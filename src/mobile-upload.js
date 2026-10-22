// 手机上传页逻辑：一套队列 UI，两种传输通道。
// - 云模式（URL 带 ?t=）：直传 Enter 云私有存储，识别也在云端。
// - 局域网模式（无 ?t=，token 由本机服务注入）：沿用原来的 /api/mobile-links 接口，识别在本机。
import {runUploadPool,uploadCloudFile,uploadSummary,retry} from './upload-engine.js';
import {prepareSelection,loadFile,saveDraft,readDraft,clearDraft,discardItems,manifestOf} from './upload-store.js';
const isPdf = (file) => /\.pdf$/i.test(file?.name || "") || file?.type === "application/pdf";
const cloudToken = (new URLSearchParams(location.search).get("t") || "").trim();
const PLACEHOLDER = "__SCRIBE_LINK_TOKEN__";
const injectedToken = typeof window.__scribeLinkToken === "string" ? window.__scribeLinkToken.trim() : "";
const localToken = injectedToken && injectedToken !== PLACEHOLDER ? injectedToken : "";
const mode = cloudToken ? "cloud" : localToken ? "local" : "invalid";

const COPY = {
  cloud: {
    title: "选好全部页面，再一次送到云端",
    intro: "手机不必和电脑连同一个 Wi‑Fi，用移动网络也能上传。全部送达后云端会逐页识别，任何设备打开应用都能阅读。",
    privacy: "文件保存在 Enter 云私有存储，原页长期保留在云端；识别在云端完成，会消耗项目的 AI 额度。",
    wifi: "无需与电脑连接同一 Wi‑Fi：上传完成后云端自动开始识别。",
    ready: "准备上传到云端",
    sending: "正在按顺序上传到云端",
    delivered: "全部文件已送达云端",
  },
  local: {
    title: "选好全部页面，再一次送到电脑",
    intro: "先在手机端确认页面顺序，再开始上传。桌面端会自动形成一个完整处理队列，不需要逐张导入。",
    privacy: "文件仅通过当前 Wi‑Fi 传到这台电脑的本地学习空间；通道在上传页保持连接时续期，最长一小时无活动后失效。",
    wifi: "请确认手机与电脑连接同一个 Wi‑Fi，电脑上的本地服务保持运行（不需要梯子）。",
    ready: "准备上传",
    sending: "正在上传",
    delivered: "已送达电脑",
  },
};

const text = COPY[mode === "cloud" ? "cloud" : "local"];
const status = document.querySelector("#status");
const title = document.querySelector("#statusTitle");
const statusText = document.querySelector("#statusText");
const progress = document.querySelector("#progress");
const queueEl = document.querySelector("#queue");
const uploadButton = document.querySelector("#uploadAll");
const clearButton = document.querySelector("#clearQueue");
const queueTools = document.querySelector("#queueTools");
const sortNameButton = document.querySelector("#sortByName");
const sortTimeButton = document.querySelector("#sortByTime");

let queue = [];
let uploading = false;
let uploadLocked = false;
let completionSent = false;
let transport = null;
let addSeq = 0;
let sources = [], persistTimer;
let initializing=true;
const draftScope='mobile:'+cloudToken;
async function persist(){
  clearTimeout(persistTimer);
  if(mode==='cloud')await saveDraft(draftScope,queue,{sources,locked:uploadLocked});
}
function persistSoon(){clearTimeout(persistTimer);persistTimer=setTimeout(()=>persist().catch(error=>show('队列暂存失败',error.message)),400);}

function orderLocked() {
  return uploading || uploadLocked || completionSent;
}

function show(message, detail) {
  status.classList.add("show");
  title.textContent = message;
  statusText.textContent = detail || "";
}

function bytes(value) {
  return value < 1024 * 1024 ? `${(value / 1024).toFixed(0)} KB` : `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function fileNameHeader(name) {
  const bytes = new TextEncoder().encode(name);
  let binary = "";
  bytes.forEach((value) => { binary += String.fromCharCode(value); });
  return btoa(binary);
}

function unavailable(message) {
  document.querySelector("#main").classList.add("expired");
  document.querySelector("#expired").classList.add("show");
  document.querySelector("#expired p").textContent = message;
}

function applyCopy() {
  document.querySelector("#pageTitle").textContent = text.title;
  document.querySelector("#pageIntro").textContent = text.intro;
  document.querySelector("#privacyNote").textContent = text.privacy;
  const wifi = document.querySelector("#wifiNote");
  if (wifi) wifi.textContent = text.wifi;
  if (title) title.textContent = text.ready;
}

function xhrRequest(method, url, file, headers, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(method, url);
    Object.keys(headers || {}).forEach((key) => xhr.setRequestHeader(key, headers[key]));
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && onProgress) onProgress(Math.round((event.loaded / event.total) * 100));
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) return resolve();
      let payload = {};
      try { payload = JSON.parse(xhr.responseText); } catch { /* 非 JSON 响应 */ }
      const error = new Error(payload.error || `上传失败（${xhr.status}）`);
      error.status = xhr.status;
      reject(error);
    };
    xhr.onerror = () => reject(new Error("网络连接中断，请检查网络后重试。"));
    xhr.send(file);
  });
}

let cloudClientPromise = null;
function cloudClient() {
  if (!cloudClientPromise) {
    cloudClientPromise = import("./integrations/supabase/client").then((module) => module.supabase);
  }
  return cloudClientPromise;
}

async function callCloud(name, body) {
  const client = await cloudClient();
  const { data, error } = await client.functions.invoke(name, { body, timeout:45000 });
  if (error) {
    let message = error.message || "云端请求失败，请重试。";
    let statusCode = 0;
    const context = error.context;
    if (context && typeof context.json === "function") {
      statusCode = context.status || 0;
      try {
        const payload = await context.clone().json();
        if (payload && payload.error) message = payload.error;
      } catch { /* 保留默认信息 */ }
    }
    const failure = new Error(message);
    failure.status = statusCode;
    throw failure;
  }
  if (data && data.error) throw new Error(data.error);
  return data;
}

function createCloudTransport(token) {
  return {
    async validate() {
      try {
        const status = await callCloud("scribe-mobile-upload", { action: "status", token });
        return { completed: status.completed === true, files: status.files || [] };
      } catch (error) {
        if (error.status === 410) return { expired: true };
        throw error;
      }
    },
    async prepare(manifest){
      return retry(()=>callCloud('scribe-mobile-upload',{action:'prepare',token,manifest}));
    },
    async upload(file, order, onProgress, options) {
      return uploadCloudFile(callCloud,token,file,order,onProgress,options);
    },
    async complete() {
      await callCloud("scribe-mobile-upload", { action: "complete", token });
    },
  };
}

function createLocalTransport(token) {
  return {
    async validate() {
      const response = await fetch(`/api/mobile-links/${encodeURIComponent(token)}`);
      if (response.status === 410) return { expired: true };
      if (!response.ok) throw new Error("无法连接到电脑。请确认手机与电脑在同一 Wi‑Fi 下。");
      const data = await response.json();
      return { completed: data.completed === true, files: data.files || [] };
    },
    async upload(file, order, onProgress) {
      await xhrRequest(
        "POST",
        `/api/mobile-links/${encodeURIComponent(token)}/files`,
        file,
        {
          "Content-Type": file.type || "application/octet-stream",
          "X-File-Name-B64": fileNameHeader(file.name),
          "X-Queue-Order": String(order),
        },
        onProgress,
      );
    },
    async complete() {
      const response = await fetch(`/api/mobile-links/${encodeURIComponent(token)}/complete`, { method: "POST" });
      if (!response.ok) {
        let payload = {};
        try { payload = await response.json(); } catch { /* 非 JSON 响应 */ }
        throw new Error(payload.error || "电脑端未能确认上传完成。");
      }
    },
  };
}

function render() {
  queueEl.innerHTML = "";
  queue.forEach((item, index) => {
    const row = document.createElement("div");
    row.className = `queue-item ${item.state || ""}`;
    row.dataset.index = String(index);
    const handle = document.createElement("button");
    handle.type = "button";
    handle.className = "drag-handle";
    handle.textContent = "☰";
    handle.setAttribute("aria-label", "按住拖拽调整顺序");
    handle.disabled = orderLocked();
    const number = document.createElement("span");
    number.className = "queue-number";
    number.textContent = String(index + 1);
    const copy = document.createElement("div");
    copy.className = "queue-copy";
    const name = document.createElement("b");
    name.textContent = item.file.name;
    const meta = document.createElement("span");
    const stateText = item.state === "uploaded" ? ` · ${text.delivered}`
      : item.state === "uploading" ? " · 上传中"
        : item.state === "error" ? " · 上传失败，顺序已锁定" : " · 等待上传";
    meta.textContent = bytes(item.file.size) + stateText;
    copy.append(name, meta);

    const actions = document.createElement("div");
    actions.className = "queue-actions";
    [["↑", "上移", () => move(index, -1)], ["↓", "下移", () => move(index, 1)], ["×", "移除", () => remove(index)]]
      .forEach(([label, aria, handler]) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "mini";
        button.textContent = label;
        button.setAttribute("aria-label", aria);
        button.disabled = uploading || uploadLocked
          || (label === "↑" && index === 0)
          || (label === "↓" && index === queue.length - 1);
        button.addEventListener("click", handler);
        actions.appendChild(button);
      });

    row.append(handle, number, copy, actions);
    item.element=row;
    queueEl.appendChild(row);
  });

  const pending = queue.filter((item) => item.state !== "uploaded").length;
  document.querySelectorAll("#images,#documents,#camera").forEach((input) => { input.disabled = uploadLocked || uploading || expanding || initializing; });
  uploadButton.disabled = !queue.length || uploading || completionSent || expanding || initializing;
  uploadButton.textContent = uploading ? "并发上传中 · 页序已锁定…"
    : completionSent ? "全部文件已送达"
      : pending ? `锁定当前顺序并上传 ${queue.length} 个文件` : "确认全部文件已送达";
  clearButton.hidden = !queue.length || uploading;
  clearButton.disabled = uploading||completionSent||expanding||initializing;
  clearButton.textContent=uploadLocked?'取消本机队列':'清空';
  queueTools.hidden = !queue.length;
  const sortDisabled = queue.length < 2 || orderLocked();
  sortNameButton.disabled = sortDisabled;
  sortTimeButton.disabled = sortDisabled;
}

function updateItem(item){
  if(!item.element)return;
  item.element.className='queue-item '+(item.state||'');
  item.element.querySelector('.queue-copy span').textContent=bytes(item.file.size)+(item.state==='uploaded'?' · 已送达':item.state==='uploading'?` · 上传中 ${item.percent||0}%`:item.state==='error'?' · 待重试':' · 等待上传');
}
function move(index, delta) {
  if (uploadLocked) return;
  const target = index + delta;
  if (target < 0 || target >= queue.length) return;
  const current = queue[index];
  queue[index] = queue[target];
  queue[target] = current;
  persistSoon();
  render();
}

function remove(index) {
  if (uploadLocked) return;
  const removed=queue.splice(index, 1);
  if(mode==='cloud')discardItems(removed).catch(()=>{});
  if(mode==='cloud'&&removed[0]?.sourceId&&!queue.some(item=>item.sourceId===removed[0].sourceId)){
    const unused=sources.filter(item=>item.sourceId===removed[0].sourceId);sources=sources.filter(item=>item.sourceId!==removed[0].sourceId);discardItems(unused).catch(()=>{});
  }
  persistSoon();
  render();
}

// PDF 先在手机上拆成逐页图片再入队：大文件不会超出云端读取上限，每页单独识别与翻译。
let expanding = false;
async function expandPdfs(files) {
  const result = [], failed = [];
  for (const file of files) {
    if (!isPdf(file)) { result.push(file); continue; }
    try {
      const { explodePdf } = await import("./pdf-pages.js");
      show("正在拆分 PDF", `${file.name} · 读取中…`);
      const pages = await explodePdf(file, (done, total) => show("正在拆分 PDF", `${file.name} · 第 ${done} / ${total} 页 · 请保持页面在前台`));
      result.push(...pages);
    } catch (error) {
      console.warn("[scribe] PDF 拆页失败", error);
      // 拆页失败且超过云端单次上限的整份 PDF 注定无法识别：不入队，明确提示，而不是上传到云端才报错。
      if (file.size > 8 * 1024 * 1024) { failed.push(file.name); continue; }
      failed.push(file.name);
      result.push(file);
    }
  }
  return { files: result, failed };
}

async function addFiles(fileList) {
  if (uploadLocked || uploading || expanding) return;
  const picked = Array.from(fileList || []);
  if(mode==='cloud'){
    expanding=true;render();
    try{
      const prepared=await prepareSelection(picked,{existing:queue.length,onProgress:(done,total)=>show('正在逐页暂存 PDF',`第 ${done} / ${total} 页；请保持页面在前台`)});
      prepared.items.forEach(item=>{item.seq=addSeq++;queue.push(item);});sources.push(...prepared.sources);
      await persist();
      show('已加入上传队列','检查编号并调整顺序；并发传输不改变页序，网络中断可继续。');
    }catch(error){show('文件尚未提交',error.message);}
    finally{expanding=false;render();}
    return;
  }
  if (picked.some(isPdf)) {
    expanding = true;
    uploadButton.disabled = true;
    try {
      const { files, failed } = await expandPdfs(picked);
      enqueue(files);
      if (failed.length) show("有 PDF 无法在手机上拆页", `${failed.join("、")}：不超过 8 MB 的将整份上传，超过的已跳过，请在电脑上重新上传该文件。`);
    } finally { expanding = false; render(); }
    return;
  }
  enqueue(picked);
}

function enqueue(files) {
  files.forEach((file) => {
    queue.push({
      id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`,
      file,
      state: "",
      addedAt: Date.now(),
      seq: addSeq++,
    });
  });
  render();
  if (queue.length) show("已加入上传队列", "检查队列编号并调整顺序；点击上传后顺序会锁定，再依序传完整批文件。");
}

function sortQueue(compare) {
  if (orderLocked() || queue.length < 2) return;
  queue.sort(compare);
  persistSoon();
  render();
}

sortNameButton.addEventListener("click", () => {
  sortQueue((left, right) => left.file.name.localeCompare(right.file.name, "zh-Hans-CN", { numeric: true, sensitivity: "base" }));
});
sortTimeButton.addEventListener("click", () => {
  sortQueue((left, right) => left.addedAt - right.addedAt || left.seq - right.seq);
});

// 触屏/鼠标通用的拖拽换位：按住手柄启动，pointermove 实时指示插入位，pointerup 提交。
let dragState = null;

function markDropTarget() {
  queueEl.querySelectorAll(".drop-target,.drop-after").forEach((row) => row.classList.remove("drop-target", "drop-after"));
  if (!dragState || dragState.target === dragState.index) return;
  const row = queueEl.querySelectorAll(".queue-item")[dragState.target];
  if (row) row.classList.add(dragState.target < dragState.index ? "drop-target" : "drop-after");
}

function finishDrag(commit) {
  if (!dragState) return;
  const { index, target, moved } = dragState;
  dragState = null;
  if (commit && moved && target !== index) queue.splice(target, 0, queue.splice(index, 1)[0]);
  if(commit)persistSoon();
  render();
}

queueEl.addEventListener("pointerdown", (event) => {
  const handle = event.target.closest && event.target.closest(".drag-handle");
  if (!handle || orderLocked()) return;
  const row = handle.closest(".queue-item");
  if (!row) return;
  const gap = parseFloat(getComputedStyle(queueEl).rowGap) || 8;
  dragState = {
    pointerId: event.pointerId,
    index: Number(row.dataset.index),
    row,
    startY: event.clientY,
    pitch: row.offsetHeight + gap,
    target: Number(row.dataset.index),
    moved: false,
  };
  if (handle.setPointerCapture) handle.setPointerCapture(event.pointerId);
  row.classList.add("dragging");
  event.preventDefault();
});

queueEl.addEventListener("pointermove", (event) => {
  if (!dragState || event.pointerId !== dragState.pointerId) return;
  const delta = event.clientY - dragState.startY;
  if (!dragState.moved && Math.abs(delta) < 4) return;
  dragState.moved = true;
  const clamped = Math.max(-dragState.index * dragState.pitch,
    Math.min((queue.length - 1 - dragState.index) * dragState.pitch, delta));
  dragState.row.style.transform = `translateY(${clamped}px)`;
  const target = Math.max(0, Math.min(queue.length - 1, dragState.index + Math.round(clamped / dragState.pitch)));
  if (target !== dragState.target) {
    dragState.target = target;
    markDropTarget();
  }
});

queueEl.addEventListener("pointerup", (event) => {
  if (dragState && event.pointerId === dragState.pointerId) finishDrag(true);
});
queueEl.addEventListener("pointercancel", (event) => {
  if (dragState && event.pointerId === dragState.pointerId) finishDrag(false);
});

async function uploadAll() {
  if (!queue.length || completionSent || uploading || expanding || initializing || !transport) return;
  if(mode==='cloud'){try{manifestOf(queue,sources);}catch(error){show('暂未提交',error.message);return;}}
  uploadLocked = true;
  uploading = true;
  render();
  const total = queue.length;
  if(mode==='cloud'){
    try{
      await persist();
      await transport.prepare(manifestOf(queue,sources));
      const transfers=queue.concat(sources);
      await runUploadPool(transfers,async(item,index,onProgress)=>{
        await transport.upload(await loadFile(item),index<total?index:index-total,onProgress,{role:index<total?'page':'original',clientId:item.id,checkpoint:{url:item.resumeUrl,save:async url=>{item.resumeUrl=url;await persist();}}});
      },{concurrency:2,onChange:item=>{
        updateItem(item);const summary=uploadSummary(transfers);
        progress.style.width=summary.percent+'%';
        show(`已送达 ${summary.done} / ${summary.total} 个文件`,`${summary.percent}% · 页序已锁定；请保持页面在前台，断网后可继续。`);
        if(item.state!=='uploading')persistSoon();
      }});
      await retry(()=>transport.complete());completionSent=true;
      clearTimeout(persistTimer);await clearDraft(draftScope,queue,sources).catch(error=>console.warn('[scribe] 暂存清理待重试',error.message));
      show(`全部 ${total} 页已送达`,'原件与顺序已保存。云端后台继续识别和翻译，现在可以关闭本页。');
    }catch(error){await persist().catch(()=>{});show('上传暂未完成',error.message);}
    finally{uploading=false;render();}
    return;
  }
  for (let index = 0; index < queue.length; index += 1) {
    const item = queue[index];
    if (item.state === "uploaded") continue;
    item.state = "uploading";
    progress.style.width = "0%";
    render();
    try {
      await transport.upload(item.file, index, (percent) => {
        progress.style.width = `${percent}%`;
        show(`正在上传第 ${index + 1} 页`, `${percent}% · ${item.file.name}`);
      });
      item.state = "uploaded";
      show(`第 ${index + 1} / ${total} 个文件已送达`, "其余文件继续按已锁定的顺序上传。");
    } catch (error) {
      item.state = "error";
      uploading = false;
      render();
      show("上传暂停", `顺序已锁定，点击重试会从失败项继续。${error.message}`);
      return;
    }
  }
  try {
    await transport.complete();
    completionSent = true;
    uploading = false;
    progress.style.width = "100%";
    render();
    show(
      `全部 ${total} 个文件已送达`,
      mode === "cloud" ? "云端即将开始逐页识别，回到电脑或任何设备打开应用即可查看结果。" : "顺序已确认。电脑端现在可以开始整批文字识别与处理。",
    );
  } catch (error) {
    uploading = false;
    render();
    show("文件已送达，等待确认", error.message);
  }
}

document.querySelector("#images").addEventListener("change", (event) => { addFiles(event.target.files); event.target.value = ""; });
document.querySelector("#documents").addEventListener("change", (event) => { addFiles(event.target.files); event.target.value = ""; });
document.querySelector("#camera").addEventListener("change", (event) => { addFiles(event.target.files); event.target.value = ""; });
uploadButton.addEventListener("click", uploadAll);
clearButton.addEventListener("click", () => {
  if (uploading || completionSent || expanding || initializing) return;
  if(uploadLocked&&!confirm('清除本机暂存队列？云端已收到的顺序不能替换；请在电脑重新生成通道开始新批次。'))return;
  const hadLocked=uploadLocked;
  clearTimeout(persistTimer);
  if(mode==='cloud')clearDraft(draftScope,queue,sources).catch(error=>show('清理暂存失败',error.message));
  queue = [];sources=[];
  uploadLocked=hadLocked;
  completionSent = false;
  progress.style.width = "0%";
  render();
  status.classList.remove("show");
  if(hadLocked)unavailable('本机队列已清空。此通道顺序已锁定，请回到电脑生成新二维码。');
});

if (/MicroMessenger/i.test(navigator.userAgent)) {
  document.querySelector("#wechatWarning").classList.add("show");
  document.querySelector("#copyLink").addEventListener("click", function () {
    const value = location.href;
    const input = document.createElement("textarea");
    input.value = value;
    document.body.appendChild(input);
    input.select();
    try {
      document.execCommand("copy");
      this.textContent = "链接已复制，粘贴到系统浏览器打开";
    } catch {
      this.textContent = "请复制地址后在系统浏览器打开";
    }
    input.remove();
  });
}

async function start() {
  applyCopy();
  render();
  if (mode === "invalid") {
    unavailable("请从电脑端生成二维码后扫码打开本页。");
    return;
  }
  transport = mode === "cloud" ? createCloudTransport(cloudToken) : createLocalTransport(localToken);
  try {
    const session = await transport.validate();
    if (session.expired) {
      unavailable(mode === "cloud" ? "此云端上传通道已失效，请回到应用重新生成二维码。" : "此传输通道已失效，请重新扫码。");
      return;
    }
    if (session.completed) {
      completionSent = true;
      uploadLocked = true;
      show(text.delivered, mode === "cloud" ? "云端正在识别，请回到应用查看进度。" : "电脑端已确认收到，可以开始识别。");
    } else if(mode==='cloud') {
      const draft=await readDraft(draftScope);
      if(draft){queue=draft.items;sources=draft.sources||[];uploadLocked=Boolean(draft.locked);queue.forEach(item=>{if(item.state==='uploading')item.state='';});show('已恢复上次上传队列','照片和确认页序仍在本机，点击上传继续；已送达文件不会重复传输。');}
    }
  } catch (error) {
    unavailable(`${error.message}`);
  }
  initializing=false;
  render();
}

start();

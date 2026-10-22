// A separate IndexedDB for binary upload staging. Never JSON/base64 encode book images.
// Only metadata lives in UI memory. Each lane loads at most one Blob at a time.
import {MAX_PAGES, MAX_OBJECT_BYTES, SOURCE_PART_BYTES} from './upload-engine.js';
let opening;
const id = () => crypto.randomUUID();
const MIME_BY_EXTENSION={pdf:'application/pdf',docx:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',jpg:'image/jpeg',jpeg:'image/jpeg',png:'image/png',txt:'text/plain'};
const metadata = file => ({name: file.name, size: file.size,
  type:(!file.type||file.type==='application/octet-stream')?(MIME_BY_EXTENSION[file.name.split('.').pop().toLowerCase()]||file.type||''):file.type,
  lastModified: file.lastModified || 0});

function open() {
  if (!opening) opening = new Promise((resolve, reject) => {
    const request = indexedDB.open('scribe-upload-staging', 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      db.createObjectStore('blobs');
      db.createObjectStore('drafts', {keyPath: 'scope'});
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error('无法使用本机上传暂存库，请退出无痕模式或更换浏览器。'));
    request.onblocked = () => reject(new Error('上传暂存库被其他标签页占用，请关闭旧页面后重试。'));
  });
  return opening;
}
async function transaction(store, mode, run) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    let result;
    const request = run(tx.objectStore(store));
    if (request) request.onsuccess = () => { result = request.result; };
    tx.oncomplete = () => resolve(result);
    tx.onabort = tx.onerror = () => reject(new Error(tx.error?.name === 'QuotaExceededError'
      ? '本机暂存空间不足。未提交这批文件，也不会跳过文件；请释放空间或分成较小批次。' : '上传队列保存失败，请重试。'));
  });
}
export async function stageFile(file) {
  const key = id();
  await transaction('blobs', 'readwrite', store => store.put(file, key));
  return {id: key, blobKey: key, file: metadata(file), state: '', addedAt: Date.now(), seq: Date.now()};
}
export async function loadFile(item) {
  if (!item.blobKey) return item.file;
  const blob = await transaction('blobs', 'readonly', store => store.get(item.blobKey));
  if (!blob) throw new Error(`暂存文件已不可用：${item.file.name}。请保留本批顺序，重新选择原文件。`);
  return new File([blob], item.file.name, {type: item.file.type, lastModified: item.file.lastModified});
}
export async function discardItems(items) {
  await transaction('blobs', 'readwrite', store => { for (const item of items) if (item.blobKey) store.delete(item.blobKey); });
}
export async function saveDraft(scope, items, extra = {}) {
  // Strip DOM nodes, callbacks and live Blobs. Blob keys are durable transactionally.
  const clean = items.map(({id, blobKey, file, state, source, sourceId, percent, addedAt, seq, resumeUrl}) =>
    ({id, blobKey, file: metadata(file), state, source, sourceId, percent, addedAt, seq, resumeUrl}));
  await transaction('drafts', 'readwrite', store => store.put({scope, items: clean, ...extra, updatedAt: Date.now()}));
}
export const readDraft = scope => transaction('drafts', 'readonly', store => store.get(scope));
export async function clearDraft(scope, items, sources = []) {
  await discardItems([...items, ...sources]);
  await transaction('drafts', 'readwrite', store => store.delete(scope));
}

// All-or-nothing selection: a PDF failure or quota error never silently skips pages.
export async function prepareSelection(files, {existing = 0, onProgress, explode} = {}) {
  const items = [], sources = [];
  try {
    for (const file of files) {
      const pdf = /\.pdf$/i.test(file.name) || file.type === 'application/pdf';
      if (!file.size) throw new Error(`${file.name} 是空文件，未加入队列。`);
      if(file.size>5*1024**3)throw new Error(`${file.name} 超过单批 5 GiB 上限，请先拆分。`);
      if(/\.doc$/i.test(file.name))throw new Error(`${file.name} 是旧版 Word 格式，暂不能识别；请另存为 DOCX 或 PDF 后导入。`);
      if(!/\.(pdf|docx|jpg|jpeg|png|heic|heif|txt)$/i.test(file.name))throw new Error(`${file.name} 的格式暂不支持，请使用 PDF、DOCX、JPG、PNG 或 TXT。`);
      if(/[\\/:*?"<>|\u0000-\u001f]/.test(file.name)||file.name.length>140)throw new Error(`${file.name.slice(0,40)}：请缩短文件名并去掉特殊符号后重试。`);
      if(/\.(heic|heif)$/i.test(file.name))throw new Error(`${file.name} 是 HEIC 原图，云端暂不能识别；请从相册分享为 JPEG，或使用拍照上传。未提交本次选择。`);
      if (!pdf) {
        if (file.size > MAX_OBJECT_BYTES) throw new Error(`${file.name} 超过当前云存储的 50 MB 单文件上限，请先拆分。`);
        items.push(await stageFile(file));
      } else {
        // Keep the exact original PDF, split only for transport (not lossy recompression).
        const sourceId = id(), count = Math.ceil(file.size / SOURCE_PART_BYTES);
        for (let part = 0; part < count; part++) {
          const piece = new File([file.slice(part * SOURCE_PART_BYTES, (part + 1) * SOURCE_PART_BYTES)], `${sourceId}-${part}.pdf`, {type: 'application/pdf'});
          const staged = await stageFile(piece);
          sources.push({...staged, sourceId, originalName: file.name, originalSize: file.size, part, parts: count});
        }
        const render = explode || (await import('./pdf-pages.js')).explodePdf;
        await render(file, onProgress, async (page, number, total) => {
          if (existing + items.length + total - number + 1 > MAX_PAGES) throw new Error(`单批最多 ${MAX_PAGES} 页，请分批导入。已选文件未提交。`);
          const staged = await stageFile(page);
          items.push({...staged, sourceId, source: file.name.replace(/\.pdf$/i, '')});
        });
      }
      if (existing + items.length > MAX_PAGES) throw new Error(`单批最多 ${MAX_PAGES} 页，请分批导入。`);
      // Yield between selections so hundreds of photos do not monopolise the main thread.
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    return {items, sources};
  } catch (error) { await discardItems([...items, ...sources]); throw error; }
}

export function manifestOf(items, sources = []) {
  if(!items.length||items.length>MAX_PAGES)throw new Error(`每批请选择 1–${MAX_PAGES} 页。`);
  if([...items,...sources].reduce((sum,item)=>sum+item.file.size,0)>5*1024**3)throw new Error('单批文件与 PDF 原件合计超过 5 GiB，请分批导入。');
  return {files: items.map(item => ({name: item.file.name, size: item.file.size, mime: item.file.type,clientId:item.id})),
    originals: sources.map(item => ({name: item.file.name, size: item.file.size, mime: item.file.type,
      sourceId: item.sourceId, originalName: item.originalName, originalSize: item.originalSize, part: item.part, parts: item.parts}))};
}

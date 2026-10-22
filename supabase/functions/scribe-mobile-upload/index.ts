// 由 scripts/bundle-functions.mjs 从 supabase/functions/src/scribe-mobile-upload.ts 生成，请勿直接编辑。
// 修改源文件后运行：pnpm bundle:functions

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// ---- 共享模块（supabase/functions/_shared 内联，平台只部署单文件） ----
const __shared = (() => {
  declare const EdgeRuntime:{waitUntil(task:Promise<unknown>):void};
  type Row = Record<string, any>;
  const BUCKET = "scribe-pages";
  // Supabase's default row cap is 1000. Never interpret that cap as a complete book/library.
  async function allRows(query: (from:number,to:number)=>any): Promise<Row[]> {
    const rows:Row[]=[];
    for(let from=0;;from+=500){
      const {data,error}=await query(from,from+499);
      if(error) throw new Error(error.message);
      rows.push(...(data||[]));
      if((data||[]).length<500) return rows;
    }
  }
  async function readJsonLimited(req:Request,maxBytes:number) {
    const reader=req.body?.getReader();if(!reader)throw new SyntaxError('缺少请求内容');
    const decoder=new TextDecoder();let bytes=0,text='';
    try{
      for(;;){const {value,done}=await reader.read();if(done)break;bytes+=value.byteLength;
        if(bytes>maxBytes){await reader.cancel();throw Object.assign(new Error('请求过大，请分批提交。'),{status:413});}
        text+=decoder.decode(value,{stream:true});
      }
      return JSON.parse(text+decoder.decode());
    }finally{reader.releaseLock();}
  }
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
  function json(value: unknown, status = 200) {
    return new Response(JSON.stringify(value), {status, headers: {...cors,
      "Content-Type":"application/json; charset=utf-8", "Cache-Control":"no-store"}});
  }
  function database() {
    const url = Deno.env.get("SUPABASE_URL"), key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!url || !key) throw new Error("云端配置缺失。");
    return createClient(url,key,{auth:{persistSession:false}});
  }
  function randomKey() {
    return Array.from(crypto.getRandomValues(new Uint8Array(32)), n=>n.toString(16).padStart(2,"0")).join("");
  }
  // 续传并入后页数会变，自动生成的标题（如「电脑上传文献（9 个文件）」）必须跟着更新，
  // 否则用户会以为页面丢了；用户自己起的标题不含这个格式，原样保留。
  function withPageCount(title: unknown, pages: number) {
    const value = String(title ?? "");
    const match = value.match(/^(.*)（\s*\d+\s*(个文件|页)\s*）\s*$/);
    if (!match) return value;
    return `${match[1]}（${pages} ${match[2]}）`;
  }
  async function libraryFor(db: ReturnType<typeof database>, key: unknown) {
    if (typeof key !== "string" || !/^[a-f0-9]{64}$/.test(key)) return null;
    // Legacy beta/library bearer keys no longer authorize requests. Every API resolves a
    // live account session, checking expiry, disabled state and credential version in SQL.
    const {data,error}=await db.rpc('scribe_account_library',{p_token_hash:await hashKey(key)});
    if(error)throw Object.assign(new Error('账号服务尚未部署，请联系管理员。'),{status:503});
    return data||null;
  }
  async function hashKey(key: string) {
    return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(key))),n=>n.toString(16).padStart(2,"0")).join("");
  }
  async function wakeQueue(db: ReturnType<typeof database>) {
    const {data,error} = await db.from("scribe_runtime_settings").select("worker_secret").eq("id",true).single();
    if (error || !data) throw new Error("后台队列未部署，请先完成云端迁移。");
    const work = fetch(Deno.env.get("SUPABASE_URL")+"/functions/v1/scribe-queue",{
      method:"POST",headers:{"Content-Type":"application/json","x-scribe-worker-key":data.worker_secret},body:"{}",
      signal:AbortSignal.timeout(10000),
    }).then(async r=>{if(!r.ok) throw new Error("后台处理器尚未启动："+r.status);await r.text();});
    // Cron is the durable fallback; waking here reduces the first-page latency.
    if (typeof EdgeRuntime !== "undefined") EdgeRuntime.waitUntil(work.catch(e=>console.error("[scribe-queue wake]",e.message)));
    else await work;
  }
  return { allRows, readJsonLimited, json, database, randomKey, withPageCount, libraryFor, hashKey, wakeQueue, BUCKET, cors };
})();
const { database, libraryFor, wakeQueue, allRows, readJsonLimited } = __shared;

// ---- 函数实现 ----
// 手机跨网络上传中转：手机（任意网络）→ Enter 云私有桶，电脑/任意设备凭 token 取回。
// 所有动作都由 token 鉴权；数据库对客户端默认拒绝，只有本函数（服务角色）可以读写。



const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const BUCKET = "scribe-pages";
const LINK_TTL_MS = 24 * 60 * 60 * 1000;
const SHORT_URL_TTL = 60 * 60;
const PAGE_URL_TTL = 60 * 60;
const MAX_FILES = 2000;
const MAX_BYTES = 50 * 1024 * 1024; // Actual Enter storage/TUS service limit, verified via OPTIONS.
const MAX_OPEN_SESSIONS = 20;

const allowedExtensions = new Set([".pdf", ".doc", ".docx", ".jpg", ".jpeg", ".png", ".heic", ".heif", ".txt"]);

const mimeByExtension: Record<string, string> = {
  ".pdf": "application/pdf",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".heic": "image/heic",
  ".heif": "image/heif",
  ".txt": "text/plain",
};

type Row = Record<string, unknown>;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

function fail(message: string, status = 400) {
  return json({ error: message }, status);
}

function cleanName(value: unknown) {
  const name = String(value || "untitled").replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").replace(/^\.+/, "").slice(0, 160);
  return name || "untitled";
}

function extensionOf(name: string) {
  const match = name.toLowerCase().match(/\.[a-z0-9]+$/);
  return match ? match[0] : "";
}

function makeToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sessionByToken(db: ReturnType<typeof database>, token: unknown) {
  if (typeof token !== "string" || token.length < 10) return null;
  const { data } = await db.from("scribe_cloud_sessions").select("*").eq("token", token).maybeSingle();
  if (!data || data.deleted_at) return null;
  if (new Date(String((data as Row).expires_at)).getTime() <= Date.now()) return null;
  // QR codes grant only a short-lived upload capability, never account/library access.
  // Disabling an account also invalidates outstanding mobile upload links.
  const {data:owner,error}=await db.from('scribe_accounts').select('id,credential_version').eq('library_id',data.library_id).eq('disabled',false).maybeSingle();
  if(error||!owner||owner.credential_version!==data.account_version)return null;
  return data as Row;
}

async function filesOf(db: ReturnType<typeof database>, sessionId: string) {
  return await allRows((from,to)=>db
    .from("scribe_cloud_files")
    .select("id, queue_order, name, size, mime, storage_path, ocr_status, ocr_error, page_count, uploaded_at")
    .eq("session_id", sessionId)
    .order("queue_order", { ascending: true })
    .order("id").range(from,to));
}

function fileInfo(file: Row) {
  return {
    id: file.id,
    order: file.queue_order,
    name: file.name,
    size: file.size,
    mime: file.mime,
    uploaded: Boolean(file.uploaded_at),
    ocrStatus: file.ocr_status,
    ocrError: file.ocr_error || "",
    pageCount: file.page_count || 0,
  };
}

function sessionInfo(session: Row, files: Row[]) {
  return {
    id: session.id,
    expiresAt: session.expires_at,
    completed: Boolean(session.completed_at),
    completedAt: session.completed_at,
    ocrStatus: session.ocr_status,
    ocrCompletedAt: session.ocr_completed_at,
    fileCount: files.filter((file) => file.uploaded_at).length,
    files: files.map(fileInfo),
  };
}

async function createSession(db: ReturnType<typeof database>, body: Row) {
  const library = await libraryFor(db,body.libraryKey);
  if(!library) return fail("请先连接云端书库。",401);
  const now = Date.now();
  const { data: open } = await db
    .from("scribe_cloud_sessions")
    .select("id")
    .gt("expires_at", new Date(now).toISOString())
    .is("completed_at", null)
    .eq("library_id",library.id)
    .limit(MAX_OPEN_SESSIONS + 1);
  if ((open || []).length >= MAX_OPEN_SESSIONS) {
    return json({ error: "云端待上传的通道过多，请先完成或删除旧通道。" }, 429);
  }
  const token = makeToken();
  const expiresAt = new Date(now + LINK_TTL_MS).toISOString();
  const title = typeof body.title === "string" ? cleanName(body.title).slice(0, 120) : null;
  const { data, error } = await db
    .from("scribe_cloud_sessions")
    .insert({ token, expires_at: expiresAt, title, library_id:library.id,account_version:library.version })
    .select("*")
    .single();
  if (error || !data) throw new Error(error?.message || "无法建立云端上传通道。");
  return json({ token, sessionId: data.id, expiresAt });
}

async function signUpload(db: ReturnType<typeof database>, session: Row, body: Row) {
  if(session.completed_at || new Date(String(session.expires_at)).getTime()<=Date.now()) return fail("上传窗口已结束，请创建新批次。",410);
  const name = cleanName(body.name);
  const extension = extensionOf(name);
  if (!allowedExtensions.has(extension)) return fail("仅支持 PDF、DOC、DOCX、JPG、PNG、HEIC 或 HEIF 文件。", 415);
  const size = Number(body.size);
  if(!Number.isSafeInteger(size) || size<=0) return fail("文件为空或大小不正确，请重新选择。",400);
  if (size > MAX_BYTES) return fail("单个存储对象不能超过 50 MB；大 PDF 请用新版页面自动分片上传。", 413);
  const order = Number(body.order);
  if(!Number.isSafeInteger(order) || order<0 || order>=MAX_FILES) return fail("文件顺序不正确，请重新确认队列。",400);
  const mime = typeof body.mime === "string" && body.mime ? body.mime : mimeByExtension[extension] || "application/octet-stream";
  const original=body.role==='original';
  const {data:previous,error:reserveError}=original
    ?await db.from('scribe_source_assets').select('*').eq('session_id',session.id).eq('queue_order',order).maybeSingle()
    :await db.rpc('scribe_reserve_page',{p_session:session.id,p_order:order,p_name:name,p_size:size,p_mime:mime});
  if(reserveError) return fail(reserveError.message,409);
  if(!previous || previous.name!==name || Number(previous.size)!==size) return fail('文件不在已确认的上传清单内。',409);
  if(!original&&previous.client_file_id&&previous.client_file_id!==body.clientId)return fail('文件身份与确认清单不一致，请勿替换已锁定的页面。',409);
  if(previous.uploaded_at) return json({fileId:previous.id,alreadyUploaded:true});
  const { data: signed, error: signError } = await db.storage.from(BUCKET).createSignedUploadUrl(previous.storage_path,{upsert:true});
  if (signError || !signed) throw new Error(signError?.message || "无法签发上传地址。");

  console.log("[scribe-mobile-upload] sign", session.id, order);
  return json({ fileId:previous.id, path:previous.storage_path, uploadUrl:signed.signedUrl,
    uploadToken:signed.token,bucket:BUCKET,resumableUrl:Deno.env.get('SUPABASE_URL')+'/storage/v1/upload/resumable' });
}

async function registerUpload(db: ReturnType<typeof database>, session: Row, body: Row) {
  if(session.completed_at || new Date(String(session.expires_at)).getTime()<=Date.now()) return fail("上传窗口已结束。",410);
  const fileId = String(body.fileId || "");
  if (!fileId) return fail("缺少文件标识。");
  const table=body.role==='original'?'scribe_source_assets':'scribe_cloud_files';
  const {data:file}=await db.from(table).select("*").eq("id",fileId).eq("session_id",session.id).maybeSingle();
  if(!file) return fail("未找到该文件。",404);
  if(file.uploaded_at) return json({ok:true,fileId});
  const {data:objects,error:objectError}=await db.storage.from(BUCKET).list(String(session.id),{search:String(file.storage_path).split('/').pop(),limit:100});
  const object=objects?.find(item=>item.name===String(file.storage_path).split('/').pop());
  if(objectError || !object || Number(object.metadata?.size)!==Number(file.size)) return fail("原件尚未完整送达，请重试上传。",409);
  const { error } = await db
    .from(table)
    .update({
      uploaded_at: new Date().toISOString(),
      size: Number(file.size),
    })
    .eq("id", fileId)
    .eq("session_id", session.id);
  if (error) throw new Error(error.message);
  // Counting the entire batch after every file was O(n²). Finalization computes it once.
  return json({ ok: true, fileId });
}

async function completeSession(db: ReturnType<typeof database>, session: Row) {
  if(session.completed_at){await wakeQueue(db);return json({ok:true,fileCount:session.file_count,queued:true});}
  if(new Date(String(session.expires_at)).getTime()<=Date.now()) return fail("上传通道已过期。",410);
  const {data,error}=await db.rpc('scribe_finalize_upload',{p_session:session.id});
  if(error) return fail(error.message,409);
  await wakeQueue(db);
  return json({...data,expiresAt:session.expires_at});
}

async function signedUrls(db: ReturnType<typeof database>, session: Row, ttl: number, onlyFileId?: string) {
  const files = await filesOf(db, String(session.id));
  const targets = onlyFileId ? files.filter((file) => file.id === onlyFileId) : files;
  const results: Row[] = [];
  const uploaded=targets.filter(file=>file.uploaded_at&&file.storage_path);
  for(let offset=0;offset<uploaded.length;offset+=100){
    const batch=uploaded.slice(offset,offset+100);
    const {data,error}=await db.storage.from(BUCKET).createSignedUrls(batch.map(file=>String(file.storage_path)),ttl);
    if(error)throw new Error(error.message);
    for(let index=0;index<batch.length;index++)if(data?.[index]?.signedUrl)results.push({...fileInfo(batch[index]),url:data[index].signedUrl,expiresIn:ttl});
  }
  return results;
}

async function resultsOf(db: ReturnType<typeof database>, session: Row) {
  const data = await allRows((from,to)=>db
    .from("scribe_cloud_files")
    .select("id, queue_order, name, mime, ocr_text, paragraphs, ocr_status, ocr_error")
    .eq("session_id", session.id)
    .order("queue_order", { ascending: true }).range(from,to));
  return ((data || []) as Row[]).map((file) => ({
    id: file.id,
    order: file.queue_order,
    name: file.name,
    mime: file.mime,
    text: typeof file.ocr_text === "string" ? file.ocr_text : "",
    paragraphs: Array.isArray(file.paragraphs) ? file.paragraphs : [],
    ocrStatus: file.ocr_status,
    ocrError: file.ocr_error || "",
  }));
}

// 阅读区调序：已识别文献的最后一重纠错。按书库凭证鉴权，直接改写 queue_order；
// 识别文本随文件行走，不受影响；书库同步按 queue_order 重建页序，各设备一致。
async function reorderSession(db: ReturnType<typeof database>, body: Row) {
  const library = await libraryFor(db, body.libraryKey);
  if (!library) return fail("请先连接云端书库。", 401);
  const sessionId = String(body.sessionId || "");
  if (!/^[0-9a-f-]{36}$/i.test(sessionId)) return fail("缺少文献标识。", 400);
  const { data: session, error } = await db
    .from("scribe_cloud_sessions")
    .select("id, library_id, deleted_at")
    .eq("id", sessionId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!session || session.library_id !== library.id || session.deleted_at) return fail("未找到该文献。", 404);

  const files = await filesOf(db, sessionId);
  if (!files.length) return fail("该文献没有页面。", 409);
  const order = Array.isArray(body.order) ? body.order.map(String) : [];
  const known = new Map(files.map((file) => [String(file.id), file]));
  if (order.length !== files.length || new Set(order).size!==order.length || order.some((id) => !known.has(id))) {
    return fail("页面顺序与文献不一致，请刷新后重试。", 409);
  }
  const {error:updateError}=await db.rpc('scribe_reorder_pages',{p_session:sessionId,p_ids:order});
  if(updateError) return fail(updateError.message,409);
  console.log("[scribe-mobile-upload] reorder", sessionId, order.length, "pages");
  return json({ ok: true, pages: order.length });
}

// 重签原页地址：阅读区读到过期或缺失的签名地址时按书库凭证重新签发。
// 续传并入的页面原件仍在原批次目录下，因此一律以文件行记录的 storage_path 签发。
async function refreshPagesByLibrary(db: ReturnType<typeof database>, body: Row) {
  const library = await libraryFor(db, body.libraryKey);
  if (!library) return fail("请先连接云端书库。", 401);
  const sessionId = String(body.sessionId || "");
  if (!/^[0-9a-f-]{36}$/i.test(sessionId)) return fail("缺少文献标识。", 400);
  const { data: session, error } = await db
    .from("scribe_cloud_sessions")
    .select("id, library_id, deleted_at")
    .eq("id", sessionId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!session || session.library_id !== library.id || session.deleted_at) return fail("未找到该文献。", 404);
  const files = await signedUrls(db, session as Row, PAGE_URL_TTL, body.fileId ? String(body.fileId) : undefined);
  return json({ files, expiresIn: PAGE_URL_TTL });
}

async function removeSession(db: ReturnType<typeof database>, session: Row) {
  if(session.library_id){
    const {data:entry}=await db.from('scribe_library_entries').select('revision').eq('library_id',session.library_id).eq('kind','doc').eq('entry_id','cloud-'+session.id).maybeSingle();
    if(entry)await db.rpc('scribe_write_entry',{p_library:session.library_id,p_kind:'doc',p_id:'cloud-'+session.id,p_value:null,p_deleted:true,p_revision:entry.revision});
  }
  // 续传并入的页面仍保存在原批次的目录下，所以按文件行记录的 storage_path 删除，
  // 再用目录列举兜底，保证「永久删除」真的清掉原件。
  const paths = new Set<string>();
  const rows = await allRows((from,to)=>db.from("scribe_cloud_files").select("id,storage_path").eq("session_id", session.id).order('id').range(from,to));
  const originals=await allRows((from,to)=>db.from('scribe_source_assets').select('id,storage_path').eq('session_id',session.id).order('id').range(from,to));
  for (const row of [...rows,...originals]) {
    const value = String(row.storage_path || "");
    if (value) paths.add(value);
  }
  for(let offset=0;;offset+=500){
    const {data:listed,error}=await db.storage.from(BUCKET).list(String(session.id),{limit:500,offset,sortBy:{column:'name',order:'asc'}});
    if(error)throw new Error(error.message);
    for(const item of listed||[])paths.add(`${session.id}/${item.name}`);
    if((listed||[]).length<500)break;
  }
  const targets = [...paths];
  for(let offset=0;offset<targets.length;offset+=100){const {error}=await db.storage.from(BUCKET).remove(targets.slice(offset,offset+100));if(error)throw new Error(error.message);}
  const { error } = await db.from("scribe_cloud_sessions").delete().eq("id", session.id);
  if (error) throw new Error(error.message);
  console.log("[scribe-mobile-upload] remove", session.id, targets.length);
  return json({ ok: true, removedFiles: targets.length });
}

// 续传：把已完成识别的新批次并入已有文献（目标会话），页码接在原有页面之后。
// 文件行改挂到目标会话（storage_path 仍指向原对象，读取时按行内路径签发，不受影响）；
// 新会话删除前写入文献墓碑，避免书库同步把它再生成一本新书。
async function absorbSession(db: ReturnType<typeof database>, session: Row, body: Row) {
  const library = await libraryFor(db, body.libraryKey);
  if (!library) return fail("请先连接云端书库。", 401);
  if (!session.library_id || session.library_id !== library.id) return fail("这一批不属于当前书库。", 403);
  if (!session.completed_at || session.deleted_at) return fail("这一批还没有完成识别，暂时不能合并。", 409);

  const targetId = String(body.into || "");
  if (!/^[0-9a-f-]{36}$/i.test(targetId)) return fail("缺少目标文献标识。", 400);
  if (targetId === session.id) return fail("不能合并到同一批。", 400);
  const { data: target, error: targetError } = await db
    .from("scribe_cloud_sessions")
    .select("*")
    .eq("id", targetId)
    .eq("library_id", library.id)
    .is("deleted_at", null)
    .maybeSingle();
  if (targetError) throw new Error(targetError.message);
  if (!target) return fail("目标文献不存在或已删除。", 404);
  if (!target.completed_at) return fail("目标文献还没有完成识别，暂时不能合并。", 409);

  const {data,error:mergeError}=await db.rpc('scribe_absorb_upload',{p_library:library.id,p_source:session.id,p_target:target.id});
  if(mergeError)return fail(mergeError.message,409);
  return json(data);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return fail("不支持的操作", 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceKey) {
    console.error("[scribe-mobile-upload] missing cloud credentials");
    return fail("云端配置缺失，请联系管理员。", 500);
  }
  const db = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

  let body: Row;
  try {
    body = (await readJsonLimited(req,2*1024*1024)) as Row;
  } catch(error) {
    return fail(error instanceof SyntaxError?'请求格式不正确。':error instanceof Error?error.message:'请求读取失败。',Number((error as {status?:number}).status)||400);
  }

  const action = String(body.action || "");
  try {
    if (action === "create") return await createSession(db, body);
    if (action === "reorder") return await reorderSession(db, body);
    if (action === "pages") return await refreshPagesByLibrary(db, body);
    if (action === 'originals') {
      const library=await libraryFor(db,body.libraryKey);
      if(!library)return fail('请先连接云端书库。',401);
      const {data:owner,error}=await db.from('scribe_cloud_sessions').select('id').eq('id',String(body.sessionId||'')).eq('library_id',library.id).is('deleted_at',null).maybeSingle();
      if(error)throw new Error(error.message);if(!owner)return fail('文献不属于当前书库。',404);
      const rows=await allRows((from,to)=>db.from('scribe_source_assets').select('*').eq('session_id',owner.id).not('uploaded_at','is',null).order('queue_order').range(from,to));
      const sources:Row[]=[];
      for(let offset=0;offset<rows.length;offset+=100){
        const batch=rows.slice(offset,offset+100);
        const {data:urls,error}=await db.storage.from(BUCKET).createSignedUrls(batch.map(row=>row.storage_path),3600);
        if(error)throw new Error(error.message);
        batch.forEach((row,index)=>sources.push({sourceId:row.source_id,name:row.original_name,size:row.original_size,part:row.part_index,parts:row.part_count,partSize:row.size,url:urls?.[index]?.signedUrl||''}));
      }
      return json({sources});
    }

    const session = await sessionByToken(db, body.token);
    if (!session) return json({ error: "此上传通道已失效，请重新生成二维码。" }, 410);

    switch (action) {
      case "prepare": {
        const {data,error}=await db.rpc('scribe_prepare_upload',{p_session:session.id,p_manifest:body.manifest});
        if(error) return fail(error.code==='PGRST202'?'云端尚未升级上传数据结构，请管理员先部署 20261021150000 迁移。':error.message,error.code==='PGRST202'?503:409);
        return json(data);
      }
      case "status": {
        const files = await filesOf(db, String(session.id));
        return json(sessionInfo(session, files));
      }
      case "sign":
        return await signUpload(db, session, body);
      case "register":
        return await registerUpload(db, session, body);
      case "complete":
        return await completeSession(db, session);
      case "downloads":
        return json({ files: await signedUrls(db, session, SHORT_URL_TTL) });
      case "results":
        return json({ files: await resultsOf(db, session) });
      case "pageUrl":
        return json({ files: await signedUrls(db, session, PAGE_URL_TTL, body.fileId ? String(body.fileId) : undefined) });
      case "remove":
        return await removeSession(db, session);
      case "absorb":
        return await absorbSession(db, session, body);
      default:
        return fail("不支持的操作。");
    }
  } catch (error) {
    console.error("[scribe-mobile-upload]", action, error);
    return fail(error instanceof Error ? error.message : "云端处理失败，请重试。", 500);
  }
});

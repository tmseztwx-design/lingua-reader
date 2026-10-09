// 手机跨网络上传中转：手机（任意网络）→ Enter 云私有桶，电脑/任意设备凭 token 取回。
// 所有动作都由 token 鉴权；数据库对客户端默认拒绝，只有本函数（服务角色）可以读写。
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {database, libraryFor, wakeQueue} from "../_shared/cloud.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const BUCKET = "scribe-pages";
const LINK_TTL_MS = 24 * 60 * 60 * 1000;
const SHORT_URL_TTL = 60 * 60;
const PAGE_URL_TTL = 60 * 60;
const MAX_FILES = 100;
const MAX_BYTES = 100 * 1024 * 1024;
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
  if (!data) return null;
  if (!data.completed_at && new Date(String((data as Row).expires_at)).getTime() <= Date.now()) return null;
  return data as Row;
}

async function filesOf(db: ReturnType<typeof database>, sessionId: string) {
  const { data } = await db
    .from("scribe_cloud_files")
    .select("id, queue_order, name, size, mime, ocr_status, ocr_error, page_count, uploaded_at")
    .eq("session_id", sessionId)
    .order("queue_order", { ascending: true })
    .order("created_at", { ascending: true });
  return (data || []) as Row[];
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

async function refreshCounts(db: ReturnType<typeof database>, session: Row) {
  const files = await filesOf(db, String(session.id));
  const uploaded = files.filter((file) => file.uploaded_at);
  await db.from("scribe_cloud_sessions").update({ file_count: uploaded.length }).eq("id", session.id);
  return files;
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
    .insert({ token, expires_at: expiresAt, title, library_id:library.id })
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
  if (Number.isFinite(size) && size > MAX_BYTES) return fail("单个文件不能超过 100 MB。", 413);
  const files = await filesOf(db, String(session.id));
  const order = body.order===undefined?files.length:Number(body.order);
  if(!Number.isSafeInteger(order) || order<0 || order>=MAX_FILES) return fail("文件顺序不正确，请重新确认队列。",400);
  const {data:previous}=await db.from("scribe_cloud_files").select("*").eq("session_id",session.id).eq("queue_order",order).maybeSingle();
  if(previous){
    if(previous.name!==name || Number(previous.size)!==size) return fail("这个队列位置已有其他文件，请重新建立批次。",409);
    if(previous.uploaded_at) return json({fileId:previous.id,alreadyUploaded:true});
    const {data:signed,error}=await db.storage.from(BUCKET).createSignedUploadUrl(previous.storage_path,{upsert:true});
    if(error||!signed) throw new Error(error?.message||"无法重试上传。");
    return json({fileId:previous.id,path:previous.storage_path,uploadUrl:signed.signedUrl});
  }
  if (files.length >= MAX_FILES) return fail(`单批最多 ${MAX_FILES} 个文件。`, 413);
  const fileId = crypto.randomUUID();
  const storagePath = `${session.id}/${String(order + 1).padStart(4, "0")}-${fileId}${extension}`;
  const mime = typeof body.mime === "string" && body.mime ? body.mime : mimeByExtension[extension] || "application/octet-stream";

  const { error: insertError } = await db.from("scribe_cloud_files").insert({
    id: fileId,
    session_id: session.id,
    queue_order: order,
    name,
    mime,
    size: Number.isFinite(size) ? size : 0,
    storage_path: storagePath,
    ocr_status: "pending",
  });
  if (insertError) throw new Error(insertError.message);

  const { data: signed, error: signError } = await db.storage.from(BUCKET).createSignedUploadUrl(storagePath);
  if (signError || !signed) throw new Error(signError?.message || "无法签发上传地址。");

  console.log("[scribe-mobile-upload] sign", session.id, order, name);
  return json({ fileId, path: storagePath, uploadUrl: signed.signedUrl });
}

async function registerUpload(db: ReturnType<typeof database>, session: Row, body: Row) {
  if(session.completed_at || new Date(String(session.expires_at)).getTime()<=Date.now()) return fail("上传窗口已结束。",410);
  const fileId = String(body.fileId || "");
  if (!fileId) return fail("缺少文件标识。");
  const {data:file}=await db.from("scribe_cloud_files").select("*").eq("id",fileId).eq("session_id",session.id).maybeSingle();
  if(!file) return fail("未找到该文件。",404);
  const {data:objects,error:objectError}=await db.storage.from(BUCKET).list(String(session.id),{search:String(file.storage_path).split('/').pop(),limit:100});
  const object=objects?.find(item=>item.name===String(file.storage_path).split('/').pop());
  if(objectError || !object || Number(object.metadata?.size)!==Number(file.size)) return fail("原件尚未完整送达，请重试上传。",409);
  const size = Number(body.size);
  if (Number.isFinite(size) && size > MAX_BYTES) {
    await db.from("scribe_cloud_files").delete().eq("id", fileId).eq("session_id", session.id);
    return fail("单个文件不能超过 100 MB。", 413);
  }
  const { error } = await db
    .from("scribe_cloud_files")
    .update({
      uploaded_at: new Date().toISOString(),
      size: Number(file.size),
    })
    .eq("id", fileId)
    .eq("session_id", session.id);
  if (error) throw new Error(error.message);
  await refreshCounts(db, session);
  return json({ ok: true, fileId });
}

async function completeSession(db: ReturnType<typeof database>, session: Row) {
  if(session.completed_at){await wakeQueue(db);return json({ok:true,fileCount:session.file_count,queued:true});}
  if(new Date(String(session.expires_at)).getTime()<=Date.now()) return fail("上传通道已过期。",410);
  const files = await refreshCounts(db, session);
  const uploaded = files.filter((file) => file.uploaded_at);
  if (!uploaded.length) return fail("还没有收到可识别的页面。", 409);
  if(uploaded.length!==files.length) return fail("仍有文件未完整上传，确认全部送达后再提交。",409);
  const { error } = await db
    .from("scribe_cloud_sessions")
    .update({ completed_at: new Date().toISOString(), file_count: uploaded.length,ocr_status:"processing" })
    .eq("id", session.id);
  if (error) throw new Error(error.message);
  await wakeQueue(db);
  console.log("[scribe-mobile-upload] complete", session.id, uploaded.length);
  return json({ ok: true, fileCount: uploaded.length, expiresAt: session.expires_at });
}

async function signedUrls(db: ReturnType<typeof database>, session: Row, ttl: number, onlyFileId?: string) {
  const files = await filesOf(db, String(session.id));
  const targets = onlyFileId ? files.filter((file) => file.id === onlyFileId) : files;
  const results: Row[] = [];
  for (const file of targets) {
    if (!file.uploaded_at) continue;
    const path = `${session.id}/${String(Number(file.queue_order) + 1).padStart(4, "0")}-${file.id}${extensionOf(String(file.name))}`;
    const { data } = await db
      .from("scribe_cloud_files")
      .select("storage_path")
      .eq("id", file.id)
      .maybeSingle();
    const storagePath = String((data as Row | null)?.storage_path || path);
    const { data: signed } = await db.storage.from(BUCKET).createSignedUrl(storagePath, ttl);
    if (!signed?.signedUrl) continue;
    results.push({ ...fileInfo(file), url: signed.signedUrl, expiresIn: ttl });
  }
  return results;
}

async function resultsOf(db: ReturnType<typeof database>, session: Row) {
  const { data } = await db
    .from("scribe_cloud_files")
    .select("id, queue_order, name, mime, ocr_text, paragraphs, ocr_status, ocr_error")
    .eq("session_id", session.id)
    .order("queue_order", { ascending: true });
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
  if (order.length !== files.length || order.some((id) => !known.has(id))) {
    return fail("页面顺序与文献不一致，请刷新后重试。", 409);
  }
  for (let index = 0; index < order.length; index += 1) {
    const { error: updateError } = await db
      .from("scribe_cloud_files")
      .update({ queue_order: index })
      .eq("id", order[index])
      .eq("session_id", sessionId);
    if (updateError) throw new Error(updateError.message);
  }
  console.log("[scribe-mobile-upload] reorder", sessionId, order.length, "pages");
  return json({ ok: true, pages: order.length });
}

async function removeSession(db: ReturnType<typeof database>, session: Row) {
  if(session.library_id){
    const {data:entry}=await db.from('scribe_library_entries').select('revision').eq('library_id',session.library_id).eq('kind','doc').eq('entry_id','cloud-'+session.id).maybeSingle();
    if(entry)await db.rpc('scribe_write_entry',{p_library:session.library_id,p_kind:'doc',p_id:'cloud-'+session.id,p_value:null,p_deleted:true,p_revision:entry.revision});
  }
  // 续传并入的页面仍保存在原批次的目录下，所以按文件行记录的 storage_path 删除，
  // 再用目录列举兜底，保证「永久删除」真的清掉原件。
  const paths = new Set<string>();
  const { data: rows } = await db.from("scribe_cloud_files").select("storage_path").eq("session_id", session.id);
  for (const row of (rows || []) as Row[]) {
    const value = String(row.storage_path || "");
    if (value) paths.add(value);
  }
  const { data: listed } = await db.storage.from(BUCKET).list(String(session.id), { limit: 1000 });
  for (const item of listed || []) paths.add(`${session.id}/${item.name}`);
  const targets = [...paths];
  if (targets.length){const {error}=await db.storage.from(BUCKET).remove(targets);if(error)throw new Error(error.message);}
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

  const incoming = (await filesOf(db, String(session.id))).filter((file) => file.uploaded_at);
  if (!incoming.length) return fail("这一批没有已送达的页面。", 409);
  const existing = (await filesOf(db, String(target.id))).filter((file) => file.uploaded_at);
  const baseOrder = existing.reduce((max, file) => Math.max(max, Number(file.queue_order)), -1) + 1;
  if (existing.length + incoming.length > MAX_FILES) return fail(`合并后超过单批 ${MAX_FILES} 页上限，请拆分。`, 413);

  for (const file of incoming) {
    const { error } = await db
      .from("scribe_cloud_files")
      .update({ session_id: target.id, queue_order: baseOrder + Number(file.queue_order) })
      .eq("id", file.id)
      .eq("session_id", session.id);
    if (error) throw new Error(error.message);
  }

  const all = [...existing, ...incoming];
  const failed = all.filter((file) => file.ocr_status === "error").length;
  const finished = all.filter((file) => file.ocr_status === "complete" || file.ocr_status === "error").length;
  const ocrStatus = finished < all.length ? "processing" : failed ? "partial" : "complete";
  const { error: updateError } = await db
    .from("scribe_cloud_sessions")
    .update({
      file_count: all.length,
      ocr_status: ocrStatus,
      ocr_completed_at: ocrStatus === "processing" ? null : new Date().toISOString(),
    })
    .eq("id", target.id);
  if (updateError) throw new Error(updateError.message);

  const { data: entry } = await db
    .from("scribe_library_entries")
    .select("revision")
    .eq("library_id", library.id)
    .eq("kind", "doc")
    .eq("entry_id", "cloud-" + session.id)
    .maybeSingle();
  if (entry) {
    await db.rpc("scribe_write_entry", { p_library: library.id, p_kind: "doc", p_id: "cloud-" + session.id, p_value: null, p_deleted: true, p_revision: entry.revision });
  }
  const { error: deleteError } = await db.from("scribe_cloud_sessions").delete().eq("id", session.id);
  if (deleteError) throw new Error(deleteError.message);
  console.log("[scribe-mobile-upload] absorb", session.id, "->", target.id, incoming.length, "pages");
  return json({ ok: true, into: target.id, pages: all.length, added: incoming.length });
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
    body = (await req.json()) as Row;
  } catch {
    return fail("请求格式不正确。");
  }

  const action = String(body.action || "");
  try {
    if (action === "create") return await createSession(db, body);
    if (action === "reorder") return await reorderSession(db, body);

    const session = await sessionByToken(db, body.token);
    if (!session) return json({ error: "此上传通道已失效，请重新生成二维码。" }, 410);

    switch (action) {
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

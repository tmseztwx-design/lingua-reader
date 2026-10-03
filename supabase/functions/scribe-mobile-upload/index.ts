// 手机跨网络上传中转：手机（任意网络）→ Enter 云私有桶，电脑/任意设备凭 token 取回。
// 所有动作都由 token 鉴权；数据库对客户端默认拒绝，只有本函数（服务角色）可以读写。
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const BUCKET = "scribe-pages";
const LINK_TTL_MS = 24 * 60 * 60 * 1000;
const SHORT_URL_TTL = 60 * 60;
const PAGE_URL_TTL = 60 * 60 * 24 * 365;
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

async function sessionByToken(db: ReturnType<typeof createClient>, token: unknown) {
  if (typeof token !== "string" || token.length < 10) return null;
  const { data } = await db.from("scribe_cloud_sessions").select("*").eq("token", token).maybeSingle();
  if (!data) return null;
  if (new Date(String((data as Row).expires_at)).getTime() <= Date.now()) return null;
  return data as Row;
}

async function filesOf(db: ReturnType<typeof createClient>, sessionId: string) {
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

async function refreshCounts(db: ReturnType<typeof createClient>, session: Row) {
  const files = await filesOf(db, String(session.id));
  const uploaded = files.filter((file) => file.uploaded_at);
  await db.from("scribe_cloud_sessions").update({ file_count: uploaded.length }).eq("id", session.id);
  return files;
}

async function createSession(db: ReturnType<typeof createClient>, body: Row) {
  const now = Date.now();
  const { data: open } = await db
    .from("scribe_cloud_sessions")
    .select("id")
    .gt("expires_at", new Date(now).toISOString())
    .is("completed_at", null)
    .limit(MAX_OPEN_SESSIONS + 1);
  if ((open || []).length > MAX_OPEN_SESSIONS) {
    return json({ error: "云端待上传的通道过多，请先完成或删除旧通道。" }, 429);
  }
  const token = makeToken();
  const expiresAt = new Date(now + LINK_TTL_MS).toISOString();
  const title = typeof body.title === "string" ? cleanName(body.title).slice(0, 120) : null;
  const { data, error } = await db
    .from("scribe_cloud_sessions")
    .insert({ token, expires_at: expiresAt, title })
    .select("*")
    .single();
  if (error || !data) throw new Error(error?.message || "无法建立云端上传通道。");
  return json({ token, sessionId: data.id, expiresAt });
}

async function signUpload(db: ReturnType<typeof createClient>, session: Row, body: Row) {
  const name = cleanName(body.name);
  const extension = extensionOf(name);
  if (!allowedExtensions.has(extension)) return fail("仅支持 PDF、DOC、DOCX、JPG、PNG、HEIC 或 HEIF 文件。", 415);
  const size = Number(body.size);
  if (Number.isFinite(size) && size > MAX_BYTES) return fail("单个文件不能超过 100 MB。", 413);
  const files = await filesOf(db, String(session.id));
  if (files.length >= MAX_FILES) return fail(`单批最多 ${MAX_FILES} 个文件。`, 413);

  const order = Number.isInteger(Number(body.order)) && Number(body.order) >= 0 ? Number(body.order) : files.length;
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

async function registerUpload(db: ReturnType<typeof createClient>, session: Row, body: Row) {
  const fileId = String(body.fileId || "");
  if (!fileId) return fail("缺少文件标识。");
  const size = Number(body.size);
  if (Number.isFinite(size) && size > MAX_BYTES) {
    await db.from("scribe_cloud_files").delete().eq("id", fileId).eq("session_id", session.id);
    return fail("单个文件不能超过 100 MB。", 413);
  }
  const { error } = await db
    .from("scribe_cloud_files")
    .update({
      uploaded_at: new Date().toISOString(),
      size: Number.isFinite(size) ? size : 0,
      ...(typeof body.mime === "string" && body.mime ? { mime: body.mime } : {}),
    })
    .eq("id", fileId)
    .eq("session_id", session.id);
  if (error) throw new Error(error.message);
  await refreshCounts(db, session);
  return json({ ok: true, fileId });
}

async function completeSession(db: ReturnType<typeof createClient>, session: Row) {
  const files = await refreshCounts(db, session);
  const uploaded = files.filter((file) => file.uploaded_at);
  if (!uploaded.length) return fail("还没有收到可识别的页面。", 409);
  const { error } = await db
    .from("scribe_cloud_sessions")
    .update({ completed_at: new Date().toISOString(), file_count: uploaded.length })
    .eq("id", session.id);
  if (error) throw new Error(error.message);
  console.log("[scribe-mobile-upload] complete", session.id, uploaded.length);
  return json({ ok: true, fileCount: uploaded.length, expiresAt: session.expires_at });
}

async function signedUrls(db: ReturnType<typeof createClient>, session: Row, ttl: number, onlyFileId?: string) {
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

async function resultsOf(db: ReturnType<typeof createClient>, session: Row) {
  const { data } = await db
    .from("scribe_cloud_files")
    .select("id, queue_order, name, mime, ocr_text, ocr_status, ocr_error")
    .eq("session_id", session.id)
    .order("queue_order", { ascending: true });
  return ((data || []) as Row[]).map((file) => ({
    id: file.id,
    order: file.queue_order,
    name: file.name,
    mime: file.mime,
    text: typeof file.ocr_text === "string" ? file.ocr_text : "",
    ocrStatus: file.ocr_status,
    ocrError: file.ocr_error || "",
  }));
}

async function removeSession(db: ReturnType<typeof createClient>, session: Row) {
  const { data: listed } = await db.storage.from(BUCKET).list(String(session.id), { limit: 1000 });
  const paths = (listed || []).map((item) => `${session.id}/${item.name}`);
  if (paths.length) await db.storage.from(BUCKET).remove(paths);
  const { error } = await db.from("scribe_cloud_sessions").delete().eq("id", session.id);
  if (error) throw new Error(error.message);
  console.log("[scribe-mobile-upload] remove", session.id, paths.length);
  return json({ ok: true, removedFiles: paths.length });
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
      default:
        return fail("不支持的操作。");
    }
  } catch (error) {
    console.error("[scribe-mobile-upload]", action, error);
    return fail(error instanceof Error ? error.message : "云端处理失败，请重试。", 500);
  }
});

// 由 scripts/bundle-functions.mjs 从 supabase/functions/src/scribe-queue.ts 生成，请勿直接编辑。
// 修改源文件后运行：pnpm bundle:functions

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// ---- 共享模块（supabase/functions/_shared 内联，平台只部署单文件） ----
const __shared = (() => {
  declare const EdgeRuntime:{waitUntil(task:Promise<unknown>):void};
  type Row = Record<string, any>;
  const BUCKET = "scribe-pages";
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
  async function libraryFor(db: ReturnType<typeof database>, key: unknown) {
    if (typeof key !== "string" || !/^[a-f0-9]{64}$/.test(key)) return null;
    const bytes = await crypto.subtle.digest("SHA-256",new TextEncoder().encode(key));
    const hash = Array.from(new Uint8Array(bytes),n=>n.toString(16).padStart(2,"0")).join("");
    const {data,error} = await db.from("scribe_libraries").select("id").eq("access_hash",hash).maybeSingle();
    if (error) throw new Error(error.message);
    return data;
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
  // 云端逐页识别：每次只处理一个文件，避免函数超时；由前端按顺序调用，失败可单页重试。
  // 图片与 PDF 交给 GPT 视觉模型直接读取；docx 用内置解压提取文本。结果写回数据库，任何设备都能读取。

  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };

  const AI_BASE_URL = "https://api.enter.pro";
  const AI_TOKEN_SECRET = "AI_API_TOKEN_3ef6055a44e1";
  const PROJECT_ID = "3ef6055a44e1ce0572332c487d8ffbb4";
  // 高并发、低成本的 GPT 模型，用于逐页原文转录。
  const DEFAULT_MODEL = "openai/gpt-6-luna";
  const SIGNED_IMAGE_TTL = 15 * 60;
  const MAX_INLINE_BYTES = 8 * 1024 * 1024;
  const NL = String.fromCharCode(10);
  const TAB = String.fromCharCode(9);

  const PROMPT = [
    "你是专业文献的页面转录引擎。请把内容中的文字逐字转录为纯文本，规则：",
    "1. 只输出原文，不要翻译、不要总结、不要解释、不要添加任何说明或标题。",
    "2. 保留段落结构与换行；保留原有标点、大小写与拼写，包括原文中的错误。",
    "3. 页眉、页脚、页码、脚注按出现顺序照常转录，可在行首用 [页眉]/[页脚]/[脚注] 标注。",
    "4. 无法辨认的字用 ␗ 代替，不要猜测或补全。",
    "5. 如果内容中确实没有文字，只输出：NO_TEXT",
  ].join(NL);

  type Row = Record<string, unknown>;

  function json(body: unknown, status = 200) {
    return new Response(JSON.stringify(body), {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
    });
  }

  function extensionOf(name: string) {
    const match = String(name || "").toLowerCase().match(/\.[a-z0-9]+$/);
    return match ? match[0] : "";
  }

  function toBase64(bytes: Uint8Array) {
    let binary = "";
    const chunk = 0x8000;
    for (let index = 0; index < bytes.length; index += chunk) {
      binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
    }
    return btoa(binary);
  }

  function parseResponsesText(payload: Row | null) {
    if (!payload) return "";
    const direct = payload.output_text;
    if (typeof direct === "string" && direct.trim()) return direct.trim();
    const output = Array.isArray(payload.output) ? payload.output : [];
    const parts: string[] = [];
    for (const item of output as Row[]) {
      if (item?.type !== "message" || !Array.isArray(item.content)) continue;
      for (const block of item.content as Row[]) {
        if (typeof block?.text === "string") parts.push(block.text);
      }
    }
    return parts.join("").trim();
  }

  // 走 openai_responses 协议；parts 里放 input_image 或 input_file。
  async function runAi(input: { parts: Row[]; model: string; sessionId: string }) {
    const apiToken = Deno.env.get(AI_TOKEN_SECRET);
    if (!apiToken) throw new Error("AI 服务未配置，请联系管理员。");

    const response = await fetch(`${AI_BASE_URL}/code/api/v1/ai/responses`, {
      method: "POST",
      signal: AbortSignal.timeout(65000),
      headers: {
        Authorization: `Bearer ${apiToken}`,
        "Content-Type": "application/json",
        "X-Session-ID": input.sessionId,
        "X-Enter-Project-ID": PROJECT_ID,
      },
      body: JSON.stringify({
        model: input.model,
        stream: false,
        input: [{ role: "user", content: [{ type: "input_text", text: PROMPT }, ...input.parts] }],
      }),
    });

    const raw = await response.text();
    let payload: Row | null = null;
    try { payload = JSON.parse(raw) as Row; } catch { /* 上游可能返回非 JSON */ }
    if (!response.ok) {
      const message = String((payload?.error as Row | undefined)?.message || raw.slice(0, 300) || "AI 服务错误");
      throw new Error(message);
    }
    return parseResponsesText(payload);
  }

  async function transcribeImage(input: { bytes: Uint8Array; mime: string; signedUrl?: string; model: string; sessionId: string }) {
    const inline = () => runAi({
      model: input.model,
      sessionId: input.sessionId,
      parts: [{ type: "input_image", image_url: `data:${input.mime};base64,${toBase64(input.bytes)}` }],
    });

    if (!input.signedUrl) return await inline();
    return await runAi({
      model: input.model,
      sessionId: input.sessionId,
      parts: [{ type: "input_image", image_url: input.signedUrl }],
    }).catch(async (error: unknown) => {
      console.warn("[scribe-ocr] signed url failed, retry inline:", error instanceof Error ? error.message : error);
      return await inline();
    });
  }

  async function transcribePdf(input: { bytes: Uint8Array; name: string; model: string; sessionId: string }) {
    if (input.bytes.length > MAX_INLINE_BYTES) {
      throw new Error("PDF 超过云端单次读取上限（8 MB），请拆分页数，或用手机拍照上传页面。");
    }
    return await runAi({
      model: input.model,
      sessionId: input.sessionId,
      parts: [{
        type: "input_file",
        filename: input.name,
        file_data: `data:application/pdf;base64,${toBase64(input.bytes)}`,
      }],
    });
  }

  function decodeEntities(value: string) {
    return value
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, String.fromCharCode(34))
      .replace(/&apos;/g, String.fromCharCode(39))
      .replace(/&amp;/g, "&");
  }

  async function inflateRaw(bytes: Uint8Array) {
    const stream = new Blob([new Uint8Array(bytes).buffer]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  // docx 就是一个 zip：只取 word/document.xml，按段落还原文本，避免引入原生依赖。
  async function extractDocxText(bytes: Uint8Array) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let eocd = -1;
    for (let index = bytes.length - 22; index >= 0 && index >= bytes.length - 66000; index -= 1) {
      if (view.getUint32(index, true) === 0x06054b50) { eocd = index; break; }
    }
    if (eocd < 0) throw new Error("Word 文档无法解析（不是有效的 docx）。");

    const entries = view.getUint16(eocd + 10, true);
    let cursor = view.getUint32(eocd + 16, true);
    for (let index = 0; index < entries; index += 1) {
      if (view.getUint32(cursor, true) !== 0x02014b50) break;
      const method = view.getUint16(cursor + 10, true);
      const compressedSize = view.getUint32(cursor + 20, true);
      const nameLength = view.getUint16(cursor + 28, true);
      const extraLength = view.getUint16(cursor + 30, true);
      const commentLength = view.getUint16(cursor + 32, true);
      const localOffset = view.getUint32(cursor + 42, true);
      const name = new TextDecoder().decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength));

      if (name === "word/document.xml") {
        const localNameLength = view.getUint16(localOffset + 26, true);
        const localExtraLength = view.getUint16(localOffset + 28, true);
        const start = localOffset + 30 + localNameLength + localExtraLength;
        const data = bytes.subarray(start, start + compressedSize);
        const xml = new TextDecoder().decode(method === 0 ? data : await inflateRaw(data));
        return decodeEntities(
          xml
            .replace(/<w:p[ >][^>]*>/g, NL)
            .replace(/<\/w:p>/g, NL)
            .replace(/<w:tab[^>]*\/>/g, TAB)
            .replace(/<w:br[^>]*\/>/g, NL)
            .replace(/<[^>]+>/g, ""),
        )
          .split(NL)
          .map((line) => line.trim())
          .filter((line, position, all) => Boolean(line) || (position > 0 && Boolean(all[position - 1])))
          .join(NL)
          .trim();
      }
      cursor += 46 + nameLength + extraLength + commentLength;
    }
    throw new Error("Word 文档里没有找到正文。");
  }

  async function transcribe(file: Row, storagePath: string, db: ReturnType<typeof database>, sessionId: string, model: string) {
    const extension = extensionOf(String(file.name));
    const mime = String(file.mime || "application/octet-stream");

    if (extension === ".heic" || extension === ".heif") {
      throw new Error("HEIC 图片暂时无法在云端识别，请改用手机拍照上传（系统相册选择通常会自动转成 JPEG）。");
    }

    const { data: blob, error } = await db.storage.from(BUCKET).download(storagePath);
    if (error || !blob) throw new Error(error?.message || "无法读取云端原页。");
    const bytes = new Uint8Array(await blob.arrayBuffer());

    if (extension === ".txt") return new TextDecoder().decode(bytes).trim();
    if (extension === ".docx") return await extractDocxText(bytes);
    if (extension === ".doc") throw new Error("暂不支持旧版 .doc，请另存为 .docx 或 PDF 后重试。");
    if (extension === ".pdf") return await transcribePdf({ bytes, name: String(file.name), model, sessionId });
    if (!mime.startsWith("image/")) throw new Error(`暂不支持此文件类型：${extension || mime}`);

    const { data: signed } = await db.storage.from(BUCKET).createSignedUrl(storagePath, SIGNED_IMAGE_TTL);
    return await transcribeImage({ bytes, mime, signedUrl: signed?.signedUrl, model, sessionId });
  }
  return { json, database, randomKey, libraryFor, hashKey, wakeQueue, BUCKET, cors, transcribe };
})();
const { database, json, wakeQueue, BUCKET, transcribe } = __shared;

// ---- 函数实现 ----
declare const EdgeRuntime:{waitUntil(task:Promise<unknown>):void};

async function work(db: ReturnType<typeof database>) {
  await cleanup(db);
  const started=Date.now();
  for(let count=0;count<5 && Date.now()-started<40000;count++) {
    const {data:file,error}=await db.rpc("scribe_claim_page");
    if(error) throw new Error(error.message);
    if(!file) return;
    let text="",failure: string|null=null;
    try {
      text=await transcribe(file,file.storage_path,db,file.session_id,"openai/gpt-6-luna");
      if(!text.trim() || /^NO_TEXT$/i.test(text.trim())) throw new Error("这一页没有识别到文字，请检查原图。");
    }catch(e){failure=e instanceof Error?e.message:"识别失败，可重试。";}
    const {error:finishError}=await db.rpc("scribe_finish_page",{
      p_id:file.id,p_lease:file.lease_id,p_text:text,p_error:failure,
    });
    if(finishError) throw new Error(finishError.message);
  }
  await wakeQueue(db);
}

async function cleanup(db:ReturnType<typeof database>) {
  const {data:candidates,error:candidateError}=await db.rpc('scribe_cleanup_candidates');
  if(candidateError)throw new Error(candidateError.message);
  for(const session of candidates||[]){
    const {data:objects,error:listError}=await db.storage.from(BUCKET).list(session.id,{limit:1000});
    if(listError)continue;
    if(objects?.length){const {error}=await db.storage.from(BUCKET).remove(objects.map(item=>session.id+'/'+item.name));if(error)continue;}
    const {error}=await db.from('scribe_cloud_sessions').delete().eq('id',session.id).eq('library_id',session.library_id);
    if(error)continue;
  }
}

Deno.serve(async req=>{
  if(req.method!=="POST") return json({error:"不支持的操作"},405);
  try {
    const db=database();
    const {data}=await db.from("scribe_runtime_settings").select("worker_secret").eq("id",true).single();
    if(!data || req.headers.get("x-scribe-worker-key")!==data.worker_secret) return json({error:"禁止访问"},403);
    const task=work(db).catch(e=>console.error("[scribe-queue]",e.message));
    EdgeRuntime.waitUntil(task);
    return json({queued:true},202);
  }catch(e){console.error("[scribe-queue]",e);return json({error:"后台服务暂不可用"},503);}
});

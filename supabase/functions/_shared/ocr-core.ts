// 云端逐页识别：每次只处理一个文件，避免函数超时；由前端按顺序调用，失败可单页重试。
// 工作机制为两段式：先用视觉模型逐字转录页面（初稿），再把原图连同初稿交给模型审校——
// 对照原图补全遗漏、修正缺词漏词与不通顺之处、合并硬换行并输出干净排版；审校失败时回退初稿。
// 图片与 PDF 交给 GPT 视觉模型直接读取；docx 用内置解压提取文本。结果写回数据库，任何设备都能读取。
import {database, BUCKET} from "./cloud.ts";

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
  "2. 保留原有标点、大小写与拼写，包括原文中的错误；段落之间用一个空行分隔。",
  "3. 不要输出 <br> 或任何 HTML 标签、Markdown 标记，只输出纯文本。",
  "4. 页眉、页脚、页码、脚注按出现顺序照常转录，可在行首用 [页眉]/[页脚]/[脚注] 标注。",
  "5. 无法辨认的字用 ␗ 代替，不要猜测或补全。",
  "6. 如果内容中确实没有文字，只输出：NO_TEXT",
].join(NL);

const REVIEW_PROMPT = [
  "你是文献转录的审校员。给你同一份页面内容和一份初步转录稿。请对照原图逐行审查并输出最终文本：",
  "1. 补全遗漏的文字、行与段落；修正认错、漏掉或明显不通顺、缺词漏词的地方，一律以原图为准。",
  "2. 不要臆造页面上没有的内容；仍无法辨认的字保留 ␗。",
  "3. 把被硬换行拆开的句子合并成通顺的连续文本，段落之间用一个空行分隔。",
  "4. 不要输出 <br> 或任何 HTML 标签、Markdown 标记；不要翻译、总结或评论。",
  "5. 只输出审校后的原文。初步转录稿如下：",
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
async function runAi(input: { parts: Row[]; model: string; sessionId: string; prompt?: string }) {
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
      input: [{ role: "user", content: [{ type: "input_text", text: input.prompt || PROMPT }, ...input.parts] }],
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

// 两段式识别：先转录初稿，再对照原图审校（查漏、补缺、排版）。审校失败不阻塞，回退初稿。
async function transcribeWithReview(input: { parts: Row[]; model: string; sessionId: string }) {
  const draft = await runAi({ model: input.model, sessionId: input.sessionId, parts: input.parts });
  if (!draft || draft === "NO_TEXT") return draft;
  try {
    const reviewed = await runAi({
      model: input.model,
      sessionId: input.sessionId,
      parts: input.parts,
      prompt: REVIEW_PROMPT + NL + NL + draft,
    });
    return reviewed || draft;
  } catch (error: unknown) {
    console.warn("[scribe-ocr] review pass failed, using draft:", error instanceof Error ? error.message : error);
    return draft;
  }
}

async function transcribeImage(input: { bytes: Uint8Array; mime: string; signedUrl?: string; model: string; sessionId: string }) {
  const inline = () => transcribeWithReview({
    model: input.model,
    sessionId: input.sessionId,
    parts: [{ type: "input_image", image_url: `data:${input.mime};base64,${toBase64(input.bytes)}` }],
  });

  if (!input.signedUrl) return await inline();
  return await transcribeWithReview({
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
  return await transcribeWithReview({
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

export async function transcribe(file: Row, storagePath: string, db: ReturnType<typeof database>, sessionId: string, model: string) {
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

// 由 scripts/bundle-functions.mjs 从 supabase/functions/src/scribe-study.ts 生成，请勿直接编辑。
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
  // 工作机制为两段式：先用视觉模型逐字转录页面（初稿），再把原图连同初稿交给模型审校——
  // 对照原图补全遗漏、修正缺词漏词与不通顺之处、合并硬换行并输出干净排版；审校失败时回退初稿。
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
    "2. 严格遵循原文的段落分布：章标题、小节标题、列表项、引文块各自单独成段；正文段落之间用一个空行分隔；不要把不同的段落合并成一段。",
    "3. 同一段落内仅因页面宽度被折断的句子，合并为连续文本；不要输出 <br> 或任何 HTML 标签、Markdown 标记，只输出纯文本。",
    "4. 页眉、页脚、页码、脚注按出现顺序照常转录，可在行首用 [页眉]/[页脚]/[脚注] 标注。",
    "5. 无法辨认的字用 ␗ 代替，不要猜测或补全。",
    "6. 如果内容中确实没有文字，只输出：NO_TEXT",
  ].join(NL);

  const REVIEW_PROMPT = [
    "你是文献转录的审校员。给你同一份页面内容和一份初步转录稿。请对照原图逐行审查并输出最终文本：",
    "1. 补全遗漏的文字、行与段落；修正认错、漏掉或明显不通顺、缺词漏词的地方，一律以原图为准。",
    "2. 不要臆造页面上没有的内容；仍无法辨认的字保留 ␗。",
    "3. 按原文的段落分布输出：标题、列表项、引文各自单独成段，段落之间用一个空行分隔；同一段落内被硬换行拆开的句子合并成通顺的连续文本；不要把不同段落堆在一起。",
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
  async function runAi(input: { parts: Row[]; model: string; sessionId: string; prompt?: string; maxOutputTokens?: number }) {
    const apiToken = Deno.env.get(AI_TOKEN_SECRET);
    if (!apiToken) throw new Error("AI 服务未配置，请联系管理员。");

    const body: Row = {
      model: input.model,
      stream: false,
      input: [{ role: "user", content: [{ type: "input_text", text: input.prompt || PROMPT }, ...input.parts] }],
    };
    if (input.maxOutputTokens) body.max_output_tokens = input.maxOutputTokens;

    const response = await fetch(`${AI_BASE_URL}/code/api/v1/ai/responses`, {
      method: "POST",
      signal: AbortSignal.timeout(65000),
      headers: {
        Authorization: `Bearer ${apiToken}`,
        "Content-Type": "application/json",
        "X-Session-ID": input.sessionId,
        "X-Enter-Project-ID": PROJECT_ID,
      },
      body: JSON.stringify(body),
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

  // 逐段译文：与识别共用同一条模型通道。整页一次性翻译，段落数量与原文严格对齐，
  // 前端因此可以给每一段配一个折叠标志。翻译失败不阻塞识别，交由客户端按页补齐。
  const TRANSLATE_PROMPT = [
    "你是精通学术英语与中文的专业译者。请把下面编号的英文段落逐段翻译成中文，规则：",
    "1. 逐段对齐：第 N 个译文对应第 N 段原文，译文数组长度必须与输入段落数量完全一致，不合并、不拆分、不增删。",
    "2. 译文要准确、通顺，符合中文学术阅读习惯；术语按学科惯例翻译，首次出现可在括号内保留英文原词。",
    "3. 不要输出原文、不要解释、不要评论、不要加译者注，译文内部不要保留原文的硬换行。",
    "4. 只输出一个 JSON 字符串数组，例如 [\"第一段译文\",\"第二段译文\"]，不要输出 Markdown 代码块、序号或任何其它文字。",
    "5. 某段若无实质内容，对应位置输出空字符串。",
  ].join(NL);

  const TRANSLATE_MODEL = "openai/gpt-5.5";
  const TRANSLATE_MAX_PARAGRAPHS = 80;

  function splitParagraphs(text: string) {
    return String(text || "")
      .replace(/<br\s*\/?>/gi, NL)
      .replace(/\r\n?/g, NL)
      .split(/\n[ \t]*\n+/)
      .map((paragraph) => paragraph.replace(/[ \t]*\n[ \t]*/g, " ").replace(/[ \t]{2,}/g, " ").trim())
      .filter(Boolean);
  }

  function parseStringArray(value: string) {
    const start = value.indexOf("[");
    const end = value.lastIndexOf("]");
    if (start < 0 || end <= start) return null;
    try {
      const parsed = JSON.parse(value.slice(start, end + 1));
      return Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  async function translateParagraphs(text: string, sessionId: string) {
    const paragraphs = splitParagraphs(text).slice(0, TRANSLATE_MAX_PARAGRAPHS);
    if (!paragraphs.length) return [];
    const numbered = paragraphs.map((paragraph, index) => `${index + 1}. ${paragraph}`).join(NL + NL);
    try {
      const answer = await runAi({
        model: TRANSLATE_MODEL,
        sessionId,
        parts: [],
        prompt: TRANSLATE_PROMPT + NL + NL + numbered,
        maxOutputTokens: 8192,
      });
      const lines = parseStringArray(answer);
      if (!lines) throw new Error("译文不是可解析的数组");
      if (lines.length !== paragraphs.length) console.warn("[scribe-ocr] translation paragraph count mismatch", lines.length, paragraphs.length);
      return paragraphs.map((paragraph, index) => ({
        text: paragraph,
        translation: typeof lines[index] === "string" ? lines[index].trim() : "",
      }));
    } catch (error: unknown) {
      console.warn("[scribe-ocr] translation failed:", error instanceof Error ? error.message : error);
      return [];
    }
  }

  // 点词卡片词典：按句子语境给出音标与释义，调用方负责缓存，避免同一词反复消耗额度。
  const DEFINE_PROMPT = [
    "你是英语学习词典的编辑。请根据每个单词下面给出的所在句子，判断它在该语境中的含义，规则：",
    "1. phonetic 用国际音标 IPA 并用斜杠包裹，例如 /ˈeɪdʒənsi/，以英式读音为准。",
    "2. gloss 给出该词在此语境下的最简释义，2~6 个汉字，例如「文化」「调节思维」，不要带词性标记。",
    "3. meaning 只解释该词在本句中的含义，必要时说明词性与常见搭配，20-40 个汉字。",
    "4. 若该词在句中是专有名词、缩写或非常用写法，含义直接说明它在句中的所指。",
    "5. 只输出一个 JSON 数组，元素顺序与输入完全一致，每项形如 {\"word\":\"...\",\"phonetic\":\"...\",\"gloss\":\"...\",\"meaning\":\"...\"}；不要输出 Markdown 代码块或其它文字。",
  ].join(NL);

  const DEFINE_MODEL = "openai/gpt-6-luna";

  function parseObjectArray(value: string) {
    const start = value.indexOf("[");
    const end = value.lastIndexOf("]");
    if (start < 0 || end <= start) return null;
    try {
      const parsed = JSON.parse(value.slice(start, end + 1));
      return Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  async function defineWords(items: { word: string; sentence: string }[], sessionId: string) {
    if (!items.length) return [];
    const numbered = items
      .map((item, index) => `${index + 1}. 单词：${item.word}${NL}   所在句子：${item.sentence || "（未提供上下文）"}`)
      .join(NL + NL);
    const answer = await runAi({
      model: DEFINE_MODEL,
      sessionId,
      parts: [],
      prompt: DEFINE_PROMPT + NL + NL + numbered,
      maxOutputTokens: 4096,
    });
    const parsed = parseObjectArray(answer);
    if (!parsed) throw new Error("未能取得音标与释义，请稍后重试。");
    return items.map((item, index) => {
      const found = (parsed[index] || {}) as Row;
      return {
        word: item.word,
        phonetic: typeof found.phonetic === "string" ? found.phonetic.trim() : "",
        gloss: typeof found.gloss === "string" ? found.gloss.trim() : "",
        meaning: typeof found.meaning === "string" ? found.meaning.trim() : "",
      };
    });
  }

  // 短语与句子的随读解释：短语给简洁释义，句子给通顺全译；调用方把结果存进卡片，不走词典缓存。
  const EXPLAIN_PROMPT = [
    "你是英语精读辅导员。下面给出若干条短语或句子及其出处语境，请逐条给出中文解释，规则：",
    "1. translation：短语给出简洁释义（2~12 个汉字）；句子给出通顺的完整译文。",
    "2. 释义以语境为准，不要逐词直译；不要输出原文、不要评论。",
    "3. 只输出一个 JSON 数组，元素顺序与输入完全一致，每项形如 {\"translation\":\"...\"}；不要输出 Markdown 代码块或其它文字。",
  ].join(NL);

  async function explainExpressions(items: { term: string; sentence: string }[], sessionId: string) {
    if (!items.length) return [];
    const numbered = items
      .map((item, index) => `${index + 1}. 内容：${item.term}${NL}   出处语境：${item.sentence || "（未提供上下文）"}`)
      .join(NL + NL);
    const answer = await runAi({
      model: DEFINE_MODEL,
      sessionId,
      parts: [],
      prompt: EXPLAIN_PROMPT + NL + NL + numbered,
      maxOutputTokens: 4096,
    });
    const parsed = parseObjectArray(answer);
    if (!parsed) throw new Error("未能生成解释，请稍后重试。");
    return items.map((item, index) => {
      const found = (parsed[index] || {}) as Row;
      return { term: item.term, translation: typeof found.translation === "string" ? found.translation.trim() : "" };
    });
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
  return { json, database, randomKey, libraryFor, hashKey, wakeQueue, BUCKET, cors, splitParagraphs, translateParagraphs, parseObjectArray, defineWords, explainExpressions, transcribe };
})();
const { database, json, libraryFor, defineWords, explainExpressions, translateParagraphs } = __shared;

// ---- 函数实现 ----
// 阅读辅助服务，由书库同步码鉴权（客户端不接触任何服务端密钥）：
//   define    点词卡片查询音标与当前语境释义，结果写入词典缓存，跨设备复用。
//   translate 为还没有译文的页面补齐逐段中文译文（旧文献与识别时翻译失败的页面都走这里）。
// 数据访问只经由本函数（服务角色），数据库对客户端默认拒绝。


const MAX_WORDS = 24;
const MAX_EXPLAIN = 12;
const MAX_SENTENCE = 400;
const MAX_TERM = 300;

type Row = Record<string, any>;

function cacheKey(word: string, sentence: string) {
  return (String(word).toLowerCase() + "|" + String(sentence).toLowerCase()).slice(0, 500);
}

async function defineAction(db: ReturnType<typeof database>, libraryId: string, body: Row) {
  const raw = Array.isArray(body.words) ? body.words.slice(0, MAX_WORDS) : [];
  const items = raw
    .map((item: Row) => ({
      word: String(item?.word || "").trim().slice(0, 64),
      sentence: String(item?.sentence || "").replace(/\s+/g, " ").trim().slice(0, MAX_SENTENCE),
    }))
    .filter((item: { word: string }) => /^[A-Za-z][A-Za-z'’-]*$/.test(item.word));
  if (!items.length) return json({ words: [] });

  const keys = items.map((item: { word: string; sentence: string }) => cacheKey(item.word, item.sentence));
  const { data: cached, error: cacheError } = await db
    .from("scribe_word_cache")
    .select("cache_key, phonetic, gloss, meaning")
    .in("cache_key", keys);
  if (cacheError) throw new Error(cacheError.message);
  const known = new Map<string, Row>(((cached || []) as Row[]).map((row) => [String(row.cache_key), row]));

  const missing = items.filter((_item: unknown, index: number) => !known.has(keys[index]));
  if (missing.length) {
    const fresh = await defineWords(missing, libraryId);
    const rows = fresh
      .map((entry, index) => ({
        cache_key: cacheKey(missing[index].word, missing[index].sentence),
        phonetic: entry.phonetic,
        gloss: entry.gloss,
        meaning: entry.meaning,
        updated_at: new Date().toISOString(),
      }))
      .filter((row) => row.meaning || row.phonetic || row.gloss);
    if (rows.length) {
      const { error } = await db.from("scribe_word_cache").upsert(rows, { onConflict: "cache_key" });
      if (error) throw new Error(error.message);
    }
    fresh.forEach((entry, index) => {
      if (!entry.phonetic && !entry.meaning && !entry.gloss) return;
      known.set(cacheKey(missing[index].word, missing[index].sentence), { ...entry });
    });
  }

  return json({
    words: items.map((item: { word: string }, index: number) => {
      const row = known.get(keys[index]);
      return { word: item.word, phonetic: row?.phonetic || "", gloss: row?.gloss || "", meaning: row?.meaning || "" };
    }),
  });
}

async function explainAction(libraryId: string, body: Row) {
  const raw = Array.isArray(body.items) ? body.items.slice(0, MAX_EXPLAIN) : [];
  const items = raw
    .map((item: Row) => ({
      term: String(item?.term || "").replace(/\s+/g, " ").trim().slice(0, MAX_TERM),
      sentence: String(item?.sentence || "").replace(/\s+/g, " ").trim().slice(0, MAX_SENTENCE),
    }))
    .filter((item: { term: string }) => /[A-Za-z]/.test(item.term));
  if (!items.length) return json({ items: [] });
  const explained = await explainExpressions(items, libraryId);
  return json({ items: explained });
}

async function translateAction(db: ReturnType<typeof database>, libraryId: string, body: Row) {
  const fileId = String(body.fileId || "");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(fileId)) return json({ error: "缺少页面标识。" }, 400);
  const { data: file, error } = await db
    .from("scribe_cloud_files")
    .select("id, session_id, ocr_text, paragraphs")
    .eq("id", fileId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!file) return json({ error: "未找到这一页。" }, 404);
  const { data: session, error: sessionError } = await db
    .from("scribe_cloud_sessions")
    .select("id, library_id, deleted_at")
    .eq("id", file.session_id)
    .maybeSingle();
  if (sessionError) throw new Error(sessionError.message);
  if (!session || session.library_id !== libraryId || session.deleted_at) return json({ error: "这一页不属于当前书库。" }, 403);

  if (Array.isArray(file.paragraphs) && file.paragraphs.length) return json({ paragraphs: file.paragraphs, cached: true });
  const text = typeof file.ocr_text === "string" ? file.ocr_text.trim() : "";
  if (!text) return json({ error: "这一页还没有原文，暂时无法生成译文。" }, 409);

  const paragraphs = await translateParagraphs(text, String(file.session_id));
  if (!paragraphs.length) return json({ error: "译文生成失败，请稍后重试。" }, 502);
  const { error: saveError } = await db.from("scribe_cloud_files").update({ paragraphs }).eq("id", file.id);
  if (saveError) throw new Error(saveError.message);
  console.log("[scribe-study] translate", file.id, paragraphs.length);
  return json({ paragraphs });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return json({ ok: true });
  if (req.method !== "POST") return json({ error: "不支持的操作" }, 405);
  try {
    const body = (await req.json()) as Row;
    const db = database();
    const library = await libraryFor(db, body.libraryKey);
    if (!library) return json({ error: "书库同步码无效，请核对后重新连接。" }, 401);
    if (body.action === "define") return await defineAction(db, String(library.id), body);
    if (body.action === "explain") return await explainAction(String(library.id), body);
    if (body.action === "translate") return await translateAction(db, String(library.id), body);
    return json({ error: "不支持的操作。" }, 400);
  } catch (error) {
    console.error("[scribe-study]", error);
    return json({ error: error instanceof Error ? error.message : "服务暂不可用。" }, 500);
  }
});

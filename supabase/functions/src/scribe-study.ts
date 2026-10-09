// 阅读辅助服务，由书库同步码鉴权（客户端不接触任何服务端密钥）：
//   define    点词卡片查询音标与当前语境释义，结果写入词典缓存，跨设备复用。
//   translate 为还没有译文的页面补齐逐段中文译文（旧文献与识别时翻译失败的页面都走这里）。
// 数据访问只经由本函数（服务角色），数据库对客户端默认拒绝。
import {database, json, libraryFor} from "../_shared/cloud.ts";
import {defineWords, explainExpressions, translateParagraphs} from "../_shared/ocr-core.ts";

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

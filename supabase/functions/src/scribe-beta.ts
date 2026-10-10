// 内测码服务：客户端只提交内测码或管理口令，校验、限流与签发全在服务端完成。
//   redeem       输入内测码 → 绑定/取回对应书库的访问凭证（同一码多设备各持一份，数据共用）
//   adminAuth    校验管理口令（口令放在服务端环境变量里，不落库、不进日志、不出现在客户端）
//   adminCreate  生成内测码（明文只在这次响应里返回，入库只存哈希与尾号）
//   adminList    码列表：掩码、备注、状态、绑定时间、活跃度、文献与卡片数量
//   adminRevoke / adminRestore  作废与恢复（只挡新设备登录，已登录设备凭证继续可用）
import {database, json, randomKey, hashKey, libraryFor} from "../_shared/cloud.ts";

const ADMIN_SECRET = "SCRIBE_ADMIN_PASSWORD";
const MAX_CODES = 200;
const MAX_BATCH = 50;
const MAX_FAILURES = 8;
const LOCK_MINUTES = 10;
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

type Row = Record<string, any>;

function normalizeCode(value: unknown) {
  return String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function maskOf(code: string) {
  const clean = String(code || "");
  const tail = clean.slice(-4) || "????";
  const head = clean.slice(0, Math.min(6, Math.max(0, clean.length - 4))) || "SCRIBE";
  return `${head}-****-${tail}`;
}

function randomCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  const body = Array.from(bytes, (byte) => ALPHABET[byte % ALPHABET.length]).join("");
  return `SCRIBE-${body.slice(0, 4)}-${body.slice(4, 8)}`;
}

// 常量时间比较，避免通过响应时间猜口令。
function safeEqual(left: string, right: string) {
  const a = new TextEncoder().encode(left);
  const b = new TextEncoder().encode(right);
  let diff = a.length ^ b.length;
  const size = Math.max(a.length, b.length);
  for (let index = 0; index < size; index += 1) diff |= (a[index] || 0) ^ (b[index] || 0);
  return diff === 0;
}

async function guardState(db: ReturnType<typeof database>) {
  const { data, error } = await db.from("scribe_beta_guard").select("failed_attempts, locked_until").eq("id", true).maybeSingle();
  if (error) throw new Error(error.message);
  return data as Row | null;
}

function lockedMinutes(state: Row | null) {
  const until = state?.locked_until ? new Date(String(state.locked_until)).getTime() : 0;
  return until > Date.now() ? Math.max(1, Math.ceil((until - Date.now()) / 60000)) : 0;
}

async function guardFail(db: ReturnType<typeof database>) {
  const state = await guardState(db);
  const attempts = Number(state?.failed_attempts || 0) + 1;
  const lockedUntil = attempts >= MAX_FAILURES ? new Date(Date.now() + LOCK_MINUTES * 60000).toISOString() : null;
  await db.from("scribe_beta_guard").update({ failed_attempts: attempts, locked_until: lockedUntil }).eq("id", true);
}

async function guardReset(db: ReturnType<typeof database>) {
  await db.from("scribe_beta_guard").update({ failed_attempts: 0, locked_until: null }).eq("id", true);
}

async function requireAdmin(db: ReturnType<typeof database>, body: Row) {
  const state = await guardState(db);
  const minutes = lockedMinutes(state);
  if (minutes) return json({ error: `口令错误次数过多，请 ${minutes} 分钟后再试。` }, 429);
  const secret = Deno.env.get(ADMIN_SECRET);
  if (!secret) return json({ error: "后台口令还没有设置在服务端，请先保存管理口令。" }, 503);
  if (!safeEqual(String(body.password || ""), secret)) {
    await guardFail(db);
    return json({ error: "管理口令不正确。" }, 401);
  }
  await guardReset(db);
  return null;
}

async function redeem(db: ReturnType<typeof database>, body: Row) {
  const state = await guardState(db);
  const minutes = lockedMinutes(state);
  if (minutes) return json({ error: `尝试次数过多，请 ${minutes} 分钟后再试。` }, 429);

  const code = normalizeCode(body.code);
  if (code.length < 6) {
    await guardFail(db);
    return json({ error: "内测码不正确，请核对后重新输入。" }, 400);
  }
  const { data: record, error } = await db.from("scribe_beta_codes").select("*").eq("code_hash", await hashKey(code)).maybeSingle();
  if (error) throw new Error(error.message);
  if (!record) {
    await guardFail(db);
    return json({ error: "内测码无效或已输入错误，请核对后重试。" }, 404);
  }
  if (record.revoked) return json({ error: "这个内测码已被停用，请联系发码人。" }, 403);
  await guardReset(db);

  const now = new Date().toISOString();
  const current = body.libraryKey ? await libraryFor(db, body.libraryKey) : null;

  // 1) 设备已有书库、这个码还没绑定：把这台设备的现有书库绑成该码的内测账号，本机数据一条不丢。
  if (current && !record.library_id) {
    const { error: bindError } = await db
      .from("scribe_beta_codes")
      .update({ library_id: current.id, redeemed_at: now, last_seen_at: now })
      .eq("id", record.id);
    if (bindError) throw new Error(bindError.message);
    console.log("[scribe-beta] redeem bind existing library", record.id);
    return json({ libraryKey: String(body.libraryKey), mask: record.code_mask, label: record.label || "", firstDevice: true, reused: true });
  }

  // 2) 码已绑定书库：为这台设备另签一份凭证，读到的是同一份数据。
  if (record.library_id) {
    const key = randomKey();
    const { error: insertError } = await db
      .from("scribe_library_access")
      .insert({ library_id: record.library_id, access_hash: await hashKey(key), label: record.code_mask });
    if (insertError) throw new Error(insertError.message);
    const { error: touchError } = await db
      .from("scribe_beta_codes")
      .update({ redeemed_at: record.redeemed_at || now, last_seen_at: now })
      .eq("id", record.id);
    if (touchError) throw new Error(touchError.message);
    console.log("[scribe-beta] redeem new device key", record.id);
    return json({ libraryKey: key, mask: record.code_mask, label: record.label || "", firstDevice: false, reused: false });
  }

  // 3) 码未绑定、本机也没有书库：新建书库并绑定。
  const key = randomKey();
  const { data: library, error: createError } = await db.from("scribe_libraries").insert({ access_hash: await hashKey(key) }).select("id").single();
  if (createError || !library) throw new Error(createError?.message || "无法建立书库。");
  const { error: bindError } = await db
    .from("scribe_beta_codes")
    .update({ library_id: library.id, redeemed_at: now, last_seen_at: now })
    .eq("id", record.id);
  if (bindError) throw new Error(bindError.message);
  console.log("[scribe-beta] redeem new library", record.id);
  return json({ libraryKey: key, mask: record.code_mask, label: record.label || "", firstDevice: true, reused: false });
}

function requestedCodes(body: Row) {
  const custom = Array.isArray(body.codes) ? body.codes.map(normalizeCode).filter(Boolean) : [];
  if (custom.length) return { codes: custom.slice(0, MAX_BATCH), custom: true };
  const count = Math.max(1, Math.min(MAX_BATCH, Number(body.count) || 1));
  return { codes: Array.from({ length: count }, () => randomCode()), custom: false };
}

async function adminCreate(db: ReturnType<typeof database>, body: Row) {
  const { codes, custom } = requestedCodes(body);
  for (const code of codes) {
    if (code.length < 6) return json({ error: `内测码「${code}」太短，请至少 6 位字母或数字。` }, 400);
  }
  const unique = [...new Set(codes)];
  if (unique.length !== codes.length) return json({ error: "生成的内测码重复，请重新生成。" }, 409);

  const hashes = new Map<string, string>();
  for (const code of unique) hashes.set(await hashKey(code), code);
  const { data: existing, error: lookupError } = await db.from("scribe_beta_codes").select("code_hash").in("code_hash", [...hashes.keys()]);
  if (lookupError) throw new Error(lookupError.message);
  const taken = new Set((existing || []).map((row: Row) => String(row.code_hash)));
  if (taken.size) {
    if (custom) return json({ error: "这些内测码里有的已经存在，请换一个。" }, 409);
    // 随机码撞库的概率极低，重试一小批即可。
    const retry = requestedCodes({ count: taken.size });
    for (const code of retry.codes) hashes.set(await hashKey(code), code);
  }

  const rows = [...hashes.entries()]
    .filter(([hash]) => !taken.has(hash))
    .map(([hash, code]) => ({ code_hash: hash, code_mask: maskOf(code), label: String(body.label || "").slice(0, 80) }));
  if (!rows.length) return json({ error: "没有可生成的内测码。" }, 409);
  const { error: insertError } = await db.from("scribe_beta_codes").insert(rows);
  if (insertError) throw new Error(insertError.message);
  const plaintext = rows.map((row) => hashes.get(row.code_hash)).filter(Boolean) as string[];
  console.log("[scribe-beta] create", plaintext.length, "codes");
  // 明文只在这里返回一次；库内只留哈希与尾号。
  return json({ codes: plaintext.map((code) => ({ code, mask: maskOf(code) })), label: String(body.label || "") });
}

async function adminList(db: ReturnType<typeof database>) {
  const { data: codes, error } = await db.from("scribe_beta_codes").select("*").order("created_at", { ascending: false }).limit(MAX_CODES);
  if (error) throw new Error(error.message);
  const libraryIds = [...new Set((codes || []).map((row: Row) => row.library_id).filter(Boolean))] as string[];
  const activity = new Map<string, Row>();
  for (const id of libraryIds) {
    const { data: entries, error: entryError } = await db.from("scribe_library_entries").select("kind, deleted, updated_at").eq("library_id", id);
    if (entryError) throw new Error(entryError.message);
    let documents = 0, cards = 0, lastActive = 0;
    for (const entry of (entries || []) as Row[]) {
      if (!entry.deleted && entry.kind === "doc") documents += 1;
      if (!entry.deleted && entry.kind === "card") cards += 1;
      const at = new Date(String(entry.updated_at)).getTime();
      if (at > lastActive) lastActive = at;
    }
    const { data: keys } = await db.from("scribe_library_access").select("access_hash").eq("library_id", id);
    activity.set(id, { documents, cards, devices: (keys || []).length + 1, lastActive: lastActive ? new Date(lastActive).toISOString() : null });
  }
  return json({
    codes: (codes || []).map((row: Row) => ({
      id: row.id,
      mask: row.code_mask,
      label: row.label || "",
      revoked: row.revoked === true,
      createdAt: row.created_at,
      redeemedAt: row.redeemed_at,
      lastSeenAt: row.last_seen_at,
      bound: Boolean(row.library_id),
      ...(row.library_id ? activity.get(row.library_id) || {} : {}),
    })),
  });
}

async function adminSetRevoked(db: ReturnType<typeof database>, body: Row, revoked: boolean) {
  const id = String(body.id || "");
  if (!/^[0-9a-f-]{36}$/i.test(id)) return json({ error: "缺少内测码标识。" }, 400);
  const { data, error } = await db.from("scribe_beta_codes").update({ revoked }).eq("id", id).select("id, code_mask, revoked").maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return json({ error: "未找到这个内测码。" }, 404);
  console.log("[scribe-beta] revoked", id, revoked);
  return json({ ok: true, id: data.id, revoked: data.revoked });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return json({ ok: true });
  if (req.method !== "POST") return json({ error: "不支持的操作" }, 405);
  try {
    const body = (await req.json()) as Row;
    const db = database();
    if (body.action === "redeem") return await redeem(db, body);

    const denied = await requireAdmin(db, body);
    if (denied) return denied;
    if (body.action === "adminAuth") return json({ ok: true });
    if (body.action === "adminCreate") return await adminCreate(db, body);
    if (body.action === "adminList") return await adminList(db);
    if (body.action === "adminRevoke") return await adminSetRevoked(db, body, true);
    if (body.action === "adminRestore") return await adminSetRevoked(db, body, false);
    return json({ error: "不支持的操作。" }, 400);
  } catch (error) {
    console.error("[scribe-beta]", error);
    return json({ error: error instanceof Error ? error.message : "服务暂不可用。" }, 500);
  }
});

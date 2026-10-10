import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
declare const EdgeRuntime:{waitUntil(task:Promise<unknown>):void};
export type Row = Record<string, any>;
export const BUCKET = "scribe-pages";
export const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
export function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {status, headers: {...cors,
    "Content-Type":"application/json; charset=utf-8", "Cache-Control":"no-store"}});
}
export function database() {
  const url = Deno.env.get("SUPABASE_URL"), key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) throw new Error("云端配置缺失。");
  return createClient(url,key,{auth:{persistSession:false}});
}
export function randomKey() {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), n=>n.toString(16).padStart(2,"0")).join("");
}
export async function libraryFor(db: ReturnType<typeof database>, key: unknown) {
  if (typeof key !== "string" || !/^[a-f0-9]{64}$/.test(key)) return null;
  const bytes = await crypto.subtle.digest("SHA-256",new TextEncoder().encode(key));
  const hash = Array.from(new Uint8Array(bytes),n=>n.toString(16).padStart(2,"0")).join("");
  const {data,error} = await db.from("scribe_libraries").select("id").eq("access_hash",hash).maybeSingle();
  if (error) throw new Error(error.message);
  if (data) return data;
  // 内测码在第二台设备登录时会为该设备另签一份凭证，所以再查一次多凭证表。
  const {data:access,error:accessError} = await db.from("scribe_library_access").select("library_id").eq("access_hash",hash).maybeSingle();
  if (accessError) throw new Error(accessError.message);
  return access ? { id: access.library_id as string } : null;
}
export async function hashKey(key: string) {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(key))),n=>n.toString(16).padStart(2,"0")).join("");
}
export async function wakeQueue(db: ReturnType<typeof database>) {
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

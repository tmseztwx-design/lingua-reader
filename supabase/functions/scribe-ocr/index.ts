// 由 scripts/bundle-functions.mjs 从 supabase/functions/src/scribe-ocr.ts 生成，请勿直接编辑。
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
  return { json, database, randomKey, libraryFor, hashKey, wakeQueue, BUCKET, cors };
})();
const { database, json, wakeQueue } = __shared;

// ---- 函数实现 ----
// Compatibility endpoint: enqueue work; OCR execution belongs to the durable worker.

Deno.serve(async req=>{
  if(req.method==="OPTIONS") return json({ok:true});
  if(req.method!=="POST") return json({error:"不支持的操作"},405);
  try {
    const body=await req.json(),db=database();
    const {data:session}=await db.from("scribe_cloud_sessions").select("*").eq("token",String(body.token||"")).maybeSingle();
    if(!session || (!session.completed_at && new Date(session.expires_at).getTime()<=Date.now())) return json({error:"上传通道已失效"},410);
    if(!session.completed_at || session.deleted_at) return json({error:"请先完成整批上传，或恢复已删除的文献。"},409);
    if(body.retry===true) {
      let query=db.from("scribe_cloud_files").update({ocr_status:"pending",attempts:0,retry_at:null,ocr_error:null})
        .eq("session_id",session.id).eq("ocr_status","error");
      if(body.fileId) query=query.eq("id",body.fileId);
      const {data:retried,error}=await query.select('id');
      if(error) throw new Error(error.message);
      if(retried?.length)await db.from("scribe_cloud_sessions").update({ocr_status:"processing",ocr_completed_at:null}).eq("id",session.id);
    }
    await wakeQueue(db);
    return json({queued:true,sessionId:session.id},202);
  }catch(e){return json({error:e instanceof Error?e.message:"请求失败"},500);}
});

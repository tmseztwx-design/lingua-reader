import {database, json, wakeQueue,BUCKET} from "../_shared/cloud.ts";
import {transcribe} from "../_shared/ocr-core.ts";
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

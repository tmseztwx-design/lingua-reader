import {database, json, wakeQueue,BUCKET,allRows} from "../_shared/cloud.ts";
import {transcribe,translateParagraphs} from "../_shared/ocr-core.ts";
declare const EdgeRuntime:{waitUntil(task:Promise<unknown>):void};

// PDF 在浏览器端拆成逐页图片后，一本书就是几十上百页：开 4 条并行通道同时识别，
// scribe_claim_page 用 skip locked 保证同一页不会被两条通道重复领取。
const LANES=4;
async function work(db: ReturnType<typeof database>) {
  await cleanup(db);
  const started=Date.now();
  const results=await Promise.allSettled(Array.from({length:LANES},()=>lane(db,started)));
  results.forEach(r=>{if(r.status==="rejected")console.error("[scribe-queue lane]",r.reason instanceof Error?r.reason.message:r.reason);});
  // 只要有一条通道把队列取空了就不再自唤醒（否则空队列会无限自调用）；cron 每分钟兜底。
  if(results.some(r=>r.status==="fulfilled"&&r.value==="drained")) return;
  await wakeQueue(db);
}

async function lane(db: ReturnType<typeof database>,started:number):Promise<"drained"|"budget"> {
  for(let count=0;count<5 && Date.now()-started<40000;count++) {
    const {data:file,error}=await db.rpc("scribe_claim_page");
    if(error) throw new Error(error.message);
    if(!file) return "drained";
    let text="",failure: string|null=null,paragraphs: unknown[] = [];
    try {
      text=await transcribe(file,file.storage_path,db,file.session_id,"openai/gpt-6-luna");
      if(!text.trim() || /^NO_TEXT$/i.test(text.trim())) throw new Error("这一页没有识别到文字，请检查原图。");
      // 逐段译文与原文同批写回；翻译失败只丢译文，不影响这一页的识别结果。
      paragraphs=await translateParagraphs(text,file.session_id);
    }catch(e){failure=e instanceof Error?e.message:"识别失败，可重试。";}
    const {error:finishError}=await db.rpc("scribe_finish_page",{
      p_id:file.id,p_lease:file.lease_id,p_text:text,p_error:failure,p_paragraphs:paragraphs,
    });
    if(finishError) throw new Error(finishError.message);
  }
  return "budget";
}

async function cleanup(db:ReturnType<typeof database>) {
  const {data:candidates,error:candidateError}=await db.rpc('scribe_cleanup_candidates');
  if(candidateError)throw new Error(candidateError.message);
  for(const session of candidates||[]){
    try{
      const files=await allRows((from,to)=>db.from('scribe_cloud_files').select('id,storage_path').eq('session_id',session.id).order('id').range(from,to));
      const originals=await allRows((from,to)=>db.from('scribe_source_assets').select('id,storage_path').eq('session_id',session.id).order('id').range(from,to));
      const paths=new Set([...files,...originals].map(file=>String(file.storage_path)).filter(Boolean));
      for(let offset=0;;offset+=500){
        const {data,error}=await db.storage.from(BUCKET).list(session.id,{limit:500,offset,sortBy:{column:'name',order:'asc'}});
        if(error)throw error;for(const file of data||[])paths.add(session.id+'/'+file.name);
        if((data||[]).length<500)break;
      }
      const targets=[...paths];
      for(let offset=0;offset<targets.length;offset+=100){const {error}=await db.storage.from(BUCKET).remove(targets.slice(offset,offset+100));if(error)throw error;}
    }catch(error){console.error('[scribe-cleanup]',session.id,error);continue;}
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

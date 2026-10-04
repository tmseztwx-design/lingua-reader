// Compatibility endpoint: enqueue work; OCR execution belongs to the durable worker.
import {database,json,wakeQueue} from "../_shared/cloud.ts";
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

import {database,json,libraryFor,hashKey,randomKey,BUCKET,Row} from "../_shared/cloud.ts";

async function entriesOf(db: ReturnType<typeof database>, id: string) {
  const result:Row[]=[];
  for(let offset=0;;offset+=500){
    const {data,error}=await db.from("scribe_library_entries").select("*").eq("library_id",id).order("kind").order("entry_id").range(offset,offset+499);
    if(error) throw new Error(error.message);
    result.push(...(data||[]));if((data||[]).length<500) return result;
  }
}
async function sessionDocuments(db: ReturnType<typeof database>,libraryId: string) {
  const {data:sessions,error}=await db.from("scribe_cloud_sessions").select("*").eq("library_id",libraryId).is("deleted_at",null).not("completed_at","is",null).order("created_at",{ascending:false});
  if(error) throw new Error(error.message);
  const documents=[];
  for(const session of sessions||[]){
    const {data:files,error:filesError}=await db.from("scribe_cloud_files").select("*").eq("session_id",session.id).not("uploaded_at","is",null).order("queue_order").order("created_at");
    if(filesError) throw new Error(filesError.message);
    const paths=(files||[]).map(file=>file.storage_path);
    const {data:urls}=paths.length?await db.storage.from(BUCKET).createSignedUrls(paths,3600):{data:[]};
    documents.push({
      id:"cloud-"+session.id,cloudSessionId:session.id,title:session.title||((files||[]).length===1?files![0].name.replace(/\.[^.]+$/,""):"云端文献（"+(files||[]).length+" 页）"),
      author:"云端导入",category:"云端文献",status:"reading",progress:0,pages:(files||[]).length,time:"0 h",color:"new",
      processingState:session.ocr_status==="complete"?"ready":session.ocr_status==="partial"?"partial":"processing",
      processingError:session.ocr_status==="partial"?"部分页未能识别，原件已保留，可重试。":"",
      sourcePages:(files||[]).map((file,index)=>({id:"cloud-"+file.id,order:index+1,name:file.name,type:file.mime||"text/plain",url:urls?.[index]?.signedUrl||"",
        text:file.ocr_text||"",confidence:file.ocr_status==="complete"?1:0,error:file.ocr_error||"",sourceFileId:file.id,pageIndex:index,cloud:true})),
      completed:(files||[]).filter(file=>file.ocr_status==="complete"||file.ocr_status==="error").length,
    });
  }
  return documents;
}

Deno.serve(async req=>{
  if(req.method==="OPTIONS") return json({ok:true});
  if(req.method!=="POST") return json({error:"不支持的操作"},405);
  try {
    const raw=await req.text();
    if(raw.length>8*1024*1024) return json({error:"单次同步内容过大，请分批同步。"},413);
    const body=JSON.parse(raw),db=database();
    if(body.action==="create"){
      const key=randomKey();
      const {data,error}=await db.from("scribe_libraries").insert({access_hash:await hashKey(key)}).select("id").single();
      if(error) throw new Error(error.message);
      return json({libraryId:data.id,libraryKey:key});
    }
    const library=await libraryFor(db,body.libraryKey);
    if(!library) return json({error:"书库同步码无效，请核对后重新连接。"},401);
    if(body.action==="attach"){
      // Legacy upload tokens can claim an unowned batch exactly once.
      const {data:session}=await db.from("scribe_cloud_sessions").select("id,library_id").eq("token",String(body.token||"")).maybeSingle();
      if(!session || (session.library_id && session.library_id!==library.id)) return json({error:"无法关联此批次。"},403);
      const {error}=await db.from("scribe_cloud_sessions").update({library_id:library.id}).eq("id",session.id).is("library_id",null);
      if(error) throw new Error(error.message);
      return json({ok:true});
    }
    if(body.action==="validate") return json({libraryId:library.id});
    if(body.action==="trash"){
      const id='cloud-'+String(body.sessionId||'');
      const {data:existing}=await db.from('scribe_library_entries').select('*').eq('library_id',library.id).eq('kind','doc').eq('entry_id',id).maybeSingle();
      const doc=existing?.value || (await sessionDocuments(db,library.id)).find(item=>item.id===id);
      if(!doc) return json({error:'未找到文献。'},404);
      const {data,error}=await db.rpc('scribe_write_entry',{p_library:library.id,p_kind:'doc',p_id:id,p_value:{...doc,deletedAt:new Date().toISOString()},p_deleted:false,p_revision:existing?.revision||0});
      if(error)throw new Error(error.message);
      if(!data.accepted)return json({error:'文献正在另一台设备更新，请同步后重试。'},409);
      return json({ok:true});
    }
    if(body.action==="sessions"){
      const {data,error}=await db.from("scribe_cloud_sessions").select("id,token,created_at,completed_at,ocr_status,file_count").eq("library_id",library.id).is("deleted_at",null).order("created_at",{ascending:false});
      if(error) throw new Error(error.message);
      return json({sessions:data});
    }
    if(body.action!=="sync") return json({error:"不支持的操作。"},400);
    const changes=Array.isArray(body.changes)?body.changes:[];
    if(changes.length>100) return json({error:"单次最多同步 100 项。"},413);
    const conflicts=[];
    for(const change of changes){
      if(!["doc","card","preferences"].includes(change.kind) || typeof change.id!=="string" || change.id.length>160 || !Number.isSafeInteger(change.revision)||change.revision<0) return json({error:"同步记录格式错误。"},400);
      if(change.value!==null && (typeof change.value!=="object" || Array.isArray(change.value))) return json({error:"同步内容格式错误。"},400);
      const {data,error}=await db.rpc("scribe_write_entry",{p_library:library.id,p_kind:change.kind,p_id:change.id,p_value:change.value,p_deleted:change.deleted===true,p_revision:change.revision});
      if(error) throw new Error(error.message);
      if(!data.accepted) conflicts.push({kind:change.kind,id:change.id,entry:data.entry});
    }
    return json({libraryId:library.id,entries:await entriesOf(db,library.id),documents:await sessionDocuments(db,library.id),conflicts});
  }catch(e){console.error("[scribe-library]",e);return json({error:e instanceof SyntaxError?"请求格式错误。":e instanceof Error?e.message:"同步失败。"},500);}
});

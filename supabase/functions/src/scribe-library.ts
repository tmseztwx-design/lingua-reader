import {database,json,libraryFor,BUCKET,Row,withPageCount,allRows,readJsonLimited,randomKey,hashKey} from "../_shared/cloud.ts";

async function entriesOf(db: ReturnType<typeof database>, id: string, known?:Row) {
  if(!known) return allRows((from,to)=>db.from('scribe_library_entries').select('*').eq('library_id',id).order('kind').order('entry_id').range(from,to));
  const versions=await allRows((from,to)=>db.from('scribe_library_entries').select('kind,entry_id,revision').eq('library_id',id).order('kind').order('entry_id').range(from,to));
  const result:Row[]=[];
  for(const kind of ['doc','card','preferences']){
    const ids=versions.filter(row=>row.kind===kind&&known[kind+':'+row.entry_id]!==row.revision).map(row=>row.entry_id);
    for(let offset=0;offset<ids.length;offset+=100){
      const {data,error}=await db.from('scribe_library_entries').select('*').eq('library_id',id).eq('kind',kind).in('entry_id',ids.slice(offset,offset+100));
      if(error)throw new Error(error.message);result.push(...(data||[]));
    }
  }
  return result;
}
// 自动标题（「电脑上传文献（9 个文件）」）里的页数必须等于真实页数：
// 续传并入后、或旧版本客户端推上来的记录里，这个数字常常落后。这里以服务端页数为准改写，
// 学生端即使还是旧版本也能在下次同步看到正确标题。
async function pageCountsOf(db: ReturnType<typeof database>, libraryId: string) {
  const counts = new Map<string, number>();
  const sessions=await allRows((from,to)=>db.from('scribe_cloud_sessions').select('id,file_count').eq('library_id',libraryId).not('completed_at','is',null).order('id').range(from,to));
  for(const row of sessions)counts.set(String(row.id),Number(row.file_count));
  return counts;
}

function correctAutoTitles(rows: Row[], counts: Map<string, number>) {
  return rows.map((row) => {
    if (row.kind !== "doc" || row.deleted || !row.value) return row;
    const sessionId = String(row.entry_id || "").replace(/^cloud-/, "");
    const real = counts.get(sessionId);
    if (!real) return row;
    const fixed = withPageCount(row.value.title, real);
    if (!fixed || fixed === row.value.title) return row;
    return { ...row, value: { ...row.value, title: fixed } };
  });
}

async function sessionDocuments(db: ReturnType<typeof database>,libraryId: string,known:Row={}) {
  const sessions=await allRows((from,to)=>db.from("scribe_cloud_sessions").select("id,title,ocr_status,updated_at").eq("library_id",libraryId).is("deleted_at",null).not("completed_at","is",null).order("created_at",{ascending:false}).order('id').range(from,to));
  const documents=[];
  for(const session of sessions||[]){
    if(known['cloud-'+session.id]===session.updated_at)continue;
    const files=await allRows((from,to)=>db.from("scribe_cloud_files").select("id,name,mime,storage_path,paragraphs,ocr_text,ocr_status,ocr_error").eq("session_id",session.id).not("uploaded_at","is",null).order("queue_order").order('id').range(from,to));
    const paths=(files||[]).map(file=>file.storage_path);
    const urls:Row[]=[];
    for(let offset=0;offset<paths.length;offset+=100){
      const {data,error}=await db.storage.from(BUCKET).createSignedUrls(paths.slice(offset,offset+100),3600);
      if(error)throw new Error(error.message);urls.push(...(data||[]));
    }
    const originals=await allRows((from,to)=>db.from('scribe_source_assets').select('source_id,original_name,original_size,part_count,part_index').eq('session_id',session.id).order('queue_order').range(from,to));
    documents.push({
      id:"cloud-"+session.id,cloudSessionId:session.id,title:withPageCount(session.title,(files||[]).length)||((files||[]).length===1?files![0].name.replace(/\.[^.]+$/,""):"云端文献（"+(files||[]).length+" 页）"),
      author:"云端导入",category:"云端文献",status:"reading",progress:0,pages:(files||[]).length,time:"0 h",color:"new",
      cloudVersion:session.updated_at,originalSources:originals.filter(row=>row.part_index===0).map(row=>({id:row.source_id,name:row.original_name,size:row.original_size,parts:row.part_count})),
      processingState:session.ocr_status==="complete"?"ready":session.ocr_status==="partial"?"partial":"processing",
      processingError:session.ocr_status==="partial"?"部分页未能识别，原件已保留，可重试。":"",
      sourcePages:(files||[]).map((file,index)=>({id:"cloud-"+file.id,order:index+1,name:file.name,type:file.mime||"text/plain",url:urls?.[index]?.signedUrl||"",
        // 逐段结构已经包含全部正文；再下发一次整页原文会让本机存储重复占用一倍。
        text:Array.isArray(file.paragraphs)&&file.paragraphs.length?"":(file.ocr_text||""),paragraphs:Array.isArray(file.paragraphs)?file.paragraphs:[],confidence:file.ocr_status==="complete"?1:0,error:file.ocr_error||"",sourceFileId:file.id,pageIndex:index,cloud:true})),
      completed:(files||[]).filter(file=>file.ocr_status==="complete"||file.ocr_status==="error").length,
    });
  }
  return documents;
}

Deno.serve(async req=>{
  if(req.method==="OPTIONS") return json({ok:true});
  if(req.method!=="POST") return json({error:"不支持的操作"},405);
  try {
    const body=await readJsonLimited(req,8*1024*1024),db=database();
    if(body.action==="create"){
      return json({error:'本站不开放注册，请由管理员在控制台创建账号。'},403);
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
    if(body.action==='capabilities'){
      const {error}=await db.from('scribe_cloud_sessions').select('upload_manifest').limit(0);
      if(error)return json({error:'云端数据结构尚未升级。请先部署 20261021150000_upload_integrity.sql。'},503);
      return json({uploadVersion:2,maxPages:2000,maxObjectBytes:52428800,maxBatchBytes:5368709120});
    }
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
      const sessions=await allRows((from,to)=>db.from("scribe_cloud_sessions").select("id,token,created_at,completed_at,ocr_status,file_count").eq("library_id",library.id).is("deleted_at",null).order("created_at",{ascending:false}).order('id').range(from,to));
      return json({sessions});
    }
    if(body.action!=="sync") return json({error:"不支持的操作。"},400);
    const changes=Array.isArray(body.changes)?body.changes:[];
    if(changes.length>100) return json({error:"单次最多同步 100 项。"},413);
    const conflicts=[];
    for(const change of changes){
      if(!["doc","card","preferences"].includes(change.kind) || typeof change.id!=="string" || change.id.length>160 || !Number.isSafeInteger(change.revision)||change.revision<0) return json({error:"同步记录格式错误。"},400);
      if(change.value!==null && (typeof change.value!=="object" || Array.isArray(change.value))) return json({error:"同步内容格式错误。"},400);
      let value=change.value;
      if(change.kind==='doc'&&change.id.startsWith('cloud-')&&value){
        value={...value};for(const field of ['sourcePages','processingState','processingError','completed','cloudVersion','originalSources'])delete value[field];
      }
      const {data,error}=await db.rpc("scribe_write_entry",{p_library:library.id,p_kind:change.kind,p_id:change.id,p_value:value,p_deleted:change.deleted===true,p_revision:change.revision});
      if(error) throw new Error(error.message);
      if(!data.accepted) conflicts.push({kind:change.kind,id:change.id,entry:data.entry});
    }
    let counters;
    if(body.activity){
      const a=body.activity;
      if(!/^[0-9a-f-]{36}$/i.test(a.deviceId)||![a.initialMinutes,a.initialReviewed,a.minutes,a.reviewed].every(value=>Number.isFinite(value)&&value>=0&&value<1e10)||!Number.isSafeInteger(a.reviewed)||!Number.isSafeInteger(a.initialReviewed))return json({error:'学习统计格式错误。'},400);
      const {data,error}=await db.rpc('scribe_merge_counters',{p_library:library.id,p_device:a.deviceId,p_initial_minutes:a.initialMinutes,p_initial_reviewed:a.initialReviewed,p_minutes:a.minutes,p_reviewed:a.reviewed});
      if(error)throw new Error(error.message);counters=data;
    }
    return json({libraryId:library.id,entries:correctAutoTitles(await entriesOf(db,library.id,body.knownEntries),await pageCountsOf(db,library.id)),documents:await sessionDocuments(db,library.id,body.knownDocuments||{}),conflicts,counters});
  }catch(e){console.error("[scribe-library]",e);return json({error:e instanceof SyntaxError?"请求格式错误。":e instanceof Error?e.message:"同步失败。"},Number((e as {status?:number}).status)||(e instanceof SyntaxError?400:500));}
});

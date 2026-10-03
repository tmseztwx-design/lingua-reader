import {localEntries,fingerprint,applyEntries} from './sync-state.js';

const STATE='scribe-local-v1',KEY='scribe-library-key',META='scribe-sync-meta-v1';
const nativeSet=Storage.prototype.setItem;
const read=(key,fallback)=>{try{return JSON.parse(localStorage.getItem(key))||fallback;}catch{return fallback;}};
const write=(key,value)=>nativeSet.call(localStorage,key,JSON.stringify(value));
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));

export function installLibrary(cloud) {
  let metadata=read(META,{}),pending={},busy=false,dirty=false,applying=false,readyPromise=null,generation=0;
  let indicator,refreshButton;
  const say=message=>{if(indicator)indicator.textContent=message;};
  const key=()=>localStorage.getItem(KEY)||'';
  async function ensureLibrary(){
    if(key()) return key();
    if(!readyPromise) readyPromise=cloud.callFunction('scribe-library',{action:'create'}).then(created=>{
      nativeSet.call(localStorage,KEY,created.libraryKey);metadata={};write(META,metadata);return created.libraryKey;
    }).finally(()=>{readyPromise=null;});
    return readyPromise;
  }
  async function libraryCall(action,body={}){
    return cloud.callFunction('scribe-library',{action,libraryKey:await ensureLibrary(),...body});
  }
  function collect(){
    if(applying || !key()) return;
    const entries=localEntries(read(STATE,{}));
    for(const id of Object.keys(pending))if(!entries.has(id)&&!metadata[id])delete pending[id];
    for(const [id,entry] of entries){
      if(fingerprint(entry)!==metadata[id]?.fingerprint) pending[id]={...entry,deleted:false,revision:metadata[id]?.revision||0};
    }
    for(const [id,known] of Object.entries(metadata)){
      if(!entries.has(id) && known.fingerprint!=='deleted') pending[id]={kind:known.kind,id:known.id,value:null,deleted:true,revision:known.revision};
    }
    write('scribe-sync-pending',pending);
  }
  let timer;
  Storage.prototype.setItem=function(name,value){
    nativeSet.call(this,name,value);
    if(this===localStorage && name===STATE && !applying){collect();clearTimeout(timer);timer=setTimeout(()=>sync().catch(()=>{}),800);}
  };
  function backupConflict(change){
    const conflicts=read('scribe-sync-conflicts',[]);
    conflicts.push({...change,savedAt:new Date().toISOString()});write('scribe-sync-conflicts',conflicts.slice(-100));
  }
  async function sync(){
    if(busy) {dirty=true;while(busy)await pause(100);return sync();}
    busy=true;dirty=false;
    const epoch=generation;
    let succeeded=false;
    try {
      await ensureLibrary();collect();say('正在同步…');
      const sending=Object.values(pending).slice(0,100);
      const response=await libraryCall('sync',{changes:sending});
      if(epoch!==generation)return;
      // User edits made during the request stay pending and keep their local values.
      const before=read(STATE,{}),live=localEntries(before);
      const conflicts=new Set(response.conflicts.map(item=>item.kind+':'+item.id));
      let conflictCount=0;
      for(const change of sending){
        const id=change.kind+':'+change.id;
        if(conflicts.has(id)){
          // An edit made during a conflicting request is still based on the old
          // version. Preserve that latest draft instead of rebasing it silently.
          backupConflict(pending[id]||change);conflictCount++;delete pending[id];
        }else if(JSON.stringify(pending[id])===JSON.stringify(change)) delete pending[id];
      }
      const rows=response.entries.filter(row=>!pending[row.kind+':'+row.entry_id]);
      const next=applyEntries(before,rows,response.documents);
      for(const change of Object.values(pending))if(change.deleted){
        if(change.kind==='doc'){next.docs=next.docs.filter(doc=>String(doc.id)!==change.id);next.deletedDocs=next.deletedDocs.filter(doc=>String(doc.id)!==change.id);}
        if(change.kind==='card')next.cards=next.cards.filter(card=>String(card.id)!==change.id);
      }
      for(const change of Object.values(pending)){
        const entry=live.get(change.kind+':'+change.id);
        if(change.kind==='doc'){
          next.docs=next.docs.filter(doc=>String(doc.id)!==change.id);next.deletedDocs=next.deletedDocs.filter(doc=>String(doc.id)!==change.id);
          if(!change.deleted&&entry)(entry.value.deletedAt?next.deletedDocs:next.docs).push(entry.value);
        }else if(change.kind==='card'){
          next.cards=next.cards.filter(card=>String(card.id)!==change.id);if(!change.deleted&&entry)next.cards.push(entry.value);
        }else if(change.kind==='preferences'&&entry)next.settings=entry.value.settings;
      }
      applying=true;write(STATE,next);applying=false;
      for(const row of response.entries){
        const id=row.kind+':'+row.entry_id;
        metadata[id]={kind:row.kind,id:row.entry_id,revision:row.revision,fingerprint:row.deleted?'deleted':fingerprint({value:row.value})};
        if(pending[id]) pending[id].revision=row.revision;
      }
      // Generated cloud documents must join the revisioned library on the next tick.
      write(META,metadata);write('scribe-sync-pending',pending);
      const snapshot=state=>JSON.stringify([...localEntries(state)].map(([id,entry])=>[id,fingerprint(entry)]));
      const changed=snapshot(before)!==snapshot(next);
      if(changed){refreshButton.hidden=false;window.dispatchEvent(new Event('scribe-cloud-updated'));}
      say(conflictCount?'同步完成；冲突副本已保留，可导出核对':Object.keys(pending).length?'正在同步剩余内容…':'已同步到云端');
      succeeded=true;
      return response;
    }catch(error){say('暂未同步：'+error.message);throw error;}
    finally{busy=false;if(succeeded && (dirty || Object.keys(pending).length))setTimeout(()=>sync().catch(()=>{}),2000);}
  }
  async function createSession(body={}){
    const result=await cloud.callFunction('scribe-mobile-upload',{action:'create',libraryKey:await ensureLibrary(),...body});
    return result;
  }
  async function upload(token,file,order,onProgress){
    const signed=await cloud.callFunction('scribe-mobile-upload',{action:'sign',token,name:file.name,size:file.size,mime:file.type,order});
    if(signed.alreadyUploaded) return;
    await new Promise((resolve,reject)=>{
      const xhr=new XMLHttpRequest();xhr.open('PUT',signed.uploadUrl);
      xhr.setRequestHeader('Content-Type',file.type||'application/octet-stream');
      xhr.upload.onprogress=e=>{if(e.lengthComputable)onProgress?.(Math.round(100*e.loaded/e.total));};
      xhr.onload=()=>xhr.status>=200&&xhr.status<300?resolve():reject(new Error('原件上传失败，请重试。'));
      xhr.onerror=()=>reject(new Error('网络中断，已保留上传队列。'));xhr.send(file);
    });
    await cloud.callFunction('scribe-mobile-upload',{action:'register',token,fileId:signed.fileId,size:file.size,mime:file.type});
  }
  async function awaitBatch(token,onProgress){
    for(;;){
      const status=await cloud.callFunction('scribe-mobile-upload',{action:'status',token});onProgress?.(status);
      if(['complete','partial'].includes(status.ocrStatus)){await sync();return status;}
      await pause(2500);
    }
  }
  cloud.library={ensureLibrary,createSession,upload,awaitBatch,sync,call:libraryCall};
  window.addEventListener('scribe-reset-workspace',()=>{
    write('scribe-last-workspace',{libraryKey:key(),state:read(STATE,{}),metadata,pending});
    generation++;localStorage.removeItem(KEY);metadata={};pending={};write(META,{});write('scribe-sync-pending',{});
  });
  function mount(){
    const panel=document.createElement('section');panel.className='card setting';panel.id='cloudLibrarySettings';
    panel.innerHTML='<h2>云端书库</h2><p class="muted tiny">书库、学习卡和阅读进度自动同步。另一台设备输入同一同步码即可连接；请妥善保管同步码。</p><p id="cloudSyncState"></p><div style="display:flex;gap:8px;flex-wrap:wrap"><button class="button secondary" id="showLibraryKey">显示同步码</button><button class="button secondary" id="joinLibrary">连接已有书库</button><button class="button secondary" id="syncNow">立即同步</button><button class="button secondary" id="exportSyncConflicts">导出冲突副本</button></div><pre id="libraryKeyValue" hidden style="white-space:pre-wrap;overflow-wrap:anywhere;user-select:all"></pre>';
    document.querySelector('#settings .settings-grid')?.prepend(panel);
    if(!panel.isConnected) document.querySelector('#settings')?.append(panel);
    indicator=panel.querySelector('#cloudSyncState');
    refreshButton=document.createElement('button');refreshButton.className='button secondary small';refreshButton.hidden=true;refreshButton.textContent='云端内容已更新 · 刷新显示';
    refreshButton.onclick=()=>location.reload();document.querySelector('.topbar')?.append(refreshButton);
    if(!refreshButton.isConnected) panel.append(refreshButton);
    document.querySelector('#showLibraryKey').onclick=async()=>{try{const value=await ensureLibrary();const output=document.querySelector('#libraryKeyValue');output.textContent=value;output.hidden=!output.hidden;}catch(error){say(error.message);}};
    document.querySelector('#joinLibrary').onclick=async()=>{
      const value=prompt('输入另一台设备“云端书库”中显示的 64 位同步码：');if(!value)return;
      if(!/^[a-f0-9]{64}$/i.test(value.trim())){say('同步码格式不正确。');return;}
      try {
        await cloud.callFunction('scribe-library',{action:'validate',libraryKey:value.trim().toLowerCase()});
        await sync();write('scribe-last-workspace',{libraryKey:key(),state:read(STATE,{}),metadata,pending});
        generation++;
        nativeSet.call(localStorage,KEY,value.trim().toLowerCase());metadata={};pending={};write(META,{});write('scribe-sync-pending',{});
        const local=read(STATE,{});local.docs=[];local.cards=[];local.deletedDocs=[];write(STATE,local);
        const cloudState=await libraryCall('sync',{changes:[]});
        applying=true;write(STATE,applyEntries(local,cloudState.entries,cloudState.documents));applying=false;
        for(const row of cloudState.entries) metadata[row.kind+':'+row.entry_id]={kind:row.kind,id:row.entry_id,revision:row.revision,fingerprint:row.deleted?'deleted':fingerprint({value:row.value})};
        write(META,metadata);location.reload();
      }catch(error){say(error.message);}
    };
    document.querySelector('#syncNow').onclick=()=>sync().catch(()=>{});
    const restore=document.createElement('button');restore.className='button secondary';restore.textContent='恢复上一个工作区';
    restore.onclick=async()=>{
      const previous=read('scribe-last-workspace',null);if(!previous){say('没有工作区备份。');return;}
      await sync().catch(()=>{});generation++;
      nativeSet.call(localStorage,KEY,previous.libraryKey);metadata=previous.metadata||{};pending=previous.pending||{};
      write(META,metadata);write('scribe-sync-pending',pending);applying=true;write(STATE,previous.state);applying=false;
      await sync();location.reload();
    };panel.append(restore);
    document.querySelector('#exportSyncConflicts').onclick=()=>{
      const blob=new Blob([JSON.stringify(read('scribe-sync-conflicts',[]),null,2)],{type:'application/json'});
      const link=document.createElement('a');link.href=URL.createObjectURL(blob);link.download='书库同步冲突副本.json';link.click();URL.revokeObjectURL(link.href);
    };
    pending=read('scribe-sync-pending',{});
    ensureLibrary().then(async()=>{
      for(const item of read('scribe-cloud-links',[])) try{await libraryCall('attach',{token:item.token});}catch{}
      await sync();
    }).catch(error=>say('云端书库未就绪：'+error.message));
    setInterval(()=>sync().catch(()=>{}),15000);
    window.addEventListener('online',()=>sync().catch(()=>{}));
    window.addEventListener('pagehide',collect);
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',mount);else mount();
}

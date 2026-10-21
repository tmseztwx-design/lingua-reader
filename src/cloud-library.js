import {localEntries,fingerprint,applyEntries,stampPageUrls} from './sync-state.js';
import {readBackupPayload,mergeBackup,summarizeRestore} from './restore-backup.js';

const STATE='scribe-local-v1',KEY='scribe-library-key',META='scribe-sync-meta-v1';
const nativeSet=Storage.prototype.setItem;
const read=(key,fallback)=>{try{return JSON.parse(localStorage.getItem(key))||fallback;}catch{return fallback;}};
const write=(key,value)=>nativeSet.call(localStorage,key,JSON.stringify(value));
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));

export function installLibrary(cloud) {
  let metadata=read(META,{}),pending={},busy=false,dirty=false,applying=false,readyPromise=null,generation=0;
  let indicator,refreshButton,betaBlocked=false;
  const say=message=>{if(indicator)indicator.textContent=message;};
  const key=()=>localStorage.getItem(KEY)||'';
  const betaKey=()=>{try{return JSON.parse(localStorage.getItem('scribe-beta-session')||'null')?.libraryKey||'';}catch{return '';}};
  function betaRequiredError(){
    const error=new Error('云端需要内测码：请在「导入文献」页顶部输入内测码，然后重试。');
    error.code='BETA_REQUIRED';
    return error;
  }
  async function ensureLibrary(){
    if(key()) return key();
    // 内测期间不再为陌生设备自动新建书库：必须先用内测码登录。
    const fromBeta=betaKey();
    if(fromBeta){nativeSet.call(localStorage,KEY,fromBeta);metadata={};write(META,metadata);return fromBeta;}
    throw betaRequiredError();
  }
  async function libraryCall(action,body={}){
    return cloud.callFunction('scribe-library',{action,libraryKey:await ensureLibrary(),...body});
  }
  // 短指纹：只用来判断“内容有没有变”，不参与云端合并，因此不需要整份内容。
  function shortPrint(value){
    const text=typeof value==='string'?value:JSON.stringify(value);
    let hash=5381;
    for(let index=0;index<text.length;index+=1) hash=((hash<<5)+hash+text.charCodeAt(index))|0;
    return (hash>>>0).toString(36)+':'+text.length;
  }
  function collect(){
    if(applying || !key()) return;
    const entries=localEntries(read(STATE,{}));
    for(const id of Object.keys(pending))if(!entries.has(id)&&!metadata[id])delete pending[id];
    for(const [id,entry] of entries){
      if(fingerprint(entry)!==metadata[id]?.fingerprint) pending[id]={kind:entry.kind,id:entry.id,deleted:false,revision:metadata[id]?.revision||0,print:shortPrint(entry.value)};
    }
    for(const [id,known] of Object.entries(metadata)){
      if(!entries.has(id) && known.fingerprint!=='deleted') pending[id]={kind:known.kind,id:known.id,deleted:true,revision:known.revision,print:'deleted'};
    }
    safeWrite('scribe-sync-pending',pending);
  }
  // 发送前把引用补成真正的值（内容取自当前状态，永远是最新的）。
  function withValues(changes){
    const entries=localEntries(read(STATE,{}));
    return changes.map(change=>{
      const entry=entries.get(change.kind+':'+change.id);
      return {kind:change.kind,id:change.id,deleted:change.deleted===true,revision:change.revision||0,
        value:change.deleted?null:(entry?entry.value:null),print:change.print};
    });
  }
  let timer;
  Storage.prototype.setItem=function(name,value){
    nativeSet.call(this,name,value);
    if(this===localStorage && name===STATE && !applying){collect();clearTimeout(timer);timer=setTimeout(()=>sync().catch(()=>{}),800);}
  };
  // 切换到另一个书库（同步码或内测码带来的钥匙）：先给当前工作区留一份可回滚的备份，
  // 再把本机内容替换成新书库的内容。本机旧内容仍在原书库与备份里，不会被抹掉。
  async function joinLibrary(value,{reload=true}={}){
    const next=String(value||'').trim().toLowerCase();
    if(!/^[a-f0-9]{64}$/i.test(next))throw new Error('同步码格式不正确。');
    if(next===key())return {switched:false};
    await cloud.callFunction('scribe-library',{action:'validate',libraryKey:next});
    await sync();
    write('scribe-last-workspace',{libraryKey:key(),state:read(STATE,{}),metadata,pending});
    generation++;
    nativeSet.call(localStorage,KEY,next);metadata={};pending={};write(META,{});write('scribe-sync-pending',{});
    const local=read(STATE,{});local.docs=[];local.cards=[];local.deletedDocs=[];write(STATE,local);
    const cloudState=await libraryCall('sync',{changes:[]});
    applying=true;write(STATE,applyEntries(local,cloudState.entries,stampPageUrls(cloudState.documents)));applying=false;
    for(const row of cloudState.entries) metadata[row.kind+':'+row.entry_id]={kind:row.kind,id:row.entry_id,revision:row.revision,fingerprint:row.deleted?'deleted':fingerprint({value:row.value})};
    write(META,metadata);
    if(reload)location.reload();
    return {switched:true};
  }
  // 这些键都是可重建的辅助数据（待发镜像、指纹表、冲突副本）。
  // 浏览器存储写满时（Safari 无痕、配额耗尽）绝不能因此中断上传与同步。
  let storagePressure = '';
  function safeWrite(name, value) {
    try { nativeSet.call(localStorage, name, JSON.stringify(value)); storagePressure = ''; return true; }
    catch (error) {
      storagePressure = (error && error.message) || '本机存储写入失败';
      console.warn('[scribe] 本机存储写入失败（' + name + '）：' + storagePressure);
      try { window.dispatchEvent(new Event('scribe-storage-pressure')); } catch { /* 忽略 */ }
      return false;
    }
  }
  const storageState = () => storagePressure;
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
      await ensureLibrary();collect();say('正在同步…');      const queued=Object.values(pending).slice(0,100);
      const sending=withValues(queued);
      const response=await libraryCall('sync',{changes:sending});
      if(epoch!==generation)return;
      // User edits made during the request stay pending and keep their local values.
      const before=read(STATE,{}),live=localEntries(before);
      // 下面每次用到 pending 内容时都重新取一次，确保拿到请求期间新写入的内容。
      const latestEntries=()=>localEntries(read(STATE,{}));
      const conflicts=new Set(response.conflicts.map(item=>item.kind+':'+item.id));
      let conflictCount=0;
      for(const change of sending){
        const id=change.kind+':'+change.id;
        if(conflicts.has(id)){
          // An edit made during a conflicting request is still based on the old
          // version. Preserve that latest draft (with its full content) instead of
          // rebasing it silently.
          backupConflict(withValues([pending[id]||change])[0]||change);conflictCount++;delete pending[id];
        }else if(pending[id]&&change.print&&pending[id].print===change.print) delete pending[id];
      }
      const rows=response.entries.filter(row=>!pending[row.kind+':'+row.entry_id]);
      const next=applyEntries(before,rows,stampPageUrls(response.documents));
      for(const change of Object.values(pending))if(change.deleted){
        if(change.kind==='doc'){next.docs=next.docs.filter(doc=>String(doc.id)!==change.id);next.deletedDocs=next.deletedDocs.filter(doc=>String(doc.id)!==change.id);}
        if(change.kind==='card')next.cards=next.cards.filter(card=>String(card.id)!==change.id);
      }
      for(const change of Object.values(pending)){
        // 必须用「此刻最新」的本地内容，不能用请求开始时的快照：
        // 查词结果、笔记等如果是在这次请求期间写入的，用旧快照会把它们冲掉
        // （表现就是卡片一会儿有释义、一会儿又回到「正在查询」）。
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
      safeWrite(META,metadata);safeWrite('scribe-sync-pending',pending);
      const snapshot=state=>JSON.stringify([...localEntries(state)].map(([id,entry])=>[id,fingerprint(entry)]));
      const changed=snapshot(before)!==snapshot(next);
      if(changed){refreshButton.hidden=false;window.dispatchEvent(new Event('scribe-cloud-updated'));}
      say(conflictCount?'同步完成；冲突副本已保留，可导出核对':Object.keys(pending).length?'正在同步剩余内容…':'已同步到云端');
      succeeded=true;
      return response;
    }catch(error){
      // 没有内测码时不再反复重试，也不再自动新建书库，交给内测卡片引导用户输入。
      if(error&&error.code==='BETA_REQUIRED'){betaBlocked=true;say('内测码未填写 · 云端同步已暂停');return;}
      say('暂未同步：'+error.message);throw error;
    }
    finally{busy=false;if(succeeded && (dirty || Object.keys(pending).length))setTimeout(()=>sync().catch(()=>{}),2000);}
  }
  // 从备份文件恢复：把另一个项目（或旧版页面）导出的学习数据合并回当前书库。
  // 只补回本机缺失的文献与学习卡，同 id 条目保留当前版本；随后由同步推到云端。
  // 云端未就绪（没填内测码）时先落在本机，接入书库后会自动同步上去。
  async function restoreBackup(payload){
    const {state:next,added,skipped}=mergeBackup(read(STATE,{}),readBackupPayload(payload));
    applying=true;write(STATE,next);applying=false;
    collect();
    try{await sync();}catch{/* 云端暂时不可用：数据已在本机，稍后重试 */ }
    return {added,skipped};
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
  // 存储被写满时给用户一条明确的出路：清掉可重建的本机缓存（词库缓存、冲突副本、
  // 上一工作区备份、待发镜像），再重新同步。云端与 STATE 里的学习数据都不动。
  function clearLocalCaches(){
    for(const name of ['scribe-word-cache-v1','scribe-sync-conflicts','scribe-last-workspace','scribe-sync-pending']) localStorage.removeItem(name);
    pending={};metadata={};
    return true;
  }
  function mountStorageBanner(){
    if(!document.body)return;
    let bar=document.getElementById('scribeStorageBar');
    if(!bar){
      bar=document.createElement('div');
      bar.id='scribeStorageBar';
      bar.style.cssText='position:fixed;left:50%;bottom:18px;transform:translateX(-50%);z-index:120;display:none;align-items:center;gap:12px;max-width:min(680px,92vw);padding:12px 14px;border:1px solid #e6cfae;border-radius:11px;background:#fff8ec;color:#7a5a28;font-size:13px;box-shadow:0 12px 32px #17243e22';
      bar.innerHTML='<b>本机存储写入失败</b><span id="scribeStorageText" style="flex:1"></span><button class="button secondary small" type="button" id="scribeStorageFix">清理本机缓存</button>';
      document.body.appendChild(bar);
      bar.querySelector('#scribeStorageFix').onclick=()=>{clearLocalCaches();bar.style.display='none';sync().catch(()=>{});};
    }
    const show=()=>{
      const text=bar.querySelector('#scribeStorageText');
      if(text)text.textContent=storagePressure?('（'+storagePressure+'）— 云端数据不受影响，可清理本机缓存后重试。'):'云端数据不受影响，可清理本机缓存后重试。';
      bar.style.display='flex';
    };
    window.addEventListener('scribe-storage-pressure',show);
  }
  // 告诉用户数据实际存在哪：大容量本机数据库（IndexedDB）+ 云端书库主副本。
  function describeStorage(panel){
    const vault=window.__scribeVault;if(!vault)return;
    const line=document.createElement('p');line.className='muted tiny';line.id='localStorageState';panel.insertBefore(line,indicator);
    const mb=bytes=>(bytes/1048576).toFixed(bytes<10485760?1:0)+' MB';
    vault.estimate().then(estimate=>{
      const mode=vault.info.mode==='indexeddb'?'本机大容量数据库':'浏览器小容量存储（约 5 MB，建议换用 Chrome / Safari 最新版）';
      const usage=estimate&&estimate.quota?' · 已用 '+mb(estimate.usage||0)+' / 可用约 '+mb(estimate.quota):'';
      line.textContent='本机数据：'+mode+usage+(vault.info.persisted?' · 已申请持久保存':'')+' · 云端书库保存完整主副本';
    });
  }
  cloud.library={ensureLibrary,createSession,upload,awaitBatch,sync,call:libraryCall,join:joinLibrary,currentKey:key,storageState,clearLocalCaches,restoreBackup};
  window.addEventListener('scribe-reset-workspace',()=>{
    write('scribe-last-workspace',{libraryKey:key(),state:read(STATE,{}),metadata,pending});
    generation++;localStorage.removeItem(KEY);metadata={};pending={};write(META,{});write('scribe-sync-pending',{});
  });
  function mount(){
    const panel=document.createElement('section');panel.className='card setting';panel.id='cloudLibrarySettings';
    panel.innerHTML='<h2>云端书库</h2><p class="muted tiny">书库、学习卡和阅读进度自动同步。另一台设备输入同一同步码即可连接；请妥善保管同步码。</p><p id="cloudSyncState"></p><div style="display:flex;gap:8px;flex-wrap:wrap"><button class="button secondary" id="showLibraryKey">显示同步码</button><button class="button secondary" id="joinLibrary">连接已有书库</button><button class="button secondary" id="syncNow">立即同步</button><button class="button secondary" id="betaGoCode">输入内测码</button><button class="button secondary" id="exportSyncConflicts">导出冲突副本</button><button class="button secondary" id="restoreBackup">从备份文件恢复</button><input id="restoreBackupFile" type="file" accept="application/json,.json" hidden></div><pre id="libraryKeyValue" hidden style="white-space:pre-wrap;overflow-wrap:anywhere;user-select:all"></pre>';
    document.querySelector('#settings .settings-grid')?.prepend(panel);
    if(!panel.isConnected) document.querySelector('#settings')?.append(panel);
    indicator=panel.querySelector('#cloudSyncState');
    refreshButton=document.createElement('button');refreshButton.className='button secondary small';refreshButton.hidden=true;refreshButton.textContent='云端内容已更新 · 刷新显示';
    refreshButton.onclick=()=>location.reload();document.querySelector('.topbar')?.append(refreshButton);
    if(!refreshButton.isConnected) panel.append(refreshButton);
    document.querySelector('#showLibraryKey').onclick=async()=>{try{const value=await ensureLibrary();const output=document.querySelector('#libraryKeyValue');output.textContent=value;output.hidden=!output.hidden;}catch(error){say(error.message);}};
    document.querySelector('#joinLibrary').onclick=async()=>{
      const value=prompt('输入另一台设备“云端书库”中显示的 64 位同步码：');if(!value)return;
      try { await joinLibrary(value); }catch(error){ say(error.message); }
    };
    document.querySelector('#syncNow').onclick=()=>sync().catch(()=>{});
    const goCode=document.querySelector('#betaGoCode');
    if(goCode)goCode.onclick=()=>{const input=document.querySelector('#betaInput-settings');const card=document.querySelector('#betaCard-settings');if(card)card.scrollIntoView({behavior:'smooth',block:'center'});if(input)setTimeout(()=>input.focus(),260);};
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
    // 换过项目、重装过浏览器、或从旧站点搬回来时，用「导出全部数据」下载的 JSON 把学习数据合并回来。
    const backupInput=document.querySelector('#restoreBackupFile');
    document.querySelector('#restoreBackup').onclick=()=>backupInput.click();
    backupInput.onchange=async()=>{
      const file=backupInput.files&&backupInput.files[0];if(!file)return;
      say('正在读取备份：'+file.name);
      try {
        const {added,skipped}=await restoreBackup(JSON.parse(await file.text()));
        const restored=added.docs+added.cards+added.deleted;
        say(summarizeRestore(added,skipped)+(restored?' 正在重新载入…':''));
        if(restored)setTimeout(()=>location.reload(),1200);
      }catch(error){
        say('恢复失败：'+(error&&error.message||'文件无法解析') );
      }finally{backupInput.value='';}
    };
    // 旧版本把整份内容存进待发镜像；带上“内容已改”的判断只需短指纹，
    // 读到旧格式就丢掉，collect() 会立刻按当前状态重建（内容来自 STATE，不丢东西）。
    mountStorageBanner();
    describeStorage(panel);
    pending=Object.fromEntries(Object.entries(read('scribe-sync-pending',{})).filter(([,change])=>change&&change.print));
    safeWrite('scribe-sync-pending',pending);
    ensureLibrary().then(async()=>{
      for(const item of read('scribe-cloud-links',[])) try{await libraryCall('attach',{token:item.token});}catch{}
      await sync();
    }).catch(error=>say(error&&error.code==='BETA_REQUIRED'?'内测码未填写 · 云端同步已暂停':'云端书库未就绪：'+error.message));
    setInterval(()=>sync().catch(()=>{}),15000);
    window.addEventListener('online',()=>sync().catch(()=>{}));
    window.addEventListener('pagehide',collect);
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',mount);else mount();
}

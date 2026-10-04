// Explicit deployment acceptance: synthetic TXT pages only, no AI calls/user data.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const config=await readFile(new URL('../src/integrations/supabase/client.ts',import.meta.url),'utf8');
const base=config.match(/SUPABASE_URL\s*=\s*["']([^"']+)/)?.[1];
const publicKey=config.match(/SUPABASE_PUBLISHABLE_KEY\s*=\s*["']([^"']+)/)?.[1];
assert.ok(base&&publicKey,'Cloud public configuration not found');
const headers={'Content-Type':'application/json',apikey:publicKey,Authorization:'Bearer '+publicKey};
async function call(name,body){
  const response=await fetch(base+'/functions/v1/'+name,{method:'POST',headers,body:JSON.stringify(body),signal:AbortSignal.timeout(30000)});
  const payload=await response.json();if(!response.ok)throw new Error(name+': '+response.status+' '+(payload.error||payload.message||'not deployed'));return payload;
}
const {libraryKey}=await call('scribe-library',{action:'create'});
const session=await call('scribe-mobile-upload',{action:'create',libraryKey,title:'部署验收 · 合成文本'});
const library=(action,body={})=>call('scribe-library',{action,libraryKey,...body});
try{
  const pages=['First page: knowledge is learned through reading.','Second page: education creates opportunities.'];
  // Upload completion is reversed, independently of confirmed page order.
  for(const order of [1,0]){
    const blob=new Blob([pages[order]],{type:'text/plain'});
    const signed=await call('scribe-mobile-upload',{action:'sign',token:session.token,order,name:'page-'+(order+1)+'.txt',size:blob.size,mime:'text/plain'});
    const put=await fetch(signed.uploadUrl,{method:'PUT',headers:{'Content-Type':'text/plain'},body:blob});assert.ok(put.ok,'Signed upload failed');
    await call('scribe-mobile-upload',{action:'register',token:session.token,fileId:signed.fileId,size:blob.size,mime:'text/plain'});
    const unsigned=await fetch(base+'/storage/v1/object/public/scribe-pages/'+signed.path);assert.ok(!unsigned.ok,'Originals must not be publicly readable');
  }
  await call('scribe-mobile-upload',{action:'complete',token:session.token});
  const deadline=Date.now()+180000;let result;
  do{
    // No browser/explicit OCR invocation: only a status read.
    result=await library('sync',{changes:[]});
    if(result.documents[0]?.processingState==='ready')break;
    await new Promise(resolve=>setTimeout(resolve,2500));
  }while(Date.now()<deadline);
  assert.equal(result.documents[0]?.processingState,'ready','Background queue did not complete within 3 minutes');
  assert.deepEqual(result.documents[0].sourcePages.map(page=>page.text.trim()),pages);
  const doc=result.documents[0];doc.progress=33;
  await library('sync',{changes:[{kind:'doc',id:doc.id,value:doc,deleted:false,revision:0}]});
  const secondDevice=await library('sync',{changes:[]});
  assert.equal(secondDevice.documents[0].sourcePages.length,2);
  assert.equal(secondDevice.entries.find(entry=>entry.entry_id===doc.id).value.progress,33);
  const denied=await fetch(base+'/functions/v1/scribe-queue',{method:'POST',headers,body:'{}'});assert.equal(denied.status,403,'Worker must require its private credential');
  console.log('PASS: private cloud upload, selected order, autonomous background conversion, cross-device library and worker authentication');
}finally{
  // Recoverable deletion; never purge existing user files or execute remove.
  await library('trash',{sessionId:session.sessionId}).catch(error=>console.warn('Synthetic batch cleanup:',error.message));
}

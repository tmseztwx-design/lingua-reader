import {retry} from './upload-engine.js';

// Reassemble exact source bytes, not OCR page JPEGs. Chromium can stream to disk.
export async function downloadOriginal(cloud,doc,onProgress=()=>{}) {
  const sources=doc.originalSources||[];
  if(!sources.length)throw new Error('这份旧文献未保留完整 PDF；已保存的页面原件仍可在阅读区查看。');
  let source=sources[0];
  if(sources.length>1){
    const choice=prompt('选择要下载的原文件：\n'+sources.map((item,index)=>`${index+1}. ${item.name}`).join('\n'));
    if(choice===null)return;source=sources[Number(choice)-1];if(!source)throw new Error('请选择有效的文件编号。');
  }
  if(!window.showSaveFilePicker&&source.size>200*1024*1024)throw new Error('原 PDF 超过 200 MB。请使用支持直接写入磁盘的最新版 Chrome / Edge 下载，避免手机内存不足。');
  const handle=window.showSaveFilePicker?await window.showSaveFilePicker({suggestedName:source.name}):null;
  const {sources:parts}=await cloud.callFunction('scribe-mobile-upload',{action:'originals',sessionId:doc.cloudSessionId,libraryKey:await cloud.library.ensureLibrary()});
  const ordered=parts.filter(part=>part.sourceId===source.id).sort((a,b)=>a.part-b.part);
  if(ordered.length!==source.parts||ordered.some((part,index)=>part.part!==index||!part.url))throw new Error('原件分片清单不完整，请稍后重试。');
  const writer=handle?await handle.createWritable():null,chunks=[];
  let bytes=0;
  try{
    for(const part of ordered){
      const blob=await retry(async()=>{
        const response=await fetch(part.url,{signal:AbortSignal.timeout(180000)});
        if(!response.ok){const error=new Error('原件下载暂时失败。');error.status=response.status;throw error;}
        const blob=await response.blob();if(blob.size!==part.partSize)throw new Error('原件分片未完整下载。');return blob;
      });
      if(writer)await writer.write(blob);else chunks.push(blob);
      bytes+=blob.size;onProgress(Math.floor(bytes/source.size*100));
    }
    if(bytes!==source.size)throw new Error('原件大小校验未通过，请重试。');
    if(writer)await writer.close();
    else{
      const url=URL.createObjectURL(new Blob(chunks,{type:'application/pdf'}));
      const link=document.createElement('a');link.href=url;link.download=source.name;link.click();setTimeout(()=>URL.revokeObjectURL(url),60000);
    }
  }catch(error){if(writer)await writer.abort().catch(()=>{});throw error;}
}

export function installOriginalDownload(cloud){
  const top=document.querySelector('#reader .reader-top');if(!top)return;
  const button=document.createElement('button');button.className='button secondary small';button.textContent='下载原始 PDF';button.type='button';button.hidden=true;top.appendChild(button);
  const active=()=>{try{const state=JSON.parse(localStorage.getItem('scribe-local-v1')||'{}');return(state.docs||[]).find(doc=>doc.id===state.activeDocId);}catch{return null;}};
  const update=()=>{button.hidden=!active()?.originalSources?.length;};
  document.addEventListener('click',()=>queueMicrotask(update));window.addEventListener('scribe-cloud-updated',update);update();
  button.onclick=async()=>{
    const doc=active();if(!doc)return;button.disabled=true;
    try{await downloadOriginal(cloud,doc,percent=>{button.textContent='下载原件 '+percent+'%';});}
    catch(error){if(error.name!=='AbortError')alert(error.message);}
    finally{button.disabled=false;button.textContent='下载原始 PDF';}
  };
}

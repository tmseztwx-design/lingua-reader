// Pure state conversion: browser views continue using their existing local format.
export function localEntries(state) {
  const entries=new Map();
  for(const value of [...(state.docs||[]),...(state.deletedDocs||[])]) entries.set('doc:'+value.id,{kind:'doc',id:String(value.id),value});
  for(const value of state.cards||[]) entries.set('card:'+value.id,{kind:'card',id:String(value.id),value});
  entries.set('preferences:settings',{kind:'preferences',id:'settings',value:{settings:state.settings||{}}});
  return entries;
}
export function fingerprint(entry) {
  if(!entry) return 'deleted';
  const value=structuredClone(entry.value);
  // Signed URLs rotate; they are refreshed on reads, not user edits.
  if(Array.isArray(value?.sourcePages)) value.sourcePages.forEach(page=>{delete page.url;delete page.urlAt;});
  return JSON.stringify(value);
}
// 服务端每次同步都会重签原页地址；记录签发时间，供阅读区判断链接是否可能已过期。
export function stampPageUrls(documents, now=Date.now()) {
  for(const document of documents||[]){
    if(!Array.isArray(document?.sourcePages)) continue;
    for(const page of document.sourcePages) if(page?.url) page.urlAt=now;
  }
  return documents;
}
// 「电脑上传文献（9 个文件）」这类自动标题带页数；续传并入后页数变了，
// 标题必须跟着服务端的真实页数走，否则用户会以为页面丢了。用户自定义标题不受影响。
const AUTO_TITLE = /（\s*(\d+)\s*(个文件|页)\s*）\s*$/;
function realPageCount(generated) {
  const pages = Number(generated?.pages);
  if (Number.isFinite(pages) && pages > 0) return pages;
  return Array.isArray(generated?.sourcePages) ? generated.sourcePages.length : 0;
}

export function applyEntries(state,rows,documents=[]) {
  const next=structuredClone(state);
  const docs=new Map((next.docs||[]).map(doc=>[String(doc.id),doc]));
  const trash=new Map((next.deletedDocs||[]).map(doc=>[String(doc.id),doc]));
  const cards=new Map((next.cards||[]).map(card=>[String(card.id),card]));
  for(const row of rows){
    if(row.kind==='doc'){
      docs.delete(row.entry_id);trash.delete(row.entry_id);
      if(!row.deleted && row.value) (row.value.deletedAt?trash:docs).set(row.entry_id,row.value);
    }else if(row.kind==='card'){
      cards.delete(row.entry_id);if(!row.deleted && row.value) cards.set(row.entry_id,row.value);
    }else if(row.kind==='preferences' && !row.deleted && row.value) next.settings=row.value.settings||next.settings;
  }
  const tombstones=new Set(rows.filter(row=>row.kind==='doc'&&(row.deleted||row.value?.deletedAt)).map(row=>row.entry_id));
  for(const generated of documents){
    if(tombstones.has(generated.id)) continue;
    const saved=docs.get(generated.id);
    const merged={...generated,...saved,sourcePages:generated.sourcePages,pages:generated.pages,
      processingState:generated.processingState,processingError:generated.processingError,completed:generated.completed};
    const claimed=String(saved?.title||'').match(AUTO_TITLE);
    const real=realPageCount(generated);
    if(claimed && real && Number(claimed[1])!==real && generated.title) merged.title=generated.title;
    docs.set(generated.id,merged);
  }
  next.docs=[...docs.values()];next.deletedDocs=[...trash.values()];next.cards=[...cards.values()];
  return next;
}

// 从备份文件恢复学习数据。
// 备份来源是「导出全部数据」下载的 JSON（{docs,cards,deletedDocs,minutes,reviewed,settings}），
// 也兼容把它包在 {state:{...}} 里导出过的旧格式。
// 合并口径刻意保守：同 id 的文献与学习卡一律保留本机当前版本，只补回本机缺失的内容，
// 避免一次恢复把现在的阅读进度、卡片释义覆盖成旧数据。
const isObject=value=>value&&typeof value==='object'&&!Array.isArray(value);

export function readBackupPayload(input){
  if(!isObject(input))throw new Error('这个文件不是 Scribe 的学习数据备份。');
  const source=isObject(input.state)?input.state:input;
  const docs=Array.isArray(source.docs)?source.docs.filter(isObject):[];
  const deletedDocs=Array.isArray(source.deletedDocs)?source.deletedDocs.filter(isObject):[];
  const cards=Array.isArray(source.cards)?source.cards.filter(isObject):[];
  if(!docs.length&&!deletedDocs.length&&!cards.length)throw new Error('备份里没有可恢复的文献或学习卡。');
  return {docs,deletedDocs,cards,minutes:Number(source.minutes)||0,reviewed:Number(source.reviewed)||0,
    settings:isObject(source.settings)?source.settings:null};
}

export function mergeBackup(current,payload){
  const next=isObject(current)?structuredClone(current):{};
  next.docs=Array.isArray(next.docs)?next.docs:[];
  next.cards=Array.isArray(next.cards)?next.cards:[];
  next.deletedDocs=Array.isArray(next.deletedDocs)?next.deletedDocs:[];
  const live=new Set(next.docs.map(doc=>String(doc&&doc.id)));
  const trash=new Set(next.deletedDocs.map(doc=>String(doc&&doc.id)));
  const cards=new Set(next.cards.map(card=>String(card&&card.id)));
  const added={docs:0,cards:0,deleted:0},skipped={docs:0,cards:0};
  // 最近删除里的文献必须带 deletedAt：书架与回收站在云端和阅读区都按它区分，
  // 少了这个字段，同步时会被当成在读文献重新放回书架。
  for(const doc of payload.deletedDocs){
    const id=String(doc.id||'');if(!id||live.has(id)||trash.has(id))continue;
    next.deletedDocs.push(doc.deletedAt?doc:{...doc,deletedAt:new Date().toISOString()});trash.add(id);added.deleted++;
  }
  for(const doc of payload.docs){
    const id=String(doc.id||'');if(!id)continue;
    if(live.has(id)||trash.has(id)){skipped.docs++;continue;}
    if(doc.deletedAt){next.deletedDocs.push(doc);trash.add(id);added.deleted++;continue;}
    next.docs.push(doc);live.add(id);added.docs++;
  }
  for(const card of payload.cards){
    const id=String(card.id||'');if(!id)continue;
    if(cards.has(id)){skipped.cards++;continue;}
    next.cards.push(card);cards.add(id);added.cards++;
  }
  // 累计学习时长与复习次数取较大值：恢复两份备份时不会把已有的投入算少。
  next.minutes=Math.max(Number(next.minutes)||0,payload.minutes);
  next.reviewed=Math.max(Number(next.reviewed)||0,payload.reviewed);
  if(payload.settings)next.settings={...payload.settings,...(isObject(next.settings)?next.settings:{})};
  return {state:next,added,skipped};
}

export function summarizeRestore(added,skipped){
  const parts=[];
  if(added.docs)parts.push('文献 '+added.docs+' 本');
  if(added.cards)parts.push('学习卡 '+added.cards+' 张');
  if(added.deleted)parts.push('最近删除 '+added.deleted+' 本');
  if(!parts.length)return skipped.docs||skipped.cards?'备份里的内容本机都已经有了，没有重复导入。':'备份里没有可恢复的内容。';
  const kept=(skipped.docs||0)+(skipped.cards||0);
  return '已恢复'+parts.join('、')+(kept?('；另有 '+kept+' 项本机已存在，保留了当前版本'):'')+'。';
}

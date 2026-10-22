// Scribe SRS v1: SM-2-inspired day intervals + explicit short learning steps.
// Not FSRS: no claim of fitted retention or personalized memory probabilities.
export const MINUTE=60_000,DAY=86_400_000;
const clamp=(value,min,max)=>Math.min(max,Math.max(min,Number(value)||min));
export const validCard=card=>Boolean(card&&card.id!=='guide'&&String(card.term||'').trim()&&['word','phrase','sentence'].includes(card.type));
export function dayKey(now=Date.now()){
  const date=new Date(now);return [date.getFullYear(),String(date.getMonth()+1).padStart(2,'0'),String(date.getDate()).padStart(2,'0')].join('-');
}
export function scheduleOf(card,now=Date.now()){
  const raw=card.review&&typeof card.review==='object'?card.review:{};
  const legacy=!raw.version&&card.due===false&&Number(card.nextReview)>0;
  const state=['new','learning','review'].includes(raw.state)?raw.state:(legacy?'review':'new');
  const due=Date.parse(raw.dueAt);
  return {...raw,version:1,state,dueAt:new Date(Number.isFinite(due)?due:now).toISOString(),
    ease:clamp(raw.ease||2.5,1.3,3),intervalDays:clamp(raw.intervalDays||(legacy?card.nextReview:0),0,3650),
    repetitions:Math.max(0,Number(raw.repetitions)||(legacy?1:0)),lapses:Math.max(0,Number(raw.lapses)||0),
    step:raw.step===1?1:0,suspended:raw.suspended===true,days:raw.days&&typeof raw.days==='object'?raw.days:{},log:Array.isArray(raw.log)?raw.log:[],
    ...(legacy?{legacyEstimated:true}:{})};
}
export function migrateSchedules(state,now=Date.now()){
  let changed=false;
  for(const card of state.cards||[])if(validCard(card)&&!card.review?.version){card.review=scheduleOf(card,now);changed=true;}
  return changed;
}
const placeholders=/^(来自当前阅读|点击原文收集|当前阅读段落|待复习的完整句子|值得积累的表达|正在|暂时无法|先输入内测码|查询超时|本文词汇|本文短语|自选短语|自选句子|这个词暂时)/;
export function meaningOf(card){return [card.translation,card.lookupFailed?'':card.meaning,card.gloss].map(value=>String(value||'').trim()).find(text=>text&&!placeholders.test(text))||'';}
export function scopeCards(cards,{book='all',kind='all'}={}){
  return (cards||[]).filter(card=>validCard(card)&&(book==='all'||card.documentId===book)&&(kind==='all'||card.type===kind));
}
export function dailyStats(cards,now=Date.now()){
  const key=dayKey(now);let studied=0,introduced=0,answers=0,remembered=0;
  for(const card of cards||[]){const review=scheduleOf(card,now),day=review.days[key];
    if(day?.answers){studied++;answers+=Number(day.answers)||0;if(day.firstRating!=='again')remembered++;}
    if(review.introducedDay===key)introduced++;
  }
  return {studied,introduced,answers,remembered};
}
export function reviewStats(cards,now=Date.now()){
  const result={new:0,due:0,learning:0,future:0,suspended:0,blocked:0,total:0,nextAt:null};
  for(const card of cards||[]){if(!validCard(card))continue;result.total++;const review=scheduleOf(card,now),due=Date.parse(review.dueAt);
    if(review.suspended){result.suspended++;continue;}
    if(!meaningOf(card)){result.blocked++;continue;}
    if(review.state==='new')result.new++;
    else if(due<=now){result.due++;if(review.state==='learning')result.learning++;}
    else{result.future++;result.nextAt=result.nextAt===null?due:Math.min(result.nextAt,due);}
  }
  return {...result,...dailyStats(cards,now)};
}
export function buildQueue(cards,options={},now=Date.now()){
  const scoped=scopeCards(cards,options).filter(card=>!scheduleOf(card,now).suspended&&meaningOf(card));
  const limit=clamp(options.size||20,1,100);
  if(options.practice)return scoped.slice(0,limit).map(card=>card.id);
  // Daily new-card budget is shared across books and rounds, not reset by changing a filter.
  const available=Math.max(0,clamp(options.newPerDay??10,0,50)-dailyStats((cards||[]).filter(validCard),now).introduced);
  const due=scoped.filter(card=>{const r=scheduleOf(card,now);return r.state!=='new'&&Date.parse(r.dueAt)<=now;});
  due.sort((a,b)=>{const x=scheduleOf(a,now),y=scheduleOf(b,now);return (x.state==='learning'?0:1)-(y.state==='learning'?0:1)||Date.parse(x.dueAt)-Date.parse(y.dueAt)||String(a.id).localeCompare(String(b.id));});
  const fresh=scoped.filter(card=>scheduleOf(card,now).state==='new').slice(0,available);
  return [...due,...fresh].slice(0,limit).map(card=>card.id);
}
export function scheduleRating(card,rating,now=Date.now(),eventId='review-'+now){
  if(!['again','hard','good','easy'].includes(rating))throw new Error('未知的复习评价');
  const before=scheduleOf(card,now),next=structuredClone(before),isReview=before.state==='review';
  let delay;
  if(rating==='again'){
    next.state='learning';next.step=0;delay=MINUTE;
    if(isReview){next.lapses++;next.repetitions=0;next.ease=Math.max(1.3,before.ease-.2);}
  }else if(!isReview){
    if(rating==='easy'){next.state='review';next.intervalDays=4;next.repetitions=1;delay=4*DAY;}
    else if(rating==='hard'){next.state='learning';delay=(before.step===1?10:5)*MINUTE;}
    else if(before.state==='learning'&&before.step===1){next.state='review';next.intervalDays=1;next.repetitions=1;delay=DAY;}
    else{next.state='learning';next.step=1;delay=10*MINUTE;}
  }else{
    const interval=Math.max(1,before.intervalDays),hard=Math.max(1,Math.ceil(interval*1.2)),good=Math.max(hard+1,before.repetitions<=1?6:Math.ceil(interval*before.ease));
    next.intervalDays=Math.min(3650,rating==='hard'?hard:rating==='good'?good:Math.max(good+1,Math.ceil(interval*before.ease*1.3)));
    next.ease=clamp(before.ease+(rating==='easy'?.15:rating==='hard'?-.15:0),1.3,3);next.repetitions++;delay=next.intervalDays*DAY;
  }
  const key=dayKey(now);next.introducedDay=before.introducedDay||(before.state==='new'?key:undefined);
  delete next.legacyEstimated;
  next.lastReviewedAt=new Date(now).toISOString();next.dueAt=new Date(now+delay).toISOString();next.lastEventId=eventId;
  const previous=next.days[key]||{};next.days[key]={answers:(Number(previous.answers)||0)+1,firstRating:previous.firstRating||rating};
  next.days=Object.fromEntries(Object.entries(next.days).sort(([a],[b])=>b.localeCompare(a)).slice(0,90));
  next.log=[...before.log,{id:eventId,at:next.lastReviewedAt,rating,dueAt:next.dueAt}].slice(-30);
  return next;
}
export function intervalLabel(card,rating,now=Date.now()){
  const delay=Date.parse(scheduleRating(card,rating,now).dueAt)-now;
  return delay<DAY?Math.round(delay/MINUTE)+' 分钟':Math.round(delay/DAY)+' 天';
}
export function normalizeAnswer(value){return String(value||'').normalize('NFKC').toLowerCase().replace(/[’‘]/g,"'").trim().replace(/^[\s"“”]+|[\s.!?。！？"“”]+$/g,'').replace(/\s+/g,' ');}
export function isCorrectAnswer(typed,term){return Boolean(normalizeAnswer(typed))&&normalizeAnswer(typed)===normalizeAnswer(term);}
export function clozeContext(card){
  const term=String(card.term||'').trim();if(!term)return null;
  const escaped=term.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  for(const value of [card.example,card.context]){
    const context=String(value||'').trim(),pattern=new RegExp('(^|[^A-Za-z])('+escaped+')(?=$|[^A-Za-z])','gi');
    if(context&&pattern.test(context))return context.replace(pattern,(_,prefix)=>prefix+'______');
  }
  return null;
}

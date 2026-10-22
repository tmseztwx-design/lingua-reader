// A durable per-library/device journal. Failed/repeated requests cannot double-count time.
// Historical totals are a shared baseline (max), subsequent device increments are additive.
const ACTIVITY_KEY='scribe-activity-v1';
const counterNumber=value=>Math.max(0,Number(value)||0);
const readActivityJournal=()=>{try{return JSON.parse(localStorage.getItem(ACTIVITY_KEY)||'{}');}catch{return {};}};
export function captureActivity(libraryKey,state){
  const journal=readActivityJournal();
  let entry=journal[libraryKey];
  if(!entry)entry={deviceId:crypto.randomUUID(),initialMinutes:counterNumber(state.minutes),initialReviewed:Math.floor(counterNumber(state.reviewed)),minutes:0,reviewed:0,seenMinutes:counterNumber(state.minutes),seenReviewed:Math.floor(counterNumber(state.reviewed))};
  entry.minutes+=Math.max(0,counterNumber(state.minutes)-entry.seenMinutes);
  entry.reviewed+=Math.max(0,Math.floor(counterNumber(state.reviewed))-entry.seenReviewed);
  entry.seenMinutes=counterNumber(state.minutes);entry.seenReviewed=Math.floor(counterNumber(state.reviewed));
  journal[libraryKey]=entry;localStorage.setItem(ACTIVITY_KEY,JSON.stringify(journal));
  return {libraryKey,request:{deviceId:entry.deviceId,initialMinutes:entry.initialMinutes,initialReviewed:entry.initialReviewed,minutes:entry.minutes,reviewed:entry.reviewed}};
}
export function applyActivity(snapshot,totals,before,next){
  const journal=readActivityJournal(),entry=journal[snapshot.libraryKey];
  if(!entry)return;
  const extraMinutes=Math.max(0,counterNumber(before.minutes)-entry.seenMinutes);
  const extraReviewed=Math.max(0,counterNumber(before.reviewed)-entry.seenReviewed);
  entry.minutes+=extraMinutes;entry.reviewed+=extraReviewed;
  next.minutes=counterNumber(totals.minutes)+(entry.minutes-snapshot.request.minutes);
  next.reviewed=counterNumber(totals.reviewed)+(entry.reviewed-snapshot.request.reviewed);
  entry.seenMinutes=next.minutes;entry.seenReviewed=next.reviewed;
  localStorage.setItem(ACTIVITY_KEY,JSON.stringify(journal));
}

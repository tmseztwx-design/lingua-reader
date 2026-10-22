import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {JSDOM} from 'jsdom';
import {MINUTE,DAY,dayKey,scheduleOf,migrateSchedules,buildQueue,scheduleRating,intervalLabel,reviewStats,dailyStats,isCorrectAnswer,clozeContext} from '../src/review-scheduler.js';
import {localEntries,applyEntries} from '../src/sync-state.js';
import {mergeBackup,readBackupPayload} from '../src/restore-backup.js';

const NOW=new Date('2026-10-22T08:00:00+08:00').getTime();
const card=(id,extras={})=>({id,term:id==='a'?'knowledge':'agency',type:'word',meaning:'知识；了解',context:'Knowledge grows through experience.',documentId:'book-a',documentTitle:'Book A',note:'Keep this note',due:true,...extras});
test('short learning steps have real absolute due dates; mature intervals adapt to recall',()=>{
  const original=card('a'),again=scheduleRating(original,'again',NOW),hard=scheduleRating(original,'hard',NOW),good=scheduleRating(original,'good',NOW),easy=scheduleRating(original,'easy',NOW);
  assert.equal(Date.parse(again.dueAt),NOW+MINUTE);assert.equal(Date.parse(hard.dueAt),NOW+5*MINUTE);assert.equal(Date.parse(good.dueAt),NOW+10*MINUTE);assert.equal(Date.parse(easy.dueAt),NOW+4*DAY);
  assert.equal(good.state,'learning');assert.equal(easy.state,'review');assert.equal(intervalLabel(original,'again',NOW),'1 分钟');
  const graduate=scheduleRating({...original,review:good},'good',NOW+10*MINUTE);assert.equal(graduate.intervalDays,1);assert.equal(graduate.state,'review');
  const mature={...original,review:{...graduate,intervalDays:10,repetitions:3,ease:2.5}};
  assert.equal(scheduleRating(mature,'good',NOW).intervalDays,25);assert.ok(scheduleRating(mature,'easy',NOW).intervalDays>25);assert.ok(scheduleRating(mature,'hard',NOW).intervalDays<25);
  assert.equal(scheduleRating(mature,'again',NOW).lapses,1);assert.equal(original.review,undefined,'pure scheduler never mutates the source');
});
test('due cards are prioritized, future cards never sneak in, and filtering preserves independent IDs',()=>{
  const future=card('future',{review:{version:1,state:'review',dueAt:new Date(NOW+DAY).toISOString()}});
  const late=card('late',{review:{version:1,state:'review',dueAt:new Date(NOW-DAY).toISOString()}});
  const learning=card('learn',{review:{version:1,state:'learning',dueAt:new Date(NOW-MINUTE).toISOString()}});
  const fresh=card('new'),other=card('other',{documentId:'book-b'});
  assert.deepEqual(buildQueue([fresh,future,late,learning,other],{size:3},NOW),['learn','late','new']);
  assert.deepEqual(buildQueue([fresh,future,late,learning,other],{book:'book-b'},NOW),['other']);
  assert.deepEqual(buildQueue([future],{},NOW),[]);assert.deepEqual(buildQueue([future],{practice:true},NOW),['future']);
  assert.deepEqual(buildQueue([fresh],{newPerDay:0},NOW),[]);
});
test('daily new-card budget is shared by all books and is not consumed by repeated ratings',()=>{
  const a=card('a'),review=scheduleRating(a,'again',NOW,'first'),again=scheduleRating({...a,review},'good',NOW+MINUTE,'second');
  assert.deepEqual(dailyStats([{...a,review:again}],NOW),{studied:1,introduced:1,answers:2,remembered:0});
  const b=card('b',{documentId:'book-b'});
  assert.deepEqual(buildQueue([{...a,review:again},b],{book:'book-b',newPerDay:1},NOW),[]);
  assert.deepEqual(buildQueue([{...a,review:again},b],{book:'book-b',newPerDay:1},NOW+DAY),['b']);
});
test('legacy migration is conservative and preserves notes, IDs, book bindings and previous data',()=>{
  const old=card('a',{due:false,nextReview:21}),state={cards:[old,card('guide',{id:'guide',term:''})]};
  assert.equal(migrateSchedules(state,NOW),true);assert.equal(old.review.legacyEstimated,true);assert.equal(Date.parse(old.review.dueAt),NOW);
  assert.equal(old.note,'Keep this note');assert.equal(old.nextReview,21);assert.equal(old.documentId,'book-a');assert.equal(state.cards[1].review,undefined);
  assert.equal(migrateSchedules(state,NOW+DAY),false,'dates do not move forward on every reload');
  assert.equal(reviewStats(state.cards,NOW).due,1);
});
test('suspended and incomplete cards stay stored but do not enter formal or practice queues',()=>{
  const paused=card('paused',{review:{version:1,suspended:true}}),pending=card('pending',{meaning:'正在查询音标与语境释义…'});
  assert.deepEqual(buildQueue([paused,pending],{},NOW),[]);assert.deepEqual(buildQueue([paused,pending],{practice:true},NOW),[]);
  const stats=reviewStats([paused,pending],NOW);assert.equal(stats.suspended,1);assert.equal(stats.blocked,1);assert.equal(stats.total,2);
});
test('spelling accepts normalized capitalization and punctuation, but not near-miss answers',()=>{
  assert.equal(isCorrectAnswer(' Knowledge. ','knowledge'),true);assert.equal(isCorrectAnswer('rather   than','rather than'),true);
  assert.equal(isCorrectAnswer('knowledgeable','knowledge'),false);assert.equal(isCorrectAnswer('','knowledge'),false);
  assert.equal(isCorrectAnswer('teacher’s','teacher\'s'),true);
  assert.equal(clozeContext(card('a')),'______ grows through experience.');
  assert.equal(clozeContext(card('a',{term:'art',context:'A partial sentence.'})),null,'do not replace substrings of other words');
  assert.equal(clozeContext(card('a',{term:'rather than',context:'Rather than guessing, recall rather than copy.'})),'______ guessing, recall ______ copy.');
  assert.equal(clozeContext(card('a',{example:'An unrelated example.',context:'Knowledge grows.'})),'______ grows.','use the original context when an old example lacks the expression');
});
test('review logs are bounded, but daily counts survive log truncation and cloud/backup round trips',()=>{
  let value=card('a');for(let n=0;n<45;n++)value={...value,review:scheduleRating(value,'again',NOW+n*MINUTE,'event-'+n)};
  assert.equal(value.review.log.length,30);assert.equal(value.review.days[dayKey(NOW)].answers,45);
  const state={docs:[{id:'book-a'}],cards:[value],settings:{}},entries=[...localEntries(state).values()].map(entry=>({kind:entry.kind,entry_id:entry.id,value:entry.value}));
  assert.deepEqual(applyEntries({docs:[],cards:[],settings:{}},entries).cards[0].review,value.review);
  assert.deepEqual(mergeBackup({docs:[],cards:[]},readBackupPayload(state)).state.cards[0].review,value.review);
});

const uiCode=(await Promise.all(['review-scheduler.js','review-ui.js'].map(name=>readFile(new URL('../src/'+name,import.meta.url),'utf8')))).map(code=>code.replace(/^import[^\n]*\n/gm,'').replace(/^export\s+/gm,'')).join('\n');
function boot(cards,extra={}){
  const dom=new JSDOM('<!doctype html><nav class="nav"><button data-view="library">书库</button><button data-view="knowledge">知识库</button></nav><section class="view active" id="review"></section><input id="outside">',{url:'https://scribe.test',runScripts:'outside-only'}),w=dom.window;
  let now=extra.now||NOW;w.Date.now=()=>now;w.structuredClone=structuredClone;w.setInterval=()=>0;
  const state={docs:[{id:'book-a',title:'Book A'},{id:'book-b',title:'Book B'}],cards,reviewed:0,settings:{review:extra.options||{}},...extra.state};
  w.localStorage.setItem('scribe-local-v1',JSON.stringify(state));if(extra.session)w.localStorage.setItem('scribe-review-session-v1',JSON.stringify(extra.session));
  if(extra.library)w.localStorage.setItem('scribe-library-key',extra.library);
  w.__scribeBookCards={sourceLabel:(_,item)=>(item.documentTitle||'Book A')+' · 第 1 页'};
  w.eval(uiCode+'\ninstallReview();');
  const root=w.document.querySelector('#review'),read=()=>JSON.parse(w.localStorage.getItem('scribe-local-v1'));
  const click=action=>{const el=root.querySelector('[data-review-action="'+action+'"]');assert.ok(el,'missing action '+action);el.click();};
  const rating=quality=>root.querySelector('[data-review-rating="'+quality+'"]').click();
  const key=(value,code='')=>w.document.dispatchEvent(new w.KeyboardEvent('keydown',{key:value,code,bubbles:true}));
  return {dom,w,root,read,click,rating,key,advance:ms=>{now+=ms;},now:()=>now};
}
test('formal session has no skipped cards or endless wrap-around, and exact schedules persist',t=>{
  const {dom,w,root,read,click,rating}=boot([card('a'),card('b')]);t.after(()=>dom.window.close());
  assert.match(root.textContent,/2张可开始学习/);click('start');assert.equal(root.querySelector('#reviewTerm').textContent,'knowledge');
  assert.equal(root.querySelector('#answerMeaning'),null,'answer is actually hidden, not just styled invisible');
  click('reveal');rating('easy');assert.equal(root.querySelector('#reviewTerm').textContent,'agency');
  click('reveal');rating('easy');assert.match(root.textContent,/完成这一小轮/);assert.equal(root.querySelector('#reviewTerm'),null);
  assert.equal(read().reviewed,2);assert.equal(Date.parse(read().cards[0].review.dueAt),NOW+4*DAY);
  click('home');click('start');assert.match(root.textContent,/当前范围没有需要开始/);assert.equal(w.__scribeReview.getSession().results.length,2);
});
test('wrong spellings cannot be rated remembered, and forgotten cards wait for their real learning step',t=>{
  const {dom,w,root,read,click,rating,advance}=boot([card('a')],{options:{mode:'spell'}});t.after(()=>dom.window.close());
  click('start');assert.equal(root.querySelector('#reviewTerm'),null);assert.doesNotMatch(root.textContent,/Knowledge grows/,'no original sentence leaks the answer before reveal');
  const input=root.querySelector('#reviewTyping');input.value='knowlege';input.dispatchEvent(new w.Event('input',{bubbles:true}));root.querySelector('form').dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));
  assert.equal(root.querySelector('[data-review-rating="good"]').disabled,true);rating('good');assert.equal(read().reviewed,0);
  rating('again');assert.match(root.textContent,/短时巩固/);assert.equal(root.querySelector('#reviewTyping'),null);
  click('check-wait');assert.equal(root.querySelector('#reviewTyping'),null);
  advance(MINUTE);click('check-wait');assert.ok(root.querySelector('#reviewTyping'));
});
test('session survives reload; undo changes only scheduling and preserves newer notes/definitions',t=>{
  const one=boot([card('a'),card('b')]);t.after(()=>one.dom.window.close());one.click('start');one.click('reveal');one.rating('easy');
  const saved=one.w.__scribeReview.getSession(),state=one.read(),two=boot(state.cards,{state,session:saved});t.after(()=>two.dom.window.close());
  two.click('resume');assert.equal(two.root.querySelector('#reviewTerm').textContent,'agency');
  // Undo is intentionally per-tab, not a stale persisted card snapshot from another session.
  assert.equal(two.root.querySelector('[data-review-action="undo"]').disabled,true);
  const fresh=one.read();fresh.cards[0].note='Edited after rating';fresh.cards[0].translation='新的语境释义';one.w.localStorage.setItem('scribe-local-v1',JSON.stringify(fresh));
  one.click('undo');assert.equal(one.read().cards[0].review.state,'new');assert.equal(one.read().cards[0].note,'Edited after rating');assert.equal(one.read().cards[0].translation,'新的语境释义');
  assert.equal(one.root.querySelector('#reviewTerm').textContent,'knowledge');
});
test('cloud changes or deletion never apply a stale rating to the next card',t=>{
  const {dom,w,root,read,click,rating}=boot([card('a'),card('b')]);t.after(()=>dom.window.close());click('start');click('reveal');
  const state=read();state.cards=state.cards.filter(item=>item.id!=='a');w.localStorage.setItem('scribe-local-v1',JSON.stringify(state));
  rating('easy');assert.equal(read().reviewed,0);assert.equal(read().cards[0].review.state,'new');assert.equal(root.querySelector('#reviewTerm').textContent,'agency');
});
test('keyboard shortcuts reveal before grading and ignore an active input',t=>{
  const {dom,w,root,read,click,key}=boot([card('a'),card('b')]);t.after(()=>dom.window.close());click('start');key('4');assert.equal(read().reviewed,0);
  const field=w.document.querySelector('#outside');field.dispatchEvent(new w.KeyboardEvent('keydown',{key:' ',code:'Space',bubbles:true}));assert.equal(root.querySelector('#answerMeaning'),null);
  key(' ','Space');assert.ok(root.querySelector('#answerMeaning'));field.dispatchEvent(new w.KeyboardEvent('keydown',{key:'4',bubbles:true}));assert.equal(read().reviewed,0);
  key('4');assert.equal(read().reviewed,1);assert.equal(root.querySelector('#reviewTerm').textContent,'agency');
});
test('practice, skip and suspension never pretend to be a successful scheduled review',t=>{
  const initial=card('a',{review:{version:1,state:'review',dueAt:new Date(NOW+DAY).toISOString()}}),{dom,root,read,click,rating}=boot([initial]);t.after(()=>dom.window.close());
  click('practice');click('reveal');rating('good');assert.equal(read().reviewed,0);assert.equal(read().cards[0].review.dueAt,initial.review.dueAt);
  click('home');click('practice');click('suspend');assert.equal(read().cards[0].review.suspended,true);assert.equal(read().reviewed,0);
  click('home');click('restore');assert.equal(read().cards[0].review.suspended,false);assert.match(root.textContent,/词卡已恢复/);
});
test('a library switch invalidates resume data and does not mutate the other library',t=>{
  const {dom,w,root,read,click,rating}=boot([card('a')]);t.after(()=>dom.window.close());click('start');click('reveal');
  w.localStorage.setItem('scribe-library-key','b'.repeat(64));rating('good');assert.equal(read().reviewed,0);assert.match(root.textContent,/学习空间已切换/);
});
test('a full browser store reports the failure without advancing the card or session',t=>{
  const {dom,w,root,read,click,rating}=boot([card('a')]);t.after(()=>dom.window.close());click('start');click('reveal');
  const proto=w.Storage.prototype,original=proto.setItem;proto.setItem=function(name,value){if(name==='scribe-local-v1')throw new Error('quota');return original.call(this,name,value);};
  rating('good');assert.equal(read().reviewed,0);assert.match(root.textContent,/本机存储未能保存/);assert.ok(root.querySelector('#answerMeaning'));
});

test('a background refresh never replaces an unchanged answer or steals spelling focus',t=>{
  const {dom,w,root,click}=boot([card('a')]);t.after(()=>dom.window.close());click('start');click('reveal');
  const answer=root.querySelector('#answer');w.__scribeReview.refresh();assert.equal(root.querySelector('#answer'),answer);
  click('home');root.querySelector('[data-review-mode="spell"]').click();click('start');
  const input=root.querySelector('#reviewTyping');input.value='kno';input.dispatchEvent(new w.Event('input',{bubbles:true}));w.__scribeReview.refresh();
  assert.equal(root.querySelector('#reviewTyping'),input);assert.equal(input.value,'kno');assert.equal(w.document.activeElement,input);
});

test('new-card budget is rechecked after a different device introduces cards mid-round',t=>{
  const {dom,w,root,read,click}=boot([card('a'),card('b'),card('elsewhere')],{options:{newPerDay:5}});t.after(()=>dom.window.close());click('start');
  const state=read();state.cards=state.cards.concat(Array.from({length:5},(_,n)=>card('remote-'+n,{review:{version:1,state:'review',dueAt:new Date(NOW+DAY).toISOString(),introducedDay:dayKey(NOW)}})));
  w.localStorage.setItem('scribe-local-v1',JSON.stringify(state));click('skip');assert.match(root.textContent,/完成这一小轮/);assert.equal(read().reviewed,0);
});

test('night mode changes the actual page and toggle state without destroying the current input',t=>{
  const {dom,w,root,click}=boot([card('a')],{options:{mode:'spell'}});t.after(()=>dom.window.close());click('start');
  const input=root.querySelector('#reviewTyping');input.value='know';click('theme');
  assert.equal(root.classList.contains('review-dark'),true);assert.equal(root.querySelector('[data-review-action="theme"]').getAttribute('aria-pressed'),'true');
  assert.equal(root.querySelector('#reviewTyping'),input);assert.equal(input.value,'know');assert.equal(w.localStorage.getItem('scribe-review-theme'),'dark');
  click('theme');assert.equal(root.classList.contains('review-dark'),false);
});

test('book titles and glosses cannot leak the spelling answer before checking',t=>{
  const {dom,w,root,click}=boot([card('a',{documentTitle:'Knowledge study',meaning:'knowledge：知识'})],{options:{mode:'spell'}});t.after(()=>dom.window.close());click('start');
  assert.doesNotMatch(root.textContent,/knowledge/i);
  root.querySelector('#reviewTyping').value='knowledge';root.querySelector('form').dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));
  assert.equal(root.querySelector('[data-review-rating="good"]').disabled,false);
});

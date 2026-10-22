import {validCard,meaningOf,scopeCards,scheduleOf,migrateSchedules,reviewStats,dailyStats,buildQueue,scheduleRating,intervalLabel,isCorrectAnswer,clozeContext,dayKey} from './review-scheduler.js';

const STATE='scribe-local-v1',SESSION='scribe-review-session-v1';
const defaults={mode:'recognize',book:'all',kind:'all',size:20,newPerDay:10};
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const copy=value=>structuredClone(value);
const id=()=>globalThis.crypto?.randomUUID?.()||'review-'+Date.now()+'-'+Math.random().toString(36).slice(2);
const readJSON=(key,fallback)=>{try{return JSON.parse(localStorage.getItem(key))||fallback;}catch{return fallback;}};
const ratingNames={again:'忘记了',hard:'有点吃力',good:'记得',easy:'很熟悉'};
const typeNames={word:'词汇',phrase:'短语',sentence:'句子'};
function normalizeOptions(value={}){
  const result={...defaults,...value};
  if(!['recognize','spell','context'].includes(result.mode))result.mode='recognize';
  if(!['all','word','phrase','sentence'].includes(result.kind))result.kind='all';
  result.size=[10,20,50].includes(Number(result.size))?Number(result.size):20;
  result.newPerDay=[0,5,10,20,30,50].includes(Number(result.newPerDay))?Number(result.newPerDay):10;
  return result;
}

export function installReview(){
  const root=document.querySelector('#review');
  if(!root||root.dataset.reviewInstalled)return;
  root.dataset.reviewInstalled='1';
  let options,session=null,screen='home',currentId=null,shown=false,typed='',checked=null,contextHint=false,undo=null,notice='',error='',fingerprint='',materialSignature='',saving=false;
  const library=()=>localStorage.getItem('scribe-library-key')||'local';
  const read=()=>readJSON(STATE,{docs:[],cards:[],settings:{}});
  const source=(state,card)=>window.__scribeBookCards?.sourceLabel(state,card)||card.documentTitle||card.source||'未归属阅读本';
  const active=()=>root.classList.contains('active');
  const stamp=card=>JSON.stringify(card?.review||null);
  const materialStamp=card=>JSON.stringify([card?.term,card?.translation,card?.meaning,card?.gloss,card?.phonetic,card?.note,card?.context,card?.example]);
  const materialCards=state=>(state.cards||[]).filter(validCard).map(card=>{
    const detail=window.__scribeWordDetails?.[String(card.term||'').toLowerCase()];
    return {...card,documentId:card.documentId||window.__scribeBookCards?.owner(state,card),
      translation:meaningOf(card)||(detail?detail[1]:''),phonetic:card.phonetic||(detail?detail[0]:'')};
  });
  const when=time=>new Date(time).toLocaleString('zh-CN',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'});
  const button=(action,label,classes='review-btn',extra='')=>'<button type="button" class="'+classes+'" data-review-action="'+action+'" '+extra+'>'+label+'</button>';
  function writeState(state){
    try{localStorage.setItem(STATE,JSON.stringify(state));return true;}
    catch{error='本机存储未能保存，本次没有推进复习。请释放空间后重试。';return false;}
  }
  function saveSession(){
    try{if(session)localStorage.setItem(SESSION,JSON.stringify(session));else localStorage.removeItem(SESSION);}
    catch{error='词卡记录已保留，但本轮续学进度暂未保存。请检查本机空间。';}
  }
  function scrollStage(selector){const target=root.querySelector(selector);if(active()&&typeof target?.scrollIntoView==='function')target.scrollIntoView({block:'start',behavior:'instant'});}
  function emit(){window.dispatchEvent(new Event('scribe-cards-updated'));updateDashboard();}
  function cancelSpeech(){try{window.speechSynthesis?.cancel();}catch{}}
  function hydrate(){
    const state=read();options=normalizeOptions(state.settings?.review);
    if(options.book!=='all'&&![...(state.docs||[]),...(state.deletedDocs||[])].some(doc=>doc.id===options.book))options.book='all';
    if(migrateSchedules(state)&&writeState(state))emit();
    const saved=readJSON(SESSION,null);
    if(saved?.version===1&&saved.library===library()&&saved.day===dayKey()&&Array.isArray(saved.queue)&&Array.isArray(saved.waiting)&&Array.isArray(saved.results)&&Array.isArray(saved.initialIds)&&Array.isArray(saved.skipped)&&saved.options){
      session={...saved,options:normalizeOptions(saved.options),waiting:saved.waiting.filter(item=>item&&typeof item.id==='string'&&Number.isFinite(item.at))};
    }else session=null;
  }
  function sessionCard(){return materialCards(read()).find(card=>card.id===currentId);}
  function snapshot(state){
    const cards=materialCards(state),scoped=scopeCards(cards,options),stats=reviewStats(scoped),daily=dailyStats(cards);
    const available=buildQueue(cards,options).length;
    return {cards,scoped,stats,daily,available};
  }
  function statsHTML(stats){return '<div class="review-metrics" aria-label="真实复习统计">'+[
    ['今日已学',stats.studied,'张 · 各卡仅计一次'],['到期复习',stats.due,'张 · 优先温习'],['还未学习',stats.new,'张 · 按每日上限学习'],['后续计划',stats.future,'张 · 未到期不打扰']
  ].map(([title,total,sub])=>'<div><span>'+title+'</span><strong>'+total+'</strong><small>'+sub+'</small></div>').join('')+'</div>';}
  function header(state,stats){
    const resumable=session&&(session.queue.length||session.waiting.length),ready=buildQueue(materialCards(state),options).length;
    const mainAction=resumable?'resume':ready||!stats.total?'start':'practice',mainLabel=resumable?'继续本轮 →':ready?'开始学习 →':stats.total?'随心练习 →':'去书库收词 →';
    return '<div class="review-heading"><div><div class="eyebrow">YOUR READING, REMEMBERED</div><h1>让读过的，真正记住。</h1><p>从原书中积累，在恰当的时候再遇见。</p></div><div class="review-heading-actions">'+(screen==='home'?button(mainAction,mainLabel,'review-btn primary'):'')+button('theme',root.classList.contains('review-dark')?'☀ 日间':'☾ 夜间','review-btn quiet','aria-pressed="'+root.classList.contains('review-dark')+'"')+'</div></div>'+statsHTML(stats)+
      '<div class="review-notice" role="status" '+(!notice?'hidden':'')+'>'+esc(notice)+'</div><div class="review-error" role="alert" '+(!error?'hidden':'')+'>'+esc(error)+'</div>';
  }
  function controls(state){
    const docs=[...(state.docs||[]),...(state.deletedDocs||[])],unique=new Map(docs.map(doc=>[doc.id,doc]));
    for(const card of state.cards||[])if(card.documentId&&!unique.has(card.documentId))unique.set(card.documentId,{id:card.documentId,title:card.documentTitle||'已移除阅读本'});
    return '<div class="review-controls"><label>学习范围<select data-review-option="book" aria-label="学习范围"><option value="all">全部阅读本 · 汇总学习</option>'+[...unique.values()].map(doc=>'<option value="'+esc(doc.id)+'" '+(options.book===doc.id?'selected':'')+'>'+esc(doc.title)+'</option>').join('')+'</select></label><label>卡片类型<select data-review-option="kind" aria-label="卡片类型">'+[['all','全部词卡'],['word','词汇'],['phrase','短语'],['sentence','句子']].map(([v,t])=>'<option value="'+v+'" '+(options.kind===v?'selected':'')+'>'+t+'</option>').join('')+'</select></label><label>每轮张数<select data-review-option="size" aria-label="每轮张数">'+[10,20,50].map(n=>'<option '+(Number(options.size)===n?'selected':'')+' value="'+n+'">'+n+' 张</option>').join('')+'</select></label><label>每日新卡<select data-review-option="newPerDay" aria-label="每日新卡上限">'+[0,5,10,20,30,50].map(n=>'<option '+(Number(options.newPerDay)===n?'selected':'')+' value="'+n+'">'+(n?n+' 张':'只复习旧卡')+'</option>').join('')+'</select></label></div>';
  }
  function modesHTML(){return '<div class="review-modes" role="group" aria-label="记忆训练方式">'+[
    ['recognize','01','看词忆义','先主动回想，再揭晓释义'],['spell','02','看义拼写','把认识的词，真正写出来'],['context','03','原文填空','回到你读过的那句话']
  ].map(([mode,n,title,description])=>'<button type="button" data-review-mode="'+mode+'" aria-pressed="'+(options.mode===mode)+'" class="'+(options.mode===mode?'selected':'')+'"><span>'+n+'</span><b>'+title+'</b><small>'+description+'</small></button>').join('')+'</div>';}
  function suspendedHTML(cards,state){
    const suspended=scopeCards(cards,options).filter(card=>scheduleOf(card).suspended);
    if(!suspended.length)return '';
    return '<details class="review-paused"><summary>已暂停 '+suspended.length+' 张词卡 · 点击管理</summary>'+suspended.map(card=>'<div><span>'+esc(card.term)+'<small>'+esc(source(state,card))+'</small></span>'+button('restore','恢复复习','review-btn quiet','data-restore-id="'+esc(card.id)+'"')+'</div>').join('')+'</details>';
  }
  function renderHome(){
    const returning=screen!=='home';cancelSpeech();screen='home';currentId=null;shown=false;
    const state=read(),{cards,stats,daily,available}=snapshot(state),resume=session&&(session.queue.length||session.waiting.length);
    const legacy=cards.some(card=>card.review?.legacyEstimated);
    root.innerHTML=header(state,stats)+controls(state)+modesHTML()+'<div class="review-home-grid"><article class="review-paper review-invitation"><div class="review-paper-kicker">一点回忆，胜过反复浏览</div><h2>'+(stats.total?(available?'今天，巩固一点点。':stats.new?'为下一次记忆留些空间。':'记忆也需要留白。'):'从阅读里，收下第一个词。')+'</h2><p>'+(stats.total?'到期内容先复习，新卡按上限加入。每张词卡保留自己的阅读语境，不因汇总学习而串书。':'在精读页点击单词，或划选短语与句子，它们会在这里汇成你的专属词库。')+'</p><div class="review-plan-count"><strong>'+available+'</strong><span>张可开始学习<small>已为你留出可完成的一小轮</small></span></div><div class="review-home-actions">'+(resume?button('resume','继续未完成的一轮 →','review-btn primary'):button('start',available?'开始本轮学习 →':stats.total?'查看下一次复习':'去书库收词 →','review-btn primary'))+(resume?button('start','按当前设置新开一轮','review-btn'):'')+(stats.total?button('practice','随心练习','review-btn'):'')+'</div>'+(resume?'<p class="review-micro">本轮剩余 '+session.queue.length+' 张，另有 '+session.waiting.length+' 张短时巩固。续学将使用本轮原来的范围和模式。</p>':'')+(stats.nextAt?'<p class="review-micro">最近一次计划：'+esc(when(stats.nextAt))+'</p>':'')+(stats.new&&daily.introduced>=Number(options.newPerDay)?'<p class="review-micro">今日新卡上限已用完；到期复习不受影响，也可选择随心练习。</p>':'')+(stats.blocked?'<p class="review-micro">'+stats.blocked+' 张词卡尚无有效释义，暂不用于背诵。可在知识库查看，或回原书补全。</p>':'')+'</article><aside class="review-plan"><div class="eyebrow">HOW IT WORKS</div><h2>把每次回忆，<br>用在恰好的地方。</h2><ol><li><b>先想，再看</b><p>不急着翻答案，给自己一次真正回忆的机会。</p></li><li><b>如实选择掌握程度</b><p>想不起来选「忘记了」；「有点吃力」仍表示已经想起来。</p></li><li><b>系统安排下次相遇</b><p>忘记的词短时巩固，熟悉的词逐步拉长间隔。</p></li></ol><div class="review-small-stat">今日已学新卡 <b>'+daily.introduced+' / '+Number(options.newPerDay)+'</b></div>'+button('knowledge','浏览总词库 ↗','review-btn quiet')+'</aside></div>'+suspendedHTML(cards,state)+(legacy?'<p class="review-method-note">旧版本未保存准确到期日，相关旧卡已保守纳入待复习。原有笔记与学习记录未删除。</p>':'')+'<p class="review-method-note">采用可解释的间隔复习规则，不预测“记住概率”。语境始终来自你的阅读本。</p>';
    if(returning)scrollStage('.review-heading');
  }
  function start(practice=false){
    error='';notice='';const {cards}=snapshot(read()),queue=buildQueue(cards,{...options,practice});
    if(!queue.length){
      if(!cards.length){navigate('library');return;}
      notice='当前范围没有需要开始的词卡。可调整范围、查看后续计划，或使用随心练习。';renderHome();return;
    }
    session={version:1,id:id(),library:library(),day:dayKey(),options:{...options,practice},queue,waiting:[],results:[],skipped:[],initialIds:[...queue],createdAt:Date.now()};
    undo=null;saveSession();next();
  }
  function next(){
    cancelSpeech();shown=false;typed='';checked=null;contextHint=false;currentId=null;
    if(!session||session.library!==library()){session=null;notice='学习空间已切换，请重新选择学习范围。';renderHome();return;}
    const cards=materialCards(read()),byId=new Map(cards.map(card=>[card.id,card])),now=Date.now();
    for(const entry of session.waiting)if(entry.at<=now&&!session.queue.includes(entry.id))session.queue.push(entry.id);
    session.waiting=session.waiting.filter(entry=>entry.at>now&&byId.has(entry.id)&&!scheduleOf(byId.get(entry.id)).suspended);
    let newBudget=Math.max(0,Number(session.options.newPerDay)-dailyStats(cards,now).introduced);
    session.queue=session.queue.filter(cardId=>{const card=byId.get(cardId);if(!card||scheduleOf(card).suspended||!meaningOf(card))return false;
      const r=scheduleOf(card);if(session.options.practice)return true;
      if(r.state==='new'){if(newBudget<=0)return false;newBudget--;return true;}
      return Date.parse(r.dueAt)<=now;
    });
    currentId=session.queue[0]||null;saveSession();
    if(currentId){screen='study';fingerprint=stamp((read().cards||[]).find(card=>card.id===currentId));renderCard();scrollStage('.review-round-progress');}
    else{screen=session.waiting.length?'waiting':'summary';renderEnd();scrollStage('.review-complete');}
  }
  function effectiveMode(card){
    if(!card)return 'recognize';
    const mode=session.options.mode;
    if(mode==='spell'&&card.type==='sentence')return 'recognize';
    if(mode==='context'&&!clozeContext(card))return 'recognize';
    return mode;
  }
  function audioButton(card,hidden=false){
    const capable=Boolean(window.speechSynthesis&&window.SpeechSynthesisUtterance);
    return hidden?'':button('speak','♪ 系统朗读','review-btn quiet','aria-label="朗读当前词卡" '+(!capable?'disabled title="当前浏览器不支持系统朗读"':''));
  }
  function renderCard(){
    const card=sessionCard();if(!card){next();return;}
    const state=read(),{stats}=snapshot(state),mode=effectiveMode(card),isTyping=mode!=='recognize',r=scheduleOf(card);
    materialSignature=materialStamp(card);
    const done=new Set(session.results.map(item=>item.cardId)).size;
    const frontSource=shown||!isTyping?source(state,card):(clozeContext({term:card.term,context:source(state,card)})||source(state,card));
    const frontMeaning=shown||!isTyping?meaningOf(card):(clozeContext({term:card.term,context:meaningOf(card)})||meaningOf(card));
    const prompt=mode==='spell'?'<div class="review-meaning-prompt">'+esc(frontMeaning)+'</div>':mode==='context'?'<blockquote class="review-cloze">'+esc(clozeContext(card))+'</blockquote>':'<div class="review-term '+(card.type!=='word'?'expression':'')+'" id="reviewTerm">'+esc(card.term)+'</div>';
    const typing=isTyping&&!shown?'<form data-review-form><label class="review-input-label" for="reviewTyping">'+(mode==='context'?'填入缺失的词或表达':'写出对应的英文')+'</label><input id="reviewTyping" lang="en" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" value="'+esc(typed)+'" placeholder="在这里输入英文…"><div class="review-typing-actions"><button class="review-btn primary" type="submit">检查答案 <kbd>Enter</kbd></button>'+button('forgot','想不起来，查看答案','review-btn quiet')+'</div></form>':'';
    root.innerHTML=header(state,stats)+'<div class="review-session-bar"><div>'+button('home','← 暂停并返回计划','review-btn quiet')+'<span>'+(session.options.practice?'随心练习 · 不改复习计划':'间隔复习')+'</span></div>'+button('undo','↶ 撤销上次评价','review-btn quiet',!undo?'disabled':'')+'</div><div class="review-round-progress"><span id="reviewProgress">已完成 '+done+' / '+session.initialIds.length+' 张</span><span>剩余 '+session.queue.length+' 张'+(session.waiting.length?' · '+session.waiting.length+' 张巩固中':'')+'</span><div role="progressbar" aria-label="本轮词卡进度" aria-valuemin="0" aria-valuemax="'+session.initialIds.length+'" aria-valuenow="'+done+'"><i style="width:'+Math.min(100,done/Math.max(1,session.initialIds.length)*100)+'%"></i></div></div><article class="review-paper review-study-card"><div class="review-card-top"><span class="review-stage" id="reviewType">'+typeNames[card.type]+' · '+(session.options.practice?'练习':r.state==='new'?'新卡':r.state==='learning'?'短时巩固':'到期复习')+'</span><span class="review-mode-name">'+({recognize:'看词忆义',spell:'看义拼写',context:'原文填空'}[mode])+'</span></div><p class="review-book-source" id="reviewSource">'+esc(frontSource)+'</p><div class="review-prompt">'+prompt+(!isTyping&&card.phonetic?'<p class="review-ipa">'+esc(card.phonetic)+'</p>':'')+(!isTyping?audioButton(card):'')+'<p id="reviewHint" class="review-prompt-hint">'+(mode==='recognize'?(card.type==='sentence'?'试着说出这句话的中文意思。':'先在脑中回忆它在本文中的意思。'):'不必急着查看答案，试着主动回忆。')+'</p>'+(mode!==session.options.mode?'<p class="review-micro">'+(card.type==='sentence'?'句子卡使用译义回忆，不要求逐字拼写。':'这张卡没有可用的原句，已切换为看词忆义。')+'</p>':'')+'</div>'+typing+(!shown&&!isTyping?'<div class="review-reveal-row">'+button('reveal','揭晓释义 <kbd>空格</kbd>','review-btn primary','id="reveal"')+(card.context?button('hint','给我一点语境','review-btn quiet'):'')+'</div>':'')+(!shown&&contextHint?'<div class="review-context-hint"><small>本文语境 · 这不是一次独立回忆</small><p>'+esc(card.context)+'</p></div>':'')+(shown?answerHTML(card,state,isTyping):'')+'<div class="review-card-footer">'+button('skip','本轮跳过','review-btn quiet')+button('suspend','暂停此卡','review-btn quiet')+'<small>不会删除词卡或笔记</small></div></article><p class="review-keyboard-hint">空格揭晓 · 1–4 评价 · Ctrl/⌘ Z 撤销 · 在输入框中不会触发评价</p>';
    if(!shown&&isTyping&&window.innerWidth>=600)root.querySelector('#reviewTyping')?.focus({preventScroll:true});
  }
  function answerHTML(card,state,isTyping){
    const wrong=checked===false,practice=session.options.practice;
    return '<section class="review-answer" id="answer" aria-label="词卡答案"><div class="review-answer-kicker">'+(wrong?'再看一次，下一次会更熟悉。':checked===true?'拼写正确，再对照一下语境。':'对照答案，再判断这次回忆。')+'</div>'+(isTyping?'<h2 id="reviewTerm">'+esc(card.term)+'</h2><p class="review-ipa">'+esc(card.phonetic||'')+'</p>'+audioButton(card):'')+(typed?'<p class="review-typed '+(wrong?'wrong':'right')+'">你的输入：'+esc(typed)+'</p>':'')+'<div class="review-answer-meaning" id="answerMeaning">'+esc(meaningOf(card))+'</div>'+(card.gloss&&card.gloss!==meaningOf(card)?'<p>'+esc(card.gloss)+'</p>':'')+'<div class="review-original"><small>本文原句</small><p id="answerContext">'+esc(card.example||card.context||'这张词卡未保留原句。')+'</p>'+button('source','回到原书 ↗','review-btn quiet')+'</div>'+(card.note?'<div class="review-note"><small>我的笔记</small><p>'+esc(card.note)+'</p></div>':'')+'<div class="review-rating-intro">'+(wrong?'这次还没有独立回忆出来，先选择「忘记了」进行巩固。':practice?'本轮只记录练习感受，不改变正式复习计划。':'按真实回忆选择，下次复习时间会随之调整。')+'</div><div class="review-ratings" id="quality">'+['again','hard','good','easy'].map((rating,index)=>'<button type="button" data-review-rating="'+rating+'" data-q="'+rating+'" class="'+rating+'" '+(wrong&&rating!=='again'?'disabled':'')+'><kbd>'+(index+1)+'</kbd><b>'+ratingNames[rating]+'</b><small>'+(practice?'仅记录本轮感受':intervalLabel(card,rating)+'后')+'</small></button>').join('')+'</div></section>';
  }
  function reveal(forgot=false){
    if(screen!=='study'||shown)return;
    const card=sessionCard();if(!card)return;
    if(effectiveMode(card)!=='recognize'&&!forgot){
      typed=root.querySelector('#reviewTyping')?.value||typed;
      if(!typed.trim()){error='先输入一个答案，或选择「想不起来」。';const alert=root.querySelector('.review-error');if(alert){alert.hidden=false;alert.textContent=error;}return;}
      checked=isCorrectAnswer(typed,card.term);
    }else if(forgot)checked=false;
    shown=true;error='';renderCard();
  }
  function grade(rating){
    if(!shown||screen!=='study'||saving||!['again','hard','good','easy'].includes(rating)||(checked===false&&rating!=='again'))return;
    saving=true;
    try{
      const state=read(),card=(state.cards||[]).find(item=>item.id===currentId);
      if(session.library!==library()||!card||stamp(card)!==fingerprint){notice='词卡或学习进度已在别处更新，本次未评价其他词卡。请重新回忆当前内容。';undo=null;next();return;}
      error='';const beforeSession=copy(session),before={review:copy(card.review),due:card.due,nextReview:card.nextReview};
      const eventId=id(),at=Date.now();
      if(!session.options.practice){
        card.review=scheduleRating(card,rating,at,eventId);card.due=false;card.nextReview=card.review.intervalDays;
        state.reviewed=(Number(state.reviewed)||0)+1;
        if(!writeState(state)){renderCard();return;}
      }
      undo={cardId:currentId,before,after:eventId,session:beforeSession,practice:session.options.practice,library:library()};
      session.queue=session.queue.filter(cardId=>cardId!==currentId);
      session.results.push({cardId:currentId,rating,at,spelling:checked});
      if(!session.options.practice&&card.review.state==='learning')session.waiting.push({id:currentId,at:Date.parse(card.review.dueAt)});
      saveSession();emit();notice='';next();
    }finally{saving=false;}
  }
  function undoLast(){
    if(!undo)return;
    const state=read(),card=(state.cards||[]).find(item=>item.id===undo.cardId);
    if(undo.library!==library()||!card||(!undo.practice&&card.review?.lastEventId!==undo.after)){error='词卡已在别处变更，不能覆盖新进度。';undo=null;refresh();return;}
    if(!undo.practice){
      if(undo.before.review===undefined)delete card.review;else card.review=undo.before.review;
      if(undo.before.due===undefined)delete card.due;else card.due=undo.before.due;
      if(undo.before.nextReview===undefined)delete card.nextReview;else card.nextReview=undo.before.nextReview;
      if(!writeState(state)){refresh();return;}
    }
    session=undo.session;undo=null;saveSession();emit();notice='已撤销上次评价；笔记和释义没有回退。';next();
  }
  function renderEnd(){
    cancelSpeech();const state=read(),{stats}=snapshot(state),first=new Map();for(const result of session.results)if(!first.has(result.cardId))first.set(result.cardId,result);
    const total=first.size,remembered=[...first.values()].filter(result=>result.rating!=='again').length,waiting=session.waiting.length;
    const nextAt=waiting?Math.min(...session.waiting.map(item=>item.at)):null;
    root.innerHTML=header(state,stats)+'<article class="review-paper review-complete"><div class="review-complete-icon">'+(waiting?'◷':'✓')+'</div><div class="eyebrow">'+(waiting?'LET IT SETTLE':'A LITTLE, EVERY DAY')+'</div><h2>'+(waiting?'这一轮先到这里，让记忆沉淀一下。':'完成这一小轮，做得很扎实。')+'</h2><p>'+(waiting?'还有 '+waiting+' 张进入短时巩固，最早可在 '+esc(when(nextAt))+' 继续。未到时间不会假装它们已经到期。':'已经评价的词卡各自保存了进度。未到期的内容，不会强制从头重复。')+'</p><div class="review-summary-numbers"><div><b>'+total+'</b><span>张已回忆</span></div><div><b>'+remembered+' / '+total+'</b><span>首轮自评记住</span></div><div><b>'+session.skipped.length+'</b><span>本轮跳过</span></div></div><div class="review-home-actions">'+button('home','返回学习计划','review-btn primary')+(waiting?button('check-wait','检查巩固队列','review-btn'):button('start','再开始一轮','review-btn'))+button('undo','↶ 撤销上次评价','review-btn quiet',!undo?'disabled':'')+'</div><p class="review-micro">'+(session.options.practice?'本轮是随心练习，未改变到期日或正式复习记录。':'“自评记住”基于你的首次评价，不等同于客观记忆准确率。')+'</p></article>';
  }
  function updateDashboard(){
    const cards=materialCards(read()),budget=Math.max(0,Number(options?.newPerDay??10)-dailyStats(cards).introduced);
    const available=cards.filter(card=>{const r=scheduleOf(card);return !r.suspended&&meaningOf(card)&&(r.state==='new'||Date.parse(r.dueAt)<=Date.now());});
    const due=available.filter(card=>scheduleOf(card).state!=='new'),fresh=available.filter(card=>scheduleOf(card).state==='new').slice(0,budget),list=[...due,...fresh];
    const count=document.querySelector('#reviewCount');if(count)count.textContent=String(list.length);
    const chips=document.querySelector('#dashboard .brief .chips');if(chips)chips.innerHTML=['word','phrase','sentence'].map(kind=>'<span class="chip">'+typeNames[kind]+' '+list.filter(card=>card.type===kind).length+'</span>').join('');
  }
  function navigate(view){document.querySelector('.nav [data-view="'+view+'"]')?.click();}
  function refresh(){
    if(session&&session.library!==library()){session=null;undo=null;notice='学习空间已切换，本轮已暂停。';renderHome();return;}
    if(screen==='home')renderHome();
    else if(screen==='study'){
      const card=(read().cards||[]).find(item=>item.id===currentId);
      if(!card||stamp(card)!==fingerprint){notice='当前词卡的复习进度已更新，已重新核对队列。';next();}
      else if(materialStamp(sessionCard())!==materialSignature)renderCard();
    }else renderEnd();
  }
  function speak(){
    const card=sessionCard();if(!card||!window.speechSynthesis||!window.SpeechSynthesisUtterance)return;
    if(effectiveMode(card)!=='recognize'&&!shown)return;
    cancelSpeech();const speech=new window.SpeechSynthesisUtterance(card.term);speech.lang='en-US';speech.rate=.88;
    const voice=window.speechSynthesis.getVoices().find(item=>/^en[-_]/i.test(item.lang));if(voice)speech.voice=voice;
    speech.onerror=()=>{notice='系统朗读暂不可用，可继续学习音标和原文。';refresh();};window.speechSynthesis.speak(speech);
  }
  root.addEventListener('click',event=>{
    const mode=event.target.closest('[data-review-mode]');if(mode){options.mode=mode.dataset.reviewMode;saveOptions();renderHome();return;}
    const gradeButton=event.target.closest('[data-review-rating]');if(gradeButton){grade(gradeButton.dataset.reviewRating);return;}
    const target=event.target.closest('[data-review-action]');if(!target||target.disabled)return;
    const action=target.dataset.reviewAction;
    if(action==='start')start();else if(action==='practice')start(true);else if(action==='resume'){notice='';error='';next();}
    else if(action==='home'){saveSession();renderHome();}else if(action==='reveal')reveal();else if(action==='forgot')reveal(true);
    else if(action==='hint'){contextHint=true;renderCard();}else if(action==='undo')undoLast();else if(action==='speak')speak();
    else if(action==='knowledge')navigate('knowledge');else if(action==='source'){cancelSpeech();window.dispatchEvent(new CustomEvent('scribe-open-card',{detail:{cardId:currentId}}));}
    else if(action==='skip'){session.skipped.push(currentId);session.queue=session.queue.filter(cardId=>cardId!==currentId);saveSession();next();}
    else if(action==='suspend'||action==='restore'){
      const state=read(),card=(state.cards||[]).find(item=>item.id===(action==='restore'?target.dataset.restoreId:currentId));
      if(!card)return;card.review={...scheduleOf(card),suspended:action==='suspend'};
      if(writeState(state)){emit();notice=action==='suspend'?'已暂停此卡，可在学习计划下方随时恢复。':'词卡已恢复复习。';if(action==='suspend'){session.queue=session.queue.filter(item=>item!==card.id);saveSession();next();}else renderHome();}else refresh();
    }else if(action==='check-wait')next();else if(action==='theme'){const enabled=root.classList.toggle('review-dark');try{localStorage.setItem('scribe-review-theme',enabled?'dark':'light');}catch{}target.textContent=enabled?'☀ 日间':'☾ 夜间';target.setAttribute('aria-pressed',String(enabled));}
  });
  function saveOptions(){const state=read();state.settings={...state.settings,review:{...options}};if(writeState(state))emit();}
  root.addEventListener('change',event=>{const select=event.target.closest('[data-review-option]');if(!select)return;const name=select.dataset.reviewOption;options[name]=['size','newPerDay'].includes(name)?Number(select.value):select.value;saveOptions();renderHome();});
  root.addEventListener('input',event=>{if(event.target.id==='reviewTyping')typed=event.target.value;});
  root.addEventListener('submit',event=>{if(event.target.matches('[data-review-form]')){event.preventDefault();reveal();}});
  document.addEventListener('keydown',event=>{
    if(!active()||event.repeat||document.querySelector('.modal.show,dialog[open]')||event.target.closest?.('input,textarea,select,[contenteditable="true"]'))return;
    if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='z'){event.preventDefault();undoLast();return;}
    if(event.ctrlKey||event.metaKey||event.altKey)return;
    if(event.code==='Space'&&screen==='study'&&!shown&&effectiveMode(sessionCard())==='recognize'){event.preventDefault();reveal();}
    else if(shown&&/^[1-4]$/.test(event.key)){event.preventDefault();grade(['again','hard','good','easy'][Number(event.key)-1]);}
  });
  window.addEventListener('scribe-review-refresh',()=>{if(active())refresh();});
  window.addEventListener('scribe-cloud-updated',()=>{updateDashboard();if(active())refresh();});
  window.addEventListener('scribe-storage-pressure',()=>{error='本机数据库落盘异常，部分进度可能仍只在内存中。离开前请导出备份或确认云同步完成。';const alert=root.querySelector('.review-error');if(alert){alert.hidden=false;alert.textContent=error;}});
  window.addEventListener('storage',event=>{if([STATE,'scribe-library-key'].includes(event.key)&&active())refresh();});
  window.addEventListener('pagehide',()=>{saveSession();cancelSpeech();});
  document.addEventListener('visibilitychange',()=>{if(document.hidden){saveSession();cancelSpeech();}else if(active())refresh();});
  if(window.MutationObserver)new MutationObserver(()=>{if(!active())cancelSpeech();}).observe(root,{attributes:true,attributeFilter:['class']});
  setInterval(()=>{if(!active())return;if(screen==='waiting'&&session.waiting.some(item=>item.at<=Date.now()))next();else if(screen==='study')refresh();},15_000);
  hydrate();try{root.classList.toggle('review-dark',localStorage.getItem('scribe-review-theme')==='dark');}catch{}
  renderHome();
  window.__scribeReview={refresh,start:()=>start(),updateDashboard,getSession:()=>session?copy(session):null};
  updateDashboard();
}

import {requireAccount,escapeAccount as esc} from './account-access.js';

export async function installAccountConsole(cloud){
  document.title='Scribe · 账号管理控制台';
  const user=await requireAccount(cloud,{ownerOnly:true});
  const old=document.getElementById('accountGate');if(old)old.remove();
  const root=document.createElement('main');root.id='accountConsole';root.className='account-console';
  root.innerHTML=`<header><a class="account-brand" href="/">S<span>Scribe<small>ACCOUNT CONSOLE</small></span></a><div><a class="account-link" href="/">进入学习空间</a> <button class="account-secondary" id="consoleLogout">退出控制台</button></div></header><h1>账号与访问权限</h1><p class="account-muted">${esc(user.displayName||user.username)} · 最高管理员。由你创建账号，网站不开放自行注册。</p><div class="account-summary" id="accountSummary"></div><div id="consoleStatus" class="account-status" role="status" aria-live="polite"></div><section id="accountCredentials" class="account-credentials" hidden></section><div class="account-console-grid"><section class="account-panel"><h2>创建可用账号</h2><p class="account-admin-note">每个账号分配独立书库。密码只在创建或重置成功后显示一次。</p><form id="createAccountForm"><label for="newUsername">账号</label><input id="newUsername" required pattern="[a-zA-Z0-9][a-zA-Z0-9_.-]{2,31}" minlength="3" maxlength="32" autocomplete="off" placeholder="例如 reader001"><label for="newDisplayName">显示名称</label><input id="newDisplayName" maxlength="80" autocomplete="off" placeholder="用于学习界面显示"><label for="newPassword">密码（留空自动生成）</label><input id="newPassword" type="password" minlength="12" maxlength="72" autocomplete="new-password" placeholder="系统可生成强随机密码"><label class="account-check"><input id="bindLegacyLibrary" type="checkbox">绑定已有旧版云端书库</label><div id="legacyLibraryField" hidden><label for="legacyLibraryKey">旧书库同步码</label><input id="legacyLibraryKey" type="password" autocomplete="off" maxlength="64"><p class="account-admin-note">仅用于首次迁移，不能重复分配。原文献、卡片和进度原地保留。</p></div><button class="account-primary" id="createAccount" type="submit" style="margin-top:20px;width:100%">创建账号并生成凭据</button></form></section><section class="account-panel"><h2>用户账号</h2><label for="filterAccounts">搜索账号或名称</label><input id="filterAccounts" type="search" placeholder="输入账号或名称"><div id="accountRows"></div><button class="account-secondary" id="reloadAccounts">刷新列表</button><section class="account-audit"><h2>最近管理操作</h2><ul id="accountAudit"></ul></section></section></div>`;
  document.body.append(root);
  const $=id=>root.querySelector('#'+id),call=(action,body={})=>cloud.callFunction('scribe-accounts',{action,...body});
  let accounts=[],busy=false,credentials=null;
  const say=(text,error=false)=>{$('consoleStatus').textContent=text;$('consoleStatus').dataset.error=String(error);};
  function showCredentials(value){
    credentials=value;const box=$('accountCredentials');box.hidden=!value;box.replaceChildren();if(!value)return;
    box.innerHTML='<b>请立即保存并安全交付给对应用户</b><p>关闭此提示后无法查看原密码；如遗失，请重新重置。</p><code></code><button class="account-secondary" id="copyAccountCredentials">复制账号与密码</button> <button class="account-secondary" id="dismissCredentials">我已保存，关闭</button>';
    box.querySelector('code').textContent='账号：'+value.username+'\n密码：'+value.password;
    $('copyAccountCredentials').onclick=async()=>{try{await navigator.clipboard.writeText('账号：'+credentials.username+'\n密码：'+credentials.password);say('已复制，请通过安全渠道发送给对应用户。');}catch{say('无法自动复制，请选中上方凭据手动复制。',true);}};
    $('dismissCredentials').onclick=()=>showCredentials(null);
  }
  function paint(){
    const needle=$('filterAccounts').value.trim().toLowerCase(),rows=accounts.filter(a=>(a.username+' '+a.displayName).toLowerCase().includes(needle));
    $('accountSummary').innerHTML='<span><b>'+accounts.length+'</b>总账号</span><span><b>'+accounts.filter(a=>!a.disabled).length+'</b>可使用</span><span><b>'+accounts.filter(a=>a.disabled).length+'</b>已停用</span>';
    $('accountRows').innerHTML=rows.length?rows.map(a=>'<article class="account-account-row"><div><h3>'+esc(a.displayName||a.username)+'</h3><p>'+esc(a.username)+' · '+(a.role==='owner'?'最高管理员':a.disabled?'已停用':'正常使用')+'</p><p>最近登录：'+esc(a.lastLoginAt?new Date(a.lastLoginAt).toLocaleString('zh-CN'):'尚未登录')+'</p></div><div class="account-row-actions">'+(a.role==='owner'?'<span class="account-badge">最高权限</span>':'<button class="account-secondary" data-account-action="resetPassword" data-id="'+esc(a.id)+'">重置密码</button><button class="account-secondary" data-account-action="'+(a.disabled?'enable':'disable')+'" data-id="'+esc(a.id)+'">'+(a.disabled?'启用账号':'停用账号')+'</button>')+'</div></article>').join(''):'<p class="account-muted">没有匹配的账号。</p>';
    root.querySelectorAll('[data-account-action]').forEach(button=>button.onclick=async()=>{
      if(busy)return;const action=button.dataset.accountAction,target=accounts.find(a=>a.id===button.dataset.id);
      if(!confirm((action==='resetPassword'?'重置后旧密码和旧会话立即失效。':action==='disable'?'停用后该用户及其手机上传通道将无法继续使用；数据保留。':'启用后用户需重新登录。')+'确定对「'+target.username+'」执行吗？'))return;
      busy=true;button.disabled=true;say('正在处理…');
      try{const result=await call(action,{id:target.id});showCredentials(result.credentials||null);await load();say(action==='resetPassword'?'新密码已生成，请保存后交付用户。':'账号状态已更新。');}catch(error){say(error.message,true);}finally{busy=false;button.disabled=false;}
    });
  }
  async function load(){const result=await call('list');accounts=result.accounts||[];paint();const audit=await call('audit');const labels={bootstrap_owner:'初始化管理员',create_account:'创建账号',disable:'停用账号',enable:'启用账号',reset_password:'重置密码'};
    $('accountAudit').innerHTML=(audit.events||[]).map(e=>'<li>'+esc(new Date(e.created_at).toLocaleString('zh-CN'))+' · '+esc(labels[e.action]||e.action)+' · '+esc(accounts.find(a=>a.id===e.target_id)?.username||'账号')+'</li>').join('')||'<li>暂无操作记录</li>';
  }
  $('filterAccounts').oninput=paint;$('reloadAccounts').onclick=()=>load().catch(error=>say(error.message,true));
  $('bindLegacyLibrary').onchange=()=>{$('legacyLibraryField').hidden=!$('bindLegacyLibrary').checked;$('legacyLibraryKey').required=$('bindLegacyLibrary').checked;};
  $('createAccountForm').onsubmit=async event=>{
    event.preventDefault();if(busy)return;busy=true;$('createAccount').disabled=true;showCredentials(null);say('正在创建独立账号与书库…');
    try{const result=await call('create',{username:$('newUsername').value,displayName:$('newDisplayName').value,password:$('newPassword').value||undefined,...($('bindLegacyLibrary').checked?{legacyLibraryKey:$('legacyLibraryKey').value}:{})});
      $('createAccountForm').reset();$('legacyLibraryField').hidden=true;showCredentials(result.credentials);await load();say('账号已可用于登录。');
    }catch(error){say(error.message,true);}finally{busy=false;$('createAccount').disabled=false;}
  };
  $('consoleLogout').onclick=async()=>{showCredentials(null);await cloud.account.logout().catch(()=>{});location.reload();};
  window.addEventListener('scribe-account-expired',()=>{showCredentials(null);cloud.account.clear();location.reload();},{once:true});
  try{await load();}catch(error){say(error.message,true);}
  return {reload:load};
}

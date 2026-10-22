import './accounts.css';
export const escapeAccount=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));

// Mounts before the legacy reading scripts are allowed to run. Hiding a page alone
// is not authentication: all cloud endpoints independently verify a live session.
export async function requireAccount(cloud,{ownerOnly=false}={}){
  document.documentElement.classList.add('scribe-auth-locked');
  document.documentElement.classList.remove('alt-route','scribe-booting');
  let profile=null;
  try{profile=await cloud.account.me();}catch(error){if(error.status!==401)console.warn('[scribe] 账号连接暂不可用');cloud.account.clear();}
  if(profile){
    if(!ownerOnly||profile.role==='owner')return profile;
    return denied(cloud);
  }
  const host=document.createElement('main');host.id='accountGate';host.className='account-login';
  host.innerHTML=`<section class="account-intro"><a class="account-brand" href="/">S<span>Scribe<small>DEEP READING</small></span></a><div><p class="account-eyebrow">阅读，积累，再次相遇</p><h1>${ownerOnly?'掌握每一份学习空间。':'回到你的阅读世界。'}</h1><p>文献、生词与每一次记忆，<br>都在属于你的空间里继续生长。</p></div><small>独立书库 · 私密文献 · 跨设备学习</small></section><section class="account-form-panel"><div class="account-form-wrap"><span class="account-badge">${ownerOnly?'管理员控制台':'专属学习空间'}</span><h2>${ownerOnly?'管理员登录':'欢迎回来'}</h2><p class="account-muted">${ownerOnly?'使用最高管理员账号管理用户和访问权限。':'请使用管理员提供的账号与密码登录。'}</p><form id="accountLoginForm"><label for="accountUsername">账号</label><input id="accountUsername" name="username" autocomplete="username" required minlength="3" maxlength="32" spellcheck="false" autocapitalize="none" placeholder="请输入账号"><label for="accountPassword">密码</label><div class="account-password"><input id="accountPassword" name="password" type="password" autocomplete="current-password" required maxlength="72" placeholder="请输入密码"><button type="button" id="accountShowPassword" aria-label="显示密码">显示</button></div><p id="accountLoginMessage" role="status" aria-live="polite"></p><button class="account-primary" type="submit" id="accountLoginSubmit">${ownerOnly?'登录控制台':'登录，继续学习'}</button></form><div class="account-help"><b>暂不开放自行注册</b><p>没有账号或忘记密码？请联系管理员创建账号或重置密码。</p></div><a class="account-link" href="${ownerOnly?'/':'/?admin=1'}">${ownerOnly?'返回用户登录':'管理员控制台 →'}</a></div></section>`;
  document.body.append(host);
  const input=host.querySelector('#accountPassword'),show=host.querySelector('#accountShowPassword');
  show.onclick=()=>{const visible=input.type==='password';input.type=visible?'text':'password';show.textContent=visible?'隐藏':'显示';show.setAttribute('aria-label',visible?'隐藏密码':'显示密码');};
  return new Promise(resolve=>{
    host.querySelector('form').onsubmit=async event=>{
      event.preventDefault();const submit=host.querySelector('#accountLoginSubmit'),message=host.querySelector('#accountLoginMessage');
      if(submit.disabled)return;submit.disabled=true;submit.textContent='正在安全登录…';message.textContent='';
      try{
        const user=await cloud.account.login(host.querySelector('#accountUsername').value,input.value);input.value='';
        if(ownerOnly&&user.role!=='owner'){await cloud.account.logout();message.textContent='此账号没有控制台权限，请使用最高管理员账号。';return;}
        host.remove();resolve(user);
      }catch(error){message.textContent=error.message||'登录失败，请重试。';}
      finally{submit.disabled=false;submit.textContent=ownerOnly?'登录控制台':'登录，继续学习';}
    };
  });
}
function denied(cloud){
  const host=document.createElement('main');host.id='accountGate';host.className='account-denied';
  host.innerHTML='<h1>此账号没有控制台权限</h1><p>请使用最高管理员账号登录。</p><a href="/">返回学习空间</a><button class="account-primary">退出并更换账号</button>';
  host.querySelector('button').onclick=async()=>{await cloud.account.logout().catch(()=>{});location.reload();};document.body.append(host);
  return new Promise(()=>{});
}
export function installAccountMenu(cloud,user){
  document.documentElement.classList.remove('scribe-auth-locked');
  const button=document.createElement('button');button.type='button';button.className='account-session';button.id='accountLogout';
  button.textContent=(user.displayName||user.username)+' · 退出登录';
  button.onclick=async()=>{button.disabled=true;await window.__scribeVault?.flush();await cloud.account.logout().catch(()=>{});location.reload();};
  document.querySelector('.topbar')?.append(button);
  document.querySelector('[data-channel="local"]')?.remove();
  const greeting=document.querySelector('#dashboard h1');if(greeting)greeting.textContent='欢迎回来，'+(user.displayName||user.username)+'。';
  if(user.role==='owner'){
    const link=document.createElement('a');link.href='/?admin=1';link.className='account-session';link.textContent='管理控制台';document.querySelector('.topbar')?.append(link);
    const exportOld=document.createElement('button');exportOld.className='button secondary';exportOld.textContent='导出本机旧版学习数据（保留原件）';
    exportOld.onclick=async()=>{const state=await window.__scribeVault?.legacyData();if(!state){alert('没有找到本机旧版数据。');return;}const url=URL.createObjectURL(new Blob([JSON.stringify(state,null,2)],{type:'application/json'})),a=document.createElement('a');a.href=url;a.download='scribe-legacy-learning-backup.json';a.click();URL.revokeObjectURL(url);};
    document.querySelector('#settings .settings-grid')?.append(exportOld);
  }
  window.addEventListener('scribe-account-expired',()=>{cloud.account.clear();document.documentElement.classList.add('scribe-auth-locked');location.reload();},{once:true});
  // Regular revalidation also locks an idle page after disable/reset, not just on its next upload.
  setInterval(()=>{if(!document.hidden)cloud.account.me().catch(error=>{if(error.status===401)window.dispatchEvent(new Event('scribe-account-expired'));});},60000);
}

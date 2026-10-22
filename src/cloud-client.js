// 云端调用封装：学生端（index.html）与管理后台（admin.html）共用同一份实现。
// 只读取框架生成的 src/integrations/supabase/client.ts，不修改它。
import { supabase } from "./integrations/supabase/client";
import QRCode from "qrcode";

async function callFunction(name, body) {
  body={...body};
  const token=sessionStorage.getItem('scribe-account-token')||'';
  if(name==='scribe-accounts'){if(body.action!=='login')body.token=token;}
  else if(token)body.libraryKey=token; // Never trust a caller-supplied account/library identity.
  else if(!(name==='scribe-mobile-upload'&&body.token)){
    throw Object.assign(new Error('请先使用管理员提供的账号密码登录。'),{status:401});
  }
  const { data, error } = await supabase.functions.invoke(name, { body, timeout: name==='scribe-study'?90000:45000 });
  if (error) {
    let message = error.message || "云端请求失败，请重试。";
    let status = 0;
    const context = error.context;
    if (context && typeof context.json === "function") {
      status = context.status || 0;
      try {
        const payload = await context.clone().json();
        if (payload && payload.error) message = payload.error;
      } catch {
        // 保留默认信息
      }
    }
    const failure = new Error(message);
    failure.status = status;
    if(token&&status===401&&!(name==='scribe-accounts'&&body.action==='login'))window.dispatchEvent(new Event('scribe-account-expired'));
    if(name==='scribe-accounts'&&[404,503].includes(status))failure.message='账号服务尚未就绪，请管理员先部署账号迁移和 scribe-accounts 云函数。';
    throw failure;
  }
  if (data && data.error) throw new Error(data.error);
  return data;
}

async function qrDataUrl(text) {
  return await QRCode.toDataURL(text, {
    width: 300,
    margin: 1,
    errorCorrectionLevel: "M",
    color: { dark: "#17243e", light: "#ffffffff" },
  });
}

export function createCloud() {
  let profile=null;
  const account={
    token:()=>sessionStorage.getItem('scribe-account-token')||'',user:()=>profile,
    async login(username,password){
      if(location.protocol!=='https:'&&!['localhost','127.0.0.1','[::1]'].includes(location.hostname))throw new Error('请使用 HTTPS 安全地址登录，避免账号密码在网络中明文传输。');
      const result=await callFunction('scribe-accounts',{action:'login',username,password});
      if(!/^[a-f0-9]{64}$/.test(result.token||'')||!result.user?.id)throw new Error('登录响应无效，请联系管理员。');
      sessionStorage.setItem('scribe-account-token',result.token);profile=result.user;return profile;},
    async me(){if(!account.token())return null;const result=await callFunction('scribe-accounts',{action:'me'});profile=result.user;return profile;},
    async logout(){try{if(account.token())await callFunction('scribe-accounts',{action:'logout'});}finally{sessionStorage.removeItem('scribe-account-token');profile=null;}},
    clear(){sessionStorage.removeItem('scribe-account-token');profile=null;}
  };
  return { callFunction, qrDataUrl,account };
}

// 把 Enter 云客户端与二维码生成器挂到 window，供页面里原有的经典脚本使用。
// 页面里的 src/integrations/supabase/client.ts 由框架生成，这里只读取、不修改。
import { supabase } from "./integrations/supabase/client";
import QRCode from "qrcode";
import {installLibrary} from "./cloud-library.js";

async function callFunction(name, body) {
  const { data, error } = await supabase.functions.invoke(name, { body });
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

window.__scribeCloud = { callFunction, qrDataUrl };
if(document.querySelector('#settings')) installLibrary(window.__scribeCloud);
window.dispatchEvent(new Event("scribe-cloud-ready"));

// 云端调用封装：学生端（index.html）与管理后台（admin.html）共用同一份实现。
// 只读取框架生成的 src/integrations/supabase/client.ts，不修改它。
import { supabase } from "./integrations/supabase/client";
import QRCode from "qrcode";

async function callFunction(name, body) {
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
  return { callFunction, qrDataUrl };
}

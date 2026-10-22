// 主入口装配：按地址栏路由决定挂载哪一屏。
// 正式站只发布主入口（/），/admin.html 这类子页面在正式域名上取不到，
// 所以管理后台同时提供 /?admin=1 这条主入口路由。
import {createCloud} from "./cloud-client.js";
import {installLibrary} from "./cloud-library.js";
import {requireAccount,installAccountMenu} from './account-access.js';
import * as uploadEngine from './upload-engine.js';
import * as uploadStore from './upload-store.js';
import {installOriginalDownload} from './original-download.js';
import {installReview} from './review-ui.js';
import './review.css';

const route = new URLSearchParams(location.search);
const cloud = createCloud();

if (route.get('admin') === '1') {
  document.documentElement.classList.add('alt-route');
  import("./account-console.js").then(({installAccountConsole}) => installAccountConsole(cloud));
} else {
  // 电脑上传队列（public/import-queue.js，普通脚本）通过这里按需加载 PDF 拆页模块。
  window.__scribeExplodePdf = (file, onProgress, onPage) => import("./pdf-pages.js").then(({explodePdf}) => explodePdf(file, onProgress, onPage));
  window.__scribeUploads = {...uploadEngine, ...uploadStore};
  // 等本机数据保险库（public/storage-vault.js）把 IndexedDB 读进内存、页面脚本跑完，再接管同步；
  // 没有保险库的环境（测试、旧页面）直接启动。
  const start = (user) => {
    window.__scribeCloud = cloud;
    installReview();
    if (document.querySelector('#settings')) installLibrary(cloud);
    installOriginalDownload(cloud);
    installAccountMenu(cloud,user);
    window.dispatchEvent(new Event("scribe-cloud-ready"));
  };
  requireAccount(cloud).then(async user=>{
    // Do not execute reading/upload scripts against a previous account's cache.
    await window.__scribeVault?.activateAccount(user.id);
    window.__scribeAccessUnlock?.();
    await window.__scribeBoot;
    start(user);
  }).catch(error=>{
    const host=document.getElementById('accountGate')||document.body.appendChild(Object.assign(document.createElement('main'),{id:'accountGate',className:'account-denied'}));
    host.textContent='工作区暂未打开：'+error.message+'。请刷新重试；原数据未删除。';
  });
}

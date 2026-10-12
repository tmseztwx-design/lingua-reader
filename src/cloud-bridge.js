// 主入口装配：按地址栏路由决定挂载哪一屏。
// 正式站只发布主入口（/），/admin.html 这类子页面在正式域名上取不到，
// 所以管理后台同时提供 /?admin=1 这条主入口路由。
import {createCloud} from "./cloud-client.js";
import {installLibrary} from "./cloud-library.js";
import {installBeta} from "./beta-access.js";

const route = new URLSearchParams(location.search);
const cloud = createCloud();

if (route.get('admin') === '1') {
  document.documentElement.classList.add('alt-route');
  import("./admin-page.js").then(({installAdminPage}) => installAdminPage(cloud));
} else {
  // 等本机数据保险库（public/storage-vault.js）把 IndexedDB 读进内存、页面脚本跑完，再接管同步；
  // 没有保险库的环境（测试、旧页面）直接启动。
  const start = () => {
    window.__scribeCloud = cloud;
    if (document.querySelector('#settings')) installBeta(cloud);
    if (document.querySelector('#settings')) installLibrary(cloud);
    window.dispatchEvent(new Event("scribe-cloud-ready"));
  };
  Promise.resolve(window.__scribeBoot).catch(() => {}).then(start);
}

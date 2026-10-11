// 学生端桥接：把云端客户端挂到 window，并装配内测登录与书库同步。
import {createCloud} from "./cloud-client.js";
import {installLibrary} from "./cloud-library.js";
import {installBeta} from "./beta-access.js";

window.__scribeCloud = createCloud();
if(document.querySelector('#settings')) installBeta(window.__scribeCloud);
if(document.querySelector('#settings')) installLibrary(window.__scribeCloud);
window.dispatchEvent(new Event("scribe-cloud-ready"));

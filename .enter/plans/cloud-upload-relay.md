# 云端上传 + 云端识别：不依赖任何人的电脑，也不依赖同一 Wi‑Fi

## Context（为什么这样改）

原方案里识别跑在用户自己的 Mac 上，这对「给别人用」是硬伤：

- 别人未必是 macOS，未必装了本机服务；
- 如果识别集中在你的电脑上，**你的电脑一关，所有用户都用不了**；
- 手机上传还要和电脑同一 Wi‑Fi，本身就是最大的使用门槛。

所以改成：**上传和识别都在 Enter 云上完成**。手机在任何网络下拍照上传 → 云上用 GPT 视觉模型逐页识别 → 任何设备打开应用都能直接读到识别结果，不需要电脑开着，也不需要本机服务。

保留的边界：

- **局域网通道保留**：想做离线/本机识别（macOS Vision，`ocr.swift`）的用户仍可切换回原通道，行为与现在一致。
- **云端原页长期保留**（用户选择），提供手动删除作为存储安全阀。
- **费用归属必须说清楚**：云识别消耗的是**这个项目的 AI 额度**（属于你），别人用得越多、你付得越多。因此会加一个每批页数上限，并在界面上标明识别用量。

## 架构

```
手机（任意网络）--HTTPS--> Enter 云 私有桶 scribe-pages + 两张表
                                  |
                                  +-- 后端函数 scribe-ocr（GPT 视觉模型逐页识别）--> 文本写入数据库
                                  |
任意设备打开应用 <----------------+  轮询状态 → 取回文本 → 生成精读页（不再需要本机服务）
```

局域网通道保持不变：手机 → 本机 `server.mjs` → `ocr.swift` 本机识别。

### 云端数据与存储

- 新表 `public.scribe_cloud_sessions`：`id`、`token`(唯一)、`created_at`、`expires_at`、`completed_at`、`file_count`、`ocr_status`(pending/processing/complete/partial)、`ocr_completed_at`、`title`。
- 新表 `public.scribe_cloud_files`：`id`、`session_id`(外键级联)、`queue_order`、`name`、`size`、`mime`、`storage_path`、`uploaded_at`、`ocr_status`、`ocr_text`、`ocr_error`、`ocr_completed_at`、`page_count`。
- 两张表**启用 RLS 且不添加任何面向客户端的策略**（默认拒绝）。浏览器不直接读写数据库，全部经后端函数（服务角色）+ token 校验，避免越权枚举别人的批次。
- 私有桶 `scribe-pages`：`file_size_limit = 100MB`，允许 `pdf/doc/docx/jpg/jpeg/png/heic/heif/txt`。客户端不直接访问桶：上传用函数签发的 signed upload URL，查看原页用函数签发长有效期 signed download URL。
- 对象路径：`<session_id>/<order>-<file_id><ext>`。

### 后端函数

**1. `scribe-mobile-upload`**（`verify_jwt = false`，token 校验，完整 CORS + OPTIONS）

| action | 用途 |
|---|---|
| `create` | 生成 32 位随机 token + 24 小时上传窗口；限制同时未过期会话数，防滥用 |
| `status` | 会话状态 + 文件清单（含每页识别状态；手机看进度、应用轮询都用它） |
| `sign` / `register` | 逐张签发上传地址 / 上传成功后回写大小与类型（保持手机端顺序队列语义） |
| `complete` | 标记整批上传完成 |
| `remove` | 手动删除该批（数据库行 + 桶内对象） |
| `pageUrl` | 为原页签发长有效期查看地址（供精读页显示原文图） |

**2. `scribe-ocr`**（`verify_jwt = false`，token 校验）

- 每次调用只处理**一个文件**（`fileId`），避免函数超时；由前端按顺序循环调用，页与页之间互不影响，失败可单页重试。
- 图片（`jpg/jpeg/png`）：读取桶内对象 → 签发短期 signed URL（或小图回退 base64）→ 调用 AI 模型的**图片输入**做逐页原文转录，提示词限定"只转录原文、保留段落，不翻译、不总结、不臆造"，返回纯文本。
- 数字版 PDF：提取文本层；文档（`doc/docx`）：mammoth 提取。抽取库走 `esm.sh`。
- **扫描版 PDF 与 HEIC 属于已知边界**：无法在函数内可靠转图时，返回明确提示（改用手机拍照上传 / 转成 JPEG），不做静默失败。iPhone 用系统相机在网页上传时通常会被 Safari 自动转成 JPEG。
- 单批页数上限（默认 ≤ 60 页）用于控制 AI 用量；超出时提示分批。

## 前端改动

### `index.html`（桌面/任意设备的应用）

- 「导入文献」面板新增通道切换：**云端识别（任意网络）** / **本机识别（同一 Wi‑Fi）**，选择记入 `state.settings`，默认云通道。
- 云通道：
  - 调用 `create` 出码，二维码内容 `${location.origin}/mobile.html?t=<token>`，用已在依赖里的 `qrcode` **前端**生成（不再依赖本机服务出码）。
  - 轮询 `status`：显示「已收到 N 页」→ 上传完成后自动逐页调用 `scribe-ocr` 并显示识别进度（第 x / N 页）。
  - 识别完成后把文本按现有 `saveDocument` 的 `sourcePages` 结构写进书库（`text`、`order`、`url` 用 `pageUrl` 签发的地址），直接进入精读区——**全程不需要本机服务**。
  - 「云端批次」列表：本地记住创建过的 token，显示 `等待上传 / 已收到 N 页 / 识别中 / 已完成 / 部分失败`，可重新识别失败页、可删除云端副本。
- 本机通道：完全保留现有行为（手机/电脑 → `server.mjs` → `ocr.swift`）。
- 界面明确标注：云端识别消耗项目 AI 额度。

### `mobile.html`（手机页）

- 从 `public/mobile.html` **移到项目根目录**，作为 Vite 第二个构建入口（`vite.config.ts` 增加 `build.rollupOptions.input`），产物仍是 `dist/mobile.html`，`server.mjs` 的 `/mobile/<token>` 路由不变。
- 现有手机端脚本（队列、排序、逐张进度、微信提示）整体搬到新模块 `src/mobile-upload.js`，一套 UI 两种传输：
  - **云模式**（URL 带 `?t=`）：`status` 校验 → 逐张 `sign` → PUT 到 signed URL → `register` → `complete`，文案改为"任意网络都能上传，识别在云端完成"。
  - **局域网模式**（无 `?t=`）：沿用 `server.mjs` 注入的 token 与现有 `/api/mobile-links/...` 接口。

### 其它文件

- `src/cloud-bridge.js`（新）：把生成的 Cloud 客户端挂到 `window` 供经典脚本使用；`src/integrations/supabase/client.ts`、`types.ts` **不修改**。
- `server.mjs`：本机 API 增加 CORS/OPTIONS，token 注入改为 `<script>window.__scribeLinkToken='…'</script>`；**业务逻辑不动**（局域网通道照旧）。
- `supabase/config.toml`：两个函数设 `verify_jwt = false`。
- `package.json`：新增 `@supabase/supabase-js`。
- `README.md`：两条通道的差异、发布站点要求、云端识别用量说明。

## AI 能力（识别的核心）

1. 实施第一步：开启 AI 能力（会弹出确认卡），随后**重新加载 `enter_llm_integration` 技能**取得本项目的模型清单。
2. 按技能要求选择**支持图片输入的 OpenAI 系（ChatGPT/GPT）模型**，遵循其模型选择流程与协议路由，并先读对应的协议参考文件再写代码。
3. 按协议要求携带 `X-Session-ID` 与 `X-Enter-Project-ID`；凭证只存在服务端 `Deno.env.get()`。
4. 不支持的模型一律不静默替换。

## 需要用户知道的三点

1. 手机打开的是**发布后的站点地址**，要长期稳定使用需要先发布项目。
2. 云识别消耗的是**本项目（你）的 AI 额度**，别人用得越多你付得越多；已加每批页数上限，可随时调整。
3. 扫描版 PDF / HEIC 是已知边界，会给出明确提示而不静默失败。

## 关键文件

| 文件 | 改动 |
|---|---|
| 迁移（经迁移工具） | 两张表 + RLS + 私有桶 `scribe-pages` |
| `supabase/functions/scribe-mobile-upload/index.ts` | 上传/状态/签名/删除/原页地址 |
| `supabase/functions/scribe-ocr/index.ts` | 单页云端识别（GPT 视觉） |
| `supabase/config.toml` | 两个函数 `verify_jwt = false` |
| `index.html` | 通道切换、云二维码、轮询、云端识别进度、云端批次列表 |
| `mobile.html`（由 `public/` 移入） | 薄壳 + 模块入口 |
| `src/mobile-upload.js`（新） | 手机端队列 UI + 云/局域网两种传输 |
| `src/cloud-bridge.js`（新） | 暴露 Cloud 客户端 |
| `vite.config.ts` | 增加 mobile.html 构建入口 |
| `server.mjs` | CORS/OPTIONS、token 注入方式（逻辑不变） |
| `package.json` / `README.md` | 依赖与说明 |

## Implementation checklist

- [ ] 开启 AI 能力并重新加载 `enter_llm_integration`，从模型表中选定**支持图片输入的 GPT 模型**并读取其协议参考文件
- [ ] 迁移：建 `scribe_cloud_sessions` / `scribe_cloud_files`（索引、外键、识别相关列），两表 `enable row level security` 且不加客户端策略
- [ ] 迁移：建私有桶 `scribe-pages`（100MB、既定 MIME），不加客户端 storage 策略
- [ ] 用 `supabase_get_table_schema` 确认 RLS 已开、列与外键符合预期
- [ ] `scribe-mobile-upload`：CORS/OPTIONS、token 校验、`create/status/sign/register/complete/remove/pageUrl`，含文件数与大小上限
- [ ] `scribe-ocr`：单文件处理、token 校验、按扩展名分流（图片→GPT 视觉转录，PDF→文本层，doc/docx→mammoth）、写回 `ocr_text/ocr_status/ocr_error`、失败可重试
- [ ] 两个函数 `verify_jwt = false` 并部署
- [ ] `package.json` 增加 `@supabase/supabase-js`；新增 `src/cloud-bridge.js` 并在 `index.html` 引入模块脚本
- [ ] `index.html`：通道切换（写入 `state.settings`，默认云通道）
- [ ] `index.html`：云通道出码（`qrcode` 前端生成）、`status` 轮询、上传完成提示
- [ ] `index.html`：逐页调用 `scribe-ocr` 的进度与失败重试，识别结果按 `saveDocument` 结构写入书库并可直接进入精读
- [ ] `index.html`：云端批次列表（localStorage 记 token、状态刷新、重试失败页、删除云端副本），并标注 AI 用量
- [ ] 迁移 `public/mobile.html` → 根目录 `mobile.html`，抽成薄壳 + `src/mobile-upload.js`
- [ ] `src/mobile-upload.js`：云模式（sign→PUT→register→complete）与局域网模式共用同一套队列 UI 与排序交互
- [ ] `mobile.html` 文案按模式区分，云模式去掉"必须同一 Wi‑Fi"
- [ ] `vite.config.ts` 增加 `mobile.html` 构建入口，产物仍为 `dist/mobile.html`
- [ ] `server.mjs`：加 CORS/OPTIONS 与 `window.__scribeLinkToken` 注入；`/mobile/<token>` 与既有接口行为不变
- [ ] `README.md` 补通道差异、发布要求、云端识别用量说明

## Verification checklist

- [ ] `pnpm build` 通过，`dist/` 含 `index.html`、`mobile.html`、打包资源与 `import-queue.js`
- [ ] 正向（上传）：脚本跑通 `create → sign → PUT → register → complete → pageUrl`，下载字节与原文件一致
- [ ] 正向（云识别）：用一张已知文字的页面图片跑 `scribe-ocr`，返回文本与原文一致，且 `ocr_status` 写回为 complete
- [ ] 正向（端到端）：云批次从上传到精读页生成，全程**不开本机服务**、不依赖 `ocr.swift`
- [ ] 负向：无效/过期 token 返回 410；未 `complete` 就识别被拒；超过页数上限/100MB/不支持的类型被拒并给出可读提示
- [ ] 负向（越权）：用 anon key 直接 REST 读两张表返回空/被拒，确认 RLS 默认拒绝生效
- [ ] 负向（边界）：扫描版 PDF、HEIC 给出明确提示而不是静默失败
- [ ] 回归（本机通道）：`server.mjs` 起服务后 `/api/mobile-links?local=1 → files → complete → commit` 仍能生成文档（本环境无 `swift`，本机 OCR 失败属预期）
- [ ] 成本核对：一次 N 页识别的用量与页数一致，页数上限生效
- [ ] 端到端（用户执行）：手机关 Wi‑Fi 用蜂窝网络扫码上传 → 任意设备打开应用 → 识别完成进精读

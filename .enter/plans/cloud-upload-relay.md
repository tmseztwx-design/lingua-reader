# 云端中转上传：手机与电脑不再需要同一 Wi‑Fi

## Context（为什么做）

现在手机直传必须和电脑在同一个 Wi‑Fi：二维码由电脑端本机服务（`server.mjs` 的 `/api/mobile-links`）用局域网 IP 生成，手机也要直接访问这台电脑。用户希望改成：**手机在任何网络下都能把书页送到 Enter 云，电脑之后再从云上取回**，原页长期保留在云端。

已确认的边界（用户选择）：

- 文字识别（OCR）仍然在用户自己的电脑上跑（macOS Vision / `ocr.swift`）。**电脑没开时上传照常进行**：云是收件箱，不会丢件，只是识别要等电脑开机后在「导入文献」里点取回。这一点需要在界面上讲清楚，不能让用户以为传完就自动识别了。
- 云端原页**长期保留**，不做自动删除；但提供手动「从云端删除这一批」作为存储安全阀。
- **局域网通道保留**，扫码时可在两条通道间切换。

## 架构

```
手机（任意网络） --HTTPS--> Enter 云（私有存储桶 + 两张表，经后端函数签发地址）
                                        |
电脑「导入文献」点击取回 <----------------+
        |
        +--> 复用现有本机链路：/api/mobile-links?local=1 → /files → /complete → /commit → /process（本机 OCR）→ 精读区
```

### 云端数据与存储

- 新表 `public.scribe_cloud_sessions`：`id`、`token`(唯一)、`created_at`、`expires_at`、`completed_at`、`file_count`、`title`。
- 新表 `public.scribe_cloud_files`：`id`、`session_id`(外键，级联删除)、`queue_order`、`name`、`size`、`mime`、`storage_path`、`uploaded_at`。
- 两张表**启用 RLS 且不添加任何面向客户端的策略**（默认拒绝）：浏览器永远不直接读写数据库，所有访问都经后端函数（服务角色）+ token 校验。这是比"给 anon 开策略"更严格的默认拒绝姿态。
- 新桶 `scribe-pages`：**private**，`file_size_limit = 100MB`，允许 `pdf/doc/docx/jpg/jpeg/png/heic/heif/txt`。客户端不直接读写桶：上传用函数签发的 **signed upload URL**（PUT），下载用函数签发的 **signed download URL**（GET），因此不需要任何客户端可见的 storage 策略。
- 对象路径：`<session_id>/<order>-<file_id><ext>`。

### 后端函数 `supabase/functions/scribe-mobile-upload/index.ts`

单函数多动作，`supabase/config.toml` 里设 `verify_jwt = false`（手机没有登录态），每个动作都先校验 token 是否存在且未过期：

| action | 用途 | 调用方 |
|---|---|---|
| `create` | 生成 32 位随机 token + 24 小时有效窗口；限制同一时间未过期会话数量（防滥用） | 电脑 |
| `status` | 会话状态 + 文件清单（按 queue_order） | 电脑轮询 / 手机校验 |
| `sign` | 为一个文件签发 storage 上传地址并落一行记录（含顺序） | 手机 |
| `register` | 上传成功后回写 `size` / `mime` / `uploaded_at` | 手机 |
| `complete` | 标记整批完成 | 手机 |
| `downloads` | 按顺序签发下载地址 | 电脑 |
| `remove` | 删除该批（数据库行 + 桶内对象） | 电脑（手动） |

约束与现有本机服务保持一致：单文件 ≤ 100MB，单批 ≤ 100 个文件，仅允许既定扩展名。函数必须带完整 CORS（含 OPTIONS 预检），密钥走 `Deno.env.get()`，不写原始 SQL。

## 前端改动

### `index.html`（桌面端「导入文献」）

- 新增通道切换：**局域网直连** / **云端中转**，选择记进 `localStorage` 的 `state.settings`，默认沿用原来的局域网。
- 云通道的二维码内容为 `${location.origin}/mobile.html?t=<token>`；二维码用依赖里已有的 `qrcode` 在前端生成（不再依赖本机服务），因此 **电脑端没有开本机服务时也能出码**。
- 轮询 `status` 显示进度；整批完成后「取回并识别」：逐个取 signed URL → `fetch` 成 Blob → 推入**现有本机链路**（复用 `server.mjs` 已有的 `/api/mobile-links?local=1`、`/{id}/files`、`/{id}/complete`、`/{id}/commit`，再走 `/api/documents/{id}/process` 的识别与 `saveDocument` 落库逻辑）——本机管线一行都不用重写。
- 新增「云端批次」列表：本地记住自己创建过的 token（`localStorage`），打开页面时刷新状态，显示 `等待上传 / 已收到 N 页 / 已取回`，可随时取回（对应"电脑没开时先上传"），也可删除云端副本。
- 本机服务没开或不可达时给出明确提示（识别需要本机服务，云上文件仍在，不会丢）。

### `mobile.html`（手机页）

- 从 `public/mobile.html` **移到项目根目录** `mobile.html`，作为 Vite 第二个构建入口（这样它才能打包自己的模块脚本）；`vite.config.ts` 增加 `build.rollupOptions.input`。产物仍在 `dist/mobile.html`，`server.mjs` 的 `/mobile/<token>` 路由不变。
- 现有手机端脚本（队列、排序、逐张进度、微信提示）整体搬到新模块 `src/mobile-upload.js`，抽出两种传输，UI 只有一套：
  - **云模式**：URL 带 `?t=` → 函数 `status` 校验 → 逐个 `sign` → PUT 到 signed URL → `register` → `complete`。
  - **局域网模式**：无 `?t=`，沿用 `server.mjs` 注入的 token 与 `/api/mobile-links/...` 接口，行为与现在一致。
- 文案按模式区分：云模式写"任意网络都能上传，电脑开机后在导入文献里取回识别"，去掉"必须同一 Wi‑Fi"。

### 其它文件

- `src/cloud-bridge.js`（新）+ 页面上 `<script type="module" src="/src/cloud-bridge.js">`：把生成的 Cloud 客户端挂到 `window`，供页面原有的经典脚本使用。`src/integrations/supabase/client.ts` 与 `types.ts` **不修改**（框架会重写）。
- `server.mjs`：本机 API 增加 CORS 响应头与 OPTIONS 预检（页面从公网站点访问 `http://localhost:4174` 才不会被浏览器拦下）；token 注入改为 `<script>window.__scribeLinkToken='…'</script>` 以配合新模块。业务逻辑不动。
- `package.json`：新增 `@supabase/supabase-js`（与生成的客户端配套）。
- `README.md`：补充两条通道、发布站点以获得固定公网地址、以及"电脑没开也能先上传、识别仍需电脑"的说明。

## 关键文件

| 文件 | 改动 |
|---|---|
| `supabase/migrations/*`（经迁移工具生成） | 两张表 + RLS + `scribe-pages` 桶 |
| `supabase/functions/scribe-mobile-upload/index.ts` | 新后端函数（7 个 action） |
| `supabase/config.toml` | `[functions.scribe-mobile-upload] verify_jwt = false` |
| `index.html` | 通道切换、云二维码、轮询、取回、云端批次列表 |
| `mobile.html`（由 `public/` 移入） | 薄壳 + 模块入口，云/局域网两种传输 |
| `src/mobile-upload.js`（新） | 手机端队列 UI + 两种传输 |
| `src/cloud-bridge.js`（新） | 暴露 Cloud 客户端给经典脚本 |
| `vite.config.ts` | 增加 mobile.html 构建入口 |
| `server.mjs` | CORS / OPTIONS、token 注入方式 |
| `package.json` / `README.md` | 依赖与说明 |

## 需要用户知道的两点

1. 手机打开的公网页面来自**发布后的站点地址**（预览地址会变）。要长期稳定使用，需要发布项目。
2. 取回后仍在本机做 OCR，所以**电脑要开着**才能识别；电脑没开时上传照样会成功并留在云上。

## Implementation checklist

- [ ] 迁移：建 `scribe_cloud_sessions` / `scribe_cloud_files`（含索引与外键），两表 `enable row level security` 且不加任何客户端策略
- [ ] 迁移：建私有桶 `scribe-pages`（100MB、既定 MIME），不加客户端 storage 策略
- [ ] 迁移后用 `supabase_get_table_schema` 确认两表 RLS 已开启、列与外键符合预期
- [ ] 写 `supabase/functions/scribe-mobile-upload/index.ts`：CORS + OPTIONS、token 校验、7 个 action、文件数与大小上限
- [ ] `supabase/config.toml` 写入 `verify_jwt = false` 并部署函数
- [ ] `package.json` 增加 `@supabase/supabase-js`；新增 `src/cloud-bridge.js` 并在 `index.html` 引入模块脚本
- [ ] `index.html`：导入文献面板加通道切换（写入 `state.settings`，默认局域网）
- [ ] `index.html`：云通道出码（`qrcode` 前端生成，`${location.origin}/mobile.html?t=`）、`status` 轮询、完成提示
- [ ] `index.html`：取回流程复用本机链路（`?local=1` → `/files` → `/complete` → `/commit` → `/process` → `saveDocument`）
- [ ] `index.html`：云端批次列表（localStorage 记 token、状态刷新、取回、删除云端副本）
- [ ] `index.html`：本机服务不可达时给出明确提示且不丢失云上文件
- [ ] 迁移 `public/mobile.html` → 根目录 `mobile.html`，抽成薄壳 + `src/mobile-upload.js`
- [ ] `src/mobile-upload.js`：云模式（`?t=` → sign → PUT → register → complete）与局域网模式（现有 `/api/mobile-links` 流程）共用同一套队列 UI
- [ ] `mobile.html` 文案按模式区分，去掉云模式下的"必须同一 Wi‑Fi"
- [ ] `vite.config.ts` 增加 `mobile.html` 构建入口，产物仍为 `dist/mobile.html`
- [ ] `server.mjs`：本机 API 加 CORS/OPTIONS；token 改为 `window.__scribeLinkToken` 注入；`/mobile/<token>` 路由保持可用
- [ ] `README.md` 补两条通道、发布要求、以及"识别仍需电脑"的边界说明

## Verification checklist

- [ ] `pnpm build` 通过，`dist/` 含 `index.html`、`mobile.html`、打包资源与 `import-queue.js`
- [ ] 正向（云）：脚本跑通 `create → sign → PUT → register → complete → downloads`，下载文件字节与原文件一致
- [ ] 负向（云）：无效/过期 token 返回 410；未 `complete` 就取回被拒；超过单批文件数或 100MB 被拒
- [ ] 负向（越权）：用 anon key 直接 REST 读两张表返回空/被拒（RLS 默认拒绝生效，说明不依赖客户端策略）
- [ ] 回归（本机链路）：本地起 `server.mjs`，`/api/mobile-links?local=1` → 上传 → `complete` → `commit` 生成文档（本环境无 macOS `swift`，OCR 失败属预期，不影响链路验证）
- [ ] 回归（局域网通道）：手机页无 `?t=` 时行为与改动前一致（由用户在本机 `pnpm build && pnpm start` 下确认）
- [ ] 端到端（用户执行）：手机用蜂窝网络（关 Wi‑Fi）扫码上传 → 电脑端「云端批次」点取回 → 生成精读页
- [ ] 端到端（用户执行）：电脑没开时先上传，之后开机取回仍能识别

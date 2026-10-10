# 内测版：内测码登录 + 内测管理后台

## Context（为什么做这件事）

现在的站点没有账号体系：每台新设备第一次打开时会**自动生成一个匿名书库同步码**，云端同步与手机上传都直接可用。要发内测版，需要把「谁可以开云端」收回到你手里：只有拿到你发出的内测码的人才能开启云端同步与上传，而每个内测码对应一份**长期、跨设备保留**的数据。

按你的四个决定实现：

1. 后台只用**管理口令**保护，口令只在服务端校验（我会给你一个安全表单填入口令，口令不经过对话、不写进代码）。
2. 一个内测码可在**多台设备**登录，共用同一份数据。
3. 内测码**生成时显示明文**，之后后台只保留哈希与尾号；丢了只能作废重发。
4. **不做整站登录门**：界面照常浏览，只有云端同步与手机上传需要内测码。

内测码本身不引入 Enter Cloud 账号体系（没有邮箱、没有密码）：它沿用现有的「书库 = 数据容器」模型，一个内测码绑定一个书库，多台设备各自拿到访问同一书库的凭证，数据保留与跨设备同步继续由现有同步引擎负责。

## 关键文件

- `index.html`：新增「内测登录」卡片（导入页顶部 + 设置页）、新增 `#betaAdmin` 视图与左侧「内测管理」入口（含 `go()` 的 crumb 映射）
- `src/beta-access.js`（新增）：内测会话状态、兑换/退出、后台接口调用、内测码卡片与后台面板 UI
- `src/cloud-library.js`：`ensureLibrary()` 接入内测状态；**不再为无内测码的新设备自动创建书库**
- `src/cloud-bridge.js`：在 `installLibrary` 之前 `installBeta(cloud)`
- `supabase/functions/src/scribe-beta.ts`（新增）+ `supabase/functions/scribe-beta/index.ts`（`pnpm bundle:functions` 生成）
- `supabase/functions/_shared/cloud.ts`：`libraryFor()` 支持「一个书库多份访问凭证」
- `supabase/config.toml`：新增 `[functions.scribe-beta] verify_jwt = false`
- `supabase/migrations/<时间戳>_beta_codes.sql`（新增）
- `docs/enter-deployment.md`、`README.md`：六个函数、新迁移、内测流程与口令设置步骤
- `test/*.test.mjs`（新增用例）、`test/cloud-live.mjs`

## 数据模型（新迁移，全部 RLS + 只授权 service_role）

- `scribe_library_access`：`library_id`、`access_hash`（唯一）、`label`、`created_at`。一个书库可有多份访问凭证，实现「一码多设备、各自持有凭证」。现有 `scribe_libraries.access_hash` 与既有同步码**原样保留、继续有效**。
- `scribe_beta_codes`：`code_hash`（唯一）、`code_mask`（如 `SCRIBE-••••-4F2A`）、`label`（备注给谁用）、`library_id`（首次兑换时绑定）、`created_at`、`redeemed_at`、`last_seen_at`、`revoked`。
- `scribe_beta_guard`：单行限流表（`failed_attempts`、`locked_until`），兑换与后台口令连续输错后短时锁定。

内测码格式：`SCRIBE-XXXX-XXXX`（用户也可在后台自定义文本），规范化（大写、去空格）后 SHA-256 存储。

## 后端：新函数 `scribe-beta`（书库式鉴权，客户端不接触任何密钥）

- `redeem` `{code, libraryKey?}`
  - 码无效 / 已作废 → 明确错误（不泄露码是否存在之外的信息）
  - 请求携带当前设备的 `libraryKey` 且该码**尚未绑定** → 绑定这个书库并返回同一把钥匙（**你现有数据原地变成你的内测账号，不丢数据**）
  - 码已绑定书库 → 为该书库新签一份访问凭证并返回（新设备登录，看到同一份数据）
  - 码未绑定且设备无书库 → 新建书库并绑定，返回钥匙
  - 更新 `redeemed_at` / `last_seen_at`
- `adminAuth` `{password}`：与 `Deno.env.get("SCRIBE_ADMIN_PASSWORD")` 做常量时间比较；失败计入限流表
- `adminCreate` `{password, count, label, codes?}`：生成随机码或写入你指定的码，返回**明文一次**（入库只存哈希与尾号）
- `adminList` `{password}`：掩码、备注、状态、绑定时间、最近活跃（`scribe_library_entries.updated_at` 最大值）、文献数、卡片数
- `adminRevoke` / `adminRestore` `{password, id}`：作废只影响**新设备登录**，已登录设备的凭证继续可用（如需硬切断，后续再加按凭证停用）

管理口令由你通过平台的安全表单写入服务端环境（`SCRIBE_ADMIN_PASSWORD`），我不经手、不落库、不出现在代码或日志里。

## 前端行为

- 未登录：导入页的「云端中转 · 任意网络」显示内测码输入卡片，不生成二维码；本地通道与所有本地功能照常可用
- 兑换成功：写入 `localStorage['scribe-beta-session']`（码尾号、书库钥匙、绑定时间），**永久有效**，刷新/重开浏览器自动登录；立刻开始同步
- **兼容旧设备**：已经有 `scribe-library-key` 但没有内测码的设备（你现在这台）继续同步，不中断；设置页给出「用内测码绑定当前数据」入口
- 设置页新增「内测与云端」卡片：当前码（尾号）、绑定时间、切换/退出内测码（切换前提示会拉取该码的数据，并提供导出本地数据）
- 内测管理面板（`#betaAdmin`，左侧导航「内测管理」）：口令输入 → 生成（数量/备注/可选自定义码，生成结果可一键复制或导出）→ 码列表（掩码、备注、状态、活跃度、文献/卡片数）→ 作废/恢复 → 导出 JSON
- 手机上传页（`mobile.html`）不需要内测码（靠一次性 token 链接），保持不变

## Implementation checklist

- [ ] 新迁移建 `scribe_library_access`、`scribe_beta_codes`、`scribe_beta_guard`，三张表同迁移内开 RLS、`revoke` 给 anon/authenticated、只授权 service_role
- [ ] `_shared/cloud.ts` 的 `libraryFor()` 先查 `scribe_libraries.access_hash`，再查 `scribe_library_access.access_hash`，既有同步码不受影响
- [ ] 新增 `src/scribe-beta.ts`：`redeem` / `adminAuth` / `adminCreate` / `adminList` / `adminRevoke` / `adminRestore`，含规范化、SHA-256、常量时间口令比较、限流表
- [ ] `supabase/config.toml` 增加 `scribe-beta` 的 `verify_jwt = false`；`pnpm bundle:functions` 生成单文件
- [ ] `src/beta-access.js`：会话状态（`scribe-beta-session`）、`redeem`/`logout`、后台调用、内测码卡片与 `#betaAdmin` 面板渲染
- [ ] `src/cloud-library.js`：`ensureLibrary()` 无内测码且无既有钥匙时抛 `BETA_REQUIRED`，不再自动新建书库；兑换成功后立即恢复同步；设置页显示内测状态
- [ ] `src/cloud-bridge.js`：`installBeta(cloud)` 先于 `installLibrary(cloud)`
- [ ] `index.html`：导入页内测卡片、`#betaAdmin` 视图、导航「内测管理」、`go()` 的 crumb 补 `betaAdmin`
- [ ] 更新 `docs/enter-deployment.md` 与 `README.md`（六个函数、新迁移、内测码流程、管理口令设置步骤）；`package.json` 升到 1.4.0

## Verification checklist

- [ ] `pnpm test`：新增 pglite 用例断言三张新表 RLS 已开、anon 无权限、service_role 可读写、`code_hash` 唯一约束生效
- [ ] `pnpm test`：新增 jsdom 用例——无码设备**不会**调用 `scribe-library create`，且导入页显示内测码卡片
- [ ] jsdom：输入有效码 → 写入会话、隐藏卡片、触发一次同步；刷新（重新 eval 页面）后仍是已登录
- [ ] jsdom：无效码 → 显示错误且不写会话；作废码 → 同样被拒
- [ ] jsdom：已有 `scribe-library-key` 的旧设备仍照常同步（回归：现有 13 项测试全绿）
- [ ] jsdom：内测管理面板在口令错误时不显示列表，正确时渲染掩码列表与生成结果
- [ ] 真实云端验收（合成数据，不碰用户文献）：直插一条已知码的记录 → 设备 A 兑换拿到钥匙 → 设备 B 用同一码兑换拿到**另一把**钥匙且两把钥匙读到**同一份**书库数据 → 作废后新设备兑换被拒
- [ ] 真实云端验收：把码绑定到已存在书库（携带 `libraryKey`）后，原书库数据与既有同步码都照常工作
- [ ] `pnpm build` 通过；`node test/cloud-live.mjs` 仍 PASS（既有链路未被内测层破坏）
- [ ] 按 1280 与 390 两个宽度截图确认内测卡片与内测管理面板排版正常

## 需要你做的两件事

1. 我会弹出安全表单让你设置**管理口令**（服务端环境变量 `SCRIBE_ADMIN_PASSWORD`）；口令只用于后台校验，我看不到。
2. 改动完成后点一次 Publish；我会先把新迁移与 `scribe-beta` 部署好，你在后台生成第一批内测码即可发给内测用户。

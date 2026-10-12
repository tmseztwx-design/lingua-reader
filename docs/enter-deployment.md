# Enter 云端部署：现状、约束与复现步骤

这份清单针对已连接的 `lingua-reader` Cloud（`spb-t4nu9v7279pycm5l`）。不新建 Cloud、不换账号、不删除历史用户文件。

## 一、当前状态（2026-10-04 已由平台工具完成）

- **迁移已执行**：`supabase/migrations/20261003090000_cloud_library_queue.sql`
  - 新增 `scribe_libraries`、`scribe_library_entries`、`scribe_runtime_settings`（三张表均开启 RLS，且已 `revoke` 给 anon/authenticated，只授权 service_role）
  - `scribe_cloud_sessions` 增加 `library_id`、`deleted_at`；`scribe_cloud_files` 增加 `attempts`、`lease_id`、`lease_until`、`retry_at`（原表与原数据保留，仅加列）
  - 新增服务端函数：`scribe_write_entry`、`scribe_claim_page`、`scribe_finish_page`、`scribe_cleanup_candidates`（仅 service_role 可执行）
  - 注册 cron 任务 `scribe-background-ocr`，每分钟调用 `scribe-queue`
- **迁移已执行**：`supabase/migrations/migration_20261009_030634000`（逐段译文与点词词典）
  - `scribe_cloud_files` 增加 `paragraphs jsonb`（原表与原数据保留，仅加列）
  - `scribe_finish_page` 换成带 `p_paragraphs` 的五个参数版本，第五个参数带默认值，旧的四参数调用仍然可用（灰度期不会中断在跑的 worker）
  - 新增 `scribe_word_cache`（开启 RLS，`revoke` 给 anon/authenticated，只授权 service_role）：同词同句的音标与语境释义只计费一次
- **迁移已执行**：`supabase/migrations/20261009120000_word_cache_gloss.sql`
  - `scribe_word_cache` 增加 `gloss`（卡片主行的概括性简释，完整语境释义仍在 `meaning`；仅加列）
- **迁移已执行**：`supabase/migrations/migration_20261010_022745000`（内测码）
  - 新增 `scribe_beta_codes`（码哈希、掩码、备注、绑定书库、作废标记、兑换与最近活跃时间）、`scribe_library_access`（一个书库多份设备凭证）、`scribe_beta_guard`（失败限流单行表）；三张表同迁移内开 RLS、`revoke` 给 anon/authenticated，只授权 service_role
  - `libraryFor()` 先查 `scribe_libraries.access_hash`，再查 `scribe_library_access.access_hash`；既有同步码原样有效
- **六个后端函数已部署**：`scribe-mobile-upload`、`scribe-ocr`、`scribe-library`、`scribe-queue`、`scribe-study`、`scribe-beta`
  - JWT 校验按 `supabase/config.toml` 关闭；`scribe-queue` 另外要求私有 `x-scribe-worker-key`（来自 `scribe_runtime_settings`，仅服务端可读）；`scribe-study` 用书库同步码鉴权，只服务本书库的页面
  - `scribe-mobile-upload` 的 `reorder`（调序）、`absorb`（续传并入）与 `pages`（重签原页地址）同样按书库同步码鉴权：只认本书库、未删除的批次，调序会校验页集完整
  - 原页地址是限时签名链接：书库同步每次都会重签并写入 `urlAt`；阅读区在本页无地址或链接超过 45 分钟时自动重签，图片加载失败也会重试一次，避免「原页像丢了一样」
  - `scribe-beta` 只做内测码兑换与后台管理：`redeem` 按码签发书库凭证，后台动作一律先校验 `SCRIBE_ADMIN_PASSWORD`（服务端环境变量、常量时间比较、连续失败短时锁定），后台口令不落库、不进日志
- **私有桶 `scribe-pages` 保留**，未改动

### 管理后台

- 地址（两种入口，共用 `src/admin-page.js` 的结构与样式）：
  1. `<站点根地址>/admin.html`（独立页面，预览与本机通道可用）；
  2. `<站点根地址>/?admin=1`（**主入口路由**）。正式站只保证主入口 `/` 可达，子页面取不到时用这条。
- 因此 `admin.html` 保持为薄壳：结构、样式与逻辑都在 `src/admin-page.js`，避免两个入口各写一份。
- 口令只由 `scribe-beta` 的服务端校验；空口令不再计入失败次数，连续输错 8 次会锁定 10 分钟（成功一次即清零）。
- 后台里生成内测码后请立刻复制或下载：库内只留哈希与尾号。
- 手机上传页目前只能用 `/mobile.html`（二维码指向它）。实测正式域名上除主入口外的路径可能返回 `Production Proxy Error`（502），此时**手机扫码会打不开**；遇到这种情况先重新发布一次刷新部署，若仍不行再把上传页也搬到主入口路由（`/?mobile=1&t=`）。

## 一点五、站点入口

构建产物有三个入口：`index.html`（学生端）、`mobile.html`（手机上传页）、`admin.html`（**内测管理后台**，独立页面）。

- 管理后台只在 `/admin.html` 出现，学生端（`/`）**不含任何后台入口**；后台需要 `SCRIBE_ADMIN_PASSWORD` 校验，口令只在本标签页内保存。
- `src/cloud-client.js` 是学生端与后台共用的云端调用封装；`src/admin-console.js` 只被 `admin.html` 使用。
- 后端 `scribe-beta` 的所有后台动作都要口令校验，未设置密钥时返回 503。

## 二、平台约束（务必先读）

**部署器只打包 `supabase/functions/<name>/index.ts` 这一个文件。** 同目录的兄弟文件、子目录、以及上层的 `_shared/` 都不会被带上，否则部署会失败并报 `Module not found`。因此本仓库的布局是：

- 唯一可读源：`supabase/functions/src/<name>.ts` 与 `supabase/functions/_shared/*.ts`
- 生成物：`supabase/functions/<name>/index.ts`（自包含单文件，直接部署这一份）
- 生成命令：`pnpm bundle:functions`

改完源文件后必须重新生成再部署，否则部署的还是旧代码。

另一个已修复的坑：共享代码内联到同一作用域后，重复声明会在运行时报 `worker boot error ... Identifier 'BUCKET' has already been declared`。现在 `_shared/ocr-core.ts` 复用 `_shared/cloud.ts` 导出的 `BUCKET`，不再自己声明。

**迁移必须通过平台工具执行**，不能在 SQL 编辑器里手工跑一遍就算完；数据库不是通过前端页面控制的。重复执行本迁移会新增重复的 cron 任务，重跑前请先检查 `cron.job` 并用 `cron.unschedule` 清理旧任务。

## 三、复现步骤（换 Cloud 或重建时）

1. 通过平台连接 Cloud，并确认 `pg_cron`、`pg_net` 可用。
2. 按文件名顺序执行 `supabase/migrations/20261003090000_cloud_library_queue.sql`、`supabase/migrations/migration_20261009_030634000`、`supabase/migrations/20261009120000_word_cache_gloss.sql` 与 `supabase/migrations/migration_20261010_022745000`。
3. 运行 `pnpm bundle:functions`，逐个部署六个函数的 `index.ts`。
3.1 通过平台安全表单写入服务端环境变量 `SCRIBE_ADMIN_PASSWORD`（内测管理口令）；未设置时后台动作会返回 503。
3.2 发布后管理后台的地址是 `<站点根地址>/admin.html`，与学生端互不入口污染；建议加书签或只自己保存。
4. 检查 `cron.job` 中 `scribe-background-ocr` 为 active，且 `cron.job_run_details` 有成功记录。
5. 运行 `pnpm test` 与 `pnpm build`。
6. 运行 `node test/cloud-live.mjs`：只创建合成 TXT 批量与独立书库，不使用用户文件，结束时软删除自己的批次。

## 四、验收证据（本次实测）

- `node test/cloud-live.mjs` → PASS：私密上传、页序（倒序完成仍按确认顺序）、**无浏览器参与的后台自动识别**、跨设备同步、worker 鉴权
- `pnpm test` → 13 项通过（含逐段译文渲染、折叠标志、点词音标与释义、词库缓存与 RLS 隔离、阅读页调序与失败回退）
- 界面实测（jsdom 驱动真实页面 + 真实云函数）：生成云端二维码不再出现 `Function not found`，状态显示「云端通道已就绪」，随后后台队列自动完成识别
- 函数探针：`scribe-mobile-upload` 410、`scribe-ocr` 410、`scribe-library` 401、`scribe-queue` 403、`scribe-study` 401（均为业务级应答，说明函数已正常启动）
- 本机存储实测与加固（1.6.1）：浏览器存储写满（`setItem … exceeded the quota`）曾让上传、收藏与翻页连带失败。现在辅助数据（待发镜像、指纹表、冲突副本）写失败不再中断流程；上传失败给出可操作提示；底部出现「清理本机缓存」提示条；学习区明确说明「这次收藏没能保存」
  - 省空间：逐段结构存在时不再重复下发/保存整页原文（实测 `page.text` 为空、`paragraphs` 完整、译文保留）；待发镜像改为「引用 + 短指纹」，不再整份复制；冲突副本上限从 100 收到 50
- 内测码哈希口径实测：修复前生成端对「带连字符的显示形式」取哈希、兑换端对「规范化后的码」取哈希，导致**随机生成的内测码全部兑换失败**（自定义码因为生成端也做了规范化而正常）。现在两端统一用规范化口径，并兼容早期按显示形式入库的码（已发出的码粘贴原样即可兑换）；实测规范化入库、大小写/空格变体、早期口径三种情况都能兑换，不存在的码仍返回 404
- 卡片显示对账：面板每 2 秒按存储内容对账，只要存储里已经有查词结果就一定显示出来（不再依赖某一次回调成功渲染）；查词超过 8 秒时卡片显示已等待秒数与“可再点该词重试”；实测服务端 `define` 冷启动 2.5~4 秒、命中缓存 26 毫秒
- 同步合并：请求期间写入的内容（查词结果、笔记）以「此刻最新」的本地值为准，不会被这次响应的旧快照覆盖（有回归测试）
- 阅读区翻页实测：顶部与底部两条翻页条同步可用，翻页后回到页面顶端（滚动位置记忆只在离开后回来时生效）；查词请求 20 秒无响应时给出可重试提示而不是一直停在“正在查询”；点词时即使有残留选区也照常收藏并清掉选区
- 阅读区标记实测：翻页重排 `#paper` 后，已收藏的词立即重新高亮（不需要再点一次）；点词时正文中该词闪动提示，配合右栏卡片滚动定位
- 点词即时性实测：点击生词后立刻发出该词的释义请求（不再等到下一次渲染/下一次点击）；连续点两个词时两个请求并行，后点的先返回也只写回自己的卡片；同一张卡不会重复请求；点击处于选中状态的词同样一次建卡并清空选区
- 书库切换实测：内测码属于另一个书库时，兑换后设备会切过去并拉取该库数据（切换前写入可回滚备份）；内测码绑定本机书库时原地保留，不动本机文献与学习卡
- 翻页健壮性实测：27 页、原页链接分散在两个目录且已过期时，上一页/下一页仍可正常翻页；本机存储写满（写入抛错）时翻页照常工作，并在阅读区提示进度未保存
- 标题页数实测：两页文献 `absorb` 并入一页后标题从「（2 个文件）」更新为「（3 个文件）」；把书库记录改回陈旧标题后同步，`documents` 与 `entries` 两处都被服务端纠正为真实页数，且同一记录里的 `progress` 原样保留
- 原页地址自愈实测：续传并入后的三页文献经 `pages` 按书库凭证重签，三个签名地址全部 200 可读（原件分散在原批次与目标批次两个目录）；单页重签可用；其他书库调用同一接口返回 404，原件仍隔离在本书库内
- 数据保护回归测试：「进入体验」在已有真实数据的设备上只移除内置示例，用户文献/学习卡/学习时长与云端书库连接全部保留，并对老用户隐藏该入口；示例数据下仍可正常从零开始
- 内测码实测：同一内测码在两台“设备”上兑换得到**两把不同凭证**并读到**同一份书库数据**；无效码 404、作废码 403、错误或缺失的管理口令 401（证明服务端已设置口令且校验生效）
- 识别阶段实测：合成 TXT 页面在后台完成后带回首段结构 `paragraphs:[{text,translation}]`，译文为中文；`define` 返回 IPA 音标、概括性简释 `gloss` 与语境释义，重复查询命中缓存
- 调序与释义实测：三页合成文献调序后书库同步按新顺序返回，缺页的不完整顺序被 409 拒绝；`explain` 为划选短语返回中文释义
- 续传与清理实测：合成小批次 `absorb` 并入目标文献后页序接在末尾（3 页），原批次不再是独立文献；随后 `remove` 永久删除目标文献，`removedFiles=3`，被并入页面的签名地址立即失效，确认并入的原件也一并清除
- 1.7.0 本机大容量存储：学习数据（`scribe-local-v1`、待发镜像、指纹表、冲突副本、工作区备份、词库缓存）由 `public/storage-vault.js` 移入 IndexedDB 并申请持久存储；页面脚本仍用同步读写接口，无需改动。首次打开自动把 localStorage 旧数据迁入，确认写入成功后才释放旧副本；IndexedDB 不可用时退回原方式并在下次优先采用那份数据。回归测试：迁移后页面脚本同步读到原数据、刷新后仍在；12 MB 写入不报配额错误并跨刷新保留；删除同样落盘；无 IndexedDB 时照常启动（41 项测试全过）

## 五、仍需用户执行

- **正式发布站点**：手机扫码需要稳定的公网 HTTPS 地址，预览地址会变化，且预览环境的访问限制不能替代正式验收。发布后请用手机**关闭 Wi‑Fi**、走移动网络与微信实测：相册多次加入、拍照、排序、确认整批上传，并验证关闭电脑页面后后台仍继续识别。
- 微信自身的选择器限制（如单次最多 9 张）无法由网页解除。

## 六、数据保护

- 本机历史文献元数据、卡片与阅读进度会同步；旧的 Blob/本机服务地址对应的原件不会凭空迁入云端，需用户重新提供。
- 新上传原件直接存云端私有桶，公开读取被拒。
- 「最近删除」保留 30 天；部署与测试不得永久清理用户数据。
- 旧上传 token 只能关联尚未归属其他书库的历史批次。

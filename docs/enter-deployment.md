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
  - `scribe-mobile-upload` 的 `reorder`（调序）与 `absorb`（续传并入）同样按书库同步码鉴权：只认本书库、未删除的批次，且调序会校验页集完整
  - `scribe-beta` 只做内测码兑换与后台管理：`redeem` 按码签发书库凭证，后台动作一律先校验 `SCRIBE_ADMIN_PASSWORD`（服务端环境变量、常量时间比较、连续失败短时锁定），后台口令不落库、不进日志
- **私有桶 `scribe-pages` 保留**，未改动

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
4. 检查 `cron.job` 中 `scribe-background-ocr` 为 active，且 `cron.job_run_details` 有成功记录。
5. 运行 `pnpm test` 与 `pnpm build`。
6. 运行 `node test/cloud-live.mjs`：只创建合成 TXT 批量与独立书库，不使用用户文件，结束时软删除自己的批次。

## 四、验收证据（本次实测）

- `node test/cloud-live.mjs` → PASS：私密上传、页序（倒序完成仍按确认顺序）、**无浏览器参与的后台自动识别**、跨设备同步、worker 鉴权
- `pnpm test` → 13 项通过（含逐段译文渲染、折叠标志、点词音标与释义、词库缓存与 RLS 隔离、阅读页调序与失败回退）
- 界面实测（jsdom 驱动真实页面 + 真实云函数）：生成云端二维码不再出现 `Function not found`，状态显示「云端通道已就绪」，随后后台队列自动完成识别
- 函数探针：`scribe-mobile-upload` 410、`scribe-ocr` 410、`scribe-library` 401、`scribe-queue` 403、`scribe-study` 401（均为业务级应答，说明函数已正常启动）
- 数据保护回归测试：「进入体验」在已有真实数据的设备上只移除内置示例，用户文献/学习卡/学习时长与云端书库连接全部保留，并对老用户隐藏该入口；示例数据下仍可正常从零开始
- 内测码实测：同一内测码在两台“设备”上兑换得到**两把不同凭证**并读到**同一份书库数据**；无效码 404、作废码 403、错误或缺失的管理口令 401（证明服务端已设置口令且校验生效）
- 识别阶段实测：合成 TXT 页面在后台完成后带回首段结构 `paragraphs:[{text,translation}]`，译文为中文；`define` 返回 IPA 音标、概括性简释 `gloss` 与语境释义，重复查询命中缓存
- 调序与释义实测：三页合成文献调序后书库同步按新顺序返回，缺页的不完整顺序被 409 拒绝；`explain` 为划选短语返回中文释义
- 续传与清理实测：合成小批次 `absorb` 并入目标文献后页序接在末尾（3 页），原批次不再是独立文献；随后 `remove` 永久删除目标文献，`removedFiles=3`，被并入页面的签名地址立即失效，确认并入的原件也一并清除

## 五、仍需用户执行

- **正式发布站点**：手机扫码需要稳定的公网 HTTPS 地址，预览地址会变化，且预览环境的访问限制不能替代正式验收。发布后请用手机**关闭 Wi‑Fi**、走移动网络与微信实测：相册多次加入、拍照、排序、确认整批上传，并验证关闭电脑页面后后台仍继续识别。
- 微信自身的选择器限制（如单次最多 9 张）无法由网页解除。

## 六、数据保护

- 本机历史文献元数据、卡片与阅读进度会同步；旧的 Blob/本机服务地址对应的原件不会凭空迁入云端，需用户重新提供。
- 新上传原件直接存云端私有桶，公开读取被拒。
- 「最近删除」保留 30 天；部署与测试不得永久清理用户数据。
- 旧上传 token 只能关联尚未归属其他书库的历史批次。

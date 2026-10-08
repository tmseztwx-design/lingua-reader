# Enter 云端部署：现状、约束与复现步骤

这份清单针对已连接的 `lingua-reader` Cloud（`spb-t4nu9v7279pycm5l`）。不新建 Cloud、不换账号、不删除历史用户文件。

## 一、当前状态（2026-10-04 已由平台工具完成）

- **迁移已执行**：`supabase/migrations/20261003090000_cloud_library_queue.sql`
  - 新增 `scribe_libraries`、`scribe_library_entries`、`scribe_runtime_settings`（三张表均开启 RLS，且已 `revoke` 给 anon/authenticated，只授权 service_role）
  - `scribe_cloud_sessions` 增加 `library_id`、`deleted_at`；`scribe_cloud_files` 增加 `attempts`、`lease_id`、`lease_until`、`retry_at`（原表与原数据保留，仅加列）
  - 新增服务端函数：`scribe_write_entry`、`scribe_claim_page`、`scribe_finish_page`、`scribe_cleanup_candidates`（仅 service_role 可执行）
  - 注册 cron 任务 `scribe-background-ocr`，每分钟调用 `scribe-queue`
- **四个后端函数已部署**：`scribe-mobile-upload`、`scribe-ocr`、`scribe-library`、`scribe-queue`
  - JWT 校验按 `supabase/config.toml` 关闭；`scribe-queue` 另外要求私有 `x-scribe-worker-key`（来自 `scribe_runtime_settings`，仅服务端可读）
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
2. 执行 `supabase/migrations/20261003090000_cloud_library_queue.sql`。
3. 运行 `pnpm bundle:functions`，逐个部署四个函数的 `index.ts`。
4. 检查 `cron.job` 中 `scribe-background-ocr` 为 active，且 `cron.job_run_details` 有成功记录。
5. 运行 `pnpm test` 与 `pnpm build`。
6. 运行 `node test/cloud-live.mjs`：只创建合成 TXT 批量与独立书库，不使用用户文件，结束时软删除自己的批次。

## 四、验收证据（本次实测）

- `node test/cloud-live.mjs` → PASS：私密上传、页序（倒序完成仍按确认顺序）、**无浏览器参与的后台自动识别**、跨设备同步、worker 鉴权
- `pnpm test` → 7 项通过
- 界面实测（jsdom 驱动真实页面 + 真实云函数）：生成云端二维码不再出现 `Function not found`，状态显示「云端通道已就绪」，随后后台队列自动完成识别
- 函数探针：`scribe-mobile-upload` 410、`scribe-ocr` 410、`scribe-library` 401、`scribe-queue` 403（均为业务级应答，说明函数已正常启动）

## 五、仍需用户执行

- **正式发布站点**：手机扫码需要稳定的公网 HTTPS 地址，预览地址会变化，且预览环境的访问限制不能替代正式验收。发布后请用手机**关闭 Wi‑Fi**、走移动网络与微信实测：相册多次加入、拍照、排序、确认整批上传，并验证关闭电脑页面后后台仍继续识别。
- 微信自身的选择器限制（如单次最多 9 张）无法由网页解除。

## 六、数据保护

- 本机历史文献元数据、卡片与阅读进度会同步；旧的 Blob/本机服务地址对应的原件不会凭空迁入云端，需用户重新提供。
- 新上传原件直接存云端私有桶，公开读取被拒。
- 「最近删除」保留 30 天；部署与测试不得永久清理用户数据。
- 旧上传 token 只能关联尚未归属其他书库的历史批次。

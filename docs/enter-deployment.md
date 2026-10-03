# Enter 云端补齐：部署验收清单

这份清单用于已连接的 `lingua-reader` 项目，不创建新 Cloud、不更换账号，不删除历史用户文件。

## 必须先部署后端，再发布前端

1. 从 `codex/cloud-completion` 分支取得完整改动。不要只复制前端页面，也不要回退 Enter 原先生成的 Supabase 客户端配置。
2. 在现有 Cloud `spb-t4nu9v7279pycm5l` 执行 `supabase/migrations/20261003090000_cloud_library_queue.sql`。保留原两张表及 `scribe-pages` 私有桶。先检查 `pg_cron` / `pg_net` 可用；不可用时停止发布并报告，不退回浏览器处理队列。迁移应在一个事务中执行。
3. 部署 `scribe-library`、`scribe-queue`、`scribe-mobile-upload`、`scribe-ocr` 与 `_shared`。保留原有服务端 `AI_API_TOKEN_3ef6055a44e1` 配置；服务角色、AI 密钥和调度密钥不得进入前端。
4. 按 `supabase/config.toml` 设置函数。`scribe-queue` 由私密请求头鉴权，不能通过公开 anon key 调用。
5. 检查 `cron.job` 中 `scribe-background-ocr` 每分钟执行，URL 指向上述 Cloud 的 `scribe-queue`，`cron.job_run_details` 与网络请求日志显示成功。确认 EdgeRuntime.waitUntil 在此平台受到支持。
6. 使用 Node.js 22+ 安装锁定依赖，执行 `npm test`、四个函数的 Deno 类型检查、`npm run build`。
7. 执行 `node test/cloud-live.mjs`。脚本只新建独立验收书库，上传两页合成 TXT，故意倒序完成上传；只提交一次，不主动调用 OCR。验证后台自行完成、页序正确、原件私有、跨设备读取进度、后台接口鉴权，最后将自己的验收批次软删除。不得测试清空真实书库。
8. 后端验收通过后，将前端改动同步到 Enter 所用分支并正式发布。提供正式 HTTPS 地址和部署版本，而不是只提供 `live-preview.enter.pro` 地址。
9. 在正式地址检查书库/设置/上传页面、同步码连接、新的二维码与 `mobile.html`。手机关闭 Wi-Fi 后，用微信扫码实测相册多次加入、拍照、排序、确认整批上传；全部原件送达后关闭电脑页面，验证后台继续。微信选择器自身限制不能由网页解除。

## 数据保护

- 本机历史文献元数据、卡片和阅读进度会同步；旧本机服务 URL 或 Blob URL 对应的原件不会凭空迁入云端，必须由用户重新提供原文件。新上传原件直接保存在云端。
- 最近删除保留 30 天；测试或部署不得主动永久清理用户数据。
- 旧上传 token 仅能关联尚未归属其他书库的历史批次，不能覆盖其归属。
- 同步冲突保留最新本机草稿副本；旧设备不自动覆盖新设备版本。
- 若任何数据库迁移、后台调度或云验收失败，不发布依赖新接口的前端，报告具体错误和未完成项。

## 已完成的本机检查

七项自动测试覆盖页面脚本解析、空书库可用性、同步期间编辑、版本冲突备份、电脑云端上传及排序、SQL 队列租约和重试、删除保留期与隔离；构建及四个云函数类型检查通过。

本机检查不能证明云端已部署，也不能替代移动网络/微信和真实图片 OCR 的验收。

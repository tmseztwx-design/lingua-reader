# Scribe · 英语专著精读学习平台

Scribe 支持文献导入、按原页顺序的互动精读、词汇/短语/句子收藏、复习和阅读记录。本仓库合并了 Enter Pro 的云端书库与后台识别，以及 Kimi 的可选 Linux/Docker 本地服务。

## 推荐方式：Enter 云端

网站现在必须使用账号密码登录，不开放自行注册。最高管理员通过 [账号控制台](http://127.0.0.1:8080/?admin=1) 创建账号、重置密码、停用/启用账号。不同设备登录同一账号即可访问同一独立书库，不再输入内测码或分享书库同步码。参见 [账号系统部署与迁移](docs/managed-accounts.md)。

手机和电脑可在不同网络下，把原件上传至 Enter 云私有存储。登录后的用户生成短时扫码上传通道；用户在手机端确认顺序后整批提交，后台逐页识别；原件全部送达后，即使关闭网页或电脑，队列仍会继续。扫码通道只提供限时的本批次上传权限，不开放书库浏览或账号管理。

微信内可以分多次加入相册图片、手机文件或拍照，再统一排序；微信文件选择器本身的单次选择限制无法由网页解除。历史本机文献只迁移已保存文本和学习数据，旧本地 URL/Blob URL 的原件不会自动上传。书籍移入最近删除后保留 30 天；永久清理会由云端删除对应原件。

云端部署前，按 [Enter 部署清单](docs/enter-deployment.md) 在已连接的 Cloud 上执行迁移、重新生成并部署六个函数、核对后台调度，再运行合成验收。不要只发布前端；未部署的接口会使上传和同步失效。正式发布后，应使用正式 HTTPS 地址生成二维码，并用手机移动网络实测。当前支持 JPG/PNG、TXT、DOCX 和 PDF；旧版 DOC/HEIC 在云识别路径仍有格式限制。内测期间界面可以自由浏览，但云端同步与手机上传需要内测码：由管理员在**独立的管理后台**（`<站点地址>/admin.html`，需管理口令）里生成并分发，一个内测码对应一份独立数据，可在多台设备登录同一份数据，本机保存后长期有效。识别、逐段翻译、点词释义与划选解释都会消耗项目 AI 额度；逐段译文随页面入库，点词释义按「单词 + 所在句子」缓存，重复阅读不会重复计费。阅读区可以按页微调顺序（写回云端页序）、也可以用「＋ 添加页面」把新扫描的页面续接到已有文献末尾。

## 本机开发

需要 Node.js 22+。仓库使用 `pnpm-lock.yaml`：

```sh
pnpm install --frozen-lockfile
pnpm dev
```

开发预览默认在 `http://localhost:8080`；云端能力要求 Enter 后端已部署。若要使用电脑直连的本地通道，另行执行：

```sh
pnpm build
pnpm start
```

本地服务运行在 `http://localhost:4174`。macOS 默认使用 Vision OCR；安装 Python 依赖并设置 `SCRIBE_OCR_ENGINE=paddle` 可切换到 Kimi 增加的 PaddleOCR 工作者。手机使用本机通道时，电脑与手机须处于同一可互通网络。

## 可选方式：私有 Docker 服务

Kimi 的 Linux/Docker 路径保留为**独立的自托管模式**，不是 Enter 云端数据库与后台队列的替代品。它提供 Node 上传 API、持久化的上传会话、PDF/图片/DOCX 的 Linux OCR。自托管时在页面切换到“本机直连/独立服务器”通道；如果由公网 HTTPS 域名访问，二维码可以跨网络打开。此模式的学习记录仍主要保存在浏览器，不提供 Enter 云端的跨设备书库同步与持久后台队列。

账号版本使用云端账号/存储接口，`server.mjs` 默认关闭旧的免登录本机上传 API，不能把旧上传接口作为绕过账号的通道。旧 Node/Python/Linux 识别代码及原文件仍保留，仅隔离冒烟测试可以通过 `NODE_ENV=test` 和 `SCRIBE_LEGACY_API_TEST=1` 运行旧协议。不要在面向用户的环境开启该测试开关。单实例运行并挂载持久卷；这里不代表已部署 Docker 服务。

```sh
docker build -t scribe-reader .
docker run --rm -p 4174:4174 -v /your/private/data:/data \
  -e SCRIBE_PUBLIC_URL=https://your-private-domain.example scribe-reader
```

`SCRIBE_PUBLIC_URL` 应为实际可访问的 HTTPS 根地址；`SCRIBE_DATA_DIR` 默认 `/data/uploads`，`PORT` 默认 `4174`。如自托管服务需要跨公网供手机使用，请先确保域名、TLS、认证代理和持久卷均已配置。`SCRIBE_OCR_LANG` 可指定 PaddleOCR 语言。OCR 准确度受原件清晰度与版式影响，失败页会保留原件与错误信息。

## 验证

```sh
pnpm test
pnpm build
pnpm bundle:functions
pnpm check
```

真实云端验收另运行 `node test/cloud-live.mjs`；它需要已部署的 Enter Cloud。Docker 构建与真实手机扫码也须分别在可用环境中验证。

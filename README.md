# Scribe · 英语专著精读学习平台

Scribe 支持文献导入、按原页顺序的互动精读、词汇/短语/句子收藏、复习和阅读记录。本仓库合并了 Enter Pro 的云端书库与后台识别，以及 Kimi 的可选 Linux/Docker 本地服务。

## 推荐方式：Enter 云端

手机和电脑可在不同网络下，把原件上传至 Enter 云私有存储。用户在手机端确认顺序后整批提交，后台逐页识别；原件全部送达后，即使关闭网页或电脑，队列仍会继续。另一设备可通过设置中的私密同步码连接同一书库。同步码等同访问凭证，请勿公开分享。

微信内可以分多次加入相册图片、手机文件或拍照，再统一排序；微信文件选择器本身的单次选择限制无法由网页解除。历史本机文献只迁移已保存文本和学习数据，旧本地 URL/Blob URL 的原件不会自动上传。书籍移入最近删除后保留 30 天；永久清理会由云端删除对应原件。

云端部署前，按 [Enter 部署清单](docs/enter-deployment.md) 在已连接的 Cloud 上执行迁移、重新生成并部署四个函数、核对后台调度，再运行合成验收。不要只发布前端；未部署的接口会使上传和同步失效。正式发布后，应使用正式 HTTPS 地址生成二维码，并用手机移动网络实测。当前支持 JPG/PNG、TXT、DOCX 和 PDF；旧版 DOC/HEIC 在云识别路径仍有格式限制。识别会消耗项目 AI 额度。

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

自托管服务当前没有用户账号和独立 API 鉴权；**只应部署在受信任的私人环境或经认证的反向代理后面，不要把容器端口直接公开给不受信任的用户**。单实例运行并挂载持久卷；没有卷时，重新部署可能丢失上传原件。容器构建需联网安装 Python OCR 依赖，首次识别还可能下载模型。这里仅保留、验证构建路径，不代表本 PR 已部署 Docker 服务。

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

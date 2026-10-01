# Scribe · AI 英语专著精读学习平台

一个围绕英文文献精读、词汇/短语/句子收集、复习与学习记录的轻量学习平台。网页是原生 HTML/CSS/JS；Node 服务负责文件上传、原页保存和 OCR 任务。学习进度目前保存在当前浏览器的 LocalStorage，不会跨浏览器/设备同步。

## 本机预览

```sh
npm ci
npm start
```

打开 <http://localhost:4174>。macOS 本机默认使用 Vision OCR；Linux/Docker 使用 PaddleOCR。

## Enter / Docker 部署

部署目标必须支持 Docker（或常驻 Node.js 服务）、后台处理进程、HTTPS 自定义域名和持久化磁盘卷。纯静态站点托管不能承载上传 API 或 OCR worker。当前会话/任务状态使用单进程内存，实例数先设为 1；多实例部署需要先迁移共享会话和任务队列。

1. 将仓库连接到 Enter，选择使用仓库根目录的 `Dockerfile` 构建。
2. 设置服务监听端口 `4174`，并将域名的 HTTPS 流量转发到该端口。
3. 添加持久化磁盘卷并挂载到 `/data`。文献原件、会话元数据、识别清单和 OCR 模型缓存依赖此目录；没有持久化卷，实例重启或重新部署可能丢失数据。
4. 配置环境变量：

   | 变量 | 用途 |
   | --- | --- |
   | `PORT` | 平台分配的端口；若平台要求动态端口，请设为平台提供的值 |
   | `SCRIBE_PUBLIC_URL` | 用户实际访问的 HTTPS 根网址，例如 `https://reader.example.com`，不要以 `/` 结尾；二维码据此生成 |
   | `SCRIBE_DATA_DIR` | 持久化上传目录；默认 `/data/uploads` |
   | `SCRIBE_OCR_LANG` | PaddleOCR 语言，默认 `en`，需要中英混排时可设为 `ch` |

5. 在 Enter 配置自定义域名与 HTTPS，并按云厂商要求完成备案后，再用真实域名生成二维码。手机和电脑无需连接同一 Wi‑Fi；两端都需要能访问该公网域名。
6. 首次 OCR 会初始化 PaddleOCR 并下载模型。容器构建和首次启动需要访问依赖/模型源；模型缓存位于持久化 `/data/home`。

`Dockerfile` 安装 Linux CPU 版 PaddlePaddle/PaddleOCR、PDF 渲染、DOCX 与 HEIC 支持。容器持久化目录应限制访问权限。手机上传会经由部署服务器暂存；二维码令牌空闲一小时后过期，未提交会话的文件随后清理。已导入的文献原页会保留，直到用户在书库删除它。学习库本身仍只存当前浏览器；此版本没有多用户账号、云端数据库或设备间同步。

OCR 会按 PDF 页序和手机确认的队列顺序输出。无法识别的页面保留原件并标明错误，方便重试或核对；OCR 准确度受图片清晰度、歪斜和版面影响，不能保证每页无误。

## 验证

```sh
node --check server.mjs
python3 -m py_compile ocr_worker.py
```

容器构建：`docker build -t scribe-reader .`

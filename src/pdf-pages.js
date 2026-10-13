// 在浏览器里把 PDF 逐页渲染成 JPEG：一页一个文件，上传、识别、译文、原页查看都按页进行。
// 这样再大的 PDF（扫描版几十 MB、上百页）也不会撞上云端单次读取上限，也不会把整本书塞进一页。
// pdf.js 按需加载（只有选了 PDF 才下载），字体/CMap/解码器由 vite 插件挂在 /pdfjs/ 下。
import workerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";

const LONG_EDGE = 2000; // 识别清晰度与文件体积的平衡点：约 0.3–0.8 MB / 页
const QUALITY = 0.85;
let library = null;

async function pdfjs() {
  if (!library) {
    library = import("pdfjs-dist/legacy/build/pdf.min.mjs").then((module) => {
      module.GlobalWorkerOptions.workerSrc = workerUrl;
      return module;
    });
  }
  return library;
}

export function isPdf(file) {
  return /\.pdf$/i.test(file?.name || "") || file?.type === "application/pdf";
}

function canvasBlob(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("页面图像生成失败"))), "image/jpeg", QUALITY);
  });
}

// onProgress(done, total)；返回按页序排列的 File[]，文件名形如「原名 · 第 03 页.jpg」以便排序。
export async function explodePdf(file, onProgress) {
  const { getDocument } = await pdfjs();
  const base = new URL("/pdfjs/", location.href).href;
  const task = getDocument({
    data: new Uint8Array(await file.arrayBuffer()),
    cMapUrl: base + "cmaps/",
    cMapPacked: true,
    standardFontDataUrl: base + "standard_fonts/",
    wasmUrl: base + "wasm/",
    iccUrl: base + "iccs/",
  });
  const pdf = await task.promise;
  const total = pdf.numPages, stem = file.name.replace(/\.pdf$/i, ""), width = String(total).length;
  const pages = [];
  try {
    for (let number = 1; number <= total; number += 1) {
      const page = await pdf.getPage(number);
      const natural = page.getViewport({ scale: 1 });
      const scale = Math.min(4, LONG_EDGE / Math.max(natural.width, natural.height));
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement("canvas");
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const context = canvas.getContext("2d");
      context.fillStyle = "#ffffff"; // 透明背景转 JPEG 会变黑，先铺白底（画布像素，不是界面颜色）
      context.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: context, canvas, viewport }).promise;
      const blob = await canvasBlob(canvas);
      page.cleanup();
      canvas.width = canvas.height = 0; // 及时释放手机内存
      const label = String(number).padStart(width, "0");
      pages.push(new File([blob], `${stem} · 第 ${label} 页.jpg`, { type: "image/jpeg", lastModified: file.lastModified }));
      onProgress?.(number, total);
    }
  } finally {
    // destroy 在加载任务上，不在文档对象上；调错对象会让已成功拆出的页被误判为失败。
    await task.destroy();
  }
  return pages;
}

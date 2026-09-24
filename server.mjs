import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import QRCode from 'qrcode';

const root = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(root, 'dist');
const uploadRoot = path.join(root, 'uploads');
const documentRoot = path.join(uploadRoot, 'documents');
const port = Number(process.env.PORT || 4174);
const ttlMs = 15 * 60 * 1000;
const maxBytes = 100 * 1024 * 1024;
const allowedExtensions = new Set(['.pdf', '.doc', '.docx', '.jpg', '.jpeg', '.png', '.heic', '.heif']);
const mimeTypes = {
  '.css': 'text/css; charset=utf-8', '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.ico': 'image/x-icon'
};
const sessions = new Map();
const documents = new Map();

function json(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}

function localAddress() {
  const candidates = Object.values(os.networkInterfaces()).flat().filter((item) => item && item.family === 'IPv4' && !item.internal);
  const privateAddress = candidates.find((item) => /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(item.address));
  return (privateAddress || candidates[0] || {}).address || null;
}

function publicBase() {
  if (process.env.SCRIBE_PUBLIC_URL) return process.env.SCRIBE_PUBLIC_URL.replace(/\/$/, '');
  const address = localAddress();
  return address ? `http://${address}:${port}` : null;
}

function cleanName(value) {
  return String(value || 'untitled').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/^\.+/, '').slice(0, 160) || 'untitled';
}

function decodeFileName(headers) {
  try {
    if (headers['x-file-name-b64']) return cleanName(Buffer.from(headers['x-file-name-b64'], 'base64').toString('utf8'));
  } catch {}
  return cleanName(headers['x-file-name']);
}

function mimeForName(name) {
  return mimeTypes[path.extname(name).toLowerCase()] || 'application/octet-stream';
}

function sessionFor(id) {
  const session = sessions.get(id);
  if (!session || session.expiresAt <= Date.now()) return null;
  return session;
}

function sessionInfo(session) {
  const files = [...session.files]
    .sort((left, right) => left.queueOrder - right.queueOrder || left.receivedOrder - right.receivedOrder)
    .map(({ filePath, ...file }) => file);
  return { id: session.id, expiresAt: new Date(session.expiresAt).toISOString(), files };
}

function recoverSessionFromDisk(names) {
  if (!Array.isArray(names) || !names.length || !fs.existsSync(uploadRoot)) return null;
  let directories = [];
  try { directories = fs.readdirSync(uploadRoot, { withFileTypes: true }); } catch { return null; }
  let best = null;
  for (const entry of directories) {
    if (!entry.isDirectory() || entry.name === 'documents' || !validId(entry.name)) continue;
    const directory = path.join(uploadRoot, entry.name);
    let stored = [];
    try { stored = fs.readdirSync(directory); } catch { continue; }
    const files = [];
    for (let index = 0; index < names.length; index += 1) {
      const name = cleanName(names[index]);
      const suffix = `-${name}`;
      const storedName = stored.find((item) => item.endsWith(suffix));
      if (!storedName) continue;
      const filePath = path.join(directory, storedName);
      let stat;
      try { stat = fs.statSync(filePath); } catch { continue; }
      if (!stat.isFile()) continue;
      const fileId = storedName.slice(0, -suffix.length);
      files.push({ id: fileId, name, type: mimeForName(name), size: stat.size, queueOrder: index, receivedOrder: index, uploadedAt: stat.mtime.toISOString(), filePath });
    }
    if (files.length && (!best || files.length > best.files.length)) {
      best = { id: entry.name, expiresAt: Date.now() + ttlMs, files, nextOrder: names.length, directory, recoveredFromDisk: true };
    }
  }
  if (best) sessions.set(best.id, best);
  return best;
}

function validId(value) {
  return /^[A-Za-z0-9_-]+$/.test(String(value || ''));
}

function documentDirectory(id) {
  return path.join(documentRoot, id);
}

function documentManifest(id) {
  return path.join(documentDirectory(id), 'manifest.json');
}

function readDocument(id) {
  if (!validId(id)) return null;
  if (documents.has(id)) return documents.get(id);
  try {
    const document = JSON.parse(fs.readFileSync(documentManifest(id), 'utf8'));
    if (!document || document.id !== id || !Array.isArray(document.pages)) return null;
    documents.set(id, document);
    return document;
  } catch {
    return null;
  }
}

function documentInfo(document) {
  return {
    id: document.id,
    createdAt: document.createdAt,
    pages: document.pages.map(({ storedName, ...page }) => ({
      ...page,
      ...(storedName ? { url: `/api/documents/${document.id}/pages/${page.id}` } : {})
    }))
  };
}

function commitSession(res, id, requestedNames) {
  const session = sessionFor(id);
  if (!session) return json(res, 410, { error: '此扫码通道已过期，请重新上传。' });
  const sourceFiles = [...session.files].sort((left, right) => left.queueOrder - right.queueOrder || left.receivedOrder - right.receivedOrder);
  if (!sourceFiles.length) return json(res, 409, { error: '还没有收到可保存的页面。' });
  if (requestedNames && (!Array.isArray(requestedNames) || requestedNames.length > 500 || requestedNames.some((name) => typeof name !== 'string' || name.length > 200))) {
    return json(res, 400, { error: '页面清单格式不正确。' });
  }
  const ordered = requestedNames && requestedNames.length
    ? requestedNames.map((name) => ({ name: cleanName(name), file: sourceFiles.find((item) => item.name === cleanName(name)) }))
    : sourceFiles.map((file) => ({ name: file.name, file }));

  const documentId = crypto.randomBytes(12).toString('base64url');
  const directory = documentDirectory(documentId);
  try {
    fs.mkdirSync(directory, { recursive: true });
    const pages = ordered.map(({ name, file }, index) => {
      const pageId = crypto.randomBytes(9).toString('base64url');
      const extension = path.extname(name).toLowerCase();
      const storedName = file ? `${String(index + 1).padStart(4, '0')}-${pageId}${extension}` : '';
      if (file) fs.copyFileSync(file.filePath, path.join(directory, storedName));
      return {
        id: pageId,
        order: index + 1,
        name,
        type: file ? file.type : mimeForName(name),
        size: file ? file.size : 0,
        storedName,
        missing: !file
      };
    });
    const document = { id: documentId, createdAt: new Date().toISOString(), pages };
    fs.writeFileSync(documentManifest(documentId), JSON.stringify(document));
    documents.set(documentId, document);
    sessions.delete(id);
    if (!session.recoveredFromDisk) fs.rm(session.directory, { recursive: true, force: true }, () => {});
    return json(res, 201, documentInfo(document));
  } catch {
    fs.rm(directory, { recursive: true, force: true }, () => {});
    return json(res, 500, { error: '无法保存原页，请检查本机磁盘空间后重试。' });
  }
}

function commitRequest(req, res, id) {
  let body = '';
  req.on('data', (chunk) => {
    body += chunk.toString();
    if (body.length > 100_000) req.destroy();
  });
  req.on('end', () => {
    let input = {};
    try { if (body) input = JSON.parse(body); } catch { return json(res, 400, { error: '页面清单格式不正确。' }); }
    commitSession(res, id, input.names);
  });
}

function routeDocument(req, res, pieces) {
  const id = pieces[2];
  const document = readDocument(id);
  if (!document) return json(res, 404, { error: '未找到已保存的文献页面。' });
  if (req.method === 'GET' && pieces.length === 3) return json(res, 200, documentInfo(document));
  if (req.method === 'GET' && pieces.length === 5 && pieces[3] === 'pages') {
    const page = document.pages.find((item) => item.id === pieces[4]);
    if (!page || !page.storedName) return json(res, 404, { error: '未找到此页面。' });
    const target = path.resolve(documentDirectory(id), page.storedName);
    if (!target.startsWith(`${documentDirectory(id)}${path.sep}`)) return json(res, 403, { error: '无权访问此页面。' });
    fs.stat(target, (error, stat) => {
      if (error || !stat.isFile()) return json(res, 404, { error: '未找到此页面。' });
      res.writeHead(200, { 'Content-Type': page.type || 'application/octet-stream', 'Content-Length': stat.size, 'Cache-Control': 'no-store' });
      fs.createReadStream(target).pipe(res);
    });
    return;
  }
  return json(res, 405, { error: '不支持的操作' });
}

function serveFile(res, target) {
  fs.stat(target, (error, stat) => {
    if (error || !stat.isFile()) return json(res, 404, { error: '未找到页面' });
    const extension = path.extname(target).toLowerCase();
    res.writeHead(200, { 'Content-Type': mimeTypes[extension] || 'application/octet-stream', 'Cache-Control': 'no-store', 'Content-Length': stat.size });
    fs.createReadStream(target).pipe(res);
  });
}

async function makeSession(res) {
  const base = publicBase();
  if (!base) return json(res, 503, { error: '未找到可供手机访问的局域网地址。请确认电脑已连接 Wi‑Fi。' });
  const id = crypto.randomBytes(18).toString('base64url');
  const expiresAt = Date.now() + ttlMs;
  const mobileUrl = `${base}/mobile/${id}`;
  const qrDataUrl = await QRCode.toDataURL(mobileUrl, { width: 300, margin: 1, errorCorrectionLevel: 'M', color: { dark: '#17243e', light: '#ffffffff' } });
  sessions.set(id, { id, expiresAt, files: [], nextOrder: 0, directory: path.join(uploadRoot, id) });
  json(res, 201, { id, expiresAt: new Date(expiresAt).toISOString(), mobileUrl, qrDataUrl });
}

function receiveFile(req, res, id) {
  const session = sessionFor(id);
  if (!session) return json(res, 410, { error: '此扫码通道已过期，请在电脑端重新生成二维码。' });
  const name = decodeFileName(req.headers);
  const extension = path.extname(name).toLowerCase();
  const declaredSize = Number(req.headers['content-length'] || 0);
  if (!allowedExtensions.has(extension)) return json(res, 415, { error: '仅支持 PDF、DOC、DOCX、JPG、PNG、HEIC 或 HEIF 文件。' });
  if (declaredSize > maxBytes) return json(res, 413, { error: '单个文件不能超过 100 MB。' });

  fs.mkdirSync(session.directory, { recursive: true });
  const requestedOrder = Number(req.headers['x-queue-order']);
  const queueOrder = Number.isInteger(requestedOrder) && requestedOrder >= 0 ? requestedOrder : session.nextOrder;
  session.nextOrder = Math.max(session.nextOrder, queueOrder + 1);
  const file = { id: crypto.randomBytes(9).toString('base64url'), name, type: String(req.headers['content-type'] || 'application/octet-stream'), size: 0, queueOrder, receivedOrder: session.files.length, uploadedAt: new Date().toISOString() };
  file.filePath = path.join(session.directory, `${file.id}-${name}`);
  const temporaryPath = `${file.filePath}.part`;
  const output = fs.createWriteStream(temporaryPath, { flags: 'wx' });
  let size = 0;
  let failed = false;
  let replied = false;
  const fail = (status, error) => {
    if (replied) return;
    replied = true;
    failed = true;
    output.destroy();
    fs.rm(temporaryPath, { force: true }, () => {});
    json(res, status, { error });
  };
  req.on('data', (chunk) => {
    if (failed) return;
    size += chunk.length;
    if (size > maxBytes) return fail(413, '单个文件不能超过 100 MB。');
    if (!output.write(chunk)) req.pause(), output.once('drain', () => req.resume());
  });
  req.on('aborted', () => fail(499, '上传已取消。'));
  req.on('error', () => fail(500, '上传中断，请重试。'));
  output.on('error', () => fail(500, '无法保存文件，请检查本机磁盘空间。'));
  req.on('end', () => {
    if (!failed) output.end();
  });
  output.on('finish', () => {
    if (failed || replied) return;
    fs.rename(temporaryPath, file.filePath, (error) => {
      if (error) return fail(500, '无法完成文件保存。');
      file.size = size;
      session.files.push(file);
      replied = true;
      json(res, 201, { file: sessionInfo(session).files.find((item) => item.id === file.id) });
    });
  });
}

function routeApi(req, res, url) {
  const pieces = url.pathname.split('/').filter(Boolean);
  if (req.method === 'POST' && url.pathname === '/api/mobile-links') return makeSession(res).catch(() => json(res, 500, { error: '二维码生成失败，请重试。' }));
  if (pieces[0] === 'api' && pieces[1] === 'documents' && pieces[2]) return routeDocument(req, res, pieces);
  if (req.method === 'GET' && url.pathname === '/api/mobile-links/recover') {
    const count = Number(url.searchParams.get('count'));
    let names = [];
    try { names = JSON.parse(url.searchParams.get('names') || '[]'); } catch {}
    const hasMatchingNames = (session) => {
      if (!Array.isArray(names) || !names.length) return true;
      const uploaded = [...session.files].sort((left, right) => left.queueOrder - right.queueOrder || left.receivedOrder - right.receivedOrder);
      return uploaded.length === names.length && uploaded.every((file, index) => file.name === names[index]);
    };
    const candidates = [...sessions.values()]
      .filter((session) => session.expiresAt > Date.now() && Number.isInteger(count) && count > 0 && session.files.length === count && hasMatchingNames(session))
      .sort((left, right) => right.expiresAt - left.expiresAt);
    const session = candidates[0] || recoverSessionFromDisk(names);
    if (!session) return json(res, 404, { error: '没有找到仍可恢复的本次手机上传。' });
    return json(res, 200, sessionInfo(session));
  }
  if (pieces[0] !== 'api' || pieces[1] !== 'mobile-links' || !pieces[2]) return json(res, 404, { error: '未找到接口' });
  const id = pieces[2];
  const session = sessionFor(id);
  if (!session) return json(res, 410, { error: '此扫码通道已过期，请回到电脑端重新生成。' });
  if (req.method === 'GET' && pieces.length === 3) return json(res, 200, sessionInfo(session));
  if (req.method === 'POST' && pieces.length === 4 && pieces[3] === 'commit') return commitRequest(req, res, id);
  if (req.method === 'POST' && pieces.length === 4 && pieces[3] === 'files') return receiveFile(req, res, id);
  if (req.method === 'GET' && pieces.length === 5 && pieces[3] === 'files') {
    const file = session.files.find((item) => item.id === pieces[4]);
    if (!file) return json(res, 404, { error: '文件不存在' });
    res.writeHead(200, { 'Content-Type': file.type, 'Content-Length': file.size, 'Content-Disposition': `attachment; filename="${encodeURIComponent(file.name)}"`, 'Cache-Control': 'no-store' });
    return fs.createReadStream(file.filePath).pipe(res);
  }
  return json(res, 405, { error: '不支持的操作' });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  if (url.pathname.startsWith('/api/')) return routeApi(req, res, url);
  const mobileMatch = url.pathname.match(/^\/mobile\/([A-Za-z0-9_-]+)$/);
  if (mobileMatch) {
    if (!sessionFor(mobileMatch[1])) return json(res, 410, { error: '此扫码通道已过期，请回到电脑端重新生成二维码。' });
    return fs.readFile(path.join(dist, 'mobile.html'), 'utf8', (error, template) => {
      if (error) return json(res, 500, { error: '无法打开移动上传页' });
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(template.replace('__SCRIBE_LINK_TOKEN__', mobileMatch[1]));
    });
  }
  const requested = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
  const target = path.resolve(dist, `.${requested}`);
  if (!target.startsWith(`${dist}${path.sep}`)) return json(res, 403, { error: '无权访问' });
  serveFile(res, target);
});

setInterval(() => {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (session.expiresAt <= now) {
      sessions.delete(id);
      fs.rm(session.directory, { recursive: true, force: true }, () => {});
    }
  }
}, 60_000).unref();

server.listen(port, '0.0.0.0', () => {
  const base = publicBase();
  console.log(`Scribe is running at http://localhost:${port}`);
  if (base) console.log(`Phone upload is available on ${base}`);
});

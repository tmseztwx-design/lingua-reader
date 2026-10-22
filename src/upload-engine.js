// Shared by desktop and mobile. File order is an immutable index, never completion time.
export const MAX_PAGES = 2000;
export const MAX_OBJECT_BYTES = 50 * 1024 * 1024;
export const SOURCE_PART_BYTES = 32 * 1024 * 1024;
const CHUNK = 6 * 1024 * 1024; // Supabase TUS requires 6 MiB chunks.
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function retry(task, {attempts = 4, wait = sleep, onRetry} = {}) {
  for (let attempt = 0; ; attempt++) {
    try { return await task(attempt); }
    catch (error) {
      const status = Number(error?.status || 0);
      if (attempt + 1 >= attempts || (status && ![408, 409, 425, 429].includes(status) && status < 500)) throw error;
      onRetry?.(attempt + 1, error);
      await wait(Math.min(15000, 750 * 2 ** attempt) + Math.random() * 250);
    }
  }
}

// Wait for every lane, even on failure. No orphan uploads can race a user's retry.
export async function runUploadPool(items, worker, {concurrency = 3, onChange = () => {}} = {}) {
  let cursor = 0;
  const errors = [];
  await Promise.all(Array.from({length: Math.min(concurrency, items.length)}, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      const item = items[index];
      if (item.state === 'uploaded') continue;
      item.state = 'uploading'; item.percent = 0; onChange(item, index);
      try {
        await worker(item, index, percent => { item.percent = percent; onChange(item, index); });
        item.state = 'uploaded'; item.percent = 100; item.error = '';
      } catch (error) {
        item.state = 'error'; item.error = error.message; errors.push({index, error});
      }
      onChange(item, index);
    }
  }));
  if (errors.length) {
    const error = new Error(`${errors.length} 个文件暂未送达，已保留成功项；点击重试只补传失败项。${errors[0].error.message}`);
    error.failures = errors;
    throw error;
  }
}

export function xhrTransfer(method, url, body, headers = {}, onProgress, timeout = 180000) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(method, url); xhr.timeout = timeout;
    for (const [key, value] of Object.entries(headers)) xhr.setRequestHeader(key, value);
    xhr.upload.onprogress = event => { if (event.lengthComputable) onProgress?.(Math.round(event.loaded / event.total * 100)); };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) return resolve(xhr);
      const error = new Error(`文件传输失败（${xhr.status}）。`); error.status = xhr.status; reject(error);
    };
    xhr.onerror = () => reject(new Error('网络中断，队列已保留。'));
    xhr.ontimeout = () => reject(new Error('上传暂时超时，正在保留进度以便重试。'));
    xhr.onabort = () => { const error = new Error('上传已中止。'); error.status = 400; reject(error); };
    xhr.send(body);
  });
}

const encode = value => btoa(String.fromCharCode(...new TextEncoder().encode(value)));
async function checkedFetch(url, options) {
  const response = await fetch(url, {...options, signal: AbortSignal.timeout(30000)});
  if (!response.ok) { const error = new Error(`续传请求失败（${response.status}）。`); error.status = response.status; throw error; }
  return response;
}

// Signed tokens authorize this one object only; service-role keys never reach the browser.
// Reconcile HEAD after a dropped PATCH response, rather than sending the same bytes twice.
export async function transferSigned(signed, file, onProgress, checkpoint = {}) {
  if (signed.alreadyUploaded) { onProgress?.(100); return; }
  if (!signed.resumableUrl || !signed.uploadToken || file.size < CHUNK) {
    await retry(() => xhrTransfer('PUT', signed.uploadUrl, file, {'Content-Type': file.type || 'application/octet-stream'}, onProgress));
    return;
  }
  const headers = {'Tus-Resumable': '1.0.0', 'x-signature': signed.uploadToken, 'x-upsert': 'true'};
  let url = checkpoint.url || '';
  if(url){const saved=new URL(url);if(saved.origin!==new URL(signed.resumableUrl).origin||!saved.pathname.startsWith('/storage/v1/upload/resumable/'))throw new Error('暂存的续传地址不安全，请重新建立批次。');}
  const save = async value => { url = value; checkpoint.url = value; await checkpoint.save?.(value); };
  const offsetOf = response => {
    const raw = response.headers.get('Upload-Offset');
    const offset = raw === null ? NaN : Number(raw);
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > file.size) throw new Error('续传位置校验失败，请重试。');
    return offset;
  };
  await retry(async () => {
    let offset = 0;
    if (url) {
      try { offset = offsetOf(await checkedFetch(url, {method: 'HEAD', headers})); }
      catch (error) { if ([404, 410].includes(error.status)) await save(''); else throw error; }
    }
    if (!url) {
      const response = await checkedFetch(signed.resumableUrl, {method: 'POST', headers: {...headers,
        'Upload-Length': String(file.size),
        'Upload-Metadata': Object.entries({bucketName: signed.bucket || 'scribe-pages', objectName: signed.path, contentType: file.type || 'application/octet-stream', cacheControl: '3600'}).map(([key, value]) => key + ' ' + encode(value)).join(',')},
      });
      const location = response.headers.get('Location');
      if (!location) throw new Error('存储服务未返回续传地址。');
      const target = new URL(location, signed.resumableUrl);
      // Never forward a signed credential to an unrelated Location header.
      if (target.origin !== new URL(signed.resumableUrl).origin || !target.pathname.startsWith('/storage/v1/upload/resumable/')) throw new Error('存储服务返回了不安全的续传地址。');
      await save(target.href);
    }
    onProgress?.(Math.floor(offset / file.size * 100));
    while (offset < file.size) {
      const start = offset;
      const chunk = file.slice(start, start + CHUNK);
      const xhr = await xhrTransfer('PATCH', url, chunk, {...headers, 'Content-Type': 'application/offset+octet-stream', 'Upload-Offset': String(start)},
        percent => onProgress?.(Math.min(99, Math.floor((start + chunk.size * percent / 100) / file.size * 100))));
      const raw = xhr.getResponseHeader('Upload-Offset');
      const next = raw === null ? NaN : Number(raw);
      if (next !== start + chunk.size) throw new Error('存储服务未确认完整分片，正在核对续传位置。');
      offset = next;
    }
    onProgress?.(100);
  });
}

export async function uploadCloudFile(call, token, file, order, onProgress, options = {}) {
  const body = {token, name: file.name, size: file.size, mime: file.type, order, role: options.role || 'page',clientId:options.clientId};
  const signed = await retry(() => call('scribe-mobile-upload', {action: 'sign', ...body}));
  if (signed.alreadyUploaded) { onProgress?.(100); return; }
  await transferSigned(signed, file, onProgress, options.checkpoint);
  // If register's response was lost, retry registration, not the file transfer.
  await retry(() => call('scribe-mobile-upload', {action: 'register', token, fileId: signed.fileId, role: body.role}));
}

export function uploadSummary(items) {
  let total = 0, sent = 0, done = 0;
  for (const item of items) {
    total += item.file.size;
    sent += item.file.size * (item.state === 'uploaded' ? 1 : (item.percent || 0) / 100);
    if (item.state === 'uploaded') done++;
  }
  return {done, total: items.length, percent: total ? Math.floor(sent / total * 100) : 0};
}

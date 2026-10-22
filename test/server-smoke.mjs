import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const root = path.resolve(import.meta.dirname, '..');
const dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'scribe-server-test-'));
const port = await new Promise((resolve, reject) => {
  const server = http.createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    server.close(() => resolve(address.port));
  });
});
const base = `http://127.0.0.1:${port}`;
const env = {
  ...process.env,
  NODE_ENV: 'test',
  SCRIBE_LEGACY_API_TEST:'1',
  PORT: String(port),
  SCRIBE_PUBLIC_URL: 'https://reader.example.test',
  SCRIBE_DATA_DIR: path.join(dataDirectory, 'uploads')
};
let child;

function launch() {
  child = spawn(process.execPath, ['server.mjs'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = '';
  child.stdout.on('data', (chunk) => { logs = (logs + chunk).slice(-4000); });
  child.stderr.on('data', (chunk) => { logs = (logs + chunk).slice(-4000); });
  return async () => {
    for (let attempt = 0; attempt < 80; attempt += 1) {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Server exited during startup: ${logs}`);
      try {
        const response = await fetch(`${base}/api/health`);
        if (response.ok) return;
      } catch {}
      await delay(100);
    }
    throw new Error(`Server did not start: ${logs}`);
  };
}

async function stop() {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGTERM');
  await exited;
}

try {
  await launch()();
  let response = await fetch(`${base}/api/health`);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).service, 'scribe-local');
  response = await fetch(`${base}/api/lan-base`);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).base, 'https://reader.example.test');

  response = await fetch(`${base}/api/mobile-links`, { method: 'POST' });
  assert.equal(response.status, 201);
  let session = await response.json();
  assert.match(session.mobileUrl, /^https:\/\/reader\.example\.test\/mobile\//);
  assert.ok(session.qrDataUrl.startsWith('data:image/png;base64,'));

  await stop();
  await launch()();
  response = await fetch(`${base}/api/mobile-links/${session.id}`);
  assert.equal(response.status, 200, 'upload session survives an app restart');
  session = await response.json();
  assert.deepEqual(session.files, []);

  response = await fetch(`${base}/api/mobile-links/${session.id}/files`, {
    method: 'POST',
    headers: {
      'Content-Type': 'text/plain',
      'X-File-Name-B64': Buffer.from('page1.txt').toString('base64'),
      'X-Queue-Order': '0'
    },
    body: 'Education and culture.'
  });
  assert.equal(response.status, 201);
  response = await fetch(`${base}/api/mobile-links/${session.id}/complete`, { method: 'POST' });
  assert.equal(response.status, 200);
  response = await fetch(`${base}/api/mobile-links/${session.id}/commit`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ names: ['page1.txt'] }) });
  assert.equal(response.status, 201);
  const document = await response.json();
  assert.equal(document.pages.length, 1);
  response = await fetch(`${base}/api/documents/${document.id}/pages/${document.pages[0].id}`);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'Education and culture.');
  response = await fetch(`${base}/api/documents/${document.id}`, { method: 'DELETE', headers: { Origin: 'https://reader.example.test' } });
  assert.equal(response.status, 200, 'same-origin document cleanup works behind HTTPS hosting');
  await stop();
  env.NODE_ENV='production';
  // Even accidentally preserving the explicit legacy test flag cannot open production APIs.
  await launch()();
  response=await fetch(`${base}/api/health`);assert.equal((await response.json()).service,'scribe-account-site');
  for(const endpoint of ['/api/mobile-links','/api/documents/unknown','/api/mobile-links/recover?count=1']){
    response=await fetch(base+endpoint,{method:endpoint==='/api/mobile-links'?'POST':'GET'});assert.equal(response.status,401);
  }
  console.log('Server smoke passed: isolated legacy upload regression and production anonymous-API rejection.');
} finally {
  await stop();
  fs.rmSync(dataDirectory, { recursive: true, force: true });
}

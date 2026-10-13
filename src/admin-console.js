// 内测管理后台（admin.html 专用）：生成与作废内测码、查看使用情况。
// 管理口令只在本标签页内保存，每次操作都由服务端校验（scribe-beta 的 adminAuth）；
// 这个页面不接触学生数据，也没有任何书库凭证。

const ADMIN_KEY = 'scribe-beta-admin-console';
const NL = String.fromCharCode(10);
const escapeHtml = (value) => String(value || '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
const formatTime = (value) => {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
};
const password = () => { try { return sessionStorage.getItem(ADMIN_KEY) || ''; } catch { return ''; } };
const remember = (value) => { try { value ? sessionStorage.setItem(ADMIN_KEY, value) : sessionStorage.removeItem(ADMIN_KEY); } catch { /* 隐私模式忽略 */ } };

export function installAdminConsole(cloud) {
  const el = (id) => document.getElementById(id);
  let codes = [];
  let generated = [];

  const say = (message, tone) => {
    const node = el('consoleMessage');
    if (!node) return;
    node.textContent = message || '';
    node.dataset.tone = tone || '';
  };

  async function call(action, body = {}) {
    return cloud.callFunction('scribe-beta', { action, password: password(), ...body });
  }

  function paintGate() {
    const unlocked = Boolean(password());
    el('gate').hidden = unlocked;
    el('console').hidden = !unlocked;
    el('lock').hidden = !unlocked;
    if (!unlocked) el('password').focus();
  }

  function paintStats() {
    const total = codes.length;
    const available = codes.filter((item) => !item.revoked).length;
    const bound = codes.filter((item) => item.bound && !item.revoked).length;
    const devices = codes.reduce((sum, item) => sum + (item.bound && !item.revoked ? Number(item.devices || 1) : 0), 0);
    const documents = codes.reduce((sum, item) => sum + (item.bound ? Number(item.documents || 0) : 0), 0);
    el('statTotal').textContent = total;
    el('statAvailable').textContent = available;
    el('statBound').textContent = bound;
    el('statDevices').textContent = devices;
    el('statDocuments').textContent = documents;
    el('listSummary').textContent = total
      ? '共 ' + total + ' 个 · 可用 ' + available + ' 个 · 已绑定 ' + bound + ' 个 · 累计文献 ' + documents + ' 份'
      : '还没有内测码，先在上方生成。';
  }

  function visibleCodes() {
    const needle = String(el('filter').value || '').trim().toLowerCase();
    if (!needle) return codes;
    return codes.filter((item) => (String(item.mask) + ' ' + String(item.label || '')).toLowerCase().includes(needle));
  }

  function paintList() {
    paintStats();
    const rows = visibleCodes();
    el('rows').innerHTML = rows.length ? rows.map((item) => {
      const status = item.revoked ? '已停用' : item.bound ? '使用中' : '未使用';
      const usage = item.bound ? (item.documents || 0) + ' 文献 · ' + (item.cards || 0) + ' 卡片' : '—';
      return '<article class="row' + (item.revoked ? ' off' : '') + '">'
        + '<div class="row-main"><b>' + escapeHtml(item.mask) + '</b>'
        + '<span class="chip ' + (item.revoked ? 'off' : item.bound ? 'live' : '') + '">' + status + '</span>'
        + '<span class="mono">' + escapeHtml(item.label || '未备注') + '</span></div>'
        + '<button class="ghost" type="button" data-toggle="' + escapeHtml(item.id) + '" data-revoked="' + (item.revoked ? '1' : '0') + '">' + (item.revoked ? '恢复使用' : '停用') + '</button>'
        + '<div class="row-meta"><span>' + usage + '</span>'
        + '<span>设备 ' + (item.bound ? item.devices || 1 : '—') + '</span>'
        + '<span>绑定 ' + escapeHtml(formatTime(item.redeemedAt)) + '</span>'
        + '<span>最近 ' + escapeHtml(formatTime(item.lastSeenAt || item.lastActive)) + '</span></div>'
        + '</article>';
    }).join('') : '<p class="empty">没有符合条件的内测码。</p>';
    el('rows').querySelectorAll('[data-toggle]').forEach((button) => {
      button.onclick = async () => {
        const revoke = button.dataset.revoked !== '1';
        if (revoke && !window.confirm('停用后这个内测码无法再登录新设备；已经登录的设备仍可继续使用。确定停用吗？')) return;
        button.disabled = true;
        say(revoke ? '正在停用…' : '正在恢复…');
        try {
          await call(revoke ? 'adminRevoke' : 'adminRestore', { id: button.dataset.toggle });
          say(revoke ? '已停用。' : '已恢复。');
          await load(true);
        } catch (error) {
          button.disabled = false;
          say(error.message || '操作失败。', 'bad');
        }
      };
    });
  }

  async function load(force) {
    if (!password()) return;
    if (codes.length && !force) { paintList(); return; }
    el('listSummary').textContent = '正在载入…';
    try {
      const result = await call('adminList');
      codes = result.codes || [];
      paintList();
      say('已载入 ' + codes.length + ' 个内测码（明文只在生成时显示）。');
    } catch (error) {
      say(error.message || '列表载入失败。', 'bad');
      el('listSummary').textContent = error.message || '列表载入失败。';
    }
  }

  function paintGenerated() {
    const box = el('generated');
    if (!generated.length) { box.hidden = true; box.innerHTML = ''; return; }
    box.hidden = false;
    box.innerHTML = '<b>这次生成的明文内测码（只显示这一次，请立刻保存）</b>'
      + '<code>' + generated.map((item) => escapeHtml(item.code)).join('<br>') + '</code>'
      + '<div class="actions"><button class="primary" type="button" id="copyCodes">复制全部</button><button class="secondary" type="button" id="downloadCodes">下载 TXT</button></div>';
    el('copyCodes').onclick = async () => {
      const text = generated.map((item) => item.code).join(NL);
      const button = el('copyCodes');
      const fallback = () => {
        // 剪贴板接口在部分浏览器/非 HTTPS 环境下不可用：退回到“临时输入框 + 选中复制”。
        const area = document.createElement('textarea');
        area.value = text;
        area.setAttribute('readonly', 'readonly');
        area.style.position = 'fixed';
        area.style.top = '-1000px';
        document.body.appendChild(area);
        area.select();
        let done = false;
        try { done = document.execCommand('copy'); } catch { done = false; }
        area.remove();
        button.textContent = done ? '已复制' : '请手动选中复制';
      };
      try {
        if (!navigator.clipboard || !navigator.clipboard.writeText) throw new Error('no clipboard');
        await navigator.clipboard.writeText(text);
        button.textContent = '已复制';
      } catch { fallback(); }
    };
    el('downloadCodes').onclick = () => {
      const lines = ['Scribe 内测码', '生成时间：' + new Date().toLocaleString('zh-CN'), '备注：' + (el('label').value.trim() || '—'), ''].concat(generated.map((item) => item.code));
      const blob = new Blob([lines.join(NL) + NL], { type: 'text/plain;charset=utf-8' });
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = 'scribe-beta-codes.txt';
      link.click();
      URL.revokeObjectURL(link.href);
    };
  }

  function bind() {
    el('gateButton').onclick = async () => {
      const input = el('password');
      const entered = String(input.value || '').trim();
      if (!entered) { el('gateMessage').textContent = '请输入管理口令。'; return; }
      el('gateMessage').textContent = '正在校验…';
      try {
        await cloud.callFunction('scribe-beta', { action: 'adminAuth', password: entered });
        remember(entered);
        el('gateMessage').textContent = '';
        input.value = '';
        paintGate();
        await load(true);
      } catch (error) {
        el('gateMessage').textContent = error.message || '口令不正确。';
      }
    };
    el('password').addEventListener('keydown', (event) => { if (event.key === 'Enter') el('gateButton').click(); });
    el('lock').onclick = () => { remember(''); codes = []; generated = []; paintGenerated(); paintGate(); say('已锁定，请重新输入管理口令。'); };
    el('create').onclick = async () => {
      const custom = el('custom').value.split(NL).map((line) => line.trim()).filter(Boolean);
      const count = Math.max(1, Math.min(50, Number(el('count').value) || 1));
      say('正在生成…');
      try {
        const result = await call('adminCreate', { count, label: el('label').value.trim(), codes: custom });
        generated = result.codes || [];
        paintGenerated();
        el('custom').value = '';
        say('已生成 ' + generated.length + ' 个内测码，请立刻复制或下载保存。');
        await load(true);
      } catch (error) { say(error.message || '生成失败。', 'bad'); }
    };
    el('reload').onclick = () => load(true);
    el('filter').oninput = () => paintList();
    el('export').onclick = () => {
      const blob = new Blob([JSON.stringify(codes, null, 2)], { type: 'application/json' });
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = 'scribe-beta-codes.json';
      link.click();
      URL.revokeObjectURL(link.href);
    };
  }

  function mount() {
    bind();
    paintGate();
    if (password()) load(true);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount); else mount();
  return { load, state: () => codes };
}

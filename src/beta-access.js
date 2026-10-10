// 内测码接入：界面照常浏览，只有云端同步与手机上传需要内测码。
// 会话只保存「尾号 + 书库钥匙 + 绑定时间」，钥匙本身就是访问凭证，重开浏览器即自动登录。
// 管理口令只放在本标签页内存/sessionStorage，仅用于服务端校验，从不写入页面以外的存储。

const SESSION = 'scribe-beta-session';
const ADMIN = 'scribe-beta-admin';

const readSession = () => {
  try { return JSON.parse(localStorage.getItem(SESSION) || 'null'); } catch { return null; }
};
const writeSession = (value) => {
  if (value) localStorage.setItem(SESSION, JSON.stringify(value));
  else localStorage.removeItem(SESSION);
};
const adminPassword = () => { try { return sessionStorage.getItem(ADMIN) || ''; } catch { return ''; } };
const rememberPassword = (value) => { try { value ? sessionStorage.setItem(ADMIN, value) : sessionStorage.removeItem(ADMIN); } catch { /* 隐私模式下忽略 */ } };

const escapeHtml = (value) => String(value || '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
const formatTime = (value) => {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
};

export function installBeta(cloud) {
  const listeners = new Set();
  const session = () => readSession();
  const notify = () => listeners.forEach((fn) => { try { fn(session()); } catch { /* 单个订阅者出错不影响其余 */ } });

  async function redeem(code) {
    const current = localStorage.getItem('scribe-library-key') || undefined;
    const result = await cloud.callFunction('scribe-beta', { action: 'redeem', code, libraryKey: current });
    writeSession({ mask: result.mask, label: result.label || '', libraryKey: result.libraryKey, redeemedAt: new Date().toISOString() });
    notify();
    return result;
  }
  function logout() {
    writeSession(null);
    notify();
  }
  async function call(action, body = {}) {
    return cloud.callFunction('scribe-beta', { action, password: adminPassword(), ...body });
  }
  async function unlock(password) {
    const result = await cloud.callFunction('scribe-beta', { action: 'adminAuth', password });
    rememberPassword(password);
    notify();
    return result;
  }
  const isAdmin = () => Boolean(adminPassword());
  function lock() { rememberPassword(''); notify(); }

  const beta = { state: session, redeem, logout, call, unlock, lock, isAdmin, onChange: (fn) => { listeners.add(fn); return () => listeners.delete(fn); } };
  cloud.beta = beta;
  window.__scribeBeta = beta;

  const style = document.createElement('style');
  style.textContent = '.beta-span{grid-column:1/-1}.beta-card [hidden],#betaAdmin [hidden],.nav button[hidden]{display:none!important}.beta-card .panel-head{margin-bottom:10px}.beta-status{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:0 0 12px}.beta-status .chip{font-weight:700}.beta-code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.02em}.beta-admin-list{display:grid;gap:8px}.beta-admin-row{display:grid;grid-template-columns:minmax(150px,1.1fr) minmax(110px,.8fr) auto minmax(90px,.7fr) minmax(120px,1fr) auto;gap:10px;align-items:center;padding:11px 13px;border:1px solid var(--line);border-radius:10px;background:#fff}.beta-admin-row b{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.beta-admin-row small{display:block;color:var(--muted);font-size:11px}.beta-admin-row.off{background:#fbfbfd;color:#9aa5b8}.beta-generated{margin-top:12px;padding:13px;border:1px solid #cfe0d6;border-radius:10px;background:#f4faf7}.beta-generated code{display:block;font:13px/1.7 ui-monospace,SFMono-Regular,Menlo,monospace;user-select:all}.beta-actions{display:flex;gap:8px;flex-wrap:wrap}@media(max-width:900px){.beta-admin-row{grid-template-columns:1fr 1fr}}@media(max-width:560px){.beta-admin-row{grid-template-columns:1fr}}';
  document.head.appendChild(style);

  // ---- 内测码卡片：导入页与设置页各一份 ----
  function card(suffix) {
    const panel = document.createElement('section');
    panel.className = 'card panel beta-card' + (suffix === 'upload' ? ' beta-span' : '');
    panel.id = 'betaCard-' + suffix;
    panel.innerHTML = '<div class="panel-head"><div><div class="eyebrow">内测通道</div><h2>用内测码开启云端</h2><p class="muted tiny" id="betaHint-' + suffix + '">内测期间云端同步与手机上传需要内测码；本地导入、精读与学习卡不受影响。</p></div><span class="chip" id="betaState-' + suffix + '">未开启</span></div><div class="beta-status" id="betaStatus-' + suffix + '"></div><div class="field" id="betaField-' + suffix + '"><label for="betaInput-' + suffix + '">内测码</label><input id="betaInput-' + suffix + '" placeholder="SCRIBE-XXXX-XXXX" autocomplete="off" spellcheck="false"></div><div class="beta-actions"><button class="button primary" type="button" id="betaRedeem-' + suffix + '">开启云端</button><button class="button secondary" type="button" id="betaSwitch-' + suffix + '" hidden>更换内测码</button><button class="button secondary" type="button" id="betaOut-' + suffix + '" hidden>退出登录</button><button class="button ghost small" type="button" id="betaAdminEntry-' + suffix + '">管理入口</button></div><p class="muted tiny" id="betaMessage-' + suffix + '" style="margin-top:10px"></p>';

    const q = (id) => panel.querySelector('#' + id + '-' + suffix);
    const say = (message, tone) => { const node = q('betaMessage'); node.textContent = message || ''; node.style.color = tone === 'bad' ? '#a3512f' : ''; };
    q('betaRedeem').onclick = async () => {
      const input = q('betaInput');
      const code = input.value.trim();
      if (code.length < 6) { say('请输入完整的内测码。', 'bad'); input.focus(); return; }
      say('正在校验内测码…');
      try {
        const result = await redeem(code);
        say(result.reused ? '已把当前数据绑定到这个内测码，正在重新载入…' : '内测码已生效，正在重新载入…');
        window.setTimeout(() => window.location.reload(), 600);
      } catch (error) { say(error.message || '内测码验证失败，请重试。', 'bad'); }
    };
    q('betaSwitch').onclick = () => {
      const field = q('betaField');
      field.hidden = false;
      q('betaInput').value = '';
      q('betaInput').focus();
      say('输入另一个内测码会切换到它的数据；当前设备的内容会先同步到你现在的内测账号。');
    };
    q('betaOut').onclick = () => {
      if (!window.confirm('退出后这台设备将停止云端同步，本机已下载的内容仍可阅读。确定退出吗？')) return;
      logout();
      say('已退出内测码。');
    };
    q('betaAdminEntry').onclick = () => openAdmin();
    return panel;
  }

  function renderCard(suffix) {
    const panel = document.getElementById('betaCard-' + suffix);
    if (!panel) return;
    const current = session();
    const chip = panel.querySelector('#betaState-' + suffix);
    const status = panel.querySelector('#betaStatus-' + suffix);
    const field = panel.querySelector('#betaField-' + suffix);
    const legacy = !current && Boolean(localStorage.getItem('scribe-library-key'));
    chip.textContent = current ? '已开启' : legacy ? '待绑定' : '未开启';
    chip.className = 'chip' + (current ? ' ' : '');
    status.innerHTML = current
      ? '<span class="chip"><i class="dot green"></i>内测码 ' + escapeHtml(current.mask || '已绑定') + '</span>'
        + (current.label ? '<span class="chip">' + escapeHtml(current.label) + '</span>' : '')
        + '<span class="chip">绑定于 ' + escapeHtml(formatTime(current.redeemedAt)) + '</span>'
      : legacy
        ? '<span class="chip"><i class="dot gold"></i>这台设备已有旧版书库，尚未绑定内测码</span>'
        : '<span class="chip"><i class="dot"></i>尚未开启云端</span>';
    field.hidden = Boolean(current);
    panel.querySelector('#betaRedeem-' + suffix).hidden = Boolean(current);
    panel.querySelector('#betaSwitch-' + suffix).hidden = !current;
    panel.querySelector('#betaOut-' + suffix).hidden = !current;
  }

  // ---- 内测管理后台 ----
  let adminView, navButton, listCache = [];
  function openAdmin() {
    if (!adminView) return;
    document.querySelectorAll('.view').forEach((view) => view.classList.toggle('active', view.id === 'betaAdmin'));
    document.querySelectorAll('.nav button').forEach((button) => button.classList.toggle('active', button === navButton));
    const crumb = document.querySelector('#crumb');
    if (crumb) crumb.textContent = '内测管理';
    window.scrollTo({ top: 0, behavior: 'smooth' });
    paintAdmin();
  }

  function buildAdmin() {
    adminView = document.createElement('section');
    adminView.className = 'view';
    adminView.id = 'betaAdmin';
    adminView.innerHTML = '<div class="heading"><div><div class="eyebrow">内测管理</div><h1>内测码</h1><p class="muted">每个内测码对应一份独立数据，可在多台设备登录同一份数据。明文只在生成时显示一次，之后只保留尾号。</p></div><button class="button secondary" type="button" id="betaLock">锁定后台</button></div><div class="settings"><article class="card panel"><div class="panel-head"><div><h2>生成内测码</h2><p class="muted tiny">随机码形如 SCRIBE-XXXX-XXXX；也可以自己指定内容（每行一个）。</p></div></div><div class="field"><label for="betaCount">生成数量</label><input id="betaCount" type="number" min="1" max="50" value="5"></div><div class="field"><label for="betaLabel">备注（给谁用）</label><input id="betaLabel" placeholder="例如：内测用户 A"></div><div class="field"><label for="betaCustom">自定义内测码（可选，每行一个）</label><textarea id="betaCustom" rows="3" placeholder="留空则随机生成"></textarea></div><div class="beta-actions"><button class="button primary" type="button" id="betaCreate">生成</button><button class="button secondary" type="button" id="betaReload">刷新列表</button><button class="button secondary" type="button" id="betaExport">导出列表</button></div><div id="betaGenerated"></div><p class="muted tiny" id="betaAdminMessage" style="margin-top:10px"></p></article><article class="card panel" id="betaAdminGate"><div class="panel-head"><div><h2>需要管理口令</h2><p class="muted tiny">口令只在服务端校验，请勿与内测码混用。</p></div></div><div class="field"><label for="betaPassword">管理口令</label><input id="betaPassword" type="password" autocomplete="current-password"></div><button class="button primary" type="button" id="betaUnlock">进入后台</button><p class="muted tiny" id="betaGateMessage" style="margin-top:10px"></p></article></div><article class="card panel" id="betaAdminList" hidden><div class="panel-head"><div><h2>内测码列表</h2><p class="muted tiny" id="betaListSummary"></p></div></div><div class="beta-admin-list" id="betaRows"></div></article>';
    const anchor = document.getElementById('settings');
    if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(adminView, anchor);
    else document.body.appendChild(adminView);

    navButton = document.createElement('button');
    navButton.type = 'button';
    navButton.dataset.betaAdmin = '1';
    navButton.innerHTML = '<span class="ico">◇</span>内测管理';
    navButton.onclick = openAdmin;
    const nav = document.querySelector('.nav');
    if (nav) nav.appendChild(navButton);

    const say = (message, tone) => { const node = adminView.querySelector('#betaAdminMessage'); node.textContent = message || ''; node.style.color = tone === 'bad' ? '#a3512f' : ''; };
    adminView.querySelector('#betaLock').onclick = () => { lock(); say('已锁定后台。'); };
    adminView.querySelector('#betaUnlock').onclick = async () => {
      const input = adminView.querySelector('#betaPassword');
      const gate = adminView.querySelector('#betaGateMessage');
      if (!input.value) { gate.textContent = '请输入管理口令。'; return; }
      gate.textContent = '正在校验…';
      try { await unlock(input.value); input.value = ''; gate.textContent = ''; paintAdmin(); }
      catch (error) { gate.textContent = error.message || '口令不正确。'; }
    };
    adminView.querySelector('#betaReload').onclick = () => paintAdmin(true);
    adminView.querySelector('#betaCreate').onclick = async () => {
      const custom = adminView.querySelector('#betaCustom').value.split('\n').map((line) => line.trim()).filter(Boolean);
      const count = Number(adminView.querySelector('#betaCount').value) || 1;
      const label = adminView.querySelector('#betaLabel').value.trim();
      say('正在生成…');
      try {
        const result = await call('adminCreate', { count, label, codes: custom });
        renderGenerated(result.codes || []);
        adminView.querySelector('#betaCustom').value = '';
        say('已生成 ' + (result.codes || []).length + ' 个内测码，请立刻复制保存。');
        paintAdmin();
      } catch (error) { say(error.message || '生成失败。', 'bad'); }
    };
    adminView.querySelector('#betaExport').onclick = () => {
      const blob = new Blob([JSON.stringify(listCache, null, 2)], { type: 'application/json' });
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = 'scribe-beta-codes.json';
      link.click();
      URL.revokeObjectURL(link.href);
    };
  }

  function renderGenerated(codes) {
    const box = adminView.querySelector('#betaGenerated');
    if (!codes.length) { box.innerHTML = ''; return; }
    box.className = 'beta-generated';
    box.innerHTML = '<b>这次生成的明文内测码（只显示这一次）</b><code>' + codes.map((item) => escapeHtml(item.code)).join('<br>') + '</code><div class="beta-actions" style="margin-top:10px"><button class="button secondary small" type="button" id="betaCopy">复制全部</button></div>';
    box.querySelector('#betaCopy').onclick = async () => {
      const text = codes.map((item) => item.code).join('\n');
      try { await navigator.clipboard.writeText(text); box.querySelector('#betaCopy').textContent = '已复制'; }
      catch { box.querySelector('#betaCopy').textContent = '请手动选中复制'; }
    };
  }

  async function paintAdmin(force) {
    const gate = adminView.querySelector('#betaAdminGate');
    const list = adminView.querySelector('#betaAdminList');
    const unlocked = isAdmin();
    gate.hidden = unlocked;
    list.hidden = !unlocked;
    if (navButton) navButton.hidden = !unlocked;
    if (!unlocked) {
      const input = adminView.querySelector('#betaPassword');
      if (input && !input.value) input.focus();
      return;
    }
    if (listCache.length && !force) { renderRows(listCache); return; }
    adminView.querySelector('#betaListSummary').textContent = '正在载入…';
    try {
      const result = await call('adminList');
      listCache = result.codes || [];
      renderRows(listCache);
    } catch (error) {
      adminView.querySelector('#betaListSummary').textContent = error.message || '列表载入失败。';
    }
  }

  function renderRows(codes) {
    const rows = adminView.querySelector('#betaRows');
    const active = codes.filter((item) => !item.revoked).length;
    const bound = codes.filter((item) => item.bound).length;
    adminView.querySelector('#betaListSummary').textContent = '共 ' + codes.length + ' 个 · 可用 ' + active + ' 个 · 已绑定 ' + bound + ' 个（明文只在生成时显示）';
    rows.innerHTML = codes.length ? codes.map((item) => {
      const status = item.revoked ? '已停用' : item.bound ? '使用中' : '未使用';
      const devices = item.bound ? ('设备 ' + (item.devices || 1)) : '—';
      return '<div class="beta-admin-row' + (item.revoked ? ' off' : '') + '"><b>' + escapeHtml(item.mask) + '</b><span>' + escapeHtml(item.label || '—') + '</span><span class="chip">' + status + '</span><span>文献 ' + (item.bound ? item.documents || 0 : '—') + ' · 卡片 ' + (item.bound ? item.cards || 0 : '—') + '<small>' + devices + '</small></span><span><small>绑定 ' + escapeHtml(formatTime(item.redeemedAt)) + '</small><small>最近 ' + escapeHtml(formatTime(item.lastSeenAt || item.lastActive)) + '</small></span><button class="button secondary small" type="button" data-beta-toggle="' + escapeHtml(item.id) + '" data-beta-revoked="' + (item.revoked ? '1' : '0') + '">' + (item.revoked ? '恢复' : '停用') + '</button></div>';
    }).join('') : '<p class="muted tiny">还没有内测码，先在上方生成。</p>';
    rows.querySelectorAll('[data-beta-toggle]').forEach((button) => {
      button.onclick = async () => {
        const revoked = button.dataset.betaRevoked !== '1';
        button.disabled = true;
        try {
          await call(revoked ? 'adminRevoke' : 'adminRestore', { id: button.dataset.betaToggle });
          listCache = [];
          await paintAdmin(true);
        } catch (error) {
          button.disabled = false;
          adminView.querySelector('#betaListSummary').textContent = error.message || '操作失败。';
        }
      };
    });
  }

  function mount() {
    if (!document.querySelector('#upload')) return;
    const uploadGrid = document.querySelector('#upload .upload-grid');
    if (uploadGrid && !document.getElementById('betaCard-upload')) uploadGrid.insertBefore(card('upload'), uploadGrid.firstChild);
    const settingsGrid = document.querySelector('#settings .settings-grid');
    if (settingsGrid && !document.getElementById('betaCard-settings')) settingsGrid.prepend(card('settings'));
    buildAdmin();
    paintAdmin();
    beta.onChange(() => { renderCard('upload'); renderCard('settings'); });
    renderCard('upload');
    renderCard('settings');
    adminView.querySelector('#betaUnlock').addEventListener('keydown', (event) => { if (event.key === 'Enter') adminView.querySelector('#betaUnlock').click(); });
    adminView.querySelector('#betaPassword').addEventListener('keydown', (event) => { if (event.key === 'Enter') adminView.querySelector('#betaUnlock').click(); });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount); else mount();
  return beta;
}

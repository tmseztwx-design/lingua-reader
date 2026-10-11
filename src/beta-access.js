// 内测码接入：界面照常浏览，只有云端同步与手机上传需要内测码。
// 会话只保存「尾号 + 书库钥匙 + 绑定时间」，钥匙本身就是访问凭证，重开浏览器即自动登录。
// 管理口令只放在本标签页内存/sessionStorage，仅用于服务端校验，从不写入页面以外的存储。

const SESSION = 'scribe-beta-session';

const readSession = () => {
  try { return JSON.parse(localStorage.getItem(SESSION) || 'null'); } catch { return null; }
};
const writeSession = (value) => {
  if (value) localStorage.setItem(SESSION, JSON.stringify(value));
  else localStorage.removeItem(SESSION);
};

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
  // 内测管理后台是独立的站点（admin.html），学生端只保留内测码登录，不再内置任何后台入口。
  const beta = { state: session, redeem, logout, onChange: (fn) => { listeners.add(fn); return () => listeners.delete(fn); } };
  cloud.beta = beta;
  window.__scribeBeta = beta;

  const style = document.createElement('style');
  style.textContent = '.beta-span{grid-column:1/-1}.beta-card [hidden]{display:none!important}.beta-card .panel-head{margin-bottom:10px}.beta-status{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:0 0 12px}.beta-status .chip{font-weight:700}.beta-actions{display:flex;gap:8px;flex-wrap:wrap}';
  document.head.appendChild(style);

  // ---- 内测码卡片：导入页与设置页各一份 ----
  function card(suffix) {
    const panel = document.createElement('section');
    panel.className = 'card panel beta-card' + (suffix === 'upload' ? ' beta-span' : '');
    panel.id = 'betaCard-' + suffix;
    panel.innerHTML = '<div class="panel-head"><div><div class="eyebrow">内测通道</div><h2>用内测码开启云端</h2><p class="muted tiny" id="betaHint-' + suffix + '">内测期间云端同步与手机上传需要内测码；本地导入、精读与学习卡不受影响。</p></div><span class="chip" id="betaState-' + suffix + '">未开启</span></div><div class="beta-status" id="betaStatus-' + suffix + '"></div><div class="field" id="betaField-' + suffix + '"><label for="betaInput-' + suffix + '">内测码</label><input id="betaInput-' + suffix + '" placeholder="SCRIBE-XXXX-XXXX" autocomplete="off" spellcheck="false"></div><div class="beta-actions"><button class="button primary" type="button" id="betaRedeem-' + suffix + '">开启云端</button><button class="button secondary" type="button" id="betaSwitch-' + suffix + '" hidden>更换内测码</button><button class="button secondary" type="button" id="betaOut-' + suffix + '" hidden>退出登录</button></div><p class="muted tiny" id="betaMessage-' + suffix + '" style="margin-top:10px"></p>';

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

  function mount() {
    if (!document.querySelector('#upload')) return;
    const uploadGrid = document.querySelector('#upload .upload-grid');
    if (uploadGrid && !document.getElementById('betaCard-upload')) uploadGrid.insertBefore(card('upload'), uploadGrid.firstChild);
    const settingsGrid = document.querySelector('#settings .settings-grid');
    if (settingsGrid && !document.getElementById('betaCard-settings')) settingsGrid.prepend(card('settings'));
    beta.onChange(() => { renderCard('upload'); renderCard('settings'); });
    renderCard('upload');
    renderCard('settings');
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount); else mount();
  return beta;
}

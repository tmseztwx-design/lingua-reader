(function () {
  function ready(callback) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', callback);
    else callback();
  }

  ready(function () {
    var input = document.querySelector('#fileInput');
    var drop = document.querySelector('#drop');
    var button = document.querySelector('#process');
    var row = document.querySelector('#fileRow');
    if (!input || !drop || !button || !row) return;

    if (sessionStorage.getItem('scribe-open-import-reader') === '1') {
      sessionStorage.removeItem('scribe-open-import-reader');
      var readerNav = window.document.querySelector('.nav button[data-view="reader"]');
      if (readerNav) readerNav.click();
    }
    new MutationObserver(function () {
      if (!/处理完成/.test(button.textContent)) return;
      sessionStorage.setItem('scribe-open-import-reader', '1');
      setTimeout(function () { window.location.reload(); }, 350);
    }).observe(button, { childList: true, characterData: true, subtree: true });

    var queue = [];
    var working = false;
    var locked = false;
    var currentDocument = null;
    var serverDocument = null;
    var style = document.createElement('style');
    style.textContent = '.computer-queue{display:grid;gap:8px;margin-top:14px}.computer-queue:empty{display:none}.computer-queue-item{display:grid;grid-template-columns:30px minmax(0,1fr) auto;gap:10px;align-items:center;padding:10px 12px;border:1px solid var(--line);border-radius:10px;background:#fff}.computer-queue-number{display:grid;place-items:center;width:27px;height:27px;border-radius:50%;background:#edf2ff;color:#4664b7;font-size:12px;font-weight:800}.computer-queue-copy{min-width:0}.computer-queue-copy b,.computer-queue-copy small{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.computer-queue-copy small{color:var(--muted);font-size:12px}.computer-queue-actions{display:flex;gap:5px}.computer-queue-actions button{width:30px;height:30px;border:1px solid var(--line);border-radius:7px;background:#fff;color:var(--ink)}.computer-queue-actions button:disabled{opacity:.35}.computer-queue-item.uploading{border-color:#aebee7;background:#f5f8ff}.computer-queue-item.uploaded{border-color:#b5dacd;background:#f3faf7}.computer-queue-item.error{border-color:#e5b7ae;background:#fff7f5}.computer-queue-tools{display:flex;justify-content:space-between;align-items:center;gap:10px;margin-top:10px;color:var(--muted);font-size:12px}.computer-queue-tools button{border:0;background:none;color:#8b5260;font:inherit;cursor:pointer}.import-wait{display:inline-flex;align-items:center;gap:8px}.import-wait:before{content:"";width:14px;height:14px;border:2px solid #9eadd4;border-top-color:#4f6fca;border-radius:50%;animation:import-spin .8s linear infinite}@keyframes import-spin{to{transform:rotate(360deg)}}.source-reading-text{width:min(100%,960px);align-self:stretch;justify-self:center;padding:clamp(22px,5vw,64px);background:#fff;color:#253047;border-radius:9px;font:clamp(19px,2vw,27px)/1.8 Georgia,"Noto Serif SC",serif;white-space:pre-wrap;overflow-wrap:anywhere}.source-reading-text .word{cursor:pointer;border-radius:3px}.source-reading-text .word:hover{background:#edf3ff}.source-reading-text .word.captured{background:#dce8ff;box-shadow:inset 0 -2px #5b79ce}.source-original-label{justify-self:start;margin:8px 0 0;color:var(--muted);font-size:12px}@media(max-width:680px){.computer-queue-item{grid-template-columns:27px minmax(0,1fr) auto;padding:9px}.computer-queue-actions{gap:2px}.computer-queue-actions button{width:27px;height:27px}}';
    document.head.appendChild(style);

    input.multiple = true;
    input.accept = '.pdf,.doc,.docx,.jpg,.jpeg,.png,.heic,.heif,.txt';
    var hint = input.parentElement.querySelector('.tiny.muted');
    if (hint) hint.textContent = '支持电脑多选、拖入多个文件；可先调整顺序，再一次性进入本机识别队列。手机端也可拍照或相册多选。';
    var notice = document.querySelector('#upload .notice');
    if (notice) notice.innerHTML = '<b>本机处理说明：</b>图片、扫描 PDF 会逐页进行文字识别；可提取文字的 PDF 和 Word 会保留页序并进入精读。原文件留在这台电脑，无法识别的页也会保留并明确标出。';
    var labels = document.querySelectorAll('#steps .step');
    ['保存原件与顺序', '读取文档页面', '识别图片文字', '整理可读文本', '生成互动精读页', '保留原文与页码', '加入书库和学习区'].forEach(function (label, index) {
      if (labels[index]) labels[index].lastChild.textContent = label;
    });

    var list = document.createElement('div');
    list.className = 'computer-queue';
    list.id = 'computerQueue';
    var tools = document.createElement('div');
    tools.className = 'computer-queue-tools';
    tools.innerHTML = '<span id="computerQueueHint">文件会按列表顺序逐个安全上传</span><button id="clearComputerQueue" type="button">清空队列</button>';
    row.insertAdjacentElement('afterend', list);
    list.insertAdjacentElement('afterend', tools);
    var hintText = tools.querySelector('#computerQueueHint');
    var clearButton = tools.querySelector('#clearComputerQueue');

    function fileNameHeader(name) {
      var bytes = new TextEncoder().encode(name);
      var binary = Array.from(bytes, function (value) { return String.fromCharCode(value); }).join('');
      return btoa(binary);
    }
    function formatBytes(value) {
      return value < 1024 * 1024 ? (value / 1024).toFixed(0) + ' KB' : (value / 1024 / 1024).toFixed(1) + ' MB';
    }
    function render() {
      list.innerHTML = '';
      queue.forEach(function (item, index) {
        var entry = document.createElement('div');
        entry.className = 'computer-queue-item ' + (item.state || '');
        var number = document.createElement('span');
        number.className = 'computer-queue-number';
        number.textContent = String(index + 1);
        var copy = document.createElement('div');
        copy.className = 'computer-queue-copy';
        var name = document.createElement('b');
        name.textContent = item.file.name;
        var meta = document.createElement('small');
        meta.textContent = formatBytes(item.file.size) + (item.state === 'uploaded' ? ' · 已保存' : item.state === 'uploading' ? ' · 上传中' : item.state === 'error' ? ' · 上传失败，可重试' : ' · 等待上传');
        copy.append(name, meta);
        var actions = document.createElement('div');
        actions.className = 'computer-queue-actions';
        [['↑', function () { move(index, -1); }], ['↓', function () { move(index, 1); }], ['×', function () { remove(index); }]].forEach(function (spec, actionIndex) {
          var control = document.createElement('button');
          control.type = 'button';
          control.textContent = spec[0];
          control.setAttribute('aria-label', actionIndex === 0 ? '上移' : actionIndex === 1 ? '下移' : '移除');
          control.disabled = locked || working || (actionIndex === 0 && index === 0) || (actionIndex === 1 && index === queue.length - 1);
          control.addEventListener('click', spec[1]);
          actions.appendChild(control);
        });
        entry.append(number, copy, actions);
        list.appendChild(entry);
      });
      clearButton.disabled = locked || working || !queue.length;
      input.disabled = locked || working;
      button.disabled = !queue.length || working || (!locked && !queue.length);
      if (!locked && !working) button.textContent = queue.length ? '上传并处理全部 ' + queue.length + ' 个文件' : '开始本地处理';
      if (queue.length && !locked && !working) hintText.textContent = '拖动以外也可用 ↑ ↓ 排序；上传开始后顺序锁定';
    }
    function move(index, delta) {
      if (locked || working) return;
      var target = index + delta;
      if (target < 0 || target >= queue.length) return;
      var item = queue[index];
      queue[index] = queue[target];
      queue[target] = item;
      render();
    }
    function remove(index) {
      if (locked || working) return;
      queue.splice(index, 1);
      render();
    }
    function addFiles(files) {
      if (locked || working) return;
      Array.from(files || []).forEach(function (file) {
        queue.push({ file: file, state: '' });
      });
      if (queue.length) {
        row.classList.add('show');
        document.querySelector('#fileName').textContent = queue.length + ' 个文件已加入队列';
        document.querySelector('#fileMeta').textContent = '确认顺序后，整批处理';
        render();
      }
    }

    document.addEventListener('change', function (event) {
      if (event.target !== input) return;
      event.stopImmediatePropagation();
      addFiles(input.files);
      input.value = '';
    }, true);
    document.addEventListener('drop', function (event) {
      if (!event.target.closest || !event.target.closest('#drop')) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      drop.classList.remove('drag');
      addFiles(event.dataTransfer && event.dataTransfer.files);
    }, true);
    document.addEventListener('dragover', function (event) {
      if (event.target.closest && event.target.closest('#drop')) event.preventDefault();
    }, true);
    clearButton.addEventListener('click', function () {
      if (locked || working) return;
      queue = [];
      row.classList.remove('show');
      render();
    });

    function uploadOne(sessionId, item, index, total) {
      return new Promise(function (resolve, reject) {
        var xhr = new XMLHttpRequest();
        xhr.open('POST', '/api/mobile-links/' + encodeURIComponent(sessionId) + '/files');
        xhr.setRequestHeader('Content-Type', item.file.type || 'application/octet-stream');
        xhr.setRequestHeader('X-File-Name-B64', fileNameHeader(item.file.name));
        xhr.setRequestHeader('X-Queue-Order', String(index));
        xhr.upload.onprogress = function (event) {
          if (!event.lengthComputable) return;
          var percent = Math.round(event.loaded / event.total * 100);
          hintText.textContent = '正在上传第 ' + (index + 1) + ' / ' + total + ' 个文件 · ' + percent + '%';
        };
        xhr.onload = function () {
          if (xhr.status >= 200 && xhr.status < 300) return resolve();
          var result = {};
          try { result = JSON.parse(xhr.responseText); } catch (error) {}
          reject(new Error(result.error || '文件上传失败。'));
        };
        xhr.onerror = function () { reject(new Error('网络中断，已保留本地队列状态。')); };
        xhr.send(item.file);
      });
    }
    async function createUploadSession() {
      var response = await fetch('/api/mobile-links?local=1', { method: 'POST' });
      var result = await response.json();
      if (!response.ok) throw new Error(result.error || '无法建立本机上传通道。');
      return result.id;
    }
    async function postJson(url) {
      var response = await fetch(url, { method: 'POST' });
      var result = await response.json();
      if (!response.ok) throw new Error(result.error || '本机处理请求失败。');
      return result;
    }
    function saveDocument(saved, pages, failure) {
      var key = 'scribe-local-v1';
      var state;
      try { state = JSON.parse(localStorage.getItem(key) || '{}'); } catch (error) { state = {}; }
      state.docs = Array.isArray(state.docs) ? state.docs : [];
      state.cards = Array.isArray(state.cards) ? state.cards : [];
      var sourcePages = pages.map(function (page) {
        var sameFile = pages.filter(function (other) { return other.fileId === page.fileId; }).length > 1;
        return { id: page.fileId + '-' + page.pageIndex, order: page.order, name: page.name + (sameFile ? ' · 第 ' + (page.pageIndex + 1) + ' 页' : ''), type: page.sourceType || 'text/plain', url: page.sourceUrl || '', text: page.text || '', confidence: page.confidence || 0, error: page.error || '', sourceFileId: page.fileId, pageIndex: page.pageIndex };
      });
      var id = 'computer-' + saved.id;
      var existing = state.docs.find(function (document) { return document.id === id; });
      var names = queue.map(function (item) { return item.file.name; });
      var title = names.length === 1 ? names[0].replace(/\.[^.]+$/, '') : '本地导入文献（' + names.length + ' 个文件）';
      var document = existing || { id: id };
      Object.assign(document, { serverDocumentId: saved.id, title: title, author: '本地电脑导入', category: '本地文献', status: 'reading', progress: Number(document.progress) || 0, pages: sourcePages.length, time: document.time || '0 h', color: 'new', sourcePages: sourcePages, processingState: failure ? 'partial' : 'ready', processingError: failure || '' });
      if (!existing) state.docs.unshift(document);
      state.activeDocId = document.id;
      localStorage.setItem(key, JSON.stringify(state));
      currentDocument = document;
      return document;
    }
    async function recognize(saved) {
      var base = '/api/documents/' + encodeURIComponent(saved.id) + '/process';
      var response = await fetch(base, { method: 'POST' });
      var job = await response.json();
      if (!response.ok && job.status !== 'processing') throw new Error(job.error || '本机文字识别无法启动。');
      while (job.status === 'processing') {
        hintText.innerHTML = '<span class="import-wait">正在逐页识别与整理 · ' + job.completed + ' / ' + job.total + '</span>';
        var steps = document.querySelectorAll('#steps .step');
        var active = Math.min(6, 2 + Math.floor(4 * job.completed / Math.max(1, job.total)));
        steps.forEach(function (step, index) { step.classList.toggle('work', index === active); step.classList.toggle('done', index < active); });
        await new Promise(function (resolve) { setTimeout(resolve, 800); });
        response = await fetch(base);
        job = await response.json();
      }
      if (job.status !== 'complete') throw new Error(job.error || '识别未完成。原文件仍已保存在本机，可重试处理。');
      return job.pages || [];
    }
    async function processAll() {
      if (!queue.length || working || button.dataset.completed === 'true') return;
      working = true;
      locked = true;
      button.disabled = true;
      button.textContent = '正在准备整批上传…';
      render();
      try {
        if (serverDocument) {
          hintText.innerHTML = '<span class="import-wait">正在重新识别已保存的原件…</span>';
          var retriedPages = await recognize(serverDocument);
          var retryFailures = retriedPages.filter(function (page) { return !page.text; }).length;
          saveDocument(serverDocument, retriedPages, retryFailures ? '有 ' + retryFailures + ' 页未能识别，请检查原图。' : '');
          button.dataset.completed = 'true';
          button.textContent = '处理完成，打开精读 →';
          button.onclick = function () { var reader = document.querySelector('.nav button[data-view="reader"]'); if (reader) reader.click(); };
          hintText.textContent = '识别完成 ' + retriedPages.length + ' 页' + (retryFailures ? '；' + retryFailures + ' 页需核对原图，原件已保留' : '；已可进入精读区');
          return;
        }
        var sessionId = button.dataset.sessionId;
        if (!sessionId) sessionId = await createUploadSession();
        button.dataset.sessionId = sessionId;
        for (var index = 0; index < queue.length; index += 1) {
          var item = queue[index];
          if (item.state === 'uploaded') continue;
          item.state = 'uploading';
          render();
          try {
            await uploadOne(sessionId, item, index, queue.length);
            item.state = 'uploaded';
            render();
          } catch (error) {
            item.state = 'error';
            throw error;
          }
        }
        button.textContent = '正在确认整批文件…';
        await postJson('/api/mobile-links/' + encodeURIComponent(sessionId) + '/complete');
        button.textContent = '正在保存原件…';
        var saved = await postJson('/api/mobile-links/' + encodeURIComponent(sessionId) + '/commit');
        serverDocument = saved;
        saveDocument(saved, [], '');
        hintText.innerHTML = '<span class="import-wait">原件已保存；本机正在识别整批页面，文件较多时请稍候</span>';
        var pages = await recognize(saved);
        var failed = pages.filter(function (page) { return !page.text; }).length;
        saveDocument(saved, pages, failed ? '有 ' + failed + ' 页未能识别，请检查原图。' : '');
        button.dataset.completed = 'true';
        button.textContent = '处理完成，打开精读 →';
        button.disabled = false;
        button.onclick = function () {
          var reader = document.querySelector('.nav button[data-view="reader"]');
          if (reader) reader.click();
        };
        hintText.textContent = '已识别并按顺序整理 ' + pages.length + ' 页' + (failed ? '；' + failed + ' 页需核对原图，原件已保留' : '；现在可在精读区点击词汇、划选短语和句子');
        document.querySelectorAll('#steps .step').forEach(function (step) { step.classList.remove('work'); step.classList.add('done'); });
      } catch (error) {
        button.disabled = false;
        button.textContent = currentDocument ? '原件已保存，重试文字识别' : '上传中断，点击重试';
        hintText.textContent = error.message;
        button.dataset.retryRecognition = currentDocument ? 'true' : '';
      } finally {
        working = false;
        render();
        if (button.dataset.completed === 'true') button.disabled = false;
      }
    }
    button.addEventListener('click', function (event) {
      if (!queue.length) return;
      if (button.dataset.completed === 'true') return;
      event.preventDefault();
      event.stopImmediatePropagation();
      processAll();
    }, true);
    render();
  });
})();

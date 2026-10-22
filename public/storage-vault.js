// 本机数据保险库：把体积大的学习数据从 localStorage（各浏览器约 5 MB 上限）搬进 IndexedDB
// （通常可用数百 MB 到数 GB，并申请「持久存储」防止被浏览器清理）。
// 页面里的旧脚本仍用同步的 localStorage.getItem/setItem 读写这些键——这里在 Storage 原型上
// 把它们接到内存副本，内存副本再异步落盘到 IndexedDB，所以旧代码一行不改也不会再触发配额错误。
// 启动顺序：本文件同步执行 → 读出 IndexedDB（首次把 localStorage 旧数据迁过去）→
// 依次执行页面中 type="scribe/boot" 的脚本 → 解析 window.__scribeBoot，云端模块随后接管。
(function () {
  'use strict';
  var KEYS = ['scribe-local-v1', 'scribe-sync-pending', 'scribe-sync-meta-v1', 'scribe-sync-conflicts', 'scribe-last-workspace', 'scribe-word-cache-v1', 'scribe-activity-v1'];
  var FALLBACK_FLAG = 'scribe-vault-fallback';
  var DB_NAME = 'scribe-vault', STORE = 'kv';
  var proto = Storage.prototype, nativeGet = proto.getItem, nativeSet = proto.setItem, nativeRemove = proto.removeItem;
  var memory = Object.create(null), dirty = Object.create(null), ready = false, db = null, timer = 0;
  var channel = null, info = { mode: 'loading', migrated: [], error: '' };
  var owned = function (store, name) { return store === window.localStorage && ready && db && KEYS.indexOf(String(name)) > -1; };

  proto.getItem = function (name) {
    if (owned(this, name)) return name in memory ? memory[name] : null;
    return nativeGet.call(this, name);
  };
  proto.setItem = function (name, value) {
    if (!owned(this, name)) return nativeSet.call(this, name, value);
    memory[name] = String(value); dirty[name] = true; schedule();
  };
  proto.removeItem = function (name) {
    if (!owned(this, name)) return nativeRemove.call(this, name);
    delete memory[name]; dirty[name] = true; schedule();
  };

  function schedule() { clearTimeout(timer); timer = setTimeout(flush, 250); }
  function flush() {
    clearTimeout(timer);
    var names = Object.keys(dirty);
    if (!db || !names.length) return;
    dirty = Object.create(null);
    try {
      var tx = db.transaction(STORE, 'readwrite'), store = tx.objectStore(STORE);
      names.forEach(function (name) { if (name in memory) store.put(memory[name], name); else store.delete(name); });
      tx.oncomplete = function () {
        if (channel) names.forEach(function (name) { channel.postMessage({ name: name, value: name in memory ? memory[name] : null }); });
      };
      tx.onerror = tx.onabort = function () {
        names.forEach(function (name) { dirty[name] = true; });
        info.error = (tx.error && tx.error.message) || '本机数据库写入失败';
        console.warn('[scribe] 本机数据库写入失败：' + info.error);
        try { window.dispatchEvent(new Event('scribe-storage-pressure')); } catch (error) { /* 忽略 */ }
      };
    } catch (error) { names.forEach(function (name) { dirty[name] = true; }); }
  }
  window.addEventListener('pagehide', flush);
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'hidden') flush(); });

  function open() {
    return new Promise(function (resolve, reject) {
      if (!window.indexedDB) return reject(new Error('浏览器不支持 IndexedDB'));
      var request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = function () { request.result.createObjectStore(STORE); };
      request.onsuccess = function () { resolve(request.result); };
      request.onerror = function () { reject(request.error || new Error('无法打开本机数据库')); };
      request.onblocked = function () { reject(new Error('本机数据库被其他标签页占用')); };
    });
  }
  function load(database) {
    return new Promise(function (resolve, reject) {
      var tx = database.transaction(STORE, 'readonly'), store = tx.objectStore(STORE), found = {};
      KEYS.forEach(function (name) { var request = store.get(name); request.onsuccess = function () { if (typeof request.result === 'string') found[name] = request.result; }; });
      tx.oncomplete = function () { resolve(found); };
      tx.onerror = function () { reject(tx.error); };
    });
  }
  // 首次启动（或上一次只能退回 localStorage 的会话）把旧数据搬进 IndexedDB；
  // 只有确认写入成功后才删掉 localStorage 里的旧副本，任何一步失败都保留原样。
  function migrate(database, found) {
    var preferNative = nativeGet.call(localStorage, FALLBACK_FLAG) === '1', moving = {};
    KEYS.forEach(function (name) {
      var legacy = nativeGet.call(localStorage, name);
      if (legacy !== null && (preferNative || !(name in found))) moving[name] = legacy;
      memory[name] = name in moving ? moving[name] : found[name];
      if (memory[name] === undefined) delete memory[name];
    });
    return new Promise(function (resolve) {
      var names = Object.keys(moving);
      var cleanup = function () {
        KEYS.forEach(function (name) { try { nativeRemove.call(localStorage, name); } catch (error) { /* 忽略 */ } });
        try { nativeRemove.call(localStorage, FALLBACK_FLAG); } catch (error) { /* 忽略 */ }
        info.migrated = names; resolve(true);
      };
      if (!names.length) return cleanup();
      var tx = database.transaction(STORE, 'readwrite'), store = tx.objectStore(STORE);
      names.forEach(function (name) { store.put(moving[name], name); });
      tx.oncomplete = cleanup;
      tx.onerror = tx.onabort = function () { resolve(false); };
    });
  }

  function runBootScripts() {
    var scripts = [].slice.call(document.querySelectorAll('script[type="scribe/boot"]'));
    return scripts.reduce(function (chain, original) {
      return chain.then(function () {
        return new Promise(function (resolve) {
          var script = document.createElement('script'), src = original.getAttribute('data-src');
          if (src) { script.src = src; script.async = false; script.onload = script.onerror = function () { resolve(); }; }
          else script.textContent = original.textContent;
          original.parentNode.insertBefore(script, original.nextSibling);
          if (!src) resolve();
        });
      });
    }, Promise.resolve());
  }
  function domParsed() {
    return new Promise(function (resolve) {
      if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { resolve(); }); else resolve();
    });
  }

  var storageReady = open().then(function (database) {
    return load(database).then(function (found) { return migrate(database, found); }).then(function (ok) {
      if (!ok) throw new Error('旧数据迁移未完成');
      db = database; ready = true; info.mode = 'indexeddb';
      try {
        channel = new BroadcastChannel('scribe-vault');
        channel.onmessage = function (event) {
          var data = event.data || {};
          if (KEYS.indexOf(data.name) < 0 || dirty[data.name]) return;
          if (data.value === null) delete memory[data.name]; else memory[data.name] = data.value;
        };
      } catch (error) { channel = null; }
      if (navigator.storage && navigator.storage.persist) navigator.storage.persist().then(function (granted) { info.persisted = granted; }).catch(function () {});
    });
  }).catch(function (error) {
    // 退回 localStorage：功能照旧，只是容量回到浏览器上限；下次能用 IndexedDB 时以这里的数据为准。
    info.mode = 'localstorage'; info.error = (error && error.message) || String(error);
    try { nativeSet.call(localStorage, FALLBACK_FLAG, '1'); } catch (ignored) { /* 忽略 */ }
    console.warn('[scribe] 本机数据库不可用，暂用浏览器小容量存储：' + info.error);
  });

  window.__scribeVault = {
    info: info,
    flush: flush,
    estimate: function () {
      if (!navigator.storage || !navigator.storage.estimate) return Promise.resolve(null);
      return navigator.storage.estimate().catch(function () { return null; });
    }
  };
  window.__scribeBoot = Promise.all([storageReady, domParsed()]).then(runBootScripts).then(function () {
    document.documentElement.classList.remove('scribe-booting');
  });
  document.documentElement.classList.add('scribe-booting');
  setTimeout(function () { document.documentElement.classList.remove('scribe-booting'); }, 4000);
})();

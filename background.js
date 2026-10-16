// Suomi Clipboard — background v1.2 (Manifest V2, постоянная фоновая страница)
// Всё хранится в IndexedDB расширения (как ArrayBuffer), а не в storage.local:
// так нет лимита на размер и нет «битых» Blob после засыпания фоновой страницы.
// Фон постоянный (MV2), поэтому буфер обмена проверяется непрерывно, даже когда браузер свёрнут.
'use strict';

// ---------- Настройки (можно менять) ----------
const TTL = 30 * 60 * 1000;                    // сколько живут скриншоты и история: 30 минут
const DOWNLOADS_WINDOW = 24 * 60 * 60 * 1000;  // за какой период показывать загрузки браузера: 24 часа
const MAX_PER_KIND = 12;                       // максимум элементов в каждом разделе
const MAX_ITEM_BYTES = 40 * 1024 * 1024;       // файлы больше 40 МБ не берём
const SEEN_TTL = 6 * 60 * 60 * 1000;           // как долго помнить «уже видели этот скриншот»
const BACKGROUND_POLL_MS = 1000;               // как часто проверять буфер обмена (0 = не проверять в фоне)
// -----------------------------------------------

const api = typeof browser !== 'undefined' ? browser : chrome;
const DB_NAME = 'zef';
const STORE = 'items';
const log = (...a) => console.log('[ZEF bg]', ...a);
let dataVersion = 0;   // растёт при любом изменении данных: панель по нему понимает, что пора обновиться

// ---------- IndexedDB ----------
function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const s = req.result.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
      s.createIndex('ts', 'ts');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idb(mode, fn) {
  return openDb().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    let out;
    try { out = fn(tx.objectStore(STORE)); } catch (e) { db.close(); reject(e); return; }
    tx.oncomplete = () => { db.close(); resolve(out && out.result !== undefined ? out.result : undefined); };
    tx.onerror = tx.onabort = () => { db.close(); reject(tx.error); };
  }));
}

// Удаляет просроченное и лишнее, возвращает актуальные записи (новые первыми)
async function pruneAndGet() {
  const all = (await idb('readonly', (s) => s.getAll())) || [];
  all.sort((a, b) => b.ts - a.ts);
  const now = Date.now();
  const counts = { clip: 0, hist: 0 };
  const keep = [];
  const drop = [];
  for (const it of all) {
    if (now - it.ts > TTL || (counts[it.kind] || 0) >= MAX_PER_KIND) drop.push(it.id);
    else { counts[it.kind] = (counts[it.kind] || 0) + 1; keep.push(it); }
  }
  if (drop.length) { await idb('readwrite', (s) => { drop.forEach((id) => s.delete(id)); }); dataVersion++; }
  return keep;
}

// ---------- «Уже видели» (чтобы очищенный скриншот не возвращался) ----------
async function getSeen() {
  const { seen = {} } = await api.storage.local.get('seen');
  const now = Date.now();
  for (const k of Object.keys(seen)) if (now - seen[k] > SEEN_TTL) delete seen[k];
  return seen;
}
const saveSeen = (seen) => api.storage.local.set({ seen });

function fingerprint(buf) {
  const u = new Uint8Array(buf);
  const n = u.length;
  const head = Math.min(n, 65536);
  const tailStart = Math.max(head, n - 65536);
  let h = 2166136261 >>> 0;
  for (let i = 0; i < head; i++) { h ^= u[i]; h = Math.imul(h, 16777619) >>> 0; }
  for (let i = tailStart; i < n; i++) { h ^= u[i]; h = Math.imul(h, 16777619) >>> 0; }
  return n + ':' + h.toString(16);
}

// То же, что fingerprint(), но без загрузки всего файла в память (читаем только начало и конец)
async function fingerprintBlob(blob) {
  const n = blob.size;
  const head = new Uint8Array(await blob.slice(0, 65536).arrayBuffer());
  const tail = n > 65536 ? new Uint8Array(await blob.slice(Math.max(65536, n - 65536)).arrayBuffer()) : new Uint8Array(0);
  let h = 2166136261 >>> 0;
  for (const part of [head, tail]) for (let i = 0; i < part.length; i++) { h ^= part[i]; h = Math.imul(h, 16777619) >>> 0; }
  return n + ':' + h.toString(16);
}

// ---------- Утилиты ----------
const pad = (n) => String(n).padStart(2, '0');
function clipName(type, ts) {
  const d = new Date(ts);
  const ext = type === 'image/jpeg' ? 'jpg' : (type.split('/')[1] || 'png').replace(/[^a-z0-9]/gi, '');
  // без двоеточий: они запрещены в именах файлов Windows и ломают загрузку на многих сайтах
  return 'Скриншот_' + pad(d.getHours()) + '-' + pad(d.getMinutes()) + '-' + pad(d.getSeconds()) + '.' + ext;
}
const cleanName = (n) => String(n || 'file').split(/[\\/]/).pop().replace(/[<>:"|?*\u0000-\u001f]/g, '_') || 'file';

const MIME = {
  pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml', txt: 'text/plain', csv: 'text/csv',
  doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  zip: 'application/zip', rar: 'application/vnd.rar', '7z': 'application/x-7z-compressed',
  mp4: 'video/mp4', mp3: 'audio/mpeg', json: 'application/json', sig: 'application/octet-stream',
};
function guessMime(name, mime) {
  if (mime && mime !== 'application/octet-stream') return mime;
  const ext = cleanName(name).split('.').pop().toLowerCase();
  return MIME[ext] || 'application/octet-stream';
}

// ---------- Буфер обмена ----------
// store=false: только запомнить, что текущая картинка в буфере «уже видена» (нужно для очистки)
let lastPollError = '';
let suppressUntil = 0;   // пока действует, картинки в буфере только «запоминаются», но не сохраняются
async function doPoll(store) {
  if (store && Date.now() < suppressUntil) store = false;
  let items;
  try { items = await navigator.clipboard.read(); lastPollError = ''; }
  catch (e) {
    const msg = String((e && e.message) || e);
    if (msg !== lastPollError) { lastPollError = msg; log('clipboard.read:', msg); }   // пустой буфер — норма, не спамим
    return { added: 0, error: msg };
  }

  const seen = await getSeen();
  const now = Date.now();
  let added = 0;
  let touched = false;

  for (const item of items) {
    const type = item.types.find((t) => t.startsWith('image/'));
    if (!type) continue;
    const blob = await item.getType(type);
    if (!blob.size || blob.size > MAX_ITEM_BYTES) continue;
    const key = await fingerprintBlob(blob);   // без полной загрузки файла: дёшево при проверке раз в секунду
    if (seen[key]) continue;
    seen[key] = now;
    touched = true;
    if (store) {
      const buf = await blob.arrayBuffer();
      await idb('readwrite', (s) => s.add({ kind: 'clip', ts: now, name: clipName(type, now), type, size: buf.byteLength, key, buf }));
      added++;
      dataVersion++;
    }
  }
  if (touched) await saveSeen(seen);
  return { added };
}

let pollChain = Promise.resolve();
function serialized(fn) {
  const p = pollChain.then(fn, fn);
  pollChain = p.catch(() => {});
  return p;
}
const pollClipboard = () => serialized(() => doPoll(true));

// ---------- Загрузки браузера ----------
async function listDownloads() {
  const { dlClearedAt = 0 } = await api.storage.local.get('dlClearedAt');
  let found = [];
  try {
    found = await api.downloads.search({ orderBy: ['-startTime'], limit: 60, state: 'complete' });
  } catch (e) { log('downloads.search failed', e); return []; }

  const now = Date.now();
  const out = [];
  for (const d of found) {
    if (!d.filename) continue;
    if (d.exists === false) continue;                       // файл удалён с диска
    const ts = new Date(d.endTime || d.startTime).getTime();
    if (ts <= dlClearedAt) continue;                        // скрыто кнопкой «Очистить»
    if (now - ts > DOWNLOADS_WINDOW) continue;
    const name = cleanName(d.filename);                     // только имя, без пути C:\...
    out.push({
      id: d.id, name, ts,
      type: guessMime(name, d.mime),
      size: d.fileSize > 0 ? d.fileSize : 0,
      // расширение не умеет читать файл с диска; единственный путь — скачать по исходной ссылке заново
      canRefetch: /^(https?|data):/i.test(d.url || ''),
    });
    if (out.length >= MAX_PER_KIND * 2) break;
  }
  return out;
}

const fail = (error) => ({ ok: false, error });

async function fetchDownload(id) {
  const [d] = await api.downloads.search({ id });
  if (!d) return fail('Загрузка не найдена в истории браузера');
  if (d.exists === false) return fail('Файл удалён с диска');
  if (!/^(https?|data):/i.test(d.url || '')) {
    return fail('Файл получен не по обычной ссылке (blob:/file:), расширение не может его прочитать');
  }
  const name = cleanName(d.filename);

  let resp;
  try { resp = await fetch(d.url, { credentials: 'include', cache: 'force-cache' }); }
  catch (e) { return fail('Не удалось скачать файл заново: ' + ((e && e.message) || e)); }
  if (!resp.ok) return fail('Сайт ответил ' + resp.status + ' при повторной загрузке');

  const buf = await resp.arrayBuffer();
  if (!buf.byteLength) return fail('Сайт вернул пустой файл');
  if (buf.byteLength > MAX_ITEM_BYTES) return fail('Файл больше 40 МБ');

  // Защита от «битых» файлов: повторный запрос мог вернуть страницу входа или ошибку вместо файла
  if (d.fileSize > 0 && buf.byteLength !== d.fileSize) {
    return fail('Размер не совпал с файлом на диске: сайт отдаёт при повторном запросе другой ответ');
  }
  const ct = (resp.headers.get('content-type') || '').toLowerCase();
  if (ct.startsWith('text/html') && !/\.(x?html?)$/i.test(name)) {
    return fail('Сайт вернул веб-страницу вместо файла (нужен вход на сайт?)');
  }
  return { ok: true, buf, name, type: guessMime(name, d.mime) };
}

// ---------- История (файлы, перетащенные на панель) ----------
async function addHistory(msg) {
  if (!(msg.buf instanceof ArrayBuffer) || !msg.buf.byteLength || msg.buf.byteLength > MAX_ITEM_BYTES) {
    return fail('Файл пустой или больше 40 МБ');
  }
  const key = fingerprint(msg.buf);
  const name = cleanName(msg.name);
  const old = (await idb('readonly', (s) => s.getAll())) || [];
  const dupIds = old.filter((i) => i.kind === 'hist' && i.key === key).map((i) => i.id);
  await idb('readwrite', (s) => {
    dupIds.forEach((id) => s.delete(id));
    s.add({ kind: 'hist', ts: Date.now(), name, type: guessMime(name, msg.type), size: msg.buf.byteLength, key, buf: msg.buf });
  });
  dataVersion++;
  return { ok: true };
}

// ---------- Список для панели ----------
const makeSig = (downloads) => dataVersion + '|' + downloads.length + ':' + (downloads[0] ? downloads[0].id : 0);

async function listAll() {
  const items = await pruneAndGet();
  const pick = (kind) => items.filter((i) => i.kind === kind)
    .map((i) => ({ id: i.id, name: i.name, type: i.type, size: i.size, ts: i.ts, buf: i.buf }));
  const downloads = await listDownloads();
  return { clips: pick('clip'), hist: pick('hist'), downloads, sig: makeSig(downloads) };
}

// Дёшево: панель опрашивает это раз в секунду и перерисовывается, только если подпись изменилась
async function signature() {
  return { sig: makeSig(await listDownloads()) };
}

async function clearAll() {
  await idb('readwrite', (s) => { s.clear(); });
  await api.storage.local.set({ dlClearedAt: Date.now() });
  dataVersion++;
  // текущая картинка в системном буфере больше не должна «воскресать»
  try { await serialized(() => doPoll(false)); } catch (e) { /* не критично */ }
  return { ok: true };
}

// ---------- Сообщения от content.js ----------
api.runtime.onMessage.addListener((msg, sender) => {
  if (!msg || !sender || sender.id !== api.runtime.id) return undefined;
  let p;
  switch (msg.action) {
    case 'pollClipboard': p = pollClipboard(); break;
    case 'list': p = listAll(); break;
    case 'signature': p = signature(); break;
    case 'suppressClipboard': suppressUntil = Date.now() + 4000; p = Promise.resolve({ ok: true }); break;
    case 'getDownload': p = fetchDownload(msg.id); break;
    case 'addHistory': p = addHistory(msg); break;
    case 'deleteItem': p = idb('readwrite', (s) => { s.delete(msg.id); }).then(() => { dataVersion++; return { ok: true }; }); break;
    case 'clear': p = clearAll(); break;
    // словарь сообщений выбранного вручную языка (настройка zefSettings.lang): content.js не может читать файлы расширения напрямую
    case 'getMessages': p = fetch(api.runtime.getURL('_locales/' + (msg.lang === 'ru' ? 'ru' : 'en') + '/messages.json'))
      .then((r) => r.json()).then((m) => ({ ok: true, messages: m }))
      .catch((e) => ({ ok: false, error: String(e) })); break;
    default: return undefined;
  }
  return p.catch((e) => { log('error in', msg.action, e); return fail(String((e && e.message) || e)); });
});

// ---------- Горячая клавиша (настраивается в about:addons → ⚙ → Управление сочетаниями) ----------
api.commands.onCommand.addListener(async (command) => {
  if (command !== 'toggle-panel') return;
  try {
    // Если пользователь задал свой бинд, Alt+V из манифеста не должен срабатывать
    const { zefSettings } = await api.storage.local.get('zefSettings');
    const want = (zefSettings && zefSettings.hotkeyCombo) || 'Alt+V';
    const norm = (s) => s.toUpperCase().replace(/CONTROL/gi, 'Ctrl').replace(/META|OS|WIN/gi, 'Meta');
    if (norm(want) !== norm('Alt+V')) return;   // свой бинд заменяет Alt+V, молчим
    const [tab] = await api.tabs.query({ active: true, currentWindow: true });
    if (tab) await api.tabs.sendMessage(tab.id, { action: 'togglePanel' });
  } catch (e) { log('hotkey: на этой странице расширение не работает', e); }
});

// ---------- Фоновые задачи ----------
// Буфер проверяется постоянно: скриншот, сделанный в любом приложении, попадает в список сразу,
// а не только когда ты вернулся в браузер. Если вдруг будет мешать другим программам — поставь BACKGROUND_POLL_MS = 0.
if (BACKGROUND_POLL_MS > 0) {
  setInterval(() => { pollClipboard().catch(() => {}); }, BACKGROUND_POLL_MS);
  pollClipboard().catch(() => {});
}
setInterval(() => { pruneAndGet().catch(() => {}); }, 60 * 1000);   // чистим просроченное, даже если панель не открывали

log('loaded');

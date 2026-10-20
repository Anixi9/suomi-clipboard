// Suomi Clipboard — content script v1.4
(() => {
  'use strict';
  if (window.top !== window.self) return;
  if (window.__zefLoaded) return;
  window.__zefLoaded = true;

  const api = typeof browser !== 'undefined' ? browser : chrome;
  const log = (...a) => console.log('[ZEF]', ...a);
  const MAX_HIST_BYTES = 40 * 1024 * 1024;
  const STEP_WAIT_MS = 1800; // сколько ждём, пока на странице появится файл, после очередного способа вставки
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ВРЕМЕННАЯ диагностика дублей скриншота ([ZEF-DUB]). После фикса поставить TRACE = false (тогда всё ниже молчит).
  const TRACE = true;
  const dub = (...a) => { if (TRACE) console.log('[ZEF-DUB]', ...a); };
  // Наблюдаем 2,5 с после отправки: сколько событий paste/drop/input/change увидела страница и сколько превью появилось в DOM
  function traceBegin(label) {
    if (!TRACE) return;
    const t0 = Date.now();
    const stamp = () => '+' + (Date.now() - t0) + 'мс';
    const cls = (n) => (n.getAttribute && n.getAttribute('class')) || '';
    const desc = (n) => (n && n.tagName ? n.tagName.toLowerCase() + (n.id ? '#' + n.id : '') + (cls(n) ? '.' + cls(n).trim().split(/\s+/).slice(0, 2).join('.') : '') : String(n));
    const blobSel = 'img[src^="blob:"], img[src^="data:"]';
    const countImgs = () => Array.from(document.querySelectorAll(blobSel)).filter((i) => !i.closest('#zef-overlay, .zef-toast')).length;
    const imgs0 = countImgs();
    const cnt = { paste: 0, drop: 0, input: 0, change: 0, nodes: 0 };
    const inOverlay = (e) => !!(e.target && e.target.closest && e.target.closest('#zef-overlay, .zef-toast'));
    const onCap = (e) => {
      if (inOverlay(e)) return;
      cnt[e.type]++;
      dub(stamp(), 'СОБЫТИЕ(capture)', e.type, '| trusted=' + e.isTrusted, '| target=' + desc(e.target), '| defaultPrevented=' + e.defaultPrevented);
    };
    const onBub = (e) => { if (!inOverlay(e)) dub(stamp(), 'СОБЫТИЕ(дошло до window после сайта)', e.type, '| defaultPrevented=' + e.defaultPrevented); };
    const types = ['paste', 'drop', 'input', 'change'];
    types.forEach((tp) => { window.addEventListener(tp, onCap, true); window.addEventListener(tp, onBub, false); });
    const mo = new MutationObserver((list) => {
      for (const m of list) {
        for (const n of m.addedNodes) {
          if (n.nodeType !== 1 || n.closest('#zef-overlay, .zef-toast')) continue;
          const hasImg = n.tagName === 'IMG' ? /^(blob|data):/.test(n.src || '') : !!n.querySelector(blobSel);
          if (hasImg || /preview|thumb|attach|chip|file/i.test(cls(n))) { cnt.nodes++; dub(stamp(), 'в DOM добавлен узел-превью №' + cnt.nodes, desc(n), hasImg ? '(есть blob/data img)' : ''); }
        }
      }
    });
    mo.observe(document, { childList: true, subtree: true });
    dub('--- старт трассировки, файл(ы):', label, '| blob/data img в DOM до:', imgs0);
    setTimeout(() => {
      types.forEach((tp) => { window.removeEventListener(tp, onCap, true); window.removeEventListener(tp, onBub, false); });
      mo.disconnect();
      dub('--- ИТОГ за 2.5с: paste=' + cnt.paste, 'drop=' + cnt.drop, 'input=' + cnt.input, 'change=' + cnt.change,
        '| узлов-превью добавлено=' + cnt.nodes, '| blob/data img в DOM: было', imgs0, '→ стало', countImgs());
    }, 2500);
  }

  // ---------------- настройки и локализация ----------------
  // storage.local.zefSettings = { theme, accent, opacity, lang, hotkeyCombo }; читаются заранее, чтобы openPanel оставался синхронным
  const MANIFEST_KEY = 'Alt+V';
  const DEFAULT_SETTINGS = { theme: 'system', accent: '', opacity: 100, lang: 'system', hotkeyCombo: MANIFEST_KEY };
  let settings = Object.assign({}, DEFAULT_SETTINGS);
  let userMsgs = null;       // словарь выбранного вручную языка (null = системный через i18n.getMessage)

  // Строка интерфейса: выбранный вручную язык → системный (api.i18n) → ключ
  const t = (key) => {
    try {
      if (userMsgs && userMsgs[key] && userMsgs[key].message) return userMsgs[key].message;
      const msg = api.i18n.getMessage(key);
      return msg || key;
    } catch (e) { return key; }
  };
  const curLang = () => {
    if (settings.lang === 'ru' || settings.lang === 'en') return settings.lang;
    try { return /^ru/i.test(api.i18n.getUILanguage()) ? 'ru' : 'en'; } catch (e) { return 'en'; }
  };

  async function loadSettings() {
    try {
      const o = await api.storage.local.get('zefSettings');
      settings = Object.assign({}, DEFAULT_SETTINGS, o.zefSettings || {});
    } catch (e) { settings = Object.assign({}, DEFAULT_SETTINGS); }
    userMsgs = null;
    if (settings.lang === 'ru' || settings.lang === 'en') {
      try {
        const r = await api.runtime.sendMessage({ action: 'getMessages', lang: settings.lang });
        if (r && r.ok) userMsgs = r.messages;
      } catch (e) { /* фолбэк: системный язык */ }
    }
  }
  loadSettings();
  try {
    api.storage.onChanged.addListener((ch, area) => { if (area === 'local' && ch.zefSettings) loadSettings(); });
  } catch (e) { /* не критично */ }

  let ctx = null;            // { input, mode: 'input' | 'hotkey', focusEl, accept }
  let overlay = null;
  let data = { clips: [], hist: [], downloads: [] };
  let pollTimer = null;
  let bypass = false;        // true, пока мы сами открываем системный диалог
  let lastSig = '';          // подпись данных, по ней панель понимает, что список изменился

  // ---------------- утилиты ----------------
  const send = async (msg) => {
    try { return await api.runtime.sendMessage(msg); }
    catch (e) { log('sendMessage failed:', msg.action, e); return null; }
  };

  const fmtSize = (b) => !b ? '' : b < 1024 ? b + ' ' + t('size_b') : b < 1048576 ? Math.round(b / 1024) + ' ' + t('size_kb')
    : (curLang() === 'ru' ? (b / 1048576).toFixed(1).replace('.', ',') : (b / 1048576).toFixed(1)) + ' ' + t('size_mb');

  const ago = (ts) => {
    const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
    if (s < 45) return t('time_now');
    if (s < 3600) return Math.max(1, Math.round(s / 60)) + ' ' + t('time_min');
    if (s < 86400) return Math.round(s / 3600) + ' ' + t('time_hour');
    return new Date(ts).toLocaleDateString(curLang() === 'ru' ? 'ru-RU' : 'en-US', { day: 'numeric', month: 'short' });
  };

  const extOf = (n) => { const i = String(n).lastIndexOf('.'); return i > 0 ? n.slice(i + 1).toLowerCase() : ''; };
  const ICONS = { pdf: '📕', doc: '📘', docx: '📘', xls: '📗', xlsx: '📗', csv: '📗', ppt: '📙', pptx: '📙',
    zip: '🗜️', rar: '🗜️', '7z': '🗜️', png: '🖼️', jpg: '🖼️', jpeg: '🖼️', gif: '🖼️', webp: '🖼️', bmp: '🖼️' };
  const iconFor = (name) => ICONS[extOf(name)] || '📄';
  const isRaster = (it) => /^image\/(png|jpeg|gif|webp|bmp)$/.test(it.type || '');

  function toast(msg, ms = 2800) {
    const t = document.createElement('div');
    t.className = 'zef-toast' + (overlay ? ' zef-toast-high' : '');
    t.textContent = msg;
    document.documentElement.appendChild(t);
    setTimeout(() => { t.classList.add('zef-toast-out'); setTimeout(() => t.remove(), 300); }, ms);
  }

  // ---------------- поиск поля ввода ----------------
  function deepActive() {
    let a = document.activeElement;
    while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement;
    return a;
  }

  function isEditable(el) {
    if (!el || el === document.body || el === document.documentElement) return false;
    if (el.isContentEditable) return true;
    if (el.tagName === 'TEXTAREA') return !el.disabled && !el.readOnly;
    if (el.tagName === 'INPUT') return !el.disabled && !el.readOnly && /^(text|search|url|email|tel|number)$/i.test(el.type || 'text');
    return false;
  }

  const usableInputs = (root) => Array.from(root.querySelectorAll('input[type="file"]'))
    .filter((i) => !i.disabled && !i.webkitdirectory);

  // Ближайшее к курсору поле загрузки: идём вверх от активного элемента, пока не найдём контейнер с input[type=file].
  // strict (курсор в редакторе): подъём не выше 10 уровней, а «любое на странице» берём, только если оно одно:
  // иначе файл мог бы уйти в чужое поле (например, загрузка аватара).
  function findNearestInput(from, strict) {
    let node = from || document.activeElement;
    let up = 0;
    while (node && node !== document.documentElement && node.querySelectorAll && (!strict || up < 10)) {
      const list = usableInputs(node);
      if (list.length) return list[0];
      node = node.parentElement || (node.getRootNode && node.getRootNode().host) || null;
      up++;
    }
    const all = usableInputs(document);
    return strict ? (all.length === 1 ? all[0] : null) : (all[0] || null);
  }

  function parseAccept(input) {
    return input && input.accept ? input.accept.toLowerCase().split(',').map((s) => s.trim()).filter(Boolean) : [];
  }
  function matchesAccept(tokens, name, type) {
    if (!tokens.length) return true;
    const n = String(name).toLowerCase();
    const m = String(type || '').toLowerCase();
    return tokens.some((t) => t.startsWith('.') ? n.endsWith(t) : t.endsWith('/*') ? m.startsWith(t.slice(0, -1)) : t === m);
  }

  // ---------------- вставка файлов на страницу ----------------
  let attaching = false;   // защита от двойного запуска (двойной клик по плитке, повторный хоткей)

  // Способ «Вставлено»: событие paste на редактор (как Ctrl+V)
  function tryPaste(el, files) {
    try {
      const dt = new DataTransfer();
      files.forEach((f) => dt.items.add(f));
      const ev = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt });
      if (!ev.clipboardData || !ev.clipboardData.files || !ev.clipboardData.files.length) return false;
      dub('+1 вставка, способ=paste (синтетический ClipboardEvent на ' + el.tagName.toLowerCase() + '), файл=' + files.map((f) => f.name).join(','));
      el.dispatchEvent(ev);
      return true;
    } catch (e) { log('paste strategy failed:', e); return false; }
  }

  // Способ «Вставлено (как Ctrl+V)» (Firefox, только PNG-скриншот): кладём картинку в системный буфер и вызываем
  // НАСТОЯЩУЮ вставку, то есть всё равно что человек нажал Ctrl+V. Нужен сайтам, которые не принимают «искусственные» события.
  async function tryTrustedPaste(el, files) {
    try {
      if (files.length !== 1 || files[0].type !== 'image/png') return false;
      if (!navigator.clipboard || !navigator.clipboard.write || typeof ClipboardItem === 'undefined') return false;
      await send({ action: 'suppressClipboard' });          // чтобы фон не принял эту картинку за новый скриншот
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': files[0] })]);
      el.focus({ preventScroll: true });
      dub('+1 вставка, способ=ctrlv (execCommand paste, настоящая вставка из системного буфера), файл=' + files[0].name);
      // Firefox: execCommand('paste') возвращает false даже при успешной вставке (событие paste при этом доходит до сайта).
      // Поэтому возврат команды не используем: сам вызов с картинкой в буфере на сфокусированном редакторе = вставка состоялась.
      // Если что-то пошло не так (буфер/фокус) — исключение уйдёт в catch → false → цепочка честно пойдёт к следующему способу.
      const pasteRes = document.execCommand('paste');
      dub('ctrlv: execCommand вернул', pasteRes, '→ считаем вставку состоявшейся (return true)');
      return true;
    } catch (e) { log('trusted paste failed:', e); return false; }
  }

  // Способ «Прикреплено»: запись в input[type=file] + события input/change (по одному разу, в правильном порядке)
  // Qwen: слушатель change живёт в page-scope — события создаём конструкторами страницы (wrappedJSObject + cloneInto)
  function fireInPage(input, type) {
    try {
      const w = window.wrappedJSObject;
      const ev = new w.Event(type, cloneInto({ bubbles: true }, window));
      input.wrappedJSObject.dispatchEvent(ev);
      return true;
    } catch (e) { log('page-context dispatch не удался:', type, e); return false; }
  }

  function setInputFiles(input, files, pageCtx) {
    const list = input.multiple ? files : files.slice(0, 1);
    const dt = new DataTransfer();
    list.forEach((f) => dt.items.add(f));
    input.files = dt.files;
    if (!input.files || input.files.length !== list.length) throw new Error('браузер не принял файл в поле загрузки');
    if (pageCtx && isQwen) {
      // только в page-контексте (без дубля из content-контекста); если не вышло — обычный путь
      const okInput = fireInPage(input, 'input');
      const okChange = fireInPage(input, 'change');
      log('Qwen: setInputFiles, события в page-контексте: input =', okInput, ', change =', okChange);
      if (okInput && okChange) return true;
    }
    dub('+1 вставка, способ=input.files (+ событие input, затем change), файл=' + list.map((f) => f.name).join(','));
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }

  const dragEvent = (type, dt, x, y) => new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt, clientX: x, clientY: y });

  // Способ «Перетащено»: имитация перетаскивания файла на редактор (событие всплывает до любого контейнера чата)
  function tryDrop(target, files) {
    try {
      const dt = new DataTransfer();
      files.forEach((f) => dt.items.add(f));
      const r = target.getBoundingClientRect();
      const x = r.left + r.width / 2;
      const y = r.top + r.height / 2;
      dub('+1 вставка, способ=drop на редактор, файл=' + files.map((f) => f.name).join(','));
      ['dragenter', 'dragover', 'drop'].forEach((t) => target.dispatchEvent(dragEvent(t, dt, x, y)));
      return true;
    } catch (e) { log('drop strategy failed:', e); return false; }
  }

  // Способ «Перетащено на область сброса»: многие сайты (Gemini, ChatGPT) при dragenter показывают отдельную
  // «зону сброса» и принимают файл только на ней. Ждём её появления и роняем файл уже туда.
  async function tryDropOnZone(editor, files) {
    try {
      const dt = new DataTransfer();
      files.forEach((f) => dt.items.add(f));
      const r = editor.getBoundingClientRect();
      const ex = r.left + r.width / 2;
      const ey = r.top + r.height / 2;
      editor.dispatchEvent(dragEvent('dragenter', dt, ex, ey));
      editor.dispatchEvent(dragEvent('dragover', dt, ex, ey));
      await sleep(350);
      if (overlay) overlay.classList.add('zef-peek');       // на миг делаем нашу панель «прозрачной» для elementFromPoint
      const hit = (x, y) => document.elementFromPoint(x, y);
      const cand = [hit(ex, ey), hit(window.innerWidth / 2, window.innerHeight / 2)];
      if (overlay) overlay.classList.remove('zef-peek');
      const zone = cand.find((n) => n && n !== editor && n !== document.body && n !== document.documentElement && !editor.contains(n));
      if (!zone) return false;
      log('зона сброса найдена:', zone.tagName, zone.className);
      const zr = zone.getBoundingClientRect();
      const zx = zr.left + zr.width / 2;
      const zy = zr.top + zr.height / 2;
      dub('+1 вставка, способ=drop на зону сброса, файл=' + files.map((f) => f.name).join(','));
      zone.dispatchEvent(dragEvent('dragover', dt, zx, zy));
      zone.dispatchEvent(dragEvent('drop', dt, zx, zy));
      return true;
    } catch (e) { log('drop-zone strategy failed:', e); return false; }
  }

  // Gemini: область сброса появляется после dragenter (классы вида fileDropAnimation / overlay-container)
  function findGeminiDropZone() {
    const n = Array.from(document.querySelectorAll('[class*="fileDrop"]')).find((el) => !el.closest('#zef-overlay, .zef-toast'));
    if (n) return n;
    const o = document.querySelector('.overlay-container');
    return o && o.childElementCount ? o : null;
  }

  // Способ «Gemini: сброс на overlay»: dragenter/dragover на редакторе → ждём overlay → dragover+drop на него в одном тике
  async function tryGeminiDrop(editor, files, flags) {
    try {
      const dt = new DataTransfer();
      files.forEach((f) => dt.items.add(f));
      const r = editor.getBoundingClientRect();
      const ex = r.left + r.width / 2;
      const ey = r.top + r.height / 2;
      editor.dispatchEvent(dragEvent('dragenter', dt, ex, ey));
      editor.dispatchEvent(dragEvent('dragover', dt, ex, ey));
      let zone = null;
      for (let t = 0; t < 24 && !zone; t++) {
        zone = findGeminiDropZone();
        if (!zone) await sleep(50);
      }
      if (!zone) { log('Gemini: overlay сброса не появился'); return false; }
      log('Gemini: overlay найден:', zone.tagName, attrClass(zone).slice(0, 80));
      flags.overlay = true;
      const zr = zone.getBoundingClientRect();
      const zx = zr.width ? zr.left + zr.width / 2 : ex;
      const zy = zr.height ? zr.top + zr.height / 2 : ey;
      // без sleep между событиями: overlay может исчезнуть так же быстро, как появился
      zone.dispatchEvent(dragEvent('dragover', dt, zx, zy));
      zone.dispatchEvent(dragEvent('drop', dt, zx, zy));
      return true;
    } catch (e) { log('Gemini drop strategy failed:', e); return false; }
  }

  // Какие поля загрузки подходят.
  // С файлами: сначала те, что принимают этот тип, затем ближайшие к курсору, затем «пошире».
  // Без файлов (системный диалог): сначала самые «широкие» поля (любые файлы), затем ближайшие.
  // Поля из чужих диалогов (профиль, настройки) ставим в конец списка.
  const MAX_INPUT_LEVEL = 14;
  function rankInputs(files, from, strict) {
    const all = usableInputs(document);
    if (!all.length) return [];
    const up = (n) => n.parentElement || (n.getRootNode && n.getRootNode().host) || null;
    const anc = new Map();
    for (let n = from, i = 0; n; n = up(n), i++) anc.set(n, i);
    return all.map((inp, idx) => {
      let level = 99;
      for (let p = inp; p; p = up(p)) { if (anc.has(p)) { level = anc.get(p); break; } }
      const dlg = inp.closest && inp.closest('[role="dialog"], [aria-modal="true"], dialog');
      const foreign = dlg && !(from && dlg.contains(from)) ? 1 : 0;
      const tokens = parseAccept(inp);
      const breadth = !tokens.length || tokens.includes('*/*') ? 100 : tokens.length;
      return { inp, idx, level, foreign, breadth, accepts: files.every((f) => matchesAccept(tokens, f.name, f.type)) ? 1 : 0 };
    }).filter((x) => !strict || x.level <= MAX_INPUT_LEVEL)
      .sort((a, b) => (b.accepts - a.accepts) || (a.foreign - b.foreign) ||
        (files.length ? (a.level - b.level) || (b.breadth - a.breadth) : (b.breadth - a.breadth) || (a.level - b.level)) ||
        (a.idx - b.idx))
      .map((x) => x.inp);
  }
  const describeInput = (i) => ({ id: i.id || '', name: i.name || '', accept: i.accept || '', multiple: !!i.multiple });

  // «Признак успеха»: на странице появилось то, что похоже на прикреплённый файл. Любой шум интерфейса
  // (анимации, подсказки, ответ чата) не считается: ищем имя файла, миниатюру или новую «плашку» рядом с полем ввода.
  function makeMatcher(files, anchor) {
    const names = files.map((f) => f.name.toLowerCase());
    const bases = files.map((f) => f.name.replace(/\.[^.]*$/, '').toLowerCase()).filter((b) => b.length >= 4);
    const wantImage = files.some((f) => /^image\//.test(f.type));
    let composer = null;
    if (anchor) {
      composer = anchor.closest('form');
      if (!composer) {
        let n = anchor;
        for (let i = 0; i < 5 && n.parentElement && n.parentElement !== document.body && n.parentElement !== document.documentElement; i++) n = n.parentElement;
        composer = n;
      }
    }
    const hit = (t) => names.some((n) => t.includes(n)) || bases.some((b) => t.includes(b));
    const matcher = (node) => {
      if (node.nodeType === 3) return hit((node.nodeValue || '').toLowerCase());
      if (node.nodeType !== 1) return false;
      if (node.closest && node.closest('#zef-overlay, .zef-toast')) return false;
      if (hit((node.textContent || '').slice(0, 20000).toLowerCase())) return true;
      const labeled = [node].concat(Array.from(node.querySelectorAll('[alt],[title],[aria-label]')).slice(0, 40));
      for (const el of labeled) {
        for (const a of ['alt', 'title', 'aria-label']) {
          const v = el.getAttribute && el.getAttribute(a);
          if (v && hit(v.toLowerCase())) return true;
        }
      }
      // Qwen + документ: успех ТОЛЬКО по имени файла (выше). Общие правила композера дают ложные срабатывания от шума интерфейса
      if (isQwen && !wantImage) return false;
      // Gemini + документ: общие правила композера не нужны (плашку и имя файла проверяет makeGeminiMatcher)
      if (isGemini && !wantImage) return false;
      if (composer && composer.contains(node)) {
        // Картинки: успех ТОЛЬКО по IMG с blob/data или узлу с классом /preview|thumb|attach|chip|file/i в композере
        if (wantImage) {
          if (node.tagName === 'IMG' && /^blob:|^data:/.test(node.src || '')) return true;
          if (node.querySelector('img[src^="blob:"], img[src^="data:"]')) return true;
          const cls = node.className || '';
          if (/preview|thumb|attach|chip|file/i.test(cls)) return true;
        } else {
          // Документы на обычных хостах: старая логика (любая кнопка, svg, текст)
          if (node.querySelector('button, svg, img') || (node.textContent || '').trim()) return true;
        }
      }
      return false;
    };
    matcher.scope = isGemini ? null : composer;   // где искать «плашку» при проверке scanAttached (null → весь документ)
    return isGemini ? makeGeminiMatcher(files, wantImage, hit, matcher) : matcher;
  }

  // Matcher Gemini: успех = (а) композер получил/обновил класс with-file-preview ИЛИ (б) имя файла появилось в body
  // (не чаще раза в 200 мс; если имя уже было на странице до вставки — не считается). Для картинок ещё и новый IMG[src^=blob:/data:].
  const GEMINI_PREVIEW_SEL = '[class*="with-file-preview"]';
  const GEMINI_BLOB_SEL = 'img[src^="blob:"], img[src^="data:"]';
  function makeGeminiMatcher(files, wantImage, hit, base) {
    const previewSig = () => Array.from(document.querySelectorAll(GEMINI_PREVIEW_SEL))
      .map((el) => el.querySelectorAll('*').length + ':' + (el.textContent || '').length).join('|');
    const blobCount = () => Array.from(document.querySelectorAll(GEMINI_BLOB_SEL)).filter((i) => !i.closest('#zef-overlay, .zef-toast')).length;
    const bodyHasName = () => !!document.body && hit((document.body.textContent || '').slice(0, 300000).toLowerCase());
    const sig0 = previewSig();
    const blob0 = wantImage ? blobCount() : 0;
    const nameBefore = bodyHasName();
    let lastBody = 0;
    const yes = (why) => { log('Gemini matcher: успех —', why); return true; };
    const bodyCheck = () => {
      const now = Date.now();
      if (nameBefore || now - lastBody < 200) return false;
      lastBody = now;
      return bodyHasName() ? yes('имя файла в body') : false;
    };
    const poll = () => {
      if (previewSig() !== sig0) return yes('with-file-preview');
      if (wantImage && blobCount() > blob0) return yes('img blob/data');
      return bodyCheck();
    };
    const m = (node) => {
      if (base(node)) return yes('имя файла в добавленном узле / композер');
      if (node.nodeType !== 1) return false;
      if (node.closest && node.closest('#zef-overlay, .zef-toast')) return false;
      if (node.matches(GEMINI_PREVIEW_SEL) || node.querySelector(GEMINI_PREVIEW_SEL) || node.closest(GEMINI_PREVIEW_SEL)) {
        if (previewSig() !== sig0) return yes('with-file-preview (узел)');
      }
      if (wantImage && (node.matches(GEMINI_BLOB_SEL) || node.querySelector(GEMINI_BLOB_SEL)) && blobCount() > blob0) return yes('img blob/data (узел)');
      return bodyCheck();
    };
    m.poll = poll;
    m.scope = null;
    return m;
  }

  // Один проход по узлам, появившимся ПОСЛЕ baseline: видит ли matcher прикреплённый файл (чип мог появиться позже окна наблюдения).
  // Область: композер (если известен), иначе весь документ; не больше SCAN_LIMIT узлов.
  const SCAN_LIMIT = 2000;
  function snapshotNodes(scope) {
    const set = new WeakSet();
    try { Array.from((scope || document).querySelectorAll('*')).slice(0, SCAN_LIMIT).forEach((n) => set.add(n)); } catch (e) { /* не критично */ }
    return set;
  }
  function snapshotBlobs() {
    const set = new Set();
    try {
      Array.from(document.querySelectorAll('img[src^="blob:"], img[src^="data:"]')).slice(0, 100).forEach((i) => {
        if (!i.closest('#zef-overlay, .zef-toast')) set.add(i.src);
      });
    } catch (e) { /* не критично */ }
    return set;
  }
  function scanAttached(matcher, baseline, blobBaseline) {
    try {
      if (matcher.poll && matcher.poll()) return true;   // Gemini: состояние композера (класс), а не добавленные узлы
      // Картинки: любые новые blob/data-изображения на странице
      if (blobBaseline) {
        const current = new Set();
        try {
          Array.from(document.querySelectorAll('img[src^="blob:"], img[src^="data:"]')).slice(0, 100).forEach((i) => {
            if (!i.closest('#zef-overlay, .zef-toast')) current.add(i.src);
          });
        } catch (e) { /* не критично */ }
        for (const src of current) {
          if (!blobBaseline.has(src)) return true;
        }
      }
      const list = Array.from((matcher.scope || document).querySelectorAll('*')).slice(0, SCAN_LIMIT);
      for (const el of list) {
        if (baseline.has(el) || el.closest('#zef-overlay, .zef-toast')) continue;
        if (matcher(el)) return true;
      }
      // Последний шанс: имя файла в body (если композер неизвестен или матчер его не видит)
      const hit = matcher.hit || (() => false);
      if (hit && document.body && hit((document.body.textContent || '').slice(0, 300000).toLowerCase())) return true;
    } catch (e) { /* не мешаем странице */ }
    return false;
  }

  // Следит за добавлением узлов; как только matcher узнал «плашку файла», сразу отвечает «да».
  function watchPageChange(ms, matcher) {
    let settled = false;
    let resolveFn;
    let timer;
    let pollTimer = null;
    const done = new Promise((r) => { resolveFn = r; });
    const finish = (v) => { if (settled) return; settled = true; clearTimeout(timer); if (pollTimer) clearInterval(pollTimer); mo.disconnect(); resolveFn(v); };
    const mo = new MutationObserver((list) => {
      for (const m of list) {
        for (const n of m.addedNodes) {
          let ok = false;
          try { ok = matcher(n); } catch (e) { /* не мешаем странице */ }
          if (ok) { finish(true); return; }
        }
      }
    });
    mo.observe(document, { childList: true, subtree: true });
    timer = setTimeout(() => finish(false), ms);
    // Только Gemini: класс with-file-preview ставится атрибутом (не добавлением узла), поэтому состояние опрашиваем сами (в т.ч. на 450 и 900 мс)
    if (typeof matcher.poll === 'function') {
      pollTimer = setInterval(() => { try { if (matcher.poll()) finish(true); } catch (e) { /* не мешаем странице */ } }, 150);
    }
    return { done, stop: () => finish(false) };
  }

  // Запоминаем для сайта, какой способ сработал (отдельно для картинок и документов): в следующий раз он идёт первым.
  const siteHost = location.hostname;
  const isQwen = /(^|\.)qwen(lm)?\.ai$/i.test(siteHost);
  const isGemini = /(^|\.)gemini\.google\.com$/i.test(siteHost);
  const isClaude = /(^|\.)claude\.ai$/i.test(siteHost);

  // ---- Qwen: вложение принимается только после «+» → пункт «Загрузить файл» (там выставляется внутреннее состояние) ----
  // Точные селекторы по живой разметке Qwen (DevTools)
  const QWEN_PLUS_SEL = '.mode-select-open[role="button"], [role="button"][aria-label="Выбрать режим"]';
  const QWEN_ITEM_NAME_SEL = '.mode-select-dropdown-item-name';
  const QWEN_ITEM_TEXT = 'Загрузить вложение';

  const isShown = (el) => !!(el && el.isConnected && el.getClientRects().length);
  const attrClass = (el) => (el.getAttribute && el.getAttribute('class')) || '';
  function describeEl(el) {
    const inner = el.querySelector && el.querySelector('[class], use');
    const useRef = inner && inner.tagName && inner.tagName.toLowerCase() === 'use'
      ? (inner.getAttribute('href') || inner.getAttribute('xlink:href') || '') : '';
    return [el.getAttribute('aria-label'), el.getAttribute('title'), (el.textContent || '').trim().slice(0, 40),
      attrClass(el), inner ? attrClass(inner) : '', useRef].filter(Boolean).join(' | ');
  }
  const elLabel = (el) => el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (attrClass(el) ? '.' + attrClass(el).trim().split(/\s+/).slice(0, 3).join('.') : '');

  // Кнопка «+» (переключатель режимов): точный селектор, без эвристики
  function findQwenPlus() {
    const list = Array.from(document.querySelectorAll(QWEN_PLUS_SEL)).filter((el) => isShown(el) && !el.closest('#zef-overlay, .zef-toast'));
    return list[0] || null;
  }

  // Пункт меню «Загрузить вложение»: по тексту в .mode-select-dropdown-item-name, клик — по ближайшему [role="menuitem"]
  function findQwenMenuItem() {
    const names = Array.from(document.querySelectorAll(QWEN_ITEM_NAME_SEL));
    const nameEl = names.find((el) => isShown(el) && (el.textContent || '').trim() === QWEN_ITEM_TEXT);
    if (nameEl) return nameEl.closest('[role="menuitem"]') || nameEl;
    // запасной путь: любой видимый menuitem с этим текстом
    return Array.from(document.querySelectorAll('[role="menuitem"]'))
      .find((el) => isShown(el) && (el.textContent || '').includes(QWEN_ITEM_TEXT)) || null;
  }

  function fireClick(el) {
    ['pointerdown', 'mousedown', 'pointerup', 'mouseup'].forEach((t) => {
      try { el.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window })); } catch (e) { /* не мешаем */ }
    });
    el.click();
  }

  // «+» → «Загрузить файл». allowDialog=false: системный диалог, который пункт меню пытается открыть, гасим (файл подставим сами).
  async function activateQwenUpload(editor, allowDialog) {
    const res = { plus: null, item: null, inputClicked: false };
    if (!isQwen) return res;                         // охрана внутри самой функции: на чужих хостах «+» не ищем и не кликаем
    const prevBypass = bypass;
    const guard = (e) => {
      const path = (e.composedPath && e.composedPath()) || [e.target];
      if (!path.find((n) => n && n.tagName === 'INPUT' && n.type === 'file')) return;
      res.inputClicked = true;
      if (!allowDialog) e.preventDefault();
    };
    bypass = true;                                   // наш перехватчик кликов по input[type=file] не должен открывать панель
    document.addEventListener('click', guard, true);
    try {
      const plus = findQwenPlus();
      log('Qwen: кнопка «+»:', plus ? elLabel(plus) + ' [' + describeEl(plus).slice(0, 80) + ']' : 'не найдена');
      if (!plus) return res;
      res.plus = plus;
      fireClick(plus);
      await sleep(80);
      const item = findQwenMenuItem();
      log('Qwen: пункт меню:', item ? elLabel(item) + ' [' + (item.textContent || '').trim().slice(0, 50) + ']' : 'не найден');
      if (!item) {
        try { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); } catch (e) { /* не критично */ }
        return res;
      }
      res.item = item;
      fireClick(item.closest('[role="menuitem"], li, button, [role="button"]') || item);
      // ждём до 700 мс: Qwen сам кликает по input[type=file]; если успел — второй click не нужен
      for (let t = 0; t < 7 && !res.inputClicked; t++) await sleep(100);
      log('Qwen: активация выполнена, клик по input[type=file] был =', res.inputClicked);
    } catch (e) { log('Qwen: activateQwenUpload ошибка:', e); }
    finally { document.removeEventListener('click', guard, true); bypass = prevBypass; }
    return res;
  }

  // ---- Gemini: «+» (Загрузка и инструменты) → «Загрузить файлы»; поле input.hidden-file-input создаётся только после клика по пункту ----
  const GEMINI_PLUS_SEL = 'button[aria-label="Загрузка и инструменты"], gem-icon-button.menu-button[aria-haspopup="menu"] button';
  const GEMINI_ITEM_SEL = 'button[data-test-id="local-images-files-uploader-button"]';
  const GEMINI_ITEM_TEXT = 'Загрузить файлы';

  function findGeminiMenuItem() {
    const byId = Array.from(document.querySelectorAll(GEMINI_ITEM_SEL)).find(isShown);
    if (byId) return byId;
    const t = Array.from(document.querySelectorAll('button, [role="menuitem"], span')).find((el) =>
      isShown(el) && !el.closest('#zef-overlay, .zef-toast') && (el.textContent || '').trim() === GEMINI_ITEM_TEXT);
    return t ? (t.closest('button, [role="menuitem"]') || t) : null;
  }

  // allowDialog=false: программный input.click() сайта гасим и запоминаем сам input (файл подставим сами).
  // allowDialog=true: ничего не гасим — сайт сам откроет системный диалог.
  async function activateGeminiUpload(editor, allowDialog) {
    const res = { plus: null, item: null, inputClicked: false, input: null };
    if (!isGemini) return res;                       // охрана: только gemini.google.com
    const prevBypass = bypass;
    const guard = (e) => {
      const path = (e.composedPath && e.composedPath()) || [e.target];
      const inp = path.find((n) => n && n.tagName === 'INPUT' && n.type === 'file');
      if (!inp) return;
      res.inputClicked = true;
      res.input = inp;
      if (!allowDialog) e.preventDefault();
    };
    bypass = true;                                   // наш перехватчик кликов по input[type=file] не должен открывать панель
    document.addEventListener('click', guard, true);
    try {
      const plus = Array.from(document.querySelectorAll(GEMINI_PLUS_SEL)).find((el) => isShown(el) && !el.closest('#zef-overlay, .zef-toast')) || null;
      log('Gemini: кнопка «+»:', plus ? elLabel(plus) : 'не найдена');
      if (!plus) return res;
      res.plus = plus;
      fireClick(plus);
      await sleep(150);
      const item = findGeminiMenuItem();
      log('Gemini: пункт меню:', item ? elLabel(item) : 'не найден');
      if (!item) {
        try { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); } catch (e) { /* не критично */ }
        return res;
      }
      res.item = item;
      fireClick(item);
      for (let t = 0; t < 7 && !res.inputClicked; t++) await sleep(100);   // до 700 мс: сайт сам кликает по input
      log('Gemini: клик по input[type=file] был =', res.inputClicked, '| input:', res.input ? describeInput(res.input) : null);
    } catch (e) { log('Gemini: activateGeminiUpload ошибка:', e); }
    finally { document.removeEventListener('click', guard, true); bypass = prevBypass; }
    return res;
  }

  // Версия кеша стратегий: при обновлении расширения (версия из manifest.json) старые стратегии сбрасываем целиком
  const stratReady = (async () => {
    try {
      const ver = api.runtime.getManifest().version;
      const o = await api.storage.local.get('zefStratVersion');
      if (o.zefStratVersion !== ver) {
        await api.storage.local.set({ zefStrat: {}, zefStratVersion: ver });
        log('zefStrat: кеш стратегий сброшен, версия', ver);
      }
    } catch (e) { /* не критично */ }
  })();

  async function loadStrategy(kind) {
    try { await stratReady; const o = await api.storage.local.get('zefStrat'); return ((o.zefStrat || {})[siteHost] || {})[kind] || null; }
    catch (e) { return null; }
  }
  async function saveStrategy(kind, id) {
    try {
      await stratReady;
      const o = await api.storage.local.get('zefStrat');
      const all = o.zefStrat || {};
      all[siteHost] = Object.assign(all[siteHost] || {}, { [kind]: id });
      await api.storage.local.set({ zefStrat: all });
    } catch (e) { /* не критично */ }
  }

  // Подпись файла по СОДЕРЖИМОМУ (не по имени): тип + размер + FNV-1a по первым и последним 64 КБ
  async function fileSig(f) {
    const n = f.size;
    let h = 0x811c9dc5;
    const eat = (u) => { for (let i = 0; i < u.length; i++) { h ^= u[i]; h = Math.imul(h, 0x01000193) >>> 0; } };
    eat(new Uint8Array(await f.slice(0, 65536).arrayBuffer()));
    if (n > 131072) eat(new Uint8Array(await f.slice(n - 65536).arrayBuffer()));
    return (f.type || '') + '|' + n + '|' + h.toString(16);
  }

  // Дедупликация: файл с той же подписью, уже прикреплённый в текущей сессии панели (ctx), второй раз не вставляем
  async function attachFiles(files) {
    if (attaching) return;
    attaching = true;
    try {
      const seen = ctx ? (ctx.sigs || (ctx.sigs = new Set())) : null;
      const local = new Set();
      const fresh = [];
      for (const f of files) {
        let sig = null;
        try { sig = await fileSig(f); } catch (e) { console.warn('[ZEF] fileSig:', e); }
        if (sig && (local.has(sig) || (seen && seen.has(sig)))) { log('дубль пропущен (то же содержимое):', f.name, sig); continue; }
        if (sig) local.add(sig);
        fresh.push({ f, sig });
      }
      if (!fresh.length) return;
      const ok = await doAttach(fresh.map((x) => x.f));
      if (ok && seen) fresh.forEach((x) => { if (x.sig) seen.add(x.sig); });   // помечаем только реально отправленные: повтор после неудачи не блокируется
    } finally { attaching = false; }
  }

  // Пробуем способы по очереди; следующий — только если файл так и не появился на странице.
  // Об успехе сообщаем, только если файл действительно появился.
  async function doAttach(files) {
    const c = ctx || {};
    const names = files.map((f) => f.name).join(', ');
    const kind = files.every((f) => /^image\//.test(f.type)) ? 'image' : 'doc';
    let steps = [];
    let anchor = null;
    const gFlags = { overlay: false, input: false };   // Gemini: нашли ли область сброса / поле загрузки
    let gMatcher = null;                               // Gemini: matcher (создаётся ниже), нужен шагу gchain для повторного change
    log('host:', siteHost, '| isQwen:', isQwen, '| isGemini:', isGemini);

    if (c.input) {
      // человек нажал скрепку сайта: нужное поле известно точно, проверка не нужна
      steps.push({ id: 'input', label: 'Прикреплено', trust: true, run: () => setInputFiles(c.input, files, isQwen) });
    } else {
      const editor = c.focusEl && c.focusEl.isConnected && isEditable(c.focusEl) ? c.focusEl : null;
      anchor = editor;
      const ranked = rankInputs(files, c.focusEl, !!editor);
      log('вставка по хоткею. Редактор:', editor && (editor.tagName + (editor.id ? '#' + editor.id : '')), '| тип:', kind, '| поля загрузки:', ranked.map(describeInput));
      if (editor) steps.push({ id: 'paste', label: 'Вставлено', run: () => tryPaste(editor, files) });
      if (editor) steps.push({ id: 'ctrlv', label: 'Вставлено (как Ctrl+V)', run: () => tryTrustedPaste(editor, files) });
      if (isGemini) steps.push({ id: 'gchain', label: 'Прикреплено', run: async () => {
        // Gemini: «+» → «Загрузить файлы»; программный click по input гасим, сам input запоминаем и пишем в него файлы
        const r = await activateGeminiUpload(editor, false);
        log('Gemini: цепочка: plus =', !!r.plus, '| item =', !!r.item, '| inputClicked =', r.inputClicked);
        const target = r.input || usableInputs(document).find((i) => i.classList.contains('hidden-file-input'));
        if (!target) return false;
        gFlags.input = true;
        setInputFiles(target, files);
        // matcher молчит 800 мс → повторный change в page-контексте (слушатель Gemini может жить в page-scope)
        for (let t = 0; t < 8; t++) {
          await sleep(100);
          if (gMatcher && gMatcher.poll && gMatcher.poll()) return true;
        }
        log('Gemini: matcher молчит 800 мс → повторный change в page-контексте');
        fireInPage(target, 'change');
        return true;
      } });
      if (ranked[0]) steps.push({ id: 'input', label: 'Прикреплено', run: async () => {
        let target = ranked[0];
        if (isQwen && kind === 'doc') {
          // Qwen: сначала «+» → «Загрузить файл», потом заново ищем поле (оно могло пересоздаться)
          await activateQwenUpload(editor, false);
          const byId = document.querySelector('input#filesUpload[type="file"]');
          target = (byId && !byId.disabled && byId) || rankInputs(files, c.focusEl, !!editor)[0] || target;
          log('Qwen: пишу файлы в поле:', describeInput(target));
        }
        if (isGemini) gFlags.input = true;   // поле загрузки на странице есть: итоговый тост «не нашёл поле» не нужен
        return setInputFiles(target, files, isQwen);
      } });
      if (editor) steps.push({ id: 'drop', label: 'Перетащено', run: () => tryDrop(editor, files) });
      if (editor && isGemini && kind === 'doc') {
        // Gemini + документ: сначала любой input[type=file], затем (ПОСЛЕДНИЙ фолбэк) drop на overlay
        steps.push({ id: 'ginput', label: 'Прикреплено', run: async () => {
          let target = null;
          for (let t = 0; t < 10 && !target; t++) {
            target = rankInputs(files, c.focusEl, false)[0] || null;
            if (!target) await sleep(100);
          }
          if (!target) { log('Gemini: input[type=file] не найден'); return false; }
          gFlags.input = true;
          log('Gemini: пишу файлы в поле:', describeInput(target));
          return setInputFiles(target, files);
        } });
        steps.push({ id: 'gdrop', label: 'Перетащено на область сброса', run: () => tryGeminiDrop(editor, files, gFlags) });
      } else if (editor && !isQwen) steps.push({ id: 'zone', label: 'Перетащено на область сброса', run: () => tryDropOnZone(editor, files) });   // на Qwen зона находит мусор
      const known = await loadStrategy(kind);
      const i = steps.findIndex((st) => st.id === known);
      if (i > 0) steps = [steps[i]].concat(steps.slice(0, i), steps.slice(i + 1));   // что работало на этом сайте раньше — первым
      if (editor) { editor.focus({ preventScroll: true }); await sleep(80); }          // фокус должен «осесть» до наблюдения за страницей
    }
    if (!steps.length) throw new Error('на странице нет поля загрузки. Поставь курсор в поле ввода или нажми скрепку');

    // Скриншоты/картинки по хоткею: fire-and-forget. Берём ПЕРВЫЙ способ, который смог отправить файл, и сразу выходим:
    // без ожидания и опроса DOM (у contenteditable-редакторов подтверждения нет → раньше были зависание, ложная ошибка и дубли
    // от запуска следующего способа поверх уже сработавшего).
    if (kind === 'image' && !c.input) {
      let sent = null;
      dub('порядок шагов:', steps.map((s) => s.id).join(' → '));
      traceBegin(names);
      for (const st of steps) {
        let res = false;
        dub('шаг start:', st.id);
        try { res = await st.run(); } catch (e) { console.warn('[ZEF] способ не удался:', st.label, e); }
        dub('шаг end:', st.id, '→ вернул', res);
        if (res) { sent = st; break; }
      }
      closePanel();
      if (sent) {
        console.log('[ZEF] отправлено без ожидания подтверждения:', sent.label, names);
      } else console.warn('[ZEF] ни один способ не смог отправить файл:', names);
      return !!sent;
    }

    const matcher = makeMatcher(files, anchor);
    gMatcher = matcher;
    // Защита от дублей: перед следующим способом проверяем, не появился ли файл «с опозданием» после предыдущего.
    // Скриншоты на всех хостах (потому что image) + документы на Gemini; Qwen, ВБ КЦ и прочие хосты — для image тоже.
    const useScan = !c.input && (kind === 'image' || (kind === 'doc' && isGemini));
    const baseline = useScan ? snapshotNodes(matcher.scope) : null;
    const blobBaseline = useScan && kind === 'image' ? snapshotBlobs() : null;
    let lastDispatched = null;
    let used = null;
    let lastErr = null;
    let dispatchedAny = false;
    for (let i = 0; i < steps.length && !used; i++) {
      const st = steps[i];
      if (useScan && lastDispatched && scanAttached(matcher, baseline, blobBaseline)) {
        log('scanAttached: файл уже на странице после «' + lastDispatched.label + '», способ «' + st.label + '» не запускаю');
        used = lastDispatched;
        saveStrategy(kind, used.id);
        break;
      }
      const watch = st.trust ? null : watchPageChange(STEP_WAIT_MS, matcher);
      let res = false;
      try { res = await st.run(); } catch (e) { lastErr = e; log('способ не удался:', st.label, e); }
      if (!res) { if (watch) watch.stop(); continue; }
      dispatchedAny = true;
      if (!watch) { used = st; break; }
      lastDispatched = st;
      const appeared = await watch.done;
      log('способ «' + st.label + '»: файл появился на странице =', appeared);
      if (appeared) { used = st; saveStrategy(kind, st.id); }
    }

    if (used) {
      log('attached:', used.label, names);
      closePanel();
      console.log('[ZEF] прикреплено:', names);
      return true;
    }
    // Запоздавший чип мог появиться после всех шагов (например, race между paste и inputFiles)
    if (useScan && dispatchedAny && scanAttached(matcher, baseline, blobBaseline)) {
      log('scanAttached после цикла: файл появился, считаем предыдущий способ успешным');
      used = lastDispatched;
      saveStrategy(kind, used.id);
      closePanel();
      console.log('[ZEF] прикреплено (поздний скан):', names);
      return true;
    }
    if (!dispatchedAny) throw lastErr || new Error('на странице нет подходящего поля загрузки');
    // Ошибок пользователю не показываем: только диагностика в консоль
    closePanel();
    if (isGemini && kind === 'doc' && !c.input && !gFlags.overlay && !gFlags.input) console.warn('[ZEF] Gemini: нет ни поля загрузки, ни области сброса');
    else console.warn('[ZEF] файл не появился на странице ни одним способом');
    return false;
  }

  // Системный диалог выбора файла (кнопка «Перетащите файл или нажмите»)
  async function openNativeDialog() {
    const c = ctx || {};
    if (isGemini && !c.input) {
      // Gemini: input появляется только после «+» → «Загрузить файлы»; сайт сам откроет системный диалог, файл крепится нативно
      closePanel();
      const gEditor = c.focusEl && c.focusEl.isConnected && isEditable(c.focusEl) ? c.focusEl : null;
      const r = await activateGeminiUpload(gEditor, true);
      log('Gemini: dropzone: plus =', !!r.plus, '| item =', !!r.item, '| inputClicked =', r.inputClicked);
      if (!r.inputClicked) console.warn('[ZEF] Gemini: диалог выбора файла не открылся');
      return;
    }
    let input = c.input || rankInputs([], c.focusEl, false)[0];   // без файлов: берём самое «широкое» поле (любые файлы)
    if (!input) { console.warn('[ZEF] поле загрузки на странице не найдено'); return; }
    let alreadyOpened = false;
    if (isQwen) {
      // Qwen: «+» → «Загрузить файл» выставляет состояние и вешает обработчик; пункт меню сам открывает диалог
      closePanel();
      const editor = c.focusEl && c.focusEl.isConnected && isEditable(c.focusEl) ? c.focusEl : null;
      const r = await activateQwenUpload(editor, true);
      alreadyOpened = r.inputClicked;
      if (!alreadyOpened) log('Qwen: цепочка «+» → пункт меню не открыла диалог («+» найден:', !!r.plus, ', пункт найден:', !!r.item, '). Фолбэк: click по полю после активации');
      const byId = document.querySelector('input#filesUpload[type="file"]');
      if (byId && !byId.disabled) input = byId;
    }
    if (alreadyOpened) { log('Qwen: диалог уже открыт пунктом меню'); return; }
    log('системный диалог через поле:', describeInput(input));
    bypass = true;
    try { input.click(); } catch (e) { log('input.click ошибка:', e); } finally { bypass = false; }
    closePanel();
  }

  // ---------------- данные ----------------
  async function refresh(poll) {
    if (poll) await send({ action: 'pollClipboard' });
    const res = await send({ action: 'list' });
    if (!overlay) return;
    if (!res || !res.clips) { console.warn('[ZEF] нет связи с фоновой страницей расширения'); return; }
    data = res;
    lastSig = res.sig || '';
    renderPanel();
  }

  // Файл всегда собирается из байтов в памяти САМОЙ страницы: так он не зависит от фоновой страницы расширения
  async function materialize(item, source) {
    if (source === 'download') {
      if (!item.canRefetch) throw new Error('этот файл нельзя прочитать из браузера. Нажми «Выбрать файл» и укажи его вручную');
      const r = await send({ action: 'getDownload', id: item.id });
      if (!r || !r.ok) throw new Error((r && r.error) || 'не удалось получить файл');
      return new File([r.buf], r.name, { type: r.type });
    }
    return new File([item.buf], item.name, { type: item.type, lastModified: item.ts });
  }

  // ---------------- панель ----------------
  // Разметка панели: подписи из t() — статичные строки расширения, данных страницы здесь нет
  const panelHtml = () => `
    <div id="zef-panel">
      <div class="zef-header">
        <div class="zef-title">📋 ${t('panel_title')}</div>
        <button class="zef-btn" id="zef-refresh-btn">🔄 ${t('btn_refresh')}</button>
        <span class="zef-gap"></span>
        <button class="zef-btn" id="zef-clear-btn">🗑️ ${t('btn_clear')}</button>
        <button class="zef-btn zef-btn-close" id="zef-close-btn" aria-label="${t('btn_close')}">✕</button>
      </div>
      <div class="zef-body">
        <div class="zef-dropzone" id="zef-dropzone">
          <div class="zef-dropzone-icon">📂</div>
          <div class="zef-dropzone-title">${t('dropzone_pick')}</div>
        </div>
        <div class="zef-divider"></div>
        <div class="zef-section-label">${t('section_buffer')}</div>
        <div class="zef-items-row" id="zef-clip-row"></div>
        <div class="zef-divider"></div>
        <div class="zef-section-label">${t('section_downloads')}</div>
        <div class="zef-items-row" id="zef-download-row"></div>
      </div>
    </div>`;

  // Тема / акцент / прозрачность: класс темы на #zef-overlay + CSS-переменные --zef-accent, --zef-bg-alpha
  function applySettings(el) {
    const s = settings;
    const dark = s.theme === 'dark' || (s.theme !== 'light' && !(window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches));
    el.classList.add(dark ? 'zef-theme-dark' : 'zef-theme-light');
    if (/^#[0-9a-f]{6}$/i.test(s.accent || '')) el.style.setProperty('--zef-accent', s.accent);
    const a = Math.min(100, Math.max(40, Number(s.opacity) || 100));
    el.style.setProperty('--zef-bg-alpha', String(a / 100));
  }

  function openPanel(input, mode) {
    if (overlay) closePanel();
    const focusEl = deepActive();
    const editor = mode === 'hotkey' && isEditable(focusEl);
    const acceptSrc = input || (mode === 'hotkey' && !editor ? findNearestInput(focusEl) : null);
    ctx = { input: input || null, mode, focusEl: mode === 'hotkey' ? focusEl : null, accept: parseAccept(acceptSrc) };

    overlay = document.createElement('div');
    overlay.id = 'zef-overlay';
    const parsedDoc = new DOMParser().parseFromString(panelHtml(), 'text/html');
overlay.replaceChildren(...parsedDoc.body.childNodes);
    applySettings(overlay);
    document.documentElement.appendChild(overlay);
    wirePanel();
    requestAnimationFrame(() => { if (overlay) overlay.classList.add('zef-visible'); });

    document.addEventListener('keydown', onEscape, true);
    pollTimer = setInterval(async () => {
      if (document.hidden || !overlay) return;
      const r = await send({ action: 'signature' });
      if (r && r.sig && r.sig !== lastSig) refresh(false);   // фон сам забирает скриншоты, панель только перерисовывается
    }, 1200);
    refresh(true);
  }

  function closePanel() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    document.removeEventListener('keydown', onEscape, true);
    if (overlay) {
      const o = overlay;
      overlay = null;
      o.classList.remove('zef-visible');
      setTimeout(() => o.remove(), 160);
    }
  }

  function onEscape(e) { if (e.key === 'Escape') { e.stopPropagation(); closePanel(); } }

  function wirePanel() {
    const q = (s) => overlay.querySelector(s);
    const panel = q('#zef-panel');
    const dz = q('#zef-dropzone');

    q('#zef-close-btn').addEventListener('click', (e) => { e.stopPropagation(); closePanel(); });
    overlay.addEventListener('click', (e) => { if (e.target === overlay) closePanel(); });

    q('#zef-refresh-btn').addEventListener('click', async (e) => {
      e.stopPropagation();
      await refresh(true);
      console.log('[ZEF] список обновлён');
    });

    q('#zef-clear-btn').addEventListener('click', async (e) => {
      e.stopPropagation();
      await send({ action: 'clear' });
      data = { clips: [], hist: [], downloads: [] };
      renderPanel();
      console.log('[ZEF] список очищен');
    });

    dz.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); openNativeDialog(); });

    // Колёсико мыши листает ленту файлов по горизонтали
    const body = q('.zef-body');
    if (body) body.addEventListener('wheel', (e) => {
      e.preventDefault();
      body.scrollLeft += Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    }, { passive: false });

    // Защита от браузерного drop на всю страницу (уведёт со страницы или активирует чужой dropzone)
    overlay.addEventListener('dragover', (e) => {
      if (e.dataTransfer.types.includes('Files')) {
        e.preventDefault();
        e.stopPropagation();
      }
    });
    overlay.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();
    });
  }

  function renderPanel() {
    if (!overlay) return;
    fillRow('#zef-clip-row', data.clips, 'clip', 'empty_clip');
    fillRow('#zef-download-row', data.downloads, 'download', 'empty_dl');
  }

  function fillRow(sel, items, source, emptyKey) {
    const row = overlay.querySelector(sel);
    row.textContent = '';
    if (!items || !items.length) {
      const e = document.createElement('div');
      e.className = 'zef-empty';
      e.append(t('empty_title'), document.createElement('br'));
      const sm = document.createElement('small');
      sm.textContent = t(emptyKey);       // только textContent: никаких данных страницы в HTML
      e.appendChild(sm);
      row.appendChild(e);
      return;
    }
    items.forEach((it) => row.appendChild(createItemEl(it, source)));
  }

  // Миниатюра рисуется на canvas: строгая CSP сайта (img-src) её не блокирует
  async function paintThumb(canvas, item) {
    try {
      const bmp = await createImageBitmap(new Blob([item.buf], { type: item.type }));
      const side = Math.min(bmp.width, bmp.height);
      const g = canvas.getContext('2d');
      g.drawImage(bmp, (bmp.width - side) / 2, (bmp.height - side) / 2, side, side, 0, 0, canvas.width, canvas.height);
      if (bmp.close) bmp.close();
    } catch (e) {
      const s = document.createElement('span');
      s.className = 'zef-icon';
      s.textContent = iconFor(item.name);
      canvas.replaceWith(s);
    }
  }

  function createItemEl(item, source) {
    const el = document.createElement('div');
    el.className = 'zef-item';
    if (source === 'download' && !item.canRefetch) el.classList.add('zef-warn');
    if (ctx && !matchesAccept(ctx.accept, item.name, item.type)) el.classList.add('zef-dim');

    const thumb = document.createElement('div');
    thumb.className = 'zef-thumb';
    if (source !== 'download' && isRaster(item)) {
      const c = document.createElement('canvas');
      c.width = 120; c.height = 120;
      thumb.appendChild(c);
      paintThumb(c, item);
    } else {
      const s = document.createElement('span');
      s.className = 'zef-icon';
      s.textContent = iconFor(item.name);
      thumb.appendChild(s);
    }

    const name = document.createElement('div');
    name.className = 'zef-name';
    name.textContent = item.name;
    name.title = item.name;

    const meta = document.createElement('div');
    meta.className = 'zef-meta';
    meta.textContent = [fmtSize(item.size), ago(item.ts)].filter(Boolean).join(', ');

    el.append(thumb, name, meta);

    if (source === 'clip' && Date.now() - item.ts < 2 * 60 * 1000) {
      const b = document.createElement('div');
      b.className = 'zef-badge';
      b.textContent = t('badge_new');
      el.appendChild(b);
    }

    if (source !== 'download') {
      const x = document.createElement('button');
      x.className = 'zef-x';
      x.textContent = '✕';
      x.title = t('item_remove');
      x.addEventListener('click', async (e) => {
        e.stopPropagation();
        await send({ action: 'deleteItem', id: item.id });
        const list = data.clips;
        const i = list.findIndex((v) => v.id === item.id);
        if (i >= 0) list.splice(i, 1);
        renderPanel();
      });
      el.appendChild(x);
    }

    el.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (el.classList.contains('zef-busy')) return;
      el.classList.add('zef-busy');
      try {
        const file = await materialize(item, source);
        await attachFiles([file]);
      } catch (err) {
        console.warn('[ZEF] attach error:', err);   // пользователю ничего не показываем
      } finally { el.classList.remove('zef-busy'); }
    });
    return el;
  }

  // ---------------- перехват скрепки / input[type=file] ----------------
  document.addEventListener('click', (e) => {
    try {
      if (bypass || e.shiftKey) return;                                   // Shift+клик = обычный системный диалог
      // composedPath находит поле, даже если оно спрятано в shadow DOM кастомного элемента
      const path = (e.composedPath && e.composedPath()) || [e.target];
      const t = path.find((n) => n && n.tagName === 'INPUT' && n.type === 'file');
      if (!t || t.disabled || t.webkitdirectory) return;
      // пока человек ни разу не взаимодействовал со страницей, диалог всё равно не откроется: не лезем
      if (navigator.userActivation && !navigator.userActivation.hasBeenActive) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      log('перехвачен выбор файла, открываю панель');
      openPanel(t, 'input');
    } catch (err) { log('click handler error:', err); }
  }, true);

  // ---------------- своя горячая клавиша (второй хоткей, в дополнение к Alt+V из манифеста) ----------------
  // Формат комбинации (тот же в options.js): «Ctrl+Alt+Shift+Meta+Клавиша»; буквы/цифры берём по e.code (не зависит от раскладки)
  function normCombo(s) {
    if (typeof s !== 'string') return '';
    // Комбинация из манифеста Alt+V уже канонична
    const order = { Ctrl: 1, Alt: 2, Shift: 3, Meta: 4 };
    const parts = s.split('+').map((p) => p.trim());
    const mods = [];
    let key = '';
    for (const p of parts) {
      const up = p.toUpperCase();
      if (up === 'CTRL' || up === 'CONTROL') mods.push('Ctrl');
      else if (up === 'ALT') mods.push('Alt');
      else if (up === 'SHIFT') mods.push('Shift');
      else if (up === 'META' || up === 'OS' || up === 'WIN') mods.push('Meta');
      else key = p;
    }
    mods.sort((a, b) => order[a] - order[b]);
    if (!key) return s; // если что-то сломано, вернём как было
    return [...mods, key.toUpperCase()].join('+');
  }
  function comboFromEvent(e) {
    if (/^(Control|Shift|Alt|AltGraph|Meta|OS)$/.test(e.key)) return '';
    let k = e.key;
    if (/^Key[A-Z]$/.test(e.code)) k = e.code.slice(3);
    else if (/^Digit\d$/.test(e.code)) k = e.code.slice(5);
    else if (k === ' ') k = 'Space';
    else if (k.length === 1) k = k.toUpperCase();
    const parts = [];
    if (e.ctrlKey) parts.push('Ctrl');
    if (e.altKey) parts.push('Alt');
    if (e.shiftKey) parts.push('Shift');
    if (e.metaKey) parts.push('Meta');
    parts.push(k);
    return normCombo(parts.join('+'));
  }
  document.addEventListener('keydown', (e) => {
    try {
      const want = normCombo(settings.hotkeyCombo);
      if (!want || want === MANIFEST_KEY || e.repeat) return;   // Alt+V обрабатывает манифест сам: capture молчит
      if (comboFromEvent(e) !== want) return;
      e.preventDefault();
      e.stopPropagation();
      if (overlay) closePanel(); else openPanel(null, 'hotkey');
    } catch (err) { log('hotkey handler error:', err); }
  }, true);

  // ---------------- горячая клавиша (из background через commands) ----------------
  api.runtime.onMessage.addListener((msg) => {
    if (msg && msg.action === 'togglePanel') {
      if (overlay) closePanel(); else openPanel(null, 'hotkey');
    }
  });

  log('v1.2 loaded');
})();

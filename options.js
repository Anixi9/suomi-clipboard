// Suomi Clipboard — экран настроек. Хранит storage.local.zefSettings = { theme, accent, opacity, lang, hotkeyCombo }
(() => {
  'use strict';
  const api = typeof browser !== 'undefined' ? browser : chrome;
  const MANIFEST_KEY = 'Alt+V';
  const DEFAULTS = { theme: 'system', accent: '', opacity: 100, lang: 'system', hotkeyCombo: MANIFEST_KEY };
  const $ = (id) => document.getElementById(id);

  let settings = Object.assign({}, DEFAULTS);
  let msgs = null;            // словарь выбранного вручную языка (null = системный)
  let recording = false;
  let savedTimer = null;

  const t = (key) => {
    try {
      if (msgs && msgs[key] && msgs[key].message) return msgs[key].message;
      return api.i18n.getMessage(key) || key;
    } catch (e) { return key; }
  };

  async function loadMessages() {
    msgs = null;
    if (settings.lang === 'ru' || settings.lang === 'en') {
      try {
        const r = await fetch(api.runtime.getURL('_locales/' + settings.lang + '/messages.json'));
        msgs = await r.json();
      } catch (e) { /* фолбэк: системный язык */ }
    }
  }

  function translate() {
    document.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.getAttribute('data-i18n')); });
    document.title = t('opt_title');
    if (!recording) $('hotkey-record').textContent = t('opt_hotkey_record');
  }

  function applyTheme() {
    const light = settings.theme === 'light' ||
      (settings.theme === 'system' && window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches);
    document.body.classList.toggle('light', light);
    if (/^#[0-9a-f]{6}$/i.test(settings.accent || '')) document.documentElement.style.setProperty('--accent', settings.accent);
    else document.documentElement.style.removeProperty('--accent');
  }

  function showSaved() {
    $('saved').textContent = t('opt_saved');
    clearTimeout(savedTimer);
    savedTimer = setTimeout(() => { $('saved').textContent = ''; }, 1500);
  }

  async function save() {
    try {
      await api.storage.local.set({ zefSettings: settings });
      showSaved();
    } catch (e) { console.log('[ZEF] options: сохранение не удалось', e); }
  }

  function fill() {
    $('theme').value = settings.theme;
    $('lang').value = settings.lang;
    $('opacity').value = String(settings.opacity);
    $('opacity-val').textContent = settings.opacity + '%';
    $('accent').value = /^#[0-9a-f]{6}$/i.test(settings.accent || '') ? settings.accent : '#8ab4ff';
    $('hotkey-field').value = settings.hotkeyCombo || MANIFEST_KEY;
  }

  // Тот же формат комбинации, что и в content.js (comboFromEvent): «Ctrl+Alt+Shift+Meta+Клавиша»
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
    return parts.join('+');
  }

  function normCombo(s) {
    if (typeof s !== 'string') return '';
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
    if (!key) return s;
    return [...mods, key.toUpperCase()].join('+');
  }
  function stopRecording() {
    recording = false;
    $('hotkey-field').classList.remove('rec');
    $('hotkey-record').textContent = t('opt_hotkey_record');
    $('hotkey-field').value = settings.hotkeyCombo || MANIFEST_KEY;
  }

  function onRecordKey(e) {
    if (!recording) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.key === 'Escape') { stopRecording(); return; }
    const combo = comboFromEvent(e);
    if (!combo) return;                                     // нажат только модификатор: ждём вторую клавишу
    // нужен Ctrl/Alt/Meta (одного Shift мало: комбинация перехватывала бы обычный набор текста); F1–F12 допустимы и без модификатора
    if (!(e.ctrlKey || e.altKey || e.metaKey) && !/^F([1-9]|1[0-2])$/.test(combo)) { $('hotkey-field').value = t('opt_hotkey_need_mod'); return; }
    settings.hotkeyCombo = normCombo(combo);
    stopRecording();
    save();
  }

  async function init() {
    try {
      const o = await api.storage.local.get('zefSettings');
      settings = Object.assign({}, DEFAULTS, o.zefSettings || {});
    } catch (e) { settings = Object.assign({}, DEFAULTS); }
    await loadMessages();
    translate();
    applyTheme();
    fill();

    $('theme').addEventListener('change', () => { settings.theme = $('theme').value; applyTheme(); save(); });
    $('accent').addEventListener('input', () => { settings.accent = $('accent').value; applyTheme(); });
    $('accent').addEventListener('change', () => { settings.accent = $('accent').value; applyTheme(); save(); });
    $('opacity').addEventListener('input', () => { $('opacity-val').textContent = $('opacity').value + '%'; });
    $('opacity').addEventListener('change', () => { settings.opacity = Number($('opacity').value); save(); });
    $('lang').addEventListener('change', async () => {
      settings.lang = $('lang').value;
      await save();
      await loadMessages();
      translate();
    });

    $('hotkey-record').addEventListener('click', () => {
      if (recording) { stopRecording(); return; }
      recording = true;
      $('hotkey-field').classList.add('rec');
      $('hotkey-field').value = t('opt_hotkey_press');
      $('hotkey-record').textContent = '✕';
    });
    $('hotkey-reset').addEventListener('click', () => {
      settings.hotkeyCombo = MANIFEST_KEY;
      if (recording) stopRecording();
      $('hotkey-field').value = MANIFEST_KEY;
      save();
    });
    document.addEventListener('keydown', onRecordKey, true);

    if (window.matchMedia) {
      const mq = window.matchMedia('(prefers-color-scheme: light)');
      if (mq.addEventListener) mq.addEventListener('change', applyTheme);
    }
  }

  init();
})();

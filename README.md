# Suomi Clipboard 📋

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Firefox Add-on](https://img.shields.io/badge/Firefox-Add--on-orange?logo=firefox)](https://addons.mozilla.org/)

A browser extension that replaces the OS file picker with a custom panel when attaching files. Inspired by Opera's Easy Files, rebuilt for Zen Browser and Firefox.

## ✨ Features

- **Smart File Picker**: Intercepts any "Attach" button and shows your own panel instead of Windows Explorer.
- **Clipboard Screenshots**: Automatically captures screenshots from any app. Just press PrintScreen!
- **Recent Downloads**: Quick access to files downloaded in the last 24 hours.
- **Privacy First**: No servers, no analytics. All data stored locally in IndexedDB.
- **Customizable**: Hotkeys (Alt+V), themes, accent colors, opacity.

## 🛠 Installation

1. Go to the [Suomi Clipboard page on Firefox Add-ons](https://addons.mozilla.org/firefox/addon/suomi-clipboard/).
2. Click **Add to Firefox**.
3. Done — the panel is ready. Press **Alt+V** in any chat/form, or click a site's attach button.

> The extension updates automatically from the Add-ons store. The `.zip` in [Releases](../../releases) is the signed source archive for developers only — installing unsigned zips from file is blocked by Firefox by design.
> For Chrome/Edge/Opera a Manifest V3 build is in development.
---

## 🇷🇺 О расширении

Суоми Клипборд — это аналог функции Easy Files из браузера Opera, созданный специально для Zen Browser и Firefox.

### Что умеет:
- Перехватывает кнопку «Прикрепить» на любых сайтах (мессенджеры, чаты ИИ, формы) и показывает удобную панель вместо стандартного проводника Windows.
- Автоматически подхватывает скриншоты из буфера обмена. Сделал скрин — он уже в панели.
- Показывает недавние загрузки браузера за последние 24 часа.
- Полностью приватный: никаких серверов, весь код работает локально.
- Настраиваемые горячие клавиши, темы и прозрачность.

### Установка

1. Откройте [страницу Suomi Clipboard в Firefox Add-ons](https://addons.mozilla.org/firefox/addon/suomi-clipboard/).
2. Нажмите **«Добавить в Firefox»**.
3. Готово — панель работает. Жмите **Alt+V** в любом чате/форме или кликайте по кнопке прикрепления сайта.

> Обновления приходят автоматически из магазина. `.zip` в [Releases](../../releases) — это архив исходников для разработчиков; установка неподписанных zip из файла заблокирована Firefox намеренно.
> Для Chrome/Edge/Opera готовится версия на Manifest V3.
## 🛠 Tech Stack
Vanilla JS • Manifest V2 • IndexedDB • browser.* API

## 📜 License
MIT © 2026 Anixi
Test for YOLO achievement

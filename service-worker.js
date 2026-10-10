/* 設定: アプリを変更した公開時は VERSION を更新してください。
 * CacheStorage に保存するのは固定のアプリファイルだけです。
 * 撮影 Blob、写真、動画、API 応答などは保存も送信もしません。
 */
'use strict';
const VERSION = 'v2';
const CACHE_PREFIX = 'temoto-camera-shell-';
const CACHE_NAME = CACHE_PREFIX + VERSION;
const SHELL = [
  './', './index.html', './styles.css', './app.js', './manifest.json',
  './icons/icon.svg', './icons/icon-192.png', './icons/icon-512.png',
  './icons/icon-maskable-512.png', './icons/apple-touch-icon.png',
];
const shellURLs = new Set(SHELL.map((path) => new URL(path, self.registration.scope).href));

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL)));
  // 新版は既存タブが閉じるまで待機し、異なる版のファイルの混在を避けます。
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) {
      if (name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME) await caches.delete(name);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  // 完全一致の同一オリジン・GET・静的ファイルのみ。Blob URL は対象外です。
  if (request.method !== 'GET' || !shellURLs.has(request.url)) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    return (await cache.match(request)) || fetch(request);
  })());
});

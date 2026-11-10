/* Service worker Buku Tamu Desa Merden
 * Naikkan VERSI setiap kali file aplikasi diubah agar tablet mengambil versi baru. */
const VERSI = 'bukutamu-v2';
const ASET = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.json',
  './icons/logo.svg',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSI).then(c => c.addAll(ASET)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== VERSI).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Pustaka Excel dari CDN: simpan setelah dipakai pertama kali
  if (url.hostname === 'cdn.jsdelivr.net') {
    e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(res => {
      const salin = res.clone();
      caches.open(VERSI).then(c => c.put(req, salin));
      return res;
    })));
    return;
  }

  // Panggilan API Apps Script tidak pernah di-cache
  if (url.origin !== self.location.origin) return;

  // Halaman: ambil dari jaringan, cadangan dari cache saat offline
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).then(res => {
      const salin = res.clone();
      caches.open(VERSI).then(c => c.put('./index.html', salin));
      return res;
    }).catch(() => caches.match('./index.html')));
    return;
  }

  // Aset: dari cache dulu, diperbarui di belakang layar
  e.respondWith(caches.match(req).then(hit => {
    const ambil = fetch(req).then(res => {
      if (res.ok) { const salin = res.clone(); caches.open(VERSI).then(c => c.put(req, salin)); }
      return res;
    }).catch(() => hit);
    return hit || ambil;
  }));
});

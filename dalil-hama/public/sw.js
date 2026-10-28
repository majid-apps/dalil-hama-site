// عامل الخدمة: يجعل الدليل يعمل بسرعة وحتى دون إنترنت بعد أول زيارة.
const VERSION = 'dh-v9';
const SHELL = [
  '/',
  '/assets/css/app.css?v=4',
  '/assets/js/theme.js?v=3',
  '/assets/js/app.js?v=4',
  '/assets/js/core.js',
  '/assets/js/search.js',
  '/assets/js/config.js',
  '/assets/img/icons.svg',
  '/assets/fonts/plex-arabic-400.woff2',
  '/assets/fonts/plex-arabic-700.woff2',
  '/manifest.webmanifest',
];

const OWN = /^\/(?:assets\/|manifest\.webmanifest$|favicon\.svg$)/;

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  if (url.pathname.startsWith('/admin')) return;

  // الصفحات: الشبكة أولاً ثم النسخة المحفوظة
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req)
        .then((res) => {
          // لا يُحفظ كواجهة للعمل دون اتصال إلا الصفحة الرئيسية السليمة
          const html = (res.headers.get('content-type') || '').includes('text/html');
          if (res.ok && html && (url.pathname === '/' || url.pathname === '/index.html')) {
            const copy = res.clone();
            caches.open(VERSION).then((c) => c.put('/', copy));
          }
          return res;
        })
        .catch(() => caches.match('/')),
    );
    return;
  }

  // ما عدا الصفحات لا نتعامل إلا مع ملفات الدليل الثابتة؛ أي طلب آخر على النطاق
  // (مثل /api/ إن أُعيد الموقع القديم يوماً) يذهب إلى الشبكة مباشرة دون تخزين
  if (!OWN.test(url.pathname)) return;

  // السكربتات والأنماط: الشبكة أولاً حتى لا تختلط وحدات JS قديمة بجديدة بعد كل تحديث
  if (/\.(?:js|css)$/.test(url.pathname)) {
    e.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(VERSION).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() => caches.match(req)),
    );
    return;
  }

  // الخطوط والصور: المحفوظ فوراً مع التحديث في الخلفية
  e.respondWith(
    caches.open(VERSION).then(async (cache) => {
      const hit = await cache.match(req);
      const net = fetch(req)
        .then((res) => {
          if (res.ok) cache.put(req, res.clone());
          return res;
        })
        .catch(() => hit);
      return hit || net;
    }),
  );
});

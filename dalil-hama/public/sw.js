// عامل الخدمة: يجعل الدليل ولوحة الإدارة يفتحان فوراً من الجهاز، وحتى دون إنترنت بعد أول زيارة.
// كل نشر يغيّر HTML أو JS أو CSS يرفع VERSION، فتُحفظ ملفات الإصدار الجديد معاً في الخلفية وتُستعمل من الفتح التالي.
const VERSION = 'dh-v6';
const SHELL = [
  '/',
  '/admin/',
  '/assets/css/app.css?v=4',
  '/assets/css/admin.css?v=6',
  '/assets/js/theme.js?v=3',
  '/assets/js/app.js?v=4',
  '/assets/js/admin.js?v=7',
  '/assets/js/core.js',
  '/assets/js/search.js',
  '/assets/js/config.js',
  '/assets/img/icons.svg',
  '/assets/fonts/plex-arabic-400.woff2',
  '/assets/fonts/plex-arabic-700.woff2',
  '/manifest.webmanifest',
  '/admin/manifest.webmanifest',
];

const OWN = /^\/(?:assets\/|manifest\.webmanifest$|admin\/manifest\.webmanifest$|favicon\.svg$)/;
const checked = new Set(); // ما حُدِّث في الخلفية منذ بدأ عامل الخدمة

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

/** الصفحة المحفوظة لهذا العنوان: الدليل (أياً كان ?…) أو لوحة الإدارة */
function pageKey(path) {
  if (path === '/' || path === '/index.html') return '/';
  if (path === '/admin' || path === '/admin/' || path === '/admin/index.html') return '/admin/';
  return null;
}

/** ردّ محفوظ جاء بعد تحويل لا يصلح جواباً لفتح صفحة، فنعيد بناءه */
function plain(res) {
  return res && res.redirected ? new Response(res.body, { status: res.status, statusText: res.statusText, headers: res.headers }) : res;
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;

  if (req.mode === 'navigate') {
    const key = pageKey(url.pathname);
    if (!key) {
      // الصفحات الأخرى (الخصوصية…): الشبكة أولاً، ثم الدليل المحفوظ دون اتصال
      e.respondWith(fetch(req).catch(() => caches.match('/').then(plain)));
      return;
    }
    // الدليل ولوحة الإدارة: من الجهاز فوراً، وتُحدَّث النسخة في الخلفية للفتح التالي
    const update = fetch(key).then((res) => {
      const html = (res.headers.get('content-type') || '').includes('text/html');
      if (res.ok && html && !res.redirected) {
        const copy = res.clone();
        return caches.open(VERSION).then((c) => c.put(key, copy)).then(() => res);
      }
      return res;
    });
    e.respondWith(caches.match(key).then((hit) => (hit ? plain(hit) : update)).catch(() => update));
    e.waitUntil(update.then(() => {}, () => {}));
    return;
  }

  // ما عدا الصفحات لا نتعامل إلا مع ملفات الدليل الثابتة؛ أي طلب آخر على النطاق
  // (القاعدة /rest/ و/auth/) يذهب إلى الشبكة مباشرة دون تخزين
  if (!OWN.test(url.pathname)) return;

  // السكربتات والأنماط: من نسخة هذا الإصدار المحفوظة (كلها من نشر واحد فلا تختلط وحدات قديمة بجديدة)،
  // وما ليس فيها يُجلب من الشبكة ويُحفظ
  if (/\.(?:js|css)$/.test(url.pathname)) {
    e.respondWith(
      caches.open(VERSION).then(async (cache) => {
        const hit = await cache.match(req);
        if (hit) return hit;
        const res = await fetch(req);
        if (res.ok) cache.put(req, res.clone());
        return res;
      }),
    );
    return;
  }

  // الخطوط لا تتغير: المحفوظ فقط، دون تنزيلها من جديد في كل فتح
  if (url.pathname.startsWith('/assets/fonts/')) {
    e.respondWith(caches.open(VERSION).then(async (cache) => (await cache.match(req)) || fetch(req).then((res) => {
      if (res.ok) cache.put(req, res.clone());
      return res;
    })));
    return;
  }

  // الصور والملفات الأخرى: المحفوظ فوراً، وتُحدَّث في الخلفية مرة واحدة ما دام عامل الخدمة يعمل
  e.respondWith(
    caches.open(VERSION).then(async (cache) => {
      const hit = await cache.match(req);
      if (hit && checked.has(url.href)) return hit;
      checked.add(url.href);
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

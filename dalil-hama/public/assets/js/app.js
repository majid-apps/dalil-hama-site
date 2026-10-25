// دليل حماة — الواجهة العامة
import {
  rpc, esc, formatPhone, isMobile, telHref, waHref, fmtNum, debounce, store,
  distance, fmtDistance, mapHref, normalizePhone, safeUrl,
} from './core.js';
import { SearchIndex, highlight } from './search.js';

const ICONS = '/assets/img/icons.svg';
const I = (name, cls = '') => `<svg class="ico ${cls}" aria-hidden="true"><use href="${ICONS}#${name}"/></svg>`;
const $ = (s, r = document) => r.querySelector(s);
const CACHE_KEY = 'dh:data:v1';
const FULL_SYNC_EVERY = 12 * 3600 * 1000;
const PAGE = 36;
const WA_MSG = 'السلام عليكم، حصلت على رقمكم من «دليل حماة» 🌿';

const QUICK = [
  ['صيدليات', 'صيدليات'], ['عيادات وأطباء', 'أطباء'], ['مستشفيات', 'مشافي'], ['عيادات أسنان', 'أسنان'],
  ['مخابر وتحاليل', 'مخابر'], ['مطاعم', 'مطاعم'], ['سوبرماركت وبقاليات', 'سوبرماركت'], ['مخابز وحلويات', 'أفران وحلويات'],
  ['موبايلات وإلكترونيات', 'موبايلات'], ['تجميل وحلاقة', 'حلاقة وتجميل'], ['صيانة سيارات', 'صيانة سيارات'], ['مدرسون ومعاهد', 'معاهد'],
];
const REPORT_KINDS = [
  ['wrong_number', 'رقم خاطئ'], ['wrong_info', 'معلومات ناقصة أو خاطئة'], ['closed', 'مغلق نهائياً'],
  ['removal', 'طلب حذف'], ['abuse', 'إزعاج أو احتيال'], ['other', 'أخرى'],
];

const state = {
  items: [], byId: new Map(), cats: [], catById: new Map(), areas: [], settings: {}, counts: new Map(), areaCounts: new Map(),
  index: new SearchIndex(), favs: new Set(store.get('dh:favs', [])), recent: store.get('dh:recent', []),
  geo: store.get('dh:geo', null), list: [], terms: [], shown: 0, viewKey: '', loaded: false,
  installEvt: null, viewed: new Set(), lastLogged: '',
};

// المدير المسجّل دخوله (من هذا المتصفح) يرى أزرار تعديل سريعة تفتح لوحة الإدارة مباشرة؛ الزائر العادي لا يرى شيئاً
const adminOn = () => { const s = store.get('dh:admin-session'); return !!(s && s.refresh_token); };

// ─────────────── البيانات والمزامنة ───────────────

function applyData(data) {
  state.cats = data.cats.map((c) => ({ ...c, ic: esc(c.ic || '📍') }));
  state.catById = new Map(state.cats.map((c) => [c.i, c]));
  state.areas = data.areas;
  state.settings = data.settings || {};
  state.items = data.items;
  state.byId = new Map(data.items.map((it) => [it.i, it]));
  state.index.setData(state.items, state.cats, state.areas);
  state.counts = new Map();
  state.areaCounts = new Map();
  for (const it of state.items) {
    state.counts.set(it.c, (state.counts.get(it.c) || 0) + 1);
    if (it.a) state.areaCounts.set(it.a, (state.areaCounts.get(it.a) || 0) + 1);
  }
  state.loaded = true;
  state.viewKey = '';
  renderChrome();
  sync();
}

function strip(data) {
  return { ...data, items: data.items.map(({ i, n, c, p, w, nw, a, d, m, g, y, x, s, e, t, f, v, k }) => ({ i, n, c, p, w, nw, a, d, m, g, y, x, s, e, t, f, v, k })) };
}

async function loadData() {
  const cached = store.get(CACHE_KEY);
  if (cached && cached.items) applyData(cached);
  try {
    const stale = !cached || !cached.fullAt || Date.now() - cached.fullAt > FULL_SYNC_EVERY;
    const since = stale ? null : new Date(new Date(cached.now).getTime() - 5 * 60000).toISOString();
    const res = await rpc('sync', since ? { since } : {});
    let next;
    if (res.full) {
      next = { ...res, fullAt: Date.now() };
    } else {
      const map = new Map(cached.items.map((it) => [it.i, it]));
      for (const it of res.items) map.set(it.i, it);
      for (const id of res.removed) map.delete(id);
      next = { ...res, items: [...map.values()].sort((a, b) => a.i - b.i), fullAt: cached.fullAt };
      if (!res.items.length && !res.removed.length && JSON.stringify(res.cats) === JSON.stringify(cached.cats)
        && JSON.stringify(res.settings) === JSON.stringify(cached.settings)) {
        store.set(CACHE_KEY, { ...strip(cached), now: res.now });
        return;
      }
    }
    const clean = strip(next);
    store.set(CACHE_KEY, clean);
    applyData(clean);
  } catch (err) {
    console.warn('sync failed', err);
    if (!cached) {
      $('#view').innerHTML = `<div class="empty"><div class="big">📡</div><h3>تعذّر الاتصال</h3><p>تحقق من اتصالك بالإنترنت ثم حاول مجدداً.</p><div class="row"><button class="btn btn-primary" onclick="location.reload()">${I('refresh', 'sm')}إعادة المحاولة</button></div></div>`;
    }
  }
}

function track(id, ev) {
  rpc('track', { lid: id || null, ev }, { keepalive: true }).catch(() => {});
}

// ─────────────── التنقل عبر الرابط ───────────────

function params() {
  const u = new URL(location.href);
  const g = (k) => u.searchParams.get(k) || '';
  return {
    q: g('q'), c: Number(g('c')) || null, a: g('a'), v: g('v'), s: g('s'), m: g('m') === '1',
    l: Number(g('l')) || null, hash: routerHash(u.hash),
  };
}

const ROUTER_HASH = /^(add|report|addphone)(-\d+)?$/;
function routerHash(h) {
  const v = String(h || '').replace(/^#/, '');
  return ROUTER_HASH.test(v) ? v : '';
}

function urlFor(p) {
  const u = new URL(location.origin + '/');
  if (p.q) u.searchParams.set('q', p.q);
  if (p.c) u.searchParams.set('c', p.c);
  if (p.a) u.searchParams.set('a', p.a);
  if (p.v) u.searchParams.set('v', p.v);
  if (p.s) u.searchParams.set('s', p.s);
  if (p.m) u.searchParams.set('m', '1');
  if (p.l) u.searchParams.set('l', p.l);
  return u.pathname + u.search + (p.hash ? '#' + p.hash : '');
}

/** تغيير الحالة في الرابط ثم إعادة الرسم. push = إضافة خطوة للرجوع. */
function go(changes, { push = true, keep = false } = {}) {
  const cur = params();
  const base = keep ? cur : { q: '', c: null, a: '', v: '', s: '', m: false, l: null, hash: '' };
  const next = { ...base, ...changes };
  const url = urlFor(next);
  if (url === location.pathname + location.search + location.hash) return sync();
  const isSheet = !!(next.l || next.hash) && !(cur.l || cur.hash);
  const idx = (history.state && history.state.idx) || 0;
  if (push) history.pushState({ idx: idx + 1, sheet: isSheet }, '', url);
  else history.replaceState({ ...(history.state || {}), idx }, '', url);
  sync();
}

function closeSheet() {
  if (history.state && history.state.sheet) history.back();
  else go({ l: null, hash: '' }, { push: false, keep: true });
}

function sync() {
  const p = params();
  const key = JSON.stringify([p.q, p.c, p.a, p.v, p.s, p.m, state.loaded, !!state.geo]);
  if (key !== state.viewKey) {
    state.viewKey = key;
    render(p);
  }
  const input = $('#q');
  if (document.activeElement !== input && input.value !== p.q) input.value = p.q;
  $('#clear-q').hidden = !input.value;
  // النوافذ
  const want = p.l ? `item:${p.l}` : p.hash.startsWith('report') ? `report:${p.hash}` : p.hash.startsWith('addphone') ? `report:${p.hash}`
    : p.hash === 'add' ? 'add' : '';
  if (want !== (openSheetKey || '')) {
    if (openSheetKey) hideSheet();
    if (want && state.loaded) {
      if (p.l) openItem(p.l);
      else if (want === 'add') openAdd();
      else openReport(p.hash);
    }
  }
  document.querySelectorAll('[data-nav]').forEach((a) => {
    const n = a.dataset.nav;
    const on = (n === 'home' && !p.v && !p.q && !p.c && !p.a) || n === p.v;
    if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
}

window.addEventListener('popstate', () => {
  const q = params().q;
  if (input.value.trim() !== q) input.value = q;
  sync();
});

// ─────────────── الرسم ───────────────

const catHue = (c) => (c ? (c.o * 4.7 + c.i * 31) % 360 : 170);
const catOf = (it) => state.catById.get(it.c);

function waNumber(it) {
  if (it.nw) return '';
  if (it.w) return normalizePhone(it.w);
  return (it.p || []).find(isMobile) || '';
}

function distOf(it) {
  if (!state.geo || !it.y) return null;
  return distance(state.geo.lat, state.geo.lng, it.y, it.x);
}

function card(it, terms = []) {
  const cat = catOf(it);
  const phone = it.p && it.p[0];
  const wa = waNumber(it);
  const map = mapHref(it);
  const d = distOf(it);
  return `<article class="card${it.f ? ' featured' : ''}" data-id="${it.i}" style="--hue:${catHue(cat)}">
    <div class="card-top">
      <a class="card-main" href="/?l=${it.i}" data-act="open">
        <div class="avatar" aria-hidden="true">${cat ? cat.ic : '📍'}</div>
        <div class="card-info">
          <h3 class="card-name">${highlight(it.n, terms)}${it.v ? `<span class="badge" title="موثّق">${I('verified')}</span>` : ''}</h3>
          <div class="meta">${cat ? `<span>${esc(cat.n)}</span>` : ''}${it.a ? `<span>${esc(it.a)}</span>` : ''}${d !== null ? `<span class="dist">${fmtDistance(d)}</span>` : ''}</div>
          ${it.d ? `<div class="addr">${esc(it.d)}</div>` : ''}
        </div>
      </a>
      <button class="fav" type="button" data-act="fav" aria-pressed="${state.favs.has(it.i)}" aria-label="المفضلة">${I('heart')}</button>
    </div>
    <div class="actions">
      ${phone ? `<a class="btn btn-primary call" href="${telHref(phone)}" data-act="call">${I('phone', 'sm')}اتصال</a>`
    : `<div class="no-phone"><span>بلا رقم</span><button type="button" data-act="addphone">أضف الرقم</button></div>`}
      ${wa ? `<a class="btn btn-wa wa" href="${waHref(wa, WA_MSG)}" target="_blank" rel="noopener" data-act="whatsapp">${I('wa', 'sm')}واتساب</a>` : ''}
      ${map ? `<a class="btn btn-soft map" href="${esc(map)}" target="_blank" rel="noopener" data-act="map">${I('pin', 'sm')}الموقع</a>` : ''}
      <button class="btn btn-soft share" type="button" data-act="share" aria-label="مشاركة">${I('share', 'sm')}</button>
      ${adminOn() ? `<a class="btn btn-soft" href="/admin/#edit/${it.i}" aria-label="تعديل في الإدارة" title="تعديل في الإدارة">${I('edit', 'sm')}</a>` : ''}
    </div>
  </article>`;
}

function setHeroCompact(compact) {
  document.body.classList.toggle('compact', compact);
}

function render(p) {
  if (!state.loaded) return;
  const view = $('#view');
  if (p.v === 'cats') { setHeroCompact(true); view.innerHTML = renderCats(); }
  else if (p.v === 'favs') { setHeroCompact(true); renderList(p, 'favs'); }
  else if (p.v === 'near') { setHeroCompact(true); renderList(p, 'near'); }
  else if (p.q || p.c || p.a) { setHeroCompact(true); renderList(p, 'search'); }
  else { setHeroCompact(false); view.innerHTML = renderHome(); }
  if (p.v || p.c || p.a) window.scrollTo({ top: 0 });
  onScroll();
}

function renderChrome() {
  const total = state.items.length;
  $('#hero-stats').innerHTML = `<span><b>${fmtNum(total)}</b> رقماً وعنواناً</span><span><b>${fmtNum(state.cats.length)}</b> تصنيفاً</span><span>حماة حصراً</span>`;
  const byName = new Map(state.cats.map((c) => [c.n, c]));
  $('#quick').innerHTML = QUICK.map(([n, label]) => byName.get(n)).filter(Boolean)
    .map((c) => `<a class="chip-hero" href="/?c=${c.i}" data-cat="${c.i}"><span aria-hidden="true">${c.ic}</span>${esc(QUICK.find((x) => x[0] === c.n)[1])}</a>`).join('');
  const an = state.settings.announcement;
  $('#announce').innerHTML = an && an.active && an.text
    ? `<div class="announce">${I('megaphone')}<div>${esc(an.text)}${safeUrl(an.link) ? ` <a class="lnk" href="${esc(safeUrl(an.link))}" target="_blank" rel="noopener" style="color:var(--brand);font-weight:700">التفاصيل</a>` : ''}</div></div>` : '';
  const c = state.settings.contact || {};
  $('#socials').innerHTML = [
    c.whatsapp && `<a href="${waHref(c.whatsapp)}" target="_blank" rel="noopener">${I('wa')}واتساب</a>`,
    c.instagram && `<a href="https://instagram.com/${esc(c.instagram)}" target="_blank" rel="noopener">${I('ig')}إنستغرام</a>`,
    safeUrl(c.facebook) && `<a href="${esc(safeUrl(c.facebook))}" target="_blank" rel="noopener">${I('fb')}فيسبوك</a>`,
    `<button type="button" data-act="share-site">${I('share')}شارك الدليل</button>`,
  ].filter(Boolean).join('');
  updateFavDot();
  if (adminOn() && !$('#admin-fab') && !/[?&]preview=visitor/.test(location.search)) {
    document.body.insertAdjacentHTML('beforeend', `<a class="admin-fab" id="admin-fab" href="/admin/">${I('settings', 'sm')}لوحة الإدارة</a>`);
  }
}

function sectionHead(title, sub = '', more = '') {
  return `<div class="section-head"><div><h2>${title}</h2>${sub ? `<p>${sub}</p>` : ''}</div>${more}</div>`;
}

function catTile(c) {
  return `<a class="cat" href="/?c=${c.i}" data-cat="${c.i}" style="--hue:${catHue(c)}"><span class="em" aria-hidden="true">${c.ic}</span><b>${esc(c.n)}</b><small>${fmtNum(state.counts.get(c.i) || 0)} نشاط</small></a>`;
}

function renderHome() {
  const emergency = state.settings.emergency || [];
  const cats = [...state.cats].filter((c) => state.counts.get(c.i)).sort((a, b) => (state.counts.get(b.i) || 0) - (state.counts.get(a.i) || 0));
  const featured = state.items.filter((it) => it.f).slice(0, 9);
  const popular = state.items.filter((it) => it.k).sort((a, b) => b.k - a.k).slice(0, 6);
  const newest = [...state.items].sort((a, b) => b.i - a.i).slice(0, 6);
  const recent = state.recent.map((id) => state.byId.get(id)).filter(Boolean).slice(0, 6);
  const areas = state.areas.filter((a) => state.areaCounts.get(a.n)).sort((a, b) => state.areaCounts.get(b.n) - state.areaCounts.get(a.n));
  let h = '';
  if (emergency.length) {
    h += `<div class="emergency">${emergency.map((e) => `<a class="sos" href="tel:${esc(e.number)}" data-act="sos"><span class="em" aria-hidden="true">${esc(e.icon || '☎️')}</span><span><b>${esc(e.name)}</b><bdi class="num">${esc(e.number)}</bdi></span></a>`).join('')}</div>`;
  }
  if (recent.length) h += `<section class="section">${sectionHead('شاهدتها مؤخراً')}<div class="rail">${recent.map((it) => card(it)).join('')}</div></section>`;
  h += `<section class="section">${sectionHead('تصفّح حسب التصنيف', 'اختر ما تحتاجه وابدأ الاتصال مباشرة', `<a class="more-link" href="/?v=cats" data-nav="cats">الكل ${I('chev', 'sm')}</a>`)}
    <div class="cat-grid">${cats.slice(0, 12).map(catTile).join('')}</div></section>`;
  if (featured.length) h += `<section class="section">${sectionHead('مميّزون في حماة', 'أنشطة موثّقة ننصح بها')}<div class="rail">${featured.map((it) => card(it)).join('')}</div></section>`;
  if (popular.length) h += `<section class="section">${sectionHead('الأكثر تواصلاً', 'الأرقام التي يتصل بها الناس أكثر هذه الفترة')}<div class="rail">${popular.map((it) => card(it)).join('')}</div></section>`;
  h += `<section class="section">${sectionHead('أقرب الخدمات إليك', 'حدّد موقعك لنرتب لك الأماكن حسب المسافة')}
    <a class="btn btn-soft btn-lg btn-block" href="/?v=near" data-nav="near">${I('locate')}اعرض الأقرب إليّ الآن</a></section>`;
  if (areas.length) {
    h += `<section class="section">${sectionHead('تصفّح حسب الحي')}<div class="filters" style="flex-wrap:wrap;overflow:visible;margin:0;padding:0">${areas.slice(0, 18).map((a) => `<a class="pill" href="/?a=${encodeURIComponent(a.n)}">${esc(a.n)} <small style="opacity:.6">${fmtNum(state.areaCounts.get(a.n))}</small></a>`).join('')}</div></section>`;
  }
  h += `<section class="section">${sectionHead('أُضيفت حديثاً')}<div class="rail">${newest.map((it) => card(it)).join('')}</div></section>`;
  h += `<section class="section"><div class="announce" style="background:var(--brand-soft);border-color:transparent;align-items:center;flex-wrap:wrap">
      <div style="flex:1;min-width:220px"><b style="font-size:17px">هل لديك نشاط في حماة؟</b><br><span style="color:var(--ink-2)">أضفه مجاناً ليصل إليك الناس بسهولة. ووجدت رقماً خاطئاً؟ بلّغنا ونصحّحه فوراً.</span></div>
      <div style="display:flex;gap:8px;flex-wrap:wrap"><a class="btn btn-primary" href="#add">${I('plus', 'sm')}أضف نشاطك</a><a class="btn btn-soft" href="#report">${I('flag', 'sm')}إبلاغ عن خطأ</a></div>
    </div></section>`;
  return h;
}

function renderCats() {
  const cats = [...state.cats].filter((c) => state.counts.get(c.i));
  const areas = state.areas.filter((a) => state.areaCounts.get(a.n));
  return `<div class="results-head"><div class="results-title"><a class="back" href="/" data-act="back" aria-label="رجوع">${I('back')}</a><h2>كل التصنيفات</h2><span class="count">${fmtNum(cats.length)} تصنيفاً</span></div></div>
    <div class="cat-grid" style="margin-top:8px">${cats.map(catTile).join('')}</div>
    <section class="section">${sectionHead('الأحياء')}<div class="filters" style="flex-wrap:wrap;overflow:visible;margin:0;padding:0">${areas.map((a) => `<a class="pill" href="/?a=${encodeURIComponent(a.n)}">${esc(a.n)} <small style="opacity:.6">${fmtNum(state.areaCounts.get(a.n))}</small></a>`).join('')}</div></section>`;
}

function renderList(p, mode) {
  const view = $('#view');
  let title = '';
  let list;
  let extra = '';
  let res = { results: [], cats: [], terms: [] };
  if (mode === 'favs') {
    title = 'مفضّلتي';
    list = [...state.favs].map((id) => state.byId.get(id)).filter(Boolean);
    if (p.c) list = list.filter((it) => it.c === p.c);
  } else {
    res = state.index.search(p.q, { cat: p.c, area: p.a });
    list = res.results;
    if (mode === 'near') {
      title = 'الأقرب إليك';
      list = list.filter((it) => it.y);
    } else if (p.q) {
      title = `نتائج «${esc(p.q)}»`;
    } else if (p.c) {
      const c = state.catById.get(p.c);
      title = c ? `${c.ic} ${esc(c.n)}` : 'النتائج';
    } else if (p.a) {
      title = `حي ${esc(p.a)}`;
    }
  }
  const sort = mode === 'near' ? 'near' : p.s;
  if (sort === 'near' && state.geo) {
    list = [...list].sort((a, b) => (distOf(a) ?? 1e9) - (distOf(b) ?? 1e9));
  } else if (sort === 'name') {
    list = [...list].sort((a, b) => a.n.localeCompare(b.n, 'ar'));
  } else if (sort === 'new') {
    list = [...list].sort((a, b) => b.i - a.i);
  } else if (!p.q && mode === 'search') {
    list = [...list].sort((a, b) => (b.f || 0) - (a.f || 0) || (b.k || 0) - (a.k || 0) || (b.p ? 1 : 0) - (a.p ? 1 : 0) || a.n.localeCompare(b.n, 'ar'));
  }
  state.list = list;
  state.terms = res.terms || [];
  state.shown = 0;

  const catOpts = state.cats.filter((c) => state.counts.get(c.i))
    .map((c) => `<option value="${c.i}"${p.c === c.i ? ' selected' : ''}>${c.ic} ${esc(c.n)}</option>`).join('');
  const areaOpts = state.areas.filter((a) => state.areaCounts.get(a.n))
    .map((a) => `<option value="${esc(a.n)}"${p.a === a.n ? ' selected' : ''}>${esc(a.n)}</option>`).join('');
  const filters = `<div class="filters" role="group" aria-label="تصفية">
      ${mode !== 'favs' ? `<button class="pill${p.m ? ' on' : ''}" type="button" data-act="toggle-map" aria-pressed="${p.m}">${I(p.m ? 'list' : 'map', 'sm')}${p.m ? 'القائمة' : 'الخريطة'}</button>` : ''}
      <select class="pill" data-filter="c" aria-label="التصنيف"><option value="">كل التصنيفات</option>${catOpts}</select>
      ${mode !== 'favs' ? `<select class="pill" data-filter="a" aria-label="الحي"><option value="">كل الأحياء</option>${areaOpts}</select>` : ''}
      ${mode === 'search' ? `<select class="pill" data-filter="s" aria-label="الترتيب">
        <option value="">${p.q ? 'الأنسب' : 'الأبرز'}</option><option value="near"${p.s === 'near' ? ' selected' : ''}>الأقرب</option>
        <option value="name"${p.s === 'name' ? ' selected' : ''}>أبجدياً</option><option value="new"${p.s === 'new' ? ' selected' : ''}>الأحدث</option></select>` : ''}
    </div>`;

  if (mode === 'near' && !state.geo) {
    extra = `<div class="empty"><div class="big">📍</div><h3>أين أنت الآن؟</h3><p>اسمح بالوصول إلى موقعك لنرتب لك الصيدليات والعيادات والمحلات حسب الأقرب إليك. لا نحفظ موقعك على خوادمنا.</p>
      <div class="row"><button class="btn btn-primary btn-lg" type="button" data-act="locate">${I('locate')}حدّد موقعي</button></div></div>`;
  } else if (mode === 'near' || (sort === 'near' && state.geo)) {
    extra = `<div class="geo-bar"><span>${I('locate', 'sm')}المسافات من موقعك ${geoStale() ? 'السابق' : 'الحالي'}</span><button class="btn btn-soft" type="button" data-act="locate">${I('refresh', 'sm')}تحديث موقعي</button></div>`;
    if (geoStale() && !state.geoTried) { state.geoTried = true; locate(true); }
  }
  if (res.cats && res.cats.length && p.q && !p.c) {
    extra += `<div class="cat-suggest">${res.cats.map((id) => state.catById.get(id)).filter(Boolean).map((c) => `<a href="/?c=${c.i}">${c.ic} كل ${esc(c.n)} <small>(${fmtNum(state.counts.get(c.i) || 0)})</small></a>`).join('')}</div>`;
  }
  if (res.fuzzy && list.length) extra += `<p class="notice">لم نجد تطابقاً تاماً، إليك أقرب النتائج:</p>`;
  if (res.phone) extra += `<p class="notice">نتائج البحث بالرقم:</p>`;

  view.innerHTML = `<div class="results-head">
      <div class="results-title"><a class="back" href="/" data-act="back" aria-label="رجوع">${I('back')}</a><h2>${title}</h2><span class="count">${fmtNum(list.length)} نتيجة</span></div>
      ${filters}
    </div>
    ${extra}
    ${p.m && mode !== 'favs' ? '<div class="map-box" id="map"></div>' : '<div class="list" id="list"></div><div class="sentinel" id="sentinel"></div>'}`;

  if (p.q) scheduleSearchLog(p.q, mode === 'search' && !p.c && !p.a ? list.length : state.index.search(p.q).results.length);
  if (!list.length && !(mode === 'near' && !state.geo)) {
    ($('#list') || $('#map')).outerHTML = emptyState(mode, p);
    return;
  }
  if (p.m && mode !== 'favs') renderMap(list);
  else {
    appendPage();
    io.disconnect();
    io.observe($('#sentinel'));
  }
}

function emptyState(mode, p) {
  if (mode === 'favs') {
    return `<div class="empty"><div class="big">🤍</div><h3>لا توجد مفضّلة بعد</h3><p>اضغط على القلب بجانب أي نشاط لتجده هنا بسرعة في المرة القادمة.</p><div class="row"><a class="btn btn-primary" href="/">تصفّح الدليل</a></div></div>`;
  }
  return `<div class="empty"><div class="big">🔎</div><h3>لم نجد «${esc(p.q || '')}»</h3><p>جرّب كلمة أخرى أو تصنيفاً أعمّ. وإن كنت تعرف هذا النشاط، ساعد غيرك بإضافته للدليل.</p>
    <div class="row"><a class="btn btn-primary" href="#add">${I('plus', 'sm')}أضفه إلى الدليل</a>${adminOn() ? `<a class="btn btn-gold" href="/admin/#new?name=${encodeURIComponent((p.q || '').slice(0, 160))}">${I('edit', 'sm')}إضافة مباشرة (إدارة)</a>` : ''}<a class="btn btn-soft" href="/">الرئيسية</a></div></div>`;
}

function appendPage() {
  const listEl = $('#list');
  if (!listEl) return;
  const next = state.list.slice(state.shown, state.shown + PAGE);
  listEl.insertAdjacentHTML('beforeend', next.map((it) => card(it, state.terms)).join(''));
  state.shown += next.length;
}

const io = new IntersectionObserver((entries) => {
  if (entries.some((e) => e.isIntersecting) && state.shown < state.list.length) appendPage();
}, { rootMargin: '800px 0px' });

const scheduleSearchLog = debounce((q, n) => {
  const t = (q || '').trim();
  if (t.length < 2 || t === state.lastLogged || t !== params().q) return;
  state.lastLogged = t;
  rpc('log_search', { q: t, results: n }).catch(() => {});
}, 1800);

// ─────────────── الخريطة (تُحمَّل عند الطلب) ───────────────

let leafletPromise;
function loadLeaflet() {
  if (window.L) return Promise.resolve(window.L);
  if (!leafletPromise) {
    leafletPromise = new Promise((resolve, reject) => {
      const css = document.createElement('link');
      css.rel = 'stylesheet';
      css.href = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css';
      css.integrity = 'sha512-h9FcoyWjHcOcmEVkxOfTLnmZFWIH0iZhZT1H2TbOq55xssQGEJHEaIm+PgoUaZbRvQTNTluNOEfb1ZRy6D3BOw==';
      css.crossOrigin = 'anonymous';
      document.head.append(css);
      const js = document.createElement('script');
      js.src = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js';
      js.integrity = 'sha512-puJW3E/qXDqYp9IfhAI54BJEaWIfloJ7JWs7OeD5i6ruC9JZL1gERT1wjtwXFlh7CjE7ZJ+/vcRZRkIYIb6p4g==';
      js.crossOrigin = 'anonymous';
      js.onload = () => resolve(window.L);
      // فشل التحميل لا يُحفظ، فتعيد المحاولة التالية الطلب من جديد
      js.onerror = (err) => { leafletPromise = null; css.remove(); js.remove(); reject(err); };
      document.head.append(js);
    });
  }
  return leafletPromise;
}

async function renderMap(list) {
  const box = $('#map');
  box.innerHTML = '<div class="empty"><p>جارٍ تحميل الخريطة…</p></div>';
  let L;
  try { L = await loadLeaflet(); } catch {
    box.innerHTML = '<div class="empty"><div class="big">🗺️</div><p>تعذّر تحميل الخريطة. تحقق من الاتصال.</p></div>';
    return;
  }
  if (!document.body.contains(box)) return;
  box.innerHTML = '';
  const map = L.map(box, { preferCanvas: true, zoomControl: true, attributionControl: true }).setView([35.1318, 36.7578], 13);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>',
  }).addTo(map);
  const pts = list.filter((it) => it.y);
  const brand = getComputedStyle(document.documentElement).getPropertyValue('--brand').trim() || '#0e5e55';
  const bounds = [];
  for (const it of pts.slice(0, 2500)) {
    const cat = catOf(it);
    const mk = L.circleMarker([it.y, it.x], { radius: 7, weight: 2, color: '#fff', fillColor: it.f ? '#c08f2e' : brand, fillOpacity: 1 });
    mk.bindPopup(`<div class="map-pop" dir="rtl"><b>${esc(it.n)}</b><small>${cat ? cat.ic + ' ' + esc(cat.n) : ''}</small><button type="button" data-open="${it.i}">التفاصيل والاتصال</button></div>`);
    mk.addTo(map);
    bounds.push([it.y, it.x]);
  }
  if (state.geo) {
    L.circleMarker([state.geo.lat, state.geo.lng], { radius: 9, weight: 3, color: '#fff', fillColor: '#2563eb', fillOpacity: 1 }).addTo(map).bindTooltip('أنت هنا');
  }
  if (bounds.length) map.fitBounds(bounds, { padding: [30, 30], maxZoom: 16 });
  if (pts.length < list.length) {
    box.insertAdjacentHTML('afterend', `<p class="notice" style="margin-top:10px">تظهر على الخريطة ${fmtNum(pts.length)} من أصل ${fmtNum(list.length)} نتيجة (الباقي بلا موقع محدد بعد).</p>`);
  }
  box.addEventListener('click', (e) => {
    const b = e.target.closest('[data-open]');
    if (b) go({ l: Number(b.dataset.open) }, { keep: true });
  });
}

// ─────────────── النوافذ المنبثقة ───────────────

let openSheetKey = null;
let sheetEls = null;
let lastFocus = null;

function showSheet(key, title, body, { label } = {}) {
  if (sheetEls) removeSheetEls();
  lastFocus = document.activeElement;
  const bd = document.createElement('div');
  bd.className = 'backdrop';
  const sh = document.createElement('div');
  sh.className = 'sheet';
  sh.setAttribute('role', 'dialog');
  sh.setAttribute('aria-modal', 'true');
  sh.setAttribute('aria-label', label || title.replace(/<[^>]+>/g, ''));
  sh.tabIndex = -1;
  sh.innerHTML = `<div class="grab" aria-hidden="true"></div><div class="sheet-head"><h2>${title}</h2><button class="icon-btn" type="button" data-act="close" aria-label="إغلاق">${I('x')}</button></div><div class="sheet-body">${body}</div>`;
  document.body.append(bd, sh);
  document.documentElement.style.overflow = 'hidden';
  requestAnimationFrame(() => { bd.classList.add('show'); sh.classList.add('show'); });
  sh.focus({ preventScroll: true });
  bd.addEventListener('click', closeSheet);
  enableSwipe(sh);
  openSheetKey = key;
  sheetEls = { bd, sh };
  return sh;
}

function removeSheetEls() {
  const { bd, sh } = sheetEls;
  bd.classList.remove('show');
  sh.classList.remove('show');
  setTimeout(() => { bd.remove(); sh.remove(); }, 320);
  sheetEls = null;
}

const BASE_TITLE = document.title;
function hideSheet() {
  if (sheetEls) removeSheetEls();
  openSheetKey = null;
  document.title = BASE_TITLE;
  document.documentElement.style.overflow = '';
  if (lastFocus && document.body.contains(lastFocus)) lastFocus.focus({ preventScroll: true });
}

function enableSwipe(sh) {
  let y0 = null;
  let dy = 0;
  sh.addEventListener('touchstart', (e) => {
    const body = sh.querySelector('.sheet-body');
    if (body.scrollTop > 0 || window.innerWidth >= 700) return;
    y0 = e.touches[0].clientY;
    dy = 0;
  }, { passive: true });
  sh.addEventListener('touchmove', (e) => {
    if (y0 === null) return;
    dy = Math.max(0, e.touches[0].clientY - y0);
    if (dy > 0) { sh.style.transition = 'none'; sh.style.transform = `translateY(${dy}px)`; }
  }, { passive: true });
  sh.addEventListener('touchend', () => {
    if (y0 === null) return;
    sh.style.transition = '';
    sh.style.transform = '';
    if (dy > 110) closeSheet();
    y0 = null;
  });
}

document.addEventListener('keydown', (e) => {
  if (!sheetEls) return;
  if (e.key === 'Escape') { e.preventDefault(); closeSheet(); }
  if (e.key === 'Tab') {
    const f = [...sheetEls.sh.querySelectorAll('a[href],button:not([disabled]),input,select,textarea,[tabindex="0"]')].filter((x) => x.offsetParent);
    if (!f.length) return;
    if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f[f.length - 1].focus(); }
    else if (!e.shiftKey && document.activeElement === f[f.length - 1]) { e.preventDefault(); f[0].focus(); }
  }
});

// تفاصيل النشاط
function openItem(id) {
  const it = state.byId.get(id);
  if (!it) {
    showSheet(`item:${id}`, 'غير موجود', `<div class="empty"><div class="big">🧐</div><p>هذا النشاط لم يعد موجوداً في الدليل أو قيد المراجعة.</p><a class="btn btn-primary" href="/">الرئيسية</a></div>`);
    return;
  }
  const cat = catOf(it);
  const wa = waNumber(it);
  const map = mapHref(it);
  const d = distOf(it);
  const phones = (it.p || []).map((p, i) => `<div class="phone-row">
      <div class="num"><bdi dir="ltr">${esc(formatPhone(p))}</bdi><span class="kind">${isMobile(p) ? 'جوال' : 'أرضي'}${i === 0 ? ' · الرقم الأساسي' : ''}</span></div>
      <button class="icon-btn" type="button" data-act="copy" data-val="${esc(p)}" aria-label="نسخ الرقم">${I('copy', 'sm')}</button>
      ${isMobile(p) && !it.nw ? `<a class="btn btn-wa" href="${waHref(p, WA_MSG)}" target="_blank" rel="noopener" data-act="whatsapp" aria-label="واتساب">${I('wa', 'sm')}</a>` : ''}
      <a class="btn btn-primary" href="${telHref(p)}" data-act="call">${I('phone', 'sm')}اتصال</a>
    </div>`).join('');
  const waExtra = wa && !(it.p || []).includes(wa)
    ? `<div class="phone-row"><div class="num"><bdi dir="ltr">${esc(formatPhone(wa))}</bdi><span class="kind">واتساب</span></div><a class="btn btn-wa" href="${waHref(wa, WA_MSG)}" target="_blank" rel="noopener" data-act="whatsapp">${I('wa', 'sm')}مراسلة</a></div>` : '';
  const body = `<div data-id="${it.i}">
    <div class="detail-hero" style="--hue:${catHue(cat)}">
      <div class="avatar" aria-hidden="true">${cat ? cat.ic : '📍'}</div>
      <div style="min-width:0"><h3>${esc(it.n)}${it.v ? `<span class="badge" title="موثّق">${I('verified')}</span>` : ''}</h3>
        <div class="tags">${cat ? `<a class="tag brand" href="/?c=${cat.i}" data-cat="${cat.i}">${esc(cat.n)}</a>` : ''}${it.a ? `<a class="tag" href="/?a=${encodeURIComponent(it.a)}">${I('pin', 'sm')}${esc(it.a)}</a>` : ''}${it.f ? `<span class="tag gold">${I('star', 'sm')}مميّز</span>` : ''}${(it.t || []).map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</div>
      </div>
    </div>
    <div class="block"><p class="block-title">أرقام التواصل</p>
      ${phones || `<div class="no-phone" style="min-height:52px"><span>لا يوجد رقم لهذا النشاط بعد</span><button type="button" data-act="addphone">تعرفه؟ أضفه</button></div>`}${waExtra}
    </div>
    ${it.d || it.a || map ? `<div class="block"><p class="block-title">العنوان والموقع</p>
      <div class="info-row">${I('pin')}<div class="grow">${esc(it.d || (it.a ? `حماة، ${it.a}` : 'حماة'))}${d !== null ? `<div class="meta"><span class="dist">يبعد عنك ${fmtDistance(d)}</span></div>` : ''}</div>
      ${map ? `<a class="btn btn-soft" href="${esc(map)}" target="_blank" rel="noopener" data-act="map">${I('map', 'sm')}الخريطة</a>` : ''}</div></div>` : ''}
    ${safeUrl(it.s) ? `<div class="block"><div class="info-row">${I('globe')}<div class="grow"><a class="lnk" href="${esc(safeUrl(it.s))}" target="_blank" rel="noopener" dir="ltr">${esc(it.s.replace(/^https?:\/\//, '').replace(/\/$/, ''))}</a></div></div></div>` : ''}
    ${it.e ? `<div class="block"><p class="block-title">نبذة</p><div class="info-row">${I('info')}<div class="grow">${esc(it.e)}</div></div></div>` : ''}
    <div class="detail-actions">
      <button class="qa" type="button" data-act="fav" aria-pressed="${state.favs.has(it.i)}">${I('heart')}المفضلة</button>
      <button class="qa" type="button" data-act="share">${I('share')}مشاركة</button>
      <button class="qa" type="button" data-act="copy-all">${I('copy')}نسخ</button>
      <button class="qa" type="button" data-act="report">${I('flag')}إبلاغ</button>
      ${adminOn() ? `<a class="qa" href="/admin/#edit/${it.i}">${I('edit')}تعديل (إدارة)</a>` : ''}
    </div>
    <div class="owner-note">${I('edit')}<span style="flex:1">هل هذا نشاطك؟ حدّث بياناته أو أضف رقماً مجاناً.</span><button type="button" data-act="report" data-kind="wrong_info">طلب تعديل</button></div>
  </div>`;
  showSheet(`item:${id}`, cat ? `${cat.ic} ${esc(cat.n)}` : 'التفاصيل', body, { label: it.n });
  state.recent = [id, ...state.recent.filter((x) => x !== id)].slice(0, 12);
  store.set('dh:recent', state.recent);
  if (!state.viewed.has(id)) { state.viewed.add(id); track(id, 'view'); }
  document.title = `${it.n} — دليل حماة`;
}

// إضافة نشاط
function openAdd() {
  const catOpts = state.cats.map((c) => `<option value="${c.i}">${c.ic} ${esc(c.n)}</option>`).join('');
  const areaOpts = state.areas.map((a) => `<option>${esc(a.n)}</option>`).join('');
  const body = `<form class="form" id="add-form" novalidate>
    <p style="margin:0;color:var(--ink-2)">أضف نشاطك أو أي نشاط تعرفه في حماة مجاناً. نراجع الطلب ونتحقق من الرقم قبل النشر.</p>
    <label class="field"><span>اسم النشاط أو صاحب المهنة <i>*</i></span><input class="input" name="name" required minlength="2" maxlength="160" placeholder="مثال: صيدلية الشفاء"></label>
    <label class="field"><span>التصنيف <i>*</i></span><select class="input" name="category_id" required><option value="">اختر التصنيف…</option>${catOpts}</select></label>
    <div class="row2">
      <label class="field"><span>رقم الهاتف <i>*</i></span><input class="input" name="phone" type="tel" dir="ltr" inputmode="tel" required maxlength="20" placeholder="09xx xxx xxx"></label>
      <label class="field"><span>رقم إضافي <em>(اختياري)</em></span><input class="input" name="phone2" type="tel" dir="ltr" inputmode="tel" maxlength="20" placeholder="013 xxx xxxx"></label>
    </div>
    <label class="field"><span>الحي <em>(اختياري)</em></span><select class="input" name="area"><option value="">اختر الحي…</option>${areaOpts}</select></label>
    <label class="field"><span>العنوان التفصيلي <em>(اختياري)</em></span><input class="input" name="address" maxlength="400" placeholder="مثال: شارع العلمين، قرب جامع السلطان"></label>
    <div class="field"><span>الموقع على الخريطة <em>(اختياري)</em></span>
      <div style="display:flex;gap:8px"><input class="input" name="map_url" dir="ltr" maxlength="1200" placeholder="رابط خرائط Google" style="flex:1"><button class="btn btn-soft" type="button" data-act="here">${I('locate', 'sm')}موقعي</button></div>
      <span class="hint">إن كنت في مكان النشاط الآن، اضغط «موقعي» لتحديده تلقائياً.</span></div>
    <label class="field"><span>الموقع الإلكتروني أو الصفحة <em>(اختياري)</em></span><input class="input" name="website" dir="ltr" maxlength="300" placeholder="facebook.com/…"></label>
    <label class="field"><span>نبذة قصيرة <em>(اختياري)</em></span><textarea class="input" name="description" maxlength="600" placeholder="الخدمات، أوقات الدوام، التخصص…"></textarea></label>
    <div class="row2">
      <label class="field"><span>اسمك <em>(لا يُنشر)</em></span><input class="input" name="submitter_name" maxlength="80"></label>
      <label class="field"><span>رقمك للتواصل <em>(لا يُنشر)</em></span><input class="input" name="submitter_phone" type="tel" dir="ltr" inputmode="tel" maxlength="20"></label>
    </div>
    <input class="hp" name="website_hp" tabindex="-1" autocomplete="off" aria-hidden="true">
    <label class="check"><input type="checkbox" name="consent" required><span>أؤكد صحة المعلومات، وأنني صاحب الرقم أو مخوّل بنشره، وأوافق على عرضه في الدليل بعد المراجعة. يمكن طلب التعديل أو الحذف في أي وقت.</span></label>
    <div class="form-error" hidden></div>
    <button class="btn btn-primary btn-lg btn-block" type="submit">${I('check', 'sm')}إرسال للمراجعة</button>
  </form>`;
  const sh = showSheet('add', 'أضف نشاطاً إلى الدليل', body);
  const form = sh.querySelector('#add-form');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(form));
    const err = form.querySelector('.form-error');
    const fail = (m) => { err.textContent = m; err.hidden = false; err.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); };
    if ((fd.name || '').trim().length < 2) return fail('اكتب اسم النشاط.');
    if (!fd.category_id) return fail('اختر التصنيف المناسب.');
    if (normalizePhone(fd.phone).replace(/\D/g, '').length < 7) return fail('اكتب رقم هاتف صحيحاً.');
    if (!fd.consent) return fail('يرجى الموافقة على شروط النشر.');
    err.hidden = true;
    const btn = form.querySelector('[type=submit]');
    btn.disabled = true;
    btn.textContent = 'جارٍ الإرسال…';
    try {
      delete fd.consent;
      fd.phone = normalizePhone(fd.phone);
      fd.phone2 = normalizePhone(fd.phone2);
      fd.map_url = safeUrl(fd.map_url);
      fd.website = safeUrl(fd.website);
      const res = await rpc('submit_listing', { payload: fd });
      if (!res.ok) {
        btn.disabled = false;
        btn.textContent = 'إرسال للمراجعة';
        return fail({ rate: 'أرسلت طلبات كثيرة خلال وقت قصير، حاول بعد قليل.', phone: 'رقم الهاتف غير صحيح.', name: 'اسم النشاط غير صالح.' }[res.error] || 'تعذّر الإرسال.');
      }
      sh.querySelector('.sheet-body').innerHTML = successHtml('وصل طلبك! 🌿', res.duplicate
        ? 'شكراً لك. لاحظنا أن هذا الرقم موجود في الدليل، سنراجع الطلب ونحدّث البيانات إن لزم.'
        : 'شكراً لمساهمتك. سنراجع الطلب ونتحقق من الرقم، ثم يظهر في الدليل قريباً.');
    } catch {
      btn.disabled = false;
      btn.textContent = 'إرسال للمراجعة';
      fail('تعذّر الاتصال. تحقق من الإنترنت وحاول مجدداً.');
    }
  });
}

function successHtml(title, text) {
  return `<div class="success"><div class="tick">${I('check')}</div><h3>${title}</h3><p>${text}</p><button class="btn btn-primary btn-lg" type="button" data-act="close">تم</button></div>`;
}

// الإبلاغ
function openReport(hash) {
  const [kindKey, idStr] = hash.split('-');
  let picked = Number(idStr) || null;
  const addPhone = kindKey === 'addphone';
  const defKind = addPhone ? 'wrong_info' : (sessionStorage.getItem('dh:rk') || 'wrong_number');
  sessionStorage.removeItem('dh:rk');
  const body = `<form class="form" id="report-form" novalidate>
    <p style="margin:0;color:var(--ink-2)">${addPhone ? 'شكراً لمساعدتك! اكتب الرقم الصحيح وسنضيفه بعد التحقق.' : 'ساعدنا في إبقاء الدليل دقيقاً. نراجع كل بلاغ ونصحّح البيانات بسرعة.'}</p>
    <div class="field"><span>النشاط المعني</span><div id="pick-box"></div></div>
    <fieldset class="field" style="border:0;padding:0;margin:0"><legend style="font-size:14px;font-weight:700;margin-bottom:6px">نوع البلاغ</legend>
      <div class="kinds">${REPORT_KINDS.map(([k, l]) => `<label><input type="radio" name="kind" value="${k}"${k === defKind ? ' checked' : ''}><span>${l}</span></label>`).join('')}</div></fieldset>
    <label class="field"><span>التفاصيل</span><textarea class="input" name="details" maxlength="1000" placeholder="${addPhone ? 'الرقم الصحيح هو: 09…' : 'ما الخطأ؟ وما المعلومة الصحيحة إن كنت تعرفها؟'}"></textarea></label>
    <label class="field"><span>وسيلة للتواصل معك <em>(اختياري)</em></span><input class="input" name="contact" maxlength="60" placeholder="رقمك أو بريدك"></label>
    <input class="hp" name="website_hp" tabindex="-1" autocomplete="off" aria-hidden="true">
    <div class="form-error" hidden></div>
    <button class="btn btn-primary btn-lg btn-block" type="submit">${I('flag', 'sm')}إرسال البلاغ</button>
  </form>`;
  const sh = showSheet(`report:${hash}`, addPhone ? 'أضف رقماً لهذا النشاط' : 'الإبلاغ عن خطأ', body);
  const box = sh.querySelector('#pick-box');
  const drawPick = () => {
    const it = picked && state.byId.get(picked);
    if (it) {
      box.innerHTML = `<div class="pick"><span class="avatar" style="width:38px;height:38px;font-size:19px;border-radius:12px;--hue:${catHue(catOf(it))}">${catOf(it)?.ic || '📍'}</span><b>${esc(it.n)}</b><button class="btn btn-ghost" type="button" data-act="unpick" style="min-height:36px;padding:0 10px">تغيير</button></div>`;
    } else {
      box.innerHTML = `<input class="input" id="pick-q" placeholder="ابحث باسم النشاط أو رقمه (اختياري)" autocomplete="off"><div class="pick-list" id="pick-list"></div>`;
      const inp = box.querySelector('#pick-q');
      const pl = box.querySelector('#pick-list');
      inp.addEventListener('input', () => {
        const r = inp.value.trim() ? state.index.search(inp.value).results.slice(0, 8) : [];
        pl.innerHTML = r.map((it2) => `<button type="button" data-pick="${it2.i}">${esc(it2.n)}<small>${esc(catOf(it2)?.n || '')}${it2.p ? ' · ' + esc(it2.p[0]) : ''}</small></button>`).join('');
      });
    }
  };
  drawPick();
  box.addEventListener('click', (e) => {
    const b = e.target.closest('[data-pick]');
    if (b) { picked = Number(b.dataset.pick); drawPick(); }
    if (e.target.closest('[data-act="unpick"]')) { picked = null; drawPick(); box.querySelector('#pick-q').focus(); }
  });
  const form = sh.querySelector('#report-form');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(form));
    const err = form.querySelector('.form-error');
    const fail = (m) => { err.textContent = m; err.hidden = false; };
    if (!picked && (fd.details || '').trim().length < 5) return fail('اختر النشاط أو اكتب تفاصيل البلاغ.');
    if (addPhone && (fd.details || '').replace(/\D/g, '').length < 7) return fail('اكتب الرقم الصحيح في خانة التفاصيل.');
    const btn = form.querySelector('[type=submit]');
    btn.disabled = true;
    try {
      const res = await rpc('submit_report', { payload: { ...fd, listing_id: picked } });
      if (!res.ok) { btn.disabled = false; return fail(res.error === 'rate' ? 'أرسلت بلاغات كثيرة، حاول بعد قليل.' : 'تعذّر الإرسال.'); }
      sh.querySelector('.sheet-body').innerHTML = successHtml('شكراً لك! 🙏', 'وصل بلاغك إلى فريق الدليل، وسنراجعه ونصحّح المعلومات في أقرب وقت.');
    } catch {
      btn.disabled = false;
      fail('تعذّر الاتصال. حاول مجدداً.');
    }
  });
}

// ─────────────── التفاعل ───────────────

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => t.classList.remove('show'), 2200);
}

async function copy(text, msg = 'تم النسخ') {
  try { await navigator.clipboard.writeText(text); toast(msg); } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.append(ta);
    ta.select();
    try { document.execCommand('copy'); toast(msg); } catch { toast('تعذّر النسخ'); }
    ta.remove();
  }
}

function itemText(it) {
  const cat = catOf(it);
  return [it.n, cat && cat.n, ...(it.p || []).map((p) => `📞 ${p}`), (it.d || it.a) && `📍 ${it.d || it.a}`, mapHref(it)].filter(Boolean).join('\n');
}

async function share(it) {
  const url = `${location.origin}/?l=${it.i}`;
  const text = `${it.n}${it.p ? ` — ${it.p[0]}` : ''}\nمن دليل حماة:`;
  track(it.i, 'share');
  if (navigator.share) {
    try { await navigator.share({ title: it.n, text, url }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  copy(`${itemText(it)}\n${url}`, 'تم نسخ الرابط والمعلومات');
}

function toggleFav(id, btn) {
  if (state.favs.has(id)) { state.favs.delete(id); toast('أُزيل من المفضلة'); } else { state.favs.add(id); toast('أُضيف إلى المفضلة ❤️'); }
  store.set('dh:favs', [...state.favs]);
  document.querySelectorAll(`[data-id="${id}"] [data-act="fav"]`).forEach((b) => {
    b.setAttribute('aria-pressed', state.favs.has(id));
    b.classList.remove('pop');
    void b.offsetWidth;
    b.classList.add('pop');
  });
  if (btn) btn.setAttribute('aria-pressed', state.favs.has(id));
  updateFavDot();
  if (params().v === 'favs') { state.viewKey = ''; sync(); }
}

function updateFavDot() {
  const dot = $('#fav-dot');
  dot.hidden = !state.favs.size;
  dot.textContent = state.favs.size > 99 ? '99+' : state.favs.size;
}

const GEO_MAX_AGE = 10 * 60 * 1000;
const geoStale = () => !state.geo || Date.now() - (state.geo.at || 0) > GEO_MAX_AGE;

function locate(quiet = false) {
  if (!navigator.geolocation) { toast('المتصفح لا يدعم تحديد الموقع'); return; }
  if (!quiet) toast('جارٍ تحديد موقعك…');
  navigator.geolocation.getCurrentPosition((pos) => {
    state.geo = { lat: pos.coords.latitude, lng: pos.coords.longitude, at: Date.now() };
    store.set('dh:geo', state.geo);
    const p = params();
    const showsDistance = p.v === 'near' || p.s === 'near';
    if (!quiet || (showsDistance && window.scrollY < 400)) {
      state.viewKey = '';
      sync();
    }
    const far = distance(state.geo.lat, state.geo.lng, 35.1318, 36.7578) > 40000;
    if (!quiet || far) toast(far ? 'يبدو أنك خارج حماة، رتّبنا لك حسب الأقرب على أي حال' : 'تم تحديد موقعك ✓');
  }, (err) => {
    if (!quiet) toast(err.code === 1 ? 'يرجى السماح بالوصول إلى الموقع من إعدادات المتصفح' : 'تعذّر تحديد الموقع، حاول مجدداً');
  }, { enableHighAccuracy: true, timeout: 12000, maximumAge: 120000 });
}

document.addEventListener('click', (e) => {
  const a = e.target.closest('a[href]');
  const act = e.target.closest('[data-act]');
  const actName = act && act.dataset.act;
  const holder = e.target.closest('[data-id]');
  const id = holder ? Number(holder.dataset.id) : null;
  const it = id ? state.byId.get(id) : null;

  if (actName === 'call' || actName === 'whatsapp' || actName === 'map') { track(id, actName); return; }
  if (actName === 'sos') return;
  if (actName === 'open' && !(e.ctrlKey || e.metaKey || e.shiftKey || e.button)) { e.preventDefault(); go({ l: id }, { keep: true }); return; }
  if (actName === 'fav') { e.preventDefault(); toggleFav(id, act); return; }
  if (actName === 'share' && it) { e.preventDefault(); share(it); return; }
  if (actName === 'share-site') {
    e.preventDefault();
    const d = { title: 'دليل حماة', text: 'كل أرقام وعناوين حماة بين يديك 🌿', url: `${location.origin}/` };
    if (navigator.share) navigator.share(d).catch(() => {}); else copy(`${d.text}\n${d.url}`, 'تم نسخ رابط الدليل');
    return;
  }
  if (actName === 'copy') { e.preventDefault(); copy(act.dataset.val, 'تم نسخ الرقم'); return; }
  if (actName === 'copy-all' && it) { e.preventDefault(); copy(itemText(it), 'تم نسخ معلومات النشاط'); return; }
  if (actName === 'report') {
    e.preventDefault();
    if (act.dataset.kind) sessionStorage.setItem('dh:rk', act.dataset.kind);
    go({ l: null, hash: it ? `report-${it.i}` : 'report' }, { keep: true, push: !history.state?.sheet });
    return;
  }
  if (actName === 'addphone') { e.preventDefault(); go({ l: null, hash: `addphone-${id}` }, { keep: true, push: !history.state?.sheet }); return; }
  if (actName === 'close') { e.preventDefault(); closeSheet(); return; }
  if (actName === 'back') {
    e.preventDefault();
    if (history.state && history.state.idx > 0) history.back(); else go({}, { push: false });
    return;
  }
  if (actName === 'toggle-map') { e.preventDefault(); go({ m: !params().m }, { keep: true, push: false }); return; }
  if (actName === 'locate') { e.preventDefault(); state.geoTried = true; locate(); return; }
  if (actName === 'here') {
    e.preventDefault();
    navigator.geolocation?.getCurrentPosition((pos) => {
      const inp = act.closest('.field').querySelector('input');
      inp.value = `https://www.google.com/maps?q=${pos.coords.latitude.toFixed(6)},${pos.coords.longitude.toFixed(6)}`;
      toast('تم تحديد الموقع ✓');
    }, () => toast('تعذّر تحديد الموقع'), { enableHighAccuracy: true, timeout: 12000 });
    return;
  }

  // روابط داخلية: تنقّل بدون إعادة تحميل
  if (a && !e.defaultPrevented && !(e.ctrlKey || e.metaKey || e.shiftKey) && a.origin === location.origin && !a.target) {
    const u = new URL(a.href);
    if (u.pathname !== '/' && u.pathname !== '/index.html') return;
    const raw = a.getAttribute('href');
    if (raw.startsWith('#') && !routerHash(raw)) return;
    e.preventDefault();
    const sp = u.searchParams;
    const next = {
      q: sp.get('q') || '', c: Number(sp.get('c')) || null, a: sp.get('a') || '', v: sp.get('v') || '',
      s: sp.get('s') || '', m: sp.get('m') === '1', l: Number(sp.get('l')) || null, hash: routerHash(u.hash),
    };
    if (u.hash && !u.search && a.getAttribute('href').startsWith('#')) {
      go({ hash: routerHash(u.hash), l: null }, { keep: true, push: !history.state?.sheet });
    } else {
      if (sheetEls) {
        const pushed = !!(history.state && history.state.sheet);
        hideSheet();
        if (pushed) {
          history.replaceState({ ...history.state, sheet: false }, '', urlFor(next));
          sync();
          return;
        }
        history.replaceState({ ...(history.state || {}), sheet: false }, '', urlFor({ ...params(), l: null, hash: '' }));
      }
      go(next);
    }
  }
});

document.addEventListener('change', (e) => {
  const f = e.target.closest('[data-filter]');
  if (!f) return;
  const k = f.dataset.filter;
  const v = f.value;
  if (k === 's' && v === 'near' && geoStale()) { state.geoTried = true; locate(); }
  go({ [k]: k === 'c' ? (Number(v) || null) : v }, { keep: true, push: false });
});

// ─────────────── البحث ───────────────

const input = $('#q');

input.addEventListener('input', () => {
  const q = input.value;
  $('#clear-q').hidden = !q;
  const p = params();
  const wasHome = !p.q && !p.c && !p.a && !p.v;
  if (wasHome && q.trim()) {
    history.pushState({ idx: ((history.state && history.state.idx) || 0) + 1 }, '', urlFor({ ...p, q: q.trim() }));
  } else {
    history.replaceState(history.state, '', urlFor({ ...p, q: q.trim(), v: p.v === 'cats' || p.v === 'favs' ? '' : p.v }));
  }
  state.viewKey = '';
  sync();
});

$('#search-form').addEventListener('submit', (e) => {
  e.preventDefault();
  input.blur();
});

$('#clear-q').addEventListener('click', () => {
  input.value = '';
  go({ q: '' }, { keep: true, push: false });
  input.focus();
});

// البحث بالصوت
const Speech = window.SpeechRecognition || window.webkitSpeechRecognition;
if (Speech) {
  const mic = $('#mic');
  mic.hidden = false;
  let rec = null;
  mic.addEventListener('click', () => {
    if (rec) { rec.stop(); return; }
    rec = new Speech();
    rec.lang = 'ar-SY';
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    mic.classList.add('listening');
    rec.onresult = (ev) => {
      input.value = [...ev.results].map((r) => r[0].transcript).join(' ');
      input.dispatchEvent(new Event('input'));
    };
    rec.onerror = () => toast('لم نتمكن من سماعك، حاول مجدداً');
    rec.onend = () => { mic.classList.remove('listening'); rec = null; };
    rec.start();
  });
}

// ─────────────── المظهر والتثبيت ───────────────

function effectiveDark() {
  const t = document.documentElement.dataset.theme;
  return t ? t === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
}
function paintThemeBtn() {
  $('#theme-btn').innerHTML = I(effectiveDark() ? 'sun' : 'moon');
}
$('#theme-btn').addEventListener('click', () => {
  const next = effectiveDark() ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  store.set('dh:theme', next);
  paintThemeBtn();
});
paintThemeBtn();

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  state.installEvt = e;
  $('#install-btn').classList.add('show');
});
$('#install-btn').addEventListener('click', async () => {
  if (!state.installEvt) return;
  state.installEvt.prompt();
  await state.installEvt.userChoice;
  state.installEvt = null;
  $('#install-btn').classList.remove('show');
});

// الشريط العلوي فوق البطل
var topbar = $('#topbar');
var hero = $('#hero');
function onScroll() { topbar.classList.toggle('on-hero', window.scrollY < hero.offsetHeight - 70); }
window.addEventListener('scroll', onScroll, { passive: true });
onScroll();

$('#year').textContent = new Intl.NumberFormat('ar-SY', { useGrouping: false }).format(new Date().getFullYear());

// ─────────────── البدء ───────────────

history.replaceState({ idx: 0 }, '');
loadData();
if (!sessionStorage.getItem('dh:visit')) { sessionStorage.setItem('dh:visit', '1'); track(null, 'visit'); }
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
}

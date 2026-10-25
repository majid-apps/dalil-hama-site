// دليل حماة — لوحة الإدارة
import {
  request, ApiError, esc, fmtNum, store, debounce, normalizePhone, formatPhone, isMobile, waHref, telHref, timeAgo, normalize, safeUrl,
} from './core.js';
import { SearchIndex } from './search.js';

const ICONS = '/assets/img/icons.svg';
const I = (name, cls = '') => `<svg class="ico ${cls}" aria-hidden="true"><use href="${ICONS}#${name}"/></svg>`;
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const SESSION_KEY = 'dh:admin-session';
const PAGE = 60;

const STATUS = { approved: 'منشور', pending: 'قيد المراجعة', hidden: 'مخفي', rejected: 'مرفوض' };
const REPORT_KIND = { wrong_number: 'رقم خاطئ', wrong_info: 'معلومات ناقصة/خاطئة', closed: 'مغلق نهائياً', removal: 'طلب حذف', abuse: 'إزعاج أو احتيال', other: 'أخرى' };
const REPORT_STATUS = { open: 'مفتوح', resolved: 'تمت المعالجة', dismissed: 'مُتجاهل' };
const FIELD_LABEL = {
  name: 'الاسم', category_id: 'التصنيف', phones: 'الأرقام', area: 'الحي', address: 'العنوان', map_url: 'رابط الخريطة', lat: 'خط العرض', lng: 'خط الطول',
  website: 'الموقع', description: 'النبذة', tags: 'الوسوم', status: 'الحالة', featured: 'مميز', verified: 'موثّق', whatsapp: 'واتساب', no_whatsapp: 'بلا واتساب', admin_note: 'ملاحظة إدارية',
};

// ─────────────── المصادقة والطلبات ───────────────

const auth = {
  session: store.get(SESSION_KEY),
  save(r) {
    // الانتهاء يُحسب بساعة الجهاز نفسه حتى لا يتأثر بفارق التوقيت مع الخادم
    const exp = r.expires_in ? Math.floor(Date.now() / 1000) + Number(r.expires_in) : r.expires_at;
    // نخزّن معرّف الحساب لا بريده: الواجهة لا تعرض البريد ولا تحتاجه
    this.session = { access_token: r.access_token, refresh_token: r.refresh_token, expires_at: exp, uid: r.user && r.user.id };
    store.set(SESSION_KEY, this.session);
  },
  clear() {
    const s = store.get(SESSION_KEY);
    if (!s || !this.session || s.refresh_token === this.session.refresh_token) store.del(SESSION_KEY);
    this.session = null;
  },
  /** الدخول بكلمة المرور فقط: تعيد القاعدة معرّف الحساب المطابق (ولا تعيده إلا لكلمة صحيحة) ثم نطلب الجلسة */
  async login(password) {
    let id;
    try {
      id = await request('/rest/v1/rpc/admin_login_hint', { method: 'POST', body: { p_password: password } });
    } catch (e) {
      if (/too_many_attempts/.test(e.message || '')) throw new ApiError('محاولات كثيرة خاطئة. انتظر 15 دقيقة ثم أعد المحاولة.', 429);
      throw e;
    }
    if (!id) throw new ApiError('كلمة المرور غير صحيحة.', 400);
    const r = await request('/auth/v1/token?grant_type=password', { method: 'POST', body: { email: id, password } });
    this.save(r);
  },
  async refresh() {
    if (!this.session) throw new ApiError('no session', 401);
    // تبويب آخر جدّد الجلسة: نعتمد جلسته بدلاً من تجديد ثانٍ برمز صار ملغى
    const s = store.get(SESSION_KEY);
    if (s && s.refresh_token && s.refresh_token !== this.session.refresh_token) {
      if (s.uid !== this.session.uid) throw new ApiError('session belongs to another account', 401);
      this.session = s;
      return;
    }
    const r = await request('/auth/v1/token?grant_type=refresh_token', { method: 'POST', body: { refresh_token: this.session.refresh_token } });
    this.save(r);
  },
  async token() {
    if (!this.session) throw new ApiError('no session', 401);
    if (this.session.expires_at * 1000 - Date.now() < 90000) await this.refresh();
    return this.session.access_token;
  },
};

function sessionExpired() {
  auth.clear();
  renderLogin('انتهت الجلسة، سجّل الدخول مجدداً.');
}

async function api(path, opts = {}, retry = true) {
  let token;
  try {
    token = await auth.token();
  } catch (e) {
    if (e.status === 400 || e.status === 401) sessionExpired();
    throw e;
  }
  try {
    return await request(path, { ...opts, token });
  } catch (e) {
    if (e.status === 401 && retry) {
      try { await auth.refresh(); } catch { sessionExpired(); throw e; }
      return api(path, opts, false);
    }
    throw e;
  }
}
const rest = (path, opts) => api(`/rest/v1/${path}`, opts);
const rpc = (name, args = {}) => api(`/rest/v1/rpc/${name}`, { method: 'POST', body: args });
const rep = { Prefer: 'return=representation' };

// ─────────────── الحالة ───────────────

const A = {
  me: null, listings: [], byId: new Map(), cats: [], catById: new Map(), areas: [], settings: {}, stats: null, reports: [], admins: [],
  index: new SearchIndex(), f: { q: '', cat: '', status: 'approved', flag: '', area: '', sort: 'new' }, selected: new Set(), page: 0, reportTab: 'open',
};

function toast(msg, bad = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.style.background = bad ? 'var(--danger)' : '';
  t.style.color = bad ? '#fff' : '';
  t.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => t.classList.remove('show'), 2600);
}

function errMsg(e) {
  const m = (e && e.message) || '';
  if (/duplicate key/.test(m)) return 'القيمة موجودة مسبقاً';
  if (/violates foreign key/.test(m)) return 'لا يمكن الحذف لارتباطه ببيانات أخرى';
  if (/forbidden|permission denied|42501/.test(m)) return 'لا تملك صلاحية هذا الإجراء';
  if (/Failed to fetch|NetworkError/.test(m)) return 'تعذّر الاتصال بالخادم';
  return m || 'حدث خطأ غير متوقع';
}

async function fetchAllListings() {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const page = await rest(`listings?select=*&order=id.asc&offset=${from}&limit=1000`);
    out.push(...page);
    if (page.length < 1000) break;
  }
  return out;
}

function compact(r) {
  return { i: r.id, n: r.name, c: r.category_id, p: r.phones, a: r.area, d: r.address, e: [r.description, r.admin_note, r.submitter_name].filter(Boolean).join(' '), t: r.tags, k: 0, _row: r };
}

function indexListings() {
  A.byId = new Map(A.listings.map((r) => [r.id, r]));
  A.index.setData(A.listings.map(compact), A.cats.map((c) => ({ i: c.id, n: c.name, k: c.keywords, o: c.sort })), A.areas.map((a) => ({ n: a.name })));
}

async function loadAll() {
  const [listings, cats, areas, settings, stats, reports, admins] = await Promise.all([
    fetchAllListings(),
    rest('categories?select=*&order=sort.asc,name.asc'),
    rest('areas?select=*&order=sort.asc,name.asc'),
    rest('settings?select=*'),
    rpc('admin_stats'),
    rest('reports?select=*&order=created_at.desc&limit=300'),
    rest('admins?select=*&order=created_at.asc'),
  ]);
  A.listings = listings;
  A.cats = cats;
  A.catById = new Map(cats.map((c) => [c.id, c]));
  A.areas = areas;
  A.settings = Object.fromEntries(settings.map((s) => [s.key, s.value]));
  A.stats = stats;
  A.reports = reports;
  A.admins = admins;
  indexListings();
}

async function refreshStats() {
  try { A.stats = await rpc('admin_stats'); renderNavCounts(); } catch { /* ignore */ }
}

function upsertLocal(row) {
  const i = A.listings.findIndex((r) => r.id === row.id);
  if (i === -1) A.listings.push(row); else A.listings[i] = row;
  indexListings();
}
function removeLocal(id) {
  A.listings = A.listings.filter((r) => r.id !== id);
  indexListings();
}

// ─────────────── الدخول ───────────────

function renderLogin(msg = '') {
  $('#app').innerHTML = `<div class="login"><form class="login-card form" id="login-form">
      <div class="brand"><span class="mark"><svg viewBox="0 0 64 64"><use href="${ICONS}#noria"/></svg></span><span>دليل حماة<small>لوحة الإدارة</small></span></div>
      <div><h1>تسجيل الدخول</h1><p>هذه الصفحة مخصصة لفريق إدارة الدليل.</p></div>
      <label class="field"><span>كلمة المرور</span><input class="input" name="password" type="password" dir="ltr" autocomplete="current-password" autofocus required></label>
      <div class="form-error" ${msg ? '' : 'hidden'}>${esc(msg)}</div>
      <button class="btn btn-primary btn-lg btn-block" type="submit">دخول</button>
      <a class="btn btn-ghost btn-block" href="/">${I('back', 'sm')}العودة إلى الدليل</a>
    </form></div>`;
  $('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const btn = e.target.querySelector('[type=submit]');
    btn.disabled = true;
    btn.textContent = 'جارٍ الدخول…';
    try {
      await auth.login(fd.get('password'));
      await start();
    } catch (err) {
      auth.clear();
      btn.disabled = false;
      btn.textContent = 'دخول';
      const box = $('.form-error');
      box.hidden = false;
      box.textContent = err.status === 400 ? 'كلمة المرور غير صحيحة.' : errMsg(err);
    }
  });
}

// ─────────────── الهيكل والتنقل ───────────────

const VIEWS = [
  ['dash', 'الرئيسية', 'chart'],
  ['pending', 'طلبات الإضافة', 'inbox'],
  ['reports', 'البلاغات', 'flag'],
  ['listings', 'الأنشطة', 'list'],
  ['quality', 'جودة البيانات', 'check'],
  ['-'],
  ['cats', 'التصنيفات', 'grid'],
  ['areas', 'الأحياء', 'pin'],
  ['io', 'استيراد وتصدير', 'download'],
  ['log', 'سجل التعديلات', 'history'],
  ['settings', 'الإعدادات', 'settings'],
];

function renderShell() {
  $('#app').innerHTML = `<div class="shell">
    <aside class="side" id="side">
      <a class="brand" href="/"><span class="mark"><svg viewBox="0 0 64 64"><use href="${ICONS}#noria"/></svg></span><span>دليل حماة<small>لوحة الإدارة</small></span></a>
      <nav class="nav" id="nav">${VIEWS.map(([k, l, ic]) => (k === '-' ? '<div class="nav-sep"></div>' : `<a href="#${k}" data-view="${k}">${I(ic)}${l}<span class="n" data-count="${k}" hidden></span></a>`)).join('')}</nav>
      <div class="side-foot">
        <div class="who">${I('user', 'sm')}<span style="overflow:hidden;text-overflow:ellipsis">${A.me.role === 'owner' ? 'مالك الدليل' : 'محرر'}</span></div>
        <div style="display:flex;gap:6px">
          <a class="btn btn-soft" href="/" style="flex:1">${I('external', 'sm')}الدليل</a>
          <button class="btn btn-soft" type="button" id="theme-btn" aria-label="المظهر">${I('moon', 'sm')}</button>
          <button class="btn btn-soft" type="button" id="logout" aria-label="خروج">${I('logout', 'sm')}</button>
        </div>
      </div>
    </aside>
    <div class="scrim" id="scrim" hidden></div>
    <div class="main">
      <header class="bar"><button class="icon-btn menu" type="button" id="menu" aria-label="القائمة">${I('menu')}</button><h1 id="title"></h1><div id="bar-actions" style="display:flex;gap:8px"></div></header>
      <div class="content" id="content"></div>
    </div>
  </div>`;
  const side = $('#side');
  const scrim = $('#scrim');
  const closeMenu = () => { side.classList.remove('open'); scrim.hidden = true; };
  $('#menu').addEventListener('click', () => { side.classList.add('open'); scrim.hidden = false; });
  scrim.addEventListener('click', closeMenu);
  $('#nav').addEventListener('click', closeMenu);
  $('#logout').addEventListener('click', async () => {
    try { await api('/auth/v1/logout', { method: 'POST' }); } catch { /* ignore */ }
    auth.clear();
    renderLogin();
  });
  $('#theme-btn').addEventListener('click', () => {
    const dark = document.documentElement.dataset.theme ? document.documentElement.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
    document.documentElement.dataset.theme = dark ? 'light' : 'dark';
    store.set('dh:theme', document.documentElement.dataset.theme);
  });
  renderNavCounts();
}

function renderNavCounts() {
  const s = A.stats || {};
  const set = (k, n, soft = false) => {
    const el = $(`[data-count="${k}"]`);
    if (!el) return;
    el.hidden = !n;
    el.textContent = fmtNum(n || 0);
    el.classList.toggle('soft', soft);
  };
  set('pending', s.pending);
  set('reports', s.reports_open);
  set('listings', s.approved, true);
}

/** روابط سريعة من الدليل العام: ‎#edit/12 يفتح تعديل النشاط، و‎#new يفتح نشاطاً جديداً (مع ‎#new?name=…&phone=…) */
function deepLink() {
  const [head, query = ''] = location.hash.slice(1).split('?');
  const [v, arg] = head.split('/');
  if (v !== 'edit' && v !== 'new') return null;
  const q = new URLSearchParams(query);
  return { v, id: Number(arg) || null, preset: { name: (q.get('name') || '').slice(0, 160), phones: q.get('phone') ? [normalizePhone(q.get('phone'))] : [] } };
}

function route() {
  const dl = deepLink();
  let v = location.hash.slice(1).split('?')[0].split('/')[0] || 'dash';
  if (dl) v = 'listings';
  const def = VIEWS.find((x) => x[0] === v) || VIEWS[0];
  $$('#nav a').forEach((a) => (a.dataset.view === def[0] ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current')));
  $('#title').textContent = def[1];
  $('#bar-actions').innerHTML = '';
  const fn = { dash: viewDash, pending: viewPending, reports: viewReports, listings: viewListings, quality: viewQuality, cats: viewCats, areas: viewAreas, io: viewIO, log: viewLog, settings: viewSettings }[def[0]];
  window.scrollTo(0, 0);
  fn($('#content'));
  if (dl) {
    // نُرجع العنوان إلى القائمة حتى لا يُعاد فتح النافذة عند التحديث أو الرجوع
    history.replaceState(null, '', '#listings');
    if (dl.v === 'new') editListing(null, dl.preset);
    else if (A.byId.has(dl.id)) editListing(dl.id);
    else toast('لم أجد هذا النشاط في الإدارة (ربما حُذف)', true);
  }
}
window.addEventListener('hashchange', () => { if (A.me) { closeSheet(); route(); } });

async function start() {
  if (!auth.session) return renderLogin();
  try {
    A.me = await rpc('admin_me');
    if (!A.me) { auth.clear(); return renderLogin('هذا الحساب لا يملك صلاحية الإدارة.'); }
    $('#app').innerHTML = `<div class="boot"><svg class="spin" viewBox="0 0 64 64"><use href="${ICONS}#noria"/></svg></div>`;
    await loadAll();
    renderShell();
    route();
  } catch (e) {
    if (e.status === 401 || e.status === 400) { auth.clear(); return renderLogin(); }
    $('#app').innerHTML = `<div class="login"><div class="login-card"><h1>تعذّر التحميل</h1><p>${esc(errMsg(e))}</p><button class="btn btn-primary btn-block" onclick="location.reload()">إعادة المحاولة</button></div></div>`;
  }
}

// ─────────────── أدوات العرض ───────────────

const catName = (id) => (A.catById.get(id) || {}).name || 'بلا تصنيف';
const catIcon = (id) => esc((A.catById.get(id) || {}).icon || '📍');
const catHue = (id) => { const c = A.catById.get(id); return c ? (c.sort * 4.7 + c.id * 31) % 360 : 170; };
const phonesHtml = (r) => (r.phones || []).map((p) => `<bdi dir="ltr">${esc(formatPhone(p))}</bdi>`).join(' · ') || '<span style="color:var(--danger)">بلا رقم</span>';
const st = (s, map = STATUS) => `<span class="st ${s}">${map[s] || s}</span>`;
const fmtDate = (d) => new Date(d).toLocaleString('ar-SY', { dateStyle: 'medium', timeStyle: 'short' });

function listingRow(r, { select = true, ops = '' } = {}) {
  const flags = [r.featured && I('star', 'sm'), r.verified && I('verified', 'sm'), (r.lat || r.map_url) && I('pin', 'sm')].filter(Boolean).join('');
  return `<div class="row${A.selected.has(r.id) ? ' sel' : ''}" data-id="${r.id}">
    ${select ? `<input type="checkbox" data-sel="${r.id}" ${A.selected.has(r.id) ? 'checked' : ''} aria-label="تحديد">` : `<span class="avatar" style="width:40px;height:40px;font-size:20px;border-radius:12px;--hue:${catHue(r.category_id)}">${catIcon(r.category_id)}</span>`}
    <div style="min-width:0"><div class="nm">${select ? `${catIcon(r.category_id)} ` : ''}${esc(r.name)} <span class="flags" style="color:var(--brand)">${flags}</span></div>
      <div class="sub"><span>#${r.id}</span><span>${esc(catName(r.category_id))}</span>${r.area ? `<span>${esc(r.area)}</span>` : ''}<span>${phonesHtml(r)}</span>${r.status !== 'approved' ? st(r.status) : ''}</div></div>
    <div class="ops">${ops || `<a class="btn btn-ghost" href="/?l=${r.id}" aria-label="عرض في الدليل" title="عرض في الدليل">${I('eye', 'sm')}</a><button class="btn btn-soft" type="button" data-edit="${r.id}">${I('edit', 'sm')}تعديل</button>`}</div>
  </div>`;
}

// ─────────────── النافذة (Sheet) ───────────────

let sheet = null;
function openSheet(title, body, { wide = true } = {}) {
  closeSheet();
  const bd = document.createElement('div');
  bd.className = 'backdrop';
  const sh = document.createElement('div');
  sh.className = `sheet${wide ? ' wide' : ''}`;
  sh.setAttribute('role', 'dialog');
  sh.setAttribute('aria-modal', 'true');
  sh.tabIndex = -1;
  sh.innerHTML = `<div class="grab"></div><div class="sheet-head"><h2>${title}</h2><button class="icon-btn" type="button" data-close aria-label="إغلاق">${I('x')}</button></div><div class="sheet-body">${body}</div>`;
  document.body.append(bd, sh);
  document.documentElement.style.overflow = 'hidden';
  requestAnimationFrame(() => { bd.classList.add('show'); sh.classList.add('show'); });
  bd.addEventListener('click', closeSheet);
  sh.querySelector('[data-close]').addEventListener('click', closeSheet);
  sheet = { bd, sh };
  sh.focus({ preventScroll: true });
  return sh;
}
function closeSheet() {
  if (!sheet) return;
  const { bd, sh } = sheet;
  bd.classList.remove('show');
  sh.classList.remove('show');
  setTimeout(() => { bd.remove(); sh.remove(); }, 300);
  sheet = null;
  document.documentElement.style.overflow = '';
}
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && sheet && !document.querySelector('dialog[open]')) closeSheet();
});

function confirmBox(msg, { ok = 'تأكيد', danger = false } = {}) {
  return new Promise((resolve) => {
    const d = document.createElement('dialog');
    d.className = 'confirm';
    d.innerHTML = `<p>${msg}</p><form method="dialog" class="confirm-ops"><button value="ok" class="btn ${danger ? 'btn-danger' : 'btn-primary'}">${ok}</button><button value="" class="btn btn-soft"${danger ? ' autofocus' : ''}>إلغاء</button></form>`;
    document.body.append(d);
    d.addEventListener('close', () => { resolve(d.returnValue === 'ok'); d.remove(); });
    d.addEventListener('click', (e) => { if (e.target === d) d.close(''); });
    d.showModal();
  });
}

// ─────────────── الخريطة والإحداثيات ───────────────

const OLC = '23456789CFGHJMPQRVWX';
function olcDecode(code) {
  code = code.toUpperCase().replace('+', '');
  let lat = -90;
  let lng = -180;
  let res = 20;
  const pairs = code.slice(0, 10);
  for (let i = 0; i < pairs.length; i += 2) {
    lat += OLC.indexOf(pairs[i]) * res;
    lng += OLC.indexOf(pairs[i + 1]) * res;
    if (i + 2 < pairs.length) res /= 20;
  }
  let latRes = res;
  let lngRes = res;
  if (code.length > 10) {
    const d = OLC.indexOf(code[10]);
    latRes = res / 5;
    lngRes = res / 4;
    lat += Math.floor(d / 4) * latRes;
    lng += (d % 4) * lngRes;
  }
  return [lat + latRes / 2, lng + lngRes / 2];
}
function olcRecover(short, ref = [35.1318, 36.7578]) {
  const head = short.toUpperCase().split('+')[0];
  if (head.length >= 8) return olcDecode(short);
  const pad = 8 - head.length;
  const resolution = 20 ** (2 - pad / 2);
  let la = ref[0] + 90;
  let ln = ref[1] + 180;
  let prefix = '';
  let r = 20;
  while (prefix.length < pad) {
    prefix += OLC[Math.floor(la / r)] + OLC[Math.floor(ln / r)];
    la %= r;
    ln %= r;
    r /= 20;
  }
  let [lat, lng] = olcDecode(prefix.slice(0, pad) + short.toUpperCase());
  const half = resolution / 2;
  if (ref[0] + half < lat) lat -= resolution; else if (ref[0] - half > lat) lat += resolution;
  if (ref[1] + half < lng) lng -= resolution; else if (ref[1] - half > lng) lng += resolution;
  return [lat, lng];
}
const inHama = (lat, lng) => lat > 34.95 && lat < 35.35 && lng > 36.55 && lng < 37;

/** يستخرج الإحداثيات والاسم من رابط خرائط أو عنوان فيه Plus Code */
function parseMap(text) {
  const raw = String(text || '');
  let u;
  try { u = decodeURIComponent(raw.replace(/\+/g, ' ')); } catch { u = raw.replace(/\+/g, ' '); }
  const out = { lat: null, lng: null, name: '' };
  const m1 = u.match(/@(-?\d+\.\d+),\s*(-?\d+\.\d+)/) || u.match(/[?&](?:q|query|ll|daddr|destination)=(-?\d+\.\d+),\s*(-?\d+\.\d+)/) || u.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/);
  if (m1) { out.lat = +m1[1]; out.lng = +m1[2]; }
  if (out.lat === null) {
    const PCX = /\b([23456789CFGHJMPQRVWX]{4,8}\+[23456789CFGHJMPQRVWX]{2,3})\b/i;
    let dec = raw;
    try { dec = decodeURIComponent(raw); } catch { /* keep raw */ }
    const pc = raw.match(PCX) || dec.match(PCX);
    if (pc) [out.lat, out.lng] = olcRecover(pc[1]);
  }
  if (out.lat !== null && !inHama(out.lat, out.lng)) { out.lat = null; out.lng = null; }
  const place = u.match(/\/place\/([^/@]+)/);
  const query = u.match(/[?&]query=([^&]+)/);
  if (place) out.name = place[1].trim();
  else if (query && !/^-?\d/.test(query[1])) out.name = query[1].split(',')[0].trim();
  return out;
}

// ─────────────── الرئيسية ───────────────

function viewDash(el) {
  const s = { days: [], top: [], misses: [], searches: [], ...(A.stats || {}) };
  const days = new Map();
  for (const d of s.days) {
    if (!days.has(d.day)) days.set(d.day, {});
    days.get(d.day)[d.kind] = d.count;
  }
  const list = [];
  for (let i = 29; i >= 0; i--) {
    const day = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
    list.push([day, days.get(day) || {}]);
  }
  const sum = (k) => list.reduce((a, [, v]) => a + (v[k] || 0), 0);
  const max = Math.max(1, ...list.map(([, v]) => (v.call || 0) + (v.whatsapp || 0) + (v.view || 0)));
  const maxV = Math.max(1, ...list.map(([, v]) => v.visit || 0));
  const chart = list.map(([day, v]) => {
    const h = (n) => `${(n / max) * 100}%`;
    return `<div class="col" data-tip="${day.slice(5)}: ${v.view || 0} مشاهدة · ${v.call || 0} اتصال · ${v.whatsapp || 0} واتساب"><div class="seg" style="height:${h(v.call || 0)};background:var(--brand)"></div><div class="seg" style="height:${h(v.whatsapp || 0)};background:var(--wa)"></div><div class="seg" style="height:${h(v.view || 0)};background:var(--gold-2);opacity:.55"></div></div>`;
  }).join('');
  const chartV = list.map(([day, v]) => `<div class="col" data-tip="${day.slice(5)}: ${v.visit || 0} زيارة · ${v.search || 0} بحث"><div class="seg" style="height:${((v.visit || 0) / maxV) * 100}%;background:var(--brand)"></div></div>`).join('');
  el.innerHTML = `
    <div class="quick-links">
      <a class="btn btn-primary" href="/">${I('external', 'sm')}فتح الدليل العام</a>
      <a class="btn btn-gold" href="#new">${I('plus', 'sm')}نشاط جديد</a>
      <a class="btn btn-soft" href="#pending">${I('inbox', 'sm')}طلبات الإضافة</a>
      <a class="btn btn-soft" href="#reports">${I('flag', 'sm')}البلاغات</a>
    </div>
    <div class="kpis">
      <a class="kpi good" href="#listings"><small>منشور</small><b>${fmtNum(s.approved)}</b></a>
      <a class="kpi ${s.pending ? 'warn' : ''}" href="#pending"><small>طلبات بانتظار المراجعة</small><b>${fmtNum(s.pending)}</b></a>
      <a class="kpi ${s.reports_open ? 'warn' : ''}" href="#reports"><small>بلاغات مفتوحة</small><b>${fmtNum(s.reports_open)}</b></a>
      <a class="kpi" href="#quality"><small>بلا رقم هاتف</small><b>${fmtNum(s.no_phone)}</b></a>
      <a class="kpi" href="#quality"><small>بلا موقع</small><b>${fmtNum(s.no_location)}</b></a>
      <div class="kpi"><small>زيارات آخر 30 يوماً</small><b>${fmtNum(sum('visit'))}</b></div>
    </div>
    <div class="panel-grid">
      <div class="panel"><h2>${I('phone')}التواصل خلال 30 يوماً</h2><div class="chart">${chart}</div>
        <div class="legend"><span><i style="background:var(--brand)"></i>اتصال ${fmtNum(sum('call'))}</span><span><i style="background:var(--wa)"></i>واتساب ${fmtNum(sum('whatsapp'))}</span><span><i style="background:var(--gold-2)"></i>مشاهدة ${fmtNum(sum('view'))}</span><span><i style="background:var(--muted)"></i>خريطة ${fmtNum(sum('map'))}</span></div></div>
      <div class="panel"><h2>${I('chart')}الزيارات والبحث</h2><div class="chart">${chartV}</div>
        <div class="legend"><span><i style="background:var(--brand)"></i>زيارة ${fmtNum(sum('visit'))}</span><span>بحث ${fmtNum(sum('search'))}</span><span>إضافات ${fmtNum(sum('submission'))}</span><span>بلاغات ${fmtNum(sum('report'))}</span></div></div>
    </div>
    <div class="panel-grid">
      <div class="panel"><h2>${I('star')}الأكثر تواصلاً</h2>${s.top.length ? `<ol class="rank">${s.top.map((t) => `<li><span class="grow"><a href="#" data-edit="${t.id}">${esc(t.name)}</a></span><span class="v">📞 ${fmtNum(t.calls)} · 💬 ${fmtNum(t.whatsapp)} · 👁 ${fmtNum(t.views)}</span></li>`).join('')}</ol>` : '<p class="muted">لا توجد بيانات بعد. ستظهر هنا الأنشطة التي يتصل بها الناس أكثر.</p>'}</div>
      <div class="panel"><h2>${I('search')}بحثوا ولم يجدوا</h2><p class="muted" style="margin:-6px 0 10px;font-size:13px">فرص لإضافة أنشطة ناقصة إلى الدليل.</p>${s.misses.length ? `<ol class="rank">${s.misses.map((t) => `<li><span class="grow">${esc(t.term)}</span><span class="v">${fmtNum(t.misses)} مرة</span><button class="btn btn-ghost" style="min-height:30px;padding:0 8px" data-term="${esc(t.term)}">بحث</button></li>`).join('')}</ol>` : '<p class="muted">لا توجد عمليات بحث فاشلة مسجلة.</p>'}</div>
    </div>
    <div class="panel"><h2>${I('search')}أكثر ما يُبحث عنه</h2>${s.searches.length ? `<div class="toolbar" style="margin:0">${s.searches.map((t) => `<span class="pill">${esc(t.term)} <small style="opacity:.6">${fmtNum(t.hits)}</small></span>`).join('')}</div>` : '<p class="muted">لا توجد بيانات بعد.</p>'}</div>`;
  el.querySelectorAll('[data-term]').forEach((b) => b.addEventListener('click', () => { A.f = { ...A.f, q: b.dataset.term, status: 'all' }; location.hash = 'listings'; }));
}

// ─────────────── طلبات الإضافة ───────────────

function viewPending(el) {
  const rows = A.listings.filter((r) => r.status === 'pending').sort((a, b) => b.id - a.id);
  if (!rows.length) {
    el.innerHTML = `<div class="empty"><div class="big">🎉</div><h3>لا توجد طلبات معلّقة</h3><p>كل طلبات الإضافة تمت مراجعتها.</p></div>`;
    return;
  }
  el.innerHTML = rows.map((r) => {
    const dupIds = A.listings.filter((x) => x.id !== r.id && x.status === 'approved' && (x.phones || []).some((p) => (r.phones || []).includes(p)));
    const mob = (r.phones || []).find(isMobile);
    return `<div class="req" data-id="${r.id}">
      <div class="req-head"><span class="avatar" style="--hue:${catHue(r.category_id)}">${catIcon(r.category_id)}</span>
        <div style="flex:1;min-width:0"><h3>${esc(r.name)}</h3><div class="muted" style="font-size:13px">${esc(catName(r.category_id))} · ${timeAgo(r.created_at)} · #${r.id}</div></div>${st(r.status)}</div>
      <dl class="kv">
        <dt>الأرقام</dt><dd>${phonesHtml(r)}</dd>
        ${r.area || r.address ? `<dt>العنوان</dt><dd>${esc([r.area, r.address].filter(Boolean).join('، '))}</dd>` : ''}
        ${safeUrl(r.map_url) ? `<dt>الخريطة</dt><dd><a href="${esc(safeUrl(r.map_url))}" target="_blank" rel="noopener" style="color:var(--brand)">فتح الرابط</a></dd>` : ''}
        ${r.website ? `<dt>الموقع</dt><dd dir="ltr" style="text-align:right">${esc(r.website)}</dd>` : ''}
        ${r.description ? `<dt>النبذة</dt><dd>${esc(r.description)}</dd>` : ''}
        ${r.submitter_name || r.submitter_phone ? `<dt>المُرسِل</dt><dd>${esc(r.submitter_name || '')} ${r.submitter_phone ? `<bdi dir="ltr">${esc(r.submitter_phone)}</bdi>` : ''}</dd>` : ''}
      </dl>
      ${dupIds.length ? `<div class="warnbox">${I('alert', 'sm')}الرقم موجود مسبقاً في: ${dupIds.map((d) => `<a href="#" data-edit="${d.id}" style="font-weight:700">${esc(d.name)}</a>`).join('، ')}</div>` : ''}
      <div class="ops">
        <button class="btn btn-primary" data-approve="${r.id}">${I('check', 'sm')}قبول ونشر</button>
        <button class="btn btn-soft" data-edit="${r.id}">${I('edit', 'sm')}مراجعة وتعديل</button>
        ${mob ? `<a class="btn btn-wa" href="${waHref(mob, `مرحباً، وصلنا طلب إضافة «${r.name}» إلى دليل حماة. نود التأكد من صحة البيانات قبل النشر 🌿`)}" target="_blank" rel="noopener">${I('wa', 'sm')}تحقق عبر واتساب</a>` : ''}
        ${r.phones && r.phones[0] ? `<a class="btn btn-soft" href="${telHref(r.phones[0])}">${I('phone', 'sm')}اتصال</a>` : ''}
        <button class="btn btn-danger" data-reject="${r.id}">${I('x', 'sm')}رفض</button>
      </div></div>`;
  }).join('');
  el.onclick = async (e) => {
    const ap = e.target.closest('[data-approve]');
    const rj = e.target.closest('[data-reject]');
    if (!ap && !rj) return;
    const id = Number((ap || rj).dataset.approve || (ap || rj).dataset.reject);
    try {
      const [row] = await rest(`listings?id=eq.${id}`, { method: 'PATCH', body: { status: ap ? 'approved' : 'rejected' }, headers: rep });
      upsertLocal(row);
      toast(ap ? 'تم النشر ✓' : 'تم الرفض');
      refreshStats();
      viewPending(el);
    } catch (err) { toast(errMsg(err), true); }
  };
}

// ─────────────── البلاغات ───────────────

function viewReports(el) {
  const tab = A.reportTab;
  const rows = A.reports.filter((r) => (tab === 'open' ? r.status === 'open' : r.status !== 'open'));
  el.innerHTML = `<div class="toolbar"><div class="seg-tabs">${['open', 'done'].map((t) => `<button type="button" data-tab="${t}" aria-pressed="${tab === t}">${t === 'open' ? `مفتوحة (${fmtNum(A.reports.filter((r) => r.status === 'open').length)})` : 'المعالَجة'}</button>`).join('')}</div></div>
    ${rows.length ? rows.map((r) => {
    const l = r.listing_id && A.byId.get(r.listing_id);
    return `<div class="req">
      <div class="req-head"><span class="avatar" style="--hue:${l ? catHue(l.category_id) : 10}">${l ? catIcon(l.category_id) : '🚩'}</span>
        <div style="flex:1;min-width:0"><h3>${esc(REPORT_KIND[r.kind] || r.kind)}${r.listing_name ? ` — ${esc(r.listing_name)}` : ''}</h3><div class="muted" style="font-size:13px">${timeAgo(r.created_at)}${l ? ` · ${phonesHtml(l)}` : ''}</div></div>${st(r.status, REPORT_STATUS)}</div>
      ${r.details ? `<div style="white-space:pre-wrap;background:var(--surface-2);border-radius:12px;padding:10px 12px">${esc(r.details)}</div>` : ''}
      ${r.contact ? `<div class="muted" style="font-size:13.5px">للتواصل مع المُبلِّغ: <bdi dir="ltr">${esc(r.contact)}</bdi></div>` : ''}
      <div class="ops">
        ${l ? `<button class="btn btn-soft" data-edit="${l.id}">${I('edit', 'sm')}تعديل النشاط</button>` : ''}
        ${l && l.status === 'approved' ? `<button class="btn btn-soft" data-hide="${l.id}" data-rid="${r.id}">${I('eye-off', 'sm')}إخفاء النشاط</button>` : ''}
        ${r.status === 'open' ? `<button class="btn btn-primary" data-res="${r.id}" data-to="resolved">${I('check', 'sm')}تمت المعالجة</button><button class="btn btn-ghost" data-res="${r.id}" data-to="dismissed">تجاهل</button>`
    : `<button class="btn btn-ghost" data-res="${r.id}" data-to="open">إعادة فتح</button>`}
      </div></div>`;
  }).join('') : `<div class="empty"><div class="big">✅</div><h3>لا توجد بلاغات ${tab === 'open' ? 'مفتوحة' : 'هنا'}</h3></div>`}`;
  el.onclick = async (e) => {
    const t = e.target.closest('[data-tab]');
    if (t) { A.reportTab = t.dataset.tab; viewReports(el); return; }
    const res = e.target.closest('[data-res]');
    const hide = e.target.closest('[data-hide]');
    try {
      if (res) {
        const to = res.dataset.to;
        const [row] = await rest(`reports?id=eq.${res.dataset.res}`, { method: 'PATCH', body: { status: to, resolved_at: to === 'open' ? null : new Date().toISOString() }, headers: rep });
        A.reports = A.reports.map((x) => (x.id === row.id ? row : x));
        toast('تم التحديث');
        refreshStats();
        viewReports(el);
      }
      if (hide) {
        const [row] = await rest(`listings?id=eq.${hide.dataset.hide}`, { method: 'PATCH', body: { status: 'hidden' }, headers: rep });
        upsertLocal(row);
        toast('تم إخفاء النشاط من الدليل');
        viewReports(el);
      }
    } catch (err) { toast(errMsg(err), true); }
  };
}

// ─────────────── الأنشطة ───────────────

function filtered() {
  const f = A.f;
  let rows;
  if (f.q.trim()) rows = A.index.search(f.q).results.map((c) => c._row);
  else rows = A.listings;
  rows = rows.filter((r) => {
    if (f.status !== 'all' && r.status !== f.status) return false;
    if (f.cat && r.category_id !== Number(f.cat)) return false;
    if (f.area && (f.area === '__none' ? r.area : r.area !== f.area)) return false;
    if (f.flag === 'nophone' && (r.phones || []).length) return false;
    if (f.flag === 'noloc' && (r.lat || r.map_url)) return false;
    if (f.flag === 'noarea' && r.area) return false;
    if (f.flag === 'featured' && !r.featured) return false;
    if (f.flag === 'verified' && !r.verified) return false;
    if (f.flag === 'odd' && !(r.phones || []).some((p) => !/^0\d{9}$/.test(p))) return false;
    return true;
  });
  if (!f.q.trim()) {
    if (f.sort === 'new') rows = [...rows].sort((a, b) => b.id - a.id);
    else if (f.sort === 'name') rows = [...rows].sort((a, b) => a.name.localeCompare(b.name, 'ar'));
    else if (f.sort === 'updated') rows = [...rows].sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  }
  return rows;
}

function viewListings(el) {
  $('#bar-actions').innerHTML = `<button class="btn btn-gold" type="button" id="new-listing">${I('plus', 'sm')}نشاط جديد</button>`;
  $('#new-listing').onclick = () => editListing(null);
  const f = A.f;
  el.innerHTML = `<div class="toolbar">
      <input class="input grow" id="f-q" type="search" placeholder="ابحث بالاسم أو الرقم أو العنوان…" value="${esc(f.q)}">
      <select class="input" id="f-status"><option value="all">كل الحالات</option>${Object.entries(STATUS).map(([k, v]) => `<option value="${k}"${f.status === k ? ' selected' : ''}>${v}</option>`).join('')}</select>
      <select class="input" id="f-cat"><option value="">كل التصنيفات</option>${A.cats.map((c) => `<option value="${c.id}"${String(f.cat) === String(c.id) ? ' selected' : ''}>${esc(c.icon)} ${esc(c.name)}</option>`).join('')}</select>
      <select class="input" id="f-area"><option value="">كل الأحياء</option><option value="__none"${f.area === '__none' ? ' selected' : ''}>بلا حي</option>${A.areas.map((a) => `<option${f.area === a.name ? ' selected' : ''}>${esc(a.name)}</option>`).join('')}</select>
      <select class="input" id="f-flag"><option value="">كل البيانات</option>
        <option value="nophone"${f.flag === 'nophone' ? ' selected' : ''}>بلا رقم</option><option value="noloc"${f.flag === 'noloc' ? ' selected' : ''}>بلا موقع</option>
        <option value="noarea"${f.flag === 'noarea' ? ' selected' : ''}>بلا حي</option><option value="odd"${f.flag === 'odd' ? ' selected' : ''}>أرقام غير اعتيادية</option>
        <option value="featured"${f.flag === 'featured' ? ' selected' : ''}>مميّز</option><option value="verified"${f.flag === 'verified' ? ' selected' : ''}>موثّق</option></select>
      <select class="input" id="f-sort"><option value="new">الأحدث</option><option value="updated"${f.sort === 'updated' ? ' selected' : ''}>آخر تعديل</option><option value="name"${f.sort === 'name' ? ' selected' : ''}>أبجدياً</option></select>
    </div>
    <div id="bulk"></div><div id="rows"></div>`;
  const draw = () => {
    const rows = filtered();
    const pages = Math.max(1, Math.ceil(rows.length / PAGE));
    A.page = Math.min(A.page, pages - 1);
    const slice = rows.slice(A.page * PAGE, A.page * PAGE + PAGE);
    $('#rows').innerHTML = `<p class="muted" style="margin:0 0 10px;font-size:14px">${fmtNum(rows.length)} نتيجة <button class="btn btn-ghost" style="min-height:30px;padding:0 8px" id="sel-all">تحديد الكل في الصفحة</button></p>
      <div class="rows">${slice.map((r) => listingRow(r)).join('') || '<div class="empty"><p>لا نتائج.</p></div>'}</div>
      ${pages > 1 ? `<div class="pager"><button class="btn btn-soft" id="pg-prev" ${A.page === 0 ? 'disabled' : ''}>السابق</button><span>${fmtNum(A.page + 1)} / ${fmtNum(pages)}</span><button class="btn btn-soft" id="pg-next" ${A.page >= pages - 1 ? 'disabled' : ''}>التالي</button></div>` : ''}`;
    $('#sel-all').onclick = () => { slice.forEach((r) => A.selected.add(r.id)); draw(); };
    if ($('#pg-prev')) { $('#pg-prev').onclick = () => { A.page--; draw(); window.scrollTo(0, 0); }; $('#pg-next').onclick = () => { A.page++; draw(); window.scrollTo(0, 0); }; }
    drawBulk();
  };
  const drawBulk = () => {
    const n = A.selected.size;
    $('#bulk').innerHTML = n ? `<div class="bulk"><b>${fmtNum(n)} محدد</b>
      <select class="input" id="b-cat"><option value="">نقل إلى تصنيف…</option>${A.cats.map((c) => `<option value="${c.id}">${esc(c.icon)} ${esc(c.name)}</option>`).join('')}</select>
      <select class="input" id="b-area"><option value="">تعيين الحي…</option>${A.areas.map((a) => `<option>${esc(a.name)}</option>`).join('')}</select>
      <select class="input" id="b-status"><option value="">تغيير الحالة…</option>${Object.entries(STATUS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select>
      <button class="btn btn-danger" id="b-del">${I('trash', 'sm')}حذف</button>
      <button class="btn btn-ghost" id="b-clear" style="color:inherit">إلغاء التحديد</button></div>` : '';
    if (!n) return;
    const ids = [...A.selected];
    const bulkPatch = async (body, msg) => {
      try {
        const rows = await rest(`listings?id=in.(${ids.join(',')})`, { method: 'PATCH', body, headers: rep });
        rows.forEach((r) => { const i = A.listings.findIndex((x) => x.id === r.id); if (i > -1) A.listings[i] = r; });
        indexListings();
        A.selected.clear();
        toast(msg);
        refreshStats();
        draw();
      } catch (err) { toast(errMsg(err), true); }
    };
    $('#b-cat').onchange = (e) => e.target.value && bulkPatch({ category_id: Number(e.target.value) }, 'تم نقل التصنيف');
    $('#b-area').onchange = (e) => e.target.value && bulkPatch({ area: e.target.value }, 'تم تعيين الحي');
    $('#b-status').onchange = (e) => e.target.value && bulkPatch({ status: e.target.value }, 'تم تغيير الحالة');
    $('#b-clear').onclick = () => { A.selected.clear(); draw(); };
    $('#b-del').onclick = async () => {
      if (!(await confirmBox(`حذف ${fmtNum(ids.length)} نشاطاً نهائياً؟ لا يمكن التراجع (يمكنك بدلاً من ذلك إخفاؤها).`, { ok: 'حذف نهائي', danger: true }))) return;
      try {
        await rest(`listings?id=in.(${ids.join(',')})`, { method: 'DELETE' });
        A.listings = A.listings.filter((r) => !A.selected.has(r.id));
        indexListings();
        A.selected.clear();
        toast('تم الحذف');
        refreshStats();
        draw();
      } catch (err) { toast(errMsg(err), true); }
    };
  };
  const onF = () => {
    A.f = { q: $('#f-q').value, status: $('#f-status').value, cat: $('#f-cat').value, area: $('#f-area').value, flag: $('#f-flag').value, sort: $('#f-sort').value };
    A.page = 0;
    A.selected.clear(); // لا نُبقي محددات مخفية عن الشاشة فتُحذف أو تُعدَّل دون قصد
    draw();
  };
  $('#f-q').addEventListener('input', debounce(onF, 150));
  ['#f-status', '#f-cat', '#f-area', '#f-flag', '#f-sort'].forEach((s) => $(s).addEventListener('change', onF));
  el.onchange = (e) => {
    const cb = e.target.closest('[data-sel]');
    if (!cb) return;
    const id = Number(cb.dataset.sel);
    if (cb.checked) A.selected.add(id); else A.selected.delete(id);
    cb.closest('.row').classList.toggle('sel', cb.checked);
    drawBulk();
  };
  draw();
}

// تعديل نشاط
function editListing(id, preset = {}) {
  const r = id ? A.byId.get(id) : { name: '', category_id: null, phones: [], tags: [], status: 'approved', featured: false, verified: false, no_whatsapp: false, ...preset };
  if (!r) return;
  const phones = (r.phones && r.phones.length ? r.phones : ['']);
  const body = `<form class="form" id="edit-form" novalidate>
    <div class="form-grid two">
      <label class="field full"><span>الاسم <i>*</i></span><input class="input" name="name" required maxlength="160" value="${esc(r.name)}"></label>
      <label class="field"><span>التصنيف</span><select class="input" name="category_id"><option value="">بلا تصنيف</option>${A.cats.map((c) => `<option value="${c.id}"${r.category_id === c.id ? ' selected' : ''}>${esc(c.icon)} ${esc(c.name)}</option>`).join('')}</select></label>
      <label class="field"><span>الحالة</span><select class="input" name="status">${Object.entries(STATUS).map(([k, v]) => `<option value="${k}"${r.status === k ? ' selected' : ''}>${v}</option>`).join('')}</select></label>
      <div class="field full"><span>الأرقام <em>(الأول هو الأساسي)</em></span><div class="phones-edit" id="phones">${phones.map((p) => phoneInput(p)).join('')}</div>
        <button class="btn btn-ghost" type="button" id="add-phone" style="justify-self:start">${I('plus', 'sm')}رقم آخر</button></div>
      <label class="field"><span>رقم واتساب مختلف <em>(اختياري)</em></span><input class="input" name="whatsapp" dir="ltr" value="${esc(r.whatsapp || '')}" placeholder="تلقائياً: أول رقم جوال"></label>
      <label class="field"><span>الحي</span><select class="input" name="area"><option value="">—</option>${r.area && !A.areas.some((a) => a.name === r.area) ? `<option selected>${esc(r.area)}</option>` : ''}${A.areas.map((a) => `<option${r.area === a.name ? ' selected' : ''}>${esc(a.name)}</option>`).join('')}</select></label>
      <label class="field full"><span>العنوان</span><input class="input" name="address" maxlength="400" value="${esc(r.address || '')}"></label>
      <div class="field full"><span>رابط الخريطة</span><div style="display:flex;gap:8px"><input class="input" name="map_url" dir="ltr" maxlength="1200" value="${esc(r.map_url || '')}" style="flex:1"><button class="btn btn-soft" type="button" id="parse-map">استخراج الإحداثيات</button></div></div>
      <label class="field"><span>خط العرض</span><input class="input" name="lat" dir="ltr" inputmode="decimal" value="${r.lat ?? ''}"></label>
      <label class="field"><span>خط الطول</span><input class="input" name="lng" dir="ltr" inputmode="decimal" value="${r.lng ?? ''}"></label>
      <label class="field"><span>الموقع الإلكتروني</span><input class="input" name="website" dir="ltr" maxlength="300" value="${esc(r.website || '')}"></label>
      <label class="field"><span>وسوم <em>(مفصولة بفاصلة: تخصص، خدمات…)</em></span><input class="input" name="tags" value="${esc((r.tags || []).join('، '))}"></label>
      <label class="field full"><span>نبذة تظهر للزوار</span><textarea class="input" name="description" maxlength="600">${esc(r.description || '')}</textarea></label>
      <label class="field full"><span>ملاحظة إدارية <em>(لا تظهر للزوار)</em></span><textarea class="input" name="admin_note" style="min-height:64px">${esc(r.admin_note || '')}</textarea></label>
      <div class="toggles full">
        <label><input type="checkbox" name="featured" ${r.featured ? 'checked' : ''}>${I('star', 'sm')}مميّز</label>
        <label><input type="checkbox" name="verified" ${r.verified ? 'checked' : ''}>${I('verified', 'sm')}موثّق</label>
        <label><input type="checkbox" name="no_whatsapp" ${r.no_whatsapp ? 'checked' : ''}>لا يملك واتساب</label>
      </div>
      ${r.submitter_name || r.submitter_phone ? `<div class="warnbox full">${I('user', 'sm')}أرسله: ${esc(r.submitter_name || '')} <bdi dir="ltr">${esc(r.submitter_phone || '')}</bdi> · ${r.source === 'public' ? 'من الزوار' : esc(r.source)}</div>` : ''}
    </div>
    <div class="form-error" hidden></div>
    ${id ? `<details><summary class="muted" style="cursor:pointer">سجل التعديلات على هذا النشاط</summary><ul class="audit mt" id="audit"><li class="muted">جارٍ التحميل…</li></ul></details>` : ''}
    <div class="form-foot">
      <button class="btn btn-primary" type="submit">${I('check', 'sm')}حفظ</button>
      ${id ? `<a class="btn btn-soft" href="/?l=${id}" target="_blank">${I('eye', 'sm')}عرض</a><button class="btn btn-soft" type="button" id="merge-btn">${I('merge', 'sm')}دمج</button><button class="btn btn-danger" type="button" id="del-btn" aria-label="حذف">${I('trash', 'sm')}</button>` : ''}
    </div>
  </form>`;
  const sh = openSheet(id ? `تعديل: ${esc(r.name)}` : 'نشاط جديد', body);
  const form = sh.querySelector('#edit-form');
  sh.querySelector('#add-phone').onclick = () => sh.querySelector('#phones').insertAdjacentHTML('beforeend', phoneInput(''));
  sh.querySelector('#phones').onclick = (e) => { const b = e.target.closest('[data-rm]'); if (b) b.closest('.ph').remove(); };
  sh.querySelector('#parse-map').onclick = () => {
    const fe = form.elements;
    const src = fe.map_url.value || fe.address.value;
    const m = parseMap(src);
    if (m.lat === null) { toast('لم أجد إحداثيات في الرابط. الروابط المختصرة (goo.gl) لا تحتوي إحداثيات؛ افتحها وانسخ الرابط الكامل.', true); return; }
    fe.lat.value = m.lat.toFixed(6);
    fe.lng.value = m.lng.toFixed(6);
    if (!fe.name.value && m.name) fe.name.value = m.name;
    toast('تم استخراج الإحداثيات ✓');
  };
  if (id) {
    rest(`audit_log?listing_id=eq.${id}&order=created_at.desc&limit=30`).then((logs) => {
      const box = sh.querySelector('#audit');
      if (box) box.innerHTML = logs.length ? logs.map(auditItem).join('') : '<li class="muted">لا توجد تعديلات مسجلة.</li>';
    }).catch(() => {});
    sh.querySelector('#del-btn').onclick = async () => {
      if (!(await confirmBox(`حذف «${esc(r.name)}» نهائياً؟ يمكنك بدلاً من ذلك تغيير حالته إلى «مخفي».`, { ok: 'حذف نهائي', danger: true }))) return;
      try { await rest(`listings?id=eq.${id}`, { method: 'DELETE' }); removeLocal(id); closeSheet(); toast('تم الحذف'); refreshStats(); route(); } catch (err) { toast(errMsg(err), true); }
    };
    // F6: الدمج يفتح نافذة أخرى، فننبّه قبل ضياع التعديلات غير المحفوظة
    const snap = () => JSON.stringify([[...new FormData(form)], $$('.ph input', form).map((i) => i.value)]);
    const initial = snap();
    sh.querySelector('#merge-btn').onclick = async () => {
      if (snap() !== initial && !(await confirmBox('لديك تعديلات غير محفوظة ستُفقد عند الانتقال إلى الدمج. متابعة؟', { ok: 'متابعة' }))) return;
      mergeDialog(id);
    };
  }
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const err = form.querySelector('.form-error');
    const num = (v) => (v === '' || v === null || Number.isNaN(Number(v)) ? null : Number(v));
    const body = {
      name: fd.get('name').trim().replace(/\s+/g, ' '),
      category_id: Number(fd.get('category_id')) || null,
      status: fd.get('status'),
      phones: [...new Set($$('.ph input', form).map((i) => normalizePhone(i.value)).filter(Boolean))],
      whatsapp: normalizePhone(fd.get('whatsapp')) || null,
      area: fd.get('area') || null,
      address: fd.get('address').trim() || null,
      map_url: safeUrl(fd.get('map_url')) || null,
      lat: num(fd.get('lat')),
      lng: num(fd.get('lng')),
      website: safeUrl(fd.get('website')) || null,
      tags: fd.get('tags').split(/[،,]/).map((t) => t.trim()).filter(Boolean),
      description: fd.get('description').trim() || null,
      admin_note: fd.get('admin_note').trim() || null,
      featured: fd.has('featured'),
      verified: fd.has('verified'),
      no_whatsapp: fd.has('no_whatsapp'),
    };
    if (body.name.length < 2) { err.textContent = 'الاسم مطلوب.'; err.hidden = false; return; }
    if ((body.lat === null) !== (body.lng === null)) { err.textContent = 'أدخل خط العرض والطول معاً أو اتركهما فارغين.'; err.hidden = false; return; }
    const dup = A.listings.find((x) => x.id !== id && x.status !== 'rejected' && (x.phones || []).some((p) => body.phones.includes(p)));
    if (dup && !form.dataset.dupOk) {
      err.innerHTML = `تنبيه: الرقم مستخدم في «${esc(dup.name)}» (#${dup.id}). اضغط «حفظ» مرة أخرى للمتابعة، أو استخدم «دمج».`;
      err.hidden = false;
      form.dataset.dupOk = '1';
      return;
    }
    const btn = form.querySelector('[type=submit]');
    btn.disabled = true;
    try {
      const [row] = id
        ? await rest(`listings?id=eq.${id}`, { method: 'PATCH', body, headers: rep })
        : await rest('listings', { method: 'POST', body: { ...body, source: 'admin' }, headers: rep });
      upsertLocal(row);
      closeSheet();
      toast('تم الحفظ ✓');
      refreshStats();
      route();
    } catch (er) {
      btn.disabled = false;
      err.textContent = errMsg(er);
      err.hidden = false;
    }
  });
}

function phoneInput(p) {
  return `<div class="ph"><input class="input" dir="ltr" inputmode="tel" value="${esc(p)}" placeholder="09xxxxxxxx"><button class="icon-btn" type="button" data-rm aria-label="إزالة">${I('x', 'sm')}</button></div>`;
}

function auditVal(v) {
  if (v === null || v === undefined || v === '') return '—';
  if (Array.isArray(v)) return v.join('، ') || '—';
  if (typeof v === 'boolean') return v ? 'نعم' : 'لا';
  return String(v);
}
function auditItem(l) {
  const who = (A.admins.find((a) => a.user_id === l.user_id) || {}).email || 'النظام';
  const act = { create: 'أضاف', update: 'عدّل', delete: 'حذف', import: 'استورد' }[l.action] || l.action;
  let chg = '';
  if (l.action === 'update' && l.changes) {
    chg = Object.entries(l.changes).map(([k, [a, b]]) => {
      const lab = FIELD_LABEL[k] || k;
      if (k === 'category_id') return `${lab}: <del>${esc(catName(a))}</del> ← <ins>${esc(catName(b))}</ins>`;
      if (k === 'status') return `${lab}: <del>${STATUS[a] || a}</del> ← <ins>${STATUS[b] || b}</ins>`;
      return `${lab}: <del>${esc(auditVal(a))}</del> ← <ins>${esc(auditVal(b))}</ins>`;
    }).join('<br>');
  } else if (l.action === 'import' && l.changes) {
    chg = `${fmtNum(l.changes.count || 0)} نشاط`;
  }
  return `<li><div><b>${esc(who)}</b> ${act} ${l.listing_id ? `<a href="#" data-edit="${l.listing_id}" style="color:var(--brand);font-weight:700">${esc(l.listing_name || '#' + l.listing_id)}</a>` : esc(l.listing_name || '')}</div><div class="when">${fmtDate(l.created_at)}</div>${chg ? `<div class="chg">${chg}</div>` : ''}</li>`;
}

function mergeDialog(keepId) {
  const keep = A.byId.get(keepId);
  if (!keep) return;
  const sh = openSheet('دمج نشاط مكرر', `<p style="margin-top:0">سيُحتفظ بـ «<b>${esc(keep.name)}</b>» وتُنقل إليه الأرقام والمعلومات الناقصة من النشاط المكرر، ثم يُحذف المكرر.</p>
    <input class="input" id="m-q" placeholder="ابحث عن النشاط المكرر…" autocomplete="off"><div class="pick-list" id="m-list"></div>`);
  const draw = () => {
    const q = sh.querySelector('#m-q').value.trim();
    const cur = A.byId.get(keepId) || keep;
    const sameP = A.listings.filter((x) => x.id !== keepId && (x.phones || []).some((p) => (cur.phones || []).includes(p)));
    const res = q ? A.index.search(q).results.map((c) => c._row).filter((x) => x.id !== keepId).slice(0, 10) : sameP;
    sh.querySelector('#m-list').innerHTML = res.map((x) => `<button type="button" data-m="${x.id}">${esc(x.name)} <small>#${x.id} · ${esc(catName(x.category_id))} · ${(x.phones || []).join(' / ')}</small></button>`).join('') || '<p class="muted">اكتب للبحث.</p>';
  };
  sh.querySelector('#m-q').addEventListener('input', draw);
  draw();
  sh.querySelector('#m-list').onclick = async (e) => {
    const b = e.target.closest('[data-m]');
    if (!b) return;
    const drop = A.byId.get(Number(b.dataset.m));
    const keep = A.byId.get(keepId); // الصف الحالي، لا النسخة الملتقطة عند فتح النافذة
    if (!drop || !keep) { draw(); return; }
    if (!(await confirmBox(`دمج «${esc(drop.name)}» في «${esc(keep.name)}» ثم حذفه؟`, { ok: 'دمج' }))) return;
    try {
      const body = {
        phones: [...new Set([...(keep.phones || []), ...(drop.phones || [])])],
        area: keep.area || drop.area,
        address: keep.address || drop.address,
        map_url: keep.map_url || drop.map_url,
        lat: keep.lat ?? drop.lat,
        lng: keep.lng ?? drop.lng,
        website: keep.website || drop.website,
        description: keep.description || drop.description,
        tags: [...new Set([...(keep.tags || []), ...(drop.tags || [])])],
      };
      const [row] = await rest(`listings?id=eq.${keepId}`, { method: 'PATCH', body, headers: rep });
      await rest(`reports?listing_id=eq.${drop.id}`, { method: 'PATCH', body: { listing_id: keepId } });
      await rest(`listings?id=eq.${drop.id}`, { method: 'DELETE' });
      removeLocal(drop.id);
      upsertLocal(row);
      closeSheet();
      toast('تم الدمج ✓');
      route();
    } catch (err) { toast(errMsg(err), true); }
  };
}

// ─────────────── جودة البيانات ───────────────

function viewQuality(el) {
  const live = A.listings.filter((r) => r.status === 'approved' || r.status === 'pending');
  const byPhone = new Map();
  for (const r of live) for (const p of r.phones || []) { if (!byPhone.has(p)) byPhone.set(p, []); byPhone.get(p).push(r); }
  const dupPhones = [...byPhone.entries()].filter(([, rs]) => rs.length > 1);
  const byName = new Map();
  for (const r of live) { const k = `${normalize(r.name)}|${r.category_id}`; if (!byName.has(k)) byName.set(k, []); byName.get(k).push(r); }
  const dupNames = [...byName.values()].filter((rs) => rs.length > 1 && !dupPhones.some(([, d]) => d.every((x) => rs.includes(x))));
  const odd = live.filter((r) => (r.phones || []).some((p) => !/^0\d{9}$/.test(p)));
  const count = (fn) => live.filter(fn).length;
  const group = (rs, title) => `<div class="dup-group"><b>${title}</b><div class="rows">${rs.map((r) => listingRow(r, { select: false, ops: `<button class="btn btn-soft" data-edit="${r.id}">${I('edit', 'sm')}تعديل</button><button class="btn btn-soft" data-merge="${r.id}">${I('merge', 'sm')}دمج</button>` })).join('')}</div></div>`;
  el.innerHTML = `<div class="kpis">
      <button class="kpi" data-flag="nophone"><small>بلا رقم</small><b>${fmtNum(count((r) => !(r.phones || []).length))}</b></button>
      <button class="kpi" data-flag="noloc"><small>بلا موقع</small><b>${fmtNum(count((r) => !r.lat && !r.map_url))}</b></button>
      <button class="kpi" data-flag="noarea"><small>بلا حي</small><b>${fmtNum(count((r) => !r.area))}</b></button>
      <button class="kpi" data-flag="odd"><small>أرقام غير اعتيادية</small><b>${fmtNum(odd.length)}</b></button>
      <div class="kpi ${dupPhones.length ? 'warn' : ''}"><small>أرقام مكررة</small><b>${fmtNum(dupPhones.length)}</b></div>
      <div class="kpi"><small>أسماء مكررة</small><b>${fmtNum(dupNames.length)}</b></div>
    </div>
    <div class="panel"><h2>${I('merge')}أرقام مكررة بين أكثر من نشاط</h2>${dupPhones.length ? dupPhones.map(([p, rs]) => group(rs, `<bdi dir="ltr">${esc(formatPhone(p))}</bdi>`)).join('') : '<p class="muted">لا توجد أرقام مكررة 👌</p>'}</div>
    <div class="panel"><h2>${I('copy')}أسماء متطابقة في نفس التصنيف</h2>${dupNames.length ? dupNames.slice(0, 60).map((rs) => group(rs, esc(rs[0].name))).join('') : '<p class="muted">لا توجد أسماء مكررة 👌</p>'}</div>`;
  el.onclick = (e) => {
    const k = e.target.closest('[data-flag]');
    if (k) { A.f = { q: '', cat: '', status: 'approved', flag: k.dataset.flag, area: '', sort: 'new' }; location.hash = 'listings'; }
    const m = e.target.closest('[data-merge]');
    if (m) mergeDialog(Number(m.dataset.merge));
  };
}

// ─────────────── التصنيفات ───────────────

function viewCats(el) {
  const counts = new Map();
  for (const r of A.listings) counts.set(r.category_id, (counts.get(r.category_id) || 0) + 1);
  el.innerHTML = `<div class="panel" style="margin-top:0"><h2>${I('plus')}تصنيف جديد</h2>
      <form class="toolbar" id="cat-new" style="margin:0"><input class="input emoji-in" name="icon" value="📍" aria-label="الأيقونة"><input class="input grow" name="name" placeholder="اسم التصنيف" required><input class="input grow" name="keywords" placeholder="كلمات بحث إضافية (اختياري)"><button class="btn btn-primary">إضافة</button></form></div>
    <div class="panel"><h2>${I('grid')}التصنيفات (${fmtNum(A.cats.length)})</h2><p class="muted" style="margin:-6px 0 12px;font-size:13px">الكلمات المفتاحية تساعد البحث: من يكتب «دكتور» يجد «عيادات وأطباء». الترتيب الأصغر يظهر أولاً.</p>
    <div class="tbl-wrap"><table class="tbl"><thead><tr><th>أيقونة</th><th>الاسم</th><th>كلمات البحث</th><th>ترتيب</th><th>عدد</th><th></th></tr></thead><tbody>
    ${A.cats.map((c) => `<tr data-cid="${c.id}"><td><input class="input emoji-in" name="icon" value="${esc(c.icon)}"></td><td><input class="input" name="name" value="${esc(c.name)}" style="min-width:150px"></td>
      <td><input class="input" name="keywords" value="${esc(c.keywords)}" style="min-width:200px"></td><td><input class="input" name="sort" type="number" value="${c.sort}" style="width:80px"></td>
      <td><a href="#" data-cat-filter="${c.id}" style="color:var(--brand);font-weight:700">${fmtNum(counts.get(c.id) || 0)}</a></td>
      <td style="white-space:nowrap"><button class="btn btn-soft" data-save-cat="${c.id}">حفظ</button> <button class="icon-btn" data-del-cat="${c.id}" aria-label="حذف">${I('trash', 'sm')}</button></td></tr>`).join('')}
    </tbody></table></div></div>`;
  $('#cat-new').onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      const [c] = await rest('categories', { method: 'POST', body: { name: fd.get('name').trim(), icon: fd.get('icon').trim() || '📍', keywords: fd.get('keywords').trim(), sort: (A.cats.at(-1)?.sort || 0) + 10 }, headers: rep });
      A.cats.push(c);
      A.catById.set(c.id, c);
      toast('تمت الإضافة ✓');
      viewCats(el);
    } catch (err) { toast(errMsg(err), true); }
  };
  el.onclick = async (e) => {
    const sv = e.target.closest('[data-save-cat]');
    const dl = e.target.closest('[data-del-cat]');
    const cf = e.target.closest('[data-cat-filter]');
    if (cf) { e.preventDefault(); A.f = { q: '', cat: cf.dataset.catFilter, status: 'all', flag: '', area: '', sort: 'new' }; location.hash = 'listings'; return; }
    if (sv) {
      const tr = sv.closest('tr');
      const body = { icon: tr.querySelector('[name=icon]').value.trim() || '📍', name: tr.querySelector('[name=name]').value.trim(), keywords: tr.querySelector('[name=keywords]').value.trim(), sort: Number(tr.querySelector('[name=sort]').value) || 100 };
      try {
        const [c] = await rest(`categories?id=eq.${sv.dataset.saveCat}`, { method: 'PATCH', body, headers: rep });
        A.cats = A.cats.map((x) => (x.id === c.id ? c : x)).sort((a, b) => a.sort - b.sort);
        A.catById.set(c.id, c);
        indexListings();
        toast('تم الحفظ ✓');
      } catch (err) { toast(errMsg(err), true); }
    }
    if (dl) {
      const id = Number(dl.dataset.delCat);
      const n = counts.get(id) || 0;
      const other = A.cats.filter((c) => c.id !== id);
      const sh = openSheet('حذف تصنيف', `<p style="margin-top:0">${n ? `يحتوي هذا التصنيف على ${fmtNum(n)} نشاطاً. اختر تصنيفاً تُنقل إليه قبل الحذف:` : 'هل تريد حذف هذا التصنيف؟'}</p>
        ${n ? `<select class="input" id="move-to">${other.map((c) => `<option value="${c.id}">${esc(c.icon)} ${esc(c.name)}</option>`).join('')}</select>` : ''}
        <div style="display:flex;gap:8px;margin-top:16px"><button class="btn btn-danger" style="flex:1" id="do-del">حذف</button><button class="btn btn-soft" style="flex:1" data-close2>إلغاء</button></div>`, { wide: false });
      sh.querySelector('[data-close2]').onclick = closeSheet;
      sh.querySelector('#do-del').onclick = async () => {
        try {
          if (n) {
            const to = Number(sh.querySelector('#move-to').value);
            await rest(`listings?category_id=eq.${id}`, { method: 'PATCH', body: { category_id: to } });
            A.listings.forEach((r) => { if (r.category_id === id) r.category_id = to; });
          }
          await rest(`categories?id=eq.${id}`, { method: 'DELETE' });
          A.cats = A.cats.filter((c) => c.id !== id);
          A.catById.delete(id);
          indexListings();
          closeSheet();
          toast('تم الحذف');
          viewCats(el);
        } catch (err) { toast(errMsg(err), true); }
      };
    }
  };
}

// ─────────────── الأحياء ───────────────

function viewAreas(el) {
  const counts = new Map();
  for (const r of A.listings) if (r.area) counts.set(r.area, (counts.get(r.area) || 0) + 1);
  el.innerHTML = `<div class="panel" style="margin-top:0"><h2>${I('plus')}حي جديد</h2><form class="toolbar" id="area-new" style="margin:0"><input class="input grow" name="name" placeholder="اسم الحي" required><button class="btn btn-primary">إضافة</button></form></div>
    <div class="panel"><h2>${I('pin')}الأحياء (${fmtNum(A.areas.length)})</h2><div class="tbl-wrap"><table class="tbl"><thead><tr><th>الاسم</th><th>ترتيب</th><th>عدد</th><th></th></tr></thead><tbody>
    ${A.areas.map((a) => `<tr data-aid="${a.id}"><td><input class="input" name="name" value="${esc(a.name)}"></td><td><input class="input" name="sort" type="number" value="${a.sort}" style="width:80px"></td><td>${fmtNum(counts.get(a.name) || 0)}</td>
      <td style="white-space:nowrap"><button class="btn btn-soft" data-save-area="${a.id}">حفظ</button> <button class="icon-btn" data-del-area="${a.id}" aria-label="حذف">${I('trash', 'sm')}</button></td></tr>`).join('')}
    </tbody></table></div></div>`;
  $('#area-new').onsubmit = async (e) => {
    e.preventDefault();
    try {
      const [a] = await rest('areas', { method: 'POST', body: { name: new FormData(e.target).get('name').trim(), sort: (A.areas.at(-1)?.sort || 0) + 10 }, headers: rep });
      A.areas.push(a);
      toast('تمت الإضافة ✓');
      viewAreas(el);
    } catch (err) { toast(errMsg(err), true); }
  };
  el.onclick = async (e) => {
    const sv = e.target.closest('[data-save-area]');
    const dl = e.target.closest('[data-del-area]');
    try {
      if (sv) {
        const tr = sv.closest('tr');
        const old = A.areas.find((a) => a.id === Number(sv.dataset.saveArea));
        const name = tr.querySelector('[name=name]').value.trim();
        const [a] = await rest(`areas?id=eq.${old.id}`, { method: 'PATCH', body: { name, sort: Number(tr.querySelector('[name=sort]').value) || 100 }, headers: rep });
        if (old.name !== name) {
          await rest(`listings?area=eq.${encodeURIComponent(old.name)}`, { method: 'PATCH', body: { area: name } });
          A.listings.forEach((r) => { if (r.area === old.name) r.area = name; });
        }
        A.areas = A.areas.map((x) => (x.id === a.id ? a : x));
        indexListings();
        toast('تم الحفظ ✓');
      }
      if (dl) {
        const a = A.areas.find((x) => x.id === Number(dl.dataset.delArea));
        if (!(await confirmBox(`حذف حي «${esc(a.name)}»؟ ستبقى الأنشطة لكن بلا حي.`, { ok: 'حذف', danger: true }))) return;
        await rest(`listings?area=eq.${encodeURIComponent(a.name)}`, { method: 'PATCH', body: { area: null } });
        A.listings.forEach((r) => { if (r.area === a.name) r.area = null; });
        await rest(`areas?id=eq.${a.id}`, { method: 'DELETE' });
        A.areas = A.areas.filter((x) => x.id !== a.id);
        indexListings();
        toast('تم الحذف');
        viewAreas(el);
      }
    } catch (err) { toast(errMsg(err), true); }
  };
}

// ─────────────── الاستيراد والتصدير ───────────────

const CSV_COLS = [
  ['المعرف', (r) => r.id], ['الاسم', (r) => r.name], ['التصنيف', (r) => catName(r.category_id)], ['الأرقام', (r) => (r.phones || []).join(' / ')],
  ['الحي', (r) => r.area || ''], ['العنوان', (r) => r.address || ''], ['رابط الخريطة', (r) => r.map_url || ''], ['خط العرض', (r) => r.lat ?? ''], ['خط الطول', (r) => r.lng ?? ''],
  ['الموقع الإلكتروني', (r) => r.website || ''], ['نبذة', (r) => r.description || ''], ['وسوم', (r) => (r.tags || []).join('، ')], ['واتساب', (r) => r.whatsapp || ''],
  ['مميز', (r) => (r.featured ? 'نعم' : '')], ['موثق', (r) => (r.verified ? 'نعم' : '')], ['الحالة', (r) => r.status], ['تاريخ الإضافة', (r) => r.created_at.slice(0, 10)],
];

function toCsv(rows) {
  const q = (v) => {
    let s = String(v ?? '');
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return '﻿' + [CSV_COLS.map((c) => c[0]).join(','), ...rows.map((r) => CSV_COLS.map(([, f]) => q(f(r))).join(','))].join('\r\n');
}

function parseCsv(text) {
  text = text.replace(/^﻿/, '');
  const rows = [];
  let row = [];
  let cell = '';
  let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else inQ = false; } else cell += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some((c) => c.trim())) rows.push(row);
      row = [];
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((c) => c.trim())) rows.push(row);
  const head = rows.shift() || [];
  return rows.map((r) => Object.fromEntries(head.map((h, i) => [h.trim(), (r[i] || '').trim().replace(/^'(?=[=+\-@\t\r])/, '')])));
}

function download(name, content, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([content], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

function viewIO(el) {
  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
  el.innerHTML = `<div class="panel" style="margin-top:0"><h2>${I('download')}تصدير نسخة احتياطية</h2>
      <p class="muted" style="margin-top:0">احفظ نسخة من كل البيانات بشكل دوري. ملف CSV يفتح في Excel، وملف JSON نسخة كاملة دقيقة.</p>
      <div class="toolbar" style="margin:0"><button class="btn btn-primary" id="ex-csv">${I('download', 'sm')}تصدير CSV (${fmtNum(A.listings.length)})</button><button class="btn btn-soft" id="ex-csv-pub">CSV المنشور فقط</button><button class="btn btn-soft" id="ex-json">نسخة JSON كاملة</button></div></div>
    <div class="panel"><h2>${I('upload')}استيراد من ملف CSV</h2>
      <p class="muted" style="margin-top:0">يقبل ملف التصدير من هذه اللوحة، أو ملف النسخة الاحتياطية من الدليل القديم. الأنشطة التي لها «المعرف» نفسه تُحدَّث، والجديدة تُضاف.</p>
      <label class="drop" id="drop"><input type="file" accept=".csv,text/csv" id="file" hidden><b>اسحب الملف هنا أو اضغط للاختيار</b><br><span class="muted">CSV بترميز UTF-8</span></label>
      <div id="import-preview"></div></div>`;
  $('#ex-csv').onclick = () => download(`dalil-hama-${stamp}.csv`, toCsv(A.listings), 'text/csv;charset=utf-8');
  $('#ex-csv-pub').onclick = () => download(`dalil-hama-published-${stamp}.csv`, toCsv(A.listings.filter((r) => r.status === 'approved')), 'text/csv;charset=utf-8');
  $('#ex-json').onclick = () => download(`dalil-hama-${stamp}.json`, JSON.stringify({ exported_at: new Date().toISOString(), categories: A.cats, areas: A.areas, settings: A.settings, listings: A.listings }, null, 1), 'application/json');
  const drop = $('#drop');
  const handle = async (file) => {
    const rows = parseCsv(await file.text());
    const catByName = new Map(A.cats.map((c) => [normalize(c.name), c.id]));
    const other = A.cats.find((c) => c.name === 'أخرى');
    const mapped = rows.map((r) => {
      const old = 'الرقم' in r;
      const phones = [r['الأرقام'], r['الرقم'], r['جوال إضافي'], r['أرقام إضافية']].filter(Boolean).join('/').split(/[/،,;|]/).map(normalizePhone).filter(Boolean);
      const id = Number(r['المعرف']) || null;
      if (old && id && A.byId.has(id)) return null;
      const st0 = r['الحالة'];
      const o = {
        name: (r['الاسم'] || '').replace(/\s+/g, ' ').trim(),
        category_id: catByName.get(normalize(r['التصنيف'] || '')) || (other && other.id) || null,
        phones: [...new Set(phones)],
        ...('الحي' in r ? { area: r['الحي'] || null } : {}),
        address: r['العنوان'] || null,
        map_url: safeUrl(old ? r['الرابط'] : r['رابط الخريطة']) || null,
        website: safeUrl(old ? r['موقع إلكتروني'] : r['الموقع الإلكتروني']) || null,
        status: STATUS[st0] ? st0 : (Object.entries(STATUS).find(([, v]) => v === st0) || ['approved'])[0],
        source: 'import',
      };
      if (!old) {
        const la = Number(r['خط العرض']);
        const ln = Number(r['خط الطول']);
        if (la && ln) { o.lat = la; o.lng = ln; }
        o.description = r['نبذة'] || null;
        o.tags = (r['وسوم'] || '').split(/[،,]/).map((t) => t.trim()).filter(Boolean);
        o.whatsapp = normalizePhone(r['واتساب']) || null;
        o.featured = r['مميز'] === 'نعم';
        o.verified = r['موثق'] === 'نعم';
      } else {
        const m = parseMap(`${o.map_url || ''} ${o.address || ''}`);
        if (m.lat !== null) { o.lat = +m.lat.toFixed(6); o.lng = +m.lng.toFixed(6); }
      }
      if (id) o.id = id;
      if (old) o._old = true;
      if (!catByName.has(normalize(r['التصنيف'] || '')) && id && A.byId.has(id)) delete o.category_id;
      return o;
    }).filter((o) => o && o.name.length >= 2);
    const skipped = rows.filter((r) => 'الرقم' in r && A.byId.has(Number(r['المعرف']))).length;
    const updates = mapped.filter((o) => o.id && A.byId.has(o.id));
    const inserts = mapped.filter((o) => !(o.id && A.byId.has(o.id)));
    $('#import-preview').innerHTML = `<div class="warnbox mt">${I('info', 'sm')}الملف يحتوي ${fmtNum(mapped.length + skipped)} نشاطاً: ${fmtNum(updates.length)} للتحديث و${fmtNum(inserts.length)} جديد${skipped ? `، و${fmtNum(skipped)} موجود مسبقاً في الدليل سيُتجاهل (ملف الدليل القديم لا يُحدِّث البيانات المنظّفة)` : ''}.</div>
      <div class="toolbar mt"><button class="btn btn-primary" id="do-import">${I('upload', 'sm')}تنفيذ الاستيراد</button></div>`;
    $('#do-import').onclick = async (e) => {
      e.target.disabled = true;
      e.target.textContent = 'جارٍ الاستيراد…';
      try {
        const groups = new Map();
        for (const o of updates) {
          const k = Object.keys(o).sort().join(',');
          if (!groups.has(k)) groups.set(k, []);
          groups.get(k).push(o);
        }
        for (const batch of groups.values()) {
          for (let i = 0; i < batch.length; i += 400) {
            await rest('listings?on_conflict=id', { method: 'POST', body: batch.slice(i, i + 400), headers: { Prefer: 'resolution=merge-duplicates,return=minimal' } });
          }
        }
        const withId = inserts.filter((o) => o._old && o.id).map(({ _old, ...o }) => ({ tags: [], lat: null, lng: null, ...o }));
        const noId = inserts.filter((o) => !(o._old && o.id)).map(({ id, _old, ...o }) => ({ tags: [], lat: null, lng: null, ...o }));
        for (const fresh of [withId, noId]) {
          if (!fresh.length) continue;
          const keys = [...new Set(fresh.flatMap((o) => Object.keys(o)))];
          const norm = fresh.map((o) => Object.fromEntries(keys.map((k) => [k, o[k] ?? (k === 'tags' || k === 'phones' ? [] : (k === 'featured' || k === 'verified' ? false : null))])));
          for (let i = 0; i < norm.length; i += 400) {
            await rest('listings', { method: 'POST', body: norm.slice(i, i + 400), headers: { Prefer: 'return=minimal' } });
          }
        }
        toast('تم الاستيراد ✓');
        A.listings = await fetchAllListings();
        indexListings();
        refreshStats();
        viewIO(el);
      } catch (err) {
        toast(errMsg(err), true);
        e.target.disabled = false;
        e.target.textContent = 'تنفيذ الاستيراد';
      }
    };
  };
  const safeHandle = (file) => handle(file).catch((err) => toast(`تعذّرت قراءة الملف: ${errMsg(err)}`, true));
  $('#file').onchange = (e) => e.target.files[0] && safeHandle(e.target.files[0]);
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); if (e.dataTransfer.files[0]) safeHandle(e.dataTransfer.files[0]); });
}

// ─────────────── السجل ───────────────

async function viewLog(el) {
  el.innerHTML = '<p class="muted">جارٍ التحميل…</p>';
  try {
    const logs = await rest('audit_log?order=created_at.desc&limit=200');
    el.innerHTML = logs.length ? `<ul class="audit">${logs.map(auditItem).join('')}</ul>` : '<div class="empty"><p>لا توجد تعديلات بعد.</p></div>';
  } catch (err) { el.innerHTML = `<p class="form-error">${esc(errMsg(err))}</p>`; }
}

// ─────────────── الإعدادات ───────────────

function viewSettings(el) {
  const c = A.settings.contact || {};
  const an = A.settings.announcement || {};
  const em = A.settings.emergency || [];
  const owner = A.me.role === 'owner';
  el.innerHTML = `
    <div class="panel" style="margin-top:0"><h2>${I('megaphone')}إعلان أعلى الصفحة</h2>
      <form class="form" id="s-an"><div class="toggles"><label><input type="checkbox" name="active" ${an.active ? 'checked' : ''}>إظهار الإعلان</label></div>
        <label class="field"><span>نص الإعلان</span><textarea class="input" name="text" maxlength="300">${esc(an.text || '')}</textarea></label>
        <label class="field"><span>رابط <em>(اختياري)</em></span><input class="input" name="link" dir="ltr" value="${esc(an.link || '')}"></label>
        <button class="btn btn-primary" ${owner ? '' : 'disabled'}>حفظ</button></form></div>
    <div class="panel"><h2>${I('phone')}أرقام الطوارئ في الصفحة الرئيسية</h2>
      <form class="form" id="s-em"><div id="em-rows" class="form">${em.map((e) => emRow(e)).join('')}</div>
        <div class="toolbar"><button class="btn btn-ghost" type="button" id="em-add">${I('plus', 'sm')}رقم</button><button class="btn btn-primary" ${owner ? '' : 'disabled'}>حفظ</button></div></form></div>
    <div class="panel"><h2>${I('wa')}وسائل التواصل مع الدليل</h2>
      <form class="form-grid two" id="s-ct">
        <label class="field"><span>واتساب (دولي بدون +)</span><input class="input" name="whatsapp" dir="ltr" value="${esc(c.whatsapp || '')}"></label>
        <label class="field"><span>إنستغرام (اسم المستخدم)</span><input class="input" name="instagram" dir="ltr" value="${esc(c.instagram || '')}"></label>
        <label class="field full"><span>فيسبوك (رابط)</span><input class="input" name="facebook" dir="ltr" value="${esc(c.facebook || '')}"></label>
        <div class="full"><button class="btn btn-primary" ${owner ? '' : 'disabled'}>حفظ</button></div></form></div>
    <div class="panel"><h2>${I('user')}فريق الإدارة</h2>
      <ul class="rank">${A.admins.map((a) => `<li><span class="grow" dir="ltr" style="text-align:right">${esc(a.email)}</span><span class="st ${a.role === 'owner' ? 'approved' : 'hidden'}">${a.role === 'owner' ? 'مالك' : 'محرر'}</span>${owner && a.user_id !== A.me.user_id && a.email !== A.me.email ? `<button class="icon-btn" data-rm-admin="${a.user_id}" aria-label="إزالة">${I('trash', 'sm')}</button>` : ''}</li>`).join('')}</ul>
      ${owner ? `<form class="form-grid two mt" id="s-admin"><label class="field"><span>بريد المشرف الجديد</span><input class="input" name="email" type="email" dir="ltr" required></label>
        <label class="field"><span>كلمة مرور مؤقتة (10 أحرف على الأقل)</span><input class="input" name="password" dir="ltr" minlength="10" required></label>
        <label class="field"><span>الصلاحية</span><select class="input" name="role"><option value="editor">محرر (الأنشطة والبلاغات)</option><option value="owner">مالك (كل الصلاحيات)</option></select></label>
        <div class="field" style="align-self:end"><button class="btn btn-primary">${I('plus', 'sm')}إضافة مشرف</button></div></form>` : ''}</div>
    <div class="panel"><h2>${I('settings')}تغيير كلمة المرور</h2>
      <form class="form-grid two" id="s-pw"><label class="field"><span>كلمة المرور الجديدة</span><input class="input" name="password" type="password" dir="ltr" minlength="10" required autocomplete="new-password"></label>
        <div class="field" style="align-self:end"><button class="btn btn-primary">تحديث</button></div></form></div>`;
  const saveSetting = async (key, value) => {
    try {
      await rest('settings?on_conflict=key', { method: 'POST', body: { key, value, is_public: true }, headers: { Prefer: 'resolution=merge-duplicates,return=minimal' } });
      A.settings[key] = value;
      toast('تم الحفظ ✓ — يظهر للزوار خلال دقائق');
    } catch (err) { toast(errMsg(err), true); }
  };
  $('#s-an').onsubmit = (e) => { e.preventDefault(); const fd = new FormData(e.target); saveSetting('announcement', { active: fd.has('active'), text: fd.get('text').trim(), link: fd.get('link').trim() }); };
  $('#s-ct').onsubmit = (e) => { e.preventDefault(); const fd = new FormData(e.target); saveSetting('contact', { whatsapp: fd.get('whatsapp').replace(/\D/g, ''), instagram: fd.get('instagram').replace(/^@/, '').trim(), facebook: fd.get('facebook').trim() }); };
  $('#em-add').onclick = () => $('#em-rows').insertAdjacentHTML('beforeend', emRow({}));
  $('#em-rows').onclick = (e) => { const b = e.target.closest('[data-rm]'); if (b) b.closest('.ph').remove(); };
  $('#s-em').onsubmit = (e) => {
    e.preventDefault();
    const list = $$('#em-rows .ph').map((r) => ({ icon: r.querySelector('[name=icon]').value.trim(), name: r.querySelector('[name=name]').value.trim(), number: r.querySelector('[name=number]').value.trim() })).filter((x) => x.name && x.number);
    saveSetting('emergency', list);
  };
  if ($('#s-admin')) {
    $('#s-admin').onsubmit = async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      try {
        await rpc('admin_create_user', { p_email: fd.get('email'), p_password: fd.get('password'), p_role: fd.get('role') });
        A.admins = await rest('admins?select=*&order=created_at.asc');
        toast('تمت إضافة المشرف ✓ — أرسل له البريد وكلمة المرور');
        viewSettings(el);
      } catch (err) { toast(/weak/.test(err.message) ? 'كلمة المرور قصيرة' : errMsg(err), true); }
    };
  }
  el.onclick = async (e) => {
    const b = e.target.closest('[data-rm-admin]');
    if (!b) return;
    if (!(await confirmBox('إزالة صلاحية الإدارة من هذا الحساب؟', { ok: 'إزالة', danger: true }))) return;
    try {
      await rest(`admins?user_id=eq.${b.dataset.rmAdmin}`, { method: 'DELETE' });
      A.admins = A.admins.filter((a) => a.user_id !== b.dataset.rmAdmin);
      toast('تمت الإزالة');
      viewSettings(el);
    } catch (err) { toast(errMsg(err), true); }
  };
  $('#s-pw').onsubmit = async (e) => {
    e.preventDefault();
    try {
      await api('/auth/v1/user', { method: 'PUT', body: { password: new FormData(e.target).get('password') } });
      e.target.reset();
      toast('تم تغيير كلمة المرور ✓');
    } catch (err) { toast(errMsg(err), true); }
  };
}

function emRow(e) {
  return `<div class="ph" style="display:flex;gap:8px"><input class="input emoji-in" name="icon" value="${esc(e.icon || '☎️')}"><input class="input" name="name" placeholder="الاسم" value="${esc(e.name || '')}" style="flex:1"><input class="input" name="number" dir="ltr" placeholder="الرقم" value="${esc(e.number || '')}" style="width:130px"><button class="icon-btn" type="button" data-rm aria-label="إزالة">${I('x', 'sm')}</button></div>`;
}

// ─────────────── عام ───────────────

document.addEventListener('click', (e) => {
  const ed = e.target.closest('[data-edit]');
  if (ed && A.me) { e.preventDefault(); editListing(Number(ed.dataset.edit)); }
});

start();

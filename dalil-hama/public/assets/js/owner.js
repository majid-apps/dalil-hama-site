// دليل حماة — صفحة صاحب الرقم (/r/#رمز): «موافق، انشروا» أو «الرقم خطأ / لا أريد النشر» من رابط رسالة الموافقة (migration 0012).
// الرمز بعد # فلا يصل إلى سجلات الخادم، ولا يتغير شيء إلا بضغط زر.
import { rpc, esc, formatPhone } from './core.js';

const box = document.getElementById('box');
const readToken = () => decodeURIComponent(location.hash.slice(1)).replace(/^t=/, '').trim();
let token = readToken();
const ERR = {
  not_found: 'هذا الرابط غير صالح. تأكدوا أنكم فتحتم الرابط كاملاً كما وصل في رسالة واتساب.',
  expired: 'انتهت صلاحية هذا الرابط. راسلونا من قنوات التواصل في الدليل لنرسل رابطاً جديداً.',
  gone: 'هذا النشاط لم يعد في الدليل.',
  phone_gone: 'هذا الرقم لم يعد في بطاقة النشاط، فلا يلزم شيء.',
  rate: 'محاولات كثيرة خلال وقت قصير. حاولوا بعد قليل.',
  bad_action: 'تعذّر تنفيذ الطلب.',
};
let info = null;

const state = (big, title, text, extra = '') => {
  box.innerHTML = `<div class="o-state"><div class="o-big" aria-hidden="true">${big}</div><h2>${title}</h2><p>${text}</p>${extra}</div>`;
};
const fail = (code) => state('⚠️', 'تعذّر الإكمال', ERR[code] || 'تعذّر الاتصال. تحقق من الإنترنت وحاول مجدداً.',
  code ? '' : '<button class="btn btn-soft btn-lg" type="button" data-act="retry">إعادة المحاولة</button>');

function head() {
  return `<h1>طلب نشر في «دليل حماة»</h1>
    <p class="o-biz">${esc(info.name)}</p>${info.category ? `<p class="o-cat">${esc(info.category)}</p>` : ''}
    <bdi class="o-num" dir="ltr">${esc(formatPhone(info.phone))}</bdi>`;
}

function render() {
  if (info.action === 'reject') {
    state('✅', 'حُذف الرقم من الدليل', 'لن يُضاف هذا الرقم إلى الدليل مرة أخرى. نعتذر عن الإزعاج، وشكراً لكم 🌿');
    return;
  }
  if (info.action === 'approve') {
    state('🌿', 'شكراً لكم، تمت الموافقة', 'صار نشاطكم في «دليل حماة» ليصل إليه أهل المدينة بسهولة.',
      `<div class="o-acts"><a class="btn btn-primary btn-lg" href="/?l=${info.id}">عرض بطاقتكم في الدليل</a>
       <button class="btn btn-soft" type="button" data-act="ask-reject">إزالة رقمي من الدليل</button></div>
       <p class="o-note">تستطيعون إزالة رقمكم في أي وقت من هذا الرابط نفسه.</p>`);
    return;
  }
  box.innerHTML = `${head()}
    <p>هل توافقون على ظهور هذا النشاط ورقمه في «دليل حماة»، الدليل الإلكتروني المجاني لمدينة حماة؟ نعرض الاسم والتصنيف والرقم فقط.</p>
    <div class="o-acts">
      <button class="btn btn-primary btn-lg" type="button" data-act="approve">✅ موافق، انشروا</button>
      <button class="btn btn-soft btn-lg" type="button" data-act="ask-reject">✖ الرقم خطأ أو لا أريد النشر</button>
    </div>
    <p class="o-note">إن لم يكن هذا الرقم لكم فاختاروا «الرقم خطأ» فيُحذف فوراً. ولا يُنشر شيء دون موافقتكم.</p>`;
}

function askReject() {
  box.innerHTML = `${info.action === 'approve' ? '<h1>إزالة رقمي من الدليل</h1>' : head()}
    <div class="o-confirm"><p>سيُحذف الرقم <bdi dir="ltr">${esc(formatPhone(info.phone))}</bdi> من «دليل حماة» ولن يُضاف مرة أخرى. هل أنتم متأكدون؟</p>
      <div class="o-acts"><button class="btn o-danger btn-lg" type="button" data-act="reject">نعم، احذفوا الرقم</button>
      <button class="btn btn-soft" type="button" data-act="back">رجوع</button></div></div>`;
}

async function act(action, btn) {
  if (btn) btn.disabled = true;
  try {
    const r = await rpc('owner_action', { p_token: token, p_action: action });
    if (!r || !r.ok) { fail(r && r.error); return; }
    info.action = r.action;
    render();
  } catch {
    if (btn) btn.disabled = false;
    fail('');
  }
}

async function load() {
  if (!/^[A-Za-z0-9_-]{22}$/.test(token)) { fail('not_found'); return; }
  try {
    const r = await rpc('owner_link_info', { p_token: token });
    if (!r || !r.ok) { fail(r && r.error); return; }
    if (r.expired && !r.action) { fail('expired'); return; }
    if (!r.in_card && !r.action) { fail('phone_gone'); return; }
    info = r;
    render();
  } catch {
    fail('');
  }
}

box.addEventListener('click', (e) => {
  const b = e.target.closest('[data-act]');
  if (!b) return;
  const a = b.dataset.act;
  if (a === 'approve') act('approve', b);
  else if (a === 'ask-reject') askReject();
  else if (a === 'reject') act('reject', b);
  else if (a === 'back') render();
  else if (a === 'retry') load();
});
// رابط آخر في التبويب نفسه يغيّر ما بعد # فقط فلا تُعاد الصفحة: نقرأ الرمز الجديد
window.addEventListener('hashchange', () => { token = readToken(); info = null; box.innerHTML = '<p>جارٍ التحميل…</p>'; load(); });
load();

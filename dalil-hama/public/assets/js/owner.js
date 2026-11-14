// دليل حماة — صفحة صاحب الرقم (/r/#رمز): «موافق، انشروا» أو تعديل أو إبلاغ أو حذف رقمه وحده أو بطاقته كاملة (migrations 0012 و0014 و0019).
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
  removed: 'تم حذف هذه البطاقة سابقاً من الدليل.',
  name: 'الاسم قصير أو طويل جداً.',
  address: 'العنوان طويل جداً (300 حرف كحد أقصى).',
  description: 'النبذة طويلة جداً (600 حرف كحد أقصى).',
  phone: 'الرقم غير صالح.',
  phone_excluded: 'هذا الرقم مستبعد من الدليل ولا يمكن استعماله.',
  details: 'اكتبوا رسالة أوضح (5 أحرف على الأقل).',
};
let info = null;
let delMode = 'phone'; // phone: رقمه وحده (تبقى البطاقة إن بقي فيها رقم) | card: البطاقة كاملة

const state = (big, title, text, extra = '') => {
  box.innerHTML = `<div class="o-state"><div class="o-big" aria-hidden="true">${big}</div><h2>${title}</h2><p>${text}</p>${extra}</div>`;
};
const fail = (code) => state('⚠️', 'تعذّر الإكمال', ERR[code] || 'تعذّر الاتصال. تحقق من الإنترنت وحاول مجدداً.',
  code ? '' : '<button class="btn btn-soft btn-lg" type="button" data-act="retry">إعادة المحاولة</button>');

function head() {
  return `<h1>بطاقتكم في «دليل حماة»</h1>
    <p class="o-biz">${esc(info.name)}</p>${info.category ? `<p class="o-cat">${esc(info.category)}</p>` : ''}
    <bdi class="o-num" dir="ltr">${esc(formatPhone(info.phone))}</bdi>`;
}

const tools = () => `<div class="o-acts">
      <button class="btn btn-soft btn-lg" type="button" data-act="edit">✏️ تعديل البيانات</button>
      <button class="btn btn-soft btn-lg" type="button" data-act="report">🚩 إبلاغ برسالة</button>
      ${info.others > 0
    ? `<button class="btn btn-soft btn-lg" type="button" data-act="ask-reject-phone">🗑 الرقم خطأ — احذفوا هذا الرقم فقط</button>
      <button class="btn btn-soft btn-lg" type="button" data-act="ask-reject-card">🗑 حذف البطاقة كاملة</button>`
    : '<button class="btn btn-soft btn-lg" type="button" data-act="ask-reject-phone">🗑 الرقم خطأ / حذف البطاقة</button>'}</div>`;

function render() {
  if (info.action === 'reject') {
    if (info.card_live) state('✅', 'حُذف رقمكم من الدليل', `لن يُضاف هذا الرقم إلى الدليل مرة أخرى، وتبقى بطاقة «${esc(info.name)}» بأرقامها الأخرى. نعتذر عن الإزعاج، وشكراً لكم 🌿`);
    else state('✅', 'حُذفت البطاقة من الدليل', 'لن يُضاف هذا الرقم إلى الدليل مرة أخرى. نعتذر عن الإزعاج، وشكراً لكم 🌿');
    return;
  }
  const pending = !info.published && info.action !== 'approve';
  const thanks = info.action === 'approve' ? '<p class="o-note" style="margin:0 0 14px">🌿 شكراً لكم، تمت الموافقة وصار نشاطكم في الدليل. وتستطيعون تعديل بطاقتكم أو حذفها في أي وقت من هذا الرابط.</p>' : '';
  box.innerHTML = `${head()}${info.address ? `<p class="o-addr">📍 ${esc(info.address)}</p>` : ''}${thanks}
    ${pending
    ? `<p>هل توافقون على ظهور هذا النشاط ورقمه في «دليل حماة»، الدليل الإلكتروني المجاني لأهل المدينة؟ لا يُنشر شيء دون موافقتكم.</p>
       <div class="o-acts" style="margin-bottom:12px"><button class="btn btn-primary btn-lg" type="button" data-act="approve">✅ موافق، انشروا</button></div>
       <p class="o-note" style="margin:0 0 12px">وإن كان الرقم أو أي معلومة خاطئة فاختاروا من الأزرار التالية:</p>`
    : `<p>حصلنا على رقمكم باسم «${esc(info.name)}» من تطبيق «دليل حماة»، الدليل الإلكتروني المجاني لأهل المدينة. فإن كان الرقم أو أي معلومة خاطئة أو تغيّرت، فعدّلوها أو احذفوا الرقم أو أبلغونا برسالة.</p>`}
    ${tools()}
    ${info.published ? `<div class="o-acts" style="margin-top:10px"><a class="btn btn-soft" href="/?l=${info.id}">عرض البطاقة في الدليل</a></div>` : ''}`;
}

function askReject() {
  const card = delMode === 'card' || !(info.others > 0);
  const num = `<bdi dir="ltr">${esc(formatPhone(info.phone))}</bdi>`;
  box.innerHTML = `${info.action === 'approve' || info.published ? '<h1>حذف من الدليل</h1>' : head()}
    <div class="o-confirm"><p>${delMode === 'card' && info.others > 0
    ? `ستُحذف بطاقة «${esc(info.name)}» بكل أرقامها ولن يُضاف الرقم ${num} مرة أخرى. هل أنتم متأكدون؟`
    : card
      ? `سيُحذف الرقم ${num} من «دليل حماة» ولن يُضاف مرة أخرى${info.published ? '، وبما أنه رقمها الوحيد ستُحذف البطاقة' : ''}. هل أنتم متأكدون؟`
      : `سيُحذف الرقم ${num} وحده من بطاقة «${esc(info.name)}» ولن يُضاف مرة أخرى، وتبقى بقية أرقامها. هل أنتم متأكدون؟`}</p>
      <div class="o-acts"><button class="btn o-danger btn-lg" type="button" data-act="reject">${delMode === 'card' && info.others > 0 ? 'نعم، احذفوا البطاقة' : 'نعم، احذفوا الرقم'}</button>
      <button class="btn btn-soft" type="button" data-act="back">رجوع</button></div></div>`;
}

function editForm() {
  box.innerHTML = `<h1>تعديل البيانات</h1>
    <form class="o-form" id="o-edit" novalidate>
      <label>اسم النشاط<input class="input" name="name" maxlength="160" value="${esc(info.name)}" required></label>
      <label>الرقم<input class="input" name="phone" inputmode="tel" dir="ltr" maxlength="20" value="${esc(info.phone)}"></label>
      <label>العنوان<input class="input" name="address" maxlength="300" value="${esc(info.address || '')}" placeholder="الحي، الشارع، بجانب…"></label>
      <label>نبذة قصيرة <em>(اختياري)</em><textarea class="input" name="description" maxlength="600" rows="3">${esc(info.description || '')}</textarea></label>
      <div class="o-acts"><button class="btn btn-primary btn-lg" type="submit">حفظ التعديل</button>
      <button class="btn btn-soft" type="button" data-act="back">رجوع</button></div>
    </form>`;
}

function reportForm() {
  box.innerHTML = `<h1>إبلاغ برسالة</h1>
    <p>اكتبوا لنا ما تريدون تصحيحه أو إضافته، وسنراجعه ونتواصل معكم عند الحاجة.</p>
    <form class="o-form" id="o-report" novalidate>
      <label>رسالتكم<textarea class="input" name="text" maxlength="1000" rows="5" required placeholder="مثال: الرقم الصحيح هو… / النشاط تغيّر عنوانه إلى…"></textarea></label>
      <div class="o-acts"><button class="btn btn-primary btn-lg" type="submit">إرسال</button>
      <button class="btn btn-soft" type="button" data-act="back">رجوع</button></div>
    </form>`;
}

async function act(action, btn) {
  if (btn) btn.disabled = true;
  try {
    const r = action === 'reject' ? await rpc('owner_delete', { p_token: token, p_card: delMode === 'card' }) : await rpc('owner_action', { p_token: token, p_action: action });
    if (!r || !r.ok) { fail(r && r.error); return; }
    info.action = r.action;
    if (r.card_live !== undefined) info.card_live = r.card_live;
    if (r.action === 'approve') info.published = true;
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
  else if (a === 'ask-reject-phone') { delMode = 'phone'; askReject(); }
  else if (a === 'ask-reject-card') { delMode = 'card'; askReject(); }
  else if (a === 'reject') act('reject', b);
  else if (a === 'back') render();
  else if (a === 'edit') editForm();
  else if (a === 'report') reportForm();
  else if (a === 'retry') load();
});
box.addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const btn = f.querySelector('[type=submit]');
  btn.disabled = true;
  try {
    if (f.id === 'o-edit') {
      const fd = new FormData(f);
      const r = await rpc('owner_edit', { p_token: token, p_name: fd.get('name'), p_phone: fd.get('phone'), p_address: fd.get('address'), p_description: fd.get('description') });
      if (!r || !r.ok) { btn.disabled = false; alert(ERR[r && r.error] || 'تعذّر الحفظ، حاولوا مجدداً.'); return; }
      info.name = String(fd.get('name')).trim() || info.name;
      info.phone = r.phone || info.phone;
      info.address = String(fd.get('address')).trim();
      info.description = String(fd.get('description')).trim();
      state('✅', 'تم حفظ التعديل', 'شكراً لكم، حُدّثت بطاقتكم في «دليل حماة».', '<div class="o-acts"><button class="btn btn-soft btn-lg" type="button" data-act="back">رجوع</button></div>');
    } else if (f.id === 'o-report') {
      const r = await rpc('owner_report', { p_token: token, p_text: new FormData(f).get('text') });
      if (!r || !r.ok) { btn.disabled = false; alert(ERR[r && r.error] || 'تعذّر الإرسال، حاولوا مجدداً.'); return; }
      state('📨', 'وصلتنا رسالتكم', 'شكراً لكم، سنراجعها بأقرب وقت.', '<div class="o-acts"><button class="btn btn-soft btn-lg" type="button" data-act="back">رجوع</button></div>');
    }
  } catch { btn.disabled = false; alert('تعذّر الاتصال. تحقق من الإنترنت وحاول مجدداً.'); }
});
// رابط آخر في التبويب نفسه يغيّر ما بعد # فقط فلا تُعاد الصفحة: نقرأ الرمز الجديد
window.addEventListener('hashchange', () => { token = readToken(); info = null; box.innerHTML = '<p>جارٍ التحميل…</p>'; load(); });
load();

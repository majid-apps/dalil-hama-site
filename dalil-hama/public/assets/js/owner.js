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
  removed: 'تم حذف هذه البطاقة سابقاً من الدليل.',
  name: 'الاسم قصير أو طويل جداً.',
  address: 'العنوان طويل جداً (300 حرف كحد أقصى).',
  description: 'النبذة طويلة جداً (600 حرف كحد أقصى).',
  phone: 'الرقم غير صالح.',
  phone_excluded: 'هذا الرقم مستبعد من الدليل ولا يمكن استعماله.',
  details: 'اكتبوا رسالة أوضح (5 أحرف على الأقل).',
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

const tools = (approve) => `<div class="o-acts">
      ${approve ? '<button class="btn btn-primary btn-lg" type="button" data-act="approve">✅ موافق، انشروا</button>' : ''}
      <button class="btn btn-soft btn-lg" type="button" data-act="edit">✏️ تعديل البيانات</button>
      <button class="btn btn-soft btn-lg" type="button" data-act="report">🚩 إبلاغ برسالة</button>
      <button class="btn btn-soft btn-lg" type="button" data-act="ask-reject">🗑 حذف البطاقة</button></div>`;

function render() {
  if (info.action === 'reject') {
    state('✅', 'حُذفت البطاقة من الدليل', 'لن يُضاف هذا الرقم إلى الدليل مرة أخرى. نعتذر عن الإزعاج، وشكراً لكم 🌿');
    return;
  }
  if (info.action === 'approve') {
    box.innerHTML = `${head()}${info.address ? `<p class="o-addr">📍 ${esc(info.address)}</p>` : ''}
      <p>شكراً لكم، نشاطكم ظاهر في «دليل حماة». يمكنكم تعديل بياناته أو إبلاغنا أو حذفه في أي وقت من هذا الرابط.</p>
      ${tools(false)}
      <div class="o-acts" style="margin-top:10px"><a class="btn btn-soft" href="/?l=${info.id}">عرض بطاقتكم في الدليل</a></div>`;
    return;
  }
  box.innerHTML = `${head()}${info.address ? `<p class="o-addr">📍 ${esc(info.address)}</p>` : ''}
    <p>حصلنا على رقمكم باسم «${esc(info.name)}» من تطبيق «دليل حماة»، الدليل الإلكتروني المجاني لمدينة حماة، ونعرض الاسم والتصنيف والرقم والعنوان فقط.</p>
    ${tools(true)}
    <p class="o-note">إن كان الرقم أو أي معلومة خاطئة فعدّلوها أو احذفوها أو أبلغونا بما يلزم. ولا يُنشر شيء دون موافقتكم.</p>`;
}

function askReject() {
  box.innerHTML = `${info.action === 'approve' || info.published ? '<h1>حذف البطاقة من الدليل</h1>' : head()}
    <div class="o-confirm"><p>ستُحذف بطاقة «${esc(info.name)}» والرقم <bdi dir="ltr">${esc(formatPhone(info.phone))}</bdi> من «دليل حماة» ولن يُضاف مرة أخرى. هل أنتم متأكدون؟</p>
      <div class="o-acts"><button class="btn o-danger btn-lg" type="button" data-act="reject">نعم، احذفوا البطاقة</button>
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
    const r = action === 'reject' ? await rpc('owner_delete', { p_token: token }) : await rpc('owner_action', { p_token: token, p_action: action });
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

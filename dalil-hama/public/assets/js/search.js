// محرك البحث: يعمل بالكامل داخل المتصفح على كل البيانات، فالنتائج فورية مع كل حرف.
import { normalize, normalizeMap, esc, toLatinDigits } from './core.js';

const STOP = new Set(['في', 'من', 'على', 'عن', 'الى', 'قرب', 'جانب', 'مقابل', 'حي', 'و', 'ب', 'مدينه', 'حماه', 'رقم', 'هاتف', 'تلفون']);
const PREFIXES = ['وال', 'بال', 'فال', 'كال', 'لل', 'ال'];
// كلمات تصف مكاناً لا نوع نشاط: «سوق الحدادين» يبحث عن المحلات الواقعة فيه
const PLACE = new Set(['سوق', 'شارع', 'دوار', 'ساحه', 'طريق', 'جسر', 'باب', 'مدخل']);

/** تجذيع خفيف: إزالة «ال» وأدوات الجر الملتصقة وبعض اللواحق الشائعة */
export function stem(t) {
  if (t.length > 4) {
    for (const p of PREFIXES) {
      if (t.startsWith(p) && t.length - p.length >= 3) { t = t.slice(p.length); break; }
    }
  }
  if (t.length > 4 && (t.endsWith('ات') || t.endsWith('ون') || t.endsWith('ين'))) t = t.slice(0, -2);
  else if (t.length > 3 && t.endsWith('ه')) t = t.slice(0, -1);
  return t;
}

const tokens = (s) => normalize(s).split(' ').filter(Boolean);

// كلمات عامية/مرادفات إضافية ← كلمة موجودة في كلمات التصنيفات المفتاحية
const SYNONYMS = {
  دكتور: 'طبيب', دكتوره: 'طبيب', حكيم: 'طبيب', عياده: 'طبيب', مشفي: 'مشفى', مستشفي: 'مشفى', اسعاف: 'مشفى',
  فرن: 'مخبز', خبز: 'مخبز', كاتو: 'حلويات', بوظه: 'حلويات', قهوه: 'مقهى', كوفي: 'مقهى', كافتيريا: 'مطعم',
  حلاق: 'حلاق', كوافيره: 'كوافير', صالون: 'حلاق', تكسي: 'تكسي', سرفيس: 'نقل', جوال: 'موبايل', خلوي: 'موبايل',
  تلفون: 'موبايل', لابتوب: 'كمبيوتر', محامي: 'محامي', مهندس: 'مهندس', سمان: 'بقاليه', بقال: 'بقاليه', ماركت: 'بقاليه',
  جامع: 'مسجد', صراف: 'صرافه', حواله: 'حوالات', بنزين: 'محروقات', كازيه: 'محروقات', فندق: 'فندق', صيدلاني: 'صيدليه',
  ميكانيكي: 'ميكانيك', تاكسي: 'تكسي', دكاتر: 'طبيب', اطباء: 'طبيب', اركيله: 'مقهى', اراكيل: 'مقهى',
};

/** المرادف للكلمة كما كُتبت أو بعد التجذيع («السمان»، «سمانة»، «الكازية»...) */
function synonym(t) {
  const st = stem(t);
  return SYNONYMS[t] || SYNONYMS[st] || SYNONYMS[st + 'ه'];
}

export class SearchIndex {
  constructor() {
    this.items = [];
    this.cats = new Map();
    this.catTokens = [];
    this.areaNames = [];
  }

  setData(items, cats, areas) {
    this.cats = new Map(cats.map((c) => [c.i, c]));
    this.catTokens = cats.map((c) => ({
      id: c.i,
      // «عيادات وأطباء»: تُفهرس «أطباء» أيضاً من دون واو العطف
      stems: [...new Set([
        ...tokens(c.n).flatMap((t, j) => (j && t.length > 3 && t[0] === 'و' ? [t, t.slice(1)] : [t])),
        ...tokens(c.k || ''),
      ].map(stem))],
    }));
    this.areaNames = areas.map((a) => ({ name: a.n, norm: normalize(a.n), stems: tokens(a.n).map(stem) }));
    for (const it of items) this.prepare(it);
    this.items = items;
  }

  prepare(it) {
    const cat = this.cats.get(it.c);
    const nm = normalize(it.n);
    it._nn = nm;
    it._tok = nm.split(' ').map(stem);
    it._hay = normalize([cat?.n, (it.t || []).join(' '), it.a, it.d, it.e].filter(Boolean).join(' '));
    it._ext = it._hay.split(' ').map(stem);
    it._dig = (it.p || []).map((p) => p.replace(/\D/g, '')).join(' ');
    it._hasPhone = !!(it.p && it.p.length);
    it._pop = it.k ? Math.min(4, Math.log2(1 + it.k)) : 0;
  }

  /** يعيد { results, cats: [تصنيفات مطابقة], fuzzy: bool } */
  search(query, { cat = null, area = null } = {}) {
    const q = toLatinDigits(query || '').trim();
    let pool = this.items;
    if (cat) pool = pool.filter((it) => it.c === cat);
    if (area) pool = pool.filter((it) => it.a === area);
    if (!q) return { results: pool, cats: [], fuzzy: false, terms: [] };

    // البحث برقم الهاتف
    const digits = q.replace(/[\s\-+()]/g, '');
    if (/^\d{3,}$/.test(digits)) {
      let d = digits.replace(/^00963|^963/, '').replace(/^0+/, '').replace(/^33(\d{7})$/, '13$1');
      if (!d) d = digits;
      const results = pool.filter((it) => it._dig.includes(d));
      return { results, cats: [], fuzzy: false, terms: [], phone: true };
    }

    const raw = tokens(q).filter((t) => !STOP.has(t));
    const terms = (raw.length ? raw : tokens(q)).slice(0, 6);
    const stems = terms.map((t) => { const syn = synonym(t); return stem(syn ? normalize(syn) : t); });
    const origStems = terms.map(stem);

    // التصنيفات والأحياء المطابقة لكل كلمة
    const catHits = stems.map((s, i) => {
      const set = new Set();
      const variants = new Set([s, origStems[i]]);
      for (const ct of this.catTokens) {
        for (const v of variants) {
          if (v.length < 2) continue;
          if (ct.stems.some((x) => x === v || (v.length >= 3 && x.startsWith(v)))) set.add(ct.id);
        }
      }
      return set;
    });
    const areaHits = origStems.map((s) => new Set(
      this.areaNames.filter((a) => s.length >= 3 && a.stems.some((x) => x.startsWith(s))).map((a) => a.name),
    ));

    const qn = normalize(q);
    const placeQuery = qn.includes(' ') && PLACE.has(terms[0]);
    const scored = [];
    for (const it of pool) {
      let total = 0;
      let ok = true;
      // الاسم يبدأ بالعبارة كاملة («جامعة حماة»): مقصود بعينه
      const fullName = it._nn === qn || (qn.includes(' ') && it._nn.startsWith(qn + ' '));
      // «سوق الحدادين»… بالعبارة كاملة في العنوان: بحث عن مكان لا عن تصنيف
      const phrase = placeQuery && it._hay.includes(qn);
      for (let i = 0; i < stems.length; i++) {
        const s = origStems[i];
        let sc = 0;
        for (const tk of it._tok) {
          if (tk === s) { sc = Math.max(sc, 12); break; }
          if ((s.length >= 2 || stems.length === 1) && tk.startsWith(s)) sc = Math.max(sc, 8);
        }
        if (!sc && s.length >= 3 && it._nn.includes(s)) sc = 5;
        if (catHits[i].has(it.c)) sc = sc ? sc + 4 : 8;
        // الكلمة تدل على تصنيف والنشاط من تصنيف آخر: تطابق الاسم عَرَضي («دكتور بطاطا» ليس طبيباً)
        else if (sc && catHits[i].size && !fullName) sc = Math.min(sc, 7);
        if (!sc && areaHits[i].has(it.a)) sc = 5;
        // كلمة تدل على تصنيف لا تكفيها مطابقة العنوان («مقابل صيدلية...» ليس صيدلية)
        if (!sc && (phrase || !catHits[i].size) && s.length >= 2 && it._ext.some((x) => x.startsWith(s))) sc = 3;
        if (!sc) { ok = false; break; }
        total += sc;
      }
      if (!ok) continue;
      if (it._tok[0] === origStems[0]) total += 3;
      if (fullName) total += 8;
      if (it._hasPhone) total += 2;
      if (it.f) total += 4;
      if (it.v) total += 1;
      total += it._pop;
      scored.push([total, it]);
    }

    let fuzzy = false;
    const fuzzyCat = [];
    if (!scored.length) {
      fuzzy = true;
      // فقط لكلمة لم تطابق تصنيفاً ولا حياً («كازو» حي، وليست خطأً في «كاتو»)
      origStems.forEach((s, i) => {
        fuzzyCat.push(s.length >= 4 && !catHits[i].size && !areaHits[i].size
          ? new Set(this.catTokens.filter((ct) => ct.stems.some((x) => x.length >= 4 && near(x, s))).map((ct) => ct.id))
          : new Set());
      });
      for (const it of pool) {
        let total = 0;
        for (let i = 0; i < origStems.length; i++) {
          const s = origStems[i];
          if (s.length < 3) continue;
          if (catHits[i].has(it.c) || fuzzyCat[i].has(it.c)) total += 8;
          else if (it._tok.some((tk) => tk.startsWith(s))) total += catHits[i].size || fuzzyCat[i].size ? 3 : 6;
          else if (areaHits[i].has(it.a)) total += 4;
          else if (s.length >= 5 && it._tok.some((tk) => near(tk, s))) total += 3;
          else if (it._ext.some((x) => x.startsWith(s))) total += 1;
        }
        if (total) scored.push([total + (it._hasPhone ? 1 : 0) + it._pop, it]);
      }
    }

    scored.sort((a, b) => b[0] - a[0] || a[1].n.localeCompare(b[1].n, 'ar'));
    const cats = [...new Set([...catHits, ...fuzzyCat].flatMap((s) => [...s]))].slice(0, 4);
    return { results: scored.map((x) => x[1]), cats, fuzzy, terms: origStems };
  }
}

/** تشابه تقريبي: فرق حرف واحد (حذف/إضافة/استبدال) على بداية الكلمة */
function near(word, q) {
  const w = word.slice(0, q.length + 1);
  if (Math.abs(w.length - q.length) > 1) return false;
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < w.length && j < q.length) {
    if (w[i] === q[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (w.length > q.length) i++;
    else if (w.length < q.length) j++;
    else { i++; j++; }
  }
  return edits + (q.length - j) <= 1;
}

/** تمييز الكلمات المطابقة في الاسم */
export function highlight(text, terms) {
  if (!terms || !terms.length) return esc(text);
  const { text: n, map } = normalizeMap(text);
  const ranges = [];
  const words = [];
  let pos = 0;
  for (const w of n.split(' ')) {
    words.push([pos, w]);
    pos += w.length + 1;
  }
  for (const [start, w] of words) {
    for (const t of terms) {
      if (t.length < 2) continue;
      let idx = w.indexOf(t);
      if (idx === -1) continue;
      if (idx > 3) continue;
      ranges.push([start + idx, start + idx + t.length]);
      break;
    }
  }
  if (!ranges.length) return esc(text);
  let out = '';
  let last = 0;
  for (const [a, b] of ranges) {
    const oa = map[a];
    const ob = b < map.length ? map[b] : map[b - 1] + 1;
    if (oa < last) continue;
    out += esc(text.slice(last, oa)) + '<mark>' + esc(text.slice(oa, ob)) + '</mark>';
    last = ob;
  }
  return out + esc(text.slice(last));
}

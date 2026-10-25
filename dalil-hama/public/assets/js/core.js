// أدوات مشتركة بين الواجهة العامة ولوحة الإدارة
import { SUPABASE_URL, SUPABASE_KEY } from './config.js';

// ─────────────── الاتصال بقاعدة البيانات ───────────────

export class ApiError extends Error {
  constructor(message, status, body) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

export async function request(path, { method = 'GET', body, token, headers = {}, keepalive = false, signal } = {}) {
  const h = { apikey: SUPABASE_KEY, ...headers };
  if (body !== undefined) h['Content-Type'] = 'application/json';
  if (token) h.Authorization = `Bearer ${token}`;
  const res = await fetch(SUPABASE_URL + path, {
    method,
    headers: h,
    body: body === undefined ? undefined : JSON.stringify(body),
    keepalive,
    signal,
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) {
    const msg = (data && (data.message || data.msg || data.error_description || data.error)) || `HTTP ${res.status}`;
    throw new ApiError(msg, res.status, data);
  }
  return data;
}

export const rpc = (name, args = {}, opts = {}) =>
  request(`/rest/v1/rpc/${name}`, { method: 'POST', body: args, ...opts });

// ─────────────── تطبيع النص العربي ───────────────

const DIGIT_MAP = { '٠': '0', '١': '1', '٢': '2', '٣': '3', '٤': '4', '٥': '5', '٦': '6', '٧': '7', '٨': '8', '٩': '9',
  '۰': '0', '۱': '1', '۲': '2', '۳': '3', '۴': '4', '۵': '5', '۶': '6', '۷': '7', '۸': '8', '۹': '9' };
const CHAR_MAP = { 'أ': 'ا', 'إ': 'ا', 'آ': 'ا', 'ٱ': 'ا', 'ة': 'ه', 'ى': 'ي', 'ؤ': 'و', 'ئ': 'ي', ...DIGIT_MAP };
const DROP = /[ً-ْٰـ‌-‏‪-‮⁦-⁩﻿]/;
const WORD = /[\p{L}\p{N}+]/u;

/** تطبيع حرف بحرف مع خريطة المواقع الأصلية (لتمييز الكلمات المطابقة). */
export function normalizeMap(input) {
  const s = String(input || '');
  let out = '';
  const map = [];
  let lastSpace = true;
  for (let i = 0; i < s.length; i++) {
    let ch = s[i];
    if (DROP.test(ch)) continue;
    ch = CHAR_MAP[ch] || ch.toLowerCase();
    if (!WORD.test(ch)) {
      if (lastSpace) continue;
      ch = ' ';
      lastSpace = true;
    } else {
      lastSpace = false;
    }
    out += ch;
    map.push(i);
  }
  if (out.endsWith(' ')) { out = out.slice(0, -1); map.pop(); }
  return { text: out, map };
}

export const normalize = (s) => normalizeMap(s).text;

export function toLatinDigits(s) {
  return String(s || '').replace(/[٠-٩۰-۹]/g, (d) => DIGIT_MAP[d]);
}

// ─────────────── الأرقام ───────────────

/** توحيد الرقم إلى الصيغة المحلية: 09xxxxxxxx / 0132xxxxxx (نفس منطق قاعدة البيانات). */
export function normalizePhone(p) {
  const raw = toLatinDigits(p).trim();
  if (!raw) return '';
  const intl = /^\s*(\+|00)/.test(raw);
  let d = raw.replace(/\D/g, '');
  if (!d) return '';
  if (d.startsWith('00963')) d = d.slice(5);
  else if (d.startsWith('963') && d.length >= 11) d = d.slice(3);
  else if (intl && !/^0*1/.test(d)) return '+' + d.replace(/^00/, '');
  d = d.replace(/^0+/, '');
  if (/^33\d{7}$/.test(d)) d = '13' + d.slice(2); // رمز حماة القديم 033 صار 013
  if (d.length >= 8) return '0' + d;
  if (/^2\d{6}$/.test(d)) return '013' + d;
  return raw.replace(/\D/g, '');
}

export const isMobile = (p) => /^09\d{8}$/.test(p);

/** الرقم الدولي بلا + (لروابط واتساب). */
export function intlNumber(p) {
  if (!p) return '';
  if (p.startsWith('+')) return p.slice(1);
  if (p.startsWith('0')) return '963' + p.slice(1);
  return p;
}

/** عرض الرقم بشكل مقروء: 0945 579 994 */
export function formatPhone(p) {
  if (!p) return '';
  if (/^09\d{8}$/.test(p)) return `${p.slice(0, 4)} ${p.slice(4, 7)} ${p.slice(7)}`;
  if (/^0\d{9}$/.test(p)) return `${p.slice(0, 3)} ${p.slice(3, 6)} ${p.slice(6)}`;
  return p;
}

export const telHref = (p) => `tel:${p}`;
export const waHref = (p, text = '') =>
  `https://wa.me/${intlNumber(p)}${text ? `?text=${encodeURIComponent(text)}` : ''}`;

// ─────────────── أدوات عامة ───────────────

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

export const fmtNum = (n) => new Intl.NumberFormat('ar-SY').format(n);

export function debounce(fn, ms) {
  let t;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
}

export const store = {
  get(key, fallback = null) {
    try {
      const v = localStorage.getItem(key);
      return v === null ? fallback : JSON.parse(v);
    } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; }
  },
  del(key) {
    try { localStorage.removeItem(key); } catch { /* ignore */ }
  },
};

/** المسافة بالمتر بين نقطتين */
export function distance(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = (x) => (x * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

export function fmtDistance(m) {
  if (m < 1000) return `${fmtNum(Math.max(10, Math.round(m / 10) * 10))} م`;
  return `${fmtNum(Math.round(m / 100) / 10)} كم`;
}

/** رابط آمن: http(s) فقط، ويُضاف https:// للروابط المكتوبة بلا بروتوكول (facebook.com/...) */
export function safeUrl(u) {
  const v = String(u || '').trim();
  if (!v) return '';
  try {
    const x = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(v) ? v : 'https://' + v.replace(/^\/+/, ''));
    return x.protocol === 'https:' || x.protocol === 'http:' ? x.href : '';
  } catch { return ''; }
}

export function mapHref(item) {
  if (item.g) return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(item.n)}&query_place_id=${item.g}`;
  if (item.m) return safeUrl(item.m);
  if (item.y && item.x) return `https://www.google.com/maps/search/?api=1&query=${item.y},${item.x}`;
  return '';
}

export function timeAgo(date) {
  const s = (Date.now() - new Date(date).getTime()) / 1000;
  const rtf = new Intl.RelativeTimeFormat('ar', { numeric: 'auto' });
  if (s < 60) return 'الآن';
  if (s < 3600) return rtf.format(-Math.round(s / 60), 'minute');
  if (s < 86400) return rtf.format(-Math.round(s / 3600), 'hour');
  if (s < 2592000) return rtf.format(-Math.round(s / 86400), 'day');
  return new Date(date).toLocaleDateString('ar-SY');
}

#!/usr/bin/env python3
"""تنظيف نسخة CSV من دليل حماة القديم واستيرادها إلى Supabase.

الاستخدام:
    python3 clean_import.py backup.csv --out build/            # تنظيف فقط + تقرير
    python3 clean_import.py backup.csv --out build/ --push      # تنظيف ثم رفع

متغيرات البيئة المطلوبة للرفع:
    SUPABASE_URL, SUPABASE_KEY (المفتاح العام), ADMIN_EMAIL, ADMIN_PASSWORD
"""
import argparse
import collections
import csv
import json
import os
import re
import sys
import urllib.parse
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from taxonomy import AREAS, CATEGORIES, LEGACY_MAP, RECLASSIFY_FROM, RECLASSIFY_RULES  # noqa: E402

HAMA = (35.1318, 36.7578)
BBOX = (34.95, 35.35, 36.55, 37.0)  # lat_min, lat_max, lng_min, lng_max

COLS = {
    "name": "الاسم", "phone": "الرقم", "address": "العنوان", "map": "الرابط",
    "category": "التصنيف", "status": "الحالة", "mobile": "جوال إضافي",
    "website": "موقع إلكتروني", "id": "المعرف", "extra": "أرقام إضافية",
}

BIDI = re.compile("[‎‏‪-‮⁦-⁩﻿]")
DIGITS = str.maketrans("٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹", "01234567890123456789")


def norm(s: str) -> str:
    """تطبيع النص العربي للمطابقة (نفس منطق البحث في الواجهة)."""
    s = BIDI.sub("", s or "").translate(DIGITS).lower()
    s = re.sub("[ً-ْٰـ]", "", s)
    s = re.sub("[أإآٱ]", "ا", s).replace("ة", "ه").replace("ى", "ي").replace("ؤ", "و").replace("ئ", "ي")
    s = re.sub(r"[^\w\s+]", " ", s)
    return re.sub(r"\s+", " ", s).strip()


def clean_text(s: str) -> str:
    s = BIDI.sub("", s or "")
    return re.sub(r"\s+", " ", s).strip(" ،,-|")


# ─────────────── الأرقام ───────────────

def normalize_phone(p: str):
    """يعيد الرقم بصيغة محلية موحدة (09xxxxxxxx / 0132xxxxxx)، أو None."""
    raw = (p or "").translate(DIGITS).strip()
    if not raw:
        return None
    intl = bool(re.match(r"^\s*(\+|00)", raw))
    d = re.sub(r"\D", "", raw)
    if not d:
        return None
    if d.startswith("00963"):
        d = d[5:]
    elif d.startswith("963") and len(d) >= 11:
        d = d[3:]
    elif intl and not re.match(r"^0*1", d):
        return "+" + re.sub(r"^00", "", d)
    d = d.lstrip("0")
    if re.fullmatch(r"33\d{7}", d):  # رمز حماة القديم 033 صار 013
        d = "13" + d[2:]
    if len(d) >= 8:
        return "0" + d
    if re.fullmatch(r"2\d{6}", d):  # رقم أرضي محلي في حماة بلا رمز المنطقة
        return "013" + d
    return re.sub(r"\D", "", raw)


def split_phones(*values):
    out = []
    for v in values:
        for part in re.split(r"[/،,;|]| و |\n", v or ""):
            n = normalize_phone(part)
            if n and n not in out:
                out.append(n)
    return out


# ─────────────── الإحداثيات ───────────────

OLC = "23456789CFGHJMPQRVWX"
PLUS = re.compile(r"\b([23456789CFGHJMPQRVWX]{4,8}\+[23456789CFGHJMPQRVWX]{2,3})\b", re.I)


def olc_decode(code):
    code = code.upper().replace("+", "")
    lat, lng, res = -90.0, -180.0, 20.0
    pairs = code[:10]
    for i in range(0, len(pairs), 2):
        lat += OLC.index(pairs[i]) * res
        lng += OLC.index(pairs[i + 1]) * res
        if i + 2 < len(pairs):
            res /= 20
    lat_res = lng_res = res
    if len(code) > 10:
        d = OLC.index(code[10])
        lat_res, lng_res = res / 5, res / 4
        lat += (d // 4) * lat_res
        lng += (d % 4) * lng_res
    return lat + lat_res / 2, lng + lng_res / 2


def olc_encode_prefix(lat, lng, n):
    lat, lng = lat + 90, lng + 180
    out, res = "", 20.0
    while len(out) < n:
        out += OLC[int(lat // res)] + OLC[int(lng // res)]
        lat %= res
        lng %= res
        res /= 20
    return out[:n]


def olc_recover(short, ref=HAMA):
    head = short.upper().split("+")[0]
    if len(head) >= 8:
        return olc_decode(short)
    pad = 8 - len(head)
    resolution = 20.0 ** (2 - pad / 2)
    full = olc_encode_prefix(ref[0], ref[1], pad) + short.upper()
    lat, lng = olc_decode(full)
    half = resolution / 2
    if ref[0] + half < lat:
        lat -= resolution
    elif ref[0] - half > lat:
        lat += resolution
    if ref[1] + half < lng:
        lng -= resolution
    elif ref[1] - half > lng:
        lng += resolution
    return lat, lng


def in_hama(lat, lng):
    return BBOX[0] <= lat <= BBOX[1] and BBOX[2] <= lng <= BBOX[3]


def extract_coords(address, url):
    u = urllib.parse.unquote(url or "")
    for pat in (r"@(-?\d+\.\d+),\s*(-?\d+\.\d+)",
                r"[?&](?:daddr|q|query|ll|destination)=(-?\d+\.\d+),\s*\+?(-?\d+\.\d+)"):
        m = re.search(pat, u)
        if m:
            lat, lng = float(m.group(1)), float(m.group(2))
            if in_hama(lat, lng):
                return round(lat, 6), round(lng, 6)
    for text in (address, u):
        m = PLUS.search(text or "")
        if m:
            try:
                lat, lng = olc_recover(m.group(1))
            except (ValueError, IndexError):
                continue
            if in_hama(lat, lng):
                return round(lat, 6), round(lng, 6)
    return None, None


# ─────────────── العنوان والحي ───────────────

USELESS_ADDR = {"حماه", "حماة", "حماة سوريا", "سوريا"}


def clean_address(a):
    a = clean_text(a)
    a = PLUS.sub("", a)
    a = re.sub(r"\(المصدر لا يحدد حيّاً داخل المدينة\)|العنوان التفصيلي قيد التدقيق", "", a)
    a = re.sub(r"\s*[|،,\-]\s*$", "", a)
    a = re.sub(r"^\s*[|،,\-]\s*", "", a)
    a = re.sub(r"\s+", " ", a).strip(" ،,-|")
    a = re.sub(r"(،\s*){2,}", "، ", a)
    if norm(a) in {norm(x) for x in USELESS_ADDR}:
        return ""
    return a


AREA_RX = [(name, [re.compile(p) for p in pats]) for name, pats in AREAS]


def detect_area(address):
    n = norm(address)
    if not n:
        return None
    for name, pats in AREA_RX:
        if any(p.search(n) for p in pats):
            return name
    return None


# ─────────────── التصنيف ───────────────

CAT_NAMES = [c[0] for c in CATEGORIES]
# الأنماط تُطبَّع بالطريقة نفسها التي تُطبَّع بها الأسماء (ى→ي، ئ→ي، ؤ→و، أ/إ/آ→ا)
_PN = str.maketrans("ىئؤأإآ", "ييوااا")
RULES = [(re.compile(p.translate(_PN), re.I), c) for p, c in RECLASSIFY_RULES]


def classify(old_cat, name):
    old_cat = clean_text(old_cat)
    tags = []
    cat = old_cat
    if old_cat in LEGACY_MAP:
        cat, tag = LEGACY_MAP[old_cat]
        if tag:
            tags.append(tag)
    if old_cat in RECLASSIFY_FROM:
        n = norm(name)
        for rx, target in RULES:
            if rx.search(n):
                if not (old_cat == "شركات ومكاتب" and target == "شركات ومكاتب"):
                    cat = target
                break
    if cat not in CAT_NAMES:
        cat = "أخرى"
    return cat, tags


def clean_url(u):
    u = clean_text(u)
    if not u:
        return ""
    if not re.match(r"^https?://", u, re.I):
        u = "https://" + u
    return u


def clean_row(r):
    name = clean_text(r[COLS["name"]])
    phones = split_phones(r[COLS["phone"]], r[COLS["mobile"]], r[COLS["extra"]])
    raw_addr = r[COLS["address"]]
    map_url = clean_url(r[COLS["map"]])
    lat, lng = extract_coords(raw_addr, map_url)
    address = clean_address(raw_addr)
    cat, tags = classify(r[COLS["category"]], name)
    status = (r[COLS["status"]] or "approved").strip()
    return {
        "id": int(r[COLS["id"]]),
        "name": name,
        "category": cat,
        "tags": tags,
        "phones": phones,
        "area": detect_area(raw_addr),
        "address": address or None,
        "map_url": map_url or None,
        "lat": lat,
        "lng": lng,
        "website": clean_url(r[COLS["website"]]) or None,
        "status": status if status in ("approved", "pending", "hidden", "rejected") else "approved",
        "source": "import",
        "_old_category": clean_text(r[COLS["category"]]),
        "_raw_phone": r[COLS["phone"]],
    }


def report(rows, path):
    lines = ["# تقرير تنظيف بيانات دليل حماة", ""]
    lines.append(f"- عدد الأنشطة: {len(rows)}")
    lines.append(f"- بلا رقم هاتف: {sum(1 for r in rows if not r['phones'])}")
    lines.append(f"- لها إحداثيات (لميزة «الأقرب إليّ»): {sum(1 for r in rows if r['lat'])}")
    lines.append(f"- لها حي معروف: {sum(1 for r in rows if r['area'])}")
    lines.append("")
    lines.append("## توزيع التصنيفات الجديدة")
    for c, n in collections.Counter(r["category"] for r in rows).most_common():
        lines.append(f"- {c}: {n}")
    lines.append("")
    lines.append("## الأنشطة التي تغيّر تصنيفها")
    moved = collections.Counter((r["_old_category"], r["category"]) for r in rows if r["_old_category"] != r["category"])
    for (a, b), n in moved.most_common():
        lines.append(f"- {a} ← {b}: {n}")
    lines.append("")
    lines.append("## أرقام غير اعتيادية (تحتاج مراجعة)")
    for r in rows:
        for p in r["phones"]:
            if not re.fullmatch(r"0\d{9}", p):
                lines.append(f"- #{r['id']} {r['name']}: `{p}` (الأصل: `{r['_raw_phone']}`)")
    lines.append("")
    lines.append("## أرقام مكررة بين أكثر من نشاط")
    by_phone = collections.defaultdict(list)
    for r in rows:
        for p in r["phones"]:
            by_phone[p].append(f"#{r['id']} {r['name']}")
    for p, names in by_phone.items():
        if len(names) > 1:
            lines.append(f"- `{p}`: " + " / ".join(names))
    with open(path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")


# ─────────────── الرفع إلى Supabase ───────────────

class Api:
    def __init__(self, url, key):
        self.url, self.key, self.token = url.rstrip("/"), key, None

    def call(self, method, path, body=None, prefer=None):
        headers = {"apikey": self.key, "Content-Type": "application/json"}
        if self.token:
            headers["Authorization"] = "Bearer " + self.token
        if prefer:
            headers["Prefer"] = prefer
        data = json.dumps(body, ensure_ascii=False).encode() if body is not None else None
        req = urllib.request.Request(self.url + path, data=data, method=method, headers=headers)
        with urllib.request.urlopen(req, timeout=60) as res:
            txt = res.read().decode()
            return json.loads(txt) if txt else None

    def login(self, email, password):
        res = self.call("POST", "/auth/v1/token?grant_type=password", {"email": email, "password": password})
        self.token = res["access_token"]


def push(rows):
    api = Api(os.environ["SUPABASE_URL"], os.environ["SUPABASE_KEY"])
    api.login(os.environ["ADMIN_EMAIL"], os.environ["ADMIN_PASSWORD"])
    cats = [{"name": n, "icon": ic, "keywords": kw, "sort": (i + 1) * 10} for i, (n, ic, kw) in enumerate(CATEGORIES)]
    api.call("POST", "/rest/v1/categories?on_conflict=name", cats, "resolution=merge-duplicates,return=minimal")
    cat_ids = {c["name"]: c["id"] for c in api.call("GET", "/rest/v1/categories?select=id,name")}
    areas = [{"name": n, "sort": (i + 1) * 10} for i, (n, _) in enumerate(AREAS)]
    api.call("POST", "/rest/v1/areas?on_conflict=name", areas, "resolution=merge-duplicates,return=minimal")
    payload = []
    for r in rows:
        row = {k: v for k, v in r.items() if not k.startswith("_") and k != "category"}
        row["category_id"] = cat_ids.get(r["category"])
        payload.append(row)
    for i in range(0, len(payload), 500):
        api.call("POST", "/rest/v1/listings?on_conflict=id", payload[i:i + 500], "resolution=merge-duplicates,return=minimal")
        print(f"  رُفع {min(i + 500, len(payload))}/{len(payload)}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("csv")
    ap.add_argument("--out", default="build")
    ap.add_argument("--push", action="store_true")
    a = ap.parse_args()
    with open(a.csv, encoding="utf-8-sig") as f:
        rows = [clean_row(r) for r in csv.DictReader(f) if (r.get(COLS["name"]) or "").strip()]
    os.makedirs(a.out, exist_ok=True)
    with open(os.path.join(a.out, "clean.json"), "w", encoding="utf-8") as f:
        json.dump(rows, f, ensure_ascii=False, indent=0)
    report(rows, os.path.join(a.out, "report.md"))
    print(f"تم تنظيف {len(rows)} نشاطاً → {a.out}/clean.json و {a.out}/report.md")
    if a.push:
        push(rows)
        print("تم الرفع.")


if __name__ == "__main__":
    main()

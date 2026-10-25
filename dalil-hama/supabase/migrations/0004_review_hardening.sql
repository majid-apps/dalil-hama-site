-- دليل حماة — تقوية بعد المراجعة الأمنية الشاملة

-- مسار بحث ثابت للدوال (تحذير مستشار Supabase الأمني)
alter function public.normalize_phone(text) set search_path = '';
alter function private.touch_updated_at() set search_path = '';
alter function private.settings_touch() set search_path = '';

-- الأرقام الأرضية المحلية (7 أرقام تبدأ بـ 2) تُكمَّل برمز حماة 013 كما في الواجهة وسكربت الاستيراد
create or replace function public.normalize_phone(p text)
returns text language plpgsql immutable set search_path = '' as $$
declare
  raw text;
  d text;
  intl boolean;
begin
  if p is null then return null; end if;
  raw := translate(p, '٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹', '01234567890123456789');
  intl := raw ~ '^\s*(\+|00)';
  d := regexp_replace(raw, '\D', '', 'g');
  if d = '' then return null; end if;
  if d like '00963%' then d := substr(d, 6);
  elsif d like '963%' and length(d) >= 11 then d := substr(d, 4);
  elsif intl and d !~ '^0*1' then return '+' || regexp_replace(d, '^00', '');
  end if;
  d := regexp_replace(d, '^0+', '');
  if length(d) >= 8 then return '0' || d; end if;
  if d ~ '^2[0-9]{6}$' then return '013' || d; end if;
  return regexp_replace(raw, '\D', '', 'g');
end $$;

-- الروابط من الزوار: http(s) فقط، وإضافة https:// للروابط بلا بروتوكول
create or replace function private.clean_url(u text, maxlen int)
returns text language sql immutable set search_path = '' as $$
  select case when v ~* '^https?://[^\s<>"]+$' then v end from (
    select case when t = '' then null when t ~* '^[a-z][a-z0-9+.-]*:' then t else 'https://' || t end as v
    from (select left(btrim(coalesce(u, '')), maxlen) as t) a
  ) b;
$$;

-- أيقونة التصنيف رمز قصير بلا أحرف HTML
alter table public.categories add constraint categories_icon_check
  check (char_length(icon) <= 16 and icon !~ '[<>"''&]');

-- التفاعل نفسه من الجهاز نفسه على النشاط نفسه يُحتسب مرة واحدة يومياً
create table if not exists private.track_seen (
  client     text   not null,
  listing_id bigint not null,
  ev         text   not null,
  day        date   not null default current_date,
  primary key (client, listing_id, ev, day)
);

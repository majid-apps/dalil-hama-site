-- دليل حماة — v1.12.1: حدود المعدل تناسب الشبكات المشتركة، وحدّ للمزامنة الكاملة، وتخزين رموز روابط أصحاب الأرقام مجزّأة.
--
-- 1) private.rate_limits: حدود كل نوع طلب في جدول واحد يتقدّم على الأرقام المكتوبة داخل الدوال (فلا حاجة لإعادة كتابة كل دالة).
--    السبب: معظم مشتركي الإنترنت في سوريا خلف عنوان IP واحد (CGNAT)، فحدّ مثل «6 طلبات إضافة في الساعة لكل IP»
--    يمنع مستخدمين حقيقيين بعد إعلان في مجموعات حماة. الحدود أعلى الآن وما زالت تمنع الإساءة الآلية.
--    وكل رفض (غير track وsearch) يُحسب في daily_stats بنوع 'rate' ليظهر في لوحة الإدارة.
-- 2) public.sync بلا since (المزامنة الكاملة، 1.4 ثانية من القاعدة لكل نداء) محدودة بـ30 في الساعة لكل عنوان.
--    الزوار العاديون يأخذون /data/sync.json من Caddy فلا يتأثرون؛ والدالة الأصلية صارت private.sync_impl.
-- 3) owner_links.token يخزّن الآن SHA-256 للرمز لا الرمز نفسه: تسريب القاعدة أو النسخ الاحتياطي لا يكشف رابطاً صالحاً
--    (الرمز كان يكفي وحده لنشر بطاقة أو تعديلها أو حذفها 60 يوماً). الروابط المرسلة سابقاً تعمل كما هي (الرمز في الرابط لم يتغير).
--    تُعاد كتابة admin_owner_link وowner_link_info وowner_action وowner_edit وowner_report وowner_delete لتبحث بالتجزئة.
-- آمنة للإعادة.

-- ───────────────────────── 1) حدود المعدل ─────────────────────────

create table if not exists private.rate_limits (
  kind     text primary key,
  max_hits int  not null check (max_hits > 0)
);
insert into private.rate_limits (kind, max_hits) values
  ('submit', 30),     -- إضافة نشاط: كانت 6 في الساعة
  ('report', 30),     -- بلاغ: كانت 10 في الساعة
  ('flag', 20),       -- «الرقم خطأ»: كانت 6 في اليوم (وسقف الإخفاء العام 20 في اليوم باقٍ)
  ('track', 1000),    -- عدّادات التواصل: كانت 240 في الساعة
  ('search', 600),    -- سجل البحث: كان 120 في الساعة
  ('owner', 300),     -- صفحة صاحب الرقم: كانت 120 في الساعة
  ('sync_full', 30)   -- المزامنة الكاملة بالدالة (الاحتياط إن غاب الملف الجاهز)
on conflict (kind) do update set max_hits = excluded.max_hits;

create or replace function private.allow(kind text, max_hits int, per interval)
returns boolean language plpgsql security definer set search_path = public as $$
declare
  b text := kind || ':' || private.client_key();
  lim int := coalesce((select r.max_hits from private.rate_limits r where r.kind = allow.kind), max_hits);
  n int;
begin
  if random() < 0.02 then
    delete from private.rate_hits where at < now() - interval '1 day';
  end if;
  select count(*) into n from private.rate_hits where bucket = b and at > now() - per;
  if n >= lim then
    -- عدّاد الرفض الظاهر للمدير (بلا track وsearch: إحصاءات فقط لا تُرى من الزائر)
    if kind not in ('track', 'search') then
      -- القيد المسمّى لا الأعمدة: اسم المعامل kind يتعارض مع عمود kind في on conflict
      insert into public.daily_stats as ds (kind, count) values ('rate', 1)
        on conflict on constraint daily_stats_pkey do update set count = ds.count + 1;
    end if;
    return false;
  end if;
  insert into private.rate_hits (bucket) values (b);
  return true;
end $$;

-- ───────────────────────── 2) حدّ المزامنة الكاملة ─────────────────────────

do $$
begin
  if to_regprocedure('private.sync_impl(timestamptz)') is null then
    alter function public.sync(timestamptz) set schema private;
    alter function private.sync(timestamptz) rename to sync_impl;
  end if;
end $$;
revoke execute on function private.sync_impl(timestamptz) from public, anon, authenticated;

create or replace function public.sync(since timestamptz default null)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
begin
  if since is null and not private.allow('sync_full', 30, interval '1 hour') then
    raise exception 'rate' using errcode = 'P0001';
  end if;
  return private.sync_impl(since);
end $$;
revoke execute on function public.sync(timestamptz) from public;
grant execute on function public.sync(timestamptz) to anon, authenticated;

-- ───────────────────────── 3) رموز روابط أصحاب الأرقام مجزّأة ─────────────────────────

create or replace function private.tok_hash(t text)
returns text language sql immutable as $$
  select encode(extensions.digest(coalesce(t, ''), 'sha256'), 'hex');
$$;

alter table public.owner_links drop constraint if exists owner_links_token_check;
update public.owner_links set token = private.tok_hash(token) where token ~ '^[A-Za-z0-9_-]{22}$';
alter table public.owner_links add constraint owner_links_token_check check (token ~ '^[0-9a-f]{64}$');

-- الإدارة: تسجيل الرمز الذي وُضع في رسالة الموافقة (يُخزَّن مجزّأً)
create or replace function public.admin_owner_link(p_listing bigint, p_phone text, p_token text)
returns boolean language plpgsql security definer set search_path = public as $$
declare n text := public.normalize_phone(p_phone);
begin
  if not public.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  if coalesce(p_token, '') !~ '^[A-Za-z0-9_-]{22}$' then raise exception 'رمز غير صالح'; end if;
  if not exists (select 1 from public.listings where id = p_listing and n = any(phones)) then
    raise exception 'الرقم ليس في هذه البطاقة';
  end if;
  insert into public.owner_links (token, listing_id, phone) values (private.tok_hash(p_token), p_listing, n) on conflict (token) do nothing;
  return true;
end $$;
revoke execute on function public.admin_owner_link(bigint, text, text) from public, anon;
grant execute on function public.admin_owner_link(bigint, text, text) to authenticated;

-- معلومات الرابط (كما في 0019، والبحث بالتجزئة)
create or replace function public.owner_link_info(p_token text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  k public.owner_links;
  l record;
begin
  if not private.allow('owner', 120, interval '1 hour') then return jsonb_build_object('ok', false, 'error', 'rate'); end if;
  select * into k from public.owner_links where token = private.tok_hash(p_token);
  if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  select x.id, x.name, x.status, x.phones, x.address, x.description, c.name as cat into l
    from public.listings x left join public.categories c on c.id = x.category_id where x.id = k.listing_id;
  if not found then return jsonb_build_object('ok', false, 'error', 'gone'); end if;
  return jsonb_build_object('ok', true, 'id', l.id, 'name', l.name, 'category', l.cat, 'phone', k.phone,
    'address', l.address, 'description', l.description,
    'published', l.status = 'approved', 'card_live', l.status in ('approved', 'pending'),
    'in_card', k.phone = any(l.phones),
    'others', cardinality(l.phones) - case when k.phone = any(l.phones) then 1 else 0 end,
    'action', k.action, 'expired', k.expires_at < now());
end $$;
grant execute on function public.owner_link_info(text) to anon, authenticated;

-- «موافق» أو «الرقم خطأ» (كما في 0012، والبحث بالتجزئة)
create or replace function public.owner_action(p_token text, p_action text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  k public.owner_links;
  l record;
  th text := private.tok_hash(p_token);
begin
  if not private.allow('owner', 120, interval '1 hour') then return jsonb_build_object('ok', false, 'error', 'rate'); end if;
  if p_action is null or p_action not in ('approve', 'reject') then return jsonb_build_object('ok', false, 'error', 'bad_action'); end if;
  select * into k from public.owner_links where token = th for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  if k.action = 'reject' or (k.action = 'approve' and p_action = 'approve') then
    return jsonb_build_object('ok', true, 'action', k.action, 'already', true);
  end if;
  if k.expires_at < now() then return jsonb_build_object('ok', false, 'error', 'expired'); end if;
  select id, status, phones into l from public.listings where id = k.listing_id for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'gone'); end if;
  if not (k.phone = any(l.phones)) then return jsonb_build_object('ok', false, 'error', 'phone_gone'); end if;
  if p_action = 'approve' then
    update public.listings
       set status = case when status = 'pending' then 'approved' else status end,
           admin_note = btrim(coalesce(admin_note, '') || E'\n✅ وافق صاحب الرقم ' || k.phone || ' على النشر من رابط الموافقة ' || current_date, E'\n')
     where id = l.id;
  else
    perform private.exclude_phone(k.phone, 'استبعده صاحبه من رابط الموافقة', true, 'استبعده صاحبه من رابط الموافقة');
  end if;
  update public.owner_links set used_at = now(), action = p_action where token = th;
  return jsonb_build_object('ok', true, 'action', p_action, 'id', l.id);
end $$;
grant execute on function public.owner_action(text, text) to anon, authenticated;

-- تعديل البطاقة من صاحب الرقم (كما في 0014، والبحث بالتجزئة)
create or replace function public.owner_edit(p_token text, p_name text default null, p_address text default null,
                                             p_description text default null, p_phone text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  k public.owner_links;
  l record;
  th text := private.tok_hash(p_token);
  v_name text := nullif(btrim(regexp_replace(coalesce(p_name, ''), '\s+', ' ', 'g')), '');
  v_addr text := nullif(btrim(p_address), '');
  v_desc text := nullif(btrim(p_description), '');
  v_phone text := public.normalize_phone(p_phone);
  v_note text := '';
begin
  if not private.allow('owner', 120, interval '1 hour') then return jsonb_build_object('ok', false, 'error', 'rate'); end if;
  select * into k from public.owner_links where token = th for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  if k.action = 'reject' then return jsonb_build_object('ok', false, 'error', 'removed'); end if;
  if k.expires_at < now() then return jsonb_build_object('ok', false, 'error', 'expired'); end if;
  select * into l from public.listings where id = k.listing_id for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'gone'); end if;
  if not (k.phone = any(l.phones)) then return jsonb_build_object('ok', false, 'error', 'phone_gone'); end if;
  if v_name is not null and (char_length(v_name) < 2 or char_length(v_name) > 160) then return jsonb_build_object('ok', false, 'error', 'name'); end if;
  -- حدّ العنوان 400 كما في الجدول والإدارة (كان 300 هنا فيُرفض ما تقبله الإدارة)
  if v_addr is not null and char_length(v_addr) > 400 then return jsonb_build_object('ok', false, 'error', 'address'); end if;
  if v_desc is not null and char_length(v_desc) > 600 then return jsonb_build_object('ok', false, 'error', 'description'); end if;
  if p_phone is not null and btrim(p_phone) <> '' then
    if length(regexp_replace(coalesce(v_phone, ''), '\D', '', 'g')) < 7 then return jsonb_build_object('ok', false, 'error', 'phone'); end if;
    if exists (select 1 from public.excluded_phones where phone = v_phone) then return jsonb_build_object('ok', false, 'error', 'phone_excluded'); end if;
    if v_phone <> k.phone then
      update public.listings set phones = array(select distinct case when q = k.phone then v_phone else q end from unnest(phones) q) where id = l.id;
      update public.owner_links set phone = v_phone where token = th;
      v_note := v_note || ' الرقم: ' || k.phone || ' ← ' || v_phone || '.';
    end if;
  else
    v_phone := k.phone;
  end if;
  update public.listings
     set name = coalesce(v_name, name),
         address = case when p_address is null then address else v_addr end,
         description = case when p_description is null then description else v_desc end,
         admin_note = btrim(coalesce(admin_note, '') || E'\n✏️ عدّل صاحب الرقم بطاقته من رابطه ' || current_date || v_note, E'\n')
   where id = l.id;
  return jsonb_build_object('ok', true, 'phone', v_phone);
end $$;
grant execute on function public.owner_edit(text, text, text, text, text) to anon, authenticated;

-- إبلاغ برسالة من صاحب الرقم (كما في 0014، والبحث بالتجزئة)
create or replace function public.owner_report(p_token text, p_text text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  k public.owner_links;
  v_name text;
  v_text text := nullif(btrim(p_text), '');
begin
  if not private.allow('owner', 120, interval '1 hour') then return jsonb_build_object('ok', false, 'error', 'rate'); end if;
  if v_text is null or char_length(v_text) < 5 then return jsonb_build_object('ok', false, 'error', 'details'); end if;
  select * into k from public.owner_links where token = private.tok_hash(p_token);
  if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  if k.expires_at < now() and k.action is null then return jsonb_build_object('ok', false, 'error', 'expired'); end if;
  if (select count(*) from public.reports where contact = k.phone and created_at > now() - interval '1 day') >= 5 then
    return jsonb_build_object('ok', false, 'error', 'rate');
  end if;
  select name into v_name from public.listings where id = k.listing_id;
  insert into public.reports (listing_id, listing_name, kind, details, contact)
  values (case when v_name is null then null else k.listing_id end, v_name, 'wrong_info', left(v_text, 1000), k.phone);
  insert into public.daily_stats (kind, count) values ('report', 1)
    on conflict (day, kind) do update set count = daily_stats.count + 1;
  return jsonb_build_object('ok', true);
end $$;
grant execute on function public.owner_report(text, text) to anon, authenticated;

-- حذف رقمه وحده أو البطاقة كاملة (كما في 0019، والبحث بالتجزئة)
create or replace function public.owner_delete(p_token text, p_card boolean default false)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  k public.owner_links;
  l record;
  th text := private.tok_hash(p_token);
  v_status public.listing_status;
begin
  if not private.allow('owner', 120, interval '1 hour') then return jsonb_build_object('ok', false, 'error', 'rate'); end if;
  select * into k from public.owner_links where token = th for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  select status into v_status from public.listings where id = k.listing_id;
  if k.action = 'reject' then return jsonb_build_object('ok', true, 'already', true, 'card_live', coalesce(v_status in ('approved', 'pending'), false)); end if;
  if k.expires_at < now() then return jsonb_build_object('ok', false, 'error', 'expired'); end if;
  select id, phones into l from public.listings where id = k.listing_id for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'gone'); end if;
  perform private.exclude_phone(k.phone, 'حذف صاحبه رقمه من رابطه', true, 'حذف صاحبه رقمه من رابطه');
  if p_card then
    update public.listings set status = 'rejected',
           admin_note = btrim(coalesce(admin_note, '') || E'\n🗑 حذف صاحب الرقم بطاقته كاملة من رابطه ' || current_date, E'\n')
     where id = k.listing_id and status <> 'rejected';
  end if;
  update public.owner_links set used_at = now(), action = 'reject' where token = th;
  select status into v_status from public.listings where id = k.listing_id;
  return jsonb_build_object('ok', true, 'action', 'reject', 'card_live', coalesce(v_status in ('approved', 'pending'), false));
end $$;
revoke execute on function public.owner_delete(text, boolean) from public;
grant execute on function public.owner_delete(text, boolean) to anon, authenticated;
revoke execute on function public.owner_edit(text, text, text, text, text) from public;
revoke execute on function public.owner_report(text, text) from public;

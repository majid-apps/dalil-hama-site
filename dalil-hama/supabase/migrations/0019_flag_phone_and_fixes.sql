-- دليل حماة — «الرقم خطأ» من رسالة الزائر + إصلاحات فحص 13 تشرين الثاني 2026 (مساءً)
--
-- 1) flag_phone: من يصله واتساب من الدليل بالخطأ يضغط «الرقم خطأ» فيُسجَّل بلاغ فوراً (رقم + بطاقة) في «البلاغات»،
--    ويُوقَف الرقم مؤقتاً عن الزوار (حتى 3 أيام أو حتى تؤكد أنت) بحمايات: حدّ لكل جهاز، حدّ عام يومي، لا يُوقَف الرقم الوحيد
--    في البطاقة، ولا رقم أكّدتَ صحته خلال 30 يوماً. يُلغى الإيقاف من الإعدادات (flag.hold = false).
-- 2) admin_release_phone: «الرقم صحيح» يعيد إظهاره ويغلق بلاغاته ويمنع إيقافه 30 يوماً. والاستبعاد يغلق بلاغات الرقم ويحذفه من الموقوفين.
-- 3) owner_delete: صاحب الرقم يحذف رقمه وحده (تبقى البطاقة إن بقي فيها رقم)، أو البطاقة كاملة بقرار صريح (p_card).
--    كان يرفض البطاقة كاملة بأرقامها الصحيحة الأخرى. وowner_link_info تعيد others وcard_live.
-- 4) بيانات: أحياء ناقصة، دمج وحذف التصنيفات الفارغة، حذف «حماة -» من بداية العناوين، إحداثيات من روابط الخرائط.
-- آمنة للإعادة.

alter table public.reports add column if not exists phone text;
alter table public.reports add column if not exists held boolean not null default false;
create index if not exists reports_phone_open_idx on public.reports (phone) where status = 'open';

create table if not exists public.held_phones (
  phone      text primary key,
  listing_id bigint references public.listings(id) on delete cascade,
  created_at timestamptz not null default now()
);
alter table public.held_phones enable row level security;
revoke all on public.held_phones from anon;
drop policy if exists "admins manage held phones" on public.held_phones;
create policy "admins manage held phones" on public.held_phones for all to authenticated using (public.is_admin()) with check (public.is_admin());
grant select, insert, update, delete on public.held_phones to authenticated;

create table if not exists private.phone_ok (
  phone text primary key,
  at    timestamptz not null default now()
);

-- ───────────────────────── sync: لا تُرسل الأرقام الموقوفة ─────────────────────────

create or replace function public.sync(since timestamptz default null)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'now', now(),
    'full', since is null,
    'items', coalesce((
      select jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
        'i', l.id,
        'n', l.name,
        'c', l.category_id,
        'p', case when cardinality(vp.ph) > 0 then to_jsonb(vp.ph) end,
        'w', case when exists (select 1 from public.held_phones h where h.phone = public.normalize_phone(l.whatsapp) and h.created_at > now() - interval '3 days') then null else l.whatsapp end,
        'nw', case when l.no_whatsapp then 1 end,
        'a', l.area,
        'd', nullif(l.address, ''),
        -- روابط بحث Google التي تحوي place_id تُرسل مختصرة (g) وتُعاد بناؤها في المتصفح
        'm', case when pid is null then nullif(l.map_url, '') end,
        'g', pid,
        'y', round(l.lat::numeric, 6),
        'x', round(l.lng::numeric, 6),
        's', nullif(l.website, ''),
        'e', nullif(l.description, ''),
        't', case when cardinality(l.tags) > 0 then to_jsonb(l.tags) end,
        'f', case when l.featured then 1 end,
        'v', case when l.verified then 1 end,
        'k', nullif(coalesce(st.calls + st.whatsapp, 0), 0)
      )) order by l.id)
      from public.listings l
      left join public.listing_stats st on st.listing_id = l.id
      -- الأرقام الموقوفة مؤقتاً بطلب «الرقم خطأ» (3 أيام كحد أقصى أو حتى يؤكد المدير) لا تُرسل للزوار
      cross join lateral (
        select coalesce(array(select u.q from unnest(l.phones) with ordinality u(q, n)
                              where not exists (select 1 from public.held_phones h where h.phone = u.q and h.created_at > now() - interval '3 days')
                              order by u.n), '{}'::text[]) as ph
      ) vp
      cross join lateral (
        select substring(l.map_url from '^https://www\.google\.com/maps/search/\?api=1&query=[^&]*&query_place_id=([A-Za-z0-9_-]+)$') as pid
      ) g
      where l.status = 'approved' and (since is null or l.updated_at > since)
    ), '[]'::jsonb),
    'removed', case when since is null then '[]'::jsonb else coalesce((
      select jsonb_agg(id) from (
        select id from public.listings where status <> 'approved' and updated_at > since
        union
        select listing_id from private.tombstones where deleted_at > since
      ) r
    ), '[]'::jsonb) end,
    'cats', coalesce((
      select jsonb_agg(jsonb_build_object('i', id, 'n', name, 'ic', icon, 'o', sort, 'k', keywords) order by sort, name)
      from public.categories
    ), '[]'::jsonb),
    'areas', coalesce((
      -- 'r' = 1 لبلدات ريف حماة (بوابة «ريف حماة»): نشاط مكانه بلدة ريفية يخرج من قوائم المدينة
      select jsonb_agg(jsonb_build_object('n', name, 'k', keywords)
                       || case when rural then jsonb_build_object('r', 1) else '{}'::jsonb end order by sort, name)
      from public.areas
    ), '[]'::jsonb),
    'settings', coalesce((select jsonb_object_agg(key, value) from public.settings where is_public), '{}'::jsonb)
  );
$$;

-- ───────────────────────── بلاغ «الرقم خطأ» من الزائر ─────────────────────────

create or replace function public.flag_phone(p_listing bigint, p_phone text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  n text := public.normalize_phone(p_phone);
  l record;
  v_cfg jsonb;
  v_visible int;
  v_hold boolean;
begin
  if n is null or n = '' then return jsonb_build_object('ok', false, 'error', 'phone'); end if;
  if not private.allow('flag', 6, interval '1 day') then return jsonb_build_object('ok', false, 'error', 'rate'); end if;
  select id, name, phones, status into l from public.listings where id = p_listing for update;
  if not found or l.status <> 'approved' then return jsonb_build_object('ok', false, 'error', 'gone'); end if;
  if not (n = any(l.phones)) then return jsonb_build_object('ok', false, 'error', 'phone_gone'); end if;
  -- الرقم نفسه مبلَّغ عنه ثلاث مرات ولم تُراجَع: لا بلاغ رابع (يبقى الموقوف موقوفاً)
  if (select count(*) from public.reports where phone = n and status = 'open') >= 3 then
    return jsonb_build_object('ok', true, 'dup', true);
  end if;
  select value into v_cfg from public.settings where key = 'flag';
  select count(*) into v_visible from unnest(l.phones) q
   where not exists (select 1 from public.held_phones h where h.phone = q and h.created_at > now() - interval '3 days');
  v_hold := coalesce((v_cfg ->> 'hold')::boolean, true)
        and v_visible > 1
        and not exists (select 1 from private.phone_ok where phone = n and at > now() - interval '30 days')
        and (select count(*) from public.held_phones where created_at > now() - interval '1 day') < 20;
  insert into public.reports (listing_id, listing_name, kind, details, phone, held)
  values (l.id, l.name, 'wrong_number',
          '⛔ طلب حذف الرقم ' || n || ' (من رابط رسالة واتساب)' || case when v_hold then E'\n⏸ أُوقف الرقم مؤقتاً عن الزوار بانتظار تأكيدك' else '' end,
          n, v_hold);
  insert into public.daily_stats (kind, count) values ('report', 1)
    on conflict (day, kind) do update set count = daily_stats.count + 1;
  if v_hold then
    insert into public.held_phones (phone, listing_id) values (n, l.id)
      on conflict (phone) do update set created_at = now(), listing_id = excluded.listing_id;
    -- تحديث البطاقة يرفع updated_at فتصل المزامنة التفاضلية بإخفاء الرقم
    update public.listings
       set admin_note = btrim(coalesce(admin_note, '') || E'\n⏸ أُوقف رقم مؤقتاً بطلب «الرقم خطأ» ' || current_date, E'\n')
     where id = l.id;
  end if;
  return jsonb_build_object('ok', true, 'held', v_hold);
end $$;
revoke execute on function public.flag_phone(bigint, text) from public;
grant execute on function public.flag_phone(bigint, text) to anon, authenticated;

-- «الرقم صحيح»: يعاد إظهاره، وتُغلق بلاغاته، ولا يُوقَف ثانية 30 يوماً. بلا p_ok: إعادة الإظهار فقط
create or replace function public.admin_release_phone(p_phone text, p_ok boolean default true)
returns bigint[] language plpgsql security definer set search_path = public as $$
declare
  n text := public.normalize_phone(p_phone);
  ids bigint[];
begin
  if not public.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  if n is null or n = '' then return '{}'; end if;
  delete from public.held_phones where phone = n;
  if p_ok then
    insert into private.phone_ok (phone) values (n) on conflict (phone) do update set at = now();
  end if;
  update public.reports
     set status = case when p_ok then 'dismissed' else status end,
         resolved_at = case when p_ok then now() else resolved_at end,
         held = false
   where phone = n and (status = 'open' or held);
  with u as (
    update public.listings
       set admin_note = btrim(coalesce(admin_note, '') || E'\n▶️ ' || case when p_ok then 'أُكّد صحة رقم ' else 'أُعيد إظهار رقم ' end || n || ' ' || current_date, E'\n')
     where n = any(phones)
    returning id)
  select coalesce(array_agg(id), '{}') into ids from u;
  return ids;
end $$;
revoke execute on function public.admin_release_phone(text, boolean) from public, anon;
grant execute on function public.admin_release_phone(text, boolean) to authenticated;

-- الاستبعاد (المدير أو صاحب الرقم): كما في 0012، ومعه إغلاق بلاغات الرقم وحذفه من الموقوفين
create or replace function private.exclude_phone(n text, p_note text, p_owner boolean default false, p_why text default null)
returns bigint[] language plpgsql security definer set search_path = public as $$
declare
  ids bigint[] := '{}';
  l record;
  left_phones text[];
  rej boolean;
  rec jsonb := '[]'::jsonb;
  stamp text := E'\n⛔ استُبعد رقم نهائياً ' || current_date || coalesce(' — ' || nullif(btrim(p_why), ''), '');
begin
  if n is null or n = '' then return ids; end if;
  insert into public.excluded_phones (phone, name, note)
  values (n, (select x.name from public.listings x where n = any(x.phones) order by (x.status = 'approved') desc, x.id limit 1), nullif(left(btrim(coalesce(p_note, '')), 300), ''))
  on conflict (phone) do update set note = coalesce(excluded.note, public.excluded_phones.note);
  for l in select * from public.listings where n = any(phones) loop
    left_phones := array(select q from unnest(l.phones) q where public.normalize_phone(q) is distinct from n);
    rej := l.status <> 'rejected' and (
             (cardinality(left_phones) = 0 and l.lat is null and coalesce(l.map_url, '') = '' and coalesce(btrim(l.address), '') = '')
             or (p_owner and (l.status = 'pending' or cardinality(left_phones) = 0)));
    rec := rec || jsonb_build_array(jsonb_build_object(
      'id', l.id,
      'pos', array_position(l.phones, n),
      'wa', coalesce(public.normalize_phone(l.whatsapp) = n, false),
      'rej', rej,
      'status', l.status));
    update public.listings
       set phones = left_phones,
           whatsapp = case when public.normalize_phone(whatsapp) = n then null else whatsapp end,
           status = case when rej then 'rejected' else l.status end,
           admin_note = btrim(coalesce(admin_note, '') || stamp, E'\n')
     where id = l.id;
    ids := ids || l.id;
  end loop;
  update public.excluded_phones set removed_from = removed_from || rec where phone = n;
  delete from public.held_phones where phone = n;
  update public.reports set status = 'resolved', resolved_at = now(), held = false where phone = n and status = 'open';
  return ids;
end $$;
revoke all on function private.exclude_phone(text, text, boolean, text) from public;

-- ───────────────────────── صاحب الرقم: حذف رقمه وحده أو البطاقة كاملة ─────────────────────────

create or replace function public.owner_link_info(p_token text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  k public.owner_links;
  l record;
begin
  if not private.allow('owner', 120, interval '1 hour') then return jsonb_build_object('ok', false, 'error', 'rate'); end if;
  select * into k from public.owner_links where token = p_token;
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

drop function if exists public.owner_delete(text);
create or replace function public.owner_delete(p_token text, p_card boolean default false)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  k public.owner_links;
  l record;
  v_status public.listing_status;
begin
  if not private.allow('owner', 120, interval '1 hour') then return jsonb_build_object('ok', false, 'error', 'rate'); end if;
  select * into k from public.owner_links where token = p_token for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  select status into v_status from public.listings where id = k.listing_id;
  if k.action = 'reject' then return jsonb_build_object('ok', true, 'already', true, 'card_live', coalesce(v_status in ('approved', 'pending'), false)); end if;
  if k.expires_at < now() then return jsonb_build_object('ok', false, 'error', 'expired'); end if;
  select id, phones into l from public.listings where id = k.listing_id for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'gone'); end if;
  -- رقمه وحده: يُستبعد نهائياً وتبقى البطاقة إن بقي فيها رقم آخر (وإلا تُرفض)
  perform private.exclude_phone(k.phone, 'حذف صاحبه رقمه من رابطه', true, 'حذف صاحبه رقمه من رابطه');
  if p_card then
    update public.listings set status = 'rejected',
           admin_note = btrim(coalesce(admin_note, '') || E'\n🗑 حذف صاحب الرقم بطاقته كاملة من رابطه ' || current_date, E'\n')
     where id = k.listing_id and status <> 'rejected';
  end if;
  update public.owner_links set used_at = now(), action = 'reject' where token = p_token;
  select status into v_status from public.listings where id = k.listing_id;
  return jsonb_build_object('ok', true, 'action', 'reject', 'card_live', coalesce(v_status in ('approved', 'pending'), false));
end $$;
revoke execute on function public.owner_delete(text, boolean) from public;
grant execute on function public.owner_delete(text, boolean) to anon, authenticated;

-- ───────────────────────── بيانات ─────────────────────────

-- أحياء مستعملة في البطاقات وليست في جدول الأحياء
insert into public.areas (name, keywords, sort, rural) values ('أبي الفداء', '', 100, false) on conflict (name) do nothing;
update public.listings set area = 'الحميدية' where area = 'حي الحميدية' and exists (select 1 from public.areas where name = 'الحميدية');
update public.listings set area = 'القصور'   where area = 'حي القصور غرناطة 1' and exists (select 1 from public.areas where name = 'القصور');

-- التصنيفات الفارغة المكررة: تُنقل بطاقاتها غير المنشورة (مرفوضة/مرشحة/مخفية) إلى التصنيف الأعمّ ثم تُحذف الفارغة
do $$
declare
  m record;
  v_from smallint;
  v_to smallint;
begin
  for m in select * from (values
    ('صالون تجميل', 'تجميل وحلاقة'), ('صالون تجميل سيدات', 'تجميل وحلاقة'), ('محل مستحضرات تجميل وعطور', 'تجميل وحلاقة'),
    ('عيادة بيطرية', 'حيوانات أليفة'), ('قهوة', 'كافيهات'), ('كافيه آيس كوفي', 'كافيهات'), ('كافيه نسائي', 'كافيهات'),
    ('مخبز', 'مخابز وحلويات'), ('مدارس', 'مدارس وروضات'), ('مدرسة', 'مدارس وروضات'), ('مدرسة بنات', 'مدارس وروضات'),
    ('مدرسة متفوقين', 'مدارس وروضات'), ('مطعم فروج', 'مطاعم'), ('مطعم فلافل', 'مطاعم'), ('مطعم مشاوي', 'مطاعم'),
    ('مطعم ومسبح', 'مطاعم'), ('مغسلة سيارات', 'صيانة سيارات'), ('مغسلة ومشحم سيارات', 'صيانة سيارات'), ('مكتبة', 'مكتبات وقرطاسية')
  ) as t(src, dst) loop
    select id into v_from from public.categories where name = m.src;
    select id into v_to from public.categories where name = m.dst;
    if v_from is not null and v_to is not null
       and not exists (select 1 from public.listings where category_id = v_from and status = 'approved') then
      update public.listings set category_id = v_to where category_id = v_from;
    end if;
    delete from public.categories c where c.id = v_from and not exists (select 1 from public.listings l where l.category_id = c.id);
  end loop;
end $$;

-- «حماة -» في بداية العنوان تكرار (الدليل كله لحماة): تُحذف من البداية فقط، ولا يُمسّ عنوان ينتهي فارغاً
update public.listings
   set address = btrim(regexp_replace(address, '^\s*(مدينة\s+)?(حماة|حماه)\s*[-–—،,]+\s*', ''))
 where address ~ '^\s*(مدينة\s+)?(حماة|حماه)\s*[-–—،,]+\s*\S';

-- إحداثيات من روابط الخرائط النصية (@lat,lng أو q=lat,lng أو !3d!4d) داخل محافظة حماة فقط
update public.listings l
   set lat = x.lat, lng = x.lng
  from (
    select id, (m[1])::double precision as lat, (m[2])::double precision as lng
    from (
      select id, coalesce(
        regexp_match(map_url, '@(-?\d{1,2}\.\d+),\s*(-?\d{1,3}\.\d+)'),
        regexp_match(map_url, '[?&](?:q|query|ll|daddr|destination)=(-?\d{1,2}\.\d+)(?:,|%2C)\s*(-?\d{1,3}\.\d+)'),
        regexp_match(map_url, '!3d(-?\d{1,2}\.\d+)!4d(-?\d{1,3}\.\d+)')) as m
      from public.listings where lat is null and lng is null and coalesce(map_url, '') <> ''
    ) s where m is not null
  ) x
 where l.id = x.id and x.lat between 34.6 and 35.7 and x.lng between 36.0 and 37.5;

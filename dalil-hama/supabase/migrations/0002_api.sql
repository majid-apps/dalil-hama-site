-- دليل حماة — الدوال العامة (RPC) ودوال الإدارة

-- مزامنة البيانات للواجهة: كاملة عند since = null، أو التغييرات فقط بعد وقت معيّن
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
        'p', case when cardinality(l.phones) > 0 then to_jsonb(l.phones) end,
        'w', l.whatsapp,
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
      select jsonb_agg(jsonb_build_object('n', name, 'k', keywords) order by sort, name)
      from public.areas
    ), '[]'::jsonb),
    'settings', coalesce((select jsonb_object_agg(key, value) from public.settings where is_public), '{}'::jsonb)
  );
$$;

-- إضافة نشاط من الزوار (يدخل بحالة "قيد المراجعة")
create or replace function public.submit_listing(payload jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_name text := btrim(regexp_replace(coalesce(payload ->> 'name', ''), '\s+', ' ', 'g'));
  v_phone text := public.normalize_phone(payload ->> 'phone');
  v_phone2 text := public.normalize_phone(payload ->> 'phone2');
  v_cat smallint;
  v_dup bigint;
  v_id bigint;
begin
  if coalesce(payload ->> 'website_hp', '') <> '' then
    return jsonb_build_object('ok', true);
  end if;
  if char_length(v_name) < 2 or char_length(v_name) > 160 then
    return jsonb_build_object('ok', false, 'error', 'name');
  end if;
  if v_phone is null or length(regexp_replace(v_phone, '\D', '', 'g')) < 7 then
    return jsonb_build_object('ok', false, 'error', 'phone');
  end if;
  if not private.allow('submit', 6, interval '1 hour') then
    return jsonb_build_object('ok', false, 'error', 'rate');
  end if;
  select id into v_cat from public.categories where id = nullif(payload ->> 'category_id', '')::smallint;
  select id into v_dup from public.listings where v_phone = any (phones) and status in ('approved', 'pending') limit 1;

  insert into public.listings (name, category_id, phones, area, address, map_url, website, description,
                               status, source, submitter_name, submitter_phone, admin_note)
  values (
    v_name, v_cat,
    array_remove(array[v_phone, v_phone2], null),
    nullif(left(btrim(payload ->> 'area'), 60), ''),
    nullif(left(btrim(payload ->> 'address'), 400), ''),
    nullif(left(btrim(payload ->> 'map_url'), 1200), ''),
    nullif(left(btrim(payload ->> 'website'), 300), ''),
    nullif(left(btrim(payload ->> 'description'), 600), ''),
    'pending', 'public',
    nullif(left(btrim(payload ->> 'submitter_name'), 80), ''),
    public.normalize_phone(payload ->> 'submitter_phone'),
    case when v_dup is not null then 'رقم مكرر مع النشاط #' || v_dup end
  ) returning id into v_id;

  insert into public.daily_stats (kind, count) values ('submission', 1)
    on conflict (day, kind) do update set count = daily_stats.count + 1;
  return jsonb_build_object('ok', true, 'id', v_id, 'duplicate', v_dup is not null);
end $$;

-- بلاغ عن خطأ أو طلب تعديل/حذف
create or replace function public.submit_report(payload jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_listing bigint := nullif(payload ->> 'listing_id', '')::bigint;
  v_kind text := coalesce(payload ->> 'kind', 'other');
  v_name text;
begin
  if coalesce(payload ->> 'website_hp', '') <> '' then
    return jsonb_build_object('ok', true);
  end if;
  if v_kind not in ('wrong_number', 'wrong_info', 'closed', 'removal', 'abuse', 'other') then
    v_kind := 'other';
  end if;
  if v_listing is null and char_length(coalesce(payload ->> 'details', '')) < 5 then
    return jsonb_build_object('ok', false, 'error', 'details');
  end if;
  if not private.allow('report', 10, interval '1 hour') then
    return jsonb_build_object('ok', false, 'error', 'rate');
  end if;
  select name into v_name from public.listings where id = v_listing;
  insert into public.reports (listing_id, listing_name, kind, details, contact)
  values (case when v_name is null then null else v_listing end, v_name, v_kind,
          nullif(left(btrim(payload ->> 'details'), 1000), ''),
          nullif(left(btrim(payload ->> 'contact'), 60), ''));
  insert into public.daily_stats (kind, count) values ('report', 1)
    on conflict (day, kind) do update set count = daily_stats.count + 1;
  return jsonb_build_object('ok', true);
end $$;

-- عدّاد التفاعل: view | call | whatsapp | map | share | visit
create or replace function public.track(lid bigint, ev text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if ev not in ('view', 'call', 'whatsapp', 'map', 'share', 'visit') then return; end if;
  if not private.allow('track', 240, interval '1 hour') then return; end if;
  insert into public.daily_stats as ds (kind, count) values (ev, 1)
    on conflict on constraint daily_stats_pkey do update set count = ds.count + 1;
  if ev = 'visit' or lid is null then return; end if;
  if not exists (select 1 from public.listings where id = lid and status = 'approved') then return; end if;
  insert into public.listing_stats as s (listing_id, views, calls, whatsapp, maps, shares)
  values (lid,
          (ev = 'view')::int, (ev = 'call')::int, (ev = 'whatsapp')::int,
          (ev = 'map')::int, (ev = 'share')::int)
  on conflict (listing_id) do update set
    views    = s.views    + (ev = 'view')::int,
    calls    = s.calls    + (ev = 'call')::int,
    whatsapp = s.whatsapp + (ev = 'whatsapp')::int,
    maps     = s.maps     + (ev = 'map')::int,
    shares   = s.shares   + (ev = 'share')::int,
    last_at  = now();
end $$;

-- تسجيل عبارات البحث (لمعرفة ما يبحث عنه الناس وما لا يجدونه)
create or replace function public.log_search(q text, results int)
returns void language plpgsql security definer set search_path = public as $$
declare t text := lower(btrim(regexp_replace(coalesce(q, ''), '\s+', ' ', 'g')));
begin
  if char_length(t) < 2 or char_length(t) > 50 then return; end if;
  if not private.allow('search', 120, interval '1 hour') then return; end if;
  insert into public.search_terms as s (term, hits, misses)
  values (t, 1, (results = 0)::int)
  on conflict (term) do update set
    hits = s.hits + 1,
    misses = s.misses + (results = 0)::int,
    last_at = now();
  insert into public.daily_stats (kind, count) values ('search', 1)
    on conflict (day, kind) do update set count = daily_stats.count + 1;
end $$;

-- ───────────────────────── الإدارة ─────────────────────────

create or replace function public.admin_me()
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce((select jsonb_build_object('email', email, 'role', role) from public.admins where user_id = auth.uid()), 'null'::jsonb);
$$;

create or replace function public.admin_stats()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare r jsonb;
begin
  if not public.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  select jsonb_build_object(
    'approved', (select count(*) from listings where status = 'approved'),
    'pending',  (select count(*) from listings where status = 'pending'),
    'hidden',   (select count(*) from listings where status = 'hidden'),
    'rejected', (select count(*) from listings where status = 'rejected'),
    'reports_open', (select count(*) from reports where status = 'open'),
    'no_phone', (select count(*) from listings where status = 'approved' and cardinality(phones) = 0),
    'no_location', (select count(*) from listings where status = 'approved' and lat is null and coalesce(map_url, '') = ''),
    'no_area', (select count(*) from listings where status = 'approved' and area is null),
    'days', coalesce((
      select jsonb_agg(jsonb_build_object('day', d.day, 'kind', d.kind, 'count', d.count) order by d.day)
      from daily_stats d where d.day > current_date - 30
    ), '[]'::jsonb),
    'top', coalesce((
      select jsonb_agg(t) from (
        select l.id, l.name, s.views, s.calls, s.whatsapp, s.maps, s.shares
        from listing_stats s join listings l on l.id = s.listing_id
        order by (s.calls + s.whatsapp) desc, s.views desc limit 15
      ) t
    ), '[]'::jsonb),
    'misses', coalesce((
      select jsonb_agg(t) from (
        select term, hits, misses, last_at from search_terms where misses > 0
        order by misses desc, last_at desc limit 25
      ) t
    ), '[]'::jsonb),
    'searches', coalesce((
      select jsonb_agg(t) from (
        select term, hits, misses from search_terms order by hits desc limit 25
      ) t
    ), '[]'::jsonb)
  ) into r;
  return r;
end $$;

-- إنشاء حساب مشرف جديد (للمالك فقط)
create or replace function public.admin_create_user(p_email text, p_password text, p_role text default 'editor')
returns uuid language plpgsql security definer set search_path = public, extensions, auth as $$
declare uid uuid;
begin
  if not public.is_owner() then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_role not in ('owner', 'editor') then raise exception 'bad role'; end if;
  if char_length(p_password) < 10 then raise exception 'weak password'; end if;
  p_email := lower(btrim(p_email));
  select id into uid from auth.users where email = p_email;
  if uid is null then
    uid := gen_random_uuid();
    insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
                            raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
                            confirmation_token, recovery_token, email_change_token_new, email_change,
                            email_change_token_current, phone_change, phone_change_token, reauthentication_token)
    values ('00000000-0000-0000-0000-000000000000', uid, 'authenticated', 'authenticated', p_email,
            crypt(p_password, gen_salt('bf')), now(),
            '{"provider":"email","providers":["email"]}', '{}', now(), now(),
            '', '', '', '', '', '', '', '');
    insert into auth.identities (id, user_id, provider_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
    values (gen_random_uuid(), uid, uid::text,
            jsonb_build_object('sub', uid::text, 'email', p_email, 'email_verified', true),
            'email', now(), now(), now());
  end if;
  insert into public.admins (user_id, email, role) values (uid, p_email, p_role)
    on conflict (user_id) do update set role = excluded.role;
  return uid;
end $$;

-- المالك يدير حسابات المشرفين مباشرة عبر الجدول (الحذف والدمج يتمّان من لوحة الإدارة عبر RLS)
create policy "owners manage admins" on public.admins for all to authenticated
  using (public.is_owner()) with check (public.is_owner());

-- ───────────────────────── الصلاحيات ─────────────────────────

revoke execute on all functions in schema public from public, anon;
grant execute on function public.sync(timestamptz) to anon, authenticated;
grant execute on function public.submit_listing(jsonb) to anon, authenticated;
grant execute on function public.submit_report(jsonb) to anon, authenticated;
grant execute on function public.track(bigint, text) to anon, authenticated;
grant execute on function public.log_search(text, int) to anon, authenticated;
grant execute on function public.normalize_phone(text) to anon, authenticated;
grant execute on function public.is_admin() to authenticated;
grant execute on function public.is_owner() to authenticated;
grant execute on function public.admin_me() to authenticated;
grant execute on function public.admin_stats() to authenticated;
grant execute on function public.admin_create_user(text, text, text) to authenticated;

alter default privileges in schema public revoke execute on functions from public, anon;

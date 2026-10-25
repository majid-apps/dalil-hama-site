-- دليل حماة — دوال مُحدَّثة بعد المراجعة الشاملة

-- حساب موجود مسبقاً يُعاد إلى حالة معروفة: كلمة المرور الجديدة + تأكيد البريد + إبطال جلساته السابقة
-- (يمنع الاستيلاء على حساب مشرف عبر تسجيل البريد نفسه مسبقاً)
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
  else
    if uid = auth.uid() then raise exception 'use the change-password form for your own account'; end if;
    update auth.users
       set encrypted_password = crypt(p_password, gen_salt('bf')),
           email_confirmed_at = coalesce(email_confirmed_at, now()),
           confirmation_token = '', recovery_token = '',
           updated_at = now()
     where id = uid;
    update auth.refresh_tokens set revoked = true, updated_at = now()
     where user_id = uid::text and not revoked;
  end if;
  insert into public.admins (user_id, email, role) values (uid, p_email, p_role)
    on conflict (user_id) do update set role = excluded.role;
  return uid;
end $$;

-- تنظيف روابط الزوار، وفحص التكرار على الرقمين
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
  select id into v_dup from public.listings
   where phones && array_remove(array[v_phone, v_phone2], null) and status in ('approved', 'pending') limit 1;

  insert into public.listings (name, category_id, phones, area, address, map_url, website, description,
                               status, source, submitter_name, submitter_phone, admin_note)
  values (
    v_name, v_cat,
    array_remove(array[v_phone, nullif(v_phone2, v_phone)], null),
    nullif(left(btrim(payload ->> 'area'), 60), ''),
    nullif(left(btrim(payload ->> 'address'), 400), ''),
    private.clean_url(payload ->> 'map_url', 1200),
    private.clean_url(payload ->> 'website', 300),
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

-- التفاعل نفسه من الجهاز نفسه على النشاط نفسه يُحتسب مرة واحدة يومياً
-- (يمنع رفع ترتيب نشاط في «الأكثر تواصلاً» بتكرار الطلبات)
create or replace function public.track(lid bigint, ev text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if ev not in ('view', 'call', 'whatsapp', 'map', 'share', 'visit') then return; end if;
  if not private.allow('track', 240, interval '1 hour') then return; end if;
  if ev = 'visit' or lid is null then
    insert into public.daily_stats as ds (kind, count) values (ev, 1)
      on conflict on constraint daily_stats_pkey do update set count = ds.count + 1;
    return;
  end if;
  if not exists (select 1 from public.listings where id = lid and status = 'approved') then return; end if;
  insert into private.track_seen (client, listing_id, ev) values (private.client_key(), lid, ev)
    on conflict do nothing;
  if not found then return; end if;
  insert into public.daily_stats as ds (kind, count) values (ev, 1)
    on conflict on constraint daily_stats_pkey do update set count = ds.count + 1;
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

revoke execute on function public.admin_create_user(text, text, text) from public, anon;
grant execute on function public.admin_create_user(text, text, text) to authenticated;
revoke execute on function public.submit_listing(jsonb) from public;
grant execute on function public.submit_listing(jsonb) to anon, authenticated;
revoke execute on function public.track(bigint, text) from public;
grant execute on function public.track(bigint, text) to anon, authenticated;

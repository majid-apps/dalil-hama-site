-- دليل حماة — إصلاحات التدقيق (10 تشرين الثاني 2026)

-- 1) تنظيف private.track_seen: كان ينمو بلا حدّ (صف لكل تفاعل لكل زائر كل يوم)
create or replace function public.track(lid bigint, ev text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if ev not in ('view', 'call', 'whatsapp', 'map', 'share', 'visit') then return; end if;
  if not private.allow('track', 240, interval '1 hour') then return; end if;
  if random() < 0.01 then
    delete from private.track_seen where day < current_date - 3;
  end if;
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
revoke execute on function public.track(bigint, text) from public;
grant execute on function public.track(bigint, text) to anon, authenticated;

-- 2) قفل الدخول: الحدّ لكل IP (8) يكفي؛ الحدّ العام كان يسمح لأي شخص بإبعاد المدير (60 → 300)
create or replace function public.admin_login_hint(p_password text)
returns text language plpgsql volatile security definer
set search_path = public, extensions, auth
as $$
declare hdr jsonb; v_ip text; v_email text;
begin
  begin hdr := nullif(current_setting('request.headers', true), '')::jsonb;
  exception when others then hdr := null; end;
  v_ip := btrim(coalesce(split_part(coalesce(hdr ->> 'x-forwarded-for', hdr ->> 'x-real-ip', ''), ',', 1), ''));
  delete from public.admin_login_fail where at < now() - interval '1 day';
  if (select count(*) from public.admin_login_fail where ip = v_ip and at > now() - interval '15 minutes') >= 8
     or (select count(*) from public.admin_login_fail where at > now() - interval '15 minutes') >= 300 then
    raise exception 'too_many_attempts' using errcode = 'P0001';
  end if;
  if p_password is null or char_length(p_password) < 1 or char_length(p_password) > 200 then
    insert into public.admin_login_fail (ip) values (v_ip); return null;
  end if;
  select a.email into v_email from public.admins a join auth.users u on u.id = a.user_id
   where u.encrypted_password = crypt(p_password, u.encrypted_password)
   order by (a.role = 'owner') desc, a.created_at limit 1;
  if v_email is null then insert into public.admin_login_fail (ip) values (v_ip); end if;
  return v_email;
end $$;
revoke all on function public.admin_login_hint(text) from public;
grant execute on function public.admin_login_hint(text) to anon, authenticated;

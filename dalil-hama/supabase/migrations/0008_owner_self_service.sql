-- دليل حماة — تعديل صاحب النشاط لبطاقته بنفسه (أو حذفها) بعد التحقق برمز واتساب
-- التدفق: owner_request_code ← (رمز على واتساب البطاقة نفسه) ← owner_verify_code ← جلسة قصيرة ← owner_update / owner_delete
-- تغيير الرقم يحتاج رمزاً ثانياً على الرقم الجديد (owner_request_code مع الجلسة) حتى لا يُسحب النشاط إلى رقم غير مملوك.
-- الميزة مغلقة افتراضياً: تُفتح بتغيير settings.owner_edit.enabled إلى true (يتطلب خدمة إرسال واتساب تقرأ private.wa_outbox).

insert into public.settings (key, value, is_public) values ('owner_edit', '{"enabled":false}', true)
  on conflict (key) do nothing;

create table if not exists private.owner_codes (
  id         bigint generated always as identity primary key,
  listing_id bigint not null,
  kind       text not null check (kind in ('auth', 'phone')),
  phone      text not null,
  code_hash  text not null,
  tries      int not null default 0,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index if not exists owner_codes_listing_idx on private.owner_codes (listing_id, created_at);
create index if not exists owner_codes_phone_idx on private.owner_codes (phone, created_at);

create table if not exists private.owner_sessions (
  token_hash      text primary key,
  listing_id      bigint not null,
  verified_phones text[] not null default '{}',
  expires_at      timestamptz not null
);

-- صندوق الإرسال: خدمة الإرسال على السيرفر تأخذ الصفوف غير المرسلة وتحذفها بعد الإرسال
create table if not exists private.wa_outbox (
  id         bigint generated always as identity primary key,
  to_phone   text not null,
  code       text not null,
  created_at timestamptz not null default now(),
  sent_at    timestamptz,
  error      text
);
create index if not exists wa_outbox_pending_idx on private.wa_outbox (id) where sent_at is null;

create or replace function private.hash(t text)
returns text language sql immutable set search_path = '' as $$
  select encode(extensions.digest(coalesce(t, ''), 'sha256'), 'hex');
$$;

create or replace function private.owner_enabled()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select (value ->> 'enabled')::boolean from public.settings where key = 'owner_edit'), false);
$$;

-- طلب رمز: بلا وسائط إضافية = رمز دخول على واتساب البطاقة، ومع new_phone والجلسة = رمز تحقق من رقم جديد
create or replace function public.owner_request_code(lid bigint, new_phone text default null, token text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  l public.listings;
  v_kind text := case when new_phone is null then 'auth' else 'phone' end;
  v_to text;
  v_code text;
begin
  if not private.owner_enabled() then return jsonb_build_object('ok', false, 'error', 'disabled'); end if;
  if not private.allow('ocode', 6, interval '1 hour') then return jsonb_build_object('ok', false, 'error', 'rate'); end if;
  if random() < 0.05 then
    delete from private.owner_codes where created_at < now() - interval '1 day';
    delete from private.owner_sessions where expires_at < now();
    delete from private.wa_outbox where created_at < now() - interval '1 day';
  end if;
  select * into l from public.listings where id = lid and status = 'approved';
  if not found then return jsonb_build_object('ok', false, 'error', 'unavailable'); end if;

  if v_kind = 'auth' then
    v_to := public.normalize_phone(coalesce(nullif(l.whatsapp, ''), (select p from unnest(l.phones) p where p ~ '^09\d{8}$' limit 1)));
  else
    if not exists (select 1 from private.owner_sessions
                   where listing_id = lid and token_hash = private.hash(token) and expires_at > now()) then
      return jsonb_build_object('ok', false, 'error', 'session');
    end if;
    v_to := public.normalize_phone(new_phone);
    if exists (select 1 from public.listings where id <> lid and phones @> array[v_to] and status in ('approved', 'pending')) then
      return jsonb_build_object('ok', false, 'error', 'dup');
    end if;
  end if;
  if v_to is null or v_to !~ '^09\d{8}$' then
    return jsonb_build_object('ok', false, 'error', case when v_kind = 'auth' then 'no_mobile' else 'phone' end);
  end if;
  -- حد لكل نشاط ولكل رقم حتى لا تُغرَق رسائل صاحب الرقم من عناوين مختلفة
  if (select count(*) from private.owner_codes where listing_id = lid and created_at > now() - interval '1 hour') >= 5
     or (select count(*) from private.owner_codes where phone = v_to and created_at > now() - interval '1 hour') >= 5 then
    return jsonb_build_object('ok', false, 'error', 'rate');
  end if;

  delete from private.owner_codes where listing_id = lid and kind = v_kind;
  v_code := lpad((('x' || encode(extensions.gen_random_bytes(4), 'hex'))::bit(32)::bigint % 1000000)::text, 6, '0');
  insert into private.owner_codes (listing_id, kind, phone, code_hash, expires_at)
    values (lid, v_kind, v_to, private.hash(v_code || ':' || lid || ':' || v_to), now() + interval '10 minutes');
  insert into private.wa_outbox (to_phone, code) values ('963' || substr(v_to, 2), v_code);
  return jsonb_build_object('ok', true, 'masked', left(v_to, 4) || ' ••• ' || right(v_to, 3));
end $$;

-- التحقق من الرمز: بلا token = دخول (يعيد جلسة)، ومع token = توثيق رقم جديد داخل الجلسة
create or replace function public.owner_verify_code(lid bigint, code text, token text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  c private.owner_codes;
  v_kind text := case when token is null then 'auth' else 'phone' end;
  v_tok text;
begin
  if not private.owner_enabled() then return jsonb_build_object('ok', false, 'error', 'disabled'); end if;
  if not private.allow('overify', 30, interval '1 hour') then return jsonb_build_object('ok', false, 'error', 'rate'); end if;
  if v_kind = 'phone' and not exists (select 1 from private.owner_sessions
       where listing_id = lid and token_hash = private.hash(token) and expires_at > now()) then
    return jsonb_build_object('ok', false, 'error', 'session');
  end if;
  select * into c from private.owner_codes
   where listing_id = lid and kind = v_kind and expires_at > now() order by id desc limit 1 for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'expired'); end if;
  if c.tries >= 5 then
    delete from private.owner_codes where id = c.id;
    return jsonb_build_object('ok', false, 'error', 'locked');
  end if;
  if c.code_hash <> private.hash(regexp_replace(coalesce(code, ''), '\D', '', 'g') || ':' || lid || ':' || c.phone) then
    update private.owner_codes set tries = tries + 1 where id = c.id;
    return jsonb_build_object('ok', false, 'error', 'wrong', 'left', 4 - c.tries);
  end if;
  delete from private.owner_codes where id = c.id;
  if v_kind = 'auth' then
    v_tok := encode(extensions.gen_random_bytes(24), 'hex');
    insert into private.owner_sessions (token_hash, listing_id, expires_at)
      values (private.hash(v_tok), lid, now() + interval '30 minutes');
    return jsonb_build_object('ok', true, 'token', v_tok);
  end if;
  update private.owner_sessions set verified_phones = array_append(verified_phones, c.phone)
   where listing_id = lid and token_hash = private.hash(token);
  return jsonb_build_object('ok', true, 'phone', c.phone);
end $$;

create or replace function public.owner_get(lid bigint, token text)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare l public.listings;
begin
  if not private.owner_enabled() then return jsonb_build_object('ok', false, 'error', 'disabled'); end if;
  if not exists (select 1 from private.owner_sessions
       where listing_id = lid and token_hash = private.hash(token) and expires_at > now()) then
    return jsonb_build_object('ok', false, 'error', 'session');
  end if;
  select * into l from public.listings where id = lid;
  if not found then return jsonb_build_object('ok', false, 'error', 'unavailable'); end if;
  return jsonb_build_object('ok', true, 'name', l.name, 'phone', l.phones[1], 'address', coalesce(l.address, ''),
    'map_url', coalesce(l.map_url, ''), 'website', coalesce(l.website, ''));
end $$;

create or replace function public.owner_update(lid bigint, token text, payload jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  l public.listings;
  v_vp text[];
  v_name text := btrim(regexp_replace(coalesce(payload ->> 'name', ''), '\s+', ' ', 'g'));
  v_addr text := nullif(left(btrim(coalesce(payload ->> 'address', '')), 400), '');
  v_map text := private.clean_url(payload ->> 'map_url', 1200);
  v_web text := private.clean_url(payload ->> 'website', 300);
  v_phone text := public.normalize_phone(payload ->> 'phone');
  v_phones text[];
  v_whatsapp text;
  v_nowa boolean;
  v_note text;
  v_diff jsonb := '{}'::jsonb;
begin
  if not private.owner_enabled() then return jsonb_build_object('ok', false, 'error', 'disabled'); end if;
  if not private.allow('oupdate', 20, interval '1 hour') then return jsonb_build_object('ok', false, 'error', 'rate'); end if;
  select verified_phones into v_vp from private.owner_sessions
   where listing_id = lid and token_hash = private.hash(token) and expires_at > now();
  if not found then return jsonb_build_object('ok', false, 'error', 'session'); end if;
  select * into l from public.listings where id = lid for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'unavailable'); end if;

  if char_length(v_name) < 2 or char_length(v_name) > 160 then return jsonb_build_object('ok', false, 'error', 'name'); end if;
  if btrim(coalesce(payload ->> 'map_url', '')) <> '' and v_map is null then return jsonb_build_object('ok', false, 'error', 'map_url'); end if;
  if btrim(coalesce(payload ->> 'website', '')) <> '' and v_web is null then return jsonb_build_object('ok', false, 'error', 'website'); end if;
  if v_phone is null or length(regexp_replace(v_phone, '\D', '', 'g')) < 7 then return jsonb_build_object('ok', false, 'error', 'phone'); end if;

  v_phones := l.phones; v_whatsapp := l.whatsapp; v_nowa := l.no_whatsapp;
  if v_phone is distinct from l.phones[1] then
    -- رقم جديد: لا يقبل إلا بعد التحقق منه على واتساب (أو كان أصلاً ضمن أرقام النشاط)
    if not (v_phone = any (l.phones) or v_phone = any (v_vp)) then
      return jsonb_build_object('ok', false, 'error', 'phone_verify');
    end if;
    if exists (select 1 from public.listings where id <> lid and phones @> array[v_phone] and status in ('approved', 'pending')) then
      return jsonb_build_object('ok', false, 'error', 'dup');
    end if;
    v_phones := array[v_phone] || array_remove(l.phones[2:], v_phone);
    if v_phone = any (v_vp) then v_whatsapp := null; v_nowa := false; end if;
  end if;

  if v_name is distinct from l.name then v_diff := v_diff || jsonb_build_object('name', jsonb_build_array(l.name, v_name)); end if;
  if v_phones is distinct from l.phones then v_diff := v_diff || jsonb_build_object('phones', jsonb_build_array(l.phones, v_phones)); end if;
  if v_addr is distinct from l.address then v_diff := v_diff || jsonb_build_object('address', jsonb_build_array(l.address, v_addr)); end if;
  if v_map is distinct from l.map_url then v_diff := v_diff || jsonb_build_object('map_url', jsonb_build_array(l.map_url, v_map)); end if;
  if v_web is distinct from l.website then v_diff := v_diff || jsonb_build_object('website', jsonb_build_array(l.website, v_web)); end if;
  if v_diff = '{}'::jsonb then return jsonb_build_object('ok', true, 'changed', false); end if;

  select string_agg(x, E'\n') into v_note from unnest(string_to_array(coalesce(l.admin_note, ''), E'\n')) x
   where x <> '' and x not like '✏️%';
  v_note := concat_ws(E'\n', v_note, '✏️ عدّله صاحبه ' || to_char(now(), 'YYYY-MM-DD'));

  update public.listings set
    name = v_name, phones = v_phones, whatsapp = v_whatsapp, no_whatsapp = v_nowa,
    address = v_addr, map_url = v_map, website = v_web,
    lat = case when v_map is not null and v_map is distinct from l.map_url then null else l.lat end,
    lng = case when v_map is not null and v_map is distinct from l.map_url then null else l.lng end,
    admin_note = v_note
   where id = lid;
  insert into public.audit_log (user_id, action, listing_id, listing_name, changes)
    values (null, 'owner_update', lid, v_name, v_diff);
  return jsonb_build_object('ok', true, 'changed', true);
end $$;

create or replace function public.owner_delete(lid bigint, token text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare l public.listings;
begin
  if not private.owner_enabled() then return jsonb_build_object('ok', false, 'error', 'disabled'); end if;
  if not private.allow('odelete', 10, interval '1 hour') then return jsonb_build_object('ok', false, 'error', 'rate'); end if;
  if not exists (select 1 from private.owner_sessions
       where listing_id = lid and token_hash = private.hash(token) and expires_at > now()) then
    return jsonb_build_object('ok', false, 'error', 'session');
  end if;
  select * into l from public.listings where id = lid for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'unavailable'); end if;
  insert into public.audit_log (user_id, action, listing_id, listing_name, changes)
    values (null, 'owner_delete', lid, l.name, to_jsonb(l) - 'updated_at');
  delete from public.listings where id = lid;
  delete from private.owner_sessions where listing_id = lid;
  delete from private.owner_codes where listing_id = lid;
  return jsonb_build_object('ok', true);
end $$;

revoke execute on function public.owner_request_code(bigint, text, text) from public;
revoke execute on function public.owner_verify_code(bigint, text, text) from public;
revoke execute on function public.owner_get(bigint, text) from public;
revoke execute on function public.owner_update(bigint, text, jsonb) from public;
revoke execute on function public.owner_delete(bigint, text) from public;
grant execute on function public.owner_request_code(bigint, text, text) to anon, authenticated;
grant execute on function public.owner_verify_code(bigint, text, text) to anon, authenticated;
grant execute on function public.owner_get(bigint, text) to anon, authenticated;
grant execute on function public.owner_update(bigint, text, jsonb) to anon, authenticated;
grant execute on function public.owner_delete(bigint, text) to anon, authenticated;

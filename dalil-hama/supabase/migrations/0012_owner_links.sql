-- دليل حماة — رابط شخصي لصاحب الرقم في «رسالة الموافقة»: «موافق، انشروا» أو «الرقم خطأ / لا أريد النشر» بضغطة واحدة دون انتظار المدير.
-- الإثبات: الرابط لا يصل إلا إلى صاحب الرقم عبر واتساب. الرمز عشوائي 128 بت، يأتي بعد # فلا يصل إلى سجلات الخادم،
-- ولا ينفّذ شيئاً إلا بضغط زر (فمعاينة الروابط في واتساب لا تغيّر شيئاً). تولّده الإدارة عند فتح واتساب وتسجّله هنا.
-- «موافق» تنشر المرشح. «الرقم خطأ» تستبعد الرقم نهائياً كاستبعاد المدير تماماً (ويرفض المرشح)، ويمكن للمدير التراجع بـ«إعادة الرقم لبطاقته».
-- ومن وافق ثم غيّر رأيه يستطيع من الرابط نفسه إزالة رقمه لاحقاً.

create table if not exists public.owner_links (
  token      text primary key check (token ~ '^[A-Za-z0-9_-]{22}$'),
  listing_id bigint not null references public.listings(id) on delete cascade,
  phone      text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '60 days',
  used_at    timestamptz,
  action     text check (action in ('approve', 'reject'))
);
create index if not exists owner_links_listing_idx on public.owner_links (listing_id);
alter table public.owner_links enable row level security;
revoke all on public.owner_links from anon;
drop policy if exists "admins read owner links" on public.owner_links;
create policy "admins read owner links" on public.owner_links for select to authenticated using (public.is_admin());
grant select on public.owner_links to authenticated;

-- الاستبعاد نفسه في مكان واحد: يستعمله المدير (admin_exclude) وصاحب الرقم (owner_action)
-- p_owner (رفض صاحب الرقم): تُرفض البطاقة إن كانت مرشحة، أو لم يبقَ فيها رقم ولو بقي عنوانها أو موقعها
-- (فلا يبقى اسم شخص منشوراً بلا رقمه)؛ وبطاقة فيها أرقام أخرى تبقى كما هي
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
  return ids;
end $$;
revoke all on function private.exclude_phone(text, text, boolean, text) from public;

-- استبعاد المدير: السلوك نفسه كما في 0011
create or replace function public.admin_exclude(p_phones text[], p_note text default null)
returns bigint[] language plpgsql security definer set search_path = public as $$
declare
  p text;
  ids bigint[] := '{}';
begin
  if not public.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  foreach p in array coalesce(p_phones, '{}') loop
    ids := ids || private.exclude_phone(public.normalize_phone(p), p_note);
  end loop;
  return ids;
end $$;
grant execute on function public.admin_exclude(text[], text) to authenticated;

-- الإدارة: تسجيل الرمز الذي وضعته في رسالة الموافقة لحظة فتح واتساب
create or replace function public.admin_owner_link(p_listing bigint, p_phone text, p_token text)
returns boolean language plpgsql security definer set search_path = public as $$
declare n text := public.normalize_phone(p_phone);
begin
  if not public.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  if coalesce(p_token, '') !~ '^[A-Za-z0-9_-]{22}$' then raise exception 'رمز غير صالح'; end if;
  if not exists (select 1 from public.listings where id = p_listing and n = any(phones)) then
    raise exception 'الرقم ليس في هذه البطاقة';
  end if;
  insert into public.owner_links (token, listing_id, phone) values (p_token, p_listing, n) on conflict (token) do nothing;
  return true;
end $$;
grant execute on function public.admin_owner_link(bigint, text, text) to authenticated;

-- صفحة صاحب الرقم: ما يعرضه الرابط (اسم النشاط ورقمه وحالته فقط)
create or replace function public.owner_link_info(p_token text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  k public.owner_links;
  l record;
begin
  if not private.allow('owner', 120, interval '1 hour') then return jsonb_build_object('ok', false, 'error', 'rate'); end if;
  select * into k from public.owner_links where token = p_token;
  if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  select x.id, x.name, x.status, x.phones, c.name as cat into l
    from public.listings x left join public.categories c on c.id = x.category_id where x.id = k.listing_id;
  if not found then return jsonb_build_object('ok', false, 'error', 'gone'); end if;
  return jsonb_build_object('ok', true, 'id', l.id, 'name', l.name, 'category', l.cat, 'phone', k.phone,
    'published', l.status = 'approved', 'in_card', k.phone = any(l.phones), 'action', k.action, 'expired', k.expires_at < now());
end $$;
grant execute on function public.owner_link_info(text) to anon, authenticated;

-- صفحة صاحب الرقم: تنفيذ الاختيار. «موافق» مرة واحدة؛ و«الرقم خطأ» نهائي، ومتاح أيضاً بعد «موافق» (سحب الموافقة)
create or replace function public.owner_action(p_token text, p_action text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  k public.owner_links;
  l record;
begin
  if not private.allow('owner', 120, interval '1 hour') then return jsonb_build_object('ok', false, 'error', 'rate'); end if;
  if p_action is null or p_action not in ('approve', 'reject') then return jsonb_build_object('ok', false, 'error', 'bad_action'); end if;
  select * into k from public.owner_links where token = p_token for update;
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
  update public.owner_links set used_at = now(), action = p_action where token = p_token;
  return jsonb_build_object('ok', true, 'action', p_action, 'id', l.id);
end $$;
grant execute on function public.owner_action(text, text) to anon, authenticated;

-- دفاع إضافي: «alter default privileges in schema public revoke … from public» في 0002 لا يمنع شيئاً
-- (المنح الافتراضي للجميع عام لا يُلغى لمخطط واحد)، فدوال الإدارة المضافة بعده قابلة للاستدعاء من الزائر
-- ويحميها فحص is_admin داخلها وحده. هنا تُسحب صراحةً من الزائر ومن الجميع.
revoke execute on function public.admin_owner_link(bigint, text, text) from public, anon;
revoke execute on function public.admin_exclude(text[], text) from public, anon;
revoke execute on function public.admin_restore_phone(text) from public, anon;

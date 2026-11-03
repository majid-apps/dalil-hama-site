-- دليل حماة — استرجاع رقم مستبعد إلى بطاقته مباشرة (للرقم الذي استُبعد خطأً)
-- نسجّل مع كل استبعاد البطاقات التي حُذف منها الرقم وحالتها قبل الحذف، ثم تعيدها admin_restore_phone.

alter table public.excluded_phones add column if not exists removed_from jsonb not null default '[]'::jsonb;

create or replace function public.admin_exclude(p_phones text[], p_note text default null)
returns bigint[] language plpgsql security definer set search_path = public as $$
declare
  p text;
  n text;
  ids bigint[] := '{}';
  l record;
  left_phones text[];
  rec jsonb;
  stamp text := E'\n⛔ استُبعد رقم نهائياً ' || current_date;
begin
  if not public.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  foreach p in array coalesce(p_phones, '{}') loop
    n := public.normalize_phone(p);
    if n is null or n = '' then continue; end if;
    insert into public.excluded_phones (phone, name, note)
    values (n, (select x.name from public.listings x where n = any(x.phones) order by (x.status = 'approved') desc, x.id limit 1), nullif(left(btrim(coalesce(p_note, '')), 300), ''))
    on conflict (phone) do update set note = coalesce(excluded.note, public.excluded_phones.note);
    rec := '[]'::jsonb;
    for l in select * from public.listings where n = any(phones) loop
      left_phones := array(select q from unnest(l.phones) q where public.normalize_phone(q) is distinct from n);
      rec := rec || jsonb_build_array(jsonb_build_object('id', l.id, 'status', l.status, 'wa', public.normalize_phone(l.whatsapp) = n));
      update public.listings
         set phones = left_phones,
             whatsapp = case when public.normalize_phone(whatsapp) = n then null else whatsapp end,
             status = case when l.status <> 'rejected' and cardinality(left_phones) = 0
                            and l.lat is null and coalesce(l.map_url, '') = '' and coalesce(btrim(l.address), '') = ''
                           then 'rejected' else l.status end,
             admin_note = btrim(coalesce(admin_note, '') || stamp, E'\n')
       where id = l.id;
      ids := ids || l.id;
    end loop;
    update public.excluded_phones set removed_from = removed_from || rec where phone = n;
  end loop;
  return ids;
end $$;
grant execute on function public.admin_exclude(text[], text) to authenticated;

-- استرجاع: يحذف الرقم من القائمة ويعيده إلى البطاقات التي أُخذ منها (وحالتها السابقة إن كانت رُفضت بسببه)
create or replace function public.admin_restore_phone(p_phone text)
returns bigint[] language plpgsql security definer set search_path = public as $$
declare
  n text := public.normalize_phone(p_phone);
  ex record;
  e jsonb;
  l record;
  ids bigint[] := '{}';
begin
  if not public.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  select * into ex from public.excluded_phones where phone = n;
  if not found then return ids; end if;
  delete from public.excluded_phones where phone = n;  -- أولاً، حتى لا يمنع الحارس إعادة النشر
  for e in select * from jsonb_array_elements(ex.removed_from) loop
    select * into l from public.listings where id = (e->>'id')::bigint;
    if not found then continue; end if;
    update public.listings
       set phones = case when n = any(phones) then phones else phones || n end,
           whatsapp = case when whatsapp is null and (e->>'wa')::boolean then n else whatsapp end,
           status = case when l.status = 'rejected' and (e->>'status') in ('approved', 'pending') then e->>'status' else l.status end,
           admin_note = btrim(coalesce(admin_note, '') || E'\n↩️ أُعيد رقم مستبعد ' || current_date, E'\n')
     where id = l.id;
    ids := ids || l.id;
  end loop;
  return ids;
end $$;
grant execute on function public.admin_restore_phone(text) to authenticated;

-- دليل حماة — الاستبعاد يخص الرقم المحدد فقط
-- يُحذف الرقم من كل بطاقة تحمله وتبقى البطاقة بحالتها إن كان فيها رقم آخر (جوال أو أرضي) أو موقع أو عنوان.
-- وإن لم يبقَ فيها شيء من ذلك تُرفض (وتبقى محفوظة للمراجعة).

drop function if exists public.admin_exclude(text[], text);

create or replace function public.admin_exclude(p_phones text[], p_note text default null)
returns bigint[] language plpgsql security definer set search_path = public as $$
declare
  p text;
  n text;
  ids bigint[] := '{}';
  l record;
  left_phones text[];
  stamp text := E'\n⛔ استُبعد رقم نهائياً ' || current_date;
begin
  if not public.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  foreach p in array coalesce(p_phones, '{}') loop
    n := public.normalize_phone(p);
    if n is null or n = '' then continue; end if;
    insert into public.excluded_phones (phone, name, note)
    values (n, (select x.name from public.listings x where n = any(x.phones) order by (x.status = 'approved') desc, x.id limit 1), nullif(left(btrim(coalesce(p_note, '')), 300), ''))
    on conflict (phone) do update set note = coalesce(excluded.note, public.excluded_phones.note);
    for l in select * from public.listings where n = any(phones) loop
      left_phones := array(select q from unnest(l.phones) q where public.normalize_phone(q) is distinct from n);
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
  end loop;
  return ids;
end $$;
grant execute on function public.admin_exclude(text[], text) to authenticated;

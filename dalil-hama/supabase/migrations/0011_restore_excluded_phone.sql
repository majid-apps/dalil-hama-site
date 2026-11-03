-- دليل حماة — «إعادة الرقم لبطاقته»: استرجاع رقم استُبعد خطأً بضغطة واحدة
-- مع كل استبعاد يُسجَّل في removed_from لكل بطاقة حُذف منها الرقم: معرّفها، ومكان الرقم بين أرقامها،
-- وهل كان رقم واتسابها، وهل رفضها الاستبعاد نفسه (لم يبقَ فيها رقم ولا موقع ولا عنوان) وحالتها قبله.
-- ثم admin_restore_phone تزيل الرقم من القائمة وتعيده إلى تلك البطاقات كما كان.
-- ما استُبعد قبل هذا الملف ليس له سجل، فيبقى له «إعادة السماح» وحده.

alter table public.excluded_phones add column if not exists removed_from jsonb not null default '[]'::jsonb;

create or replace function public.admin_exclude(p_phones text[], p_note text default null)
returns bigint[] language plpgsql security definer set search_path = public as $$
declare
  p text;
  n text;
  ids bigint[] := '{}';
  l record;
  left_phones text[];
  rej boolean;
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
      rej := l.status <> 'rejected' and cardinality(left_phones) = 0
             and l.lat is null and coalesce(l.map_url, '') = '' and coalesce(btrim(l.address), '') = '';
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
  end loop;
  return ids;
end $$;
grant execute on function public.admin_exclude(text[], text) to authenticated;

-- الاسترجاع: يحذف الرقم من القائمة أولاً (كي لا يمنعه حارس الأرقام المستبعدة)، ثم يعيده إلى مكانه في كل بطاقة
-- ما زالت موجودة، ورقمَ واتساب إن كان كذلك وبقي فارغاً، وحالتها السابقة إن كان الاستبعاد هو الذي رفضها وما زالت مرفوضة.
create or replace function public.admin_restore_phone(p_phone text)
returns bigint[] language plpgsql security definer set search_path = public as $$
declare
  n text := public.normalize_phone(p_phone);
  src jsonb;
  e jsonb;
  l public.listings;
  pos integer;
  ids bigint[] := '{}';
begin
  if not public.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  delete from public.excluded_phones where phone = n returning removed_from into src;
  if not found then return ids; end if;
  for e in select value from jsonb_array_elements(coalesce(src, '[]'::jsonb)) loop
    select * into l from public.listings where id = (e ->> 'id')::bigint;
    if not found then continue; end if;
    pos := least(greatest(coalesce((e ->> 'pos')::integer, cardinality(l.phones) + 1), 1), cardinality(l.phones) + 1);
    update public.listings
       set phones = case when n = any(phones) then phones else phones[1:pos - 1] || n || phones[pos:] end,
           whatsapp = case when whatsapp is null and coalesce((e ->> 'wa')::boolean, false) then n else whatsapp end,
           status = case when status = 'rejected' and coalesce((e ->> 'rej')::boolean, false)
                              and (e ->> 'status') in ('approved', 'pending', 'hidden')
                         then (e ->> 'status')::public.listing_status else status end,
           admin_note = btrim(coalesce(admin_note, '') || E'\n↩️ أُعيد رقم مستبعد ' || current_date, E'\n')
     where id = l.id;
    ids := ids || l.id;
  end loop;
  return ids;
end $$;
grant execute on function public.admin_restore_phone(text) to authenticated;

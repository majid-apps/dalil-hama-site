-- دليل حماة — إصلاح بطاقات رُفضت كاملة بالاستبعاد القديم (migration 0008)
-- كان الاستبعاد الأول يرفض البطاقة كلها. الآن: يُحذف الرقم المستبعد وحده من البطاقة، وتعود إلى حالتها السابقة
-- إن بقي فيها رقم آخر (جوال أو أرضي) أو موقع أو عنوان. ومن لم يبقَ فيها شيء من ذلك تبقى مرفوضة.
do $$
declare
  l record;
  left_phones text[];
  prev text;
begin
  for l in select * from public.listings where status = 'rejected' and admin_note like '%⛔ مستبعد نهائياً%' loop
    left_phones := array(
      select q from unnest(l.phones) q
      where not exists (select 1 from public.excluded_phones e where e.phone = public.normalize_phone(q))
    );
    if cardinality(left_phones) = cardinality(l.phones) then continue; end if;
    if cardinality(left_phones) > 0 or l.lat is not null or coalesce(l.map_url, '') <> '' or coalesce(btrim(l.address), '') <> '' then
      select a.changes -> 'status' ->> 0 into prev
        from public.audit_log a
       where a.listing_id = l.id and a.action = 'update' and a.changes -> 'status' ->> 1 = 'rejected'
       order by a.created_at desc limit 1;
      update public.listings
         set phones = left_phones,
             whatsapp = case when exists (select 1 from public.excluded_phones e where e.phone = public.normalize_phone(whatsapp)) then null else whatsapp end,
             status = coalesce(nullif(prev, 'rejected'), 'approved')::public.listing_status,
             admin_note = replace(admin_note, '⛔ مستبعد نهائياً', '⛔ استُبعد رقم نهائياً')
       where id = l.id;
    end if;
  end loop;
end $$;

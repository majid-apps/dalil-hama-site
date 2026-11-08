-- دليل حماة — صاحب الرقم يدير بطاقته من رابطه الشخصي: تعديل (الاسم والعنوان والنبذة والرقم)، إبلاغ برسالة، أو حذف البطاقة.
-- نفس رابط 0012 (رمز عشوائي بعد # ولا شيء يتغير بطلب GET). الحذف = رفض البطاقة واستبعاد الرقم نهائياً (يمكن للمدير التراجع).

-- معلومات الرابط: تُضاف بيانات البطاقة ليعدّلها صاحبها
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
    'published', l.status = 'approved', 'in_card', k.phone = any(l.phones), 'action', k.action, 'expired', k.expires_at < now());
end $$;
grant execute on function public.owner_link_info(text) to anon, authenticated;

-- تعديل البطاقة من صاحب الرقم: الحقول المرسلة فقط (null = بلا تغيير). تغيير الرقم يبدّل رقمه هو دون غيره.
create or replace function public.owner_edit(p_token text, p_name text default null, p_address text default null,
                                             p_description text default null, p_phone text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  k public.owner_links;
  l record;
  v_name text := nullif(btrim(regexp_replace(coalesce(p_name, ''), '\s+', ' ', 'g')), '');
  v_addr text := nullif(btrim(p_address), '');
  v_desc text := nullif(btrim(p_description), '');
  v_phone text := public.normalize_phone(p_phone);
  v_note text := '';
begin
  if not private.allow('owner', 120, interval '1 hour') then return jsonb_build_object('ok', false, 'error', 'rate'); end if;
  select * into k from public.owner_links where token = p_token for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  if k.action = 'reject' then return jsonb_build_object('ok', false, 'error', 'removed'); end if;
  if k.expires_at < now() then return jsonb_build_object('ok', false, 'error', 'expired'); end if;
  select * into l from public.listings where id = k.listing_id for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'gone'); end if;
  if not (k.phone = any(l.phones)) then return jsonb_build_object('ok', false, 'error', 'phone_gone'); end if;
  if v_name is not null and (char_length(v_name) < 2 or char_length(v_name) > 160) then return jsonb_build_object('ok', false, 'error', 'name'); end if;
  if v_addr is not null and char_length(v_addr) > 300 then return jsonb_build_object('ok', false, 'error', 'address'); end if;
  if v_desc is not null and char_length(v_desc) > 600 then return jsonb_build_object('ok', false, 'error', 'description'); end if;
  if p_phone is not null and btrim(p_phone) <> '' then
    if length(regexp_replace(coalesce(v_phone, ''), '\D', '', 'g')) < 7 then return jsonb_build_object('ok', false, 'error', 'phone'); end if;
    if exists (select 1 from public.excluded_phones where phone = v_phone) then return jsonb_build_object('ok', false, 'error', 'phone_excluded'); end if;
    if v_phone <> k.phone then
      update public.listings set phones = array(select distinct case when q = k.phone then v_phone else q end from unnest(phones) q) where id = l.id;
      update public.owner_links set phone = v_phone where token = p_token;
      v_note := v_note || ' الرقم: ' || k.phone || ' ← ' || v_phone || '.';
    end if;
  else
    v_phone := k.phone;
  end if;
  update public.listings
     set name = coalesce(v_name, name),
         address = case when p_address is null then address else v_addr end,
         description = case when p_description is null then description else v_desc end,
         admin_note = btrim(coalesce(admin_note, '') || E'\n✏️ عدّل صاحب الرقم بطاقته من رابطه ' || current_date || v_note, E'\n')
   where id = l.id;
  return jsonb_build_object('ok', true, 'phone', v_phone);
end $$;
grant execute on function public.owner_edit(text, text, text, text, text) to anon, authenticated;

-- إبلاغ برسالة نصية من صاحب الرقم (يصل إلى «البلاغات» عند المدير)
create or replace function public.owner_report(p_token text, p_text text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  k public.owner_links;
  v_name text;
  v_text text := nullif(btrim(p_text), '');
begin
  if not private.allow('owner', 120, interval '1 hour') then return jsonb_build_object('ok', false, 'error', 'rate'); end if;
  if v_text is null or char_length(v_text) < 5 then return jsonb_build_object('ok', false, 'error', 'details'); end if;
  select * into k from public.owner_links where token = p_token;
  if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  if k.expires_at < now() and k.action is null then return jsonb_build_object('ok', false, 'error', 'expired'); end if;
  if (select count(*) from public.reports where contact = k.phone and created_at > now() - interval '1 day') >= 5 then
    return jsonb_build_object('ok', false, 'error', 'rate');
  end if;
  select name into v_name from public.listings where id = k.listing_id;
  insert into public.reports (listing_id, listing_name, kind, details, contact)
  values (case when v_name is null then null else k.listing_id end, v_name, 'wrong_info', left(v_text, 1000), k.phone);
  insert into public.daily_stats (kind, count) values ('report', 1)
    on conflict (day, kind) do update set count = daily_stats.count + 1;
  return jsonb_build_object('ok', true);
end $$;
grant execute on function public.owner_report(text, text) to anon, authenticated;

-- حذف البطاقة كاملة من صاحب الرقم: يُستبعد رقمه نهائياً وتُرفض البطاقة (تخرج من الدليل في التحديث التالي)
create or replace function public.owner_delete(p_token text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  k public.owner_links;
  l record;
begin
  if not private.allow('owner', 120, interval '1 hour') then return jsonb_build_object('ok', false, 'error', 'rate'); end if;
  select * into k from public.owner_links where token = p_token for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  if k.action = 'reject' then return jsonb_build_object('ok', true, 'already', true); end if;
  if k.expires_at < now() then return jsonb_build_object('ok', false, 'error', 'expired'); end if;
  select id, phones into l from public.listings where id = k.listing_id for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'gone'); end if;
  perform private.exclude_phone(k.phone, 'حذف صاحبه بطاقته من رابطه', true, 'حذف صاحبه بطاقته من رابطه');
  update public.listings set status = 'rejected',
         admin_note = btrim(coalesce(admin_note, '') || E'\n🗑 حذف صاحب الرقم بطاقته من رابطه ' || current_date, E'\n')
   where id = k.listing_id and status <> 'rejected';
  update public.owner_links set used_at = now(), action = 'reject' where token = p_token;
  return jsonb_build_object('ok', true, 'action', 'reject');
end $$;
grant execute on function public.owner_delete(text) to anon, authenticated;

revoke execute on function public.owner_edit(text, text, text, text, text) from public;
revoke execute on function public.owner_report(text, text) from public;
revoke execute on function public.owner_delete(text) from public;

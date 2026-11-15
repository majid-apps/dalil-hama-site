-- دليل حماة — v1.13.0: رسالة التوثيق من الزائر، وإشارات صاحب الرقم إلى الإدارة.
--
-- رسالة واتساب التي يرسلها الزائر إلى نشاط غير موثّق صارت رسالة توثيق (الاسم والتصنيف والعنوان والموقع، ثم «هل أنتم موافقون على النشر؟»)
-- ورابطها /?l=ID&w=1#p=الرقم يفتح نافذة بثلاثة خيارات لصاحب الرقم حكماً (من وصلته الرسالة) وللرقم نفسه وحده:
--   ✅ موافق وتوثيق  → owner_signal('approve')  بلاغ من نوع owner_ok   (الإدارة تضغط «توثيق»)
--   ✏️ تعديل         → owner_signal('edit')     بلاغ من نوع owner_edit (الإدارة تطبّق التعديل من «تعديل النشاط»)
--   ❌ الرقم خطأ      → flag_phone (0019 كما هي)  بلاغ wrong_number مع إيقاف مؤقت، والإدارة تحذف نهائياً
-- الرابط عام بلا رمز، فلا تغيّر هذه الدوال البطاقة بنفسها: تسجّل بلاغاً يظهر في «البلاغات» و«مهام اليوم» وسطراً في admin_note، والقرار النهائي للإدارة.
--
-- 1) reports.kind يقبل 'owner_ok' و'owner_edit'.
-- 2) public.owner_signal(p_listing, p_phone, p_kind, p_text): يحدّه private.allow('flag') نفسه (20 يومياً لكل عنوان من rate_limits)؛
--    موافقة واحدة مفتوحة للرقم، وحتى 3 طلبات تعديل مفتوحة له.
-- 3) public.admin_verify_phone(p_listing, p_phone): «توثيق» من البلاغات: verified = true (ونشر إن كانت قيد المراجعة)، الرقم مؤكَّد 30 يوماً
--    (private.phone_ok) ويُرفع إيقافه، وتُغلق بلاغات owner_ok المفتوحة للرقم في هذه البطاقة.
-- آمنة للإعادة.

alter table public.reports drop constraint if exists reports_kind_check;
alter table public.reports add constraint reports_kind_check
  check (kind in ('wrong_number', 'wrong_info', 'closed', 'removal', 'abuse', 'other', 'owner_ok', 'owner_edit'));

create or replace function public.owner_signal(p_listing bigint, p_phone text, p_kind text, p_text text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  n text := public.normalize_phone(p_phone);
  l record;
  v_text text := nullif(btrim(p_text), '');
  v_kind text;
  v_open int;
begin
  if n is null or n = '' then return jsonb_build_object('ok', false, 'error', 'phone'); end if;
  if p_kind is null or p_kind not in ('approve', 'edit') then return jsonb_build_object('ok', false, 'error', 'bad_action'); end if;
  if p_kind = 'edit' and (v_text is null or char_length(v_text) < 5) then return jsonb_build_object('ok', false, 'error', 'details'); end if;
  if not private.allow('flag', 6, interval '1 day') then return jsonb_build_object('ok', false, 'error', 'rate'); end if;
  select id, name, phones, status, verified into l from public.listings where id = p_listing for update;
  if not found or l.status <> 'approved' then return jsonb_build_object('ok', false, 'error', 'gone'); end if;
  if not (n = any(l.phones)) then return jsonb_build_object('ok', false, 'error', 'phone_gone'); end if;
  v_kind := case when p_kind = 'approve' then 'owner_ok' else 'owner_edit' end;
  select count(*) into v_open from public.reports where phone = n and kind = v_kind and status = 'open';
  if (v_kind = 'owner_ok' and v_open >= 1) or v_open >= 3 then
    return jsonb_build_object('ok', true, 'dup', true);
  end if;
  insert into public.reports (listing_id, listing_name, kind, details, phone)
  values (l.id, l.name, v_kind,
          case when v_kind = 'owner_ok'
            then '✅ وافق صاحب الرقم ' || n || ' على النشر والتوثيق (من رابط رسالة الزائر). اضغط «توثيق» لاعتماده.'
            else '✏️ طلب تعديل من صاحب الرقم ' || n || E' (من رابط رسالة الزائر):\n' || left(v_text, 900) end,
          n);
  insert into public.daily_stats (kind, count) values ('report', 1)
    on conflict (day, kind) do update set count = daily_stats.count + 1;
  update public.listings
     set admin_note = btrim(coalesce(admin_note, '') || E'\n' || case when v_kind = 'owner_ok'
           then '✅ وافق صاحب الرقم ' || n || ' على النشر والتوثيق من رسالة الزائر ' || current_date || ' (بانتظار توثيقك من البلاغات)'
           else '✏️ طلب صاحب الرقم ' || n || ' تعديلاً من رسالة الزائر ' || current_date || ' (التفاصيل في البلاغات)' end, E'\n')
   where id = l.id;
  return jsonb_build_object('ok', true, 'verified', coalesce(l.verified, false));
end $$;
revoke execute on function public.owner_signal(bigint, text, text, text) from public;
grant execute on function public.owner_signal(bigint, text, text, text) to anon, authenticated;

create or replace function public.admin_verify_phone(p_listing bigint, p_phone text)
returns boolean language plpgsql security definer set search_path = public as $$
declare n text := public.normalize_phone(p_phone);
begin
  if not public.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  if n is null or n = '' then raise exception 'رقم غير صالح'; end if;
  update public.listings
     set verified = true,
         status = case when status = 'pending' then 'approved' else status end,
         admin_note = btrim(coalesce(admin_note, '') || E'\n✅ وُثّق النشاط بموافقة صاحب الرقم ' || n || ' ' || current_date, E'\n')
   where id = p_listing and n = any(phones);
  if not found then raise exception 'الرقم ليس في هذه البطاقة'; end if;
  insert into private.phone_ok (phone) values (n) on conflict (phone) do update set at = now();
  delete from public.held_phones where phone = n;
  update public.reports
     set status = 'resolved', resolved_at = now(), held = false
   where phone = n and listing_id = p_listing and kind = 'owner_ok' and status = 'open';
  return true;
end $$;
revoke execute on function public.admin_verify_phone(bigint, text) from public, anon;
grant execute on function public.admin_verify_phone(bigint, text) to authenticated;

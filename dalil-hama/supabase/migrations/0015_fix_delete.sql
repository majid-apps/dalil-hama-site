-- دليل حماة — «الرقم خطأ» من شاشة صاحب النشاط (رابط الرسالة ?l=ID&fix=1): يُحذف الرقم فوراً ويُحفظ في «الأرقام المستبعدة»
-- فلا يمكن إضافته أو استيراده من جديد (يستطيع المدير التراجع بـ«إعادة الرقم لبطاقته»). الرقم وحده يُحذف وتبقى البطاقة إن بقي فيها رقم.
-- بلا رمز خاص (الرابط عام)، فالحماية: حدّ محاولات لكل زائر في اليوم، وسطر في الملاحظة الإدارية، والتراجع من الإدارة.
-- التعديل والإبلاغ لا يغيّران البطاقة هنا: يصلان بلاغاً (submit_report) يراجعه المدير.
create or replace function public.fix_delete(p_listing bigint, p_phone text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  n text := public.normalize_phone(p_phone);
  l record;
begin
  if not private.allow('fixdel', 6, interval '1 day') then return jsonb_build_object('ok', false, 'error', 'rate'); end if;
  select id, phones into l from public.listings where id = p_listing and status = 'approved';
  if not found then return jsonb_build_object('ok', false, 'error', 'gone'); end if;
  if n is null or n = '' or not exists (select 1 from unnest(l.phones) q where public.normalize_phone(q) = n) then
    return jsonb_build_object('ok', false, 'error', 'phone_gone');
  end if;
  perform private.exclude_phone(n, 'حُذف من شاشة «الرقم خطأ»', true, 'حُذف من شاشة «الرقم خطأ» (رابط الرسالة)');
  return jsonb_build_object('ok', true);
end $$;
grant execute on function public.fix_delete(bigint, text) to anon, authenticated;
revoke execute on function public.fix_delete(bigint, text) from public;

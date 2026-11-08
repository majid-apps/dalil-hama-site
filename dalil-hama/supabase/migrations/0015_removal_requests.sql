-- دليل حماة — «الرقم خطأ، يرجى الحذف» من رابط رسالة الدليل (?l=ID&w=1)
-- الضغط على الزر يوقف ظهور ذلك الرقم وحده فوراً (يخرج من بطاقته وتبقى البطاقة إن كان فيها أرقام أخرى أو عنوان/موقع)
-- ويُسجَّل في «الأرقام المستبعدة» بعلامة ⏳ حتى يوافق المدير (علامة ⏳ تُزال) أو يرفض («إعادة الرقم لبطاقته»).
-- ويصل بلاغ إلى «البلاغات». لا حذف نهائي من هنا: أسوأ ما يفعله مسيء إيقاف رقم مؤقتاً حتى تراجعه.

create or replace function public.request_number_removal(p_listing bigint, p_phone text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  n text := public.normalize_phone(p_phone);
  l record;
begin
  if not private.allow('removal', 12, interval '1 hour') then return jsonb_build_object('ok', false, 'error', 'rate'); end if;
  if n is null or n = '' then return jsonb_build_object('ok', false, 'error', 'phone'); end if;
  select id, name, phones, status into l from public.listings where id = p_listing;
  if not found or l.status <> 'approved' or not (n = any(l.phones)) then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;
  perform private.exclude_phone(n, '⏳ طلب حذف من الرابط — بانتظار موافقتك', false, 'طلب حذف من الرابط، بانتظار الموافقة');
  insert into public.reports (listing_id, listing_name, kind, details, contact)
  values (l.id, l.name, 'removal', '⏳ الرقم خطأ — أُوقف الرقم ' || n || ' مؤقتاً بانتظار موافقتك (الأرقام المستبعدة)', n);
  insert into public.daily_stats (kind, count) values ('report', 1)
    on conflict (day, kind) do update set count = daily_stats.count + 1;
  return jsonb_build_object('ok', true);
end $$;
revoke execute on function public.request_number_removal(bigint, text) from public;
grant execute on function public.request_number_removal(bigint, text) to anon, authenticated;

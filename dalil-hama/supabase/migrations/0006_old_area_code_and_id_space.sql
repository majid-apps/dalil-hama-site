-- رمز حماة القديم 033 صار 013: الرقمان المكتوبان بالرمزين يُوحَّدان
create or replace function public.normalize_phone(p text)
returns text language plpgsql immutable set search_path = '' as $$
declare
  raw text;
  d text;
  intl boolean;
begin
  if p is null then return null; end if;
  raw := translate(p, '٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹', '01234567890123456789');
  intl := raw ~ '^\s*(\+|00)';
  d := regexp_replace(raw, '\D', '', 'g');
  if d = '' then return null; end if;
  if d like '00963%' then d := substr(d, 6);
  elsif d like '963%' and length(d) >= 11 then d := substr(d, 4);
  elsif intl and d !~ '^0*1' then return '+' || regexp_replace(d, '^00', '');
  end if;
  d := regexp_replace(d, '^0+', '');
  if d ~ '^33[0-9]{7}$' then d := '13' || substr(d, 3); end if;
  if length(d) >= 8 then return '0' || d; end if;
  if d ~ '^2[0-9]{6}$' then return '013' || d; end if;
  return regexp_replace(raw, '\D', '', 'g');
end $$;

-- أرقام الأنشطة الجديدة تبدأ بعد 1,000,000 فلا تتداخل مع أرقام الدليل القديم
-- (فيُعرف كل نشاط مستورد من نسخة قديمة برقمه الأصلي في أي استيراد لاحق)
select setval(pg_get_serial_sequence('public.listings', 'id'), greatest(1000000, (select max(id) from public.listings)));

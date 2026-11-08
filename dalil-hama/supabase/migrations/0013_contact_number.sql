-- رقم تواصل الدليل (واتساب) الجديد: يستبدل الرقم القديم في كل الإعدادات (جهة التواصل، الإعلان، وغيرها).
-- آمن للتكرار: لا يغيّر شيئاً إن لم يبقَ الرقم القديم.
update public.settings
   set value = replace(replace(replace(value::text,
         '963986693552', '963949018059'),
         '0986693552',   '0949018059'),
         '986693552',    '949018059')::jsonb
 where value::text like '%986693552%';

-- إن لم يكن للتواصل رقم أصلاً، يوضع الجديد
update public.settings
   set value = jsonb_set(value, '{whatsapp}', '"963949018059"')
 where key = 'contact' and coalesce(value ->> 'whatsapp', '') = '';

-- دليل حماة — حساب إكس (تويتر) الرسمي في وسائل التواصل (يظهر أسفل الدليل). يُعدَّل لاحقاً من الإعدادات.
update public.settings
   set value = coalesce(value, '{}'::jsonb) || '{"x":"Dalil_HAMA"}'::jsonb
 where key = 'contact';

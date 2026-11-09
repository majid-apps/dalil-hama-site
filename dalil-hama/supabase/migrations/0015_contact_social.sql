-- دليل حماة — حسابا إكس (تويتر) وتلغرام الرسميان في وسائل التواصل (يظهر أسفل الدليل). يُعدَّل لاحقاً من الإعدادات.
update public.settings
   set value = coalesce(value, '{}'::jsonb) || '{"x":"Dalil_HAMA","telegram":"dalil_hama"}'::jsonb
 where key = 'contact';

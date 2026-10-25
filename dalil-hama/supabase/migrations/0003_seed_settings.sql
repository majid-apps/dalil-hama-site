-- الإعدادات الافتراضية (تُعدَّل لاحقاً من لوحة الإدارة ← الإعدادات)
insert into public.settings (key, value, is_public) values
  ('contact', '{"whatsapp":"963986693552","instagram":"dalil_hama","facebook":"https://www.facebook.com/share/1Rqw76HyG4/"}', true),
  ('announcement', '{"active":false,"text":""}', true),
  ('emergency', '[{"name":"الإسعاف","number":"110","icon":"🚑"},{"name":"الشرطة","number":"112","icon":"🚓"},{"name":"الإطفاء","number":"113","icon":"🚒"}]', true),
  ('site', '{"title":"دليل حماة","tagline":"كل أرقام وعناوين حماة… بلمسة واحدة"}', true)
on conflict (key) do nothing;

-- أول حساب مالك يُنشأ يدوياً (مرة واحدة) عبر SQL Editor، ثم تُضاف بقية الحسابات من لوحة الإدارة.

-- بعد نقل البيانات إلى السيرفر (install-db): Supabase يبقى للقراءة فقط.
-- التبويبات القديمة وموقع Render تقرأ منه كما كانت، لكن لا يُكتب فيه شيء لا يراه أحد.
-- (ليس في supabase/migrations عمداً: ذلك المجلد يُطبَّق على قاعدة السيرفر)
drop function if exists public.dh_server_export(text);

revoke execute on function
  public.submit_listing(jsonb),
  public.submit_report(jsonb),
  public.track(bigint, text),
  public.log_search(text, integer),
  public.admin_create_user(text, text, text)
from public, anon, authenticated;

revoke insert, update, delete, truncate on all tables in schema public from anon, authenticated;

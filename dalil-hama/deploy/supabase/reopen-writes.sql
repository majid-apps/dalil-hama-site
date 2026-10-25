-- عكس readonly-after-move.sql: يُطبَّق على Supabase فقط إن عاد الموقع إليه نهائياً (بعد db-rollback).
grant execute on function
  public.submit_listing(jsonb),
  public.submit_report(jsonb),
  public.track(bigint, text),
  public.log_search(text, integer)
to anon, authenticated;
grant execute on function public.admin_create_user(text, text, text) to authenticated;

grant insert, update, delete, truncate on
  public.admins, public.areas, public.audit_log, public.categories, public.daily_stats,
  public.listing_stats, public.listings, public.reports, public.search_terms, public.settings
to authenticated;

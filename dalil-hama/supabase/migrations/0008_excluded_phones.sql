-- دليل حماة — قائمة الأرقام المستبعدة نهائياً
-- الرقم المستبعد لا يُنشر ولا يُقبل من الزوار ولا من الاستيراد إلا بعد إزالته من القائمة بأمر من المدير.

create table if not exists public.excluded_phones (
  phone      text primary key,
  name       text,
  note       text check (char_length(note) <= 300),
  created_at timestamptz not null default now()
);
alter table public.excluded_phones enable row level security;
drop policy if exists "admins manage excluded" on public.excluded_phones;
create policy "admins manage excluded" on public.excluded_phones for all to authenticated using (public.is_admin()) with check (public.is_admin());
grant select, insert, update, delete on public.excluded_phones to authenticated;

-- حارس: أي نشاط (من الزوار أو الاستيراد أو الإدارة) يحمل رقماً مستبعداً لا يصير «منشوراً» ولا «معلّقاً»
create or replace function private.excluded_guard()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.status in ('approved', 'pending') and exists (
    select 1 from unnest(new.phones) p join public.excluded_phones e on e.phone = public.normalize_phone(p)
  ) then
    if auth.uid() is not null and public.is_admin() then
      raise exception 'أحد أرقام هذا النشاط في قائمة الأرقام المستبعدة. أزله منها أولاً إن أردت نشره.';
    end if;
    new.status := 'rejected';
  end if;
  return new;
end $$;

drop trigger if exists listings_excluded_guard on public.listings;
create trigger listings_excluded_guard before insert or update of status, phones on public.listings
  for each row execute function private.excluded_guard();

-- أمر الاستبعاد: يحفظ الأرقام في القائمة ويرفض كل بطاقة تحملها (تبقى البطاقة محفوظة للمراجعة)
create or replace function public.admin_exclude(p_phones text[], p_note text default null)
returns integer language plpgsql security definer set search_path = public as $$
declare
  p text;
  n text;
  cnt integer := 0;
begin
  if not public.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  foreach p in array coalesce(p_phones, '{}') loop
    n := public.normalize_phone(p);
    if n is null or n = '' then continue; end if;
    insert into public.excluded_phones (phone, name, note)
    values (n, (select l.name from public.listings l where n = any(l.phones) order by (l.status = 'approved') desc, l.id limit 1), nullif(left(btrim(coalesce(p_note, '')), 300), ''))
    on conflict (phone) do update set note = coalesce(excluded.note, public.excluded_phones.note);
    update public.listings
       set status = 'rejected',
           admin_note = btrim(coalesce(admin_note, '') || E'\n⛔ مستبعد نهائياً ' || current_date, E'\n')
     where n = any(phones) and status <> 'rejected';
    cnt := cnt + 1;
  end loop;
  return cnt;
end $$;
grant execute on function public.admin_exclude(text[], text) to authenticated;

-- تسريع التحديث التفاضلي في الإدارة (يجلب ما تغيّر منذ آخر فتح)
create index if not exists listings_updated_at_idx on public.listings (updated_at);

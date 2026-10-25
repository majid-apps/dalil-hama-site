-- دليل حماة — دخول الإدارة بكلمة المرور فقط (بلا إدخال البريد)
-- admin_login_hint() تعيد معرّف دخول الحساب المطابق ولا تعيده إلا لكلمة مرور صحيحة،
-- ثم يُصدر GoTrue الجلسة بالطريقة المعتادة. حدّ للمحاولات الخاطئة لكل عنوان IP ولمجموع الطلبات.
create table if not exists public.admin_login_fail (
  id bigint generated always as identity primary key,
  ip text not null default '',
  at timestamptz not null default now()
);
alter table public.admin_login_fail enable row level security;
revoke all on public.admin_login_fail from anon, authenticated;
create index if not exists admin_login_fail_at_idx on public.admin_login_fail (at);

create or replace function public.admin_login_hint(p_password text)
returns text language plpgsql volatile security definer
set search_path = public, extensions, auth
as $$
declare hdr jsonb; v_ip text; v_email text;
begin
  begin hdr := nullif(current_setting('request.headers', true), '')::jsonb;
  exception when others then hdr := null; end;
  v_ip := btrim(coalesce(split_part(coalesce(hdr ->> 'x-forwarded-for', hdr ->> 'x-real-ip', ''), ',', 1), ''));
  delete from public.admin_login_fail where at < now() - interval '1 day';
  if (select count(*) from public.admin_login_fail where ip = v_ip and at > now() - interval '15 minutes') >= 8
     or (select count(*) from public.admin_login_fail where at > now() - interval '15 minutes') >= 60 then
    raise exception 'too_many_attempts' using errcode = 'P0001';
  end if;
  if p_password is null or char_length(p_password) < 1 or char_length(p_password) > 200 then
    insert into public.admin_login_fail (ip) values (v_ip); return null;
  end if;
  select a.email into v_email from public.admins a join auth.users u on u.id = a.user_id
   where u.encrypted_password = crypt(p_password, u.encrypted_password)
   order by (a.role = 'owner') desc, a.created_at limit 1;
  if v_email is null then insert into public.admin_login_fail (ip) values (v_ip); end if;
  return v_email;
end $$;
revoke all on function public.admin_login_hint(text) from public;
grant execute on function public.admin_login_hint(text) to anon, authenticated;

-- دليل حماة — v1.14.0: من ضغط زر رابط الرسالة؟ صاحب الرقم أم المرسل. وإخفاء تام أسبوعاً لطلب «الرقم خطأ».
--
-- رابط رسالة التوثيق /?l=ID&w=1#p=الرقم عام بلا رمز: يفتحه من وصلته الرسالة (صاحب الرقم) ومن أرسلها (الزائر) وأي أحد يعرف الرقم.
-- لا يستطيع رابط أن يعرف من فتحه؛ ما يثبت أن الضاغط صاحب الرقم هو رسالة واتساب تصل الإدارة **من الرقم نفسه**.
-- لذلك بعد كل خيار من الخيارات الثلاثة يفتح المتصفح واتساب إلى رقم الإدارة برسالة جاهزة فيها رابط /admin/#sig?l=ID&p=الرقم&k=ok|edit|rm،
-- والإدارة حين تفتح الرابط من محادثة الرقم (بعد التحقق أن المحادثة من الرقم نفسه) تعلّم البلاغ «مؤكَّداً من واتساب الرقم».
--
-- 1) reports: by_sender (الطلب من الجهاز الذي أُرسلت منه رسالة التوثيق: المرسل لا صاحب الرقم، يكشفه المتصفح من ذاكرته المحلية)،
--    confirmed_at (وصلت الإدارة رسالة واتساب من الرقم وأكّدت ذلك)، src (بصمة قصيرة لعنوان المُبلِّغ لعدّ بلاغات المصدر نفسه على بطاقات مختلفة).
-- 2) flag_phone(p_listing, p_phone, p_sender): الإخفاء التام أسبوعاً (7 أيام بدل 3) ولو كان الرقم الوحيد في البطاقة (فتختفي البطاقة معه من الزوار)،
--    إلا إن جاء الطلب من جهاز المرسل (لا إخفاء، بلاغ معلَّم فقط) أو أُكّد الرقم خلال 30 يوماً أو أُوقف الإخفاء من الإعدادات (flag.hold = false).
-- 3) owner_signal(..., p_sender): يعلّم البلاغ by_sender.
-- 4) private.sync_impl: الأرقام الموقوفة تُحجب 7 أيام، والبطاقة التي حُجبت كل أرقامها لا تُرسل للزوار (وتصل في removed بالمزامنة التفاضلية).
-- 5) admin_confirm_signal(p_listing, p_phone, p_kind): من رابط /admin/#sig: يعلّم البلاغ المفتوح مؤكَّداً، أو ينشئه مؤكَّداً إن لم يصل (جهاز صاحب الرقم بلا إنترنت مثلاً).
-- آمنة للإعادة.

alter table public.reports add column if not exists by_sender boolean not null default false;
alter table public.reports add column if not exists confirmed_at timestamptz;
alter table public.reports add column if not exists src text;
create index if not exists reports_src_open_idx on public.reports (src) where status = 'open';

-- بصمة قصيرة لعنوان المُبلِّغ (لا العنوان نفسه): تكفي لعدّ بلاغات المصدر الواحد، ولا تكشف شيئاً في النسخة الكاملة
create or replace function private.src_key()
returns text language sql stable security definer set search_path = public as $$
  select left(md5('src:' || coalesce(private.client_key(), '')), 8);
$$;
revoke all on function private.src_key() from public;

-- ───────────────────────── sync: حجب الأرقام الموقوفة 7 أيام، وحجب البطاقة التي حُجبت كل أرقامها ─────────────────────────

create or replace function private.sync_impl(since timestamptz default null)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'now', now(),
    'full', since is null,
    'items', coalesce((
      select jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
        'i', l.id,
        'n', l.name,
        'c', l.category_id,
        'p', case when cardinality(vp.ph) > 0 then to_jsonb(vp.ph) end,
        'w', case when exists (select 1 from public.held_phones h where h.phone = public.normalize_phone(l.whatsapp) and h.created_at > now() - interval '7 days') then null else l.whatsapp end,
        'nw', case when l.no_whatsapp then 1 end,
        'a', l.area,
        'd', nullif(l.address, ''),
        -- روابط بحث Google التي تحوي place_id تُرسل مختصرة (g) وتُعاد بناؤها في المتصفح
        'm', case when pid is null then nullif(l.map_url, '') end,
        'g', pid,
        'y', round(l.lat::numeric, 6),
        'x', round(l.lng::numeric, 6),
        's', nullif(l.website, ''),
        'e', nullif(l.description, ''),
        't', case when cardinality(l.tags) > 0 then to_jsonb(l.tags) end,
        'f', case when l.featured then 1 end,
        'v', case when l.verified then 1 end,
        'k', nullif(coalesce(st.calls + st.whatsapp, 0), 0)
      )) order by l.id)
      from public.listings l
      left join public.listing_stats st on st.listing_id = l.id
      -- الأرقام الموقوفة مؤقتاً بطلب «الرقم خطأ» (7 أيام كحد أقصى أو حتى يؤكد المدير) لا تُرسل للزوار
      cross join lateral (
        select coalesce(array(select u.q from unnest(l.phones) with ordinality u(q, n)
                              where not exists (select 1 from public.held_phones h where h.phone = u.q and h.created_at > now() - interval '7 days')
                              order by u.n), '{}'::text[]) as ph
      ) vp
      cross join lateral (
        select substring(l.map_url from '^https://www\.google\.com/maps/search/\?api=1&query=[^&]*&query_place_id=([A-Za-z0-9_-]+)$') as pid
      ) g
      where l.status = 'approved' and (since is null or l.updated_at > since)
        -- الإخفاء التام: بطاقة حُجبت كل أرقامها تختفي من الزوار حتى يقرر المدير أو ينتهي الأسبوع
        and not (cardinality(l.phones) > 0 and cardinality(vp.ph) = 0)
    ), '[]'::jsonb),
    'removed', case when since is null then '[]'::jsonb else coalesce((
      select jsonb_agg(id) from (
        select id from public.listings where status <> 'approved' and updated_at > since
        union
        select listing_id from private.tombstones where deleted_at > since
        union
        select l.id from public.listings l
         where l.status = 'approved' and l.updated_at > since and cardinality(l.phones) > 0
           and not exists (select 1 from unnest(l.phones) q
                            where not exists (select 1 from public.held_phones h where h.phone = q and h.created_at > now() - interval '7 days'))
      ) r
    ), '[]'::jsonb) end,
    'cats', coalesce((
      select jsonb_agg(jsonb_build_object('i', id, 'n', name, 'ic', icon, 'o', sort, 'k', keywords) order by sort, name)
      from public.categories
    ), '[]'::jsonb),
    'areas', coalesce((
      -- 'r' = 1 لبلدات ريف حماة (بوابة «ريف حماة»): نشاط مكانه بلدة ريفية يخرج من قوائم المدينة
      select jsonb_agg(jsonb_build_object('n', name, 'k', keywords)
                       || case when rural then jsonb_build_object('r', 1) else '{}'::jsonb end order by sort, name)
      from public.areas
    ), '[]'::jsonb),
    'settings', coalesce((select jsonb_object_agg(key, value) from public.settings where is_public), '{}'::jsonb)
  );
$$;
revoke execute on function private.sync_impl(timestamptz) from public, anon, authenticated;

-- ───────────────────────── «الرقم خطأ»: إخفاء تام أسبوعاً، ولا إخفاء بطلب من جهاز المرسل ─────────────────────────

drop function if exists public.flag_phone(bigint, text);
create or replace function public.flag_phone(p_listing bigint, p_phone text, p_sender boolean default false)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  n text := public.normalize_phone(p_phone);
  l record;
  v_cfg jsonb;
  v_hold boolean;
  v_sender boolean := coalesce(p_sender, false);
begin
  if n is null or n = '' then return jsonb_build_object('ok', false, 'error', 'phone'); end if;
  if not private.allow('flag', 6, interval '1 day') then return jsonb_build_object('ok', false, 'error', 'rate'); end if;
  select id, name, phones, status into l from public.listings where id = p_listing for update;
  if not found or l.status <> 'approved' then return jsonb_build_object('ok', false, 'error', 'gone'); end if;
  if not (n = any(l.phones)) then return jsonb_build_object('ok', false, 'error', 'phone_gone'); end if;
  -- الرقم نفسه مبلَّغ عنه ثلاث مرات ولم تُراجَع: لا بلاغ رابع (يبقى الموقوف موقوفاً)
  if (select count(*) from public.reports where phone = n and status = 'open') >= 3 then
    return jsonb_build_object('ok', true, 'dup', true);
  end if;
  select value into v_cfg from public.settings where key = 'flag';
  -- الإخفاء التام (ولو كان الرقم الوحيد) إلا: طلب من جهاز المرسل، أو رقم أُكّد خلال 30 يوماً، أو إيقاف من الإعدادات، أو تجاوز 20 إيقافاً في اليوم
  v_hold := coalesce((v_cfg ->> 'hold')::boolean, true)
        and not v_sender
        and not exists (select 1 from private.phone_ok where phone = n and at > now() - interval '30 days')
        and (select count(*) from public.held_phones where created_at > now() - interval '1 day') < 20;
  insert into public.reports (listing_id, listing_name, kind, details, phone, held, by_sender, src)
  values (l.id, l.name, 'wrong_number',
          '⛔ طلب حذف الرقم ' || n || ' (من رابط رسالة واتساب)'
            || case when v_sender then E'\n⚠️ جاء الطلب من الجهاز الذي أُرسلت منه رسالة التوثيق (المرسل، لا صاحب الرقم) فلم يُخفَ الرقم' else '' end
            || case when v_hold then E'\n⏸ أُخفي الرقم عن الزوار أسبوعاً بانتظار تأكيدك' else '' end,
          n, v_hold, v_sender, private.src_key());
  insert into public.daily_stats (kind, count) values ('report', 1)
    on conflict (day, kind) do update set count = daily_stats.count + 1;
  if v_hold then
    insert into public.held_phones (phone, listing_id) values (n, l.id)
      on conflict (phone) do update set created_at = now(), listing_id = excluded.listing_id;
    -- تحديث البطاقة يرفع updated_at فتصل المزامنة التفاضلية بإخفاء الرقم (أو البطاقة إن كان رقمها الوحيد)
    update public.listings
       set admin_note = btrim(coalesce(admin_note, '') || E'\n⏸ أُخفي رقم أسبوعاً بطلب «الرقم خطأ» ' || current_date, E'\n')
     where id = l.id;
  end if;
  return jsonb_build_object('ok', true, 'held', v_hold);
end $$;
revoke execute on function public.flag_phone(bigint, text, boolean) from public;
grant execute on function public.flag_phone(bigint, text, boolean) to anon, authenticated;

-- ───────────────────────── إشارة صاحب الرقم (موافقة أو تعديل) مع علامة «من جهاز المرسل» ─────────────────────────

drop function if exists public.owner_signal(bigint, text, text, text);
create or replace function public.owner_signal(p_listing bigint, p_phone text, p_kind text, p_text text default null, p_sender boolean default false)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  n text := public.normalize_phone(p_phone);
  l record;
  v_text text := nullif(btrim(p_text), '');
  v_kind text;
  v_open int;
  v_sender boolean := coalesce(p_sender, false);
  v_tag text;
begin
  if n is null or n = '' then return jsonb_build_object('ok', false, 'error', 'phone'); end if;
  if p_kind is null or p_kind not in ('approve', 'edit') then return jsonb_build_object('ok', false, 'error', 'bad_action'); end if;
  if p_kind = 'edit' and (v_text is null or char_length(v_text) < 5) then return jsonb_build_object('ok', false, 'error', 'details'); end if;
  if not private.allow('flag', 6, interval '1 day') then return jsonb_build_object('ok', false, 'error', 'rate'); end if;
  select id, name, phones, status, verified into l from public.listings where id = p_listing for update;
  if not found or l.status <> 'approved' then return jsonb_build_object('ok', false, 'error', 'gone'); end if;
  if not (n = any(l.phones)) then return jsonb_build_object('ok', false, 'error', 'phone_gone'); end if;
  v_kind := case when p_kind = 'approve' then 'owner_ok' else 'owner_edit' end;
  select count(*) into v_open from public.reports where phone = n and kind = v_kind and status = 'open';
  if (v_kind = 'owner_ok' and v_open >= 1) or v_open >= 3 then
    return jsonb_build_object('ok', true, 'dup', true);
  end if;
  v_tag := case when v_sender then E'\n⚠️ جاء الطلب من الجهاز الذي أُرسلت منه رسالة التوثيق (المرسل، لا صاحب الرقم)' else '' end;
  insert into public.reports (listing_id, listing_name, kind, details, phone, by_sender, src)
  values (l.id, l.name, v_kind,
          case when v_kind = 'owner_ok'
            then '✅ وافق صاحب الرقم ' || n || ' على النشر والتوثيق (من رابط رسالة الزائر). اضغط «توثيق» لاعتماده.' || v_tag
            else '✏️ طلب تعديل من صاحب الرقم ' || n || E' (من رابط رسالة الزائر):\n' || left(v_text, 900) || v_tag end,
          n, v_sender, private.src_key());
  insert into public.daily_stats (kind, count) values ('report', 1)
    on conflict (day, kind) do update set count = daily_stats.count + 1;
  update public.listings
     set admin_note = btrim(coalesce(admin_note, '') || E'\n' || case when v_kind = 'owner_ok'
           then '✅ وافق صاحب الرقم ' || n || ' على النشر والتوثيق من رسالة الزائر ' || current_date || ' (بانتظار توثيقك من البلاغات)'
           else '✏️ طلب صاحب الرقم ' || n || ' تعديلاً من رسالة الزائر ' || current_date || ' (التفاصيل في البلاغات)' end
           || case when v_sender then ' ⚠️ من جهاز المرسل' else '' end, E'\n')
   where id = l.id;
  return jsonb_build_object('ok', true, 'verified', coalesce(l.verified, false));
end $$;
revoke execute on function public.owner_signal(bigint, text, text, text, boolean) from public;
grant execute on function public.owner_signal(bigint, text, text, text, boolean) to anon, authenticated;

-- ───────────────────────── الإدارة: وصل تأكيد واتساب من الرقم ─────────────────────────

-- p_kind: 'ok' (موافقة) | 'edit' (تعديل) | 'rm' (الرقم خطأ). يعلّم البلاغات المفتوحة للرقم في البطاقة من هذا النوع مؤكَّدة،
-- وإن لم يوجد بلاغ مفتوح أنشأه مؤكَّداً (الطلب لم يصل من جهاز صاحب الرقم لكن رسالة واتساب وصلت). يعيد عدد البلاغات المعلَّمة أو المنشأة.
create or replace function public.admin_confirm_signal(p_listing bigint, p_phone text, p_kind text)
returns int language plpgsql security definer set search_path = public as $$
declare
  n text := public.normalize_phone(p_phone);
  v_kind text;
  v_n int;
  l record;
begin
  if not public.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  if n is null or n = '' then raise exception 'رقم غير صالح'; end if;
  v_kind := case p_kind when 'ok' then 'owner_ok' when 'edit' then 'owner_edit' when 'rm' then 'wrong_number' else null end;
  if v_kind is null then raise exception 'نوع غير معروف'; end if;
  update public.reports
     set confirmed_at = now(),
         details = btrim(coalesce(details, '') || E'\n📱 وصل تأكيد واتساب من الرقم نفسه ' || current_date, E'\n')
   where listing_id = p_listing and phone = n and kind = v_kind and status = 'open' and confirmed_at is null;
  get diagnostics v_n = row_count;
  if v_n = 0 and not exists (select 1 from public.reports where listing_id = p_listing and phone = n and kind = v_kind and status = 'open') then
    select id, name, phones into l from public.listings where id = p_listing;
    if not found then raise exception 'النشاط غير موجود'; end if;
    insert into public.reports (listing_id, listing_name, kind, details, phone, confirmed_at)
    values (l.id, l.name, v_kind,
            case v_kind when 'owner_ok' then '✅ وافق صاحب الرقم ' || n || ' على النشر والتوثيق. اضغط «توثيق» لاعتماده.'
                        when 'owner_edit' then '✏️ طلب تعديل من صاحب الرقم ' || n || ' (التفاصيل في رسالة واتساب)'
                        else '⛔ طلب حذف الرقم ' || n end
              || E'\n📱 وصل تأكيد واتساب من الرقم نفسه ' || current_date || ' (لم يصل الطلب من الرابط)',
            n, now());
    v_n := 1;
  end if;
  update public.listings
     set admin_note = btrim(coalesce(admin_note, '') || E'\n📱 وصل تأكيد واتساب من الرقم ' || n || ' ' || current_date || ' ('
           || case v_kind when 'owner_ok' then 'موافقة' when 'owner_edit' then 'تعديل' else 'الرقم خطأ' end || ')', E'\n')
   where id = p_listing;
  return v_n;
end $$;
revoke execute on function public.admin_confirm_signal(bigint, text, text) from public, anon;
grant execute on function public.admin_confirm_signal(bigint, text, text) to authenticated;

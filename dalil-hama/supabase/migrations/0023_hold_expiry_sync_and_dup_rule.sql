-- دليل حماة — v1.15.0: إصلاح ملاحظتين من فحص 16 تشرين الثاني 2026 (docs/AUDIT-2026-11-16.md، ثانياً 3 و4).
--
-- 1) private.sync_impl: انتهاء إخفاء الرقم (أسبوع في held_phones) كان لا يصل الزوار بالمزامنة التفاضلية لأن البطاقة لا تتغير
--    (updated_at ثابت)، فلا يعود الرقم (أو البطاقة إن كان رقمها الوحيد) إلا بالمزامنة الكاملة الأسبوعية أو بقرار المدير.
--    الآن تُعدّ البطاقة «متغيرة» في المزامنة التفاضلية إن انتهى إخفاء أحد أرقامها (أو رقم واتسابها) بين since والآن.
-- 2) flag_phone: كان ثلاثة بلاغات «الرقم خطأ» مفتوحة للرقم نفسه تمنع الرابع ولو جاء من صاحب الرقم فعلاً
--    (المرسل المسيء يبلغ من ثلاثة أجهزة أو ثلاث مرات من جهازه فيُغلق الباب). الآن: البلاغ المكرر هو ما جاء من المصدر نفسه
--    (بصمة العنوان reports.src) لرقم فيه بلاغ مفتوح منه، أو ما جاء بعد 10 بلاغات مفتوحة للرقم (سقف للإغراق).
--    البلاغات المعلَّمة «من جهاز المرسل» (by_sender) لا تُعدّ في السقف. بقية الحمايات كما هي (حدود المعدل، 20 إخفاءً يومياً، phone_ok).
-- آمنة للإعادة.

-- ───────────────────────── sync: انتهاء الإخفاء يصل بالمزامنة التفاضلية ─────────────────────────

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
      where l.status = 'approved'
        and (since is null or l.updated_at > since
             -- انتهى إخفاء رقم من أرقامها (أو رقم واتسابها) بعد آخر مزامنة: تعود البطاقة بأرقامها كاملة دون تغيير updated_at
             or exists (select 1 from public.held_phones h
                         where (h.phone = any(l.phones) or h.phone = public.normalize_phone(l.whatsapp))
                           and h.created_at + interval '7 days' > since
                           and h.created_at + interval '7 days' <= now()))
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

-- ───────────────────────── «الرقم خطأ»: المكرر من المصدر نفسه، وسقف 10 بلاغات مفتوحة للرقم ─────────────────────────

create or replace function public.flag_phone(p_listing bigint, p_phone text, p_sender boolean default false)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  n text := public.normalize_phone(p_phone);
  l record;
  v_cfg jsonb;
  v_hold boolean;
  v_sender boolean := coalesce(p_sender, false);
  v_src text := private.src_key();
begin
  if n is null or n = '' then return jsonb_build_object('ok', false, 'error', 'phone'); end if;
  if not private.allow('flag', 6, interval '1 day') then return jsonb_build_object('ok', false, 'error', 'rate'); end if;
  select id, name, phones, status into l from public.listings where id = p_listing for update;
  if not found or l.status <> 'approved' then return jsonb_build_object('ok', false, 'error', 'gone'); end if;
  if not (n = any(l.phones)) then return jsonb_build_object('ok', false, 'error', 'phone_gone'); end if;
  -- المكرر: المصدر نفسه له بلاغ «الرقم خطأ» مفتوح على الرقم نفسه (لا بلاغ ثانياً منه)، أو بلغ الرقم 10 بلاغات مفتوحة
  -- من غير جهاز المرسل (سقف للإغراق). مصدر مختلف (صاحب الرقم مثلاً) لا يُمنع بسبب بلاغات غيره.
  if exists (select 1 from public.reports where phone = n and status = 'open' and kind = 'wrong_number' and src = v_src)
     or (select count(*) from public.reports where phone = n and status = 'open' and kind = 'wrong_number' and not by_sender) >= 10 then
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
          n, v_hold, v_sender, v_src);
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

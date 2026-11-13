-- دليل حماة — بوابة «ريف حماة» وتنظيف التصنيفات (13 تشرين الثاني 2026)
--
-- 1) عمود areas.rural: البلدة الريفية تُعلَّم بأنها من «ريف حماة»، وكل نشاط حيّه بلدة ريفية يُعرض في بوابة الريف
--    لا في قوائم المدينة (القرار في الواجهة من علم الحي، فلا عمود جديد في listings).
-- 2) sync تُرسل علم الحي (r) مع الأحياء.
-- 3) تعيين بلدة الأنشطة الريفية من العنوان أو الاسم بقواعد متحفظة (لا يمسّ إلا ما حيّه فارغ).
-- 4) حذف بطاقتي الاختبار، ودمج التصنيفات الصغيرة المكررة، وحذف التصنيفات الفارغة المكررة.
-- آمنة للإعادة: لا تنفّذ شيئاً مرتين.

alter table public.areas add column if not exists rural boolean not null default false;

-- مزامنة البيانات للواجهة: كاملة عند since = null، أو التغييرات فقط بعد وقت معيّن
create or replace function public.sync(since timestamptz default null)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'now', now(),
    'full', since is null,
    'items', coalesce((
      select jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
        'i', l.id,
        'n', l.name,
        'c', l.category_id,
        'p', case when cardinality(l.phones) > 0 then to_jsonb(l.phones) end,
        'w', l.whatsapp,
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
      cross join lateral (
        select substring(l.map_url from '^https://www\.google\.com/maps/search/\?api=1&query=[^&]*&query_place_id=([A-Za-z0-9_-]+)$') as pid
      ) g
      where l.status = 'approved' and (since is null or l.updated_at > since)
    ), '[]'::jsonb),
    'removed', case when since is null then '[]'::jsonb else coalesce((
      select jsonb_agg(id) from (
        select id from public.listings where status <> 'approved' and updated_at > since
        union
        select listing_id from private.tombstones where deleted_at > since
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


-- ───────────────────────── بلدات ريف حماة ─────────────────────────

insert into public.areas (name, keywords, sort, rural) values
  ('سلمية', '', 1001, true), ('مصياف', '', 1002, true), ('السقيلبية', '', 1003, true), ('محردة', '', 1004, true),
  ('قمحانة', '', 1005, true), ('صوران', '', 1006, true), ('كفرزيتا', '', 1007, true), ('حلفايا', '', 1008, true),
  ('طيبة الإمام', '', 1009, true), ('اللطامنة', '', 1010, true), ('مورك', '', 1011, true), ('سلحب', '', 1012, true),
  ('عقيربات', '', 1013, true), ('شيزر', '', 1014, true), ('الغاب', '', 1015, true), ('كرناز', '', 1016, true),
  ('كفربهم', '', 1017, true), ('كفربو', '', 1018, true), ('معردفتين', '', 1019, true), ('بسيرين', '', 1020, true),
  ('سريحين', '', 1021, true), ('تل قرطل', '', 1022, true), ('خطاب', '', 1023, true), ('الجنان', '', 1024, true),
  ('قرى أخرى', '', 1099, true)
on conflict (name) do update set rural = true;

-- ───────────────────────── تعيين البلدة للأنشطة الريفية ─────────────────────────
-- القواعد (بالترتيب، وأول قاعدة تنطبق هي المعتمدة):
--   1 العنوان يبدأ باسم البلدة (بعد حذف «حماة»/«ريف حماة»/«سوريا» من أوله)
--   2 الاسم فيه البلدة بين قوسين، مثل «صيدلية ماري (محردة)»
--   3 عبارة «ريف حماة» في العنوان أو الاسم (البلدة من العنوان إن وُجدت، وإلا «قرى أخرى»)
--   4 اسم النشاط فيه بلدة مميّزة ككلمة كاملة (ليست بعد «طريق/شارع/كراج…») والعنوان فارغ أو يذكر بلدة ريفية
-- لا يُعدَّل إلا نشاط حيّه فارغ، فلا يُغيَّر ما حدّده المدير. «مصياف» في «طريق مصياف» أو «كراج سلمية» لا تعني ريفاً.

create temp table _rt (ord int primary key, name text not null, pat text not null, strong boolean not null) on commit drop;
insert into _rt values
  (1,  'سلمية',       'سلمية|السلمية|سلميه|السلميه', true),
  (2,  'مصياف',       'مصياف|المصياف', true),
  (3,  'السقيلبية',   'السقيلبية|السقيلبيه', true),
  (4,  'محردة',       'محردة|محرده', true),
  (5,  'قمحانة',      'قمحانة|قمحانه', true),
  (6,  'صوران',       'صوران', true),
  (7,  'كفرزيتا',     'كفرزيتا|كفر زيتا', true),
  (8,  'حلفايا',      'حلفايا', true),
  (9,  'طيبة الإمام', 'طيبة الإمام|طيبة الامام', true),
  (10, 'سلحب',        'سلحب|تل سلحب', true),
  (11, 'عقيربات',     'عقيربات', true),
  (12, 'كرناز',       'كرناز', true),
  (13, 'كفربهم',      'كفربهم', true),
  (14, 'كفربو',       'كفربو', true),
  (15, 'معردفتين',    'معردفتين', true),
  (16, 'بسيرين',      'بسيرين', true),
  (17, 'سريحين',      'سريحين', true),
  (18, 'تل قرطل',     'تل قرطل', true),
  -- أسماء شائعة تُطابَق في بداية العنوان فقط (لا في الأسماء: «خطاب» و«الجنان» و«الغاب» أسماء أشخاص وأماكن عامة)
  (19, 'اللطامنة',    'اللطامنة|لطامنة', false),
  (20, 'مورك',        'مورك', false),
  (21, 'شيزر',        'شيزر', false),
  (22, 'الغاب',       'الغاب|سهل الغاب', false),
  (23, 'خطاب',        'خطاب', false),
  (24, 'الجنان',      'الجنان', false);

create temp table _cand on commit drop as
select l.id, t.name, r.rank, t.ord
from public.listings l
cross join _rt t
cross join lateral (
  select coalesce(l.address, '') as addr,
         btrim(regexp_replace(coalesce(l.address, ''),
           '^\s*((ريف حماة( الشمالي| الغربي| الشرقي| الجنوبي)?|مدينة حماة|محافظة حماة|حماة|حماه|سوريا|سورية|syria)(\s*[-–—،,|/]+\s*|\s*$))+',
           '', 'i')) as rest
) a
cross join lateral (
  select case
    when a.rest ~ ('^(' || t.pat || ')($|[^ء-ي])') then 1
    when l.name ~ ('[(（]\s*(' || t.pat || ')\s*[)）]') then 2
    when (a.addr ~ 'ريف حماة' or l.name ~ 'ريف حماة')
         and a.addr ~ ('(^|[^ء-ي])(' || t.pat || ')($|[^ء-ي])') then 3
    when t.strong
         and l.name ~ ('(^|[^ء-ي])(' || t.pat || ')($|[^ء-ي])')
         and l.name !~ ('(^|[^ء-ي])(طريق|شارع|كراج|دوار|مفرق|موقف|جسر|طلعة|سوق|باب|ساحة|اوتستراد|أوتستراد)\s+(' || t.pat || ')($|[^ء-ي])')
         and (btrim(a.addr) = ''
              or exists (select 1 from _rt s where s.strong and a.addr ~ ('(^|[^ء-ي])(' || s.pat || ')($|[^ء-ي])')))
    then 4
  end as rank
) r
where l.area is null and r.rank is not null;

-- «ريف حماة» مذكورة ولا بلدة معروفة: «قرى أخرى»
insert into _cand
select l.id, 'قرى أخرى', 5, 99
from public.listings l
where l.area is null
  and (l.address ~ 'ريف حماة' or l.name ~ 'ريف حماة')
  and not exists (select 1 from _cand c where c.id = l.id);

update public.listings l
   set area = c.name
  from (select distinct on (id) id, name from _cand order by id, rank, ord) c
 where l.id = c.id and l.area is null;

-- ───────────────────────── تنظيف ─────────────────────────

-- بطاقتا اختبار كانتا منشورتين للزوار
delete from public.listings
 where name in ('اختبار نقل القاعدة', 'Test Business — تجارة مواد غذائية');

-- دمج التصنيفات الصغيرة المكررة في التصنيف الرئيسي المقابل (إن وُجد الاثنان)
do $$
declare
  m record;
  v_from smallint;
  v_to smallint;
begin
  for m in select * from (values
    ('أفران', 'مخابز وحلويات'), ('اكسسوارات ذهب', 'ذهب ومجوهرات'), ('مجوهرات', 'ذهب ومجوهرات'),
    ('كراج ميكانيك', 'صيانة سيارات'), ('محل هدايا واكسسوارات', 'هدايا وعطور وزهور'), ('مطعم وكافيه', 'مطاعم'),
    ('مكتب سياحة وسفر', 'مكاتب سفر وسياحة'), ('عيادة تجميل', 'تجميل وحلاقة'), ('روضة', 'مدارس وروضات'),
    ('كافيه', 'كافيهات'), ('مركز طبي متكامل', 'عيادات وأطباء'), ('موبايلات واتصالات', 'موبايلات وإلكترونيات'),
    ('مفروشات', 'مفروشات وأثاث')
  ) as t(src, dst) loop
    select id into v_from from public.categories where name = m.src;
    select id into v_to from public.categories where name = m.dst;
    if v_from is not null and v_to is not null then
      update public.listings set category_id = v_to where category_id = v_from;
    end if;
  end loop;
end $$;

-- حذف التصنيفات المكررة حين تصير فارغة (لا يُحذف تصنيف فيه أي نشاط مهما كان)
delete from public.categories c
 where c.name = any (array[
   'صالون تجميل', 'صالون تجميل سيدات', 'عيادة بيطرية', 'قهوة', 'كافيه آيس كوفي', 'كافيه نسائي',
   'محل مستحضرات تجميل وعطور', 'مخبز', 'مدارس', 'مدرسة', 'مدرسة بنات', 'مدرسة متفوقين', 'مطعم فروج',
   'مطعم فلافل', 'مطعم مشاوي', 'مطعم ومسبح', 'مغسلة سيارات', 'مغسلة ومشحم سيارات', 'مكتبة',
   'أفران', 'اكسسوارات ذهب', 'مجوهرات', 'كراج ميكانيك', 'محل هدايا واكسسوارات', 'مطعم وكافيه',
   'مكتب سياحة وسفر', 'عيادة تجميل', 'روضة', 'كافيه', 'مركز طبي متكامل', 'موبايلات واتصالات', 'مفروشات'
 ])
   and not exists (select 1 from public.listings l where l.category_id = c.id);

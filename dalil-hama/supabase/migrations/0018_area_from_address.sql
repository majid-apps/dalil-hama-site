-- دليل حماة — ملء الحي من العنوان (13 تشرين الثاني 2026)
--
-- نحو 6,900 نشاط بلا حي فلا يظهرون في «تصفّح حسب الحي» ولا في فلتر الحي. هذه الـmigration تملأ الحي حين يدلّ عليه
-- العنوان بوضوح، بقاعدتين فقط (الاسم لا يُستعمل لأنه يخدع: «مطعم المحطة» ليس في حي المحطة):
--   1 العنوان يبدأ باسم الحي (بعد حذف «حماة»/«مدينة حماة»/«سوريا» من أوله، وبعد «حي» إن وُجدت): «القصور شارع…»، «حي الحاضر…»
--   2 «حي» متبوعة باسم الحي في أي موضع من العنوان: «حماة - حي الصابونية - دوار…»
-- المطابقة بعد توحيد الكتابة (الهمزات، التاء المربوطة، الألف المقصورة، «ال») فتشمل «قصور» و«دباغة» و«أميريه».
-- إن طابق العنوانُ أكثر من حي بالقاعدة نفسها فالأطول اسماً هو المعتمد، وإن تساويا لا يُعيَّن شيء.
-- لا يُعدَّل إلا نشاط حيّه فارغ، والأحياء الريفية مستثناة (بلدات الريف لها migration 0017).
-- القياس على 4,269 نشاطاً حيّه معيَّن أصلاً: اتفقت القاعدة مع 3,744 وخالفت 30 (عناوين تذكر حيين)، وتسكت عن 495.
-- آمنة للإعادة: لا تملأ إلا ما حيّه فارغ.

create or replace function pg_temp.dh_norm(t text) returns text language sql immutable as $$
  select regexp_replace(
           regexp_replace(translate(lower(coalesce(t, '')), 'أإآةى', 'اااهي'), '[ً-ْـ]', '', 'g'),
           '(^|\s)ال', '\1', 'g')
$$;

drop table if exists pg_temp._ar;
create temp table _ar (name text primary key, nn text not null) on commit drop;
insert into _ar select name, pg_temp.dh_norm(name) from public.areas where not rural;

drop table if exists pg_temp._ac;
create temp table _ac on commit drop as
select l.id, a.name, a.nn, r.rank
from public.listings l
cross join _ar a
cross join lateral (select pg_temp.dh_norm(l.address) as full) f
cross join lateral (
  select btrim(regexp_replace(f.full,
    '^\s*((ريف حماه( الشمالي| الغربي| الشرقي| الجنوبي)?|مدينه حماه|محافظه حماه|حماه|سوريا|سوريه|syria)(\s*[-–—،,|/]+\s*|\s*$))+',
    '', 'i')) as rest
) s
cross join lateral (
  select case
    when s.rest ~ ('^(حي\s+)?' || a.nn || '(?![ء-ي])') then 1
    when f.full ~ ('(^|[^ء-ي])حي\s+' || a.nn || '(?![ء-ي])') then 2
  end as rank
) r
where l.area is null and btrim(coalesce(l.address, '')) <> '' and r.rank is not null;

update public.listings l
   set area = c.name
  from (
    select id, (array_agg(name order by length(nn) desc))[1] as name
    from (select *, min(rank) over (partition by id) as best from _ac) x
    where rank = best
    group by id
    having (array_agg(length(nn) order by length(nn) desc))[1]
           is distinct from (array_agg(length(nn) order by length(nn) desc))[2]
  ) c
 where l.id = c.id and l.area is null;

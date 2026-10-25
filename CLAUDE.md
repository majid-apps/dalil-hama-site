# دليل حماة — تطبيق مجيد (majid-apps) — اقرأ هذا أولاً

لا علاقة لهذا المشروع بمستودع `aposamir/abdulmajid-alia-wedding` (يخص شخصاً آخر). لا تقرأ منه ولا تدفع إليه.

## الموقع الحي: https://dalil-hama.majid.cfd  (الإدارة: /admin/) — الرابط لا يتغير
- **هذا المستودع (`majid-apps/dalil-hama-site`، عام، كود فقط بلا أرقام) هو مصدر الموقع الحي.** المجلد `dalil-hama/`: `public` الواجهة، `supabase/migrations` القاعدة، `deploy/server/dalil-hama-site` سكربت النشر.
- المستودع الخاص `majid-apps/dalil-hama` فيه النسخة القديمة (FastAPI) وملفات الأرقام `data/`؛ لا تضعها هنا أبداً (هذا المستودع عام).
- السيرفر خاص (Hetzner) خلف Caddy، وقاعدته PostgreSQL محلية `dalil_hama` خلف PostgREST (`/rest/v1`) وGoTrue (`/auth/v1`).
  **لا يوجد Supabase ولا Render ولا كليبفورد**؛ لا تستخدم أدوات Supabase/Render MCP.
- لا تملك جلسة Claude وصولاً للسيرفر: أي أمر على السيرفر أو القاعدة تعطيه لمجيد ليلصقه.

## النشر
- السيرفر يسحب `dalil-hama/public` من فرع `main` هنا كل 10 دقائق (الإعداد في `/etc/dalil-hama-site/config`: `REPO=majid-apps/dalil-hama-site` و`BRANCH=main`).
- اعمل على فرع جانبي، ولا تدمج في `main` دون موافقة مجيد (الدمج ينشر على الموقع الحي خلال دقائق).
- تعديل القاعدة = ملف جديد برقم تالٍ في `dalil-hama/supabase/migrations/` ثم على السيرفر `sudo dalil-hama-site install-db`.
- الأوامر: `sudo dalil-hama-site status | update | previous`.
- عند تغيير js/css ارفع `?v=` في `index.html` و`admin/index.html` ورقم `VERSION` في `sw.js`. لا سكربتات مضمّنة في HTML. لا تغيّر `assets/js/config.js`.

## الإدارة
- الدخول بكلمة المرور فقط (دالة `admin_login_hint`، migration 0007). البريد في `public.admins` ولا يظهر في الواجهة. كلمات مرور المشرفين يجب ألا تتطابق.
- روابط سريعة: `/admin/#edit/ID` و`/admin/#new?name=…&phone=…`، وزر «لوحة الإدارة» في الدليل يظهر للمدير المسجّل فقط.

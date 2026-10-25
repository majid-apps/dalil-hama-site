// يطبّق المظهر المحفوظ (فاتح/داكن) قبل رسم الصفحة لتجنّب وميض الألوان.
// ملف منفصل لا نص مضمَّن، كي تبقى سياسة أمان المحتوى (CSP) صارمة.
try { var t = localStorage.getItem('dh:theme'); if (t === '"dark"' || t === '"light"') document.documentElement.dataset.theme = JSON.parse(t); } catch (e) {}

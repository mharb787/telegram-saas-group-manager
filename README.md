# Telegram SaaS Group Manager MVP

مشروع Node.js لبوت تيليجرام SaaS لإدارة المجموعات. يحتوي على Master Bot يستقبل العملاء ويربط بوتات العملاء الخاصة بهم، ثم يشغل كل بوت عميل بإعداداته من SQLite.

## المتطلبات

- Node.js 18 أو أحدث
- حساب Telegram
- بوت Master من BotFather

## التثبيت

```bash
npm install
```

انسخ ملف البيئة:

```bash
cp .env.example .env
```

على Windows PowerShell:

```powershell
Copy-Item .env.example .env
```

عدّل القيم داخل `.env`:

```env
MASTER_BOT_TOKEN=ضع_توكن_بوت_الماستر
PORT=3000
DATABASE_PATH=./data/app.sqlite
TOKEN_SECRET=ضع_نص_طويل_عشوائي_لحماية_التوكنات
DEFAULT_SUBSCRIPTION_DAYS=30
NODE_ENV=development
```

## إنشاء Master Bot

1. افتح Telegram وابحث عن `@BotFather`.
2. أرسل `/newbot`.
3. اختر اسم البوت واسم المستخدم.
4. انسخ التوكن وضعه في `MASTER_BOT_TOKEN`.

## تشغيل المشروع

```bash
npm start
```

سيعمل Express على:

```text
http://localhost:3000
```

وقاعدة البيانات ستنشأ تلقائياً في المسار المحدد داخل `DATABASE_PATH`.

## إضافة بوت عميل

1. افتح Master Bot في تيليجرام.
2. أرسل `/start`.
3. أنشئ بوت جديد من `@BotFather` أو استخدم بوتاً موجوداً.
4. أرسل Bot Token الخاص ببوت العميل إلى Master Bot.
5. سيتحقق النظام من التوكن عبر `getMe`.
6. بعد النجاح، يحفظ النظام التوكن مشفراً ويعرض لوحة تحكم Inline Keyboard.

ملاحظة: لا يتم عرض Bot Token بعد حفظه.

## إضافة بوت العميل إلى مجموعة

1. أضف بوت العميل إلى المجموعة.
2. اجعله Admin من إعدادات المجموعة.
3. امنحه صلاحيات:
   - Delete messages
   - Ban users
   - Restrict members
   - Invite users إذا احتجت
4. جرّب الأمر `/rules` داخل المجموعة.

## إعدادات لوحة العميل

من لوحة Master Bot يستطيع العميل تعديل:

- رسالة الترحيب
- منع الروابط
- منع السبام
- الكلمات الممنوعة
- عدد الإنذارات قبل العقوبة
- مدة الكتم بالدقائق
- رسالة قوانين المجموعة
- اللغة: عربي / إنجليزي
- الردود التلقائية
- إضافة رد تلقائي بكلمة مفتاحية ورد

## أوامر بوت العميل داخل المجموعة

الأوامر العامة:

```text
/rules
```

أوامر المشرفين، وتستخدم غالباً كرد على رسالة المستخدم:

```text
/warn
/mute
/mute 60
/ban
/unban
/settings
```

## الاشتراكات

يوجد هيكل جاهز للاشتراكات بدون بوابة دفع:

- `basic`
- `pro`
- `vip`

كل بوت جديد يحصل على اشتراك `basic` افتراضي حسب `DEFAULT_SUBSCRIPTION_DAYS`. عند انتهاء الاشتراك يتوقف تنفيذ وظائف بوت العميل ويرسل إشعاراً للمالك عند محاولة استخدامه.

## الأمان

- يتم تشفير توكنات بوتات العملاء باستخدام `aes-256-gcm` وقيمة `TOKEN_SECRET`.
- لا يتم عرض التوكن بعد حفظه.
- يوجد validation أساسي للمدخلات.
- لا يتم تنفيذ أي كود من المستخدم.
- أخطاء Telegram API يتم التقاطها وتسجيلها بدون إسقاط السيرفر.

## هيكل المشروع

```text
src/
  index.js
  database.js
  masterBot.js
  customerBotManager.js
  customerBot.js
  services/
    moderation.js
    subscription.js
    settings.js
  utils/
    validators.js
```

هذا إصدار MVP عملي ومقصود أن يكون بسيطاً وقابلاً للتوسعة. الخطوة التالية عادة تكون إضافة Webhooks بدلاً من polling، نظام دفع، لوحة ويب، وسجل Audit للأحداث.

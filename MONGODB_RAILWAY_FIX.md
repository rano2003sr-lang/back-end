# إصلاح خطأ اتصال MongoDB من Railway

## المشكلة
```
خطأ في MongoDB ❌ انتهت مهلة اختيار الخادم بعد 30000 مللي ثانية
ReplicaSetNoPrimary
```

## السبب
Railway يستخدم عناوين IP ديناميكية. MongoDB Atlas يسمح بالاتصال فقط من عناوين IP المضافة في Network Access.

## الحل

### 1. افتح MongoDB Atlas
- ادخل إلى [cloud.mongodb.com](https://cloud.mongodb.com)
- اختر مشروعك (Project)
- اختر Cluster الخاص بك

### 2. Network Access
- من القائمة الجانبية: **Network Access** (أو "الوصول للشبكة")
- اضغط **Add IP Address** أو **ADD IP ADDRESS**

### 3. إضافة عنوان IP

**خيار أ — إضافة IP محدد (مثلاً للسيرفر المحلي):**
- أدخل: `169.224.11.158/32`
- أو أي IP آخر تريد السماح له
- اضغط **Confirm**

**خيار ب — السماح لجميع العناوين (للـ Railway أو السيرفرات السحابية):**
- اختر **Allow Access from Anywhere**
- أو أدخل يدوياً: `0.0.0.0/0`
- اضغط **Confirm**

### 4. انتظر دقيقة
- قد يستغرق تفعيل التغيير 1–2 دقيقة

### 5. أعد تشغيل الباك اند على Railway
- من لوحة Railway: اختر المشروع → Deployments → Redeploy

---

## ملاحظات أمان
- `0.0.0.0/0` يسمح بالاتصال من أي عنوان IP
- تأكد من استخدام كلمة مرور قوية لـ MongoDB
- يمكن لاحقاً استخدام VPC Peering أو Private Endpoints لتحسين الأمان

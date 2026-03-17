const express = require("express");
const { OAuth2Client } = require("google-auth-library");
const jwt = require("jsonwebtoken");
const User = require("../module/Users");
const axios = require("axios");
const { sendPushNotification, buildImageUrl, getBaseUrl } = require("../utils/push");

const router = express.Router();

/* ================== HELPERS ================== */
const generateUserId = () => Math.floor(10000000 + Math.random() * 90000000).toString();

function toUserResponse(user) {
  return {
    id: user.userId,
    name: user.name,
    email: user.email,
    profileImage: user.profileImage || "",
    avatar: user.profileImage || "",
    age: user.age ?? null,
    dateOfBirth: user.dateOfBirth || "",
    height: user.height ?? null,
    weight: user.weight ?? null,
    country: user.country || "",
    gender: user.gender || "",
    hobby: user.hobby || "",
    month: user.month || "",
  };
}
const generatePin = () => Math.floor(100000 + Math.random() * 900000).toString();
const generateRandomPassword = () => Math.random().toString(36).slice(-12);

/* ================== BREVO API (Transactional Email) ================== */
// يستخدم API key (xkeysib-...) وليس SMTP - يعمل مباشرة بدون مشاكل مصادقة
async function sendPinEmail(toEmail, pin) {
  const apiKey = process.env.BREVO_API_KEY || process.env.BREVO_SMTP_KEY;
  const fromEmail = process.env.BREVO_FROM_EMAIL;

  if (!apiKey || !fromEmail) {
    throw new Error("إعدادات Brevo ناقصة: BREVO_API_KEY و BREVO_FROM_EMAIL مطلوبان في .env");
  }

  const res = await axios.post(
    "https://api.brevo.com/v3/smtp/email",
    {
      sender: { name: "Rolet", email: fromEmail },
      to: [{ email: toEmail }],
      subject: "كود تسجيل الدخول - Rolet",
      htmlContent: `
        <div style="font-family:Arial;direction:rtl;text-align:right;padding:20px">
          <h2>كود تسجيل الدخول</h2>
          <p>الكود الخاص بك هو:</p>
          <h1 style="letter-spacing:8px;color:#1B1036">${pin}</h1>
          <p>الكود صالح لمدة 5 دقائق</p>
        </div>
      `,
    },
    {
      headers: {
        "accept": "application/json",
        "content-type": "application/json",
        "api-key": apiKey.trim(),
      },
      timeout: 15000,
    }
  );

  return res.data;
}

/* ================== CHECK EMAIL (هل البريد مسجل؟) ================== */
router.post("/auth/check-email", async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ success: false, message: "البريد الإلكتروني مطلوب" });

    const trimmedEmail = String(email).trim().toLowerCase();
    const user = await User.findOne({ email: trimmedEmail });
    res.json({ success: true, exists: !!user });
  } catch (error) {
    console.error("check-email error:", error);
    res.status(500).json({ success: false, message: "خطأ في التحقق" });
  }
});

/* ================== REQUEST PIN (تسجيل دخول - للمستخدمين المسجلين فقط) ================== */
router.post("/auth/request-pin", async (req, res) => {
  try {
    const { email, mode } = req.body;
    if (!email) return res.status(400).json({ success: false, message: "البريد الإلكتروني مطلوب" });

    const trimmedEmail = String(email).trim().toLowerCase();
    if (!trimmedEmail) return res.status(400).json({ success: false, message: "البريد الإلكتروني مطلوب" });

    let user = await User.findOne({ email: trimmedEmail });

    if (mode === "login") {
      if (!user) return res.status(404).json({ success: false, message: "البريد غير مسجل. قم بالتسجيل أولاً" });
    } else if (mode === "signup") {
      if (user) return res.status(409).json({ success: false, message: "البريد مسجّل مسبقاً. سجّل دخولك" });
      if (!user) {
        user = await User.create({
          userId: generateUserId(),
          name: trimmedEmail.split("@")[0] || "مستخدم جديد",
          email: trimmedEmail,
          password: generateRandomPassword(),
          profileImage: "",
        });
      }
    } else {
      if (!user) {
        user = await User.create({
          userId: generateUserId(),
          name: trimmedEmail.split("@")[0] || "مستخدم جديد",
          email: trimmedEmail,
          password: generateRandomPassword(),
          profileImage: "",
        });
      }
    }

    const pin = generatePin();
    user.loginPin = pin;
    user.loginPinExpiresAt = new Date(Date.now() + 5 * 60 * 1000);
    await user.save();

    res.json({ success: true, message: "تم إرسال كود التفعيل إلى بريدك" });

    sendPinEmail(trimmedEmail, pin).catch((e) =>
      console.error("sendPinEmail background error:", e?.response?.data || e?.message)
    );
  } catch (error) {
    console.error("request-pin error:", error?.response?.data || error.message);
    const msg = error?.response?.data?.message || error?.message || "فشل إرسال كود التفعيل";
    res.status(500).json({ success: false, message: msg });
  }
});

/* ================== VERIFY PIN ================== */
router.post("/auth/verify-pin", async (req, res) => {
  try {
    const { email, pin } = req.body;
    if (!email || !pin) return res.status(400).json({ success: false, message: "الإيميل والكود مطلوبان" });

    const trimmedEmail = String(email).trim().toLowerCase();
    const user = await User.findOne({ email: trimmedEmail });
    if (!user || !user.loginPin || !user.loginPinExpiresAt)
      return res.status(400).json({ success: false, message: "لا يوجد كود فعال" });

    if (new Date() > user.loginPinExpiresAt) {
      user.loginPin = null;
      user.loginPinExpiresAt = null;
      await user.save();
      return res.status(400).json({ success: false, message: "انتهت صلاحية الكود" });
    }

    if (user.loginPin !== pin) return res.status(400).json({ success: false, message: "الكود غير صحيح" });

    user.loginPin = null;
    user.loginPinExpiresAt = null;
    await user.save();

    const token = jwt.sign({ id: user.userId, email: user.email }, process.env.JWT_SECRET, { expiresIn: "30d" });

    res.json({
      success: true,
      token,
      userId: user.userId,
      user: toUserResponse(user),
    });
  } catch (error) {
    console.error("verify-pin error:", error);
    res.status(500).json({ success: false, message: "خطأ أثناء التحقق" });
  }
});

/* ================== AUTH MIDDLEWARE ================== */
const auth = (req, res, next) => {
  const header = req.headers.authorization;
  if (!header) return res.status(401).json({ message: "لا يوجد توكن" });

  const token = header.split(" ")[1];
  if (!token) return res.status(401).json({ message: "توكن غير صالح" });

  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ message: "توكن منتهي أو غير صالح" });
  }
};

/* ================== GOOGLE LOGIN ================== */
router.post("/google-login", async (req, res) => {
  try {
    const { idToken } = req.body;
    const clientId = process.env.GOOGLE_CLIENT_ID;
    if (!idToken || !clientId) return res.status(400).json({ message: "بيانات Google ناقصة" });

    const client = new OAuth2Client(clientId);
    const ticket = await client.verifyIdToken({ idToken, audience: clientId });
    const { email, name, picture } = ticket.getPayload();

    let user = await User.findOne({ email });
    if (!user) {
      user = await User.create({ userId: generateUserId(), name: name || "مستخدم Google", email, password: "", profileImage: picture || "" });
    }

    const token = jwt.sign({ id: user.userId, email: user.email }, process.env.JWT_SECRET, { expiresIn: "30d" });

    res.json({ success: true, token, user: toUserResponse(user) });
  } catch (error) {
    console.error("google-login error:", error);
    res.status(500).json({ message: "فشل تسجيل الدخول عبر Google" });
  }
});

/* ================== AUTH ME ================== */
const authMeCache = new Map();
const AUTH_ME_TTL = 2000;
router.get("/auth/me", auth, async (req, res) => {
  const meId = req.user.id;
  const cached = authMeCache.get(meId);
  if (cached && Date.now() - cached.ts < AUTH_ME_TTL) {
    return res.json(cached.data);
  }
  const user = await User.findOne({ userId: meId }).select("-password -loginPin -loginPinExpiresAt");
  if (!user) return res.status(404).json({ message: "المستخدم غير موجود" });
  const payload = { success: true, user: toUserResponse(user) };
  authMeCache.set(meId, { data: payload, ts: Date.now() });
  res.json(payload);
});

/* ================== ONLINE STATUS (النقطة الخضراء) ================== */
const onlineUsers = new Map(); // userId -> lastSeenAt
const ONLINE_TTL_MS = 5000;

function cleanupOnlineStale() {
  const now = Date.now();
  for (const [userId, lastSeen] of onlineUsers.entries()) {
    if (now - lastSeen > ONLINE_TTL_MS) onlineUsers.delete(userId);
  }
}

/* ================== ONLINE (إشعار الأصدقاء + تسجيل الاتصال) ================== */
router.post("/auth/online", auth, async (req, res) => {
  try {
    const meId = req.user.id;
    onlineUsers.set(meId, Date.now());
    const me = await User.findOne({ userId: meId }).select("name profileImage friends");
    if (!me || !me.friends || me.friends.length === 0) {
      return res.json({ success: true });
    }
    const friendIds = me.friends.map((f) => f.userId).filter(Boolean);
    if (friendIds.length === 0) return res.json({ success: true });

    const friendsWithTokens = await User.find({
      userId: { $in: friendIds },
      pushToken: { $exists: true, $ne: "" },
    }).select("userId pushToken");

    const baseUrl = getBaseUrl(req);
    const myName = me.name || "صديقك";
    const myImage = buildImageUrl(me.profileImage, baseUrl);
    const title = myName;
    const body = "متصل - تعال لدردشة";

    const promises = friendsWithTokens.map((f) =>
      sendPushNotification(f.pushToken, title, body, myImage)
    );
    await Promise.allSettled(promises);

    res.json({ success: true });
  } catch (err) {
    console.error("online notify error:", err);
    res.json({ success: true });
  }
});

router.post("/auth/offline", auth, (req, res) => {
  onlineUsers.delete(req.user.id);
  res.json({ success: true });
});

router.get("/auth/online-users", auth, (req, res) => {
  cleanupOnlineStale();
  res.json({ success: true, userIds: Array.from(onlineUsers.keys()) });
});

/* ================== PUSH TOKEN (للإشعارات) ================== */
router.post("/auth/push-token", auth, async (req, res) => {
  try {
    const { pushToken } = req.body;
    if (!pushToken || typeof pushToken !== "string") {
      return res.status(400).json({ success: false, message: "رمز الإشعار مطلوب" });
    }
    const user = await User.findOne({ userId: req.user.id });
    if (!user) return res.status(404).json({ success: false, message: "المستخدم غير موجود" });
    user.pushToken = pushToken.trim();
    await user.save();
    res.json({ success: true });
  } catch (error) {
    console.error("push-token error:", error);
    res.status(500).json({ success: false, message: "خطأ في حفظ رمز الإشعار" });
  }
});

/* ================== UPDATE PROFILE ================== */
// الحقول التي تُخزَن مرة واحدة ولا تُغيّر لاحقاً: age, dateOfBirth, height, weight, country, gender, hobby, month
// يُسمح بتعديل الاسم والصورة فقط بعد الاكتمال
router.put("/auth/profile", auth, async (req, res) => {
  try {
    const { name, profileImage, avatar, age, dateOfBirth, height, weight, country, gender, hobby, month } = req.body;
    const user = await User.findOne({ userId: req.user.id });
    if (!user) return res.status(404).json({ message: "المستخدم غير موجود" });

    // الاسم والصورة دائماً قابلة للتعديل
    if (name !== undefined) user.name = String(name).trim() || user.name;
    const img = profileImage || avatar;
    if (img !== undefined) user.profileImage = img;

    // الحقول ذات المرّة الواحدة: تُحدَّث فقط إذا كانت فارغة حالياً
    const setOnce = (field, value, setter) => {
      const isEmpty = field === "" || field === null || field === undefined;
      if (isEmpty && value !== undefined && value !== "" && value !== null) setter(value);
    };
    setOnce(user.age, age === "" || age === null ? null : Number(age), (v) => { user.age = v; });
    setOnce(user.dateOfBirth, dateOfBirth ? String(dateOfBirth) : "", (v) => { user.dateOfBirth = v; });
    setOnce(user.height, height === "" || height === null ? null : Number(height), (v) => { user.height = v; });
    setOnce(user.weight, weight === "" || weight === null ? null : Number(weight), (v) => { user.weight = v; });
    setOnce(user.country, country ? String(country).trim() : "", (v) => { user.country = v; });
    setOnce(user.gender, gender ? String(gender).trim() : "", (v) => { user.gender = v; });
    setOnce(user.hobby, hobby ? String(hobby).trim() : "", (v) => { user.hobby = v; });
    setOnce(user.month, month ? String(month).trim() : "", (v) => { user.month = v; });

    await user.save();

    authMeCache.delete(req.user.id);

    res.json({ success: true, user: toUserResponse(user) });
  } catch (error) {
    console.error("profile update error:", error);
    res.status(500).json({ message: "خطأ في تحديث الملف الشخصي" });
  }
});

/* ================== DELETE ACCOUNT (مسح الحساب) ================== */
router.delete("/auth/account", auth, async (req, res) => {
  try {
    const userId = req.user.id;
    const User = require("../module/Users");
    const Message = require("../module/Messages");
    const Moment = require("../module/Moment");
    const Wallet = require("../module/Wallet");

    await Promise.all([
      User.deleteOne({ userId }),
      Message.deleteMany({ $or: [{ fromId: userId }, { toId: userId }] }),
      Moment.deleteMany({ userId }),
      Wallet.deleteOne({ userId }),
    ]);

    await User.updateMany(
      {},
      {
        $pull: {
          followers: { userId },
          friends: { userId },
          blocked: { userId },
          profileVisitors: { userId },
        },
      }
    );

    res.json({ success: true, message: "تم مسح الحساب بنجاح" });
  } catch (error) {
    console.error("delete-account error:", error);
    res.status(500).json({ success: false, message: "تعذر مسح الحساب" });
  }
});

module.exports = { router, auth };

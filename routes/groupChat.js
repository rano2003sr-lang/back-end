const express = require("express");
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const { auth } = require("../authGoogle/googleAuth");
const User = require("../module/Users");
const GroupChatMessage = require("../module/GroupChatMessage");
const Wallet = require("../module/Wallet");

// تخزين مؤقت للرسائل — يقلل الضغط على MongoDB عند الاستعلام المتكرر
const messagesCache = { data: null, ts: 0 };
const MESSAGES_CACHE_MS = 3000;
const { getBaseUrl } = require("../utils/push");
const { AccessToken } = require("livekit-server-sdk");

const router = express.Router();

const musicDir = path.join(__dirname, "../uploads/music");
if (!fs.existsSync(musicDir)) fs.mkdirSync(musicDir, { recursive: true });
const musicUpload = multer({
  storage: multer.diskStorage({
    destination: (_, __, cb) => cb(null, musicDir),
    filename: (_, file, cb) => {
      const ext = (path.extname(file.originalname || "") || ".mp3").toLowerCase();
      cb(null, `music_${Date.now()}_${Math.random().toString(36).slice(2)}${ext}`);
    },
  }),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (_, file, cb) => {
    const ok =
      ["audio/mpeg", "audio/mp3", "audio/m4a", "audio/x-m4a", "audio/aac"].includes(file.mimetype) ||
      [".mp3", ".m4a", ".aac"].some((e) => (file.originalname || "").toLowerCase().endsWith(e));
    cb(null, !!ok);
  },
});

const LIVEKIT_ROOM = "rolet-group-chat";

// غرفة الدردشة الجماعية — تخزين مؤقت في الذاكرة
// كل مستخدم: { userId, name, gender, profileImage, joinedAt, lastSeen }
const roomUsers = new Map();
// الشقق (1-8): slotIndex -> { userId, name, profileImage }
const roomSlots = new Map();

const STALE_MS = 8 * 1000; // 8 ثوانٍ بدون نبض = اعتبار المستخدم مغلقاً (إغلاق التطبيق أو التنقل الطويل)

function touchUser(userId) {
  const u = roomUsers.get(userId);
  if (u) {
    u.lastSeen = Date.now();
  }
}

function cleanupStale() {
  const now = Date.now();
  for (const [userId, data] of roomUsers.entries()) {
    const lastSeen = data.lastSeen ?? data.joinedAt ?? 0;
    if (now - lastSeen > STALE_MS) {
      roomUsers.delete(userId);
      for (const [idx, slot] of roomSlots.entries()) {
        if (slot.userId === userId) roomSlots.delete(idx);
      }
    }
  }
}

// تنظيف دوري كل 3 ثوانٍ — لإزالة من أُغلق تطبيقهم
setInterval(cleanupStale, 3000);

/** دخول غرفة الدردشة الجماعية */
router.post("/group-chat/join", auth, async (req, res) => {
  try {
    const meId = req.user.id;
    const me = await User.findOne({ userId: meId }).select("name gender profileImage");
    if (!me) return res.status(404).json({ success: false, message: "المستخدم غير موجود" });

    const now = Date.now();
    roomUsers.set(meId, {
      userId: meId,
      name: me.name || "مستخدم",
      gender: me.gender || "male",
      profileImage: me.profileImage || null,
      joinedAt: now,
      lastSeen: now,
    });
    cleanupStale();
    res.json({ success: true });
  } catch (err) {
    console.error("group-chat join error:", err);
    res.status(500).json({ success: false });
  }
});

/** توكن LiveKit للصوت المباشر — LiveKit أرخص/مجاني عند الاستضافة الذاتية */
router.get("/group-chat/voice-token", auth, async (req, res) => {
  try {
    const apiKey = process.env.LIVEKIT_API_KEY;
    const apiSecret = process.env.LIVEKIT_API_SECRET;
    const wsUrl = process.env.LIVEKIT_WS_URL;
    if (!apiKey || !apiSecret || !wsUrl) {
      return res.status(503).json({ success: false, message: "LiveKit غير مُعد" });
    }
    const meId = req.user.id;
    const me = await User.findOne({ userId: meId }).select("name");
    const identity = meId;
    const name = me?.name || "مستخدم";
    const at = new AccessToken(apiKey, apiSecret, { identity, name, ttl: "2h" });
    at.addGrant({ roomJoin: true, room: LIVEKIT_ROOM, canPublish: true, canSubscribe: true });
    const token = await at.toJwt();
    res.json({ success: true, token, wsUrl });
  } catch (err) {
    console.error("voice-token error:", err);
    res.status(500).json({ success: false });
  }
});

/** رفع أغنية للبث في الدردشة الجماعية */
router.post("/group-chat/upload-music", auth, musicUpload.single("music"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, message: "الملف مطلوب" });
    const base = getBaseUrl(req);
    const musicUrl = `${base}/uploads/music/${req.file.filename}`;
    res.json({ success: true, musicUrl });
  } catch (err) {
    console.error("upload-music error:", err);
    res.status(500).json({ success: false, message: "خطأ في رفع الأغنية" });
  }
});

/** مغادرة غرفة الدردشة */
router.post("/group-chat/leave", auth, async (req, res) => {
  try {
    const meId = req.user.id;
    for (const [idx, data] of roomSlots.entries()) {
      if (data.userId === meId) roomSlots.delete(idx);
    }
    roomUsers.delete(meId);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false });
  }
});

/** أخذ شقة أو ترك المايك — كل مستخدم بشكل منفرد */
router.post("/group-chat/slot", auth, async (req, res) => {
  try {
    const meId = req.user.id;
    touchUser(meId);
    const { slotIndex, action } = req.body;
    if (action === "release") {
      for (const [idx, data] of roomSlots.entries()) {
        if (data.userId === meId) roomSlots.delete(idx);
      }
      return res.json({ success: true, slots: await getSlotsWithWallet() });
    }
    const idx = parseInt(slotIndex, 10);
    if (!Number.isFinite(idx) || idx < 1 || idx > 8) {
      return res.status(400).json({ success: false, message: "رقم الشقة غير صالح" });
    }
    for (const [i, data] of roomSlots.entries()) {
      if (data.userId === meId) roomSlots.delete(i);
    }
    const me = await User.findOne({ userId: meId }).select("name profileImage");
    if (!me) return res.status(404).json({ success: false, message: "المستخدم غير موجود" });
    roomSlots.set(idx, {
      userId: meId,
      name: me.name || "مستخدم",
      profileImage: me.profileImage || null,
    });
    res.json({ success: true, slots: await getSlotsWithWallet() });
  } catch (err) {
    console.error("group-chat slot error:", err);
    res.status(500).json({ success: false });
  }
});

function getSlotsArray() {
  const arr = [];
  for (let i = 1; i <= 8; i++) {
    const data = roomSlots.get(i);
    arr.push(data ? { slotIndex: i, userId: data.userId, name: data.name, profileImage: data.profileImage } : null);
  }
  return arr;
}

async function getSlotsWithWallet() {
  const slots = getSlotsArray();
  const userIds = slots.filter(Boolean).map((s) => s.userId);
  const wallets = userIds.length
    ? await Wallet.find({ userId: { $in: userIds } }).select("userId totalGold chargedGold freeGold diamonds").lean()
    : [];
  const walletMap = Object.fromEntries(wallets.map((w) => [w.userId, w]));
  return slots.map((s) => {
    if (!s) return null;
    const w = walletMap[s.userId] || {};
    const totalGold = (w.chargedGold ?? 0) + (w.freeGold ?? 0);
    const diamonds = w.diamonds ?? 0;
    const chargedGold = w.chargedGold ?? 0;
    const level = Math.floor(diamonds / 10) + 1;
    return { ...s, totalGold, diamonds, chargedGold, level };
  });
}

/** جلب الشقق الحالية — مع ثروة وسحر وليفل */
router.get("/group-chat/slots", auth, async (req, res) => {
  try {
    touchUser(req.user.id);
    cleanupStale();
    const slots = await getSlotsWithWallet();
    res.json({ success: true, slots });
  } catch (err) {
    res.status(500).json({ success: false });
  }
});

/** قائمة المستخدمين الحاليين في الغرفة */
router.get("/group-chat/users", auth, async (req, res) => {
  try {
    touchUser(req.user.id);
    cleanupStale();
    const list = Array.from(roomUsers.values()).map((u) => ({
      userId: u.userId,
      name: u.name,
      gender: u.gender,
      profileImage: u.profileImage || null,
    }));
    res.json({ success: true, users: list });
  } catch (err) {
    console.error("group-chat users error:", err);
    res.status(500).json({ success: false });
  }
});

/** جلب رسائل الدردشة الجماعية — مع cache لتخفيف الضغط */
router.get("/group-chat/messages", auth, async (req, res) => {
  try {
    const now = Date.now();
    if (messagesCache.data && now - messagesCache.ts < MESSAGES_CACHE_MS) {
      return res.json(messagesCache.data);
    }
    const limit = Math.min(parseInt(req.query.limit, 10) || 250, 250);
    const msgs = await GroupChatMessage.find({ roomId: "main" })
      .select("fromId fromName fromProfileImage toId text createdAt audioUrl audioDurationSeconds imageUrl")
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();
    const payload = {
      success: true,
      messages: msgs.reverse().map((m) => ({
        id: String(m._id),
        fromId: m.fromId,
        fromName: m.fromName,
        fromProfileImage: m.fromProfileImage,
        toId: m.toId,
        text: m.text,
        createdAt: m.createdAt,
        audioUrl: m.audioUrl,
        audioDurationSeconds: m.audioDurationSeconds,
        imageUrl: m.imageUrl,
      })),
    };
    messagesCache.data = payload;
    messagesCache.ts = now;
    res.json(payload);
  } catch (err) {
    // عند فشل MongoDB: إرجاع آخر cache إن وُجد (لتجنب شاشة فارغة)
    if (messagesCache.data) {
      return res.json(messagesCache.data);
    }
    console.error("group-chat messages error:", err?.message || err);
    res.status(500).json({ success: false });
  }
});

module.exports = router;

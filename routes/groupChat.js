const express = require("express");
const { auth } = require("../authGoogle/googleAuth");
const User = require("../module/Users");
const GroupChatMessage = require("../module/GroupChatMessage");
const Wallet = require("../module/Wallet");
const { sendPushNotification } = require("../utils/push");
const { AccessToken } = require("livekit-server-sdk");

const router = express.Router();

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

/** إرسال رسالة في الدردشة الجماعية */
router.post("/group-chat/send", auth, async (req, res) => {
  try {
    const fromId = req.user.id;
    touchUser(fromId);
    cleanupStale();
    const { text, audioUrl, audioDurationSeconds, imageUrl, toId, giftAmount } = req.body;
    const isVoice = !!audioUrl;
    const isImage = !!imageUrl;
    const textVal = isVoice ? "🎤 رسالة صوتية" : isImage ? "📷 صورة" : (text || "").trim();
    if (!isVoice && !isImage && !textVal) {
      return res.status(400).json({ success: false, message: "النص أو المحتوى مطلوب" });
    }

    const fromUser = await User.findOne({ userId: fromId }).select("userId name profileImage age gender");
    if (!fromUser) return res.status(404).json({ success: false, message: "المستخدم غير موجود" });

    let finalText = String(textVal).slice(0, 500);
    let giftToId = toId || null;

    const giftMatch = String(textVal).match(/^GIFT:([^:]+):(\d+)$/);
    if (giftMatch) {
      const amount = parseInt(giftMatch[2], 10);
      if (Number.isFinite(amount) && amount > 0 && giftToId) {
        let senderWallet = await Wallet.findOne({ userId: fromId });
        if (!senderWallet) {
          senderWallet = await Wallet.create({ userId: fromId, totalGold: 0, chargedGold: 0, freeGold: 0, diamonds: 0, transactions: [] });
        }
        const totalAvail = (senderWallet.chargedGold ?? 0) + (senderWallet.freeGold ?? 0);
        if (totalAvail < amount) {
          return res.status(400).json({ success: false, message: "رصيدك من الذهب غير كافٍ لإرسال الهدية" });
        }
        const charged = senderWallet.chargedGold ?? 0;
        const free = senderWallet.freeGold ?? 0;
        const takeFromCharged = Math.min(charged, amount);
        const takeFromFree = amount - takeFromCharged;
        senderWallet.chargedGold = charged - takeFromCharged;
        senderWallet.freeGold = free - takeFromFree;
        senderWallet.totalGold = senderWallet.chargedGold + senderWallet.freeGold;
        senderWallet.diamonds = Math.round(((senderWallet.diamonds ?? 0) + amount * 0.001) * 100) / 100;
        await senderWallet.save();

        const diamondsEarned = Math.round((takeFromCharged * 0.45 + takeFromFree * 0.001) * 100) / 100;
        let receiverWallet = await Wallet.findOne({ userId: giftToId });
        if (!receiverWallet) {
          receiverWallet = await Wallet.create({ userId: giftToId, totalGold: 0, chargedGold: 0, freeGold: 0, diamonds: 0, transactions: [] });
        }
        receiverWallet.diamonds = Math.round(((receiverWallet.diamonds ?? 0) + diamondsEarned) * 100) / 100;
        await receiverWallet.save();
      }
    }

    const msg = await GroupChatMessage.create({
      roomId: "main",
      fromId,
      fromName: fromUser.name || "مستخدم",
      fromProfileImage: fromUser.profileImage || null,
      toId: giftToId,
      text: finalText,
      audioUrl: audioUrl || null,
      audioDurationSeconds: audioDurationSeconds != null ? Number(audioDurationSeconds) : null,
      imageUrl: imageUrl || null,
    });

    const MAX = 250;
    const all = await GroupChatMessage.find({ roomId: "main" }).sort({ createdAt: 1 }).select("_id").lean();
    if (all.length > MAX) {
      const toDel = all.slice(0, all.length - MAX).map((m) => m._id);
      await GroupChatMessage.deleteMany({ _id: { $in: toDel } });
    }

    // إرسال إشعار push لجميع المستخدمين في الغرفة (ما عدا المرسل)
    const notifyUserIds = Array.from(roomUsers.keys()).filter((id) => id !== fromId);
    if (notifyUserIds.length > 0) {
      const recipients = await User.find({ userId: { $in: notifyUserIds }, pushToken: { $exists: true, $ne: "" } }).select("userId pushToken").lean();
      let notifBody = String(finalText || "").slice(0, 80);
      if (audioUrl) notifBody = "🎤 رسالة صوتية";
      else if (imageUrl) notifBody = "📷 صورة";
      else if (/^GIFT:/.test(finalText || "")) notifBody = "🎁 هدية";
      const notifTitle = `${fromUser.name || "مستخدم"} في الدردشة الجماعية`;
      for (const r of recipients) {
        if (r.pushToken) {
          sendPushNotification(r.pushToken, notifTitle, notifBody || "رسالة جديدة", null, {
            type: "groupMessage",
            fromId,
            fromName: fromUser.name || "",
          }).catch((e) => console.error("[groupChat] push error:", e?.message));
        }
      }
    }

    let fromWallet = await Wallet.findOne({ userId: fromId }).select("diamonds chargedGold").lean();
    if (!fromWallet) fromWallet = { diamonds: 0, chargedGold: 0 };
    res.json({
      success: true,
      message: {
        id: msg._id,
        fromId: msg.fromId,
        fromName: msg.fromName,
        fromProfileImage: msg.fromProfileImage,
        fromAge: fromUser.age ?? null,
        fromGender: fromUser.gender || null,
        fromDiamonds: fromWallet.diamonds ?? 0,
        fromChargedGold: fromWallet.chargedGold ?? 0,
        toId: msg.toId,
        text: msg.text,
        createdAt: msg.createdAt,
        audioUrl: msg.audioUrl,
        audioDurationSeconds: msg.audioDurationSeconds,
        imageUrl: msg.imageUrl,
      },
    });
  } catch (err) {
    console.error("group-chat send error:", err);
    res.status(500).json({ success: false, message: "خطأ في إرسال الرسالة" });
  }
});

/** جلب رسائل الدردشة الجماعية — مع بيانات المرسل (عمر، جنس، ماس، مشحون) */
router.get("/group-chat/messages", auth, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 250, 250);
    const msgs = await GroupChatMessage.find({ roomId: "main" })
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();
    const fromIds = [...new Set(msgs.map((m) => m.fromId))];
    const users = await User.find({ userId: { $in: fromIds } }).select("userId age gender").lean();
    const wallets = await Wallet.find({ userId: { $in: fromIds } }).select("userId diamonds chargedGold").lean();
    const userMap = Object.fromEntries(users.map((u) => [u.userId, u]));
    const walletMap = Object.fromEntries(wallets.map((w) => [w.userId, w]));
    res.json({
      success: true,
      messages: msgs.reverse().map((m) => {
        const u = userMap[m.fromId] || {};
        const w = walletMap[m.fromId] || {};
        return {
          id: m._id,
          fromId: m.fromId,
          fromName: m.fromName,
          fromProfileImage: m.fromProfileImage,
          fromAge: u.age ?? null,
          fromGender: u.gender || null,
          fromDiamonds: w.diamonds ?? 0,
          fromChargedGold: w.chargedGold ?? 0,
          toId: m.toId,
          text: m.text,
          createdAt: m.createdAt,
          audioUrl: m.audioUrl,
          audioDurationSeconds: m.audioDurationSeconds,
          imageUrl: m.imageUrl,
        };
      }),
    });
  } catch (err) {
    console.error("group-chat messages error:", err);
    res.status(500).json({ success: false });
  }
});

module.exports = router;

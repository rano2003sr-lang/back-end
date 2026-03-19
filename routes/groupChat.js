const express = require("express");
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const jwt = require("jsonwebtoken");
const { AccessToken } = require("livekit-server-sdk");
const GroupChatMessage = require("../module/GroupChatMessage");
const User = require("../module/Users");
const Wallet = require("../module/Wallet");
const { auth } = require("../authGoogle/googleAuth");
const { getBaseUrl } = require("../utils/push");

const router = express.Router();

const ROOM_NAME = "group-chat-room";

// in-memory store for slots and room membership (replace with Redis in production)
const slots = new Map(); // slotIndex -> { userId, name, profileImage, ... }
const roomMembers = new Set(); // userId

// حالة الموسيقى المشتركة — تُبث لجميع المستخدمين
let musicState = {
  url: null,
  isPlaying: false,
  playlist: [],
  currentIndex: 0,
  volume: 1,
  updatedAt: 0,
};

const musicDir = path.join(__dirname, "../uploads/music");
if (!fs.existsSync(musicDir)) fs.mkdirSync(musicDir, { recursive: true });
const musicUpload = multer({
  storage: multer.diskStorage({
    destination: (_, __, cb) => cb(null, musicDir),
    filename: (_, __, cb) => cb(null, `song_${Date.now()}_${Math.random().toString(36).slice(2)}.mp3`),
  }),
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (_, file, cb) => {
    const ok =
      ["audio/mpeg", "audio/mp3", "audio/m4a", "audio/x-m4a", "audio/aac"].includes(file.mimetype) ||
      (file.originalname || "").toLowerCase().match(/\.(mp3|m4a|aac)$/);
    cb(null, !!ok);
  },
});

// POST /api/group-chat/join
router.post("/group-chat/join", auth, async (req, res) => {
  try {
    roomMembers.add(req.user.id);
    res.json({ success: true });
  } catch (err) {
    console.error("group-chat join error:", err);
    res.status(500).json({ success: false, message: "خطأ في الانضمام" });
  }
});

// POST /api/group-chat/leave
router.post("/group-chat/leave", auth, async (req, res) => {
  try {
    roomMembers.delete(req.user.id);
    for (const [idx, data] of slots.entries()) {
      if (data && data.userId === req.user.id) {
        slots.delete(idx);
        break;
      }
    }
    res.json({ success: true });
  } catch (err) {
    console.error("group-chat leave error:", err);
    res.status(500).json({ success: false, message: "خطأ في المغادرة" });
  }
});

// POST /api/group-chat/slot — take or release slot
router.post("/group-chat/slot", auth, async (req, res) => {
  try {
    const { slotIndex, action } = req.body;
    const meId = req.user.id;

    if (action === "release") {
      for (const [idx, data] of slots.entries()) {
        if (data && data.userId === meId) {
          slots.delete(idx);
          break;
        }
      }
    } else if (action === "take" && typeof slotIndex === "number" && slotIndex >= 0 && slotIndex < 8) {
      for (const [idx] of slots.entries()) {
        if (slots.get(idx)?.userId === meId) slots.delete(idx);
      }
      const me = await User.findOne({ userId: meId }).select("userId name profileImage").lean();
      const wallet = await Wallet.findOne({ userId: meId }).select("totalGold chargedGold diamonds").lean();
      slots.set(slotIndex, {
        userId: meId,
        name: me?.name || "مستخدم",
        profileImage: me?.profileImage || null,
        totalGold: wallet?.totalGold ?? 0,
        chargedGold: wallet?.chargedGold ?? 0,
        diamonds: wallet?.diamonds ?? 0,
      });
    }

    const result = [];
    for (let i = 0; i < 8; i++) {
      const d = slots.get(i);
      result.push(d ? { slotIndex: i, ...d } : null);
    }
    res.json({ success: true, slots: result });
  } catch (err) {
    console.error("group-chat slot error:", err);
    res.status(500).json({ success: false, message: "خطأ في الشقة" });
  }
});

// GET /api/group-chat/slots
router.get("/group-chat/slots", auth, async (req, res) => {
  try {
    const result = [];
    for (let i = 0; i < 8; i++) {
      const d = slots.get(i);
      result.push(d ? { slotIndex: i, ...d } : null);
    }
    res.json({ success: true, slots: result });
  } catch (err) {
    console.error("group-chat slots error:", err);
    res.status(500).json({ success: false, message: "خطأ في جلب الشقق" });
  }
});

// GET /api/group-chat/users
router.get("/group-chat/users", auth, async (req, res) => {
  try {
    const userIds = Array.from(roomMembers);
    const users = await User.find({ userId: { $in: userIds } })
      .select("userId name profileImage gender")
      .lean();
    const list = users.map((u) => ({
      userId: u.userId,
      name: u.name || "مستخدم",
      profileImage: u.profileImage || null,
      gender: u.gender || null,
    }));
    res.json({ success: true, users: list });
  } catch (err) {
    console.error("group-chat users error:", err);
    res.status(500).json({ success: false, message: "خطأ في جلب المستخدمين" });
  }
});

// GET /api/group-chat/voice-token
router.get("/group-chat/voice-token", auth, async (req, res) => {
  try {
    const apiKey = process.env.LIVEKIT_API_KEY;
    const apiSecret = process.env.LIVEKIT_API_SECRET;
    const wsUrl = process.env.LIVEKIT_WS_URL || "wss://your-livekit-server.livekit.cloud";

    if (!apiKey || !apiSecret) {
      return res.status(503).json({ success: false, message: "LiveKit غير مُعد" });
    }

    const at = new AccessToken(apiKey, apiSecret, {
      identity: req.user.id,
      name: req.user.id,
    });
    at.addGrant({ roomJoin: true, room: ROOM_NAME, canPublish: true, canSubscribe: true });

    const token = await at.toJwt();
    res.json({ success: true, token, wsUrl });
  } catch (err) {
    console.error("group-chat voice-token error:", err);
    res.status(500).json({ success: false, message: "خطأ في الحصول على توكن الصوت" });
  }
});

// GET /api/group-chat/music-state — جلب حالة الموسيقى (للجميع)
router.get("/group-chat/music-state", auth, (req, res) => {
  res.json({ success: true, ...musicState });
});

// POST /api/group-chat/music-control — تشغيل/إيقاف/التالي/السابق/الصوت
router.post("/group-chat/music-control", auth, (req, res) => {
  try {
    const { action, url, volume } = req.body;
    const base = getBaseUrl(req);

    if (action === "play" && url) {
      const fullUrl = url.startsWith("http") ? url : `${base}${url.startsWith("/") ? "" : "/"}${url}`;
      if (!musicState.playlist.length) musicState.playlist = [fullUrl];
      else if (!musicState.playlist.includes(fullUrl)) musicState.playlist.push(fullUrl);
      musicState.currentIndex = musicState.playlist.indexOf(fullUrl);
      musicState.url = fullUrl;
      musicState.isPlaying = true;
      musicState.updatedAt = Date.now();
    } else if (action === "stop") {
      musicState.isPlaying = false;
      musicState.url = null;
      musicState.updatedAt = Date.now();
    } else if (action === "next" && musicState.playlist.length > 0) {
      musicState.currentIndex = (musicState.currentIndex + 1) % musicState.playlist.length;
      musicState.url = musicState.playlist[musicState.currentIndex];
      musicState.isPlaying = true;
      musicState.updatedAt = Date.now();
    } else if (action === "prev" && musicState.playlist.length > 0) {
      musicState.currentIndex = (musicState.currentIndex - 1 + musicState.playlist.length) % musicState.playlist.length;
      musicState.url = musicState.playlist[musicState.currentIndex];
      musicState.isPlaying = true;
      musicState.updatedAt = Date.now();
    } else if (action === "volume" && typeof volume === "number") {
      musicState.volume = Math.max(0, Math.min(1, volume));
      musicState.updatedAt = Date.now();
    }

    res.json({ success: true, ...musicState });
  } catch (err) {
    console.error("music-control error:", err);
    res.status(500).json({ success: false });
  }
});

// POST /api/group-chat/upload-music
router.post("/group-chat/upload-music", auth, musicUpload.single("music"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, message: "الملف مطلوب" });
    const base = getBaseUrl(req);
    const musicUrl = `${base}/uploads/music/${req.file.filename}`;
    res.json({ success: true, musicUrl });
  } catch (err) {
    console.error("group-chat upload-music error:", err);
    res.status(500).json({ success: false, message: "خطأ في رفع الأغنية" });
  }
});

// تخزين مؤقت — استجابة فورية عند الطلبات المتكررة
let messagesCache = { data: [], ts: 0 };
const CACHE_TTL_MS = 1500;

// GET /api/group-chat/messages — جلب رسائل الدردشة الجماعية
router.get("/group-chat/messages", auth, async (req, res) => {
  const now = Date.now();
  if (messagesCache.data.length > 0 && now - messagesCache.ts < CACHE_TTL_MS) {
    return res.json({ success: true, messages: messagesCache.data });
  }
  try {
    const limit = 250;
    const msgs = await GroupChatMessage.find({})
      .sort({ createdAt: 1 })
      .limit(limit)
      .lean();

    const fromIds = [...new Set(msgs.map((m) => m.fromId))];
    const [users, wallets] = await Promise.all([
      fromIds.length ? User.find({ userId: { $in: fromIds } }).select("userId name profileImage age gender").lean() : [],
      fromIds.length ? Wallet.find({ userId: { $in: fromIds } }).select("userId diamonds chargedGold").lean() : [],
    ]);
    const userMap = new Map(users.map((u) => [u.userId, u]));
    const walletMap = new Map(wallets.map((w) => [w.userId, w]));

    const result = msgs.map((m) => {
      const u = userMap.get(m.fromId);
      const w = walletMap.get(m.fromId);
      const diamonds = m.fromDiamonds ?? w?.diamonds ?? 0;
      const chargedGold = m.fromChargedGold ?? w?.chargedGold ?? 0;
      return {
        id: m._id,
        fromId: m.fromId,
        fromName: m.fromName || u?.name || "مستخدم",
        fromProfileImage: m.fromProfileImage ?? u?.profileImage ?? null,
        fromAge: m.fromAge ?? u?.age ?? null,
        fromGender: m.fromGender ?? u?.gender ?? null,
        fromDiamonds: diamonds,
        fromChargedGold: chargedGold,
        toId: m.toId ?? null,
        text: m.text,
        createdAt: m.createdAt,
        replyToText: m.replyToText ?? null,
        replyToFromId: m.replyToFromId ?? null,
        replyToFromName: m.replyToFromName ?? null,
        audioUrl: m.audioUrl ?? null,
        audioDurationSeconds: m.audioDurationSeconds ?? null,
        imageUrl: m.imageUrl ?? null,
      };
    });

    messagesCache = { data: result, ts: Date.now() };
    res.json({ success: true, messages: result });
  } catch (err) {
    if (messagesCache.data.length > 0) {
      return res.json({ success: true, messages: messagesCache.data });
    }
    res.json({ success: true, messages: [] });
  }
});

// POST /api/group-chat/send — إرسال رسالة في الدردشة الجماعية (تُحفظ في MongoDB ويراها الجميع)
router.post("/group-chat/send", auth, async (req, res) => {
  try {
    const {
      text,
      audioUrl,
      audioDurationSeconds,
      imageUrl,
      toId,
      giftAmount,
      replyToText,
      replyToFromId,
      replyToFromName,
    } = req.body;

    const fromId = req.user.id;
    const isVoice = !!audioUrl;
    const isImage = !!imageUrl;
    const textVal = isVoice ? "🎤 رسالة صوتية" : isImage ? "📷 صورة" : (text || "").trim();
    if (!isVoice && !isImage && !textVal) {
      return res.status(400).json({ success: false, message: "النص أو المحتوى مطلوب" });
    }

    const fromUser = await User.findOne({ userId: fromId }).select("userId name profileImage age gender").lean();
    if (!fromUser) return res.status(404).json({ success: false, message: "المستخدم غير موجود" });

    let fromDiamonds = null;
    let fromChargedGold = null;
    if (giftAmount && Number(giftAmount) > 0) {
      const wallet = await Wallet.findOne({ userId: fromId });
      if (wallet) {
        fromDiamonds = wallet.diamonds ?? 0;
        fromChargedGold = wallet.chargedGold ?? 0;
      }
    }

    const msg = await GroupChatMessage.create({
      fromId,
      fromName: fromUser.name || "مستخدم",
      fromProfileImage: fromUser.profileImage || null,
      fromAge: fromUser.age ?? null,
      fromGender: fromUser.gender || null,
      fromDiamonds,
      fromChargedGold,
      toId: toId || null,
      text: String(textVal).slice(0, 500),
      replyToText: replyToText ? String(replyToText).slice(0, 300) : null,
      replyToFromId: replyToFromId ? String(replyToFromId) : null,
      replyToFromName: replyToFromName ? String(replyToFromName).slice(0, 100) : null,
      audioUrl: audioUrl || null,
      audioDurationSeconds: audioDurationSeconds != null ? Number(audioDurationSeconds) : null,
      imageUrl: imageUrl || null,
    });

    const MAX_MESSAGES = 250;
    const count = await GroupChatMessage.countDocuments();
    if (count > MAX_MESSAGES) {
      const excess = count - MAX_MESSAGES;
      const oldest = await GroupChatMessage.find().sort({ createdAt: 1 }).limit(excess).select("_id").lean();
      if (oldest.length) await GroupChatMessage.deleteMany({ _id: { $in: oldest.map((o) => o._id) } });
    }

    messagesCache = { data: [], ts: 0 };

    res.json({
      success: true,
      message: {
        id: msg._id,
        fromId: msg.fromId,
        fromName: msg.fromName,
        fromProfileImage: msg.fromProfileImage,
        fromAge: msg.fromAge,
        fromGender: msg.fromGender,
        fromDiamonds: msg.fromDiamonds,
        fromChargedGold: msg.fromChargedGold,
        toId: msg.toId,
        text: msg.text,
        createdAt: msg.createdAt,
        replyToText: msg.replyToText,
        replyToFromId: msg.replyToFromId,
        replyToFromName: msg.replyToFromName,
        audioUrl: msg.audioUrl,
        audioDurationSeconds: msg.audioDurationSeconds,
        imageUrl: msg.imageUrl,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: "خطأ في إرسال الرسالة" });
  }
});

// DELETE /api/group-chat/messages/:id — حذف رسالة (للمرسل فقط)
router.delete("/group-chat/messages/:id", auth, async (req, res) => {
  try {
    const { id } = req.params;
    const meId = req.user.id;
    const msg = await GroupChatMessage.findById(id);
    if (!msg) return res.status(404).json({ success: false, message: "الرسالة غير موجودة" });
    if (msg.fromId !== meId) return res.status(403).json({ success: false, message: "لا يمكنك حذف رسالة غيرك" });
    await GroupChatMessage.findByIdAndDelete(id);
    messagesCache = { data: [], ts: 0 };
    res.json({ success: true });
  } catch (err) {
    console.error("delete group-chat message error:", err);
    res.status(500).json({ success: false, message: "خطأ في الحذف" });
  }
});

module.exports = router;

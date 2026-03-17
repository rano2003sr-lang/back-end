const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const Moment = require("../module/Moment");
const User = require("../module/Users");
const { auth } = require("../authGoogle/googleAuth");
const { getBaseUrl } = require("../utils/push");

const router = express.Router();
const MAX_VIDEO_SEC = 20;

const uploadsDir = path.join(__dirname, "../uploads/moments");
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const ext = file.mimetype.includes("video") ? "mp4" : "jpg";
    cb(null, `moment_${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ["image/jpeg", "image/png", "image/webp", "video/mp4", "video/quicktime"];
    if (allowed.includes(file.mimetype)) cb(null, true);
    else cb(new Error("نوع الملف غير مدعوم"));
  },
});

const uploadFields = upload.fields([
  { name: "media", maxCount: 1 },
  { name: "thumbnail", maxCount: 1 },
]);

let momentsCache = { data: null, ts: 0 };
const MOMENTS_CACHE_TTL = 2000;

// GET /api/moments — جلب كل اللحظات
router.get("/moments", async (req, res) => {
  if (momentsCache.data && Date.now() - momentsCache.ts < MOMENTS_CACHE_TTL) {
    return res.json(momentsCache.data);
  }
  try {
    const currentUserId = req.headers.authorization ? (() => {
      try {
        const jwt = require("jsonwebtoken");
        const token = req.headers.authorization.split(" ")[1];
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        return decoded.id;
      } catch { return null; }
    })() : null;

    const moments = await Moment.find().sort({ createdAt: -1 }).lean();
    const baseUrl = `${getBaseUrl(req)}/uploads/moments/`;

    const list = moments.map((m) => {
      const mediaUrl = m.mediaUrl.startsWith("http") ? m.mediaUrl : baseUrl + m.mediaUrl;
      const thumbnailUrl = m.thumbnailUrl 
        ? (m.thumbnailUrl.startsWith("http") ? m.thumbnailUrl : baseUrl + m.thumbnailUrl)
        : null;
      return {
        id: m._id.toString(),
        userId: m.userId,
        userName: m.userName,
        userAge: m.userAge,
        userGender: m.userGender || "",
        userCountry: m.userCountry || "",
        userProfileImage: m.userProfileImage || "",
        mediaUrl,
        thumbnailUrl,
        mediaType: m.mediaType,
        durationSeconds: m.durationSeconds,
        likeCount: (m.likedBy || []).length,
        likedByMe: currentUserId ? (m.likedBy || []).includes(currentUserId) : false,
        createdAt: m.createdAt,
      };
    });

    const payload = { success: true, moments: list };
    momentsCache = { data: payload, ts: Date.now() };
    res.json(payload);
  } catch (err) {
    console.error("GET /moments error:", err);
    res.status(500).json({ success: false, message: "خطأ في جلب اللحظات" });
  }
});

// POST /api/moments — نشر لحظة (صورة أو فيديو حتى 20 ثانية)
router.post("/moments", auth, uploadFields, async (req, res) => {
  try {
    const mediaFile = req.files?.media?.[0];
    const thumbFile = req.files?.thumbnail?.[0];
    
    if (!mediaFile) return res.status(400).json({ success: false, message: "الملف مطلوب" });

    const {
      mediaType,
      durationSeconds,
      userId,
      userName,
      userAge,
      userGender,
      userCountry,
      userProfileImage,
    } = req.body;
    const dur = durationSeconds ? parseInt(durationSeconds, 10) : null;

    if (mediaType === "video" && dur != null && dur > MAX_VIDEO_SEC) {
      fs.unlinkSync(mediaFile.path);
      if (thumbFile) fs.unlinkSync(thumbFile.path);
      return res.status(413).json({ success: false, message: `الحد الأقصى للفيديو ${MAX_VIDEO_SEC} ثانية` });
    }

    const filename = path.basename(mediaFile.path);
    const thumbFilename = thumbFile ? path.basename(thumbFile.path) : null;
    const baseUrl = `${getBaseUrl(req)}/uploads/moments/`;

    const moment = await Moment.create({
      userId: userId || req.user.id,
      userName: userName || "مستخدم",
      userAge: userAge ? parseInt(userAge, 10) : null,
      userGender: userGender || "",
      userCountry: userCountry || "",
      userProfileImage: userProfileImage || "",
      mediaUrl: filename,
      thumbnailUrl: thumbFilename,
      mediaType: mediaType || (mediaFile.mimetype.includes("video") ? "video" : "image"),
      durationSeconds: dur,
      likedBy: [],
    });

    momentsCache = { data: null, ts: 0 };

    res.json({
      success: true,
      moment: {
        id: moment._id.toString(),
        userId: moment.userId,
        userName: moment.userName,
        userAge: moment.userAge,
        userGender: moment.userGender,
        userCountry: moment.userCountry,
        userProfileImage: moment.userProfileImage,
        mediaUrl: baseUrl + filename,
        thumbnailUrl: thumbFilename ? baseUrl + thumbFilename : null,
        mediaType: moment.mediaType,
        durationSeconds: moment.durationSeconds,
        likeCount: 0,
        likedByMe: false,
        createdAt: moment.createdAt,
      },
    });
  } catch (err) {
    console.error("POST /moments error:", err);
    const mediaFile = req.files?.media?.[0];
    const thumbFile = req.files?.thumbnail?.[0];
    if (mediaFile && fs.existsSync(mediaFile.path)) fs.unlinkSync(mediaFile.path);
    if (thumbFile && fs.existsSync(thumbFile.path)) fs.unlinkSync(thumbFile.path);
    res.status(500).json({ success: false, message: err.message || "خطأ في نشر اللحظة" });
  }
});

// DELETE /api/moments/:id — حذف لحظة (مالك اللحظة فقط) + حذف الملفات من القرص
router.delete("/moments/:id", auth, async (req, res) => {
  try {
    const moment = await Moment.findById(req.params.id);
    if (!moment) return res.status(404).json({ success: false, message: "اللحظة غير موجودة" });
    if (moment.userId !== req.user.id)
      return res.status(403).json({ success: false, message: "لا يمكنك حذف لحظة ليست لك" });

    const filePath = path.join(uploadsDir, moment.mediaUrl);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    
    if (moment.thumbnailUrl) {
      const thumbPath = path.join(uploadsDir, moment.thumbnailUrl);
      if (fs.existsSync(thumbPath)) fs.unlinkSync(thumbPath);
    }
    
    await Moment.findByIdAndDelete(req.params.id);

    momentsCache = { data: null, ts: 0 };

    res.json({ success: true, message: "تم الحذف" });
  } catch (err) {
    console.error("DELETE /moments/:id error:", err);
    res.status(500).json({ success: false, message: "خطأ في الحذف" });
  }
});

// POST /api/moments/:id/like — إعجاب (مرة واحدة لكل مستخدم)
router.post("/moments/:id/like", auth, async (req, res) => {
  try {
    const moment = await Moment.findById(req.params.id);
    if (!moment) return res.status(404).json({ success: false, message: "اللحظة غير موجودة" });

    const uid = req.user.id;
    const likedBy = moment.likedBy || [];
    let likedByMeta = moment.likedByMeta || [];
    const idx = likedBy.indexOf(uid);

    if (idx >= 0) {
      likedBy.splice(idx, 1);
      likedByMeta = likedByMeta.filter((x) => x.userId !== uid);
    } else {
      likedBy.push(uid);
      const now = new Date();
      const metaIdx = likedByMeta.findIndex((x) => x.userId === uid);
      if (metaIdx >= 0) {
        likedByMeta[metaIdx].likedAt = now;
      } else {
        likedByMeta.push({ userId: uid, likedAt: now });
      }
    }
    moment.likedBy = likedBy;
    moment.likedByMeta = likedByMeta;
    await moment.save();

    momentsCache = { data: null, ts: 0 };

    res.json({
      success: true,
      likeCount: likedBy.length,
      likedByMe: likedBy.includes(uid),
    });
  } catch (err) {
    console.error("POST /moments/:id/like error:", err);
    res.status(500).json({ success: false, message: "خطأ في الإعجاب" });
  }
});

// GET /api/moments/:id/likers — المستخدمون الذين أعجبوا بلحظة معيّنة
router.get("/moments/:id/likers", auth, async (req, res) => {
  try {
    const moment = await Moment.findById(req.params.id).lean();
    if (!moment) {
      return res.status(404).json({ success: false, message: "اللحظة غير موجودة" });
    }

    const likedBy = moment.likedBy || [];
    if (!likedBy.length) {
      return res.json({ success: true, users: [] });
    }

    const likedByMeta = moment.likedByMeta || [];
    const baseUrl = `${getBaseUrl(req)}/uploads/moments/`;

    const users = await User.find({ userId: { $in: likedBy } }).lean();

    const usersResult = users.map((u) => {
      const meta = likedByMeta.find((m) => m.userId === u.userId) || {};
      const likedAt = meta.likedAt || null;

      // هذه الواجهة ترجع نفس شكل MomentLiker من الفرونت
      const file = moment.mediaUrl;
      const thumb = moment.thumbnailUrl;
      const lastMediaUrl = file && file.startsWith("http") ? file : file ? baseUrl + file : null;
      const lastThumbnailUrl = thumb && thumb.startsWith("http") ? thumb : thumb ? baseUrl + thumb : null;

      return {
        userId: u.userId,
        name: u.name,
        age: typeof u.age === "number" ? u.age : null,
        profileImage: u.profileImage || "",
        country: u.country || "",
        gender: u.gender || "",
        likeCount: 1,
        lastMediaUrl,
        lastThumbnailUrl,
        lastMediaType: moment.mediaType || null,
        lastLikedAt: likedAt,
      };
    });

    res.json({ success: true, users: usersResult });
  } catch (err) {
    console.error("GET /moments/:id/likers error:", err);
    res.status(500).json({ success: false, message: "خطأ في جلب قائمة معجبي اللحظة" });
  }
});

// GET /api/moments/my-likers — كل إعجابات المستخدمين على لحظاتي (تكرار حسب كل لحظة)
router.get("/moments/my-likers", auth, async (req, res) => {
  try {
    const ownerId = req.user.id;
    const moments = await Moment.find({ userId: ownerId }).lean();

    if (!moments.length) {
      return res.json({ success: true, users: [] });
    }

    // نبني عنصر لكل إعجاب فردي: (user + اللحظة التي أعجب بها)
    const likeEntries = [];
    for (const m of moments) {
      const likedByMeta = m.likedByMeta || [];
      for (const meta of likedByMeta) {
        likeEntries.push({
          userId: meta.userId,
          likedAt: meta.likedAt || m.createdAt,
          mediaUrl: m.mediaUrl,
          thumbnailUrl: m.thumbnailUrl,
          mediaType: m.mediaType,
        });
      }
    }

    if (!likeEntries.length) {
      return res.json({ success: true, users: [] });
    }

    // ترتيب بحسب الأحدث أولاً (اختياري لكن يبدوا أجمل)
    likeEntries.sort((a, b) => new Date(b.likedAt).getTime() - new Date(a.likedAt).getTime());

    const likerIds = Array.from(new Set(likeEntries.map((e) => e.userId)));
    const users = await User.find({ userId: { $in: likerIds } }).lean();
    const userMap = new Map(users.map((u) => [u.userId, u]));

    const baseUrl = `${getBaseUrl(req)}/uploads/moments/`;

    const result = likeEntries
      .map((entry) => {
        const u = userMap.get(entry.userId);
        if (!u) return null;

        const file = entry.mediaUrl;
        const thumb = entry.thumbnailUrl;
        const lastMediaUrl = file && file.startsWith("http") ? file : file ? baseUrl + file : null;
        const lastThumbnailUrl = thumb && thumb.startsWith("http") ? thumb : thumb ? baseUrl + thumb : null;

        return {
          userId: u.userId,
          name: u.name,
          profileImage: u.profileImage || "",
          age: typeof u.age === "number" ? u.age : null,
          country: u.country || "",
          gender: u.gender || "",
          // هذا الحقل هنا يعني "إعجاب واحد لهذه اللحظة"
          likeCount: 1,
          lastMediaUrl,
          lastThumbnailUrl,
          lastMediaType: entry.mediaType || null,
          lastLikedAt: entry.likedAt || null,
        };
      })
      .filter(Boolean);

    res.json({ success: true, users: result });
  } catch (err) {
    console.error("GET /moments/my-likers error:", err);
    res.status(500).json({ success: false, message: "خطأ في جلب قائمة المعجبين" });
  }
});

module.exports = router;

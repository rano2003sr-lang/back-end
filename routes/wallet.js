const express = require("express");
const Wallet = require("../module/Wallet");
const CheckIn = require("../module/CheckIn");
const Message = require("../module/Messages");
const AdReward = require("../module/AdReward");
const AdRewardState = require("../module/AdRewardState");
const RevenueShare = require("../module/RevenueShare");
const { auth } = require("../authGoogle/googleAuth");

const router = express.Router();
const walletCache = new Map();
const WALLET_CACHE_TTL = 1500;
function invalidateWalletCache(userId) {
  walletCache.delete(userId);
}
const AD_REWARD_GOLD = 1;
const AD_DAILY_LIMIT = 20; // 20 إعلان يومياً — 1 ذهب لكل إعلان
const AD_WEEKLY_LIMIT = 140; // 20 يومياً × 7 — تراكم حتى 10$
const AD_COOLDOWN_MS = 5 * 60 * 1000; // 5 دقائق بين كل إعلان (أمان ضد حظر الحساب)
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const TIMER_OFF = false; // غيّر إلى true مؤقتاً لإلغاء المؤقت للاختبار
const WAIT_BEFORE_CLAIM = TIMER_OFF ? 0 : MS_PER_DAY;

// GET /api/wallet — جلب رصيد الذهب للمستخدم المسجّل
router.get("/wallet", auth, async (req, res) => {
  try {
    const userId = req.user.id;
    const cached = walletCache.get(userId);
    if (cached && Date.now() - cached.ts < WALLET_CACHE_TTL) {
      return res.json(cached.data);
    }
    let wallet = await Wallet.findOne({ userId });
    if (!wallet) {
      wallet = await Wallet.create({
        userId,
        totalGold: 0,
        chargedGold: 0,
        freeGold: 0,
        diamonds: 0,
        transactions: [],
      });
    }
    const charged = wallet.chargedGold ?? 0;
    const free = wallet.freeGold ?? 0;
    const payload = {
      success: true,
      wallet: {
        totalGold: charged + free,
        chargedGold: charged,
        freeGold: free,
        diamonds: wallet.diamonds ?? 0,
      },
    };
    walletCache.set(userId, { data: payload, ts: Date.now() });
    res.json(payload);
  } catch (err) {
    console.error("GET /wallet error:", err);
    res.status(500).json({ success: false, message: "خطأ في جلب الرصيد" });
  }
});

// POST /api/wallet/topup — إضافة ذهب من عملية شراء
router.post("/wallet/topup", auth, async (req, res) => {
  try {
    const { amount, bonus } = req.body;
    if (typeof amount !== "number" || amount < 0) {
      return res.status(400).json({ success: false, message: "قيمة غير صالحة" });
    }
    const bonusAmount = typeof bonus === "number" ? Math.round(bonus) : 0;

    const userId = req.user.id;
    let wallet = await Wallet.findOne({ userId });
    if (!wallet) {
      wallet = await Wallet.create({
        userId,
        totalGold: 0,
        chargedGold: 0,
        freeGold: 0,
        diamonds: 0,
        transactions: [],
      });
    }

    const newCharged = (wallet.chargedGold ?? 0) + amount;
    const newFree = (wallet.freeGold ?? 0) + bonusAmount;

    wallet.chargedGold = newCharged;
    wallet.freeGold = newFree;
    wallet.totalGold = newCharged + newFree;
    wallet.transactions.push({ amount, bonus: bonusAmount, createdAt: new Date() });
    await wallet.save();

    invalidateWalletCache(userId);

    res.json({
      success: true,
      wallet: {
        totalGold: wallet.totalGold,
        chargedGold: wallet.chargedGold,
        freeGold: wallet.freeGold,
        diamonds: wallet.diamonds ?? 0,
      },
    });
  } catch (err) {
    console.error("POST /wallet/topup error:", err);
    res.status(500).json({ success: false, message: "خطأ في شحن الرصيد" });
  }
});

async function addRevenueShare(userId, points) {
  let rs = await RevenueShare.findOne({ userId });
  if (!rs) {
    const weekStart = RevenueShare.getWeekStart();
    rs = await RevenueShare.create({ userId, balancePoints: 0, weekStart, weekEarnedPoints: 0 });
  }
  rs.balancePoints = (rs.balancePoints ?? 0) + points;
  rs.weekEarnedPoints = (rs.weekEarnedPoints ?? 0) + points;
  await rs.save();
}

async function ensureWallet(userId) {
  let wallet = await Wallet.findOne({ userId });
  if (!wallet) {
    wallet = await Wallet.create({
      userId,
      totalGold: 0,
      chargedGold: 0,
      freeGold: 0,
      diamonds: 0,
      transactions: [],
    });
  }
  return wallet;
}

async function getWalletForResponse(userId) {
  const wallet = await Wallet.findOne({ userId });
  if (!wallet) return { totalGold: 0, chargedGold: 0, freeGold: 0, diamonds: 0 };
  return {
    totalGold: wallet.totalGold,
    chargedGold: wallet.chargedGold,
    freeGold: wallet.freeGold,
    diamonds: wallet.diamonds ?? 0,
  };
}

// GET /api/wallet/checkin — حالة تسجيل الدخول الأسبوعي
router.get("/wallet/checkin", auth, async (req, res) => {
  try {
    const userId = req.user.id;
    let checkin = await CheckIn.findOne({ userId });
    const now = new Date();

    if (!checkin) {
      return res.json({
        success: true,
        checkin: {
          currentDay: 1,
          weekStartAt: null,
          nextClaimAt: null,
          canClaim: false,
          canStart: true,
          rewardForCurrentDay: 2,
          secondsUntilClaim: 0,
        },
      });
    }

    const weekStart = new Date(checkin.weekStartAt);
    const weekAge = now - weekStart;
    if (weekAge >= 7 * MS_PER_DAY) {
      checkin.currentDay = 1;
      checkin.weekStartAt = now;
      checkin.nextClaimAt = null;
      checkin.lastClaimedAt = null;
      await checkin.save();
    }

    const reward = CheckIn.getRewardForDay(checkin.currentDay);
    const nextClaim = checkin.nextClaimAt ? new Date(checkin.nextClaimAt) : null;
    const canClaim = nextClaim && now >= nextClaim;
    const canStart = !nextClaim && checkin.currentDay === 1;

    return res.json({
      success: true,
      checkin: {
        currentDay: checkin.currentDay,
        weekStartAt: checkin.weekStartAt,
        nextClaimAt: checkin.nextClaimAt,
        canClaim,
        canStart,
        rewardForCurrentDay: reward,
        secondsUntilClaim: nextClaim && !canClaim ? Math.max(0, Math.floor((nextClaim - now) / 1000)) : 0,
      },
    });
  } catch (err) {
    console.error("GET /wallet/checkin error:", err);
    res.status(500).json({ success: false, message: "خطأ في جلب حالة التسجيل" });
  }
});

// POST /api/wallet/checkin — بدء يوم 1 أو استلام المكافأة
router.post("/wallet/checkin", auth, async (req, res) => {
  try {
    const userId = req.user.id;
    const { action } = req.body || {};
    const now = new Date();

    let checkin = await CheckIn.findOne({ userId });

    if (!checkin) {
      checkin = await CheckIn.create({
        userId,
        currentDay: 1,
        weekStartAt: now,
        nextClaimAt: new Date(now.getTime() + WAIT_BEFORE_CLAIM),
        lastClaimedAt: null,
      });
      const wallet = await ensureWallet(userId);
      const nextClaim = checkin.nextClaimAt ? new Date(checkin.nextClaimAt) : null;
      const canClaim = nextClaim && now >= nextClaim;
      const secondsUntilClaim = nextClaim && !canClaim ? Math.max(0, Math.floor((nextClaim - now) / 1000)) : 0;
      return res.json({
        success: true,
        message: TIMER_OFF ? "تم بدء التسجيل! استلم 2 ذهب الآن" : "تم بدء التسجيل! استلم 2 ذهب بعد 24 ساعة",
        checkin: {
          currentDay: 1,
          nextClaimAt: checkin.nextClaimAt,
          canClaim,
          canStart: false,
          rewardForCurrentDay: 2,
          secondsUntilClaim,
        },
        wallet: {
          totalGold: wallet.totalGold,
          chargedGold: wallet.chargedGold,
          freeGold: wallet.freeGold,
          diamonds: wallet.diamonds ?? 0,
        },
      });
    }

    const weekStart = new Date(checkin.weekStartAt);
    if (now - weekStart >= 7 * MS_PER_DAY) {
      checkin.currentDay = 1;
      checkin.weekStartAt = now;
      checkin.nextClaimAt = new Date(now.getTime() + WAIT_BEFORE_CLAIM);
      checkin.lastClaimedAt = null;
      await checkin.save();
      const nextClaimW = checkin.nextClaimAt ? new Date(checkin.nextClaimAt) : null;
      const canClaimW = nextClaimW && now >= nextClaimW;
      const secondsW = nextClaimW && !canClaimW ? Math.max(0, Math.floor((nextClaimW - now) / 1000)) : 0;
      return res.json({
        success: true,
        message: TIMER_OFF ? "تم بدء أسبوع جديد! استلم 2 ذهب الآن" : "تم بدء أسبوع جديد! استلم 2 ذهب بعد 24 ساعة",
        checkin: {
          currentDay: 1,
          nextClaimAt: checkin.nextClaimAt,
          canClaim: canClaimW,
          canStart: false,
          rewardForCurrentDay: 2,
          secondsUntilClaim: secondsW,
        },
        wallet: await getWalletForResponse(userId),
      });
    }

    if (action === "claim") {
      const nextClaim = checkin.nextClaimAt ? new Date(checkin.nextClaimAt) : null;
      if (!nextClaim || now < nextClaim) {
        return res.status(400).json({
          success: false,
          message: "لم ينتهِ الوقت بعد. انتظر حتى انتهاء المدة لاستلام المكافأة",
        });
      }

      const reward = CheckIn.getRewardForDay(checkin.currentDay);
      const wallet = await ensureWallet(userId);

      const newFree = (wallet.freeGold ?? 0) + reward;
      wallet.freeGold = newFree;
      wallet.totalGold = (wallet.chargedGold ?? 0) + newFree;
      wallet.transactions.push({ amount: 0, bonus: reward, createdAt: now });
      await wallet.save();

      invalidateWalletCache(userId);

      const nextDay = checkin.currentDay >= 7 ? 1 : checkin.currentDay + 1;
      const newWeekStart = checkin.currentDay >= 7 ? now : checkin.weekStartAt;
      checkin.currentDay = nextDay;
      checkin.weekStartAt = newWeekStart;
      checkin.lastClaimedAt = now;
      checkin.nextClaimAt = new Date(now.getTime() + WAIT_BEFORE_CLAIM);
      await checkin.save();

      await addRevenueShare(userId, RevenueShare.CHECKIN_POINTS);

      const nextReward = CheckIn.getRewardForDay(nextDay);
      const nextClaimC = checkin.nextClaimAt ? new Date(checkin.nextClaimAt) : null;
      const canClaimC = nextClaimC && now >= nextClaimC;
      const secondsC = nextClaimC && !canClaimC ? Math.max(0, Math.floor((nextClaimC - now) / 1000)) : 0;
      return res.json({
        success: true,
        message: `تم استلام ${reward} ذهب!`,
        reward,
        checkin: {
          currentDay: nextDay,
          nextClaimAt: checkin.nextClaimAt,
          canClaim: canClaimC,
          canStart: false,
          rewardForCurrentDay: nextReward,
          secondsUntilClaim: secondsC,
        },
        wallet: {
          totalGold: wallet.totalGold,
          chargedGold: wallet.chargedGold,
          freeGold: wallet.freeGold,
          diamonds: wallet.diamonds ?? 0,
        },
      });
    }

    if (action === "start" || !checkin.nextClaimAt) {
      if (checkin.nextClaimAt) {
        return res.status(400).json({
          success: false,
          message: "لديك تسجيل قيد الانتظار. انتظر حتى انتهاء المدة لاستلام المكافأة",
        });
      }
      checkin.nextClaimAt = new Date(now.getTime() + WAIT_BEFORE_CLAIM);
      checkin.weekStartAt = checkin.weekStartAt || now;
      await checkin.save();
      const nextClaimS = checkin.nextClaimAt ? new Date(checkin.nextClaimAt) : null;
      const canClaimS = nextClaimS && now >= nextClaimS;
      const secondsS = nextClaimS && !canClaimS ? Math.max(0, Math.floor((nextClaimS - now) / 1000)) : 0;
      return res.json({
        success: true,
        message: TIMER_OFF ? "تم بدء التسجيل! استلم المكافأة الآن" : "تم بدء التسجيل! استلم المكافأة بعد 24 ساعة",
        checkin: {
          currentDay: checkin.currentDay,
          nextClaimAt: checkin.nextClaimAt,
          canClaim: canClaimS,
          canStart: false,
          rewardForCurrentDay: CheckIn.getRewardForDay(checkin.currentDay),
          secondsUntilClaim: secondsS,
        },
        wallet: await getWalletForResponse(userId),
      });
    }

    return res.status(400).json({ success: false, message: "إجراء غير صالح" });
  } catch (err) {
    console.error("POST /wallet/checkin error:", err);
    res.status(500).json({ success: false, message: "خطأ في تسجيل الدخول" });
  }
});

async function getWeeklyAdCount(userId) {
  const weekStart = AdReward.getWeekStart ? AdReward.getWeekStart() : new Date().toISOString().slice(0, 10);
  const docs = await AdReward.find({ userId, date: { $gte: weekStart } });
  return docs.reduce((s, d) => s + (d.count ?? 0), 0);
}

// GET /api/wallet/ad-status — حالة مكافآت الإعلانات اليومية
router.get("/wallet/ad-status", auth, async (req, res) => {
  try {
    const userId = req.user.id;
    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    let doc = await AdReward.findOne({ userId, date: today });
    const todayCount = doc?.count ?? 0;
    const dailyRemaining = Math.max(0, AD_DAILY_LIMIT - todayCount);
    const weekCount = await getWeeklyAdCount(userId);
    const weeklyRemaining = Math.max(0, AD_WEEKLY_LIMIT - weekCount);

    let cooldownSeconds = 0;
    let state = await AdRewardState.findOne({ userId });
    if (state?.lastAdAt) {
      const elapsed = now - new Date(state.lastAdAt);
      if (elapsed < AD_COOLDOWN_MS) {
        cooldownSeconds = Math.ceil((AD_COOLDOWN_MS - elapsed) / 1000);
      }
    }

    return res.json({
      success: true,
      adStatus: {
        todayCount,
        dailyLimit: AD_DAILY_LIMIT,
        dailyRemaining,
        weekCount,
        weeklyLimit: AD_WEEKLY_LIMIT,
        weeklyRemaining,
        cooldownSeconds,
        rewardPerAd: AD_REWARD_GOLD,
      },
    });
  } catch (err) {
    console.error("GET /wallet/ad-status error:", err);
    res.status(500).json({ success: false, message: "خطأ في جلب حالة الإعلانات" });
  }
});

// POST /api/wallet/ad-reward — مكافأة بعد مشاهدة إعلان (يُستدعى من التطبيق بعد اكتمال الإعلان)
router.post("/wallet/ad-reward", auth, async (req, res) => {
  try {
    const userId = req.user.id;
    const now = new Date();
    const today = now.toISOString().slice(0, 10);

    // Cooldown: دقيقتان بين كل إعلان
    let state = await AdRewardState.findOne({ userId });
    if (state?.lastAdAt) {
      const elapsed = now - new Date(state.lastAdAt);
      if (elapsed < AD_COOLDOWN_MS) {
        const secs = Math.ceil((AD_COOLDOWN_MS - elapsed) / 1000);
        return res.status(429).json({
          success: false,
          message: `انتظر ${secs} ثانية قبل مشاهدة إعلان آخر`,
          cooldownSeconds: secs,
        });
      }
    }

    // حد أسبوعي
    const weekCount = await getWeeklyAdCount(userId);
    if (weekCount >= AD_WEEKLY_LIMIT) {
      return res.status(400).json({
        success: false,
        message: `وصلت للحد الأسبوعي (${AD_WEEKLY_LIMIT} إعلانات). عد الأسبوع القادم!`,
      });
    }

    let adDoc = await AdReward.findOne({ userId, date: today });
    if (!adDoc) {
      adDoc = await AdReward.create({ userId, date: today, count: 0 });
    }
    if (adDoc.count >= AD_DAILY_LIMIT) {
      return res.status(400).json({
        success: false,
        message: `وصلت للحد اليومي (${AD_DAILY_LIMIT} إعلانات). عد غداً!`,
      });
    }

    const wallet = await ensureWallet(userId);
    const newFree = (wallet.freeGold ?? 0) + AD_REWARD_GOLD;
    wallet.freeGold = newFree;
    wallet.totalGold = (wallet.chargedGold ?? 0) + newFree;
    wallet.transactions.push({ amount: 0, bonus: AD_REWARD_GOLD, createdAt: new Date() });
    await wallet.save();

    invalidateWalletCache(userId);

    adDoc.count += 1;
    await adDoc.save();

    await AdRewardState.findOneAndUpdate(
      { userId },
      { lastAdAt: now },
      { upsert: true, new: true }
    );

    await addRevenueShare(userId, RevenueShare.AD_POINTS);

    const dailyRemaining = Math.max(0, AD_DAILY_LIMIT - adDoc.count);
    const weeklyRemaining = Math.max(0, AD_WEEKLY_LIMIT - weekCount - 1);
    return res.json({
      success: true,
      message: `تم استلام ${AD_REWARD_GOLD} ذهب!`,
      reward: AD_REWARD_GOLD,
      adStatus: {
        todayCount: adDoc.count,
        dailyLimit: AD_DAILY_LIMIT,
        dailyRemaining,
        weekCount: weekCount + 1,
        weeklyLimit: AD_WEEKLY_LIMIT,
        weeklyRemaining,
        cooldownSeconds: Math.ceil(AD_COOLDOWN_MS / 1000),
      },
      wallet: {
        totalGold: wallet.totalGold,
        chargedGold: wallet.chargedGold,
        freeGold: wallet.freeGold,
        diamonds: wallet.diamonds ?? 0,
      },
    });
  } catch (err) {
    console.error("POST /wallet/ad-reward error:", err);
    res.status(500).json({ success: false, message: "خطأ في استلام مكافأة الإعلان" });
  }
});

const FIVE_MESSAGES_REWARD = 15;
const FIVE_MESSAGES_COOLDOWN_MS = 24 * 60 * 60 * 1000; // 24 ساعة

// GET /api/wallet/task-five-messages — حالة مهمة 5 رسائل (مهلة 24 ساعة بعد كل تحصيل)
router.get("/wallet/task-five-messages", auth, async (req, res) => {
  try {
    const userId = req.user.id;
    const now = new Date();
    const wallet = await Wallet.findOne({ userId });
    const lastClaim = wallet?.lastFiveMessagesClaim ? new Date(wallet.lastFiveMessagesClaim) : null;

    const cooldownEnd = lastClaim ? new Date(lastClaim.getTime() + FIVE_MESSAGES_COOLDOWN_MS) : null;
    const inCooldown = cooldownEnd && now < cooldownEnd;

    let count = 5;
    if (!inCooldown) {
      const countStart = cooldownEnd && now >= cooldownEnd ? cooldownEnd : (() => {
        const d = new Date(now);
        d.setUTCHours(0, 0, 0, 0);
        return d;
      })();
      count = await Message.countDocuments({
        fromId: userId,
        createdAt: { $gte: countStart },
      });
    }

    let secondsUntilClaim = 0;
    if (inCooldown && cooldownEnd) {
      secondsUntilClaim = Math.max(0, Math.floor((cooldownEnd - now) / 1000));
    }

    return res.json({
      success: true,
      task: {
        messagesSentToday: Math.min(5, count),
        claimedToday: inCooldown,
        reward: FIVE_MESSAGES_REWARD,
        secondsUntilClaim,
        nextClaimAt: cooldownEnd ? cooldownEnd.toISOString() : null,
      },
    });
  } catch (err) {
    console.error("GET /wallet/task-five-messages error:", err);
    res.status(500).json({ success: false, message: "خطأ في جلب حالة المهمة" });
  }
});

// POST /api/wallet/claim-task-five-messages — استلام 15 ذهب مجاني عند إكمال 5 رسائل
router.post("/wallet/claim-task-five-messages", auth, async (req, res) => {
  try {
    const userId = req.user.id;
    const now = new Date();
    const wallet = await ensureWallet(userId);
    const lastClaim = wallet.lastFiveMessagesClaim ? new Date(wallet.lastFiveMessagesClaim) : null;
    const cooldownEnd = lastClaim ? new Date(lastClaim.getTime() + FIVE_MESSAGES_COOLDOWN_MS) : null;
    const inCooldown = cooldownEnd && now < cooldownEnd;

    if (inCooldown) {
      const secondsUntilClaim = Math.max(0, Math.floor((cooldownEnd - now) / 1000));
      return res.json({
        success: false,
        task: {
          messagesSentToday: 5,
          claimedToday: true,
          reward: FIVE_MESSAGES_REWARD,
          secondsUntilClaim,
          nextClaimAt: cooldownEnd.toISOString(),
        },
      });
    }

    const countStart = cooldownEnd || new Date(now);
    if (!lastClaim) countStart.setUTCHours(0, 0, 0, 0);
    const count = await Message.countDocuments({
      fromId: userId,
      createdAt: { $gte: countStart },
    });

    if (count < 5) {
      return res.json({
        success: false,
        task: {
          messagesSentToday: count,
          claimedToday: false,
          reward: FIVE_MESSAGES_REWARD,
          secondsUntilClaim: 0,
          nextClaimAt: null,
        },
      });
    }

    const newFree = (wallet.freeGold ?? 0) + FIVE_MESSAGES_REWARD;
    wallet.freeGold = newFree;
    wallet.totalGold = (wallet.chargedGold ?? 0) + newFree;
    wallet.lastFiveMessagesClaim = now;
    wallet.transactions.push({ amount: 0, bonus: FIVE_MESSAGES_REWARD, createdAt: now });
    await wallet.save();

    invalidateWalletCache(userId);

    const nextClaimAt = new Date(now.getTime() + FIVE_MESSAGES_COOLDOWN_MS);
    return res.json({
      success: true,
      task: {
        messagesSentToday: 5,
        claimedToday: true,
        reward: FIVE_MESSAGES_REWARD,
        secondsUntilClaim: FIVE_MESSAGES_COOLDOWN_MS / 1000,
        nextClaimAt: nextClaimAt.toISOString(),
      },
    });
  } catch (err) {
    console.error("POST /wallet/claim-task-five-messages error:", err);
    res.status(500).json({ success: false, message: "خطأ في استلام المكافأة" });
  }
});

const SHARE_MOMENT_REWARD = 10;
const SHARE_MOMENT_COOLDOWN_MS = 24 * 60 * 60 * 1000; // 24 ساعة

// GET /api/wallet/task-share-moment — حالة مهمة نشر لحظة (مهلة 24 ساعة بعد كل تحصيل)
router.get("/wallet/task-share-moment", auth, async (req, res) => {
  try {
    const userId = req.user.id;
    const now = new Date();
    const wallet = await Wallet.findOne({ userId });
    const lastClaim = wallet?.lastShareMomentClaim ? new Date(wallet.lastShareMomentClaim) : null;
    const cooldownEnd = lastClaim ? new Date(lastClaim.getTime() + SHARE_MOMENT_COOLDOWN_MS) : null;
    const inCooldown = cooldownEnd && now < cooldownEnd;
    let secondsUntilClaim = 0;
    if (inCooldown && cooldownEnd) {
      secondsUntilClaim = Math.max(0, Math.floor((cooldownEnd - now) / 1000));
    }
    return res.json({
      success: true,
      task: {
        claimedToday: inCooldown,
        reward: SHARE_MOMENT_REWARD,
        secondsUntilClaim,
        nextClaimAt: cooldownEnd ? cooldownEnd.toISOString() : null,
      },
    });
  } catch (err) {
    console.error("GET /wallet/task-share-moment error:", err);
    res.status(500).json({ success: false, message: "خطأ في جلب حالة المهمة" });
  }
});

// POST /api/wallet/claim-task-share-moment — استلام 10 ذهب عند نشر لحظة
router.post("/wallet/claim-task-share-moment", auth, async (req, res) => {
  try {
    const userId = req.user.id;
    const now = new Date();
    const wallet = await ensureWallet(userId);
    const lastClaim = wallet.lastShareMomentClaim ? new Date(wallet.lastShareMomentClaim) : null;
    const cooldownEnd = lastClaim ? new Date(lastClaim.getTime() + SHARE_MOMENT_COOLDOWN_MS) : null;
    const inCooldown = cooldownEnd && now < cooldownEnd;

    if (inCooldown) {
      const secondsUntilClaim = Math.max(0, Math.floor((cooldownEnd - now) / 1000));
      return res.json({
        success: false,
        task: {
          claimedToday: true,
          reward: SHARE_MOMENT_REWARD,
          secondsUntilClaim,
          nextClaimAt: cooldownEnd.toISOString(),
        },
      });
    }

    const newFree = (wallet.freeGold ?? 0) + SHARE_MOMENT_REWARD;
    wallet.freeGold = newFree;
    wallet.totalGold = (wallet.chargedGold ?? 0) + newFree;
    wallet.lastShareMomentClaim = now;
    wallet.transactions.push({ amount: 0, bonus: SHARE_MOMENT_REWARD, createdAt: now });
    await wallet.save();

    invalidateWalletCache(userId);

    const nextClaimAt = new Date(now.getTime() + SHARE_MOMENT_COOLDOWN_MS);
    return res.json({
      success: true,
      task: {
        claimedToday: true,
        reward: SHARE_MOMENT_REWARD,
        secondsUntilClaim: SHARE_MOMENT_COOLDOWN_MS / 1000,
        nextClaimAt: nextClaimAt.toISOString(),
      },
    });
  } catch (err) {
    console.error("POST /wallet/claim-task-share-moment error:", err);
    res.status(500).json({ success: false, message: "خطأ في استلام المكافأة" });
  }
});

const ADD_FRIEND_REWARD = 25;
const ADD_FRIEND_COOLDOWN_MS = 24 * 60 * 60 * 1000; // 24 ساعة

// GET /api/wallet/task-add-friend — حالة مهمة إضافة صديق (مهلة 24 ساعة بعد كل تحصيل)
router.get("/wallet/task-add-friend", auth, async (req, res) => {
  try {
    const userId = req.user.id;
    const now = new Date();
    const wallet = await Wallet.findOne({ userId });
    const lastClaim = wallet?.lastAddFriendClaim ? new Date(wallet.lastAddFriendClaim) : null;
    const cooldownEnd = lastClaim ? new Date(lastClaim.getTime() + ADD_FRIEND_COOLDOWN_MS) : null;
    const inCooldown = cooldownEnd && now < cooldownEnd;
    let secondsUntilClaim = 0;
    if (inCooldown && cooldownEnd) {
      secondsUntilClaim = Math.max(0, Math.floor((cooldownEnd - now) / 1000));
    }
    return res.json({
      success: true,
      task: {
        claimedToday: inCooldown,
        reward: ADD_FRIEND_REWARD,
        secondsUntilClaim,
        nextClaimAt: cooldownEnd ? cooldownEnd.toISOString() : null,
      },
    });
  } catch (err) {
    console.error("GET /wallet/task-add-friend error:", err);
    res.status(500).json({ success: false, message: "خطأ في جلب حالة المهمة" });
  }
});

// POST /api/wallet/claim-task-add-friend — استلام 25 ذهب عند إضافة صديق
router.post("/wallet/claim-task-add-friend", auth, async (req, res) => {
  try {
    const userId = req.user.id;
    const now = new Date();
    const wallet = await ensureWallet(userId);
    const lastClaim = wallet.lastAddFriendClaim ? new Date(wallet.lastAddFriendClaim) : null;
    const cooldownEnd = lastClaim ? new Date(lastClaim.getTime() + ADD_FRIEND_COOLDOWN_MS) : null;
    const inCooldown = cooldownEnd && now < cooldownEnd;

    if (inCooldown) {
      const secondsUntilClaim = Math.max(0, Math.floor((cooldownEnd - now) / 1000));
      return res.json({
        success: false,
        task: {
          claimedToday: true,
          reward: ADD_FRIEND_REWARD,
          secondsUntilClaim,
          nextClaimAt: cooldownEnd.toISOString(),
        },
      });
    }

    const newFree = (wallet.freeGold ?? 0) + ADD_FRIEND_REWARD;
    wallet.freeGold = newFree;
    wallet.totalGold = (wallet.chargedGold ?? 0) + newFree;
    wallet.lastAddFriendClaim = now;
    wallet.transactions.push({ amount: 0, bonus: ADD_FRIEND_REWARD, createdAt: now });
    await wallet.save();

    invalidateWalletCache(userId);

    const nextClaimAt = new Date(now.getTime() + ADD_FRIEND_COOLDOWN_MS);
    return res.json({
      success: true,
      task: {
        claimedToday: true,
        reward: ADD_FRIEND_REWARD,
        secondsUntilClaim: ADD_FRIEND_COOLDOWN_MS / 1000,
        nextClaimAt: nextClaimAt.toISOString(),
      },
    });
  } catch (err) {
    console.error("POST /wallet/claim-task-add-friend error:", err);
    res.status(500).json({ success: false, message: "خطأ في استلام المكافأة" });
  }
});

const DICE_REWARD = 8;
const DICE_COOLDOWN_MS = 24 * 60 * 60 * 1000; // 24 ساعة
const DICE_TEXT_REGEX = /^🎲\s*\d$/;

// GET /api/wallet/task-dice — حالة مهمة 5 نرد (مهلة 24 ساعة بعد كل تحصيل)
router.get("/wallet/task-dice", auth, async (req, res) => {
  try {
    const userId = req.user.id;
    const now = new Date();
    const wallet = await Wallet.findOne({ userId });
    const lastClaim = wallet?.lastDiceClaim ? new Date(wallet.lastDiceClaim) : null;
    const cooldownEnd = lastClaim ? new Date(lastClaim.getTime() + DICE_COOLDOWN_MS) : null;
    const inCooldown = cooldownEnd && now < cooldownEnd;

    let count = 5;
    if (!inCooldown) {
      const countStart = cooldownEnd && now >= cooldownEnd ? cooldownEnd : (() => {
        const d = new Date(now);
        d.setUTCHours(0, 0, 0, 0);
        return d;
      })();
      count = await Message.countDocuments({
        fromId: userId,
        createdAt: { $gte: countStart },
        text: { $regex: DICE_TEXT_REGEX },
      });
    }

    let secondsUntilClaim = 0;
    if (inCooldown && cooldownEnd) {
      secondsUntilClaim = Math.max(0, Math.floor((cooldownEnd - now) / 1000));
    }

    return res.json({
      success: true,
      task: {
        diceSentToday: Math.min(5, count),
        claimedToday: inCooldown,
        reward: DICE_REWARD,
        secondsUntilClaim,
        nextClaimAt: cooldownEnd ? cooldownEnd.toISOString() : null,
      },
    });
  } catch (err) {
    console.error("GET /wallet/task-dice error:", err);
    res.status(500).json({ success: false, message: "خطأ في جلب حالة المهمة" });
  }
});

// POST /api/wallet/claim-task-dice — استلام 8 ذهب عند إرسال 5 نرد
router.post("/wallet/claim-task-dice", auth, async (req, res) => {
  try {
    const userId = req.user.id;
    const now = new Date();
    const wallet = await ensureWallet(userId);
    const lastClaim = wallet.lastDiceClaim ? new Date(wallet.lastDiceClaim) : null;
    const cooldownEnd = lastClaim ? new Date(lastClaim.getTime() + DICE_COOLDOWN_MS) : null;
    const inCooldown = cooldownEnd && now < cooldownEnd;

    if (inCooldown) {
      const secondsUntilClaim = Math.max(0, Math.floor((cooldownEnd - now) / 1000));
      return res.json({
        success: false,
        task: {
          diceSentToday: 5,
          claimedToday: true,
          reward: DICE_REWARD,
          secondsUntilClaim,
          nextClaimAt: cooldownEnd.toISOString(),
        },
      });
    }

    const countStart = cooldownEnd || new Date(now);
    if (!lastClaim) countStart.setUTCHours(0, 0, 0, 0);
    const count = await Message.countDocuments({
      fromId: userId,
      createdAt: { $gte: countStart },
      text: { $regex: DICE_TEXT_REGEX },
    });

    if (count < 5) {
      return res.json({
        success: false,
        task: {
          diceSentToday: count,
          claimedToday: false,
          reward: DICE_REWARD,
          secondsUntilClaim: 0,
          nextClaimAt: null,
        },
      });
    }

    const newFree = (wallet.freeGold ?? 0) + DICE_REWARD;
    wallet.freeGold = newFree;
    wallet.totalGold = (wallet.chargedGold ?? 0) + newFree;
    wallet.lastDiceClaim = now;
    wallet.transactions.push({ amount: 0, bonus: DICE_REWARD, createdAt: now });
    await wallet.save();

    invalidateWalletCache(userId);

    const nextClaimAt = new Date(now.getTime() + DICE_COOLDOWN_MS);
    return res.json({
      success: true,
      task: {
        diceSentToday: 5,
        claimedToday: true,
        reward: DICE_REWARD,
        secondsUntilClaim: DICE_COOLDOWN_MS / 1000,
        nextClaimAt: nextClaimAt.toISOString(),
      },
    });
  } catch (err) {
    console.error("POST /wallet/claim-task-dice error:", err);
    res.status(500).json({ success: false, message: "خطأ في استلام المكافأة" });
  }
});

// GET /api/wallet/revenue-share — رصيد المستخدم القابل للسحب (هدف تراكمي 10$)
router.get("/wallet/revenue-share", auth, async (req, res) => {
  try {
    const userId = req.user.id;
    const weekStart = RevenueShare.getWeekStart();
    let rs = await RevenueShare.findOne({ userId });
    if (!rs) {
      rs = await RevenueShare.create({ userId, balancePoints: 0, weekStart, weekEarnedPoints: 0 });
    }
    const balancePoints = rs.balancePoints ?? 0;
    const balanceUsd = balancePoints / RevenueShare.POINTS_PER_DOLLAR;
    const withdrawGoal = RevenueShare.WITHDRAW_GOAL ?? 10;
    const goalPoints = Math.round(withdrawGoal * RevenueShare.POINTS_PER_DOLLAR);
    const progressPercent = Math.min(100, goalPoints > 0 ? (balancePoints / goalPoints) * 100 : 0);
    return res.json({
      success: true,
      revenueShare: {
        balancePoints,
        goalPoints,
        balanceUsd: Math.round(balanceUsd * 100) / 100,
        withdrawGoal,
        progressPercent: Math.round(progressPercent * 10) / 10,
        canWithdraw: balanceUsd >= withdrawGoal,
        minWithdraw: withdrawGoal,
      },
    });
  } catch (err) {
    console.error("GET /wallet/revenue-share error:", err);
    res.status(500).json({ success: false, message: "خطأ في جلب رصيد المشاركة" });
  }
});

// POST /api/wallet/withdraw-request — طلب سحب (الهدف 10$)
router.post("/wallet/withdraw-request", auth, async (req, res) => {
  try {
    const userId = req.user.id;
    const { amount, method, details } = req.body || {};
    const reqAmount = typeof amount === "number" ? amount : parseFloat(amount);
    const minWithdraw = RevenueShare.WITHDRAW_GOAL ?? 10;
    if (isNaN(reqAmount) || reqAmount < minWithdraw) {
      return res.status(400).json({
        success: false,
        message: `الحد الأدنى للسحب ${minWithdraw} دولار`,
      });
    }

    let rs = await RevenueShare.findOne({ userId });
    if (!rs) {
      return res.status(400).json({ success: false, message: "لا يوجد رصيد للسحب" });
    }
    const balanceUsd = (rs.balancePoints ?? 0) / RevenueShare.POINTS_PER_DOLLAR;
    if (balanceUsd < reqAmount) {
      return res.status(400).json({
        success: false,
        message: `رصيدك ${balanceUsd.toFixed(2)}$ غير كافٍ. الحد الأدنى ${minWithdraw}$`,
      });
    }

    const pointsToDeduct = Math.round(reqAmount * RevenueShare.POINTS_PER_DOLLAR);
    rs.balancePoints = Math.max(0, (rs.balancePoints ?? 0) - pointsToDeduct);
    rs.withdrawalRequests.push({
      amount: reqAmount,
      status: "pending",
      method: method || "غير محدد",
      details: details || "",
    });
    await rs.save();

    return res.json({
      success: true,
      message: "تم إرسال طلب السحب. سنتواصل معك خلال 24-48 ساعة",
      revenueShare: {
        balanceUsd: Math.round((rs.balancePoints / RevenueShare.POINTS_PER_DOLLAR) * 100) / 100,
      },
    });
  } catch (err) {
    console.error("POST /wallet/withdraw-request error:", err);
    res.status(500).json({ success: false, message: "خطأ في طلب السحب" });
  }
});

module.exports = router;

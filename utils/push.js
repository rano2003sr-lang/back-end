const axios = require("axios");

async function sendPushNotification(pushToken, title, body, imageUrl, data = {}) {
  if (!pushToken || typeof pushToken !== "string") return;
  const token = String(pushToken).trim();
  if (!token.startsWith("ExponentPushToken")) {
    console.warn("[push] توكن غير صالح (يجب أن يبدأ بـ ExponentPushToken):", token ? token.slice(0, 30) + "..." : "فارغ");
    return;
  }
  try {
    const img = imageUrl && String(imageUrl).trim();
    const finalImg = img && img.startsWith("http") ? img : null;
    const payload = {
      to: token,
      title: title || "رسالة جديدة",
      body: body || "لديك رسالة جديدة",
      sound: "default",
      priority: "high",
      channelId: "messages",
      data: { ...data },
    };
    if (finalImg) {
      payload.richContent = { image: finalImg };
    }
    const res = await axios.post(
      "https://exp.host/--/api/v2/push/send",
      [payload],
      { headers: { "Content-Type": "application/json" }, timeout: 10000 }
    );
    const ticket = res?.data?.data?.[0];
    if (ticket?.status === "error") {
      console.warn("[push] فشل إرسال الإشعار:", ticket.message || ticket);
    }
  } catch (err) {
    console.error("[push] خطأ في إرسال الإشعار:", err?.response?.data || err?.message || err);
  }
}

function buildImageUrl(profileImage, baseUrl) {
  if (!profileImage || !String(profileImage).trim()) return null;
  const img = String(profileImage).trim();
  if (img.startsWith("http") || img.startsWith("data:")) return img;
  if (!baseUrl) return null;
  const base = String(baseUrl).replace(/\/$/, "");
  if (img.startsWith("/uploads/")) return `${base}${img}`;
  if (img.startsWith("uploads/")) return `${base}/${img}`;
  return `${base}/uploads/${img.replace(/^\//, "")}`;
}

function getBaseUrl(req) {
  const proto = req.get("x-forwarded-proto") || req.protocol || "http";
  const host = req.get("x-forwarded-host") || req.get("host");
  return `${proto}://${host}`;
}

/**
 * رابط أساسي يمكن للجهاز الوصول إليه (للإشعارات عند إغلاق التطبيق).
 * يستخدم BASE_URL من .env إذا كان الطلب من localhost.
 */
function getPublicBaseUrl(req) {
  const fromReq = getBaseUrl(req);
  const host = req.get("x-forwarded-host") || req.get("host") || "";
  const isLocal = /localhost|127\.0\.0\.1/i.test(host);
  if (isLocal && process.env.BASE_URL) {
    return String(process.env.BASE_URL).replace(/\/$/, "");
  }
  return fromReq.replace(/\/$/, "");
}

module.exports = { sendPushNotification, buildImageUrl, getBaseUrl, getPublicBaseUrl };

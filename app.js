const express = require("express");
const dns = require("dns");
const app = express();
const mongoose = require("mongoose");
const cors = require("cors");
require("dotenv").config();

// استخدام Google DNS لحل مشكلة querySrv ECONNREFUSED (بعض الشبكات تحجب SRV)
dns.setDefaultResultOrder("ipv4first");
dns.setServers(["8.8.8.8", "8.8.4.4", "1.1.1.1"]);

// Trust proxy (for localtunnel/ngrok)
app.set("trust proxy", true);

// Middleware
try {
  app.use(require("compression")());
} catch {
  // compression غير مُثبت — شغّل: npm install compression
}
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(cors({
  origin: "*", // في الإنتاج ضع domain محدد
  credentials: true,
}));

// Routes
const authRoutes = require("./authGoogle/authGoogle");
const { router: googleAuthRouter } = require("./authGoogle/googleAuth");
const momentsRouter = require("./routes/moments");
const walletRouter = require("./routes/wallet");
const socialRouter = require("./routes/social");
const messagesRouter = require("./routes/messages");
const profileVisitsRouter = require("./routes/profileVisits");
const profileLikesRouter = require("./routes/profileLikes");
const groupChatRouter = require("./routes/groupChat");

app.use("/api", authRoutes); // Routes القديمة (register, login, etc.)
app.use("/api", googleAuthRouter); // Google OAuth routes
app.use("/api", momentsRouter); // اللحظات (صور وفيديو حتى 20 ثانية)
app.use("/api", walletRouter);
app.use("/api/social", socialRouter); // المتابعين والأصدقاء
app.use("/api/profile-visits", profileVisitsRouter); // زواري — من زار بروفايلك
app.use("/api/profile", profileLikesRouter); // إعجاب البروفايل
app.use("/api", groupChatRouter); // الدردشة الجماعية
app.use("/api/messages", messagesRouter);

// Static files
app.use("/uploads", express.static("uploads"));

// Health check
app.get("/health", (req, res) => {
  res.json({ status: "OK", timestamp: new Date().toISOString() });
});

const MONGODB_URI = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/mydb";

// Railway → Atlas: مهلات طويلة + إعادة محاولة (شبكة غير مستقرة)
const mongooseOptions = {
  serverSelectionTimeoutMS: 60000,
  connectTimeoutMS: 60000,
  socketTimeoutMS: 90000,
  maxPoolSize: 10,
  minPoolSize: 1,
  retryWrites: true,
  retryReads: true,
};

function connectMongo(retries = 5) {
  mongoose.connect(MONGODB_URI, mongooseOptions)
    .then(() => console.log("MongoDB Connected ✅"))
    .catch((err) => {
      console.log("MongoDB Error ❌", err?.message || err);
      if (retries > 0) {
        console.log(`إعادة المحاولة بعد 5 ثوانٍ... (${retries} متبقية)`);
        setTimeout(() => connectMongo(retries - 1), 5000);
      }
    });
}
connectMongo();

mongoose.connection.on("error", (err) => {
  console.warn("MongoDB connection error:", err?.message || err);
});
mongoose.connection.on("disconnected", () => {
  console.warn("MongoDB disconnected");
});

app.listen(3000, () => {
  console.log("Server running on http://localhost:3000");
});
import "./env.js";
import express from "express";
import cors from "cors";
import mongoose from "mongoose";
import rateLimit from "express-rate-limit";
import bcrypt from "bcryptjs";
import { User } from "./models/User.js";
import authRoutes from "./routes/auth.js";
import recipeRoutes from "./routes/recipes.js";
import categoryRoutes from "./routes/categories.js";
import userRoutes from "./routes/users.js";
import ocrRoutes from "./routes/ocr.js";
import qrRoutes from "./routes/qr.js";
import syncRoutes from "./routes/sync.js";
import { redis, redisStatus } from "./services/cache.js";
import { RedisStore } from "rate-limit-redis";

// сбой Redis/сети не должен валить сервер
process.on("unhandledRejection", (e) => console.error("Unhandled rejection:", e));

const app = express();
const port = Number(process.env.PORT ?? 4000);
const allowedOrigins = (process.env.CLIENT_ORIGIN ?? "http://localhost:5173").split(",")
  .concat((process.env.ADMIN_ORIGIN ?? "http://localhost:5174").split(","));

app.disable("x-powered-by");
app.set("trust proxy", 1); // за прокси (Render/Railway/nginx) — корректный IP для rate-limit
app.use(cors({ origin: allowedOrigins, credentials: true }));
app.use(express.json({ limit: "4mb" }));
const limiterStore = (prefix: string) => redis
  ? { store: new RedisStore({ prefix: `ck:rl:${prefix}:`, sendCommand: (...args: string[]) => (redis as any).call(...args) }) }
  : {};
app.use("/api/auth/login", rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false, passOnStoreError: true, ...limiterStore("login") }));
app.use("/api/ocr", rateLimit({ windowMs: 60 * 1000, limit: 10, standardHeaders: true, legacyHeaders: false, passOnStoreError: true, ...limiterStore("ocr") }));

app.get("/api/health", (_req, res) => res.json({
  status: "ok",
  service: "clean-kitchen-api",
  database: mongoose.connection.readyState === 1 ? "connected" : "not-connected",
  redis: redisStatus(),
  timestamp: new Date().toISOString()
}));

app.get("/api", (_req, res) => res.json({
  name: "Clean Kitchen API",
  version: "12.0.0",
  stage: "ocr-qr-history-offline"
}));

app.use("/api/auth", authRoutes);
app.use("/api/recipes", recipeRoutes);
app.use("/api/categories", categoryRoutes);
app.use("/api/users", userRoutes);
app.use("/api/ocr", ocrRoutes);
app.use("/api/qr", qrRoutes);
app.use("/api/sync", syncRoutes);

app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err);
  if (err?.name === "CastError") return res.status(400).json({ error: "Некорректный идентификатор" });
  if (err?.message?.includes("Поддерживаются только")) return res.status(400).json({ error: err.message });
  if (err?.code === "LIMIT_FILE_SIZE") return res.status(400).json({ error: "Файл слишком большой (макс. 12 МБ)" });
  res.status(500).json({ error: "Внутренняя ошибка сервера" });
});

async function start() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error("MONGODB_URI не задан. Для V3 требуется MongoDB.");
    process.exit(1);
  }
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 10000 });
  console.log("MongoDB connected");

  const adminEmail = process.env.ADMIN_EMAIL?.toLowerCase();
  const adminPassword = process.env.ADMIN_PASSWORD;
  if (adminEmail && adminPassword) {
    const existing = await User.findOne({ email: adminEmail });
    if (!existing) {
      const passwordHash = await bcrypt.hash(adminPassword, 12);
      await User.create({
        email: adminEmail,
        name: process.env.ADMIN_NAME || "Администратор",
        passwordHash,
        role: "admin"
      });
      console.log("Initial administrator created from environment variables.");
    }
  }

  app.listen(port, "0.0.0.0", () => console.log(`Clean Kitchen API listening on http://localhost:${port}`));
}

start().catch(error => {
  console.error("Server startup failed:", error);
  process.exit(1);
});

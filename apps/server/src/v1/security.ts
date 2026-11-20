import { hash, verify } from "@node-rs/argon2";
import jwt from "jsonwebtoken";
import crypto from "node:crypto";
import type { Request, Response } from "express";

export const cfg = () => ({
  accessSecret: process.env.JWT_ACCESS_SECRET || (process.env.NODE_ENV === "production" ? "" : "dev-access-secret-change-me-0123456789abcdef"),
  refreshSecret: process.env.JWT_REFRESH_SECRET || (process.env.NODE_ENV === "production" ? "" : "dev-refresh-secret-change-me-0123456789abcdef"),
  accessTtl: process.env.ACCESS_TOKEN_TTL || "15m",
  refreshTtlMs: parseDuration(process.env.REFRESH_TOKEN_TTL || "7d"),
  origins: (process.env.APP_ORIGIN || "http://localhost:5173").split(",").map((s) => s.trim()).filter(Boolean)
    .concat(["capacitor://localhost", "ionic://localhost"]),
  prod: process.env.NODE_ENV === "production"
});

export function assertSecrets() {
  const c = cfg();
  if (!c.accessSecret || !c.refreshSecret || c.accessSecret.length < 32 || c.refreshSecret.length < 32)
    throw new Error("JWT_ACCESS_SECRET и JWT_REFRESH_SECRET должны быть заданы (минимум 32 символа)");
}

export function parseDuration(s: string): number {
  const m = /^(\d+)\s*(s|m|h|d)$/.exec(s.trim());
  if (!m) return 7 * 864e5;
  return Number(m[1]) * { s: 1e3, m: 6e4, h: 36e5, d: 864e5 }[m[2] as "s"];
}

// Argon2id (параметры OWASP: 19 МиБ, t=2, p=1)
const ARGON = { algorithm: 2 as const, memoryCost: 19456, timeCost: 2, parallelism: 1 };
export const hashPassword = (pw: string) => hash(pw, ARGON);
export const verifyPassword = (h: string, pw: string) => verify(h, pw).catch(() => false);
// заглушка для выравнивания времени ответа при несуществующем email
let dummy: Promise<string> | null = null;
export const dummyVerify = async (pw: string) => { dummy ??= hashPassword("dummy-password-0"); await verifyPassword(await dummy, pw); };

export function passwordProblem(pw: string): string | null {
  if (pw.length < 10) return "Пароль должен быть не короче 10 символов";
  if (pw.length > 200) return "Пароль слишком длинный";
  if (!/[A-Za-zА-Яа-я]/.test(pw) || !/\d/.test(pw)) return "Пароль должен содержать буквы и цифры";
  return null;
}

export const signAccess = (userId: string, sessionId: string) =>
  jwt.sign({ sub: userId, sid: sessionId, typ: "access" }, cfg().accessSecret, { expiresIn: cfg().accessTtl as any, algorithm: "HS256" });
export const verifyAccess = (t: string) => {
  const p = jwt.verify(t, cfg().accessSecret, { algorithms: ["HS256"] }) as any;
  if (p.typ !== "access") throw new Error("bad token type");
  return p as { sub: string; sid: string };
};

/** Refresh-токен непрозрачный: `<sessionId>.<random>`; в БД хранится только HMAC с JWT_REFRESH_SECRET */
export const newRefreshToken = (sessionId: string) => `${sessionId}.${crypto.randomBytes(32).toString("base64url")}`;
export const refreshHash = (t: string) => crypto.createHmac("sha256", cfg().refreshSecret).update(t).digest("hex");
export const sessionIdOf = (t: string) => /^[a-f0-9]{24}$/.test(t.split(".")[0] ?? "") ? t.split(".")[0] : null;
export const randomToken = () => crypto.randomBytes(32).toString("base64url");
export const sha256 = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

const COOKIE = "ck_rt";
export function setRefreshCookie(res: Response, token: string) {
  const c = cfg();
  res.cookie(COOKIE, token, {
    httpOnly: true, secure: c.prod || process.env.COOKIE_SECURE === "1",
    sameSite: (process.env.COOKIE_SAMESITE as any) || (c.prod ? "none" : "lax"),
    path: "/api/v1/auth", maxAge: c.refreshTtlMs
  });
}
export const clearRefreshCookie = (res: Response) => res.clearCookie(COOKIE, { path: "/api/v1/auth" });
export const readRefreshCookie = (req: Request): string | null => {
  const raw = req.headers.cookie ?? "";
  const m = raw.split(/;\s*/).find((p) => p.startsWith(COOKIE + "="));
  return m ? decodeURIComponent(m.slice(COOKIE.length + 1)) : null;
};

/**
 * CSRF для cookie-refresh: (1) Origin обязан быть в белом списке, (2) обязателен нестандартный заголовок
 * X-CK-CSRF (браузер не пошлёт его кросс-сайт без CORS-preflight, который пропускает только наши origin'ы).
 */
export function csrfOk(req: Request): boolean {
  const origin = req.headers.origin;
  if (origin && !cfg().origins.includes(origin)) return false;
  if (!origin && cfg().prod && req.headers["sec-fetch-site"] && req.headers["sec-fetch-site"] !== "same-origin") return false;
  return req.headers["x-ck-csrf"] === "1";
}

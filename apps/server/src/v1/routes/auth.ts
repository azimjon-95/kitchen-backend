import { Router } from "express";
import { z } from "zod";
import { PlatformUser, Session, RefreshTokenFamily, Membership, Restaurant } from "../models.js";
import { HttpError, authenticate, validate, wrap, oidParam } from "../middleware.js";
import { cfg, verifyPassword, dummyVerify, hashPassword, passwordProblem, readRefreshCookie, clearRefreshCookie, csrfOk,
  sessionIdOf, refreshHash, newRefreshToken, setRefreshCookie, signAccess, randomToken, sha256 } from "../security.js";
import { startSession, revokeSession, revokeAllSessions, defaultRestaurantFor, buildMe, publicUser } from "../session.js";
import { audit } from "../audit.js";

const r = Router();
const MAX_FAILS = 5, LOCK_MS = 15 * 60 * 1000, GRACE_MS = 10_000;

r.post("/login", validate(z.object({ email: z.string().email().max(200), password: z.string().min(1).max(200) })), wrap(async (req, res) => {
  const { email, password } = req.data;
  const user = await PlatformUser.findOne({ email: email.toLowerCase() }).select("+passwordHash");
  if (!user) { await dummyVerify(password); throw new HttpError(401, "Неверный email или пароль", "bad_credentials"); }
  if (user.lockUntil && user.lockUntil > new Date()) throw new HttpError(429, "Слишком много попыток входа. Попробуйте позже", "locked");
  if (!(await verifyPassword(user.passwordHash, password))) {
    const fails = (user.failedLogins ?? 0) + 1;
    await PlatformUser.updateOne({ _id: user._id }, fails >= MAX_FAILS ? { failedLogins: 0, lockUntil: new Date(Date.now() + LOCK_MS) } : { failedLogins: fails });
    await audit(req, { action: "auth.login_failed", entity: "user", entityId: user._id, actor: { id: user._id, email: user.email } });
    throw new HttpError(401, "Неверный email или пароль", "bad_credentials");
  }
  if (user.status !== "active") throw new HttpError(403, "Аккаунт заблокирован", "account_blocked");
  await PlatformUser.updateOne({ _id: user._id }, { failedLogins: 0, lockUntil: null });
  const rid = user.platformRole === "super_admin" ? null : await defaultRestaurantFor(user._id);
  const { session, accessToken } = await startSession(req, res, user, rid);
  req.auth = { user, session };
  await audit(req, { action: "auth.login", entity: "session", entityId: session._id, restaurantId: rid });
  res.json({ accessToken, ...(await buildMe(user, session)) });
}));

r.post("/refresh", wrap(async (req, res) => {
  if (!csrfOk(req)) throw new HttpError(403, "CSRF-проверка не пройдена", "csrf");
  const token = readRefreshCookie(req);
  const sid = token ? sessionIdOf(token) : null;
  if (!token || !sid) throw new HttpError(401, "Нет сессии", "no_refresh");
  const fam = await RefreshTokenFamily.findOne({ sessionId: sid });
  const session = await Session.findById(sid);
  if (!fam || !session || fam.revokedAt || session.revokedAt || session.expiresAt < new Date()) { clearRefreshCookie(res); throw new HttpError(401, "Сессия завершена", "session_revoked"); }
  const h = refreshHash(token);
  if (h !== fam.currentHash) {
    if (fam.usedHashes.includes(h)) {
      // повторное использование уже ротированного токена. В пределах короткого окна — гонка вкладок, иначе кража → отзыв семьи
      if (Date.now() - new Date(fam.rotatedAt).getTime() < GRACE_MS && fam.usedHashes[fam.usedHashes.length - 1] === h) throw new HttpError(401, "Повторите запрос", "refresh_race");
      await revokeSession(sid, "refresh_reuse");
      await audit(req, { action: "auth.refresh_reuse_detected", entity: "session", entityId: sid, actor: { id: session.userId }, restaurantId: session.restaurantId });
    }
    clearRefreshCookie(res); throw new HttpError(401, "Сессия завершена", "session_revoked");
  }
  const user = await PlatformUser.findById(session.userId);
  if (!user || user.status !== "active") { await revokeSession(sid, "account_blocked"); clearRefreshCookie(res); throw new HttpError(401, "Аккаунт заблокирован", "account_blocked"); }
  const next = newRefreshToken(sid);
  const upd = await RefreshTokenFamily.updateOne({ sessionId: sid, currentHash: h, revokedAt: null },
    { currentHash: refreshHash(next), rotatedAt: new Date(), $push: { usedHashes: { $each: [h], $slice: -20 } } });
  if (!upd.modifiedCount) throw new HttpError(401, "Повторите запрос", "refresh_race");
  await Session.updateOne({ _id: sid }, { lastSeenAt: new Date() });
  setRefreshCookie(res, next);
  res.json({ accessToken: signAccess(String(user._id), sid), ...(await buildMe(user, session)) });
}));

r.post("/logout", wrap(async (req, res) => {
  if (!csrfOk(req)) throw new HttpError(403, "CSRF-проверка не пройдена", "csrf");
  const token = readRefreshCookie(req); const sid = token ? sessionIdOf(token) : null;
  if (sid) {
    const s = await Session.findById(sid);
    if (s) { await revokeSession(sid, "logout"); await audit(req, { action: "auth.logout", entity: "session", entityId: sid, actor: { id: s.userId }, restaurantId: s.restaurantId }); }
  }
  clearRefreshCookie(res); res.json({ ok: true });
}));

r.get("/me", authenticate, wrap(async (req, res) => res.json(await buildMe(req.auth.user, req.auth.session))));

r.post("/logout-all", authenticate, wrap(async (req, res) => {
  const n = await revokeAllSessions(req.auth.user._id, "logout_all");
  await audit(req, { action: "auth.logout_all", entity: "user", entityId: req.auth.user._id, after: { revoked: n } });
  clearRefreshCookie(res); res.json({ ok: true, revoked: n });
}));

/** Смена ресторана — только из списка собственных членств (проверяется на сервере) */
r.post("/switch-restaurant", authenticate, validate(z.object({ restaurantId: z.string().length(24) })), wrap(async (req, res) => {
  const m = await Membership.findOne({ userId: req.auth.user._id, restaurantId: req.data.restaurantId, status: "active" });
  if (!m) throw new HttpError(403, "Нет доступа к ресторану", "no_membership");
  req.auth.session.restaurantId = m.restaurantId; await req.auth.session.save();
  await audit(req, { action: "auth.switch_restaurant", entity: "restaurant", entityId: m.restaurantId, restaurantId: m.restaurantId });
  res.json(await buildMe(req.auth.user, req.auth.session));
}));

r.post("/password/change", authenticate, validate(z.object({ currentPassword: z.string().max(200), newPassword: z.string().max(200) })), wrap(async (req, res) => {
  const u = await PlatformUser.findById(req.auth.user._id).select("+passwordHash");
  if (!(await verifyPassword(u.passwordHash, req.data.currentPassword))) throw new HttpError(403, "Текущий пароль неверен", "bad_password");
  const prob = passwordProblem(req.data.newPassword); if (prob) throw new HttpError(400, prob, "weak_password");
  u.passwordHash = await hashPassword(req.data.newPassword); u.passwordChangedAt = new Date(); await u.save();
  const n = await revokeAllSessions(u._id, "password_changed");
  const { session, accessToken } = await startSession(req, res, u, req.auth.session.restaurantId);
  await audit(req, { action: "auth.password_changed", entity: "user", entityId: u._id, after: { revokedSessions: n } });
  res.json({ accessToken, revoked: n, sessionId: String(session._id) });
}));

// Восстановление пароля: ответ всегда одинаковый (не раскрываем, существует ли email). Токен одноразовый, 30 минут.
r.post("/password/forgot", validate(z.object({ email: z.string().email().max(200) })), wrap(async (req, res) => {
  const u = await PlatformUser.findOne({ email: req.data.email.toLowerCase(), status: "active" });
  const out: any = { ok: true };
  if (u) {
    const t = randomToken();
    await PlatformUser.updateOne({ _id: u._id }, { resetHash: sha256(t), resetExpires: new Date(Date.now() + 30 * 60_000) });
    await audit(req, { action: "auth.password_reset_requested", entity: "user", entityId: u._id, actor: { id: u._id, email: u.email } });
    // Почтовый транспорт подключается отдельно (SMTP не входит в бэкенд). Для разработки/тестов токен можно получить явно.
    if (!cfg().prod && process.env.RESET_TOKEN_IN_RESPONSE === "1") out.devToken = t;
    else console.log(`[password-reset] токен для ${u.email} создан (отправьте письмом через ваш почтовый сервис)`);
  }
  res.json(out);
}));
r.post("/password/reset", validate(z.object({ token: z.string().min(20).max(100), newPassword: z.string().max(200) })), wrap(async (req, res) => {
  const prob = passwordProblem(req.data.newPassword); if (prob) throw new HttpError(400, prob, "weak_password");
  const u = await PlatformUser.findOne({ resetHash: sha256(req.data.token), resetExpires: { $gt: new Date() } }).select("+resetHash +resetExpires");
  if (!u) throw new HttpError(400, "Ссылка недействительна или устарела", "bad_reset_token");
  u.passwordHash = await hashPassword(req.data.newPassword); u.passwordChangedAt = new Date(); u.resetHash = null; u.resetExpires = null; u.failedLogins = 0; u.lockUntil = null;
  await u.save(); await revokeAllSessions(u._id, "password_reset");
  await audit(req, { action: "auth.password_reset", entity: "user", entityId: u._id, actor: { id: u._id, email: u.email } });
  res.json({ ok: true });
}));

export const sessionsRouter = Router();
sessionsRouter.use(authenticate);
sessionsRouter.get("/", wrap(async (req, res) => {
  const items = await Session.find({ userId: req.auth.user._id, revokedAt: null, expiresAt: { $gt: new Date() } }).sort({ lastSeenAt: -1 }).lean<any[]>();
  res.json({ items: items.map((s) => ({ id: String(s._id), current: String(s._id) === String(req.auth.session._id), ip: s.ip, userAgent: s.userAgent, createdAt: s.createdAt, lastSeenAt: s.lastSeenAt })) });
}));
sessionsRouter.delete("/:id", oidParam(), wrap(async (req, res) => {
  const s = await Session.findOne({ _id: req.params.id, userId: req.auth.user._id });
  if (!s) throw new HttpError(404, "Сессия не найдена", "not_found");
  await revokeSession(s._id, "revoked_by_user");
  await audit(req, { action: "session.revoked", entity: "session", entityId: s._id });
  res.json({ ok: true });
}));
export default r;

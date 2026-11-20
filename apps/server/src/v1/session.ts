import type { Request, Response } from "express";
import { PlatformUser, Session, RefreshTokenFamily, Membership, Restaurant, Role } from "./models.js";
import { cfg, signAccess, newRefreshToken, refreshHash, setRefreshCookie } from "./security.js";
import { resolveTenant, HttpError } from "./middleware.js";

export async function startSession(req: Request, res: Response, user: any, restaurantId?: any) {
  const c = cfg();
  const session = await Session.create({
    userId: user._id, restaurantId: restaurantId ?? null, ip: req.ip, userAgent: String(req.headers["user-agent"] ?? "").slice(0, 200),
    expiresAt: new Date(Date.now() + c.refreshTtlMs)
  });
  const refresh = newRefreshToken(String(session._id));
  await RefreshTokenFamily.create({ sessionId: session._id, userId: user._id, currentHash: refreshHash(refresh) });
  setRefreshCookie(res, refresh);
  return { session, accessToken: signAccess(String(user._id), String(session._id)) };
}

export async function revokeSession(sessionId: any, reason: string) {
  await Session.updateOne({ _id: sessionId, revokedAt: null }, { revokedAt: new Date(), revokedReason: reason });
  await RefreshTokenFamily.updateOne({ sessionId, revokedAt: null }, { revokedAt: new Date() });
}
export async function revokeAllSessions(userId: any, reason: string, exceptId?: any) {
  const q: any = { userId, revokedAt: null }; if (exceptId) q._id = { $ne: exceptId };
  const ids = (await Session.find(q).select("_id").lean<any[]>()).map((s) => s._id);
  if (!ids.length) return 0;
  await Session.updateMany({ _id: { $in: ids } }, { revokedAt: new Date(), revokedReason: reason });
  await RefreshTokenFamily.updateMany({ sessionId: { $in: ids }, revokedAt: null }, { revokedAt: new Date() });
  return ids.length;
}

/** Выбор ресторана при входе: первый ресторан с активным членством (серверное решение) */
export async function defaultRestaurantFor(userId: any) {
  const ms = await Membership.find({ userId, status: "active" }).sort({ createdAt: 1 }).lean<any[]>();
  if (!ms.length) return null;
  const rs = await Restaurant.find({ _id: { $in: ms.map((m) => m.restaurantId) } }).select("status").lean<any[]>();
  const act = ms.find((m) => rs.find((r) => String(r._id) === String(m.restaurantId))?.status === "active");
  return (act ?? ms[0]).restaurantId;
}

export function publicUser(u: any) { return { id: String(u._id), email: u.email, name: u.name, platformRole: u.platformRole }; }

/** Контекст для клиента: из него строится меню и доступные действия (клиенту нельзя доверять — сервер перепроверяет всё) */
export async function buildMe(user: any, session: any) {
  const ms = await Membership.find({ userId: user._id }).lean<any[]>();
  const rs = await Restaurant.find({ _id: { $in: ms.map((m) => m.restaurantId) } }).lean<any[]>();
  const roles = await Role.find({ _id: { $in: ms.map((m) => m.roleId) }, restaurantId: { $in: ms.map((m) => m.restaurantId) } }).lean<any[]>();
  const memberships = ms.map((m) => {
    const r = rs.find((x) => String(x._id) === String(m.restaurantId));
    const ro = roles.find((x) => String(x._id) === String(m.roleId));
    return { restaurantId: String(m.restaurantId), restaurantName: r?.name ?? "?", restaurantStatus: r?.status, status: m.status, roleName: ro?.name ?? "?", roleKey: ro?.key ?? "" };
  });
  const out: any = { user: publicUser(user), memberships, restaurant: null, role: null, permissions: {}, features: [], flags: {}, scope: null, assigned: null, tenantError: null };
  if (session.restaurantId) {
    try {
      const t = await resolveTenant(user._id, session.restaurantId);
      out.restaurant = { id: String(t.restaurant._id), name: t.restaurant.name, organization: t.restaurant.organization, currency: t.restaurant.currency, timezone: t.restaurant.timezone, logoUrl: t.restaurant.logoUrl };
      out.role = { id: String(t.role._id), key: t.role.key, name: t.role.name };
      out.permissions = t.perms; out.features = t.role.features ?? [];
      out.flags = { denyCost: !!t.role.denyCost && !t.isOwner, denyPurchasePriceEdit: !!t.role.denyPurchasePriceEdit && !t.isOwner };
      out.scope = t.role.scope; out.assigned = t.membership.assigned ?? null;
    } catch (e) { if (e instanceof HttpError) out.tenantError = { code: e.code, message: e.message }; else throw e; }
  }
  return out;
}

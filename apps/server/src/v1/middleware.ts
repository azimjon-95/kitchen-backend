import type { Request, Response, NextFunction, RequestHandler } from "express";
import type { ZodTypeAny } from "zod";
import mongoose from "mongoose";
import { verifyAccess } from "./security.js";
import { PlatformUser, Session, Membership, Role, Restaurant } from "./models.js";
import { hasPerm, type Action, type Section, type PermMap } from "./permissions.js";

export class HttpError extends Error {
  constructor(public status: number, message: string, public code = "error") { super(message); }
}
export const wrap = (fn: (req: any, res: Response, next: NextFunction) => Promise<any>): RequestHandler =>
  (req, res, next) => { fn(req, res, next).catch(next); };

export interface TenantCtx {
  restaurantId: mongoose.Types.ObjectId; restaurant: any; membership: any; role: any;
  perms: PermMap; isOwner: boolean;
}

/** 1+2. Authentication + Session validation: токен подписан, сессия жива, пользователь активен */
export const authenticate = wrap(async (req, _res, next) => {
  const h = req.headers.authorization;
  if (!h?.startsWith("Bearer ")) throw new HttpError(401, "Требуется авторизация", "unauthorized");
  let p; try { p = verifyAccess(h.slice(7)); } catch { throw new HttpError(401, "Недействительный или просроченный токен", "token_invalid"); }
  if (!mongoose.isValidObjectId(p.sid)) throw new HttpError(401, "Недействительный токен", "token_invalid");
  const session = await Session.findById(p.sid);
  if (!session || session.revokedAt || session.expiresAt < new Date() || String(session.userId) !== p.sub)
    throw new HttpError(401, "Сессия завершена", "session_revoked");
  const user = await PlatformUser.findById(p.sub);
  if (!user || user.status !== "active") throw new HttpError(401, "Аккаунт заблокирован", "account_blocked");
  req.auth = { user, session };
  next();
});

export const requireSuperAdmin: RequestHandler = (req: any, _res, next) =>
  req.auth?.user?.platformRole === "super_admin" ? next() : next(new HttpError(403, "Только для Super Admin", "forbidden"));

/**
 * 3+4. Tenant context + членство: ресторан берётся ТОЛЬКО из серверной сессии (session.restaurantId),
 * никогда из тела/URL/заголовков запроса. Проверяются статус ресторана, членство и окно доступа.
 */
export async function resolveTenant(userId: any, restaurantId: any): Promise<TenantCtx> {
  const restaurant = await Restaurant.findById(restaurantId);
  if (!restaurant) throw new HttpError(403, "Ресторан недоступен", "no_tenant");
  if (restaurant.status !== "active") throw new HttpError(403, restaurant.status === "suspended" ? "Ресторан заблокирован" : "Ресторан в архиве", "restaurant_" + restaurant.status);
  const membership = await Membership.findOne({ userId, restaurantId });
  if (!membership || membership.status !== "active") throw new HttpError(403, "Нет доступа к ресторану", "no_membership");
  const now = new Date();
  if ((membership.accessFrom && membership.accessFrom > now) || (membership.accessUntil && membership.accessUntil < now))
    throw new HttpError(403, "Срок доступа истёк или ещё не начался", "access_window");
  const role = await Role.findOne({ _id: membership.roleId, restaurantId });
  if (!role) throw new HttpError(403, "Роль не найдена", "no_role");
  return { restaurantId: restaurant._id, restaurant, membership, role, perms: role.permissions ?? {}, isOwner: role.key === "owner" };
}

export const tenant = wrap(async (req, _res, next) => {
  const sess = req.auth.session;
  if (!sess.restaurantId) throw new HttpError(403, "Не выбран ресторан", "no_tenant");
  req.tenant = await resolveTenant(req.auth.user._id, sess.restaurantId);
  next();
});

/** 5. RBAC: нет явного разрешения → 403 */
export const can = (section: Section, action: Action): RequestHandler => (req: any, _res, next) =>
  hasPerm(req.tenant?.perms, section, action) ? next() : next(new HttpError(403, "Недостаточно прав", "forbidden"));

/** 6. Resource scope: фильтр рецептов, доступных участнику (Category-based / Recipe-based / по цехам) */
export function recipeScope(t: TenantCtx): Record<string, any> {
  const base: any = { restaurantId: t.restaurantId };
  // без права создавать/редактировать карточки черновики и архив не видны
  if (!hasPerm(t.perms, "recipes", "edit") && !hasPerm(t.perms, "recipes", "create")) base.status = "published";
  if (t.role.scope === "all") return base;
  const a = t.membership.assigned ?? {};
  const or: any[] = [];
  if (a.categoryIds?.length) or.push({ categoryId: { $in: a.categoryIds } });
  if (a.recipeIds?.length) or.push({ _id: { $in: a.recipeIds } });
  if (a.zones?.length) or.push({ zone: { $in: a.zones } });
  base.$or = or.length ? or : [{ _id: null }]; // ничего не назначено → ничего не видно
  return base;
}
export function categoryScope(t: TenantCtx): Record<string, any> {
  const base: any = { restaurantId: t.restaurantId };
  if (t.role.scope === "all") return base;
  const a = t.membership.assigned ?? {};
  const or: any[] = [];
  if (a.categoryIds?.length) or.push({ _id: { $in: a.categoryIds } });
  if (a.zones?.length) or.push({ zone: { $in: a.zones } });
  base.$or = or.length ? or : [{ _id: null }];
  return base;
}

/** 7. Валидация входа */
export const validate = (schema: ZodTypeAny, where: "body" | "query" = "body"): RequestHandler => (req: any, _res, next) => {
  const r = schema.safeParse(req[where]);
  if (!r.success) return next(new HttpError(400, "Некорректные данные: " + r.error.issues.map((i) => i.path.join(".") + " " + i.message).join("; ").slice(0, 300), "validation"));
  req[where === "body" ? "data" : "q"] = r.data;
  next();
};

export const oidParam = (name = "id"): RequestHandler => (req, _res, next) =>
  mongoose.isValidObjectId(req.params[name]) ? next() : next(new HttpError(400, "Некорректный идентификатор", "bad_id"));

/** 10. Центральный обработчик ошибок */
export function errorHandler(err: any, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, code: err.code });
  if (err?.code === 11000) return res.status(409).json({ error: "Запись с такими данными уже существует", code: "duplicate" });
  if (err?.name === "CastError" || err?.name === "ValidationError") return res.status(400).json({ error: "Некорректные данные", code: "validation" });
  if (String(err?.message).startsWith("tenantGuard")) { console.error(err); return res.status(500).json({ error: "Внутренняя ошибка", code: "tenant_guard" }); }
  console.error(err);
  res.status(500).json({ error: "Внутренняя ошибка сервера", code: "internal" });
}

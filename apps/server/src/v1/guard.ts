import type { RequestHandler } from "express";
import { HttpError, type TenantCtx } from "./middleware.js";
import { audit } from "./audit.js";

/**
 * Защита технологических карт от массового выкачивания.
 * Считает, сколько раз сотрудник получал ПОЛНОЕ содержимое карт за окно времени.
 * Владелец не ограничивается (это его данные). Превышение → 429 + запись в Audit Log (один раз за окно).
 * Лимиты с запасом для обычной работы: офлайн-синхронизация, просмотр десятков карт за смену.
 */
const WINDOW_MS = 60 * 60 * 1000;
const LIMITS = {
  full: Number(process.env.GUARD_FULL_LIST_PER_HOUR ?? 30),   // полная выгрузка списка (?full=1)
  one: Number(process.env.GUARD_RECIPE_VIEWS_PER_HOUR ?? 400),  // открытие отдельных карт
  export: Number(process.env.GUARD_EXPORTS_PER_HOUR ?? 5)       // экспорт
};
type Kind = keyof typeof LIMITS;
const hits = new Map<string, { n: number; start: number; flagged: boolean }>();
setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (now - v.start > WINDOW_MS) hits.delete(k); }, 10 * 60 * 1000).unref();

export const recipeReadGuard = (kind: Kind | ((q: any) => Kind | null)): RequestHandler => (req: any, _res, next) => {
  const t: TenantCtx | undefined = req.tenant;
  if (!t || t.isOwner) return next();
  const k = typeof kind === "function" ? kind(req.query) : kind;
  if (!k) return next();
  const key = `${t.restaurantId}:${req.auth.user._id}:${k}`;
  const now = Date.now();
  let h = hits.get(key);
  if (!h || now - h.start > WINDOW_MS) { h = { n: 0, start: now, flagged: false }; hits.set(key, h); }
  h.n++;
  if (h.n <= LIMITS[k]) return next();
  if (!h.flagged) {
    h.flagged = true;
    void audit(req, { action: "recipe.scrape_suspected", entity: "member", entityId: t.membership._id, after: { kind: k, count: h.n, limitPerHour: LIMITS[k] } });
  }
  next(new HttpError(429, "Слишком много обращений к техкартам. Попробуйте позже или обратитесь к владельцу.", "read_limit"));
};
export const _resetGuard = () => hits.clear();

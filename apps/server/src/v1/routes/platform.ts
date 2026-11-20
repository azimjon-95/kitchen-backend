import { Router } from "express";
import { z } from "zod";
import { PlatformUser, Restaurant, Membership, Role, TRecipe, AuditLog, TCategory, TIngredient } from "../models.js";
import { HttpError, authenticate, requireSuperAdmin, validate, wrap, oidParam } from "../middleware.js";
import { hashPassword, passwordProblem, randomToken, sha256, cfg } from "../security.js";
import { revokeAllSessions } from "../session.js";
import { seedRoles, ownerMembership } from "../tenantSetup.js";
import { audit } from "../audit.js";

const r = Router();
r.use(authenticate, requireSuperAdmin);

const slugRe = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;
const ownerSchema = z.object({ email: z.string().email().max(200), name: z.string().trim().min(2).max(100), password: z.string().max(200) });
const restSchema = z.object({
  name: z.string().trim().min(2).max(120), organization: z.string().trim().min(2).max(120), slug: z.string().toLowerCase().regex(slugRe, "slug: a-z, 0-9, дефис"),
  address: z.string().max(300).optional().default(""),
  contacts: z.object({ phone: z.string().max(40).optional().default(""), email: z.string().max(200).optional().default("") }).optional().default({}),
  logoUrl: z.string().max(1000).optional().default(""), currency: z.string().length(3).optional().default("UZS"), timezone: z.string().max(60).optional().default("Asia/Tashkent"),
  status: z.enum(["active", "suspended", "archived"]).optional().default("active"),
  ownerId: z.string().length(24).optional(), owner: ownerSchema.optional()
}).refine((v) => !!v.ownerId !== !!v.owner, "Укажите ownerId ИЛИ owner (новый владелец)");

const dto = (x: any, extra: any = {}) => ({ id: String(x._id), name: x.name, organization: x.organization, slug: x.slug, address: x.address, contacts: x.contacts, logoUrl: x.logoUrl, currency: x.currency, timezone: x.timezone, status: x.status, ownerId: String(x.ownerId), createdAt: x.createdAt, ...extra });

async function createOwner(o: z.infer<typeof ownerSchema>) {
  const prob = passwordProblem(o.password); if (prob) throw new HttpError(400, prob, "weak_password");
  return PlatformUser.create({ email: o.email.toLowerCase(), name: o.name, passwordHash: await hashPassword(o.password), platformRole: "user" });
}

r.get("/restaurants", wrap(async (_req, res) => {
  const items = await Restaurant.find().sort({ createdAt: -1 }).lean<any[]>();
  const out = [];
  for (const x of items) {
    const [members, recipes, owner] = await Promise.all([
      Membership.countDocuments({ restaurantId: x._id }), TRecipe.countDocuments({ restaurantId: x._id }), PlatformUser.findById(x.ownerId).select("email name").lean<any>()
    ]);
    out.push(dto(x, { membersCount: members, recipesCount: recipes, owner: owner && { id: String(owner._id), email: owner.email, name: owner.name } }));
  }
  res.json({ items: out });
}));

r.post("/restaurants", validate(restSchema), wrap(async (req, res) => {
  const d = req.data;
  if (await Restaurant.exists({ slug: d.slug })) throw new HttpError(409, "Идентификатор ресторана занят", "duplicate");
  const owner = d.owner ? await createOwner(d.owner) : await PlatformUser.findById(d.ownerId);
  if (!owner || owner.platformRole === "super_admin") throw new HttpError(400, "Владелец не найден или недопустим", "bad_owner");
  // несколько ресторанов у одного владельца возможны только по явному решению Super Admin (передача существующего ownerId)
  const { owner: _o, ownerId: _i, ...rest } = d;
  const rest0 = await Restaurant.create({ ...rest, ownerId: owner._id });
  const roles = await seedRoles(rest0._id);
  await ownerMembership(rest0._id, owner._id, roles.owner._id);
  await audit(req, { action: "restaurant.created", entity: "restaurant", entityId: rest0._id, after: dto(rest0), restaurantId: rest0._id });
  res.status(201).json({ item: dto(rest0), owner: { id: String(owner._id), email: owner.email } });
}));

r.get("/restaurants/:id", oidParam(), wrap(async (req, res) => {
  const x = await Restaurant.findById(req.params.id); if (!x) throw new HttpError(404, "Ресторан не найден", "not_found");
  const [members, recipes, categories, ingredients] = await Promise.all([
    Membership.countDocuments({ restaurantId: x._id }), TRecipe.countDocuments({ restaurantId: x._id }),
    TCategory.countDocuments({ restaurantId: x._id }), TIngredient.countDocuments({ restaurantId: x._id })]);
  res.json({ item: dto(x, { membersCount: members, recipesCount: recipes, categoriesCount: categories, ingredientsCount: ingredients }) });
}));

const patchSchema = z.object({
  name: z.string().trim().min(2).max(120), organization: z.string().trim().min(2).max(120), address: z.string().max(300),
  contacts: z.object({ phone: z.string().max(40), email: z.string().max(200) }), logoUrl: z.string().max(1000), currency: z.string().length(3), timezone: z.string().max(60)
}).partial().strict();
r.patch("/restaurants/:id", oidParam(), validate(patchSchema), wrap(async (req, res) => {
  const x = await Restaurant.findById(req.params.id); if (!x) throw new HttpError(404, "Ресторан не найден", "not_found");
  const before = dto(x); x.set(req.data); await x.save();
  await audit(req, { action: "restaurant.updated", entity: "restaurant", entityId: x._id, before, after: dto(x), restaurantId: x._id });
  res.json({ item: dto(x) });
}));

r.post("/restaurants/:id/status", oidParam(), validate(z.object({ status: z.enum(["active", "suspended", "archived"]) })), wrap(async (req, res) => {
  const x = await Restaurant.findById(req.params.id); if (!x) throw new HttpError(404, "Ресторан не найден", "not_found");
  const before = x.status; x.status = req.data.status; await x.save();
  await audit(req, { action: "restaurant.status_changed", entity: "restaurant", entityId: x._id, before: { status: before }, after: { status: x.status }, restaurantId: x._id });
  res.json({ item: dto(x) });
}));
r.delete("/restaurants/:id", oidParam(), wrap(async (req, res) => {   // «удаление» = архивирование (данные не теряются)
  const x = await Restaurant.findById(req.params.id); if (!x) throw new HttpError(404, "Ресторан не найден", "not_found");
  x.status = "archived"; await x.save();
  await audit(req, { action: "restaurant.archived", entity: "restaurant", entityId: x._id, restaurantId: x._id });
  res.json({ item: dto(x) });
}));

/** Смена владельца: новый владелец получает роль owner, прежний — понижается до «Управляющий» */
r.post("/restaurants/:id/owner", oidParam(), validate(z.object({ ownerId: z.string().length(24).optional(), owner: ownerSchema.optional() }).refine((v) => !!v.ownerId !== !!v.owner)), wrap(async (req, res) => {
  const x = await Restaurant.findById(req.params.id); if (!x) throw new HttpError(404, "Ресторан не найден", "not_found");
  const next = req.data.owner ? await createOwner(req.data.owner) : await PlatformUser.findById(req.data.ownerId);
  if (!next || next.platformRole === "super_admin") throw new HttpError(400, "Владелец не найден или недопустим", "bad_owner");
  const ownerRole = await Role.findOne({ restaurantId: x._id, key: "owner" });
  const mgrRole = await Role.findOne({ restaurantId: x._id, key: "manager" });
  const prev = String(x.ownerId);
  if (prev !== String(next._id)) {
    await Membership.updateOne({ restaurantId: x._id, userId: prev }, { roleId: mgrRole._id });
    await Membership.updateOne({ restaurantId: x._id, userId: next._id }, { roleId: ownerRole._id, status: "active", accessFrom: null, accessUntil: null, "assigned.categoryIds": [], "assigned.recipeIds": [], "assigned.zones": [] }, { upsert: true });
    x.ownerId = next._id; await x.save();
  }
  await audit(req, { action: "restaurant.owner_changed", entity: "restaurant", entityId: x._id, before: { ownerId: prev }, after: { ownerId: String(next._id) }, restaurantId: x._id });
  res.json({ item: dto(x) });
}));

/** Контролируемый просмотр данных ресторана (read-only, каждое обращение логируется) */
r.get("/restaurants/:id/support/recipes", oidParam(), wrap(async (req, res) => {
  const x = await Restaurant.findById(req.params.id); if (!x) throw new HttpError(404, "Ресторан не найден", "not_found");
  await audit(req, { action: "support.view_recipes", entity: "restaurant", entityId: x._id, restaurantId: x._id });
  const items = await TRecipe.find({ restaurantId: x._id }).select("name status zone updatedAt").sort({ updatedAt: -1 }).limit(200).lean<any[]>();
  res.json({ items: items.map((i) => ({ id: String(i._id), name: i.name, status: i.status, zone: i.zone, updatedAt: i.updatedAt })) });
}));

r.get("/users", wrap(async (_req, res) => {
  const items = await PlatformUser.find().sort({ createdAt: -1 }).limit(500).lean<any[]>();
  res.json({ items: items.map((u) => ({ id: String(u._id), email: u.email, name: u.name, platformRole: u.platformRole, status: u.status, createdAt: u.createdAt })) });
}));
r.post("/users", validate(ownerSchema), wrap(async (req, res) => {
  const u = await createOwner(req.data);
  await audit(req, { action: "platform_user.created", entity: "user", entityId: u._id, after: { email: u.email, name: u.name } });
  res.status(201).json({ item: { id: String(u._id), email: u.email, name: u.name, status: u.status } });
}));
r.post("/users/:id/status", oidParam(), validate(z.object({ status: z.enum(["active", "blocked"]) })), wrap(async (req, res) => {
  const u = await PlatformUser.findById(req.params.id); if (!u) throw new HttpError(404, "Пользователь не найден", "not_found");
  if (u.platformRole === "super_admin" && String(u._id) === String(req.auth.user._id)) throw new HttpError(400, "Нельзя заблокировать себя", "self");
  const before = u.status; u.status = req.data.status; await u.save();
  const n = u.status === "blocked" ? await revokeAllSessions(u._id, "blocked") : 0;   // блокировка действует немедленно
  await audit(req, { action: u.status === "blocked" ? "user.blocked" : "user.unblocked", entity: "user", entityId: u._id, before: { status: before }, after: { status: u.status, revoked: n } });
  res.json({ ok: true, status: u.status });
}));
r.post("/users/:id/reset-password-token", oidParam(), wrap(async (req, res) => {
  const u = await PlatformUser.findById(req.params.id); if (!u) throw new HttpError(404, "Пользователь не найден", "not_found");
  const t = randomToken();
  await PlatformUser.updateOne({ _id: u._id }, { resetHash: sha256(t), resetExpires: new Date(Date.now() + 30 * 60_000) });
  await audit(req, { action: "user.reset_token_issued", entity: "user", entityId: u._id });
  res.json({ token: t, expiresInMinutes: 30 });
}));

r.get("/audit-logs", wrap(async (req, res) => {
  const q: any = {}; if (req.query.restaurantId && /^[a-f0-9]{24}$/.test(String(req.query.restaurantId))) q.restaurantId = req.query.restaurantId;
  if (req.query.action) q.action = new RegExp("^" + String(req.query.action).replace(/[^\w.]/g, ""));
  const items = await AuditLog.find(q).sort({ at: -1 }).limit(Math.min(Number(req.query.limit) || 100, 500)).lean<any[]>();
  res.json({ items: items.map(fmtAudit) });
}));
export const fmtAudit = (a: any) => ({ id: String(a._id), at: a.at, action: a.action, entity: a.entity, entityId: a.entityId, actorEmail: a.actorEmail, restaurantId: a.restaurantId ? String(a.restaurantId) : null, before: a.before, after: a.after, ip: a.ip });
export default r;

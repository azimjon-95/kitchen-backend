import { Router } from "express";
import { z } from "zod";
import mongoose from "mongoose";
import { PlatformUser, Membership, Role, Session, TCategory, TRecipe } from "../models.js";
import { HttpError, authenticate, tenant, can, validate, wrap, oidParam, recipeScope, categoryScope, type TenantCtx } from "../middleware.js";
import { SECTIONS, SECTION_ACTIONS, ACTIONS, FEATURES, ZONES, ZONE_LABELS, normalizePerms, isSubset, type PermMap } from "../permissions.js";
import { hashPassword, passwordProblem, randomToken, sha256 } from "../security.js";
import { revokeSession } from "../session.js";
import { audit } from "../audit.js";

const r = Router();
r.use(authenticate, tenant);

// ───── профиль ресторана ─────
const prof = (x: any) => ({ id: String(x._id), name: x.name, organization: x.organization, slug: x.slug, address: x.address, contacts: x.contacts, logoUrl: x.logoUrl, currency: x.currency, timezone: x.timezone, status: x.status });
r.get("/profile", can("restaurant", "view"), wrap(async (req, res) => res.json({ item: prof(req.tenant.restaurant) })));
r.patch("/profile", can("restaurant", "edit"), validate(z.object({
  name: z.string().trim().min(2).max(120), address: z.string().max(300), logoUrl: z.string().max(1000),
  contacts: z.object({ phone: z.string().max(40), email: z.string().max(200) })
}).partial().strict()), wrap(async (req, res) => {
  const x = req.tenant.restaurant; const before = prof(x); x.set(req.data); await x.save();
  await audit(req, { action: "restaurant.profile_updated", entity: "restaurant", entityId: x._id, before, after: prof(x) });
  res.json({ item: prof(x) });
}));

// ───── защита от privilege escalation ─────
function assertGrantable(t: TenantCtx, p: { permissions: PermMap; scope: string; denyCost: boolean; denyPurchasePriceEdit: boolean; features: string[] }) {
  if (t.isOwner) return;
  if (!isSubset(p.permissions, t.perms)) throw new HttpError(403, "Нельзя выдать права, которых нет у вас", "escalation");
  if (p.scope === "all" && t.role.scope !== "all") throw new HttpError(403, "Нельзя выдать доступ ко всем данным", "escalation");
  if (!p.denyCost && t.role.denyCost) throw new HttpError(403, "Нельзя открыть себестоимость, если она скрыта у вас", "escalation");
  if (!p.denyPurchasePriceEdit && t.role.denyPurchasePriceEdit) throw new HttpError(403, "Нельзя разрешить правку закупочных цен, если она запрещена вам", "escalation");
  if (p.features.some((f) => !(t.role.features ?? []).includes(f))) throw new HttpError(403, "Нельзя выдать функции, которых нет у вас", "escalation");
}
const roleParams = (x: any) => ({ permissions: x.permissions ?? {}, scope: x.scope, denyCost: !!x.denyCost, denyPurchasePriceEdit: !!x.denyPurchasePriceEdit, features: x.features ?? [] });

// ───── роли и разрешения ─────
const roleDto = (x: any) => ({ id: String(x._id), key: x.key, name: x.name, system: x.system, permissions: x.permissions, scope: x.scope, denyCost: x.denyCost, denyPurchasePriceEdit: x.denyPurchasePriceEdit, features: x.features });
r.get("/permissions", can("roles", "view"), (_req, res) => res.json({ sections: SECTIONS, actions: ACTIONS, sectionActions: SECTION_ACTIONS, features: FEATURES, zones: ZONES.map((z) => ({ key: z, label: ZONE_LABELS[z] })) }));
r.get("/roles", can("roles", "view"), wrap(async (req, res) => {
  const items = await Role.find({ restaurantId: req.tenant.restaurantId }).sort({ system: -1, name: 1 }).lean<any[]>();
  const counts = await Membership.aggregate([{ $match: { restaurantId: req.tenant.restaurantId } }, { $group: { _id: "$roleId", n: { $sum: 1 } } }]);
  res.json({ items: items.map((x) => ({ ...roleDto(x), members: counts.find((c) => String(c._id) === String(x._id))?.n ?? 0 })) });
}));
const roleBody = z.object({
  name: z.string().trim().min(2).max(80), permissions: z.record(z.array(z.string())).default({}), scope: z.enum(["all", "assigned"]).default("assigned"),
  denyCost: z.boolean().default(true), denyPurchasePriceEdit: z.boolean().default(true), features: z.array(z.enum(FEATURES)).default([])
});
r.post("/roles", can("roles", "create"), validate(roleBody), wrap(async (req, res) => {
  const d = req.data; const permissions = normalizePerms(d.permissions);
  assertGrantable(req.tenant, { ...d, permissions });
  const x = await Role.create({ restaurantId: req.tenant.restaurantId, name: d.name, permissions, scope: d.scope, denyCost: d.denyCost, denyPurchasePriceEdit: d.denyPurchasePriceEdit, features: d.features });
  await audit(req, { action: "role.created", entity: "role", entityId: x._id, after: roleDto(x) });
  res.status(201).json({ item: roleDto(x) });
}));
r.patch("/roles/:id", oidParam(), can("roles", "edit"), validate(roleBody.partial().strict()), wrap(async (req, res) => {
  const x = await Role.findOne({ _id: req.params.id, restaurantId: req.tenant.restaurantId });
  if (!x) throw new HttpError(404, "Роль не найдена", "not_found");
  if (x.system) throw new HttpError(400, "Системные роли изменить нельзя — создайте копию", "system_role");
  if (String(req.tenant.role._id) === String(x._id)) throw new HttpError(403, "Нельзя менять собственную роль", "self_edit");
  if (!req.tenant.isOwner && !isSubset(x.permissions, req.tenant.perms)) throw new HttpError(403, "Роль мощнее вашей", "escalation");
  const before = roleDto(x); const d = req.data;
  const next = { permissions: d.permissions ? normalizePerms(d.permissions) : x.permissions, scope: d.scope ?? x.scope, denyCost: d.denyCost ?? x.denyCost, denyPurchasePriceEdit: d.denyPurchasePriceEdit ?? x.denyPurchasePriceEdit, features: d.features ?? x.features };
  assertGrantable(req.tenant, next);
  x.set({ ...next, ...(d.name ? { name: d.name } : {}) }); x.markModified("permissions"); await x.save();
  await audit(req, { action: "role.permissions_changed", entity: "role", entityId: x._id, before, after: roleDto(x) });
  res.json({ item: roleDto(x) });
}));
r.delete("/roles/:id", oidParam(), can("roles", "delete"), wrap(async (req, res) => {
  const x = await Role.findOne({ _id: req.params.id, restaurantId: req.tenant.restaurantId });
  if (!x) throw new HttpError(404, "Роль не найдена", "not_found");
  if (x.system) throw new HttpError(400, "Системные роли удалить нельзя", "system_role");
  if (await Membership.exists({ restaurantId: req.tenant.restaurantId, roleId: x._id })) throw new HttpError(409, "Роль назначена сотрудникам", "in_use");
  await Role.deleteOne({ restaurantId: req.tenant.restaurantId, _id: x._id }); await audit(req, { action: "role.deleted", entity: "role", entityId: x._id, before: roleDto(x) });
  res.json({ ok: true });
}));

// ───── сотрудники ─────
const memberDto = (m: any, u: any, role: any) => ({ id: String(m._id), userId: String(m.userId), email: u?.email, name: u?.name, userStatus: u?.status, status: m.status, roleId: String(m.roleId), roleName: role?.name, roleKey: role?.key, assigned: { categoryIds: (m.assigned?.categoryIds ?? []).map(String), recipeIds: (m.assigned?.recipeIds ?? []).map(String), zones: m.assigned?.zones ?? [] }, accessFrom: m.accessFrom, accessUntil: m.accessUntil });
r.get("/members", can("members", "view"), wrap(async (req, res) => {
  const ms = await Membership.find({ restaurantId: req.tenant.restaurantId }).sort({ createdAt: 1 }).lean<any[]>();
  const [us, rs] = await Promise.all([PlatformUser.find({ _id: { $in: ms.map((m) => m.userId) } }).lean<any[]>(), Role.find({ restaurantId: req.tenant.restaurantId }).lean<any[]>()]);
  res.json({ items: ms.map((m) => memberDto(m, us.find((u) => String(u._id) === String(m.userId)), rs.find((x) => String(x._id) === String(m.roleId)))) });
}));

const assignedSchema = z.object({ categoryIds: z.array(z.string().length(24)).max(500).default([]), recipeIds: z.array(z.string().length(24)).max(2000).default([]), zones: z.array(z.enum(ZONES)).default([]) });
async function checkAssigned(t: TenantCtx, a: z.infer<typeof assignedSchema>) {
  // всё назначаемое должно существовать В ЭТОМ ресторане и входить в то, что доступно самому назначающему
  if (a.categoryIds.length) {
    const n = await TCategory.countDocuments({ ...(t.isOwner || t.role.scope === "all" ? { restaurantId: t.restaurantId } : categoryScope(t)), _id: { $in: a.categoryIds } });
    if (n !== new Set(a.categoryIds).size) throw new HttpError(400, "Категории не найдены или недоступны вам", "bad_assignment");
  }
  if (a.recipeIds.length) {
    const n = await TRecipe.countDocuments({ ...recipeScope(t), _id: { $in: a.recipeIds } });
    if (n !== new Set(a.recipeIds).size) throw new HttpError(400, "Карточки не найдены или недоступны вам", "bad_assignment");
  }
  if (!t.isOwner && t.role.scope !== "all" && a.zones.some((z) => !(t.membership.assigned?.zones ?? []).includes(z))) throw new HttpError(403, "Цех вам не назначен", "bad_assignment");
}
async function loadTargetRole(t: TenantCtx, roleId: string) {
  const role = await Role.findOne({ _id: roleId, restaurantId: t.restaurantId });
  if (!role) throw new HttpError(400, "Роль не найдена", "bad_role");
  if (role.key === "owner") throw new HttpError(403, "Роль владельца назначается только Super Admin", "escalation");
  assertGrantable(t, roleParams(role));
  return role;
}
const dateOrNull = z.string().datetime().nullable().optional();

r.post("/members", can("members", "create"), validate(z.object({
  email: z.string().trim().min(2).max(200).regex(/^[^\s@]+(@[^\s@]+\.[^\s@]+)?$/, "Неверный логин"), name: z.string().trim().min(2).max(100), password: z.string().max(200), roleId: z.string().length(24),
  assigned: assignedSchema.optional().default({}), accessFrom: dateOrNull, accessUntil: dateOrNull
})), wrap(async (req, res) => {
  const d = req.data; const t: TenantCtx = req.tenant;
  const prob = passwordProblem(d.password); if (prob) throw new HttpError(400, prob, "weak_password");
  const role = await loadTargetRole(t, d.roleId); await checkAssigned(t, d.assigned);
  if (await PlatformUser.exists({ email: d.email.toLowerCase() })) throw new HttpError(409, "Пользователь с таким email уже существует", "duplicate");
  const u = await PlatformUser.create({ email: d.email.toLowerCase(), name: d.name, passwordHash: await hashPassword(d.password) });
  const m = await Membership.create({ userId: u._id, restaurantId: t.restaurantId, roleId: role._id, assigned: d.assigned, accessFrom: d.accessFrom ?? null, accessUntil: d.accessUntil ?? null });
  await audit(req, { action: "member.created", entity: "member", entityId: m._id, after: { email: u.email, role: role.name, assigned: d.assigned } });
  res.status(201).json({ item: memberDto(m, u, role) });
}));

async function loadMember(req: any) {
  const t: TenantCtx = req.tenant;
  const m = await Membership.findOne({ _id: req.params.id, restaurantId: t.restaurantId });
  if (!m) throw new HttpError(404, "Сотрудник не найден", "not_found");
  const role = await Role.findOne({ _id: m.roleId, restaurantId: t.restaurantId });
  if (role?.key === "owner") throw new HttpError(403, "Владельца изменить нельзя", "owner_protected");
  if (String(m.userId) === String(req.auth.user._id)) throw new HttpError(403, "Нельзя менять собственный доступ", "self_edit");
  if (!t.isOwner && role && !isSubset(role.permissions ?? {}, t.perms)) throw new HttpError(403, "Сотрудник с более широкими правами", "escalation");
  return { m, role };
}
r.patch("/members/:id", oidParam(), can("members", "edit"), validate(z.object({
  name: z.string().trim().min(2).max(100), roleId: z.string().length(24), assigned: assignedSchema, accessFrom: dateOrNull, accessUntil: dateOrNull
}).partial().strict()), wrap(async (req, res) => {
  const t: TenantCtx = req.tenant; const d = req.data; const { m, role: oldRole } = await loadMember(req);
  const before = { roleId: String(m.roleId), assigned: m.assigned, accessFrom: m.accessFrom, accessUntil: m.accessUntil };
  let role = oldRole;
  if (d.roleId) { role = await loadTargetRole(t, d.roleId); m.roleId = role._id; }
  if (d.assigned) { await checkAssigned(t, d.assigned); m.assigned = d.assigned; }
  if (d.accessFrom !== undefined) m.accessFrom = d.accessFrom; if (d.accessUntil !== undefined) m.accessUntil = d.accessUntil;
  await m.save();
  if (d.name) await PlatformUser.updateOne({ _id: m.userId }, { name: d.name }); // имя сотрудника, созданного рестораном
  const u = await PlatformUser.findById(m.userId);
  await audit(req, { action: d.roleId || d.assigned ? "member.permissions_changed" : "member.updated", entity: "member", entityId: m._id, before, after: { roleId: String(m.roleId), assigned: m.assigned, accessFrom: m.accessFrom, accessUntil: m.accessUntil } });
  res.json({ item: memberDto(m, u, role) });
}));
for (const [path, status] of [["block", "blocked"], ["unblock", "active"]] as const) {
  r.post(`/members/:id/${path}`, oidParam(), can("members", "edit"), wrap(async (req, res) => {
    const { m } = await loadMember(req); const before = m.status; m.status = status; await m.save();
    await audit(req, { action: status === "blocked" ? "member.blocked" : "member.unblocked", entity: "member", entityId: m._id, before: { status: before }, after: { status } });
    res.json({ ok: true, status });
  }));
}
r.post("/members/:id/revoke-sessions", oidParam(), can("members", "edit"), wrap(async (req, res) => {
  const { m } = await loadMember(req);
  // отзываются только сессии, открытые в ЭТОМ ресторане: сессии пользователя в других ресторанах не затрагиваются
  const ss = await Session.find({ userId: m.userId, restaurantId: req.tenant.restaurantId, revokedAt: null }).select("_id").lean<any[]>();
  for (const s of ss) await revokeSession(s._id, "revoked_by_manager");
  await audit(req, { action: "member.sessions_revoked", entity: "member", entityId: m._id, after: { revoked: ss.length } });
  res.json({ ok: true, revoked: ss.length });
}));
r.post("/members/:id/reset-password-token", oidParam(), can("members", "edit"), wrap(async (req, res) => {
  const { m } = await loadMember(req);
  // сброс пароля разрешён только для аккаунтов, существующих исключительно в этом ресторане (иначе — захват чужого доступа)
  if ((await Membership.countDocuments({ userId: m.userId, restaurantId: { $ne: req.tenant.restaurantId } })) > 0) throw new HttpError(403, "Аккаунт используется в других ресторанах", "shared_account");
  const t = randomToken();
  await PlatformUser.updateOne({ _id: m.userId }, { resetHash: sha256(t), resetExpires: new Date(Date.now() + 30 * 60_000) });
  await audit(req, { action: "member.reset_token_issued", entity: "member", entityId: m._id });
  res.json({ token: t, expiresInMinutes: 30 });
}));
r.delete("/members/:id", oidParam(), can("members", "delete"), wrap(async (req, res) => {
  const { m } = await loadMember(req);
  const ss = await Session.find({ userId: m.userId, restaurantId: req.tenant.restaurantId, revokedAt: null }).select("_id").lean<any[]>();
  for (const s of ss) await revokeSession(s._id, "member_removed");
  await Membership.deleteOne({ restaurantId: req.tenant.restaurantId, _id: m._id }); await audit(req, { action: "member.removed", entity: "member", entityId: m._id, before: { userId: String(m.userId) } });
  res.json({ ok: true });
}));
export default r;

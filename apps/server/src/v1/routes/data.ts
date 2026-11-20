import { Router } from "express";
import { z } from "zod";
import { TCategory, TIngredient, TRecipe, TRecipeVersion, ImportJob, AuditLog, Membership, Role } from "../models.js";
import { HttpError, authenticate, tenant, can, validate, wrap, oidParam, recipeScope, categoryScope, type TenantCtx } from "../middleware.js";
import { hasPerm, ZONES } from "../permissions.js";
import { audit } from "../audit.js";
import { fmtAudit } from "./platform.js";

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const slugify = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "").slice(0, 60) || "cat";
const hideCost = (t: TenantCtx) => !t.isOwner && !!t.role.denyCost;
const noPriceEdit = (t: TenantCtx) => !t.isOwner && !!t.role.denyPurchasePriceEdit;

export function costOf(rec: any) {
  const lines = (rec.ingredients ?? []).map((i: any) => { const q = Number(i.gross ?? i.net ?? 0), p = Number(i.pricePerUnit ?? 0); return { name: i.name, unit: i.unit, quantity: q, pricePerUnit: p, total: Math.round(q * p * 100) / 100 }; });
  const total = Math.round(lines.reduce((s: number, l: any) => s + l.total, 0) * 100) / 100;
  const portions = Number(rec.portionCount ?? 0);
  return { total, perPortion: portions > 0 ? Math.round((total / portions) * 100) / 100 : null, portions: portions || null, lines, complete: lines.length > 0 && lines.every((l: any) => l.pricePerUnit > 0 && l.quantity > 0) };
}

export function recipeDto(x: any, t: TenantCtx, full = true) {
  const hide = hideCost(t);
  const base: any = { id: String(x._id), name: x.name, description: x.description, categoryId: x.categoryId ? String(x.categoryId) : null, zone: x.zone, portionCount: x.portionCount, yieldLabel: x.yieldLabel, imageUrl: x.imageUrl, status: x.status, version: x.version, updatedAt: x.updatedAt, createdAt: x.createdAt };
  if (full) {
    base.steps = x.steps ?? [];
    base.ingredients = (x.ingredients ?? []).map((i: any) => { const o: any = { name: i.name, unit: i.unit, gross: i.gross, net: i.net }; if (!hide) o.pricePerUnit = i.pricePerUnit; return o; });
    if (!hide) base.cost = costOf(x);
  }
  return base;
}

const inAssignedScope = (t: TenantCtx, d: { categoryId?: any; zone?: string }) =>
  t.role.scope === "all" || t.isOwner || (d.categoryId && (t.membership.assigned?.categoryIds ?? []).some((c: any) => String(c) === String(d.categoryId))) || (d.zone && (t.membership.assigned?.zones ?? []).includes(d.zone));

// ───────────── Категории ─────────────
export const categories = Router(); categories.use(authenticate, tenant);
const catBody = z.object({ name: z.string().trim().min(2).max(80), zone: z.enum([...ZONES, ""] as [string, ...string[]]).default(""), sortOrder: z.number().int().min(0).max(10000).default(0) });
const catDto = (x: any) => ({ id: String(x._id), name: x.name, slug: x.slug, zone: x.zone, sortOrder: x.sortOrder });
categories.get("/", can("categories", "view"), wrap(async (req, res) => {
  const items = await TCategory.find(categoryScope(req.tenant)).sort({ sortOrder: 1, name: 1 }).lean<any[]>();
  res.json({ items: items.map(catDto) });
}));
categories.post("/", can("categories", "create"), validate(catBody), wrap(async (req, res) => {
  const x = await TCategory.create({ restaurantId: req.tenant.restaurantId, ...req.data, slug: slugify(req.data.name) });
  await audit(req, { action: "category.created", entity: "category", entityId: x._id, after: catDto(x) }); res.status(201).json({ item: catDto(x) });
}));
categories.patch("/:id", oidParam(), can("categories", "edit"), validate(catBody.partial().strict()), wrap(async (req, res) => {
  const x = await TCategory.findOne({ ...categoryScope(req.tenant), _id: req.params.id }); if (!x) throw new HttpError(404, "Категория не найдена", "not_found");
  const before = catDto(x); x.set(req.data); if (req.data.name) x.slug = slugify(req.data.name); await x.save();
  await audit(req, { action: "category.updated", entity: "category", entityId: x._id, before, after: catDto(x) }); res.json({ item: catDto(x) });
}));
categories.delete("/:id", oidParam(), can("categories", "delete"), wrap(async (req, res) => {
  const x = await TCategory.findOne({ ...categoryScope(req.tenant), _id: req.params.id }); if (!x) throw new HttpError(404, "Категория не найдена", "not_found");
  if (await TRecipe.exists({ restaurantId: req.tenant.restaurantId, categoryId: x._id })) throw new HttpError(409, "В категории есть карточки", "in_use");
  await TCategory.deleteOne({ restaurantId: req.tenant.restaurantId, _id: x._id }); await audit(req, { action: "category.deleted", entity: "category", entityId: x._id, before: catDto(x) }); res.json({ ok: true });
}));

// ───────────── Ингредиенты ─────────────
export const ingredients = Router(); ingredients.use(authenticate, tenant);
const ingBody = z.object({ name: z.string().trim().min(1).max(120), unit: z.enum(["kg", "g", "l", "ml", "pcs"]).default("kg"), pricePerUnit: z.number().min(0).max(1e9).default(0), semiFinished: z.boolean().default(false) });
const ingDto = (x: any, t: TenantCtx) => ({ id: String(x._id), name: x.name, unit: x.unit, semiFinished: x.semiFinished, ...(hideCost(t) ? {} : { pricePerUnit: x.pricePerUnit }) });
ingredients.get("/", can("ingredients", "view"), wrap(async (req, res) => {
  const q: any = { restaurantId: req.tenant.restaurantId }; if (req.query.q) q.name = new RegExp(esc(String(req.query.q).slice(0, 60)), "i");
  const items = await TIngredient.find(q).sort({ name: 1 }).limit(1000).lean<any[]>();
  res.json({ items: items.map((x) => ingDto(x, req.tenant)) });
}));
ingredients.post("/", can("ingredients", "create"), validate(ingBody), wrap(async (req, res) => {
  const d = { ...req.data }; if (noPriceEdit(req.tenant)) d.pricePerUnit = 0;
  const x = await TIngredient.create({ restaurantId: req.tenant.restaurantId, ...d });
  await audit(req, { action: "ingredient.created", entity: "ingredient", entityId: x._id, after: { name: x.name, pricePerUnit: x.pricePerUnit } }); res.status(201).json({ item: ingDto(x, req.tenant) });
}));
ingredients.patch("/:id", oidParam(), can("ingredients", "edit"), validate(ingBody.partial().strict()), wrap(async (req, res) => {
  const x = await TIngredient.findOne({ restaurantId: req.tenant.restaurantId, _id: req.params.id }); if (!x) throw new HttpError(404, "Ингредиент не найден", "not_found");
  if (req.data.pricePerUnit !== undefined && req.data.pricePerUnit !== x.pricePerUnit && noPriceEdit(req.tenant)) throw new HttpError(403, "Изменение закупочных цен запрещено", "price_edit_denied");
  const before = { name: x.name, pricePerUnit: x.pricePerUnit }; x.set(req.data); await x.save();
  await audit(req, { action: before.pricePerUnit !== x.pricePerUnit ? "ingredient.price_changed" : "ingredient.updated", entity: "ingredient", entityId: x._id, before, after: { name: x.name, pricePerUnit: x.pricePerUnit } });
  res.json({ item: ingDto(x, req.tenant) });
}));
ingredients.delete("/:id", oidParam(), can("ingredients", "delete"), wrap(async (req, res) => {
  const x = await TIngredient.findOneAndDelete({ restaurantId: req.tenant.restaurantId, _id: req.params.id }); if (!x) throw new HttpError(404, "Ингредиент не найден", "not_found");
  await audit(req, { action: "ingredient.deleted", entity: "ingredient", entityId: x._id, before: { name: x.name } }); res.json({ ok: true });
}));

// ───────────── Технологические карты ─────────────
export const recipes = Router(); recipes.use(authenticate, tenant);
const line = z.object({ name: z.string().trim().min(1).max(120), unit: z.enum(["kg", "g", "l", "ml", "pcs"]).default("g"), gross: z.number().min(0).optional(), net: z.number().min(0).optional(), pricePerUnit: z.number().min(0).max(1e9).optional() });
const recipeBody = z.object({
  name: z.string().trim().min(2).max(160), description: z.string().max(2000).default(""), categoryId: z.string().length(24).nullable().default(null),
  zone: z.enum([...ZONES, ""] as [string, ...string[]]).default(""), portionCount: z.number().min(0).max(100000).default(0), yieldLabel: z.string().max(80).default(""),
  imageUrl: z.string().max(1000).default(""), ingredients: z.array(line).max(200).default([]),
  steps: z.array(z.object({ text: z.string().trim().min(1).max(2000), durationMinutes: z.number().min(0).optional() })).max(100).default([]),
  status: z.enum(["draft", "published", "archived"]).default("draft")
});

async function checkCategory(t: TenantCtx, id: string | null) {
  if (id && !(await TCategory.exists({ restaurantId: t.restaurantId, _id: id }))) throw new HttpError(400, "Категория не найдена", "bad_category");
}
/** цены: без права править закупочные цены сервер сам подставляет сохранённые (по названию) или цену из каталога */
async function applyPrices(t: TenantCtx, lines: any[], existing?: any[]) {
  if (!noPriceEdit(t)) return lines;
  const cat = await TIngredient.find({ restaurantId: t.restaurantId, name: { $in: lines.map((l) => l.name) } }).lean<any[]>();
  return lines.map((l) => ({ ...l, pricePerUnit: existing?.find((e) => e.name === l.name)?.pricePerUnit ?? cat.find((c) => c.name === l.name)?.pricePerUnit ?? 0 }));
}
function checkStatus(t: TenantCtx, from: string | null, to: string) {
  if (to === from) return;
  if (to === "published" && !hasPerm(t.perms, "recipes", "publish")) throw new HttpError(403, "Нет права публикации", "forbidden");
  if (to === "archived" && !hasPerm(t.perms, "recipes", "archive")) throw new HttpError(403, "Нет права архивирования", "forbidden");
}

recipes.get("/", can("recipes", "view"), wrap(async (req, res) => {
  const t: TenantCtx = req.tenant; const q: any = recipeScope(t);
  const f = req.query as any;
  if (f.q) q.name = new RegExp(esc(String(f.q).slice(0, 60)), "i");
  if (f.categoryId && /^[a-f0-9]{24}$/.test(f.categoryId)) q.categoryId = f.categoryId;
  if (f.zone && (ZONES as readonly string[]).includes(f.zone)) q.zone = f.zone;
  if (f.status && ["draft", "published", "archived"].includes(f.status) && (!q.status || q.status === f.status)) q.status = f.status;
  const limit = Math.min(Number(f.limit) || 200, 500), skip = Math.max(Number(f.skip) || 0, 0);
  const [items, total] = await Promise.all([TRecipe.find(q).sort({ updatedAt: -1 }).skip(skip).limit(limit).lean<any[]>(), TRecipe.countDocuments(q)]);
  res.json({ items: items.map((x) => recipeDto(x, t, f.full === "1")), total });
}));
recipes.get("/export", can("recipes", "export"), wrap(async (req, res) => {
  const items = await TRecipe.find(recipeScope(req.tenant)).sort({ name: 1 }).limit(2000).lean<any[]>();
  await audit(req, { action: "recipe.exported", entity: "recipe", after: { count: items.length } });
  res.json({ items: items.map((x) => recipeDto(x, req.tenant)) });
}));
// повторная серверная проверка доступа при открытии карточки: недоступная карточка → 404 (существование не раскрывается)
recipes.get("/:id", oidParam(), can("recipes", "view"), wrap(async (req, res) => {
  const x = await TRecipe.findOne({ ...recipeScope(req.tenant), _id: req.params.id }).lean<any>(); if (!x) throw new HttpError(404, "Карточка не найдена", "not_found");
  res.json({ item: recipeDto(x, req.tenant) });
}));
recipes.post("/", can("recipes", "create"), validate(recipeBody), wrap(async (req, res) => {
  const t: TenantCtx = req.tenant; const d = req.data;
  await checkCategory(t, d.categoryId); checkStatus(t, null, d.status);
  if (!inAssignedScope(t, d)) throw new HttpError(403, "Категория/цех вам не назначены", "out_of_scope");
  const x = await TRecipe.create({ ...d, ingredients: await applyPrices(t, d.ingredients), restaurantId: t.restaurantId, createdBy: req.auth.user._id, updatedBy: req.auth.user._id });
  await TRecipeVersion.create({ restaurantId: t.restaurantId, recipeId: x._id, version: 1, snapshot: x.toObject(), changedBy: req.auth.user._id });
  await audit(req, { action: "recipe.created", entity: "recipe", entityId: x._id, after: { name: x.name, status: x.status, categoryId: x.categoryId } });
  res.status(201).json({ item: recipeDto(x, t) });
}));
recipes.patch("/:id", oidParam(), can("recipes", "edit"), validate(recipeBody.partial().strict()), wrap(async (req, res) => {
  const t: TenantCtx = req.tenant; const d = req.data;
  const x = await TRecipe.findOne({ ...recipeScope(t), _id: req.params.id }); if (!x) throw new HttpError(404, "Карточка не найдена", "not_found");
  if (d.categoryId !== undefined) await checkCategory(t, d.categoryId);
  if (d.status) checkStatus(t, x.status, d.status);
  if (d.categoryId !== undefined || d.zone !== undefined) {
    const nxt = { categoryId: d.categoryId !== undefined ? d.categoryId : x.categoryId, zone: d.zone ?? x.zone };
    const wasReachableByRecipeId = (t.membership.assigned?.recipeIds ?? []).some((i: any) => String(i) === String(x._id));
    if (!inAssignedScope(t, nxt) && !wasReachableByRecipeId) throw new HttpError(403, "Категория/цех вам не назначены", "out_of_scope");
  }
  const beforeCost = costOf(x).total, before = { name: x.name, status: x.status, categoryId: x.categoryId };
  await TRecipeVersion.updateOne({ restaurantId: t.restaurantId, recipeId: x._id, version: x.version }, { $setOnInsert: { snapshot: x.toObject(), changedBy: req.auth.user._id } }, { upsert: true });
  const ing = d.ingredients ? await applyPrices(t, d.ingredients, x.ingredients) : undefined;
  x.set({ ...d, ...(ing ? { ingredients: ing } : {}), updatedBy: req.auth.user._id }); x.version += 1; await x.save();
  await TRecipeVersion.create({ restaurantId: t.restaurantId, recipeId: x._id, version: x.version, snapshot: x.toObject(), changedBy: req.auth.user._id }).catch(() => {});
  await audit(req, { action: d.status && d.status !== before.status ? `recipe.${d.status}` : "recipe.updated", entity: "recipe", entityId: x._id, before, after: { name: x.name, status: x.status, categoryId: x.categoryId } });
  const afterCost = costOf(x).total;
  if (afterCost !== beforeCost) await audit(req, { action: "recipe.cost_changed", entity: "recipe", entityId: x._id, before: { total: beforeCost }, after: { total: afterCost } });
  res.json({ item: recipeDto(x, t) });
}));
for (const [path, status, perm] of [["publish", "published", "publish"], ["archive", "archived", "archive"]] as const) {
  recipes.post(`/:id/${path}`, oidParam(), can("recipes", perm), wrap(async (req, res) => {
    const x = await TRecipe.findOne({ ...recipeScope(req.tenant), _id: req.params.id }); if (!x) throw new HttpError(404, "Карточка не найдена", "not_found");
    const before = x.status; x.status = status; x.updatedBy = req.auth.user._id; x.version += 1; await x.save();
    await audit(req, { action: `recipe.${status}`, entity: "recipe", entityId: x._id, before: { status: before }, after: { status } });
    res.json({ item: recipeDto(x, req.tenant) });
  }));
}
recipes.post("/:id/duplicate", oidParam(), can("recipes", "create"), wrap(async (req, res) => {
  const t: TenantCtx = req.tenant;
  const x = await TRecipe.findOne({ ...recipeScope(t), _id: req.params.id }).lean<any>(); if (!x) throw new HttpError(404, "Карточка не найдена", "not_found");
  const { _id, createdAt, updatedAt, __v, ...rest } = x;
  const c = await TRecipe.create({ ...rest, name: `${x.name} (копия)`.slice(0, 160), status: "draft", version: 1, createdBy: req.auth.user._id, updatedBy: req.auth.user._id });
  await audit(req, { action: "recipe.duplicated", entity: "recipe", entityId: c._id, before: { sourceId: String(x._id) } });
  res.status(201).json({ item: recipeDto(c, t) });
}));
recipes.delete("/:id", oidParam(), can("recipes", "delete"), wrap(async (req, res) => {
  const t: TenantCtx = req.tenant;
  const x = await TRecipe.findOne({ ...recipeScope(t), _id: req.params.id }); if (!x) throw new HttpError(404, "Карточка не найдена", "not_found");
  await TRecipe.deleteOne({ restaurantId: t.restaurantId, _id: x._id }); await TRecipeVersion.deleteMany({ restaurantId: t.restaurantId, recipeId: x._id });
  await Membership.updateMany({ restaurantId: t.restaurantId }, { $pull: { "assigned.recipeIds": x._id } });
  await audit(req, { action: "recipe.deleted", entity: "recipe", entityId: x._id, before: { name: x.name, status: x.status } });
  res.json({ ok: true });
}));
recipes.get("/:id/versions", oidParam(), can("recipes", "edit"), wrap(async (req, res) => {
  const x = await TRecipe.findOne({ ...recipeScope(req.tenant), _id: req.params.id }).select("_id"); if (!x) throw new HttpError(404, "Карточка не найдена", "not_found");
  const items = await TRecipeVersion.find({ restaurantId: req.tenant.restaurantId, recipeId: x._id }).sort({ version: -1 }).limit(50).lean<any[]>();
  res.json({ items: items.map((v) => ({ version: v.version, createdAt: v.createdAt, changedBy: v.changedBy ? String(v.changedBy) : null, name: v.snapshot?.name })) });
}));

// ───────────── Калькуляции ─────────────
export const calculations = Router(); calculations.use(authenticate, tenant, can("calculations", "view"), (req: any, _res, next) => hideCost(req.tenant) ? next(new HttpError(403, "Себестоимость скрыта для вашей роли", "cost_hidden")) : next());
calculations.get("/", wrap(async (req, res) => {
  const items = await TRecipe.find({ ...recipeScope(req.tenant), status: { $ne: "archived" } }).sort({ name: 1 }).limit(1000).lean<any[]>();
  const rows = items.map((x) => { const c = costOf(x); return { id: String(x._id), name: x.name, total: c.total, perPortion: c.perPortion, complete: c.complete }; });
  const priced = rows.filter((r) => r.complete);
  res.json({ items: rows, summary: { count: rows.length, complete: priced.length, avgTotal: priced.length ? Math.round(priced.reduce((s, r) => s + r.total, 0) / priced.length * 100) / 100 : 0, currency: req.tenant.restaurant.currency } });
}));
calculations.get("/:id", oidParam(), wrap(async (req, res) => {
  const x = await TRecipe.findOne({ ...recipeScope(req.tenant), _id: req.params.id }).lean<any>(); if (!x) throw new HttpError(404, "Карточка не найдена", "not_found");
  res.json({ item: { id: String(x._id), name: x.name, ...costOf(x), currency: req.tenant.restaurant.currency } });
}));

// ───────────── Импорт ─────────────
export const imports = Router(); imports.use(authenticate, tenant);
imports.get("/", can("imports", "view"), wrap(async (req, res) => {
  const items = await ImportJob.find({ restaurantId: req.tenant.restaurantId }).sort({ createdAt: -1 }).limit(50).lean<any[]>();
  res.json({ items: items.map((j) => ({ id: String(j._id), status: j.status, total: j.total, created: j.created, failed: j.failed, errors: j.errors, createdAt: j.createdAt })) });
}));
/** Пакетный импорт карточек (JSON из сканера/файла). Всегда создаёт черновики — публикация отдельным правом. */
imports.post("/", can("imports", "import"), validate(z.object({ recipes: z.array(recipeBody.partial({ description: true, categoryId: true, zone: true, portionCount: true, yieldLabel: true, imageUrl: true, ingredients: true, steps: true, status: true })).min(1).max(200) })), wrap(async (req, res) => {
  const t: TenantCtx = req.tenant; let created = 0; const errors: string[] = [];
  for (const [i, d] of (req.data.recipes as any[]).entries()) {
    try {
      await checkCategory(t, d.categoryId ?? null);
      if (!inAssignedScope(t, d)) throw new Error("вне назначенных категорий/цехов");
      const x = await TRecipe.create({ ...d, status: "draft", ingredients: await applyPrices(t, d.ingredients ?? []), restaurantId: t.restaurantId, createdBy: req.auth.user._id, updatedBy: req.auth.user._id });
      await TRecipeVersion.create({ restaurantId: t.restaurantId, recipeId: x._id, version: 1, snapshot: x.toObject(), changedBy: req.auth.user._id });
      created++;
    } catch (e: any) { errors.push(`#${i + 1} ${d.name ?? ""}: ${e.message}`.slice(0, 200)); }
  }
  const job = await ImportJob.create({ restaurantId: t.restaurantId, createdBy: req.auth.user._id, total: req.data.recipes.length, created, failed: errors.length, errors: errors.slice(0, 50), status: errors.length ? (created ? "partial" : "failed") : "done" });
  await audit(req, { action: "import.recipes", entity: "import", entityId: job._id, after: { total: job.total, created, failed: errors.length } });
  res.status(201).json({ id: String(job._id), created, failed: errors.length, errors });
}));

// ───────────── Audit + Dashboard ─────────────
export const auditRoutes = Router(); auditRoutes.use(authenticate, tenant, can("audit", "view"));
auditRoutes.get("/", wrap(async (req, res) => {
  const q: any = { restaurantId: req.tenant.restaurantId };
  if (req.query.action) q.action = new RegExp("^" + String(req.query.action).replace(/[^\w.]/g, ""));
  const items = await AuditLog.find(q).sort({ at: -1 }).limit(Math.min(Number(req.query.limit) || 100, 500)).lean<any[]>();
  res.json({ items: items.map(fmtAudit) });
}));

export const dashboard = Router(); dashboard.use(authenticate, tenant, can("dashboard", "view"));
dashboard.get("/", wrap(async (req, res) => {
  const t: TenantCtx = req.tenant; const rid = t.restaurantId;
  const [recipesTotal, published, drafts, categoriesTotal, members, last] = await Promise.all([
    TRecipe.countDocuments(recipeScope(t)), TRecipe.countDocuments({ ...recipeScope(t), status: "published" }), TRecipe.countDocuments({ ...recipeScope(t), status: "draft" }),
    TCategory.countDocuments(categoryScope(t)), hasPerm(t.perms, "members", "view") ? Membership.countDocuments({ restaurantId: rid }) : Promise.resolve(null),
    hasPerm(t.perms, "audit", "view") ? AuditLog.find({ restaurantId: rid }).sort({ at: -1 }).limit(8).lean<any[]>() : Promise.resolve(null)
  ]);
  let calc = null;
  if (hasPerm(t.perms, "calculations", "view") && !hideCost(t)) {
    const rs = await TRecipe.find({ ...recipeScope(t), status: { $ne: "archived" } }).limit(1000).lean<any[]>();
    const c = rs.map(costOf); calc = { total: c.length, complete: c.filter((x) => x.complete).length };
  }
  res.json({ recipes: { total: recipesTotal, published, drafts }, categories: categoriesTotal, members, calculations: calc, recent: last?.map(fmtAudit) ?? null });
}));

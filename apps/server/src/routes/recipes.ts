import { Router } from "express";
import { bumpRecipesVersion, cached } from "../services/cache.js";
import { z } from "zod";
import { Recipe } from "../models/Recipe.js";
import { RecipeVersion } from "../models/RecipeVersion.js";
import { scoreRecipeSearch } from "../services/smartSearch.js";
import { requireAuth, requireRoles, optionalAuth, type AuthRequest } from "../middleware/auth.js";
import { inferDepartmentSection } from "../data/kitchenTaxonomy.js";

const router = Router();

// любое успешное изменение рецептов сбрасывает кэш списков и sync
router.use((req, res, next) => {
  if (req.method !== "GET") res.on("finish", () => { if (res.statusCode < 400) void bumpRecipesVersion(); });
  next();
});

const ingredient = z.object({
  name: z.string().trim().min(1).max(120),
  unit: z.enum(["kg", "g", "l", "ml", "pcs"]).default("g"),
  gross: z.number().min(0).optional(),
  net: z.number().min(0).optional(),
  pricePerUnit: z.number().min(0).optional(),
  amount: z.string().max(60).optional()
});

const step = z.object({
  text: z.string().trim().min(1).max(2000),
  durationMinutes: z.number().min(0).optional(),
  imageUrl: z.string().url().max(1000).optional().or(z.literal(""))
});

const recipeSchema = z.object({
  name: z.string().trim().min(2).max(160),
  description: z.string().max(2000).optional().default(""),
  imageUrl: z.string().url().max(1000).optional().or(z.literal("")),
  category: z.string().trim().min(2).max(80),
  department: z.string().trim().max(80).optional().default(""),
  section: z.string().trim().max(80).optional().default(""),
  yieldLabel: z.string().max(80).optional().default(""),
  yieldQuantity: z.number().min(0).optional(),
  yieldUnit: z.enum(["kg", "g", "l", "ml", "pcs"]).optional().default("kg"),
  portionCount: z.number().min(0).optional(),
  ingredients: z.array(ingredient).max(200).optional().default([]),
  steps: z.array(step).max(100).optional().default([]),
  aliases: z.array(z.string().trim().min(1).max(100)).max(30).optional().default([]),
  status: z.enum(["draft", "published", "archived"]).optional().default("draft"),
  sourceDocumentUrl: z.string().url().max(1000).optional().or(z.literal("")),
  sourceDocumentType: z.enum(["pdf", "image", "manual", ""]).optional()
});

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function toRecipe(item: any) {
  return {
    id: String(item._id),
    name: item.name,
    description: item.description ?? "",
    category: item.category,
    department: item.department ?? "",
    section: item.section ?? "",
    yieldLabel: item.yieldLabel ?? "",
    imageUrl: item.imageUrl ?? "",
    yieldQuantity: item.yieldQuantity ?? null,
    yieldUnit: item.yieldUnit ?? "kg",
    portionCount: item.portionCount ?? null,
    ingredients: item.ingredients ?? [],
    steps: item.steps ?? [],
    aliases: item.aliases ?? [],
    status: item.status,
    version: item.version ?? 1,
    sourceDocumentUrl: item.sourceDocumentUrl ?? "",
    sourceDocumentType: item.sourceDocumentType ?? "manual",
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    cost: calculateRecipeCost(item),
    costCurrency: process.env.COST_CURRENCY || "UZS"
  };
}

function calculateRecipeCost(item: any) {
  const lines = (item.ingredients ?? []).map((ingredient: any) => {
    const quantity = Number(ingredient.gross ?? ingredient.net ?? 0);
    const price = Number(ingredient.pricePerUnit ?? 0);
    return {
      name: ingredient.name,
      quantity,
      unit: ingredient.unit,
      pricePerUnit: price,
      total: quantity * price
    };
  });
  const total = lines.reduce((sum: number, line: any) => sum + line.total, 0);
  const portions = Number(item.portionCount ?? 0);
  return {
    total: Math.round(total * 100) / 100,
    perPortion: portions > 0 ? Math.round((total / portions) * 100) / 100 : null,
    portions: portions || null,
    lines,
    complete: lines.length > 0 && lines.every((line: any) => line.pricePerUnit > 0 && line.quantity > 0)
  };
}

function detectChangedFields(before: any, after: any): string[] {
  const fields = [
    "name", "description", "category", "yieldLabel", "yieldQuantity", "yieldUnit",
    "portionCount", "status", "imageUrl", "ingredients", "steps", "aliases"
  ];
  const changed: string[] = [];
  for (const f of fields) {
    const a = JSON.stringify(before?.[f] ?? null);
    const b = JSON.stringify(after?.[f] ?? null);
    if (a !== b) changed.push(f);
  }
  return changed;
}

// ─── List ───────────────────────────────────────────────────────────────────
router.get("/", optionalAuth, async (req: AuthRequest, res, next) => {
  try {
    const q = String(req.query.q ?? "").trim();
    const category = String(req.query.category ?? "").trim();
    const status = String(req.query.status ?? "").trim();
    const filter: Record<string, unknown> = {};

    if (q) {
      filter.$or = [
        { name: { $regex: escapeRegex(q), $options: "i" } },
        { aliases: { $regex: escapeRegex(q), $options: "i" } },
        { "ingredients.name": { $regex: escapeRegex(q), $options: "i" } }
      ];
    }
    if (category) filter.category = category;
    const department = String(req.query.department ?? "").trim();
    const section = String(req.query.section ?? "").trim();
    if (department) filter.department = department;
    if (section) filter.section = section;
    if (status && ["draft", "published", "archived"].includes(status)) {
      filter.status = status;
    } else if (req.user?.role !== "admin" && req.user?.role !== "manager") {
      filter.status = "published";
    }

    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));

    const load = async () => {
      const [items, total] = await Promise.all([
        Recipe.find(filter).sort({ updatedAt: -1 }).skip((page - 1) * limit).limit(limit).lean<any[]>(),
        Recipe.countDocuments(filter)
      ]);
      return { items: items.map(toRecipe), page, limit, total };
    };
    // Публичные списки кэшируются в Redis на 60 с; для admin/manager (видят черновики) кэша нет
    const isStaff = req.user?.role === "admin" || req.user?.role === "manager";
    if (isStaff) return res.json(await load());
    const { value, hit } = await cached(`recipes:list:${req.originalUrl}`, 60, load);
    res.setHeader("X-Cache", hit ? "HIT" : "MISS");
    res.json(value);
  } catch (e) {
    next(e);
  }
});

// ─── Smart search ───────────────────────────────────────────────────────────
router.get("/smart-search", optionalAuth, async (req: AuthRequest, res, next) => {
  try {
    const q = String(req.query.q ?? "").trim().slice(0, 100);
    if (!q) return res.json({ items: [], query: q, total: 0 });

    const filter: Record<string, unknown> = {};
    if (req.user?.role !== "admin" && req.user?.role !== "manager") {
      filter.status = "published";
    }

    const candidates = await Recipe.find(filter)
      .select("name description category aliases ingredients status createdAt updatedAt yieldLabel steps version")
      .sort({ updatedAt: -1 })
      .limit(1000)
      .lean<any[]>();

    const items = candidates
      .map(item => ({ item, score: scoreRecipeSearch(q, item as any) }))
      .filter(result => result.score > 0)
      .sort((a, b) => b.score - a.score || String(b.item.updatedAt).localeCompare(String(a.item.updatedAt)))
      .slice(0, Math.min(50, Math.max(1, Number(req.query.limit) || 20)))
      .map(result => ({ ...toRecipe(result.item), relevance: result.score }));

    res.json({ items, query: q, total: items.length });
  } catch (e) {
    next(e);
  }
});

// ─── Import draft (must be before /:id routes) ──────────────────────────────
const importSchema = z.object({
  name: z.string().trim().min(2).max(160),
  category: z.string().trim().min(2).max(80).default("Без категории"),
  description: z.string().max(2000).optional().default(""),
  yieldLabel: z.string().max(80).optional().default(""),
  ingredients: z.array(ingredient).max(200).optional().default([]),
  steps: z.array(step).max(100).optional().default([]),
  aliases: z.array(z.string().trim().min(1).max(100)).max(30).optional().default([]),
  sourceDocumentUrl: z.string().url().max(1000).optional().or(z.literal("")),
  sourceDocumentType: z.enum(["pdf", "image", "manual"]).optional().default("image")
});

router.post("/import-draft", requireAuth, requireRoles("admin", "manager"), async (req: AuthRequest, res, next) => {
  try {
    const parsed = importSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Некорректные данные импорта", details: parsed.error.flatten() });
    }
    // Always created as draft — never auto-publish (TZ requirement)
    const item = await Recipe.create({
      ...parsed.data,
      status: "draft",
      version: 1,
      createdBy: req.user!.sub,
      updatedBy: req.user!.sub
    });
    res.status(201).json({
      item: toRecipe(item.toObject()),
      message: "Черновик создан. Проверьте данные перед публикацией."
    });
  } catch (e) {
    next(e);
  }
});

// ─── Get one ────────────────────────────────────────────────────────────────
router.get("/:id", optionalAuth, async (req: AuthRequest, res, next) => {
  try {
    const item = await Recipe.findById(req.params.id).lean<any>();
    if (!item || (item.status !== "published" && req.user?.role !== "admin" && req.user?.role !== "manager")) {
      return res.status(404).json({ error: "Карта не найдена" });
    }
    res.json({ item: toRecipe(item) });
  } catch (e) {
    next(e);
  }
});

// ─── Create ─────────────────────────────────────────────────────────────────
router.post("/", requireAuth, requireRoles("admin", "manager"), async (req: AuthRequest, res, next) => {
  try {
    const parsed = recipeSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Некорректные данные карты", details: parsed.error.flatten() });
    }
    const data = { ...parsed.data };
    if (!data.department || !data.section) {
      const inferred = inferDepartmentSection(data.category || data.section || "");
      data.department = data.department || inferred.department;
      data.section = data.section || inferred.section;
    }
    const item = await Recipe.create({
      ...data,
      version: 1,
      createdBy: req.user!.sub,
      updatedBy: req.user!.sub
    });
    res.status(201).json({ item: toRecipe(item.toObject()) });
  } catch (e) {
    next(e);
  }
});

// ─── Update (with automatic version snapshot) ───────────────────────────────
router.patch("/:id", requireAuth, requireRoles("admin", "manager"), async (req: AuthRequest, res, next) => {
  try {
    const parsed = recipeSchema.partial().safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Некорректные данные карты", details: parsed.error.flatten() });
    }

    const existing = await Recipe.findById(req.params.id).lean<any>();
    if (!existing) return res.status(404).json({ error: "Карта не найдена" });

    const nextVersion = (existing.version ?? 1) + 1;
    const changedFields = detectChangedFields(existing, { ...existing, ...parsed.data });

    if (changedFields.length > 0) {
      await RecipeVersion.create({
        recipeId: existing._id,
        version: existing.version ?? 1,
        snapshot: existing,
        changedBy: req.user!.sub,
        changeNote: req.body.changeNote || "",
        changedFields
      });
    }

    const item = await Recipe.findByIdAndUpdate(
      req.params.id,
      { ...parsed.data, version: nextVersion, updatedBy: req.user!.sub },
      { new: true, runValidators: true }
    ).lean<any>();

    if (!item) return res.status(404).json({ error: "Карта не найдена" });
    res.json({ item: toRecipe(item) });
  } catch (e) {
    next(e);
  }
});

// ─── Soft delete (archive) ──────────────────────────────────────────────────
router.delete("/:id", requireAuth, requireRoles("admin"), async (req, res, next) => {
  try {
    const item = await Recipe.findByIdAndUpdate(req.params.id, { status: "archived" }, { new: true }).lean<any>();
    if (!item) return res.status(404).json({ error: "Карта не найдена" });
    res.json({ item: toRecipe(item) });
  } catch (e) {
    next(e);
  }
});

// ─── Version history ────────────────────────────────────────────────────────
router.get("/:id/history", requireAuth, requireRoles("admin", "manager"), async (req, res, next) => {
  try {
    const recipeId = req.params.id;
    const recipe = await Recipe.findById(recipeId).select("_id name version").lean<any>();
    if (!recipe) return res.status(404).json({ error: "Карта не найдена" });

    const versions = await RecipeVersion.find({ recipeId })
      .sort({ version: -1 })
      .limit(50)
      .select("version changedFields changeNote changedBy createdAt")
      .lean<any[]>();

    res.json({
      recipeId,
      currentVersion: recipe.version ?? 1,
      history: versions.map(v => ({
        version: v.version,
        changedFields: v.changedFields,
        changeNote: v.changeNote,
        changedBy: v.changedBy,
        createdAt: v.createdAt
      }))
    });
  } catch (e) {
    next(e);
  }
});

// ─── Get specific version snapshot ──────────────────────────────────────────
router.get("/:id/history/:version", requireAuth, requireRoles("admin", "manager"), async (req, res, next) => {
  try {
    const versionNum = Number(req.params.version);
    if (!Number.isFinite(versionNum) || versionNum < 1) {
      return res.status(400).json({ error: "Некорректный номер версии" });
    }

    const doc = await RecipeVersion.findOne({
      recipeId: req.params.id,
      version: versionNum
    }).lean<any>();

    if (!doc) return res.status(404).json({ error: "Версия не найдена" });
    res.json({ version: doc.version, snapshot: toRecipe(doc.snapshot), createdAt: doc.createdAt });
  } catch (e) {
    next(e);
  }
});

// ─── Restore a previous version ─────────────────────────────────────────────
router.post("/:id/restore/:version", requireAuth, requireRoles("admin"), async (req: AuthRequest, res, next) => {
  try {
    const versionNum = Number(req.params.version);
    if (!Number.isFinite(versionNum) || versionNum < 1) {
      return res.status(400).json({ error: "Некорректный номер версии" });
    }

    const existing = await Recipe.findById(req.params.id).lean<any>();
    if (!existing) return res.status(404).json({ error: "Карта не найдена" });

    const historyDoc = await RecipeVersion.findOne({
      recipeId: req.params.id,
      version: versionNum
    }).lean<any>();

    if (!historyDoc) return res.status(404).json({ error: "Версия не найдена" });

    await RecipeVersion.create({
      recipeId: existing._id,
      version: existing.version ?? 1,
      snapshot: existing,
      changedBy: req.user!.sub,
      changeNote: `Восстановление версии ${versionNum}`,
      changedFields: ["restore"]
    });

    const snap = historyDoc.snapshot as any;
    const nextVersion = (existing.version ?? 1) + 1;

    const updated = await Recipe.findByIdAndUpdate(
      req.params.id,
      {
        name: snap.name,
        description: snap.description,
        category: snap.category,
        yieldLabel: snap.yieldLabel,
        yieldQuantity: snap.yieldQuantity,
        yieldUnit: snap.yieldUnit,
        portionCount: snap.portionCount,
        ingredients: snap.ingredients,
        steps: snap.steps,
        aliases: snap.aliases,
        imageUrl: snap.imageUrl,
        status: snap.status,
        version: nextVersion,
        updatedBy: req.user!.sub
      },
      { new: true, runValidators: true }
    ).lean<any>();

    res.json({ item: toRecipe(updated), restoredFrom: versionNum });
  } catch (e) {
    next(e);
  }
});

export default router;

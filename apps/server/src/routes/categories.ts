import { Router } from "express";
import { z } from "zod";
import { Category } from "../models/Category.js";
import { requireAuth, requireRoles } from "../middleware/auth.js";
import { KITCHEN_DEPARTMENTS } from "../data/kitchenTaxonomy.js";

const router = Router();
const schema = z.object({
  name: z.string().trim().min(2).max(80),
  department: z.string().trim().max(80).optional().nullable(),
  sortOrder: z.number().optional(),
  icon: z.string().optional()
});

/** Built-in kitchen structure (цеха + участки) — always available */
router.get("/taxonomy", (_req, res) => {
  res.json({
    departments: KITCHEN_DEPARTMENTS.map(d => ({
      name: d.name,
      slug: d.slug,
      icon: d.icon,
      sections: d.sections.map(s => ({ name: s.name, slug: s.slug, icon: s.icon }))
    }))
  });
});

router.get("/", async (_req, res, next) => {
  try {
    const categories = await Category.find({ active: { $ne: false } }).sort({ sortOrder: 1, name: 1 }).lean<any[]>();
    res.json({
      items: categories.map(c => ({
        id: String(c._id),
        name: c.name,
        slug: c.slug,
        department: c.department ?? null,
        sortOrder: c.sortOrder ?? 0,
        icon: c.icon,
        createdAt: c.createdAt
      })),
      taxonomy: KITCHEN_DEPARTMENTS
    });
  } catch (e) {
    next(e);
  }
});

router.post("/", requireAuth, requireRoles("admin", "manager"), async (req, res, next) => {
  try {
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Название категории должно содержать от 2 до 80 символов" });
    }
    const slug = parsed.data.name
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-zа-я0-9]+/gi, "-")
      .replace(/^-|-$/g, "");
    const item = await Category.create({
      name: parsed.data.name,
      slug,
      department: parsed.data.department ?? null,
      sortOrder: parsed.data.sortOrder ?? 0,
      icon: parsed.data.icon || "utensils"
    });
    res.status(201).json({
      item: {
        id: String(item._id),
        name: item.name,
        slug: item.slug,
        department: item.department
      }
    });
  } catch (e: any) {
    if (e?.code === 11000) return res.status(409).json({ error: "Такая категория уже существует" });
    next(e);
  }
});

router.delete("/:id", requireAuth, requireRoles("admin"), async (req, res, next) => {
  try {
    const item = await Category.findByIdAndDelete(req.params.id);
    if (!item) return res.status(404).json({ error: "Категория не найдена" });
    res.json({ success: true });
  } catch (e) {
    next(e);
  }
});

export default router;

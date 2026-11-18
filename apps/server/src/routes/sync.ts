import { Router } from "express";
import { Recipe } from "../models/Recipe.js";
import { cached } from "../services/cache.js";
import { toRecipe } from "./recipes.js";

const router = Router();

/**
 * GET /api/sync/recipes?since=ISO-дата
 * Для офлайн-клиентов: без `since` — полный набор опубликованных карточек;
 * с `since` — только изменённые после этой даты + id карточек, которые убраны (архив/черновик).
 * Ответ содержит serverTime — его клиент сохраняет и передаёт в следующий раз.
 */
router.get("/recipes", async (req, res, next) => {
  try {
    const sinceRaw = String(req.query.since ?? "");
    const since = sinceRaw ? new Date(sinceRaw) : null;
    if (since && Number.isNaN(since.getTime())) return res.status(400).json({ error: "Некорректная дата since" });
    const serverTime = new Date().toISOString();
    const { value, hit } = await cached(`sync:${since ? since.toISOString() : "full"}`, 30, async () => {
      if (!since) {
        const items = await Recipe.find({ status: "published" }).sort({ updatedAt: -1 }).limit(2000).lean<any[]>();
        return { items: items.map(toRecipe), removedIds: [] as string[], full: true };
      }
      const [changed, removed] = await Promise.all([
        Recipe.find({ status: "published", updatedAt: { $gt: since } }).sort({ updatedAt: -1 }).limit(2000).lean<any[]>(),
        Recipe.find({ status: { $ne: "published" }, updatedAt: { $gt: since } }).select("_id").lean<any[]>()
      ]);
      return { items: changed.map(toRecipe), removedIds: removed.map((r) => String(r._id)), full: false };
    });
    res.setHeader("X-Cache", hit ? "HIT" : "MISS");
    res.json({ ...value, serverTime });
  } catch (e) { next(e); }
});

export default router;

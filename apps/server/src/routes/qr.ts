import { Router } from "express";
import QRCode from "qrcode";
import { Recipe } from "../models/Recipe.js";
import { optionalAuth, type AuthRequest } from "../middleware/auth.js";

const router = Router();

/**
 * GET /api/qr/:recipeId
 * Returns PNG QR code that deep-links to the recipe card.
 * Free, no external service.
 */
router.get("/:recipeId", optionalAuth, async (req: AuthRequest, res, next) => {
  try {
    const recipe = await Recipe.findById(req.params.recipeId).select("_id name status").lean<any>();
    if (!recipe) return res.status(404).json({ error: "Карта не найдена" });
    if (recipe.status !== "published" && req.user?.role !== "admin" && req.user?.role !== "manager") {
      return res.status(404).json({ error: "Карта не найдена" });
    }

    const baseUrl = process.env.CLIENT_ORIGIN?.split(",")[0] || "http://localhost:5173";
    const deepLink = `${baseUrl}/?recipe=${recipe._id}`;

    const png = await QRCode.toBuffer(deepLink, {
      type: "png",
      width: 320,
      margin: 2,
      color: { dark: "#202124", light: "#ffffff" },
      errorCorrectionLevel: "M"
    });

    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "public, max-age=3600");
    res.setHeader("Content-Disposition", `inline; filename="recipe-${recipe._id}-qr.png"`);
    res.send(png);
  } catch (e) {
    next(e);
  }
});

/**
 * GET /api/qr/:recipeId/data
 * Returns JSON with deep-link and data-URL for embedding.
 */
router.get("/:recipeId/data", optionalAuth, async (req: AuthRequest, res, next) => {
  try {
    const recipe = await Recipe.findById(req.params.recipeId).select("_id name status").lean<any>();
    if (!recipe) return res.status(404).json({ error: "Карта не найдена" });

    const baseUrl = process.env.CLIENT_ORIGIN?.split(",")[0] || "http://localhost:5173";
    const deepLink = `${baseUrl}/?recipe=${recipe._id}`;
    const dataUrl = await QRCode.toDataURL(deepLink, { width: 280, margin: 2 });

    res.json({
      recipeId: String(recipe._id),
      name: recipe.name,
      deepLink,
      qrDataUrl: dataUrl
    });
  } catch (e) {
    next(e);
  }
});

export default router;

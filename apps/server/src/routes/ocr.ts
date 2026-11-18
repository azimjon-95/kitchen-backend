import { Router } from "express";
import multer from "multer";
import path from "path";
import fs from "fs";
import { requireAuth, requireRoles, type AuthRequest } from "../middleware/auth.js";
import { runOcr, cleanupUpload, UPLOAD_DIR } from "../services/ocr.js";

const router = Router();

// Ensure upload directory exists
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const safe = `${Date.now()}-${Math.random().toString(36).slice(2)}${path.extname(file.originalname).toLowerCase()}`;
    cb(null, safe);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 12 * 1024 * 1024 }, // 12 MB
  fileFilter: (_req, file, cb) => {
    const allowed = /\.(jpg|jpeg|png|pdf|webp|tif|tiff)$/i;
    if (allowed.test(path.extname(file.originalname)) || file.mimetype.startsWith("image/") || file.mimetype === "application/pdf") {
      cb(null, true);
    } else {
      cb(new Error("Поддерживаются только изображения и PDF"));
    }
  }
});

/**
 * POST /api/ocr/extract
 * Upload image/PDF → Tesseract OCR → structured draft suggestion.
 * Never auto-publishes. Admin/manager only.
 */
router.post(
  "/extract",
  requireAuth,
  requireRoles("admin", "manager"),
  upload.single("file"),
  async (req: AuthRequest, res, next) => {
    const filePath = req.file?.path;
    try {
      if (!filePath) {
        return res.status(400).json({ error: "Файл не загружен" });
      }

      const lang = String(req.body.lang || "rus+eng");
      const result = await runOcr(filePath, lang);

      // Keep original file temporarily? For now we return path reference but clean up
      // In production you may move to permanent storage. TZ: store source document.
      const publicName = path.basename(filePath);

      res.json({
        success: true,
        confidence: result.confidence,
        rawText: result.rawText,
        suggested: result.suggested,
        sourceFile: publicName,
        message: "OCR завершён. Проверьте и подтвердите данные перед публикацией."
      });
    } catch (e: any) {
      if (filePath) cleanupUpload(filePath);
      next(e);
    }
  }
);

export default router;

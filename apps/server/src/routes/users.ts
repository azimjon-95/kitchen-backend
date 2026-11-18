import { Router } from "express";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { User } from "../models/User.js";
import { requireAuth, requireRoles } from "../middleware/auth.js";

const router = Router();
const createSchema = z.object({
  email: z.string().email().max(200),
  name: z.string().trim().min(2).max(100),
  password: z.string().min(8).max(100),
  role: z.enum(["cook", "manager", "admin"]).default("cook")
});

router.get("/", requireAuth, requireRoles("admin", "manager"), async (_req, res, next) => {
  try {
    const items = await User.find().select("email name role active createdAt").sort({ createdAt: -1 }).lean();
    res.json({ items: items.map(u => ({ id: String(u._id), email: u.email, name: u.name, role: u.role, active: u.active, createdAt: u.createdAt })) });
  } catch (e) { next(e); }
});

router.post("/", requireAuth, requireRoles("admin"), async (req, res, next) => {
  try {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Проверьте данные пользователя", details: parsed.error.flatten() });
    const passwordHash = await bcrypt.hash(parsed.data.password, 12);
    const user = await User.create({ ...parsed.data, email: parsed.data.email.toLowerCase(), passwordHash });
    res.status(201).json({ item: { id: user.id, email: user.email, name: user.name, role: user.role, active: user.active } });
  } catch (e: any) { if (e?.code === 11000) return res.status(409).json({ error: "Пользователь с таким email уже существует" }); next(e); }
});

router.patch("/:id/active", requireAuth, requireRoles("admin"), async (req, res, next) => {
  try {
    const active = z.boolean().safeParse(req.body.active);
    if (!active.success) return res.status(400).json({ error: "Поле active должно быть boolean" });
    const user = await User.findByIdAndUpdate(req.params.id, { active: active.data }, { new: true }).select("email name role active");
    if (!user) return res.status(404).json({ error: "Пользователь не найден" });
    res.json({ item: { id: user.id, email: user.email, name: user.name, role: user.role, active: user.active } });
  } catch (e) { next(e); }
});

export default router;

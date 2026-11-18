import { Router } from "express";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { User } from "../models/User.js";
import { requireAuth, type AuthRequest, signToken } from "../middleware/auth.js";

const router = Router();
const loginSchema = z.object({
  email: z.string().email().max(200),
  password: z.string().min(1).max(200)
});

router.post("/login", async (req, res, next) => {
  try {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Проверьте email и пароль" });
    const email = parsed.data.email.toLowerCase();
    const user = await User.findOne({ email, active: true }).select("+passwordHash");
    if (!user || !(await bcrypt.compare(parsed.data.password, user.passwordHash))) {
      return res.status(401).json({ error: "Неверный email или пароль" });
    }
    const payload = { sub: user.id, email: user.email, name: user.name, role: user.role as "cook"|"manager"|"admin" };
    return res.json({ token: signToken(payload), user: { id: user.id, email: user.email, name: user.name, role: user.role } });
  } catch (error) { next(error); }
});

router.get("/me", requireAuth, (req: AuthRequest, res) => {
  const user = req.user!;
  res.json({ user: { id: user.sub, email: user.email, name: user.name, role: user.role } });
});

export default router;

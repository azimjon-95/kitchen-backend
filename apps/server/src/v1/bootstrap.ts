import { PlatformUser } from "./models.js";
import { hashPassword, passwordProblem } from "./security.js";

/** Идемпотентное создание Super Admin из ENV: повторный запуск дубликатов не создаёт, пароль не перезаписывает */
export async function bootstrapSuperAdmin(): Promise<"created" | "exists" | "skipped"> {
  const email = process.env.SUPER_ADMIN_EMAIL?.toLowerCase().trim(), password = process.env.SUPER_ADMIN_PASSWORD;
  if (!email || !password) return "skipped";
  if (await PlatformUser.exists({ platformRole: "super_admin" })) return "exists";
  const prob = passwordProblem(password); if (prob) throw new Error("SUPER_ADMIN_PASSWORD: " + prob);
  try {
    await PlatformUser.create({ email, name: process.env.SUPER_ADMIN_NAME || "Super Admin", passwordHash: await hashPassword(password), platformRole: "super_admin" });
  } catch (e: any) { if (e?.code === 11000) return "exists"; throw e; }
  return "created";
}

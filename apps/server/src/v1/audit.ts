import type { Request } from "express";
import { AuditLog } from "./models.js";

const SENSITIVE = /password|hash|token|secret/i;
function scrub(v: any): any {
  if (v == null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map(scrub);
  if (typeof v.toObject === "function") v = v.toObject();
  const o: any = {};
  for (const [k, x] of Object.entries(v)) o[k] = SENSITIVE.test(k) ? "[скрыто]" : scrub(x);
  return o;
}

export interface AuditInput { action: string; entity?: string; entityId?: any; before?: any; after?: any; restaurantId?: any; actor?: { id?: any; email?: string } }

export async function audit(req: Request | null, a: AuditInput) {
  const r: any = req;
  try {
    await AuditLog.create({
      restaurantId: a.restaurantId ?? r?.tenant?.restaurantId ?? null,
      actorId: a.actor?.id ?? r?.auth?.user?._id ?? null,
      actorEmail: a.actor?.email ?? r?.auth?.user?.email ?? "",
      action: a.action, entity: a.entity ?? "", entityId: a.entityId ? String(a.entityId) : "",
      before: scrub(a.before) ?? null, after: scrub(a.after) ?? null,
      ip: r?.ip, sessionId: r?.auth?.session ? String(r.auth.session._id) : undefined,
      userAgent: String(r?.headers?.["user-agent"] ?? "").slice(0, 200)
    });
  } catch (e) { console.error("audit failed:", (e as Error).message); }
}

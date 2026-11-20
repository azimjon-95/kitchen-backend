import { Role, Membership } from "./models.js";
import { SYSTEM_ROLES } from "./permissions.js";

/** Базовые роли нового ресторана (владелец, управляющий, шеф, су-шеф, повар) */
export async function seedRoles(restaurantId: any) {
  const out: Record<string, any> = {};
  for (const t of SYSTEM_ROLES) {
    out[t.key] = await Role.create({ restaurantId, key: t.key, name: t.name, system: true, permissions: t.permissions, scope: t.scope, denyCost: t.denyCost, denyPurchasePriceEdit: t.denyPurchasePriceEdit, features: t.features });
  }
  return out;
}
export const ownerMembership = (restaurantId: any, userId: any, roleId: any) =>
  Membership.create({ restaurantId, userId, roleId, status: "active" });

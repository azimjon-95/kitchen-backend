import mongoose, { Schema } from "mongoose";
import { tenantGuard } from "./tenantGuard.js";

const M = <T>(name: string, schema: any, coll?: string): mongoose.Model<any> => (mongoose.models[name] as any) || mongoose.model(name, schema, coll);
const oid = Schema.Types.ObjectId;

export const PlatformUser = M<any>("PlatformUser", new Schema({
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  name: { type: String, required: true, trim: true },
  passwordHash: { type: String, required: true, select: false },
  platformRole: { type: String, enum: ["super_admin", "user"], default: "user" },
  status: { type: String, enum: ["active", "blocked"], default: "active" },
  failedLogins: { type: Number, default: 0 },
  lockUntil: { type: Date, default: null },
  passwordChangedAt: { type: Date, default: null },
  resetHash: { type: String, select: false, default: null },
  resetExpires: { type: Date, select: false, default: null }
}, { timestamps: true }), "pl_users");

export const Restaurant = M<any>("Restaurant", new Schema({
  name: { type: String, required: true, trim: true },
  organization: { type: String, required: true, trim: true },
  slug: { type: String, required: true, unique: true, lowercase: true, trim: true },
  address: { type: String, default: "" },
  contacts: { phone: { type: String, default: "" }, email: { type: String, default: "" } },
  logoUrl: { type: String, default: "" },
  currency: { type: String, default: "UZS" },
  timezone: { type: String, default: "Asia/Tashkent" },
  status: { type: String, enum: ["active", "suspended", "archived"], default: "active", index: true },
  ownerId: { type: oid, ref: "PlatformUser", required: true, index: true },
  settings: { type: Schema.Types.Mixed, default: {} }
}, { timestamps: true }), "pl_restaurants");

const roleSchema = new Schema({
  restaurantId: { type: oid, required: true },
  key: { type: String, default: "" },        // owner|manager|head_chef|sous_chef|cook для системных
  name: { type: String, required: true, trim: true, maxlength: 80 },
  system: { type: Boolean, default: false },
  permissions: { type: Schema.Types.Mixed, default: {} },
  scope: { type: String, enum: ["all", "assigned"], default: "assigned" },
  denyCost: { type: Boolean, default: true },
  denyPurchasePriceEdit: { type: Boolean, default: true },
  features: { type: [String], default: [] }
}, { timestamps: true });
roleSchema.index({ restaurantId: 1, name: 1 }, { unique: true });
roleSchema.plugin(tenantGuard);
export const Role = M<any>("Role", roleSchema, "t_roles");

const memberSchema = new Schema({
  userId: { type: oid, ref: "PlatformUser", required: true },
  restaurantId: { type: oid, required: true },
  roleId: { type: oid, ref: "Role", required: true },
  status: { type: String, enum: ["active", "blocked"], default: "active" },
  assigned: {
    categoryIds: { type: [oid], default: [] },
    recipeIds: { type: [oid], default: [] },
    zones: { type: [String], default: [] }
  },
  accessFrom: { type: Date, default: null },
  accessUntil: { type: Date, default: null }
}, { timestamps: true });
memberSchema.index({ userId: 1, restaurantId: 1 }, { unique: true });
memberSchema.index({ restaurantId: 1, roleId: 1 });
memberSchema.plugin(tenantGuard, { allowUserScope: true }); // членства ищутся и по userId (при входе)
export const Membership = M<any>("RestaurantMembership", memberSchema, "t_memberships");

export const Session = M<any>("Session", new Schema({
  userId: { type: oid, required: true, index: true },
  restaurantId: { type: oid, default: null },
  ip: String, userAgent: String,
  expiresAt: { type: Date, required: true },
  lastSeenAt: { type: Date, default: Date.now },
  revokedAt: { type: Date, default: null },
  revokedReason: { type: String, default: "" }
}, { timestamps: true }), "pl_sessions");

export const RefreshTokenFamily = M<any>("RefreshTokenFamily", new Schema({
  sessionId: { type: oid, required: true, unique: true },
  userId: { type: oid, required: true },
  currentHash: { type: String, required: true },
  usedHashes: { type: [String], default: [] },
  rotatedAt: { type: Date, default: Date.now },
  revokedAt: { type: Date, default: null }
}, { timestamps: true }), "pl_refresh_families");

const auditSchema = new Schema({
  restaurantId: { type: oid, default: null, index: true },
  actorId: { type: oid, default: null },
  actorEmail: { type: String, default: "" },
  action: { type: String, required: true, index: true },
  entity: { type: String, default: "" },
  entityId: { type: String, default: "" },
  before: { type: Schema.Types.Mixed, default: null },
  after: { type: Schema.Types.Mixed, default: null },
  ip: String, sessionId: String, userAgent: String,
  at: { type: Date, default: Date.now, index: true }
}, { versionKey: false });
// журнал неизменяем: обновление и удаление через Mongoose запрещены
for (const op of ["updateOne", "updateMany", "findOneAndUpdate", "findOneAndDelete", "findOneAndReplace", "deleteOne", "deleteMany", "replaceOne"] as const)
  auditSchema.pre(op as any, function () { throw new Error("AuditLog is append-only"); });
auditSchema.pre("save", function (next) { if (!this.isNew) return next(new Error("AuditLog is append-only")); next(); });
export const AuditLog = M<any>("AuditLog", auditSchema, "pl_audit_logs");

// ───── ресторанные данные (все с обязательным restaurantId + tenantGuard) ─────
const catSchema = new Schema({
  restaurantId: { type: oid, required: true },
  name: { type: String, required: true, trim: true, maxlength: 80 },
  slug: { type: String, required: true, lowercase: true },
  zone: { type: String, enum: ["hot", "cold", "prep", "pastry", ""], default: "" },
  sortOrder: { type: Number, default: 0 }
}, { timestamps: true });
catSchema.index({ restaurantId: 1, slug: 1 }, { unique: true });
catSchema.plugin(tenantGuard);
export const TCategory = M<any>("TCategory", catSchema, "t_categories");

const ingSchema = new Schema({
  restaurantId: { type: oid, required: true },
  name: { type: String, required: true, trim: true, maxlength: 120 },
  unit: { type: String, enum: ["kg", "g", "l", "ml", "pcs"], default: "kg" },
  pricePerUnit: { type: Number, min: 0, default: 0 },
  semiFinished: { type: Boolean, default: false }
}, { timestamps: true });
ingSchema.index({ restaurantId: 1, name: 1 }, { unique: true });
ingSchema.plugin(tenantGuard);
export const TIngredient = M<any>("TIngredient", ingSchema, "t_ingredients");

const lineSchema = new Schema({
  name: { type: String, required: true, trim: true, maxlength: 120 },
  unit: { type: String, enum: ["kg", "g", "l", "ml", "pcs"], default: "g" },
  gross: { type: Number, min: 0 }, net: { type: Number, min: 0 },
  pricePerUnit: { type: Number, min: 0 }
}, { _id: false });
const recipeSchema = new Schema({
  restaurantId: { type: oid, required: true },
  name: { type: String, required: true, trim: true, maxlength: 160 },
  description: { type: String, default: "", maxlength: 2000 },
  categoryId: { type: oid, default: null },
  zone: { type: String, enum: ["hot", "cold", "prep", "pastry", ""], default: "" },
  portionCount: { type: Number, min: 0, default: 0 },
  yieldLabel: { type: String, default: "" },
  imageUrl: { type: String, default: "" },
  ingredients: { type: [lineSchema], default: [] },
  steps: { type: [new Schema({ text: { type: String, required: true, maxlength: 2000 }, durationMinutes: Number }, { _id: false })], default: [] },
  status: { type: String, enum: ["draft", "published", "archived"], default: "draft" },
  version: { type: Number, default: 1 },
  createdBy: { type: oid }, updatedBy: { type: oid }
}, { timestamps: true });
recipeSchema.index({ restaurantId: 1, status: 1, updatedAt: -1 });
recipeSchema.index({ restaurantId: 1, categoryId: 1 });
recipeSchema.index({ restaurantId: 1, name: 1 });
recipeSchema.plugin(tenantGuard);
export const TRecipe = M<any>("TRecipe", recipeSchema, "t_recipes");

const verSchema = new Schema({
  restaurantId: { type: oid, required: true },
  recipeId: { type: oid, required: true },
  version: { type: Number, required: true },
  snapshot: { type: Schema.Types.Mixed, required: true },
  changedBy: { type: oid }
}, { timestamps: { createdAt: true, updatedAt: false } });
verSchema.index({ restaurantId: 1, recipeId: 1, version: -1 }, { unique: true });
verSchema.plugin(tenantGuard);
export const TRecipeVersion = M<any>("TRecipeVersion", verSchema, "t_recipe_versions");

const importSchema = new Schema({
  restaurantId: { type: oid, required: true },
  createdBy: { type: oid },
  kind: { type: String, default: "recipes" },
  status: { type: String, enum: ["done", "failed", "partial"], default: "done" },
  total: Number, created: Number, failed: Number,
  errors: { type: [String], default: [] }
}, { timestamps: true });
importSchema.plugin(tenantGuard);
export const ImportJob = M<any>("ImportJob", importSchema, "t_import_jobs");

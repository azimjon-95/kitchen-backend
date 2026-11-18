import mongoose, { Schema } from "mongoose";

/**
 * Snapshot of a recipe at a point in time.
 * Used for history / restore. Stores a full copy of the recipe fields
 * so restore is simple and independent of future schema changes.
 */
const recipeVersionSchema = new Schema({
  recipeId: { type: Schema.Types.ObjectId, ref: "Recipe", required: true, index: true },
  version: { type: Number, required: true },
  snapshot: { type: Schema.Types.Mixed, required: true },
  changedBy: { type: Schema.Types.ObjectId, ref: "User" },
  changeNote: { type: String, default: "", maxlength: 500 },
  changedFields: { type: [String], default: [] }
}, { timestamps: { createdAt: true, updatedAt: false } });

recipeVersionSchema.index({ recipeId: 1, version: -1 }, { unique: true });

export const RecipeVersion = mongoose.models.RecipeVersion || mongoose.model("RecipeVersion", recipeVersionSchema);

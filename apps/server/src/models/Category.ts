import mongoose, { Schema } from "mongoose";

/**
 * Kitchen department / section taxonomy.
 * Examples:
 *  - department: "Горячий цех", section: "Паста"
 *  - department: "Суши", section: null
 *  - department: "Кондитерский", section: "Пекарный"
 */
const categorySchema = new Schema({
  name: { type: String, required: true, trim: true },
  slug: { type: String, required: true, trim: true, lowercase: true },
  /** Parent department name (null = top-level department) */
  department: { type: String, trim: true, default: null, index: true },
  /** Sort order within department */
  sortOrder: { type: Number, default: 0 },
  /** Icon key for UI */
  icon: { type: String, default: "utensils" },
  active: { type: Boolean, default: true }
}, { timestamps: true });

categorySchema.index({ name: 1, department: 1 }, { unique: true });
categorySchema.index({ name: "text" });

export const Category = mongoose.models.Category || mongoose.model("Category", categorySchema);

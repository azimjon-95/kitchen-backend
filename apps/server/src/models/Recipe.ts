import mongoose, { Schema } from "mongoose";

const ingredientSchema = new Schema({
  name: { type: String, required: true, trim: true },
  unit: { type: String, enum: ["kg", "g", "l", "ml", "pcs"], default: "g" },
  gross: { type: Number, min: 0 },
  net: { type: Number, min: 0 },
  pricePerUnit: { type: Number, min: 0 },
  amount: { type: String, trim: true }
}, { _id: false });

const stepSchema = new Schema({
  text: { type: String, required: true, trim: true },
  durationMinutes: { type: Number, min: 0 },
  imageUrl: { type: String, trim: true, maxlength: 1000 }
}, { _id: false });

const recipeSchema = new Schema({
  name: { type: String, required: true, trim: true, index: true },
  description: { type: String, default: "" },
  imageUrl: { type: String, trim: true, maxlength: 1000 },
  category: { type: String, required: true, trim: true, index: true },
  /** Kitchen department (цех): Горячий цех, Суши, Холодный цех, Кондитерский */
  department: { type: String, trim: true, index: true, default: "" },
  /** Section inside department: Паста, Мангал, Соусы, Раздача, Заготовка, Пекарный... */
  section: { type: String, trim: true, index: true, default: "" },
  yieldLabel: { type: String, default: "" },
  yieldQuantity: { type: Number, min: 0 },
  yieldUnit: { type: String, enum: ["kg", "g", "l", "ml", "pcs"], default: "kg" },
  portionCount: { type: Number, min: 0 },
  ingredients: { type: [ingredientSchema], default: [] },
  steps: { type: [stepSchema], default: [] },
  aliases: { type: [String], default: [] },
  status: { type: String, enum: ["draft", "published", "archived"], default: "draft", index: true },
  version: { type: Number, default: 1, min: 1 },
  createdBy: { type: Schema.Types.ObjectId, ref: "User" },
  updatedBy: { type: Schema.Types.ObjectId, ref: "User" },
  /** Original source for OCR imports (kept for audit, never auto-published) */
  sourceDocumentUrl: { type: String, trim: true, maxlength: 1000 },
  sourceDocumentType: { type: String, enum: ["pdf", "image", "manual", ""], default: "manual" }
}, { timestamps: true });

recipeSchema.index({ name: "text", description: "text", aliases: "text", category: "text" });
export const Recipe = mongoose.models.Recipe || mongoose.model("Recipe", recipeSchema);

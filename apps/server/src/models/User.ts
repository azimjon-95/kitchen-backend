import mongoose, { Schema, type InferSchemaType } from "mongoose";

const userSchema = new Schema({
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  name: { type: String, required: true, trim: true },
  passwordHash: { type: String, required: true, select: false },
  role: { type: String, enum: ["cook", "manager", "admin"], default: "cook", required: true },
  active: { type: Boolean, default: true }
}, { timestamps: true });

export type UserDocument = InferSchemaType<typeof userSchema>;
export const User = mongoose.models.User || mongoose.model("User", userSchema);

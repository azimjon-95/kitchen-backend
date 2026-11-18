/**
 * Начальные данные: 37 демо-карточек (идемпотентно — существующие по названию не трогаются).
 * Запуск: npm run seed  (из папки backend)
 */
import "./env.js";
import mongoose from "mongoose";
import { readFileSync } from "node:fs";
import { Recipe } from "./models/Recipe.js";

const file = new URL("./data/seedRecipes.json", import.meta.url);
const items: any[] = JSON.parse(readFileSync(file, "utf8"));

const uri = process.env.MONGODB_URI;
if (!uri) { console.error("MONGODB_URI не задан"); process.exit(1); }
await mongoose.connect(uri, { serverSelectionTimeoutMS: 10000 });
let added = 0;
for (const it of items) {
  const r = await (Recipe as any).updateOne({ name: it.name }, { $setOnInsert: { ...it, version: 1, sourceDocumentType: "manual" } }, { upsert: true });
  if (r.upsertedCount) added++;
}
console.log(`Seed: добавлено ${added} из ${items.length}`);
await mongoose.disconnect();

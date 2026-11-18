/**
 * Clean Kitchen OCR Service — free, self-hosted via tesseract.js
 * No paid APIs. Languages: Russian + English (Uzbek limited support in Tesseract).
 * Always returns structured draft data for human review before publish.
 */

import Tesseract from "tesseract.js";
import path from "path";
import fs from "fs";

export type OcrExtracted = {
  rawText: string;
  confidence: number;
  suggested: {
    name: string;
    category: string;
    yieldLabel: string;
    ingredients: { name: string; amount: string; unit?: string; gross?: number; net?: number }[];
    steps: { text: string }[];
    aliases: string[];
  };
};

const UNIT_MAP: Record<string, string> = {
  кг: "kg", кгм: "kg", kg: "kg",
  г: "g", гр: "g", g: "g",
  л: "l", лт: "l", l: "l",
  мл: "ml", ml: "ml",
  шт: "pcs", штук: "pcs", pcs: "pcs"
};

function detectUnit(token: string): string | undefined {
  const t = token.toLowerCase().replace(/[.,]/g, "");
  return UNIT_MAP[t];
}

function parseNumber(raw: string): number | undefined {
  const cleaned = raw.replace(",", ".").replace(/[^\d.]/g, "");
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Heuristic parser for typical Russian tech-card OCR text.
 * Not perfect — always requires human review (TZ requirement).
 */
function parseTechCard(text: string): OcrExtracted["suggested"] {
  const lines = text
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(Boolean);

  let name = "";
  let category = "Без категории";
  let yieldLabel = "";
  const ingredients: OcrExtracted["suggested"]["ingredients"] = [];
  const steps: { text: string }[] = [];
  const aliases: string[] = [];

  // Try to find name (usually first significant line or after "Название")
  for (const line of lines.slice(0, 8)) {
    if (/назван|наимен|dish|рецепт/i.test(line)) {
      name = line.replace(/назван[ие]*\s*[:.\-]?\s*/i, "").trim();
      break;
    }
  }
  if (!name && lines[0] && lines[0].length < 80) name = lines[0];

  // Category keywords
  const catMap: [RegExp, string][] = [
    [/соус/i, "Соусы"],
    [/салат/i, "Салаты"],
    [/суп/i, "Супы"],
    [/горяч/i, "Горячие блюда"],
    [/закуск/i, "Холодные закуски"],
    [/десерт|торт|пирож/i, "Десерты"],
    [/напит|сок|компот/i, "Напитки"],
    [/гарнир/i, "Гарниры"]
  ];
  for (const [re, cat] of catMap) {
    if (re.test(text)) { category = cat; break; }
  }

  // Yield / выход
  const yieldMatch = text.match(/выход[:\s]*([\d,.]+\s*(?:кг|г|л|мл|шт)?)/i);
  if (yieldMatch) yieldLabel = yieldMatch[1].trim();

  // Ingredients block: look for lines with numbers + units
  let inIngredients = false;
  let inSteps = false;
  for (const line of lines) {
    if (/ингредиент|состав|продукт/i.test(line)) {
      inIngredients = true;
      inSteps = false;
      continue;
    }
    if (/технолог|способ приготов|рецептура|этап|шаг/i.test(line)) {
      inIngredients = false;
      inSteps = true;
      continue;
    }
    if (inIngredients) {
      // e.g. "Говядина 1000 г" or "1. Томаты — 2 кг"
      const m = line.match(/^(?:\d+[\.\)]\s*)?(.+?)\s+[—\-]?\s*([\d,.]+)\s*([а-яa-z]+)?/i);
      if (m) {
        const unit = m[3] ? detectUnit(m[3]) : undefined;
        const qty = parseNumber(m[2]);
        ingredients.push({
          name: m[1].replace(/^\d+[\.\)]\s*/, "").trim(),
          amount: `${m[2]}${m[3] ? " " + m[3] : ""}`.trim(),
          unit: unit as any,
          gross: qty,
          net: qty
        });
      }
    } else if (inSteps) {
      const cleaned = line.replace(/^\d+[\.\)]\s*/, "").trim();
      if (cleaned.length > 5) steps.push({ text: cleaned });
    }
  }

  // Fallback: any line that looks like "Name 123 g"
  if (ingredients.length === 0) {
    for (const line of lines) {
      const m = line.match(/^(.+?)\s+([\d,.]+)\s*(кг|г|л|мл|шт|g|kg|ml|l)\b/i);
      if (m && m[1].length < 60) {
        ingredients.push({
          name: m[1].trim(),
          amount: `${m[2]} ${m[3]}`,
          unit: detectUnit(m[3]) as any,
          gross: parseNumber(m[2]),
          net: parseNumber(m[2])
        });
      }
    }
  }

  return { name: name || "Без названия (проверьте OCR)", category, yieldLabel, ingredients, steps, aliases };
}

export async function runOcr(filePath: string, lang = "rus+eng"): Promise<OcrExtracted> {
  const result = await Tesseract.recognize(filePath, lang, {
    logger: () => {} // silent in production
  });
  const rawText = result.data.text || "";
  const confidence = result.data.confidence ?? 0;
  const suggested = parseTechCard(rawText);
  return { rawText, confidence, suggested };
}

export function cleanupUpload(filePath: string) {
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch {
    // ignore
  }
}

export const UPLOAD_DIR = path.resolve(process.cwd(), "uploads");

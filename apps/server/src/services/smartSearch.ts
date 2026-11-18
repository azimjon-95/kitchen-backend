/**
 * Clean Kitchen Smart Search — V12 senior
 * Offline-friendly, RU/UZ, typo-tolerant, incomplete-phrase aware.
 */

const synonymGroups: string[][] = [
  ["курица", "куриный", "куриная", "грудка", "товук", "tovuq", "chicken"],
  ["говядина", "говяжий", "мол гушти", "mol go'shti", "mol goshti", "beef"],
  ["баранина", "қўй гўшти", "куй гушти", "qo'y go'shti", "qoy goshti", "lamb"],
  ["картофель", "картошка", "potato"],
  ["помидор", "томат", "помидоры", "pomidor", "tomato"],
  ["огурец", "огурцы", "бодринг", "bodring", "cucumber"],
  ["лук", "репчатый лук", "пиёз", "piyoz", "onion"],
  ["чеснок", "саримсоқ", "саримсок", "sarimsoq", "garlic"],
  ["рис", "гуруч", "guruch", "rice"],
  ["яйцо", "яйца", "тухум", "tuxum", "egg", "омлет"],
  ["суп", "шурпа", "шўрва", "shorva", "sho'rva", "soup", "крем-суп", "кремсуп"],
  ["салат", "салатик", "salat"],
  ["соус", "подлива", "sous", "sauce"],
  ["десерт", "сладкое", "ширинлик", "shirinlik", "dessert"],
  // Dish-specific
  ["болоньезе", "болонез", "болоньез", "болонезе", "bolognese", "bolognaise"],
  ["путанеско", "путанеска", "puttanesca"],
  ["омлет", "омлетик", "омлет с зеленью"]
];

const COMMAND_PREFIXES = [
  /^(найди|найти|найтите|покажи|показать|открой|открыть|дай|дайте|хочу|мне\s+нужен?|покажите|ищи|искать)\s+/i,
  /^(show|find|open|get|search)\s+/i
];

const STT_FIXES: [RegExp, string][] = [
  [/\bболон[еэ][зс][еэ]?\b/gi, "болоньезе"],
  [/\bболонь[еэ]з\b/gi, "болоньезе"],
  [/\bпутанес[кц][оа]?\b/gi, "путанеско"],
  [/\bомлет[иы]?\b/gi, "омлет"],
  [/\bкрем\s*суп\b/gi, "крем-суп"],
  [/\bкурин[аоыйяе]+\b/gi, "курица"]
];

function normalize(value: string): string {
  const lower = value.toLocaleLowerCase("ru").replace(/ё/g, "е").normalize("NFKD");
  const map: Record<string, string> = {
    а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ж: "zh", з: "z", и: "i", й: "y",
    к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t", у: "u",
    ф: "f", х: "h", ц: "ts", ч: "ch", ш: "sh", щ: "shch", ы: "i", э: "e", ю: "yu",
    я: "ya", ў: "o", қ: "q", ғ: "g", ҳ: "h"
  };
  return Array.from(lower)
    .map(char => map[char] ?? char)
    .join("")
    .replace(/['’`ʻʼ-]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > 3) return 4;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(cur[j - 1] + 1, prev[j] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

function preprocessQuery(raw: string): string {
  let text = raw.trim();
  for (const re of COMMAND_PREFIXES) text = text.replace(re, "");
  for (const [pattern, replacement] of STT_FIXES) text = text.replace(pattern, replacement);
  return text.replace(/\s+/g, " ").trim();
}

function expandTokens(token: string): string[] {
  const n = normalize(token);
  const group = synonymGroups.find(items => items.some(item => normalize(item) === n));
  return group ? [...new Set(group.map(normalize))] : [n];
}

function tokenMatch(queryToken: string, textTokens: string[]): number {
  const variants = expandTokens(queryToken);
  let best = 0;
  for (const variant of variants) {
    for (const candidate of textTokens) {
      if (candidate === variant) best = Math.max(best, 1);
      else if (candidate.startsWith(variant) || variant.startsWith(candidate)) best = Math.max(best, 0.85);
      else if (Math.min(candidate.length, variant.length) >= 4) {
        const distance = editDistance(candidate, variant);
        if (distance <= 1) best = Math.max(best, 0.9);
        else if (distance <= 2) best = Math.max(best, 0.7);
      }
    }
  }
  return best;
}

export function scoreRecipeSearch(query: string, recipe: any): number {
  const cleaned = preprocessQuery(query);
  if (!cleaned) return 0;

  const q = normalize(cleaned);
  const name = normalize(recipe.name || "");
  const category = normalize(recipe.category || "");
  const aliases = normalize((recipe.aliases || []).join(" "));
  const ingredients = normalize(
    (recipe.ingredients || []).map((i: any) => i.name || "").join(" ")
  );
  const description = normalize(recipe.description || "");
  const haystack = [name, category, aliases, ingredients, description].join(" ");

  // Exact / contains
  if (name === q) return 100;
  if (name.includes(q) || q.includes(name)) return 92;
  if (aliases.includes(q)) return 90;

  // Prefix (incomplete speech)
  if (name.startsWith(q) && q.length >= 3) return 88;
  if (q.startsWith(name.slice(0, Math.min(5, name.length))) && name.length >= 4) return 80;

  // Token scoring
  const qTokens = q.split(" ").filter(t => t.length >= 2);
  const textTokens = haystack.split(" ").filter(Boolean);
  if (!qTokens.length) return 0;

  let total = 0;
  for (const qt of qTokens) {
    total += tokenMatch(qt, textTokens);
  }
  const ratio = total / qTokens.length;

  // Full-string fuzzy
  let fuzzy = 0;
  if (q.length >= 4) {
    const dist = editDistance(name, q);
    if (dist <= 1) fuzzy = 0.95;
    else if (dist <= 2) fuzzy = 0.8;
    else if (dist <= 3 && q.length >= 7) fuzzy = 0.55;
  }

  const score = Math.round(Math.max(ratio, fuzzy) * 100);
  return score > 25 ? score : 0;
}

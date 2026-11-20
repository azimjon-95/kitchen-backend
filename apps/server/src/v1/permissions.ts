/** Каталог разрешений (Permissions Matrix) и системные роли. Отсутствие явного разрешения = запрет. */
export const SECTIONS = ["dashboard", "recipes", "categories", "ingredients", "calculations", "imports", "members", "roles", "audit", "restaurant"] as const;
export const ACTIONS = ["view", "create", "edit", "delete", "publish", "archive", "import", "export", "approve"] as const;
export const FEATURES = ["tts", "qr", "voice", "cooking_mode", "saved"] as const;
export const ZONES = ["hot", "cold", "prep", "pastry"] as const;

export type Section = (typeof SECTIONS)[number];
export type Action = (typeof ACTIONS)[number];
export type PermMap = Partial<Record<Section, Action[]>>;

export const ZONE_LABELS: Record<string, string> = { hot: "Горячий цех", cold: "Холодный цех", prep: "Заготовочный цех", pastry: "Кондитерский цех" };

/** Какие действия имеют смысл в каждом разделе — всё остальное отбрасывается при валидации */
export const SECTION_ACTIONS: Record<Section, Action[]> = {
  dashboard: ["view"],
  recipes: ["view", "create", "edit", "delete", "publish", "archive", "import", "export", "approve"],
  categories: ["view", "create", "edit", "delete"],
  ingredients: ["view", "create", "edit", "delete", "import", "export"],
  calculations: ["view", "export"],
  imports: ["view", "import"],
  members: ["view", "create", "edit", "delete"],
  roles: ["view", "create", "edit", "delete"],
  audit: ["view"],
  restaurant: ["view", "edit"]
};

const all = (s: Section): Action[] => [...SECTION_ACTIONS[s]];
export const ALL_PERMISSIONS: PermMap = Object.fromEntries(SECTIONS.map((s) => [s, all(s)])) as PermMap;

export interface RoleTemplate {
  key: string; name: string; permissions: PermMap; scope: "all" | "assigned";
  denyCost: boolean; denyPurchasePriceEdit: boolean; features: string[];
}

export const SYSTEM_ROLES: RoleTemplate[] = [
  { key: "owner", name: "Владелец", permissions: ALL_PERMISSIONS, scope: "all", denyCost: false, denyPurchasePriceEdit: false, features: [...FEATURES] },
  {
    key: "manager", name: "Управляющий", scope: "all", denyCost: false, denyPurchasePriceEdit: false, features: [...FEATURES],
    permissions: { dashboard: ["view"], recipes: all("recipes"), categories: all("categories"), ingredients: all("ingredients"), calculations: all("calculations"), imports: all("imports"), members: ["view"], roles: ["view"], restaurant: ["view"] }
  },
  {
    key: "head_chef", name: "Шеф-повар", scope: "all", denyCost: false, denyPurchasePriceEdit: false, features: [...FEATURES],
    permissions: { dashboard: ["view"], recipes: ["view", "create", "edit", "publish", "archive", "export"], categories: ["view"], ingredients: ["view", "create", "edit"], calculations: ["view"] }
  },
  {
    key: "sous_chef", name: "Су-шеф", scope: "assigned", denyCost: true, denyPurchasePriceEdit: true, features: ["tts", "qr", "voice", "cooking_mode", "saved"],
    permissions: { recipes: ["view", "edit"], categories: ["view"], ingredients: ["view", "create"] }
  },
  {
    key: "cook", name: "Повар", scope: "assigned", denyCost: true, denyPurchasePriceEdit: true, features: ["tts", "qr", "voice", "cooking_mode", "saved"],
    permissions: { recipes: ["view"], categories: ["view"], ingredients: ["view"] }
  }
];

export function normalizePerms(input: unknown): PermMap {
  const out: PermMap = {};
  if (!input || typeof input !== "object") return out;
  for (const s of SECTIONS) {
    const raw = (input as any)[s];
    if (!Array.isArray(raw)) continue;
    const acts = [...new Set(raw.filter((a: any) => SECTION_ACTIONS[s].includes(a)))] as Action[];
    if (acts.length) out[s] = acts;
  }
  return out;
}

export const hasPerm = (p: PermMap | undefined, s: Section, a: Action) => !!p?.[s]?.includes(a);

/** true, если каждое разрешение из `wanted` есть у `have` (защита от privilege escalation) */
export function isSubset(wanted: PermMap, have: PermMap): boolean {
  return SECTIONS.every((s) => (wanted[s] ?? []).every((a) => have[s]?.includes(a)));
}

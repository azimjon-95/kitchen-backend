export type UserRole = "cook" | "manager" | "admin";
export type RecipeStatus = "draft" | "published" | "archived";
export type IngredientUnit = "kg" | "g" | "l" | "ml" | "pcs";

export interface Ingredient {
  name: string;
  unit: IngredientUnit;
  gross?: number;
  net?: number;
  amount?: string;
  pricePerUnit?: number;
}

export interface RecipeStep {
  text: string;
  durationMinutes?: number;
  imageUrl?: string;
}

export interface RecipeSummary {
  id: string;
  name: string;
  category: string;
  yieldLabel: string;
  updatedAt: string;
  status?: RecipeStatus;
  version?: number;
}

export interface Recipe {
  id: string;
  name: string;
  description?: string;
  category: string;
  yieldLabel: string;
  ingredients: Ingredient[];
  steps: RecipeStep[];
  aliases: string[];
  status: RecipeStatus;
  version?: number;
  imageUrl?: string;
  yieldQuantity?: number;
  yieldUnit?: IngredientUnit;
  portionCount?: number;
  sourceDocumentUrl?: string;
  sourceDocumentType?: "pdf" | "image" | "manual" | "";
  createdAt: string;
  updatedAt: string;
}

export interface RecipeVersionSummary {
  version: number;
  changedFields: string[];
  changeNote: string;
  changedBy?: string;
  createdAt: string;
}

export interface Category {
  id: string;
  name: string;
  slug: string;
  createdAt: string;
}

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: UserRole;
}

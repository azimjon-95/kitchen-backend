/**
 * Restaurant kitchen structure (цеха и участки).
 */

export type KitchenSection = {
  name: string;
  slug: string;
  icon?: string;
};

export type KitchenDepartment = {
  name: string;
  slug: string;
  icon: string;
  sections: KitchenSection[];
};

export const KITCHEN_DEPARTMENTS: KitchenDepartment[] = [
  {
    name: "Горячий цех",
    slug: "goryachiy",
    icon: "flame",
    sections: [
      { name: "Паста", slug: "pasta", icon: "utensils" },
      { name: "Мангал", slug: "mangal", icon: "flame" },
      { name: "Соусы", slug: "sousy", icon: "soup" },
      { name: "Раздача", slug: "razdacha", icon: "utensils" },
      { name: "Заготовка", slug: "zagotovka-hot", icon: "clock" }
    ]
  },
  {
    name: "Суши",
    slug: "sushi",
    icon: "leaf",
    sections: [
      { name: "Роллы", slug: "rolly", icon: "leaf" },
      { name: "Сашими / Нигири", slug: "sashimi", icon: "leaf" },
      { name: "Заготовка", slug: "zagotovka-sushi", icon: "clock" }
    ]
  },
  {
    name: "Холодный цех",
    slug: "holodniy",
    icon: "soup",
    sections: [
      { name: "Салаты", slug: "salaty", icon: "leaf" },
      { name: "Закуски", slug: "zakuski", icon: "utensils" },
      { name: "Заготовка", slug: "zagotovka-cold", icon: "clock" }
    ]
  },
  {
    name: "Кондитерский",
    slug: "konditerskiy",
    icon: "cake",
    sections: [
      { name: "Десерты", slug: "deserty", icon: "cake" },
      { name: "Пекарный", slug: "pekarnyy", icon: "cake" },
      { name: "Заготовка", slug: "zagotovka-sweet", icon: "clock" }
    ]
  }
];

export function inferDepartmentSection(category: string): { department: string; section: string } {
  const c = (category || "").toLowerCase();
  if (/соус/.test(c)) return { department: "Горячий цех", section: "Соусы" };
  if (/паст|спагет|пенне|фетуч/.test(c)) return { department: "Горячий цех", section: "Паста" };
  if (/мангал|гриль|шашлык|стейк/.test(c)) return { department: "Горячий цех", section: "Мангал" };
  if (/суши|ролл|сашим|нигир/.test(c)) return { department: "Суши", section: "Роллы" };
  if (/салат/.test(c)) return { department: "Холодный цех", section: "Салаты" };
  if (/закуск|холодн/.test(c)) return { department: "Холодный цех", section: "Закуски" };
  if (/десерт|торт|пирож|кондит/.test(c)) return { department: "Кондитерский", section: "Десерты" };
  if (/хлеб|выпеч|пекар|булк/.test(c)) return { department: "Кондитерский", section: "Пекарный" };
  if (/суп/.test(c)) return { department: "Горячий цех", section: "Раздача" };
  if (/горяч/.test(c)) return { department: "Горячий цех", section: "Раздача" };
  if (/завтрак|омлет/.test(c)) return { department: "Горячий цех", section: "Раздача" };
  return { department: "Горячий цех", section: "Раздача" };
}

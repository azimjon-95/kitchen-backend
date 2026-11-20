import { Router } from "express";
import cookieParser from "cookie-parser";
import authRoutes, { sessionsRouter } from "./routes/auth.js";
import platformRoutes from "./routes/platform.js";
import restaurantRoutes from "./routes/restaurant.js";
import { categories, ingredients, recipes, calculations, imports, auditRoutes, dashboard } from "./routes/data.js";
import { errorHandler } from "./middleware.js";

export { errorHandler };
export function buildV1(): Router {
  const r = Router();
  r.use(cookieParser());
  r.use("/auth", authRoutes);
  r.use("/sessions", sessionsRouter);
  r.use("/platform", platformRoutes);
  r.use("/restaurant", restaurantRoutes);
  r.use("/dashboard", dashboard);
  r.use("/recipes", recipes);
  r.use("/categories", categories);
  r.use("/ingredients", ingredients);
  r.use("/calculations", calculations);
  r.use("/imports", imports);
  r.use("/audit-logs", auditRoutes);
  return r;
}

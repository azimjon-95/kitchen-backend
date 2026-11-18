import type { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";

export type Role = "cook" | "manager" | "admin";
export interface TokenPayload { sub: string; email: string; name: string; role: Role }
export interface AuthRequest extends Request { user?: TokenPayload }

const secret = () => process.env.JWT_SECRET || "development-only-change-this-secret";

export function signToken(payload: TokenPayload): string {
  return jwt.sign(payload, secret(), { expiresIn: "7d" });
}

export function requireAuth(req: AuthRequest, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  const token = header?.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Требуется авторизация" });
  try {
    req.user = jwt.verify(token, secret()) as TokenPayload;
    next();
  } catch {
    return res.status(401).json({ error: "Недействительный или просроченный токен" });
  }
}

export function requireRoles(...roles: Role[]) {
  return (req: AuthRequest, res: Response, next: NextFunction) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: "Недостаточно прав" });
    }
    next();
  };
}

export function optionalAuth(req: AuthRequest, _res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  const token = header?.startsWith("Bearer ") ? header.slice(7) : null;
  if (token) {
    try { req.user = jwt.verify(token, secret()) as TokenPayload; }
    catch { /* Invalid optional token is treated as anonymous. */ }
  }
  next();
}

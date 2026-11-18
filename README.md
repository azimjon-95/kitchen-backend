# Clean Kitchen — backend

Express + MongoDB (Mongoose) API из монорепозитория v12 (`apps/server`) и общий пакет `packages/shared`.

```bash
cd backend
cp .env.example .env     # задайте JWT_SECRET, MONGODB_URI, ADMIN_*
npm install
npm run dev              # http://localhost:4000
```

Описание эндпоинтов — `docs/API.md`, архитектура — `docs/ARCHITECTURE.md`. Клиент (корень репозитория) подключается через `VITE_API_URL`.

> Код перенесён без изменений. При свежей установке зависимостей `npm run typecheck` может ругаться на типы Mongoose (`lean()` в `routes/qr.ts`, `routes/recipes.ts`) — это не связано с переносом; зафиксируйте версию `mongoose` или поправьте приведение типов.

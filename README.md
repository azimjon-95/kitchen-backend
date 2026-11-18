# Clean Kitchen — backend

Express + MongoDB (Mongoose) API: рецепты/техкарты, категории, пользователи (admin/manager/staff), QR-коды, OCR, история версий, импорт черновиков.

## Запуск локально
```bash
cp .env.example .env        # задайте MONGODB_URI, JWT_SECRET, ADMIN_*
npm install
npm run build
npm run seed                # 37 демо-карточек (повторный запуск безопасен)
npm start                   # http://localhost:4000/api/health
```
Разработка с автоперезапуском: `npm run dev`.

## Redis
Необязателен. Если задан `REDIS_URL`: публичные списки `GET /api/recipes` кэшируются на 60 с (заголовок `X-Cache: HIT/MISS`), любое изменение карточек сбрасывает кэш, лимиты запросов хранятся в Redis. Если Redis недоступен — сервер продолжает работать с MongoDB.

## Синхронизация для офлайн-клиентов
`GET /api/sync/recipes` — полный набор опубликованных карточек; `GET /api/sync/recipes?since=<serverTime>` — только изменённые и список `removedIds`. Мобильное приложение хранит всё на устройстве и при появлении интернета запрашивает только новое.

## Всё сразу локально
`docker compose up --build` — MongoDB + Redis + API (нужен `.env`).

## Деплой
**Render:** New → Blueprint → этот репозиторий (`render.yaml`). Задайте `MONGODB_URI` (Atlas), `CLIENT_ORIGIN` (адрес клиента на Vercel), `ADMIN_EMAIL`, `ADMIN_PASSWORD`. `JWT_SECRET` сгенерируется сам. После первого запуска выполните `npm run seed:prod` в Shell (по желанию).

**Docker (любой сервер/Railway/Fly):**
```bash
docker build -t clean-kitchen-api .
docker run -p 4000:4000 --env-file .env clean-kitchen-api
```

**Клиент:** в Vercel добавьте переменную `VITE_API_URL=https://<адрес-api>` (без `/api` на конце — см. README клиента) и пересоберите.

## Основные эндпоинты
`GET /api/health` · `POST /api/auth/login` · `GET /api/recipes?limit=200` (опубликованные — публично) · `POST /api/recipes` · `POST /api/recipes/import-draft` (admin/manager, всегда `draft`) · `GET /api/qr/:id` · `GET /api/categories` · `/api/users`, `/api/ocr`. Подробнее — `docs/API.md`.

## Безопасность
- `.env` в git не хранится; смените `ADMIN_PASSWORD` после первого входа.
- Вход ограничен rate-limit (20 попыток / 15 мин), OCR — 10 запросов в минуту.

## Голосовое распознавание (`/api/voice`)

- `GET /api/voice/status` — включено ли серверное распознавание.
- `POST /api/voice/transcribe?lang=ru` — тело `audio/wav` (16 кГц), ответ `{ text }`. Отсекает тишину и типичные «галлюцинации» Whisper, подсказывает модели названия блюд из базы.
- Включение: в `.env` задать `STT_API_KEY` (по умолчанию Groq, модель `whisper-large-v3`; для OpenAI-совместимых сервисов — `STT_API_URL` и `STT_MODEL`). Лимит 30 запросов в минуту.
- Точность зависит от провайдера; на живой речи с акцентами не проверялась.

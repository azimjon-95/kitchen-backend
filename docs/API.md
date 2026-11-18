# Clean Kitchen API — V3

Base URL: `http://localhost:4000`

## Health
- `GET /api/health`
- `GET /api`

## Authentication
- `POST /api/auth/login` — `{ "email": "...", "password": "..." }`
- `GET /api/auth/me` — Bearer token

## Recipes
- `GET /api/recipes?q=&category=&status=&page=&limit=` — public requests return published cards; authenticated requests can request status.
- `GET /api/recipes/:id`
- `POST /api/recipes` — admin/manager
- `PATCH /api/recipes/:id` — admin/manager
- `DELETE /api/recipes/:id` — admin; archives the card

## Categories
- `GET /api/categories`
- `POST /api/categories` — admin/manager
- `DELETE /api/categories/:id` — admin

## Users
- `GET /api/users` — admin/manager
- `POST /api/users` — admin
- `PATCH /api/users/:id/active` — admin

All protected routes require `Authorization: Bearer <token>`.


## Умный поиск
`GET /api/recipes/smart-search?q=<текст>&limit=20` — поиск по названию, категории, описанию, ингредиентам и aliases с ранжированием, синонимами RU/UZ и допуском опечаток.


## Редактирование технологических карт (V6)
- `POST /api/recipes` — создать карту с ингредиентами и шагами.
- `PATCH /api/recipes/:id` — изменить поля, ингредиенты, шаги, aliases или статус `draft/published`.
- `DELETE /api/recipes/:id` — архивировать карту (только admin).
- `GET /api/recipes/:id` — получить полную карту; черновики доступны только admin/manager.


## Food Cost (V7)
Recipe ingredient objects accept `pricePerUnit` (numeric, price for the selected `unit`). Recipe objects accept `portionCount`, `yieldQuantity`, and `yieldUnit`. Recipe responses include `cost.total`, `cost.perPortion`, `cost.lines`, `cost.complete`, and `costCurrency`. Calculation uses `gross` quantity, falling back to `net`; quantities and prices must use the same unit. Project currency is set by `COST_CURRENCY`.


## Recipe scaling data (V8)
Recipe responses include `portionCount`, `yieldQuantity`, and `yieldUnit` alongside ingredient `gross`, `net`, and `unit` fields. Scaling is performed client-side for the requested portion count; the stored recipe is not modified.


## Recipe media (V9)
Recipe documents and responses may include `imageUrl` (HTTPS URL) and each step may include `imageUrl`. These are optional display URLs; V9 does not upload files or manage media storage.

## V11 Version History

### GET /api/recipes/:id/history
Returns list of previous versions (admin/manager).

### GET /api/recipes/:id/history/:version
Returns full snapshot of a specific version.

### POST /api/recipes/:id/restore/:version
Restores recipe to that version (admin only). Current state is saved before restore.

## V12 Import foundation

### POST /api/recipes/import-draft
Creates a **draft** recipe from structured payload (OCR result or manual).
Never auto-publishes. Requires admin/manager role.

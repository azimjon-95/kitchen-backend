# Установка на VPS (Contabo и любой Ubuntu/Debian) — одна команда

```bash
curl -fsSL https://raw.githubusercontent.com/azimjon-95/kitchen-backend/main/deploy/install.sh | sudo bash -s -- --domain kitchen.example.com
```

- Без `--domain` сайт получит адрес `1-2-3-4.sslip.io` (по IP сервера) с настоящим HTTPS.
- Для своего домена сначала создайте DNS-запись **A** → IP сервера.
- Если репозитории приватные: добавьте `--git-token <github-token>` (токен не сохраняется на диске).
- Повторный запуск той же команды = обновление. Пароли, база и сертификаты сохраняются.
- Данные входа Super Admin: `sudo cat /opt/clean-kitchen/CREDENTIALS.txt`.

## Что поднимается

| Сервис | Назначение | Наружу | Интернет | Лимиты |
|---|---|---|---|---|
| web (Caddy) | сайт + HTTPS + прокси `/api` | 80/443 | да | 200 МБ |
| api (Node) | API, авторизация, RBAC | нет | да (резервный Whisper) | 1 CPU, 600 МБ |
| stt (GigaAM) | распознавание речи | нет | **нет** | 2 CPU, 3 ГБ |
| mongo | база (с паролем) | нет | нет | 900 МБ |
| redis | кэш, лимиты (с паролем) | нет | нет | 160 МБ |

Итого ≈ 5 ГБ в пике. На VPS с 8 ГБ остаётся место для других ваших программ; на 4 ГБ скрипт добавит swap.

## Безопасность

- Сайт и API на одном домене: refresh-cookie первой стороны (`HttpOnly`, `Secure`, `SameSite=Lax`) — работает в Safari/iOS и Telegram WebView, где сторонние cookie блокируются.
- Контейнеры без root, файловая система только для чтения, `no-new-privileges`, все Linux-capabilities сняты (api, stt).
- Сервис речи в сети без выхода в интернет; модель скачивается при сборке, код GigaAM закреплён на коммите.
- Брандмауэр: открыты только SSH, 80, 443. MongoDB и Redis наружу не публикуются и защищены паролями.
- Заголовки: HSTS, CSP, запрет встраивания во фреймы, `nosniff`.
- Распознавание речи — только для вошедших пользователей.
- Защита техкарт: изоляция ресторанов, лимит массовых выгрузок для сотрудников (превышение → 429 и запись в журнал), водяной знак с email сотрудника, запрет копирования и печати без права экспорта.
- Резервная копия базы каждый день в 03:30 в `/opt/clean-kitchen/backups` (хранится 14 дней). Копируйте её и за пределы сервера.

## Если на сервере уже есть сайт (nginx на 80/443)

Скрипт это обнаружит, поставит Clean Kitchen на `127.0.0.1:8088` и покажет блок `location` для вашего nginx.

## Полезное

```bash
cd /opt/clean-kitchen/backend
docker compose -f deploy/docker-compose.prod.yml --env-file deploy/.compose.env ps
docker compose -f deploy/docker-compose.prod.yml --env-file deploy/.compose.env logs -f stt   # время распознавания каждого запроса
```

Быстрее, чуть менее точно: повторите установку с `--int8` или задайте `GIGAAM_MODEL=v3_e2e_ctc` в `.env`.

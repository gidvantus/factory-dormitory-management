# Кабинет оператора

Отдельное приложение рядом с основным кабинетом: вход по логину и паролю из
конфига и пустая страница после входа. Своей базы, ролей и данных у кабинета
нет — в этой задаче он не делает ни одного запроса в основной API.

## Что где лежит

```
operator/
├── backend/            — FastAPI: вход, проверка сессии, выход, health
│   ├── app/            — config.py, security.py, schemas.py, main.py, api/
│   ├── tests/          — pytest
│   └── Dockerfile
└── frontend/           — React + TypeScript + vite: форма входа и пустая страница
    ├── src/            — api/, auth/, components/, pages/, test/
    ├── nginx.conf      — статика SPA и прокси /api/ в operator-api
    └── Dockerfile
```

Оба сервиса объявлены в корневом `docker-compose.yml` — `operator-api` и
`operator-web`, без профиля: стенд поднимается одной командой, как раньше.

## Как поднять

```bash
docker compose up -d --build
```

Правка `.env` не нужна: умолчаний из `.env.example` достаточно, если порты
свободны.

Адреса по умолчанию:

- кабинет оператора — http://localhost:8081 (`operator-web`);
- API кабинета — http://localhost:8002 (`operator-api`);
- health обоих: `GET /healthz` у фронтенда и `GET /api/health` у API.

Если стендов на машине несколько, запускайте свой под отдельным именем
(`docker compose -p <имя> ...`): имя проекта и порты у каждого стенда свои.
Имя проекта Docker принимает только строчными буквами.

## Переменные `.env`

| Переменная | Значение по умолчанию | Что значит |
| --- | --- | --- |
| `OPERATOR_USERNAME` | `operator` | логин единственного оператора; не секрет |
| `OPERATOR_PASSWORD` | нет (в примере `change-me`) | пароль оператора; без него сервис не стартует |
| `OPERATOR_TOKEN_SECRET` | нет (в примере заглушка) | секрет подписи сессии кабинета, не короче 16 символов; **не** `JWT_SECRET` основного приложения |
| `OPERATOR_TOKEN_TTL_HOURS` | `12` | срок жизни сессии в часах; он же уходит в `Max-Age` cookie |
| `OPERATOR_SESSION_COOKIE_SECURE` | `false` | отдавать cookie только по https |
| `OPERATOR_API_PORT` | `8002` | порт API кабинета на хосте |
| `OPERATOR_FRONTEND_PORT` | `8081` | порт фронтенда кабинета на хосте |

Реальные значения `OPERATOR_PASSWORD` и `OPERATOR_TOKEN_SECRET` в репозитории не
хранятся: `.env.example` держит имена и заглушки, свои значения кладутся в `.env`.
На боевом стенде порты публикуются на `127.0.0.1` (см. `docs/ssl.md`).

## Контракт API

Всё под префиксом `/api` того же origin: nginx кабинета проксирует `/api/` в
`operator-api:8000`, поэтому cookie остаётся first-party. Схема — `/openapi.json`
и `/docs` на `operator-api`.

| Метод | Путь | Ответ |
| --- | --- | --- |
| `POST` | `/api/auth/login` | `200 {"username": "operator"}` и `Set-Cookie: operator_session=…; HttpOnly; SameSite=lax; Path=/; Max-Age=43200`; неверная пара — `401 {"detail": "Неверный логин или пароль"}` (один текст на неверный логин и неверный пароль) |
| `GET` | `/api/auth/me` | `200 {"username": "operator"}` или `401 {"detail": "Требуется авторизация"}` |
| `POST` | `/api/auth/logout` | `204` без тела, cookie гасится теми же атрибутами; без сессии — тоже `204` |
| `GET` | `/api/health` | `200 {"status": "ok"}` |

Сессия — httpOnly cookie `operator_session`, в JS токена нет.

## Фронтенд

Маршруты:

- `/login` — форма входа: логин и пароль, ничего больше (восстановления пароля и
  регистрации у кабинета нет);
- `/` — пустая страница под `RequireOperator`: при монтировании `GET /api/auth/me`,
  пока ждём — «Проверяем сессию…», `401` — редирект на `/login`;
- остальные адреса редиректят на `/`.

Состояния формы: пусто; отправка (кнопка неактивна, «Вход…»); клиентская проверка
пустых полей («Укажите логин», «Укажите пароль», запрос не уходит); отказ сервера —
текст `detail` дословно в `role="alert"`; сеть/`5xx` — «Не удалось войти.
Попробуйте ещё раз».

Для тестировщика — ровно шесть `data-testid`: `operator-login-username`,
`operator-login-password`, `operator-login-submit`, `operator-login-error`,
`operator-home`, `operator-logout`.

Dev-режим без контейнеров:

```bash
cd operator/frontend
npm ci
npm run dev
```

Vite проксирует `/api` на `http://localhost:8002` (порт `operator-api` по
умолчанию); другой адрес задаётся переменной `VITE_API_PROXY_TARGET`, а не правкой
конфига.

Оформление — «natural neutral» из макета (`mockups/126/`): свои токены в
`operator/frontend/src/index.css`, продуктовые стили `app/frontend` не
переиспользуются. Шрифты — системный стек, по сети ничего не грузится.

## Проверки

Бэкенд:

```bash
docker compose exec operator-api python -m pytest
docker compose exec operator-api ruff check .
docker compose exec operator-api mypy .
```

Фронтенд — из `operator/frontend`:

```bash
npm ci
npm run build      # tsc --noEmit && vite build
npm run lint       # eslint .
npx prettier --check .
npm run test       # vitest run
```

## Чего здесь нет

- Запросов в основной API и CORS: кабинет в этой задаче не обменивается данными с
  основным кабинетом, обмен — отдельная задача.
- Своей базы, alembic и миграций.
- Ролей, второго оператора, восстановления пароля, «запомнить меня», меню и
  разделов кабинета.
- TLS, домена и маршрута в caddy: профиль `tls` кабинет не затрагивает.

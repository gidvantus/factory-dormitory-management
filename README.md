# CRM Dormitory

Проект для учёта рабочих на общежитиях.

## Назначение

CRM-система ведёт учёт рабочих, проживающих в общежитиях: заселение и выселение,
распределение по комнатам и местам, кадровые и бытовые данные. Система нужна
комендантам и кадровой службе, чтобы видеть актуальную занятость мест и историю
проживания.

## Возможности

- реестр рабочих: карточка, подразделение, статус;
- реестр общежитий: здания, комнаты, места;
- заселение, переселение и выселение с историей;
- отчётность по занятости мест.

## Стек

- **Backend** — FastAPI (Python).
- **Frontend** — React + TypeScript.
- **База данных** — PostgreSQL, запуск через Docker Compose.

## Структура

```
.
├── app/
│   ├── backend/          — FastAPI: app/, alembic/, tests/, Dockerfile
│   └── frontend/         — React + TypeScript: src/, Dockerfile, nginx.conf
├── docker-compose.yml    — стенд: db + api + web
├── .env.example          — значения стенда по умолчанию (.env переопределяет)
└── README.md
```

## Запуск стенда

```bash
docker compose up -d --build
```

Адреса по умолчанию:

- Frontend — http://localhost:8080
- API — http://localhost:8001

Если на машине несколько стендов проекта, запускайте свой под отдельным именем,
чтобы не задеть контейнеры и том базы соседнего стенда:

```bash
docker compose -p <имя-стенда> up -d --build
```

## Проверки кода

Backend — из `app/backend`:

```bash
ruff check .
ruff format --check .
mypy .
pytest -q
```

Frontend — из `app/frontend`:

```bash
tsc --noEmit
eslint .
prettier --check .
vitest run
```

## Процесс работы

- Базовая ветка — `main`, напрямую в неё не коммитят.
- Задача берётся из issue с меткой `ready-for-dev`; ветка задачи —
  `feature/<номер>-<краткий-слаг>`, например `feature/1-readme`.
- Итог оформляется pull request в `main`; мерж делает человек.
- После открытия pull request issue получает метку `ready-for-test`.
- Разработчик отвечает за статический анализ и юнит-тесты; E2E-проверки
  (Playwright), визуальные эталоны и отчёты о доступности — за тестировщиком.

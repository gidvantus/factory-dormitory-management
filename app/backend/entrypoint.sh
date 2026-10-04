#!/bin/sh
# Старт api: сначала миграции, потом сервер.
# Готовность базы гарантирует healthcheck сервиса db в docker-compose.yml.
set -e

echo "Применяю миграции базы данных..."
alembic upgrade head

echo "Запускаю api на порту 8000..."
exec uvicorn app.main:app --host 0.0.0.0 --port 8000

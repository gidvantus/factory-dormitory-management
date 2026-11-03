FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app

# Сначала зависимости: слой pip переиспользуется, пока не менялся pyproject.toml.
# Пакет ставится editable, чтобы правки в ./app подхватывались без пересборки.
COPY pyproject.toml ./
COPY app ./app
RUN pip install --no-cache-dir -e ".[dev]"

# Тесты лежат в образе: стенд прогоняет их внутри контейнера
# (`docker compose exec operator-api python -m pytest`).
COPY tests ./tests

# Миграций и точки входа нет: кабинету нечего применять к базе — базы у него нет.
EXPOSE 8000

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]

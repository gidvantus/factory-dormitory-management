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

COPY alembic.ini ./
COPY alembic ./alembic
COPY tests ./tests
COPY entrypoint.sh ./
RUN chmod +x ./entrypoint.sh

EXPOSE 8000

CMD ["./entrypoint.sh"]

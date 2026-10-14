FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app

# Шрифт для PDF-форм счёта и акта: в core-шрифтах PDF кириллицы нет, поэтому
# DejaVu Sans приходит из пакета Debian, а не из git. Отдельным слоем: список
# пакетов не сбрасывается при каждой правке исходников.
RUN apt-get update \
    && apt-get install -y --no-install-recommends fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/*

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

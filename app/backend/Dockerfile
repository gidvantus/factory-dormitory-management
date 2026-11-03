# syntax=docker/dockerfile:1
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

# Зависимости ставит отдельный слой, и его содержимое зависит ТОЛЬКО от
# pyproject.toml: `COPY app ./app` идёт ниже, поэтому правка любого файла в app/
# не сбрасывает этот слой и не тянет PyPI заново.
# setuptools считает метаданные пакета на этапе установки (`pip install -e`),
# то есть ему нужен каталог app/ — имена и версии зависимостей берутся из
# pyproject.toml, а не из кода. Поэтому вместо настоящих исходников кладётся
# заглушка app/__init__.py: настоящий `COPY app ./app` ниже перезапишет её.
# `-e` (editable) остаётся: пакет подключается ссылкой на /app/app, поэтому
# правки в ./app подхватываются без переустановки зависимостей. Кэш pip
# монтируется из билдера (BuildKit): без него `--no-cache-dir` отключал бы ровно
# тот кэш, который нужен; с маунтом скачивание переживает сброс этого слоя.
COPY pyproject.toml ./
RUN --mount=type=cache,target=/root/.cache/pip \
    mkdir -p app && touch app/__init__.py \
    && pip install -e ".[dev]"

# Исходники — после зависимостей: меняется только этот слой и те, что ниже.
COPY app ./app

COPY alembic.ini ./
COPY alembic ./alembic
COPY tests ./tests
COPY entrypoint.sh ./
RUN chmod +x ./entrypoint.sh

EXPOSE 8000

CMD ["./entrypoint.sh"]

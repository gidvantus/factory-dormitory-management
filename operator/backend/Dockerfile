FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app

# Зависимости ставит отдельный слой, и его содержимое зависит ТОЛЬКО от
# pyproject.toml: `COPY app ./app` идёт ниже, поэтому правка любого файла в app/
# не сбрасывает этот слой и не тянет PyPI заново.
# setuptools считает метаданные пакета на этапе установки (`pip install -e`),
# то есть ему нужен каталог app/ — имена и версии зависимостей берутся из
# pyproject.toml, а не из кода. Поэтому вместо настоящих исходников кладётся
# заглушка app/__init__.py: настоящий `COPY app ./app` ниже перезапишет её.
# `-e` (editable) остаётся: пакет подключается ссылкой на /app/app, поэтому
# правки в ./app подхватываются без переустановки зависимостей.
# Только штатные инструкции и обычный `docker compose build`: ни `--mount`, ни
# директивы `# syntax` здесь нет, поэтому шагу сборки на сервере BuildKit не
# нужен сверх того, что уже требуется сегодня.
COPY pyproject.toml ./
RUN mkdir -p app && touch app/__init__.py \
    && pip install --no-cache-dir -e ".[dev]"

# Исходники — после зависимостей: меняется только этот слой и те, что ниже.
COPY app ./app

# Тесты лежат в образе: стенд прогоняет их внутри контейнера
# (`docker compose exec operator-api python -m pytest`).
COPY tests ./tests

# Миграций и точки входа нет: кабинету нечего применять к базе — базы у него нет.
EXPOSE 8000

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]

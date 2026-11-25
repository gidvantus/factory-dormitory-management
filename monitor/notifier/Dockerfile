# Notifier: Alertmanager → Telegram и вечерняя сводка (docs/monitoring.md).
#
# Свой маленький образ, а не сторонний: webhook Alertmanager разбирается
# пятьюдесятью строками, а сводку за сутки не умеет ни один готовый образ.
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

EXPOSE 9087

CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "9087"]

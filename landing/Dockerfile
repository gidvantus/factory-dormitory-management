# Образ для статичного лендинга «Домовой».
# Сборка из каталога landing:
#   docker build -t domovoy-landing:local .
FROM nginx:1.27-alpine

LABEL org.opencontainers.image.title="domovoy-landing" \
      org.opencontainers.image.description="Статичный лендинг CRM для учёта рабочих, проживающих в общежитиях" \
      org.opencontainers.image.source="https://github.com/gidvantus/factory-dormitory-management"

COPY nginx.conf /etc/nginx/conf.d/default.conf

COPY index.html styles.css /usr/share/nginx/html/
COPY assets/ /usr/share/nginx/html/assets/

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD wget -qO- http://127.0.0.1/healthz >/dev/null 2>&1 || exit 1

CMD ["nginx", "-g", "daemon off;"]

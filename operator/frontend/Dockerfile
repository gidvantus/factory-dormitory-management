# Сборка: зависимости отдельным слоем, чтобы правки в src не пересобирали npm ci.
# `npm ci` требует закоммиченного package-lock.json — он в репозитории.
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# dev-стадия: в ней гоняются tsc/eslint/prettier/vitest и живёт `vite dev`.
FROM deps AS dev
COPY . .
EXPOSE 5174
CMD ["npm", "run", "dev", "--", "--host", "0.0.0.0"]

FROM deps AS build
COPY . .
RUN npm run build

# Раздача статики и проксирование /api в operator-api: кабинет ходит на свой же
# origin, поэтому cookie сессии остаётся first-party.
FROM nginx:1.27-alpine AS web
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80

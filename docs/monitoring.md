# Мониторинг, алерты и вечерняя сводка

Боевой CRM Dormitory смотрит за собой сам: метрики приложения, ресурсы
сервера и контейнеров, алерты в Telegram и раз в сутки — короткая сводка
«как прошёл день». Всё это лежит в каталоге `monitor/` и поднимается отдельным
compose-проектом, а не вместе с приложением: мониторинг нужен и тогда, когда
код не менялся, и не должен падать вместе с тем, за чем он смотрит.

```
  api:8000/metrics ─┐
  node-exporter  ───┼─→ Prometheus ─→ Alertmanager ─→ notifier ─→ Telegram
  docker-stats   ───┘         │                          ↑
                              └────→ Grafana ←── Caddy ───┘ (https://monitor.<домен>)
```

Три части, которые видит человек:

* **Grafana** — `https://monitor.<SITE_DOMAIN>`, два дашборда: «API: ошибки и
  скорость» и «Сервер и контейнеры». Закрыта логином и паролем.
* **Алерты** — сообщение в Telegram, когда что-то сломалось или починилось.
* **Сводка** — раз в сутки в 18:00 по Москве: трафик, ошибки, скорость,
  ресурсы, диск, размер базы, кто не в строю.

## Доступ

Адрес — `https://monitor.<SITE_DOMAIN>` (на бою `https://monitor.dmv-crm.ru`).
Два замка подряд, оба на одном пароле:

1. **basic auth Caddy** — логин и bcrypt-хеш пароля из `.env` сервера
   (`MONITOR_BASIC_AUTH_USER`, `MONITOR_BASIC_AUTH_HASH`). Проверяется до
   Grafana: без пары запрос получает `401` и до приложения не доходит.
2. **Вход в Grafana** — `admin` и тот же пароль (`GRAFANA_ADMIN_PASSWORD`
   в `monitor/.env`).

Пара генерируется один раз при первом запуске
[`.github/workflows/deploy-monitoring.yml`](../.github/workflows/deploy-monitoring.yml)
и живёт в двух файлах на сервере:

```
/srv/crm-dormitory/.env            MONITOR_BASIC_AUTH_USER / MONITOR_BASIC_AUTH_HASH
/srv/crm-dormitory/monitor/.env    GRAFANA_ADMIN_USER / GRAFANA_ADMIN_PASSWORD
```

Пароль с сервера забирается так (он нигде не печатается в логи):

```bash
ssh crm-monitor "sed -n 's/^GRAFANA_ADMIN_PASSWORD=//p' /srv/crm-dormitory/monitor/.env"
```

**Забыли пароль.** Удалите пару и запустите деплой мониторинга снова — он
создаст новую:

```bash
ssh crm-monitor "cd /srv/crm-dormitory && sed -i '/^MONITOR_BASIC_AUTH_HASH=/d' .env"
```

**Сменить пароль руками.** Замков два, и меняются они по отдельности.

1. **Вход на поддомен (basic auth Caddy).** Новый хеш печатает
   `caddy hash-password` (пароль передаётся через stdin, в историю команд он
   не попадает), затем строка `MONITOR_BASIC_AUTH_HASH=` в `.env` сервера
   заменяется на новую, и Caddy перезапускается с новым окружением. Команды
   выполняются **в сессии на сервере** (`ssh crm-monitor`), а не одной строкой
   снаружи: в них есть и `$$`, и кавычки, и снаружи они разваливаются:

   ```bash
   # на сервере
   cd /srv/crm-dormitory
   read -rs -p "новый пароль: " PW        # ввод не отображается на экране
   HASH="$(printf '%s\n' "$PW" | docker run --rm -i caddy:2-alpine caddy hash-password)"
   ESCAPED="$(printf '%s' "$HASH" | sed 's/\$/$$/g')"   # без этого хеш не доедет
   sed -i '/^MONITOR_BASIC_AUTH_HASH=/d' .env
   printf 'MONITOR_BASIC_AUTH_HASH=%s\n' "$ESCAPED" >> .env
   unset PW HASH ESCAPED
   docker compose --profile tls up -d --no-deps caddy
   ```

   `$$` — не опечатка. Compose интерполирует `$` в значениях `.env`, а
   bcrypt-хеш почти целиком из них состоит: с одиночными `$` в контейнер
   приезжает обрезанный `$2a$14.…`, caddy стартует, и **верный пароль не
   подходит** — поддомен отвечает `401` всем. Проверить, что доехало именно то,
   что нужно: `docker compose --profile tls run --rm --no-deps --entrypoint env caddy`
   → в строке `MONITOR_BASIC_AUTH_HASH` должно быть ровно 60 символов.

   Именно перезапуск: `caddy reload` перечитывает только `Caddyfile`, а хеш
   лежит в окружении контейнера. Заодно обновите `GRAFANA_ADMIN_PASSWORD` в
   `monitor/.env` — пароль удобно держать один.

2. **Вход в Grafana.** `GRAFANA_ADMIN_PASSWORD` в `monitor/.env` — и
   пересоздать только Grafana (остальной стек не трогается):

   ```bash
   ssh crm-monitor "cd /srv/crm-dormitory && \
     nano monitor/.env && \
     docker compose -f monitor/docker-compose.monitor.yml --env-file monitor/.env up -d grafana"
   ```

   `GF_SECURITY_ADMIN_PASSWORD` Grafana применяет к существующей учётной записи
   админа только при пересоздании контейнера, поэтому именно `up -d grafana`,
   а не правка через интерфейс: пароль в интерфейсе разойдётся с файлом, и
   следующий деплой вернёт пароль из `monitor/.env`.

Хеш в репозитории (`.env.example`, `caddy/Caddyfile`) — **заглушка**: bcrypt
случайной строки, которую не знает никто. Подобрать её нечем, войти по ней
нельзя — это страховка от пустого значения, а не «пароль по умолчанию».

## Запуск на сервере

Эксплуатационный путь — workflow, а не ssh-сессии:

> Actions → **«Деплой мониторинга»** → *Run workflow* (ветка `main`).

Он делает всё сам и повторяемо:

1. проверяет, что запущен из `main`, и что заданы те же `CRM_SSH_*`, что у
   деплоя и бэкапа;
2. читает `SITE_DOMAIN` и `ACME_EMAIL` из `.env` сервера и **сверяет**
   получившийся адрес с ожидаемым `monitor.dmv-crm.ru`: сертификат
   выпускается только на имя, у которого есть A-запись, и тратить лимиты
   Let's Encrypt на опечатку незачем;
3. раскладывает `monitor/`, `caddy/` и `.env.example`, **не трогая** ни код
   приложения, ни базу, ни основной `.env`;
4. создаёт пару входа, если её нет (идемпотентно: повторный запуск значения
   не меняет);
5. собирает образы `notifier` и `docker-stats-exporter` и поднимает стек
   `crm-dormitory-monitor`;
6. проверяет, что **ни один порт мониторинга не опубликован** на хост;
7. ждёт, пока Prometheus увидит `up{job="api"} == 1` — то есть весь шов
   «Prometheus → `api:8000/metrics`», а не просто «контейнеры запущены», и
   проверяет изнутри сети, что Grafana отвечает `200` на `api/health`
   (второй конец шва: `grafana:3000` для Caddy);
8. прогоняет `caddy validate` с новым `.env` **до** перезапуска Caddy: если
   конфиг не принят, основной кабинет продолжает работать на старом;
9. перезапускает Caddy (не `reload`: пароль блок `monitor.` читает из
   окружения контейнера, а `reload` перечитывает только файл);
10. проверяет, что основной домен жив, что поддомен без пары отвечает `401`,
    а с парой — `200`/`302`;
11. читает сертификат и предупреждает, если он ещё не выпустился.

Порядок первого раза: сначала обычный деплой (`deploy.yml`) — он обновляет
`caddy/Caddyfile` и `.env` основного стека, — потом деплой мониторинга.

## Стенд отдела разработки

Локально стек поднимается тем же compose-файлом, со своим именем
compose-проекта (`name: crm-dormitory-monitor` в самом файле):

```bash
cp monitor/.env.example monitor/.env     # один раз
docker compose -f monitor/docker-compose.monitor.yml \
    --env-file monitor/.env up -d --build
docker compose -f monitor/docker-compose.monitor.yml --env-file monitor/.env ps
```

`--env-file` обязателен: без него compose подхватит корневой `.env`
основного приложения (пароли базы, `JWT_SECRET`) — мониторингу они не нужны,
а часть `${...}` из его шаблона в мониторинге не определена.

Что подкрутить на стенде:

* `APP_NETWORK` — сеть основного стека. На сервере это
  `<COMPOSE_PROJECT_NAME>_default` (`crm-dormitory_default`), у стенда отдела
  имя проекта своё: `docker network ls` покажет.
* `MONITOR_HOST` — адрес для Grafana: без него Grafana в 11-й версии ругается
  на `origin not allowed` и не пускает в интерфейс.
* Порты на стенде публиковать не нужно: в Grafana заходим через Caddy или
  через `docker compose exec`.

Остановить и убрать (тома с историей Prometheus и дашбордами удаляются
только с `-v`, данные приложения это не затрагивает):

```bash
docker compose -f monitor/docker-compose.monitor.yml --env-file monitor/.env down
```

## Что собирается

### Метрики приложения

Отдаёт сам API: `GET http://api:8000/metrics`, `text/plain; version=0.0.4`.
Реализация — `app/backend/app/metrics.py`, подключение — `app/backend/app/main.py`.
Это **контракт**: имена метрик и метки — часть API, их нельзя переименовать,
не поправив правила алертов и сводку.

| Метрика | Тип | Метки | Смысл |
| --- | --- | --- | --- |
| `http_requests_total` | counter | `method`, `status`, `route` | число запросов |
| `http_request_duration_seconds` | histogram | `method`, `route` | время ответа, бакеты 5 мс … 10 с |
| `db_size_bytes` | gauge | — | размер базы, обновляется лениво раз в 30 с |

`route` — шаблон маршрута (`/api/students/{student_id}`), а не живой URL:
иначе каждый идентификатор заводил бы новую серию и Prometheus рос бы без
границ. Запрос, не попавший ни в один маршрут, считается как `unmatched`.

Чего в метриках нет: `/metrics` не считает сам себя (запросы к нему не
попадают в `http_requests_total`), а эндпоинт не публикуется наружу — nginx
фронта проксирует только `/api/`, порт `api` на сервере слушает loopback.

Проверка шва руками (из контейнера в сети основного стека):

```bash
docker compose -p crm-dormitory exec -T api \
  python -c "import urllib.request; print(urllib.request.urlopen('http://127.0.0.1:8000/metrics').read(200).decode())"
```

### Метрики сервера и контейнеров

* `node-exporter` — CPU, память, диск хоста (`node_*`).
* `docker-stats-exporter` (`monitor/docker-stats-exporter/`) — данные из
  docker API через `/var/run/docker.sock`: `container_cpu_percent`,
  `container_memory_usage_bytes`, `container_memory_limit_bytes`,
  `container_network_rx_bytes_total`, `container_network_tx_bytes_total`,
  `container_last_seen`. Метка `service` — имя сервиса compose, поэтому
  алерты и графики говорят «api», «db», «caddy», а не «a1b2c3d4».

## Алерты

Правила — `monitor/prometheus/alerts.yml`, маршрут —
`monitor/alertmanager/alertmanager.yml` (webhook в `notifier:9087/alert`).
Группировка по `alertname`, `job`, `service`; первый пакет уходит через 30 с,
повтор о непотушенном — раз в 4 часа. Восстановление тоже приходит
(«✅ Восстановлено»).

| Алерт | Когда | Ждёт | Уровень |
| --- | --- | --- | --- |
| `TargetDown` | `up == 0` — цель скрейпа не отвечает | 1 мин | critical |
| `ApiMetricsDown` | `up{job="api"} == 0` | 2 мин | critical |
| `ContainerStopped` | контейнер не подаёт признаков жизни (`container_last_seen`) | 2 мин | critical |
| `HighErrorRate` | доля 5xx больше 5 % | 5 мин | critical |
| `SlowRequests` | p95 времени ответа выше 2 с | 10 мин | warning |
| `ContainerHighCPU` | CPU контейнера выше 80 % | 5 мин | warning |
| `ContainerHighMemory` | память контейнера выше 90 % лимита | 5 мин | warning |
| `DiskLow` | свободно на `/` меньше 15 % | 10 мин | warning |

Уровень сейчас не меняет маршрут (канал один — личный Telegram), но остаётся
меткой в сообщении и в правилах: разделение на «пейджеру» и «в дашборд»
делается одной правкой `route`.

Проверить правила без запуска Prometheus:

```bash
docker run --rm --entrypoint promtool \
  -v "$PWD/monitor/prometheus:/etc/prometheus:ro" prom/prometheus:v2.53.0 \
  check rules /etc/prometheus/alerts.yml
```

## Уведомления в Telegram

Нужны две переменные в `monitor/.env`:

```env
MONITOR_TELEGRAM_BOT_TOKEN=123456:AA...
MONITOR_TELEGRAM_CHAT_ID=123456789
```

Токен можно взять у бота приложения (`TELEGRAM_BOT_TOKEN` в `.env` основного
стека) — это тот же бот; чат должен быть тот, куда бот имеет право писать.
После правки:

```bash
docker compose -f monitor/docker-compose.monitor.yml --env-file monitor/.env up -d notifier
```

**Пустой токен — рабочее состояние, а не ошибка.** Notifier тогда пишет
сообщение в свой лог, помечая его словом `АЛЕРТ`, и продолжает работать; ни
один алерт не теряется молча:

```bash
docker compose -f monitor/docker-compose.monitor.yml --env-file monitor/.env logs notifier | grep АЛЕРТ
```

Проверить доставку, не дожидаясь реального сбоя:

```bash
docker compose -f monitor/docker-compose.monitor.yml --env-file monitor/.env \
  exec -T notifier python -c "import urllib.request; urllib.request.urlopen(urllib.request.Request('http://127.0.0.1:9087/digest', data=b''))"
```

`POST /digest` собирает сводку и отправляет её сразу — этим же проверяют
текст после правок. `GET /health` — живость процесса (по нему compose
проверяет контейнер).

Ошибки отправки notifier логирует типом исключения, а не адресом: адрес Bot
API содержит токен, и печатать его в логи нельзя.

## Вечерняя сводка

Раз в сутки в `DIGEST_HOUR` (по умолчанию 18:00) по `DIGEST_TIMEZONE`
(`Europe/Moscow`) notifier спрашивает Prometheus и отправляет текст:

```
📊 Сводка CRM Dormitory за сутки (16.11.2026 18:00, Europe/Moscow)
• Запросов за сутки: 12 345, из них 5xx: 12 (0.1 %)
• Время ответа p95: 240 мс
• CPU контейнеров (среднее): api 12.0 %, db 3.1 %, caddy 0.2 %
• Память контейнеров (среднее): api 210 МиБ, db 95 МиБ, caddy 18 МиБ
• Свободно на /: 42.5 %
• Размер базы: 1.2 ГиБ
• Не в строю: никого
```

Если Prometheus недоступен или данных за сутки нет, в строке честно написано
«нет данных», а не ноль: ноль — это измеренное значение, и путать его с
«не знаю» нельзя. Если сводку не удалось собрать целиком, поток пишет
исключение в лог и продолжает жить — следующий день придёт как обычно.

Часовой пояс берётся из `zoneinfo`; если в образе нет базы часовых поясов,
работает запасное фиксированное смещение UTC+3 (Москва переходит на летнее
время не с 2014 года).

## Дашборды

Лежат в git и подключаются автоматически, править их в интерфейсе Grafana
бессмысленно — следующий деплой вернёт версию из репозитория:

```
monitor/grafana/dashboards/api.json         uid=crm-api          «API: ошибки и скорость»
monitor/grafana/dashboards/containers.json  uid=crm-containers   «Сервер и контейнеры»
monitor/grafana/provisioning/datasources/prometheus.yml  источник uid=prometheus
```

Панели отвечают на вопросы, которые задают при разборе инцидента: сколько
запросов и сколько из них 5xx, какие маршруты тормозят (p95), что с диском и
памятью, какой контейнер ел CPU, кто перезапускался, растёт ли база.

## Диагностика

| Симптом | Причина и что делать |
| --- | --- |
| `502` на поддомене | Стек мониторинга не запущен или в другой сети: `docker compose -f monitor/docker-compose.monitor.yml --env-file monitor/.env ps`, затем сверьте `APP_NETWORK` с `docker network ls`. |
| `401` при верном пароле | Caddy работает со старым окружением: `caddy reload` файл перечитывает, а переменные — нет. Лечится `docker compose --profile tls up -d --no-deps caddy`. |
| `401` всем сразу после ручной смены пароля | В `MONITOR_BASIC_AUTH_HASH` одиночные `$`: compose интерполирует их и обрезает хеш до `$2a$14.…`. Длина значения в контейнере (`docker compose --profile tls run --rm --no-deps --entrypoint env caddy`) должна быть 60 — если меньше, перепишите строку с удвоенными `$$` (см. «Сменить пароль руками»). |
| Пустые графики | Нет данных (`up{job=...}` = 0) или Grafana ругается на `origin not allowed` — сверьте `MONITOR_HOST` с реальным адресом. |
| Сводка только в логе | Не заданы `MONITOR_TELEGRAM_BOT_TOKEN`/`MONITOR_TELEGRAM_CHAT_ID`. |
| Алерты не приходят, хотя сбой есть | `docker compose ... logs alertmanager`: webhook не доставлен, если notifier не запущен. Правила проверяются `promtool check rules`. |
| Histogram пустой | Приложение не отдало ни одного запроса с момента старта: гистограмма появляется на первом запросе. |

Логи:

```bash
docker compose -f monitor/docker-compose.monitor.yml --env-file monitor/.env logs -f --tail=100
```

## Проверка перед pull request

Всё, что можно проверить без сервера, проверяется командами из корня
репозитория (они же — то, чем эти файлы проверялись):

```bash
# compose-файл: 6 сервисов, 3 тома, своё имя проекта, НИ ОДНОГО ports:
docker compose -f monitor/docker-compose.monitor.yml --env-file monitor/.env config

# правила Prometheus и маршрут Alertmanager
docker run --rm --entrypoint promtool \
  -v "$PWD/monitor/prometheus:/etc/prometheus:ro" prom/prometheus:v2.53.0 \
  check config /etc/prometheus/prometheus.yml
docker run --rm --entrypoint promtool \
  -v "$PWD/monitor/prometheus:/etc/prometheus:ro" prom/prometheus:v2.53.0 \
  check rules /etc/prometheus/alerts.yml
docker run --rm --entrypoint amtool \
  -v "$PWD/monitor/alertmanager:/etc/alertmanager:ro" prom/alertmanager:v0.27.0 \
  check-config /etc/alertmanager/alertmanager.yml

# Caddyfile с переменными мониторинга
docker run --rm --entrypoint caddy -e SITE_DOMAIN=example.org \
  -e MONITOR_BASIC_AUTH_USER=monitor -e MONITOR_BASIC_AUTH_HASH='$2a$14$...' \
  -e ACME_EMAIL=owner@example.org \
  -v "$PWD/caddy/Caddyfile:/etc/caddy/Caddyfile:ro" caddy:2-alpine \
  validate --config /etc/caddy/Caddyfile

# хеш доезжает до контейнера целиком: compose подставляет значения .env сам
docker compose --profile tls run --rm --no-deps --entrypoint env caddy \
  | sed -n 's/^MONITOR_BASIC_AUTH_HASH=//p' | wc -c   # 61 = 60 символов + перевод строки

# образы собираются и поднимаются, оба приложения отвечают
docker compose -f monitor/docker-compose.monitor.yml --env-file monitor/.env build
docker compose -f monitor/docker-compose.monitor.yml --env-file monitor/.env up -d
docker compose -f monitor/docker-compose.monitor.yml --env-file monitor/.env ps

# python стека — по правилам проекта (`ruff check`, `ruff format --check`)
```

Живость notifier проверяется его же обработчиками (`/health`), а формат
сообщений — `POST /digest` (см. выше). `docker-stats-exporter` работает и на
стенде отдела (Docker Desktop пробрасывает `/var/run/docker.sock`), но видит
контейнеры **всех** проектов хоста, поэтому в его сериях и в сводке рядом с
`crm-dormitory-*` появляются чужие имена, а остановленные чужие контейнеры
попадают в «не в строю». На сервере проект один, и шума нет.

## Чего здесь нет

* **Автовосстановления и дежурств.** Алерт — сообщение человеку, а не команда
  «перезапусти контейнер». Автоматика, которая сама лечит, ошибается быстрее,
  чем человек читает сообщение.
* **Логов и трассировки.** Loki и Jaeger в стек не входят: логи смотрятся
  `docker compose logs`, ошибки приложения — в его собственном логе.
* **Метрик бизнеса** (заявки, заселения). Слой `http_requests_total` отвечает
  на вопрос «работает ли», а не «сколько заселили»; для второго нужны
  отдельные счётчики в API и отдельная задача.
* **Мониторинга самой базы.** Есть размер базы (`db_size_bytes`), но нет
  `pg_stat_*`: медленные запросы разбираются по логам PostgreSQL.

## Изменения

- 2026-11-16 — мониторинг появился: `monitor/` (Prometheus, Grafana,
  Alertmanager, notifier, node-exporter, docker-stats-exporter), метрики API
  (`app/backend/app/metrics.py`, `GET /metrics`), поддомен
  `monitor.<SITE_DOMAIN>` с basic auth в `caddy/Caddyfile`, алерты и вечерняя
  сводка в Telegram, отдельный workflow `deploy-monitoring.yml`.

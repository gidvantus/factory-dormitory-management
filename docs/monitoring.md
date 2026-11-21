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

  логи контейнеров ─→ promtail ─→ Loki ─→ Grafana (история, поиск)
                   └─→ Dozzle ←── Caddy ──── (https://logs.<домен>, живьём)
```

Четыре части, которые видит человек:

* **Grafana** — `https://monitor.<SITE_DOMAIN>`, три дашборда: «API: ошибки и
  скорость», «Сервер и контейнеры» и «Логи и ошибки». Закрыта логином и паролем.
* **Логи** — `https://logs.<SITE_DOMAIN>`: живой поток логов всех контейнеров
  (Dozzle) и он же в Grafana как источник `Loki` — с поиском по истории.
  Закрыто логином и паролем.
* **Алерты** — сообщение в Telegram, когда что-то сломалось или починилось.
* **Сводка** — раз в сутки в 18:00 по Москве: трафик, ошибки, скорость,
  ресурсы, диск, размер базы, кто не в строю.

## Доступ

Два адреса, оба через Caddy основного стека:

| Адрес | Что открывается | Логин | Пароль |
| --- | --- | --- | --- |
| `https://monitor.<SITE_DOMAIN>` | Grafana: дашборды и алерты | `monitor` (basic auth) + `admin` (Grafana) | один и тот же |
| `https://logs.<SITE_DOMAIN>` | Dozzle: живой поток логов | `logs` (basic auth) | тот же, что у мониторинга |

**Почему у адресов разные логины, а пароль один.** Разный логин оставляет в
логе Caddy след, с какого адреса входили, а два пароля на два адреса одного
сервиса человек всё равно путает и начинает хранить их в блокноте. За Dozzle
при этом виден docker-сокет, то есть логи **всех** контейнеров хоста — поэтому
второй замок там не «для галочки», а такая же необходимость, как на `monitor.`.

На `monitor.` замков два, оба на одном пароле:

1. **basic auth Caddy** — логин и bcrypt-хеш пароля из `.env` сервера
   (`MONITOR_BASIC_AUTH_USER`, `MONITOR_BASIC_AUTH_HASH`; в файле хеш записан с
   удвоенными `$` — этого требует compose, см. «Сменить пароль руками»).
   Проверяется до Grafana: без пары запрос получает `401` и до приложения не
   доходит.
2. **Вход в Grafana** — `admin` и тот же пароль (`GRAFANA_ADMIN_PASSWORD`
   в `monitor/.env`).

Пара генерируется один раз при первом запуске
[`.github/workflows/deploy-monitoring.yml`](../.github/workflows/deploy-monitoring.yml)
и живёт в двух файлах на сервере (пары для `logs.` — зеркало той же, с другим
логином и тем же хешем):

```
/srv/crm-dormitory/.env            MONITOR_BASIC_AUTH_USER / MONITOR_BASIC_AUTH_HASH
                                   LOGS_BASIC_AUTH_USER / LOGS_BASIC_AUTH_HASH
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
   (второй конец шва: `grafana:3000` для Caddy), а Loki и Dozzle — на `/ready`
   и `/` (это то, до чего будет проксировать Caddy);
8. проверяет, что **логи действительно доехали**: спрашивает у Loki, видел ли он
   метку `service=api`. Это проверка всего шва «логи контейнера → promtail →
   Loki», а не «promtail запущен»;
9. прогоняет `caddy validate` с новым `.env` **до** перезапуска Caddy: если
   конфиг не принят, основной кабинет продолжает работать на старом;
10. перезапускает Caddy (не `reload`: пароли блоков `monitor.` и `logs.` читаются
    из окружения контейнера, а `reload` перечитывает только файл);
11. проверяет, что основной домен жив, что оба поддомена без пары отвечают
    `401`, а с парой — `200`/`302`;
12. читает сертификаты обоих поддоменов и предупреждает, если какой-то ещё не
    выпустился.

Порядок первого раза: сначала обычный деплой (`deploy.yml`) — он обновляет
`caddy/Caddyfile` и `.env` основного стека, — потом деплой мониторинга.

**`.env` сервера должен принадлежать пользователю деплоя.** Деплой мониторинга и
читает из него `SITE_DOMAIN` с `ACME_EMAIL`, и дописывает в него пару
`MONITOR_BASIC_AUTH_*`. Файл, оставшийся `root:root` (обычное следствие правки
через `sudo nano .env`), ломает это с двух сторон: без чтения деплой падал с
«SITE_DOMAIN пуст» и `sed: can't read .env: Permission denied`, без записи — с
`Permission denied` посреди генерации пары. Проверка прав стоит в начале шага
«Сервер: чек-лист `.env` и адреса мониторинга» и называет исправление; владелец
берётся у каталога проекта, он всегда принадлежит пользователю деплоя:

```bash
sudo chown --reference=/srv/crm-dormitory /srv/crm-dormitory/.env
sudo chmod 640 /srv/crm-dormitory/.env
```

## Стенд отдела разработки

Локально мониторинг поднимается теми же файлами, но с **оверрайдом портов**:
`monitor/docker-compose.local.yml`. Без него в интерфейс не попасть — на сервере
вход один, через Caddy с сертификатом, а локально Caddy нет.

### На клоне владельца — автоматически, вместе со стендом

Стенд из `.github/workflows/stand.yml` обновляет мониторинг сам, каждый раз
когда обновляется клон после мержа в `develop-m` (`docs/ci.md`, раздел
«Мониторинг на стенде»). Руками ничего делать не нужно — ни `cp .env.example`,
ни `up`:

* `monitor/.env` создаётся из шаблона при первом прогоне (файл не в git);
* каждый прогон пишет в него `MONITORED_PROJECT=<проект стенда>` и
  `APP_NETWORK=<проект стенда>_default`, а пустые `MONITOR_HOST` и
  `GRAFANA_ADMIN_PASSWORD` заполняет заглушками с `::warning::`;
* стек поднимается проектом `crm-dormitory-monitor` командой
  `docker compose -p crm-dormitory-monitor -f monitor/docker-compose.monitor.yml
  -f monitor/docker-compose.local.yml --env-file monitor/.env up -d --build
  --remove-orphans`;
* после подъёма job проверяет Grafana (`/api/health`), Dozzle (корень), Loki
  (`/ready`) и что у Loki уже есть метка `service=api`.

Занятый порт — это `::error::` до подъёма стека: чужие контейнеры ради порта не
останавливаются, порт меняется в `monitor/.env`. Исключение — порты, которые
держит сам `crm-dormitory-monitor` от прошлого прогона (grafana и dozzle живут
между прогонами): их job считает своими, пишет `held by our own stack …` и идёт
дальше — `compose up -d` пересоздаёт эти контейнеры. Иначе второй и каждый
следующий прогон падал бы на порте, занятом собственным стеком.

Ручные команды ниже нужны для **своего** стенда у роли отдела разработки
(проект `crm-dormitory-monitor-local`) и для отладки без GitHub.

```bash
cp monitor/.env.example monitor/.env     # один раз
docker compose -p crm-dormitory-monitor-local \
    -f monitor/docker-compose.monitor.yml \
    -f monitor/docker-compose.local.yml \
    --env-file monitor/.env up -d --build
docker compose -p crm-dormitory-monitor-local \
    -f monitor/docker-compose.monitor.yml \
    -f monitor/docker-compose.local.yml \
    --env-file monitor/.env ps
```

Куда смотреть (порты — из `MONITOR_GRAFANA_PORT` / `MONITOR_LOGS_PORT`,
по умолчанию 8095 и 8096):

| Адрес | Что это |
| --- | --- |
| <http://localhost:8095/> | Grafana: логин `admin`, пароль `GRAFANA_ADMIN_PASSWORD` из `monitor/.env` (в шаблоне — `monitor-stand-only-change-me`) |
| <http://localhost:8096/> | Dozzle: живой поток логов всех контейнеров стенда |

Если порт занят (`Bind for 127.0.0.1:8095 failed: port is already allocated`),
дефолт переопределяется в `monitor/.env`: `MONITOR_GRAFANA_PORT=18095` (и так же
`MONITOR_LOGS_PORT`). Причина — другой стек на той же машине: на стенде отдела
порт 8095 держит `workflow-agent-web`, и это не повод останавливать чужой
контейнер.

`-p crm-dormitory-monitor-local` в примере не случаен: имя проекта отделяет
стенд от боевого `crm-dormitory-monitor`, поэтому тома с историей Prometheus и
Loki у них разные. `127.0.0.1` в оверрайде — тоже не случайность: на этих
портах нет basic auth (его делает Caddy, которого локально нет), и `0.0.0.0`
отдал бы логи всех контейнеров любому в локальной сети.

`--env-file` обязателен: без него compose подхватит корневой `.env`
основного приложения (пароли базы, `JWT_SECRET`) — мониторингу они не нужны,
а часть `${...}` из его шаблона в мониторинге не определена.

Что подкрутить на стенде:

* `APP_NETWORK` — сеть основного стека. На сервере это
  `<COMPOSE_PROJECT_NAME>_default` (`crm-dormitory_default`), у стенда отдела
  имя проекта своё: `docker network ls` покажет.
* `MONITOR_HOST` — адрес для Grafana на бою. Локально его перекрывает оверрайд
  (`GF_SERVER_ROOT_URL: http://localhost:8095/`): с боевым адресом Grafana 11
  ответила бы `origin not allowed` и не пустила в интерфейс.
* `MONITORED_PROJECT` — имя проекта основного стека, чьи контейнеры собираются.
  На сервере его пишет деплой из `COMPOSE_PROJECT_NAME`; на стенде это имя
  проекта стенда (`docker compose -p … ps` покажет первое слово в имени
  контейнера). Неверное значение = пустые логи и пустой Dozzle при живом
  мониторинге.
* Порты на стенде публикует **только** `docker-compose.local.yml`. В основном
  файле `ports:` нет ни у одного сервиса, и деплой это проверяет.

Что нужно основному стеку, чтобы мониторинг видел данные: сеть
`<project>_default` и запущенный `api` (иначе `up{job="api"} == 0`). Метрики
хоста и контейнеров идут и без приложения.

Остановить и убрать (тома с историей Prometheus, Loki и дашбордами удаляются
только с `-v`, данные приложения это не затрагивает):

```bash
docker compose -p crm-dormitory-monitor-local \
    -f monitor/docker-compose.monitor.yml \
    -f monitor/docker-compose.local.yml \
    --env-file monitor/.env down
```

### Локально: свои данные, а не чужие

Стенд отдела не должен видеть человеческий. Два правила, из которых это
следует:

* `-p crm-dormitory-monitor-local` — свой compose-проект: свои контейнеры, свои
  тома, свои имена;
* `APP_NETWORK` указывает на сеть **своего** стека. Если в `monitor/.env`
  остался `crm-dormitory_default` (значение из шаблона), Prometheus со стенда
  пойдёт искать `api` в чужой сети и получит `up == 0` — это не поломка
  мониторинга, а неверный `APP_NETWORK`.
* `MONITORED_PROJECT` — имя проекта **своего** стека
  (`crm-dormitory-agent`), иначе фильтр не найдёт контейнеров и Grafana с
  Dozzle останутся пустыми, хотя сам мониторинг работает. Смотреть надо не на
  имя проекта мониторинга, а на имя проекта приложения: сборщики ищут именно
  его контейнеры.

Проще всего: взять имя сети из `docker compose -p crm-dormitory-agent ps` и
подставить в `APP_NETWORK` перед первым запуском.

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
| `http_request_sql_duration_seconds` | histogram | `method`, `route` | суммарное время SQL за запрос, бакеты 1 мс … 10 с |
| `http_sql_statements_total` | counter | `method`, `route` | число SQL-выполнений за запрос |

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

### Медленные SQL-запросы

Две метрики SQL отдаются тем же `GET /metrics` и по тем же правилам
(`app/backend/app/sql_diagnostics.py`): метка `route` — шаблон маршрута, ни
`request_id`, ни отпечаток шаблона в метки не попадают — их значения задаёт
клиент, а кардинальность метки обязан задавать код.

Считаются запросы под `/api`, но не `/metrics`: сам скрейп и его
`SELECT pg_database_size` в статистику не идут. Служебные запросы вне
клиентского API и SQL вне HTTP-запроса (бот, импорт, планировщик) не
учитываются вовсе.

**Доля SQL во времени ответа** — первый график, который смотрят, когда страница
отвечает медленно:

```promql
sum by (route) (rate(http_request_sql_duration_seconds_sum{job="api"}[5m]))
/
clamp_min(sum by (route) (rate(http_request_duration_seconds_sum{job="api"}[5m])), 0.001)
```

Доля около единицы — время ушло в базу. Доля заметно ниже — узкое место в
Python (сборка ответа, отчёты, PDF), и SQL тут ни при чём: именно этот вывод
метрика и позволяет сделать. Панели «SQL-время p95 по маршрутам», «Доля SQL во
времени ответа» и «SQL-выполнений на запрос» — в дашборде «API: ошибки и
скорость», панели событий — в «Логи и ошибки».

#### Событие `slow_sql_request`

Метрики отвечают «в этом маршруте SQL занимает 80 % времени», но не отвечают
«какой именно запрос». Ответ — одна строка JSON в stdout API на каждый запрос
дольше порога; promtail несёт её в Loki как есть, Grafana показывает в
дашборде «Логи и ошибки». Журнала всех запросов нет намеренно: он залил бы
Loki и не нёс бы информации.

| Настройка | По умолчанию | Что значит |
| --- | --- | --- |
| `SLOW_REQUEST_MS` | `300` | запрос короче порога не пишется вовсе |
| `SLOW_SQL_MS` | `50` | SQL-шаблон, у которого самое долгое выполнение короче порога, в `slow_sql` не попадает |

Оба порога — переменные окружения (`app/backend/app/config.py`), меняются без
пересборки образа. Счётчик и время SQL при этом считаются всегда: порог
отсекает только подробности.

Пример строки (значения сокращены):

```json
{"duration_ms":812.4,"event":"slow_sql_request","failed":false,"method":"GET","request_id":"…","route":"/api/personnel","slow_sql":[{"count":3,"fingerprint":"1a2b3c4d5e6f","max_ms":220.4,"operation":"SELECT","slowest_at_ms":118.2,"tables":["employees","residents"],"total_ms":410.1}],"sql_count":37,"sql_ms":640.2,"sql_share":0.788,"stages_ms":{"assemble":38.1,"events":22.4,"sources":420.5},"status":200,"thresholds":{"request_ms":300,"sql_ms":50},"ts":"2026-11-19T12:34:56.789+00:00"}
```

Ключи в строке идут в алфавитном порядке (`sort_keys=True` в `write_event`):
так одинаковый набор полей всегда даёт одинаковые байты, и сравнение строк в Loki
не зависит от порядка, в котором их собрал код. Поэтому пример выше записан так
же, как выглядит живая строка, — по алфавиту, а не по смыслу. Порядок по смыслу
живёт в самой полезной нагрузке: `stages_ms` — самые долгие этапы (не больше
восьми, по убыванию времени), `slow_sql[]` — до пяти шаблонов по суммарному
времени; текст строки при этом остаётся алфавитным.

| Поле | Смысл |
| --- | --- |
| `event` | имя события, по нему строится запрос панели |
| `request_id` | случайный идентификатор запроса: им же помечен разбор в логах |
| `route` | шаблон маршрута, а не живой адрес: идентификаторов в событии нет |
| `duration_ms`, `sql_ms`, `sql_count`, `sql_share` | всё время запроса, время в SQL, число выполнений и их доля |
| `stages_ms` | время этапов обработчика, которые он разметил: самые долгие, не больше восьми |
| `slow_sql[]` | до пяти шаблонов, отсортированных по суммарному времени |
| `fingerprint` | 12 hex от нормализованного SQL: стабилен, пока не изменился шаблон |
| `operation`, `tables` | первое слово стейтмента и имена таблиц — идентификаторы, не значения |
| `slowest_at_ms` | смещение самого долгого выполнения от начала запроса: по нему видно, какая часть ручки его вызвала |

**Зачем `stages_ms`.** `sql_share` отвечает «сколько времени в базе», но не
отвечает «куда ушло остальное»: у медленных ручек кабинета заметная часть
времени приходится на Python — сборку ответа, приведение значений, обходы
коллекций. Этапы размечает сам обработчик (`stage("sources")` из
`app.sql_diagnostics`), поэтому имена в `stages_ms` — это имена шагов из кода, а
не данные: `sources` (строки-источники), `events` (журнал), `assemble` (сборка
карточек), `plans`, `arrivals`, `settings`. Этапы включают в себя свой SQL:
`stage("sources")` оборачивает чтение строк-источников, `stage("events")` —
чтение журнала, поэтому `stages_ms` и `sql_ms` пересекаются и вычитать одно из
другого нельзя. Остаток «`duration_ms` минус `stages_ms` минус время в SQL вне
размеченных этапов» — то, чего не видит ни разметка, ни SQL-слой (пул
соединений, `flush`/`commit`, сериализация ответа). Если обработчик ничего не
разметил, поле остаётся пустым объектом.


**Чего в событии нет и не будет.** Ни bind-параметров, ни литералов из SQL, ни
адреса запроса с идентификатором, ни тела запроса, ни cookies. Сырого SQL тоже
нет: `text()` в проекте собирается f-строками, и литерал в готовом стейтменте
не отличить от имени колонки, поэтому вместо SQL уходит отпечаток. Ограничение
осознанное: диагностика не имеет права стать вторым каналом утечки
персональных данных.

Запросы в Loki:

```logql
# все медленные запросы API
{service="api"} |= "slow_sql_request"

# только падения ручек
{service="api"} |= "slow_sql_request" |= "\"failed\":true"

# сколько медленных за 5 минут
sum(count_over_time({service="api"} |= "slow_sql_request" [5m]))
```

`| json` тоже работает: строка пишется без префикса логгера (`%(asctime)s …`),
поэтому разбирается целиком:

```logql
{service="api"} |= "slow_sql_request"
  | json | route="/api/personnel"
  | line_format "{{.duration_ms}} мс, SQL {{.sql_ms}} мс, {{.sql_count}} запросов"
```

#### Что делать с отпечатком

Событие называет шаблон, но не показывает SQL. Место в коде находит команда
(из каталога `app/backend`):

```bash
# все SQL-литералы с отпечатками
python -m app.diagnostics.sql_fingerprints

# шаблон по отпечатку из события
python -m app.diagnostics.sql_fingerprints --fingerprint 1a2b3c4d5e6f

# отпечаток и нормализованная форма конкретного SQL
python -m app.diagnostics.sql_fingerprints "SELECT id FROM residents WHERE dormitory_id = :id"
```

Значения и имена параметров при нормализации вырезаются, поэтому один шаблон
даёт один отпечаток при любых данных и в любом виде: `:name` из кода,
`%(name)s` у psycopg, `?` у SQLite. В базе команда ничего не выполняет;
коды выхода — `0` найден, `2` не найден, `1` ошибка запуска.

Дальше — план запроса **на стенде или на копии данных**:

```sql
EXPLAIN SELECT …;
```

`EXPLAIN ANALYZE` на боевой базе не запускается: он выполняет запрос целиком,
а медленный `UPDATE`/`DELETE` в нём — это уже изменение данных. На бою — план
без `ANALYZE` и `pg_stat_statements`.

Чего команда не найдёт: SQL, который SQLAlchemy собирает из ORM-запросов
(`select(Resident)…`) — такого текста в коде нет, готовый стейтмент появляется
только при выполнении. Для таких событий остаются `route`, `tables` и
`slowest_at_ms`: по ним ищется место в ручке.

### Метрики сервера и контейнеров

* `node-exporter` — CPU, память, диск хоста (`node_*`).
* `docker-stats-exporter` (`monitor/docker-stats-exporter/`) — данные из
  docker API через `/var/run/docker.sock`: `container_cpu_percent`,
  `container_memory_usage_bytes`, `container_memory_limit_bytes`,
  `container_network_rx_bytes_total`, `container_network_tx_bytes_total`,
  `container_last_seen`. Метка `service` — имя сервиса compose, поэтому
  алерты и графики говорят «api», «db», «caddy», а не «a1b2c3d4».

## Логи

Три сервиса, потому что вопросов два: «что происходит прямо сейчас» и «что было
вчера в 3:40». Первый решается потоком без индексации, второй — поиском по
истории; одним инструментом оба дешево не решаются.

| Сервис | Роль | Куда виден |
| --- | --- | --- |
| `promtail` | читает stdout/stderr контейнеров через docker API и отправляет в Loki | никуда, только пишет |
| `loki` | хранит логи, метки `service`, `container`, `stream`, `project` | только внутри сети: Grafana (источник `Loki`) и promtail |
| `dozzle` | живой поток логов из docker API, без индексации | `https://logs.<SITE_DOMAIN>` за basic auth |

Наружу открыт только `https://logs.<SITE_DOMAIN>` (Dozzle) и `monitor.<домен>`
(Grafana); `loki` и `promtail` портов не публикуют — как и весь остальной стек.

**Чьи контейнеры.** Только одного compose-проекта — `MONITORED_PROJECT` в
`monitor/.env` (по умолчанию `crm-dormitory`, на сервере деплой ставит туда
`COMPOSE_PROJECT_NAME` основного стека). Docker API отдаёт все контейнеры
машины, поэтому фильтр стоит на трёх сборщиках сразу:

| Что | Метка фильтра | Что будет без него |
| --- | --- | --- |
| `promtail` | `filters: label=com.docker.compose.project` | в Loki попадают логи чужих стеков |
| `dozzle` | `DOZZLE_FILTER` | на `logs.<домен>` видно все контейнеры машины |
| `docker-stats-exporter` | тот же `MONITORED_PROJECT` | алерты `ContainerStopped`/`HighCpu` срабатывают на чужие контейнеры |

Значение должно совпадать с именем проекта основного стека. Ошибка здесь не
даёт ошибки: панели и Dozzle просто пусты, алерты молчат. Ловится это на
деплое проверкой `service=api` в Loki, а локально — тем, что в Dozzle видно
ноль контейнеров. Пустое значение = все контейнеры хоста (так было до фильтра).

**Контейнеры внутри проекта не перечисляются руками.** promtail находит их через
`docker_sd_configs`, поэтому новый сервис в основном стеке начинает логироваться
сам, а удалённый перестаёт быть целью. Обратная сторона: логи читаются из
`json-file` (штатный logging driver compose). Если у сервиса появится
`logging.driver: journald` или `local`, promtail перестанет видеть его логи
**молча** — на это есть проверка «promtail доставляет логи в Loki» в деплое.

Контейнер, запущенный руками (`docker run`, без compose-меток), не относится ни
к одному проекту и в мониторинг не попадает — ни в логи, ни в алерты.

**Сколько хранится.** 14 суток (`limits_config.retention_period` в
`monitor/loki/loki.yml`), удаляет компактор. Диск сервера общий с боевой базой,
поэтому потолок обязателен: логи занимают место быстрее метрик, а в разборе
инцидентов двух недель хватает.

### Найти ошибки

Dozzle (`https://logs.<домен>`) показывает поток живьём и умеет искать по
подстроке — этого достаточно, чтобы понять «что сейчас сыплется».

История и срез по всем сервисам — в Grafana, дашборд «Логи и ошибки» или
Explore с источником `Loki`. Рабочие запросы:

```logql
# ошибки и исключения по всем контейнерам за последний час
{service=~".+"} |~ "(?i)error|critical|traceback|exception"

# только API
{service="api"}

# только stderr (там всё, что приложение считает ошибкой)
{service="api", stream="stderr"}

# сколько ошибок в минуту по сервисам
sum by (service) (count_over_time({service=~".+"} |~ "(?i)error" [1m]))
```

Метка `project` отделяет стенд отдела от боевого стека, если оба Loki живут на
одной машине: `{project="crm-dormitory", service="api"}`. В Loki она остаётся,
хотя фильтр `MONITORED_PROJECT` уже ограничил набор контейнеров: у стенда и боя
одинаковые имена сервисов (`api`, `web`, `db`), и по одной метке `service` их не
различить.

### Проверить шов руками

```bash
# promtail видит контейнеры и пишет в Loki: Loki помнит метку service=api
docker compose -f monitor/docker-compose.monitor.yml --env-file monitor/.env \
  exec -T notifier python -c "import urllib.request,json; print(json.load(urllib.request.urlopen('http://loki:3100/loki/api/v1/label/service/values')))"

# последние строки из Loki
docker compose -f monitor/docker-compose.monitor.yml --env-file monitor/.env \
  exec -T notifier python -c "import urllib.request,json; print(json.load(urllib.request.urlopen('http://loki:3100/loki/api/v1/query_range?query=%7Bservice%3D%22api%22%7D&limit=5'))['data']['result'])"
```

Пустой список значений `service` — не «логи не нужны», а «promtail не доехал»
или «не тот проект». Проверять в этом порядке:

1. `MONITORED_PROJECT` в `monitor/.env` равен имени проекта основного стека?
   Сравнить с `docker inspect` любого его контейнера —
   `com.docker.compose.project`;
2. `docker compose ... logs promtail` — стартовал ли он вообще: опечатка в
   `${...}` внутри конфига валит promtail с «Unable to parse variable name», и
   он уходит в рестарт по кругу;
3. logging driver контейнеров — `json-file`, а не `journald`/`local`.

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

**Если у сервера нет прямого выхода в Telegram** (симптомы и общая картина —
`docs/deploy.md`, раздел «Сервер без прямого доступа к Telegram»), notifier
получает свой прокси третьей переменной в `monitor/.env`:

```env
MONITOR_TELEGRAM_PROXY_URL=http://proxy.example:3128
```

Заданное значение уводит в прокси **только** запрос `sendMessage`: notifier
собирает для него отдельный `urllib.request.build_opener(ProxyHandler(...))`, а
запросы к Prometheus (`PROMETHEUS_URL`) идут напрямую, как раньше. Пустое
значение — прямое соединение, оно же умолчание. Это НЕ `HTTPS_PROXY`: та
переменная общая для процесса и увела бы в прокси и сводку из Prometheus. После
правки — `docker compose -f monitor/docker-compose.monitor.yml --env-file
monitor/.env up -d notifier` (пересоздание, а не `restart`: окружение
перечитывается только при создании контейнера).

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
| Деплой падает на `Permission denied` для `.env` или на «`SITE_DOMAIN` в `.env` пуст» с `sed: can't read .env` | `.env` сервера не принадлежит пользователю деплоя (остался `root:root` после `sudo nano`): читать и писать его может только root, поэтому домен «пуст», а пару `MONITOR_BASIC_AUTH_*` некуда дописать. `sudo chown --reference=/srv/crm-dormitory /srv/crm-dormitory/.env && sudo chmod 640 /srv/crm-dormitory/.env`, затем запустить workflow снова — он идемпотентен. Проверка прав стоит в начале шага «Сервер: чек-лист `.env` и адреса мониторинга». |
| `exec: "validate": executable file not found in $PATH` при проверке конфига | У образа `caddy:2-alpine` нет `ENTRYPOINT`, только `CMD caddy run …`: аргументы `compose run` заменяют CMD целиком, и `validate` пытаются выполнить как программу. Нужен явный entrypoint: `docker compose --profile tls run --rm --no-deps --entrypoint caddy caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile`. В текущем workflow вызов исправлен, в более старых его версиях — нет. |
| `502` на поддомене | Стек мониторинга не запущен или в другой сети: `docker compose -f monitor/docker-compose.monitor.yml --env-file monitor/.env ps`, затем сверьте `APP_NETWORK` с `docker network ls`. |
| `401` при верном пароле | Caddy работает со старым окружением: `caddy reload` файл перечитывает, а переменные — нет. Лечится `docker compose --profile tls up -d --no-deps caddy`. |
| `401` всем сразу после ручной смены пароля | В `MONITOR_BASIC_AUTH_HASH` одиночные `$`: compose интерполирует их и обрезает хеш до `$2a$14.…`. Длина значения в контейнере (`docker compose --profile tls run --rm --no-deps --entrypoint env caddy`) должна быть 60 — если меньше, перепишите строку с удвоенными `$$` (см. «Сменить пароль руками»). |
| Пустые графики | Нет данных (`up{job=...}` = 0) или Grafana ругается на `origin not allowed` — сверьте `MONITOR_HOST` с реальным адресом. |
| Сводка только в логе | Не заданы `MONITOR_TELEGRAM_BOT_TOKEN`/`MONITOR_TELEGRAM_CHAT_ID`. |
| Алерты не приходят, хотя сбой есть | `docker compose ... logs alertmanager`: webhook не доставлен, если notifier не запущен. Правила проверяются `promtool check rules`. |
| Histogram пустой | Приложение не отдало ни одного запроса с момента старта: гистограмма появляется на первом запросе. |
| Пусто в Dozzle, «Логи и ошибки» и «Сервер и контейнеры», а метрики API идут | `MONITORED_PROJECT` не совпадает с именем проекта основного стека: все три сборщика фильтруют контейнеры по этой метке. Сверьте с `com.docker.compose.project` на контейнере: `docker inspect crm-dormitory-api-1 --format '{{index .Config.Labels "com.docker.compose.project"}}'`. |
| promtail в рестарте по кругу, в логе `Unable to parse variable name` | В `monitor/promtail/promtail.yml` в комментарии осталась последовательность `$` с фигурными скобками: promtail разворачивает переменные по всему файлу до разбора YAML, и комментарии тоже. |

Логи:

```bash
docker compose -f monitor/docker-compose.monitor.yml --env-file monitor/.env logs -f --tail=100
```

## Проверка перед pull request

Всё, что можно проверить без сервера, проверяется командами из корня
репозитория (они же — то, чем эти файлы проверялись):

```bash
# compose-файл: 9 сервисов, 5 томов, своё имя проекта, НИ ОДНОГО ports:
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
стенде отдела (Docker Desktop пробрасывает `/var/run/docker.sock`), но с
`MONITORED_PROJECT` в его сериях только контейнеры выбранного проекта — на
сервере это `crm-dormitory`, на стенде имя проекта стенда. Без фильтра
(пустое значение) он видит контейнеры **всех** проектов хоста, и тогда чужие
имена попадают и в дашборд, и в алерты `ContainerStopped`.

## Чего здесь нет

* **Автовосстановления и дежурств.** Алерт — сообщение человеку, а не команда
  «перезапусти контейнер». Автоматика, которая сама лечит, ошибается быстрее,
  чем человек читает сообщение.
* **Трассировки.** Jaeger в стеке нет: он отвечает на вопрос «где именно
  время ушло внутри запроса», а пока запросов мало и узкое место одно, хватает
  p95 из метрик и логов. Логи есть — но это stdout контейнеров, а не
  структурный журнал приложения: `request_id` в обычные строки лога не
  пишется, он есть только в событии `slow_sql_request`, поэтому склеить запрос
  из нескольких строк по нему нельзя.
* **Метрик бизнеса** (заявки, заселения). Слой `http_requests_total` отвечает
  на вопрос «работает ли», а не «сколько заселили»; для второго нужны
  отдельные счётчики в API и отдельная задача.
* **Мониторинга самой базы.** Есть размер базы (`db_size_bytes`) и время SQL по
  маршрутам, но нет `pg_stat_*`: медленные запросы разбираются по логам
  PostgreSQL — они тоже попадают в Loki, потому что `db` пишет в stdout.

## Изменения

- 2026-11-19 — notifier ходит в Telegram через прокси: `MONITOR_TELEGRAM_PROXY_URL`
  в `monitor/.env` собирает для `sendMessage` отдельный
  `urllib.request.build_opener(ProxyHandler(...))`, а запросы к Prometheus
  остаются прямыми. Нужно серверам без прямого выхода в Telegram
  (`docs/deploy.md`, раздел «Сервер без прямого доступа к Telegram»). Пустое
  значение — прежнее прямое соединение.
- 2026-11-19 — диагностика медленных SQL-запросов: API отдаёт
  `http_request_sql_duration_seconds` и `http_sql_statements_total` по меткам
  `method`/`route` (`app/backend/app/sql_diagnostics.py`), а запрос дольше
  `SLOW_REQUEST_MS` (300 мс) пишет в stdout одну строку JSON
  `slow_sql_request` — шаблон маршрута, время и число SQL, отпечатки медленных
  шаблонов. Значений параметров и сырого SQL в событии нет. В дашбордах
  появились «SQL-время p95 по маршрутам», «Доля SQL во времени ответа»,
  «SQL-выполнений на запрос» и панель событий в Loki; место SQL по отпечатку
  ищет `python -m app.diagnostics.sql_fingerprints`.
- 2026-11-16 — стенд: проверка занятости портов мониторинга больше не считает
  чужими порты собственного стека. Grafana и Dozzle проекта
  `crm-dormitory-monitor` живут между прогонами, поэтому второй запуск стенда
  падал на `Port 127.0.0.1:8095 … is already taken by another program` — своим
  же контейнером. Теперь владелец порта сверяется с меткой
  `com.docker.compose.project`; `::error::` остаётся для настоящих чужих
  программ (и, как и раньше, называет контейнер, который держит порт).
- 2026-11-16 — деплой мониторинга проверяет права на серверный `.env` в начале
  шага «Сервер: чек-лист `.env` и адреса мониторинга»: файл, оставшийся
  `root:root` после `sudo nano`, валил запуск с двух сторон — без чтения домен
  выглядел пустым (`sed: can't read .env`), без записи падала генерация пары
  (`Permission denied`). Теперь ошибка называет владельца, режим и готовую
  команду `chown --reference`/`chmod`.
- 2026-11-16 — мониторинг обновляется вместе со стендом: `.github/workflows/stand.yml`
  получил три шага (`Мониторинг: окружение стенда`, `Мониторинг: пересборка и
  перезапуск`, `Проверка: мониторинг отвечает`). `.env` мониторинга создаётся из
  шаблона, `MONITORED_PROJECT` и `APP_NETWORK` подставляются из проекта стенда,
  стек поднимается проектом `crm-dormitory-monitor` с локальным оверрайдом
  портов и проверяется по Grafana, Dozzle, Loki и метке `service=api`. Занятый
  порт мониторинга теперь виден как `::error::` до подъёма стека, а не как
  сообщение compose про `port is already allocated`.
- 2026-11-16 — логи и локальный стенд: в стек добавлены `promtail`, `Loki`
  (14 суток истории, метки `service`/`container`/`stream`/`project`) и `Dozzle`,
  второй поддомен `logs.<SITE_DOMAIN>` за своим basic auth, дашборд «Логи и
  ошибки» и источник `Loki` в Grafana, локальный оверрайд
  `monitor/docker-compose.local.yml` (Grafana на 8095, логи на 8096) — в
  основном файле по-прежнему нет ни одного `ports:`. Деплой
  `deploy-monitoring.yml` получил пару входа для `logs.`, проверки Loki/Dozzle
  изнутри сети и проверку того, что логи `api` реально доехали в Loki.
  Сборщики ограничены одним compose-проектом (`MONITORED_PROJECT`): `promtail`,
  `dozzle` и `docker-stats-exporter` берут только контейнеры основного стека,
  поэтому чужие стеки на рабочей машине больше не попадают ни в логи, ни в
  алерты.
- 2026-11-16 — мониторинг появился: `monitor/` (Prometheus, Grafana,
  Alertmanager, notifier, node-exporter, docker-stats-exporter), метрики API
  (`app/backend/app/metrics.py`, `GET /metrics`), поддомен
  `monitor.<SITE_DOMAIN>` с basic auth в `caddy/Caddyfile`, алерты и вечерняя
  сводка в Telegram, отдельный workflow `deploy-monitoring.yml`.

# Почему три `SELECT` в `GET /api/personnel` дают 89,7 % SQL

Разбор боевого события `slow_sql_request` от 2026-11-21 09:19 и замеры на стенде:
что именно выполняет обработчик, сколько это занимает, каким планом и что из этого
воспроизводится вне боевого инстанса. Продуктовый код в этом шаге не менялся.

## Событие и его этапы

`duration_ms` 3789,6 · `sql_ms` 2267,2 · `sql_count` 25 · `sql_share` 0,598.

| Этап | мс | Доля от `duration_ms` |
| --- | ---: | ---: |
| `events` (журнал сотрудников) | 1673,9 | 44,2 % |
| вне размеченных этапов | 1364,2 | 36,0 % |
| `settings` (настройки притока) | 527,0 | 13,9 % |
| `assemble` (сборка карточек) | 105,5 | 2,8 % |
| `sources` (строки-источники) | 80,2 | 2,1 % |
| `arrivals` (приток) | 27,1 | 0,7 % |
| `plans` (планы) | 11,7 | 0,3 % |

Размеченные этапы дают в сумме 2425,4 мс (64,0 %), остаток до `duration_ms` — это
«вне этапов».

**Складывать `stages_ms` с `sql_ms` нельзя.** Этап оборачивает и свой SQL:
`stage("events")` включает чтение журнала, `stage("sources")` — чтение
строк-источников (см. `docs/monitoring.md`, раздел «Событие `slow_sql_request`»).
Поэтому 2267,2 мс SQL лежат **внутри** 2425,4 мс этапов, а не рядом с ними.
Доля SQL (0,598) считается от `duration_ms` и с суммой этапов не связана.

## Три запроса, которые съели SQL

| Запрос | Где в коде | мс | Доля от `sql_ms` | Доля от `duration_ms` |
| --- | --- | ---: | ---: | ---: |
| `SELECT … FROM employee_events WHERE dormitory_id IN (…)` | `app/backend/app/personnel.py:778-782` | 794,6 | 35,0 % | 21,0 % |
| `SELECT … FROM dormitories WHERE id IN (…)` | `app/backend/app/personnel.py:748-754` | 723,4 | 31,9 % | 19,1 % |
| `SELECT … FROM arrival_plans JOIN dormitories …` | `app/backend/app/arrival_settings.py:78-86` | 516,7 | 22,8 % | 13,6 % |

Вместе — 2034,7 мс, то есть 89,7 % всего SQL и 53,7 % всего запроса.

Смущает второе число: `dormitories` — таблица в несколько строк, и 723,4 мс на
`WHERE id IN (…)` по первичному ключу кодом не объясняются. Предыдущее событие на
том же маршруте имело `sql_ms` 206,2 — разброс по времени SQL в 11 раз
(2267,2 / 206,2). Различить «плохой план», «ожидание блокировки» и «медленный
инстанс» по логам было нельзя: `pg_stat_*` в проекте нет (`docs/monitoring.md:804`).

## Как снимались замеры

Стенд отдела — compose-проект `crm-dormitory-agent` из рабочей копии
`D:\Agents\CRMDormitory`, образ `api` пересобран из `develop-m` (`3c8d03d`),
PostgreSQL 16 (`postgres:16-alpine`), Python 3.12 в контейнере. `sha256` файлов
`app/personnel.py`, `app/arrival_settings.py`, `app/sql_diagnostics.py` в контейнере
совпадают с рабочей копией — замеры сделаны на текущем коде базы.

Объём данных — существующая фикстура `app/backend/tests/test_personnel_workspace_perf.py`
(`build_stand`): 2000 сотрудников, 20 000 строк-источников, 2000 событий журнала,
200 планов, 5 планов притока, 1 общежитие; база 21 МБ.

Запросы шли по HTTP внутри контейнера на настоящий `GET /api/personnel`
(`httpx`, cookie-сессия `crm_session` живого пользователя с активной организацией
и подпиской), а не в обход авторизации через подмену зависимостей: так в замер
попадают те же 24 SQL, что и на бою, включая проверку секции, подписки и членства.
Три запроса подряд, между ними ничего не делалось. Этапы и `slow_sql_request`
писал сам сервис — цифры ниже взяты из его события, а не из таймера снаружи.
`pg_stat_activity` снимался параллельным потоком внутри того же контейнера каждые
10 мс (соединение с `application_name = 'recon240-sampler'`, собственная сессия и
сам сэмплер исключены), только чтение.

## Точный SQL трёх запросов

`str(statement.compile(dialect=postgresql.dialect(), compile_kwargs={"literal_binds": True}))`,
идентификатор общежития подставлен из области запроса.

`app/backend/app/personnel.py:748-754`:

```sql
SELECT dormitories.id, dormitories.organization_id, dormitories.created_by_id, dormitories.name,
       dormitories.client_name, dormitories.section_states, dormitories.section_parents,
       dormitories.exchange_options, dormitories.standard_clear_list, dormitories.is_archived,
       dormitories.created_at
FROM dormitories
WHERE dormitories.id IN (3)
ORDER BY dormitories.name, dormitories.id
```

`app/backend/app/personnel.py:778-782`:

```sql
SELECT employee_events.id, employee_events.employee_id, employee_events.dormitory_id,
       employee_events.kind, employee_events.source_table, employee_events.source_id,
       employee_events.title, employee_events.happened_on, employee_events.snapshot,
       employee_events.actor_id, employee_events.created_at
FROM employee_events
WHERE employee_events.dormitory_id IN (3)
ORDER BY employee_events.id
```

`app/backend/app/arrival_settings.py:78-86`:

```sql
SELECT arrival_plans.id, arrival_plans.dormitory_id, arrival_plans.date, arrival_plans.count,
       arrival_plans.names, arrival_plans.people, arrival_plans.custom_values,
       arrival_plans.revision
FROM arrival_plans
JOIN dormitories ON dormitories.id = arrival_plans.dormitory_id
WHERE dormitories.organization_id = 3
```

Видно две вещи, которых в событии не было. `dormitories` выбирает четыре JSONB-колонки
(`section_states`, `section_parents`, `exchange_options`, `standard_clear_list`) —
ширина строки в плане 1181 байт при одной строке результата. `arrival_plans` не имеет
ни сужения по общежитиям (только по организации), ни периода — и тащит JSONB
`people` и `custom_values` для всех планов организации.

## Объём и планы

| Запрос | План | `actual rows` | `loops` | `shared hit` | `shared read` | `Seq Scan` | `Sort` | `Execution Time` |
| --- | --- | ---: | ---: | ---: | ---: | --- | --- | ---: |
| `dormitories` | `Sort` → `Index Scan using dormitories_pkey` | 1 | 1 | 5 | 0 | нет | да, quicksort 25 КБ | 0,086 мс |
| `employee_events` | `Sort` → `Index Scan using ix_employee_events_dormitory_id` | 2000 | 1 | 40 | 0 | нет | да, quicksort 299 КБ | 0,665 мс |
| `arrival_plans` ⋈ `dormitories` | `Nested Loop` → `Index Scan` по `dormitories` + `Bitmap Heap Scan` по `arrival_plans` | 5 | 1 | 4 | 0 | нет | нет | 0,052 мс |

`dormitories`:

```
Sort  (cost=8.17..8.17 rows=1 width=1181)
  Sort Key: name
  ->  Index Scan using dormitories_pkey on dormitories  (cost=0.14..8.16 rows=1 width=1181)
        Index Cond: (id = 3)
```

`employee_events`:

```
Sort  (cost=4.31..4.31 rows=1 width=184)
  Sort Key: id
  ->  Index Scan using ix_employee_events_dormitory_id on employee_events  (cost=0.28..4.30 rows=1 width=184)
        Index Cond: (dormitory_id = 3)
```

`arrival_plans` ⋈ `dormitories`:

```
Nested Loop  (cost=4.30..17.68 rows=6 width=202)
  ->  Index Scan using ix_dormitories_organization_id on dormitories  (cost=0.14..8.16 rows=1 width=4)
        Index Cond: (organization_id = 3)
  ->  Bitmap Heap Scan on arrival_plans  (cost=4.16..9.50 rows=2 width=202)
        Recheck Cond: (dormitory_id = dormitories.id)
        ->  Bitmap Index Scan on ix_arrival_plans_dormitory_id  (cost=0.00..4.16 rows=2 width=0)
              Index Cond: (dormitory_id = dormitories.id)
```

`Seq Scan` нет ни в одном плане, все обращения — по индексам, `shared read` равен нулю
везде (база 21 МБ целиком в буферах), `Planning Time` 0,049–0,066 мс.

Отдельно стоит оценка строк у `employee_events`: планировщик ждёт 1 строку, получает
2000 — ошибка в 2000 раз. Причина не в статистике таблицы как таковой (автоанализ по ней
прошёл, `pg_stat_user_tables` это подтверждает), а в том, что фикстура вставляет строки и
сразу их читает: нового значения `dormitory_id` ещё нет в списке частых значений колонки.
Плана это не портит — соединений, где ошибка в числе строк меняла бы стратегию, здесь нет,
и запрос всё равно укладывается в 0,665 мс.

Замер того же запроса через ORM-сессию, пять прогонов подряд, медиана:

| Запрос | Прогоны, мс | Медиана |
| --- | --- | ---: |
| `dormitories` | 0,414 · 0,431 · 0,435 · 0,499 · 1,405 | 0,435 мс |
| `employee_events` | 21,014 · 22,930 · 25,147 · 26,448 · 68,578 | 25,147 мс |
| `arrival_plans` ⋈ `dormitories` | 0,533 · 0,558 · 0,596 · 0,728 · 1,569 | 0,596 мс |

Разница с боем на тех же запросах: `dormitories` 723,4 против 0,086 мс (в 8 412 раз по
`Execution Time` и в 1 663 раза по времени через ORM), `arrival_plans` 516,7 против
0,052 мс (9 937 раз), `employee_events` 794,6 против 0,665 мс (1 195 раз). Последний
запрос — единственный из трёх, который действительно читает данные (2000 строк, ширина
строки по плану 184 байта), и на стенде он самый дорогой из трёх.

## Три `GET /api/personnel` подряд

| № | `duration_ms` | `sql_ms` | `sql_count` | `sql_share` | `sources` | `events` | `assemble` | `arrivals` | `plans` | `settings` | вне этапов |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 686,7 | 41,6 | 24 | 0,061 | 391,7 | 140,9 | 9,8 | 3,9 | 3,3 | 2,0 | 135,1 |
| 2 | 638,0 | 38,6 | 24 | 0,060 | 428,2 | 30,6 | 13,5 | 2,6 | 2,7 | 2,2 | 158,2 |
| 3 | 694,6 | 37,3 | 24 | 0,054 | 518,4 | 26,4 | 8,5 | 2,6 | 4,4 | 1,5 | 132,8 |

Клиентское время тех же запросов — 733,2 · 686,2 · 720,4 мс, тело ответа 20 742 538 байт
(20,7 МБ) каждый раз: разница между клиентом и сервером — это передача тела, а не работа
ручки.

`sql_ms` разошёлся в 1,12 раза (41,6 / 37,3) — порог «в три раза» не пройден, база на
стенде стабильна. `slow_sql[]` во всех трёх событиях пуст: ни один отдельный SQL не
перешёл порог 50 мс. На бою на том же маршруте разброс был 11-кратный, и один SQL
занимал 723,4 мс.

Раскладка на стенде другая: SQL 5,4–6,1 %, а самый долгий этап — `sources`
(57,0–74,6 % от `duration_ms`). `events` и `settings`, где живут два из трёх медленных
запросов, вместе дают 27,9–142,9 мс.

## `pg_stat_activity` в момент запроса

165 снимков на три запроса, только чтение.

| Запрос | снимков | из них с занятой сессией | состояний `idle in transaction` / `active` | ожидания | `pg_locks` ненаграждённых | самая долгая открытая транзакция |
| --- | ---: | ---: | --- | --- | ---: | ---: |
| 1 | 56 | 55 | 53 / 2 | `Client/ClientRead` 53, без ожидания 2 | 0 | 0,690 с |
| 2 | 49 | 48 | 45 / 3 | `Client/ClientRead` 45, без ожидания 3 | 0 | 0,648 с |
| 3 | 60 | 58 | 55 / 3 | `Client/ClientRead` 55, без ожидания 3 | 0 | 0,700 с |

Ни в одном снимке нет `Lock`, `LWLock`, `transactionid` или `IO` в
`wait_event_type`/`wait_event`, и ни в одном нет ненаграждённой блокировки. Единственное
ожидание — `Client/ClientRead`: бэкенд держит транзакцию открытой и ждёт, пока приложение
пришлёт следующий запрос. Транзакций дольше секунды нет ни в одном снимке: самая долгая
открытая — 0,700 с, и это транзакция самого разбираемого запроса.

Внутри окна видны сами стейтменты (по `left(query, 120)`): чаще всего `residents`
(20 000 строк), `employee_events`, `arrival_plans`, `employees`, `archive_entries`.
То есть база почти всё время ждёт приложение, а не наоборот.

## Замер существующей фикстурой

`pytest -q -m dbtest tests/test_personnel_workspace_perf.py -s` — прошёл.

```
workspace: 708 мс
  SQL: 49 мс в 17 выполнениях
  доля SQL: 6.8%
  этап sources: 472 мс
  этап events: 29 мс
  этап assemble: 9 мс
  этап arrivals: 9 мс
  этап plans: 7 мс

settings: 4 мс
  SQL: 1 мс в 2 выполнениях
  доля SQL: 28.2%
```

Фикстура вызывает обработчик напрямую, поэтому SQL в ней 17 выполнений, а по HTTP — 24:
разницу дают проверки авторизации, подписки и членства, которые в замере ручки не
участвуют. Доли и порядок этапов совпадают с HTTP-замерами, поэтому объём фикстуры
считать репрезентативным для стенда можно.

## Вердикты по гипотезам

| Гипотеза | Вердикт | Цифра |
| --- | --- | --- |
| План / `Seq Scan` | опровергнута | `Seq Scan` нет ни в одном из трёх планов; все три — `Index Scan` / `Bitmap Index Scan` + `Nested Loop`; `dormitories` 0,086 мс при `actual rows=1`, `employee_events` 0,665 мс на 2000 строках, `arrival_plans` 0,052 мс на 5 строках; `shared read` = 0 везде |
| Блокировка | опровергнута на стенде | 165 снимков `pg_stat_activity`, ненаграждённых блокировок 0 в каждом, ни одного `Lock`/`LWLock`/`transactionid` в ожиданиях; единственное ожидание — `Client/ClientRead` (153 снимка из 165) |
| I/O или нагрузка инстанса | на стенде опровергнута, на бою не проверена | `shared read` = 0 в трёх планах (база 21 МБ в буферах), `sql_ms` разброс 1,12× против 11× на бою; `pg_stat_*` на бою нет, снять нечем |

Что это значит вместе. Ни текст запросов, ни их планы не объясняют 723,4 мс: на текущем
коде и сопоставимом объёме данных те же три `SELECT` занимают 0,086 / 0,665 / 0,052 мс, а
весь SQL запроса — 37–42 мс. Гипотезы «план» и «блокировка» цифрами закрыты. Остаётся
третья, и стенд не может её ни подтвердить, ни опровергнуть по построению: 21 МБ базы
целиком лежат в `shared_buffers`, поэтому `shared read` нулевой и любое I/O-ожидание
боевого инстанса здесь не воспроизводится. Одиннадцатикратный разброс `sql_ms` на бою при
одном и том же коде — признак того, что различие в инстансе, а не в запросе.

## Рекомендация: вариант A

Один следующий шаг — **A: выборки колонками и область для настроек**, правка
`app/backend/app/arrival_settings.py:78-86` (плюс, отдельным входом, сужение выборки
колонок в `app/backend/app/personnel.py:748-754`).

Что менять в `organization_plans`: сузить выборку до колонок, которые реально нужны
ответу настроек (`id`, `dormitory_id`, `date`, `count`, `revision`; JSONB `people` и
`custom_values` ответу не нужны), и добавить область — общежития секции уже известны
вызывающему коду, период планов тоже, их и надо передать в условие вместо одного
`Dormitories.organization_id`.

Основание — боевые цифры: этап `settings` в событии 527,0 мс, и 516,7 мс из них —
этот самый `SELECT` (98,1 % этапа). Сужение строк и колонок сокращает объём, который
база читает из TOAST и передаёт в приложение, — а именно объём, а не план, на бою
и оплачивается. **Ожидаемый выигрыш — до 500 мс на HTTP-запрос** (весь этап `settings`,
527,0 мс из 3789,6 мс, 13,9 % запроса), из них ~19 мс остаётся на собственную работу
этапа.

Почему не B и не C. **B** (A + индексы) не даёт ничего: все три запроса уже идут по
индексам, `Seq Scan` нет ни в одном плане, `shared read` = 0 — индексировать нечего, а
миграция добавила бы риск без выигрыша. **C** (предвычисление) на боевых цифрах не
обосновано: `sources` на бою 80,2 мс (2,1 % запроса), предвычислять там нечего; на стенде
`sources` действительно 57,0–74,6 % времени, но это свойство стенда, а не боевого профиля,
и переносить вывод стенда на бой было бы ошибкой.

Чего вариант A не лечит: 723,4 мс на `dormitories` и 794,6 мс на `employee_events`. Пока
у боевой базы не снят план и снимок ожиданий, эти два числа — свойство инстанса, и любая
правка кода под них была бы угадыванием.

## Снимки, которые нужны с боевой базы

Доступа к боевой базе у отдела нет: всё, что выше, снято на стенде, а боевые числа взяты
из готового события `slow_sql_request`. Чтобы закрыть гипотезу «I/O или нагрузка
инстанса», нужны снимки с боя — они только читают и ничего не меняют:

```sql
-- 1. план без выполнения; список идентификаторов взять из события
EXPLAIN
SELECT dormitories.id, dormitories.organization_id, dormitories.created_by_id, dormitories.name,
       dormitories.client_name, dormitories.section_states, dormitories.section_parents,
       dormitories.exchange_options, dormitories.standard_clear_list, dormitories.is_archived,
       dormitories.created_at
FROM dormitories WHERE dormitories.id IN (/* id из области запроса */)
ORDER BY dormitories.name, dormitories.id;

-- 2. то же с выполнением (только для этих трёх SELECT, в окне низкой нагрузки):
--    EXPLAIN (ANALYZE, BUFFERS) перед тем же SELECT, что в пункте 1

-- 3. кто чего ждёт прямо сейчас
SELECT pid, state, wait_event_type, wait_event,
       now() - query_start AS query_age, now() - xact_start AS xact_age,
       left(query, 120) AS query
FROM pg_stat_activity
WHERE datname = current_database()
ORDER BY xact_start NULLS LAST;

-- 4. ненаграждённые блокировки
SELECT count(*) FROM pg_locks WHERE NOT granted;

-- 5. кто держит транзакцию дольше секунды
SELECT pid, state, now() - xact_start AS xact_age, left(query, 120) AS query
FROM pg_stat_activity
WHERE xact_start IS NOT NULL AND now() - xact_start > interval '1 second'
ORDER BY xact_age DESC;

-- 6. объём и свежесть статистики по таблицам из трёх запросов
SELECT relname, n_live_tup, n_dead_tup, last_analyze, last_autoanalyze, last_vacuum
FROM pg_stat_user_tables
WHERE relname IN ('dormitories', 'employee_events', 'arrival_plans')
ORDER BY n_live_tup DESC;

-- 7. с чем сравнивать
SHOW shared_buffers; SHOW effective_cache_size; SHOW work_mem; SHOW max_connections;
SELECT state, count(*) FROM pg_stat_activity
WHERE datname = current_database() GROUP BY state;
```

Пункты 1–2 повторить три раза — по одному на каждый из трёх запросов из раздела
«Точный SQL». Снимок 3 удобно снимать с `\watch 0.1` в соседнем `psql`, пока в
другом окне открывается страница персонала; этого достаточно, чтобы увидеть, сидит ли
бэкенд в `IO`, `Lock` или `ClientRead`.

## Что не проверено

- Боевая база не опрашивалась: доступа нет. Планы, `pg_stat_activity` и `pg_locks`
  боевого инстанса не снимались, поэтому гипотеза «I/O или нагрузка инстанса» для боя
  остаётся непроверенной — она лишь единственная не опровергнутая.
- Объём данных боевой базы неизвестен: на стенде 2000 сотрудников и 20 000
  строк-источников, база 21 МБ. Если на бою таблицы на порядки больше, часть разницы
  объясняется объёмом, а не инстансом.
- Ожидаемый выигрыш варианта A (до 500 мс) — оценка сверху по боевому событию, на стенде
  он не измеряется: там этот `SELECT` занимает 0,596 мс, и любая экономия тонет в
  погрешности.
- Число выполнений SQL на стенде (24 по HTTP, 17 в фикстуре) не сверялось с боевым 25:
  на бою набор путей может отличаться (например, наличием архивных строк или
  предпочтений персонала, которых в фикстуре нули).
- Одиннадцатикратный разброс `sql_ms` на бою объяснён быть не может: это два события в
  разное время, а не серия подряд.

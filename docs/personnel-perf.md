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

Стенд отдела — рабочая копия `D:\Agents\CRMDormitory`, образ `api` пересобран из
`develop-m` (`3c8d03d`), PostgreSQL 16.15 (`postgres:16-alpine`), Python 3.12
в контейнере. Профиль ручки, три `GET` подряд, ORM-медианы и снимки
`pg_stat_activity` сняты на compose-проекте `crm-dormitory-agent`; планы
`EXPLAIN (ANALYZE, BUFFERS)` пересняты 2026-11-21 на соседнем стенде отдела —
compose-проект `crmdormitory`, та же сборка образа, та же фикстура, база пуста до
прогона. `sha256` файлов
`app/personnel.py`, `app/arrival_settings.py`, `app/sql_diagnostics.py` в контейнере
совпадают с рабочей копией — замеры сделаны на текущем коде базы.

Объём данных — существующая фикстура `app/backend/tests/test_personnel_workspace_perf.py`
(`build_stand`): 2000 сотрудников, 20 000 строк-источников, 2000 событий журнала,
200 планов, 5 планов притока, 1 общежитие; `residents` 5,8 МБ, `employee_events`
888 кБ, `employees` 792 кБ, вся база 20 МБ. **С боевым объёмом эти числа не
сопоставимы**: сколько строк и байт на бою — неизвестно, поэтому всё, что ниже, —
утверждения про стенд, а не про бой.

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
на строке с заполненными JSONB план показывает ширину 1181 байт при одной строке
результата (о том, почему в переснятом плане ширина другая, — в разделе «Объём и
планы»). `arrival_plans` не имеет
ни сужения по общежитиям (только по организации), ни периода — и тащит JSONB
`people` и `custom_values` для всех планов организации. Второе — не лишние колонки:
`people` и `custom_values` читает `used_values` (`arrival_settings.py:89-100`), из них
считается `used_fields`, и на нём держится защита настроек от смены используемого поля;
что с этим делать — в разделе о рекомендации.

## Объём и планы

Съёмка этого раздела: фикстура → `EXPLAIN (ANALYZE, BUFFERS)` по каждому из трёх
запросов, одним проходом на стенде `crmdormitory`. Идентификаторы в прогоне свои
(`dormitory_id=29`, `organization_id=41`), объём — фикстуры. Планы приводятся дословно,
как их напечатал `EXPLAIN`; в таблице ниже — те же числа, что в дампах. ORM-медианы,
которые служат знаменателем при сравнении с боем, — в таблице ниже по разделу; они
сняты отдельной съёмкой на `crm-dormitory-agent` (см. «Как снимались замеры»).

| Запрос | План | `actual rows` | `loops` | `shared hit` | `shared read` | `Seq Scan` | `Sort` | `Execution Time` |
| --- | --- | ---: | ---: | ---: | ---: | --- | --- | ---: |
| `dormitories` | `Sort` → `Seq Scan on dormitories` | 1 | 1 | 4 | 0 | да, таблица в одну строку | да, quicksort 25 кБ | 0,053 мс |
| `employee_events` | `Sort` → `Index Scan using ix_employee_events_dormitory_id` | 2000 | 1 | 42 | 0 | нет | да, quicksort 299 кБ | 2,032 мс |
| `arrival_plans` ⋈ `dormitories` | `Nested Loop` → `Seq Scan` по `arrival_plans` + `Seq Scan` по `dormitories` | 5 | 1 | 6 | 0 | да, 5 и 1 строка | нет | 0,041 мс |

`dormitories`:

```
Sort  (cost=1.02..1.03 rows=1 width=88) (actual time=0.035..0.035 rows=1 loops=1)
  Sort Key: name
  Sort Method: quicksort  Memory: 25kB
  Buffers: shared hit=4
  ->  Seq Scan on dormitories  (cost=0.00..1.01 rows=1 width=88) (actual time=0.010..0.010 rows=1 loops=1)
        Filter: (id = '29'::smallint)
        Buffers: shared hit=1
Planning:
  Buffers: shared hit=44
Planning Time: 0.220 ms
Execution Time: 0.053 ms
```

`employee_events`:

```
Sort  (cost=4.30..4.31 rows=1 width=184) (actual time=1.827..1.928 rows=2000 loops=1)
  Sort Key: id
  Sort Method: quicksort  Memory: 299kB
  Buffers: shared hit=42
  ->  Index Scan using ix_employee_events_dormitory_id on employee_events  (cost=0.28..4.29 rows=1 width=184) (actual time=0.032..0.487 rows=2000 loops=1)
        Index Cond: (dormitory_id = '29'::smallint)
        Buffers: shared hit=39
Planning:
  Buffers: shared hit=35
Planning Time: 0.259 ms
Execution Time: 2.032 ms
```

`arrival_plans` ⋈ `dormitories`:

```
Nested Loop  (cost=0.00..2.03 rows=1 width=202) (actual time=0.016..0.023 rows=5 loops=1)
  Join Filter: (arrival_plans.dormitory_id = dormitories.id)
  Buffers: shared hit=6
  ->  Seq Scan on arrival_plans  (cost=0.00..1.00 rows=1 width=202) (actual time=0.010..0.011 rows=5 loops=1)
        Buffers: shared hit=1
  ->  Seq Scan on dormitories  (cost=0.00..1.01 rows=1 width=4) (actual time=0.001..0.001 rows=1 loops=5)
        Filter: (organization_id = '41'::smallint)
        Buffers: shared hit=5
Planning:
  Buffers: shared hit=38
Planning Time: 0.644 ms
Execution Time: 0.041 ms
```

Про `width` у `dormitories`: в переснятом плане ширина строки 88 байт, а в первой съёмке
на стенде тот же план показывал 1181. Это не расхождение в замере, а разное наполнение
таблицы: фикстура заводит общежитие с пустыми `section_states`, `section_parents`,
`exchange_options` и `standard_clear_list`, а в таблице первой съёмки лежали общежития с
заполненными JSONB. Эти байты и есть те четыре колонки, которые обработчик не читает
(см. «Рекомендация»); на боевом наполнении они уходят в приложение целиком.

Про `Sort Key` у `dormitories`. В запросе стоит `ORDER BY dormitories.name, dormitories.id`
(раздел «Точный SQL»), а план показывает один ключ — и это не потеря строки при
перепечатке, а работа планировщика: `id` в запросе связан равенством (`IN` из одного
элемента превращается в `id = 29`, это видно в `Filter`), поэтому значение ключа внутри
запроса постоянно, и планировщик выбрасывает его из сортировки как избыточный.
Проверяется одной командой на том же стенде:

```sql
EXPLAIN SELECT id, name FROM dormitories WHERE id IN (1) ORDER BY name, id;
--   Sort Key: name
EXPLAIN SELECT id, name FROM dormitories WHERE id IN (1, 2) ORDER BY name, id;
--   Sort Key: name, id
EXPLAIN SELECT id, name FROM dormitories WHERE id IN (1) ORDER BY name, id, organization_id;
--   Sort Key: name, organization_id
```

Во втором плане связывание идёт через `= ANY`, константы нет — и второй ключ остаётся;
в третьем из сортировки уходит ровно `id`, а `organization_id` остаётся. Значит
`Sort Key: name` — это тот же запрос, просто без избыточного ключа, а не чужой план.

`Seq Scan` есть в двух планах из трёх, и это не тот `Seq Scan`, которого опасается
гипотеза «плохой план»: в `dormitories` одна строка (узел читает одну страницу,
`Filter` по первичному ключу отбрасывает ноль строк), в `arrival_plans` — пять строк
и одна страница, соединение идёт `Nested Loop` по одной строке внешней ветки. На
`employee_events`, единственной таблице с настоящим объёмом, плана хуже индексного
сканирования нет: `Index Scan` по `ix_employee_events_dormitory_id`, 39 из 42
прочитанных буферов. `shared read` равен нулю везде — база 20 МБ целиком в буферах;
`Planning Time` 0,220–0,644 мс. `Execution Time` у `employee_events` плавает от
прогона к прогону (0,668 · 1,462 · 2,032 мс в трёх съёмках подряд) — это кэш и
планировщик, а не свойство запроса; остальные два стабильны в пределах 0,04–0,06 мс.

Отдельно стоит оценка строк у `employee_events`: планировщик ждёт 1 строку, получает
2000 — ошибка в 2000 раз. Причина не в статистике таблицы как таковой (автоанализ по ней
прошёл, `pg_stat_user_tables` это подтверждает), а в том, что фикстура вставляет строки и
сразу их читает: нового значения `dormitory_id` ещё нет в списке частых значений колонки.
Плана это не портит — соединений, где ошибка в числе строк меняла бы стратегию, здесь нет,
и запрос всё равно укладывается в 2,032 мс.

Замер того же запроса через ORM-сессию, пять прогонов подряд, медиана (съёмка на
`crm-dormitory-agent`, тем же инструментом, что и боевые числа):

| Запрос | Прогоны, мс | Медиана |
| --- | --- | ---: |
| `dormitories` | 0,414 · 0,431 · 0,435 · 0,499 · 1,405 | 0,435 мс |
| `employee_events` | 21,014 · 22,930 · 25,147 · 26,448 · 68,578 | 25,147 мс |
| `arrival_plans` ⋈ `dormitories` | 0,533 · 0,558 · 0,596 · 0,728 · 1,569 | 0,596 мс |

Про метрики, иначе числа сравнивают разное. Боевые 723,4 / 794,6 / 516,7 мс — это
интервал слушателя SQLAlchemy (`app/backend/app/sql_diagnostics.py:370-409`): он
обнимает весь путь запроса через драйвер, включая передачу строк в приложение.
Стендовые `Execution Time` из планов (0,053 / 2,032 / 0,041 мс) — время сервера из
`EXPLAIN (ANALYZE)`: планирование, исполнение и отдача строк в сокет, без Python и без
ORM. Это две разные метрики, поэтому знаменателем ниже служит медиана ORM-прогонов
из таблицы выше: она снята тем же инструментом, что и боевые числа.

Разница с боем: `dormitories` 723,4 против 0,435 мс — в 1 663 раза; `employee_events`
794,6 против 25,147 — в 32 раза; `arrival_plans` 516,7 против 0,596 — в 867 раз.
`Execution Time` тех же запросов остаётся в докладе как отдельное утверждение — «план
считается на сервере за десятые доли миллисекунды», — но знаменателем не служит.
`employee_events` — единственный из трёх, который действительно читает данные
(2000 строк, ширина строки по плану 184 байта), и на стенде он самый дорогой из трёх
и по `Execution Time`, и по ORM.

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

Снималось с роли-владельца базы стенда: `crm` в образе `postgres:16-alpine` —
суперпользователь кластера (`usesuper = true`), поэтому в снимках видны все колонки
`pg_stat_activity`: `pid`, `state`, `wait_event_type`, `wait_event`, `query_start`,
`xact_start` и `left(query, 120)`, в том числе по чужим бэкендам. На бою это
существенно: без роли с `pg_read_all_stats` или `pg_monitor` (или суперпользователя)
`state`, `wait_event_type`, `wait_event`, `query` и `xact_start` чужих сессий
приходят `NULL`, и тогда «ожиданий нет» в снимке означает только «их не видно».
Исключение — `pg_locks`: его строки видны всем ролям без отдельной привилегии.

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
| План / `Seq Scan` | опровергнута | `Seq Scan` есть только там, где в таблице одна-пять строк (`dormitories`, `arrival_plans`); на `employee_events` (2000 строк) — `Index Scan` по `ix_employee_events_dormitory_id`, `Nested Loop` по одной строке внешней ветки; `dormitories` 0,053 мс при `actual rows=1`, `employee_events` 2,032 мс на 2000 строках (0,668–2,032 мс в трёх прогонах), `arrival_plans` 0,041 мс на 5 строках; `shared read` = 0 везде |
| Блокировка | опровергнута на стенде | 165 снимков `pg_stat_activity`, ненаграждённых блокировок 0 в каждом, ни одного `Lock`/`LWLock`/`transactionid` в ожиданиях; единственное ожидание — `Client/ClientRead` (153 снимка из 165) |
| I/O или нагрузка инстанса | на стенде опровергнута, на бою не проверена | `shared read` = 0 в трёх планах (база 20 МБ в буферах), `sql_ms` разброс 1,12× против 11× на бою; `pg_stat_*` на бою нет, снять нечем |

Что это значит вместе. Ни текст запросов, ни их планы не объясняют 723,4 мс. Числа
этого раздела — про стенд, а не про бой: здесь на объёме фикстуры (2000 карточек,
20 000 строк-источников, 2000 событий, 1 общежитие, база 20 МБ) те же три `SELECT`
занимают 0,053 / 2,032 / 0,041 мс на сервере и 0,435 / 25,147 / 0,596 мс через ORM,
а весь SQL запроса — 37–42 мс. С боевым объёмом, который неизвестен, эти числа
напрямую не сопоставимы: они показывают, что на этом объёме запрос дешёвый, и ничего
не говорят о том, сколько он стоит на боевых таблицах. Гипотезы «план» и «блокировка»
цифрами закрыты. Остаётся третья, и стенд не может её ни подтвердить, ни опровергнуть
по построению: 20 МБ базы целиком лежат в `shared_buffers`, поэтому `shared read`
нулевой и любое I/O-ожидание боевого инстанса здесь не воспроизводится.
Одиннадцатикратный разброс `sql_ms` на бою при одном и том же коде — признак того, что
различие в инстансе, а не в запросе.

## Рекомендация: вариант A

Один следующий шаг — **A: выборки колонками, без миграции и без предвычисления**. Две
правки, обе в бэкенде:

1. `app/backend/app/arrival_settings.py:78-86` — считать `used_fields` внутри SQL, а не в
   Python.
2. `app/backend/app/personnel.py:748-754` — сузить выборку `dormitories` до колонок,
   которые обработчик действительно читает.

**Что менять в `organization_plans`.** Ответу `settings_response` из этого запроса нужны
не строки планов, а только набор ключей: `"used_fields": sorted(used_values(...))`
(`arrival_settings.py:109`). `used_values` (`:89-100`) обходит `plan.custom_values` и
`[*person for person in plan.people]`, то есть JSONB `people` и `custom_values` — **вход
этой функции, а не мусор в ответе**: выбрасывать их из выборки нельзя, а сужение строк
меняет смысл `used_fields`. Тот же `used_values` стоит в `save_settings` (`:133-145`) и
держит защиту `409` «Поле содержит значения» / «Нельзя убрать используемый вариант
поля» — единственное, что не даёт сменить тип или варианты поля, на котором уже висят
данные. Планы обязаны читаться все: сужение по периоду, секции или общежитиям разрешит
сменить тип поля, у которого есть значения в плане вне сужения, то есть тихо отключит
защиту. Вызывающему и нечего сузить: все три вызова — `api/personnel.py:110`,
`api/arrival_plans.py:66` и `:113` — зовут `settings_response(db, membership.organization_id)`
без периода и без секции.

Правка, которая семантику сохраняет: перенести сбор в SQL — `jsonb_each` по
`custom_values` и по `people[*]->'custom_values'` с тем же условием `filled`, чтобы из
базы уходил набор ключей, а не JSONB всех планов организации. В `save_settings` тот же
`SELECT` возвращает пары «поле → значение»: там значения нужны для проверки по
`field.options`, и защита `409` остаётся прежней. Модель `ArrivalPlan` и её колонки не
меняются.

**Что менять в `dormitories`** (`personnel.py:748-754`). Из загруженных объектов читаются
только `id`, `name`, `client_name`, `is_archived`: ответ (`personnel.py:838`) и наложение
`annotate` (`personnel.py:253-259`, `dormitory.name` и `dormitory.client_name`). Четыре
JSONB-колонки — `section_states`, `section_parents`, `exchange_options`,
`standard_clear_list` — вместе с `created_by_id` и `created_at` не читаются нигде в
обработчике, а ширина строки в плане на заполненных JSONB — 1181 байт. Их и надо убрать
из выборки.

**Ожидаемый выигрыш.** Этап `settings` в событии 527,0 мс (13,9 % из 3789,6 мс), и
516,7 мс из них — `organization_plans` (98,1 % этапа); остальные 10,3 мс — второй `SELECT`,
строка настроек (`arrival_settings.py:104`), плюс питоновская часть этапа. Потолок первой
правки — **516,7 мс на HTTP-запрос** (13,6 % запроса). Чтение тех же страниц JSONB
остаётся в SQL, уходит только передача их в приложение и обход в Python, поэтому сколько
из этих 516,7 мс вернётся, знает лишь боевой снимок: на стенде весь этап 2,0 мс и
разделить эти две части нечем. Вторая правка (колонки `dormitories`) снимает передачу
1181 байта на строку результата (на боевом наполнении), а на `dormitories` приходится одна
строка — на стенде это неизмеримо (0,053 мс), и обещанного числа в миллисекундах у неё
нет; она идёт в том же шаге не за выигрышем, а потому что выборка шире, чем нужно
обработчику.

Почему не B и не C. **B** (A + индексы) не даёт ничего: оба запроса с настоящим объёмом
уже идут по индексам (`Index Scan` по `ix_employee_events_dormitory_id`, pkey по
`dormitories`), два оставшихся `Seq Scan` — это таблицы в одну и пять строк, где
индексировать нечего, `shared read` = 0 — миграция добавила бы риск без выигрыша.
**C** (предвычисление) на боевых цифрах не
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

Пунктам 3 и 5 нужна роль с `pg_read_all_stats` или `pg_monitor` — без неё
`state`, `wait_event_type`, `wait_event`, `query` и `xact_start` чужих сессий придут
`NULL`, и снимок будет выглядеть как «ожиданий и долгих транзакций нет», хотя это
означает лишь «не видно». Проверить заранее:

```sql
SELECT pg_has_role(current_user, 'pg_read_all_stats', 'member')
    OR pg_has_role(current_user, 'pg_monitor', 'member')
    OR (SELECT usesuper FROM pg_user WHERE usename = current_user) AS can_see_all;
```

Пункт 4 (`pg_locks`) такой роли не требует: его строки видны всем.

## Что не проверено

- Боевая база не опрашивалась: доступа нет. Планы, `pg_stat_activity` и `pg_locks`
  боевого инстанса не снимались, поэтому гипотеза «I/O или нагрузка инстанса» для боя
  остаётся непроверенной — она лишь единственная не опровергнутая.
- Объём данных боевой базы неизвестен: на стенде 2000 сотрудников и 20 000
  строк-источников, база 20 МБ. Если на бою таблицы на порядки больше, часть разницы
  объясняется объёмом, а не инстансом.
- Ожидаемый выигрыш варианта A (потолок 516,7 мс) — оценка сверху по боевому событию, на
  стенде он не измеряется: там этот `SELECT` занимает 0,596 мс, и любая экономия тонет в
  погрешности. Разделить «чтение в базе» и «передачу в приложение» внутри этих 516,7 мс
  нечем — это и есть главная неопределённость рекомендации.
- Число выполнений SQL на стенде (24 по HTTP, 17 в фикстуре) не сверялось с боевым 25:
  на бою набор путей может отличаться (например, наличием архивных строк или
  предпочтений персонала, которых в фикстуре нули).
- Одиннадцатикратный разброс `sql_ms` на бою объяснён быть не может: это два события в
  разное время, а не серия подряд.

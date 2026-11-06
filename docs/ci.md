# CI на локальной машине: самообновление стенда после мержа

Зачем: после мержа PR в `develop-m` стенд в рабочем клоне обновляется сам —
без ручного `git pull` и `docker compose up --build`. Job идёт на self-hosted
раннере GitHub Actions с меткой `crm-ci`, то есть на этой же машине, в клоне
владельца. GitHub-hosted раннер сюда не годится: он живёт в облаке и до
локального Docker Desktop не достаёт.

Работает файл `.github/workflows/stand.yml`, job `stand` («Обновить локальный
стенд»).

## Что делает workflow и почему он не в `deploy.yml`

`deploy.yml` — боевой деплой: `workflow_dispatch`, только из `main`,
`ubuntu-latest` → SSH на сервер, гейт на `refs/heads/main` (`docs/deploy.md`).
Он не имеет отношения к машине разработчика и трогать его в этой задаче было
нельзя.

`stand.yml` — про другое: он не ходит на сервер и ничего не публикует. Он
выполняется **в клоне владельца** на этой машине и делает ровно одно:

1. проверяет, что клон существует и в нём открыта ожидаемая ветка (по умолчанию
   `develop-m`);
2. обновляет клон **только fast-forward** до `origin/develop-m` — либо, при
   ручном запуске с input `branch`, не обновляет ничего и собирает стенд из той
   ветки, что уже открыта в клоне;
3. сверяет имя compose-проекта с тем, что ожидается (защита от второго стека);
4. снимает дамп БД стенда в `D:\stand-backups\CRMDormitory`;
5. пересобирает и перезапускает стек (`docker compose up -d --build --wait`);
6. проверяет, что API и веб отвечают.

Держать это в `deploy.yml` нельзя: у файлов разные права (боевой деплой идёт с
секретами сервера), разные раннеры (облачный против локального) и разные
последствия ошибки. Плюс `deploy.yml` запускают руками и только из `main` —
локальный стенд от этого не должен зависеть.

`actions/checkout` в job не используется: job работает в клоне владельца
(`LOCAL_CLONE`), а не в рабочем каталоге раннера `_work`.

## Когда запускается

Ровно три повода:

- `push` в `develop-m` — любой коммит в неё, включая мерж PR;
- вручную без input: Actions → «Обновить локальный стенд» → Run workflow (нужно
  для первого прогона и для повторной попытки после сбоя) — это то же самое, что
  `push`: стенд собирается из `develop-m`;
- вручную с input `branch`: стенд собирается из **той ветки, что открыта в
  клоне** (см. раздел «Собрать стенд из ветки до мержа»).

**Почему не на `pull_request`.** Self-hosted раннер исполняет код из
репозитория **на машине владельца**. Событие `pull_request` позволило бы
исполнить код из чужого форка на этой машине, с доступом к Docker и к файлам
клона. Поэтому блока `pull_request` в `on:` нет, и добавлять его не нужно. PR
открывается и ревьюится как обычно — обновление стенда происходит после мержа.

Группа `concurrency: crm-stand` с `cancel-in-progress: false`: прогоны не
отменяют друг друга, а встают в очередь. Отмена на середине `up --build`
оставила бы полуразобранный стек.

## Один раз на машине: поставить раннер

Нужны права администратора репозитория (Settings → Actions → Runners) и
Windows PowerShell 5.1 (на машине стоит именно она; скрипт сохранён в UTF-8
**с BOM**, иначе 5.1 прочитала бы кириллицу как ANSI).

1. Возьмите PAT (classic со scope `repo`; либо fine-grained с правом
   `Administration: Read and write` для этого репозитория) и положите в
   переменную окружения — в скрипт он не вписан:

   ```powershell
   $env:GITHUB_PAT = 'github_pat_...'
   ```

2. Поставьте раннер (режим по умолчанию — задание Планировщика Windows):

   ```powershell
   cd D:\Development\VideCoding\CRMDormitory
   powershell.exe -NoProfile -ExecutionPolicy Bypass -File _tools\runner\install-runner.ps1 -Pat $env:GITHUB_PAT
   ```

   Скрипт скачает `actions-runner-win-x64` в `D:\actions-runner-crm`,
   зарегистрирует раннер с именем `crm-ci-<ИМЯ-МАШИНЫ>` и меткой `crm-ci`,
   создаст задание Планировщика `crm-ci-runner` (запуск при входе
   пользователя) и запустит его.

3. Проверьте: Settings → Actions → Runners — строка `crm-ci-<машина>` должна
   быть **Idle** (зелёная точка). Затем Actions → «Обновить локальный стенд» →
   Run workflow — первый прогон вручную.

**Почему по умолчанию не служба.** Docker Desktop на Windows отдаёт свой канал
(`npipe:////./pipe/dockerDesktopLinuxEngine`) только вошедшему пользователю из
группы `docker-users`. Служба (`--runasservice`, учётная запись вроде
`NT AUTHORITY\NETWORK SERVICE`) до Docker Desktop не достаёт — шаги
`docker compose` упадут с `permission denied while trying to connect to the
docker API`. Служба имеет смысл, только если Docker в job не нужен:

```powershell
$cred = Get-Credential "$env:USERDOMAIN\$env:USERNAME"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File _tools\runner\install-runner.ps1 -Pat $env:GITHUB_PAT -Mode Service -Credential $cred
```

**Токен без PAT.** На странице Settings → Actions → Runners → New self-hosted
runner GitHub показывает короткий токен (живёт час). Его можно передать вместо
PAT:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File _tools\runner\install-runner.ps1 -RegistrationToken '<токен из UI>'
```

Снять раннер (регистрация в репозитории, задание, служба):

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File _tools\runner\install-runner.ps1 -Pat $env:GITHUB_PAT -Uninstall
# вместе с каталогом D:\actions-runner-crm:
powershell.exe -NoProfile -ExecutionPolicy Bypass -File _tools\runner\install-runner.ps1 -Pat $env:GITHUB_PAT -Uninstall -Purge
```

Пока раннер не зарегистрирован и не запущен, job в GitHub висит в `Queued`, а
стенд молча не обновляется.

## Что настраивается в `env` job

Всё лежит в `.github/workflows/stand.yml`, блок `jobs.stand.env`:

| Переменная | Значение по умолчанию | Зачем |
|---|---|---|
| `LOCAL_CLONE` | `D:\Development\VideCoding\CRMDormitory` | клон владельца, который обновляется и чей стенд пересобирается |
| `LOCAL_BRANCH` | `develop-m` | базовая ветка: какая ветка обязана быть открыта в клоне и откуда берётся fast-forward |
| `STAND_BRANCH` | `${{ inputs.branch }}` (пусто → `LOCAL_BRANCH`) | ветка, **из которой** собирается стенд. Приходит из input `branch`; пустое значение означает «как обычно, из `develop-m`» |
| `STAND_PROJECT` | `crm-dormitory` | ожидаемое имя compose-проекта стенда (`COMPOSE_PROJECT_NAME` в `.env` клона) |
| `STAND_BACKUP_DIR` | `D:\stand-backups\CRMDormitory` | куда складываются дампы БД перед обновлением |

Порты стенда здесь **не** задаются: они берутся из `docker compose config
--format json`, то есть из `.env` клона (`API_PORT`, `FRONTEND_PORT`). Меняете
порты в `.env` — workflow править не нужно.

Имя compose-проекта не переопределяется через `-p` ни в одной команде: оно
читается из `.env` клона. Шаг «Проверка: имя compose-проекта» падает, если
фактическое имя не равно `STAND_PROJECT`:

```
::error::Compose project name is '<имя>', expected 'crm-dormitory'. COMPOSE_PROJECT_NAME
is missing or wrong in ...\.env: without it compose would start a SECOND stack with an
empty database instead of updating the existing one.
```

Причина такой проверки: `.env` не в git, и без `COMPOSE_PROJECT_NAME` compose
поднял бы **второй** стек с пустой базой вместо обновления существующего.

## Собрать стенд из ветки до мержа

Штатный случай — ветка, которую нельзя собрать из `develop-m`: например она
сводит две головы alembic (в `develop-m` их две, и `alembic upgrade head` на
таком дереве падает с «Multiple head revisions», а значит `api` не стартует).
Проверять такую ветку надо на стенде **до** мержа, и для этого есть input
`branch` у ручного запуска:

Actions → «Обновить локальный стенд» → Run workflow → в поле `branch` — имя
ветки, которая уже открыта в клоне (`chore/merge-heads-3`), → Run.

Что при этом происходит и чего не происходит:

| Шаг | Развилка |
|---|---|
| «Проверка: клон и ветка» | имя из input сверяется с фактической веткой клона: не совпало — `::error::`, стенд не тронут |
| «Клон: fast-forward … либо сборка открытой ветки» | `fetch` и `merge` **не выполняются**: клон не переключается, `origin` не трогается, в дело идёт ровно то дерево, что открыто у владельца |
| бэкап, пересборка, проверки | те же, что и всегда |

Правила, которые при этом действуют:

- input принимается **только у ручного запуска**. `push` в `develop-m` не может
  подставить ветку: у push-события нет `inputs`, поэтому он всегда собирает
  `develop-m`. Дополнительно шаг проверяет `GITHUB_EVENT_NAME`.
- правки в **отслеживаемых** файлах клона не допускаются: стенд собрался бы из
  полусохранённого дерева. Неотслеживаемые файлы (`.artifacts`, `tmp-pip` и
  прочий мусор) не мешают.
- стенд остаётся на этой ветке, пока следующий прогон не соберёт `develop-m`.
  Шаг «Итог» печатает ветку стенда и в этом случае даёт `::warning::`.
- миграции ветки **применяются к БД стенда** (их накатывает `api` при старте) и
  отката у них нет. Поэтому собирайте так только ветки, чьи миграции вы готовы
  оставить на стенде; страховка — дамп, который шаг бэкапа снимает до сборки.

**Ограничение GitHub.** Кнопка «Run workflow» появляется только тогда, когда
файл workflow есть на **default-ветке** репозитория. У этого репозитория
default — `main`, а `stand.yml` живёт в `develop-m` и доедет до `main` только
релизным слиянием. Пока файла на `main` нет, ручной запуск недоступен: прогоны
приходят только на `push` в `develop-m`, а ветку до мержа собирают руками по
разделу «Те же шаги руками». После ближайшего релиза (`develop-m` → `main`)
input `branch` заработает из UI без других правок.

## Когда стенд НЕ обновится — и что делать

Это штатные случаи, а не поломка workflow:

| Что в клоне | Поведение workflow | Что делать |
|---|---|---|
| есть локальные коммиты впереди `origin/develop-m` | `::warning::`, стенд не тронут, job зелёный (`updated=false`) | запушьте или уберите коммиты — стенд обновится следующим прогоном |
| открыта другая ветка, input `branch` пуст | `::error::`, стенд не тронут | переключите клон на `develop-m` и перезапустите job — либо, если нужна именно эта ветка, запустите job вручную и впишите её имя в input `branch` |
| открыта другая ветка, а input `branch` называет третью | `::error::`, стенд не тронут | имя в input должно совпадать с веткой клона: переключите клон или исправьте input |
| input `branch` заполнен, но в клоне есть правки в отслеживаемых файлах | `::error::`, стенд не тронут | `git status`, затем commit или `git stash`, и перезапуск |
| незакоммиченные правки в файлах, которые меняет merge | `::error::` от `git merge --ff-only`, стенд не тронут, клон не испорчен | `git status` покажет файлы: закоммитьте или `git stash`, затем перезапуск |
| в `.env` нет или неверный `COMPOSE_PROJECT_NAME` | `::error::` на шаге-гварде, до любых действий со стеком | впишите `COMPOSE_PROJECT_NAME=crm-dormitory` в `.env` клона |
| клон не обновился (нет новых коммитов) | job зелёный, все шаги стенда пропущены | ничего: пересобирать нечего |

Ключевое отличие от вахтового образца: шаги стенда стоят под
`if: steps.clone.outputs.updated == 'true'`. Если клон не обновился, стенд не
пересобирается вообще.

## Где лежат дампы и что с ними делать

Миграции стенда накатывает сам `api` при старте (`app/backend/entrypoint.sh`:
`alembic upgrade head`, затем uvicorn), то есть каждый прогон workflow с
обновлением кода применяет миграции к БД стенда. **Отката миграций нет**:
`alembic downgrade` не вызывается ни в workflow, ни в документации.

Страховка — шаг «Стенд: бэкап БД перед обновлением»:

- дамп снимается `pg_dump -Fc` **внутри** контейнера `db` в `/tmp`, затем
  копируется наружу через `docker cp`. Через `>`/`Out-File` дамп не
  перенаправляется: PowerShell исказил бы двоичные данные;
- файл: `D:\stand-backups\CRMDormitory\crm_<ГГГГММДД-ЧЧММСС>.dump` — вне
  рабочей копии, чтобы не мусорить в `git status` клона;
- если контейнера `db` ещё нет — `::warning::` «первый запуск, откатывать
  нечего», workflow идёт дальше;
- если контейнер есть, но остановлен — он сначала поднимается (`up -d --wait
  db`), иначе дамп снимать не с чего.

**Ротации нет**: дампы копятся. Чистятся руки́ми — удаляйте старые файлы из
`D:\stand-backups\CRMDormitory` сами, никакой шаг их не убирает.

Восстановление из дампа стенда (руками, при необходимости):

```powershell
cd D:\Development\VideCoding\CRMDormitory
docker compose stop api bot
docker compose exec -T db sh -c 'pg_restore -U $POSTGRES_USER -d $POSTGRES_DB --clean --if-exists' < dump-файла
```

(перенаправление здесь в другую сторону — из файла в `stdin` контейнера; для
двоичного `-Fc` надёжнее `docker cp` файла в контейнер и `pg_restore` по пути
внутри него).

## Правило: в блоках `run:` — только ASCII

Раннер записывает тело шага во временный `.ps1` в `_work\_temp` **без BOM**, а
Windows PowerShell 5.1 читает файл без BOM как ANSI. Кириллица и типографские
символы (`—`, `→`, `«»`) превращаются в мусор, и разбор падает ещё до первого
оператора:

```
+ if (-not (Test-Path (Join-Path $clone '.git'))) {
+                                                 ~
Missing closing '}' in statement block or type definition.
```

Договорённость:

- `name:` шагов, комментарии YAML, `docs/`, issue — по-русски;
- всё исполняемое (`run:`) — по-английски, без не-ASCII.

Проверка перед коммитом — команда не должна ничего напечатать:

```powershell
Select-String -Path .github\workflows\stand.yml -Pattern '[^\x00-\x7F]' |
  Where-Object { $_.Line -notmatch '^\s*(#|-?\s*name:|description:)' } |
  ForEach-Object { "$($_.LineNumber): $($_.Line.Trim())" }
```

`description:` исключается потому, что это текст, который GitHub показывает в
UI ручного запуска; исполняемым он не становится. Всё остальное не-ASCII вне
комментариев и `name:` — ошибка.

Дополнительно стоит прогнать каждый блок `run:` через разбор в PowerShell 5.1
(ею пользуется раннер): выпишите тело шага в файл и выполните

```powershell
powershell.exe -NoProfile -Command "$null = [ScriptBlock]::Create((Get-Content -Raw <файл>)); 'ok'"
```

## Те же шаги руками (проверка без GitHub)

```powershell
cd D:\Development\VideCoding\CRMDormitory
git fetch origin; git merge --ff-only origin/develop-m
# имя проекта и порты стенда - из .env этого клона
docker compose config --format json | ConvertFrom-Json | Select-Object name
# бэкап: pg_dump в контейнере + docker cp наружу (см. раздел про дампы)
docker compose up -d --build --remove-orphans --wait --wait-timeout 300
Invoke-WebRequest http://localhost:<API_PORT>/api/health -UseBasicParsing | Select-Object StatusCode
Invoke-WebRequest http://localhost:<FRONTEND_PORT>/ -UseBasicParsing | Select-Object StatusCode
```

`<API_PORT>` и `<FRONTEND_PORT>` — значения из `.env` этого клона, не из
документа.

Сборка стенда из ветки, которой нет в `develop-m` (то же, что input `branch`,
но без GitHub): переключите клон на эту ветку, убедитесь, что `git status
--porcelain -uno` пуст, и выполните те же шаги, начиная с `docker compose
config`: `git fetch`/`git merge` в этом режиме не нужны — стенд собирается из
открытого дерева.

## Безопасность

- Self-hosted раннер исполняет код из репозитория **на этой машине**. Запустить
  job могут только push в `develop-m` (то есть уже смёрженный код) и ручная
  кнопка. События `pull_request` в триггерах нет — PR из форков ничего
  исполнить не могут. Если репозиторий когда-нибудь станет публичным и
  `pull_request` вернут, раннер надо будет снять.
- Ручной запуск с input `branch` собирает ветку, которая **уже открыта в клоне
  владельца**, то есть дерево, которое владелец видит у себя. Ветку из
  произвольного места workflow не приносит: совпадение имени с фактической
  веткой клона проверяется до любых действий со стеком, а на `push` input'а нет
  вовсе.
- Токен. Fetch клона идёт по HTTPS с токеном workflow (`${{ github.token }}`,
  права `permissions: contents: read`). Токен объявлен **только в `env:` шага
  fast-forward** и передаётся заголовком `http.extraheader` одной команде
  `git fetch`:
  - в URL клона не попадает: `git remote -v` в клоне после прогона по-прежнему
    показывает `git@github.com:...`;
  - в `git config` клона и в `url.insteadOf` не попадает;
  - в лог не печатается: шаг не выводит ни токен, ни собранный заголовок.
    GitHub маскирует значение `${{ github.token }}`, но base64-форму заголовка
    — нет, поэтому её нет ни в одном `Write-Host`.
- Отдельный PAT, deploy key и новые секреты для обновления стенда не нужны.
- В репозитории нет ни адресов стенда, ни портов, ни паролей: имена и порты
  приходят из `.env` клона, который не в git.

## Если что-то пошло не так

| Симптом | Причина и что делать |
|---|---|
| Job в `Queued` минутами | раннер офлайн: `Get-ScheduledTask -TaskName crm-ci-runner`, затем `Start-ScheduledTask -TaskName crm-ci-runner`; статус — Settings → Actions → Runners |
| `docker ... permission denied ... dockerDesktopLinuxEngine` | раннер поставлен службой или Docker Desktop не запущен: переставьте в режиме Task и войдите в систему |
| `::error::No git repository at ...` | неверный `LOCAL_CLONE` в `stand.yml` |
| `::error::Clone is on branch ...` | в клоне открыта другая ветка: переключите на `develop-m` и перезапустите, либо запустите job вручную с именем этой ветки в input `branch` |
| `::error::Manual stand build asked for branch ...` | input `branch` не совпал с веткой клона: переключите клон или исправьте input |
| `::error::Clone has uncommitted changes in tracked files` | правки в отслеживаемых файлах при сборке не из `develop-m`: `git status`, затем commit или `git stash` |
| `::warning::Stand was built from ...` | это не ошибка: стенд остался на ветке из input `branch`, следующий прогон (push в `develop-m` или ручной без input) вернёт его на `develop-m` |
| `::error::Refusing to build the stand from ...` | input `branch` пришёл не от ручного запуска (так быть не должно): проверьте триггеры в `stand.yml` |
| `::error::Cannot fast-forward the clone` | в клоне правки в файлах, которые меняет merge: `git status`, затем commit или `git stash` |
| `::warning::Clone has N local commit(s) ahead` | это ваша незапушенная работа: стенд сознательно не тронут |
| `::error::Compose project name is ...` | нет/неверен `COMPOSE_PROJECT_NAME` в `.env` клона |
| `::error::$apiUrl did not respond` | стек поднялся, но API не отвечает: `docker compose logs api` в клоне |
| `::error::pg_dump failed` | контейнер `db` не готов или в нём нет `pg_dump`: `docker compose logs db`; стенд при этом не тронут |
| Диск растёт | `D:\stand-backups\CRMDormitory` не ротируется: чистится руками. Плюс `D:\actions-runner-crm\_work` хранит файлы раннера |

## Что workflow не делает

- Не собирает и не тестирует код: линтеры, `tsc`, `vitest`, `pytest` и сборка
  образов до обновления стенда — отдельная задача. Ошибку в коде этот job
  покажет только как «стенд не поднялся».
- Не трогает боевой сервер и `deploy.yml`.
- Не трогает другие стенды на машине: проект compose определяется `.env` клона,
  а `-p` нигде не переопределяется. Стенд отдела разработки
  (`crm-dormitory-agent`) и любой другой стенд этим workflow не обновляется.
- Не мержит PR и не двигает метки процесса.
- Не делает `docker compose down -v`, не удаляет тома и не чистит Docker
  (`prune`): база стенда и файлы в `uploads` сохраняются.
- Не откатывает миграции: откат БД — только вручную из дампа (см. выше).

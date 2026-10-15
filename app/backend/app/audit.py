"""Журнал действий: перехват write-запросов, маскирование ПДн и месячные партиции.

Весь журнал собран в одном модуле; HTTP-часть — middleware в `app/main.py`.
Механизм записи — два пути, и разница между ними принципиальная.

**Атомарный путь (fail-closed).** Слушатель `before_commit` на `Session` кладёт
строку журнала **в ту же сессию и тот же коммит**, что и само действие. Если
вставка не проходит, падает весь коммит: действие не выполняется, данные не
меняются, а клиент получает 503 — `AuditWriteError` и обработчик в `app/main.py`.
Никакого `try/except` вокруг этой вставки нет: в этом и смысл fail-closed.
Строка журнала едет тем же коммитом, что и действие, поэтому отдельного `fsync`
и отдельного коммита она не добавляет.

**Best-effort путь.** Вход, выход и отказы 4xx/422 не коммитят вообще: у них
коммита нет, а строка нужна — иначе успешный вход исчез бы из журнала. Поэтому
middleware считает коммиты (`AuditContext.atomic_rows`) и после ответа пишет
**одну** строку своей сессией, с настоящими `status` и `duration_ms`. Это
единственное место, где журнал остаётся fail-open, и там ему и место:
гарантировать нечего, потому что ничего не изменилось.

**Контекст запроса** — изменяемый `AuditContext` в `ContextVar`. Middleware
создаёт его до маршрутизации, `get_current_user` дописывает в **тот же объект**
актора и организацию. Мутация общего объекта видна из threadpool, где
выполняются синхронные зависимости, а `ContextVar.set` оттуда — нет.

**Персональные данные** маскируются (`mask`) после вырезания секретов (`redact`)
и до обрезки тела (`truncate`): ФИО, телефон, email и свободный текст попадают в
базу только маской и отпечатком. Отпечаток — `HMAC-SHA256` с секретом подписи
сессий, доменно отделённым от подписи токенов; он нужен, чтобы маска не убила
вопрос «было → стало». Секреты отпечатка не получают: отпечаток пароля — это
подбираемый хеш, а не защита. Секрет сейчас — `JWT_SECRET`; для независимой
ротации в настройках понадобилась бы отдельная переменная.

**Снимок «было → стало»** (`changes`) собирается в том же слушателе по
`session.new` / `session.dirty` / `session.deleted` и лежит на той же строке
журнала: расследованию нужен срез «одно действие — все его изменения», а
отдельная таблица умножила бы число строк в разы. Значения снимка проходят ту же
очистку, что и тело запроса (`redact` → `mask` → `truncate`), иначе маскирование
ПДн обессмысливалось бы. Цена решения измерена: строка журнала вырастает с ~194
байт до ~871-1223, поэтому у снимка есть предел — `DIFF_LIMIT` записей и
`CHANGE_VALUE_LIMIT` символов на значение, остальное сворачивается в
`{"_omitted": N}`.

Партиции по месяцам — свойство PostgreSQL: в юнит-тестах база — SQLite, и там
`audit_events` обычная таблица. Поэтому `ensure_partitions`, `prune_audit` и
`prepare_session` сначала смотрят на диалект и на чужой базе молча выходят.
"""

import hmac
import json
import logging
from collections.abc import MutableMapping
from contextvars import ContextVar, Token
from dataclasses import dataclass, field
from datetime import UTC, date, datetime, timedelta
from hashlib import sha256
from time import perf_counter
from typing import Any

from sqlalchemy import Engine, event, text
from sqlalchemy import inspect as sa_inspect
from sqlalchemy.engine import ExceptionContext
from sqlalchemy.orm import Session

from app import db as db_module
from app.config import get_settings
from app.models.audit import AuditEvent

logger = logging.getLogger(__name__)

KIND_SECURITY = "security"
KIND_DATA = "data"
KIND_NOISE = "noise"
AUDIT_KINDS = (KIND_SECURITY, KIND_DATA, KIND_NOISE)

# Методы, которые меняют данные: только они попадают в журнал.
AUDIT_METHODS = frozenset({"POST", "PUT", "PATCH", "DELETE"})

# Длины совпадают с колонками модели: журнал не должен падать на длинном пути,
# который клиент прислал вместо настоящего маршрута.
PATH_LIMIT = 512
ACTION_LIMIT = 64

# Разделы API, которые меняют доступ, деньги или состав кабинета. Строки этих
# действий хранятся два года: по ним разбираются спорные входы и оплаты.
SECURITY_SECTIONS = frozenset({"auth", "organization", "billing", "tariffs", "users"})
# Настройки общежития (`/api/dormitories/{...}/settings`) меняют права и тарифы
# этого общежития, поэтому тоже считаются действием безопасности.
DORMITORIES_SECTION = "dormitories"
SETTINGS_TAIL = "settings"
# Автоподстановка ячеек: клиент сохраняет их на каждый ввод. Это шум — он пишется
# чаще остальных действий вместе взятых и хранится квартал, а не два года.
CELLS_SEGMENT = "cells"
HOSTELS_SEGMENT = "hostels"
API_SECTION = "api"

# Значения ключей с этими именами в тело не попадают никогда: пароль входа,
# новый пароль, хеш пароля, токен активации/восстановления, заголовки сессии.
# Отпечатка у них нет намеренно: отпечаток пароля — подбираемый хеш, а не защита.
SECRET_KEYS = frozenset(
    {"password", "new_password", "password_hash", "token", "authorization", "cookie"}
)
SECRET_MASK = "***"

# Значения этих ключей — персональные данные: в журнал идёт маска и отпечаток.
NAME_KEYS = frozenset({"full_name"})
PHONE_KEYS = frozenset({"phone"})
EMAIL_KEYS = frozenset({"email"})
# Свободный текст: содержимое не хранится ни в каком виде — ПДн в свободном
# тексте шаблоном надёжно не ловится, поэтому остаются длина и отпечаток.
FREE_TEXT_KEYS = frozenset({"notes", "reason", "additional_info", "text", "comment", "description"})
MASKED_KEYS = NAME_KEYS | PHONE_KEYS | EMAIL_KEYS | FREE_TEXT_KEYS

MASKED_KEY = "_masked"
LENGTH_KEY = "length"
FINGERPRINT_KEY = "fp"
FREE_TEXT_MARK = "free_text"
FINGERPRINT_DOMAIN = b"audit-fingerprint\0"
FINGERPRINT_LENGTH = 16
# Крайние символы телефона, которые остаются видны в маске.
PHONE_HEAD = 2
PHONE_TAIL = 2
# Короче этого номера маскировать по краям нечем: из семи символов четыре —
# это больше половины, поэтому короткий номер маскируется целиком.
MIN_PHONE_LENGTH = 7

# Длинную строку в теле режем: иначе одно поле на 10 КБ занимает всю запись.
STRING_LIMIT = 500

# Таблицы, которые не попадают в снимок «было → стало» вообще.
#
# `activation_tokens` и `recovery_requests` хранят не значение секрета, а его
# отпечаток (`token_hash`, `identifier_hash`), и в списке маскирования этих ключей
# нет: снимок вынес бы в журнал готовые к перебору хеши одним запросом.
#
# `employee_aliases` и `employee_events` — производные записи картотеки: они
# целиком повторяют строку проживающего, но под ключами `value`, `raw_value` и
# `snapshot`, которых список маскирования не знает. Маскирование идёт по имени
# ключа, поэтому телефон и ФИО утекли бы в журнал открытыми — притом что сама
# правка уже описана маской по своей таблице. Ключи вроде `value` в общий список
# добавлять нельзя: под ними лежат осмысленные значения других таблиц
# (`hostel_cells.value`, `report_rows.value`), и маска убила бы журнал.
#
# Сама строка журнала (`audit_events`) исключена потому, что она дописывается в
# тот же коммит: без этого снимок описывал бы собственное появление.
EXCLUDED_TABLES = frozenset(
    {
        "activation_tokens",
        "recovery_requests",
        "employee_aliases",
        "employee_events",
        "audit_events",
    }
)

# Состояние атрибута строки (`AttributeState`) описывается как `Any`: публичного
# экспортируемого имени у него в 2.1 нет, а параметризовать его больше нечем.
# В снимок попадают только колонки: обход идёт по `mapper.column_attrs`, а
# `relationship()` в проекте нет вовсе.
ModelAttribute = Any

OP_INSERT = "insert"
OP_UPDATE = "update"
OP_DELETE = "delete"

# Предел снимка: строка журнала растёт с ~194 байт до ~871-1223, поэтому не более
# `DIFF_LIMIT` записей и `CHANGE_VALUE_LIMIT` символов на значение. Остальное
# сворачивается в `{"_omitted": N}`. Полного снимка широкой строки при этом не
# будет — осознанный компромисс в пользу объёма журнала.
DIFF_LIMIT = 10
CHANGE_VALUE_LIMIT = 300
OMITTED_KEY = "_omitted"

# Ключ копилки снимка в `session.info`. Снимок принадлежит транзакции сессии, а не
# запросу: одна и та же сессия в тестах обслуживает много запросов подряд, и
# остаток одной транзакции не должен попасть в строку следующей.
PENDING_INFO = "audit_pending_changes"


@dataclass
class PendingChanges:
    """Снимок «было → стало», накопленный сессией за текущую транзакцию.

    `awaiting` — пары «объект и его запись» для вставок: автоинкрементный
    идентификатор появляется только к концу `flush`, а запись собирается раньше.
    """

    records: list[dict[str, Any]] = field(default_factory=list)
    awaiting: list[tuple[Any, dict[str, Any]]] = field(default_factory=list)


# Читаемое название есть только у осмысленных действий. Остальным название не
# выдумывается: код вида `post_dormitories_tables_columns_restore` честнее
# сочинённого «Восстановить колонку».
ACTION_TITLES: dict[str, str] = {
    "post_auth_activate": "Задать пароль по ссылке и открыть кабинет",
    "post_auth_activate_resend": "Отправить письмо активации ещё раз",
    "post_auth_login": "Войти по email и паролю",
    "post_auth_logout": "Выйти и погасить cookie сессии",
    "post_auth_password_recovery": "Отправить письмо для восстановления пароля",
    "post_auth_register": "Зарегистрировать пользователя и отправить письмо активации",
    "post_billing_invoices": "Выставить счёт за тариф или решение",
    "patch_billing_invoices": "Изменить статус счёта",
    "post_dormitories": "Создать общежитие",
    "patch_dormitories": "Изменить названия или статус архива общежития",
    "post_dormitories_hostels": "Добавить хостел",
    "post_dormitories_hostels_import": "Загрузить файл импорта размещения персонала",
    "post_dormitories_hostels_import_confirm": "Применить импорт размещения персонала",
    "delete_dormitories_hostels": "Убрать хостел с месяца",
    "post_dormitories_inflow": "Добавить строку притока",
    "post_dormitories_outflow": "Добавить строку оттока",
    "post_dormitories_payments": "Добавить строку выплаты",
    "delete_dormitories_payments": "Очистить весь список аванса или расчёта",
    "post_dormitories_report_rows": "Добавить строку отчёта",
    "patch_dormitories_report_rows": "Изменить строку отчёта",
    "patch_dormitories_residents": "Сохранить поля проживающего",
    "post_dormitories_residents_payments": "Записать проживающего на аванс или расчёт",
    "patch_organization": "Изменить название, ИНН и реквизиты организации",
    "post_organization_invitations": "Пригласить сотрудника в организацию",
    "post_report_templates": "Сохранить структуру отчёта как шаблон",
    "delete_report_templates": "Удалить шаблон отчёта",
    "post_telegram_chat": "Привязать чат бота к кабинету по коду",
    "post_telegram_connect": "Выдать код привязки Telegram",
    "post_telegram_disconnect": "Отвязать Telegram",
    "patch_telegram_subscriptions": "Включить или выключить вид уведомлений",
    "post_telegram_test_message": "Прислать тестовое уведомление",
}

# --- Партиции ---------------------------------------------------------------

POSTGRES_DIALECT = "postgresql"
PARTITION_TABLE = "audit_events"
PARTITION_PREFIX = "audit_events_"
PARTITION_NAME_TEMPLATE = PARTITION_PREFIX + "{year:04d}_{month:02d}"
# DEFAULT-партиция — страховка от пропущенного месяца: с ней строка ложится в
# общую партицию и в логе остаётся WARNING, а без неё вставка падает — и с
# fail-closed это отказ клиенту.
DEFAULT_PARTITION = PARTITION_PREFIX + "default"

# `SET LOCAL` действует до конца транзакции. Он стоит **только** на служебных
# сессиях журнала: ослаблять им бизнес-коммит нельзя.
ASYNC_COMMIT_SQL = text("SET LOCAL synchronous_commit = off")

LIST_PARTITIONS_SQL = text(
    """
    SELECT c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind = 'r'
      AND n.nspname = 'public'
      AND c.relname ~ '^audit_events_[0-9]{4}_[0-9]{2}$'
    ORDER BY c.relname
    """
)

COUNT_DEFAULT_ROWS_SQL = text(f"SELECT count(*) FROM {DEFAULT_PARTITION}")

DELETE_OLD_EVENTS_SQL = text("DELETE FROM audit_events WHERE kind = :kind AND created_at < :before")

# Метка служебной сессии журнала: её коммиты слушатель пропускает, иначе запись
# строки вызвала бы саму себя.
AUDIT_WRITER_INFO = "audit_writer"

# Текст 503 отдаётся в `detail`: фронт показывает `detail` пользователю.
AUDIT_WRITE_DETAIL = "Журнал действий недоступен: изменения не сохранены. Повторите запрос позже."

# Начало стейтмента, которым строка журнала уходит в базу. По нему отказ вставки
# строки отличается от отказа бизнес-данных: других `INSERT` в `audit_events` в
# приложении нет (чтения журнала в этой задаче тоже нет).
JOURNAL_INSERT_MARK = "INSERT INTO AUDIT_EVENTS"


class AuditWriteError(RuntimeError):
    """Строку журнала записать не удалось — коммит действия отменён (fail-closed)."""


@event.listens_for(Engine, "handle_error")
def require_journal_row(context: ExceptionContext) -> BaseException | None:
    """Превратить отказ вставки строки журнала в `AuditWriteError`.

    Строка журнала уходит тем же коммитом, что и действие, поэтому её отказ
    означает отказ всего коммита — и клиенту нужно сказать об этом внятно: 503 с
    русским текстом (`app/main.py`), а не 500 без объяснения.

    Отличить «упала строка журнала» от «упали данные» можно по стейтменту: в
    приложении есть ровно один `INSERT` в `audit_events`, и он наш. Всё
    остальное возвращается как есть — бизнес-ошибки остаются бизнес-ошибками.

    `handle_error` выбран вместо `try/except` вокруг записи, потому что строка
    добавляется в сессию в `before_commit`, а вставку делает обычный `flush`
    коммита: поймать её иначе, чем по факту отказа, негде.
    """
    statement = " ".join((context.statement or "").split()).upper()
    if statement.startswith(JOURNAL_INSERT_MARK):
        return AuditWriteError(AUDIT_WRITE_DETAIL)
    return None


# --- Контекст запроса -------------------------------------------------------


@dataclass
class AuditContext:
    """Всё, что журнал знает о текущем запросе.

    Объект изменяемый: middleware создаёт его один раз, а `get_current_user`
    дописывает актора — уже из threadpool, где доступна только мутация самого
    объекта, но не установка `ContextVar`.
    """

    request_id: str
    method: str
    scope: MutableMapping[str, Any]
    ip: str | None
    user_agent: str | None
    request_body: Any | None
    started: float
    # Префикс, под которым включены роутеры приложения (`/api`). В самом
    # маршруте его нет: он добавляется при `include_router`.
    prefix: str = ""
    actor_id: int | None = None
    organization_id: int | None = None
    # Сколько строк уже ушло атомарным путём, в коммитах этого запроса.
    atomic_rows: int = 0
    # Снимок «было → стало» последнего коммита. Живёт на контексте, а не только
    # на строке: после `commit` история изменений сессии пуста, и взять её для
    # строки, записанной после ответа, больше негде.
    changes: list[dict[str, Any]] | None = None

    @property
    def is_write(self) -> bool:
        """Запрос меняет данные: только такие попадают в журнал."""
        return self.method in AUDIT_METHODS

    def path_template(self) -> str:
        """Шаблон маршрута, а не адрес с подставленным идентификатором.

        Маршрут известен только после сопоставления, поэтому берётся из `scope` в
        момент записи, а не при создании контекста. Если маршрута нет (битый
        адрес), остаётся сырой путь: терять запрос нельзя.

        Путь маршрута хранится без префикса включения (`/api` его не содержит),
        поэтому префикс приписывается здесь — из middleware, который знает, чем
        включал роутеры. Служебные адреса (`/openapi.json`) остаются как есть.
        """
        route = self.scope.get("route")
        template = getattr(route, "path", None)
        if template is None:
            return str(self.scope.get("path", ""))
        template = str(template)
        raw = str(self.scope.get("path", ""))
        if self.prefix and raw.startswith(self.prefix) and not template.startswith(self.prefix):
            return self.prefix + template
        return template

    def duration_ms(self) -> int:
        """Сколько запрос обрабатывался к этому моменту."""
        return int((perf_counter() - self.started) * 1000)

    def values(
        self,
        *,
        status: int | None,
        duration_ms: int | None,
        changes: list[dict[str, Any]] | None = None,
    ) -> dict[str, Any]:
        """Значения колонок строки журнала по этому контексту.

        `status` и `duration_ms` у атомарной строки пустые: на момент коммита
        финальный код ответа ещё неизвестен. Их заполняет только строка, которую
        пишут после ответа. `changes` передаётся явно: снимок принадлежит коммиту,
        а не запросу.
        """
        path = self.path_template()
        return {
            "method": self.method,
            "path": path[:PATH_LIMIT],
            "action": action_code(self.method, path),
            "kind": audit_kind(self.method, path),
            "status": status,
            "duration_ms": duration_ms,
            "actor_id": self.actor_id,
            "organization_id": self.organization_id,
            "ip": self.ip,
            "user_agent": self.user_agent,
            "request_body": self.request_body,
            "path_params": dict(self.scope.get("path_params") or {}) or None,
            "request_id": self.request_id,
            "changes": changes,
        }


# Контекст текущего запроса. Значение живёт в контексте задачи: дочерняя задача
# запроса (и threadpool синхронных зависимостей) его наследует.
audit_context: ContextVar[AuditContext | None] = ContextVar("audit_context", default=None)


def current_context() -> AuditContext | None:
    """Контекст текущего запроса или `None` вне запроса."""
    return audit_context.get()


def start_context(context: AuditContext) -> Token[AuditContext | None]:
    """Сделать контекст текущим. Возвращённый маркер нужен для `finish_context`."""
    return audit_context.set(context)


def finish_context(token: Token[AuditContext | None]) -> None:
    """Вернуть прежнее состояние: контекст не течёт в следующий запрос."""
    audit_context.reset(token)


def record_actor(actor_id: int | None, organization_id: int | None) -> None:
    """Дописать актора в контекст запроса.

    Вызывается из `get_current_user`: аутентификация — единственное место, где
    пользователь становится известен. Именно мутация общего объекта, а не
    `ContextVar.set`: зависимость выполняется в threadpool, где контекст
    скопирован, и установленное там значение наружу не вышло бы.
    """
    context = audit_context.get()
    if context is None:
        return
    context.actor_id = actor_id
    context.organization_id = organization_id


# --- Правила вида и кода действия -------------------------------------------


def _segments(path_template: str) -> list[str]:
    """Части шаблона маршрута без пустых: `/api/auth/login` → `["api","auth","login"]`."""
    return [part for part in path_template.split("/") if part]


def audit_kind(method: str, path_template: str) -> str:
    """Вид действия: `security`, `data` или `noise`.

    Вид определяется маршрутом, а не методом: `PUT` автоподстановки ячейки — шум
    при любом методе, а `POST` в разделе биллинга — действие безопасности. Метод
    принимается для единой подписи с `action_code`.

    Незнакомый маршрут попадает в `data`: терять его нельзя, а назвать
    безопасностью не за что.
    """
    parts = _segments(path_template)
    section = parts[1] if len(parts) > 1 and parts[0] == API_SECTION else ""
    if section in SECURITY_SECTIONS:
        return KIND_SECURITY
    if section == DORMITORIES_SECTION and parts[-1:] == [SETTINGS_TAIL]:
        return KIND_SECURITY
    if CELLS_SEGMENT in parts and (parts[-2:-1] == [CELLS_SEGMENT] or HOSTELS_SEGMENT in parts):
        return KIND_NOISE
    return KIND_DATA


def _word(part: str) -> str:
    """Слово маршрута в код действия: дефис становится подчёркиванием."""
    return "".join(char if char.isalnum() else "_" for char in part.lower())


def action_code(method: str, path_template: str) -> str:
    """Код действия: метод и слова маршрута без подстановок.

    Значения пути в код не попадают: `/api/dormitories/{dormitory_id}` и
    `/api/dormitories/42` — одно действие `patch_dormitories`.
    """
    words = [
        _word(part)
        for part in _segments(path_template)
        if part != API_SECTION and not part.startswith("{")
    ]
    return "_".join([method.lower(), *(word for word in words if word)])[:ACTION_LIMIT]


def action_title(action: str) -> str:
    """Читаемое название действия. Безымянное отдаётся своим кодом."""
    return ACTION_TITLES.get(action, action)


# --- Очистка тела -----------------------------------------------------------


def _is_secret_key(key: Any) -> bool:
    return isinstance(key, str) and key.lower() in SECRET_KEYS


def redact(payload: Any) -> Any:
    """Заменить значения секретных ключей на `***` — по словарям и спискам.

    Пароль входа и токен активации лежат прямо в теле запроса: без этой замены
    они оказались бы в базе открытым текстом.
    """
    if isinstance(payload, dict):
        return {
            key: SECRET_MASK if _is_secret_key(key) else redact(value)
            for key, value in payload.items()
        }
    if isinstance(payload, list):
        return [redact(item) for item in payload]
    return payload


def _fingerprint(value: str) -> str:
    """Отпечаток значения: `HMAC-SHA256`, усечённый до 16 hex-символов.

    Секрет — тот же, что у подписи сессий, но домен отдельный: отпечаток нельзя
    спутать с подписью токена. Отпечаток не раскрывает значение и позволяет
    сопоставить одинаковые значения между строками журнала. У значений с малым
    пространством (телефон) он подбирается перебором, если утечёт секрет, —
    поэтому секрет не попадает ни в журнал, ни в ответы чтения.
    """
    secret = get_settings().jwt_secret.encode("utf-8")
    digest = hmac.new(secret, FINGERPRINT_DOMAIN + value.encode("utf-8"), sha256)
    return digest.hexdigest()[:FINGERPRINT_LENGTH]


def _mask_name(value: str) -> str:
    """«Иванов Иван Иванович» → «И*** И*** И***»."""
    return " ".join(f"{word[0]}{SECRET_MASK}" for word in value.split())


def _mask_phone(value: str) -> str:
    """`+79990001122` → `+7***22`; короткий номер маскируется целиком."""
    if len(value) < MIN_PHONE_LENGTH:
        return SECRET_MASK
    return f"{value[:PHONE_HEAD]}{SECRET_MASK}{value[-PHONE_TAIL:]}"


def _mask_email(value: str) -> str:
    """`ivan@example.com` → `i***@example.com`."""
    local, at, domain = value.partition("@")
    if not at:
        return f"{local[:1]}{SECRET_MASK}"
    return f"{local[:1]}{SECRET_MASK}@{domain}"


def _masked_field(name: str, value: Any) -> Any:
    """Значение поля ПДн: маска и отпечаток вместо самого значения.

    Не строка и пустая строка маскировать нечего — значение возвращается как есть.
    """
    if not isinstance(value, str) or not value:
        return value
    if name in NAME_KEYS:
        mask_value = _mask_name(value)
    elif name in PHONE_KEYS:
        mask_value = _mask_phone(value)
    elif name in EMAIL_KEYS:
        mask_value = _mask_email(value)
    else:
        # Свободный текст: содержимое не хранится, только длина и отпечаток.
        return {
            MASKED_KEY: FREE_TEXT_MARK,
            LENGTH_KEY: len(value),
            FINGERPRINT_KEY: _fingerprint(value),
        }
    return {MASKED_KEY: mask_value, FINGERPRINT_KEY: _fingerprint(value)}


def mask(payload: Any) -> Any:
    """Заменить персональные данные маской и отпечатком — рекурсивно по ключам.

    Применяется после `redact` (секреты уже вырезаны и отпечатка не получают) и
    до `truncate` (обрезать маску незачем). Маскируются значения полей; ссылки на
    объект в `path_params` не трогаются — иначе журнал перестанет отвечать на
    вопрос «по кому действие».

    Не маскируются намеренно: `name` (название общежития, организации, тарифа —
    это объект, а не человек), реквизиты (`inn`, `kpp`, `ogrn`, `address`,
    `buyer_*`), `personnel_number`, `medical_book`, `citizenship`.
    """
    if isinstance(payload, dict):
        masked: dict[Any, Any] = {}
        for key, value in payload.items():
            name = key.lower() if isinstance(key, str) else ""
            if name in MASKED_KEYS:
                masked[key] = _masked_field(name, value)
            else:
                masked[key] = mask(value)
        return masked
    if isinstance(payload, list):
        return [mask(item) for item in payload]
    return payload


def _shorten_strings(payload: Any) -> Any:
    """Рекурсивно обрезать строки до `STRING_LIMIT` символов."""
    if isinstance(payload, str):
        return payload[:STRING_LIMIT]
    if isinstance(payload, dict):
        return {key: _shorten_strings(value) for key, value in payload.items()}
    if isinstance(payload, list):
        return [_shorten_strings(item) for item in payload]
    return payload


def _payload_size(payload: Any) -> int:
    """Размер тела в байтах UTF-8 — тот же, что считает nginx и PostgreSQL."""
    try:
        encoded = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    except (TypeError, ValueError):
        return 0
    return len(encoded.encode("utf-8"))


def truncate(payload: Any, limit: int) -> Any:
    """Ужать тело под лимит.

    Сначала режутся длинные строки: тело из одного поля на 10 КБ после обрезки
    строки помещается целиком, и терять его незачем. Если и после этого тело
    больше лимита, в журнал идёт только факт и размер — восстанавливать из такой
    записи всё равно нечего, а место она занимает. Размер считается по тому, что
    пришло сюда: к этому шагу тело уже очищено от секретов и ПДн.
    """
    shortened = _shorten_strings(payload)
    if _payload_size(shortened) <= limit:
        return shortened
    return {"_truncated": True, "_bytes": _payload_size(payload)}


# --- Снимок «было → стало» --------------------------------------------------
#
# Снимок собирается по состоянию сессии в момент коммита, а не по телу запроса:
# тело знает только то, что прислал клиент, а ручки пишут в базу и сами — пример
# тому GET-ручка вкладки таблицы, создающая недостающие столбцы. Поэтому источник
# истины — `session.new` / `dirty` / `deleted`.


def _identity_value(identity: Any) -> Any:
    """Идентификатор строки: одно значение, а не кортеж из одного элемента.

    У модели с составным ключом остаётся кортеж, у остальных — сам ключ. `None`
    означает, что идентификатора нет: у `INSERT` в таблицу с автоинкрементным
    ключом он появляется только после вставки, а предварительного `flush` в
    снимке нет (`session_changes`). Выдумывать идентификатор нельзя: снимок с
    чужим ключом хуже снимка без ключа.
    """
    if identity is None:
        return None
    return identity[0] if len(identity) == 1 else tuple(identity)


def _entity_id(state: Any) -> Any:
    """Идентификатор строки по её состоянию в сессии."""
    return _identity_value(state.identity)


def _state_attributes(state: Any) -> list[Any]:
    """Состояния колонок строки — по порядку объявления, без связей.

    Ключи берутся у маппера (`column_attrs`), а состояния атрибутов — у строки:
    у маппера состояние атрибута строки не спросить, а у строки нет списка колонок.
    `relationship()` в проекте нет вовсе, поэтому в снимок попадают только колонки.
    """
    return [
        state.attrs[prop.key]
        for prop in state.mapper.column_attrs
        if prop.key not in state.unloaded
    ]


def _is_changed_attribute(attribute: Any) -> bool:
    """Значение атрибута действительно изменилось.

    Объект попадает в `session.dirty` и тогда, когда значение присвоено тем же
    самым; пустая история в снимок не идёт вовсе: «изменений нет» — это не
    «значение стало `None`».
    """
    return bool(attribute.history.has_changes())


def _changed_attributes(state: Any) -> list[Any]:
    """Состояния колонок объекта с непустой историей изменения."""
    return [attr for attr in _state_attributes(state) if _is_changed_attribute(attr)]


def _json_safe(value: Any) -> Any:
    """Привести значение колонки к тому, что переживёт `json.dumps`.

    Значения снимка приходят не из тела запроса, а из базы: колонка бывает
    `date`, `datetime`, `Decimal`, `UUID` или перечислением, а колонка журнала —
    `JSON`. Сериализатор SQLAlchemy упал бы на таком значении, а строка журнала
    идёт тем же коммитом, что и действие, — клиент получил бы 503 из-за одного
    поля даты. Поэтому дата становится строкой ISO, а прочее, что JSON не знает,
    — своим `str`. Списки и словари обходятся: JSON-колонки в проекте хранят
    вложенные структуры (`options`, `section_states`, `settings`).
    """
    if value is None or isinstance(value, str | bool | int | float):
        return value
    if isinstance(value, dict):
        return {str(key): _json_safe(item) for key, item in value.items()}
    if isinstance(value, list | tuple | set | frozenset):
        return [_json_safe(item) for item in value]
    if isinstance(value, datetime | date):
        return value.isoformat()
    return str(value)


def _snapshot_value(field: str, value: Any) -> Any:
    """Значение колонки для снимка — та же очистка, что у тела запроса.

    Порядок тот же — `redact` → `mask` → `truncate`, — поэтому ключи колонок и
    ключи тела переиспользуют одни списки: `full_name`, `phone`, `email`, `notes`
    приходят сюда маской и отпечатком, `password_hash` — без значения и без
    отпечатка. У свободного текста остаются длина и отпечаток: «было → стало» по
    ним видно, а содержимое не сохраняется.

    Приведение к JSON-совместимому виду идёт первым: значения приходят из базы, а
    не из тела, и `datetime` в колонке уронил бы вставку строки журнала.
    Маскирование идёт по обёртке `{field: value}` — правила маскирования выбирают
    по имени поля, — а предел длины применяется уже к самому значению: обёртка на
    пределе свернулась бы в заглушку и поля в ней не осталось бы.
    """
    masked = mask(redact({field: _json_safe(value)}))[field]
    return truncate(masked, CHANGE_VALUE_LIMIT)


def _record(state: Any, op: str, field: str, old: Any, new: Any) -> dict[str, Any]:
    """Одна запись снимка: что за строка, что с ней сделали и как изменилось поле."""
    return {
        "entity": state.mapper.local_table.name,
        "id": _entity_id(state),
        "op": op,
        "field": field,
        "old": old,
        "new": new,
    }


def _row_snapshot(state: Any, op: str) -> list[dict[str, Any]]:
    """Снимок целиком строки: на `INSERT` значения непустых колонок идут в `new`.

    Для `INSERT` и `DELETE` истории изменений нет: строки либо ещё не было, либо
    уже не будет. Пустые значения (`None` и пустая строка) пропускаются — иначе
    широкая модель забивала бы снимок пустыми полями.
    """
    records = []
    for attr in _state_attributes(state):
        value = attr.value
        if value is None or value == "":
            continue
        cleaned = _snapshot_value(attr.key, value)
        old, new = (cleaned, None) if op == OP_DELETE else (None, cleaned)
        records.append(_record(state, op, attr.key, old, new))
    return records


def _update_snapshot(state: Any) -> list[dict[str, Any]]:
    """Снимок `UPDATE`: только реально изменённые поля, с обеими сторонами."""
    records = []
    for attr in _changed_attributes(state):
        history = attr.history
        # `deleted` пуст у значения, которого не было: тогда старое честно `None`.
        old = history.deleted[0] if history.deleted else None
        new = history.added[0] if history.added else None
        records.append(
            _record(
                state,
                OP_UPDATE,
                attr.key,
                _snapshot_value(attr.key, old),
                _snapshot_value(attr.key, new),
            )
        )
    return records


def _row_records(state: Any, op: str) -> list[dict[str, Any]]:
    """Записи снимка по одной строке сессии."""
    if op == OP_UPDATE:
        return _update_snapshot(state)
    return _row_snapshot(state, op)


def _collect_states(session: Session) -> list[tuple[Any, str]]:
    """Строки сессии, которые нужно описать, с их ролью.

    Историю изменений приходится прочитать **до** `flush`: `flush` записывает
    новые значения в базу и обнуляет историю, после него «было» уже неоткуда
    взять. Поэтому состояния читаются здесь, а роль строки (`insert` / `update` /
    `delete`) — из того набора, в котором она сейчас лежит.

    Строка таблицы с секретами (`EXCLUDED_TABLES`) в снимок не попадает вообще:
    её значение — отпечаток секрета, а не сам секрет, и в списке маскирования
    такого ключа нет.
    """
    collected: list[tuple[Any, str]] = []
    # Один и тот же объект может оказаться сразу в двух наборах; описывается один
    # раз — наборы просматриваются в порядке «вставка, правка, удаление».
    seen: set[int] = set()
    pending: tuple[tuple[Any, str], ...] = (
        *((obj, OP_INSERT) for obj in session.new),
        *((obj, OP_UPDATE) for obj in session.dirty),
        *((obj, OP_DELETE) for obj in session.deleted),
    )
    for obj, op in pending:
        marker = id(obj)
        if marker in seen:
            continue
        seen.add(marker)
        state = sa_inspect(obj)
        if state.mapper.local_table.name in EXCLUDED_TABLES:
            continue
        collected.append((state, op))
    return collected


def _limit_records(records: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Ужать снимок под предел: не больше `DIFF_LIMIT` записей.

    Остаток не исчезает молча: `{"_omitted": N}` говорит, сколько изменений не
    попало в снимок. Предел считается по объёму значений строки, а не по числу
    обрезанных записей: запись бывает маленькой (флаг) и большой (свободный
    текст), и считать их штуками — значит не защищать размер строки.
    """
    kept: list[dict[str, Any]] = []
    size = 0
    for record in records:
        if len(kept) >= DIFF_LIMIT:
            break
        grew = _payload_size(record["old"]) + _payload_size(record["new"])
        if kept and size + grew > CHANGE_VALUE_LIMIT:
            break
        kept.append(record)
        size += grew
    omitted = len(records) - len(kept)
    if omitted:
        kept.append({OMITTED_KEY: omitted})
    return kept


def _pending_changes(session: Session) -> PendingChanges:
    """Копилка снимка этой сессии: заводится при первом обращении."""
    pending = session.info.get(PENDING_INFO)
    if not isinstance(pending, PendingChanges):
        pending = PendingChanges()
        session.info[PENDING_INFO] = pending
    return pending


def _forget_pending_changes(session: Session) -> None:
    """Забыть снимок: транзакция кончилась, начинается следующая.

    Остаток нужен именно после коммита: последний `flush` коммита видит те же
    строки, которые уже описаны в строке журнала, и без сброса они попали бы в
    строку следующего коммита того же запроса — второй раз.
    """
    session.info.pop(PENDING_INFO, None)


def _collect_records(session: Session, pending: PendingChanges) -> None:
    """Описать изменения сессии и добавить их в копилку транзакции.

    Вызывается на каждом `flush` и ещё раз на `before_commit` — за остатком,
    которого не коснулся ни один `flush`. Собирать одну и ту же строку дважды
    нельзя, но и не получится: `flush` завершается сбросом истории, и на
    `before_commit` от уже сброшенного объекта не остаётся ни набора, в котором
    он лежал, ни изменений.
    """
    for state, op in _collect_states(session):
        records = _row_records(state, op)
        pending.records.extend(records)
        if op == OP_INSERT:
            # Идентификатор автоинкрементного ключа известен только после
            # завершения `flush`: к `before_commit` он уже есть, а запись собрана
            # раньше — поэтому запоминается пара «объект и его запись».
            pending.awaiting.extend((state.obj(), record) for record in records)


def _fill_identities(pending: PendingChanges) -> None:
    """Дописать идентификаторы строкам, вставленным этой транзакцией.

    Идентификатор берётся у состояния объекта в момент `before_commit`: `flush`
    к этому времени завершён. У строки, которая до коммита ни разу не сбрасывалась
    на диск, идентификатора всё ещё нет — его даст только сам коммит, а строка
    журнала пишется раньше. Тогда в записи честно остаётся `id = None`: выдумать
    ключ хуже, чем его не указать.
    """
    for obj, record in pending.awaiting:
        record["id"] = _identity_value(sa_inspect(obj).identity)


def pending_changes(session: Session, *, take: bool = False) -> list[dict[str, Any]]:
    """Снимок «было → стало», накопленный сессией за текущую транзакцию.

    Снимок копится по ходу транзакции, а не собирается один раз на коммите:
    ручки пишут и промежуточными `flush` — `record_changed` в `app/personnel.py`
    сбрасывает на диск событие сотрудника прямо посреди обработки запроса, — а
    `flush` обнуляет историю изменений, и на коммите от правки не остаётся ничего.
    Копится он в `session.info`: снимок принадлежит транзакции сессии, а не
    запросу, и служебная сессия журнала его не трогает.

    `take=True` забирает снимок себе: строка журнала уносит его в коммит, а
    следующая транзакция той же сессии начинает с чистого листа. Пустой список
    означает коммит без изменений — тогда в строке журнала остаётся `NULL`, а не
    `[]`.
    """
    pending = _pending_changes(session)
    changes = _limit_records(pending.records)
    if take:
        pending.records = []
        pending.awaiting = []
    return changes


# --- Запись -----------------------------------------------------------------


def _is_postgres(db: Session) -> bool:
    """Настоящая PostgreSQL: партиции и `SET LOCAL` есть только у неё."""
    return db.get_bind().dialect.name == POSTGRES_DIALECT


def audit_session() -> Session:
    """Сессия для служебных записей журнала: её коммиты слушатель пропускает."""
    db = db_module.SessionLocal()
    db.info[AUDIT_WRITER_INFO] = True
    return db


def prepare_session(db: Session) -> None:
    """Первым стейтментом транзакции отпустить запись на диск.

    Только для служебных сессий журнала: ослабить `synchronous_commit` у
    бизнес-коммита значило бы потерять не строку журнала, а само действие.
    """
    if not get_settings().audit_async_commit:
        return
    if not _is_postgres(db):
        return
    db.execute(ASYNC_COMMIT_SQL)


@event.listens_for(Session, "after_flush")
def collect_flushed_changes(session: Session, flush_context: Any) -> None:
    """Накопить снимок изменений, ушедших в этот `flush`.

    Копится именно здесь, а не только на коммите: `flush` обнуляет историю
    изменений, и ручка, которая сбрасывает данные на диск посреди обработки
    запроса, иначе не оставила бы в снимке ни одного поля. Подробности — в
    `pending_changes`.

    `flush_context` в подписи обязателен: его передаёт SQLAlchemy, и без него
    слушатель не будет вызван.
    """
    if session.info.get(AUDIT_WRITER_INFO):
        return
    if audit_context.get() is None or not get_settings().audit_enabled:
        return
    _collect_records(session, _pending_changes(session))


@event.listens_for(Session, "after_commit")
@event.listens_for(Session, "after_rollback")
def forget_pending_changes(session: Session) -> None:
    """Забыть снимок: транзакция закончилась.

    После коммита остаток обязателен к сбросу: последний `flush` коммита видит те
    же строки, что уже описаны в строке журнала, — без сброса они попали бы в
    строку следующего коммита того же запроса второй раз. После отката снимок
    неверен целиком: изменений в базе нет.
    """
    _forget_pending_changes(session)


@event.listens_for(Session, "before_commit")
def add_atomic_row(session: Session) -> None:
    """Положить строку журнала в тот же коммит, что и само действие.

    `before_commit` вызывается до сброса изменений в базу, поэтому `session.add`
    здесь попадает в тот же flush и тот же коммит: либо в базы есть и действие, и
    его строка, либо нет ни того ни другого.

    Снимок «было → стало» к этому моменту уже накоплен `collect_flushed_changes`;
    здесь к нему добавляется остаток — изменения, которых не коснулся ни один
    `flush` (ручка добавила строку и сразу коммитит). Строка журнала пишется, если
    **есть изменения** или метод запроса — write. Так в журнал попадает, например,
    `GET` вкладки таблицы, который создаёт недостающие столбцы и коммитит:
    прежнее правило «только write-методы» теряло такие изменения.

    `try/except` вокруг строки журнала нет: это и есть fail-closed. Отказ
    вставки превращается в `AuditWriteError` слушателем `Engine.handle_error` —
    по стейтменту видно, что упала именно строка журнала, а не данные.
    """
    if session.info.get(AUDIT_WRITER_INFO):
        return
    context = audit_context.get()
    if context is None or not get_settings().audit_enabled:
        return
    pending = _pending_changes(session)
    _collect_records(session, pending)
    _fill_identities(pending)
    # Снимок забирается строкой журнала: следующая транзакция этой же сессии
    # начинает с чистого листа, а не дописывает чужие изменения.
    changes = pending_changes(session, take=True)
    if not changes and not context.is_write:
        return
    context.changes = changes or None
    values = context.values(status=None, duration_ms=None, changes=context.changes)
    session.add(AuditEvent(**values))
    context.atomic_rows += 1


def write_audit(event_row: AuditEvent) -> None:
    """Записать строку журнала своей сессией — вне транзакции действия.

    Так попадают в журнал вход, выход и отказы: коммита у них нет, а строка
    нужна. Это единственный fail-open путь журнала, и гарантировать здесь нечего:
    ничего не изменилось, отказывать клиенту не в чем.

    Фабрика читается из модуля `app.db` в момент вызова, а не импортируется по
    имени: так тесты подменяют её на свою базу, не трогая журнал.
    """
    try:
        db = audit_session()
        try:
            prepare_session(db)
            db.add(event_row)
            db.commit()
        finally:
            db.close()
    except Exception:
        logger.warning("Не удалось записать строку журнала действий", exc_info=True)


def write_best_effort(context: AuditContext, *, status: int) -> None:
    """Записать строку после ответа, если в запросе не было ни одного коммита.

    Вход, выход, отказы 4xx/422 и падения не коммитят — атомарному пути там
    нечего записывать, а строка нужна. Всё, что уже ушло своим коммитом, повторно
    не пишется: одна строка журнала на коммит. `changes` берётся с контекста:
    после `commit` история изменений сессии пуста, и снимок последнего коммита
    сохранил только он.
    """
    if not context.is_write or context.atomic_rows:
        return
    values = context.values(
        status=status, duration_ms=context.duration_ms(), changes=context.changes
    )
    write_audit(AuditEvent(**values))


# --- Месячные партиции ------------------------------------------------------


def month_start(moment: datetime) -> date:
    """Первое число месяца момента (в UTC) — граница партиции."""
    return moment.astimezone(UTC).date().replace(day=1)


def shift_month(month: date, offset: int) -> date:
    """Первое число месяца через `offset` месяцев от `month`."""
    total = month.year * 12 + month.month - 1 + offset
    return date(total // 12, total % 12 + 1, 1)


def next_month(month: date) -> date:
    """Первое число следующего месяца."""
    return shift_month(month, 1)


def month_partition(month: date) -> str:
    """Имя партиции месяца: `audit_events_2026_10`."""
    return PARTITION_NAME_TEMPLATE.format(year=month.year, month=month.month)


def partition_month(name: str) -> date | None:
    """Месяц партиции по её имени. Чужое имя — `None`."""
    suffix = name.removeprefix(PARTITION_PREFIX)
    year, _, month = suffix.partition("_")
    if len(year) != 4 or not year.isdigit() or not month.isdigit():
        return None
    if not 1 <= int(month) <= 12:
        return None
    return date(int(year), int(month), 1)


def _partition_names(db: Session) -> list[str]:
    """Имена существующих месячных партиций журнала — по каталогу PostgreSQL."""
    return list(db.scalars(LIST_PARTITIONS_SQL))


def ensure_partitions(db: Session, ahead: int) -> None:
    """Создать партиции: `DEFAULT` и месячные на текущий и следующие `ahead`.

    Месяц без партиции — потерянная запись журнала, а с fail-closed ещё и отказ
    клиенту. Поэтому запас — год вперёд, а `DEFAULT`-партиция ловит пропущенный
    месяц: строка ляжет туда, и в логе будет WARNING.

    На не-PostgreSQL работы нет: `PARTITION OF` — синтаксическая ошибка SQLite.
    """
    if not _is_postgres(db):
        return
    db.execute(
        text(
            f"CREATE TABLE IF NOT EXISTS {DEFAULT_PARTITION} PARTITION OF {PARTITION_TABLE} DEFAULT"
        )
    )
    current = month_start(datetime.now(UTC))
    for offset in range(ahead + 1):
        month = shift_month(current, offset)
        # Имя и границы собраны из даты, а не из ввода: подставлять в DDL
        # пользовательские значения здесь нечему.
        db.execute(
            text(
                f"CREATE TABLE IF NOT EXISTS {month_partition(month)} "
                f"PARTITION OF {PARTITION_TABLE} "
                f"FOR VALUES FROM ('{month.isoformat()}') TO ('{next_month(month).isoformat()}')"
            )
        )
    db.commit()


def warn_about_default_rows(db: Session) -> None:
    """Предупредить, если строки попали в `DEFAULT`-партицию.

    Строка там не теряется, но означает пропущенный месяц: следующая месячная
    партиция в её диапазоне не создастся, пока строку оттуда не уберут.
    """
    if not _is_postgres(db):
        return
    rows = db.scalar(COUNT_DEFAULT_ROWS_SQL)
    if rows:
        logger.warning(
            "В DEFAULT-партиции журнала действий %s строк: месячная партиция пропущена", rows
        )


def retention_days(kind: str) -> int:
    """Срок хранения строк вида.

    Два года — только у действий безопасности. Отдельного срока для `data` в
    настройках нет: `data` и `noise` различаются не сроком, а тем, что шум
    (автоподстановка ячеек) пишется чаще всех остальных действий вместе взятых.
    """
    settings = get_settings()
    if kind == KIND_SECURITY:
        return settings.audit_retention_days_security
    return settings.audit_retention_days_noise


def prune_audit(db: Session, now: datetime | None = None) -> None:
    """Убрать строки, срок хранения которых истёк.

    Месячная партиция, целиком попавшая за самый длинный срок, отбрасывается
    таблицей: в ней нет ни одной строки, которую нужно хранить, а `DROP` дешевле
    удаления построчно. `DEFAULT`-партиция не отбрасывается никогда — её строки
    удаляются по сроку вместе с остальными.

    На не-PostgreSQL работы нет: партиций там не существует.
    """
    if not _is_postgres(db):
        return
    moment = now or datetime.now(UTC)
    oldest_kept = month_start(moment - timedelta(days=get_settings().audit_retention_days_security))
    for name in _partition_names(db):
        month = partition_month(name)
        if month is not None and next_month(month) <= oldest_kept:
            # Имя пришло из каталога PostgreSQL и разобрано `partition_month`.
            db.execute(text(f'DROP TABLE IF EXISTS "{name}"'))
    for kind in AUDIT_KINDS:
        db.execute(
            DELETE_OLD_EVENTS_SQL,
            {"kind": kind, "before": moment - timedelta(days=retention_days(kind))},
        )
    db.commit()


# --- Смена месяца -----------------------------------------------------------

# Месяц, партиции которого уже готовы. Это состояние процесса, а не базы: в одном
# процессе смена месяца случается один раз.
_ensured_month: date | None = None


def month_guard(now: datetime | None = None) -> bool:
    """True — месяц сменился с момента последней подготовки партиций.

    Ничего не меняет: месяц отмечает `refresh_audit_storage`, когда работа
    действительно сделана. Иначе упавшая подготовка запомнилась бы как успешная и
    повторить её было бы некому.
    """
    return _ensured_month != month_start(now or datetime.now(UTC))


def refresh_audit_storage(now: datetime | None = None) -> None:
    """Подготовить партиции и убрать устаревшее — в своей сессии.

    Вызывается при старте приложения и на смене месяца: планировщика в задаче
    нет, поэтому второй раз её запускает первый запрос после смены месяца —
    `month_guard` говорит, что пора. Ошибка не мешает приложению подняться:
    пропущенная подготовка партиций с fail-closed означает отказ write-ручек, и
    приложение всё равно должно подняться, чтобы этот отказ отдать.
    """
    global _ensured_month
    moment = now or datetime.now(UTC)
    try:
        db = audit_session()
        try:
            ensure_partitions(db, get_settings().audit_partitions_ahead)
            warn_about_default_rows(db)
            prune_audit(db, moment)
        finally:
            db.close()
    except Exception:
        logger.warning("Не удалось подготовить партиции журнала действий", exc_info=True)
        return
    _ensured_month = month_start(moment)

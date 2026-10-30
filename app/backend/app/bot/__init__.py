"""Бот Telegram: тонкий воркер поверх Bot API и очереди CRM.

Запускается как `python -m app.bot` отдельным контейнером на том же образе, что
и `api`. Вебхука нет: бот сам ходит в Bot API за обновлениями (`getUpdates`) и
сам забирает готовые уведомления из CRM. Наружу не открывается ни один роут.

Состояния бот не хранит: привязка, подписки и очередь доставки живут в базе
CRM. Здесь только два HTTP-разговора — с Bot API (`app/telegram.py`) и с CRM
(`app/api/telegram.py`), — и правило «ошибка одного шага не убивает цикл».

В лог идёт только тип ошибки и код ответа: ни токена бота, ни сервисного
секрета, ни `chat_id`, ни текста сообщения. `chat_id` — персональные данные
получателя, а сервисный секрет вообще не должен покидать процесс.
"""

import enum
import logging
import time
from dataclasses import dataclass

import httpx

from app import telegram as telegram_client
from app.config import Settings, get_settings
from app.security import BOT_TOKEN_HEADER

logger = logging.getLogger(__name__)

# Команда запуска. Telegram дописывает к команде имя бота (`/start@MyBot`),
# поэтому при разборе имя отбрасывается.
START_COMMAND = "/start"

HELP_TEXT = (
    "Этот бот присылает уведомления из кабинета «Домовой».\n"
    "Откройте «Личные данные» → «Уведомления в Telegram», получите код и "
    "отправьте его командой /start <код>."
)
LINKED_TEXT = "Готово, {full_name}. Уведомления будут приходить сюда."
INVALID_CODE_TEXT = "Код не подошёл, получите новый в кабинете."
FAILURE_TEXT = "Не получилось обработать команду. Попробуйте позже."

# Что бот отправляет в CRM, если Bot API отказал. В CRM уходит код, а не текст
# ответа Telegram: в описании ошибки может быть текст самого сообщения.
SEND_FAILED_REASON = "send_failed"

# Потолок ленты одного чата за один заход.
FEED_LIMIT = 20

# Чаты, где бот не отвечает на посторонний текст: в группе бот сидит ради
# уведомлений, а не ради подсказок, и ответ на каждое сообщение был бы шумом.
GROUP_CHAT_TYPES = frozenset({"group", "supergroup"})


class LinkOutcome(enum.Enum):
    """Чем закончилась привязка чата по коду.

    Исходы различаются, потому что человеку нужны разные ответы: успех с ФИО,
    непригодный код и сбой на стороне CRM — три разные ситуации. Раньше все три
    выглядели как «код не подошёл», и человек с исправным кодом получал совет,
    который ничем не помогал.
    """

    LINKED = "linked"
    INVALID_CODE = "invalid_code"
    FAILURE = "failure"


@dataclass(frozen=True)
class LinkResult:
    """Исход привязки и, только для `LINKED`, ФИО владельца кода."""

    outcome: LinkOutcome
    full_name: str = ""


def is_start(text: str) -> bool:
    """Команда запуска: `/start`, `/start <код>` или `/start@ИмяБота <код>`."""
    parts = text.strip().split()
    if not parts:
        return False
    return parts[0].split("@")[0] == START_COMMAND


def start_code(text: str) -> str | None:
    """Код из `/start <код>`. `None` — кода в команде нет.

    Чистая функция: разбор команды проверяется тестом без сети.
    """
    if not is_start(text):
        return None
    parts = text.strip().split()
    if len(parts) < 2 or not parts[1]:
        return None
    return parts[1]


def _crm_request(
    method: str,
    path: str,
    *,
    crm_client: httpx.Client,
    settings: Settings,
    json: dict[str, object] | None = None,
    params: dict[str, str | int] | None = None,
) -> httpx.Response | None:
    """Запрос к CRM с сервисным токеном. Сбой связи — `None` и запись в лог.

    Сервисный токен уходит в заголовке и в лог не попадает: логируется только
    путь без параметров и имя типа ошибки.
    """
    base = settings.telegram_crm_api_url.rstrip("/")
    try:
        return crm_client.request(
            method,
            f"{base}/api{path}",
            json=json,
            params=params,
            headers={BOT_TOKEN_HEADER: settings.telegram_service_token},
        )
    except httpx.HTTPError as error:
        logger.error("CRM недоступна (%s): %s", path, type(error).__name__)
        return None


def is_group_chat(chat: dict[str, object]) -> bool:
    """Групповой чат. Отсутствующий `type` считается приватным чатом."""
    return chat.get("type") in GROUP_CHAT_TYPES


def link_reply_text(result: LinkResult) -> str:
    """Текст ответа человеку по исходу привязки.

    Тексты живут здесь, а не в кабинете: карточка не дублирует то, что бот пишет
    в чат, иначе две копии одной фразы разъезжаются.
    """
    if result.outcome is LinkOutcome.LINKED:
        return LINKED_TEXT.format(full_name=result.full_name)
    if result.outcome is LinkOutcome.INVALID_CODE:
        return INVALID_CODE_TEXT
    return FAILURE_TEXT


def link_chat_via_crm(
    code: str,
    chat_id: str,
    username: str | None,
    *,
    crm_client: httpx.Client,
    settings: Settings,
) -> LinkResult:
    """Привязать чат по коду: «привязан (ФИО)», «код не подошёл» или «сбой».

    Разбор ответа CRM намеренно узкий: непригодным код считается только по
    `410` — единственному ответу, который CRM даёт именно за неизвестный,
    просроченный или погашенный код. Всё остальное (`None` — CRM недоступна,
    `401`, `5xx`, `200` без `linked: true`) — сбой на нашей стороне, и человеку
    нельзя говорить «код не подошёл»: новый код в этой ситуации не поможет.
    """
    response = _crm_request(
        "POST",
        "/telegram/chat",
        crm_client=crm_client,
        settings=settings,
        json={"code": code, "chat_id": chat_id, "username": username},
    )
    if response is None:
        return LinkResult(LinkOutcome.FAILURE)
    if response.status_code == httpx.codes.GONE:
        return LinkResult(LinkOutcome.INVALID_CODE)
    if response.status_code != httpx.codes.OK:
        return LinkResult(LinkOutcome.FAILURE)
    try:
        body = response.json()
    except ValueError:
        return LinkResult(LinkOutcome.FAILURE)
    if not isinstance(body, dict) or body.get("linked") is not True:
        return LinkResult(LinkOutcome.FAILURE)
    full_name = body.get("full_name")
    if not isinstance(full_name, str) or not full_name:
        return LinkResult(LinkOutcome.FAILURE)
    return LinkResult(LinkOutcome.LINKED, full_name)


def fetch_feed(
    chat_id: str, *, crm_client: httpx.Client, settings: Settings
) -> list[dict[str, object]]:
    """Готовые уведомления чата. Пустой список — «ничего нет» или сбой CRM."""
    response = _crm_request(
        "GET",
        "/telegram/feed",
        crm_client=crm_client,
        settings=settings,
        params={"chat_id": chat_id, "limit": FEED_LIMIT},
    )
    if response is None or response.status_code != httpx.codes.OK:
        return []
    try:
        body = response.json()
    except ValueError:
        return []
    if not isinstance(body, dict):
        return []
    items = body.get("items")
    if not isinstance(items, list):
        return []
    return [item for item in items if isinstance(item, dict)]


def fetch_chats(*, crm_client: httpx.Client, settings: Settings) -> list[str]:
    """Чаты всех живых привязок. Сбой CRM — пустой список.

    Без этого списка бот знал бы только те чаты, откуда пришло обновление, и
    готовое уведомление ждало бы, пока получатель сам что-нибудь напишет боту.
    Уведомление адресовано человеку, а не ответу на его сообщение, поэтому
    лента обходится по всем подключённым чатам каждый цикл.
    """
    response = _crm_request("GET", "/telegram/chats", crm_client=crm_client, settings=settings)
    if response is None or response.status_code != httpx.codes.OK:
        return []
    try:
        body = response.json()
    except ValueError:
        return []
    if not isinstance(body, dict):
        return []
    items = body.get("items")
    if not isinstance(items, list):
        return []
    return [item for item in items if isinstance(item, str) and item]


def report_failed(delivery_id: object, *, crm_client: httpx.Client, settings: Settings) -> None:
    """Сообщить CRM, что Bot API отказал: доставка больше не выдаётся."""
    if not isinstance(delivery_id, int):
        return
    _crm_request(
        "POST",
        f"/telegram/feed/{delivery_id}/failed",
        crm_client=crm_client,
        settings=settings,
        json={"error": SEND_FAILED_REASON},
    )


def drain_feed(
    chat_id: str, *, bot_client: httpx.Client, crm_client: httpx.Client, settings: Settings
) -> None:
    """Отправить всё, что CRM приготовила этому чату."""
    for item in fetch_feed(chat_id, crm_client=crm_client, settings=settings):
        text = item.get("text")
        if not isinstance(text, str) or not text:
            continue
        if telegram_client.send_message(
            chat_id=chat_id, text=text, client=bot_client, settings=settings
        ):
            continue
        # Одна неудачная отправка не мешает остальным пунктам ленты.
        report_failed(item.get("id"), crm_client=crm_client, settings=settings)


def handle_update(
    update: dict[str, object],
    *,
    bot_client: httpx.Client,
    crm_client: httpx.Client,
    settings: Settings,
) -> str | None:
    """Обработать одно обновление. Возвращает `chat_id`, которому нужна лента.

    Обновление без текста или без чата — это не ошибка, а тип, который бот не
    понимает: он пропускается молча.
    """
    message = update.get("message")
    if not isinstance(message, dict):
        return None
    chat = message.get("chat")
    if not isinstance(chat, dict) or chat.get("id") is None:
        return None
    chat_id = str(chat["id"])

    text = message.get("text")
    if not isinstance(text, str) or not text.strip():
        return chat_id

    if not is_start(text):
        # Сообщение без команды. В приватном чате это чаще всего код, вставленный
        # без `/start`, — человек ждёт ответа, и молчание выглядит как поломка.
        # В группе бот молчит: там он ради уведомлений, а не ради подсказок.
        if not is_group_chat(chat):
            telegram_client.send_message(
                chat_id=chat_id, text=HELP_TEXT, client=bot_client, settings=settings
            )
        return chat_id

    code = start_code(text)
    if code is None:
        telegram_client.send_message(
            chat_id=chat_id, text=HELP_TEXT, client=bot_client, settings=settings
        )
        return chat_id

    sender = message.get("from")
    username = sender.get("username") if isinstance(sender, dict) else None
    result = link_chat_via_crm(
        code,
        chat_id,
        username if isinstance(username, str) else None,
        crm_client=crm_client,
        settings=settings,
    )
    telegram_client.send_message(
        chat_id=chat_id,
        text=link_reply_text(result),
        client=bot_client,
        settings=settings,
    )
    return chat_id


def poll_once(
    *,
    offset: int | None,
    bot_client: httpx.Client,
    crm_client: httpx.Client,
    settings: Settings,
) -> int | None:
    """Один шаг цикла: обновления → привязка → лента каждого подключённого чата.

    Лента обходится не только у чатов из свежих обновлений, но и у всех живых
    привязок: уведомление адресовано человеку, а не ответу на его сообщение, и
    ждать, пока получатель сам напишет боту, нельзя.

    Возвращает смещение для следующего `getUpdates`. Ни одно падение шага не
    выходит наружу: ошибка одного обновления не должна останавливать остальные,
    а ошибку всего запроса ловит `run_forever` и просто ждёт следующего круга.
    """
    updates = telegram_client.get_updates(offset=offset, client=bot_client, settings=settings)
    next_offset = offset
    chats: list[str] = []
    for update in updates:
        update_id = update.get("update_id")
        if isinstance(update_id, int):
            next_offset = update_id + 1
        try:
            chat_id = handle_update(
                update, bot_client=bot_client, crm_client=crm_client, settings=settings
            )
        except Exception as error:
            logger.error("Обновление не обработано: %s", type(error).__name__)
            continue
        if chat_id is not None:
            chats.append(chat_id)

    try:
        chats.extend(fetch_chats(crm_client=crm_client, settings=settings))
    except Exception as error:
        logger.error("Список чатов не получен: %s", type(error).__name__)

    for chat_id in dict.fromkeys(chats):
        try:
            drain_feed(chat_id, bot_client=bot_client, crm_client=crm_client, settings=settings)
        except Exception as error:
            logger.error("Лента не отправлена: %s", type(error).__name__)
    return next_offset


def run_forever(*, settings: Settings | None = None) -> None:
    """Цикл бота: опрос, отправка, пауза. Работает до остановки контейнера."""
    resolved = settings or get_settings()
    timeout = resolved.telegram_request_timeout_seconds
    offset: int | None = None
    with httpx.Client(timeout=timeout) as bot_client, httpx.Client(timeout=timeout) as crm_client:
        while True:
            try:
                offset = poll_once(
                    offset=offset,
                    bot_client=bot_client,
                    crm_client=crm_client,
                    settings=resolved,
                )
            except Exception as error:
                logger.error("Шаг бота не удался: %s", type(error).__name__)
            time.sleep(resolved.telegram_poll_interval_seconds)


def main() -> None:
    """Точка входа `python -m app.bot`."""
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    settings = get_settings()
    missing = [
        name
        for name, value in (
            ("TELEGRAM_BOT_TOKEN", settings.telegram_bot_token),
            ("TELEGRAM_SERVICE_TOKEN", settings.telegram_service_token),
        )
        if not value.strip()
    ]
    if missing:
        # Выход до первого сетевого вызова: без токенов бот всё равно ничего не
        # сможет, а внятная запись в лог объясняет, что именно не задано.
        logger.error("Бот не запущен: не заданы %s", ", ".join(missing))
        return
    logger.info("Бот запущен: опрос Bot API каждые %s с", settings.telegram_poll_interval_seconds)
    run_forever(settings=settings)

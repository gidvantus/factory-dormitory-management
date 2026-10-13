"""Бот: разбор `/start`, привязка чата, лента и живучесть цикла.

Сети нет: оба HTTP-разговора бота (Bot API и CRM) идут через `httpx.MockTransport`.
Проверяется разбор обновлений, содержимое запросов к CRM и то, что сбой одного
шага не останавливает цикл.
"""

import logging
from collections.abc import Callable

import httpx
import pytest

from app import bot
from app.config import Settings, get_settings

BOT_TOKEN = "111111:unit-test-bot-token"
SERVICE_TOKEN = "unit-test-service-token"
CHAT_ID = "4242"

CRM_URL = "http://crm.test"


def make_settings(
    *,
    bot_token: str = BOT_TOKEN,
    service_token: str = SERVICE_TOKEN,
    crm_url: str = CRM_URL,
) -> Settings:
    """Настройки с явными значениями: окружение машины в тестах не участвует."""
    return Settings(
        database_url="sqlite+pysqlite:///:memory:",
        jwt_secret="unit-test-secret-value-0123456789",
        telegram_bot_token=bot_token,
        telegram_bot_username="DormitoryNotifyBot",
        telegram_service_token=service_token,
        telegram_api_base_url="https://api.telegram.test",
        telegram_crm_api_url=crm_url,
        telegram_request_timeout_seconds=1.0,
    )


def client_with(handler: Callable[[httpx.Request], httpx.Response]) -> httpx.Client:
    return httpx.Client(transport=httpx.MockTransport(handler))


def test_start_command_parsing() -> None:
    assert bot.start_code("/start КОД") == "КОД"
    assert bot.start_code("/start@DormitoryNotifyBot КОД") == "КОД"
    assert bot.start_code("  /start   КОД  ") == "КОД"
    assert bot.start_code("/start") is None
    assert bot.start_code("/start ") is None
    assert bot.start_code("привет") is None
    assert bot.is_start("/start") is True
    assert bot.is_start("/start@Bot КОД") is True
    assert bot.is_start("старт") is False


def test_poll_once_links_the_chat_and_drains_the_feed() -> None:
    crm_calls: list[httpx.Request] = []
    bot_calls: list[httpx.Request] = []

    def crm_handler(request: httpx.Request) -> httpx.Response:
        crm_calls.append(request)
        if request.url.path == "/api/telegram/chat":
            return httpx.Response(200, json={"linked": True, "full_name": "Иванов Иван"})
        if request.url.path == "/api/telegram/feed":
            return httpx.Response(200, json={"items": [{"id": 5, "text": "Выселение"}]})
        return httpx.Response(404, json={"detail": "нет"})

    def bot_handler(request: httpx.Request) -> httpx.Response:
        bot_calls.append(request)
        if request.url.path.endswith("/getUpdates"):
            return httpx.Response(
                200,
                json={
                    "ok": True,
                    "result": [
                        {
                            "update_id": 10,
                            "message": {
                                "chat": {"id": int(CHAT_ID), "username": "ivan"},
                                "from": {"username": "ivan"},
                                "text": "/start КОД-ИЗ-КАБИНЕТА",
                            },
                        }
                    ],
                },
            )
        return httpx.Response(200, json={"ok": True, "result": {"message_id": 1}})

    settings = make_settings()
    with (
        client_with(crm_handler) as crm_client,
        client_with(bot_handler) as bot_client,
    ):
        offset = bot.poll_once(
            offset=None, bot_client=bot_client, crm_client=crm_client, settings=settings
        )

    assert offset == 11
    chat_calls = [request for request in crm_calls if request.url.path == "/api/telegram/chat"]
    assert len(chat_calls) == 1
    assert chat_calls[0].headers["X-Bot-Token"] == SERVICE_TOKEN
    assert b'"chat_id":"4242"' in chat_calls[0].content

    feed_calls = [request for request in crm_calls if request.url.path == "/api/telegram/feed"]
    assert len(feed_calls) == 1
    assert feed_calls[0].url.params["chat_id"] == CHAT_ID

    sent_texts = [
        request.content.decode("utf-8")
        for request in bot_calls
        if request.url.path.endswith("/sendMessage")
    ]
    assert len(sent_texts) == 2
    assert "Готово, Иванов Иван" in sent_texts[0]
    assert "Выселение" in sent_texts[1]
    # Разметка Telegram не используется: `parse_mode` не ставится вовсе.
    assert all("parse_mode" not in text for text in sent_texts)


def test_invalid_code_answers_with_the_same_short_text() -> None:
    bot_calls: list[httpx.Request] = []

    def crm_handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(410, json={"linked": False, "reason": "invalid_code"})

    def bot_handler(request: httpx.Request) -> httpx.Response:
        bot_calls.append(request)
        if request.url.path.endswith("/getUpdates"):
            return httpx.Response(
                200,
                json={
                    "ok": True,
                    "result": [
                        {
                            "update_id": 1,
                            "message": {"chat": {"id": int(CHAT_ID)}, "text": "/start мусор"},
                        }
                    ],
                },
            )
        return httpx.Response(200, json={"ok": True, "result": {}})

    with (
        client_with(crm_handler) as crm_client,
        client_with(bot_handler) as bot_client,
    ):
        bot.poll_once(
            offset=None,
            bot_client=bot_client,
            crm_client=crm_client,
            settings=make_settings(),
        )

    texts = [
        request.content.decode("utf-8")
        for request in bot_calls
        if request.url.path.endswith("/sendMessage")
    ]
    assert any(bot.INVALID_CODE_TEXT in text for text in texts)


def test_plain_start_answers_with_help() -> None:
    bot_calls: list[httpx.Request] = []

    def empty_crm(request: httpx.Request) -> httpx.Response:
        # В CRM бот ходит только за лентой: без кода привязки её не с чем связать,
        # но лента всё равно запрашивается — она возвращается пустой.
        return httpx.Response(200, json={"items": []})

    def bot_handler(request: httpx.Request) -> httpx.Response:
        bot_calls.append(request)
        if request.url.path.endswith("/getUpdates"):
            return httpx.Response(
                200,
                json={
                    "ok": True,
                    "result": [
                        {
                            "update_id": 2,
                            "message": {"chat": {"id": int(CHAT_ID)}, "text": "/start"},
                        }
                    ],
                },
            )
        return httpx.Response(200, json={"ok": True, "result": {}})

    with (
        client_with(empty_crm) as crm_client,
        client_with(bot_handler) as bot_client,
    ):
        offset = bot.poll_once(
            offset=1,
            bot_client=bot_client,
            crm_client=crm_client,
            settings=make_settings(),
        )

    assert offset == 3
    texts = [
        request.content.decode("utf-8")
        for request in bot_calls
        if request.url.path.endswith("/sendMessage")
    ]
    assert len(texts) == 1
    assert "/start <код>" in texts[0]


def test_poll_once_survives_a_failed_step_and_keeps_going() -> None:
    calls = {"count": 0}

    def bot_handler(request: httpx.Request) -> httpx.Response:
        calls["count"] += 1
        if calls["count"] == 1:
            raise httpx.ConnectError("connection refused", request=request)
        return httpx.Response(200, json={"ok": True, "result": []})

    with (
        client_with(lambda request: httpx.Response(200, json={})) as crm_client,
        client_with(bot_handler) as bot_client,
    ):
        # Первый шаг падает на связи — наружу это не выходит.
        assert (
            bot.poll_once(
                offset=None,
                bot_client=bot_client,
                crm_client=crm_client,
                settings=make_settings(),
            )
            is None
        )
        # Следующий шаг работает: цикл не сломался.
        assert (
            bot.poll_once(
                offset=None,
                bot_client=bot_client,
                crm_client=crm_client,
                settings=make_settings(),
            )
            is None
        )

    assert calls["count"] == 2


def test_main_without_tokens_logs_and_exits_before_the_network(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    monkeypatch.setenv("TELEGRAM_BOT_TOKEN", "")
    monkeypatch.setenv("TELEGRAM_SERVICE_TOKEN", "")
    get_settings.cache_clear()
    started: list[dict[str, object]] = []
    monkeypatch.setattr(bot, "run_forever", lambda **kwargs: started.append(kwargs))

    try:
        with caplog.at_level(logging.ERROR, logger="app.bot"):
            bot.main()
    finally:
        get_settings.cache_clear()

    assert started == []
    logged = "\n".join(record.getMessage() for record in caplog.records)
    assert "TELEGRAM_BOT_TOKEN" in logged
    assert "TELEGRAM_SERVICE_TOKEN" in logged

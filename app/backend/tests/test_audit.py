"""Журнал действий: перехват write-запросов, очистка тела и маскирование ПДн.

Юнит-тесты идут на SQLite: там `audit_events` — обычная таблица без партиций
(партиционирование проверяется на настоящей PostgreSQL в
`tests/test_audit_partitions.py`).

Строку журнала кладёт в тот же коммит, что и действие, слушатель `before_commit`
(`app.audit.add_atomic_row`), поэтому в тесте она видна прямо в сессии теста: это
та же сессия, что у переопределённого `get_db`. У входа, выхода и отказов коммита
нет — их строку пишет middleware своей сессией, и для неё фабрика подменяется на
базу теста (`app.db.SessionLocal`).

Проверяется здесь ровно то, что обещает постановка: что записывается, чего в
записи быть не должно и что сбой журнала отменяет само действие.
"""

import logging
from datetime import UTC, datetime
from typing import Any

import pytest
from fastapi import Request
from fastapi.testclient import TestClient
from sqlalchemy import func, select, text
from sqlalchemy.orm import Session

from app import audit
from app import db as db_module
from app.config import get_settings
from app.main import IP_LIMIT, client_ip
from app.models.audit import AuditEvent
from app.models.dormitory import Dormitory
from tests.conftest import TEST_PASSWORD, create_user, sign_in

PAYLOAD = {"name": "Северное", "client_name": "Стройкомплект"}

# Тело `multipart/form-data`: так уходит импорт «Мест» (файл .xlsx).
XLSX_MEDIA_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"

RESIDENT_FULL_NAME = "Иванов Иван Иванович"
RESIDENT_PHONE = "+79990001122"
RESIDENT_NOTES = "Просил не ставить в ночные смены"

# Правка проживающего требует месяц отчёта: он приходит параметром запроса.
CURRENT_MONTH = "2026-10-01"


def events(db_session: Session) -> list[AuditEvent]:
    """Строки журнала в порядке появления."""
    db_session.expire_all()
    return list(db_session.scalars(select(AuditEvent).order_by(AuditEvent.id)))


def last_event(db_session: Session) -> AuditEvent:
    """Последняя строка журнала."""
    return events(db_session)[-1]


def create_resident(client: TestClient, dormitory_id: int) -> int:
    """Завести проживающего в общежитии и вернуть его id."""
    created = client.post(f"/api/dormitories/{dormitory_id}/residents")
    assert created.status_code == 201, created.text
    return int(created.json()["id"])


def test_committed_action_leaves_the_row_in_the_same_commit(
    client: TestClient, db_session: Session
) -> None:
    """`PATCH` общежития — строка журнала в том же коммите, что и действие."""
    user = sign_in(client, db_session)
    created = client.post("/api/dormitories", json=PAYLOAD)
    assert created.status_code == 201, created.text
    dormitory_id = created.json()["id"]

    updated = client.patch(f"/api/dormitories/{dormitory_id}", json={"is_archived": True})
    assert updated.status_code == 200, updated.text

    rows = events(db_session)
    # Вход — строка best-effort, дальше по строке на каждый коммит действия.
    assert len(rows) == 3
    assert [row.method for row in rows] == ["POST", "POST", "PATCH"]

    row = rows[-1]
    assert row.actor_id == user.id
    # Журнал пишет организацию актора: у вошедшего пользователя она есть.
    assert row.organization_id == user.active_organization_id
    # Идентификатор не подставлен в путь: журнал группируется по шаблону.
    assert row.path == "/api/dormitories/{dormitory_id}"
    # Значения пути — те, что подставил маршрутизатор.
    assert row.path_params == {"dormitory_id": str(dormitory_id)}
    assert row.action == "patch_dormitories"
    assert audit.action_title(row.action) == "Изменить названия или статус архива общежития"
    assert row.kind == audit.KIND_DATA
    assert row.request_body == {"is_archived": True}
    assert row.request_id is not None and len(row.request_id) == 36
    assert row.created_at is not None
    # У атомарной строки код ответа и длительность ещё неизвестны: их знает
    # только строка, записанная после ответа.
    assert row.status is None
    assert row.duration_ms is None


def test_login_and_logout_leave_rows_with_the_real_status(
    client: TestClient, db_session: Session
) -> None:
    """Вход и выход не коммитят — их строки пишет middleware после ответа."""
    create_user(db_session)
    login = client.post(
        "/api/auth/login",
        json={"email": "worker@example.com", "password": TEST_PASSWORD},
    )
    assert login.status_code == 200, login.text
    logout = client.post("/api/auth/logout")
    assert logout.status_code == 204

    rows = events(db_session)
    assert len(rows) == 2

    sign_in_row, sign_out_row = rows
    assert sign_in_row.action == "post_auth_login"
    assert sign_in_row.kind == audit.KIND_SECURITY
    # Вход идёт до появления сессии: актора ещё нет, и это не ошибка.
    assert sign_in_row.actor_id is None
    assert sign_in_row.status == 200
    assert sign_in_row.duration_ms is not None and sign_in_row.duration_ms >= 0
    # Почта — персональные данные, поэтому и в теле входа она под маской.
    body = sign_in_row.request_body
    assert isinstance(body, dict)
    assert body["password"] == "***"
    assert body["email"]["_masked"] == "w***@example.com"
    assert len(body["email"]["fp"]) == audit.FINGERPRINT_LENGTH
    assert "worker@example.com" not in str(body)

    assert sign_out_row.action == "post_auth_logout"
    assert sign_out_row.kind == audit.KIND_SECURITY
    assert sign_out_row.status == 204


def test_refused_request_leaves_the_real_status(client: TestClient, db_session: Session) -> None:
    """Отказ 422 не коммитит, но строку с настоящим кодом оставляет."""
    response = client.post("/api/auth/register", json={"email": "не-почта", "full_name": "И"})
    assert response.status_code == 422

    row = last_event(db_session)
    assert row.path == "/api/auth/register"
    assert row.status == 422
    assert row.actor_id is None


def test_read_request_leaves_nothing(client: TestClient, db_session: Session) -> None:
    """Чтения в журнал не попадают."""
    sign_in(client, db_session)
    assert client.get("/api/me").status_code == 200
    assert client.get("/api/dormitories").status_code == 200

    assert len(events(db_session)) == 1


def test_failed_journal_write_rolls_back_the_action(
    client: TestClient, db_session: Session
) -> None:
    """Fail-closed: без строки журнала действие не выполняется, клиент видит 503."""
    sign_in(client, db_session)
    # Сбой записи журнала: таблицы нет.
    db_session.execute(text("DROP TABLE audit_events"))
    db_session.commit()

    response = client.post("/api/dormitories", json=PAYLOAD)
    # Сессия осталась с отменённой транзакцией — как её и оставил сервер.
    db_session.rollback()

    assert response.status_code == 503
    assert "журнал" in response.json()["detail"].lower()
    # Действие не сохранилось: в базе нет ни данных, ни строки журнала.
    assert db_session.scalar(select(func.count()).select_from(Dormitory)) == 0


def test_unknown_route_is_logged(client: TestClient, db_session: Session) -> None:
    """Запрос по несуществующему адресу тоже остаётся в журнале."""
    response = client.post("/api/no-such-route", json={"a": 1})
    assert response.status_code == 404

    row = last_event(db_session)
    assert row.method == "POST"
    assert row.path == "/api/no-such-route"
    assert row.action == "post_no_such_route"
    assert row.kind == audit.KIND_DATA
    assert row.status == 404
    assert row.actor_id is None


def test_personal_data_is_masked_in_the_journal(client: TestClient, db_session: Session) -> None:
    """ФИО, телефон и свободный текст лежат в журнале маской и отпечатком."""
    sign_in(client, db_session)
    dormitory_id = int(client.post("/api/dormitories", json=PAYLOAD).json()["id"])
    resident_id = create_resident(client, dormitory_id)

    updated = client.patch(
        f"/api/dormitories/{dormitory_id}/residents/{resident_id}?month={CURRENT_MONTH}",
        json={
            "full_name": RESIDENT_FULL_NAME,
            "phone": RESIDENT_PHONE,
            "notes": RESIDENT_NOTES,
            "personnel_number": "Т-42",
            "medical_book": "Есть",
        },
    )
    assert updated.status_code == 200, updated.text

    row = last_event(db_session)
    assert row.action == "patch_dormitories_residents"
    body = row.request_body
    assert body is not None
    assert body["full_name"]["_masked"] == "И*** И*** И***"
    assert body["phone"]["_masked"] == "+7***22"
    assert body["notes"]["_masked"] == "free_text"
    assert body["notes"]["length"] == len(RESIDENT_NOTES)
    assert len(body["notes"]["fp"]) == audit.FINGERPRINT_LENGTH
    # Поля, которые маскировать не нужно, видны целиком: по ним и ищут в журнале.
    assert body["personnel_number"] == "Т-42"
    assert body["medical_book"] == "Есть"

    stored = str(body)
    assert RESIDENT_FULL_NAME.split()[0] not in stored
    assert RESIDENT_PHONE not in stored
    assert RESIDENT_NOTES not in stored


def test_equal_values_get_equal_fingerprints(client: TestClient, db_session: Session) -> None:
    """Отпечаток одинаковых значений совпадает, разных — различается."""
    sign_in(client, db_session)
    dormitory_id = int(client.post("/api/dormitories", json=PAYLOAD).json()["id"])
    first = create_resident(client, dormitory_id)
    second = create_resident(client, dormitory_id)

    url = f"/api/dormitories/{dormitory_id}/residents"
    month = f"?month={CURRENT_MONTH}"
    assert client.patch(f"{url}/{first}{month}", json={"phone": RESIDENT_PHONE}).status_code == 200
    assert client.patch(f"{url}/{second}{month}", json={"phone": RESIDENT_PHONE}).status_code == 200
    assert client.patch(f"{url}/{second}{month}", json={"phone": "+79990009999"}).status_code == 200

    same_first, same_second, other = (row.request_body for row in events(db_session)[-3:])
    assert same_first is not None and same_second is not None and other is not None
    assert same_first["phone"]["fp"] == same_second["phone"]["fp"]
    assert other["phone"]["fp"] != same_first["phone"]["fp"]


def test_body_over_the_journal_limit_is_stored_as_a_stub(
    client: TestClient, db_session: Session
) -> None:
    """Тело, не влезающее в лимит, остаётся в журнале только фактом и размером."""
    blob = "я" * 500
    response = client.post("/api/no-such-route", json={"a": blob, "b": blob, "c": blob})
    assert response.status_code == 404

    row = last_event(db_session)
    assert row.request_body == {
        "_truncated": True,
        "_bytes": audit._payload_size({"a": blob, "b": blob, "c": blob}),
    }
    assert row.request_body["_bytes"] > get_settings().audit_body_limit_bytes
    assert blob not in str(row.request_body)


def test_body_over_the_read_limit_is_not_read_at_all(
    client: TestClient, db_session: Session
) -> None:
    """Тело длиннее лимита чтения не читается: иначе импорт на 20 МБ в памяти."""
    response = client.post("/api/no-such-route", json={"blob": "я" * 40000})
    assert response.status_code == 404

    row = last_event(db_session)
    assert row.request_body is None
    assert row.status == 404


def test_multipart_body_is_not_stored(client: TestClient, db_session: Session) -> None:
    """Импорт файла — `multipart/form-data`: тело не сохраняется вовсе."""
    sign_in(client, db_session)
    response = client.post(
        "/api/dormitories/1/hostels/import",
        files={"file": ("places.xlsx", b"not-a-real-xlsx", XLSX_MEDIA_TYPE)},
        data={"month": "2026-10-01"},
    )

    row = last_event(db_session)
    assert row.method == "POST"
    assert row.path == "/api/dormitories/{dormitory_id}/hostels/import"
    assert row.status == response.status_code
    assert row.request_body is None


def test_broken_journal_storage_keeps_the_response_of_the_handle(
    client: TestClient, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    """Сбой best-effort записи — WARNING в логе, а не ошибка клиенту."""

    def broken_factory() -> Any:
        raise RuntimeError("база журнала недоступна")

    monkeypatch.setattr(db_module, "SessionLocal", broken_factory)

    with caplog.at_level(logging.WARNING, logger="app.audit"):
        response = client.post("/api/auth/login", json={"email": "a@example.com", "password": "x"})

    # Ответ ручки не изменился: неудачная запись журнала его не трогает.
    assert response.status_code == 401
    assert any(
        record.levelno == logging.WARNING and record.name == "app.audit"
        for record in caplog.records
    ), caplog.text


def test_disabled_journal_writes_nothing(
    client: TestClient,
    db_session: Session,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Выключенный журнал не пишет ничего, а ручки работают как раньше."""
    sign_in(client, db_session)
    monkeypatch.setattr(get_settings(), "audit_enabled", False)

    created = client.post("/api/dormitories", json=PAYLOAD)
    assert created.status_code == 201, created.text
    assert len(events(db_session)) == 1


def test_ip_and_user_agent_are_taken_from_proxy_headers(
    client: TestClient, db_session: Session
) -> None:
    """Длинный `User-Agent` режется, а подделанные клиентом заголовки IP не проходят.

    `TestClient` приходит с соседом `testclient`, а это не доверенный прокси
    (сети прокси — `TRUSTED_PROXY_NETWORKS`), поэтому заголовки не читаются вовсе:
    адрес берётся из соединения. Иначе любой клиент подменил бы себе адрес в
    журнале строкой `X-Real-IP`/`X-Forwarded-For` (#105).
    """
    create_user(db_session)
    long_agent = "A" * 400
    response = client.post(
        "/api/auth/login",
        json={"email": "worker@example.com", "password": TEST_PASSWORD},
        headers={"X-Forwarded-For": "198.51.100.5, 10.0.0.1", "User-Agent": long_agent},
    )
    assert response.status_code == 200, response.text
    with_real_ip = client.post(
        "/api/auth/logout",
        headers={"X-Real-IP": "203.0.113.7", "X-Forwarded-For": "198.51.100.5"},
    )
    assert with_real_ip.status_code == 204

    forwarded, real = events(db_session)
    assert forwarded.ip == "testclient"
    assert forwarded.user_agent == long_agent[: get_settings().audit_user_agent_limit]
    assert real.ip == "testclient"


def make_request(
    headers: dict[str, str] | None = None,
    client: tuple[str, int] | None = ("172.18.0.5", 50000),
) -> Request:
    """Запрос с заданным соседом и заголовками: `client_ip` проверяется без сети."""
    scope = {
        "type": "http",
        "method": "GET",
        "path": "/api/health",
        "headers": [
            (name.lower().encode("latin-1"), value.encode("latin-1"))
            for name, value in (headers or {}).items()
        ],
        "client": client,
    }
    return Request(scope)


@pytest.fixture
def trusted_proxies(monkeypatch: pytest.MonkeyPatch) -> None:
    """Доверенный прокси — сеть compose: у `make_request` сосед `172.18.0.5`."""
    monkeypatch.setattr(get_settings(), "trusted_proxy_networks", "172.16.0.0/12")


def test_client_ip_behind_trusted_proxies_is_the_nearest_untrusted_hop(
    trusted_proxies: None,
) -> None:
    """Цепочка читается с конца: caddy дописал клиента, nginx — caddy."""
    caddy_to_nginx = "203.0.113.7, 172.18.0.5"
    assert client_ip(make_request({"X-Forwarded-For": caddy_to_nginx})) == "203.0.113.7"
    # Клиент в локальной сети — тоже настоящий адрес, он просто доверенным не стал.
    chain = "192.168.1.20, 172.18.0.5"
    assert client_ip(make_request({"X-Forwarded-For": chain})) == "192.168.1.20"


def test_client_ip_ignores_x_real_ip_from_any_hops(trusted_proxies: None) -> None:
    """`X-Real-IP` не читается: после TLS-слоя его автором остаётся сам запрос."""
    request = make_request({"X-Real-IP": "8.8.8.8", "X-Forwarded-For": "203.0.113.7, 172.18.0.5"})
    assert client_ip(request) == "203.0.113.7"
    # Только `X-Real-IP` без цепочки — сосед доверенный, прокси адреса не прислал.
    only_real_ip = make_request({"X-Real-IP": "8.8.8.8"})
    assert client_ip(only_real_ip) == "172.18.0.5"


def test_client_ip_ignores_the_chain_the_client_wrote_itself(trusted_proxies: None) -> None:
    """Левые элементы цепочки дописывает клиент: доверия им нет."""
    spoofed = "8.8.8.8, 198.51.100.5, 203.0.113.7, 172.18.0.5"
    assert client_ip(make_request({"X-Forwarded-For": spoofed})) == "203.0.113.7"
    # Неразбираемое значение в цепочке — не адрес: оно пропускается.
    garbage = "not-an-ip, 203.0.113.7, 172.18.0.5"
    assert client_ip(make_request({"X-Forwarded-For": garbage})) == "203.0.113.7"


def test_client_ip_from_untrusted_peer_comes_from_the_socket(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Прямое подключение мимо прокси: заголовки игнорируются целиком."""
    monkeypatch.setattr(get_settings(), "trusted_proxy_networks", "172.16.0.0/12")
    request = make_request(
        {"X-Real-IP": "8.8.8.8", "X-Forwarded-For": "198.51.100.5"},
        client=("203.0.113.7", 50000),
    )
    assert client_ip(request) == "203.0.113.7"


def test_client_ip_keeps_only_trusted_addresses_and_clips_the_column(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Вся цепочка из прокси — остаётся самый дальний; длинное значение режется."""
    monkeypatch.setattr(get_settings(), "trusted_proxy_networks", "172.16.0.0/12")
    both_proxies = make_request({"X-Forwarded-For": "172.18.0.2, 172.18.0.5"})
    assert client_ip(both_proxies) == "172.18.0.2"
    # Сеть не разбирается — она не считается доверенной, и ошибки в настройке нет.
    monkeypatch.setattr(get_settings(), "trusted_proxy_networks", "bogus,172.16.0.0/12")
    assert client_ip(both_proxies) == "172.18.0.2"
    long_peer = make_request(client=("A" * 400, 50000))
    assert client_ip(long_peer) == "A" * IP_LIMIT
    assert client_ip(make_request(client=None, headers={"X-Forwarded-For": "172.18.0.2"})) == (
        "172.18.0.2"
    )


def test_direct_connection_without_proxy_keeps_the_socket_address(
    client: TestClient, db_session: Session
) -> None:
    """Без прокси IP берётся из соединения: TestClient приходит с `testclient`."""
    client.post("/api/no-such-route", json={})

    assert last_event(db_session).ip == "testclient"


def test_kind_and_action_are_derived_from_the_route() -> None:
    """Правила вида и кода действия — на всех случаях из задачи."""
    assert audit.audit_kind("POST", "/api/auth/login") == audit.KIND_SECURITY
    assert audit.audit_kind("PATCH", "/api/organization") == audit.KIND_SECURITY
    assert audit.audit_kind("POST", "/api/billing/invoices") == audit.KIND_SECURITY
    assert (
        audit.audit_kind("PUT", "/api/dormitories/{dormitory_id}/settings") == audit.KIND_SECURITY
    )
    assert (
        audit.audit_kind("PUT", "/api/dormitories/{dormitory_id}/tables/{table_key}/rows/1/cells/2")
        == audit.KIND_NOISE
    )
    assert (
        audit.audit_kind("PUT", "/api/dormitories/{dormitory_id}/hostels/{hostel_id}/cells/1/2")
        == audit.KIND_NOISE
    )
    assert audit.audit_kind("POST", "/api/dormitories") == audit.KIND_DATA
    assert audit.audit_kind("POST", "/api/no-such-route") == audit.KIND_DATA

    assert audit.action_code("POST", "/api/auth/login") == "post_auth_login"
    assert audit.action_code("POST", "/api/auth/password-recovery") == "post_auth_password_recovery"
    assert audit.action_code("PATCH", "/api/dormitories/{dormitory_id}") == "patch_dormitories"
    assert audit.action_code("POST", "/api/dormitory-templates") == "post_dormitory_templates"
    # Действие без читаемого названия отдаётся кодом: название не выдумывается.
    assert audit.action_title("post_dormitory_templates") == "post_dormitory_templates"


def test_redact_mask_and_truncate_run_in_that_order() -> None:
    """Порядок очистки тела: секреты → персональные данные → обрезка.

    Порядок виден по следам каждого шага: у секрета нет отпечатка (значит,
    `redact` шёл до `mask`), длина свободного текста исходная (значит, `mask` шёл
    до `truncate`), а длинная строка обрезана до 500 символов (значит, `truncate`
    был последним).
    """
    notes = "т" * 3000
    long_value = "я" * 3000
    body: dict[str, Any] = {"token": "секрет", "notes": notes, "other": long_value}

    cleaned = audit.truncate(audit.mask(audit.redact(body)), get_settings().audit_body_limit_bytes)

    assert cleaned["token"] == audit.SECRET_MASK
    assert cleaned["notes"]["_masked"] == "free_text"
    assert cleaned["notes"]["length"] == len(notes)
    assert cleaned["other"] == long_value[: audit.STRING_LIMIT]


def test_masking_rules() -> None:
    """Маска ПДн: ФИО, телефон, email и свободный текст; остальное не трогается."""
    masked = audit.mask(
        {
            "full_name": "Иванов Иван Иванович",
            "phone": "+79990001122",
            "email": "ivan@example.com",
            "notes": "свободный текст",
            "nested": [{"comment": "внутри"}],
            "inn": "770123456789",
            "name": "Северное",
            "personnel_number": "Т-42",
            "medical_book": "Есть",
            "citizenship": "Россия",
            "empty": "",
        }
    )

    assert masked["full_name"]["_masked"] == "И*** И*** И***"
    assert masked["phone"]["_masked"] == "+7***22"
    # Короткий номер маскируется целиком: по краям он выдал бы все цифры.
    assert audit.mask({"phone": "+7999"})["phone"]["_masked"] == audit.SECRET_MASK
    assert masked["email"]["_masked"] == "i***@example.com"
    # Почта без домена: остаётся только первая буква локальной части.
    assert audit.mask({"email": "ivan"})["email"]["_masked"] == "i***"
    assert masked["notes"]["_masked"] == "free_text"
    assert masked["nested"][0]["comment"]["_masked"] == "free_text"
    # Реквизиты, названия объектов и служебные поля остаются целиком: по ним и
    # ищут в журнале.
    assert masked["inn"] == "770123456789"
    assert masked["name"] == "Северное"
    assert masked["personnel_number"] == "Т-42"
    assert masked["medical_book"] == "Есть"
    assert masked["citizenship"] == "Россия"
    assert masked["empty"] == ""

    # Отпечаток есть у персональных данных и нет у секретов.
    assert len(masked["full_name"]["fp"]) == audit.FINGERPRINT_LENGTH
    assert len(masked["notes"]["fp"]) == audit.FINGERPRINT_LENGTH
    assert audit.redact({"password": "секрет"})["password"] == audit.SECRET_MASK


def test_month_guard_fires_once_a_month(monkeypatch: pytest.MonkeyPatch) -> None:
    """Смена месяца замечена один раз: планировщика в задаче нет.

    Сам `month_guard` ничего не меняет — месяц отмечает `refresh_audit_storage`,
    когда работа действительно сделана. Иначе упавшая подготовка запомнилась бы
    как успешная и повторить её было бы некому.
    """
    monkeypatch.setattr(audit, "_ensured_month", None)
    assert audit.month_guard(datetime(2026, 10, 14, tzinfo=UTC)) is True

    # На SQLite работы нет (партиций там не бывает), но месяц считается готовым.
    audit.refresh_audit_storage(datetime(2026, 10, 14, tzinfo=UTC))

    assert audit.month_guard(datetime(2026, 10, 31, 23, 59, tzinfo=UTC)) is False
    assert audit.month_guard(datetime(2026, 11, 1, 0, 1, tzinfo=UTC)) is True


def test_partition_helpers_count_months_without_overflow() -> None:
    """Границы и имена месяцев считаются через границу года."""
    assert (
        audit.month_start(datetime(2026, 10, 14, 23, 30, tzinfo=UTC))
        == datetime(2026, 10, 1).date()
    )
    assert audit.shift_month(datetime(2026, 10, 1).date(), 3) == datetime(2027, 1, 1).date()
    assert audit.next_month(datetime(2026, 12, 1).date()) == datetime(2027, 1, 1).date()
    assert audit.month_partition(datetime(2026, 1, 1).date()) == "audit_events_2026_01"
    assert audit.partition_month("audit_events_2027_12") == datetime(2027, 12, 1).date()
    # DEFAULT-партиция — не месячная: её нельзя ни отбросить, ни спутать с месяцем.
    assert audit.partition_month(audit.DEFAULT_PARTITION) is None
    assert audit.partition_month("audit_events_other") is None
    assert audit.partition_month("audit_events_2027_13") is None


def test_retention_is_two_years_for_security_and_a_quarter_for_the_rest() -> None:
    """Сроки хранения: безопасность — два года, шум и данные — квартал."""
    assert audit.retention_days(audit.KIND_SECURITY) == 730
    assert audit.retention_days(audit.KIND_DATA) == 90
    assert audit.retention_days(audit.KIND_NOISE) == 90

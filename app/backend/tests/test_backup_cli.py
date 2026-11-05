"""CLI резервных копий: ротация дампов в S3 и отказы на опасных аргументах.

Проверяется на `LocalStorage(tmp_path)`: правила отбора — про имена ключей, а не
про S3, поэтому сети и настроек приложения здесь не нужно. Хранилище приходит в
функции аргументом (`upload`, `rotate`, `check`), а `run` возвращает код выхода,
который и проверяется: workflow полагается ровно на него.

Что охраняют эти тесты: под префиксом среды лежат не только дампы, но и файлы
пользователей (`<ГГГГ-ММ-ДД>/<uuid>.xlsx`). Ротация, которая возьмёт «все
объекты папки» или «всё, что вернул `list_folder("")`», — это тихая потеря
документов арендатора, а не «лишний дамп».

Префикс боевой среды — настройка (`S3_PREFIX_PROD`), поэтому `check` получает
не константу, а набор настроек боевого прогона (`PROD`): сравнение с литералом
отказывало бы на правильно переопределённом префиксе.
"""

from pathlib import Path
from typing import TypedDict

import pytest

from app.backup_cli import BackupError, check_backup_storage, rotate, run, upload
from app.storage import LocalStorage, S3Storage, StorageError

PAYLOAD = b"PGDMP not really a dump"
FIRST = "crm_20261101_030000.dump"
SECOND = "crm_20261102_030000.dump"
THIRD = "crm_20261103_030000.dump"


class BackupSettings(TypedDict):
    """Настройки, по которым `check` решает, годится ли бэкап."""

    env: str
    prefix: str
    test_prefix: str


# Боевой прогон: `S3_ENV=prod`, боевой префикс проекта и тестовый префикс.
PROD: BackupSettings = {
    "env": "prod",
    "prefix": "crmdormitory-prod",
    "test_prefix": "crm-agent-test",
}

# Тестовый прогон стенда: боевой бэкап от него отличается — это и есть отказ.
TEST: BackupSettings = {
    "env": "test",
    "prefix": "crm-agent-test",
    "test_prefix": "crm-agent-test",
}


def local_storage(tmp_path: Path) -> LocalStorage:
    return LocalStorage(tmp_path / "storage")


def s3_storage(prefix: str) -> S3Storage:
    """S3-хранилище с фиктивными ключами: клиент создаётся без обращения к сети."""
    return S3Storage(
        endpoint="https://s3.example.test",
        access_key="key",
        secret_key="secret",
        bucket="bucket",
        prefix=prefix,
    )


def put_dump(storage: LocalStorage, name: str, folder: str = "backup/db") -> str:
    """Кладёт дамп прямо во хранилище — так его увидит ротация."""
    return storage.put_raw(PAYLOAD, f"{folder}/{name}")


def test_rotate_keeps_the_newest_dumps_and_deletes_the_older(tmp_path: Path) -> None:
    """Остаются `keep` самых новых по имени: шаблон сортируется как время."""
    storage = local_storage(tmp_path)
    for day in range(1, 13):
        put_dump(storage, f"crm_202611{day:02d}_030000.dump")

    removed = rotate(storage, "backup/db", 10)

    assert removed == [
        "backup/db/crm_20261101_030000.dump",
        "backup/db/crm_20261102_030000.dump",
    ]
    left = storage.list_folder("backup/db")
    assert len(left) == 10
    assert "backup/db/crm_20261101_030000.dump" not in left
    assert "backup/db/crm_20261112_030000.dump" in left


def test_rotate_with_fewer_dumps_than_keep_deletes_nothing(tmp_path: Path) -> None:
    storage = local_storage(tmp_path)
    for name in (FIRST, SECOND, THIRD):
        put_dump(storage, name)

    assert rotate(storage, "backup/db", 10) == []
    assert len(storage.list_folder("backup/db")) == 3


def test_rotate_leaves_foreign_names_and_folders_alone(tmp_path: Path) -> None:
    """Чужое имя и чужая папка не удаляются никогда, даже при keep=1.

    Под префиксом среды кроме дампов живут файлы пользователей и служебные
    объекты; ротация обязана отбирать только `crm_ГГГГММДД_ЧЧММСС.dump` прямо
    в своей папке.
    """
    storage = local_storage(tmp_path)
    for name in (FIRST, SECOND, THIRD):
        put_dump(storage, name)
    user_file = storage.put_raw(PAYLOAD, "backup/db/2026-11-01/user.xlsx")
    note = storage.put_raw(PAYLOAD, "backup/db/notes.txt")
    nested = storage.put_raw(PAYLOAD, "backup/db/old/crm_20261001_030000.dump")
    upload_key = storage.put_raw(PAYLOAD, "uploads/2026-11-01/crm_20261001_030000.dump")

    removed = rotate(storage, "backup/db", 1)

    assert removed == ["backup/db/crm_20261101_030000.dump", "backup/db/crm_20261102_030000.dump"]
    assert storage.exists(f"backup/db/{THIRD}")
    assert storage.exists(user_file)
    assert storage.exists(note)
    assert storage.exists(nested)
    assert storage.exists(upload_key)


@pytest.mark.parametrize("folder", ["uploads", "", "backup", "2026-11-01", "/"])
def test_rotate_refuses_a_folder_outside_backup(tmp_path: Path, folder: str) -> None:
    """Папка обязана начинаться с `backup/`: иначе ротация ушла бы в файлы людей."""
    storage = local_storage(tmp_path)
    put_dump(storage, FIRST)

    with pytest.raises(BackupError):
        rotate(storage, folder, 1)
    assert storage.exists(f"backup/db/{FIRST}")


@pytest.mark.parametrize("keep", [0, -1])
def test_rotate_refuses_to_keep_less_than_one_dump(tmp_path: Path, keep: int) -> None:
    """`keep < 1` — это «удалить все копии», а не «не хранить»."""
    storage = local_storage(tmp_path)
    put_dump(storage, FIRST)

    with pytest.raises(BackupError):
        rotate(storage, "backup/db", keep)
    assert storage.exists(f"backup/db/{FIRST}")


def test_upload_returns_the_key_backup_db_name(tmp_path: Path) -> None:
    storage = local_storage(tmp_path)
    file = tmp_path / THIRD
    file.write_bytes(PAYLOAD)

    key = upload(storage, file, THIRD)

    assert key == f"backup/db/{THIRD}"
    assert storage.read_bytes(key) == PAYLOAD


@pytest.mark.parametrize(
    "name",
    [
        "2026-11-01/user.xlsx",
        "crm_2026110_030000.dump",
        "crm_20261103_030000.dump.bak",
        "dump.dump",
        "../crm_20261103_030000.dump",
    ],
)
def test_upload_refuses_a_name_outside_the_dump_pattern(tmp_path: Path, name: str) -> None:
    storage = local_storage(tmp_path)
    file = tmp_path / "dump.bin"
    file.write_bytes(PAYLOAD)

    with pytest.raises(BackupError):
        upload(storage, file, name)
    assert storage.list_folder("") == []


def test_upload_of_a_missing_file_exits_with_code_one(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    """Пропавший файл — код 1 и одна строка `ОШИБКА: …` без traceback."""
    storage = local_storage(tmp_path)

    code = run(["upload", str(tmp_path / "nope.dump"), THIRD], storage, **PROD)

    assert code == 1
    err = capsys.readouterr().err
    assert err.startswith("ОШИБКА:")
    assert "Traceback" not in err


def test_rotate_prints_every_removed_key(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    storage = local_storage(tmp_path)
    for name in (FIRST, SECOND):
        put_dump(storage, name)

    code = run(["rotate", "backup/db", "1"], storage, **PROD)

    assert code == 0
    out = capsys.readouterr().out
    assert f"удалён backup/db/{FIRST}" in out
    assert "Ротация" in out
    # Оставленный дамп в выводе не значится: печатается только удалённое.
    assert SECOND not in out
    assert storage.exists(f"backup/db/{SECOND}")


def test_check_refuses_the_local_storage(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    """S3 выключен — job обязан упасть с текстом, называющим хранилище."""
    storage = local_storage(tmp_path)

    code = run(["check"], storage, **PROD)

    assert code == 1
    assert "S3Storage" in capsys.readouterr().err


def test_check_accepts_the_production_prefix() -> None:
    """Боевой прогон на префиксе проекта — успех и префикс в выводе."""
    storage = s3_storage(prefix=PROD["prefix"])

    line = check_backup_storage(storage, **PROD)

    assert line == "Хранилище: S3Storage, S3_ENV=prod, префикс: crmdormitory-prod"


def test_check_refuses_when_the_environment_is_not_prod() -> None:
    """`S3_ENV=test` — дамп уедет в тестовый префикс, это отказ."""
    storage = s3_storage(prefix=PROD["test_prefix"])

    with pytest.raises(BackupError) as err:
        check_backup_storage(storage, **TEST)

    message = str(err.value)
    assert message.startswith("S3_ENV='test'")
    assert "crm-agent-test" in message


def test_check_refuses_an_empty_production_prefix() -> None:
    """Пустой `S3_PREFIX_PROD` — дамп лёг бы в корень бакета."""
    storage = s3_storage(prefix="")
    settings: BackupSettings = {"env": "prod", "prefix": "  ", "test_prefix": "crm-agent-test"}

    with pytest.raises(BackupError) as err:
        check_backup_storage(storage, **settings)

    assert "S3_PREFIX_PROD" in str(err.value)


def test_check_refuses_the_test_prefix_as_the_production_one() -> None:
    """Боевой префикс, совпавший с тестовым, — тоже отказ."""
    storage = s3_storage(prefix=TEST["prefix"])
    settings: BackupSettings = {**TEST, "env": "prod"}

    with pytest.raises(BackupError) as err:
        check_backup_storage(storage, **settings)

    assert "совпадает с тестовым" in str(err.value)


def test_check_puts_the_empty_prefix_before_the_coincidence() -> None:
    """Пустой префикс отказывает раньше сравнения: порядок отказов из промта."""
    storage = s3_storage(prefix="")
    settings: BackupSettings = {"env": "prod", "prefix": "", "test_prefix": ""}

    with pytest.raises(BackupError) as err:
        check_backup_storage(storage, **settings)

    assert "задайте S3_PREFIX_PROD" in str(err.value)


def test_check_names_settings_not_the_old_literal_prefix() -> None:
    """Проверка идёт по настройкам: старого литерала префикса в тексте нет."""
    storage = s3_storage(prefix=TEST["prefix"])

    with pytest.raises(BackupError) as err:
        check_backup_storage(storage, **TEST)

    assert "crm-prod" not in str(err.value)


def test_check_follows_a_redefined_production_prefix() -> None:
    """Переопределённый префикс проходит: истина — настройка, а не литерал."""
    storage = s3_storage(prefix="other-prod")
    settings: BackupSettings = {**TEST, "env": "prod", "prefix": "other-prod"}

    line = check_backup_storage(storage, **settings)

    assert "префикс: other-prod" in line


def test_check_run_prints_the_success_line(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    """Код 0 и ровно строка успеха — на неё смотрит лог workflow."""
    storage = s3_storage(prefix=PROD["prefix"])

    assert run(["check"], storage, **PROD) == 0
    out = capsys.readouterr().out
    assert out.strip() == "Хранилище: S3Storage, S3_ENV=prod, префикс: crmdormitory-prod"


def test_run_check_with_a_test_environment_exits_with_code_one(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    """`S3_ENV=test` через `run`: код 1 и одна строка `ОШИБКА: S3_ENV='test' …`."""
    storage = s3_storage(prefix="crm-agent-test")

    code = run(["check"], storage, **TEST)

    assert code == 1
    err = capsys.readouterr().err
    assert err.startswith("ОШИБКА: S3_ENV='test'")
    assert err.strip().count("\n") == 0
    assert "Traceback" not in err


def test_a_storage_error_is_one_line_and_code_one(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    """Ошибка хранилища — тоже `ОШИБКА: …` и код 1: на нём стоит `set -e` сервера."""

    class BrokenStorage(LocalStorage):
        def delete(self, name: str) -> None:
            raise StorageError("S3: AccessDenied")

    storage = BrokenStorage(tmp_path / "storage")
    storage.put_raw(PAYLOAD, f"backup/db/{FIRST}")
    storage.put_raw(PAYLOAD, f"backup/db/{SECOND}")

    assert run(["rotate", "backup/db", "1"], storage, **PROD) == 1
    err = capsys.readouterr().err
    assert err.startswith("ОШИБКА:")
    assert "AccessDenied" in err
    assert "Traceback" not in err


def test_an_unknown_command_is_refused_with_code_one(tmp_path: Path) -> None:
    storage = local_storage(tmp_path)

    assert run(["dump-everything"], storage, **PROD) == 1
    assert run([], storage, **PROD) == 1


def test_rotate_refuses_a_non_numeric_keep(tmp_path: Path) -> None:
    storage = local_storage(tmp_path)
    put_dump(storage, FIRST)

    assert run(["rotate", "backup/db", "ten"], storage, **PROD) == 1
    assert storage.exists(f"backup/db/{FIRST}")

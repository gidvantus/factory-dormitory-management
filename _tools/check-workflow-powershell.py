"""Проверка: тела `run:` в Windows-jobs разбираются PowerShell 5.1.

Зачем. Раннер записывает тело шага во временный `.ps1` и запускает его. Ошибка
разбора — это не падение одной команды, а отказ всего шага до первого оператора.
Так 6 ноября встало обновление стенда: `"...in $dir: alembic..."` — в PowerShell
`$dir:` читается как переменная со scope (как `$env:`), а `dir` драйвом не
является, поэтому файл не парсится целиком. На раннере это видно только после
пуша, в логе шага; в pull request — не видно никак.

Второй, менее очевидный класс — кодировка. Раннер пишет `.ps1` **без BOM**, и
Windows PowerShell 5.1 читает такой файл в системной ANSI-кодировке (на раннере
это cp1251). Кириллица превращается в мусор — сам по себе он безобиден, — но
типографские тире и кавычки дают байты 0x91–0x94, а в cp1251 это ‘ ’ “ ”, и
PowerShell считает их границами строки. 16 ноября так упал стенд: сообщение
`"... (MONITOR_GRAFANA_PORT) — compose ..."` закрыло строку на тире, остаток
прочитался как код, и шаг умер с "Missing closing '}'" ещё до первого оператора.
Поэтому в телах `run:` — только ASCII: русский текст живёт в YAML-комментариях
выше шага, а всё исполняемое пишется по-английски.

Как определяется оболочка. Job, у которого в `runs-on` встречается `Windows`,
исполняет `run:` в Windows PowerShell (в этом репозитории так у `stand.yml`).
Остальные — `ubuntu-latest` и bash, их этот скрипт не трогает.
Явный `shell: pwsh` / `shell: powershell` в шаге тоже считается PowerShell.

Разбор делает настоящий PowerShell: `[System.Management.Automation.Language.Parser]`
из `pwsh` (на ubuntu-раннере GitHub он есть). Ошибки `$dir:`-класса в 7 и 5.1
одинаковые, поэтому проверка на `pwsh` переносится на 5.1. Правило про ASCII
статическое и от оболочки не зависит.

Запуск:
    python _tools/check-workflow-powershell.py            # весь .github/workflows
    python _tools/check-workflow-powershell.py --shell powershell   # локально на Windows

Код возврата: 0 — все блоки разбираются и в них только ASCII, 1 — есть ошибки.
"""

from __future__ import annotations

import argparse
import pathlib
import shutil
import subprocess
import sys

import yaml

PARSER_SCRIPT = (
    "$stdin = New-Object System.IO.StreamReader([Console]::OpenStandardInput(), [Text.Encoding]::UTF8)\n"
    "$src = $stdin.ReadToEnd()\n"
    "$errs = $null\n"
    "[void][System.Management.Automation.Language.Parser]::ParseInput($src, [ref]$null, [ref]$errs)\n"
    "if ($errs) { $errs | ForEach-Object { $_.Extent.StartLineNumber.ToString() + ': ' + $_.Message }; exit 1 }\n"
    "exit 0\n"
)


def find_shell() -> str:
    for candidate in ("pwsh", "powershell"):
        path = shutil.which(candidate)
        if path:
            return path
    raise SystemExit(
        "не найден ни pwsh, ни powershell: разбор тел run: без PowerShell невозможен"
    )


def job_uses_powershell(job: dict) -> bool:
    runs_on = job.get("runs-on", "")
    values = runs_on if isinstance(runs_on, list) else [runs_on]
    return any("windows" in str(value).lower() for value in values)


def step_shell_is_powershell(step: dict) -> bool | None:
    shell = step.get("shell")
    if shell is None:
        return None
    return str(shell).lower() in {"pwsh", "powershell"}


def parse_errors(shell: str, body: str) -> list[str]:
    # Тело передаётся через stdin, а не файлом: проверка не должна зависеть от
    # прав на временный каталог машины, где её запускают.
    result = subprocess.run(
        [shell, "-NoProfile", "-NonInteractive", "-Command", PARSER_SCRIPT],
        input=body,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    if result.returncode == 0:
        return []
    lines = [line for line in (result.stdout + result.stderr).splitlines() if line.strip()]
    return lines or ["неизвестная ошибка разбора"]


TYPESET_QUOTES = "\u2013\u2014\u2018\u2019\u201c\u201d"


def encoding_errors(body: str, start: int) -> list[str]:
    """Строки тела, на которых раннер споткнётся из-за кодировки.

    Тело шага на раннере — это файл `.ps1` без BOM, который Windows PowerShell
    5.1 читает в системной ANSI-кодировке. Любой не-ASCII-символ превращается в
    мусор, а типографские кавычки и тире — в настоящие кавычки, которые
    закрывают строку. Поэтому в телах `run:` разрешён только ASCII.
    """
    errors: list[str] = []
    for index, line in enumerate(body.splitlines(), 1):
        where = start + index - 1 if start else index
        quotes = [char for char in line if char in TYPESET_QUOTES]
        if quotes:
            errors.append(
                f"{where}: типографский символ {quotes[0]!r} в теле run:: в cp1251 он становится "
                'кавычкой, Windows PowerShell режет на нём строку. Замените на ASCII: "-" для тире, \'"\' или \'"\' для кавычек.'
            )
            continue
        if any(ord(char) > 127 for char in line):
            errors.append(
                f"{where}: не-ASCII в теле run:: раннер пишет .ps1 без BOM, Windows PowerShell 5.1 читает "
                "его в cp1251, и текст превращается в мусор. В run: только ASCII, русский — в YAML-комментарии выше шага."
            )
    return errors


def line_of(text: str, body: str) -> int:
    """Номер строки, где начинается тело шага.

    Простой `text.find(body)` не годится: YAML срезает отступ первой строки
    блока, и в файле она начинается с пробелов. Поэтому сравниваем строки без
    отступов и подтверждаем совпадение по следующим непустым строкам.
    Переводы строк нормализуются: на Windows-чекауте файл с CRLF, тело из YAML — с LF.
    """
    lines = text.replace("\r\n", "\n").split("\n")
    parts = body.splitlines() or [""]
    needle = parts[0].strip()
    rest = [part.strip() for part in parts[1:] if part.strip()]
    for index, line in enumerate(lines):
        if line.strip() != needle:
            continue
        cursor = index + 1
        matched = True
        for expected in rest:
            while cursor < len(lines) and not lines[cursor].strip():
                cursor += 1
            if cursor >= len(lines) or lines[cursor].strip() != expected:
                matched = False
                break
            cursor += 1
        if matched:
            return index + 1
    return 0


def check_file(path: pathlib.Path, shell: str) -> list[str]:
    text = path.read_text(encoding="utf-8")
    data = yaml.safe_load(text) or {}
    problems: list[str] = []
    for job_name, job in (data.get("jobs") or {}).items():
        for step in job.get("steps") or []:
            body = step.get("run")
            if not body:
                continue
            explicit = step_shell_is_powershell(step)
            is_powershell = explicit if explicit is not None else job_uses_powershell(job)
            if not is_powershell:
                continue
            name = step.get("name", "<без имени>")
            start = line_of(text, body)
            errors = encoding_errors(body, start) + parse_errors(shell, body)
            if not errors:
                continue
            problems.append(
                f"{path.as_posix()}:{start}: job '{job_name}', шаг '{name}' — тело run: не переживёт раннер:"
            )
            problems.extend(f"    {error}" for error in errors)
    return problems


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "path",
        nargs="?",
        default=".github/workflows",
        help="каталог с workflow (по умолчанию .github/workflows)",
    )
    parser.add_argument(
        "--shell",
        default=None,
        help="чем разбирать: pwsh или powershell (по умолчанию — что найдётся)",
    )
    args = parser.parse_args()

    shell = args.shell or find_shell()
    root = pathlib.Path(args.path)
    files = sorted(root.glob("*.yml")) + sorted(root.glob("*.yaml"))

    problems: list[str] = []
    checked = 0
    for file in files:
        checked += 1
        problems.extend(check_file(file, shell))

    if problems:
        print("\n".join(problems), file=sys.stderr)
        print(
            f"\nПроверено файлов: {checked}. Две правки, которые ловит эта проверка: "
            'оберните переменную перед двоеточием (${dir} вместо $dir:, и ${var} везде, где дальше идёт ":"); '
            "уберите не-ASCII из тела run: — раннер пишет .ps1 без BOM, Windows PowerShell читает его в cp1251.",
            file=sys.stderr,
        )
        return 1

    print(f"workflow: тела run: в Windows-jobs разбираются PowerShell и держат ASCII ({checked} файлов)")
    return 0


if __name__ == "__main__":
    sys.exit(main())

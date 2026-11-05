"""Домик в плашке-герое писем приглашения и активации — картинкой-вложением.

Письма `invitation` и `activation` получают в герое домик из макета: справа от
надзаголовка и заголовка встаёт `<img src="cid:domovoy-house@domovoy">`, а сам PNG
едет вложением письма (`app/mail.py`, `_attach_house_image`). Внешних ссылок и
`data:`-URI в письме не появляется: картинка лежит внутри `multipart/related`.

Вёрстка — копия `_document()` из `0059_mail_html_bodies` в самой ревизии (ревизии не
импортируют друг друга) с изменённым только героем: он стал двухколоночной таблицей
`role="presentation"`. Тексты, плейсхолдеры, шаги, кнопка, примечание и подвал не
меняются.

Ревизия **аддитивная по смыслу**: она переписывает `body_html` только у строк
`invitation` и `activation`, которых не создаёт, и не трогает ни другие коды, ни
`subject`, ни plain-текст. `downgrade` возвращает `body_html` ровно тот, что был в
`0059`, — прежний вид героя хранится рядом (`*_HTML_PREVIOUS`), а не остаётся `NULL`:
иначе после отката письма уехали бы в старую обёртку из plain-текста.

Идентификатор ревизии короче 32 символов: колонка `alembic_version.version_num` имеет
тип `varchar(32)`.

Сводящей ревизии (`0063_merge_main_heads`) эта ревизия не заводит: она берёт ту, что
приносит PR #174 — разные ветки не могут завести две сводящие ревизии из одних и тех
же родителей, иначе после слияния в дереве снова окажутся две головы и `alembic
upgrade head` в `entrypoint.sh` упадёт с «Multiple head revisions».
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0064_mail_hero_house"
down_revision: str | None = "0063_merge_main_heads"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# Коды шаблонов, которым достаётся домик. Остальные строки `mail_templates` ревизия
# не трогает вовсе.
INVITATION_CODE = "invitation"
ACTIVATION_CODE = "activation"

UPDATE_BODY_HTML_SQL = "UPDATE mail_templates SET body_html = :body_html WHERE code = :code"

# Герой из `0059_mail_html_bodies`: один `td` с надзаголовком и заголовком.
HERO_PLAIN = """\
                  <div style="padding:0 0 8px 0;font-size:12px;line-height:1.4;color:#4a5a6b">Для вас открыта дверь</div>
                  <div style="font-size:28px;line-height:1.2;font-weight:700;color:#27313d">{hero_title}</div>"""

# Герой с домиком: слева те же надзаголовок и заголовок, справа растр 112×112,
# который приезжает вложением с `cid`. `alt` пустой намеренно: домик — украшение,
# а не смысл, и без картинки письмо читается.
HERO_WITH_HOUSE = """\
                  <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%"
                         style="width:100%;border-collapse:collapse">
                    <tr>
                      <td valign="middle" style="padding:0">
                        <div style="padding:0 0 8px 0;font-size:12px;line-height:1.4;color:#4a5a6b">Для вас открыта дверь</div>
                        <div style="font-size:28px;line-height:1.2;font-weight:700;color:#27313d">{hero_title}</div>
                      </td>
                      <td width="112" align="right" valign="middle" style="width:112px;padding:0 0 0 16px">
                        <img src="cid:domovoy-house@domovoy" width="112" height="112" alt="" style="display:block;border:0;outline:none">
                      </td>
                    </tr>
                  </table>"""


def _document(
    *,
    hero_title: str,
    intro: str,
    button_label: str,
    ignore_line: str,
    with_house: bool,
) -> str:
    """Собрать письмо целиком: шапка, герой, шаги, кнопка, примечание, подвал.

    От письма к письму отличаются только герой, абзац после приветствия, надпись
    на кнопке и вторая строка примечания — они и приходят аргументами. Строки с
    плейсхолдерами (`{full_name}`, `{activation_url}`, …) остаются в разметке как
    есть: их подставляет `app.mail` уже после выборки шаблона из базы. `with_house`
    переключает только герой — так `downgrade` возвращает вёрстку `0059`
    байт-в-байт, а не её пересказ.
    """
    hero = (HERO_WITH_HOUSE if with_house else HERO_PLAIN).format(hero_title=hero_title)
    return f"""<html lang="ru">
<head>
<meta charset="utf-8">
<title>{{subject}}</title>
</head>
<body style="margin:0;padding:0;background:#ffffff">
<table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%"
       style="width:100%;border-collapse:collapse;background:#ffffff">
  <tr>
    <td align="center" style="padding:0">
      <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="600"
             style="width:100%;max-width:600px;border-collapse:collapse;font-family:'Segoe UI',system-ui,Arial,Helvetica,sans-serif;color:#27313d">
        <tr>
          <td style="padding:32px 32px 0 32px">

            <div style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;overflow:hidden;opacity:0;color:#ffffff">Для вас открыта дверь</div>

            <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%"
                   style="width:100%;border-collapse:collapse">
              <tr>
                <td width="150" valign="middle" style="width:150px;padding:0 0 28px 0">
                  <table role="presentation" border="0" cellpadding="0" cellspacing="0"
                         style="border-collapse:collapse">
                    <tr>
                      <td width="32" height="32" valign="top"
                          style="width:32px;height:32px;padding:6px 0 0 0;background:#dceee4;border-radius:8px;text-align:center">
                        <div style="width:0;height:0;margin:0 auto;border-left:9px solid #dceee4;border-right:9px solid #dceee4;border-bottom:8px solid #27313d;font-size:0;line-height:0">&nbsp;</div>
                        <div style="width:13px;height:8px;margin:0 auto;border:2px solid #27313d;border-top:0;font-size:0;line-height:0">&nbsp;</div>
                      </td>
                      <td valign="middle" style="padding:0 0 0 10px;font-size:17px;line-height:1.2;font-weight:700;color:#27313d">Домовой</td>
                    </tr>
                  </table>
                </td>
                <td valign="middle" align="right"
                    style="padding:0 0 28px 0;font-size:12px;line-height:1.4;color:#5c6a78;text-align:right">
                  Учёт и управление<br>общежитиями
                </td>
              </tr>
            </table>

            <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%"
                   style="width:100%;border-collapse:collapse">
              <tr>
                <td style="padding:28px;background:#dceee4;border-radius:18px">
{hero}
                </td>
              </tr>
            </table>

            <p style="margin:28px 0 0 0;padding:0;font-size:16px;line-height:1.5;font-weight:600;color:#27313d">Здравствуйте, {{full_name}}!</p>
            <p style="margin:12px 0 0 0;padding:0;font-size:15px;line-height:1.6;color:#4a5a6b">{intro}</p>

            <p style="margin:32px 0 0 0;padding:0;font-size:16px;line-height:1.4;font-weight:700;color:#27313d">Три простых шага — и вы в команде</p>

            <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%"
                   style="width:100%;margin:16px 0 0 0;border-collapse:collapse">
              <tr>
                <td width="34" valign="top" style="width:34px;padding:1px 0 16px 0">
                  <table role="presentation" border="0" cellpadding="0" cellspacing="0"
                         style="border-collapse:collapse">
                    <tr>
                      <td width="22" height="22" align="center" valign="middle"
                          style="width:22px;height:22px;background:#2f7d62;border-radius:11px;font-size:12px;line-height:22px;font-weight:700;color:#ffffff;text-align:center">1</td>
                    </tr>
                  </table>
                </td>
                <td valign="top" style="padding:0 0 16px 0">
                  <div style="font-size:15px;line-height:1.4;font-weight:600;color:#27313d">Задайте пароль</div>
                  <div style="padding:2px 0 0 0;font-size:13px;line-height:1.5;color:#4a5a6b">Для безопасного входа в кабинет.</div>
                </td>
              </tr>
              <tr>
                <td width="34" valign="top" style="width:34px;padding:1px 0 16px 0">
                  <table role="presentation" border="0" cellpadding="0" cellspacing="0"
                         style="border-collapse:collapse">
                    <tr>
                      <td width="22" height="22" align="center" valign="middle"
                          style="width:22px;height:22px;background:#2f7d62;border-radius:11px;font-size:12px;line-height:22px;font-weight:700;color:#ffffff;text-align:center">2</td>
                    </tr>
                  </table>
                </td>
                <td valign="top" style="padding:0 0 16px 0">
                  <div style="font-size:15px;line-height:1.4;font-weight:600;color:#27313d">Подтвердите согласия</div>
                  <div style="padding:2px 0 0 0;font-size:13px;line-height:1.5;color:#4a5a6b">Примите правила и обработку данных.</div>
                </td>
              </tr>
              <tr>
                <td width="34" valign="top" style="width:34px;padding:1px 0 0 0">
                  <table role="presentation" border="0" cellpadding="0" cellspacing="0"
                         style="border-collapse:collapse">
                    <tr>
                      <td width="22" height="22" align="center" valign="middle"
                          style="width:22px;height:22px;background:#2f7d62;border-radius:11px;font-size:12px;line-height:22px;font-weight:700;color:#ffffff;text-align:center">3</td>
                    </tr>
                  </table>
                </td>
                <td valign="top" style="padding:0">
                  <div style="font-size:15px;line-height:1.4;font-weight:600;color:#27313d">Начните работу</div>
                  <div style="padding:2px 0 0 0;font-size:13px;line-height:1.5;color:#4a5a6b">Откройте кабинет вашей организации.</div>
                </td>
              </tr>
            </table>

            <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%"
                   style="width:100%;margin:28px 0 0 0;border-collapse:separate">
              <tr>
                <td align="center" bgcolor="#2f7d62" style="background:#2f7d62;border-radius:12px">
                  <a href="{{activation_url}}"
                     style="display:block;padding:18px 24px;border-radius:12px;font-size:16px;line-height:20px;font-weight:700;color:#ffffff;text-decoration:none;text-align:center">{button_label}</a>
                </td>
              </tr>
            </table>

            <p style="margin:14px 0 0 0;padding:0;font-size:12px;line-height:1.5;color:#5c6a78">Если кнопка не работает, скопируйте ссылку в браузер:</p>
            <p style="margin:4px 0 0 0;padding:0;font-size:12px;line-height:1.5;color:#2f7d62;word-break:break-all"><a href="{{activation_url}}"
               style="color:#2f7d62;text-decoration:underline;word-break:break-all">{{activation_url}}</a></p>

            <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%"
                   style="width:100%;margin:24px 0 0 0;border-collapse:collapse">
              <tr>
                <td style="padding:18px;background:#f4ebdc;border-radius:12px;font-size:13px;line-height:1.55;color:#4a5a6b">
                  Ссылка действует {{expires_hours}} ч. и может быть использована один раз.<br>
                  {ignore_line}
                </td>
              </tr>
            </table>

            <p style="margin:28px 0 0 0;padding:0;font-size:15px;line-height:1.6;color:#4a5a6b">До встречи в кабинете,<br><strong style="font-weight:700;color:#27313d">команда «Домового»</strong></p>

            <div style="margin:32px 0 0 0;padding:20px 0 0 0;border-top:1px solid #f4ebdc">
              <table role="presentation" border="0" cellpadding="0" cellspacing="0"
                     style="border-collapse:collapse">
                <tr>
                  <td width="24" height="24" valign="top"
                      style="width:24px;height:24px;padding:5px 0 0 0;background:#dceee4;border-radius:6px;text-align:center">
                    <div style="width:0;height:0;margin:0 auto;border-left:6px solid #dceee4;border-right:6px solid #dceee4;border-bottom:5px solid #27313d;font-size:0;line-height:0">&nbsp;</div>
                    <div style="width:8px;height:4px;margin:0 auto;border:2px solid #27313d;border-top:0;font-size:0;line-height:0">&nbsp;</div>
                  </td>
                  <td valign="middle" style="padding:0 0 0 8px;font-size:14px;line-height:1.2;font-weight:700;color:#27313d">Домовой</td>
                </tr>
              </table>
              <div style="padding:10px 0 0 0;font-size:13px;line-height:1.5;color:#4a5a6b">Порядок в общежитиях. Спокойствие в работе.</div>
              <div style="padding:10px 0 0 0;font-size:12px;line-height:1.5;color:#4a5a6b">
                <a href="{{site_url}}/" style="color:#4a5a6b;text-decoration:underline">О сервисе</a>
                <span style="padding:0 6px;color:#5c6a78">·</span>
                <a href="{{site_url}}/documents/privacy-policy" style="color:#4a5a6b;text-decoration:underline">Политика конфиденциальности</a>
              </div>
              <div style="padding:12px 0 0 0;font-size:11px;line-height:1.5;color:#5c6a78">Это автоматическое письмо. Отвечать на него не нужно.<br>© 2026 Домовой</div>
            </div>

          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>"""


# Письмо-приглашение: абзац с названием организации приходит ключом
# `organization_phrase` (« организации «Ромашка»» или пустая строка).
INVITATION_HTML = _document(
    hero_title="Добро пожаловать в вашу команду",
    intro=(
        "Администратор{organization_phrase} приглашает вас в кабинет организации в "
        "«Домовом». После активации вы сможете работать с общежитиями, персоналом и "
        "отчётами в рамках предоставленных вам прав."
    ),
    button_label="Принять приглашение",
    ignore_line="Если вы не ждали приглашения, просто проигнорируйте это письмо.",
    with_house=True,
)

# Письмо активации: тот, кто зарегистрировался сам, организации ещё не назвал.
ACTIVATION_HTML = _document(
    hero_title="Добро пожаловать в «Домовой»",
    intro=(
        "Вы зарегистрировались в системе учёта проживающих «Домовой». Задайте пароль — "
        "и кабинет откроется."
    ),
    button_label="Активировать кабинет",
    ignore_line="Если вы не регистрировались, просто проигнорируйте это письмо.",
    with_house=True,
)

# Вёрстка ровно из `0059_mail_html_bodies`: её возвращает `downgrade`. Ревизии не
# импортируют друг друга, поэтому прежний вид героя хранится здесь, а не берётся
# оттуда: иначе откат оставил бы письма без разметки вообще.
INVITATION_HTML_PREVIOUS = _document(
    hero_title="Добро пожаловать в вашу команду",
    intro=(
        "Администратор{organization_phrase} приглашает вас в кабинет организации в "
        "«Домовом». После активации вы сможете работать с общежитиями, персоналом и "
        "отчётами в рамках предоставленных вам прав."
    ),
    button_label="Принять приглашение",
    ignore_line="Если вы не ждали приглашения, просто проигнорируйте это письмо.",
    with_house=False,
)

ACTIVATION_HTML_PREVIOUS = _document(
    hero_title="Добро пожаловать в «Домовой»",
    intro=(
        "Вы зарегистрировались в системе учёта проживающих «Домовой». Задайте пароль — "
        "и кабинет откроется."
    ),
    button_label="Активировать кабинет",
    ignore_line="Если вы не регистрировались, просто проигнорируйте это письмо.",
    with_house=False,
)


def upgrade() -> None:
    """Проставить вёрстку с домиком двум существующим письмам.

    Отсутствующий код не создаётся: `UPDATE` по нему просто не найдёт строку.
    """
    bind = op.get_bind()
    for code, body_html in (
        (INVITATION_CODE, INVITATION_HTML),
        (ACTIVATION_CODE, ACTIVATION_HTML),
    ):
        bind.execute(sa.text(UPDATE_BODY_HTML_SQL), {"body_html": body_html, "code": code})


def downgrade() -> None:
    """Вернуть `body_html` ровно тот, что был в `0059_mail_html_bodies`."""
    bind = op.get_bind()
    for code, body_html in (
        (INVITATION_CODE, INVITATION_HTML_PREVIOUS),
        (ACTIVATION_CODE, ACTIVATION_HTML_PREVIOUS),
    ):
        bind.execute(sa.text(UPDATE_BODY_HTML_SQL), {"body_html": body_html, "code": code})

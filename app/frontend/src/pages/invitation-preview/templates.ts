export interface InvitationDesign {
  id: number;
  name: string;
  description: string;
  note: string;
  accent: string;
  paper: string;
  ink: string;
}

export const invitationDesigns: InvitationDesign[] = [
  {
    id: 1,
    name: 'По вашему образцу',
    description:
      'Тёмная шапка, выразительный заголовок и понятные шаги. Знакомая композиция в цветах «Домового».',
    note: 'Ближе всего к референсу',
    accent: '#2f7d62',
    paper: '#dceee4',
    ink: '#10273c',
  },
  {
    id: 2,
    name: 'Добро пожаловать домой',
    description:
      'Мятная палитра, открытая дверь и дружелюбная подача. Продолжение визуального языка нашего сайта.',
    note: 'Фирменный и дружелюбный',
    accent: '#2f7d62',
    paper: '#dceee4',
    ink: '#294c3e',
  },
  {
    id: 3,
    name: 'Только главное',
    description:
      'Спокойное деловое письмо. Организация и кнопка принятия видны сразу, инструкция расположена ниже.',
    note: 'Короткий и деловой',
    accent: '#34679e',
    paper: '#dce9f7',
    ink: '#27313d',
  },
  {
    id: 4,
    name: 'Тёплая открытка',
    description:
      'Небольшой квартал, пастельные оттенки и центрированная композиция. Приглашение с ощущением заботы.',
    note: 'С иллюстрацией общежитий',
    accent: '#5b4b9e',
    paper: '#e6e1f5',
    ink: '#373451',
  },
  {
    id: 5,
    name: 'Ваш пропуск в команду',
    description:
      'Персональный пропуск с именем и организацией. Акцент на том, кто приглашён и куда откроется доступ.',
    note: 'Персональный и необычный',
    accent: '#5b4b9e',
    paper: '#e6e1f5',
    ink: '#27313d',
  },
];

const organization = 'ООО «Северный ресурс»';
const recipient = 'Дмитрий Кириллов';
// Адрес зарезервирован для примеров и никогда не содержит рабочего токена.
const demoLink = 'https://domovoy.example/activate/demo-invitation';
const textColor = '#536171';

function table(content: string, style = ''): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate;border-spacing:0;${style}">${content}</table>`;
}

function logo(color = '#27313d', small = false): string {
  return `<span style="display:inline-block;vertical-align:middle;width:${small ? 25 : 32}px;height:${small ? 25 : 32}px;line-height:${small ? 25 : 32}px;background:#dceee4;border-radius:9px;text-align:center;color:#27313d;font-size:${small ? 20 : 25}px;font-weight:bold;">⌂</span><span style="display:inline-block;vertical-align:middle;margin-left:9px;color:${color};font-size:${small ? 20 : 24}px;font-weight:800;letter-spacing:-.7px;">Домовой</span>`;
}

function brandHeader(dark = false, descriptor = 'Учёт и управление общежитиями'): string {
  return table(
    `<tr><td class="mobile-pad" style="padding:26px 36px;${dark ? 'background:#0c1f31;' : ''}">${logo(dark ? '#ffffff' : '#27313d')}</td><td class="brand-description" align="right" style="padding:26px 36px 26px 0;${dark ? 'background:#0c1f31;' : ''}font-size:11px;line-height:1.6;color:${dark ? '#b1c3d4' : '#687585'};width:180px;">${descriptor}</td></tr>`,
  );
}

function steps(accent: string, horizontal = false, compact = false): string {
  const items = [
    ['Задайте пароль', 'Для безопасного входа в кабинет.'],
    ['Подтвердите согласия', 'Примите правила и обработку данных.'],
    ['Начните работу', 'Откройте кабинет вашей организации.'],
  ];
  if (horizontal) {
    return table(
      `<tr>${items.map(([title, text], i) => `<td class="step-column" width="33.33%" valign="top" style="padding:0 8px;text-align:center;"><span style="display:inline-block;width:30px;height:30px;line-height:30px;border:1px solid ${accent};border-radius:50%;color:${accent};font-size:13px;font-weight:bold;">${i + 1}</span><p style="margin:11px 0 5px;color:#27313d;font-size:13px;font-weight:bold;line-height:1.45;">${title}</p><p style="margin:0;font-size:12px;line-height:1.6;color:${textColor};">${text}</p></td>`).join('')}</tr>`,
    );
  }
  return table(
    items
      .map(
        ([title, text], i) =>
          `<tr><td width="${compact ? 34 : 42}" valign="top" style="padding:0 12px ${i === 2 ? 0 : compact ? 15 : 22}px 0;"><span style="display:block;width:${compact ? 24 : 29}px;height:${compact ? 24 : 29}px;line-height:${compact ? 24 : 29}px;background:${accent};border-radius:50%;text-align:center;color:white;font-size:13px;font-weight:bold;">${i + 1}</span></td><td style="padding:0 0 ${i === 2 ? 0 : compact ? 15 : 22}px;"><p style="margin:0 0 3px;font-size:${compact ? 14 : 15}px;font-weight:bold;color:#27313d;line-height:1.5;">${title}</p><p style="margin:0;font-size:13px;line-height:1.6;color:${textColor};">${text}</p></td></tr>`,
      )
      .join(''),
  );
}

function action(accent: string, full = false): string {
  return `<div style="text-align:center;margin:30px 0 0;"><a href="#demo-invitation" style="display:${full ? 'block' : 'inline-block'};padding:17px 28px;border-radius:10px;background:${accent};color:#ffffff;text-decoration:none;font-size:16px;font-weight:bold;line-height:1.4;">Принять приглашение</a></div>`;
}

function fallback(accent: string): string {
  return `<p style="margin:22px 0 0;text-align:center;font-size:11px;line-height:1.8;color:#687585;">Если кнопка не работает, скопируйте ссылку в браузер:<br><a href="#demo-invitation" style="color:${accent};text-decoration:underline;overflow-wrap:anywhere;word-break:break-word;">${demoLink}</a></p>`;
}

function expiry(accent: string, background = '#f3f6f8'): string {
  return `<div style="margin-top:28px;padding:17px 20px;border-left:3px solid ${accent};border-radius:3px 12px 12px 3px;background:${background};font-size:12px;line-height:1.8;color:${textColor};">Ссылка действует <strong style="color:#27313d;">24 часа</strong> и может быть использована один раз.<br>Если вы не ждали приглашения, просто проигнорируйте это письмо.</div>`;
}

function signoff(center = false): string {
  return `<p style="margin:28px 0 0;padding-top:22px;border-top:1px solid #e5e9ec;font-size:13px;color:#687585;line-height:1.7;${center ? 'text-align:center;' : ''}">До встречи в кабинете,<br><strong style="color:#27313d;">команда «Домового»</strong></p>`;
}

function footer(dark = false, centered = false): string {
  return `<div class="mobile-pad" style="padding:27px 36px;background:${dark ? '#0c1f31' : '#f6f8f7'};color:${dark ? '#afbdcc' : '#687585'};${centered ? 'text-align:center;' : ''}">${logo(dark ? '#ffffff' : '#27313d', true)}<p style="margin:12px 0 19px;font-size:12px;line-height:1.6;">Порядок в общежитиях. Спокойствие в работе.</p><p style="margin:0 0 18px;font-size:11px;line-height:1.8;"><a href="#demo-invitation" style="color:inherit;text-decoration:underline;">О сервисе</a><span style="padding:0 9px;">·</span><a href="#demo-invitation" style="color:inherit;text-decoration:underline;">Политика конфиденциальности</a></p><p style="border-top:1px solid ${dark ? '#314253' : '#e1e6e3'};padding-top:17px;margin:0;font-size:10px;line-height:1.8;">Это автоматическое письмо. Отвечать на него не нужно.<br>© 2026 Домовой</p></div>`;
}

function intro(center = false): string {
  return `<div style="${center ? 'text-align:center;' : ''}"><p style="margin:0 0 16px;font-size:16px;color:#27313d;line-height:1.7;">Здравствуйте, <strong>Дмитрий!</strong></p><p style="margin:0;font-size:14px;line-height:1.9;color:${textColor};">Администратор <strong style="color:#27313d;">${organization}</strong> приглашает вас в кабинет организации в «Домовом». После активации вы сможете работать с общежитиями, персоналом и отчётами в рамках предоставленных вам прав.</p></div>`;
}

function houseArt(neighborhood = false): string {
  const houses = neighborhood
    ? `<path d="M7 104V56l30-22 30 22v48" fill="#dceee4" stroke="#27313d" stroke-width="2.4"/><path d="M124 104V48l27-18 27 18v56" fill="#fbe0d2" stroke="#27313d" stroke-width="2.4"/><path d="M18 61h10v11H18zm25 0h10v11H43zm93-7h10v11h-10zm18 0h10v11h-10z" fill="#fffdf9" stroke="#27313d" stroke-width="2"/>`
    : '';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="184" height="128" viewBox="0 0 184 128"><circle cx="143" cy="24" r="13" fill="#f2d793"/>${houses}<path d="M${neighborhood ? '52 104V42L92 12l40 30v62' : '40 109V46L92 9l52 37v63'}" fill="#fffdf9" stroke="#27313d" stroke-width="2.8" stroke-linejoin="round"/><path d="M${neighborhood ? '45 46 92 9l47 37' : '30 51 92 5l62 46'}" fill="none" stroke="#27313d" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M65 50h16v18H65zm37 0h16v18h-16" fill="#dce9f7" stroke="#27313d" stroke-width="2.2"/><path d="M80 105V82h24v23" fill="#a9d6c1" stroke="#27313d" stroke-width="2.2"/><path d="m104 82 13 6v25l-13-8z" fill="#2f7d62" stroke="#27313d" stroke-width="2.2" stroke-linejoin="round"/><circle cx="112" cy="98" r="1.5" fill="#fcefc7"/><path d="M7 112h170" stroke="#27313d" stroke-width="2.6" stroke-linecap="round"/><path d="M21 110v-8m-5-5 5 5 5-5m137 13V96m-6-7 6 7 6-7" fill="none" stroke="#2f7d62" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  return `<img src="data:image/svg+xml,${encodeURIComponent(svg)}" alt="" width="184" height="128" style="display:block;max-width:100%;height:auto;margin:0 auto;">`;
}

function classic(): string {
  return `${brandHeader(true)}<div class="mobile-pad" style="padding:35px 36px 37px;background:#10273c;"><p style="margin:0 0 18px;font-size:11px;letter-spacing:1.5px;color:#a9d6c1;font-weight:bold;">ПРИГЛАШЕНИЕ В КАБИНЕТ</p><div style="width:43px;height:3px;background:#a9d6c1;margin-bottom:20px;"></div><h1 style="font-size:30px;font-weight:bold;line-height:1.23;letter-spacing:-.7px;color:white;margin:0 0 17px;">Вас пригласили в кабинет<br>организации</h1><p style="margin:0;color:#b7c8d9;font-size:14px;line-height:1.6;">${organization} · сервис «Домовой»</p></div><div class="mobile-pad" style="padding:32px 36px 34px;">${intro()}<div style="margin-top:29px;">${steps('#2f7d62')}</div>${action('#2f7d62')}${fallback('#26654f')}${expiry('#2f7d62')}${signoff()}</div>${footer(true)}`;
}

function mint(): string {
  return `${brandHeader()}<div class="mobile-pad" style="padding:4px 26px 0;">${table(`<tr><td class="mobile-pad" style="padding:28px 24px;background:#dceee4;border-radius:18px 0 0 0;"><p style="margin:0 0 12px;font-size:12px;color:#26654f;">Для вас открыта дверь</p><h1 style="margin:0;font-size:31px;font-weight:bold;line-height:1.2;letter-spacing:-.8px;color:#294c3e;">Добро пожаловать<br>в вашу команду</h1></td><td class="hero-art" width="155" valign="bottom" style="padding:20px 16px 22px 0;background:#dceee4;border-radius:0 18px 0 0;">${houseArt()}</td></tr>`)}</div><div class="mobile-pad" style="padding:29px 42px 34px;">${intro()}<p style="margin:24px 0 18px;font-size:15px;font-weight:bold;color:#294c3e;">Три простых шага — и вы в команде</p>${steps('#2f7d62', false, true)}${action('#2f7d62', true)}${fallback('#26654f')}${expiry('#2f7d62', '#f0f7f3')}${signoff()}</div>${footer()}`;
}

function minimal(): string {
  return `${brandHeader(false, 'Приглашение в организацию')}<div class="mobile-pad" style="padding:10px 40px 34px;"><div style="width:40px;height:4px;background:#34679e;margin:0 0 24px;"></div><h1 style="margin:0 0 22px;font-size:29px;line-height:1.25;letter-spacing:-.7px;color:#27313d;">Дмитрий, присоединяйтесь<br>к команде в «Домовом»</h1><p style="margin:0;font-size:14px;line-height:1.85;color:${textColor};">Администратор пригласил вас в рабочий кабинет. Здесь ваша команда ведёт учёт персонала и управляет общежитиями.</p><div style="margin-top:23px;padding:19px 20px;background:#f0f5fb;border-radius:8px;border:1px solid #dce9f7;"><p style="margin:0 0 6px;font-size:11px;color:#536171;">Ваша организация</p><p style="margin:0;color:#27313d;font-size:17px;font-weight:bold;">${organization}</p><p style="margin:7px 0 0;font-size:12px;line-height:1.7;color:${textColor};">Доступ к данным — в рамках предоставленных прав.</p></div>${action('#34679e', true)}<p style="margin:27px 0 18px;color:#27313d;font-weight:bold;font-size:14px;">После перехода по ссылке</p>${steps('#34679e', false, true)}${fallback('#34679e')}${expiry('#34679e')}${signoff()}</div>${footer()}`;
}

function postcard(): string {
  return `${brandHeader(false, 'Порядок начинается с команды')}<div class="mobile-pad" style="padding:25px 35px 30px;background:#f0edf9;text-align:center;">${houseArt(true)}<h1 style="margin:16px 0 12px;color:#373451;font-size:31px;line-height:1.22;letter-spacing:-.8px;">У вашей команды<br>есть место для вас</h1><p style="margin:0;font-size:13px;line-height:1.7;color:#665984;">Приглашение в кабинет ${organization}</p></div><div class="mobile-pad" style="padding:29px 36px 34px;">${intro(true)}<div style="margin-top:29px;padding:24px 0;border-top:1px solid #e7e2f2;border-bottom:1px solid #e7e2f2;">${steps('#5b4b9e', true)}</div>${action('#5b4b9e')}${fallback('#5b4b9e')}${expiry('#5b4b9e', '#f5f3fa')}${signoff(true)}</div>${footer(false, true)}`;
}

function pass(): string {
  return `${brandHeader()}<div class="mobile-pad" style="padding:9px 36px 34px;"><p style="margin:0 0 10px;color:#5b4b9e;font-size:12px;">Персональное приглашение</p><h1 style="margin:0 0 23px;color:#27313d;font-size:31px;line-height:1.2;letter-spacing:-.8px;">Ваш пропуск<br>в команду готов</h1><div style="border:1px solid #d5cdea;border-radius:15px;overflow:hidden;"><div style="padding:21px 24px;background:#e6e1f5;">${table(`<tr><td><p style="margin:0 0 7px;font-size:11px;color:#665984;">Рабочее пространство</p><p style="margin:0;color:#373451;font-size:20px;font-weight:bold;line-height:1.35;">${organization}</p></td><td width="42" align="right"><span style="display:inline-block;width:34px;height:34px;background:#fff;border-radius:50%;color:#5b4b9e;line-height:34px;text-align:center;font-size:22px;">⌂</span></td></tr>`)}</div><div style="padding:20px 24px;border-top:2px dashed #c8bfe1;background:#fcfbfe;"><p style="margin:0 0 5px;color:#687585;font-size:11px;">Кого ждём в команде</p><p style="margin:0;color:#27313d;font-size:19px;font-weight:bold;">${recipient}</p><p style="margin:9px 0 0;font-size:12px;color:#665984;">Доступ откроется после активации</p></div></div><p style="margin:24px 0 0;color:${textColor};font-size:14px;line-height:1.85;">Дмитрий, администратор приглашает вас в «Домовой» для работы с общежитиями, персоналом и отчётами организации. Возможности кабинета зависят от предоставленных вам прав.</p>${action('#5b4b9e', true)}<div style="margin-top:28px;">${steps('#5b4b9e', false, true)}</div>${fallback('#5b4b9e')}${expiry('#5b4b9e', '#f5f3fa')}${signoff()}</div>${footer()}`;
}

const renderers = [classic, mint, minimal, postcard, pass];

export function invitationHtml(id: number): string {
  const render = renderers[id - 1] ?? classic;
  return `<!doctype html><html lang="ru"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light"><title>Приглашение в организацию — Домовой</title><style>html,body{margin:0;padding:0;background:#ffffff;color:#27313d;font-family:Arial,Helvetica,sans-serif;-webkit-text-size-adjust:100%;}*{box-sizing:border-box;}a:focus-visible{outline:2px solid #34679e;outline-offset:4px;}@media(max-width:480px){.mobile-pad{padding-left:22px!important;padding-right:22px!important;}.brand-description{display:none!important;}.hero-art{width:112px!important;padding-right:10px!important;}h1{font-size:26px!important;}.step-column{display:block!important;width:100%!important;padding:0 0 20px!important;}.step-column:last-child{padding-bottom:0!important;}}@media(prefers-reduced-motion:reduce){*{scroll-behavior:auto!important;}}</style></head><body><div id="email-root" style="width:100%;max-width:640px;margin:0 auto;background:#ffffff;overflow:hidden;">${render()}</div></body></html>`;
}

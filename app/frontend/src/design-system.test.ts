import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Страж дизайн-системы. Контракт живёт в `src/DESIGN.md`, значения — в `:root`
 * `src/index.css`, а модули рабочего пространства только потребляют их. Тест
 * текстовый (как `design-tokens.test.ts`) и читает файлы через `readFileSync`,
 * потому что jsdom не считает CSS и молча пропустил бы вторую палитру.
 */
const SRC = resolve(process.cwd(), 'src');

/** Все CSS-модули проекта: правило действует на каждый из них. */
function moduleCssFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      return moduleCssFiles(path);
    }
    return path.endsWith('.module.css') ? [path] : [];
  });
}

const FILES = moduleCssFiles(SRC).map((path) => ({
  path: path.slice(SRC.length + 1).replace(/\\/g, '/'),
  css: readFileSync(path, 'utf8'),
}));

/** Глобальный слой без комментариев: правила кнопок ищутся по точному селектору. */
const INDEX_CSS = readFileSync(join(SRC, 'index.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

/** Тело правила по точному селектору; пустая строка, если правила нет. */
function ruleBody(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`(?:^|[};])\\s*${escaped}\\s*\\{([^}]*)\\}`, 'm').exec(css);
  return match ? match[1] : '';
}

/** Экраны лендинга: компактный размер кабинета сюда не протекает. */
const LANDING_SCREENS = ['pages/Landing.tsx', 'pages/Pricing.tsx'];

interface Rule {
  selector: string;
  body: string;
}

/** Правила файла: комментарии выброшены, селектор и тело разделены первой `{`. */
function rules(css: string): Rule[] {
  const found: Rule[] = [];
  for (const chunk of css.replace(/\/\*[\s\S]*?\*\//g, '').split('}')) {
    const open = chunk.indexOf('{');
    if (open === -1) continue;
    found.push({ selector: chunk.slice(0, open).trim(), body: chunk.slice(open + 1) });
  }
  return found;
}

/** Последний компаунд селектора без псевдоклассов и атрибутов. */
function lastCompound(selector: string): string {
  const parts = selector.split(/[\s>+~]+/);
  const last = parts[parts.length - 1] ?? '';
  return last.replace(/\[[^\]]*\]/g, '').replace(/::?[a-z-]+(?:\([^)]*\))?/gi, '');
}

/**
 * Известные исключения: кнопки, которым локальная геометрия нужна по смыслу —
 * иконочные стрелки порядка строк, текстовая кнопка-название строки отчёта,
 * чипы-ссылки на ячейки формулы и кнопка внутри плашки ошибки организации.
 * Это не «ослабление» правила, а явный список: всё остальное обязано брать
 * вид у глобального `.btn`.
 *
 * Кнопки-иконки каркаса (`.shell .logout`, `.shell .menu-toggle`,
 * `.shell .modal__close`) тоже остаются локальными, но под проверку не
 * попадают: их селекторы оканчиваются классом, а не элементом `button`.
 */
const BUTTON_RULE_EXCEPTIONS = [
  '.rowName button',
  '.rowMove button',
  '.references button',
  '.shell .organization-error button',
  // Обводка фокуса — сквозное правило доступности для кнопок и ссылок каркаса,
  // а не вид кнопки: она берёт `--focus-outline-width` и одинакова везде.
  '.shell button:focus-visible',
];

/**
 * Кнопки, которые красятся локально до сих пор. Это вид экранов, появившихся
 * в рабочем пространстве параллельно с задачей #25 — прайс и тарифы, настройки
 * вкладок и столбцов, виджеты дашборда, статистика, персонал, дизайн-превью.
 * Задача #25 перечисляет конкретные файлы и прямо запрещает менять визуальные
 * значения, поэтому перевод этих кнопок на `.btn` — отдельная задача: их
 * компактный вид (радиус 8px, отступы 6–8px 11px, 11–13px) не совпадает
 * ни с `.btn--sm` (39px, радиус 9px), ни с `.btn--ghost`.
 *
 * Список точечный — пара «файл: селектор», а не модуль целиком: любая новая
 * кнопка в этих же модулях снова валит проверку. Когда экран переезжает на
 * глобальный слой, его строки отсюда удаляются.
 */
const BUTTON_RULES_AWAITING_MIGRATION = [
  'pages/DormitoryDesignPreview.module.css: .actionMenu button',
  'pages/DormitoryDesignPreview.module.css: .actionMenu button:hover',
  'pages/DormitoryDesignPreview.module.css: .modeChoices button',
  'pages/DormitoryDesignPreview.module.css: .order button',
  'pages/DormitoryDesignPreview.module.css: .page button:focus-visible',
  'pages/DormitoryDesignPreview.module.css: .previewBar button',
  'pages/DormitoryDesignPreview.module.css: .settingsTabs button',
  'pages/DormitoryDesignPreview.module.css: .subtabs button',
  'pages/DormitoryDesignPreview.module.css: .tabs button',
  'pages/personnel-preview/Operations.module.css: .savedLists > div button',
  'pages/personnel-preview/Operations.module.css: .taskMeta button',
  'pages/personnel-preview/Operations.module.css: .week > button',
  'pages/personnel-preview/Operations.module.css: .week > button:hover',
  "pages/personnel-preview/Operations.module.css: .week > button[aria-pressed='true']",
  'pages/personnel-preview/Operations.module.css: .widgetRows > button',
  'pages/personnel-preview/Operations.module.css: .widgetTasks button',
  'pages/personnel-preview/PersonnelDesignPreview.module.css: .cardFooter button',
  'pages/personnel-preview/PersonnelDesignPreview.module.css: .filterChips button',
  "pages/personnel-preview/PersonnelDesignPreview.module.css: .filterChips button[aria-pressed='true']",
  'pages/personnel-preview/PersonnelDesignPreview.module.css: .metrics > button',
  'pages/personnel-preview/PersonnelDesignPreview.module.css: .metrics > button:first-child',
  'pages/personnel-preview/PersonnelDesignPreview.module.css: .metrics > button:hover',
  'pages/personnel-preview/PersonnelDesignPreview.module.css: .metrics > button:last-child',
  'pages/personnel-preview/PersonnelDesignPreview.module.css: .metrics > button:nth-child(3)',
  'pages/personnel-preview/PersonnelDesignPreview.module.css: .residentTotal button',
  'pages/personnel-preview/PersonnelDesignPreview.module.css: .sidebar nav button',
  'pages/personnel-preview/PersonnelDesignPreview.module.css: .sidebar nav button[aria-current]',
  'pages/personnel-preview/PersonnelDesignPreview.module.css: .sidebarNote button',
  'pages/personnel-preview/PersonnelDesignPreview.module.css: .tabs button',
  'pages/personnel-preview/PersonnelDesignPreview.module.css: .theme button:focus-visible',
  'pages/StatisticsDesignPreview.module.css: .blockActions button',
  'pages/StatisticsDesignPreview.module.css: .blockActions button:hover',
  'pages/StatisticsDesignPreview.module.css: .breadcrumb button',
  'pages/StatisticsDesignPreview.module.css: .formatGrid button',
  'pages/StatisticsDesignPreview.module.css: .nav button',
  'pages/StatisticsDesignPreview.module.css: .page button:focus-visible',
  'pages/StatisticsDesignPreview.module.css: .tabs button',
  'workspace/dashboard/Dashboard.module.css: .dashboard .blocksActions button',
  "workspace/dashboard/Dashboard.module.css: .dashboard .blocksActions button[aria-pressed='true']",
  'workspace/dashboard/Dashboard.module.css: .dashboard .blockTools button',
  'workspace/dashboard/Dashboard.module.css: .dashboard .hiddenBlocks button',
  'workspace/dashboard/WidgetChart.module.css: .legend button',
  'workspace/dashboard/WidgetDialog.module.css: .actions button',
  'workspace/dashboard/WidgetDialog.module.css: .sourceHeading button',
  'workspace/dormitories/ConfigurableColumns.module.css: .actions button',
  'workspace/dormitories/ConfigurableColumns.module.css: .actions button:last-child',
  'workspace/dormitories/ConfigurableColumns.module.css: .columnList button',
  'workspace/dormitories/ConfigurableColumns.module.css: .controls button',
  'workspace/dormitories/ConfigurableColumns.module.css: .option button',
  'workspace/dormitories/ConfigurableColumns.module.css: .options > button',
  'workspace/dormitories/ConfigurableColumns.module.css: .subtabFields button',
  'workspace/dormitories/CreateDormitoryDialog.module.css: .modes button',
  "workspace/dormitories/CreateDormitoryDialog.module.css: .modes button[aria-pressed='true']",
  'workspace/dormitories/Dormitories.module.css: .dormitoryActions button',
  'workspace/dormitories/DormitorySettingsDialog.module.css: .pages button',
  "workspace/dormitories/DormitorySettingsDialog.module.css: .pages button[aria-selected='true']",
  'workspace/dormitories/DormitorySettingsDialog.module.css: .shell button',
  'workspace/dormitories/DormitoryTabPicker.module.css: .controls button',
  'workspace/dormitories/ManageCustomTabsDialog.module.css: .content button',
  'workspace/dormitories/ReportReadiness.module.css: .readiness .error button',
  'workspace/dormitories/TransferResidentDialog.module.css: .form button',
  "workspace/dormitories/TransferResidentDialog.module.css: .form button[type='submit']",
  "workspace/personnel/Personnel.module.css: .chips button[aria-pressed='true']",
  'workspace/personnel/Personnel.module.css: .linkControl button',
  'workspace/personnel/Personnel.module.css: .metrics button',
  'workspace/personnel/Personnel.module.css: .modal button',
  'workspace/personnel/Personnel.module.css: .modal button:hover:not(:disabled)',
  'workspace/personnel/Personnel.module.css: .page button',
  'workspace/personnel/Personnel.module.css: .page button:hover:not(:disabled)',
  'workspace/personnel/Personnel.module.css: .rows > button',
  'workspace/personnel/Personnel.module.css: .saved > span > button:first-child',
  'workspace/personnel/Personnel.module.css: .saved > span > button:last-child',
  'workspace/personnel/Personnel.module.css: .tabs button',
  'workspace/personnel/Personnel.module.css: .week button',
  "workspace/personnel/Personnel.module.css: .week button[aria-pressed='true']",
  'workspace/statistics/Statistics.module.css: .blockActions button',
  'workspace/statistics/Statistics.module.css: .blockActions button:hover',
  'workspace/statistics/Statistics.module.css: .formatGrid button',
  "workspace/statistics/Statistics.module.css: .live .tabs button[aria-pressed='true']",
  'workspace/statistics/Statistics.module.css: .page button:focus-visible',
  'workspace/statistics/Statistics.module.css: .tabs button',
  'workspace/Workspace.module.css: .shell .row-actions button',
];

const BUTTON_PROPERTIES = ['border-radius', 'background', 'border', 'outline'];

const AWAITING_MIGRATION = new Set(BUTTON_RULES_AWAITING_MIGRATION);

const FORBIDDEN_LITERALS = ['white', '#fff', '#ffffff', '#fffdf9', '#fbf6ec', '#f4ebdc', '#e8dcc7'];

/**
 * Литералы, оставшиеся вне задачи #25: они не участвуют в сведении второй
 * палитры и перечислены явно, чтобы появление нового значения всё равно
 * ловилось.
 */
const FROZEN_LITERALS = [
  '#7a5c0d',
  '#97431f',
  '#c34d4d',
  'var(--color-status-neutral)',
  'var(--color-status-ok)',
  'var(--color-status-missing)',
  'rgb(255 255 255 / 94%)',
];

const TOKEN_PREFIXES = [
  '--color-',
  '--text-',
  '--font-',
  '--radius-',
  '--shadow-',
  '--space-',
  '--gap-',
  '--control-',
];

describe('контракт дизайн-системы', () => {
  it('находит CSS-модули', () => {
    expect(FILES.length).toBeGreaterThan(0);
  });

  it('не объявляет токены вне index.css', () => {
    const offenders: string[] = [];
    for (const file of FILES) {
      for (const match of file.css.matchAll(/^\s*(--[a-z0-9-]+)\s*:/gim)) {
        if (TOKEN_PREFIXES.some((prefix) => match[1].startsWith(prefix))) {
          offenders.push(`${file.path}: ${match[1]}`);
        }
      }
    }
    expect(offenders, `Токены объявляет только index.css:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('не красит кнопки в модулях', () => {
    const offenders: string[] = [];
    for (const file of FILES) {
      for (const rule of rules(file.css)) {
        for (const selector of rule.selector.split(',')) {
          const text = selector.trim();
          if (lastCompound(text).toLowerCase() !== 'button') continue;
          if (BUTTON_RULE_EXCEPTIONS.includes(text)) continue;
          if (AWAITING_MIGRATION.has(`${file.path}: ${text}`)) continue;
          for (const property of BUTTON_PROPERTIES) {
            if (new RegExp(`(?:^|[\\s;{])${property}\\s*:`, 'i').test(rule.body)) {
              offenders.push(`${file.path}: ${text} { ${property} }`);
            }
          }
        }
      }
    }
    expect(
      offenders,
      `Вид кнопок задаёт глобальный слой в index.css:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  it('не зашивает кремовые фоны литералами', () => {
    const offenders: string[] = [];
    for (const file of FILES) {
      const declarations =
        /(?:^|[\s;{])(background(?:-color)?|border(?:-[a-z]+)?-color)\s*:\s*([^;]+);/gim;
      for (const match of file.css.matchAll(declarations)) {
        const value = match[2].trim().toLowerCase();
        if (FROZEN_LITERALS.some((frozen) => value.includes(frozen))) continue;
        for (const literal of FORBIDDEN_LITERALS) {
          if (new RegExp(`(?:^|[\\s(,])${literal}(?:$|[\\s),;])`).test(value)) {
            offenders.push(`${file.path}: ${match[0].trim()}`);
            break;
          }
        }
      }
    }
    expect(offenders, `Фоны и границы берутся из токенов:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('держит компактный размер лендинга замороженным', () => {
    const body = ruleBody(INDEX_CSS, '.btn--sm');
    expect(body, '.btn--sm должен существовать в index.css').not.toBe('');
    expect(body).toContain('min-height: 42px');
    expect(body).toContain('padding: 0.5rem 1.125rem');
    expect(body).not.toMatch(/border-radius\s*:/);
    expect(body).not.toMatch(/font-size\s*:/);
  });

  it('держит компактный размер кабинета на 39px и радиусе 9px', () => {
    const body = ruleBody(INDEX_CSS, '.btn--compact');
    expect(body, '.btn--compact должен существовать в index.css').not.toBe('');
    expect(body).toContain('min-height: var(--control-h-md)');
    expect(body).toContain('border-radius: var(--radius-4xs)');
    expect(body).toContain('font-size: var(--text-xs)');
  });

  it('не пускает компактный размер кабинета на лендинг', () => {
    const offenders = LANDING_SCREENS.filter((path) =>
      readFileSync(join(SRC, path), 'utf8').includes('btn--compact'),
    );
    expect(
      offenders,
      `Лендинг и публичный прайс живут на .btn--sm, а не на размере кабинета:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });
});

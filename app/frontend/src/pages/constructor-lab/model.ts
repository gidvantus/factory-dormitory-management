export type BuilderId =
  | 'structure'
  | 'table'
  | 'columns'
  | 'formula'
  | 'link'
  | 'places'
  | 'personnel'
  | 'dashboard'
  | 'statistics'
  | 'arrivals'
  | 'workspace'
  | 'filters';

export interface Field {
  key: string;
  label: string;
  type?: 'text' | 'toggle';
  options?: string[];
  hint?: string;
  advanced?: boolean;
  when?: [string, string];
}
export interface Item {
  id: string;
  name: string;
  kind: string;
  enabled: boolean;
}
export interface Draft {
  values: Record<string, string | boolean>;
  items: Item[];
}
export interface Preset {
  name: string;
  description: string;
  values: Record<string, string | boolean>;
  items?: Item[];
}
export interface Builder {
  id: BuilderId;
  name: string;
  shortName: string;
  location: string;
  task: string;
  problem: string;
  improvement: string;
  fields: Field[];
  initial: Draft;
  presets: Preset[];
  collection?: string;
  sentence: string;
}

export const variants = [
  {
    id: 'steps',
    name: 'Пошаговый мастер',
    short: 'Один вопрос за раз',
    description: 'Ведём от задачи к проверке. На каждом шаге только нужные настройки.',
    benefit: 'Проще начать без обучения',
    tradeoff: 'Больше переходов при частых правках',
    best: 'Первое создание, сложные связи',
  },
  {
    id: 'split',
    name: 'Настройки + результат',
    short: 'Всё видно сразу',
    description:
      'Настройки слева, живой результат справа. Редкие параметры открываются по запросу.',
    benefit: 'Видно, на что влияет каждое действие',
    tradeoff: 'На телефоне результат находится ниже',
    best: 'Единый интерфейс для всех конструкторов',
  },
  {
    id: 'templates',
    name: 'Сначала готовый пример',
    short: 'Выбрать и поправить',
    description:
      'Начинаем с знакомой задачи. Готовый пример заполняет настройки, дальше их можно менять.',
    benefit: 'Пустая форма больше не мешает начать',
    tradeoff: 'Нужен небольшой каталог удачных примеров',
    best: 'Типовые таблицы, поля и показатели',
  },
  {
    id: 'sentence',
    name: 'Собрать как фразу',
    short: 'Настройки на языке задачи',
    description: 'Собираем правило из понятных частей. Сразу читаем, что именно получится.',
    benefit: 'Условия и связи легче проверить',
    tradeoff: 'Сложную структуру удобнее править в редакторе',
    best: 'Формулы, связи, расчёты',
  },
  {
    id: 'canvas',
    name: 'Править в результате',
    short: 'Выбрать и настроить',
    description:
      'Нажмите на название, содержимое или вид результата. Рядом откроются его настройки.',
    benefit: 'Не нужно искать нужное поле в длинной форме',
    tradeoff: 'Нужно ясно показывать, что можно изменить',
    best: 'Структура, столбцы, карточки и графики',
  },
] as const;
export type VariantId = (typeof variants)[number]['id'];

const items = (...names: string[]): Item[] =>
  names.map((name, index) => ({
    id: `item-${index}`,
    name,
    kind: name.includes('Дата') ? 'Дата' : name.includes('Сумма') ? 'Число' : 'Текст',
    enabled: true,
  }));
const nameField: Field = { key: 'name', label: 'Название', type: 'text' };

export const builders: Builder[] = [
  {
    id: 'structure',
    name: 'Структура общежития',
    shortName: 'Структура',
    location: 'Общежития / Настройки / Вкладки и таблицы',
    task: 'Оставить нужные разделы и собрать понятное меню общежития.',
    problem:
      'Вкладки, вложенность и столбцы настраиваются рядом. Трудно понять, какой уровень меняется.',
    improvement:
      'Сначала меню разделов, затем содержимое выбранной вкладки. Весь путь всегда виден.',
    fields: [
      nameField,
      {
        key: 'layout',
        label: 'Как расположить разделы',
        options: ['Общим списком', 'По рабочим задачам'],
      },
      { key: 'archived', label: 'Показывать архив в меню', type: 'toggle', advanced: true },
    ],
    initial: {
      values: { name: 'Северный', layout: 'По рабочим задачам', archived: false },
      items: items('Проживающие', 'Приток', 'Отток', 'На аванс', 'На расчёт', 'Общий отчёт'),
    },
    collection: 'Разделы в меню',
    sentence: 'Хочу организовать меню общежития',
    presets: [
      {
        name: 'Для коменданта',
        description: 'Проживание, движение и общий отчёт',
        values: { layout: 'По рабочим задачам' },
        items: items('Проживающие', 'Приток', 'Отток', 'Общий отчёт'),
      },
      {
        name: 'Для расчётов',
        description: 'Проживающие и списки выплат',
        values: { layout: 'Общим списком' },
        items: items('Проживающие', 'На аванс', 'На расчёт'),
      },
      {
        name: 'Все разделы',
        description: 'Полная структура общежития',
        values: { layout: 'По рабочим задачам' },
        items: items('Проживающие', 'Приток', 'Отток', 'На аванс', 'На расчёт', 'Общий отчёт'),
      },
    ],
  },
  {
    id: 'table',
    name: 'Вкладки и таблицы',
    shortName: 'Вкладки и таблицы',
    location: 'Общежития / Добавить вкладку / Создать таблицу',
    task: 'Создать свою таблицу, выбрать формат и работу с датами.',
    problem:
      'Разница между обычной таблицей и календарём становится понятна только после создания.',
    improvement: 'Показываем оба формата на примере и объясняем, откуда берётся период.',
    fields: [
      nameField,
      { key: 'format', label: 'Формат таблицы', options: ['Список записей', 'Дни в столбцах'] },
      {
        key: 'period',
        label: 'Показывать записи',
        options: ['За всё время', 'За месяц', 'За диапазон дат'],
        hint: 'Для списка период отбирает записи по столбцу «Дата».',
      },
      { key: 'addRow', label: 'Кнопка «Добавить строку»', type: 'toggle', advanced: true },
      { key: 'clear', label: 'Кнопка «Очистить список»', type: 'toggle', advanced: true },
    ],
    initial: {
      values: {
        name: 'Выдача спецодежды',
        format: 'Список записей',
        period: 'За месяц',
        addRow: true,
        clear: false,
      },
      items: items('ФИО', 'Дата', 'Комплект'),
    },
    collection: 'Столбцы или показатели',
    sentence: 'Хочу создать таблицу',
    presets: [
      {
        name: 'Выдача спецодежды',
        description: 'Список с датой выдачи и комплектом',
        values: { name: 'Выдача спецодежды', format: 'Список записей', period: 'За месяц' },
        items: items('ФИО', 'Дата', 'Комплект'),
      },
      {
        name: 'Учёт по дням',
        description: 'Показатели в строках, дни в столбцах',
        values: { name: 'Учёт по дням', format: 'Дни в столбцах', period: 'За месяц' },
        items: items('Выдано комплектов', 'Возвращено комплектов'),
      },
      {
        name: 'Свободный список',
        description: 'Все записи без выбора периода',
        values: { name: 'Мой список', format: 'Список записей', period: 'За всё время' },
        items: items('Название', 'Примечание'),
      },
    ],
  },
  {
    id: 'columns',
    name: 'Столбцы и типы данных',
    shortName: 'Столбцы',
    location: 'Любая таблица / Настроить столбцы',
    task: 'Добавить столбцы, выбрать тип и порядок, скрыть лишнее.',
    problem:
      'Название типа не объясняет, как будет выглядеть ячейка. Результат изменения порядка не виден.',
    improvement: 'Рядом с каждым типом — пример ячейки. Перестановка сразу отражается в таблице.',
    fields: [
      nameField,
      { key: 'types', label: 'Подписывать типы в примере', type: 'toggle', advanced: true },
    ],
    initial: {
      values: { name: 'Проживающие', types: true },
      items: items('ФИО', 'Дата заселения', 'Телефон'),
    },
    collection: 'Столбцы таблицы',
    sentence: 'Хочу настроить столбцы таблицы',
    presets: [
      {
        name: 'Контакты',
        description: 'ФИО, телефон и примечание',
        values: {},
        items: items('ФИО', 'Телефон', 'Примечание'),
      },
      {
        name: 'Документы',
        description: 'Название, срок и отметка о проверке',
        values: {},
        items: [
          { id: 'doc', name: 'Документ', kind: 'Текст', enabled: true },
          { id: 'date', name: 'Дата окончания', kind: 'Дата', enabled: true },
          { id: 'check', name: 'Проверен', kind: 'Чекбокс', enabled: true },
        ],
      },
      {
        name: 'Выплаты',
        description: 'Табельный номер, сумма и статус',
        values: {},
        items: [
          { id: 'num', name: 'Табельный номер', kind: 'Текст', enabled: true },
          { id: 'sum', name: 'Сумма', kind: 'Число', enabled: true },
          { id: 'status', name: 'Статус', kind: 'Список', enabled: true },
        ],
      },
    ],
  },
  {
    id: 'formula',
    name: 'Строки и формулы отчёта',
    shortName: 'Строки и формулы',
    location: 'Общежитие / Общий отчёт / Добавить строку',
    task: 'Выбрать ручной ввод или собрать формулу из существующих строк.',
    problem:
      'Синтаксис формулы нужно помнить. По названию строки не видно, верно ли работает расчёт.',
    improvement: 'Выбираем строки по названию, показываем формулу и расчёт на конкретную дату.',
    fields: [
      nameField,
      { key: 'mode', label: 'Как заполнять', options: ['Формулой', 'Вручную по дням'] },
      {
        key: 'left',
        label: 'Первая строка',
        options: ['Проживает', 'Прибыло', 'Выбыло'],
        when: ['mode', 'Формулой'],
      },
      {
        key: 'operator',
        label: 'Действие',
        options: ['Прибавить', 'Вычесть', 'Умножить', 'Разделить'],
        when: ['mode', 'Формулой'],
      },
      {
        key: 'right',
        label: 'Вторая строка',
        options: ['Прибыло', 'Выбыло', 'Проживает'],
        when: ['mode', 'Формулой'],
      },
    ],
    initial: {
      values: {
        name: 'Всего с учётом заезда',
        mode: 'Формулой',
        left: 'Проживает',
        operator: 'Прибавить',
        right: 'Прибыло',
      },
      items: [],
    },
    sentence: 'Хочу получать значение строки',
    presets: [
      {
        name: 'С учётом заезда',
        description: 'Проживает + Прибыло',
        values: {
          name: 'Всего с учётом заезда',
          mode: 'Формулой',
          left: 'Проживает',
          operator: 'Прибавить',
          right: 'Прибыло',
        },
      },
      {
        name: 'С учётом выезда',
        description: 'Проживает − Выбыло',
        values: {
          name: 'После выезда',
          mode: 'Формулой',
          left: 'Проживает',
          operator: 'Вычесть',
          right: 'Выбыло',
        },
      },
      {
        name: 'Ручной показатель',
        description: 'Отдельное значение на каждый день',
        values: { name: 'Замечания', mode: 'Вручную по дням' },
      },
    ],
  },
  {
    id: 'link',
    name: 'Связи отчёта с таблицами',
    shortName: 'Связи с таблицами',
    location: 'Общий отчёт / Строка / Связь с таблицей',
    task: 'Посчитать подходящие записи из таблицы и распределить их по датам.',
    problem: 'Легко перепутать условие отбора и дату, на которую попадёт запись.',
    improvement: 'Показываем цепочку «источник → условие → дата» и объясняем судьбу каждой записи.',
    fields: [
      nameField,
      { key: 'source', label: 'Откуда брать записи', options: ['Проживающие', 'Приток', 'Отток'] },
      {
        key: 'condition',
        label: 'Условие для статуса',
        options: ['Статус заполнен', 'Статус равен'],
      },
      {
        key: 'status',
        label: 'Какой статус',
        options: ['Оформлен', 'Ожидает'],
        when: ['condition', 'Статус равен'],
      },
      {
        key: 'date',
        label: 'Распределять по дате',
        options: ['Дате события', 'Дате создания записи'],
        hint: 'Запись без даты события не попадёт в расчёт по дате события.',
      },
    ],
    initial: {
      values: {
        name: 'Оформленные за день',
        source: 'Приток',
        condition: 'Статус равен',
        status: 'Оформлен',
        date: 'Дате события',
      },
      items: [],
    },
    sentence: 'Хочу считать записи для строки',
    presets: [
      {
        name: 'Оформленные',
        description: 'Приток со статусом «Оформлен» по дате события',
        values: {
          name: 'Оформленные за день',
          source: 'Приток',
          condition: 'Статус равен',
          status: 'Оформлен',
          date: 'Дате события',
        },
      },
      {
        name: 'Все со статусом',
        description: 'Проживающие с любым заполненным статусом',
        values: {
          name: 'Записи со статусом',
          source: 'Проживающие',
          condition: 'Статус заполнен',
          date: 'Дате создания записи',
        },
      },
      {
        name: 'Ожидающие',
        description: 'Приток со статусом «Ожидает»',
        values: {
          name: 'Ожидающие за день',
          source: 'Приток',
          condition: 'Статус равен',
          status: 'Ожидает',
          date: 'Дате события',
        },
      },
    ],
  },
  {
    id: 'places',
    name: 'Связи с размещением',
    shortName: 'Связи с размещением',
    location: 'Общий отчёт / Связь / Размещение персонала',
    task: 'Получать проживающих, оплаченные или свободные места из хостелов.',
    problem: 'Неочевидно, как считается итог и что означает выбор всех хостелов.',
    improvement: 'Показываем источник и расшифровку: оплачено минус проживает, за выбранный день.',
    fields: [
      nameField,
      { key: 'hostel', label: 'Какие хостелы', options: ['Все хостелы', 'Север', 'Восток'] },
      {
        key: 'metric',
        label: 'Какой показатель',
        options: ['Свободных мест', 'Проживает', 'Оплачено мест'],
      },
      {
        key: 'gender',
        label: 'Кого учитывать',
        options: ['Всех: М + Ж', 'Только М', 'Только Ж'],
        advanced: true,
      },
    ],
    initial: {
      values: {
        name: 'Свободные места',
        hostel: 'Все хостелы',
        metric: 'Свободных мест',
        gender: 'Всех: М + Ж',
      },
      items: [],
    },
    sentence: 'Хочу брать показатель для строки',
    presets: [
      {
        name: 'Свободные места',
        description: 'Оплачено минус проживает по всем хостелам',
        values: {
          name: 'Свободные места',
          hostel: 'Все хостелы',
          metric: 'Свободных мест',
          gender: 'Всех: М + Ж',
        },
      },
      {
        name: 'Проживающие на Севере',
        description: 'Численность М + Ж за каждый день',
        values: {
          name: 'Проживает на Севере',
          hostel: 'Север',
          metric: 'Проживает',
          gender: 'Всех: М + Ж',
        },
      },
      {
        name: 'Оплаченные места',
        description: 'Места для женщин по всем хостелам',
        values: {
          name: 'Оплачено мест Ж',
          hostel: 'Все хостелы',
          metric: 'Оплачено мест',
          gender: 'Только Ж',
        },
      },
    ],
  },
  {
    id: 'personnel',
    name: 'Связь с персоналом',
    shortName: 'Связь с персоналом',
    location: 'Настройки общежития / Связь таблицы с персоналом',
    task: 'Сопоставить столбцы таблицы с данными карточки сотрудника.',
    problem: 'После выбора столбца не видно, какие сведения появятся в карточке.',
    improvement:
      'Слева источник, справа назначение. Пример карточки показывает результат сопоставления.',
    fields: [
      nameField,
      {
        key: 'fullName',
        label: 'ФИО сотрудника брать из',
        options: ['ФИО', 'Имя сотрудника', 'Не использовать'],
      },
      {
        key: 'number',
        label: 'Табельный номер брать из',
        options: ['Табельный номер', 'Не использовать'],
      },
      {
        key: 'phone',
        label: 'Телефон брать из',
        options: ['Телефон', 'Контактный номер', 'Не использовать'],
      },
      {
        key: 'shift',
        label: 'Начало вахты брать из',
        options: ['Дата начала', 'Не использовать'],
        advanced: true,
      },
    ],
    initial: {
      values: {
        name: 'Проживающие',
        fullName: 'ФИО',
        number: 'Табельный номер',
        phone: 'Телефон',
        shift: 'Не использовать',
      },
      items: [],
    },
    sentence: 'Хочу связать таблицу с карточкой сотрудника',
    presets: [
      {
        name: 'Базовая карточка',
        description: 'ФИО и табельный номер',
        values: {
          fullName: 'ФИО',
          number: 'Табельный номер',
          phone: 'Не использовать',
          shift: 'Не использовать',
        },
      },
      {
        name: 'С контактами',
        description: 'ФИО, номер и телефон',
        values: {
          fullName: 'ФИО',
          number: 'Табельный номер',
          phone: 'Телефон',
          shift: 'Не использовать',
        },
      },
      {
        name: 'С данными вахты',
        description: 'Контакты и дата начала вахты',
        values: {
          fullName: 'Имя сотрудника',
          number: 'Табельный номер',
          phone: 'Контактный номер',
          shift: 'Дата начала',
        },
      },
    ],
  },
  {
    id: 'dashboard',
    name: 'Блоки дашборда',
    shortName: 'Блоки дашборда',
    location: 'Обзор / Добавить блок статистики',
    task: 'Вывести нужный показатель числом, списком или графиком.',
    problem: 'Срез на дату и сумма за период выглядят похожими настройками, но дают разный смысл.',
    improvement:
      'Сначала задача и показатель, затем вид. Под итогом всегда написано, за что посчитано.',
    fields: [
      nameField,
      {
        key: 'source',
        label: 'Что показывать',
        options: ['Проживающие', 'План заездов', 'Свободные места'],
      },
      { key: 'display', label: 'Как показывать', options: ['Число', 'Список', 'График'] },
      {
        key: 'period',
        label: 'Когда считать',
        options: ['На последнюю дату', 'За весь период'],
        hint: 'Для численности обычно нужен срез на дату. Сумма за период складывает дневные значения.',
      },
      {
        key: 'scope',
        label: 'Какие общежития',
        options: ['Все общежития', 'Только Северный'],
        advanced: true,
      },
    ],
    initial: {
      values: {
        name: 'Проживает сейчас',
        source: 'Проживающие',
        display: 'Число',
        period: 'На последнюю дату',
        scope: 'Все общежития',
      },
      items: [],
    },
    sentence: 'Хочу видеть на обзоре',
    presets: [
      {
        name: 'Проживает сейчас',
        description: 'Число на последнюю дату периода',
        values: {
          name: 'Проживает сейчас',
          source: 'Проживающие',
          display: 'Число',
          period: 'На последнюю дату',
        },
      },
      {
        name: 'План заездов',
        description: 'Заезды за неделю по общежитиям',
        values: {
          name: 'План заездов',
          source: 'План заездов',
          display: 'Список',
          period: 'За весь период',
        },
      },
      {
        name: 'Динамика свободных мест',
        description: 'График за выбранный период',
        values: {
          name: 'Свободные места',
          source: 'Свободные места',
          display: 'График',
          period: 'На последнюю дату',
        },
      },
    ],
  },
  {
    id: 'statistics',
    name: 'Отчёты статистики',
    shortName: 'Статистика',
    location: 'Статистика / Отчёт / Конструктор блока',
    task: 'Выбрать данные, расчёт и представление для блока отчёта.',
    problem:
      'Источник, итог периода, группировка и вид графика требуют много решений одновременно.',
    improvement:
      'Разделяем «что считаем» и «как показываем», объясняем итог и сразу обновляем график.',
    fields: [
      nameField,
      {
        key: 'source',
        label: 'Что считать',
        options: ['Проживающие', 'План заездов', 'Свободные места'],
      },
      {
        key: 'display',
        label: 'Как показывать',
        options: ['Столбцы', 'Линия', 'Области', 'Круговая', 'Таблица', 'Число'],
      },
      { key: 'group', label: 'Сравнивать', options: ['Общежития', 'Дни'] },
      {
        key: 'aggregate',
        label: 'Итог за период',
        options: ['Последнее значение', 'Сумма за период', 'Среднее за день', 'Максимум'],
        advanced: true,
        hint: 'Для проживающих рекомендуем последнее значение, для заездов — сумму.',
      },
    ],
    initial: {
      values: {
        name: 'Проживающие по общежитиям',
        source: 'Проживающие',
        display: 'Столбцы',
        group: 'Общежития',
        aggregate: 'Последнее значение',
      },
      items: [],
    },
    sentence: 'Хочу получить в отчёте',
    presets: [
      {
        name: 'Проживающие по общежитиям',
        description: 'Сравнение численности на последнюю дату',
        values: {
          name: 'Проживающие по общежитиям',
          source: 'Проживающие',
          display: 'Столбцы',
          group: 'Общежития',
          aggregate: 'Последнее значение',
        },
      },
      {
        name: 'Динамика свободных мест',
        description: 'Линия по дням, итог — последнее значение',
        values: {
          name: 'Свободные места по дням',
          source: 'Свободные места',
          display: 'Линия',
          group: 'Дни',
          aggregate: 'Последнее значение',
        },
      },
      {
        name: 'Заезды за неделю',
        description: 'Сумма заездов в каждом общежитии',
        values: {
          name: 'Заезды за неделю',
          source: 'План заездов',
          display: 'Таблица',
          group: 'Общежития',
          aggregate: 'Сумма за период',
        },
      },
    ],
  },
  {
    id: 'arrivals',
    name: 'Поля и карточки заездов',
    shortName: 'План заездов',
    location: 'Персонал / План заездов / Настройки',
    task: 'Добавить поле в форму заезда и выбрать содержимое правой панели.',
    problem:
      'Поле для всего заезда и поле для каждого человека могут быть перепутаны. Настройка карточки находится отдельно.',
    improvement: 'На одном примере видно, где заполнять поле и где оно появится после сохранения.',
    fields: [
      nameField,
      { key: 'type', label: 'Тип поля', options: ['Число', 'Текст', 'Дата', 'Список', 'Чекбокс'] },
      {
        key: 'scope',
        label: 'Кто заполняет значение',
        options: ['Отдельно для каждого человека', 'Одно на весь заезд'],
      },
      { key: 'required', label: 'Обязательное поле', type: 'toggle' },
      { key: 'card', label: 'Показывать поле в карточке заезда', type: 'toggle' },
      {
        key: 'empty',
        label: 'Показывать незаполненные поля в карточке',
        type: 'toggle',
        advanced: true,
      },
    ],
    initial: {
      values: {
        name: 'Количество смен',
        type: 'Число',
        scope: 'Отдельно для каждого человека',
        required: false,
        card: true,
        empty: false,
      },
      items: [],
    },
    sentence: 'Хочу добавить в план заездов поле',
    presets: [
      {
        name: 'Смены каждого человека',
        description: 'Числовое поле рядом с каждым ФИО',
        values: {
          name: 'Количество смен',
          type: 'Число',
          scope: 'Отдельно для каждого человека',
          required: true,
          card: true,
        },
      },
      {
        name: 'Контакт сопровождающего',
        description: 'Одно текстовое поле на весь заезд',
        values: {
          name: 'Телефон сопровождающего',
          type: 'Текст',
          scope: 'Одно на весь заезд',
          required: false,
          card: true,
        },
      },
      {
        name: 'Проверка документов',
        description: 'Отметка для каждого человека',
        values: {
          name: 'Документы проверены',
          type: 'Чекбокс',
          scope: 'Отдельно для каждого человека',
          required: false,
          card: true,
        },
      },
    ],
  },
];

builders.push(
  {
    id: 'workspace',
    name: 'Блоки рабочей поверхности',
    shortName: 'Блоки персонала',
    location: 'Персонал / Рабочая поверхность / Добавить блок',
    task: 'Собрать личный блок с сотрудниками, контактами, заездами или сохранённым списком.',
    problem: 'Содержимое, период, число строк и ширина выбираются без примера будущего блока.',
    improvement:
      'Сразу показываем карточку на поверхности: кого она включает, сколько строк видно и сколько места занимает.',
    fields: [
      nameField,
      {
        key: 'kind',
        label: 'Содержимое блока',
        options: [
          'Проживающие',
          'Завершают вахту',
          'Контакты',
          'План заездов',
          'Сохранённый список',
        ],
      },
      { key: 'days', label: 'На сколько дней вперёд', options: ['3', '7', '14'] },
      {
        key: 'savedList',
        label: 'Какой сохранённый список',
        options: ['Завершают вахту за 7 дней', 'Без телефона'],
        when: ['kind', 'Сохранённый список'],
      },
      { key: 'scope', label: 'Какие общежития', options: ['Все общежития', 'Только Северный'] },
      { key: 'limit', label: 'Сколько строк показывать', options: ['1', '3', '5'], advanced: true },
      { key: 'wide', label: 'Блок на всю ширину', type: 'toggle', advanced: true },
    ],
    initial: {
      values: {
        name: 'Скоро заканчивается вахта',
        kind: 'Завершают вахту',
        days: '7',
        scope: 'Все общежития',
        limit: '3',
        wide: false,
        savedList: 'Завершают вахту за 7 дней',
      },
      items: [],
    },
    sentence: 'Хочу видеть на рабочей поверхности персонала',
    presets: [
      {
        name: 'Завершают вахту',
        description: 'Ближайшие 7 дней, до трёх сотрудников',
        values: {
          name: 'Скоро заканчивается вахта',
          kind: 'Завершают вахту',
          days: '7',
          limit: '3',
          wide: false,
        },
      },
      {
        name: 'Контакты Северного',
        description: 'Сотрудники одного общежития на всю ширину',
        values: {
          name: 'Контакты Северного',
          kind: 'Контакты',
          scope: 'Только Северный',
          limit: '5',
          wide: true,
        },
      },
      {
        name: 'Ближайшие заезды',
        description: 'Планы на следующие 14 дней',
        values: {
          name: 'Ближайшие заезды',
          kind: 'План заездов',
          days: '14',
          scope: 'Все общежития',
          limit: '5',
          wide: true,
        },
      },
    ],
  },
  {
    id: 'filters',
    name: 'Свои списки и фильтры',
    shortName: 'Списки персонала',
    location: 'Персонал / Сотрудники / Фильтры / Сохранить список',
    task: 'Собрать условия отбора сотрудников и сохранить список для повторного использования.',
    problem:
      'Несколько условий можно настроить, но итоговый смысл отбора приходится держать в голове.',
    improvement:
      'Проговариваем все условия вместе, показываем найденных сотрудников и объясняем закрепление списка.',
    fields: [
      nameField,
      {
        key: 'status',
        label: 'Кого искать',
        options: ['Все сотрудники', 'Проживают', 'Завершают вахту'],
      },
      {
        key: 'days',
        label: 'Вахта заканчивается в течение дней',
        options: ['3', '7', '14'],
        when: ['status', 'Завершают вахту'],
      },
      { key: 'scope', label: 'Какие общежития', options: ['Все общежития', 'Только Северный'] },
      { key: 'column', label: 'Проверить поле', options: ['Телефон', 'Общежитие'] },
      {
        key: 'condition',
        label: 'Условие',
        options: ['Не заполнено', 'Заполнено', 'Равно', 'Содержит'],
      },
      { key: 'value', label: 'Значение условия', type: 'text' },
      {
        key: 'pin',
        label: 'Закрепить списком на рабочей поверхности',
        type: 'toggle',
        advanced: true,
      },
    ],
    initial: {
      values: {
        name: 'Нужно уточнить телефон',
        status: 'Проживают',
        days: '7',
        scope: 'Все общежития',
        column: 'Телефон',
        condition: 'Не заполнено',
        value: 'Северный',
        pin: true,
      },
      items: [],
    },
    sentence: 'Хочу сохранить список сотрудников',
    presets: [
      {
        name: 'Без телефона',
        description: 'Проживающие с незаполненным телефоном',
        values: {
          name: 'Нужно уточнить телефон',
          status: 'Проживают',
          column: 'Телефон',
          condition: 'Не заполнено',
          scope: 'Все общежития',
        },
      },
      {
        name: 'Пора связаться',
        description: 'Вахта заканчивается за 7 дней, телефон указан',
        values: {
          name: 'Пора связаться',
          status: 'Завершают вахту',
          days: '7',
          column: 'Телефон',
          condition: 'Заполнено',
          scope: 'Все общежития',
        },
      },
      {
        name: 'Люди Северного',
        description: 'Проживающие в выбранном общежитии',
        values: {
          name: 'Люди Северного',
          status: 'Проживают',
          column: 'Общежитие',
          condition: 'Равно',
          value: 'Северный',
          scope: 'Все общежития',
        },
      },
    ],
  },
);

export function applyPreset(draft: Draft, preset: Preset): Draft {
  return { values: { ...draft.values, ...preset.values }, items: preset.items ?? draft.items };
}

export function visibleFields(builder: Builder, draft: Draft): Field[] {
  return builder.fields.filter(
    (field) =>
      (!field.when || draft.values[field.when[0]] === field.when[1]) &&
      !(
        builder.id === 'dashboard' &&
        draft.values.display === 'График' &&
        field.key === 'period'
      ) &&
      !(
        builder.id === 'workspace' &&
        !['Завершают вахту', 'План заездов'].includes(String(draft.values.kind)) &&
        field.key === 'days'
      ) &&
      !(
        builder.id === 'filters' &&
        !['Равно', 'Содержит'].includes(String(draft.values.condition)) &&
        field.key === 'value'
      ),
  );
}

export function validate(builder: Builder, draft: Draft): string[] {
  const errors: string[] = [];
  if (!String(draft.values.name).trim()) errors.push('Укажите название — его увидят коллеги.');
  if (builder.collection) {
    const active = draft.items.filter((item) => item.enabled);
    if (!active.length) errors.push('Оставьте хотя бы один видимый элемент.');
    if (active.some((item) => !item.name.trim()))
      errors.push('Заполните названия видимых элементов.');
    const names = active.map((item) =>
      item.name.trim().replace(/\s+/g, ' ').toLocaleLowerCase('ru'),
    );
    if (new Set(names).size !== names.length)
      errors.push('Названия видимых элементов не должны повторяться.');
  }
  if (
    builder.id === 'table' &&
    draft.values.format === 'Дни в столбцах' &&
    draft.values.period === 'За всё время'
  )
    errors.push('Для таблицы с днями выберите месяц или диапазон дат.');
  if (
    builder.id === 'table' &&
    draft.values.format === 'Список записей' &&
    draft.values.period !== 'За всё время' &&
    !draft.items.some((item) => item.enabled && item.kind === 'Дата')
  )
    errors.push('Добавьте видимый столбец типа «Дата» для отбора записей за период.');
  if (builder.id === 'personnel' && draft.values.fullName === 'Не использовать')
    errors.push('Выберите столбец ФИО, чтобы связать запись с сотрудником.');
  if (
    builder.id === 'filters' &&
    ['Равно', 'Содержит'].includes(String(draft.values.condition)) &&
    !String(draft.values.value).trim()
  )
    errors.push('Укажите значение для выбранного условия.');
  if (
    builder.id === 'formula' &&
    draft.values.mode === 'Формулой' &&
    formulaData(draft).values.some((value) => !Number.isFinite(value))
  )
    errors.push('В примере получается деление на ноль. Измените действие или вторую строку.');
  return errors;
}

export const demoDays = [
  '25 окт.',
  '26 окт.',
  '27 окт.',
  '28 окт.',
  '29 окт.',
  '30 окт.',
  '31 окт.',
];
export const demoDorms = ['Северный', 'Заводской', 'Речной'];
const series: Record<string, number[][]> = {
  Проживающие: [
    [110, 113, 112, 118, 120, 122, 124],
    [83, 85, 86, 86, 89, 91, 92],
    [61, 62, 61, 63, 64, 66, 68],
  ],
  'План заездов': [
    [3, 5, 0, 8, 2, 4, 6],
    [2, 1, 4, 0, 3, 2, 1],
    [0, 2, 1, 3, 0, 1, 2],
  ],
  'Свободные места': [
    [30, 27, 28, 22, 20, 18, 16],
    [27, 25, 24, 24, 21, 19, 18],
    [19, 18, 19, 17, 16, 14, 12],
  ],
};
export function aggregate(values: number[], mode: string): number {
  if (mode === 'Сумма за период' || mode === 'За весь период')
    return values.reduce((a, b) => a + b, 0);
  if (mode === 'Среднее за день') return values.reduce((a, b) => a + b, 0) / values.length;
  if (mode === 'Максимум') return Math.max(...values);
  return values[values.length - 1];
}
export function chartData(draft: Draft): { label: string; value: number }[] {
  const rows = (series[String(draft.values.source)] ?? series['Проживающие']).filter(
    (_, index) => draft.values.scope !== 'Только Северный' || index === 0,
  );
  if (draft.values.group === 'Дни' || draft.values.display === 'График')
    return demoDays.map((label, index) => ({
      label,
      value: rows.reduce((sum, row) => sum + row[index], 0),
    }));
  return rows.map((row, index) => ({
    label: demoDorms[index],
    value: aggregate(row, String(draft.values.aggregate ?? draft.values.period)),
  }));
}
export function formulaData(draft: Draft): { expression: string; values: number[] } {
  const rows: Record<string, number[]> = {
    Проживает: [120, 122, 124],
    Прибыло: [2, 4, 6],
    Выбыло: [1, 2, 0],
  };
  const operators: Record<string, string> = {
    Прибавить: '+',
    Вычесть: '−',
    Умножить: '×',
    Разделить: '÷',
  };
  const left = rows[String(draft.values.left)];
  const right = rows[String(draft.values.right)];
  return {
    expression: `=[${draft.values.left}] ${operators[String(draft.values.operator)]} [${draft.values.right}]`,
    values: left.map((value, index) =>
      draft.values.operator === 'Вычесть'
        ? value - right[index]
        : draft.values.operator === 'Умножить'
          ? value * right[index]
          : draft.values.operator === 'Разделить'
            ? right[index] === 0
              ? NaN
              : value / right[index]
            : value + right[index],
    ),
  };
}

export function summary(builder: Builder, draft: Draft): string {
  const v = draft.values;
  switch (builder.id) {
    case 'workspace':
      return `Блок «${v.name}»: ${String(v.kind).toLocaleLowerCase('ru')}${['Завершают вахту', 'План заездов'].includes(String(v.kind)) ? `, на ${v.days} дней вперёд` : v.kind === 'Сохранённый список' ? ` «${v.savedList}»` : ''}. ${v.scope}. До ${v.limit} строк. ${v.wide ? 'На всю ширину.' : 'Половина ширины.'}`;
    case 'filters':
      return `Список «${v.name}»: ${String(v.status).toLocaleLowerCase('ru')}${v.status === 'Завершают вахту' ? ` за ${v.days} дней` : ''}, ${String(v.scope).toLocaleLowerCase('ru')}. Поле «${v.column}» ${String(v.condition).toLocaleLowerCase('ru')}${['Равно', 'Содержит'].includes(String(v.condition)) ? ` «${v.value}»` : ''}. ${v.pin ? 'Закреплён на рабочей поверхности.' : 'Доступен в моих списках.'}`;
    case 'structure':
      return `Меню «${v.name}»: ${draft.items.filter((item) => item.enabled).length} разделов. ${v.layout}.${v.archived ? ' Архив виден.' : ''}`;
    case 'table':
      return `«${v.name}»: ${String(v.format).toLocaleLowerCase('ru')}, ${String(v.period).toLocaleLowerCase('ru')}. ${draft.items.filter((item) => item.enabled).length} видимых элементов.`;
    case 'columns':
      return `В таблице «${v.name}» будет ${draft.items.filter((item) => item.enabled).length} видимых столбцов в выбранном порядке.`;
    case 'formula':
      return v.mode === 'Вручную по дням'
        ? `«${v.name}» заполняется вручную для каждого дня.`
        : `«${v.name}» = ${v.left} ${String(v.operator).toLocaleLowerCase('ru')} ${v.right}. Расчёт отдельно для каждого дня.`;
    case 'link':
      return `Считать записи из «${v.source}», где ${v.condition === 'Статус заполнен' ? 'статус заполнен' : `статус «${v.status}»`}. Распределять по ${String(v.date).toLocaleLowerCase('ru')}.`;
    case 'places':
      return `Брать «${v.metric}» из ${v.hostel === 'Все хостелы' ? 'всех хостелов' : `хостела «${v.hostel}»`}, ${String(v.gender).toLocaleLowerCase('ru')}. За каждый день отдельно.`;
    case 'personnel':
      return `Связать «${v.name}» с персоналом: ФИО из «${v.fullName}»${v.phone !== 'Не использовать' ? `, телефон из «${v.phone}»` : ''}.`;
    case 'dashboard':
      return `Показать «${v.source}»: ${String(v.display).toLocaleLowerCase('ru')}, ${v.display === 'График' ? 'по дням' : String(v.period).toLocaleLowerCase('ru')}. ${v.scope}.`;
    case 'statistics':
      return `«${v.source}»: ${String(v.display).toLocaleLowerCase('ru')}, сравниваем ${String(v.group).toLocaleLowerCase('ru')}. Итог: ${String(v.aggregate).toLocaleLowerCase('ru')}.`;
    case 'arrivals':
      return `Поле «${v.name}», ${String(v.type).toLocaleLowerCase('ru')}, ${String(v.scope).toLocaleLowerCase('ru')}. ${v.required ? 'Обязательное.' : 'Необязательное.'} ${v.card ? 'Видно в карточке.' : 'Только в форме.'}`;
  }
}

export const employeeExamples = [
  { name: 'Иванов Алексей', dorm: 'Северный', days: 2, phone: '+7 (900) 000-00-01', current: true },
  { name: 'Петрова Анна', dorm: 'Северный', days: 6, phone: '', current: true },
  { name: 'Соколов Игорь', dorm: 'Речной', days: 12, phone: '+7 (900) 000-00-03', current: true },
  { name: 'Орлова Елена', dorm: 'Заводской', days: 4, phone: '+7 (900) 000-00-04', current: true },
  { name: 'Морозов Павел', dorm: 'Северный', days: 0, phone: '', current: false },
];

export function employeeMatches(draft: Draft, workspace = false): typeof employeeExamples {
  const v = draft.values;
  return employeeExamples.filter((person) => {
    if (v.scope === 'Только Северный' && person.dorm !== 'Северный') return false;
    if (workspace) {
      if (!person.current) return false;
      if (v.kind === 'Завершают вахту') return person.days <= Number(v.days);
      if (v.kind === 'Сохранённый список')
        return v.savedList === 'Без телефона' ? !person.phone : person.days <= 7;
      return true;
    }
    if (v.status !== 'Все сотрудники' && !person.current) return false;
    if (v.status === 'Завершают вахту' && person.days > Number(v.days)) return false;
    const actual = v.column === 'Телефон' ? person.phone : person.dorm;
    if (v.condition === 'Не заполнено') return !actual;
    if (v.condition === 'Заполнено') return Boolean(actual);
    const expected = String(v.value).trim().toLocaleLowerCase('ru');
    return v.condition === 'Равно'
      ? actual.toLocaleLowerCase('ru') === expected
      : actual.toLocaleLowerCase('ru').includes(expected);
  });
}

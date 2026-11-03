import { useContext } from 'react';
import { LivePreview } from '../constructor-sandbox/Preview';
import type { Scene } from '../constructor-sandbox/inventory';
import { WindowDraftContext } from './WindowDraftContext';
import s from './Windows.module.css';

const previewScenes: Record<string, Scene> = {
  column: 'columns',
  'create-tab': 'create-tab',
  'create-table': 'create-table',
  binding: 'binding',
  'dashboard-block': 'dashboard',
  'report-row': 'formula',
};

const guides: Record<string, { text: string; preview?: string; kind?: string }> = {
  'report-row-modal': {
    text: 'Выберите способ заполнения строки. Настройка применяется ко всем датам отчёта.',
    preview: 'Проверить результат на примере',
    kind: 'report-row',
  },
  'column-editor-modal': {
    text: 'Укажите название и формат данных. Тип столбца сохраняется после создания.',
    preview: 'Посмотреть пример ячеек',
    kind: 'column',
  },
  'manage-columns-modal': {
    text: 'Настройте названия и порядок столбцов. Удалённые столбцы можно вернуть вместе с данными.',
  },
  'create-custom-tab-modal': {
    text: 'Создайте пустую вкладку или возьмите структуру из другого общежития. Записи образца не копируются.',
    preview: 'Посмотреть состав вкладки',
    kind: 'create-tab',
  },
  'create-table-modal': {
    text: 'Добавьте нужные столбцы. Варианты выпадающих списков настраиваются здесь же.',
    preview: 'Посмотреть будущую таблицу',
    kind: 'create-table',
  },
  'personnel-binding': {
    text: 'Сопоставьте столбцы таблицы с карточкой сотрудника. Ненужные назначения можно оставить пустыми.',
    preview: 'Проверить сопоставление',
    kind: 'binding',
  },
  'dashboard-widget-dialog': {
    text: 'Задайте вид блока, источник и общежития. Перед сохранением можно проверить расчёт.',
    preview: 'Посмотреть результат расчёта',
    kind: 'dashboard-block',
  },
  'personnel-block-editor': {
    text: 'Выберите содержимое блока, общежития и количество строк. Блок появится на рабочей поверхности.',
  },
  'personnel-save-list': {
    text: 'Сохраните текущие условия под понятным названием. Список можно сразу закрепить отдельным блоком.',
  },
  'save-report-template-modal': {
    text: 'Сохраняются названия строк, формулы и связи. Ежедневные значения в шаблон не входят.',
  },
};

export function WindowIntro({
  editorId,
  showPreview = true,
}: {
  editorId: string;
  showPreview?: boolean;
}): JSX.Element | null {
  const context = useContext(WindowDraftContext);
  const guide = guides[editorId];
  if (!guide || !context) return null;
  const available = guide.kind === context.snapshot?.kind;
  return (
    <div className={s.intro}>
      <p>{guide.text}</p>
      {showPreview && guide.preview && available && (
        <details className={s.draftPreview}>
          <summary>{guide.preview}</summary>
          <div>
            <span className={s.exampleLabel}>Пример на тестовых данных · 29–31 октября</span>
            <LivePreview
              store={context.store}
              dorm={context.dorm}
              table={context.table}
              scene={previewScenes[guide.kind ?? ''] ?? 'formula'}
              snapshot={context.snapshot}
              form={context.form}
              rowId={
                context.snapshot?.kind === 'report-row'
                  ? (context.snapshot.value as { rowId: number | null }).rowId
                  : null
              }
            />
          </div>
        </details>
      )}
    </div>
  );
}

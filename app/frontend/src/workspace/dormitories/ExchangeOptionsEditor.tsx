import type { ExchangeOptions } from '../../api/client';
import { EditorSection } from '../../components/EditorSection';
import styles from './CustomTabOptionsEditor.module.css';

export function ExchangeOptionsEditor({
  value,
  onChange,
  disabled = false,
  history = false,
}: {
  value: ExchangeOptions;
  onChange: (value: ExchangeOptions) => void;
  disabled?: boolean;
  history?: boolean;
}): JSX.Element {
  return (
    <EditorSection title="Импорт и экспорт" description="Обмен данными этой таблицы с Excel.">
      <fieldset disabled={disabled} className={styles.editor}>
        <legend>Доступные действия с Excel</legend>
        <div className={styles.checks}>
          {!history && (
            <label>
              <input
                type="checkbox"
                checked={value.import_enabled ?? true}
                onChange={(event) => onChange({ ...value, import_enabled: event.target.checked })}
              />
              Импорт данных по шаблону
            </label>
          )}
          <label>
            <input
              type="checkbox"
              checked={value.export_enabled ?? true}
              onChange={(event) => onChange({ ...value, export_enabled: event.target.checked })}
            />
            Экспорт данных в Excel
          </label>
        </div>
        <p className={styles.hint}>
          {history
            ? 'История действий заполняется автоматически. Доступна выгрузка записей.'
            : 'Шаблон автоматически учитывает текущие столбцы. Импорт добавляет строки, а в отчёте и размещении заполняет пустые ячейки.'}
        </p>
      </fieldset>
    </EditorSection>
  );
}

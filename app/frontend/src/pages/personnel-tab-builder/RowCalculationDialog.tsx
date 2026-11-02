import { useContext, useState } from 'react';
import type { PersonnelData } from '../../api/personnel';
import { Modal, ModalCancelButton } from '../../components/Modal';
import type { PersonnelTab, RecordRow } from './model';
import { manualRule } from './calculationTypes';
import { referenceTargets, rowTitle, validateCalculations } from './calculations';
import { CalculationFields } from './CalculationFields';
import s from './Tabs.module.css';
import { BuilderEnvironmentContext } from './BuilderEnvironment';
import { useCalculationPreview } from './useCalculationEngine';

export function RowCalculationDialog({
  tab,
  tabs,
  row,
  data,
  onClose,
  onSave,
}: {
  tab: PersonnelTab;
  tabs: PersonnelTab[];
  row: RecordRow;
  data: PersonnelData;
  onClose: () => void;
  onSave: (row: RecordRow) => void;
}): JSX.Element {
  const [initial] = useState<RecordRow>(() => ({
    ...structuredClone(row),
    id: row.id || crypto.randomUUID(),
    name: row.id ? rowTitle(tab, row, data) : '',
    rule: row.rule ?? { ...manualRule(), mode: row.id ? 'manual' : 'formula' },
    includeInTotals: row.includeInTotals ?? !!row.id,
  }));
  const [draft, setDraft] = useState(initial);
  const environment = useContext(BuilderEnvironmentContext);
  const evaluate = useCalculationPreview();
  const [date, setDate] = useState(data.today);
  const [error, setError] = useState('');
  const candidate = {
    ...tab,
    rows: row.id
      ? tab.rows.map((item) => (item.id === row.id ? draft : item))
      : [...tab.rows, draft],
  };
  const candidates = [...tabs.filter((item) => item.id !== tab.id), candidate];
  return (
    <Modal
      title={row.id ? 'Настроить строку' : 'Добавить расчётную строку'}
      testId="row-calculation-editor"
      onClose={onClose}
      dirty={JSON.stringify(draft) !== JSON.stringify(initial)}
      panelClassName={s.recordModal}
    >
      <form
        className={s.recordForm}
        onSubmit={(event) => {
          event.preventDefault();
          if (!draft.name?.trim()) {
            setError('Укажите название строки.');
            return;
          }
          if (
            tab.rows.some(
              (item) =>
                item.id !== draft.id &&
                rowTitle(tab, item, data).toLocaleLowerCase('ru') ===
                  draft.name!.trim().toLocaleLowerCase('ru'),
            )
          ) {
            setError('Название строки должно отличаться от других строк.');
            return;
          }
          const message = validateCalculations(candidates, data, environment?.sources);
          if (message) {
            setError(message);
            return;
          }
          const first = tab.columns.find((column) => !column.archived && column.kind === 'text');
          onSave({
            ...draft,
            name: draft.name.trim(),
            values: first ? { ...draft.values, [first.id]: draft.name.trim() } : draft.values,
          });
        }}
      >
        <label>
          Название строки
          <input
            required
            maxLength={100}
            value={draft.name}
            onChange={(event) => {
              setDraft({ ...draft, name: event.target.value });
              setError('');
            }}
          />
        </label>
        <CalculationFields
          key={date}
          rule={draft.rule!}
          targets={referenceTargets(candidate, 'row', data)}
          currentId={draft.id}
          axis="row"
          tab={candidate}
          tabs={candidates}
          data={data}
          onChange={(rule) => {
            setDraft({ ...draft, rule });
            setError('');
          }}
          onPreview={() =>
            evaluate(candidates, data, { tabId: tab.id, rowId: draft.id, day: date }, { day: date })
          }
        />
        <label>
          Дата для проверки
          <input
            type="date"
            required
            value={date}
            onChange={(event) => setDate(event.target.value)}
          />
        </label>
        <label className={s.check}>
          <input
            type="checkbox"
            checked={draft.includeInTotals !== false}
            onChange={(event) => setDraft({ ...draft, includeInTotals: event.target.checked })}
          />
          Учитывать в общем итоге таблицы
        </label>
        <small className={s.muted}>
          Ручные дневные значения сохраняются при переключении на формулу или связь. Формулы
          используют строки по их постоянным ссылкам, поэтому переименование и перестановка не
          нарушают расчёт.
        </small>
        {error && (
          <p role="alert" className={s.error}>
            {error}
          </p>
        )}
        <div className="dialog-actions">
          <ModalCancelButton className="btn btn--ghost btn--compact" onClick={onClose}>
            Отмена
          </ModalCancelButton>
          <button className="btn btn--primary btn--compact" type="submit">
            Сохранить строку
          </button>
        </div>
      </form>
    </Modal>
  );
}

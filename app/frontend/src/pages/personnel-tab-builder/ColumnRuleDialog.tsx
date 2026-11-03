import { useContext, useState } from 'react';
import type { PersonnelData } from '../../api/personnel';
import { Modal, ModalCancelButton } from '../../components/Modal';
import { CalculationFields } from './CalculationFields';
import { manualRule } from './calculationTypes';
import { referenceTargets, rowTitle, validateCalculations } from './calculations';
import type { Column, PersonnelTab } from './model';
import s from './Tabs.module.css';
import { BuilderEnvironmentContext } from './BuilderEnvironment';
import { useCalculationPreview } from './useCalculationEngine';

export function ColumnRuleDialog({
  tab,
  tabs,
  column,
  data,
  onSave,
  onClose,
}: {
  tab: PersonnelTab;
  tabs: PersonnelTab[];
  column: Column;
  data: PersonnelData;
  onSave: (tab: PersonnelTab) => void;
  onClose: () => void;
}): JSX.Element {
  const [draft, setDraft] = useState(() => structuredClone(column));
  const environment = useContext(BuilderEnvironmentContext);
  const evaluate = useCalculationPreview();
  const [rowId, setRowId] = useState(tab.rows[0]?.id ?? '');
  const [error, setError] = useState('');
  const candidate = {
    ...tab,
    columns: tab.columns.map((item) => (item.id === column.id ? draft : item)),
  };
  const candidates = [...tabs.filter((item) => item.id !== tab.id), candidate];
  const row = tab.rows.find((row) => row.id === rowId);
  return (
    <Modal
      title={`Настроить столбец «${column.name}»`}
      testId="project-column-rule"
      onClose={onClose}
      dirty={JSON.stringify(draft) !== JSON.stringify(column)}
      panelClassName={s.recordModal}
    >
      <form
        className={s.recordForm}
        onSubmit={(event) => {
          event.preventDefault();
          const message = validateCalculations(candidates, data, environment?.sources);
          if (message) {
            setError(message);
            return;
          }
          onSave(candidate);
          onClose();
        }}
      >
        <label>
          Проверить на записи
          <select value={rowId} onChange={(event) => setRowId(event.target.value)}>
            {tab.rows.map((row) => (
              <option key={row.id} value={row.id}>
                {rowTitle(tab, row, data)}
              </option>
            ))}
          </select>
        </label>
        <CalculationFields
          key={rowId}
          rule={draft.rule ?? manualRule()}
          targets={referenceTargets(candidate, 'column', data)}
          currentId={draft.id}
          tab={candidate}
          tabs={candidates}
          data={data}
          axis="column"
          onChange={(rule) => {
            const manualSettings = draft.manualSettings ?? {
              kind: draft.kind,
              required: draft.required,
            };
            setDraft({
              ...draft,
              rule,
              manualSettings,
              ...(rule.mode === 'manual'
                ? manualSettings
                : {
                    required: false,
                    ...(rule.mode === 'formula' ? { kind: 'number' as const } : {}),
                  }),
            });
            setError('');
          }}
          onPreview={() =>
            row
              ? evaluate(
                  candidates,
                  data,
                  { tabId: tab.id, rowId: row.id, columnId: column.id },
                  {
                    range: { from: data.today, to: data.today },
                  },
                )
              : { value: null, error: 'Сначала добавьте запись в таблицу.' }
          }
        />
        {error && (
          <p role="alert" className={s.error}>
            {error}
          </p>
        )}
        <div className="dialog-actions">
          <ModalCancelButton className="btn btn--ghost btn--compact" onClick={onClose}>
            Отмена
          </ModalCancelButton>
          <button type="submit" className="btn btn--primary btn--compact">
            Сохранить правило
          </button>
        </div>
      </form>
    </Modal>
  );
}

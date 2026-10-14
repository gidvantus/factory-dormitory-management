import type { OutflowFields } from '../../api/client';
import { OutflowReasonInput } from './OutflowReasonInput';
import styles from './TransferResidentDialog.module.css';

export function OutflowTransferFields({
  fields,
  reason,
  departure,
  onReason,
  onDeparture,
  disabled,
}: {
  fields: OutflowFields;
  reason: string;
  departure: string;
  onReason: (value: string) => void;
  onDeparture: (value: string) => void;
  disabled: boolean;
}): JSX.Element {
  return (
    <>
      {fields.reason_column ? (
        <label className={styles.field}>
          Причина оттока
          <OutflowReasonInput
            label="Причина оттока"
            hint="Новая причина сохранится в списке после переноса."
            value={reason}
            choices={fields.reasons}
            allowCustom={fields.reason_column.kind === 'text'}
            onChange={onReason}
            disabled={disabled}
            required
          />
        </label>
      ) : (
        <p className={styles.warning} role="note">
          Причина недоступна: добавьте или восстановите в «Оттоке» столбец «Причина» типа «Текст»
          или «Выпадающий список». Тогда здесь можно будет указать причину и использовать её в общем
          отчёте.
        </p>
      )}
      {fields.departure_column ? (
        <label className={styles.field}>
          Дата оттока
          <input
            aria-label="Дата оттока"
            type="date"
            value={departure}
            required
            disabled={disabled}
            onChange={(event) => onDeparture(event.target.value)}
          />
          <small>Будет записана в «Отток» как дата выезда.</small>
        </label>
      ) : (
        <p className={styles.warning} role="note">
          Дата оттока недоступна: добавьте или восстановите в «Оттоке» столбец «Дата выезда» типа
          «Дата». Тогда указанная дата оттока будет попадать в этот столбец.
        </p>
      )}
    </>
  );
}

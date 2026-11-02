import { useState } from 'react';
import type { FormEvent } from 'react';
import { Modal, ModalCancelButton } from '../../../components/Modal';
import { PersonnelBlockIcon as Icon } from '../PersonnelBlockIcon';
import { FieldControl } from './ArrivalFields';
import { PeopleEditor } from './PeopleEditor';
import type { Field, Settings, Value } from './data';
import type { ArrivalDraft } from './adapter';
import { hasPersonData, isEmpty, PEOPLE_PAGE_SIZE, personCount } from './data';
import s from './Arrivals.module.css';

export function ArrivalDialog({
  draft,
  settings,
  dormitories,
  busy,
  error,
  onChange,
  onClose,
  onSettings,
  onSave,
  onDelete,
}: {
  draft: ArrivalDraft;
  settings: Settings;
  dormitories: { id: number; name: string }[];
  busy: boolean;
  error: string;
  onChange: (values: Partial<ArrivalDraft>) => void;
  onClose: () => void;
  onSettings: () => void;
  onSave: () => Promise<void>;
  onDelete: () => Promise<void>;
}): JSX.Element {
  const [page, setPage] = useState(0);
  const [allowTrim, setAllowTrim] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [validation, setValidation] = useState('');
  const count = personCount(draft.count);
  const personal = settings.fields.filter((field) => field.inForm && field.scope === 'person');
  const shared = settings.fields.filter((field) => field.inForm && field.scope === 'arrival');
  const extra = count ? draft.people.slice(count).filter(hasPersonData).length : 0;
  function change(values: Partial<ArrivalDraft>): void {
    setValidation('');
    if (values.count !== undefined) setAllowTrim(false);
    onChange(values);
  }
  function missing(field: Field, value: Value | undefined): boolean {
    return field.type === 'checkbox'
      ? value !== true
      : isEmpty(value) || (typeof value === 'string' && !value.trim());
  }
  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (busy) return;
    if (!count) {
      setValidation('Укажите целое количество человек от 1 до 10 000.');
      return;
    }
    if (extra && !allowTrim) {
      setValidation(
        'Подтвердите удаление заполненных строк за пределами нового количества или увеличьте количество человек.',
      );
      return;
    }
    for (let index = 0; index < count; index++) {
      const field = personal.find(
        (item) => item.required && missing(item, draft.people[index].values[item.id]),
      );
      if (field) {
        setPage(Math.floor(index / PEOPLE_PAGE_SIZE));
        setValidation(`Заполните поле «${field.label}» у человека № ${index + 1}.`);
        return;
      }
    }
    await onSave();
  }
  return (
    <Modal
      title={draft.id ? 'Изменить заезд' : 'Добавить заезд'}
      testId="arrival-dialog"
      onClose={onClose}
      closeDisabled={busy}
      protectChanges={false}
      panelClassName={`${s.dialog} ${s.arrivalDialog}`}
    >
      <form onSubmit={(event) => void submit(event)}>
        <fieldset disabled={busy} className={s.disabledFields}>
          <div className={s.formIntro}>
            <span>Заполните сведения о заезде.</span>
            <button type="button" className="btn btn--ghost btn--compact" onClick={onSettings}>
              <Icon name="settings" />
              Настроить поля
            </button>
          </div>
          <div className={s.formFields}>
            <div className={s.arrivalCore}>
              <label className={s.inputField}>
                Общежитие
                <select
                  required
                  value={draft.dormitory_id}
                  onChange={(event) => {
                    const dorm = dormitories.find((item) => item.id === Number(event.target.value));
                    if (dorm) change({ dormitory_id: dorm.id, dorm: dorm.name });
                  }}
                >
                  {dormitories.map((dorm) => (
                    <option key={dorm.id} value={dorm.id}>
                      {dorm.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className={s.inputField}>
                Дата заезда
                <input
                  type="date"
                  required
                  value={draft.date}
                  onChange={(event) => change({ date: event.target.value })}
                />
              </label>
              <label className={s.inputField}>
                Количество человек
                <input
                  type="number"
                  required
                  min={1}
                  max={10000}
                  step={1}
                  value={draft.count}
                  onChange={(event) => change({ count: event.target.value })}
                />
              </label>
            </div>
            <PeopleEditor
              people={draft.people}
              count={count}
              fields={personal}
              page={page}
              onPage={setPage}
              onChange={(index, person) =>
                change({ people: draft.people.map((old, i) => (i === index ? person : old)) })
              }
            />
            {extra > 0 && (
              <div className={s.trimNotice}>
                <p>
                  Количество уменьшено. За пределами списка осталось заполненных строк: {extra}. При
                  увеличении количества они снова появятся.
                </p>
                <label className={s.checkField}>
                  <input
                    type="checkbox"
                    checked={allowTrim}
                    onChange={(event) => setAllowTrim(event.target.checked)}
                  />
                  Убрать эти строки при сохранении заезда
                </label>
              </div>
            )}
            {shared.length > 0 && (
              <div className={s.extraFieldsHeading}>
                <h3>Общие сведения о заезде</h3>
                <span className={s.muted}>Заполняются один раз для всей группы</span>
              </div>
            )}
            <div className={s.customFields}>
              {shared.map((field) => (
                <div key={field.id} data-wide={field.type === 'textarea'}>
                  <FieldControl
                    field={field}
                    value={draft.values[field.id]}
                    onChange={(value) => change({ values: { ...draft.values, [field.id]: value } })}
                  />
                </div>
              ))}
            </div>
          </div>
          {(validation || error) && (
            <p role="alert" className={s.error}>
              {validation || error}
            </p>
          )}
          <div className={`dialog-actions ${s.dialogActions}`}>
            {draft.id && (
              <button
                type="button"
                className="btn btn--ghost btn--compact"
                onClick={() => setDeleting(true)}
              >
                Удалить заезд
              </button>
            )}
            <ModalCancelButton
              onClick={onClose}
              type="button"
              className="btn btn--ghost btn--compact"
            >
              Отмена
            </ModalCancelButton>
            <button type="submit" className="btn btn--primary btn--compact">
              {busy ? 'Сохраняем…' : 'Сохранить заезд'}
            </button>
          </div>
          {deleting && (
            <div className={s.trimNotice}>
              <p>Удалить этот заезд? Его количество перестанет учитываться в отчёте.</p>
              <div className={s.actions}>
                <button
                  type="button"
                  className="btn btn--danger btn--compact"
                  onClick={() => void onDelete()}
                >
                  Да, удалить
                </button>
                <button
                  type="button"
                  className="btn btn--ghost btn--compact"
                  onClick={() => setDeleting(false)}
                >
                  Оставить запись
                </button>
              </div>
            </div>
          )}
        </fieldset>
      </form>
    </Modal>
  );
}

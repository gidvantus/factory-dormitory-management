import { useState } from 'react';
import { Modal, ModalCancelButton } from '../../../components/Modal';
import { PersonnelBlockIcon as Icon } from '../PersonnelBlockIcon';
import { ArrivalCard, FieldControl } from './ArrivalFields';
import type { Arrival, Field, FieldType, Settings } from './data';
import { FIELD_TYPES, reconfigureArrival, sampleValue } from './data';
import { message } from '../helpers';
import s from './Arrivals.module.css';

type Tab = 'fields' | 'display';

function move<T>(items: T[], index: number, step: number): T[] {
  const next = [...items];
  const other = index + step;
  if (other >= 0 && other < items.length) [next[index], next[other]] = [next[other], next[index]];
  return next;
}

export function SettingsDialog({
  settings,
  initialTab,
  sample,
  onClose,
  onSave,
  preview = true,
  usedFields = [],
}: {
  settings: Settings;
  initialTab: Tab;
  sample: Arrival;
  onClose: () => void;
  onSave: (settings: Settings) => void | Promise<void>;
  preview?: boolean;
  usedFields?: string[];
}): JSX.Element {
  const [draft, setDraft] = useState<Settings>(() =>
    structuredClone({ fields: settings.fields, display: settings.display }),
  );
  const [tab, setTab] = useState(initialTab);
  const [selected, setSelected] = useState(settings.fields[0]?.id ?? '');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const field = draft.fields.find((item) => item.id === selected);
  const display = draft.display;
  const previewArrival = reconfigureArrival(sample, settings, draft);
  for (const item of draft.fields) {
    if (settings.fields.find((old) => old.id === item.id)?.type === item.type) continue;
    if (item.scope === 'arrival') previewArrival.values[item.id] = sampleValue(item, sample.date);
    else
      previewArrival.people.forEach((person, index) => {
        person.values[item.id] =
          item.type === 'number' && index === 0 ? '15' : sampleValue(item, sample.date);
      });
  }

  function updateField(values: Partial<Field>): void {
    setDraft((old) => ({
      ...old,
      fields: old.fields.map((item) => (item.id === selected ? { ...item, ...values } : item)),
    }));
    setError('');
  }
  function updateDisplay(values: Partial<Settings['display']>): void {
    setDraft((old) => ({ ...old, display: { ...old.display, ...values } }));
  }
  function toggleVisible(id: string, checked: boolean): void {
    updateDisplay({
      visible: checked
        ? [...display.visible.filter((item) => item !== id), id]
        : display.visible.filter((item) => item !== id),
    });
  }
  function addField(): void {
    const id = crypto.randomUUID();
    setDraft((old) => ({
      fields: [
        ...old.fields,
        {
          id,
          label: 'Новое поле',
          type: 'text',
          inForm: true,
          required: false,
          scope: 'arrival',
          options: [],
        },
      ],
      display: {
        ...old.display,
        order: [...old.display.order, id],
        visible: [...old.display.visible, id],
      },
    }));
    setSelected(id);
    setError('');
  }
  function removeField(): void {
    const next = draft.fields.filter((item) => item.id !== selected);
    setDraft({
      fields: next,
      display: {
        ...display,
        order: display.order.filter((id) => id !== selected),
        visible: display.visible.filter((id) => id !== selected),
      },
    });
    setSelected(next[0]?.id ?? '');
    setError('');
  }
  async function save(): Promise<void> {
    if (busy) return;
    const normalized = draft.fields.map((item) => ({
      ...item,
      label: item.label.trim(),
      options: [...new Set(item.options.map((option) => option.trim()).filter(Boolean))],
    }));
    const labels = normalized.map((item) => item.label.toLocaleLowerCase('ru'));
    if (normalized.some((item) => !item.label)) {
      setError('Введите название каждого поля.');
      return;
    }
    if (
      new Set([...labels, 'общежитие', 'дата заезда', 'количество человек', 'фио']).size !==
      labels.length + 4
    ) {
      setError('Названия полей должны отличаться друг от друга и от основных полей.');
      return;
    }
    if (normalized.some((item) => item.type === 'select' && !item.options.length)) {
      setError('Добавьте хотя бы один вариант для каждого выпадающего списка.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await onSave({ fields: normalized, display });
    } catch (caught) {
      setError(message(caught));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title="Настройки плана заездов"
      testId="arrival-settings-dialog"
      onClose={onClose}
      closeDisabled={busy}
      dirty={
        JSON.stringify(draft) !==
        JSON.stringify({ fields: settings.fields, display: settings.display })
      }
      panelClassName={`${s.dialog} ${s.settingsDialog}`}
      initialFocus="panel"
    >
      <fieldset className={s.disabledFields} disabled={busy}>
        <p className={s.muted}>
          Один набор полей для добавления и изменения заезда во всех общежитиях.
        </p>
        <div className={s.settingsTabs} role="tablist" aria-label="Разделы настроек">
          <button
            className="btn btn--ghost btn--compact"
            role="tab"
            id="settings-fields-tab"
            aria-controls="settings-fields-panel"
            aria-selected={tab === 'fields'}
            onClick={() => setTab('fields')}
          >
            Поля формы
          </button>
          <button
            className="btn btn--ghost btn--compact"
            role="tab"
            id="settings-display-tab"
            aria-controls="settings-display-panel"
            aria-selected={tab === 'display'}
            onClick={() => setTab('display')}
          >
            Правая панель
          </button>
        </div>
        <div className={s.settingsLayout}>
          <div role="tabpanel" id={`settings-${tab}-panel`} aria-labelledby={`settings-${tab}-tab`}>
            {tab === 'fields' ? (
              <>
                <div className={s.fixedFields}>
                  <strong>Основные поля</strong>
                  <span>Общежитие · Дата заезда · Количество человек · ФИО</span>
                  <small>
                    Общежитие, дата и количество обязательны. Для каждого человека — отдельная
                    ячейка ФИО.
                  </small>
                </div>
                <div className={s.sectionHeading}>
                  <h3>Дополнительные поля</h3>
                  <button
                    className="btn btn--ghost btn--compact"
                    disabled={draft.fields.length >= 40}
                    onClick={addField}
                  >
                    <Icon name="plus" />
                    Добавить поле
                  </button>
                </div>
                <div className={s.fieldWorkspace}>
                  <div className={s.fieldList} aria-label="Дополнительные поля">
                    {draft.fields.map((item, index) => (
                      <div
                        key={item.id}
                        className={s.fieldListRow}
                        data-active={item.id === selected}
                      >
                        <button
                          className={`btn btn--ghost btn--compact ${s.fieldSelect}`}
                          aria-pressed={selected === item.id}
                          onClick={() => setSelected(item.id)}
                        >
                          <span className={s.typeIcon}>{FIELD_TYPES[item.type].icon}</span>
                          <span>
                            <strong>{item.label || 'Без названия'}</strong>
                            <small>
                              {FIELD_TYPES[item.type].label}
                              {item.scope === 'person' ? ' · у каждого ФИО' : ' · на заезд'}
                              {!item.inForm ? ' · скрыто в форме' : ''}
                            </small>
                          </span>
                        </button>
                        <div className={s.reorder}>
                          <button
                            className="btn btn--ghost btn--compact"
                            aria-label={`Поднять поле ${item.label}`}
                            disabled={index === 0}
                            onClick={() =>
                              setDraft((old) => ({ ...old, fields: move(old.fields, index, -1) }))
                            }
                          >
                            <Icon name="up" />
                          </button>
                          <button
                            className="btn btn--ghost btn--compact"
                            aria-label={`Опустить поле ${item.label}`}
                            disabled={index === draft.fields.length - 1}
                            onClick={() =>
                              setDraft((old) => ({ ...old, fields: move(old.fields, index, 1) }))
                            }
                          >
                            <Icon name="down" />
                          </button>
                        </div>
                      </div>
                    ))}
                    {!draft.fields.length && (
                      <p className={s.empty}>Добавьте первое поле, например «Кол-во смен».</p>
                    )}
                  </div>
                  {field && (
                    <div className={s.fieldEditor}>
                      <label className={s.inputField}>
                        Название поля
                        <input
                          maxLength={80}
                          value={field.label}
                          onChange={(e) => updateField({ label: e.target.value })}
                        />
                      </label>
                      <label className={s.inputField}>
                        Где заполнять
                        <select
                          value={field.scope}
                          disabled={!preview && usedFields.includes(field.id)}
                          onChange={(e) => updateField({ scope: e.target.value as Field['scope'] })}
                        >
                          <option value="arrival">Один раз на заезд</option>
                          <option value="person">Напротив каждого ФИО</option>
                        </select>
                        <small>
                          {field.scope === 'person'
                            ? 'У каждого человека своя ячейка и своё значение.'
                            : 'Одно общее значение для всей группы.'}
                        </small>
                      </label>
                      <label className={s.inputField}>
                        Тип поля
                        <select
                          value={field.type}
                          disabled={!preview && usedFields.includes(field.id)}
                          onChange={(e) =>
                            updateField({
                              type: e.target.value as FieldType,
                              options: field.options.length
                                ? field.options
                                : ['Вариант 1', 'Вариант 2'],
                            })
                          }
                        >
                          {Object.entries(FIELD_TYPES).map(([value, item]) => (
                            <option key={value} value={value}>
                              {item.label}
                            </option>
                          ))}
                        </select>
                      </label>
                      {!preview && usedFields.includes(field.id) && (
                        <p className={s.muted}>
                          Поле уже содержит значения. Для другого типа или размещения добавьте новое
                          поле.
                        </p>
                      )}
                      {preview &&
                        settings.fields.some(
                          (old) => old.id === field.id && old.type !== field.type,
                        ) && (
                          <p className={s.muted}>
                            При смене типа значения этого поля в макете очистятся.
                          </p>
                        )}
                      {field.type === 'select' && (
                        <label className={s.inputField}>
                          Варианты списка
                          <textarea
                            rows={4}
                            value={field.options.join('\n')}
                            onChange={(e) => updateField({ options: e.target.value.split('\n') })}
                          />
                          <small>Каждый вариант с новой строки.</small>
                        </label>
                      )}
                      <label className={s.checkField}>
                        <input
                          type="checkbox"
                          checked={field.inForm}
                          onChange={(e) =>
                            updateField({
                              inForm: e.target.checked,
                              required: e.target.checked && field.required,
                            })
                          }
                        />
                        Показывать в форме
                      </label>
                      <label className={s.checkField}>
                        <input
                          type="checkbox"
                          checked={field.required}
                          disabled={!field.inForm}
                          onChange={(e) => updateField({ required: e.target.checked })}
                        />
                        {field.scope === 'person'
                          ? 'Обязательное у каждого человека'
                          : 'Обязательное поле'}
                      </label>
                      <label className={s.checkField}>
                        <input
                          type="checkbox"
                          checked={display.visible.includes(field.id)}
                          onChange={(e) => toggleVisible(field.id, e.target.checked)}
                        />
                        Показывать справа
                      </label>
                      <button className="btn btn--ghost btn--compact" onClick={removeField}>
                        <Icon name="remove" />
                        Убрать поле
                      </button>
                    </div>
                  )}
                </div>
              </>
            ) : (
              <>
                <div className={s.sectionHeading}>
                  <h3>Что показывать в карточке</h3>
                </div>
                <p className={s.muted}>
                  Личные поля показываются столбцами у человека. Порядок этих полей определяет
                  порядок столбцов. Общежитие и количество видны всегда.
                </p>
                <div className={s.displayList}>
                  {display.order.map((id, index) => {
                    const item = draft.fields.find((entry) => entry.id === id);
                    const label = id === 'names' ? 'ФИО приезжающих' : (item?.label ?? '');
                    return (
                      <div className={s.displayListRow} key={id}>
                        <label className={s.checkField}>
                          <input
                            type="checkbox"
                            checked={display.visible.includes(id)}
                            onChange={(e) => toggleVisible(id, e.target.checked)}
                          />
                          <span>
                            {label}
                            {item?.scope === 'person' && (
                              <small className={s.scopeNote}>Напротив каждого ФИО</small>
                            )}
                          </span>
                        </label>
                        <div className={s.reorder}>
                          <button
                            className="btn btn--ghost btn--compact"
                            disabled={index === 0}
                            aria-label={`Поднять в карточке ${label}`}
                            onClick={() => updateDisplay({ order: move(display.order, index, -1) })}
                          >
                            <Icon name="up" />
                          </button>
                          <button
                            className="btn btn--ghost btn--compact"
                            disabled={index === display.order.length - 1}
                            aria-label={`Опустить в карточке ${label}`}
                            onClick={() => updateDisplay({ order: move(display.order, index, 1) })}
                          >
                            <Icon name="down" />
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
                <div className={s.displayOptions}>
                  <label className={s.checkField}>
                    <input
                      type="checkbox"
                      checked={display.summary}
                      onChange={(e) => updateDisplay({ summary: e.target.checked })}
                    />
                    Показывать итог за день
                  </label>
                  <label className={s.checkField}>
                    <input
                      type="checkbox"
                      checked={display.hideEmpty}
                      onChange={(e) => updateDisplay({ hideEmpty: e.target.checked })}
                    />
                    Скрывать незаполненные поля
                  </label>
                  <label className={s.checkField}>
                    <input
                      type="checkbox"
                      checked={display.compact}
                      onChange={(e) => updateDisplay({ compact: e.target.checked })}
                    />
                    Компактные карточки
                  </label>
                  <label className={s.inputField}>
                    Людей в карточке
                    <select
                      value={display.namesLimit}
                      onChange={(e) => updateDisplay({ namesLimit: Number(e.target.value) })}
                    >
                      <option value={3}>До 3 человек</option>
                      <option value={5}>До 5 человек</option>
                      <option value={10000}>Все люди</option>
                    </select>
                  </label>
                </div>
              </>
            )}
          </div>
          <aside className={s.livePreview} aria-label="Предпросмотр настроек">
            <span className={s.previewLabel}>Предпросмотр</span>
            <h3>{tab === 'fields' ? 'Так поле выглядит в форме' : 'Так выглядит правая панель'}</h3>
            {tab === 'fields' && field ? (
              <>
                <fieldset className={s.controlPreview} disabled>
                  {field.scope === 'person' ? (
                    <div className={s.personFieldPreview}>
                      <span>ФИО</span>
                      <span>{field.label}</span>
                      {[0, 1].map((index) => (
                        <div key={index} className={s.personPreviewRow}>
                          <input
                            aria-label={`Пример ФИО ${index + 1}`}
                            value={
                              sample.people[index]?.name ||
                              (index ? 'Михаил Соколов' : 'Александр Волков')
                            }
                            readOnly
                          />
                          <FieldControl
                            compact
                            field={field}
                            value={
                              field.type === 'number' && index === 0
                                ? '15'
                                : sampleValue(field, sample.date)
                            }
                            onChange={() => undefined}
                          />
                        </div>
                      ))}
                    </div>
                  ) : (
                    <FieldControl
                      key={field.type}
                      field={field}
                      value={sampleValue(field, sample.date)}
                      onChange={() => undefined}
                    />
                  )}
                </fieldset>
                <p className={s.muted}>
                  {field.scope === 'person'
                    ? 'Поле повторяется в каждой строке рядом с ФИО. Значения у людей могут отличаться.'
                    : 'Поле заполняется один раз на весь заезд.'}
                </p>
                <h4>В карточке заезда</h4>
              </>
            ) : (
              display.summary && (
                <div className={s.previewSummary}>
                  <strong>{sample.count}</strong>
                  <span>человек ожидается</span>
                </div>
              )
            )}
            <ArrivalCard arrival={previewArrival} settings={draft} />
            <p className={s.previewNote}>
              Предпросмотр меняется сразу. На странице настройки применятся после сохранения.
            </p>
          </aside>
        </div>
        {error && (
          <p role="alert" className={s.error}>
            {error}
          </p>
        )}
        <div className={`dialog-actions ${s.dialogActions}`}>
          <ModalCancelButton onClick={onClose} className="btn btn--ghost btn--compact">
            Отмена
          </ModalCancelButton>
          <button className="btn btn--primary btn--compact" onClick={() => void save()}>
            {busy ? 'Сохраняем…' : preview ? 'Применить в макете' : 'Сохранить настройки'}
          </button>
        </div>
      </fieldset>
    </Modal>
  );
}

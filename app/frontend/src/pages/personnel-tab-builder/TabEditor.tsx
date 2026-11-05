import { ColumnArchiveTabs } from '../../components/ColumnArchiveTabs';
import { useContext, useState } from 'react';
import type { PersonnelData } from '../../api/personnel';
import { Modal, ModalCancelButton } from '../../components/Modal';
import { EmployeeListFilters } from '../../workspace/personnel/EmployeeListFilterPanel';
import { employeeListFields } from '../../workspace/personnel/employeeListFilters';
import {
  blockNames,
  defaultBlocks,
  filterPeople,
  names,
  dateLabel,
} from '../../workspace/personnel/helpers';
import { columnNames, kindNames, move, newColumn, validateTab } from './model';
import type { Column, PersonnelTab } from './model';
import s from './Tabs.module.css';
import { TableSettings } from './TableSettings';
import { CalculationFields } from './CalculationFields';
import { manualRule } from './calculationTypes';
import { dependents, isComputed, referenceTargets } from './calculations';
import { BuilderEnvironmentContext } from './BuilderEnvironment';
import { useCalculationPreview } from './useCalculationEngine';

export function TabEditor({
  initial,
  tabs,
  data,
  isNew,
  isDefault,
  onClose,
  onSave,
}: {
  initial: PersonnelTab;
  tabs: PersonnelTab[];
  data: PersonnelData;
  isNew: boolean;
  isDefault: boolean;
  onClose: () => void;
  onSave: (tab: PersonnelTab, makeDefault: boolean, childrenNames: string[]) => void;
}): JSX.Element {
  const [draft, setDraft] = useState(() => structuredClone(initial));
  const environment = useContext(BuilderEnvironmentContext);
  const evaluate = useCalculationPreview();
  const [section, setSection] = useState('content');
  const [makeDefault, setMakeDefault] = useState(isDefault);
  const [error, setError] = useState('');
  const [archivedColumns, setArchivedColumns] = useState(false);
  const [withChildren, setWithChildren] = useState(false);
  const [childrenNames, setChildrenNames] = useState(['']);
  const patch = (values: Partial<PersonnelTab>): void => {
    setDraft((current) => ({ ...current, ...values }));
    setError('');
  };
  const fieldChoices = employeeListFields(data, draft.criteria).filter(
    (field) => field.id !== 'full_name' && field.id !== 'dormitory',
  );
  function columnPatch(id: string, values: Partial<Column>): void {
    if (values.archived) {
      const users = dependents(
        [...tabs.filter((tab) => tab.id !== draft.id), draft],
        draft.id,
        'column',
        id,
      );
      if (users.length) {
        setError(
          `Столбец используется в расчётах: ${users.join(', ')}. Сначала измените зависимости.`,
        );
        return;
      }
    }
    patch({
      columns: draft.columns.map((column) =>
        column.id === id ? { ...column, ...values } : column,
      ),
    });
  }
  return (
    <Modal
      title={isNew ? 'Добавить подвкладку' : 'Настроить подвкладку'}
      testId="personnel-tab-editor"
      panelClassName={s.editor}
      onClose={onClose}
      dirty={
        JSON.stringify(draft) !== JSON.stringify(initial) ||
        makeDefault !== isDefault ||
        withChildren
      }
    >
      <form
        className={s.editorForm}
        onSubmit={(event) => {
          event.preventDefault();
          const message = validateTab(draft, tabs, data, environment?.sources);
          if (message) {
            setError(message);
            return;
          }
          const childNames =
            withChildren && draft.kind === 'table' ? childrenNames.map((name) => name.trim()) : [];
          const normalize = (name: string): string =>
            name.toLocaleLowerCase('ru').replace(/\s+/g, ' ').trim();
          if (
            childNames.length &&
            (childNames.some((name) => !name) ||
              new Set([
                ...tabs.filter((tab) => tab.id !== draft.id).map((tab) => normalize(tab.name)),
                normalize(draft.name),
                ...childNames.map(normalize),
              ]).size !==
                tabs.filter((tab) => tab.id !== draft.id).length + childNames.length + 1)
          ) {
            setError(
              'Названия вложенных подвкладок должны быть заполнены и отличаться от других вкладок.',
            );
            return;
          }
          onSave(
            {
              ...draft,
              name: draft.name.trim(),
              description: draft.description.trim(),
              columns: draft.columns.map((column) => ({
                ...column,
                name: column.name.trim(),
                options: [
                  ...new Set(column.options.map((option) => option.trim()).filter(Boolean)),
                ],
              })),
            },
            makeDefault,
            childNames,
          );
        }}
      >
        <div className={s.editorScroll}>
          <div className={s.twoFields}>
            <label>
              Название подвкладки
              <input
                required
                maxLength={60}
                value={draft.name}
                onChange={(event) => patch({ name: event.target.value })}
                placeholder="Например, Проверить документы"
              />
            </label>
            <label>
              Описание
              <input
                maxLength={180}
                value={draft.description}
                onChange={(event) => patch({ description: event.target.value })}
                placeholder="Для чего нужна эта подвкладка"
              />
            </label>
          </div>
          <fieldset className={s.kindChoices}>
            <legend>Что будет внутри</legend>
            {(['employees', 'table', 'blocks'] as const).map((kind) => (
              <label key={kind} data-selected={draft.kind === kind}>
                <input
                  type="radio"
                  name="tab-kind"
                  disabled={initial.isGroup}
                  checked={draft.kind === kind}
                  onChange={() => patch({ kind })}
                />
                <span>
                  <strong>{kindNames[kind]}</strong>
                  <small>
                    {kind === 'employees'
                      ? 'Существующие сотрудники по вашим условиям'
                      : kind === 'table'
                        ? 'Свои столбцы и записи'
                        : 'Сводки, контакты и списки на одной странице'}
                  </small>
                </span>
              </label>
            ))}
          </fieldset>
          <div role="tablist" aria-label="Настройки подвкладки" className={s.editorTabs}>
            <button
              type="button"
              role="tab"
              id="tab-content"
              aria-selected={section === 'content'}
              aria-controls="tab-content-panel"
              className={`btn ${section === 'content' ? 'btn--primary' : 'btn--ghost'} btn--compact`}
              onClick={() => setSection('content')}
            >
              Содержимое
            </button>
            <button
              type="button"
              role="tab"
              id="tab-actions"
              aria-selected={section === 'actions'}
              aria-controls="tab-actions-panel"
              className={`btn ${section === 'actions' ? 'btn--primary' : 'btn--ghost'} btn--compact`}
              onClick={() => setSection('actions')}
            >
              Возможности
            </button>
          </div>
          <div
            role="tabpanel"
            id={`tab-${section}-panel`}
            aria-labelledby={`tab-${section}`}
            className={s.editorBody}
          >
            {section === 'content' ? (
              <>
                {draft.kind === 'employees' && (
                  <>
                    <div className={s.twoFields}>
                      <label>
                        Кого показывать
                        <select
                          value={draft.criteria.filter}
                          onChange={(event) =>
                            patch({
                              criteria: {
                                ...draft.criteria,
                                filter: event.target.value as PersonnelTab['criteria']['filter'],
                              },
                            })
                          }
                        >
                          {Object.entries(names).map(([id, name]) => (
                            <option key={id} value={id}>
                              {name}
                            </option>
                          ))}
                        </select>
                      </label>
                      {draft.criteria.filter === 'ending' && (
                        <label>
                          До окончания вахты, дней
                          <input
                            type="number"
                            min={1}
                            max={365}
                            required
                            value={draft.criteria.days}
                            onChange={(event) =>
                              patch({
                                criteria: { ...draft.criteria, days: Number(event.target.value) },
                              })
                            }
                          />
                        </label>
                      )}
                    </div>
                    <fieldset className={s.checks}>
                      <legend>Общежития</legend>
                      <label>
                        <input
                          type="checkbox"
                          checked={!draft.criteria.scope.length}
                          onChange={() => patch({ criteria: { ...draft.criteria, scope: [] } })}
                        />
                        Все общежития
                      </label>
                      {data.dormitories.map((dorm) => (
                        <label key={dorm.id}>
                          <input
                            type="checkbox"
                            checked={draft.criteria.scope.includes(dorm.id)}
                            onChange={(event) =>
                              patch({
                                criteria: {
                                  ...draft.criteria,
                                  scope: event.target.checked
                                    ? [...draft.criteria.scope, dorm.id]
                                    : draft.criteria.scope.filter((id) => id !== dorm.id),
                                },
                              })
                            }
                          />
                          {dorm.name}
                        </label>
                      ))}
                    </fieldset>
                    <EmployeeListFilters
                      data={data}
                      criteria={draft.criteria}
                      fields={employeeListFields(data, draft.criteria)}
                      onChange={(rules) =>
                        patch({ criteria: { ...draft.criteria, column_filters: rules } })
                      }
                    />
                    <fieldset className={s.checks}>
                      <legend>Столбцы списка</legend>
                      <p>ФИО и проживание видны всегда. Выберите дополнительные сведения.</p>
                      {fieldChoices.map((field) => (
                        <label key={field.id}>
                          <input
                            type="checkbox"
                            checked={draft.fields.includes(field.id)}
                            onChange={(event) =>
                              patch({
                                fields: event.target.checked
                                  ? [...draft.fields, field.id]
                                  : draft.fields.filter((id) => id !== field.id),
                              })
                            }
                          />
                          {field.label}
                        </label>
                      ))}
                    </fieldset>
                    <p className={s.result}>
                      Сейчас условиям соответствуют{' '}
                      <strong>{filterPeople(data, draft.criteria).length}</strong> сотрудников.
                      Состав списка обновляется по данным реестра.
                    </p>
                  </>
                )}
                {draft.kind === 'table' && (
                  <>
                    <TableSettings
                      draft={draft}
                      tabs={tabs}
                      isNew={isNew}
                      patch={patch}
                      withChildren={withChildren}
                      onWithChildren={setWithChildren}
                      childrenNames={childrenNames}
                      onChildrenNames={setChildrenNames}
                    />
                    <p className={s.muted}>
                      Добавьте свои столбцы. Тип «Сотрудник из реестра» связывает запись с
                      существующим человеком.
                    </p>
                    <ColumnArchiveTabs
                      archived={archivedColumns}
                      onChange={setArchivedColumns}
                      currentCount={draft.columns.filter((column) => !column.archived).length}
                      archivedCount={draft.columns.filter((column) => column.archived).length}
                    />
                    {draft.columns
                      .filter((column) => !archivedColumns && !column.archived)
                      .map((column, index) => {
                        const used = draft.rows.some(
                          (row) =>
                            row.values[column.id] !== undefined && row.values[column.id] !== '',
                        );
                        const active = draft.columns.filter((item) => !item.archived);
                        return (
                          <fieldset key={column.id} className={s.column}>
                            <legend>Столбец {index + 1}</legend>
                            <div className={s.twoFields}>
                              <label>
                                Название столбца
                                <input
                                  maxLength={80}
                                  value={column.name}
                                  onChange={(event) =>
                                    columnPatch(column.id, { name: event.target.value })
                                  }
                                  required
                                />
                              </label>
                              <label>
                                Тип столбца
                                <select
                                  value={column.kind}
                                  disabled={used || column.rule?.mode === 'formula'}
                                  onChange={(event) =>
                                    columnPatch(column.id, {
                                      kind: event.target.value as Column['kind'],
                                    })
                                  }
                                >
                                  {Object.entries(columnNames).map(([id, name]) => (
                                    <option key={id} value={id}>
                                      {name}
                                    </option>
                                  ))}
                                </select>
                                {used && <small>Тип заполненного столбца сохраняется.</small>}
                              </label>
                            </div>
                            {column.kind === 'select' && (
                              <label>
                                Варианты списка
                                <textarea
                                  rows={3}
                                  value={column.options.join('\n')}
                                  onChange={(event) =>
                                    columnPatch(column.id, {
                                      options: event.target.value.split('\n'),
                                    })
                                  }
                                  placeholder="Каждый вариант с новой строки"
                                />
                              </label>
                            )}
                            <CalculationFields
                              rule={column.rule ?? manualRule()}
                              targets={referenceTargets(draft, 'column', data)}
                              currentId={column.id}
                              tab={draft}
                              tabs={[...tabs.filter((tab) => tab.id !== draft.id), draft]}
                              data={data}
                              axis="column"
                              onChange={(rule) => {
                                const manualSettings = column.manualSettings ?? {
                                  kind: column.kind,
                                  required: column.required,
                                };
                                columnPatch(column.id, {
                                  rule,
                                  manualSettings,
                                  ...(rule.mode === 'manual'
                                    ? manualSettings
                                    : {
                                        required: false,
                                        ...(rule.mode === 'formula'
                                          ? { kind: 'number' as const }
                                          : {}),
                                      }),
                                });
                              }}
                              onPreview={() => {
                                const row = draft.rows[0];
                                return row
                                  ? evaluate(
                                      [...tabs.filter((tab) => tab.id !== draft.id), draft],
                                      data,
                                      { tabId: draft.id, rowId: row.id, columnId: column.id },
                                      { range: { from: data.today, to: data.today } },
                                    )
                                  : {
                                      value: null,
                                      error:
                                        'Добавьте запись с исходными значениями, чтобы проверить расчёт.',
                                    };
                              }}
                            />
                            {isComputed(column.rule) && (
                              <small className={s.muted}>
                                Проверка использует первую запись; связи по дате —{' '}
                                {dateLabel(data.today, true)}. В таблице расчёт применяется к каждой
                                записи и выбранному периоду.
                              </small>
                            )}
                            <div className={s.toolbar}>
                              <label className={s.check}>
                                <input
                                  type="checkbox"
                                  checked={column.required}
                                  disabled={isComputed(column.rule)}
                                  onChange={(event) =>
                                    columnPatch(column.id, { required: event.target.checked })
                                  }
                                />
                                Обязательное поле
                              </label>
                              <div className={s.buttons}>
                                <button
                                  className="btn btn--quiet btn--compact"
                                  type="button"
                                  aria-label={`Поднять столбец ${index + 1}`}
                                  disabled={index === 0}
                                  onClick={() =>
                                    patch({
                                      columns: [
                                        ...move(active, index, -1),
                                        ...draft.columns.filter((item) => item.archived),
                                      ],
                                    })
                                  }
                                >
                                  ↑
                                </button>
                                <button
                                  className="btn btn--quiet btn--compact"
                                  type="button"
                                  aria-label={`Опустить столбец ${index + 1}`}
                                  disabled={index === active.length - 1}
                                  onClick={() =>
                                    patch({
                                      columns: [
                                        ...move(active, index, 1),
                                        ...draft.columns.filter((item) => item.archived),
                                      ],
                                    })
                                  }
                                >
                                  ↓
                                </button>
                                <button
                                  className="btn btn--ghost btn--compact"
                                  type="button"
                                  onClick={() => columnPatch(column.id, { archived: true })}
                                >
                                  Скрыть столбец
                                </button>
                              </div>
                            </div>
                          </fieldset>
                        );
                      })}
                    <button
                      className="btn btn--outline btn--compact"
                      type="button"
                      onClick={() => {
                        setArchivedColumns(false);
                        patch({ columns: [...draft.columns, newColumn()] });
                      }}
                    >
                      + Добавить столбец
                    </button>
                    {draft.columns.some((column) => column.archived) && (
                      <div className={s.archived} hidden={!archivedColumns}>
                        {draft.columns
                          .filter((column) => column.archived)
                          .map((column) => (
                            <div key={column.id} className={s.toolbar}>
                              <span>{column.name || 'Без названия'}</span>
                              <button
                                type="button"
                                className="btn btn--ghost btn--compact"
                                onClick={() => columnPatch(column.id, { archived: false })}
                              >
                                Восстановить столбец
                              </button>
                            </div>
                          ))}
                      </div>
                    )}
                  </>
                )}
                {draft.kind === 'blocks' && (
                  <fieldset className={s.checks}>
                    <legend>Какие блоки добавить</legend>
                    <p>Каждый блок можно отдельно настроить и переместить на готовой подвкладке.</p>
                    {defaultBlocks.map((block) => (
                      <label key={block.kind}>
                        <input
                          type="checkbox"
                          checked={draft.blocks.some((item) => item.kind === block.kind)}
                          onChange={(event) =>
                            patch({
                              blocks: event.target.checked
                                ? [
                                    ...draft.blocks,
                                    { ...structuredClone(block), id: crypto.randomUUID() },
                                  ]
                                : draft.blocks.filter((item) => item.kind !== block.kind),
                            })
                          }
                        />
                        {blockNames[block.kind]}
                      </label>
                    ))}
                  </fieldset>
                )}
              </>
            ) : (
              <>
                <fieldset className={s.checks}>
                  <legend>Доступные действия</legend>
                  {(
                    [
                      ...(draft.kind !== 'blocks'
                        ? [
                            ['search', 'Поиск на вкладке'],
                            ['export', 'Скачать список CSV'],
                          ]
                        : []),
                      ...(draft.kind === 'employees'
                        ? [['filters', 'Дополнительные фильтры на вкладке']]
                        : []),
                    ] as [keyof PersonnelTab['actions'], string][]
                  ).map(([key, label]) => (
                    <label key={key}>
                      <input
                        type="checkbox"
                        checked={draft.actions[key]}
                        onChange={(event) =>
                          patch({ actions: { ...draft.actions, [key]: event.target.checked } })
                        }
                      />
                      {label}
                    </label>
                  ))}
                  {draft.kind === 'blocks' && (
                    <p>Добавление, настройка и порядок блоков доступны на самой подвкладке.</p>
                  )}
                </fieldset>
                <label className={s.check}>
                  <input
                    type="checkbox"
                    checked={makeDefault}
                    onChange={(event) => setMakeDefault(event.target.checked)}
                  />
                  Открывать эту подвкладку при входе в «Персонал»
                </label>
              </>
            )}
          </div>
        </div>
        <div className={s.editorFooter}>
          {error && (
            <p role="alert" className={s.error}>
              {error}
            </p>
          )}
          <span className={s.muted}>
            {environment ? 'Настройки вашей организации.' : 'Сохранится только в тестовом примере.'}
          </span>
          <div className={s.buttons}>
            <ModalCancelButton className="btn btn--ghost btn--compact" onClick={onClose}>
              Отмена
            </ModalCancelButton>
            <button className="btn btn--primary btn--compact" type="submit">
              {isNew ? 'Создать подвкладку' : 'Сохранить настройки'}
            </button>
          </div>
        </div>
      </form>
    </Modal>
  );
}

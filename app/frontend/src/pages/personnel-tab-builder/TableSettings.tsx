import { useContext, useState } from 'react';
import { CustomTabOptionsEditor } from '../../workspace/dormitories/CustomTabOptionsEditor';
import { cloneTable, dormitoryTableTemplates, newColumn } from './model';
import type { PersonnelTab } from './model';
import s from './Tabs.module.css';
import { isComputed } from './calculations';
import { BuilderEnvironmentContext } from './BuilderEnvironment';
import { defaultTabOptions } from '../../workspace/dormitories/customTabOptions';

export function TableSettings({
  draft,
  tabs,
  isNew,
  patch,
  withChildren,
  onWithChildren,
  childrenNames,
  onChildrenNames,
}: {
  draft: PersonnelTab;
  tabs: PersonnelTab[];
  isNew: boolean;
  patch: (value: Partial<PersonnelTab>) => void;
  withChildren: boolean;
  onWithChildren: (value: boolean) => void;
  childrenNames: string[];
  onChildrenNames: (value: string[]) => void;
}): JSX.Element {
  const environment = useContext(BuilderEnvironmentContext);
  const [demoTemplates] = useState(() => (environment ? [] : dormitoryTableTemplates()));
  const dormTemplates = environment
    ? environment.templates.map((tab) => ({
        label: tab.templateLabel,
        tab: { ...tab, tableOptions: { ...defaultTabOptions, ...tab.tableOptions } },
      }))
    : demoTemplates;
  const [source, setSource] = useState('');
  const ownTemplates = tabs.filter((tab) => tab.kind === 'table' && !tab.isGroup && !tab.archived);
  const choices = [
    ...ownTemplates.map((tab) => ({
      key: `personnel:${tab.id}`,
      label: `${tab.name} — Персонал`,
      tab,
    })),
    ...dormTemplates.map((template, index) => ({ ...template, key: `dorm:${index}` })),
  ];
  return (
    <>
      {draft.isGroup && (
        <p className={s.muted}>
          Настройки и столбцы группы служат образцом для новых подвкладок. Уже созданные таблицы
          настраиваются отдельно.
        </p>
      )}
      {isNew && (
        <fieldset className={s.column}>
          <legend>Основа и вложенные подвкладки</legend>
          <label>
            Основа таблицы
            <select
              value={source}
              onChange={(event) => {
                setSource(event.target.value);
                const selected = choices.find((choice) => choice.key === event.target.value);
                const template = selected
                  ? cloneTable(
                      selected.tab,
                      '',
                      selected.tab.tableOptions.table_format === 'calendar' &&
                        selected.tab.rows.some((row) => isComputed(row.rule)),
                      draft.id,
                    )
                  : null;
                patch(
                  template
                    ? {
                        columns: template.columns,
                        rows: template.rows,
                        tableOptions: template.tableOptions,
                        dateColumnId: template.dateColumnId,
                        description: draft.description || template.description,
                      }
                    : { columns: [newColumn()], rows: [], dateColumnId: null },
                );
              }}
            >
              <option value="">Новая структура</option>
              <optgroup label="Свои таблицы персонала">
                {choices
                  .filter((choice) => choice.key.startsWith('personnel:'))
                  .map((choice) => (
                    <option value={choice.key} key={choice.key}>
                      {choice.label}
                    </option>
                  ))}
              </optgroup>
              <optgroup label="Из вкладок общежитий">
                {choices
                  .filter((choice) => choice.key.startsWith('dorm:'))
                  .map((choice) => (
                    <option value={choice.key} key={choice.key}>
                      {choice.label}
                    </option>
                  ))}
              </optgroup>
            </select>
          </label>
          <p className={s.muted}>
            Копируются столбцы, формулы, связи и настройки. В календаре с расчётами переносятся
            также названия строк и их правила. Ручные значения остаются в исходной таблице.
          </p>
          {!draft.parentId && (
            <>
              <label className={s.check}>
                <input
                  type="checkbox"
                  checked={withChildren}
                  onChange={(event) => onWithChildren(event.target.checked)}
                />
                Создать вкладку с подвкладками
              </label>
              {withChildren && (
                <div className={s.editorBody}>
                  <p className={s.muted}>
                    У каждой подвкладки будет своя таблица с этой начальной структурой. Настройки и
                    записи можно менять отдельно.
                  </p>
                  {childrenNames.map((name, index) => (
                    <div className={s.toolbar} key={index}>
                      <label>
                        Название подвкладки {index + 1}
                        <input
                          required
                          maxLength={60}
                          value={name}
                          onChange={(event) =>
                            onChildrenNames(
                              childrenNames.map((old, i) =>
                                i === index ? event.target.value : old,
                              ),
                            )
                          }
                        />
                      </label>
                      <button
                        className="btn btn--quiet btn--compact"
                        type="button"
                        disabled={childrenNames.length === 1}
                        aria-label={`Убрать вложенную подвкладку ${index + 1}`}
                        onClick={() => onChildrenNames(childrenNames.filter((_, i) => i !== index))}
                      >
                        Убрать
                      </button>
                    </div>
                  ))}
                  <button
                    className="btn btn--outline btn--compact"
                    type="button"
                    onClick={() => onChildrenNames([...childrenNames, ''])}
                  >
                    + Ещё подвкладка
                  </button>
                </div>
              )}
            </>
          )}
        </fieldset>
      )}
      <CustomTabOptionsEditor
        value={draft.tableOptions}
        columns={draft.columns.map((column) => ({
          name: column.name,
          kind: column.kind,
          archived: column.archived,
        }))}
        dateColumnName={
          draft.columns.find((column) => column.id === draft.dateColumnId)?.name ?? null
        }
        onDateColumnName={(name) =>
          patch({
            dateColumnId:
              draft.columns.find(
                (column) => column.name === name && column.kind === 'date' && !column.archived,
              )?.id ?? null,
          })
        }
        onChange={(options) => {
          const next: Partial<PersonnelTab> = { tableOptions: options };
          if (
            options.table_format === 'list' &&
            options.period_mode !== 'none' &&
            (draft.tableOptions.period_mode === 'none' ||
              draft.tableOptions.table_format === 'calendar')
          ) {
            const date = draft.columns.find((column) => column.kind === 'date' && !column.archived);
            if (date) next.dateColumnId = date.id;
            else {
              const names = new Set(
                draft.columns.map((column) => column.name.trim().toLocaleLowerCase('ru')),
              );
              let name = 'Дата';
              let suffix = 2;
              while (names.has(name.toLocaleLowerCase('ru'))) name = `Дата ${suffix++}`;
              const added = { ...newColumn(), name, kind: 'date' as const };
              next.columns = [...draft.columns, added];
              next.dateColumnId = added.id;
            }
          }
          patch(next);
        }}
      />
    </>
  );
}

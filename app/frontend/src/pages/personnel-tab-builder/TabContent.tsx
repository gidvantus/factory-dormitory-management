import { BuilderEnvironmentContext } from './BuilderEnvironment';
import { WorkingTable } from '../../components/WorkingTable';
import { useContext, useState } from 'react';
import { useBuilderDraft } from './useBuilderDraft';
import type { Block, PersonnelData } from '../../api/personnel';
import { Modal } from '../../components/Modal';
import { EmployeeListFilters } from '../../workspace/personnel/EmployeeListFilterPanel';
import {
  employeeFieldValues,
  employeeListFields,
  sourceInScope,
} from '../../workspace/personnel/employeeListFilters';
import { filterPeople, personName } from '../../workspace/personnel/helpers';
import { PersonnelEmployeeFocus } from '../../workspace/personnel/PersonnelEmployeeFocus';
import { PersonnelWorkspaceBlock } from '../../workspace/personnel/PersonnelWorkspaceBlock';
import { BlockDialog } from '../../workspace/personnel/Dialogs';
import w from '../../workspace/personnel/PersonnelWorkspace.module.css';
import p from '../../workspace/personnel/Personnel.module.css';
import { move } from './model';
import type { PersonnelTab } from './model';
import s from './Tabs.module.css';

import { downloadCsv } from './csv';

export function PeopleContent({
  tab,
  data,
  onChange,
  onPerson,
}: {
  tab: PersonnelTab;
  data: PersonnelData;
  onChange: (tab: PersonnelTab) => void;
  onPerson: (id: string) => void;
}): JSX.Element {
  const environment = useContext(BuilderEnvironmentContext);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [showSelected, setShowSelected] = useState(false);
  const [page, setPage] = useState(0);
  const criteria = tab.criteria;
  const searched = new Set(
    filterPeople(data, { ...criteria, query: tab.actions.search ? query : '' }).map(
      (person) => person.id,
    ),
  );
  const rows = filterPeople(data, criteria).filter((person) => searched.has(person.id));
  const fields = employeeListFields(data, criteria).filter((field) =>
    tab.fields.includes(field.id),
  );
  const actualPage = Math.min(page, Math.max(0, Math.ceil(rows.length / 20) - 1));
  return (
    <div className={`${p.page} ${s.people}`}>
      <div className={s.toolbar}>
        <p className={s.muted}>
          В списке: <strong>{rows.length}</strong> сотрудников
        </p>
        <div className={s.buttons}>
          {tab.actions.search && (
            <input
              aria-label="Поиск сотрудника"
              placeholder="ФИО, табельный номер, телефон"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setPage(0);
              }}
            />
          )}
          {tab.actions.export && (
            <button
              type="button"
              className="btn btn--ghost btn--compact"
              onClick={() =>
                downloadCsv(
                  tab.name,
                  ['Сотрудник', ...fields.map((field) => field.label)],
                  rows
                    .filter((person) => !selected.length || selected.includes(person.id))
                    .map((person) => [
                      personName(person),
                      ...fields.map((field) =>
                        employeeFieldValues(person, field, data, criteria).join(' · '),
                      ),
                    ]),
                )
              }
            >
              Скачать CSV
            </button>
          )}
        </div>
      </div>
      {tab.actions.filters && (
        <details className={s.filters}>
          <summary>Условия списка</summary>
          <EmployeeListFilters
            data={data}
            criteria={criteria}
            fields={employeeListFields(data, criteria)}
            onChange={(rules) =>
              onChange({ ...tab, criteria: { ...tab.criteria, column_filters: rules } })
            }
          />
        </details>
      )}
      {selected.length > 0 && (
        <div className={s.selection}>
          <span>Выбрано: {selected.length}</span>
          <button className="btn btn--outline btn--compact" onClick={() => setShowSelected(true)}>
            Список выбранных
          </button>
          <button className="btn btn--quiet btn--compact" onClick={() => setSelected([])}>
            Снять выбор
          </button>
        </div>
      )}
      <PersonnelEmployeeFocus
        people={rows.slice(actualPage * 20, actualPage * 20 + 20).map((person) => ({
          ...person,
          current: person.current.filter((source) => sourceInScope(source, criteria)),
        }))}
        rows={rows}
        selected={selected}
        onSelection={setSelected}
        data={data}
        criteria={criteria}
        fields={fields}
        onPerson={onPerson}
      />
      {rows.length > 20 && (
        <div className={s.toolbar}>
          <span>
            {actualPage * 20 + 1}–{Math.min(rows.length, actualPage * 20 + 20)} из {rows.length}
          </span>
          <div className={s.buttons}>
            <button
              className="btn btn--ghost btn--compact"
              disabled={!actualPage}
              onClick={() => setPage(actualPage - 1)}
            >
              Назад
            </button>
            <button
              className="btn btn--ghost btn--compact"
              disabled={(actualPage + 1) * 20 >= rows.length}
              onClick={() => setPage(actualPage + 1)}
            >
              Далее
            </button>
          </div>
        </div>
      )}
      {showSelected && (
        <Modal
          title="Список выбранных сотрудников"
          testId="tab-selected-employees"
          onClose={() => setShowSelected(false)}
        >
          <div className={s.tableScroll}>
            <WorkingTable
              viewKey={environment ? `personnel/table-views/${tab.id}-selection` : undefined}
              className={s.table}
            >
              <thead>
                <tr>
                  <th>Сотрудник</th>
                  {fields.map((field) => (
                    <th key={field.id}>{field.label}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.employees
                  .filter((person) => selected.includes(person.id))
                  .map((person) => (
                    <tr key={person.id}>
                      <td>
                        <button
                          className="link-button"
                          onClick={() => {
                            setShowSelected(false);
                            onPerson(person.id);
                          }}
                        >
                          {personName(person)}
                        </button>
                      </td>
                      {fields.map((field) => (
                        <td key={field.id}>
                          {employeeFieldValues(person, field, data, criteria).join(' · ') || '—'}
                        </td>
                      ))}
                    </tr>
                  ))}
              </tbody>
            </WorkingTable>
          </div>
        </Modal>
      )}
    </div>
  );
}

export function BlocksContent({
  tab,
  data,
  onChange,
  onPerson,
  onEmployees,
  onPlanning,
}: {
  tab: PersonnelTab;
  data: PersonnelData;
  onChange: (tab: PersonnelTab) => void;
  onPerson: (id: string) => void;
  onEmployees: (criteria?: PersonnelTab['criteria']) => void;
  onPlanning: () => void;
}): JSX.Element {
  const [editor, setEditor] = useState<Block | 'new' | null>(null);
  useBuilderDraft(!!editor);
  const [configuring, setConfiguring] = useState(false);
  return (
    <div className={p.page}>
      <div className={s.toolbar}>
        <p className={s.muted}>Каждый блок настраивается отдельно.</p>
        <div className={s.buttons}>
          <button
            className="btn btn--ghost btn--compact"
            aria-pressed={configuring}
            onClick={() => setConfiguring(!configuring)}
          >
            {configuring ? 'Готово' : 'Расположение блоков'}
          </button>
          <button
            className="btn btn--primary btn--compact"
            disabled={tab.blocks.length >= 20}
            onClick={() => setEditor('new')}
          >
            + Добавить блок
          </button>
        </div>
      </div>
      <div className={w.grid}>
        {tab.blocks.map((block, index) => (
          <PersonnelWorkspaceBlock
            key={block.id}
            block={block}
            data={data}
            dormitory={null}
            configuring={configuring}
            busy={false}
            first={!index}
            last={index === tab.blocks.length - 1}
            onPerson={onPerson}
            onList={(criteria) => onEmployees(criteria)}
            onPlanning={onPlanning}
            onEdit={() => setEditor(block)}
            onMove={(step) => onChange({ ...tab, blocks: move(tab.blocks, index, step) })}
            onRemove={() =>
              onChange({ ...tab, blocks: tab.blocks.filter((item) => item.id !== block.id) })
            }
          />
        ))}
      </div>
      {!tab.blocks.length && (
        <div className={s.empty}>
          <strong>Добавьте первый блок</strong>
          <p>Например, контакты сотрудников или список заканчивающих вахту.</p>
        </div>
      )}
      {editor && (
        <BlockDialog
          block={editor === 'new' ? null : editor}
          data={data}
          onClose={() => setEditor(null)}
          onSave={async (block) =>
            onChange({
              ...tab,
              blocks:
                editor === 'new'
                  ? [...tab.blocks, block]
                  : tab.blocks.map((item) => (item.id === block.id ? block : item)),
            })
          }
        />
      )}
    </div>
  );
}

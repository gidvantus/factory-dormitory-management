import { useState } from 'react';
import type { Block, BlockKind, PersonnelData, SavedList } from '../../api/personnel';
import { Modal } from '../../components/Modal';
import { SubmitForm } from './Forms';
import { blockNames, dormName, filterPeople, names } from './helpers';
import s from './Personnel.module.css';

export function BlockDialog({
  block,
  data,
  onClose,
  onSave,
}: {
  block: Block | null;
  data: PersonnelData;
  onClose: () => void;
  onSave: (block: Block) => Promise<void>;
}): JSX.Element {
  const [draft, setDraft] = useState<Block>(
    block ?? {
      id: crypto.randomUUID(),
      kind: 'residents',
      title: blockNames.residents,
      scope: [],
      days: 5,
      limit: 4,
      wide: false,
      saved_list_id: null,
    },
  );
  return (
    <Modal
      title={block ? 'Настроить блок' : 'Добавить блок'}
      testId="personnel-block-editor"
      onClose={onClose}
      panelClassName={s.modal}
    >
      <SubmitForm
        label="Сохранить блок"
        onDone={onClose}
        onSubmit={(form) =>
          onSave({
            ...draft,
            title: String(form.get('title')).trim(),
            days: Number(form.get('days')) || draft.days,
            limit: Number(form.get('limit')) || draft.limit,
          })
        }
      >
        <label>
          Содержимое
          <select
            value={draft.kind}
            onChange={(event) => {
              const kind = event.target.value as BlockKind;
              setDraft({
                ...draft,
                kind,
                title: blockNames[kind],
                saved_list_id: kind === 'saved' ? (data.preferences.lists[0]?.id ?? null) : null,
              });
            }}
          >
            {Object.entries(blockNames).map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Название
          <input
            key={draft.kind}
            name="title"
            required
            maxLength={120}
            defaultValue={draft.title}
          />
        </label>
        {draft.kind === 'saved' && (
          <label>
            Сохранённый список
            <select
              required
              value={draft.saved_list_id ?? ''}
              onChange={(event) =>
                setDraft({ ...draft, saved_list_id: event.target.value || null })
              }
            >
              <option value="">Выберите список</option>
              {data.preferences.lists.map((list) => (
                <option key={list.id} value={list.id}>
                  {list.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <div className={s.formGrid}>
          <label>
            Период, дней
            <input type="number" name="days" min={1} max={365} required defaultValue={draft.days} />
          </label>
          <label>
            Количество строк
            <input
              type="number"
              name="limit"
              min={1}
              max={20}
              required
              defaultValue={draft.limit}
            />
          </label>
        </div>
        <fieldset className={s.checks}>
          <legend>Общежития блока</legend>
          <label>
            <input
              type="checkbox"
              checked={!draft.scope.length}
              onChange={() => setDraft({ ...draft, scope: [] })}
            />
            Все общежития
          </label>
          {data.dormitories.map((dorm) => (
            <label key={dorm.id}>
              <input
                type="checkbox"
                checked={draft.scope.includes(dorm.id)}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    scope: event.target.checked
                      ? [...draft.scope, dorm.id]
                      : draft.scope.filter((id) => id !== dorm.id),
                  })
                }
              />
              {dorm.name}
              {dorm.is_archived ? ' · архив' : ''}
            </label>
          ))}
        </fieldset>
        <label className={s.radio}>
          <input
            type="checkbox"
            checked={draft.wide}
            onChange={(event) => setDraft({ ...draft, wide: event.target.checked })}
          />
          На всю ширину рабочей поверхности
        </label>
        <p className={s.hint}>
          Настройки сохраняются в вашем аккаунте. Фильтр общежития на странице дополнительно
          ограничивает содержимое блока.
        </p>
      </SubmitForm>
    </Modal>
  );
}
export function SaveListDialog({
  criteria,
  data,
  onClose,
  onSave,
}: {
  criteria: Omit<SavedList, 'id' | 'name'>;
  data: PersonnelData;
  onClose: () => void;
  onSave: (list: SavedList, pin: boolean) => Promise<void>;
}): JSX.Element {
  return (
    <Modal
      title="Сохранить свой список"
      testId="personnel-save-list"
      onClose={onClose}
      panelClassName={s.modal}
    >
      <SubmitForm
        label="Сохранить список"
        onDone={onClose}
        onSubmit={(form) =>
          onSave(
            { ...criteria, id: crypto.randomUUID(), name: String(form.get('name')).trim() },
            !!form.get('pin'),
          )
        }
      >
        <label>
          Название списка
          <input name="name" maxLength={120} required defaultValue={names[criteria.filter]} />
        </label>
        <p>
          {names[criteria.filter]} · {filterPeople(data, criteria).length} в выборке
        </p>
        <p className={s.hint}>
          {criteria.dormitory == null ? 'Все общежития' : dormName(data, criteria.dormitory)} · до{' '}
          {criteria.days} дней. Сохраняются условия; состав обновляется автоматически.
        </p>
        <label className={s.radio}>
          <input type="checkbox" name="pin" defaultChecked />
          Закрепить блоком на рабочей поверхности
        </label>
      </SubmitForm>
    </Modal>
  );
}

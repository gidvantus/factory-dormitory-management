import { useState } from 'react';
import { personnelApi } from '../../api/personnel';
import type { Employee, Match, PersonnelData } from '../../api/personnel';
import { Modal } from '../../components/Modal';
import { SubmitForm } from './Forms';
import type { Mutate } from './Forms';
import { dormName, personName } from './helpers';
import type { ProfileTab } from './PersonnelProfile';
import s from './Personnel.module.css';

export type OpenPerson = (id: string, tab?: ProfileTab) => void;
export function MatchesBoard({
  data,
  dormitory,
  onPerson,
  mutate,
}: {
  data: PersonnelData;
  dormitory: number | null;
  onPerson: OpenPerson;
  mutate: Mutate;
}): JSX.Element {
  const [review, setReview] = useState<Match | null>(null);
  const pairs = data.matches.filter(
    (match) =>
      dormitory == null ||
      data.employees.some(
        (person) =>
          [match.source_id, match.target_id].includes(person.id) &&
          person.sources.some((source) => source.dormitory_id === dormitory),
      ),
  );
  return (
    <section className={s.board} data-testid="personnel-matches">
      <div className={s.toolbar}>
        <div>
          <span className={s.eyebrow}>ЦЕЛОСТНАЯ ИСТОРИЯ</span>
          <h2>Проверка совпадений</h2>
          <p className={s.hint}>
            Сравните сведения перед связыванием. Одной фамилии или табельного номера недостаточно.
          </p>
        </div>
        <span className={s.badge}>Ожидают проверки: {pairs.length}</span>
      </div>
      <div className={s.comparison}>
        {pairs.map((match) => {
          const source = data.employees.find((person) => person.id === match.source_id);
          const target = data.employees.find((person) => person.id === match.target_id);
          if (!source || !target) return null;
          return (
            <article key={`${match.source_id}-${match.target_id}`}>
              <span className={s.badge}>
                {match.score >= 80 ? 'Несколько совпадающих признаков' : 'Нужна ручная проверка'}
              </span>
              <div className={s.comparisonPair}>
                {[source, target].map((person, index) => (
                  <div key={person.id}>
                    <button className={s.linkButton} onClick={() => onPerson(person.id)}>
                      {personName(person)}
                    </button>
                    <p>
                      Т/н {person.personnel_number ?? '—'} · {person.phone ?? 'Телефон не указан'}
                    </p>
                    <p>
                      {[
                        ...new Set(
                          person.sources.map((record) => dormName(data, record.dormitory_id)),
                        ),
                      ].join(' · ') || 'Есть сохранённая история'}
                    </p>
                    {index === 0 && <small>Первая карточка</small>}
                  </div>
                ))}
              </div>
              <p className={s.hint}>{match.evidence.join(' · ')}</p>
              {match.differences.length > 0 && (
                <p className={s.warning}>{match.differences.join(' · ')}</p>
              )}
              <button onClick={() => setReview(match)}>Сравнить карточки →</button>
            </article>
          );
        })}
      </div>
      {!pairs.length && <p className={s.empty}>Совпадений для проверки нет.</p>}
      {review && (
        <MatchDialog match={review} data={data} mutate={mutate} onClose={() => setReview(null)} />
      )}
    </section>
  );
}
function MatchDialog({
  match,
  data,
  mutate,
  onClose,
}: {
  match: Match;
  data: PersonnelData;
  mutate: Mutate;
  onClose: () => void;
}): JSX.Element | null {
  const left = data.employees.find((person) => person.id === match.source_id);
  const right = data.employees.find((person) => person.id === match.target_id);
  const [target, setTarget] = useState(match.target_id);
  const [action, setAction] = useState('merge');
  const identities: (keyof Pick<Employee, 'full_name' | 'personnel_number' | 'phone'>)[] = [
    'full_name',
    'personnel_number',
    'phone',
  ];
  if (!left || !right) return null;
  return (
    <Modal
      title="Сравнить карточки сотрудника"
      testId="personnel-match-review"
      onClose={onClose}
      panelClassName={s.modal}
    >
      <div className={s.tableScroll}>
        <table className={s.table}>
          <thead>
            <tr>
              <th>Данные</th>
              <th>Первая карточка</th>
              <th>Вторая карточка</th>
            </tr>
          </thead>
          <tbody>
            {identities.map((field, index) => (
              <tr key={field}>
                <th>{['ФИО', 'Табельный номер', 'Телефон'][index]}</th>
                {[left, right].map((person) => (
                  <td key={person.id}>
                    <strong>{person[field] || '—'}</strong>
                    {(person.variants[field]?.length ?? 0) > 1 && (
                      <small>Варианты: {person.variants[field]?.join(' · ')}</small>
                    )}
                  </td>
                ))}
              </tr>
            ))}
            <tr>
              <th>Проживание</th>
              {[left, right].map((person) => (
                <td key={person.id}>
                  {person.current
                    .map((source) => dormName(data, source.dormitory_id))
                    .join(' · ') || 'Сейчас не проживает'}
                </td>
              ))}
            </tr>
            <tr>
              <th>Источники</th>
              {[left, right].map((person) => (
                <td key={person.id}>
                  {person.sources.map((source) => (
                    <small key={`${source.table_key}-${source.row_id}`}>
                      {dormName(data, source.dormitory_id)} · {source.source_name}
                    </small>
                  ))}
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>
      <SubmitForm
        label={action === 'merge' ? 'Связать карточки' : 'Подтвердить: разные сотрудники'}
        onDone={onClose}
        onSubmit={(form) =>
          mutate(() =>
            action === 'merge'
              ? personnelApi.merge(
                  {
                    ...match,
                    source_id: target === right.id ? left.id : right.id,
                    target_id: target,
                  },
                  String(form.get('reason')).trim(),
                )
              : personnelApi.separate(match, String(form.get('reason')).trim()),
          )
        }
      >
        <label>
          Результат проверки
          <select value={action} onChange={(event) => setAction(event.target.value)}>
            <option value="merge">Это один человек — связать историю</option>
            <option value="separate">Это разные сотрудники</option>
          </select>
        </label>
        {action === 'merge' && (
          <>
            <label>
              Основная карточка
              <select value={target} onChange={(event) => setTarget(event.target.value)}>
                {[left, right].map((person) => (
                  <option key={person.id} value={person.id}>
                    {personName(person)} · Т/н {person.personnel_number ?? '—'} ·{' '}
                    {person.current
                      .map((source) => dormName(data, source.dormitory_id))
                      .join(', ') || 'Без текущего проживания'}
                  </option>
                ))}
              </select>
            </label>
            <p className={s.hint}>
              Исходные значения, история, заметки и планы сохранятся. Данные основной карточки
              останутся основными. Объединение можно отменить в её истории.
            </p>
          </>
        )}
        <label>
          Основание решения
          <textarea
            name="reason"
            maxLength={1000}
            required
            placeholder="Например, данные сверены с сотрудником"
          />
        </label>
      </SubmitForm>
    </Modal>
  );
}

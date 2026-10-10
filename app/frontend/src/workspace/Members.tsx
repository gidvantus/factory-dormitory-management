import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';

import { api, ApiError } from '../api/client';
import type { InviteRole, OrganizationMember } from '../api/client';
import styles from './Workspace.module.css';

/** Роль в базе хранится кодом, а человеку показывается словом. */
const ROLE_LABELS: Record<string, string> = {
  owner: 'Владелец',
  admin: 'Администратор',
  manager: 'Менеджер',
  commandant: 'Комендант',
  member: 'Сотрудник',
};

/** Роли, которые можно выбрать при приглашении: `owner` и `member` — не выдаются. */
const INVITE_ROLES: { value: InviteRole; label: string }[] = [
  { value: 'admin', label: 'Администратор' },
  { value: 'manager', label: 'Менеджер' },
  { value: 'commandant', label: 'Комендант' },
];

const DEFAULT_INVITE_ROLE: InviteRole = 'manager';

const STATUS_ACTIVE = 'Активирован';
const STATUS_INVITED = 'Приглашение отправлено';

function roleLabel(role: string): string {
  return ROLE_LABELS[role] ?? role;
}

function statusLabel(member: OrganizationMember): string {
  return member.is_active ? STATUS_ACTIVE : STATUS_INVITED;
}

/**
 * Сотрудники организации: список участников и форма приглашения.
 *
 * Роль здесь — только данные для отображения: прав по ней не проверяет ни
 * сервер, ни этот экран. Формат email и ФИО проверяет сервер, а его текст (409
 * на занятый адрес, 422 на поля и роль) показывается пользователю как есть —
 * по той же причине, что и на странице организации.
 */
export function Members(): JSX.Element {
  const [members, setMembers] = useState<OrganizationMember[]>([]);
  const [status, setStatus] = useState<'loading' | 'ready' | 'not-linked' | 'error'>('loading');
  const [attempt, setAttempt] = useState(0);
  const [email, setEmail] = useState('');
  const [fullName, setFullName] = useState('');
  const [role, setRole] = useState<InviteRole>(DEFAULT_INVITE_ROLE);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState('');
  const [sendError, setSendError] = useState('');
  const inFlight = useRef(false);
  const emailRef = useRef<HTMLInputElement>(null);
  const fullNameRef = useRef<HTMLInputElement>(null);
  // Куда вернуть фокус после отправки: пока идёт запрос, кнопка задизейблена и
  // фокус с неё слетает на `<body>`.
  const focusAfterSend = useRef<'email' | 'full_name' | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setStatus('loading');
    void api
      .members(controller.signal)
      .then((value) => {
        if (controller.signal.aborted) return;
        setMembers(value);
        setStatus('ready');
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        // 404 — пользователь не привязан к организации: форма приглашения тут
        // не поможет, поэтому состояние отдельное от сбоя загрузки.
        setStatus(error instanceof ApiError && error.status === 404 ? 'not-linked' : 'error');
      });
    return () => controller.abort();
  }, [attempt]);

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (inFlight.current) return;
    inFlight.current = true;
    setSending(true);
    setSent('');
    setSendError('');
    try {
      const created = await api.inviteMember({ email, full_name: fullName, role });
      setMembers((current) => [...current, created]);
      setEmail('');
      setFullName('');
      setRole(DEFAULT_INVITE_ROLE);
      setSent(`Приглашение отправлено на ${created.email}.`);
      focusAfterSend.current = 'email';
    } catch (error) {
      setSendError(inviteErrorMessage(error));
      focusAfterSend.current = fieldForError(error);
    } finally {
      inFlight.current = false;
      setSending(false);
      const target = focusAfterSend.current;
      focusAfterSend.current = null;
      // Кадр нужен потому, что сразу после `setSending(false)` поля ещё
      // задизейблены, а задизейбленный элемент фокус не принимает.
      window.requestAnimationFrame(() => {
        const field = target === 'full_name' ? fullNameRef.current : emailRef.current;
        field?.focus({ preventScroll: true });
      });
    }
  }

  return (
    <section aria-labelledby="members-title" data-testid="members-page">
      <div className={styles['page-heading']}>
        <div>
          <p className={styles.eyebrow}>Рабочее пространство</p>
          <h1 id="members-title" tabIndex={-1}>
            Сотрудники
          </h1>
          <p className={styles.subtitle}>Пригласите сотрудника и выберите его роль</p>
        </div>
      </div>

      {status === 'loading' && (
        <p className={styles['view-note']} role="status" data-testid="members-loading">
          Загружаем сотрудников…
        </p>
      )}

      {status === 'not-linked' && (
        <section
          className={styles['profile-card']}
          aria-labelledby="members-not-linked-title"
          data-testid="members-not-linked"
        >
          <div className={styles['profile-intro']}>
            <div>
              <h2 id="members-not-linked-title">Организация не привязана</h2>
              <p>
                Список сотрудников появится, когда учётная запись будет привязана к организации.
              </p>
            </div>
          </div>
        </section>
      )}

      {status === 'error' && (
        <div className={styles['organization-error']} role="alert" data-testid="members-error">
          <p>Не удалось загрузить список сотрудников.</p>
          <button type="button" onClick={() => setAttempt((value) => value + 1)}>
            Повторить
          </button>
        </div>
      )}

      {status === 'ready' && (
        <>
          <section
            className={styles['table-card']}
            aria-labelledby="members-table-title"
            data-testid="members-table"
          >
            <div className={styles['table-heading']}>
              <h2 id="members-table-title">Участники организации</h2>
              <p className={styles['table-meta']} data-testid="members-count">
                {members.length} чел.
              </p>
            </div>
            <div className={styles['table-scroll']}>
              <table className={styles['members-table']}>
                <caption className="visually-hidden">Участники организации</caption>
                <thead>
                  <tr>
                    <th scope="col">ФИО</th>
                    <th scope="col">Email</th>
                    <th scope="col">Роль</th>
                    <th scope="col">Статус</th>
                  </tr>
                </thead>
                <tbody>
                  {members.map((member) => (
                    <tr key={member.id} data-testid="member-row">
                      <td data-testid="member-name">
                        <span className={styles.person}>{member.full_name}</span>
                      </td>
                      <td className={styles['muted-cell']} data-testid="member-email">
                        {member.email}
                      </td>
                      <td data-testid="member-role">{roleLabel(member.role)}</td>
                      <td>
                        <span
                          className={`${styles.tag} ${
                            member.is_active ? styles['tag--ok'] : styles['tag--wait']
                          }`}
                          data-testid="member-status"
                          data-active={String(member.is_active)}
                        >
                          {statusLabel(member)}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section
            className={`${styles['profile-card']} ${styles['invite-card']}`}
            aria-labelledby="invite-title"
            data-testid="invite-card"
          >
            <div className={styles['profile-intro']}>
              <div>
                <h2 id="invite-title">Пригласить сотрудника</h2>
                <p>
                  Мы отправим письмо со ссылкой: по ней сотрудник задаст пароль и войдёт в вашу
                  организацию.
                </p>
              </div>
            </div>
            <form
              className={`${styles['organization-form']} ${styles['invite-form']}`}
              noValidate
              aria-busy={sending}
              onSubmit={(event) => void submit(event)}
            >
              <div className="field">
                <label className="field__label" htmlFor="invite-email">
                  Email
                </label>
                <input
                  className="field__input"
                  id="invite-email"
                  data-testid="invite-email"
                  ref={emailRef}
                  type="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  maxLength={320}
                  disabled={sending}
                  placeholder="novyi@example.com"
                  aria-describedby="invite-email-hint"
                />
                <p className={styles['organization-hint']} id="invite-email-hint">
                  На этот адрес уйдёт письмо-приглашение.
                </p>
              </div>

              <div className="field">
                <label className="field__label" htmlFor="invite-full-name">
                  ФИО
                </label>
                <input
                  className="field__input"
                  id="invite-full-name"
                  data-testid="invite-full-name"
                  ref={fullNameRef}
                  value={fullName}
                  onChange={(event) => setFullName(event.target.value)}
                  maxLength={255}
                  disabled={sending}
                  placeholder="Например, Петров Пётр"
                />
              </div>

              <div className="field">
                <label className="field__label" htmlFor="invite-role">
                  Роль
                </label>
                <select
                  className="field__input"
                  id="invite-role"
                  data-testid="invite-role"
                  value={role}
                  onChange={(event) => setRole(event.target.value as InviteRole)}
                  disabled={sending}
                >
                  {INVITE_ROLES.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
                <p className={styles['organization-hint']} id="invite-role-hint">
                  Роль показывается в списке сотрудников.
                </p>
              </div>

              {sent && (
                <p className="alert alert--ok" role="status" data-testid="invite-success">
                  {sent}
                </p>
              )}
              {sendError && (
                <p className="alert alert--error" role="alert" data-testid="invite-error">
                  {sendError}
                </p>
              )}

              <button
                className="btn btn--primary"
                type="submit"
                disabled={sending}
                data-testid="invite-submit"
              >
                {sending ? 'Отправляем…' : 'Пригласить'}
              </button>
            </form>
          </section>
        </>
      )}
    </section>
  );
}

/** 401 — это конец сессии, а не отказ валидации: текст должен отличаться. */
function inviteErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    return error.status === 401 ? 'Сессия завершилась. Войдите в аккаунт снова.' : error.message;
  }
  return 'Не удалось отправить приглашение. Проверьте соединение и попробуйте ещё раз.';
}

/**
 * Куда вернуть фокус при ошибке отправки.
 *
 * Поле определяется по имени в тексте сервера (`email: …`, `full_name: …`), как
 * на странице организации. Если поле не названо (например, 409 про занятый
 * адрес), возвращаемся на первое — там начинается форма.
 */
function fieldForError(error: unknown): 'email' | 'full_name' {
  if (error instanceof ApiError && /(?:^|[\s;])full_name\s*:/i.test(error.message)) {
    return 'full_name';
  }
  return 'email';
}

import { useSession } from '../auth/SessionProvider';
import { userInitials } from './userInitials';
import { WorkspaceIcon } from './WorkspaceIcon';
import styles from './Workspace.module.css';

export function PersonalData(): JSX.Element {
  const { user } = useSession();

  return (
    <section aria-labelledby="profile-title" data-testid="personal-data-page">
      <div className="page-head">
        <div>
          <p className={styles.eyebrow}>Учётная запись</p>
          <h1 id="profile-title" tabIndex={-1}>
            Личные данные
          </h1>
          <p className={styles.subtitle}>Данные, указанные при регистрации</p>
        </div>
      </div>
      <section className={styles['profile-card']} aria-labelledby="profile-card-title">
        <div className={styles['profile-intro']}>
          <span className={styles['profile-avatar']} aria-hidden="true">
            {userInitials(user?.full_name ?? '')}
          </span>
          <div>
            <h2 id="profile-card-title">{user?.full_name}</h2>
            <p>Ваша учётная запись</p>
          </div>
        </div>
        <dl className={styles['profile-details']}>
          <div className={styles['profile-row']}>
            <dt>ФИО</dt>
            <dd data-testid="cabinet-full-name">{user?.full_name}</dd>
          </div>
          <div className={styles['profile-row']}>
            <dt>Email</dt>
            <dd data-testid="cabinet-email">{user?.email}</dd>
          </div>
        </dl>
        <div className={styles['profile-security']}>
          <WorkspaceIcon name="lock" />
          <p>
            <strong>Пароль вашей учётной записи</strong>Пароль выдан при регистрации. В открытом
            виде он не хранится и повторно не показывается.
          </p>
        </div>
      </section>
    </section>
  );
}

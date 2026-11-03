import { useId } from 'react';
import type { ReactNode } from 'react';
import { useOrganizedEditor } from './useOrganizedEditor';
import styles from './EditorSection.module.css';

/** Смысловая группа включается только в тестовом варианте организации окон. */
export function EditorSection({
  title,
  description,
  children,
  tone = 'normal',
}: {
  title: string;
  description?: string;
  children: ReactNode;
  tone?: 'normal' | 'danger';
}): JSX.Element {
  const organized = useOrganizedEditor();
  const id = useId();
  if (!organized) return <>{children}</>;
  return (
    <section
      id={id}
      className={styles.section}
      data-editor-section={title}
      data-section-tone={tone}
      aria-labelledby={`${id}-title`}
    >
      <header>
        <h3 id={`${id}-title`}>{title}</h3>
        {description && <p>{description}</p>}
      </header>
      <div className={styles.fields}>{children}</div>
    </section>
  );
}

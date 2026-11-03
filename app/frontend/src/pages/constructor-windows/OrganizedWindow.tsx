import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import s from './OrganizedWindow.module.css';

type SectionLink = { id: string; title: string };
const nativeNavigation = new Set([
  'dormitory-settings-modal',
  'arrival-settings-dialog',
  'statistics-block-window',
]);

export function OrganizedWindow({
  editorId,
  children,
}: {
  editorId: string;
  children: ReactNode;
}): JSX.Element {
  const content = useRef<HTMLDivElement>(null);
  const [sections, setSections] = useState<SectionLink[]>([]);
  const [active, setActive] = useState('');
  useEffect(() => {
    const root = content.current;
    if (!root) return;
    const update = (): void => {
      const dialog = root.closest('[role="dialog"]');
      const nodes = [...root.querySelectorAll<HTMLElement>('[data-editor-section]')].filter(
        (node) =>
          node.closest('[role="dialog"]') === dialog &&
          !node.parentElement?.closest('[data-editor-section]'),
      );
      const next = nodes.map((node) => ({ id: node.id, title: node.dataset.editorSection! }));
      setSections((old) => (JSON.stringify(old) === JSON.stringify(next) ? old : next));
      setActive((current) =>
        next.some((section) => section.id === current) ? current : (next[0]?.id ?? ''),
      );
    };
    update();
    const observer = new MutationObserver(update);
    observer.observe(root, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [editorId]);
  const navigation = sections.length > 1 && !nativeNavigation.has(editorId);
  return (
    <div className={s.layout} data-editor-organizer="true" data-has-navigation={String(navigation)}>
      {navigation && (
        <nav className={s.navigation} aria-label="Разделы конструктора">
          <p>В этом окне</p>
          {sections.map((section, index) => (
            <button
              key={section.id}
              type="button"
              className="btn btn--quiet btn--compact"
              aria-pressed={(active || sections[0]?.id) === section.id}
              onClick={() => {
                const target = document.getElementById(section.id);
                target?.scrollIntoView({ block: 'start', behavior: 'instant' });
                setActive(section.id);
              }}
            >
              <span>{index + 1}</span>
              {section.title}
            </button>
          ))}
          <small>Все настройки сохраняются одной кнопкой.</small>
        </nav>
      )}
      <div
        className={s.content}
        ref={content}
        onScroll={() => {
          const root = content.current;
          if (!root) return;
          const top = root.getBoundingClientRect().top;
          const atEnd = root.scrollTop + root.clientHeight >= root.scrollHeight - 3;
          const selected = atEnd
            ? sections.at(-1)
            : sections
                .filter(
                  (section) =>
                    (document.getElementById(section.id)?.getBoundingClientRect().top ??
                      Infinity) <=
                    top + 70,
                )
                .at(-1);
          if (selected) setActive(selected.id);
        }}
      >
        {children}
      </div>
    </div>
  );
}

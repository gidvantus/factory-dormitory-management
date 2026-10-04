import { useEffect } from 'react';

/**
 * Мягкое появление блоков с классом `reveal` при прокрутке — как в прототипе
 * лендинга. Без IntersectionObserver (тесты, старые браузеры) и при
 * `prefers-reduced-motion: reduce` блоки показываются сразу.
 */
export function useReveal(): void {
  useEffect(() => {
    const root = document.documentElement;
    root.classList.add('js');

    const items = Array.from(document.querySelectorAll<HTMLElement>('.reveal'));
    const reduceMotion =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    if (typeof IntersectionObserver === 'undefined' || reduceMotion) {
      items.forEach((element) => element.classList.add('is-visible'));
      return () => root.classList.remove('js');
    }

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add('is-visible');
            observer.unobserve(entry.target);
          }
        });
      },
      { rootMargin: '0px 0px -8% 0px', threshold: 0.08 },
    );

    items.forEach((element) => observer.observe(element));
    return () => {
      observer.disconnect();
      root.classList.remove('js');
    };
  }, []);
}

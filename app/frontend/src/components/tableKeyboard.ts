import type { KeyboardEvent } from 'react';

export function navigateTable(event: KeyboardEvent<HTMLTableElement>): void {
  if (
    event.defaultPrevented ||
    event.altKey ||
    event.ctrlKey ||
    event.metaKey ||
    event.shiftKey ||
    event.nativeEvent.isComposing ||
    !['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Enter'].includes(event.key)
  )
    return;
  const target = event.target;
  if (!(
    target instanceof HTMLInputElement ||
    target instanceof HTMLSelectElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLTableCellElement ||
    (target instanceof HTMLElement && target.hasAttribute('data-table-edit-trigger'))
  ))
    return;
  if (target instanceof HTMLTextAreaElement && event.key === 'Enter') return;
  const cell = target.closest<HTMLTableCellElement>('td,th');
  const row = cell?.parentElement as HTMLTableRowElement | null;
  if (!cell || !row || !row.closest('tbody')) return;
  const rows = Array.from(event.currentTarget.tBodies)
    .flatMap((body) => Array.from(body.rows))
    .filter((item) => !item.hidden);
  let y = rows.indexOf(row),
    x = cell.cellIndex;
  const vertical = ['ArrowUp', 'ArrowDown', 'Enter'].includes(event.key);
  const delta = ['ArrowUp', 'ArrowLeft'].includes(event.key) ? -1 : 1;
  while (true) {
    if (vertical) y += delta;
    else x += delta;
    const nextRow = rows[y];
    if (!nextRow) return;
    const next = nextRow.cells[x];
    if (!next) return;
    const editor = next.querySelector<HTMLElement>(
      'input:not([type="hidden"]), select, textarea, [data-table-edit-trigger]',
    );
    if (!editor || editor.matches(':disabled') || ('readOnly' in editor && editor.readOnly))
      continue;
    event.preventDefault();
    if (editor.hasAttribute('data-table-edit-trigger')) {
      editor.click();
      return;
    }
    editor.focus();
    if (
      editor instanceof HTMLInputElement &&
      ['text', 'search', 'tel', 'url', 'email'].includes(editor.type)
    )
      editor.select();
    editor.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    return;
  }
}

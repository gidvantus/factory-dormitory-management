export type SortValue = string | number | null;
export interface TableSort {
  column: string;
  direction: 'ascending' | 'descending';
}

const alphabet = new Intl.Collator('ru', { numeric: true, sensitivity: 'base' });

export function compareTableValues(
  a: SortValue,
  b: SortValue,
  direction: TableSort['direction'],
): number {
  // Пустые ячейки остаются в конце при обоих направлениях.
  if (a === null || b === null) return a === b ? 0 : a === null ? 1 : -1;
  const result =
    typeof a === 'number' && typeof b === 'number' ? a - b : alphabet.compare(String(a), String(b));
  return direction === 'ascending' ? result : -result;
}

export function tableCellValue(cell: HTMLTableCellElement, kind?: string): SortValue {
  const editor = cell.querySelector<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(
    'input:not([type="hidden"]),select,textarea',
  );
  if (editor instanceof HTMLInputElement && editor.type === 'checkbox')
    return Number(editor.checked);
  if (editor instanceof HTMLSelectElement && !editor.value) return null;
  const copy = cell.cloneNode(true) as HTMLElement;
  copy
    .querySelectorAll(
      '[data-table-tool],[data-table-fixed-controls],[hidden],[role="dialog"],[role="menu"],sup.table-rule-mark,[aria-hidden="true"],[role="status"],[role="alert"]',
    )
    .forEach((node) => node.remove());
  const text = (
    cell.dataset.sortValue ??
    (editor instanceof HTMLSelectElement
      ? editor.selectedOptions[0]?.textContent
      : editor?.value) ??
    copy.textContent ??
    ''
  ).trim();
  if (!text || text === '—') return null;
  const numeric = text.replace(/[\s\u00a0\u202f]/g, '').replace(',', '.');
  if (
    kind === 'number' ||
    (editor instanceof HTMLInputElement && editor.type === 'number') ||
    /^[-+]?\d+(?:[.,]\d+)?$/.test(numeric)
  ) {
    const value = Number(numeric);
    if (Number.isFinite(value)) return value;
  }
  const date = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(text);
  if (date) return `${date[3]}-${date[2]}-${date[1]}`;
  return text;
}

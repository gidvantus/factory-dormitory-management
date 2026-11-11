import { flushSync } from 'react-dom';

export interface TablePasteCell {
  cell: HTMLTableCellElement;
  value: string;
}

type CellEditor = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;

export function bodyCell(
  table: HTMLTableElement,
  target: EventTarget,
): HTMLTableCellElement | null {
  if (!(target instanceof Element)) return null;
  const cell = target.closest<HTMLTableCellElement>('td,th');
  return cell?.closest('table') === table && cell.parentElement?.parentElement?.tagName === 'TBODY'
    ? cell
    : null;
}

export function parseClipboardGrid(text: string): string[][] {
  const source = text.replace(/\r\n?/g, '\n');
  const rows: string[][] = [];
  let row: string[] = [];
  let value = '';
  let quoted = false;
  for (let index = 0; index < source.length; index++) {
    const character = source[index];
    if (quoted) {
      if (character === '"' && source[index + 1] === '"') {
        value += '"';
        index++;
      } else if (character === '"') {
        quoted = false;
      } else {
        value += character;
      }
    } else if (character === '"' && (index === 0 || ['\t', '\n'].includes(source[index - 1]))) {
      quoted = true;
    } else if (character === '\t' || character === '\n') {
      row.push(value);
      value = '';
      if (character === '\n') {
        rows.push(row);
        row = [];
        if (index === source.length - 1) return rows;
      }
    } else {
      value += character;
    }
  }
  if (quoted)
    return source
      .replace(/\n$/, '')
      .split('\n')
      .map((line) => line.split('\t'));
  rows.push([...row, value]);
  return rows;
}

function withinCell<T extends HTMLElement>(cell: HTMLTableCellElement, selector: string): T | null {
  return (
    Array.from(cell.querySelectorAll<T>(selector)).find(
      (element) =>
        element.closest('td,th') === cell && !element.closest('[hidden], [role="dialog"]'),
    ) ?? null
  );
}

function cellEditor(cell: HTMLTableCellElement): CellEditor | null {
  return withinCell(cell, 'input:not([type="hidden"]),textarea,select:not([multiple])');
}

function editTrigger(cell: HTMLTableCellElement): HTMLElement | null {
  return withinCell(cell, '[data-table-edit-trigger]:not(:disabled)');
}

function writable(editor: CellEditor): boolean {
  return (
    !editor.matches(':disabled') &&
    !('readOnly' in editor && editor.readOnly) &&
    (!(editor instanceof HTMLInputElement) ||
      ['text', 'tel', 'search', 'url', 'email', 'number', 'date', 'checkbox'].includes(editor.type))
  );
}

export function pasteTargets(
  table: HTMLTableElement,
  start: HTMLTableCellElement,
  grid: string[][],
): TablePasteCell[] {
  const rows = Array.from(table.tBodies)
    .flatMap((body) => Array.from(body.rows))
    .filter((row) => !row.hidden);
  const top = rows.indexOf(start.parentElement as HTMLTableRowElement);
  const left = start.cellIndex;
  if (top < 0 || start.colSpan !== 1 || start.rowSpan !== 1) return [];
  const targets: TablePasteCell[] = [];
  grid.forEach((line, offset) => {
    const row = rows[top + offset];
    if (!row || Array.from(row.cells).some((cell) => cell.colSpan !== 1 || cell.rowSpan !== 1))
      return;
    line.forEach((value, index) => {
      const cell = row.cells[left + index];
      if (!cell) return;
      const editor = cellEditor(cell);
      if (editor ? writable(editor) : editTrigger(cell)) targets.push({ cell, value });
    });
  });
  return targets;
}

const normalized = (value: string): string => value.trim().toLocaleLowerCase('ru');

export function ungroupClipboardNumber(value: string): string {
  const text = value.trim();
  return /^[+-]?\d{1,3}(?:[ \u00a0\u202f]\d{3})+(?:[.,]\d+)?$/.test(text)
    ? text.replace(/[ \u00a0\u202f]/g, '')
    : value;
}

function clipboardDate(value: string): string | null {
  const local = value.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/);
  const iso = local
    ? `${local[3]}-${local[2].padStart(2, '0')}-${local[1].padStart(2, '0')}`
    : value;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
  const date = new Date(`${iso}T00:00:00Z`);
  return Number.isFinite(date.valueOf()) && date.toISOString().slice(0, 10) === iso ? iso : null;
}

function clipboardValue(editor: CellEditor, text: string): string | boolean | null {
  if (text.includes('\0')) return null;
  const value = text.trim();
  if (editor instanceof HTMLSelectElement) {
    const options = Array.from(editor.options).filter(
      (option) => !option.matches(':disabled') && option.value !== '__new_reason__',
    );
    if (!value) return options.some((option) => !option.value) ? '' : null;
    const matches = options.filter((option) => normalized(option.text) === normalized(value));
    if (matches.length === 1) return matches[0].value;
    return options.find((option) => option.value === value)?.value ?? null;
  }
  if (editor instanceof HTMLInputElement) {
    if (editor.type === 'checkbox') {
      if (['1', 'да', 'true', '✓', 'истина'].includes(normalized(value))) return true;
      if (['', '0', 'нет', 'false', 'ложь'].includes(normalized(value))) return false;
      return null;
    }
    if (editor.type === 'date') return value ? clipboardDate(value) : '';
    if (editor.type === 'number' || ['decimal', 'numeric'].includes(editor.inputMode)) {
      if (!value) return '';
      const number = ungroupClipboardNumber(value).replace(',', '.').replace(/^\+/, '');
      const pattern = editor.inputMode === 'numeric' ? /^\d+$/ : /^-?(?:\d+(?:\.\d+)?|\.\d+)$/;
      if (!pattern.test(number) || !Number.isFinite(Number(number))) return null;
      if (
        (editor.min && Number(number) < Number(editor.min)) ||
        (editor.max && Number(number) > Number(editor.max))
      )
        return null;
      if (editor.type === 'number' && editor.step === '1' && !Number.isInteger(Number(number)))
        return null;
      return number;
    }
    if (text.includes('\n')) return null;
  }
  return editor.maxLength >= 0 && text.length > editor.maxLength ? null : text;
}

export function fillPastedCell({ cell, value }: TablePasteCell): boolean {
  if (!cell.isConnected) return false;
  let editor = cellEditor(cell);
  if (!editor) {
    const trigger = editTrigger(cell);
    if (!trigger) return false;
    flushSync(() => trigger.click());
    editor = cellEditor(cell);
  }
  if (!editor || !writable(editor)) return false;
  const control = editor;
  const next = clipboardValue(control, value);
  flushSync(() => control.focus({ preventScroll: true }));
  if (next === null || control.ownerDocument.activeElement !== control) {
    flushSync(() => control.blur());
    return false;
  }
  flushSync(() => {
    if (typeof next === 'boolean') {
      if (control instanceof HTMLInputElement && control.checked !== next) control.click();
    } else if (control.value !== next) {
      // Нативный setter позволяет React обработать вставку как обычное изменение поля.
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(control), 'value')?.set;
      setter?.call(control, next);
      control.dispatchEvent(
        new Event(control instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }),
      );
    }
  });
  const accepted =
    typeof next === 'boolean'
      ? control instanceof HTMLInputElement && control.checked === next
      : control.value === next;
  flushSync(() => control.blur());
  return accepted;
}

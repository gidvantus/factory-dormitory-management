import { OrderContext } from './workingTableContext';
import { navigateTable } from './tableKeyboard';
import { useTableZoom } from './useTableZoom';
import { bodyCell, fillPastedCell, parseClipboardGrid, pasteTargets } from './tablePaste';
import type { TablePasteCell } from './tablePaste';
import { compareTableValues, tableCellValue } from './tableSorting';
import type { SortValue, TableSort } from './tableSorting';
import {
  Children,
  Fragment,
  cloneElement,
  isValidElement,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import type { ClipboardEvent, ComponentPropsWithoutRef, ReactElement, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ApiError, request } from '../api/client';
import { Modal } from './Modal';
import { EditorSurfaceContext } from './EditorSurface';
import { emptyTableView, moveKey, orderedKeys, tableColors } from './workingTableModel';
import type { TableColor, TableView, TableViewState } from './workingTableModel';

interface ViewColumn {
  id: string;
  label: string;
  kind?: string;
  compact?: boolean;
}

export interface PagedTableRows {
  sort: TableSort | null;
  onSort: (sort: TableSort) => void;
  onOrderSaved: () => void;
}

interface RowMove {
  source: string;
  target: string;
  after: boolean;
}

const WIDTH_SAMPLE_SIZE = 30;

function rowsForWidth(table: HTMLTableElement): HTMLTableRowElement[] {
  const sample: HTMLTableRowElement[] = [];
  for (const body of table.tBodies) {
    for (const row of body.rows) {
      if (row.hidden || !row.cells.length || (row.cells.length === 1 && row.cells[0].colSpan > 1))
        continue;
      sample.push(row);
      if (sample.length === WIDTH_SAMPLE_SIZE) return sample;
    }
  }
  return sample;
}

function canGrow(column: ViewColumn): boolean {
  const label = column.label.trim();
  return (
    !!label &&
    !column.compact &&
    (!column.kind || ['text', 'textarea', 'employee'].includes(column.kind)) &&
    !/^(?:№|дата|статус|период|итого|действия)(?:\s|$)/iu.test(label)
  );
}
interface NodeProps {
  children?: ReactNode;
  index?: number;
  colSpan?: number;
  'data-row-key'?: string;
  'data-fixed-row'?: boolean;
}
function flatten(children: ReactNode): ReactElement<NodeProps>[] {
  return Children.toArray(children).flatMap((child) =>
    !isValidElement<NodeProps>(child)
      ? []
      : child.type === Fragment
        ? flatten(child.props.children)
        : [child],
  );
}
function nodeKey(node: ReactElement<NodeProps>, index: number): string {
  return String(node.props['data-row-key'] ?? node.key ?? index).replace(/^.*\$/, '');
}
function textOf(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  return Children.toArray(node)
    .map((item) => (isValidElement<NodeProps>(item) ? textOf(item.props.children) : ''))
    .join(' ');
}
function columnNodes(children: ReactNode): ReactElement<NodeProps>[] {
  const head = flatten(children).find((node) => node.type === 'thead');
  const row = head && flatten(head.props.children)[0];
  return row ? flatten(row.props.children) : [];
}

export function WorkingTable({
  viewKey: providedViewKey,
  zoomKey,
  revisionKey,
  columns: explicitColumns,
  configured = false,
  readOnly = false,
  pasteCells = false,
  pagedRows,
  sortable = true,
  children,
  className = '',
  style,
  ...props
}: ComponentPropsWithoutRef<'table'> & {
  viewKey?: string;
  zoomKey?: string;
  revisionKey?: string;
  columns?: ViewColumn[];
  configured?: boolean;
  readOnly?: boolean;
  pasteCells?: boolean | ((cells: TablePasteCell[]) => Promise<void>);
  pagedRows?: PagedTableRows;
  sortable?: boolean;
}): JSX.Element {
  const surface = useContext(EditorSurfaceContext);
  const viewKey = surface ? undefined : providedViewKey;
  const ref = useRef<HTMLTableElement>(null);
  const { scale, saveFailed: zoomSaveFailed } = useTableZoom(
    ref,
    surface ? undefined : (zoomKey ?? viewKey),
  );
  const originalBackgrounds = useRef(new WeakMap<HTMLTableCellElement, string>());
  const [view, setView] = useState<TableView>(emptyTableView);
  const [loaded, setLoaded] = useState(!viewKey);
  const [loadError, setLoadError] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [retry, setRetry] = useState(0);
  const [selected, setSelected] = useState<{
    axis: 'rows' | 'columns';
    key: string;
    label: string;
  } | null>(null);
  const [hosts, setHosts] = useState<
    { node: HTMLElement; axis: 'rows' | 'columns'; key: string; label: string }[]
  >([]);
  const [widths, setWidths] = useState<number[]>([]);
  const fitted = useRef<{ key: string; hasRows: boolean } | null>(null);
  const [localSort, setSort] = useState<TableSort | null>(null);
  const sort = pagedRows ? pagedRows.sort : localSort;
  const [sortValues, setSortValues] = useState<Record<string, Record<string, SortValue>>>({});
  const [pasteNotice, setPasteNotice] = useState('');
  const pasting = useRef(false);
  const drag = useRef<{ axis: 'rows' | 'columns'; key: string } | null>(null);
  const headings = columnNodes(children);
  const columns: ViewColumn[] =
    explicitColumns ??
    headings.map((node, index) => ({
      id: nodeKey(node, index),
      label: textOf(node.props.children),
    }));
  const originalKeys = columns.map((column) => column.id);
  const order = orderedKeys(originalKeys, view.state.columns);
  const body = flatten(children).find((node) => node.type === 'tbody');
  const bodyChildren = body ? flatten(body.props.children) : [];
  const movable = bodyChildren.filter(
    (node) =>
      !node.props['data-fixed-row'] &&
      !flatten(node.props.children).some((cell) => (cell.props.colSpan ?? 1) > 1),
  );
  const rowKeys = movable.map(nodeKey);
  const rowOrder = pagedRows ? rowKeys : orderedKeys(rowKeys, view.state.rows);
  if (sort && !pagedRows)
    rowOrder.sort((a, b) =>
      compareTableValues(
        sortValues[a]?.[sort.column] ?? null,
        sortValues[b]?.[sort.column] ?? null,
        sort.direction,
      ),
    );
  const renderedRowKeys: string[] = [];
  const readonly = readOnly;

  useEffect(() => {
    const controller = new AbortController();
    setView(emptyTableView());
    setLoaded(!viewKey);
    setLoadError('');
    setSort(null);
    if (viewKey)
      void request<TableView>(`/${viewKey}`, { signal: controller.signal })
        .then((result) => {
          if (!controller.signal.aborted) {
            setView(result?.state ? result : emptyTableView());
            setLoaded(true);
          }
        })
        .catch((caught: unknown) => {
          if (!controller.signal.aborted)
            setLoadError(
              caught instanceof ApiError
                ? caught.message
                : 'Не удалось загрузить оформление таблицы.',
            );
        });
    return () => controller.abort();
  }, [viewKey, retry, revisionKey]);

  async function save(state: TableViewState, rowMove?: RowMove): Promise<void> {
    if (busy || readonly || !loaded) return;
    setBusy(true);
    setError('');
    try {
      const result = viewKey
        ? await request<TableView>(`/${viewKey}`, {
            method: 'PUT',
            body: JSON.stringify({ revision: view.revision, state, row_move: rowMove }),
          })
        : { revision: view.revision + 1, state };
      setView(result);
      if (rowMove) pagedRows?.onOrderSaved();
    } catch (caught) {
      setError(
        caught instanceof ApiError
          ? caught.message
          : 'Не удалось сохранить оформление. Повторите действие.',
      );
    } finally {
      setBusy(false);
    }
  }

  function move(axis: 'rows' | 'columns', source: string, target: string): void {
    if (axis === 'rows' && pagedRows) {
      if (source !== target)
        void save(view.state, {
          source,
          target,
          after: rowOrder.indexOf(source) < rowOrder.indexOf(target),
        });
      return;
    }
    if (axis === 'rows') setSort(null);
    const active = axis === 'rows' ? rowOrder : order;
    const reordered = moveKey(active, source, target);
    // Сохраняем также строки вне выбранного периода и столбцы других месяцев.
    const remaining = view.state[axis].filter((key) => !active.includes(key));
    void save({ ...view.state, [axis]: [...reordered, ...remaining] });
  }
  function color(value: TableColor | null): void {
    if (!selected) return;
    const axis = selected.axis === 'rows' ? 'row_colors' : 'column_colors';
    const colors = { ...view.state[axis] };
    if (value) colors[selected.key] = value;
    else delete colors[selected.key];
    void save({ ...view.state, [axis]: colors });
  }

  function cells(node: ReactElement<NodeProps>): ReactElement<NodeProps> {
    if (configured || node.type !== 'tr') return node;
    const items = flatten(node.props.children);
    if (items.length !== columns.length || items.some((cell) => (cell.props.colSpan ?? 1) > 1))
      return node;
    return cloneElement(
      node,
      {},
      order.map((key) => cloneElement(items[originalKeys.indexOf(key)], { key })),
    );
  }
  const content = flatten(children)
    .filter((node) => node.type !== 'colgroup')
    .map((section) => {
      if (!['thead', 'tbody', 'tfoot'].includes(String(section.type))) return section;
      let items = flatten(section.props.children);
      if (section.type === 'tbody') {
        const byKey = new Map(movable.map((node, index) => [nodeKey(node, index), node]));
        let index = 0;
        items = items.map((node, originalIndex) => {
          if (!byKey.has(nodeKey(node, originalIndex))) {
            renderedRowKeys.push('');
            return node;
          }
          const key = rowOrder[index++];
          const next = byKey.get(key);
          renderedRowKeys.push(key ?? '');
          return next
            ? next.type === 'tr'
              ? cells(next)
              : 'index' in next.props
                ? cloneElement(next, { index: index - 1 })
                : next
            : node;
        });
      } else items = items.map(cells);
      return cloneElement(section, {}, items);
    });

  const signature = `${order.join('|')}:${renderedRowKeys.join('|')}:${JSON.stringify(view.state.row_colors)}:${JSON.stringify(view.state.column_colors)}:${readonly}`;
  const fitKey = JSON.stringify([
    providedViewKey ?? zoomKey,
    order.map((key) => columns.find((column) => column.id === key)),
  ]);
  useLayoutEffect(() => {
    const table = ref.current;
    if (!table) return;
    const nextHosts: typeof hosts = [];
    const cleanups: (() => void)[] = [];
    const addHost = (
      cell: HTMLTableCellElement,
      axis: 'rows' | 'columns',
      key: string,
      label: string,
    ): void => {
      if (!key || readonly || cell.colSpan > 1) return;
      const host = document.createElement('span');
      host.className = 'working-table-handle';
      host.dataset.tableTool = 'true';
      host.dataset.axis = axis;
      const position = cell.style.position;
      if (getComputedStyle(cell).position === 'static' || !getComputedStyle(cell).position)
        cell.style.position = 'relative';
      cell.dataset.hasTableTools = 'true';
      cleanups.push(() => {
        cell.style.position = position;
        delete cell.dataset.hasTableTools;
      });
      cell.prepend(host);
      nextHosts.push({ node: host, axis, key, label });
      cleanups.push(() => host.remove());
    };
    const head = table.tHead?.rows[0];
    if (head)
      Array.from(head.cells).forEach((cell, index) => {
        const key = order[index];
        if (
          sortable &&
          key &&
          cell.colSpan === 1 &&
          columns.find((column) => column.id === key)?.label &&
          (!pagedRows || columns.find((column) => column.id === key)?.kind !== 'action') &&
          key !== 'actions'
        ) {
          cell.dataset.tableColumn = key;
          cell.dataset.tableSortable = 'true';
          const tabIndex = cell.getAttribute('tabindex');
          const title = cell.title;
          cell.tabIndex = 0;
          cell.title = 'Нажмите для сортировки по возрастанию или убыванию';
          cleanups.push(() => {
            delete cell.dataset.tableSortable;
            if (tabIndex === null) cell.removeAttribute('tabindex');
            else cell.setAttribute('tabindex', tabIndex);
            cell.title = title;
          });
        }
        addHost(
          cell,
          'columns',
          key,
          columns.find((column) => column.id === key)?.label ?? 'Столбец',
        );
      });
    const rows = Array.from(table.tBodies).flatMap((section) => Array.from(section.rows));
    rows.forEach((row, index) => {
      const key = renderedRowKeys[index];
      row.dataset.rowKey = key ?? '';
      if (!key) return;
      const first = row.cells[0];
      if (first) addHost(first, 'rows', key, String(index + 1));
    });
    for (const row of table.rows) {
      Array.from(row.cells).forEach((cell, index) => {
        if (cell.colSpan > 1 || index >= order.length) return;
        const key = order[index];
        cell.dataset.tableColumn = key;
        const rowKey = row.dataset.rowKey;
        const fill = (rowKey && view.state.row_colors[rowKey]) || view.state.column_colors[key];
        if (fill) {
          if (!originalBackgrounds.current.has(cell))
            originalBackgrounds.current.set(cell, cell.style.backgroundColor);
          cell.dataset.tableColor = fill;
          cell.style.backgroundColor = `var(--table-fill-${fill})`;
        } else {
          delete cell.dataset.tableColor;
          if (originalBackgrounds.current.has(cell)) {
            cell.style.backgroundColor = originalBackgrounds.current.get(cell)!;
            originalBackgrounds.current.delete(cell);
          }
        }
      });
    }
    const drop = (event: DragEvent): void => {
      const cell = (event.target as Element).closest<HTMLTableCellElement>('th,td');
      const source = drag.current;
      if (!cell || !source) return;
      const row = cell.parentElement as HTMLTableRowElement;
      const key = source.axis === 'columns' ? order[cell.cellIndex] : row.dataset.rowKey;
      if (!key || (source.axis === 'columns' && !row.closest('thead'))) return;
      event.preventDefault();
      if (event.type === 'drop') {
        move(source.axis, source.key, key);
        drag.current = null;
      }
    };
    table.addEventListener('dragover', drop);
    table.addEventListener('drop', drop);
    setHosts(nextHosts);
    return () => {
      cleanups.forEach((cleanup) => cleanup());
      table.removeEventListener('dragover', drop);
      table.removeEventListener('drop', drop);
    };
    // Порталы добавляют только кнопки; порядок данных меняется через React.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature, children, loaded, busy, sortable]);

  useLayoutEffect(() => {
    const table = ref.current;
    const container = table?.parentElement;
    if (!table || !container || !order.length) return;
    if (fitted.current?.key === fitKey && fitted.current.hasRows) return;

    const measure = (): void => {
      const bodyRows = rowsForWidth(table);
      const hasRows = bodyRows.length > 0;
      if (fitted.current?.key === fitKey && (fitted.current.hasRows || !hasRows)) return;

      const canvas =
        typeof CanvasRenderingContext2D === 'undefined'
          ? null
          : document.createElement('canvas').getContext('2d');
      const measureText = (text: string): number =>
        canvas?.measureText(text).width ?? text.length * 7;
      const pixels = (value: string): number => parseFloat(value) || 0;
      const next = order.map(() => 0);
      const headerRows = Array.from(table.tHead?.rows ?? []);
      for (const row of [...headerRows, ...bodyRows]) {
        Array.from(row.cells).forEach((cell, index) => {
          if (cell.colSpan > 1 || index >= next.length) return;
          const editor = cell.querySelector<
            HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
          >('input:not([type="hidden"]),textarea,select');
          const toggle =
            editor instanceof HTMLInputElement && ['checkbox', 'radio'].includes(editor.type);
          const clone = cell.cloneNode(true) as HTMLElement;
          clone
            .querySelectorAll(
              '[data-table-tool],[data-table-fixed-controls],input,textarea,select,[hidden],[role="dialog"],[role="menu"]',
            )
            .forEach((node) => node.remove());
          let value = clone.textContent?.trim() ?? '';
          if (editor instanceof HTMLSelectElement)
            value += editor.selectedOptions[0]?.textContent ?? '';
          else if (editor && !toggle) value += editor.value;
          const textElement =
            editor ??
            cell.querySelector(
              'output, a, button:not(.working-table-grip, .working-table-edit-button), strong',
            ) ??
            cell;
          const font = getComputedStyle(textElement);
          const spacing = getComputedStyle(cell);
          if (canvas) canvas.font = `${font.fontWeight} ${font.fontSize} ${font.fontFamily}`;
          const padding =
            pixels(spacing.paddingLeft) +
            pixels(spacing.paddingRight) +
            pixels(spacing.borderLeftWidth) +
            pixels(spacing.borderRightWidth);
          const editorPadding =
            textElement !== cell && !toggle
              ? pixels(font.paddingLeft) +
                pixels(font.paddingRight) +
                pixels(font.borderLeftWidth) +
                pixels(font.borderRightWidth)
              : 0;
          const controlsWidth = Array.from(
            cell.querySelectorAll<HTMLElement>(
              '[data-table-fixed-controls],button[data-table-edit-trigger]',
            ),
          ).reduce(
            (sum, node) =>
              sum +
              node.getBoundingClientRect().width / scale +
              pixels(getComputedStyle(node.parentElement!).columnGap),
            0,
          );
          const displayValue =
            font.textTransform === 'uppercase'
              ? value.toLocaleUpperCase('ru')
              : font.textTransform === 'lowercase'
                ? value.toLocaleLowerCase('ru')
                : value;
          const line = Math.max(
            0,
            ...displayValue
              .split('\n')
              .map((text) => measureText(text) + pixels(font.letterSpacing) * text.length),
          );
          let nativeControlWidth = 0;
          if (editor instanceof HTMLSelectElement) nativeControlWidth = pixels(font.fontSize) * 1.5;
          if (toggle)
            nativeControlWidth =
              editor.getBoundingClientRect().width / scale +
              pixels(font.marginInlineStart) +
              pixels(font.marginInlineEnd);
          next[index] = Math.max(
            next[index],
            Math.ceil(line + padding + editorPadding + nativeControlWidth + controlsWidth + 2),
            editor instanceof HTMLInputElement && editor.type === 'date' ? 132 : 0,
          );
        });
      }
      fitted.current = { key: fitKey, hasRows };
      const containerStyle = getComputedStyle(container);
      const tableStyle = getComputedStyle(table);
      const borderSpacing =
        tableStyle.borderCollapse === 'separate'
          ? pixels(tableStyle.borderSpacing) * (next.length + 1)
          : 0;
      // clientWidth округлён до целых. Остаток пикселя заполняет width: 100%.
      const availableWidth =
        container.clientWidth -
        1 -
        pixels(containerStyle.paddingLeft) -
        pixels(containerStyle.paddingRight) -
        pixels(tableStyle.borderLeftWidth) -
        pixels(tableStyle.borderRightWidth) -
        pixels(tableStyle.paddingLeft) -
        pixels(tableStyle.paddingRight) -
        borderSpacing;
      const spareWidth = availableWidth - next.reduce((sum, width) => sum + width, 0);
      if (spareWidth > 0) {
        const flexible = new Set(columns.filter(canGrow).map((column) => column.id));
        const recipients = flexible.size ? flexible.size : next.length;
        order.forEach((key, index) => {
          if (!flexible.size || flexible.has(key)) next[index] += spareWidth / recipients;
        });
      }
      setWidths((previous) =>
        JSON.stringify(previous) === JSON.stringify(next) ? previous : next,
      );
    };

    // Скрытая таблица получит размеры, когда станет видимой.
    if (table.getClientRects().length) {
      measure();
      return;
    }
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      if (!table.getClientRects().length) return;
      observer.disconnect();
      measure();
    });
    observer.observe(table);
    return () => observer.disconnect();
    // После загрузки первых строк ввод и перелистывание сохраняют ширину.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitKey, children, signature]);

  const clientSortColumn = pagedRows ? undefined : sort?.column;
  useLayoutEffect(() => {
    const table = ref.current;
    if (!table || !clientSortColumn) return;
    let frame = 0;
    const update = (): void => {
      frame = 0;
      if (table.contains(document.activeElement) && !document.activeElement?.closest('thead'))
        return;
      const values = collectSortValues(clientSortColumn);
      setSortValues((previous) =>
        JSON.stringify(previous) === JSON.stringify(values) ? previous : values,
      );
    };
    const schedule = (): void => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    update();
    const observer = new MutationObserver(schedule);
    observer.observe(table, { childList: true, subtree: true, characterData: true });
    table.addEventListener('input', schedule);
    table.addEventListener('change', schedule);
    table.addEventListener('focusout', schedule);
    return () => {
      observer.disconnect();
      table.removeEventListener('input', schedule);
      table.removeEventListener('change', schedule);
      table.removeEventListener('focusout', schedule);
      if (frame) cancelAnimationFrame(frame);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature, children, hosts, clientSortColumn]);

  const selectedOrder = selected?.axis === 'rows' ? rowOrder : order;
  const selectedIndex = selected ? selectedOrder.indexOf(selected.key) : -1;
  const selectedColor = selected
    ? view.state[selected.axis === 'rows' ? 'row_colors' : 'column_colors'][selected.key]
    : null;
  useLayoutEffect(() => {
    ref.current
      ?.querySelectorAll<HTMLTableCellElement>('thead [data-table-sortable]')
      .forEach((cell) => {
        cell.setAttribute(
          'aria-sort',
          sort && sort.column === cell.dataset.tableColumn ? sort.direction : 'none',
        );
      });
  }, [sort, hosts]);
  function collectSortValues(column: string): typeof sortValues {
    const values: typeof sortValues = {};
    const index = order.indexOf(column);
    const kind = columns.find((item) => item.id === column)?.kind;
    Array.from(ref.current?.tBodies ?? [])
      .flatMap((body) => Array.from(body.rows))
      .forEach((row) => {
        if (row.dataset.rowKey && row.cells[index])
          values[row.dataset.rowKey] = { [column]: tableCellValue(row.cells[index], kind) };
      });
    return values;
  }
  function sortHeader(target: EventTarget): boolean {
    if (
      !(target instanceof Element) ||
      target.closest('button,a,input,select,textarea,[data-table-tool]')
    )
      return false;
    const cell = target.closest<HTMLTableCellElement>('thead [data-table-sortable]');
    if (!cell?.dataset.tableColumn) return false;
    const column = cell.dataset.tableColumn;
    const nextSort: TableSort = {
      column,
      direction:
        sort?.column === column && sort.direction === 'ascending' ? 'descending' : 'ascending',
    };
    if (pagedRows) {
      pagedRows.onSort(nextSort);
      return true;
    }
    // Читаем и несохранённые значения перед перестановкой, сохраняя DOM ячеек.
    setSortValues(collectSortValues(column));
    setSort(nextSort);
    return true;
  }

  async function paste(event: ClipboardEvent<HTMLTableElement>): Promise<void> {
    props.onPaste?.(event);
    if (!pasteCells || event.defaultPrevented) return;
    const table = event.currentTarget;
    const start = bodyCell(table, event.target);
    if (!start || (event.target instanceof Element && event.target.closest('[data-table-tool]')))
      return;
    const text = event.clipboardData.getData('text/plain');
    if (!text && !event.clipboardData.types?.includes('text/plain')) return;
    const spreadsheet =
      text.includes('\t') ||
      /<table[\s>]/i.test(event.clipboardData.getData('text/html')) ||
      (!(event.target instanceof HTMLTextAreaElement) && /[\r\n]/.test(text));
    if (
      !spreadsheet &&
      event.target instanceof Element &&
      event.target.matches('input,textarea,[contenteditable]')
    )
      return;
    event.preventDefault();
    if (readonly || pasting.current) return;
    const maximum = typeof pasteCells === 'function' ? 5000 : 500;
    if (text.length > 2_000_000) {
      setPasteNotice('Диапазон слишком большой. Вставьте его частями.');
      return;
    }
    const grid = parseClipboardGrid(text);
    const size = grid.reduce((sum, row) => sum + row.length, 0);
    if (size > maximum) {
      setPasteNotice(`За раз можно вставить до ${maximum} ячеек. Разделите диапазон на части.`);
      return;
    }
    const cells = pasteTargets(table, start, grid);
    if (!cells.length) {
      setPasteNotice('В выбранном диапазоне нет доступных для ввода ячеек.');
      return;
    }
    pasting.current = true;
    try {
      let inserted = 0;
      if (typeof pasteCells === 'function') {
        setPasteNotice('Сохраняем вставленные значения…');
        await pasteCells(cells);
        inserted = cells.length;
      } else {
        for (const cell of cells) if (fillPastedCell(cell)) inserted++;
      }
      const skipped = size - inserted;
      setPasteNotice(`Вставлено ячеек: ${inserted}.${skipped ? ` Пропущено: ${skipped}.` : ''}`);
    } catch (caught) {
      setPasteNotice(caught instanceof Error ? caught.message : 'Не удалось вставить значения.');
    } finally {
      pasting.current = false;
      if (start.isConnected && table.ownerDocument.activeElement === table.ownerDocument.body) {
        start.tabIndex = -1;
        start.focus({ preventScroll: true });
      }
    }
  }

  return (
    <OrderContext.Provider value={order}>
      {loadError && (
        <p className="working-table-notice" aria-live="polite">
          Оформление не загружено.{' '}
          <button
            type="button"
            className="link-button"
            onClick={() => setRetry((value) => value + 1)}
          >
            Повторить
          </button>
        </p>
      )}
      {error && (
        <p className="working-table-notice" role="alert">
          {error}{' '}
          <button
            type="button"
            className="link-button"
            disabled={busy}
            onClick={() => {
              setError('');
              setSelected(null);
              setRetry((value) => value + 1);
            }}
          >
            Обновить оформление
          </button>
        </p>
      )}
      {pasteNotice && (
        <p className="working-table-notice" role="status">
          {pasteNotice}
        </p>
      )}
      {zoomSaveFailed && (
        <p className="working-table-notice" role="alert">
          Не удалось сохранить масштаб таблицы.
        </p>
      )}
      <table
        {...props}
        ref={ref}
        className={`working-table ${className}`}
        style={{
          ...style,
          zoom: scale === 1 ? style?.zoom : scale,
          tableLayout: 'fixed',
          width: '100%',
          minWidth: widths.length ? widths.reduce((sum, width) => sum + width, 0) : style?.minWidth,
        }}
        onKeyDown={(event) => {
          props.onKeyDown?.(event);
          if (
            !event.defaultPrevented &&
            ['Enter', ' '].includes(event.key) &&
            sortHeader(event.target)
          ) {
            event.preventDefault();
            return;
          }
          navigateTable(event);
        }}
        onClick={(event) => {
          props.onClick?.(event);
          if (event.defaultPrevented || sortHeader(event.target)) return;
          if (
            pasteCells &&
            !readonly &&
            event.target instanceof Element &&
            !event.target.closest(
              'button,a,input,select,textarea,label,[role="button"],[contenteditable]',
            )
          ) {
            const cell = bodyCell(event.currentTarget, event.target);
            if (cell) {
              cell.tabIndex = -1;
              cell.focus({ preventScroll: true });
            }
          }
        }}
        onPaste={(event) => void paste(event)}
      >
        {!!widths.length && (
          <colgroup>
            {widths.slice(0, order.length).map((width, index) => (
              <col key={order[index] ?? index} style={{ width }} />
            ))}
          </colgroup>
        )}
        {content}
      </table>
      {hosts.map(({ node, axis, key, label }) =>
        createPortal(
          <button
            type="button"
            className="btn btn--quiet working-table-grip"
            disabled={busy || !loaded}
            aria-label={`${axis === 'columns' ? 'Столбец' : 'Строка'}: ${label}. Цвет и порядок`}
            title="Перетащите для перестановки или нажмите для выбора цвета"
            draggable={!busy && loaded}
            onDragStart={(event) => {
              drag.current = { axis, key };
              event.dataTransfer.effectAllowed = 'move';
              event.dataTransfer.setData('text/plain', key);
            }}
            onDragEnd={() => {
              drag.current = null;
            }}
            onClick={() => setSelected({ axis, key, label })}
          />,
          node,
          `${axis}:${key}`,
        ),
      )}
      {selected && (
        <Modal
          testId="working-table-settings"
          title={`${selected.axis === 'rows' ? 'Строка' : 'Столбец'}: ${selected.label}`}
          onClose={() => setSelected(null)}
          closeDisabled={busy}
        >
          <div className="working-table-settings">
            <p>Цвет выделения</p>
            <div className="working-table-palette" role="group" aria-label="Цвет выделения">
              {tableColors.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className="btn btn--quiet working-table-swatch"
                  data-table-color={item.id}
                  aria-label={item.label}
                  title={item.label}
                  aria-pressed={selectedColor === item.id}
                  disabled={busy || !loaded}
                  onClick={() => color(item.id)}
                >
                  {selectedColor === item.id ? '✓' : ''}
                </button>
              ))}
            </div>
            <button
              type="button"
              className="btn btn--ghost btn--compact"
              disabled={busy || !selectedColor}
              onClick={() => color(null)}
            >
              Сбросить цвет
            </button>
            <p>Порядок {selected.axis === 'rows' ? 'строк' : 'столбцов'}</p>
            <div className="working-table-move">
              <button
                type="button"
                className="btn btn--ghost btn--compact"
                disabled={busy || selectedIndex <= 0}
                onClick={() => move(selected.axis, selected.key, selectedOrder[selectedIndex - 1])}
              >
                {selected.axis === 'rows' ? 'Выше' : 'Левее'}
              </button>
              <button
                type="button"
                className="btn btn--ghost btn--compact"
                disabled={busy || selectedIndex < 0 || selectedIndex >= selectedOrder.length - 1}
                onClick={() => move(selected.axis, selected.key, selectedOrder[selectedIndex + 1])}
              >
                {selected.axis === 'rows' ? 'Ниже' : 'Правее'}
              </button>
            </div>
            <small>
              Порядок можно менять перетаскиванием за ⠿ в заголовке. При пересечении выделений
              применяется цвет строки.
            </small>
            {busy && <p role="status">Сохраняем оформление…</p>}
            {error && <p role="alert">{error}</p>}
          </div>
        </Modal>
      )}
    </OrderContext.Provider>
  );
}

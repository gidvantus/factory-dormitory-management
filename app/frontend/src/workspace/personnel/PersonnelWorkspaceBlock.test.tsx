import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import type { Block, PersonnelData } from '../../api/personnel';
import { personnelApi } from '../../api/personnel';
import * as session from '../../auth/SessionProvider';
import { Personnel } from '../Personnel';
import { PersonnelWorkspaceBlock } from './PersonnelWorkspaceBlock';
import { blockNames } from './helpers';

const makeBlock = (kind: Block['kind'], extra: Partial<Block> = {}): Block => ({
  id: kind,
  kind,
  title: blockNames[kind],
  scope: [],
  days: 7,
  limit: 4,
  wide: false,
  saved_list_id: null,
  ...extra,
});
const payload = (): PersonnelData => ({
  today: '2026-10-15',
  dormitories: [{ id: 1, name: 'Северное', client_name: 'Клиент', is_archived: false }],
  employees: [],
  plans: [],
  arrival_plans: [],
  preferences: { revision: 0, blocks: [], lists: [] },
});
afterEach(() => vi.restoreAllMocks());

it('оформляет каждый из пяти типов независимо от его позиции и показывает пустые состояния', () => {
  const data = payload();
  for (const kind of ['saved', 'contacts', 'ending', 'residents', 'plans'] as const) {
    const { unmount } = render(
      <PersonnelWorkspaceBlock
        block={makeBlock(kind, { wide: true })}
        data={data}
        dormitory={null}
        configuring={false}
        busy={false}
        first={false}
        last={false}
        onPerson={vi.fn()}
        onList={vi.fn()}
        onPlanning={vi.fn()}
        onEdit={vi.fn()}
        onMove={vi.fn()}
        onRemove={vi.fn()}
      />,
    );
    expect(screen.getByRole('article', { name: blockNames[kind] })).toHaveAttribute(
      'data-wide',
      'true',
    );
    expect(screen.getByRole('heading', { name: blockNames[kind] })).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: `Настроить блок «${blockNames[kind]}»` }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(kind === 'saved' ? 'Выберите список' : 'Пока нет данных'),
    ).toBeInTheDocument();
    unmount();
  }
});

it('сохраняет пользовательский набор: добавляет ранее скрытый тип, меняет порядок и не возвращает убранные блоки', async () => {
  const user = userEvent.setup();
  const data = payload();
  data.preferences.blocks = [makeBlock('contacts')];
  data.preferences.lists = [
    {
      id: 'team',
      name: 'Моя бригада',
      filter: 'all',
      query: '',
      scope: [],
      dormitory: null,
      days: 7,
    },
  ];
  vi.spyOn(session, 'useSession').mockReturnValue({
    status: 'authenticated',
    user: null,
    setUser: vi.fn(),
    refresh: vi.fn(),
    logout: vi.fn(),
  });
  vi.spyOn(personnelApi, 'workspace').mockImplementation(async () => structuredClone(data));
  const save = vi.spyOn(personnelApi, 'preferences').mockImplementation(async (next) => {
    data.preferences = { ...structuredClone(next), revision: next.revision + 1 };
    return data.preferences;
  });
  render(
    <MemoryRouter>
      <Personnel />
    </MemoryRouter>,
  );
  await screen.findByRole('article', { name: 'Контакты сотрудников' });
  expect(screen.queryByRole('article', { name: 'План заездов' })).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: /^Добавить блок$/ }));
  const dialog = screen.getByRole('dialog');
  await user.selectOptions(within(dialog).getByLabelText('Содержимое'), 'saved');
  await user.click(within(dialog).getByLabelText('На всю ширину рабочей поверхности'));
  await user.click(within(dialog).getByRole('button', { name: 'Сохранить блок' }));
  const saved = await screen.findByRole('article', { name: 'Сохранённый список' });
  expect(saved).toHaveAttribute('data-kind', 'saved');
  expect(saved).toHaveAttribute('data-wide', 'true');
  expect(save.mock.calls[0][0].blocks?.map((block) => block.kind)).toEqual(['contacts', 'saved']);
  await user.click(screen.getByRole('button', { name: 'Настроить поверхность' }));
  await user.click(screen.getByRole('button', { name: 'Поднять блок «Сохранённый список»' }));
  await waitFor(() =>
    expect(screen.getAllByRole('article')[0]).toHaveAttribute('data-kind', 'saved'),
  );
  await user.click(screen.getByRole('button', { name: 'Убрать блок «Контакты сотрудников»' }));
  await waitFor(() =>
    expect(screen.queryByRole('article', { name: 'Контакты сотрудников' })).not.toBeInTheDocument(),
  );
  expect(data.preferences.blocks?.map((block) => block.kind)).toEqual(['saved']);
  expect(screen.queryByRole('article', { name: 'Проживающий персонал' })).not.toBeInTheDocument();
});

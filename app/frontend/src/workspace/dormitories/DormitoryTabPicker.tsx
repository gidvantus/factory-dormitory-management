import { useState } from 'react';
import type { TabCatalogItem } from '../../api/client';
import styles from './DormitoryTabPicker.module.css';

export function DormitoryTabPicker({
  items,
  selected,
  onChange,
  disabled,
}: {
  items: TabCatalogItem[];
  selected: Record<string, string | null>;
  onChange: (value: Record<string, string | null>) => void;
  disabled: boolean;
}): JSX.Element {
  const [search, setSearch] = useState('');
  const normalize = (value: string): string =>
    value.trim().toLocaleLowerCase('ru').replaceAll('ё', 'е');
  const chosenNames = new Set(
    items.filter((item) => selected[item.id]).map((item) => normalize(item.name)),
  );
  return (
    <fieldset className={styles.picker} disabled={disabled}>
      <legend>Вкладки нового общежития</legend>
      <p className={styles.help}>
        Отметьте нужные вкладки и подвкладки. Каждое название показано один раз; образец определяет
        столбцы и форматы. Если родитель не выбран, подвкладка станет самостоятельной.
      </p>
      <div className={styles.controls}>
        <label>
          Поиск вкладки
          <input value={search} onChange={(event) => setSearch(event.target.value)} />
        </label>
        <button
          type="button"
          onClick={() =>
            onChange(
              Object.fromEntries(
                items.map((item) => [item.id, selected[item.id] || item.variants[0].id]),
              ),
            )
          }
        >
          Выбрать все
        </button>
        <button type="button" onClick={() => onChange({})}>
          Снять все
        </button>
      </div>
      <div className={styles.list}>
        {items
          .filter((item) => normalize(item.name).includes(normalize(search)))
          .map((item) => {
            const source =
              item.variants.find((variant) => variant.id === selected[item.id]) || item.variants[0];
            const nested = source.parent_name && chosenNames.has(normalize(source.parent_name));
            return (
              <div key={item.id} className={styles.item}>
                <label className={styles.toggle}>
                  <input
                    type="checkbox"
                    checked={!!selected[item.id]}
                    onChange={(event) =>
                      onChange({ ...selected, [item.id]: event.target.checked ? source.id : null })
                    }
                  />
                  {item.name}
                </label>
                {selected[item.id] && (
                  <>
                    <label className={styles.source}>
                      Образец для «{item.name}»
                      <select
                        value={source.id}
                        onChange={(event) =>
                          onChange({ ...selected, [item.id]: event.target.value })
                        }
                      >
                        {item.variants.map((variant) => (
                          <option key={variant.id} value={variant.id}>
                            {variant.dormitory_id
                              ? `${variant.client_name} · ${variant.dormitory_name} · ${variant.path.join(' → ')}`
                              : variant.dormitory_name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <span className={styles.help}>
                      {nested
                        ? `Внутри вкладки «${source.parent_name}»`
                        : 'Самостоятельная вкладка'}
                    </span>
                  </>
                )}
              </div>
            );
          })}
      </div>
      <p className={styles.help}>
        Выбрано: {chosenNames.size}. Копируется независимая структура без записей. Изменения образца
        не повлияют на новое общежитие.
      </p>
    </fieldset>
  );
}

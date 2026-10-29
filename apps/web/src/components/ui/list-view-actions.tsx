'use client';

import type { ReactNode } from 'react';
import { Plus } from 'lucide-react';
import type { useListPage } from '@/hooks/useListPage';
import { Button } from './button';
import { TableColumnsDropdown } from './columns-dropdown';
import { DateRangeFilter } from './date-range-filter';
import { DetailPanelToggle } from './detail-panel-toggle';
import { ListSearchInput } from './list-search-input';
import { ListFiltersRow, ShowDeletedToggle } from './list-toolbar';
import { SaveFilterButton } from './saved-filters-bar';

interface ListViewActionsProps {
  /** Стан списку (`useListPage()`): видалені, колонки, бокова панель, увімкнені можливості. */
  list: Pick<
    ReturnType<typeof useListPage>,
    | 'showDeleted'
    | 'toggleShowDeleted'
    | 'tableColumns'
    | 'detailPanel'
    | 'features'
    | 'filterSetter'
  >;
  /** Типовий порядок колонок (JSON ключів) — від нього рахується «налаштовано». */
  defaultKeysJson: string;
  /** Зберегти подання (кнопка є, лише коли збережені подання увімкнені). */
  onSaveFilter: (name: string) => void;
  /** Власний перемикач «видалених» (типово — `list.toggleShowDeleted`). */
  onToggleDeleted?: (() => void) | undefined;
  /** Основна кнопка «+ Документ» — остання в групі. */
  onAdd: () => void;
  addLabel: ReactNode;
}

/**
 * Перемикачі вигляду списку в діях рядка фільтрів — у порядку стандарту (`ListFiltersRow`):
 * «видалені», збереження подання, колонки, бокова панель і остання — основна «+ Документ».
 */
export function ListViewActions({
  list,
  defaultKeysJson,
  onSaveFilter,
  onToggleDeleted,
  onAdd,
  addLabel,
}: ListViewActionsProps) {
  const { detailPanel } = list;
  return (
    <>
      <ShowDeletedToggle
        shown={list.showDeleted}
        onToggle={onToggleDeleted ?? list.toggleShowDeleted}
      />
      {list.features.savedFiltersEnabled && <SaveFilterButton onSave={onSaveFilter} />}
      <TableColumnsDropdown table={list.tableColumns} defaultKeysJson={defaultKeysJson} />
      <DetailPanelToggle enabled={detailPanel.enabled} onToggle={detailPanel.toggle} />
      <Button onClick={onAdd} leftIcon={<Plus className="h-4 w-4" />}>
        {addLabel}
      </Button>
    </>
  );
}

interface ListToolbarProps extends ListViewActionsProps {
  /** Пошук: `[значення, сеттер]` і підказка (вона ж доступна назва) — перше поле рядка. */
  search?: readonly [string, (value: string) => void] | undefined;
  searchLabel?: string | undefined;
  /** Період «З … По …»: `[from, setFrom, to, setTo]`, `YYYY-MM-DD` — одразу після пошуку. */
  period?: readonly [string, (value: string) => void, string, (value: string) => void] | undefined;
  /** Решта фільтрів сторінки — після пошуку й періоду. */
  children?: ReactNode;
}

/**
 * Рядок фільтрів списку за стандартом: пошук, період, фільтри сторінки ліворуч і стандартні дії
 * (`ListViewActions`) праворуч. Зміна поля — через `list.filterSetter` (перша сторінка, без подання).
 */
export function ListToolbar({
  search,
  searchLabel,
  period,
  children,
  ...actions
}: ListToolbarProps) {
  const { filterSetter } = actions.list;
  return (
    <ListFiltersRow actions={<ListViewActions {...actions} />}>
      {search && (
        <ListSearchInput
          value={search[0]}
          onChange={filterSetter(search[1])}
          label={searchLabel ?? ''}
        />
      )}
      {period && (
        <DateRangeFilter
          from={period[0]}
          to={period[2]}
          onFromChange={filterSetter(period[1])}
          onToChange={filterSetter(period[3])}
        />
      )}
      {children}
    </ListFiltersRow>
  );
}

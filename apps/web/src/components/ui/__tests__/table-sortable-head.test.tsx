/**
 * Курсор заголовка колонки (запит власника 2026-10-13): при наведенні — те, що зробить КЛІК
 * (вказівник на сортованій колонці, звичайна стрілка на решті), рука-захват — лише поки кнопку
 * затиснуто для перетягування. Раніше `th[draggable="true"] { cursor: grab }` перебивав
 * `cursor-pointer`, і на всіх заголовках завжди була рука.
 *
 * Сам курсор задає CSS: jsdom каскад із globals.css не рахує, тому тут стережеться дві речі,
 * на які цей CSS спирається, — мітка `data-sortable` і самі правила у файлі стилів.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SortableHead, TableHead } from '../table';

const sort = { sortBy: 'amount', sortDir: 'asc' as const };

function renderHead(onSort = vi.fn()) {
  render(
    <table>
      <thead>
        <tr>
          <SortableHead sortKey="amount" currentSort={sort} onSort={onSort} draggable>
            Сума
          </SortableHead>
          <TableHead draggable>Статус</TableHead>
        </tr>
      </thead>
    </table>,
  );
  return onSort;
}

describe('заголовок колонки: курсор сортування й перетягування', () => {
  it('сортований заголовок має мітку data-sortable, звичайний — ні', () => {
    renderHead();
    expect(screen.getByRole('columnheader', { name: /Сума/ })).toHaveAttribute(
      'data-sortable',
      'true',
    );
    expect(screen.getByRole('columnheader', { name: 'Статус' })).not.toHaveAttribute(
      'data-sortable',
    );
  });

  it('клік по сортованому заголовку сортує — перетягуваність цьому не заважає', async () => {
    const onSort = renderHead();
    await userEvent.click(screen.getByRole('columnheader', { name: /Сума/ }));
    expect(onSort).toHaveBeenCalledWith('amount');
  });

  it('стилі: наведення — стрілка або вказівник, захват — лише в :active', () => {
    // Шлях від кореня пакета (cwd vitest), а не через відносні сегменти: селектор зачеплених тестів читає
    // такий рядок як імпорт теки компонентів і прив'язує цей тест до кожного компонента в ній.
    const css = readFileSync(join(process.cwd(), 'src/app/globals.css'), 'utf8');
    const rule = (selector: string): string => {
      const i = css.indexOf(`${selector} {`);
      expect(i, `немає правила ${selector}`).toBeGreaterThanOrEqual(0);
      return css.slice(i, css.indexOf('}', i));
    };
    expect(rule('th[draggable="true"]')).toContain('cursor: default');
    expect(rule('th[draggable="true"][data-sortable="true"]')).toContain('cursor: pointer');
    expect(rule('th[draggable="true"]:active')).toContain('cursor: grabbing');
    // Правило :active стоїть ПІСЛЯ правила сортованого заголовка: специфічність у них однакова,
    // тож саме порядок робить так, що затиснута кнопка показує захват і на сортованій колонці.
    expect(css.indexOf('th[draggable="true"]:active {')).toBeGreaterThan(
      css.indexOf('th[draggable="true"][data-sortable="true"] {'),
    );
    expect(css).not.toMatch(/th\[draggable="true"\]\s*\{[^}]*cursor:\s*grab\b/);
  });
});

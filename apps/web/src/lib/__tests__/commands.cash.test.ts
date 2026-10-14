// Bug #852: палітра команд (Ctrl+K) не знала «Каси». Після рішення «каса — місце готівкових
// оплат» запит «оплата» вів лише в «Розрахунки», а «каса» не знаходив нічого.
//
// Мутація: прибрати запис `nav:cash` з NAV_COMMANDS → падають усі три кейси з касою.

import { describe, it, expect } from 'vitest';
import { getCommands, searchCommands } from '../commands';
import { MASTER_NAV_ITEMS } from '../nav';

const found = (role: string, query: string) =>
  searchCommands(getCommands(role), query).map(c => c.id);

describe('палітра команд — каса', () => {
  it.each(['каса', 'Оплата', 'готівка'])('запит «%s» знаходить «Касу»', query => {
    expect(found('OWNER', query)).toContain('nav:cash');
  });

  it('команда веде на сторінку каси', () => {
    const pushed: string[] = [];
    const cash = getCommands('ACCOUNTANT').find(c => c.id === 'nav:cash');
    cash?.perform({ router: { push: href => pushed.push(href) }, role: 'ACCOUNTANT' });
    expect(pushed).toEqual(['/cash']);
  });

  it('команду бачать рівно ті ролі, яким показано пункт меню «Каса»', () => {
    const navRoles = MASTER_NAV_ITEMS.find(i => i.href === '/cash')?.roles ?? [];
    expect(navRoles.length).toBeGreaterThan(0);
    for (const role of [
      'OWNER',
      'ADMIN',
      'ACCOUNTANT',
      'RECEPTIONIST',
      'STOREKEEPER',
      'MECHANIC',
    ]) {
      expect(found(role, 'каса').includes('nav:cash'), role).toBe(navRoles.includes(role));
    }
  });
});

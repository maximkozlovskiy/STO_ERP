// Сторінка наряду — блок «Журнал змін» (рішення власника 2026-10-16): лише ролям із доступом до
// `GET /audit` (`AUDIT_VIEW_ROLES` — власник, адміністратор, бухгалтер). Приймальні й механіку —
// ні запиту (інакше 403 у консолі), ні блоку.

import { render, screen, waitFor } from '@testing-library/react';
import { vi, it, expect, describe, beforeEach } from 'vitest';
import { AUDIT_VIEW_ROLES } from '@sto/shared';
import { WorkOrderAuditSection } from '../WorkOrderAuditSection';

const apiFetchMock = vi.fn();
vi.mock('@/lib/api-client', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

let role: string | undefined = 'OWNER';
vi.mock('@/lib/auth', () => ({
  useAuth: () => ({ employee: role ? { role } : null }),
}));

const WO_ID = '11111111-1111-4111-8111-111111111111';
const EVENTS = {
  items: [
    {
      id: 'a1',
      action: 'UPDATE',
      diff: { description: { from: 'старий', to: 'новий' } },
      createdAt: '2026-10-16T09:00:00Z',
      user: { firstName: 'Іван', lastName: 'Петренко' },
    },
  ],
};

describe('WorkOrderAuditSection — «Журнал змін» за ролями', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
    apiFetchMock.mockResolvedValue(EVENTS);
  });

  it('ролі з доступом — ті самі, що в @Roles GET /audit', () => {
    expect([...AUDIT_VIEW_ROLES].sort()).toEqual(['ACCOUNTANT', 'ADMIN', 'OWNER']);
  });

  it.each(['OWNER', 'ADMIN', 'ACCOUNTANT'])('%s → журнал запитано й показано', async r => {
    role = r;
    render(<WorkOrderAuditSection woId={WO_ID} />);
    expect(await screen.findByText(/Петренко Іван/)).toBeInTheDocument();
    expect(apiFetchMock).toHaveBeenCalledWith(`/audit?entityType=WorkOrder&entityId=${WO_ID}`);
  });

  it.each(['RECEPTIONIST', 'MECHANIC', 'STOREKEEPER', undefined])(
    '%s → ні запиту, ні блоку',
    async r => {
      role = r;
      const { container } = render(<WorkOrderAuditSection woId={WO_ID} />);
      await waitFor(() => expect(container).toBeEmptyDOMElement());
      expect(apiFetchMock).not.toHaveBeenCalled();
    },
  );

  it('збій журналу не ламає сторінку — блоку немає', async () => {
    role = 'OWNER';
    apiFetchMock.mockRejectedValue(new Error('500'));
    const { container } = render(<WorkOrderAuditSection woId={WO_ID} />);
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });
});

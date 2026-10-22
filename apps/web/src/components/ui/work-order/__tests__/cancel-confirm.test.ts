// BR-WO-025, BR-WO-031: попередження про повернення складу, сторно боргу й скасування рахунку —
// для «Виконано» і «Виставлено» (обидва вже списали запчастини й нарахували борг); для решти — без.
import { describe, expect, it } from 'vitest';
import i18n from '@/i18n/config';
import { cancelConfirmOptions } from '../cancel-confirm';

const t = i18n.getFixedT('uk', 'workOrders');
const WARNING =
  'Наряд уже виконано: товари повернуться на склад, борг клієнта буде сторновано, а рахунок наряду — скасовано.';

describe('cancelConfirmOptions', () => {
  it.each(['COMPLETED', 'INVOICED'])('%s — з попередженням', from => {
    expect(cancelConfirmOptions(t, from).message).toBe(WARNING);
  });

  it.each(['DRAFT', 'APPROVED', 'ON_HOLD'])('%s — без попередження', from => {
    expect(cancelConfirmOptions(t, from).message).toBeUndefined();
  });
});

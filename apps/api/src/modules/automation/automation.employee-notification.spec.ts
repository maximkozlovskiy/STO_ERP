/**
 * Дія «сповіщення працівникам» (docs/objects/automation.md, BR-AUT-020…023): одержувачі за
 * переліком, роллю й «відповідальний з документа», без звільнених і видалених, без ініціатора;
 * сповіщення в системі; зовнішній канал за телефоном працівника.
 */
import { describe, it, expect } from 'vitest';
import {
  ACTOR,
  FIRED,
  FOREIGN,
  MECH_1,
  MECH_2,
  ON_LEAVE,
  RECEPTION,
  automationHarness,
  fakeCtx,
  fakeEvent,
  fakeRule,
} from './automation.spec-fixture';

const notify = (over: Record<string, unknown> = {}) => ({
  type: 'employee_notification',
  title: 'Наряд {{documentNumber}}: {{status}}',
  body: 'Клієнт {{clientName}}',
  ...over,
  recipients: { ...(over.recipients as object) },
});

async function fire(
  action: Record<string, unknown>,
  opts: { actorId?: string | null; ctx?: ReturnType<typeof fakeCtx> } = {},
) {
  const h = automationHarness({ rules: [fakeRule({ actions: [action] })], ctx: opts.ctx });
  await h.engine.handle(fakeEvent(opts.actorId !== undefined ? { actorId: opts.actorId } : {}));
  const inbox = h.tables.employeeNotification.rows;
  return { h, inbox, ids: inbox.map(n => n.employeeId).sort(), run: h.runs[0] };
}

describe('Дія «сповіщення працівникам»', () => {
  // guards: BR-AUT-020
  it('за роллю — усі механіки організації, крім звільненого й чужої org; у відпустці отримує', async () => {
    const { ids } = await fire(notify({ recipients: { roles: ['MECHANIC'] } }));
    expect(ids).toEqual([MECH_1, MECH_2, ON_LEAVE].sort());
    expect(ids).not.toContain(FIRED);
    expect(ids).not.toContain(FOREIGN);
  });

  // guards: BR-AUT-020
  it('конкретні працівники і «відповідальний з документа» (виконавці наряду) — без повторів', async () => {
    const { ids } = await fire(
      notify({ recipients: { employeeIds: [RECEPTION, MECH_1, FIRED], responsible: true } }),
    );
    expect(ids).toEqual([MECH_1, MECH_2, RECEPTION].sort());
  });

  // guards: BR-AUT-020
  it('«відповідальний» документа без виконавців — автор (ініціатор події «створено»)', async () => {
    const ctx = fakeCtx({ documentType: 'INVOICE', responsibleIds: [], responsibleIsAuthor: true });
    const h = automationHarness({
      rules: [
        fakeRule({
          documentType: 'INVOICE',
          toStatuses: [],
          actions: [notify({ recipients: { responsible: true } })],
        }),
      ],
      ctx,
      events: [
        {
          id: 'e0',
          orgId: 'org-a',
          documentType: 'INVOICE',
          documentId: ctx.documentId,
          kind: 'CREATED',
          actorId: RECEPTION,
          occurredAt: new Date('2026-01-01'),
          deletedAt: null,
        },
      ],
    });
    await h.engine.handle(fakeEvent({ documentType: 'INVOICE', toStatus: 'SENT', actorId: null }));
    expect(h.tables.employeeNotification.rows.map(n => n.employeeId)).toEqual([RECEPTION]);
  });

  // guards: BR-AUT-023
  it('ініціатор зміни не отримує сповіщення про власну дію; з notifyInitiator — отримує', async () => {
    const without = await fire(notify({ recipients: { employeeIds: [ACTOR, RECEPTION] } }));
    expect(without.ids).toEqual([RECEPTION]);
    const withActor = await fire(
      notify({ recipients: { employeeIds: [ACTOR, RECEPTION] }, notifyInitiator: true }),
    );
    expect(withActor.ids).toEqual([ACTOR, RECEPTION].sort());
  });

  // guards: BR-AUT-023
  it('лише ініціатор серед одержувачів — дію пропущено «немає одержувачів»', async () => {
    const { inbox, run } = await fire(notify({ recipients: { employeeIds: [ACTOR] } }));
    expect(inbox).toHaveLength(0);
    expect(run?.actionResults).toEqual([
      expect.objectContaining({ status: 'SKIPPED', reason: 'NO_RECIPIENTS' }),
    ]);
  });

  // guards: BR-AUT-021
  it('сповіщення в системі: заголовок і текст із шаблону, документ і правило, непрочитане', async () => {
    const { inbox, run } = await fire(notify({ recipients: { employeeIds: [RECEPTION] } }));
    expect(inbox).toEqual([
      expect.objectContaining({
        orgId: 'org-a',
        employeeId: RECEPTION,
        title: 'Наряд НРД-7: В роботі',
        body: 'Клієнт Петренко Іван',
        documentType: 'WORK_ORDER',
        documentId: 'doc-wo-1',
        ruleId: run?.ruleId,
        readAt: null,
      }),
    ]);
  });

  // guards: BR-AUT-022
  it('зовнішній канал — SMS за телефоном працівника; без телефону — лише в системі', async () => {
    const { h, inbox, run } = await fire(
      notify({
        recipients: { employeeIds: [RECEPTION, MECH_2] },
        external: {
          channels: ['TELEGRAM_BOT', 'SMS'],
          template: { body: 'Наряд {{documentNumber}}' },
        },
      }),
    );
    expect(inbox).toHaveLength(2);
    expect(h.enqueueChain).toHaveBeenCalledTimes(1);
    const chain = h.enqueueChain.mock.calls[0]![2] as {
      channel: string;
      recipient: string;
      message: string;
    }[];
    expect(chain).toEqual([
      expect.objectContaining({
        channel: 'SMS',
        recipient: '+380670000004',
        message: 'Наряд НРД-7',
      }),
    ]);
    expect(run?.status).toBe('DONE');
  });

  // Та сама модель, що в повідомленні клієнту (рішення власника 2026-10-29): без переліку — канали
  // філії в пріоритеті власника, але лише ті, що дозволені працівнику (email працівнику — ні).
  // guards: BR-AUT-011, BR-AUT-022
  it('зовнішній канал без переліку — канали філії за пріоритетом, лише дозволені працівнику', async () => {
    const h = automationHarness({
      rules: [
        fakeRule({
          actions: [
            notify({
              recipients: { employeeIds: [RECEPTION] },
              external: { template: { body: 'Наряд {{documentNumber}}' } },
            }),
          ],
        }),
      ],
      channels: ['EMAIL', 'SMS', 'TELEGRAM', 'VIBER'],
    });
    await h.engine.handle(fakeEvent());
    expect(h.resolveChannels).toHaveBeenCalledWith('org-a', fakeCtx().messageBranchId, null);
    const chain = h.enqueueChain.mock.calls[0]![2] as { channel: string; recipient: string }[];
    expect(chain.map(c => [c.channel, c.recipient])).toEqual([
      ['SMS', '+380670000004'],
      ['VIBER', '+380670000004'],
    ]);
  });

  // Канали філії однакові для всіх одержувачів дії — один запит, а не по одному на працівника
  // (до 500 одержувачів ролі).
  // guards: BR-AUT-022
  it('зовнішній канал кільком працівникам — канали філії читаються один раз на дію', async () => {
    const { h } = await fire(
      notify({
        recipients: { employeeIds: [RECEPTION, MECH_1], roles: ['MECHANIC'] },
        notifyInitiator: true,
        external: { channels: ['SMS'], template: { body: 'Наряд {{documentNumber}}' } },
      }),
    );
    expect(h.enqueueChain).toHaveBeenCalledTimes(2);
    expect(h.resolveChannels).toHaveBeenCalledTimes(1);
  });
});

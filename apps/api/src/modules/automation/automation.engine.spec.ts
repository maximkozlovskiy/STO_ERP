/**
 * Двигун правил (docs/objects/automation.md): відбір правил за подією, умови «І», дедуплікація
 * спрацювань, незалежність дій, вимкнене правило. Очікування — з тексту BR-AUT-002…006 і
 * «Двигун і дії — технічні рішення», не з коду.
 */
import { describe, it, expect } from 'vitest';
import { conditionsMet, runStatus } from './automation-engine';
import {
  BRANCH,
  OTHER_BRANCH,
  OTHER_ORG,
  automationHarness,
  clientMessage,
  fakeCtx,
  fakeEvent,
  fakeRule,
} from './automation.spec-fixture';

const notification = {
  type: 'employee_notification',
  recipients: { roles: ['MECHANIC'] },
  title: 'Наряд {{documentNumber}} в роботі',
};

describe('AutomationEngine — відбір і виконання правил', () => {
  // guards: BR-AUT-002
  it('спрацьовує правило свого типу документа, події й статусу; чужі — ні', async () => {
    const hit = fakeRule();
    const rules = [
      hit,
      fakeRule({ toStatuses: ['COMPLETED'] }),
      fakeRule({ eventKind: 'CREATED', toStatuses: [] }),
      fakeRule({ documentType: 'INVOICE', toStatuses: [] }),
      fakeRule({ orgId: OTHER_ORG }),
    ];
    const h = automationHarness({ rules });
    await h.engine.handle(fakeEvent());
    expect(h.runs.map(r => r.ruleId)).toEqual([hit.id]);
    expect(h.enqueueChain).toHaveBeenCalledTimes(1);
  });

  // guards: BR-AUT-002
  it('порожній перелік «у статус» — будь-який статус події', async () => {
    const any = fakeRule({ toStatuses: [] });
    const h = automationHarness({ rules: [any] });
    await h.engine.handle(fakeEvent({ toStatus: 'ON_HOLD' }));
    expect(h.runs).toHaveLength(1);
  });

  // guards: BR-AUT-006
  it('вимкнене або видалене правило не спрацьовує (читається на момент обробки)', async () => {
    const rules = [fakeRule({ enabled: false }), fakeRule({ deletedAt: new Date() })];
    const h = automationHarness({ rules });
    await h.engine.handle(fakeEvent());
    expect(h.runs).toHaveLength(0);
    expect(h.load).not.toHaveBeenCalled();
    expect(h.enqueueChain).not.toHaveBeenCalled();
  });

  // guards: BR-AUT-006
  it('зміна правила діє на наступні події: вимкнули після першої — друга без дій', async () => {
    const rule = fakeRule();
    const h = automationHarness({ rules: [rule] });
    await h.engine.handle(fakeEvent());
    rule.enabled = false;
    await h.engine.handle(fakeEvent());
    expect(h.runs).toHaveLength(1);
  });

  // guards: BR-AUT-004
  it('повторна обробка тієї самої події правило вдруге не виконує; нова подія — нове спрацювання', async () => {
    const rule = fakeRule();
    const h = automationHarness({ rules: [rule] });
    const event = fakeEvent();
    await h.engine.handle(event);
    await h.engine.handle(event);
    expect(h.runs).toHaveLength(1);
    expect(h.enqueueChain).toHaveBeenCalledTimes(1);
    // Наряд повернули й знову перевели у «В роботі» — нова подія, нове спрацювання.
    await h.engine.handle(fakeEvent());
    expect(h.runs).toHaveLength(2);
  });

  // guards: BR-AUT-004
  it('спрацювання захоплюється ДО дій: паралельний дубль (P2002) дій не виконує', async () => {
    const rule = fakeRule();
    const h = automationHarness({ rules: [rule] });
    const event = fakeEvent();
    // Інший обробник уже вставив спрацювання між читанням і вставкою.
    h.tables.automationRun.findMany.mockResolvedValueOnce([]);
    h.runs.push({ id: 'run-x', orgId: rule.orgId, ruleId: rule.id, eventId: event.id });
    await h.engine.handle(event);
    expect(h.enqueueChain).not.toHaveBeenCalled();
    expect(h.runs).toHaveLength(1);
  });

  // guards: BR-AUT-005
  it('помилка однієї дії не зупиняє інші; статус PARTIAL, помилка в результаті дії', async () => {
    const rule = fakeRule({ actions: [clientMessage(), notification] });
    const h = automationHarness({ rules: [rule] });
    h.enqueueChain.mockRejectedValueOnce(new Error('Redis недоступний'));
    await expect(h.engine.handle(fakeEvent())).resolves.toBeUndefined();
    const run = h.runs[0]!;
    expect(run.status).toBe('PARTIAL');
    expect(run.actionResults).toEqual([
      expect.objectContaining({
        index: 0,
        type: 'client_message',
        status: 'FAILED',
        error: 'Redis недоступний',
      }),
      expect.objectContaining({ index: 1, type: 'employee_notification', status: 'DONE' }),
    ]);
    expect(h.tables.employeeNotification.rows.length).toBeGreaterThan(0);
  });

  // guards: BR-AUT-005
  it('runStatus: DONE / SKIPPED / PARTIAL / FAILED за результатами дій', () => {
    const r = (status: 'DONE' | 'SKIPPED' | 'FAILED') => ({
      index: 0,
      type: 'create_task' as const,
      status,
    });
    expect(runStatus([r('DONE'), r('SKIPPED')])).toBe('DONE');
    expect(runStatus([r('SKIPPED'), r('SKIPPED')])).toBe('SKIPPED');
    expect(runStatus([r('DONE'), r('FAILED')])).toBe('PARTIAL');
    expect(runStatus([r('FAILED'), r('FAILED')])).toBe('FAILED');
  });

  // guards: BR-AUT-003
  it('умови не виконано — ні спрацювання, ні дій (без запису)', async () => {
    const rule = fakeRule({ conditions: { branchIds: [OTHER_BRANCH] } });
    const h = automationHarness({ rules: [rule] });
    await h.engine.handle(fakeEvent());
    expect(h.runs).toHaveLength(0);
    expect(h.enqueueChain).not.toHaveBeenCalled();
  });

  // guards: BR-AUT-003
  it('conditionsMet: усі умови — «І»; поле, якого немає, умову не проходить', () => {
    const c = (over: object) => ({
      branchIds: [],
      fromStatuses: [],
      repairCategories: [],
      priorities: [],
      ...over,
    });
    const ctx = fakeCtx();
    const ev = { fromStatus: 'APPROVED' };
    expect(conditionsMet(c({ branchIds: [BRANCH], minAmount: 5000 }), ev, ctx)).toBe(true);
    expect(conditionsMet(c({ branchIds: [BRANCH], minAmount: 5000.01 }), ev, ctx)).toBe(false);
    expect(conditionsMet(c({ fromStatuses: ['ESTIMATE'] }), ev, ctx)).toBe(false);
    expect(conditionsMet(c({ fromStatuses: ['APPROVED'] }), ev, ctx)).toBe(true);
    expect(conditionsMet(c({ repairCategories: ['BODY_REPAIR'] }), ev, ctx)).toBe(false);
    expect(conditionsMet(c({ priorities: ['NORMAL', 'HIGH'] }), ev, ctx)).toBe(true);
    // Документ без філії / без суми — умова не проходить.
    expect(conditionsMet(c({ branchIds: [BRANCH] }), ev, fakeCtx({ branchId: null }))).toBe(false);
    expect(conditionsMet(c({ minAmount: 0 }), ev, fakeCtx({ amount: null }))).toBe(false);
  });

  // guards: BR-AUT-003
  it('документ видалено до обробки — правила не виконуються', async () => {
    const h = automationHarness({ rules: [fakeRule()], ctx: null });
    await h.engine.handle(fakeEvent());
    expect(h.runs).toHaveLength(0);
  });

  // guards: BR-AUT-005
  it('зіпсоване збережене правило — спрацювання FAILED, решта правил виконується', async () => {
    const broken = fakeRule({ actions: [{ type: 'unknown' }] });
    const ok = fakeRule();
    const h = automationHarness({ rules: [broken, ok] });
    await h.engine.handle(fakeEvent());
    expect(h.runs.find(r => r.ruleId === broken.id)?.status).toBe('FAILED');
    expect(h.runs.find(r => r.ruleId === ok.id)?.status).toBe('DONE');
  });

  // guards: BR-AUT-052
  it('правила — у межах організації події: подія чужої org правил цієї org не запускає', async () => {
    const h = automationHarness({ rules: [fakeRule()] });
    await h.engine.handle(fakeEvent({ orgId: OTHER_ORG }));
    expect(h.runs).toHaveLength(0);
    await h.engine.handle(fakeEvent());
    expect(h.runs[0]?.orgId).toBe('org-a');
    expect(h.load).toHaveBeenCalledWith('org-a', 'WORK_ORDER', 'doc-wo-1');
  });
});

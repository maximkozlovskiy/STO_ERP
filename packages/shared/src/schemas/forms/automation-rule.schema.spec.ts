/**
 * Схема правила автоматизації (docs/objects/automation.md). Очікування — з тексту правил дос'є:
 * BR-AUT-001 (правило: назва, ≥ 1 дія), BR-AUT-003 (умови лише там, де в документа є таке поле),
 * BR-AUT-010 (повідомлення клієнту — лише документу з клієнтом), BR-AUT-014 (невідома змінна —
 * помилка збереження), BR-AUT-023 (ініціатор типово не отримує), BR-AUT-030 (задача).
 */
import { describe, it, expect } from 'vitest';
import { automationRuleSchema } from './automation-rule.schema';
import {
  AUTOMATION_DEFAULT_RULES,
  AUTOMATION_VARIABLES,
  defaultRuleActions,
  findUnknownTemplateVariables,
  renderAutomationTemplate,
  templateFragmentsValid,
  templateVariables,
} from '../../constants/automation-rules';

const base = {
  name: 'Наряд у роботі',
  documentType: 'WORK_ORDER',
  eventKind: 'STATUS_CHANGED',
  toStatuses: ['IN_PROGRESS'],
  actions: [
    {
      type: 'client_message',
      channels: ['VIBER', 'SMS'],
      template: { body: '{{clientName}}, ваше авто {{vehicle}} в роботі' },
    },
  ],
};

function issues(input: unknown): { message: string; path: string }[] {
  const r = automationRuleSchema.safeParse(input);
  return r.success ? [] : r.error.issues.map(i => ({ message: i.message, path: i.path.join('.') }));
}

describe('automationRuleSchema', () => {
  // guards: BR-AUT-001
  it('мінімальне правило проходить; типові значення — увімкнено, службове, без умов', () => {
    const r = automationRuleSchema.parse(base);
    expect(r.enabled).toBe(true);
    expect(r.messageKind).toBe('SERVICE');
    expect(r.conditions).toEqual({
      branchIds: [],
      fromStatuses: [],
      repairCategories: [],
      priorities: [],
    });
  });

  // guards: BR-AUT-001
  it('без дій і без назви — помилка', () => {
    expect(issues({ ...base, actions: [] }).map(i => i.message)).toContain(
      'v.automation.actions.required',
    );
    expect(issues({ ...base, name: '   ' }).map(i => i.message)).toContain(
      'v.automation.name.required',
    );
  });

  // guards: BR-AUT-014
  it('невідома змінна в шаблоні — помилка з шляхом поля; змінна іншого типу документа теж', () => {
    const bad = {
      ...base,
      actions: [{ ...base.actions[0], template: { body: 'Привіт {{clientNme}}' } }],
    };
    expect(issues(bad)).toContainEqual({
      message: 'v.automation.template.unknownVariable',
      path: 'actions.0.template.body',
    });
    // `visitDate` є лише в онлайн-запису — у наряді це невідома змінна.
    const foreign = {
      ...base,
      actions: [{ ...base.actions[0], template: { body: '{{visitDate}}' } }],
    };
    expect(issues(foreign).map(i => i.message)).toContain('v.automation.template.unknownVariable');
  });

  // guards: BR-AUT-014
  it('каталог: findUnknownTemplateVariables, templateVariables, render підставляє значення', () => {
    expect(findUnknownTemplateVariables('{{ clientName }} {{x}} {{x}}', 'WORK_ORDER')).toEqual([
      'x',
    ]);
    expect(templateVariables('{{a}}{{b}}{{a}}')).toEqual(['a', 'b']);
    expect(
      renderAutomationTemplate('Наряд {{documentNumber}}: {{status}}', {
        documentNumber: 'WO-1',
        status: 'В роботі',
      }),
    ).toBe('Наряд WO-1: В роботі');
    for (const vars of Object.values(AUTOMATION_VARIABLES))
      expect(new Set(vars).size).toBe(vars.length);
  });

  // guards: BR-AUT-003
  it('умова, якої в документа немає (тип ремонту в рахунку, сума в складському), — помилка', () => {
    const invoice = {
      ...base,
      documentType: 'INVOICE',
      toStatuses: ['PAID'],
      conditions: { repairCategories: ['MAINTENANCE'] },
    };
    expect(issues(invoice)).toContainEqual({
      message: 'v.automation.conditions.notApplicable',
      path: 'conditions.repairCategories',
    });
    const stock = {
      ...base,
      documentType: 'STOCK_DOCUMENT',
      toStatuses: [],
      actions: [
        {
          type: 'employee_notification',
          recipients: { roles: ['STOREKEEPER'] },
          title: 'Док {{documentNumber}}',
        },
      ],
      conditions: { minAmount: 100 },
    };
    expect(issues(stock).map(i => i.path)).toContain('conditions.minAmount');
    const created = {
      ...base,
      eventKind: 'CREATED',
      toStatuses: [],
      conditions: { fromStatuses: ['DRAFT'] },
    };
    expect(issues(created).map(i => i.path)).toContain('conditions.fromStatuses');
  });

  // guards: BR-AUT-003
  it('статус поза переліком типу документа — помилка; сума ≥ X для рахунку проходить', () => {
    expect(issues({ ...base, toStatuses: ['SENT'] }).map(i => i.message)).toContain(
      'v.automation.status.invalid',
    );
    const ok = {
      ...base,
      documentType: 'INVOICE',
      toStatuses: ['PAID'],
      conditions: { minAmount: 5000 },
    };
    expect(issues(ok)).toEqual([]);
  });

  // guards: BR-AUT-003
  it('«оплату створено» → у статус: лише «діє»; «Сторновано» на створенні — помилка (правило-мовчун)', () => {
    const paymentCreated = {
      ...base,
      documentType: 'PAYMENT',
      eventKind: 'CREATED',
      actions: [
        {
          type: 'client_message',
          channels: ['SMS'],
          template: { body: 'Дякуємо, {{clientName}}' },
        },
      ],
    };
    expect(issues({ ...paymentCreated, toStatuses: ['ACTIVE'] })).toEqual([]);
    expect(issues({ ...paymentCreated, toStatuses: [] })).toEqual([]);
    expect(issues({ ...paymentCreated, toStatuses: ['REVERSED'] })).toEqual([
      { message: 'v.automation.conditions.notApplicable', path: 'toStatuses.0' },
    ]);
    // Сторно — подія «статус змінено»: там «Сторновано» — звичайна умова.
    expect(
      issues({ ...paymentCreated, eventKind: 'STATUS_CHANGED', toStatuses: ['REVERSED'] }),
    ).toEqual([]);
  });

  // guards: BR-AUT-010
  it('повідомлення клієнту для документа без клієнта (замовлення постачальнику) — помилка', () => {
    const po = {
      ...base,
      documentType: 'PURCHASE_ORDER',
      toStatuses: ['ORDERED'],
      actions: [{ ...base.actions[0], template: { body: 'x' } }],
    };
    expect(issues(po).map(i => i.message)).toContain('v.automation.action.noClient');
  });

  // Рішення власника 2026-10-29: «Я налаштовую самостійно пріоритет, немає фіксованих».
  // guards: BR-AUT-011
  it('канали: без переліку чи порожній — «як у філії» (undefined); перелік — як є; повтор — помилка', () => {
    const channelsOf = (input: unknown) => {
      const a = automationRuleSchema.parse(input).actions[0];
      return a?.type === 'client_message' ? a.channels : 'not-client';
    };
    const { channels: _omit, ...noChannels } = base.actions[0]!;
    expect(channelsOf({ ...base, actions: [noChannels] })).toBeUndefined();
    expect(channelsOf({ ...base, actions: [{ ...noChannels, channels: [] }] })).toBeUndefined();
    expect(
      channelsOf({ ...base, actions: [{ ...noChannels, channels: ['SMS', 'VIBER'] }] }),
    ).toEqual(['SMS', 'VIBER']);
    const dup = { ...base, actions: [{ ...base.actions[0], channels: ['SMS', 'SMS'] }] };
    expect(issues(dup).map(i => i.message)).toContain('v.automation.channels.duplicate');

    // Зовнішнє сповіщення працівнику — та сама модель.
    const external = automationRuleSchema.parse({
      ...base,
      actions: [
        {
          type: 'employee_notification',
          recipients: { responsible: true },
          title: 'Т',
          external: { channels: [], template: { body: 'Наряд {{documentNumber}}' } },
        },
      ],
    }).actions[0];
    expect(external?.type === 'employee_notification' && external.external?.channels).toBe(
      undefined,
    );
  });

  // Bug #998: «Головна філія, тел. » — порожній телефон організації лишав хвіст без номера.
  // guards: BR-AUT-014
  it('фрагмент [[…]]: порожня змінна всередині прибирає фрагмент цілком, інакше дужки знімаються', () => {
    const tpl = '{{branchName}}[[, тел. {{branchPhone}}]]. Дякуємо';
    expect(renderAutomationTemplate(tpl, { branchName: 'Головна філія' })).toBe(
      'Головна філія. Дякуємо',
    );
    expect(renderAutomationTemplate(tpl, { branchName: 'Головна філія', branchPhone: '  ' })).toBe(
      'Головна філія. Дякуємо',
    );
    expect(
      renderAutomationTemplate(tpl, { branchName: 'Головна філія', branchPhone: '+380441234567' }),
    ).toBe('Головна філія, тел. +380441234567. Дякуємо');
    // Хоч одна порожня з кількох — фрагмент випадає; фрагмент без змінних лишається текстом.
    expect(
      renderAutomationTemplate('А[[ {{clientName}} {{vehicle}}]][[ Б]]', { clientName: 'Іван' }),
    ).toBe('А Б');
    // Значення змінної не розбирається як шаблон.
    expect(
      renderAutomationTemplate('[[{{clientName}}]]', { clientName: '[[x]] {{vehicle}}' }),
    ).toBe('[[x]] {{vehicle}}');
  });

  // guards: BR-AUT-014
  it('фрагмент [[…]]: вкладений, незакритий чи зайве «]]» — помилка; змінна фрагмента — з каталогу', () => {
    const withBody = (body: string) => ({
      ...base,
      actions: [{ ...base.actions[0], template: { body } }],
    });
    expect(issues(withBody('{{branchName}}[[, тел. {{branchPhone}}]]'))).toEqual([]);
    for (const bad of ['[[a [[{{vehicle}}]] b]]', '[[, тел. {{branchPhone}}', 'тел.]] x', ']][['])
      expect(issues(withBody(bad)), bad).toContainEqual({
        message: 'v.automation.template.fragment',
        path: 'actions.0.template.body',
      });
    expect(issues(withBody('[[ {{visitDate}}]]')).map(i => i.message)).toContain(
      'v.automation.template.unknownVariable',
    );
    expect(templateFragmentsValid('[[a]] b [[c]]')).toBe(true);
  });

  // guards: BR-AUT-020, BR-AUT-023
  it('сповіщення працівнику: потрібні одержувачі й канал; ініціатор типово не отримує', () => {
    const noOne = {
      ...base,
      actions: [{ type: 'employee_notification', recipients: {}, title: 'Т' }],
    };
    expect(issues(noOne).map(i => i.message)).toContain('v.automation.recipients.required');
    const silent = {
      ...base,
      actions: [
        {
          type: 'employee_notification',
          recipients: { responsible: true },
          title: 'Т',
          inApp: false,
        },
      ],
    };
    expect(issues(silent).map(i => i.message)).toContain(
      'v.automation.notification.channelRequired',
    );
    const ok = automationRuleSchema.parse({
      ...base,
      actions: [
        {
          type: 'employee_notification',
          recipients: { responsible: true },
          title: 'Наряд {{documentNumber}}',
        },
      ],
    });
    const action = ok.actions[0];
    expect(action?.type === 'employee_notification' && action.notifyInitiator).toBe(false);
  });

  // guards: BR-AUT-030
  it('задача: термін — ціле число годин 0…720; на подію задачі задачу не ставить', () => {
    const task = (patch: object) => ({
      ...base,
      actions: [
        {
          type: 'create_task',
          title: 'Підготувати пост',
          assignee: 'responsible',
          dueInHours: 2,
          ...patch,
        },
      ],
    });
    expect(issues(task({}))).toEqual([]);
    expect(issues(task({ dueInHours: 1.5 })).map(i => i.message)).toContain(
      'v.automation.task.dueInHours',
    );
    expect(issues(task({ dueInHours: 721 })).map(i => i.message)).toContain(
      'v.automation.task.dueInHours',
    );
    const onTask = { ...task({}), documentType: 'TASK', toStatuses: ['DONE'] };
    expect(issues(onTask).map(i => i.message)).toContain('v.automation.action.taskOnTask');
  });

  // guards: BR-AUT-007, BR-AUT-011, BR-AUT-014
  it('типові правила проходять схему; канали — «як у філії»; телефон — у фрагменті', () => {
    for (const d of AUTOMATION_DEFAULT_RULES) {
      expect(defaultRuleActions(d)[0]).not.toHaveProperty('channels');
      expect(d.body, d.systemKey).toContain('[[, тел. {{branchPhone}}]]');
      expect(renderAutomationTemplate(d.body, {}), d.systemKey).not.toMatch(/тел\.|\[\[|\]\]/);
      const r = automationRuleSchema.safeParse({
        name: d.name,
        documentType: d.documentType,
        eventKind: d.eventKind,
        toStatuses: [...d.toStatuses],
        messageKind: d.messageKind,
        actions: defaultRuleActions(d),
      });
      expect(r.success, d.systemKey).toBe(true);
    }
  });
});

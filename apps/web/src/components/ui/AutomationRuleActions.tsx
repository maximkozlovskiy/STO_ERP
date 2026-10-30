'use client';

import { useId, useMemo } from 'react';
import { Controller, useFormContext, useWatch } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { ArrowDown, ArrowUp, Bell, ListTodo, MessageSquare, Trash2, X } from 'lucide-react';
import {
  AUTOMATION_CHANNELS,
  AUTOMATION_EMPLOYEE_CHANNELS,
  AUTOMATION_PRIORITIES,
  AUTOMATION_RECIPIENT_ROLES,
  AUTOMATION_RULE_NAME_MAX,
  AUTOMATION_TASK_DUE_HOURS_MAX,
  AUTOMATION_TEMPLATE_BODY_MAX,
  AUTOMATION_TEMPLATE_SUBJECT_MAX,
  TASK_DESCRIPTION_MAX,
  TASK_TITLE_MAX,
  type AutomationActionTypeValue,
  type AutomationDocumentTypeValue,
  type AutomationRuleFormInput,
  type AutomationRuleFormValues,
} from '@sto/shared';
import { cn } from '@/lib/utils';
import { automationChannelLabel } from '@/lib/automation';
import { employeeRoleLabel, woPriorityLabel } from '@/i18n/enumLabel';
import { Button } from './button';
import { Input } from './input';
import { Select } from './select';
import { TemplateBodyEditor } from './TemplateBodyEditor';

type ActionInput = AutomationRuleFormInput['actions'][number];

export const ACTION_ICONS: Record<AutomationActionTypeValue, typeof Bell> = {
  client_message: MessageSquare,
  employee_notification: Bell,
  create_task: ListTodo,
};

/** Нова дія з типовими значеннями (ініціатор — без сповіщення, BR-AUT-023). */
export function newAction(type: AutomationActionTypeValue): ActionInput {
  switch (type) {
    case 'client_message':
      return { type, channels: [], template: { subject: '', body: '' } };
    case 'employee_notification':
      return {
        type,
        recipients: { employeeIds: [], roles: [], responsible: true },
        title: '',
        body: '',
        inApp: true,
        notifyInitiator: false,
      };
    case 'create_task':
      return {
        type,
        title: '',
        description: '',
        assignee: 'responsible',
        fallbackEmployeeId: '',
        dueInHours: 2,
        priority: 'NORMAL',
      };
    default: {
      const _exhaustive: never = type;
      return _exhaustive;
    }
  }
}

export interface EmployeeOption {
  id: string;
  name: string;
  active: boolean;
}

/** Помилка поля з дерева помилок RHF за шляхом `a.0.b` (масиви дій — різні типи). */
function errorAt(errors: unknown, path: string): string | undefined {
  let node: unknown = errors;
  for (const key of path.split('.')) {
    if (!node || typeof node !== 'object') return undefined;
    node = (node as Record<string, unknown>)[key];
  }
  if (node && typeof node === 'object' && 'message' in node) {
    const m = (node as { message?: unknown }).message;
    return typeof m === 'string' ? m : undefined;
  }
  return undefined;
}

// ── Канали: «як у філії» (порожній перелік) або явний упорядкований перелік (BR-AUT-011) ──

interface ChannelListEditorProps {
  value: readonly string[];
  onChange: (next: string[]) => void;
  options: readonly string[];
  error?: string | undefined;
  testId: string;
}

function ChannelListEditor({ value, onChange, options, error, testId }: ChannelListEditorProps) {
  const { t } = useTranslation('automation');
  const name = useId();
  const custom = value.length > 0;
  const remaining = options.filter(o => !value.includes(o));

  const move = (i: number, dir: -1 | 1) => {
    const next = [...value];
    const j = i + dir;
    if (j < 0 || j >= next.length) return;
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
  };

  return (
    <fieldset className="space-y-2" data-testid={testId}>
      <legend className="text-[13px] font-medium text-foreground mb-1">{t('card.channels')}</legend>
      <label className="flex items-start gap-2 text-[13px] cursor-pointer">
        <input
          type="radio"
          name={name}
          checked={!custom}
          onChange={() => onChange([])}
          className="mt-0.5"
        />
        <span>
          <span className="text-foreground">{t('card.channelsBranch')}</span>
          <span className="block text-[12px] text-muted-foreground">
            {t('card.channelsBranchHint')}
          </span>
        </span>
      </label>
      <label className="flex items-start gap-2 text-[13px] cursor-pointer">
        <input
          type="radio"
          name={name}
          checked={custom}
          onChange={() => {
            if (!custom && options[0]) onChange([options[0]]);
          }}
          className="mt-0.5"
        />
        <span>
          <span className="text-foreground">{t('card.channelsCustom')}</span>
          <span className="block text-[12px] text-muted-foreground">
            {t('card.channelsCustomHint')}
          </span>
        </span>
      </label>
      {custom && (
        <div className="ml-6 space-y-1.5">
          <ol className="space-y-1">
            {value.map((ch, i) => (
              <li
                key={ch}
                className="flex items-center gap-2 rounded-lg border border-border bg-surface px-2 py-1"
                data-channel={ch}
              >
                <span className="w-5 text-right text-[12px] tabular-nums text-muted-foreground">
                  {i + 1}.
                </span>
                <span className="flex-1 text-[13px] text-foreground">
                  {automationChannelLabel(ch)}
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  onClick={() => move(i, -1)}
                  disabled={i === 0}
                  aria-label={`${t('card.moveUp')}: ${automationChannelLabel(ch)}`}
                >
                  <ArrowUp className="h-3.5 w-3.5" aria-hidden="true" />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  onClick={() => move(i, 1)}
                  disabled={i === value.length - 1}
                  aria-label={`${t('card.moveDown')}: ${automationChannelLabel(ch)}`}
                >
                  <ArrowDown className="h-3.5 w-3.5" aria-hidden="true" />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  onClick={() => onChange(value.filter(c => c !== ch))}
                  aria-label={t('card.removeChannel', { channel: automationChannelLabel(ch) })}
                  className="text-destructive/70 hover:text-destructive hover:bg-destructive/10"
                >
                  <X className="h-3.5 w-3.5" aria-hidden="true" />
                </Button>
              </li>
            ))}
          </ol>
          {remaining.length > 0 && (
            <Select
              aria-label={t('card.addChannel')}
              value=""
              onChange={e => {
                if (e.target.value) onChange([...value, e.target.value]);
              }}
              className="h-8 w-56 text-[13px] py-0.5 px-2 pr-7"
            >
              <option value="">{t('card.addChannel')}</option>
              {remaining.map(ch => (
                <option key={ch} value={ch}>
                  {automationChannelLabel(ch)}
                </option>
              ))}
            </Select>
          )}
        </div>
      )}
      {error && <p className="text-[12px] text-destructive-text">{error}</p>}
    </fieldset>
  );
}

// ── Працівники: чипи обраних + список для додавання ──

interface EmployeeChipsProps {
  value: readonly string[];
  onChange: (next: string[]) => void;
  employees: readonly EmployeeOption[];
  /** Перелік працівників прочитано — лише тоді відсутній у ньому стає «недоступним». */
  loaded: boolean;
}

function EmployeeChips({ value, onChange, employees, loaded }: EmployeeChipsProps) {
  const { t } = useTranslation('automation');
  const byId = useMemo(() => new Map(employees.map(e => [e.id, e])), [employees]);
  const options = employees.filter(e => e.active && !value.includes(e.id));
  return (
    <div className="space-y-1.5">
      <p className="text-[12px] font-medium text-foreground">{t('card.employees')}</p>
      {value.length > 0 && (
        <ul className="flex flex-wrap gap-1.5">
          {value.map(id => {
            const e = byId.get(id);
            const name = e?.name ?? (loaded ? '' : '…');
            const label =
              loaded && (!e || !e.active)
                ? t('card.employeeUnavailable', { name: name || id })
                : name;
            return (
              <li
                key={id}
                className={cn(
                  'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[12px]',
                  loaded && (!e || !e.active)
                    ? 'border-warning-border bg-warning-subtle text-warning-text'
                    : 'border-border bg-secondary text-foreground',
                )}
              >
                {label}
                <button
                  type="button"
                  onClick={() => onChange(value.filter(v => v !== id))}
                  aria-label={t('card.removeEmployee', { name: label })}
                  className="text-muted-foreground hover:text-destructive"
                >
                  <X className="h-3 w-3" aria-hidden="true" />
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <Select
        aria-label={t('card.employeesPlaceholder')}
        value=""
        onChange={e => {
          if (e.target.value) onChange([...value, e.target.value]);
        }}
        className="h-8 w-64 text-[13px] py-0.5 px-2 pr-7"
      >
        <option value="">{t('card.employeesPlaceholder')}</option>
        {options.map(e => (
          <option key={e.id} value={e.id}>
            {e.name}
          </option>
        ))}
      </Select>
    </div>
  );
}

// ── Картка однієї дії ──

interface ActionCardProps {
  index: number;
  count: number;
  documentType: AutomationDocumentTypeValue;
  employees: readonly EmployeeOption[];
  employeesLoaded: boolean;
  onRemove: () => void;
  onMove: (dir: -1 | 1) => void;
  onSendTest?: (() => void) | undefined;
  sendTestBlockedReason?: string | undefined;
}

/**
 * Дія правила в картці (BR-AUT-010…032): повідомлення клієнту, сповіщення працівникам або задача.
 * Поля — через контекст форми картки (`FormProvider`), помилки — зі спільної схеми правила.
 */
export function AutomationActionCard({
  index,
  count,
  documentType,
  employees,
  employeesLoaded,
  onRemove,
  onMove,
  onSendTest,
  sendTestBlockedReason,
}: ActionCardProps) {
  const { t } = useTranslation('automation');
  const {
    control,
    register,
    setValue,
    formState: { errors },
  } = useFormContext<AutomationRuleFormInput, unknown, AutomationRuleFormValues>();
  const action = useWatch({ control, name: `actions.${index}` });
  const base = `actions.${index}` as const;
  const err = (rel: string) => errorAt(errors, `${base}.${rel}`);
  const Icon = ACTION_ICONS[action.type];
  const activeEmployees = employees.filter(e => e.active);

  const header = (
    <div className="flex items-center gap-2 border-b border-border pb-2 mb-3">
      <Icon className="h-4 w-4 text-primary" aria-hidden="true" />
      <h3 className="flex-1 text-[13px] font-semibold text-foreground">
        {t('card.actionN', { n: index + 1 })}: {t(`actionTypes.${action.type}`)}
      </h3>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        onClick={() => onMove(-1)}
        disabled={index === 0}
        aria-label={`${t('card.moveUp')}: ${t('card.actionN', { n: index + 1 })}`}
      >
        <ArrowUp className="h-3.5 w-3.5" aria-hidden="true" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        onClick={() => onMove(1)}
        disabled={index === count - 1}
        aria-label={`${t('card.moveDown')}: ${t('card.actionN', { n: index + 1 })}`}
      >
        <ArrowDown className="h-3.5 w-3.5" aria-hidden="true" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        onClick={onRemove}
        aria-label={`${t('card.removeAction')}: ${t('card.actionN', { n: index + 1 })}`}
        className="text-destructive/70 hover:text-destructive hover:bg-destructive/10"
      >
        <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
      </Button>
    </div>
  );

  const typeError = err('type');

  return (
    <section
      className="rounded-xl border border-border bg-surface p-4"
      data-testid={`action-${index}`}
      data-action-type={action.type}
    >
      {header}
      {typeError && (
        <p className="mb-3 text-[12px] text-destructive-text" role="alert">
          {typeError}
        </p>
      )}

      {action.type === 'client_message' && (
        <div className="space-y-4">
          <Controller
            control={control}
            name={`actions.${index}.channels`}
            render={({ field }) => (
              <ChannelListEditor
                value={field.value ?? []}
                onChange={field.onChange}
                options={AUTOMATION_CHANNELS}
                error={err('channels')}
                testId={`action-${index}-channels`}
              />
            )}
          />
          <Controller
            control={control}
            name={`actions.${index}.template.subject`}
            render={({ field }) => (
              <TemplateBodyEditor
                label={t('card.subject')}
                singleLine
                value={field.value ?? ''}
                onChange={field.onChange}
                onBlur={field.onBlur}
                documentType={documentType}
                maxLength={AUTOMATION_TEMPLATE_SUBJECT_MAX}
                error={err('template.subject')}
              />
            )}
          />
          <Controller
            control={control}
            name={`actions.${index}.template.body`}
            render={({ field }) => (
              <TemplateBodyEditor
                label={t('card.body')}
                required
                value={field.value}
                onChange={field.onChange}
                onBlur={field.onBlur}
                documentType={documentType}
                maxLength={AUTOMATION_TEMPLATE_BODY_MAX}
                error={err('template.body')}
                onSendTest={onSendTest}
                sendTestBlockedReason={sendTestBlockedReason}
                data-testid={`action-${index}-body`}
              />
            )}
          />
        </div>
      )}

      {action.type === 'employee_notification' && (
        <div className="space-y-4">
          <fieldset className="space-y-2">
            <legend className="text-[13px] font-medium text-foreground mb-1">
              {t('card.recipients')}
            </legend>
            <label className="flex items-start gap-2 text-[13px] cursor-pointer">
              <input
                type="checkbox"
                className="mt-0.5"
                {...register(`actions.${index}.recipients.responsible`)}
              />
              <span>
                <span className="text-foreground">{t('card.responsible')}</span>
                <span className="block text-[12px] text-muted-foreground">
                  {t('card.responsibleHint')}
                </span>
              </span>
            </label>
            <div>
              <p className="text-[12px] font-medium text-foreground mb-1">{t('card.roles')}</p>
              <div className="flex flex-wrap gap-x-4 gap-y-1">
                {AUTOMATION_RECIPIENT_ROLES.map(role => (
                  <label key={role} className="flex items-center gap-1.5 text-[13px]">
                    <input
                      type="checkbox"
                      value={role}
                      {...register(`actions.${index}.recipients.roles`)}
                    />
                    {employeeRoleLabel(role)}
                  </label>
                ))}
              </div>
            </div>
            <Controller
              control={control}
              name={`actions.${index}.recipients.employeeIds`}
              render={({ field }) => (
                <EmployeeChips
                  value={field.value ?? []}
                  onChange={field.onChange}
                  employees={employees}
                  loaded={employeesLoaded}
                />
              )}
            />
            {err('recipients') && (
              <p className="text-[12px] text-destructive-text" role="alert">
                {err('recipients')}
              </p>
            )}
            <label className="flex items-start gap-2 text-[13px] cursor-pointer">
              <input
                type="checkbox"
                className="mt-0.5"
                {...register(`actions.${index}.notifyInitiator`)}
              />
              <span>
                <span className="text-foreground">{t('card.notifyInitiator')}</span>
                <span className="block text-[12px] text-muted-foreground">
                  {t('card.notifyInitiatorHint')}
                </span>
              </span>
            </label>
          </fieldset>

          <label className="flex items-center gap-2 text-[13px] cursor-pointer">
            <input type="checkbox" {...register(`actions.${index}.inApp`)} />
            <span className="text-foreground">{t('card.inApp')}</span>
          </label>
          {err('inApp') && (
            <p className="text-[12px] text-destructive-text" role="alert">
              {err('inApp')}
            </p>
          )}
          <Controller
            control={control}
            name={`actions.${index}.title`}
            render={({ field }) => (
              <TemplateBodyEditor
                label={t('card.notificationTitle')}
                singleLine
                required
                value={field.value}
                onChange={field.onChange}
                onBlur={field.onBlur}
                documentType={documentType}
                maxLength={AUTOMATION_RULE_NAME_MAX}
                error={err('title')}
                data-testid={`action-${index}-title`}
              />
            )}
          />
          <Controller
            control={control}
            name={`actions.${index}.body`}
            render={({ field }) => (
              <TemplateBodyEditor
                label={t('card.notificationBody')}
                rows={3}
                value={field.value ?? ''}
                onChange={field.onChange}
                onBlur={field.onBlur}
                documentType={documentType}
                maxLength={AUTOMATION_TEMPLATE_BODY_MAX}
                error={err('body')}
              />
            )}
          />

          <label className="flex items-center gap-2 text-[13px] cursor-pointer">
            <input
              type="checkbox"
              checked={!!action.external}
              onChange={e =>
                setValue(
                  `actions.${index}.external`,
                  e.target.checked
                    ? { channels: [], template: { subject: '', body: '' } }
                    : undefined,
                  { shouldDirty: true },
                )
              }
            />
            <span className="text-foreground">{t('card.external')}</span>
          </label>
          {action.external && (
            <div className="ml-6 space-y-4">
              <Controller
                control={control}
                name={`actions.${index}.external.channels`}
                render={({ field }) => (
                  <ChannelListEditor
                    value={field.value ?? []}
                    onChange={field.onChange}
                    options={AUTOMATION_EMPLOYEE_CHANNELS}
                    error={err('external.channels')}
                    testId={`action-${index}-external-channels`}
                  />
                )}
              />
              <Controller
                control={control}
                name={`actions.${index}.external.template.body`}
                render={({ field }) => (
                  <TemplateBodyEditor
                    label={t('card.externalBody')}
                    required
                    rows={3}
                    value={field.value ?? ''}
                    onChange={field.onChange}
                    onBlur={field.onBlur}
                    documentType={documentType}
                    maxLength={AUTOMATION_TEMPLATE_BODY_MAX}
                    error={err('external.template.body')}
                    onSendTest={onSendTest}
                    sendTestBlockedReason={sendTestBlockedReason}
                  />
                )}
              />
            </div>
          )}
        </div>
      )}

      {action.type === 'create_task' && (
        <div className="space-y-4">
          <Controller
            control={control}
            name={`actions.${index}.title`}
            render={({ field }) => (
              <TemplateBodyEditor
                label={t('card.taskTitle')}
                singleLine
                required
                value={field.value}
                onChange={field.onChange}
                onBlur={field.onBlur}
                documentType={documentType}
                maxLength={TASK_TITLE_MAX}
                error={err('title')}
                data-testid={`action-${index}-task-title`}
              />
            )}
          />
          <Controller
            control={control}
            name={`actions.${index}.description`}
            render={({ field }) => (
              <TemplateBodyEditor
                label={t('card.taskDescription')}
                rows={3}
                value={field.value ?? ''}
                onChange={field.onChange}
                onBlur={field.onBlur}
                documentType={documentType}
                maxLength={TASK_DESCRIPTION_MAX}
                error={err('description')}
              />
            )}
          />
          <fieldset className="space-y-2">
            <legend className="text-[13px] font-medium text-foreground mb-1">
              {t('card.assignee')}
            </legend>
            <label className="flex items-center gap-2 text-[13px] cursor-pointer">
              <input
                type="radio"
                checked={action.assignee === 'responsible'}
                onChange={() =>
                  setValue(`actions.${index}.assignee`, 'responsible', { shouldDirty: true })
                }
              />
              {t('card.assigneeResponsible')}
            </label>
            <label className="flex items-center gap-2 text-[13px] cursor-pointer">
              <input
                type="radio"
                checked={action.assignee !== 'responsible'}
                onChange={() =>
                  setValue(`actions.${index}.assignee`, { employeeId: '' }, { shouldDirty: true })
                }
              />
              {t('card.assigneeSpecific')}
            </label>
            {action.assignee !== 'responsible' && (
              <div className="ml-6">
                <Select
                  aria-label={t('card.assigneeSpecific')}
                  value={action.assignee.employeeId}
                  onChange={e =>
                    setValue(
                      `actions.${index}.assignee`,
                      { employeeId: e.target.value },
                      { shouldDirty: true, shouldValidate: true },
                    )
                  }
                  errorMessage={err('assignee.employeeId')}
                  className="h-8 w-64 text-[13px] py-0.5 px-2 pr-7"
                >
                  <option value="">{t('card.assigneePlaceholder')}</option>
                  {activeEmployees.map(e => (
                    <option key={e.id} value={e.id}>
                      {e.name}
                    </option>
                  ))}
                </Select>
              </div>
            )}
          </fieldset>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Select
              id={`action-${index}-fallback`}
              label={t('card.fallbackAssignee')}
              hint={t('card.fallbackHint')}
              errorMessage={err('fallbackEmployeeId')}
              {...register(`actions.${index}.fallbackEmployeeId`)}
            >
              <option value="">{t('card.fallbackNone')}</option>
              {activeEmployees.map(e => (
                <option key={e.id} value={e.id}>
                  {e.name}
                </option>
              ))}
            </Select>
            <Input
              id={`action-${index}-due`}
              type="number"
              min={0}
              max={AUTOMATION_TASK_DUE_HOURS_MAX}
              step={1}
              label={t('card.dueInHours')}
              errorMessage={err('dueInHours')}
              {...register(`actions.${index}.dueInHours`, { valueAsNumber: true })}
            />
            <Select
              id={`action-${index}-priority`}
              label={t('card.priority')}
              {...register(`actions.${index}.priority`)}
            >
              {AUTOMATION_PRIORITIES.map(p => (
                <option key={p} value={p}>
                  {woPriorityLabel(p)}
                </option>
              ))}
            </Select>
          </div>
        </div>
      )}
    </section>
  );
}

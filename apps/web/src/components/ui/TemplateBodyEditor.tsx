'use client';

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Braces, Eye, EyeOff, Send } from 'lucide-react';
import {
  AUTOMATION_VARIABLES,
  findUnknownTemplateVariables,
  renderAutomationTemplate,
  templateFragmentsValid,
  type AutomationDocumentTypeValue,
  type AutomationVariableKey,
} from '@sto/shared';
import { cn } from '@/lib/utils';
import { automationDocumentTypeLabel } from '@/lib/automation';
import { useEscapeLayer } from '@/hooks/useEscapeLayer';
import { Button } from './button';

/** Приклад необов'язкового фрагмента в підказці — літерал, а не i18n (дужки шаблону). */
const FRAGMENT_EXAMPLE = '{{branchName}}[[, тел. {{branchPhone}}]]';

interface TemplateBodyEditorProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  onBlur?: () => void;
  /** Тип документа правила — каталог змінних (BR-AUT-014). */
  documentType: AutomationDocumentTypeValue;
  maxLength: number;
  /** Однорядкове поле (заголовок, тема, назва задачі) замість багаторядкового тексту. */
  singleLine?: boolean;
  rows?: number;
  required?: boolean;
  placeholder?: string;
  /** Помилка схеми (zod) — уже перекладена. */
  error?: string | undefined;
  /** «Надіслати тест» поруч із редактором; без колбека кнопки немає. */
  onSendTest?: (() => void) | undefined;
  /** Чому тест зараз недоступний (незбережене правило) — кнопка вимкнена з цією підказкою. */
  sendTestBlockedReason?: string | undefined;
  'data-testid'?: string;
}

/**
 * Редактор тексту шаблону правила автоматизації (docs/objects/automation.md, BR-AUT-014): вставка
 * змінної з каталогу типу документа в позицію курсора, підсвічування невідомих змінних і зламаного
 * фрагмента `[[…]]` ще до збереження (сервер відповість тим самим 400), перегляд з прикладовими
 * даними — тим самим `renderAutomationTemplate`, що й двигун, і «Надіслати тест».
 */
export function TemplateBodyEditor({
  label,
  value,
  onChange,
  onBlur,
  documentType,
  maxLength,
  singleLine = false,
  rows = 4,
  required,
  placeholder,
  error,
  onSendTest,
  sendTestBlockedReason,
  'data-testid': testId,
}: TemplateBodyEditorProps) {
  const { t } = useTranslation('automation');
  const id = useId();
  const fieldRef = useRef<HTMLTextAreaElement | HTMLInputElement | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [preview, setPreview] = useState(false);
  // Позиція курсора, з якою відкрили меню: фокус іде в меню, і selectionStart поля вже не той.
  const caretRef = useRef<{ start: number; end: number } | null>(null);
  const pendingCaretRef = useRef<number | null>(null);

  useEscapeLayer(menuOpen, () => setMenuOpen(false));
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [menuOpen]);

  // Курсор після вставки — одразу за змінною (після того, як значення дійшло з форми).
  useEffect(() => {
    const pos = pendingCaretRef.current;
    const el = fieldRef.current;
    if (pos === null || !el) return;
    pendingCaretRef.current = null;
    el.focus();
    el.setSelectionRange(pos, pos);
  }, [value]);

  const variables = AUTOMATION_VARIABLES[documentType];
  const unknown = useMemo(
    () => findUnknownTemplateVariables(value, documentType),
    [value, documentType],
  );
  const fragmentsOk = useMemo(() => templateFragmentsValid(value), [value]);
  const samples = useMemo(() => {
    const out: Partial<Record<AutomationVariableKey, string>> = {};
    // Телефон організації в прикладі порожній навмисно: так видно, як зникає фрагмент `[[…]]`.
    for (const key of variables)
      out[key] = key === 'branchPhone' ? '' : t(`template.samples.${key}`, { defaultValue: '' });
    return out;
  }, [variables, t]);
  const rendered = useMemo(
    () => (preview ? renderAutomationTemplate(value, samples) : ''),
    [preview, value, samples],
  );

  const openMenu = () => {
    const el = fieldRef.current;
    caretRef.current = el
      ? { start: el.selectionStart ?? value.length, end: el.selectionEnd ?? value.length }
      : { start: value.length, end: value.length };
    setMenuOpen(v => !v);
  };

  const insert = (key: string) => {
    const token = `{{${key}}}`;
    const { start, end } = caretRef.current ?? { start: value.length, end: value.length };
    const next = value.slice(0, start) + token + value.slice(end);
    if (next.length > maxLength) return;
    pendingCaretRef.current = start + token.length;
    caretRef.current = null;
    setMenuOpen(false);
    onChange(next);
  };

  const docLabel = automationDocumentTypeLabel(documentType);
  const describedBy = `${id}-hint`;
  const fieldClass = cn(
    'w-full rounded border bg-surface px-3 py-2 text-[13px] text-foreground outline-none transition-all',
    'border-input hover:border-input-hover focus:border-primary focus:ring-3 focus:ring-brand-100',
    (error || unknown.length > 0 || !fragmentsOk) &&
      'border-destructive focus:ring-destructive-ring',
  );

  return (
    <div className="flex flex-col gap-1" data-testid={testId}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <label htmlFor={id} className="text-[13px] font-medium text-foreground leading-none">
          {label}
          {required && <span className="ml-0.5 text-destructive">*</span>}
        </label>
        <div className="flex flex-wrap items-center gap-1">
          <div className="relative" ref={menuRef}>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={openMenu}
              aria-expanded={menuOpen}
              aria-haspopup="listbox"
              className="h-7 px-2 text-[12px]"
            >
              <Braces className="h-3.5 w-3.5" aria-hidden="true" />
              {t('template.insertVariable')}
            </Button>
            {menuOpen && (
              <div
                role="listbox"
                aria-label={t('template.variablesFor', { document: docLabel })}
                className="absolute right-0 top-full z-50 mt-1 max-h-64 w-64 overflow-y-auto rounded-lg border border-border bg-surface py-1 shadow-lg"
              >
                {variables.map(key => (
                  <button
                    key={key}
                    type="button"
                    role="option"
                    aria-selected={false}
                    onClick={() => insert(key)}
                    className="flex w-full items-baseline justify-between gap-2 px-3 py-1.5 text-left text-[12px] hover:bg-secondary"
                  >
                    <span className="text-foreground">{t(`template.variables.${key}`)}</span>
                    <code className="text-[11px] text-muted-foreground">{`{{${key}}}`}</code>
                  </button>
                ))}
              </div>
            )}
          </div>
          {!singleLine && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setPreview(v => !v)}
              aria-pressed={preview}
              title={t('template.preview')}
              className="h-7 px-2 text-[12px]"
            >
              {preview ? (
                <EyeOff className="h-3.5 w-3.5" aria-hidden="true" />
              ) : (
                <Eye className="h-3.5 w-3.5" aria-hidden="true" />
              )}
              {t('template.previewShort')}
            </Button>
          )}
          {onSendTest && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onSendTest}
              disabled={!!sendTestBlockedReason}
              title={sendTestBlockedReason}
              className="h-7 px-2 text-[12px]"
            >
              <Send className="h-3.5 w-3.5" aria-hidden="true" />
              {t('template.sendTest')}
            </Button>
          )}
        </div>
      </div>

      {singleLine ? (
        <input
          id={id}
          ref={el => {
            fieldRef.current = el;
          }}
          value={value}
          maxLength={maxLength}
          placeholder={placeholder}
          onChange={e => onChange(e.target.value)}
          onBlur={onBlur}
          aria-invalid={!!error || unknown.length > 0 || !fragmentsOk}
          aria-describedby={describedBy}
          className={cn(fieldClass, 'h-9')}
        />
      ) : (
        <textarea
          id={id}
          ref={el => {
            fieldRef.current = el;
          }}
          value={value}
          rows={rows}
          maxLength={maxLength}
          placeholder={placeholder}
          onChange={e => onChange(e.target.value)}
          onBlur={onBlur}
          aria-invalid={!!error || unknown.length > 0 || !fragmentsOk}
          aria-describedby={describedBy}
          className={cn(fieldClass, 'resize-y')}
        />
      )}

      <div id={describedBy} className="space-y-1">
        {unknown.length > 0 && (
          <p className="text-[12px] text-destructive-text" data-testid="template-unknown">
            {t('template.unknown', {
              vars: unknown.map(v => `{{${v}}}`).join(', '),
              document: docLabel,
            })}
          </p>
        )}
        {!fragmentsOk && (
          <p className="text-[12px] text-destructive-text" data-testid="template-fragment-error">
            {t('template.fragmentError')}
          </p>
        )}
        {error && unknown.length === 0 && fragmentsOk && (
          <p className="text-[12px] text-destructive-text" role="alert">
            {error}
          </p>
        )}
        {!singleLine && (
          <p className="flex justify-between gap-3 text-[11px] text-muted-foreground">
            <span>{t('template.fragmentHint', { example: FRAGMENT_EXAMPLE })}</span>
            <span className="tabular-nums shrink-0">
              {t('template.counter', { n: value.length, max: maxLength })}
            </span>
          </p>
        )}
      </div>

      {preview && !singleLine && (
        <div
          className="rounded-lg border border-border bg-secondary px-3 py-2"
          data-testid="template-preview"
        >
          <p className="mb-1 text-[11px] text-muted-foreground">{t('template.previewPhoneHint')}</p>
          <p className="whitespace-pre-wrap wrap-break-word text-[13px] text-foreground">
            {rendered.trim() ? rendered : t('template.previewEmpty')}
          </p>
        </div>
      )}
    </div>
  );
}

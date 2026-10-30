'use client';

import type { Dispatch, ReactNode, SetStateAction } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, Download, MessageSquare, Minus, Printer, Share2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useTabBarContext, type ModalTab } from '@/contexts/TabBarContext';

/**
 * Спільні дії картки документа (наряд, рахунок, замовлення постачальнику, складський документ):
 * «Згорнути у вкладку» і «×» у шапці; у підвалі — скасування документа, «Друк», «Зберегти як»,
 * заглушки «Поділитись» / SMS і «Зберегти зміни». Розмітка була скопійована в чотири картки
 * (гейт jscpd, 2026-10-26); тексти й обробники передає картка — у кожної свій простір перекладу
 * і своя поведінка друку.
 */

const btnIcon =
  'rounded p-1.5 text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors duration-150';

export interface DocumentCardHeaderActionsProps {
  minimizeLabel: string;
  /** Колбек картки «згорнуто» (проп `onMinimize` картки) — після створення вкладки. */
  onMinimize?: () => void;
  /** Закрити картку без питання про незбережене: її стан лишається у вкладці. */
  closeCard: () => void;
  /** «×»: закриття з перевіркою незбережених змін. */
  onClose: () => void;
  disabled?: boolean;
  /**
   * Вкладка, у яку згортається картка; `null` — кнопки «Згорнути у вкладку» немає. Лише збережений
   * і завантажений документ: незнайденому згортати нічого (TECH-DEBT §9 п.4).
   */
  minimize: Omit<ModalTab, 'id' | 'kind'> | null;
}

/** «Згорнути у вкладку» і «×» у правому куті шапки картки. */
export function DocumentCardHeaderActions({
  minimizeLabel,
  onMinimize,
  closeCard,
  onClose,
  disabled,
  minimize,
}: DocumentCardHeaderActionsProps) {
  const { t } = useTranslation('common');
  const { minimizeModal } = useTabBarContext();
  return (
    <div className="flex items-center gap-1">
      {/* Згортання нижче lg ховаємо: смуга вкладок там `hidden lg:flex`, і згорнута картка
          зникала без шляху назад (TECH-DEBT §9 п.1). */}
      {minimize && (
        <button
          onClick={() => {
            minimizeModal({ kind: 'modal', ...minimize });
            onMinimize?.();
            closeCard();
          }}
          className={`hidden lg:inline-flex ${btnIcon}`}
          title={minimizeLabel}
          aria-label={minimizeLabel}
          disabled={disabled}
        >
          <Minus className="h-4 w-4" />
        </button>
      )}
      <button
        onClick={onClose}
        className={btnIcon}
        title={t('close')}
        aria-label={t('close')}
        disabled={disabled}
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}

/**
 * «Закрити» у підвалі картки. Як Escape і «×»: незбережені зміни — спершу підтвердження
 * (`useDirtyForm`), тому картка передає свій `handleModalClose`, а не `onClose` батька.
 */
export function DocumentCloseButton({
  onClose,
  disabled,
}: {
  onClose: () => unknown;
  disabled: boolean;
}) {
  const { t } = useTranslation('common');
  return (
    <Button variant="outline" size="sm" onClick={() => void onClose()} disabled={disabled}>
      {t('close')}
    </Button>
  );
}

/**
 * «Скасувати» документ (перехід у CANCELLED) — ліворуч у підвалі картки, окремо від «Закрити» й
 * «Друк» (UX-огляд 2026-10-29: червона «Скасувати» поруч із «Закрити» скасовувала документ).
 * Підпис називає документ («Скасувати наряд»). Видно, коли перехід є серед дозволених: для нового,
 * видаленого чи незнайденого документа список порожній.
 */
export function DocumentCancelAction({
  label,
  transitions,
  onTransition,
  busy,
  saving,
}: {
  label: string;
  transitions: readonly string[];
  onTransition: (status: 'CANCELLED') => unknown;
  /** Іде перехід статусу — спінер на кнопці. */
  busy: boolean;
  saving: boolean;
}) {
  if (!transitions.includes('CANCELLED')) return null;
  return (
    <Button
      variant="destructive"
      size="sm"
      data-testid="document-cancel"
      onClick={() => void onTransition('CANCELLED')}
      loading={busy}
      disabled={busy || saving}
    >
      {label}
    </Button>
  );
}

export type DocumentSaveAsFormat = 'pdf' | 'xlsx' | 'docx';

const SAVE_AS_FORMATS: { fmt: DocumentSaveAsFormat; label: string }[] = [
  { fmt: 'pdf', label: 'PDF' },
  { fmt: 'xlsx', label: 'Excel (.xlsx)' },
  { fmt: 'docx', label: 'Word (.docx)' },
];

export interface DocumentFileActionsProps {
  printLabel: string;
  printTitle?: string;
  onPrint: () => void;
  /** Друк готується на сервері (токен поширення наряду) — спінер на кнопці. */
  printLoading?: boolean;
  saveAsLabel: string;
  saveAsTitle?: string;
  /** Стан меню «Зберегти як» тримає картка: його закриває Escape-шар і скидання при відкритті. */
  saveAsOpen: boolean;
  setSaveAsOpen: Dispatch<SetStateAction<boolean>>;
  onSaveAs: (fmt: DocumentSaveAsFormat) => void;
  disabled?: boolean;
}

/** «Друк» і «Зберегти як» (меню форматів) у підвалі картки. */
export function DocumentFileActions({
  printLabel,
  printTitle,
  onPrint,
  printLoading,
  saveAsLabel,
  saveAsTitle,
  saveAsOpen,
  setSaveAsOpen,
  onSaveAs,
  disabled,
}: DocumentFileActionsProps) {
  return (
    <>
      <Button
        variant="outline"
        size="sm"
        onClick={onPrint}
        loading={printLoading}
        disabled={disabled}
        title={printTitle ?? printLabel}
      >
        <Printer size={15} className="mr-1" />
        {printLabel}
      </Button>
      <div className="relative">
        <Button
          variant="outline"
          size="sm"
          onClick={() => setSaveAsOpen(v => !v)}
          disabled={disabled}
          title={saveAsTitle}
        >
          <Download size={15} className="mr-1" />
          {saveAsLabel}
          <ChevronDown size={13} className="ml-1" />
        </Button>
        {saveAsOpen && (
          <>
            <div className="fixed inset-0 z-40" onClick={() => setSaveAsOpen(false)} />
            <div className="absolute bottom-full mb-1 right-0 z-50 bg-surface border border-border rounded-lg shadow-lg py-1 min-w-35">
              {SAVE_AS_FORMATS.map(({ fmt, label }) => (
                <button
                  key={fmt}
                  type="button"
                  onClick={() => onSaveAs(fmt)}
                  className="w-full text-left px-3 py-1.5 text-[13px] hover:bg-border transition-colors"
                >
                  {label}
                </button>
              ))}
            </div>
          </>
        )}
      </div>
    </>
  );
}

export interface DocumentEditActionsProps {
  /** «Друк» і «Зберегти як» — лише для показаного документа (не для незнайденого, §9 п.4). */
  showFile: boolean;
  /** «Поділитись» і SMS — лише для документа, який можна змінювати (не видалений). */
  showShare: boolean;
  saveAsOpen: boolean;
  setSaveAsOpen: Dispatch<SetStateAction<boolean>>;
  /** «Зберегти зміни»; `null` — документ не редагується (не чернетка / лише перегляд). */
  save: { label: string; onSave: () => unknown } | null;
  saving: boolean;
  /** Іде перехід статусу — разом зі збереженням блокує всі дії. */
  busy: boolean;
  /** Дії картки між «SMS» і «Зберегти зміни» (складський документ — «Підтвердити»). */
  children?: ReactNode;
  labels: { print: string; saveAs: string; share: string; shareTitle: string; smsTitle: string };
}

/**
 * Дії підвалу збереженого рахунку, замовлення постачальнику і складського документа: друк
 * сторінки браузером, меню «Зберегти як» (формати ще не реалізовано — пункт лише закриває меню),
 * заглушки «Поділитись» / SMS і «Зберегти зміни».
 */
export function DocumentEditActions({
  showFile,
  showShare,
  saveAsOpen,
  setSaveAsOpen,
  save,
  saving,
  busy,
  children,
  labels,
}: DocumentEditActionsProps) {
  const disabled = saving || busy;
  return (
    <>
      {showFile && (
        <DocumentFileActions
          printLabel={labels.print}
          onPrint={() => window.print()}
          saveAsLabel={labels.saveAs}
          saveAsOpen={saveAsOpen}
          setSaveAsOpen={setSaveAsOpen}
          onSaveAs={() => setSaveAsOpen(false)}
          disabled={disabled}
        />
      )}
      {showShare && (
        <>
          <Button variant="outline" size="sm" disabled={disabled} title={labels.shareTitle}>
            <Share2 size={15} className="mr-1" />
            {labels.share}
          </Button>
          <Button variant="outline" size="sm" disabled={disabled} title={labels.smsTitle}>
            <MessageSquare size={15} className="mr-1" />
            SMS
          </Button>
        </>
      )}
      {children}
      {save && (
        <Button onClick={() => void save.onSave()} loading={saving} disabled={disabled} size="sm">
          {save.label}
        </Button>
      )}
    </>
  );
}

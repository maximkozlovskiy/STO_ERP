'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Send } from 'lucide-react';
import type { AutomationDocumentTypeValue } from '@sto/shared';
import { apiFetch } from '@/lib/api-client';
import { fmtDate } from '@/lib/format';
import { toast } from '@/lib/toast';
import { automationDocumentTypeLabel } from '@/lib/automation';
import { useTestAutomationRule, type AutomationTestResult } from '@/hooks/api/useAutomation';
import { Button } from './button';
import { EntityPickerField } from './entity-picker-field';
import { Modal, ModalFooter } from './modal';
import { SearchPickerModal } from './search-picker-modal';
import { ActionResultLine } from './AutomationJournal';

interface DocItem {
  id: string;
  primary: string;
  secondary?: string;
}

/** Рядок списку будь-якого документа → пункт вибору: номер / назва / клієнт і дата. */
function toItem(row: Record<string, unknown>): DocItem | null {
  const str = (k: string) => (typeof row[k] === 'string' ? row[k] : '');
  const id = str('id');
  if (!id) return null;
  const primary =
    str('number') || str('title') || str('clientName') || str('counterpartyName') || id;
  const secondary = [
    primary === str('counterpartyName') ? '' : str('counterpartyName'),
    str('supplierName'),
    primary === str('clientName') ? '' : str('clientName'),
    str('createdAt') ? fmtDate(str('createdAt')) : '',
  ]
    .filter(Boolean)
    .join(' · ');
  return { id, primary, ...(secondary ? { secondary } : {}) };
}

/** Список документів типу правила — для «Надіслати тест»; пошук — серверний, де він є. */
const LIST_PATH: Record<AutomationDocumentTypeValue, (q: string) => string> = {
  WORK_ORDER: q => `/work-orders?limit=20${q ? `&q=${encodeURIComponent(q)}` : ''}`,
  INVOICE: q => `/invoices?limit=20${q ? `&q=${encodeURIComponent(q)}` : ''}`,
  PURCHASE_ORDER: q => `/purchase-orders?limit=20${q ? `&q=${encodeURIComponent(q)}` : ''}`,
  STOCK_DOCUMENT: q => `/stock-documents?limit=20${q ? `&q=${encodeURIComponent(q)}` : ''}`,
  PAYMENT: () => '/payments?limit=20',
  SUPPLIER_PAYMENT: q => `/supplier-payments?limit=20${q ? `&q=${encodeURIComponent(q)}` : ''}`,
  SUPPLIER_RETURN: q => `/supplier-returns?limit=20${q ? `&q=${encodeURIComponent(q)}` : ''}`,
  BOOKING: () => '/booking',
  TASK: q => `/tasks?limit=20&includeOpen=true${q ? `&q=${encodeURIComponent(q)}` : ''}`,
};

async function fetchDocuments(type: AutomationDocumentTypeValue, q: string): Promise<DocItem[]> {
  const data = await apiFetch<unknown>(LIST_PATH[type](q.trim()));
  const rows =
    data && typeof data === 'object' && Array.isArray((data as { items?: unknown }).items)
      ? (data as { items: unknown[] }).items
      : Array.isArray(data)
        ? data
        : [];
  const items = rows
    .filter((r): r is Record<string, unknown> => !!r && typeof r === 'object')
    .map(toItem)
    .filter((i): i is DocItem => i !== null);
  // Онлайн-запис і оплати серверного пошуку не мають — фільтр на клієнті.
  const needle = q.trim().toLowerCase();
  return needle
    ? items.filter(i => `${i.primary} ${i.secondary ?? ''}`.toLowerCase().includes(needle))
    : items;
}

interface AutomationTestModalProps {
  open: boolean;
  ruleId: string;
  documentType: AutomationDocumentTypeValue;
  onClose: () => void;
}

/**
 * «Надіслати тест» (BR-AUT-051): повідомлення правила з даними обраного документа — на телефон /
 * email / Telegram того, хто тестує. Результат кожної дії — тут же; доставка — у журналі.
 */
export function AutomationTestModal({
  open,
  ruleId,
  documentType,
  onClose,
}: AutomationTestModalProps) {
  const { t } = useTranslation('automation');
  const [doc, setDoc] = useState<DocItem | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [result, setResult] = useState<AutomationTestResult | null>(null);
  const [error, setError] = useState('');
  const test = useTestAutomationRule();

  useEffect(() => {
    if (!open) return;
    setDoc(null);
    setResult(null);
    setError('');
  }, [open]);

  const fetchItems = useCallback((q: string) => fetchDocuments(documentType, q), [documentType]);

  const send = async () => {
    if (!doc || test.isPending) return;
    setError('');
    setResult(null);
    try {
      const res = await test.mutateAsync({ id: ruleId, documentId: doc.id });
      setResult(res);
      toast.success(t('test.sent'));
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : t('card.loadError'));
    }
  };

  const docLabel = automationDocumentTypeLabel(documentType);

  return (
    <>
      <Modal
        open={open}
        onClose={onClose}
        title={t('test.title')}
        size="md"
        onSubmit={() => void send()}
        footer={
          <ModalFooter>
            <Button variant="outline" onClick={onClose}>
              {t('card.close')}
            </Button>
            <Button
              onClick={() => void send()}
              loading={test.isPending}
              disabled={!doc}
              leftIcon={<Send className="h-4 w-4" />}
            >
              {t('test.send')}
            </Button>
          </ModalFooter>
        }
      >
        <div className="space-y-4" data-testid="automation-test">
          <p className="text-[12px] text-muted-foreground">{t('test.hint')}</p>
          <EntityPickerField<DocItem>
            label={t('test.pickDocument')}
            display={doc ? [doc.primary, doc.secondary].filter(Boolean).join(' · ') : ''}
            placeholder={t('test.pickTitle', { document: docLabel })}
            ariaLabel={t('test.pickDocument')}
            hideDetail
            onSearch={fetchItems}
            onSearchSelect={item => setDoc(item)}
            onPick={() => setPickerOpen(true)}
            onClear={() => setDoc(null)}
          />
          {error && (
            <div
              role="alert"
              className="text-[13px] text-destructive-text bg-destructive-subtle border border-destructive-border rounded-lg px-3 py-2"
            >
              {error}
            </div>
          )}
          {result && (
            <div
              className="rounded-lg border border-border p-3"
              data-testid="automation-test-result"
            >
              <p className="mb-1 text-[13px] font-medium text-foreground">{t('test.result')}</p>
              {result.actionResults.length === 0 ? (
                <p className="text-[12px] text-muted-foreground">{t('test.resultEmpty')}</p>
              ) : (
                <ul className="space-y-0.5">
                  {result.actionResults.map(r => (
                    <ActionResultLine key={r.index} r={r} />
                  ))}
                </ul>
              )}
              <p className="mt-2 text-[11px] text-muted-foreground">{t('test.checkJournal')}</p>
            </div>
          )}
        </div>
      </Modal>
      <SearchPickerModal<DocItem>
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        title={t('test.pickTitle', { document: docLabel })}
        selectedId={doc?.id ?? null}
        fetchItems={fetchItems}
        emptyText={t('test.pickEmpty')}
        onSelect={item => {
          setDoc(item);
          setPickerOpen(false);
        }}
      />
    </>
  );
}

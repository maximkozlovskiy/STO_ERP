'use client';

import { useEffect, useState } from 'react';
import { useConfirm } from '@/hooks/useConfirm';
import { apiFetch } from '@/lib/api-client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { type DocNumberConfig } from './shared';

export default function NumbersTab() {
  const { confirm, dialogProps } = useConfirm();
  const [docNumbers, setDocNumbers] = useState<DocNumberConfig[]>([]);
  const [error, setError] = useState('');

  useEffect(() => {
    apiFetch<DocNumberConfig[]>('/settings/document-numbers')
      .then(setDocNumbers)
      .catch((e: unknown) =>
        console.warn(
          '[NumbersTab] /settings/document-numbers failed:',
          e instanceof Error ? e.message : e,
        ),
      );
  }, []);

  const resetDocNumber = async (documentType: string) => {
    if (!(await confirm({ title: `Скинути лічильник для ${documentType}?` }))) return;
    try {
      await apiFetch(`/settings/document-numbers/${documentType}/reset`, { method: 'POST' });
      setDocNumbers(prev =>
        prev.map(c => (c.documentType === documentType ? { ...c, currentSeq: 0 } : c)),
      );
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Помилка');
    }
  };

  return (
    <div className="space-y-3">
      {error && (
        <div className="text-sm text-destructive-text bg-destructive-subtle border border-destructive-border rounded-lg p-3">
          {error}
        </div>
      )}

      {docNumbers.length === 0 && (
        <p className="text-sm text-muted-foreground">Конфігурацій не знайдено</p>
      )}

      {docNumbers.map(cfg => (
        <div key={cfg.id} className="bg-surface rounded-xl border border-border p-4 space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium text-foreground">{cfg.documentType}</span>
            <span className="text-xs text-muted-foreground font-mono">#{cfg.currentSeq}</span>
          </div>
          <div className="grid grid-cols-2 gap-3 text-[13px]">
            <div>
              <label className="block text-muted-foreground mb-1">Префікс</label>
              <Input
                value={cfg.prefix ?? ''}
                onChange={e => {
                  const prefix = e.target.value || null;
                  setDocNumbers(prev =>
                    prev.map(c => (c.documentType === cfg.documentType ? { ...c, prefix } : c)),
                  );
                }}
                onBlur={e => {
                  const prefix = e.target.value || null;
                  apiFetch(`/settings/document-numbers/${cfg.documentType}`, {
                    method: 'PATCH',
                    body: JSON.stringify({ prefix }),
                  }).catch((err: unknown) =>
                    setError(err instanceof Error ? err.message : 'Помилка збереження префікса'),
                  );
                }}
                className="h-8 text-[13px]"
                placeholder="Без префіксу"
              />
            </div>
            <div>
              <label className="block text-muted-foreground mb-1">Роздільник</label>
              <Input
                value={cfg.separator}
                onChange={e => {
                  const separator = e.target.value || '-';
                  setDocNumbers(prev =>
                    prev.map(c => (c.documentType === cfg.documentType ? { ...c, separator } : c)),
                  );
                }}
                onBlur={e => {
                  const separator = e.target.value || '-';
                  apiFetch(`/settings/document-numbers/${cfg.documentType}`, {
                    method: 'PATCH',
                    body: JSON.stringify({ separator }),
                  }).catch((err: unknown) =>
                    setError(err instanceof Error ? err.message : 'Помилка збереження роздільника'),
                  );
                }}
                className="h-8 text-[13px] w-16"
              />
            </div>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-[13px] text-muted-foreground">
              Скидати:{' '}
              {cfg.resetPeriod === 'NEVER'
                ? 'Ніколи'
                : cfg.resetPeriod === 'YEARLY'
                  ? 'Щороку'
                  : 'Щомісяця'}
            </span>
            <Button
              size="sm"
              variant="destructive"
              onClick={() => void resetDocNumber(cfg.documentType)}
              className="h-7 text-xs"
            >
              Скинути лічильник
            </Button>
          </div>
        </div>
      ))}

      <ConfirmDialog {...dialogProps} />
    </div>
  );
}

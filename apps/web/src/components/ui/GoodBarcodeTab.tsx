'use client';

import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import i18n from '@/i18n/config';
import { Plus, Star, X } from 'lucide-react';
import { apiFetch } from '@/lib/api-client';
import { toast } from '@/lib/toast';
import { AnimatedBody } from '@/components/ui/modal';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';

interface GoodBarcode {
  id: string;
  barcode: string;
  type: string;
  isPrimary: boolean;
}

interface GoodBarcodeTabProps {
  goodId: string;
  /** Optional — currently unused; reserved for future tenant-scoped endpoints */
  orgId?: string;
  /** Notifies parent when count changes (for count badge in tabs strip) */
  onCountChange?: (count: number) => void;
}

export function GoodBarcodeTab({ goodId, onCountChange }: GoodBarcodeTabProps) {
  const { t } = useTranslation('catalog');
  const [modalBarcodes, setModalBarcodes] = useState<GoodBarcode[]>([]);
  const [modalBarcodesLoading, setModalBarcodesLoading] = useState(false);
  const [barcodeError, setBarcodeError] = useState('');
  const [showAddBarcode, setShowAddBarcode] = useState(false);
  const [addBarcodeForm, setAddBarcodeForm] = useState({ barcode: '', type: 'EAN13' });
  const [addingBarcode, setAddingBarcode] = useState(false);
  const [deletingBarcodeId, setDeletingBarcodeId] = useState<string | null>(null);
  const modalBarcodeReqRef = useRef(0);

  // Notify parent when count changes
  useEffect(() => {
    onCountChange?.(modalBarcodes.length);
  }, [modalBarcodes.length, onCountChange]);

  useEffect(() => {
    if (!goodId) {
      setModalBarcodes([]);
      return;
    }
    const reqId = ++modalBarcodeReqRef.current;
    setModalBarcodes([]);
    setModalBarcodesLoading(true);
    setBarcodeError('');

    apiFetch<GoodBarcode[]>(`/goods/${goodId}/barcodes`)
      .then(data => {
        if (modalBarcodeReqRef.current === reqId) setModalBarcodes(data);
      })
      .catch(err => {
        if (modalBarcodeReqRef.current === reqId)
          setBarcodeError(
            err instanceof Error ? err.message : i18n.t('catalog:goodEdit.barcodesLoadError'),
          );
      })
      .finally(() => {
        if (modalBarcodeReqRef.current === reqId) setModalBarcodesLoading(false);
      });
  }, [goodId]);

  return (
    <div className="space-y-3">
      {modalBarcodesLoading && (
        <div className="py-6 text-center text-sm text-muted-foreground">
          {t('common:loadingDots')}
        </div>
      )}
      {!modalBarcodesLoading && barcodeError && (
        <div className="rounded-lg border border-destructive/30 bg-destructive-subtle px-3 py-2 text-sm text-destructive-text">
          {barcodeError}
        </div>
      )}
      {!modalBarcodesLoading && !barcodeError && (
        <>
          <div className="flex items-center justify-between">
            <span className="text-[13px] text-muted-foreground">
              {t('goodEdit.barcodesCount', { n: modalBarcodes.length })}
            </span>
            {!showAddBarcode && (
              <Button
                size="sm"
                variant="outline"
                leftIcon={<Plus className="h-3.5 w-3.5" />}
                onClick={() => setShowAddBarcode(true)}
              >
                {t('common:add')}
              </Button>
            )}
          </div>
          {showAddBarcode && (
            <AnimatedBody className="rounded-lg border border-border bg-secondary/40 p-3 space-y-3">
              <div className="grid grid-cols-2 gap-2">
                <Input
                  label={t('goods.panel.barcode')}
                  required
                  value={addBarcodeForm.barcode}
                  onChange={e => setAddBarcodeForm(f => ({ ...f, barcode: e.target.value }))}
                  placeholder="4820123456789"
                />
                <Select
                  label={t('goods.columns.type')}
                  value={addBarcodeForm.type}
                  onChange={e => setAddBarcodeForm(f => ({ ...f, type: e.target.value }))}
                >
                  <option value="EAN13">EAN-13</option>
                  <option value="EAN8">EAN-8</option>
                  <option value="CODE128">Code 128</option>
                  <option value="CODE39">Code 39</option>
                  <option value="QR">QR</option>
                </Select>
              </div>
              <div className="flex gap-2 justify-end">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setShowAddBarcode(false);
                    setAddBarcodeForm({ barcode: '', type: 'EAN13' });
                  }}
                >
                  {t('common:cancel')}
                </Button>
                <Button
                  size="sm"
                  loading={addingBarcode}
                  disabled={!addBarcodeForm.barcode}
                  onClick={() =>
                    // try/catch усередині вже показує помилку; `void` + IIFE —
                    // щоб React-обробник не повертав проміс (no-misused-promises).
                    void (async () => {
                      setAddingBarcode(true);
                      try {
                        const created = await apiFetch<GoodBarcode>(`/goods/${goodId}/barcodes`, {
                          method: 'POST',
                          body: JSON.stringify({
                            barcode: addBarcodeForm.barcode,
                            type: addBarcodeForm.type,
                          }),
                        });
                        setModalBarcodes(prev => [...prev, created]);
                        setAddBarcodeForm({ barcode: '', type: 'EAN13' });
                        setShowAddBarcode(false);
                        toast.success(t('toast.barcodeAdded'));
                      } catch (e: unknown) {
                        toast.error(e instanceof Error ? e.message : t('common.genericError'));
                      } finally {
                        setAddingBarcode(false);
                      }
                    })()
                  }
                >
                  {t('common:save')}
                </Button>
              </div>
            </AnimatedBody>
          )}
          {modalBarcodes.length > 0 && (
            <div className="rounded-xl border border-border overflow-hidden">
              <table className="w-full text-[13px]">
                <thead className="bg-secondary border-b border-border">
                  <tr>
                    <th className="text-left px-3 py-2 text-muted-foreground font-medium">
                      {t('goods.panel.barcode')}
                    </th>
                    <th className="text-left px-3 py-2 text-muted-foreground font-medium">
                      {t('goods.columns.type')}
                    </th>
                    <th className="w-10 px-3 py-2 text-muted-foreground" title={t('goods.primary')}>
                      <Star className="h-3.5 w-3.5" />
                    </th>
                    <th className="w-12" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {modalBarcodes.map(bc => (
                    <tr key={bc.id} className="bg-surface hover:bg-secondary/50 transition-colors">
                      <td className="px-3 py-2 font-mono text-foreground">{bc.barcode}</td>
                      <td className="px-3 py-2 text-muted-foreground">{bc.type}</td>
                      <td className="px-3 py-2 text-center">
                        {bc.isPrimary && (
                          <Star className="h-3.5 w-3.5 text-warning-text fill-warning-text" />
                        )}
                      </td>
                      <td className="px-3 py-2 text-center">
                        <button
                          type="button"
                          disabled={deletingBarcodeId === bc.id}
                          onClick={() =>
                            // try/catch усередині вже показує помилку; `void` + IIFE —
                            // щоб React-обробник не повертав проміс (no-misused-promises).
                            void (async () => {
                              setDeletingBarcodeId(bc.id);
                              try {
                                await apiFetch(`/goods/${goodId}/barcodes/${bc.id}`, {
                                  method: 'DELETE',
                                });
                                setModalBarcodes(prev => prev.filter(b => b.id !== bc.id));
                                toast.success(t('toast.barcodeDeleted'));
                              } catch (e: unknown) {
                                toast.error(
                                  e instanceof Error ? e.message : t('common.genericError'),
                                );
                              } finally {
                                setDeletingBarcodeId(null);
                              }
                            })()
                          }
                          className="text-destructive/70 hover:text-destructive hover:bg-destructive/10 p-1 rounded transition-colors"
                          title={t('common:delete')}
                        >
                          <X className="h-3.5 w-3.5" />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {modalBarcodes.length === 0 && !showAddBarcode && (
            <p className="text-[13px] text-muted-foreground text-center py-4">
              {t('goodEdit.barcodesEmpty')}
            </p>
          )}
        </>
      )}
    </div>
  );
}

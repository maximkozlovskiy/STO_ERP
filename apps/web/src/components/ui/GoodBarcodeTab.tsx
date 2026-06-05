'use client';

import { useEffect, useRef, useState } from 'react';
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
  const [modalBarcodes, setModalBarcodes] = useState<GoodBarcode[]>([]);
  const [modalBarcodesLoading, setModalBarcodesLoading] = useState(false);
  const [barcodeError, setBarcodeError] = useState('');
  const [showAddBarcode, setShowAddBarcode] = useState(false);
  const [addBarcodeForm, setAddBarcodeForm] = useState({ barcode: '', type: 'EAN13' });
  const [addingBarcode2, setAddingBarcode2] = useState(false);
  const [deletingBarcodeId2, setDeletingBarcodeId2] = useState<string | null>(null);
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
          setBarcodeError(err instanceof Error ? err.message : 'Помилка завантаження штрихкодів');
      })
      .finally(() => {
        if (modalBarcodeReqRef.current === reqId) setModalBarcodesLoading(false);
      });
  }, [goodId]);

  return (
    <div className="space-y-3">
      {modalBarcodesLoading && (
        <div className="py-6 text-center text-sm text-muted-foreground">Завантаження...</div>
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
              {modalBarcodes.length} штрихкодів
            </span>
            {!showAddBarcode && (
              <Button
                size="sm"
                variant="outline"
                leftIcon={<Plus className="h-3.5 w-3.5" />}
                onClick={() => setShowAddBarcode(true)}
              >
                Додати
              </Button>
            )}
          </div>
          {showAddBarcode && (
            <AnimatedBody className="rounded-lg border border-border bg-secondary/40 p-3 space-y-3">
              <div className="grid grid-cols-2 gap-2">
                <Input
                  label="Штрихкод"
                  required
                  value={addBarcodeForm.barcode}
                  onChange={e => setAddBarcodeForm(f => ({ ...f, barcode: e.target.value }))}
                  placeholder="4820123456789"
                />
                <Select
                  label="Тип"
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
                  Скасувати
                </Button>
                <Button
                  size="sm"
                  loading={addingBarcode2}
                  disabled={!addBarcodeForm.barcode}
                  onClick={async () => {
                    setAddingBarcode2(true);
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
                      toast.success('Штрихкод додано');
                    } catch (e: unknown) {
                      toast.error(e instanceof Error ? e.message : 'Помилка');
                    } finally {
                      setAddingBarcode2(false);
                    }
                  }}
                >
                  Зберегти
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
                      Штрихкод
                    </th>
                    <th className="text-left px-3 py-2 text-muted-foreground font-medium">Тип</th>
                    <th className="w-10 px-3 py-2 text-muted-foreground" title="Основний">
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
                          disabled={deletingBarcodeId2 === bc.id}
                          onClick={async () => {
                            setDeletingBarcodeId2(bc.id);
                            try {
                              await apiFetch(`/goods/${goodId}/barcodes/${bc.id}`, {
                                method: 'DELETE',
                              });
                              setModalBarcodes(prev => prev.filter(b => b.id !== bc.id));
                              toast.success('Штрихкод видалено');
                            } catch (e: unknown) {
                              toast.error(e instanceof Error ? e.message : 'Помилка');
                            } finally {
                              setDeletingBarcodeId2(null);
                            }
                          }}
                          className="text-destructive/70 hover:text-destructive hover:bg-destructive/10 p-1 rounded transition-colors"
                          title="Видалити"
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
            <p className="text-[13px] text-muted-foreground text-center py-4">Штрихкодів немає</p>
          )}
        </>
      )}
    </div>
  );
}

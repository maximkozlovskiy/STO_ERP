'use client';

import { useCallback, useEffect, useState } from 'react';
import { Check, X } from 'lucide-react';
import { apiFetch } from '@/lib/api-client';
import { toast } from '@/lib/toast';
import { useUiFeatures } from '@/hooks/useUiFeatures';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { getCached, setCache } from '@/lib/ref-cache';
import { cn } from '@/lib/utils';
import { type BranchInfo } from './shared';

// Відповідь GET /settings/branch/:id — секрети (ключ/PIN) НЕ повертаються (write-only).
interface FiscalSettings {
  fiscalEnabled?: boolean;
  checkboxApiUrl?: string | null;
  checkboxCashRegisterId?: string | null;
}

interface VerifyResult {
  valid: boolean;
  cashRegisterName?: string;
  error?: string;
}

const DEFAULT_API_URL = 'https://api.checkbox.ua';

export default function FiscalTab() {
  const currentFeatures = useUiFeatures();
  const [branches, setBranches] = useState<BranchInfo[]>([]);
  const [selectedBranch, setSelectedBranch] = useState('');
  const [enabled, setEnabled] = useState(false);
  const [apiUrl, setApiUrl] = useState(DEFAULT_API_URL);
  const [cashRegisterId, setCashRegisterId] = useState('');
  // Секрети write-only: порожнє = «не змінювати». Не prefill з GET.
  const [licenseKey, setLicenseKey] = useState('');
  const [pinCode, setPinCode] = useState('');
  const [saving, setSaving] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [verifyResult, setVerifyResult] = useState<VerifyResult | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    const cached = getCached<BranchInfo[]>('cache:branches');
    if (cached && cached.length > 0) {
      setBranches(cached);
      setSelectedBranch(prev => prev || cached[0].id);
    }
    apiFetch<{ items: BranchInfo[] } | BranchInfo[]>('/branches')
      .then(d => {
        const arr = Array.isArray(d) ? d : d.items;
        setBranches(arr);
        setCache('cache:branches', arr);
        if (arr.length > 0) setSelectedBranch(prev => prev || arr[0].id);
      })
      .catch((e: unknown) =>
        console.warn('[FiscalTab] /branches failed:', e instanceof Error ? e.message : e),
      );
  }, []);

  const loadSettings = useCallback((branchId: string) => {
    apiFetch<FiscalSettings>(`/settings/branch/${branchId}`)
      .then(s => {
        setEnabled(s.fiscalEnabled ?? false);
        setApiUrl(s.checkboxApiUrl || DEFAULT_API_URL);
        setCashRegisterId(s.checkboxCashRegisterId ?? '');
        setLicenseKey(''); // write-only — не prefill
        setPinCode('');
        setVerifyResult(null);
      })
      .catch((e: unknown) =>
        console.warn('[FiscalTab] settings load failed:', e instanceof Error ? e.message : e),
      );
  }, []);

  useEffect(() => {
    if (selectedBranch) loadSettings(selectedBranch);
  }, [selectedBranch, loadSettings]);

  const save = async () => {
    if (!selectedBranch) return;
    setSaving(true);
    setError('');
    try {
      // Секрети додаємо лише коли введені (порожнє → не затирати наявний ключ/PIN).
      const body: Record<string, unknown> = {
        fiscalEnabled: enabled,
        checkboxApiUrl: apiUrl || null,
        checkboxCashRegisterId: cashRegisterId || null,
      };
      if (licenseKey) body.checkboxLicenseKey = licenseKey;
      if (pinCode) body.checkboxPinCode = pinCode;

      await apiFetch(`/settings/branch/${selectedBranch}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      });
      setLicenseKey(''); // очистити секрет-поля після збереження
      setPinCode('');
      if (currentFeatures.toastEnabled) toast.success('Налаштування збережено');
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Помилка збереження';
      setError(msg);
      if (currentFeatures.toastEnabled) toast.error(msg);
    } finally {
      setSaving(false);
    }
  };

  const verify = async () => {
    if (!selectedBranch) return;
    setVerifying(true);
    setVerifyResult(null);
    try {
      const res = await apiFetch<VerifyResult>(`/settings/branch/${selectedBranch}/fiscal/verify`, {
        method: 'POST',
        // Передаємо введені креди; якщо ключ порожній — бекенд візьме збережений.
        body: JSON.stringify({
          apiUrl: apiUrl || undefined,
          licenseKey: licenseKey || undefined,
        }),
      });
      setVerifyResult(res);
    } catch (e: unknown) {
      setVerifyResult({
        valid: false,
        error: e instanceof Error ? e.message : 'Помилка перевірки',
      });
    } finally {
      setVerifying(false);
    }
  };

  return (
    <div className="space-y-5 max-w-xl">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold text-foreground">Фіскалізація (ПРРО · Checkbox)</h3>
        {branches.length > 1 && (
          <Select
            value={selectedBranch}
            onChange={e => setSelectedBranch(e.target.value)}
            className="w-48"
          >
            {branches.map(b => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </Select>
        )}
      </div>

      {error && (
        <div className="text-sm text-destructive-text bg-destructive-subtle border border-destructive-border rounded-lg p-3">
          {error}
        </div>
      )}

      <div className="flex items-center justify-between bg-surface rounded-xl border border-border p-3">
        <div>
          <div className="text-sm font-medium text-foreground">Увімкнути фіскалізацію</div>
          <div className="text-xs text-muted-foreground">
            Чек пробивається для способів оплати, що потребують фіскалізації.
          </div>
        </div>
        <Switch
          checked={enabled}
          onChange={setEnabled}
          ariaLabel={enabled ? 'Вимкнути фіскалізацію' : 'Увімкнути фіскалізацію'}
        />
      </div>

      <Input
        label="API URL"
        value={apiUrl}
        onChange={e => setApiUrl(e.target.value)}
        placeholder={DEFAULT_API_URL}
      />
      <Input
        label="Ліцензійний ключ каси"
        type="password"
        value={licenseKey}
        onChange={e => setLicenseKey(e.target.value)}
        placeholder="Залиште порожнім, щоб не змінювати"
        autoComplete="off"
      />
      <Input
        label="PIN касира"
        type="password"
        value={pinCode}
        onChange={e => setPinCode(e.target.value)}
        placeholder="Залиште порожнім, щоб не змінювати"
        autoComplete="off"
      />
      <Input
        label="ID каси (cash register)"
        value={cashRegisterId}
        onChange={e => setCashRegisterId(e.target.value)}
        placeholder="напр. 0e5b..."
      />

      <div className="flex items-center gap-3">
        <Button onClick={() => void save()} loading={saving}>
          Зберегти
        </Button>
        <Button variant="outline" onClick={() => void verify()} loading={verifying}>
          Перевірити
        </Button>
        {verifyResult && (
          <span
            className={cn(
              'flex items-center gap-1 text-sm',
              verifyResult.valid ? 'text-success' : 'text-destructive-text',
            )}
          >
            {verifyResult.valid ? (
              <>
                <Check className="h-4 w-4" />
                Ключ дійсний
                {verifyResult.cashRegisterName && ` · каса: ${verifyResult.cashRegisterName}`}
              </>
            ) : (
              <>
                <X className="h-4 w-4" />
                {verifyResult.error ?? 'Невірний ключ'}
              </>
            )}
          </span>
        )}
      </div>

      <p className="text-xs text-muted-foreground">
        Для реального пробиття чеків потрібна відкрита касова зміна — керування зміною зʼявиться у
        наступному оновленні.
      </p>
    </div>
  );
}

'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { apiFetch } from '@/lib/api-client';

type Step = 'checking' | 'org' | 'branch' | 'warehouse' | 'fiscal' | 'sms' | 'done';

interface WizardData {
  orgName: string;
  edrpou: string;
  ownerEmail: string;
  ownerPassword: string;
  ownerFirstName: string;
  ownerLastName: string;
  branchName: string;
  branchAddress: string;
  warehouseName: string;
}

const STEPS: Step[] = ['org', 'branch', 'warehouse', 'fiscal', 'sms', 'done'];
const STEP_TITLES: Record<Step, string> = {
  checking: '',
  org: 'Організація',
  branch: 'Перша філія',
  warehouse: 'Склад',
  fiscal: 'ПРРО (Checkbox)',
  sms: 'SMS-сповіщення',
  done: 'Готово',
};

export default function SetupPage() {
  const router = useRouter();
  const [step, setStep] = useState<Step>('checking');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<WizardData>({
    orgName: '',
    edrpou: '',
    ownerEmail: '',
    ownerPassword: '',
    ownerFirstName: '',
    ownerLastName: '',
    branchName: 'Головна філія',
    branchAddress: '',
    warehouseName: 'Основний склад',
  });

  // Check if already initialized — redirect if so
  useEffect(() => {
    let cancelled = false;
    apiFetch<{ initialized: boolean }>('/setup/status')
      .then(d => {
        if (cancelled) return;
        if (d.initialized) {
          router.replace('/login');
        } else {
          setStep('org');
        }
      })
      .catch(() => {
        if (!cancelled) setStep('org');
      });
    return () => {
      cancelled = true;
    };
  }, [router]);

  const stepIndex = STEPS.indexOf(step);
  const totalSteps = STEPS.length - 1; // exclude 'done'

  const update = (field: keyof WizardData, value: string) =>
    setData(d => ({ ...d, [field]: value }));

  const next = () => {
    const idx = STEPS.indexOf(step);
    if (idx >= 0 && idx < STEPS.length - 1) setStep(STEPS[idx + 1]);
  };

  const submit = async () => {
    setLoading(true);
    setError('');
    try {
      const result = await apiFetch<{ accessToken: string }>('/setup/init', {
        method: 'POST',
        body: JSON.stringify({
          orgName: data.orgName,
          edrpou: data.edrpou || undefined,
          ownerEmail: data.ownerEmail,
          ownerPassword: data.ownerPassword,
          ownerFirstName: data.ownerFirstName,
          ownerLastName: data.ownerLastName,
          branchName: data.branchName,
          branchAddress: data.branchAddress,
          warehouseName: data.warehouseName || undefined,
        }),
      });

      sessionStorage.setItem('sto_access_token', result.accessToken);
      setStep('done');
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Помилка ініціалізації');
    } finally {
      setLoading(false);
    }
  };

  if (step === 'checking') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-surface">
        <div className="w-8 h-8 border-4 border-primary border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (step === 'done') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-surface">
        <div className="bg-surface rounded-2xl shadow border border-border p-10 max-w-md w-full text-center space-y-4">
          <div className="text-5xl">✓</div>
          <h1 className="text-2xl font-bold text-foreground">Систему налаштовано!</h1>
          <p className="text-muted-foreground">Ласкаво просимо до STO ERP</p>
          <button
            onClick={() => router.replace('/dashboard')}
            className="w-full py-2 px-4 bg-primary text-white rounded-lg font-medium hover:opacity-90"
          >
            Перейти до системи
          </button>
        </div>
      </div>
    );
  }

  const isNextDisabled =
    (step === 'org' &&
      (!data.orgName.trim() ||
        !data.ownerEmail.trim() ||
        !data.ownerPassword.trim() ||
        !data.ownerFirstName.trim() ||
        !data.ownerLastName.trim())) ||
    (step === 'branch' && (!data.branchName.trim() || !data.branchAddress.trim()));

  return (
    <div className="min-h-screen bg-surface flex items-center justify-center p-4">
      <div className="bg-surface rounded-2xl shadow-lg border border-border w-full max-w-lg">
        {/* Header */}
        <div className="p-6 border-b border-border">
          <h1 className="text-xl font-bold text-foreground">Перший запуск STO ERP</h1>
          <div className="mt-3 flex gap-1">
            {STEPS.filter(s => s !== 'done' && s !== 'checking').map((s, i) => (
              <div
                key={s}
                className={`h-1 flex-1 rounded-full ${i <= stepIndex ? 'bg-primary' : 'bg-border'}`}
              />
            ))}
          </div>
          <p className="mt-2 text-sm text-muted-foreground">
            Крок {stepIndex + 1} з {totalSteps}: {STEP_TITLES[step]}
          </p>
        </div>

        {/* Body */}
        <div className="p-6 space-y-4">
          {error && (
            <div className="bg-destructive-subtle border border-destructive-border text-destructive-text rounded-lg p-3 text-sm">
              {error}
            </div>
          )}

          {step === 'org' && (
            <>
              <Field
                label="Назва організації"
                value={data.orgName}
                onChange={v => update('orgName', v)}
                placeholder="СТО Авто-Майстер"
              />
              <Field
                label="ЄДРПОУ"
                value={data.edrpou}
                onChange={v => update('edrpou', v)}
                placeholder="12345678"
              />
              <div className="border-t border-border pt-4 mt-2">
                <p className="text-sm font-medium text-foreground mb-3">Обліковий запис власника</p>
                <Field
                  label="Email"
                  value={data.ownerEmail}
                  onChange={v => update('ownerEmail', v)}
                  placeholder="owner@sto.local"
                  type="email"
                />
                <Field
                  label="Пароль"
                  value={data.ownerPassword}
                  onChange={v => update('ownerPassword', v)}
                  placeholder="мін. 6 символів"
                  type="password"
                />
                <div className="grid grid-cols-2 gap-3">
                  <Field
                    label="Ім'я"
                    value={data.ownerFirstName}
                    onChange={v => update('ownerFirstName', v)}
                    placeholder="Іван"
                  />
                  <Field
                    label="Прізвище"
                    value={data.ownerLastName}
                    onChange={v => update('ownerLastName', v)}
                    placeholder="Коваль"
                  />
                </div>
              </div>
            </>
          )}

          {step === 'branch' && (
            <>
              <Field
                label="Назва філії"
                value={data.branchName}
                onChange={v => update('branchName', v)}
                placeholder="Головна філія"
              />
              <Field
                label="Адреса"
                value={data.branchAddress}
                onChange={v => update('branchAddress', v)}
                placeholder="вул. Гагаріна 12, Київ"
              />
            </>
          )}

          {step === 'warehouse' && (
            <>
              <Field
                label="Назва складу"
                value={data.warehouseName}
                onChange={v => update('warehouseName', v)}
                placeholder="Основний склад"
              />
              <p className="text-sm text-muted-foreground">Основний склад запчастин вашого СТО.</p>
            </>
          )}

          {step === 'fiscal' && (
            <div className="text-center py-4 space-y-3">
              <div className="text-4xl">🧾</div>
              <h2 className="font-semibold text-foreground">ПРРО (Checkbox)</h2>
              <p className="text-sm text-muted-foreground">
                Фіскальні налаштування можна додати пізніше в розділі{' '}
                <strong>Налаштування → Філія</strong>.
              </p>
            </div>
          )}

          {step === 'sms' && (
            <div className="text-center py-4 space-y-3">
              <div className="text-4xl">💬</div>
              <h2 className="font-semibold text-foreground">SMS-сповіщення</h2>
              <p className="text-sm text-muted-foreground">
                SMS через TurboSMS налаштовуються пізніше в розділі{' '}
                <strong>Налаштування → Філія</strong>.
              </p>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="p-6 border-t border-border flex justify-between">
          <button
            disabled={stepIndex === 0}
            onClick={() => setStep(STEPS[stepIndex - 1])}
            className="px-4 py-2 text-sm text-muted-foreground hover:text-foreground disabled:opacity-40"
          >
            ← Назад
          </button>

          {step === 'sms' ? (
            <button
              onClick={submit}
              disabled={loading}
              className="px-6 py-2 bg-primary text-white rounded-lg text-sm font-medium hover:opacity-90 disabled:opacity-60"
            >
              {loading ? 'Зачекайте...' : 'Завершити налаштування'}
            </button>
          ) : (
            <button
              onClick={next}
              disabled={isNextDisabled}
              className="px-6 py-2 bg-primary text-white rounded-lg text-sm font-medium hover:opacity-90 disabled:opacity-60"
            >
              Далі →
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  type = 'text',
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: string;
}) {
  // Browser autocomplete hints — purely UX, no security impact (one-shot wizard).
  const autoComplete = type === 'email' ? 'email' : type === 'password' ? 'new-password' : 'off';
  return (
    <div className="mb-3">
      <label className="block text-sm font-medium text-foreground mb-1">{label}</label>
      <input
        type={type}
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        autoComplete={autoComplete}
        className="w-full border border-border rounded-lg px-3 py-2 text-sm bg-surface text-foreground focus:outline-none focus:ring-2 focus:ring-primary"
      />
    </div>
  );
}

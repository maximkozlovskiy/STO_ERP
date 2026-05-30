'use client';

import { useEffect, useState } from 'react';
import { useRequireAuth } from '@/lib/auth';
import { apiFetch } from '@/lib/api-client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';

interface Me {
  id: string;
  orgId: string;
  firstName: string;
  lastName: string;
  role: string;
  email: string | null;
}

const ROLE_LABELS: Record<string, string> = {
  OWNER: 'Власник',
  ADMIN: 'Адміністратор',
  MECHANIC: 'Механік',
  RECEPTIONIST: 'Адміністратор СТО',
  STOREKEEPER: 'Комірник',
  ACCOUNTANT: 'Бухгалтер',
};

export default function ProfilePage() {
  useRequireAuth();

  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [pwForm, setPwForm] = useState({ current: '', next: '', confirm: '' });
  const [pwError, setPwError] = useState('');
  const [pwSuccess, setPwSuccess] = useState('');
  const [pwSaving, setPwSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    apiFetch<Me>('/auth/me')
      .then(d => {
        if (!cancelled) setMe(d);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Помилка завантаження профілю');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const changePassword = async () => {
    setPwError('');
    setPwSuccess('');
    if (pwForm.next !== pwForm.confirm) {
      setPwError('Паролі не збігаються');
      return;
    }
    if (pwForm.next.length < 8) {
      setPwError('Новий пароль має бути не менше 8 символів');
      return;
    }
    setPwSaving(true);
    try {
      await apiFetch<void>('/auth/change-password', {
        method: 'POST',
        body: JSON.stringify({ currentPassword: pwForm.current, newPassword: pwForm.next }),
      });
      setPwSuccess('Пароль успішно змінено');
      setPwForm({ current: '', next: '', confirm: '' });
    } catch (e: unknown) {
      setPwError(e instanceof Error ? e.message : 'Помилка зміни пароля');
    } finally {
      setPwSaving(false);
    }
  };

  if (loading)
    return (
      <div className="flex items-center justify-center min-h-[40vh]">
        <Spinner size="lg" />
      </div>
    );

  if (error || !me)
    return (
      <div className="page-container">
        <div className="text-[13px] text-destructive-text bg-destructive-subtle border border-destructive-border rounded-lg px-4 py-2">
          {error || 'Профіль не знайдено'}
        </div>
      </div>
    );

  return (
    <div className="page-container max-w-lg space-y-6">
      <h1 className="page-title">Профіль</h1>

      {/* Info card */}
      <div className="bg-surface rounded-xl border border-border p-5 space-y-3">
        <div className="flex items-center gap-4">
          <div className="w-14 h-14 rounded-full bg-primary/10 flex items-center justify-center text-primary text-2xl font-bold">
            {(me.firstName?.[0] ?? me.lastName?.[0] ?? '?').toUpperCase()}
          </div>
          <div>
            <p className="font-semibold text-foreground text-lg">
              {me.lastName} {me.firstName}
            </p>
            <p className="text-sm text-muted-foreground">{ROLE_LABELS[me.role] ?? me.role}</p>
          </div>
        </div>
        {me.email && (
          <div>
            <p className="text-xs text-muted-foreground">Email</p>
            <p className="text-sm text-foreground">{me.email}</p>
          </div>
        )}
      </div>

      {/* Change password */}
      <div className="bg-surface rounded-xl border border-border p-5 space-y-4">
        <h2 className="font-semibold text-foreground">Зміна пароля</h2>
        {pwError && (
          <div className="text-[13px] text-destructive-text bg-destructive-subtle border border-destructive-border rounded-lg px-4 py-2">
            {pwError}
          </div>
        )}
        {pwSuccess && (
          <div className="text-[13px] text-success bg-success-subtle border border-success/20 rounded-lg px-4 py-2">
            {pwSuccess}
          </div>
        )}
        <Input
          label="Поточний пароль"
          type="password"
          value={pwForm.current}
          onChange={e => setPwForm(f => ({ ...f, current: e.target.value }))}
          autoComplete="current-password"
        />
        <Input
          label="Новий пароль"
          type="password"
          value={pwForm.next}
          onChange={e => setPwForm(f => ({ ...f, next: e.target.value }))}
          hint="Не менше 8 символів"
          autoComplete="new-password"
        />
        <Input
          label="Підтвердження нового пароля"
          type="password"
          value={pwForm.confirm}
          onChange={e => setPwForm(f => ({ ...f, confirm: e.target.value }))}
          autoComplete="new-password"
        />
        <Button
          onClick={changePassword}
          loading={pwSaving}
          disabled={!pwForm.current || !pwForm.next || !pwForm.confirm}
        >
          Змінити пароль
        </Button>
      </div>
    </div>
  );
}

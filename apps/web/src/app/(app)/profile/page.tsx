'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
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

export default function ProfilePage() {
  const { t } = useTranslation('profile');
  const { employee } = useRequireAuth();

  const {
    data: me,
    isLoading: loading,
    error: queryError,
  } = useQuery<Me>({
    queryKey: ['auth', 'me'],
    queryFn: ({ signal }) => apiFetch('/auth/me', { signal }),
    enabled: !!employee,
    staleTime: 5 * 60_000, // профіль рідко міняється
    gcTime: 10 * 60_000,
  });

  const error = queryError instanceof Error ? queryError.message : '';

  const [pwForm, setPwForm] = useState({ current: '', next: '', confirm: '' });
  const [pwError, setPwError] = useState('');
  const [pwSuccess, setPwSuccess] = useState('');
  const [pwSaving, setPwSaving] = useState(false);

  const changePassword = async () => {
    setPwError('');
    setPwSuccess('');
    if (pwForm.next !== pwForm.confirm) {
      setPwError(t('changePassword.mismatch'));
      return;
    }
    if (pwForm.next.length < 8) {
      setPwError(t('changePassword.tooShort'));
      return;
    }
    setPwSaving(true);
    try {
      await apiFetch<void>('/auth/change-password', {
        method: 'POST',
        body: JSON.stringify({ currentPassword: pwForm.current, newPassword: pwForm.next }),
      });
      setPwSuccess(t('changePassword.success'));
      setPwForm({ current: '', next: '', confirm: '' });
    } catch (e: unknown) {
      setPwError(e instanceof Error ? e.message : t('changePassword.error'));
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
          {error || t('notFound')}
        </div>
      </div>
    );

  return (
    <div className="page-container max-w-lg space-y-6">
      <h1 className="page-title">{t('title')}</h1>

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
            <p className="text-sm text-muted-foreground">
              {t(`roles.${me.role}`, { defaultValue: me.role })}
            </p>
          </div>
        </div>
        {me.email && (
          <div>
            <p className="text-xs text-muted-foreground">{t('email')}</p>
            <p className="text-sm text-foreground">{me.email}</p>
          </div>
        )}
      </div>

      {/* Change password */}
      <div className="bg-surface rounded-xl border border-border p-5 space-y-4">
        <h2 className="font-semibold text-foreground">{t('changePassword.heading')}</h2>
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
          label={t('changePassword.current')}
          type="password"
          value={pwForm.current}
          onChange={e => setPwForm(f => ({ ...f, current: e.target.value }))}
          autoComplete="current-password"
          className="h-8 text-[13px]"
        />
        <Input
          label={t('changePassword.new')}
          type="password"
          value={pwForm.next}
          onChange={e => setPwForm(f => ({ ...f, next: e.target.value }))}
          hint={t('changePassword.newHint')}
          autoComplete="new-password"
          className="h-8 text-[13px]"
        />
        <Input
          label={t('changePassword.confirm')}
          type="password"
          value={pwForm.confirm}
          onChange={e => setPwForm(f => ({ ...f, confirm: e.target.value }))}
          autoComplete="new-password"
          className="h-8 text-[13px]"
        />
        <Button
          onClick={changePassword}
          loading={pwSaving}
          disabled={!pwForm.current || !pwForm.next || !pwForm.confirm}
        >
          {t('changePassword.submit')}
        </Button>
      </div>
    </div>
  );
}

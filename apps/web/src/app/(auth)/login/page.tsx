'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { Wrench, Wifi } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

export default function LoginPage() {
  const { login } = useAuth();
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await login(email, password);
      router.replace('/dashboard');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Помилка входу');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex bg-background">
      {/* Left panel — brand */}
      <div className="hidden lg:flex lg:w-105 flex-col justify-between p-10 bg-sidebar-bg text-white shrink-0">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary">
            <Wrench className="h-5 w-5 text-white" />
          </div>
          <span className="text-[16px] font-bold tracking-tight">STO ERP</span>
        </div>

        <div className="space-y-6">
          <div className="space-y-2">
            <h1 className="text-[32px] font-bold leading-tight tracking-tight">
              Система управління
              <br />
              автосервісом
            </h1>
            <p className="text-[15px] text-sidebar-muted leading-relaxed">
              Наряди, склад, фінанси, CRM — все в одному місці. Працює у локальній мережі СТО без
              інтернету.
            </p>
          </div>

          <div className="space-y-3">
            {[
              'Наряди та облік робіт',
              'Склад та запчастини',
              'Фінанси та розрахунки',
              'CRM та клієнтська база',
            ].map(f => (
              <div key={f} className="flex items-center gap-2.5 text-[13px] text-sidebar-fg">
                <div className="h-1.5 w-1.5 rounded-full bg-primary shrink-0" />
                {f}
              </div>
            ))}
          </div>
        </div>

        <div className="flex items-center gap-2 text-[12px] text-sidebar-muted">
          <Wifi className="h-3.5 w-3.5" />
          Офлайн-система — не потребує інтернету
        </div>
      </div>

      {/* Right panel — form */}
      <div className="flex flex-1 items-center justify-center p-6">
        <div className="w-full max-w-90">
          {/* Mobile logo */}
          <div className="flex lg:hidden items-center gap-2.5 mb-8 justify-center">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary">
              <Wrench className="h-5 w-5 text-white" />
            </div>
            <span className="text-[18px] font-bold text-foreground">STO ERP</span>
          </div>

          <div className="mb-7">
            <h2 className="text-[22px] font-bold text-foreground tracking-tight">
              Вхід до системи
            </h2>
            <p className="text-[14px] text-muted-foreground mt-1">Введіть ваші облікові дані</p>
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            <Input
              label="Email"
              id="email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={e => setEmail(e.target.value)}
              placeholder="admin@sto.local"
              className="h-8 text-[13px]"
            />

            <Input
              label="Пароль"
              id="password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={e => setPassword(e.target.value)}
              placeholder="••••••••"
              className="h-8 text-[13px]"
            />

            {error && (
              <div className="text-[13px] text-destructive-text bg-destructive-subtle border border-destructive-border rounded-lg px-3 py-2.5">
                {error}
              </div>
            )}

            <Button type="submit" loading={loading} className="w-full mt-2">
              Увійти
            </Button>
          </form>
        </div>
      </div>
    </div>
  );
}

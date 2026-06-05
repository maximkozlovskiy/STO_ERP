'use client';

import { useEffect, useState } from 'react';
import { Sun, Moon, Monitor } from 'lucide-react';
import { apiFetch } from '@/lib/api-client';
import { THEMES, type ThemeName, applyTheme } from '@/lib/theme';
import { setColorMode, getColorMode, type ColorMode } from '@/lib/color-mode';
import { toast } from '@/lib/toast';
import { useUiFeatures } from '@/hooks/useUiFeatures';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { type OrgSettings } from './shared';

type NavMode = 'sections' | 'functions';
const NAV_MODE_KEY = 'sto_nav_mode';

export default function ThemeTab() {
  const currentFeatures = useUiFeatures();
  const [orgSettings, setOrgSettings] = useState<OrgSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [navMode, setNavModeState] = useState<NavMode>('sections');
  const [colorMode, setColorModeState] = useState<ColorMode>('system');
  const [error, setError] = useState('');

  useEffect(() => {
    try {
      const saved = localStorage.getItem(NAV_MODE_KEY) as NavMode | null;
      if (saved === 'sections' || saved === 'functions') setNavModeState(saved);
    } catch {
      /* ignore */
    }
    setColorModeState(getColorMode());
  }, []);

  useEffect(() => {
    apiFetch<OrgSettings>('/settings/organisation')
      .then(s => {
        setOrgSettings(s);
        applyTheme(s.brandTheme);
      })
      .catch((e: unknown) =>
        setError(e instanceof Error ? e.message : 'Помилка завантаження налаштувань'),
      );
  }, []);

  const changeNavMode = (mode: NavMode) => {
    setNavModeState(mode);
    try {
      localStorage.setItem(NAV_MODE_KEY, mode);
    } catch {
      /* ignore */
    }
    window.dispatchEvent(new CustomEvent<NavMode>('sto:nav-mode-change', { detail: mode }));
  };

  const saveTheme = async () => {
    if (!orgSettings) return;
    setSaving(true);
    try {
      const updated = await apiFetch<OrgSettings>('/settings/organisation', {
        method: 'PATCH',
        body: JSON.stringify({ brandTheme: orgSettings.brandTheme }),
      });
      applyTheme(updated.brandTheme);
      setOrgSettings(updated);
      if (currentFeatures.toastEnabled) toast.success('Тему збережено');
    } catch (e: unknown) {
      const errMsg = e instanceof Error ? e.message : 'Помилка збереження';
      setError(errMsg);
      if (currentFeatures.toastEnabled) toast.error(errMsg);
    } finally {
      setSaving(false);
    }
  };

  if (!orgSettings) return null;

  return (
    <div className="space-y-6">
      {error && (
        <div className="text-sm text-destructive-text bg-destructive-subtle border border-destructive-border rounded-lg p-3">
          {error}
        </div>
      )}

      <div className="bg-surface rounded-xl border border-border p-6">
        <p className="text-sm text-muted-foreground mb-4">Оберіть кольорову палітру інтерфейсу</p>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-6">
          {(Object.entries(THEMES) as [ThemeName, (typeof THEMES)[ThemeName]][]).map(
            ([key, theme]) => (
              <button
                key={key}
                onClick={() => {
                  setOrgSettings({ ...orgSettings, brandTheme: key });
                  applyTheme(key);
                }}
                className={cn(
                  'flex items-center gap-3 p-3 rounded-xl border-2 transition-all',
                  orgSettings.brandTheme === key
                    ? 'border-foreground shadow-sm'
                    : 'border-border hover:border-foreground/40',
                )}
              >
                <span
                  className="w-8 h-8 rounded-full shrink-0"
                  style={{ background: theme.primary }}
                />
                <span className="text-sm font-medium text-foreground">{theme.label}</span>
              </button>
            ),
          )}
        </div>
        <Button onClick={() => void saveTheme()} loading={saving} className="w-full">
          Зберегти тему
        </Button>
      </div>

      <div className="bg-surface rounded-xl border border-border p-6">
        <p className="text-[13px] font-medium text-foreground mb-3">Режим навігації</p>
        <div className="flex gap-1.5">
          {[
            { mode: 'sections' as NavMode, label: 'По розділах' },
            { mode: 'functions' as NavMode, label: 'По функціях' },
          ].map(({ mode, label }) => (
            <button
              key={mode}
              onClick={() => changeNavMode(mode)}
              className={cn(
                'flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[13px] font-medium transition-colors',
                navMode === mode
                  ? 'bg-primary text-white'
                  : 'bg-secondary text-foreground hover:bg-secondary/80',
              )}
            >
              {label}
            </button>
          ))}
        </div>
        <p className="text-[12px] text-muted-foreground mt-2">Зберігається локально у браузері</p>
      </div>

      <div className="bg-surface rounded-xl border border-border p-6">
        <p className="text-[13px] font-medium text-foreground mb-3">Тема</p>
        <div className="flex gap-1.5">
          {(
            [
              { mode: 'light' as ColorMode, label: 'Світла', icon: Sun },
              { mode: 'dark' as ColorMode, label: 'Темна', icon: Moon },
              { mode: 'system' as ColorMode, label: 'Системна', icon: Monitor },
            ] as const
          ).map(({ mode, label, icon: Icon }) => (
            <button
              key={mode}
              onClick={() => {
                setColorMode(mode);
                setColorModeState(mode);
              }}
              className={cn(
                'flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[13px] font-medium transition-colors',
                colorMode === mode
                  ? 'bg-primary text-white'
                  : 'bg-secondary text-foreground hover:bg-secondary/80',
              )}
            >
              <Icon className="h-3.5 w-3.5" />
              {label}
            </button>
          ))}
        </div>
        <p className="text-[12px] text-muted-foreground mt-2">Зберігається локально у браузері</p>
      </div>
    </div>
  );
}

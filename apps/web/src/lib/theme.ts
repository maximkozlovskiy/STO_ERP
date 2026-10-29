export type ThemeName = 'blue' | 'green' | 'purple' | 'orange' | 'gray';

/** Кроки шкали `--color-brand-*` (globals.css): з неї похідні primary, підсвітка меню, кільце фокуса. */
const BRAND_STEPS = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900] as const;

/**
 * Палітри інтерфейсу. `scale` — уся шкала `--color-brand-50…900`: міняти лише `--color-primary`
 * мало — підсвітка меню (`--color-sidebar-active`), кільце фокуса, `primary-hover/subtle` беруть
 * колір зі шкали напряму й лишались синіми. `blue` — шкала з globals.css (інлайн не ставиться).
 */
export const THEMES: Record<
  ThemeName,
  { label: string; primary: string; light: string; dark: string; scale: readonly string[] | null }
> = {
  blue: { label: 'Синій', primary: '#2563eb', light: '#eff6ff', dark: '#1d4ed8', scale: null },
  green: {
    label: 'Зелений',
    primary: '#16a34a',
    light: '#f0fdf4',
    dark: '#15803d',
    scale: [
      '#f0fdf4',
      '#dcfce7',
      '#bbf7d0',
      '#86efac',
      '#4ade80',
      '#22c55e',
      '#16a34a',
      '#15803d',
      '#166534',
      '#14532d',
    ],
  },
  purple: {
    label: 'Фіолетовий',
    primary: '#7c3aed',
    light: '#f5f3ff',
    dark: '#6d28d9',
    scale: [
      '#f5f3ff',
      '#ede9fe',
      '#ddd6fe',
      '#c4b5fd',
      '#a78bfa',
      '#8b5cf6',
      '#7c3aed',
      '#6d28d9',
      '#5b21b6',
      '#4c1d95',
    ],
  },
  orange: {
    label: 'Помаранчевий',
    primary: '#ea580c',
    light: '#fff7ed',
    dark: '#c2410c',
    scale: [
      '#fff7ed',
      '#ffedd5',
      '#fed7aa',
      '#fdba74',
      '#fb923c',
      '#f97316',
      '#ea580c',
      '#c2410c',
      '#9a3412',
      '#7c2d12',
    ],
  },
  gray: {
    label: 'Сірий',
    primary: '#374151',
    light: '#f9fafb',
    dark: '#1f2937',
    scale: [
      '#f9fafb',
      '#e5e7eb',
      '#d1d5db',
      '#9ca3af',
      '#6b7280',
      '#4b5563',
      '#374151',
      '#1f2937',
      '#111827',
      '#030712',
    ],
  },
};

/** Кеш палітри організації: скрипт у <head> ставить її до першого кадру (без спалаху синього). */
export const BRAND_THEME_STORAGE_KEY = 'sto_brand_theme';

/** Інлайн-змінні, які колись ставила попередня версія `applyTheme` (лише primary-трійка). */
const LEGACY_PROPS = ['--color-primary', '--color-primary-light', '--color-primary-dark'];

export function applyTheme(theme: string) {
  const name = (theme in THEMES ? theme : 'blue') as ThemeName;
  const { scale } = THEMES[name];
  const root = document.documentElement;
  for (const p of LEGACY_PROPS) root.style.removeProperty(p);
  BRAND_STEPS.forEach((step, i) => {
    const prop = `--color-brand-${step}`;
    if (scale) root.style.setProperty(prop, scale[i]);
    else root.style.removeProperty(prop);
  });
  try {
    localStorage.setItem(BRAND_THEME_STORAGE_KEY, name);
  } catch {
    /* приватний режим — палітра лишиться до перезавантаження, далі прийде з API */
  }
}

/**
 * Тіло скрипта для <head> кореневого layout: застосовує кешовану палітру до гідратації. Шкали
 * вбудовуються з `THEMES` під час збірки — одне джерело правди з `applyTheme`.
 */
export function brandThemeBootScript(): string {
  const scales: Record<string, readonly string[]> = {};
  for (const [name, t] of Object.entries(THEMES)) if (t.scale) scales[name] = t.scale;
  return `(function(){try{var s=${JSON.stringify(scales)};var t=localStorage.getItem('${BRAND_THEME_STORAGE_KEY}');var c=t&&s[t];if(!c)return;var st=${JSON.stringify(BRAND_STEPS)};for(var i=0;i<st.length;i++){document.documentElement.style.setProperty('--color-brand-'+st[i],c[i]);}}catch(e){}})();`;
}

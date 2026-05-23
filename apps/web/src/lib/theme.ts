export type ThemeName = 'blue' | 'green' | 'purple' | 'orange' | 'gray';

export const THEMES: Record<ThemeName, { label: string; primary: string; light: string; dark: string }> = {
  blue:   { label: 'Синій',    primary: '#2563eb', light: '#eff6ff', dark: '#1d4ed8' },
  green:  { label: 'Зелений',  primary: '#16a34a', light: '#f0fdf4', dark: '#15803d' },
  purple: { label: 'Фіолетовий', primary: '#7c3aed', light: '#f5f3ff', dark: '#6d28d9' },
  orange: { label: 'Помаранчевий', primary: '#ea580c', light: '#fff7ed', dark: '#c2410c' },
  gray:   { label: 'Сірий',    primary: '#374151', light: '#f9fafb', dark: '#1f2937' },
};

export function applyTheme(theme: string) {
  const t = THEMES[theme as ThemeName] ?? THEMES.blue;
  const root = document.documentElement;
  root.style.setProperty('--color-primary', t.primary);
  root.style.setProperty('--color-primary-light', t.light);
  root.style.setProperty('--color-primary-dark', t.dark);
}

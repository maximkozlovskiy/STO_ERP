export type ColorMode = 'system' | 'light' | 'dark';

const KEY = 'sto_color_mode';

export function getColorMode(): ColorMode {
  if (typeof window === 'undefined') return 'system';
  return (localStorage.getItem(KEY) as ColorMode) ?? 'system';
}

export function setColorMode(mode: ColorMode): void {
  if (typeof window === 'undefined') return;
  localStorage.setItem(KEY, mode);
  applyColorMode(mode);
}

export function applyColorMode(mode?: ColorMode): void {
  if (typeof window === 'undefined') return;
  const m = mode ?? getColorMode();
  const isDark =
    m === 'dark' ||
    (m === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.classList.toggle('dark', isDark);
}

export function watchSystemColorMode(): () => void {
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  const handler = () => {
    if (getColorMode() === 'system') applyColorMode();
  };
  mq.addEventListener('change', handler);
  return () => mq.removeEventListener('change', handler);
}

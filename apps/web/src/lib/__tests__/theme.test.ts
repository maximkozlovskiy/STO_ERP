// Палітра інтерфейсу (2026-10-29): після Ctrl+Shift+R інтерфейс повертався до синього, бо палітру
// застосовували лише сторінки налаштувань; а підсвітка меню лишалась синьою й без перезавантаження,
// бо `applyTheme` міняв лише `--color-primary`, тоді як меню, кільце фокуса й primary-hover беруть
// колір зі шкали `--color-brand-*`.
//
// Mutation-verify (2026-10-29): `applyTheme` ставить лише `--color-brand-600` → падає «уся шкала»;
// без `localStorage.setItem` → падає «кеш»; скрипт без циклу по кроках → падає «скрипт <head>».
import { afterEach, describe, expect, it } from 'vitest';
import {
  BRAND_THEME_STORAGE_KEY,
  LOGO_ACCENT,
  THEMES,
  applyTheme,
  brandThemeBootScript,
} from '../theme';

const brand = (step: number) =>
  document.documentElement.style.getPropertyValue(`--color-brand-${step}`);

afterEach(() => {
  document.documentElement.removeAttribute('style');
  localStorage.clear();
});

describe('applyTheme', () => {
  it('ставить усю шкалу brand — за нею йдуть підсвітка меню, фокус і primary', () => {
    applyTheme('green');
    const scale = THEMES.green.scale!;
    expect(brand(50)).toBe(scale[0]);
    expect(brand(600)).toBe(THEMES.green.primary);
    expect(brand(700)).toBe(THEMES.green.dark);
    expect(brand(900)).toBe(scale[9]);
  });

  it('синя — шкала з globals.css: інлайн-змінні знімаються, як і старі primary-змінні', () => {
    document.documentElement.style.setProperty('--color-primary', '#16a34a');
    applyTheme('orange');
    applyTheme('blue');
    expect(brand(600)).toBe('');
    expect(brand(50)).toBe('');
    expect(document.documentElement.style.getPropertyValue('--color-primary')).toBe('');
  });

  it('невідома назва — синя', () => {
    applyTheme('green');
    applyTheme('magenta');
    expect(brand(600)).toBe('');
    expect(localStorage.getItem(BRAND_THEME_STORAGE_KEY)).toBe('blue');
  });

  it('акцент логотипу — колір файла логотипу палітри; синя — запасне значення BrandAppIcon', () => {
    applyTheme('orange');
    expect(document.documentElement.style.getPropertyValue('--color-logo-accent')).toBe(
      LOGO_ACCENT.orange,
    );
    applyTheme('blue');
    expect(document.documentElement.style.getPropertyValue('--color-logo-accent')).toBe('');
  });

  it('кеш: обрана палітра записується для скрипта <head>', () => {
    applyTheme('purple');
    expect(localStorage.getItem(BRAND_THEME_STORAGE_KEY)).toBe('purple');
  });
});

describe('скрипт <head>', () => {
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const runBootScript = () => new Function(brandThemeBootScript())();

  it('ставить кешовану палітру до гідратації', () => {
    localStorage.setItem(BRAND_THEME_STORAGE_KEY, 'gray');
    runBootScript();
    expect(brand(600)).toBe(THEMES.gray.primary);
    expect(brand(50)).toBe(THEMES.gray.scale![0]);
    expect(document.documentElement.style.getPropertyValue('--color-logo-accent')).toBe(
      LOGO_ACCENT.gray,
    );
  });

  it('без кешу або з синьою — нічого не ставить (діє globals.css)', () => {
    runBootScript();
    expect(brand(600)).toBe('');
    localStorage.setItem(BRAND_THEME_STORAGE_KEY, 'blue');
    runBootScript();
    expect(brand(600)).toBe('');
  });
});

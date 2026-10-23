import { describe, it, expect } from 'vitest';
import { sameApiUrl, trimTrailingSlashes } from './trim-trailing-slashes';

describe('sameApiUrl', () => {
  it('кінцеві слеші й пробіли не роблять адресу іншою', () => {
    expect(sameApiUrl('https://api.checkbox.ua', 'https://api.checkbox.ua/')).toBe(true);
    expect(sameApiUrl(' https://api.checkbox.ua ', 'https://api.checkbox.ua')).toBe(true);
  });

  it('порожня ≡ null ≡ undefined (типова адреса провайдера)', () => {
    expect(sameApiUrl(null, '')).toBe(true);
    expect(sameApiUrl(undefined, null)).toBe(true);
  });

  it('інший хост чи шлях — інша адреса', () => {
    expect(sameApiUrl('https://api.checkbox.ua', 'https://collector.example')).toBe(false);
    expect(sameApiUrl(null, 'https://api.checkbox.ua')).toBe(false);
    expect(sameApiUrl('https://x.ua/api', 'https://x.ua/api/v2')).toBe(false);
  });
});

describe('trimTrailingSlashes', () => {
  it('прибирає один і кілька кінцевих слешів', () => {
    expect(trimTrailingSlashes('https://x.com/')).toBe('https://x.com');
    expect(trimTrailingSlashes('https://x.com///')).toBe('https://x.com');
  });

  it('слеші всередині адреси лишаються', () => {
    expect(trimTrailingSlashes('https://x.com/api/v1/')).toBe('https://x.com/api/v1');
    expect(trimTrailingSlashes('https://x.com/api')).toBe('https://x.com/api');
  });

  it('порожній рядок і рядок лише зі слешів → порожній', () => {
    expect(trimTrailingSlashes('')).toBe('');
    expect(trimTrailingSlashes('///')).toBe('');
  });

  it('довга серія слешів не в кінці — лінійно, без зависання', () => {
    const s = `${'/'.repeat(100_000)}x`;
    expect(trimTrailingSlashes(s)).toBe(s);
  });
});

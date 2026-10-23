import { describe, it, expect } from 'vitest';
import { trimTrailingSlashes } from './trim-trailing-slashes';

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

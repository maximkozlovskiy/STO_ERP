import { describe, expect, it } from 'vitest';
import { safeImageSrc } from '../safe-image-src';

describe('safeImageSrc', () => {
  it('http(s), blob і відносний шлях — без змін', () => {
    expect(safeImageSrc('https://minio.local/org/1/public/logo.png')).toBe(
      'https://minio.local/org/1/public/logo.png',
    );
    expect(safeImageSrc('http://192.168.1.20:9000/sto/logo.png')).toBe(
      'http://192.168.1.20:9000/sto/logo.png',
    );
    expect(safeImageSrc('blob:http://localhost:3001/7c1e')).toBe('blob:http://localhost:3001/7c1e');
    expect(safeImageSrc('/files/logo.png')).toBe('/files/logo.png');
  });

  it('data: лише для зображень', () => {
    expect(safeImageSrc('data:image/png;base64,iVBORw0KGgo=')).toBe(
      'data:image/png;base64,iVBORw0KGgo=',
    );
    expect(safeImageSrc('data:text/html;base64,PHNjcmlwdD4=')).toBeNull();
    expect(safeImageSrc('data:image/svg+xml;base64,PHN2Zz4=')).toBeNull();
  });

  it('javascript:, file: і порожнє → null', () => {
    expect(safeImageSrc('javascript:alert(1)')).toBeNull();
    expect(safeImageSrc(' JavaScript:alert(1)')).toBeNull();
    expect(safeImageSrc('file:///etc/passwd')).toBeNull();
    expect(safeImageSrc('')).toBeNull();
    expect(safeImageSrc(null)).toBeNull();
  });
});

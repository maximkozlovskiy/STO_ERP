import { describe, it, expect } from 'vitest';
import { attachmentDisposition, safeFilenamePart } from './send-file';

describe("send-file — ім'я файла вкладення", () => {
  // guards: BR-INV-028
  it('символи / \\ : * ? " < > | у номері → «-»', () => {
    expect(safeFilenamePart('INV/2026\\1:*?"<>|')).toBe('INV-2026-1-------');
  });

  // guards: BR-INV-028
  it("кирилиця — filename*=UTF-8'' з percent-кодуванням; апостроф і дужки теж кодуються (RFC 5987)", () => {
    expect(attachmentDisposition('Рахунок-1.pdf')).toBe(
      `attachment; filename*=UTF-8''${encodeURIComponent('Рахунок-1.pdf')}`,
    );
    expect(attachmentDisposition("Д'(1)*!.pdf")).toBe(
      "attachment; filename*=UTF-8''%D0%94%27%281%29%2A%21.pdf",
    );
  });
});

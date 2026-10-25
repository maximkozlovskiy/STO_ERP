import { describe, it, expect } from 'vitest';
import { detectMimeFromBuffer, isDetectedImage, isDetectedZip, ZIP_MIME } from './file-signature';

/**
 * BR-SEC-UPLOAD: тип файлу визначається за МАГІЧНИМИ БАЙТАМИ, а не за заявленим клієнтом mime чи
 * розширенням. Перейменований .exe/.zip/.txt під .png має бути впізнаний як НЕ-зображення.
 * Мутація: прибрати будь-яку гілку сигнатури в `detectMimeFromBuffer` → її кейс червоніє;
 * прибрати перевірку довжини (`buf.length < 4`) → кейс «короткий буфер» червоніє.
 */

const sig = (...bytes: number[]) => Buffer.from(bytes);
const withTail = (head: number[], tailLen = 32) =>
  Buffer.concat([Buffer.from(head), Buffer.alloc(tailLen, 0x41)]);

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG = [0xff, 0xd8, 0xff, 0xe0];
const GIF = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61];
const PDF = [0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34];
const ZIP = [0x50, 0x4b, 0x03, 0x04]; // PK\x03\x04 — xlsx/docx/zip
const WEBP = [0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50];
// HEIC: 4 байти розміру box, 'ftyp', brand 'heic'
const HEIC = [
  0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63, 0x00, 0x00, 0x00, 0x00,
];
const MZ = [0x4d, 0x5a, 0x90, 0x00]; // DOS/PE виконуваний
const TXT = Buffer.from('просто текстовий файл, не зображення', 'utf-8');

describe('detectMimeFromBuffer', () => {
  it('впізнає PNG за сигнатурою', () => {
    expect(detectMimeFromBuffer(withTail(PNG))).toBe('image/png');
  });

  it('впізнає JPEG (FF D8 FF)', () => {
    expect(detectMimeFromBuffer(withTail(JPEG))).toBe('image/jpeg');
  });

  it('впізнає GIF', () => {
    expect(detectMimeFromBuffer(withTail(GIF))).toBe('image/gif');
  });

  it('впізнає WEBP (RIFF…WEBP)', () => {
    expect(detectMimeFromBuffer(withTail(WEBP))).toBe('image/webp');
  });

  it('впізнає PDF (%PDF-)', () => {
    expect(detectMimeFromBuffer(withTail(PDF))).toBe('application/pdf');
  });

  it('впізнає HEIC (ftyp heic)', () => {
    expect(detectMimeFromBuffer(withTail(HEIC))).toBe('image/heic');
  });

  it('впізнає ZIP/XLSX (PK\\x03\\x04) як OOXML', () => {
    expect(detectMimeFromBuffer(withTail(ZIP))).toBe(ZIP_MIME);
  });

  it('RIFF без WEBP-бренда (напр. WAV) → null, не зображення', () => {
    const wav = [0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45];
    expect(detectMimeFromBuffer(withTail(wav))).toBeNull();
  });

  it('виконуваний MZ → null (підробка .exe→.png)', () => {
    expect(detectMimeFromBuffer(withTail(MZ))).toBeNull();
  });

  it('текстовий файл → null (підробка .txt→.xlsx)', () => {
    expect(detectMimeFromBuffer(TXT)).toBeNull();
  });

  it('короткий буфер (< 4 байт) → null', () => {
    expect(detectMimeFromBuffer(sig(0x89, 0x50))).toBeNull();
    expect(detectMimeFromBuffer(Buffer.alloc(0))).toBeNull();
  });

  it('Uint8Array приймається так само, як Buffer', () => {
    expect(detectMimeFromBuffer(Uint8Array.from(withTail(PNG)))).toBe('image/png');
  });
});

describe('isDetectedImage / isDetectedZip', () => {
  it('зображення: PNG/JPEG/WEBP/GIF/HEIC — true; PDF/ZIP/null — false', () => {
    expect(isDetectedImage('image/png')).toBe(true);
    expect(isDetectedImage('image/jpeg')).toBe(true);
    expect(isDetectedImage('image/webp')).toBe(true);
    expect(isDetectedImage('image/gif')).toBe(true);
    expect(isDetectedImage('image/heic')).toBe(true);
    expect(isDetectedImage('application/pdf')).toBe(false);
    expect(isDetectedImage(ZIP_MIME)).toBe(false);
    expect(isDetectedImage(null)).toBe(false);
  });

  it('zip: лише OOXML-mime — true', () => {
    expect(isDetectedZip(ZIP_MIME)).toBe(true);
    expect(isDetectedZip('image/png')).toBe(false);
    expect(isDetectedZip(null)).toBe(false);
  });
});

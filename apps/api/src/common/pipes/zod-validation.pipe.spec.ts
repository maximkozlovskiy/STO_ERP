import { describe, it, expect } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';
import { ZodValidationPipe } from './zod-validation.pipe';
import { goodFormSchema } from '@sto/shared';

describe('ZodValidationPipe', () => {
  it('повертає типізований (коерснутий) об’єкт для валідного входу', () => {
    const pipe = new ZodValidationPipe(goodFormSchema);
    const out = pipe.transform({ name: 'Масло', purchasePrice: '350' });
    expect(out.name).toBe('Масло');
    expect(out.purchasePrice).toBe(350); // рядок → число
  });

  it('кидає BadRequest із форматом { statusCode, message: string[], error } українською', () => {
    const pipe = new ZodValidationPipe(goodFormSchema);
    try {
      pipe.transform({ name: '' });
      throw new Error('очікували BadRequestException');
    } catch (e) {
      expect(e).toBeInstanceOf(BadRequestException);
      const resp = (e as BadRequestException).getResponse() as {
        statusCode: number;
        message: string[];
        error: string;
      };
      expect(resp.statusCode).toBe(400);
      expect(resp.error).toBe('Bad Request');
      expect(Array.isArray(resp.message)).toBe(true);
      expect(resp.message[0]).toContain('Вкажіть назву товару');
    }
  });

  it('додає шлях поля до повідомлення (форма зіставляє помилку з полем)', () => {
    const schema = z.object({ email: z.string().email('Невірний email') });
    const pipe = new ZodValidationPipe(schema);
    try {
      pipe.transform({ email: 'bad' });
    } catch (e) {
      const resp = (e as BadRequestException).getResponse() as { message: string[] };
      expect(resp.message[0]).toBe('Невірний email (поле "email")');
    }
  });

  it('порожній масив issues → загальний фолбек', () => {
    // Схема, що завжди падає без issues малоймовірна; перевіряємо гілку через мок-схему.
    const fake = {
      safeParse: () => ({ success: false, error: { issues: [] } }),
    } as unknown as z.ZodSchema<unknown>;
    const pipe = new ZodValidationPipe(fake);
    try {
      pipe.transform({});
    } catch (e) {
      const resp = (e as BadRequestException).getResponse() as { message: string[] };
      expect(resp.message).toEqual(['Помилка валідації']);
    }
  });
});

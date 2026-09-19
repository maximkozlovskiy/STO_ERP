import { describe, it, expect } from 'vitest';
import type { ValidationError } from '@nestjs/common';
import { BadRequestException } from '@nestjs/common';
import { validationExceptionFactory } from './validation-error.factory';
import { runWithTenant } from '../tenant/tenant-context';

/**
 * Locale round-trip guard for the class-validator 400 seam (analog of zod-validation.pipe.spec.ts).
 * validationExceptionFactory reads getLocale() from the tenant ALS; we drive it via runWithTenant so
 * each assertion exercises the real request path (uk default + Accept-Language:en override).
 *
 * Covers: generic err.cv.* templates (isNotEmpty/maxLength/matches/isEnum/isEmail), {{field}}
 * interpolation, reachable inline err.dto.* overrides (IsHexColor → err.dto.*.color.hex — NOT shadowed
 * by CV_TEMPLATE_KEYS), nested @ValidateNested children (parentPath join), and the empty-errors fallback.
 */

function leaf(property: string, constraints: Record<string, string>): ValidationError {
  return { property, constraints, children: [] };
}

function nested(property: string, children: ValidationError[]): ValidationError {
  return { property, children };
}

/** Runs the factory as if inside a request with the given locale. */
function factoryWithLocale(locale: 'uk' | 'en', errors: ValidationError[]): string[] {
  const ex = runWithTenant({ locale }, () => validationExceptionFactory(errors));
  expect(ex).toBeInstanceOf(BadRequestException);
  const res = ex.getResponse() as { statusCode: number; message: string[]; error: string };
  expect(res.statusCode).toBe(400);
  expect(res.error).toBe('Bad Request');
  expect(Array.isArray(res.message)).toBe(true);
  return res.message;
}

describe('validationExceptionFactory — locale round-trip', () => {
  describe('generic err.cv.* constraints render per-locale', () => {
    const cases: Array<[string, string, RegExp, RegExp]> = [
      ['isNotEmpty', 'isNotEmpty', /не може бути порожнім/, /cannot be empty/],
      ['maxLength', 'maxLength', /занадто довге/, /too long/],
      ['matches', 'matches', /некоректний формат/, /incorrect format/],
      ['isEnum', 'isEnum', /допустимих значень/, /allowed values/],
      ['isEmail', 'isEmail', /email/i, /email/i],
    ];

    for (const [name, constraintKey, ukRe, enRe] of cases) {
      it(`${name}: uk ↔ en`, () => {
        const errs = [leaf('name', { [constraintKey]: 'raw class-validator message' })];
        const uk = factoryWithLocale('uk', errs);
        const en = factoryWithLocale('en', errs);
        expect(uk[0]).toMatch(ukRe);
        expect(en[0]).toMatch(enRe);
        // Never leak the raw constraint string, nor the translation key.
        expect(uk[0]).not.toContain('raw class-validator');
        expect(uk[0]).not.toContain('err.cv.');
        expect(en[0]).not.toContain('err.cv.');
      });
    }
  });

  it('{{field}} interpolates the field path in both locales (no literal {{field}})', () => {
    const errs = [leaf('email', { isEmail: 'x' })];
    const uk = factoryWithLocale('uk', errs);
    const en = factoryWithLocale('en', errs);
    expect(uk[0]).toContain('email');
    expect(en[0]).toContain('email');
    expect(uk[0]).not.toContain('{{field}}');
    expect(en[0]).not.toContain('{{field}}');
  });

  it('isIn maps to err.cv.isEnum (not a separate key)', () => {
    const errs = [leaf('type', { isIn: 'x' })];
    expect(factoryWithLocale('uk', errs)[0]).toMatch(/допустимих значень/);
    expect(factoryWithLocale('en', errs)[0]).toMatch(/allowed values/);
  });

  describe('reachable inline err.dto.* override (IsHexColor, not shadowed)', () => {
    it('renders the localized catalog value in both locales', () => {
      const errs = [leaf('color', { isHexColor: 'err.dto.counterpartyStatus.color.hex' })];
      const uk = factoryWithLocale('uk', errs);
      const en = factoryWithLocale('en', errs);
      expect(uk[0]).toMatch(/HEX/);
      expect(uk[0]).toMatch(/Колір/);
      expect(en[0]).toMatch(/HEX/);
      expect(en[0]).toMatch(/Color/);
      expect(uk[0]).not.toContain('err.dto.');
      expect(en[0]).not.toContain('err.dto.');
    });
  });

  it('non-key raw default message survives verbatim (unknown constraint fallback)', () => {
    const raw = 'some third-party constraint message';
    const errs = [leaf('field', { someCustomConstraint: raw })];
    expect(factoryWithLocale('uk', errs)[0]).toBe(raw);
    expect(factoryWithLocale('en', errs)[0]).toBe(raw);
  });

  describe('nested @ValidateNested children (recursion + path join)', () => {
    it('builds parent.child field path and translates each leaf', () => {
      const errs = [
        nested('address', [leaf('city', { isNotEmpty: 'x' }), leaf('zip', { matches: 'x' })]),
      ];
      const uk = factoryWithLocale('uk', errs);
      expect(uk).toHaveLength(2);
      expect(uk[0]).toContain('address.city');
      expect(uk[0]).toMatch(/не може бути порожнім/);
      expect(uk[1]).toContain('address.zip');
      expect(uk[1]).toMatch(/некоректний формат/);

      const en = factoryWithLocale('en', errs);
      expect(en[0]).toContain('address.city');
      expect(en[0]).toMatch(/cannot be empty/);
      expect(en[1]).toContain('address.zip');
    });

    it('handles nested array items (parent.0.field style paths)', () => {
      const errs = [nested('items', [nested('0', [leaf('qty', { min: 'x' })])])];
      const uk = factoryWithLocale('uk', errs);
      expect(uk).toHaveLength(1);
      expect(uk[0]).toContain('items.0.qty');
    });
  });

  describe('empty-errors fallback', () => {
    it('errors array with no producible messages → localized v.validationFailed', () => {
      // A ValidationError with no constraints and no children yields no leaf messages.
      const errs: ValidationError[] = [{ property: 'x', children: [] }];
      const uk = factoryWithLocale('uk', errs);
      const en = factoryWithLocale('en', errs);
      expect(uk).toHaveLength(1);
      expect(en).toHaveLength(1);
      // Must be localized, not the raw key.
      expect(uk[0]).not.toBe('v.validationFailed');
      expect(en[0]).not.toBe('v.validationFailed');
      expect(uk[0]).not.toBe(en[0]);
    });

    it('completely empty errors array → localized fallback', () => {
      const uk = factoryWithLocale('uk', []);
      expect(uk).toHaveLength(1);
      expect(uk[0]).not.toBe('v.validationFailed');
    });
  });

  it('default locale (no ALS store) resolves to uk', () => {
    const ex = validationExceptionFactory([leaf('name', { isNotEmpty: 'x' })]);
    const res = ex.getResponse() as { message: string[] };
    expect(res.message[0]).toMatch(/не може бути порожнім/);
  });
});

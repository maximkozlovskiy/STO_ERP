import { describe, it, expect } from 'vitest';
import { whereHasTenantScope } from './tenant-guard.extension';

/**
 * A1 — pure-unit покриття детектора tenant-scope у `where`. (Повна поведінка екстеншена — throw/stamp/tx —
 * покривається інтеграційним тестом проти реального client-а; тут доводимо саму логіку розпізнавання
 * усіх реальних where-shape-ів з коду.)
 */
describe('whereHasTenantScope', () => {
  describe('приймає (має tenant-scope)', () => {
    it('top-level orgId', () => {
      expect(whereHasTenantScope({ orgId: 'o1', deletedAt: null })).toBe(true);
    });
    it('top-level orgId разом з id', () => {
      expect(whereHasTenantScope({ id: 'x', orgId: 'o1' })).toBe(true);
    });
    it('top-level branchId (tenant-binding через FK→GarageBranch→org)', () => {
      expect(whereHasTenantScope({ branchId: 'b1' })).toBe(true);
    });
    it('composite-unique ключ з orgId (orgId_email)', () => {
      expect(whereHasTenantScope({ orgId_email: { orgId: 'o1', email: 'a@b.c' } })).toBe(true);
    });
    it('composite-unique ключ з orgId (orgId_goodId_warehouseId)', () => {
      expect(
        whereHasTenantScope({
          orgId_goodId_warehouseId: { orgId: 'o1', goodId: 'g', warehouseId: 'w' },
        }),
      ).toBe(true);
    });
    it('composite-unique ключ з branchId (branchId_channel)', () => {
      expect(whereHasTenantScope({ branchId_channel: { branchId: 'b1', channel: 'SMS' } })).toBe(
        true,
      );
    });
    it('composite-unique ключ з branchId (branchId_kind_provider)', () => {
      expect(
        whereHasTenantScope({
          branchId_kind_provider: { branchId: 'b1', kind: 'FISCAL', provider: 'checkbox' },
        }),
      ).toBe(true);
    });
    it('AND-гілка містить orgId', () => {
      expect(whereHasTenantScope({ AND: [{ status: 'DRAFT' }, { orgId: 'o1' }] })).toBe(true);
    });
    it('AND як одиночний обʼєкт (не масив)', () => {
      expect(whereHasTenantScope({ AND: { orgId: 'o1' } })).toBe(true);
    });
  });

  describe('відхиляє (немає tenant-scope → guard кине)', () => {
    it('порожній where', () => {
      expect(whereHasTenantScope({})).toBe(false);
    });
    it('undefined/null where', () => {
      expect(whereHasTenantScope(undefined)).toBe(false);
      expect(whereHasTenantScope(null)).toBe(false);
    });
    it('лише id (без orgId) — класичний пропуск', () => {
      expect(whereHasTenantScope({ id: 'x', deletedAt: null })).toBe(false);
    });
    it('composite-ключ БЕЗ tenant-токена (workOrderId_something)', () => {
      expect(whereHasTenantScope({ someKey: { workOrderId: 'w', foo: 1 } })).toBe(false);
    });
    it('top-level OR без sibling orgId — свідомо MISS (одна гілка могла б матчити чужий tenant)', () => {
      expect(whereHasTenantScope({ OR: [{ orgId: 'o1' }, { orgId: 'o2' }] })).toBe(false);
    });
    it('фільтр-обʼєкт на не-tenant полі (status equals) не рахується як scope', () => {
      expect(whereHasTenantScope({ status: { equals: 'DRAFT' } })).toBe(false);
    });
  });
});

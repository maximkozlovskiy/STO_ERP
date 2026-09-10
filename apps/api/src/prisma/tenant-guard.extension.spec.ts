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
    it('orgId як {in:[...]} — легіт cross-org batch (nbu-fetch.scheduler)', () => {
      expect(whereHasTenantScope({ orgId: { in: ['o1', 'o2'] } })).toBe(true);
    });
    it('orgId як {equals:v} — позитивна рівність', () => {
      expect(whereHasTenantScope({ orgId: { equals: 'o1' } })).toBe(true);
    });
    it('orgId-scalar із sibling NOT:{deletedAt} — scope дає orgId, не NOT', () => {
      expect(whereHasTenantScope({ orgId: 'o1', NOT: { deletedAt: null } })).toBe(true);
    });
    it('orgId-scalar із sibling NOT:{id} (unique-recheck pattern)', () => {
      expect(whereHasTenantScope({ orgId: 'o1', name: 'a', NOT: { id: 'z' } })).toBe(true);
    });
  });

  // A1 leak-fix (Bug: guard приймав НЕГАТИВНІ/діапазонні orgId-фільтри як scope → крос-tenant витік).
  // Позитивна рівність (scalar/in/equals) прив'язує рядок до орендаря; негація/діапазон — матчить ЧУЖІ.
  describe('leak-вектори (НЕГАТИВНИЙ orgId-фільтр → guard МУСИТЬ кинути)', () => {
    it('orgId:{not:X} — негація матчить УСІ інші tenant-и', () => {
      expect(whereHasTenantScope({ orgId: { not: 'other-org' } })).toBe(false);
    });
    it('orgId:{notIn:[...]} — негація множини', () => {
      expect(whereHasTenantScope({ orgId: { notIn: ['a'] } })).toBe(false);
    });
    it('orgId:{gt/lt/gte/lte} — діапазон охоплює чужі tenant-и', () => {
      expect(whereHasTenantScope({ orgId: { gt: '0' } })).toBe(false);
      expect(whereHasTenantScope({ orgId: { lte: 'z' } })).toBe(false);
    });
    it('NOT:{orgId:X} — негований tenant-фільтр (матчить УСІ інші org)', () => {
      expect(whereHasTenantScope({ NOT: { orgId: 'x' } })).toBe(false);
    });
    it('branchId:{not:X} — те саме для branchId', () => {
      expect(whereHasTenantScope({ branchId: { not: 'b' } })).toBe(false);
    });
    it('orgId:null — NOT NULL колонка, {null} матчить 0 рядків, не scope', () => {
      expect(whereHasTenantScope({ orgId: null })).toBe(false);
    });
    it('orgId:{in:[]} — порожня множина не є позитивним tenant-binding', () => {
      expect(whereHasTenantScope({ orgId: { in: [] } })).toBe(false);
    });
    it('nested composite key з orgId:undefined (забутий tenant-токен у ключі)', () => {
      expect(whereHasTenantScope({ orgId_email: { orgId: undefined, email: 'x' } })).toBe(false);
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

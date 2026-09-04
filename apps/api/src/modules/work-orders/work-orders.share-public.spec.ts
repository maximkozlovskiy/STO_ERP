import { describe, it, expect, vi } from 'vitest';
import { WorkOrdersService } from './work-orders.service';
import type { PrismaService } from '../../prisma/prisma.service';

// ─── Regression spec: findByShareToken — public DTO leak guards ────────────
//
// Public endpoint /work-orders/share/:token (без auth, доступний клієнтам через
// SMS link) повертає EstimatePublicDto — МАЄ бути МІНІМАЛЬНИМ. Чутливі поля
// (costPrice, orgId, FK-и, paidAmount, syncVersion) НЕ повинні витікати у
// публічну відповідь.
//
// Цей spec ловить регресії:
//   #530-A: refactor що додає `costPrice: Number(p.batchCostPrice)` до parts.map
//           у findByShareToken → leak фінансово чутливого поля у public endpoint.
//   #530-B: include {parts: {select: {batchCostPrice: true}}} замість зараз
//           обмеженого select — поле потрапляє у wo.parts[i], і автоматичний
//           spread `{ ...p }` (якщо рефакторинг) витікає у DTO.
//   #530-C: `findByShareToken` повертає поля що не оголошені у EstimatePublicDto
//           (контракт-дрейф) — `Object.keys()` не повинні містити sensitive.
//   #530-D: Promise.all([org, uoms]) sequential-regression — обидва запити
//           ОБОВ'ЯЗКОВО незалежні (org залежить лише від wo.orgId, uoms — лише
//           від wo.parts[].unitOfMeasureId; org→uoms sequential = регресія).
//   #530-E: findByShareToken з 0 запчастин з unitOfMeasureId — БЕЗ goodUoM.findMany
//           call (короткий вихід `uomIds.length === 0`).

const TOKEN = 'public-share-token-abc-def-12345';

function makePrismaForPublicShare(opts: { hasUoMIds: boolean; partsCount?: number }) {
  const woFindFirst = vi.fn().mockResolvedValue({
    id: 'wo-1',
    orgId: 'org-1',
    number: 'WO-2026-0042',
    status: 'ESTIMATE',
    documentDate: new Date('2026-06-17'),
    description: 'Тестовий кошторис',
    inMileage: 50000,
    totalLabor: 1000,
    totalParts: 500,
    totalAmount: 1500,
    totalActualLabor: 1200, // навмисно != totalLabor — щоб переконатись що
    // публічний DTO повертає PLANNED (Bug #508 guard у самому handler)
    branch: { name: 'Філія Київ' },
    counterparty: {
      firstName: 'Іван',
      lastName: 'Петров',
      companyName: null,
    },
    vehicle: {
      make: 'Toyota',
      model: 'Camry',
      licensePlate: 'AB1234CD',
    },
    lines: [
      {
        id: 'line-1',
        normoHours: 2,
        price: 500,
        amount: 1000,
        notes: null,
        work: { name: 'Заміна масла' },
      },
    ],
    parts: Array.from({ length: opts.partsCount ?? 1 }, (_, i) => ({
      id: `part-${i + 1}`,
      goodId: `good-${i + 1}`,
      quantity: 1,
      price: 250,
      amount: 250,
      // unitOfMeasureId — або всім string, або всім null
      unitOfMeasureId: opts.hasUoMIds ? `uom-${i + 1}` : null,
      good: {
        name: `Запчастина ${i + 1}`,
        unit: 'шт',
        unitOfMeasure: { shortName: 'шт' },
      },
    })),
  });

  const organisationFindFirst = vi.fn().mockResolvedValue({
    name: 'СТО Тест',
    logoUrl: 'https://example.com/logo.png',
  });

  const goodUoMFindMany = vi.fn().mockResolvedValue(
    opts.hasUoMIds
      ? Array.from({ length: opts.partsCount ?? 1 }, (_, i) => ({
          id: `uom-${i + 1}`,
          unitOfMeasure: { shortName: `у${i + 1}` },
        }))
      : [],
  );

  const prisma = {
    workOrder: { findFirst: woFindFirst },
    organisation: { findFirst: organisationFindFirst },
    goodUoM: { findMany: goodUoMFindMany },
  } as unknown as PrismaService;

  return { prisma, woFindFirst, organisationFindFirst, goodUoMFindMany };
}

function makeService(prisma: PrismaService): WorkOrdersService {
  return new WorkOrdersService(
    prisma,
    null as never,
    null as never,
    null as never,
    null as never,
    null as never,
    null as never,
    null as never,
    null as never,
    null as never,
    null as never,
  );
}

describe('WorkOrdersService.findByShareToken — public DTO leak guards', () => {
  // ─── 1. costPrice ВІДСУТНІЙ у parts[] ─────────────────────────────────────

  it('parts[] МАЄ НЕ МІСТИТИ costPrice (key absent, not undefined/null)', async () => {
    const { prisma } = makePrismaForPublicShare({ hasUoMIds: false, partsCount: 2 });
    const service = makeService(prisma);

    const dto = await service.findByShareToken(TOKEN);

    expect(dto.parts).toHaveLength(2);
    for (const part of dto.parts) {
      // КРИТИЧНО: ключ costPrice взагалі НЕ повинен існувати у public DTO.
      // hasOwnProperty не реагує на undefined що відсутній; це сильніша гарантія
      // ніж `.costPrice === undefined`.
      expect(Object.prototype.hasOwnProperty.call(part, 'costPrice')).toBe(false);
      // Bonus — навіть індекс-доступ не повинен щось повернути:
      expect((part as Record<string, unknown>).costPrice).toBeUndefined();
    }
  });

  it('parts[] НЕ містить інші чутливі поля (batchCostPrice, warehouseId, goodId, orgId)', async () => {
    const { prisma } = makePrismaForPublicShare({ hasUoMIds: false, partsCount: 1 });
    const service = makeService(prisma);

    const dto = await service.findByShareToken(TOKEN);

    const part = dto.parts[0] as Record<string, unknown>;
    // Жодне з фінансово/structurally чутливих полів не повинно бути у public DTO:
    expect(Object.prototype.hasOwnProperty.call(part, 'batchCostPrice')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(part, 'warehouseId')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(part, 'goodId')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(part, 'orgId')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(part, 'workOrderId')).toBe(false);
  });

  it('top-level DTO НЕ містить orgId, paidAmount, syncVersion, contractId', async () => {
    const { prisma } = makePrismaForPublicShare({ hasUoMIds: false });
    const service = makeService(prisma);

    const dto = (await service.findByShareToken(TOKEN)) as Record<string, unknown>;

    expect(Object.prototype.hasOwnProperty.call(dto, 'orgId')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(dto, 'paidAmount')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(dto, 'syncVersion')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(dto, 'contractId')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(dto, 'shareToken')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(dto, 'createdAt')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(dto, 'updatedAt')).toBe(false);
  });

  it('контракт parts[] — рівно {id, goodName, quantity, unitShortName, price, amount}', async () => {
    const { prisma } = makePrismaForPublicShare({ hasUoMIds: false, partsCount: 1 });
    const service = makeService(prisma);

    const dto = await service.findByShareToken(TOKEN);

    const part = dto.parts[0];
    // Точний whitelist полів — якщо хтось додасть поле без оновлення DTO/
    // EstimatePublicPartDto, спрацює тут.
    expect(Object.keys(part as Record<string, unknown>).sort()).toEqual(
      ['amount', 'goodName', 'id', 'price', 'quantity', 'unitShortName'].sort(),
    );
  });

  // ─── 2. totalAmount = PLANNED (Bug #508 regression guard у share endpoint) ─

  it('totalAmount = totalLabor + totalParts (НЕ wo.totalAmount який містить actualHours)', async () => {
    // makePrismaForPublicShare встановлює totalActualLabor=1200, totalLabor=1000,
    // totalParts=500 → wo.totalAmount у БД = 1500 (planned-coincidence) або 1700 (actual+parts).
    // Симулюємо актуальну розбіжність:
    const prisma = {
      workOrder: {
        findFirst: vi.fn().mockResolvedValue({
          orgId: 'org-1',
          number: 'WO-2026-0042',
          status: 'ESTIMATE',
          documentDate: new Date('2026-06-17'),
          description: null,
          inMileage: null,
          totalLabor: 1000,
          totalParts: 500,
          totalAmount: 1700, // wo.totalAmount містить actual (мав би бути 1500 planned)
          totalActualLabor: 1200,
          branch: { name: 'Br' },
          counterparty: { firstName: 'І', lastName: 'П', companyName: null },
          vehicle: { make: 'X', model: 'Y', licensePlate: 'Z' },
          lines: [],
          parts: [],
        }),
      },
      organisation: { findFirst: vi.fn().mockResolvedValue({ name: 'O', logoUrl: null }) },
      goodUoM: { findMany: vi.fn().mockResolvedValue([]) },
    } as unknown as PrismaService;

    const service = makeService(prisma);
    const dto = await service.findByShareToken(TOKEN);

    // КРИТИЧНО (Bug #508): public кошторис показує PLANNED, не actual.
    expect(dto.totalAmount).toBe(1500); // 1000 + 500
    expect(dto.totalAmount).not.toBe(1700); // НЕ wo.totalAmount
  });

  // ─── 3. Promise.all([org, uoms]) parallel guard ─────────────────────────

  it('org та goodUoM запити викликаються паралельно (не sequential)', async () => {
    const { prisma, organisationFindFirst, goodUoMFindMany } = makePrismaForPublicShare({
      hasUoMIds: true,
      partsCount: 1,
    });
    const service = makeService(prisma);

    // Робимо обидва запити slow з різними timings.
    // Якщо вони у Promise.all → загальний час ~ max(50, 80) = 80ms.
    // Якщо sequential → ~ 50 + 80 = 130ms.
    let orgResolveTime = 0;
    let uomsResolveTime = 0;
    let allStartTime = 0;

    (organisationFindFirst as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      await new Promise(r => setTimeout(r, 50));
      orgResolveTime = Date.now() - allStartTime;
      return { name: 'O', logoUrl: null };
    });
    (goodUoMFindMany as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      await new Promise(r => setTimeout(r, 80));
      uomsResolveTime = Date.now() - allStartTime;
      return [{ id: 'uom-1', unitOfMeasure: { shortName: 'у1' } }];
    });

    allStartTime = Date.now();
    await service.findByShareToken(TOKEN);
    const totalTime = Date.now() - allStartTime;

    // Гарантуємо що goodUoMFindMany стартував ДО завершення organisationFindFirst.
    // Якщо sequential — uomsResolveTime ≥ orgResolveTime + 80.
    // Якщо паралельно — uomsResolveTime ≈ orgResolveTime + ~30 (різниця delay).
    // Тест толерує 20ms jitter — нижня межа sequential буде ~130ms.
    expect(totalTime).toBeLessThan(130);
    // Регресія-guard: якщо хтось зробить
    //   const org = await prisma.organisation.findFirst(...);
    //   const uoms = await prisma.goodUoM.findMany(...);
    // → totalTime ≈ 130ms → fails.
    expect(orgResolveTime).toBeGreaterThan(0);
    expect(uomsResolveTime).toBeGreaterThan(0);
  });

  it('skip goodUoM.findMany якщо немає parts з unitOfMeasureId (defense + RTT save)', async () => {
    // Усі parts мають unitOfMeasureId === null → uomIds.length === 0 →
    // короткий вихід через Promise.resolve([]) без round-trip до БД.
    const { prisma, goodUoMFindMany } = makePrismaForPublicShare({
      hasUoMIds: false,
      partsCount: 3,
    });
    const service = makeService(prisma);

    await service.findByShareToken(TOKEN);

    // КРИТИЧНО: goodUoM.findMany НЕ викликається (short-circuit).
    expect(goodUoMFindMany).not.toHaveBeenCalled();
  });

  it('викликає goodUoM.findMany рівно один раз коли є parts з unitOfMeasureId', async () => {
    const { prisma, goodUoMFindMany } = makePrismaForPublicShare({
      hasUoMIds: true,
      partsCount: 2,
    });
    const service = makeService(prisma);

    await service.findByShareToken(TOKEN);

    expect(goodUoMFindMany).toHaveBeenCalledTimes(1);
    // WO-C3: lookup за (unitOfMeasureId, goodId), не за GoodUoM.id. Порядок — за parts[].
    const callArgs = (goodUoMFindMany as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(callArgs.where.unitOfMeasureId.in).toEqual(['uom-1', 'uom-2']);
    expect(callArgs.where.goodId.in).toEqual(['good-1', 'good-2']);
  });

  // ─── 4. NotFound on bad token (sanity) ──────────────────────────────────

  it('NotFoundException якщо токен не знайдено', async () => {
    const prisma = {
      workOrder: { findFirst: vi.fn().mockResolvedValue(null) },
    } as unknown as PrismaService;
    const service = makeService(prisma);

    await expect(service.findByShareToken('bad-token')).rejects.toThrow(
      'Посилання не дійсне або термін дії минув',
    );
  });
});

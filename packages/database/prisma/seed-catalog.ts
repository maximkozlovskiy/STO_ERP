/**
 * seed-catalog.ts — Імпорт системних каталогів послуг та категорій товарів.
 * Виконується після seed.ts: npx ts-node prisma/seed-catalog.ts
 *
 * Що робить:
 *   1. Читає sto_services_catalog_full.json → WorkCategory (71 шт.) + Work (345 шт.)
 *   2. Читає auto_parts_categories.json → GoodCategory (365 шт.)
 *   3. Будує WorkGoodCategoryLink через linked_service_codes
 *
 * Ідемпотентний: повторний запуск оновить тільки змінені поля, нових дублів не створить.
 */

import { PrismaClient, Prisma } from '@prisma/client';
import * as fs from 'fs';
import * as path from 'path';

const prisma = new PrismaClient();

const ORG_ID = 'a1000000-0000-4000-8000-000000000001';

// ─── JSON types ───────────────────────────────────────────

interface ServiceNode {
  id: number;
  parent_id: number | null;
  type: 'category' | 'service';
  level?: number;
  code: string;
  name: string;
  norm_hours: number | null;
  sort_order: number;
  is_active: boolean;
}

interface PartsCategoryNode {
  id: number;
  parent_id: number | null;
  type: 'category';
  level: number;
  code: string;
  name: string;
  is_leaf: boolean;
  linked_service_codes: string[];
  sort_order: number;
  is_active: boolean;
}

// ─── Helpers ─────────────────────────────────────────────

function loadJson<T>(filename: string): T {
  const docsDir = path.resolve(__dirname, '../../../docs');
  const filePath = path.join(docsDir, filename);
  return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
}

// ─── Main ────────────────────────────────────────────────

async function main() {
  console.warn('seed-catalog: старт...');

  const servicesData = loadJson<{ nodes: ServiceNode[] }>('sto_services_catalog_full.json');
  const partsData = loadJson<{ nodes: PartsCategoryNode[] }>('auto_parts_categories.json');

  // ─── Step 1: WorkCategory (тільки type=category) ─────────

  const categoryNodes = servicesData.nodes.filter(n => n.type === 'category');
  const serviceNodes = servicesData.nodes.filter(n => n.type === 'service');

  console.warn(`  Категорій послуг: ${categoryNodes.length}, Послуг: ${serviceNodes.length}`);

  // Map JSON id → DB uuid (генеруємо детерміновані UUID через prefix)
  // Використовуємо детерміновані UUID щоб upsert був ідемпотентним
  const workCatIdMap = new Map<number, string>(); // jsonId → dbId

  // Спочатку отримаємо всі існуючі системні WorkCategory для цього org
  const existingWorkCats = await prisma.workCategory.findMany({
    where: { orgId: ORG_ID, isSystem: true, deletedAt: null },
    select: { id: true, code: true },
  });
  const existingWorkCatByCode = new Map(existingWorkCats.map(c => [c.code!, c.id]));

  // Сортуємо: кореневі (parent_id=null) першими, потім дочірні — тільки 2 рівні в services JSON
  const sortedCategoryNodes = [...categoryNodes].sort(
    (a, b) =>
      (a.parent_id === null ? 0 : 1) - (b.parent_id === null ? 0 : 1) ||
      a.sort_order - b.sort_order,
  );

  for (const node of sortedCategoryNodes) {
    const parentDbId = node.parent_id ? (workCatIdMap.get(node.parent_id) ?? null) : null;

    // Знайти або створити
    let dbId = existingWorkCatByCode.get(node.code);

    if (dbId) {
      // Оновити існуючу
      await prisma.workCategory.update({
        where: { id: dbId },
        data: {
          name: node.name,
          sortOrder: node.sort_order,
          isActive: node.is_active,
          parentId: parentDbId,
        },
      });
    } else {
      // Створити нову
      const created = await prisma.workCategory.create({
        data: {
          orgId: ORG_ID,
          name: node.name,
          code: node.code,
          parentId: parentDbId,
          sortOrder: node.sort_order,
          isSystem: true,
          isActive: node.is_active,
        },
      });
      dbId = created.id;
      existingWorkCatByCode.set(node.code, dbId);
    }

    workCatIdMap.set(node.id, dbId);
  }

  console.warn(`  WorkCategory: ${workCatIdMap.size} оброблено`);

  // ─── Step 2: Work (тільки type=service) ──────────────────

  // Отримати всі існуючі системні Work по code
  const existingWorks = await prisma.work.findMany({
    where: { orgId: ORG_ID, deletedAt: null },
    select: { id: true, name: true, categoryId: true },
  });
  const existingWorkByName = new Map(existingWorks.map(w => [w.name, w.id]));

  let worksCreated = 0;
  let worksUpdated = 0;

  for (const node of serviceNodes) {
    const catDbId = node.parent_id ? workCatIdMap.get(node.parent_id) : null;
    if (!catDbId) {
      console.warn(
        `  ⚠ Work "${node.name}" (code=${node.code}): батьківська категорія не знайдена`,
      );
      continue;
    }

    const existingId = existingWorkByName.get(node.name);
    if (existingId) {
      // Якщо id = 'created' — пропустити (вже оброблено раніше в цьому батчі)
      if (existingId !== 'created') {
        await prisma.work.update({
          where: { id: existingId },
          data: {
            categoryId: catDbId,
            normoHours: node.norm_hours ?? 1.0,
          },
        });
        worksUpdated++;
      }
    } else {
      const created = await prisma.work.create({
        data: {
          orgId: ORG_ID,
          categoryId: catDbId,
          name: node.name,
          normoHours: node.norm_hours ?? 1.0,
          price: new Prisma.Decimal(0),
        },
      });
      existingWorkByName.set(node.name, created.id);
      worksCreated++;
    }
  }

  console.warn(`  Work: ${worksCreated} створено, ${worksUpdated} оновлено`);

  // ─── Step 3: GoodCategory ────────────────────────────────

  const goodCatIdMap = new Map<number, string>(); // jsonId → dbId

  const existingGoodCats = await prisma.goodCategory.findMany({
    where: { orgId: ORG_ID, isSystem: true, deletedAt: null },
    select: { id: true, code: true },
  });
  const existingGoodCatByCode = new Map(existingGoodCats.map(c => [c.code!, c.id]));

  // Сортуємо за level (1 → 2 → 3) щоб батько завжди оброблявся до дитини
  const sortedPartNodes = [...partsData.nodes].sort(
    (a, b) => (a.level ?? 1) - (b.level ?? 1) || a.sort_order - b.sort_order,
  );

  for (const node of sortedPartNodes) {
    const parentDbId = node.parent_id ? (goodCatIdMap.get(node.parent_id) ?? null) : null;

    let dbId = existingGoodCatByCode.get(node.code);

    if (dbId) {
      await prisma.goodCategory.update({
        where: { id: dbId },
        data: {
          name: node.name,
          sortOrder: node.sort_order,
          isActive: node.is_active,
          parentId: parentDbId,
        },
      });
    } else {
      const created = await prisma.goodCategory.create({
        data: {
          orgId: ORG_ID,
          name: node.name,
          code: node.code,
          parentId: parentDbId,
          sortOrder: node.sort_order,
          isSystem: true,
          isActive: node.is_active,
        },
      });
      dbId = created.id;
      existingGoodCatByCode.set(node.code, dbId);
    }

    goodCatIdMap.set(node.id, dbId);
  }

  console.warn(`  GoodCategory: ${goodCatIdMap.size} оброблено`);

  // ─── Step 4: WorkGoodCategoryLink ────────────────────────

  // Будуємо маппінг code (верхнього рівня сервісної категорії) → [workCategoryDbId]
  // linked_service_codes наприклад: ["ENG", "MNT"] — тобто верхньорівневі коди
  const workCatByCode = new Map<string, string>(); // code → dbId (всі WorkCategory)
  for (const [code, dbId] of existingWorkCatByCode) {
    workCatByCode.set(code, dbId);
  }

  let linksCreated = 0;
  let linksSkipped = 0;

  for (const node of partsData.nodes) {
    const goodCatDbId = goodCatIdMap.get(node.id);
    if (!goodCatDbId) continue;

    for (const serviceCode of node.linked_service_codes) {
      const workCatDbId = workCatByCode.get(serviceCode);
      if (!workCatDbId) {
        linksSkipped++;
        continue;
      }

      // Upsert link (ігнорувати якщо вже існує)
      await prisma.workGoodCategoryLink.upsert({
        where: {
          orgId_workCategoryId_goodCategoryId: {
            orgId: ORG_ID,
            workCategoryId: workCatDbId,
            goodCategoryId: goodCatDbId,
          },
        },
        update: {},
        create: {
          orgId: ORG_ID,
          workCategoryId: workCatDbId,
          goodCategoryId: goodCatDbId,
        },
      });
      linksCreated++;
    }
  }

  console.warn(`  WorkGoodCategoryLink: ${linksCreated} записів, ${linksSkipped} пропущено`);
  console.warn('seed-catalog: завершено ✓');
}

main()
  .catch(e => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => {
    void prisma.$disconnect();
  });

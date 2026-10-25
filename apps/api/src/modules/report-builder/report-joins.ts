import { Prisma } from '@prisma/client';
import type { ReportEntityDef } from './report-registry';

/**
 * З'єднання для SQL-агрегатів конструктора (`report-sql.builder.ts`). FK-колонка хопу — з реєстру
 * (`relation.fk`), таблиця цілі й наявність колонок — з DMMF Prisma (у Prisma 7 runtime-DMMF має
 * назви, типи й `dbName` моделей, але не FK і не обов'язковість). Кожен хоп звіряється: FK є
 * колонкою батька, зв'язок веде в модель цілі — розбіжність кидає при першому ж запиті й ловиться
 * `report-registry.spec.ts`.
 */

type DmmfModel = (typeof Prisma.dmmf.datamodel.models)[number];

const MODELS: ReadonlyMap<string, DmmfModel> = new Map(
  Prisma.dmmf.datamodel.models.map(m => [m.name, m]),
);

/** Хоп зв'язку: `good.brand` — з таблиці батька (`good`) по `brandId` у `brands`. */
export interface JoinHop {
  /** prismaPath зв'язку з реєстру: `good`, `good.brand`. */
  path: string;
  /** Шлях батька (`''` — корінь сутності). */
  parentPath: string;
  /** FK-колонка в таблиці батька. */
  fk: string;
  /** Таблиця цілі (`@@map`). */
  table: string;
  /** Ціль має `orgId` — ставимо його в `ON` (tenant-guard сирий SQL не бачить). */
  hasOrgId: boolean;
}

export interface EntityJoins {
  /** Таблиця кореня сутності. */
  rootTable: string;
  /** Хопи за prismaPath зв'язку. */
  hops: ReadonlyMap<string, JoinHop>;
}

/** `workOrderPart` (делегат Prisma) → модель DMMF `WorkOrderPart`. */
function modelOf(prismaModel: string): DmmfModel {
  const name = prismaModel.charAt(0).toUpperCase() + prismaModel.slice(1);
  const model = MODELS.get(name);
  if (!model) throw new Error(`report-joins: немає моделі ${name} у схемі Prisma`);
  return model;
}

const fieldOf = (model: DmmfModel, name: string) => model.fields.find(f => f.name === name);

const cache = new Map<string, EntityJoins>();

/** Розв'язує всі зв'язки сутності реєстру в хопи SQL. Кидає, якщо реєстр розійшовся зі схемою. */
export function resolveJoins(entity: ReportEntityDef): EntityJoins {
  const cached = cache.get(entity.key);
  if (cached) return cached;
  const root = modelOf(entity.prismaModel);
  const modelByPath = new Map<string, DmmfModel>([['', root]]);
  const hops = new Map<string, JoinHop>();
  // Батько раніше за дитину: за глибиною шляху.
  const relations = [...entity.relations].sort((a, b) => a.depth - b.depth);
  for (const rel of relations) {
    const segments = rel.prismaPath.split('.');
    const parentPath = segments.slice(0, -1).join('.');
    const parent = modelByPath.get(parentPath);
    if (!parent) throw new Error(`report-joins: немає батька для ${entity.key}.${rel.prismaPath}`);
    const field = fieldOf(parent, segments[segments.length - 1]);
    const target = field?.kind === 'object' ? MODELS.get(field.type) : undefined;
    if (!target) {
      throw new Error(`report-joins: ${parent.name}.${segments[segments.length - 1]} — не зв'язок`);
    }
    if (fieldOf(parent, rel.fk)?.kind !== 'scalar') {
      throw new Error(`report-joins: немає FK ${parent.name}.${rel.fk} для ${rel.prismaPath}`);
    }
    modelByPath.set(rel.prismaPath, target);
    hops.set(rel.prismaPath, {
      path: rel.prismaPath,
      parentPath,
      fk: rel.fk,
      table: target.dbName ?? target.name,
      hasOrgId: fieldOf(target, 'orgId') !== undefined,
    });
  }
  const joins = { rootTable: root.dbName ?? root.name, hops };
  cache.set(entity.key, joins);
  return joins;
}

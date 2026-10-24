import type { PrismaClient } from '@prisma/client';

/**
 * Спільна ФОРМА Prisma 5 `$allOperations`-хука (Prisma 5 вимагає `$extends` — `$use` прибрано у v5).
 * Витягнута з трьох розширень (`withSyncVersion`, `withFieldEncryption`, tenant-guard), які
 * інакше дублювали ідентичний boilerplate `$extends({ query: { $allModels: { $allOperations } } })`
 * і типізацію параметра — jscpd (CI 144). Спільний ЛИШЕ каркас/тип; логіка кожного розширення
 * (його рішення) живе у власному handler-і й не змінюється. Порядок композиції у [prisma.service.ts]
 * (tenant-guard OUTERMOST) теж незмінний — цей wrapper лише будує одне розширення.
 */
export interface AllOperationsArgs {
  model?: string;
  operation: string;
  args: Record<string, unknown>;
  query: (args: Record<string, unknown>) => Promise<unknown>;
}

export type AllOperationsHandler = (ctx: AllOperationsArgs) => Promise<unknown>;

/** Будує `$extends`-розширення з одним `$allModels.$allOperations`-хуком `handler`. */
export function extendAllModels(client: PrismaClient, handler: AllOperationsHandler): PrismaClient {
  return client.$extends({
    query: {
      $allModels: {
        $allOperations: handler,
      },
    },
  }) as unknown as PrismaClient;
}

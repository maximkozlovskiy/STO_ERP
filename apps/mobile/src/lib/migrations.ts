import { schemaMigrations, addColumns } from '@nozbe/watermelondb/Schema/migrations';

/**
 * Міграції локальної бази. Без них WatermelonDB при зміні `schema.version` СКИДАЄ базу —
 * а в ній можуть лежати ще не відправлені зміни (`is_dirty`). Тому кожне підняття версії
 * у `schema.ts` супроводжується кроком тут.
 */
export const migrations = schemaMigrations({
  migrations: [
    {
      // BR-WO-007: сума наряду без ПДВ і сума ПДВ. Колонки необов'язкові: у рядків,
      // синхронізованих до міграції, значення з'явиться після наступної синхронізації.
      toVersion: 2,
      steps: [
        addColumns({
          table: 'work_orders',
          columns: [
            { name: 'total_net', type: 'number', isOptional: true },
            { name: 'total_vat', type: 'number', isOptional: true },
          ],
        }),
      ],
    },
  ],
});

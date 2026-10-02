/**
 * Гард доступності БД для integration-специв.
 *
 * Патерн «немає БД → тихо skip» дозволяє розробнику прогнати весь набір без docker. Але він
 * має зворотний бік: у CI, де Postgres МАЄ бути, тест, що мовчки пропустився через збій
 * підключення чи незасіяну базу, виглядає точно як успішний. Саме так сталося раніше —
 * 7 integration-специв (включно з tenant-guard, про який у коді написано «ЄДИНЕ реальне
 * покриття guard-а») роками не виконувались у CI, і ніхто про це не знав (аудит 2026-10).
 *
 * Тому тут асиметрія:
 *  - локально (`REQUIRE_DB` не задано) — skip, як і було;
 *  - у CI (`REQUIRE_DB=1`) — недоступна БД валить набір із поясненням, а не ховається.
 */
export const DEFAULT_TEST_DATABASE_URL = 'postgresql://sto:sto_dev_secret@localhost:5432/sto_erp';

export function testDatabaseUrl(): string {
  return process.env.DATABASE_URL ?? DEFAULT_TEST_DATABASE_URL;
}

/** `true`, якщо прогін зобов'язаний мати живу БД (виставляється в CI). */
export function dbIsRequired(): boolean {
  return process.env.REQUIRE_DB === '1';
}

/**
 * Викликається з `beforeAll`, коли підключення не вдалося або база не засіяна.
 * У CI кидає, локально — дозволяє спеку піти у skip.
 *
 * @param reason що саме не склалося (підключення / відсутній seed)
 */
export function handleDbUnavailable(reason: string): void {
  if (!dbIsRequired()) return;
  throw new Error(
    `REQUIRE_DB=1, але БД недоступна: ${reason}. ` +
      `DATABASE_URL=${testDatabaseUrl().replace(/:[^:@]*@/, ':***@')}. ` +
      'У CI integration-тести не мають тихо пропускатись — підніміть Postgres, ' +
      'застосуйте міграції та seed.',
  );
}

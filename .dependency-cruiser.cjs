/**
 * Детектор циклічних залежностей.
 *
 * Замінив madge (аудит 2026-10): madge@8 — остання версія, і її peer прибитий до
 * typescript ^5.4.4. На TS 7 вона падає з «Cannot read properties of undefined
 * (reading 'readFile')». dependency-cruiser не оголошує typescript у peers і працює.
 *
 * Правило одне й навмисно: ловимо саме цикли. Три з них уже були знайдені й розірвані
 * (OCR-дуга — винесення grid-geometry і text-layer-registry), тож нуль утримати реально,
 * і крок CI лишається БЛОКУЮЧИМ.
 */
module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      severity: 'error',
      comment: 'Циклічна залежність: модулі імпортують одне одного по колу.',
      from: {},
      to: { circular: true },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    // Абсолютний шлях через __dirname: відносний резолвиться від CWD, і при запуску
    // `pnpm run cycles` з кореня depcruise падав із TS18003 («No inputs were found»),
    // бо шукав src/** відносно не тієї теки.
    tsConfig: { fileName: require('node:path').join(__dirname, 'apps/api/tsconfig.json') },
    tsPreCompilationDeps: true,
  },
};

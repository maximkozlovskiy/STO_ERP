import base from '@sto/config/vitest';
import { mergeConfig, defineConfig } from 'vitest/config';

// Спільний пресет packages/config/vitest/base.ts (він був написаний і експортований, але
// жоден пакет його не підключав — аудит 2026-10) + локальний exclude.
//
// `dist/` ОБОВ'ЯЗКОВО виключений: spec-файли компілювались у dist/cjs разом із рештою,
// і vitest підхоплював І джерело, І збірку — зібраний spec падав, бо у dist немає
// vitest як залежності. Паралельно spec прибрано зі збірки (tsconfig.cjs.json), тож
// фікс подвійний: у dist їх більше немає, і навіть якби з'явились — не скануються.
export default mergeConfig(
  base,
  defineConfig({ test: { exclude: ['**/node_modules/**', '**/dist/**'] } }),
);

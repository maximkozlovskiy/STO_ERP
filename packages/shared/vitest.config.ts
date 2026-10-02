// Використовує спільний пресет packages/config/vitest/base.ts. Пресет був написаний
// і експортований, але жоден пакет його не підключав (аудит 2026-10) — тут він оживає.
export { default } from '@sto/config/vitest';

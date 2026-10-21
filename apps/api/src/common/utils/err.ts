import { translateError } from '@sto/shared';
import { getLocale } from '../tenant/tenant-context';

/** Текст помилки за ключем `err.*` мовою поточного запиту (Accept-Language). */
export const err = (key: string, params?: Record<string, string | number>): string =>
  translateError(key, getLocale(), params);

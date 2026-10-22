import { describe, it, expect } from 'vitest';
import {
  pickLineExecutor,
  slotMechanicId,
  type LiftMechanic,
  type PickLineExecutorInput,
} from '../work-line-executor';

/**
 * BR-WO-030: виконавець нової роботи наряду — механік запису календаря, інакше єдиний механік
 * підйомника; відпустка й чужа категорія не підставляються; лише активні механіки.
 */

const ENGINE = 'cat-engine';
const BODY = 'cat-body';

const ivan: LiftMechanic = { id: 'm-ivan', status: 'ACTIVE', workCategoryIds: [] };
const petro: LiftMechanic = { id: 'm-petro', status: 'ACTIVE', workCategoryIds: [ENGINE] };
const oleh: LiftMechanic = { id: 'm-oleh', status: 'ACTIVE', workCategoryIds: [BODY] };
const onLeave: LiftMechanic = { id: 'm-leave', status: 'ON_LEAVE', workCategoryIds: [] };
/** Звужена відповідь (роль механіка): без статусу й категорій. */
const lookup: LiftMechanic = { id: 'm-lookup' };

const ACTIVE = ['m-ivan', 'm-petro', 'm-oleh', 'm-leave', 'm-lookup', 'm-calendar'];

describe('pickLineExecutor — BR-WO-030', () => {
  // guards: BR-WO-030
  it.each<[string, Omit<PickLineExecutorInput, 'activeMechanicIds'>, string]>([
    [
      'запис календаря з механіком → він, навіть коли на підйомнику кілька',
      { calendarMechanicId: 'm-petro', liftMechanics: [ivan, petro], workCategoryId: ENGINE },
      'm-petro',
    ],
    [
      'механік запису не з цього підйомника → усе одно він (категорій не знаємо — не обмежують)',
      { calendarMechanicId: 'm-calendar', liftMechanics: [ivan], workCategoryId: ENGINE },
      'm-calendar',
    ],
    [
      'запису немає, на підйомнику один механік → він',
      { calendarMechanicId: null, liftMechanics: [ivan], workCategoryId: ENGINE },
      'm-ivan',
    ],
    [
      'запису немає, на підйомнику кілька → порожньо',
      { calendarMechanicId: null, liftMechanics: [ivan, petro], workCategoryId: ENGINE },
      '',
    ],
    [
      'підйомника немає / список не отримано → порожньо',
      { calendarMechanicId: null, liftMechanics: null, workCategoryId: ENGINE },
      '',
    ],
    [
      'на підйомнику нікого → порожньо',
      { calendarMechanicId: null, liftMechanics: [], workCategoryId: ENGINE },
      '',
    ],
    [
      'єдиний механік у відпустці → порожньо',
      { calendarMechanicId: null, liftMechanics: [onLeave], workCategoryId: ENGINE },
      '',
    ],
    [
      'механік запису у відпустці → діє решта правила: єдиний механік підйомника',
      { calendarMechanicId: 'm-leave', liftMechanics: [onLeave, ivan], workCategoryId: ENGINE },
      'm-ivan',
    ],
    [
      'єдиний механік без категорії роботи → порожньо',
      { calendarMechanicId: null, liftMechanics: [oleh], workCategoryId: ENGINE },
      '',
    ],
    [
      'механік запису без категорії роботи → діє решта правила: єдиний механік підйомника',
      { calendarMechanicId: 'm-oleh', liftMechanics: [oleh, petro], workCategoryId: ENGINE },
      'm-petro',
    ],
    [
      'двоє на підйомнику, категорію роботи має лише один → він',
      { calendarMechanicId: null, liftMechanics: [petro, oleh], workCategoryId: BODY },
      'm-oleh',
    ],
    [
      'категорії в механіка не задано → підставляється для будь-якої роботи',
      { calendarMechanicId: null, liftMechanics: [ivan], workCategoryId: BODY },
      'm-ivan',
    ],
    [
      'звужена відповідь без статусу й категорій → підставляється',
      { calendarMechanicId: null, liftMechanics: [lookup], workCategoryId: ENGINE },
      'm-lookup',
    ],
    [
      'категорія роботи невідома: механік із категоріями не підставляється',
      { calendarMechanicId: null, liftMechanics: [petro], workCategoryId: null },
      '',
    ],
    [
      'категорія роботи невідома: механік без категорій підставляється',
      { calendarMechanicId: null, liftMechanics: [ivan], workCategoryId: null },
      'm-ivan',
    ],
  ])('%s', (_label, input, expected) => {
    expect(pickLineExecutor({ ...input, activeMechanicIds: ACTIVE })).toBe(expected);
  });

  // guards: BR-WO-030
  it('механік поза списком активних не підставляється — ні з запису, ні з підйомника', () => {
    expect(
      pickLineExecutor({
        calendarMechanicId: 'm-petro',
        liftMechanics: [petro],
        workCategoryId: ENGINE,
        activeMechanicIds: ['m-ivan'],
      }),
    ).toBe('');
    expect(
      pickLineExecutor({
        calendarMechanicId: 'm-petro',
        liftMechanics: [petro, ivan],
        workCategoryId: ENGINE,
        activeMechanicIds: ['m-ivan'],
      }),
    ).toBe('m-ivan');
  });
});

describe('slotMechanicId — механік запису наряду в календарі', () => {
  // guards: BR-WO-030
  it('найраніший запис із механіком (сервер віддає від найпізнішого)', () => {
    expect(
      slotMechanicId([
        { startAt: '2026-10-24T09:00:00.000Z', employeeId: 'm-late' },
        { startAt: '2026-10-22T07:00:00.000Z', employeeId: null },
        { startAt: '2026-10-23T09:00:00.000Z', employeeId: 'm-early' },
      ]),
    ).toBe('m-early');
  });

  it('записів немає чи жоден без механіка → null', () => {
    expect(slotMechanicId([])).toBeNull();
    expect(slotMechanicId(undefined)).toBeNull();
    expect(slotMechanicId([{ startAt: '2026-10-22T07:00:00.000Z', employeeId: null }])).toBeNull();
  });
});

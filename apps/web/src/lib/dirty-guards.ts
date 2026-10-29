/**
 * Реєстр незбережених форм для навігації, що йде повз кнопки картки (UX-огляд 2026-10-29).
 *
 * Картка списку живе в адресі (`lib/url-card.ts`), тож «Назад» у браузері закриває її без «×» —
 * і без запиту «Є незбережені зміни», який стоїть у власному закритті картки. Кожна `useDirtyForm`
 * тут реєструється; `useUrlCard`, побачивши «Назад» при брудній формі, тримає картку відкритою й
 * питає тим самим вікном цієї форми (`confirmClose`).
 */
export interface DirtyGuard {
  isDirty: () => boolean;
  /** `true` — зміни можна покинути (або їх немає); `false` — лишитись у формі. */
  confirm: () => Promise<boolean>;
}

const guards: DirtyGuard[] = [];

export function registerDirtyGuard(guard: DirtyGuard): () => void {
  guards.push(guard);
  return () => {
    const i = guards.indexOf(guard);
    if (i >= 0) guards.splice(i, 1);
  };
}

/** Остання зареєстрована форма з незбереженими змінами або `null`. */
export function activeDirtyGuard(): DirtyGuard | null {
  for (let i = guards.length - 1; i >= 0; i--) if (guards[i].isDirty()) return guards[i];
  return null;
}

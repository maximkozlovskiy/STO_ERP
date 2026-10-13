'use client';

import { useEffect, useRef } from 'react';

/**
 * Бокова панель списку тримає КОПІЮ вибраного документа (рядок або довантажену картку), а не
 * посилання на рядок таблиці. Коли документ змінили не зі сторінки — у картці, відновленій із
 * вкладки (`RestoredDocumentModal`), або в картці самої сторінки — список перечитується через
 * інвалідацію ключа, а копія в панелі лишається старою: статус «Чернетка» і дія «Надіслати» для
 * вже надісланого рахунку.
 *
 * Хук стежить за рядком вибраного документа у ЗАВАНТАЖЕНОМУ списку і кличе `onChanged`, щойно
 * цей рядок змінився. Порівнюється рядок із попереднім рядком (а не з копією в панелі): копія
 * довантажена іншим ендпоінтом і має більше полів, тож порівняння з нею ганяло б запит по колу.
 */
export function useSelectedRowRefresh<T extends { id: string }>(
  rows: readonly T[],
  selectedId: string | null | undefined,
  onChanged: (row: T) => void,
): void {
  const seenRef = useRef<{ id: string; signature: string } | null>(null);
  // onChanged зазвичай інлайн-стрілка — у ref, щоб ефект не спрацьовував на кожен рендер.
  const onChangedRef = useRef(onChanged);
  onChangedRef.current = onChanged;

  useEffect(() => {
    if (!selectedId) {
      seenRef.current = null;
      return;
    }
    const row = rows.find(r => r.id === selectedId);
    // Рядка немає на завантаженій сторінці — чекаємо (вибір скидає окремий ефект сторінки).
    if (!row) return;
    const signature = JSON.stringify(row);
    const seen = seenRef.current;
    seenRef.current = { id: selectedId, signature };
    if (seen && seen.id === selectedId && seen.signature !== signature) onChangedRef.current(row);
  }, [rows, selectedId]);
}

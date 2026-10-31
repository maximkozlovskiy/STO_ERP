import { useCallback, useRef, useState, type MutableRefObject } from 'react';

/**
 * Прапорець «іде збереження / перехід» картки документа у двох видах: стан — для `disabled` і
 * спінера, ref — для синхронного guard-а від подвійного кліку (стан оновлюється лише на наступному
 * рендері, ref — одразу; WEB-H3). Сетер пише обидва. Одна реалізація замість пари
 * `useState` + `useRef` + `setXBoth` у кожній картці (CI-гейт нових клонів).
 */
export function useSyncedFlag(): [boolean, MutableRefObject<boolean>, (v: boolean) => void] {
  const [value, setValue] = useState(false);
  const ref = useRef(false);
  const set = useCallback((v: boolean) => {
    ref.current = v;
    setValue(v);
  }, []);
  return [value, ref, set];
}

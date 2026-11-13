/**
 * Позиція спливного вікна (`position: fixed`) біля кнопки чи поля: легенда «?» (`HelpPopover`),
 * пікер дати-часу (`DateTimePickerInput`, TECH-DEBT (б) №74). Одне правило для всіх попапів, які
 * мають уміститися у вікні браузера.
 */

/** Відступ вікна від краю екрана, px (на 390 px вікно не виходить за край). */
const EDGE = 16;
/** Зазор між кнопкою і вікном, px. */
const GAP = 6;
/** Найменша висота вікна під кнопкою, коли місця немає ні знизу, ні зверху, px. */
const MIN_HEIGHT = 120;

export interface PopoverPlacement {
  top: number;
  left: number;
  /** Висота, більша за яку вікно вийшло б за край екрана: вміст понад неї — прокрутка. */
  maxHeight: number;
}

/**
 * Позиція вікна біля кнопки: під нею, а коли знизу не вміщається і зверху місця більше — над нею;
 * по горизонталі — від краю кнопки (`align`), але не ближче ніж EDGE до краю екрана. Висота
 * обмежена місцем з обраного боку (`maxHeight`).
 */
export function placePopover(
  anchor: { top: number; bottom: number; left: number; right: number },
  panel: { width: number; height: number },
  viewport: { width: number; height: number },
  align: 'start' | 'end',
): PopoverPlacement {
  const preferred = align === 'end' ? anchor.right - panel.width : anchor.left;
  const maxLeft = Math.max(EDGE, viewport.width - panel.width - EDGE);
  const left = Math.min(Math.max(preferred, EDGE), maxLeft);
  const below = viewport.height - anchor.bottom - GAP - EDGE;
  const above = anchor.top - GAP - EDGE;
  if (panel.height > below && above > below) {
    const height = Math.min(panel.height, above);
    return { top: anchor.top - GAP - height, left, maxHeight: above };
  }
  return { top: anchor.bottom + GAP, left, maxHeight: Math.max(below, MIN_HEIGHT) };
}

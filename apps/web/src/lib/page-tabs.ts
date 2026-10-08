/**
 * Класи рядка вкладок сторінки-списку: вкладки-розрізи зліва й окрема вкладка праворуч
 * (`ml-auto`). Споживачі — «Склад» (`StockTypeTabs`) і «Банківські платежі».
 *
 * Одне місце правди: раніше ці три рядки були скопійовані в обидві сторінки, і правка
 * фокус-кільця чи hover-у в одній тихо розводила їх.
 */
export const PAGE_TAB_CLASS =
  'flex items-center gap-1.5 px-4 py-2.5 text-[13px] font-medium whitespace-nowrap border-b-2 transition-colors shrink-0 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:rounded-sm';
export const PAGE_TAB_ACTIVE = 'border-primary text-primary';
export const PAGE_TAB_IDLE =
  'border-transparent text-muted-foreground hover:text-foreground hover:border-border';

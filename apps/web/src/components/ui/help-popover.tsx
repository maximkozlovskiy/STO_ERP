'use client';

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useTranslation } from 'react-i18next';
import { CircleHelp } from 'lucide-react';
import { useEscapeLayer } from '@/hooks/useEscapeLayer';
import { cn } from '@/lib/utils';

/** Відступ вікна від краю екрана, px (на 390 px вікно не виходить за край). */
const EDGE = 16;
/** Зазор між кнопкою і вікном, px. */
const GAP = 6;

interface Position {
  top: number;
  left: number;
  maxHeight: number;
}

/**
 * Позиція вікна біля кнопки: під нею, а коли знизу не вміщається і зверху місця більше — над нею;
 * по горизонталі — від краю кнопки (`align`), але не ближче ніж EDGE до краю екрана.
 */
export function placeHelpPanel(
  button: { top: number; bottom: number; left: number; right: number },
  panel: { width: number; height: number },
  viewport: { width: number; height: number },
  align: 'start' | 'end',
): Position {
  const preferred = align === 'end' ? button.right - panel.width : button.left;
  const maxLeft = Math.max(EDGE, viewport.width - panel.width - EDGE);
  const left = Math.min(Math.max(preferred, EDGE), maxLeft);
  const below = viewport.height - button.bottom - GAP - EDGE;
  const above = button.top - GAP - EDGE;
  if (panel.height > below && above > below) {
    const height = Math.min(panel.height, above);
    return { top: button.top - GAP - height, left, maxHeight: above };
  }
  return { top: button.bottom + GAP, left, maxHeight: Math.max(below, 120) };
}

export interface HelpPopoverProps {
  /** Підпис кнопки для читача екрана й підказка під курсором. */
  label: string;
  /** Заголовок вікна (і його `aria-label`). */
  title: string;
  children: ReactNode;
  /** До якого краю кнопки прив'язане вікно: `end` — праве (кнопка праворуч), `start` — ліве. */
  align?: 'start' | 'end';
  /** `md` — кнопка 32 px з рамкою (шапки, тулбари); `sm` — мала іконка біля підпису поля. */
  size?: 'sm' | 'md';
  /** Ширина вікна: `md` — 320 px, `lg` — 416 px (обидві — не ширше екрана мінус 32 px). */
  width?: 'md' | 'lg';
  className?: string;
  testId?: string;
}

/**
 * Кнопка «?» з поясненням (з легенди календаря, BR-CAL-009). Вікно — `role="dialog"`, фокус
 * переходить у нього; закривається повторним кліком, кліком поза ним, виходом фокусу за його межі
 * і Escape — лише воно, бо це верхній шар `useEscapeLayer` (вкладена в модалку «?» модалку не
 * закриває). Фокус після Escape повертається на кнопку. Вікно `fixed` і рахує позицію від кнопки:
 * не обрізається прокруткою предка й не виходить за край екрана (390 px).
 */
export function HelpPopover({
  label,
  title,
  children,
  align = 'end',
  size = 'md',
  width = 'md',
  className,
  testId,
}: HelpPopoverProps) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<Position | null>(null);
  const rootRef = useRef<HTMLSpanElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const titleId = useId();

  const place = useCallback(() => {
    const button = buttonRef.current;
    const panel = panelRef.current;
    if (!button || !panel) return;
    const r = button.getBoundingClientRect();
    setPos(
      placeHelpPanel(
        r,
        { width: panel.offsetWidth, height: panel.scrollHeight },
        { width: document.documentElement.clientWidth, height: window.innerHeight },
        align,
      ),
    );
  }, [align]);

  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    place();
  }, [open, place]);

  useEffect(() => {
    if (!open) return;
    // role="dialog": фокус переходить у вікно, щоб читач екрана одразу прочитав пояснення.
    panelRef.current?.focus({ preventScroll: true });
    const onPointerDown = (e: MouseEvent) => {
      if (e.target instanceof Node && rootRef.current?.contains(e.target)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    window.addEventListener('resize', place);
    // Прокрутка будь-якого предка (capture) зсуває кнопку — вікно йде за нею.
    window.addEventListener('scroll', place, true);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open, place]);

  useEscapeLayer(open, () => {
    setOpen(false);
    // Фокус повертається на кнопку — інакше з клавіатури він губиться на <body>.
    buttonRef.current?.focus();
  });

  return (
    <span
      ref={rootRef}
      className={cn('relative inline-flex', className)}
      data-testid={testId}
      // Фокус пішов за межі (Tab, вкладена модалка) — вікно закривається: інакше воно висить над
      // сторінкою, і Escape, призначений модалці, закрив би й його. `relatedTarget` null (клік по
      // тексту вікна, перемикання вікна ОС) — не вихід.
      onBlur={e => {
        const next = e.relatedTarget;
        if (next instanceof Node && !rootRef.current?.contains(next)) setOpen(false);
      }}
    >
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen(v => !v)}
        aria-label={label}
        title={label}
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        className={cn(
          'inline-flex items-center justify-center transition-colors focus-visible:outline-2 focus-visible:outline-ring',
          size === 'md'
            ? cn(
                'h-8 w-8 shrink-0 rounded-lg border border-border text-muted-foreground hover:bg-secondary hover:text-foreground',
                open ? 'bg-secondary text-foreground' : 'bg-surface',
              )
            : cn(
                'h-5 w-5 rounded-full text-muted-foreground hover:text-foreground',
                open && 'text-foreground',
              ),
        )}
      >
        <CircleHelp className={size === 'md' ? 'h-4 w-4' : 'h-3.5 w-3.5'} aria-hidden="true" />
      </button>
      {open && (
        <div
          ref={panelRef}
          id={panelId}
          role="dialog"
          aria-labelledby={titleId}
          tabIndex={-1}
          style={
            pos
              ? { top: pos.top, left: pos.left, maxHeight: pos.maxHeight }
              : { top: 0, left: 0, visibility: 'hidden' }
          }
          className={cn(
            'fixed z-[60] max-w-[calc(100vw-2rem)] overflow-y-auto rounded-xl border border-border bg-surface p-3 text-left text-[13px] font-normal normal-case tracking-normal text-foreground shadow-lg focus:outline-none',
            width === 'lg' ? 'w-[26rem]' : 'w-80',
          )}
        >
          <p id={titleId} className="mb-2 font-semibold text-foreground">
            {title}
          </p>
          <div className="space-y-3">{children}</div>
        </div>
      )}
    </span>
  );
}

/** Розділ пояснення: малий заголовок і пункти. */
export function HelpSection({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <section className="space-y-1.5">
      {title && <p className="text-[12px] font-medium text-muted-foreground">{title}</p>}
      {children}
    </section>
  );
}

/** Пункт пояснення: термін (жирним) і що він означає; без терміна — звичайний абзац. */
export function HelpItem({ term, children }: { term?: string; children?: ReactNode }) {
  return (
    <p className="leading-snug text-foreground">
      {term && <span className="font-medium">{term}</span>}
      {term && children ? ' — ' : null}
      {children && <span className={term ? 'text-muted-foreground' : undefined}>{children}</span>}
    </p>
  );
}

/** Пункт тексту з каталогу: рядок — абзац, `{ term, text }` — термін і пояснення. */
export type HelpEntry = string | { term: string; text: string };
/** Розділ тексту з каталогу (`help.*` у локалях сторінки). */
export interface HelpBlock {
  title?: string;
  items: HelpEntry[];
}

function isEntry(v: unknown): v is HelpEntry {
  if (typeof v === 'string') return true;
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return typeof o.term === 'string' && typeof o.text === 'string';
}

/**
 * Розділи з каталогу i18n (`t(key, { returnObjects: true })`) → `HelpSection` / `HelpItem`.
 * Каталог не того вигляду (ключ не знайдено — рядок) — нічого не малює, а не падає.
 */
export function HelpBlocks({ blocks }: { blocks: unknown }) {
  if (!Array.isArray(blocks)) return null;
  return (
    <>
      {blocks.map((b: unknown, i) => {
        if (!b || typeof b !== 'object') return null;
        const block = b as Partial<HelpBlock>;
        const items = Array.isArray(block.items) ? block.items.filter(isEntry) : [];
        return (
          <HelpSection key={i} title={typeof block.title === 'string' ? block.title : undefined}>
            {items.map((it, j) =>
              typeof it === 'string' ? (
                <HelpItem key={j}>{it}</HelpItem>
              ) : (
                <HelpItem key={j} term={it.term}>
                  {it.text}
                </HelpItem>
              ),
            )}
          </HelpSection>
        );
      })}
    </>
  );
}

/**
 * «?» з текстом із каталогу сторінки: `<topic>.title` — підпис кнопки й заголовок вікна,
 * `<topic>.blocks` — розділи (`HelpBlock[]`). `values` — підстановки `{{…}}` у текстах.
 */
export function CatalogHelp({
  ns,
  topic,
  values,
  ...rest
}: {
  ns: string;
  topic: string;
  values?: Record<string, string | number>;
} & Omit<HelpPopoverProps, 'label' | 'title' | 'children'>) {
  const { t } = useTranslation(ns);
  const title = t(`${topic}.title`, values);
  return (
    <HelpPopover label={title} title={title} {...rest}>
      <HelpBlocks blocks={t(`${topic}.blocks`, { ...values, returnObjects: true })} />
    </HelpPopover>
  );
}

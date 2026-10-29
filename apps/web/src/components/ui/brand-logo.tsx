/**
 * Бренд OneService у застосунку (брендбук `Images/OneService-brand/OneService-brand/02_app-icon/app/
 * oneservice-app-icon-os-<палітра>.svg`). П'ять файлів палітр відрізняються лише кольором «O»,
 * тож іконка — один інлайн-SVG з акцентом `var(--color-logo-accent)`: його ставить `applyTheme`
 * (і скрипт `<head>`) разом зі шкалою brand — іконка міняє колір із палітрою організації без
 * перезавантаження й без спалаху синього. Шрифт Montserrat — з `next/font` (кореневий layout,
 * `--font-montserrat`): файл брендбука тягне його з Google Fonts, а система працює без інтернету.
 */
const BG = '#202329';
const LIGHT = '#F4F4F5';
const ACCENT = 'var(--color-logo-accent, #3B82F6)';
export const BRAND_FONT = "var(--font-montserrat), Montserrat, 'Segoe UI', Arial, sans-serif";

/** Назва системи — одне місце для шапки, входу, першого запуску й метаданих. */
export const APP_NAME = 'OneService';
/** Підпис бренду під назвою організації (брендбук). */
export const APP_TAGLINE = 'SERVICE PLATFORM';

export function BrandAppIcon({ size = 44, className }: { size?: number; className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 180 180"
      width={size}
      height={size}
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      <rect width="180" height="180" rx="36" fill={BG} />
      <text
        x="90"
        y="123"
        textAnchor="middle"
        fontSize="96"
        letterSpacing="-5"
        fontFamily={BRAND_FONT}
        fontWeight={800}
      >
        <tspan fill={ACCENT}>O</tspan>
        <tspan fill={LIGHT}>S</tspan>
      </text>
    </svg>
  );
}

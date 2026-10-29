import { useId } from 'react';

/**
 * Логотип OneService (Images/Logo/logo-*.svg). П'ять файлів палітр відрізняються лише кольором
 * акценту, тож логотип — один інлайн-SVG з акцентом `var(--color-logo-accent)`: його ставить
 * `applyTheme` (і скрипт `<head>`) разом зі шкалою brand — логотип міняє колір із палітрою
 * організації без перезавантаження й без спалаху синього.
 */
const BG = '#202329';
const LINE = '#F4F4F5';
const ACCENT = 'var(--color-logo-accent, #3B82F6)';
const TOOTH = 'M79 56.5 L79.8 53.3 Q80.2 52 81.5 52 H85.5 Q86.8 52 87.2 53.3 L88 56.5 Z';
const TEETH = [0, 45, 90, 135, 180, 225, 270, 315];

export function BrandLogo({ size = 40, className }: { size?: number; className?: string }) {
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
      <rect width="180" height="180" rx="22" fill={BG} />
      <g transform="translate(6.5 16.5)">
        <g fill="none" strokeLinecap="round">
          <path d="M27 73.5H57M110 73.5H140" stroke={ACCENT} strokeWidth="6" />
          <path d="M34 52V95M133 52V95" stroke={BG} strokeWidth="12" strokeLinecap="butt" />
          <path d="M34 52V95M133 52V95" stroke={ACCENT} strokeWidth="6" />
        </g>
        <g fill={ACCENT}>
          {TEETH.map(deg => (
            <path key={deg} d={TOOTH} transform={`rotate(${deg} 83.5 73.5)`} />
          ))}
          <circle cx="83.5" cy="73.5" r="18" />
        </g>
        <circle cx="83.5" cy="73.5" r="10.5" fill={BG} />
        <circle cx="83.5" cy="73.5" r="4.5" fill={ACCENT} />
        <g fill="none" stroke={LINE} strokeWidth="1.9" strokeLinejoin="round" strokeLinecap="round">
          <g transform="translate(18.88 15.88) scale(1.26)">
            <circle cx="12" cy="7.5" r="3.2" />
            <path d="M6.5 19.5a5.5 5.5 0 0 1 11 0Z" />
            <circle cx="4.8" cy="9.5" r="2.1" />
            <path d="M1.2 18.5a3.6 3.6 0 0 1 4.3-3.5" />
            <circle cx="19.2" cy="9.5" r="2.1" />
            <path d="M22.8 18.5a3.6 3.6 0 0 0-4.3-3.5" />
          </g>
          <g transform="translate(68.38 15.88) scale(1.26)">
            <path d="M2.5 21V9L12 3.5 21.5 9V21" />
            <path d="M6.5 21v-9h11v9" />
            <path d="M6.5 15h11M6.5 18h11" />
          </g>
          <g transform="translate(117.88 15.88) scale(1.26)">
            <rect x="3.5" y="5" width="17" height="15.5" rx="2" />
            <path d="M3.5 10h17M8 3v4M16 3v4" />
            <path d="M9 15l2 2 4-4" />
          </g>
          <g transform="translate(18.88 100.88) scale(1.26)">
            <path d="M12 2.5 20.5 7v10L12 21.5 3.5 17V7Z" />
            <path d="M3.5 7 12 11.5 20.5 7M12 11.5v10M7.75 4.75l8.5 4.5" />
          </g>
          <g transform="translate(68.38 100.88) scale(1.26)">
            <path d="M1.5 5.5h12.5V17H1.5Z" />
            <path d="M14 9h4.5l4 4.5V17H14" />
            <circle cx="6" cy="18" r="2.2" fill={BG} />
            <circle cx="18" cy="18" r="2.2" fill={BG} />
          </g>
          <g transform="translate(117.88 100.88) scale(1.26)">
            <path d="M4 21v-3M9 21v-6M14 21v-9M19 21V9" />
            <path d="M3 13 9 8l3 2.5 7.5-7" />
            <path d="M15.5 3.5h4v4" />
          </g>
        </g>
      </g>
    </svg>
  );
}

/** Назва системи — одне місце для шапки, входу, першого запуску й метаданих. */
export const APP_NAME = 'OneService';

const LIGHT = '#F4F4F5';
const TAGLINE = '#9CA3AF';
const LOGO_FONT = "var(--font-montserrat), Montserrat, 'Segoe UI', Arial, sans-serif";

/**
 * Горизонтальний логотип для темного фону (брендбук `Images/BrandBook/OneService-brand/01_logo/
 * horizontal/oneservice-horizontal-for-dark-bg.svg`): знак із прозорим фоном, «OneService»,
 * «SERVICE PLATFORM». Акцент — колір палітри (`--color-logo-accent`). Шрифт Montserrat — з
 * `next/font` (кореневий layout, `--font-montserrat`): файл брендбука тягне його з Google Fonts, а
 * система працює без інтернету. Маски вирізають отвори (фон прозорий) — id унікальні на екземпляр.
 */
export function BrandLogoHorizontal({
  height = 44,
  className,
}: {
  height?: number;
  className?: string;
}) {
  const uid = useId().replace(/:/g, '');
  const mc = `mc${uid}`;
  const mg = `mg${uid}`;
  const mt = `mt${uid}`;
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 720 200"
      height={height}
      width={(height * 720) / 200}
      className={className}
      role="img"
      aria-label={APP_NAME}
    >
      <svg x="20" y="22" width="178" height="156" viewBox="23 32 134 117">
        <defs>
          <mask id={mc} maskUnits="userSpaceOnUse" x="0" y="0" width="180" height="180">
            <rect width="180" height="180" fill="#fff" />
            <path d="M34 52V95M133 52V95" stroke="#000" strokeWidth="12" />
          </mask>
          <mask id={mg} maskUnits="userSpaceOnUse" x="0" y="0" width="180" height="180">
            <rect width="180" height="180" fill="#fff" />
            <circle cx="83.5" cy="73.5" r="10.5" fill="#000" />
          </mask>
          <mask id={mt} maskUnits="userSpaceOnUse" x="-5" y="-5" width="35" height="35">
            <rect x="-5" y="-5" width="35" height="35" fill="#fff" />
            <circle cx="6" cy="18" r="2.2" fill="#000" />
            <circle cx="18" cy="18" r="2.2" fill="#000" />
          </mask>
        </defs>
        <g transform="translate(6.5 16.5)">
          <g fill="none" stroke={ACCENT} strokeWidth="6" strokeLinecap="round">
            <path d="M27 73.5H57M110 73.5H140" mask={`url(#${mc})`} />
            <path d="M34 52V95M133 52V95" />
          </g>
          <g fill={ACCENT} mask={`url(#${mg})`}>
            {TEETH.map(deg => (
              <path key={deg} d={TOOTH} transform={`rotate(${deg} 83.5 73.5)`} />
            ))}
            <circle cx="83.5" cy="73.5" r="18" />
          </g>
          <circle cx="83.5" cy="73.5" r="4.5" fill={ACCENT} />
          <g
            fill="none"
            stroke={LIGHT}
            strokeWidth="1.9"
            strokeLinejoin="round"
            strokeLinecap="round"
          >
            <g transform="translate(18.88 15.88) scale(1.26)">
              <circle cx="12" cy="7.5" r="3.2" />
              <path d="M6.5 19.5a5.5 5.5 0 0 1 11 0Z" />
              <circle cx="4.8" cy="9.5" r="2.1" />
              <path d="M1.2 18.5a3.6 3.6 0 0 1 4.3-3.5" />
              <circle cx="19.2" cy="9.5" r="2.1" />
              <path d="M22.8 18.5a3.6 3.6 0 0 0-4.3-3.5" />
            </g>
            <g transform="translate(68.38 15.88) scale(1.26)">
              <path d="M2.5 21V9L12 3.5 21.5 9V21" />
              <path d="M6.5 21v-9h11v9" />
              <path d="M6.5 15h11M6.5 18h11" />
            </g>
            <g transform="translate(117.88 15.88) scale(1.26)">
              <rect x="3.5" y="5" width="17" height="15.5" rx="2" />
              <path d="M3.5 10h17M8 3v4M16 3v4" />
              <path d="M9 15l2 2 4-4" />
            </g>
            <g transform="translate(18.88 100.88) scale(1.26)">
              <path d="M12 2.5 20.5 7v10L12 21.5 3.5 17V7Z" />
              <path d="M3.5 7 12 11.5 20.5 7M12 11.5v10M7.75 4.75l8.5 4.5" />
            </g>
            <g transform="translate(68.38 100.88) scale(1.26)">
              <g mask={`url(#${mt})`}>
                <path d="M1.5 5.5h12.5V17H1.5Z" />
                <path d="M14 9h4.5l4 4.5V17H14" />
              </g>
              <circle cx="6" cy="18" r="2.2" />
              <circle cx="18" cy="18" r="2.2" />
            </g>
            <g transform="translate(117.88 100.88) scale(1.26)">
              <path d="M4 21v-3M9 21v-6M14 21v-9M19 21V9" />
              <path d="M3 13 9 8l3 2.5 7.5-7" />
              <path d="M15.5 3.5h4v4" />
            </g>
          </g>
        </g>
      </svg>
      <text x="222" y="112" fontSize="68" fill={LIGHT} fontFamily={LOGO_FONT}>
        <tspan fontWeight={800} fill={ACCENT}>
          One
        </tspan>
        <tspan fontWeight={400}>Service</tspan>
      </text>
      <text
        x="225"
        y="150"
        fontSize="18"
        fill={TAGLINE}
        fontFamily={LOGO_FONT}
        fontWeight={700}
        letterSpacing="4.5"
      >
        SERVICE PLATFORM
      </text>
    </svg>
  );
}

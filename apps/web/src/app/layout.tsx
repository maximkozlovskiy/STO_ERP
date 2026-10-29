import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { GeistSans } from 'geist/font/sans';
import { GeistMono } from 'geist/font/mono';
import localFont from 'next/font/local';
import { ServiceWorkerRegistrar } from '@/components/ServiceWorkerRegistrar';
import { ColorModeProvider } from '@/components/ColorModeProvider';
import { I18nProvider } from '@/components/I18nProvider';
import { QueryProvider } from '@/components/QueryProvider';
import { brandThemeBootScript } from '@/lib/theme';
import { APP_NAME } from '@/components/ui/brand-logo';
import './globals.css';

// Шрифт бренду OneService (брендбук: Montserrat 400/700/800) — варіативний файл латиниці в
// репозиторії (src/fonts, ліцензія OFL поруч). Не next/font/google: та тягне шрифт із Google під час
// збірки — офлайн-збірка й E2E-сервер на ній падали («next/font/google queries have exactly one entry»).
const montserrat = localFont({
  src: '../fonts/montserrat-latin-variable.woff2',
  weight: '400 800',
  variable: '--font-montserrat',
  display: 'swap',
});

export const metadata: Metadata = {
  title: APP_NAME,
  description: 'Система управління автосервісом',
  manifest: '/manifest.json',
  // Іконка OneService «OS» (брендбук, синя); іконка вкладки статична — палітра організації
  // на неї не діє (браузер кешує favicon), у застосунку — BrandAppIcon з кольором палітри.
  icons: { icon: '/logo.svg' },
};

export const viewport: Viewport = {
  themeColor: '#2563eb',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="uk" suppressHydrationWarning>
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var m=localStorage.getItem('sto_color_mode')||'light';document.documentElement.setAttribute('data-color-mode',m);if(m==='dark'||(m==='system'&&window.matchMedia('(prefers-color-scheme: dark)').matches)){document.documentElement.classList.add('dark');}}catch(e){}})();`,
          }}
        />
        {/* Палітра організації з кешу — до першого кадру, інакше після Ctrl+Shift+R мигає синя */}
        <script dangerouslySetInnerHTML={{ __html: brandThemeBootScript() }} />
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var l=localStorage.getItem('sto_locale');if(l==='uk'||l==='en'){document.documentElement.lang=l;}}catch(e){}})();`,
          }}
        />
      </head>
      <body
        className={`${GeistSans.variable} ${GeistMono.variable} ${montserrat.variable} antialiased`}
      >
        <ServiceWorkerRegistrar />
        <QueryProvider>
          <I18nProvider>
            <ColorModeProvider>{children}</ColorModeProvider>
          </I18nProvider>
        </QueryProvider>
      </body>
    </html>
  );
}

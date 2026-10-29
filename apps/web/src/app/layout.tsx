import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { GeistSans } from 'geist/font/sans';
import { GeistMono } from 'geist/font/mono';
import { Montserrat } from 'next/font/google';
import { ServiceWorkerRegistrar } from '@/components/ServiceWorkerRegistrar';
import { ColorModeProvider } from '@/components/ColorModeProvider';
import { I18nProvider } from '@/components/I18nProvider';
import { QueryProvider } from '@/components/QueryProvider';
import { brandThemeBootScript } from '@/lib/theme';
import { APP_NAME } from '@/components/ui/brand-logo';
import './globals.css';

// Шрифт логотипу OneService (брендбук: Montserrat 400/700/800). next/font завантажує його під час
// збірки й роздає локально — без запитів до Google Fonts, система працює офлайн.
const montserrat = Montserrat({
  subsets: ['latin'],
  weight: ['400', '700', '800'],
  variable: '--font-montserrat',
  display: 'swap',
});

export const metadata: Metadata = {
  title: APP_NAME,
  description: 'Система управління автосервісом',
  manifest: '/manifest.json',
  // Логотип OneService (Images/Logo/logo-blue.svg); іконка вкладки статична — палітра організації
  // на неї не діє (браузер кешує favicon), у застосунку логотип — BrandLogo з кольором палітри.
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

import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { GeistSans } from 'geist/font/sans';
import { GeistMono } from 'geist/font/mono';
import { ServiceWorkerRegistrar } from '@/components/ServiceWorkerRegistrar';
import { ColorModeProvider } from '@/components/ColorModeProvider';
import { QueryProvider } from '@/components/QueryProvider';
import './globals.css';

export const metadata: Metadata = {
  title: 'STO ERP',
  description: 'Система управління автосервісом',
  manifest: '/manifest.json',
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
      </head>
      <body className={`${GeistSans.variable} ${GeistMono.variable} antialiased`}>
        <ServiceWorkerRegistrar />
        <QueryProvider>
          <ColorModeProvider>{children}</ColorModeProvider>
        </QueryProvider>
      </body>
    </html>
  );
}

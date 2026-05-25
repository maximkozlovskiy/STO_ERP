import type { Metadata, Viewport } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import { AuthProvider } from '@/lib/auth';
import { TopShell } from '@/components/TopShell';
import { ServiceWorkerRegistrar } from '@/components/ServiceWorkerRegistrar';
import { ColorModeProvider } from '@/components/ColorModeProvider';
import './globals.css';

const geistSans = Geist({
  variable: '--font-geist-sans',
  subsets: ['latin'],
});

const geistMono = Geist_Mono({
  variable: '--font-geist-mono',
  subsets: ['latin'],
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'STO ERP',
  description: 'Система управління автосервісом',
  manifest: '/manifest.json',
};

export const viewport: Viewport = {
  themeColor: '#2563eb',
};

export default function RootLayout({
  children,
}: {
  children: import('react').ReactNode;
}) {
  return (
    <html lang="uk" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: `(function(){try{var m=localStorage.getItem('sto_color_mode')||'light';document.documentElement.setAttribute('data-color-mode',m);if(m==='dark'||(m==='system'&&window.matchMedia('(prefers-color-scheme: dark)').matches)){document.documentElement.classList.add('dark');}}catch(e){}})();` }} />
      </head>
      <body className={`${geistSans.variable} ${geistMono.variable} antialiased`}>
        <ServiceWorkerRegistrar />
        <ColorModeProvider>
          <AuthProvider>
            <TopShell>{children}</TopShell>
          </AuthProvider>
        </ColorModeProvider>
      </body>
    </html>
  );
}

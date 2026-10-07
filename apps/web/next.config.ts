import type { NextConfig } from 'next';

const isDev = process.env.NODE_ENV === 'development';

const nextConfig: NextConfig = {
  // Static export for production installer; dev server runs normally
  ...(isDev ? {} : { output: 'export' }),
  // Playwright піднімає ВЛАСНИЙ екземпляр dev-сервера поруч зі звичайним (:3002 проти :3001).
  // Два `next dev` в одній теці не можуть ділити `.next`, тож E2E-екземпляр отримує свою.
  ...(process.env.NEXT_DIST_DIR ? { distDir: process.env.NEXT_DIST_DIR } : {}),
  trailingSlash: true,
  images: { unoptimized: true },
  transpilePackages: ['@sto/shared', '@sto/ui'],
  env: {
    NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3000',
  },
};

export default nextConfig;

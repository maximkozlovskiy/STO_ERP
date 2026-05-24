import type { NextConfig } from 'next';

const isDev = process.env.NODE_ENV === 'development';

const nextConfig: NextConfig = {
  // Static export for production installer; dev server runs normally
  ...(isDev ? {} : { output: 'export' }),
  trailingSlash: true,
  images: { unoptimized: true },
  transpilePackages: ['@sto/shared', '@sto/ui'],
  env: {
    NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3000',
  },
};

export default nextConfig;

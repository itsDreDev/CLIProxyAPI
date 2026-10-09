import type { NextConfig } from 'next';

const config: NextConfig = {
  output: 'export',
  basePath: '/subscriptions',
  trailingSlash: true,
  poweredByHeader: false,
  env: {
    NEXT_PUBLIC_API_ORIGIN: process.env.NODE_ENV === 'development'
      ? (process.env.PROXY_API_ORIGIN || 'http://127.0.0.1:8317')
      : '',
  },
  images: { unoptimized: true },
  // Keep API calls on the Next dev origin without shipping a second backend.
  ...(process.env.NODE_ENV === 'development' ? {
    async rewrites() {
      return [{ source: '/v8/management/:path*', destination: `${process.env.PROXY_API_ORIGIN || 'http://127.0.0.1:8317'}/v8/management/:path*`, basePath: false }];
    },
  } : {}),
};

export default config;

import type { NextConfig } from 'next';
const backend = process.env.BACKEND_URL;
const config: NextConfig = {
  async rewrites() { return backend ? [{ source: '/api/:path*', destination: `${backend.replace(/\/$/, '')}/api/:path*` }] : []; },
};
export default config;

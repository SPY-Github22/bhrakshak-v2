/** @type {import('next').NextConfig} */
const nextConfig = {
  // Double-mount in dev StrictMode re-creates the MapLibre instance while
  // the worker is still booting — keep it off for map stability.
  reactStrictMode: false,
  typescript: {
    // The demo API routes are typed loosely on purpose (contract parity with
    // FastAPI); `npm run typecheck` is the strict gate.
    ignoreBuildErrors: true,
  },
};

export default nextConfig;

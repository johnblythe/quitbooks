import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  cacheComponents: true,
  partialPrefetching: true,
  // PGlite (local-dev database) ships WASM; load it from node_modules instead of bundling it.
  serverExternalPackages: ["@electric-sql/pglite"],
  experimental: {
    // CSV text is passed as a server action argument. Default is 1 MB; Vercel's request cap is 4.5 MB.
    // The import action enforces a tighter 3.5 MB byte limit itself.
    serverActions: { bodySizeLimit: "4mb" },
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "same-origin" },
          { key: "X-Content-Type-Options", value: "nosniff" },
        ],
      },
    ];
  },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;

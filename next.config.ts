import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Keep the SQLite builtin and the Anthropic SDK out of the bundle; they run server-side only.
  serverExternalPackages: ["@anthropic-ai/sdk"],
  poweredByHeader: false,
};

export default nextConfig;

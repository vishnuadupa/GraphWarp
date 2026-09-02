import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Keep Node.js-only packages out of the Edge runtime bundle.
  serverExternalPackages: ['neo4j-driver', 'openai'],
};

export default nextConfig;

import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Keep Node.js-only packages out of the Edge runtime bundle.
  // pdf-parse and papaparse use fs/path/Buffer which aren't available
  // in the Edge runtime (middleware). Listing them here forces Next.js
  // to treat them as external server-only packages.
  serverExternalPackages: ['pdf-parse', 'papaparse', 'mammoth', 'neo4j-driver', 'openai'],
};

export default nextConfig;

import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  allowedDevOrigins: ["127.0.0.1"],
  outputFileTracingIncludes: {
    "/api/documents/**": ["./src/features/documents/.generated/docx-conversion-worker.cjs"],
  },
  turbopack: {
    root: process.cwd(),
  },
};

export default nextConfig;

import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The report prompt is read from disk at runtime, which file tracing can't see on its own.
  outputFileTracingIncludes: {
    "/api/report": ["./prompts/**/*"],
  },
};

export default nextConfig;

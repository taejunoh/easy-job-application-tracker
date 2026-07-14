import type { NextConfig } from "next";

import { validateServerEnv } from "./src/lib/server-env-core";

validateServerEnv(process.env, process.env.NODE_ENV);

const nextConfig: NextConfig = {
  outputFileTracingIncludes: {
    "/api/parse-resume": [
      "./src/lib/resume/pdf-parse-worker.mjs",
      "./node_modules/pdfjs-dist/package.json",
      "./node_modules/pdfjs-dist/legacy/build/pdf.mjs",
      "./node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs",
      "./node_modules/@napi-rs/canvas*/**/*",
    ],
  },
};

export default nextConfig;

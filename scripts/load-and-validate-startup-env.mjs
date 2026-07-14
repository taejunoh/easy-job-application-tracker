import nextEnv from "@next/env";

import serverEnvCore from "../src/lib/server-env-core.js";

const { loadEnvConfig } = nextEnv;

export function loadAndValidateStartupEnv(isDevelopment) {
  loadEnvConfig(process.cwd(), isDevelopment);
  serverEnvCore.validateServerEnv(
    process.env,
    isDevelopment ? "development" : "production",
  );
}

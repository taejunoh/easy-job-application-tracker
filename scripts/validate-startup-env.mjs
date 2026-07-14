import nextEnv from "@next/env";

import serverEnvCore from "../src/lib/server-env-core.js";

const { loadEnvConfig } = nextEnv;
const isDevelopment = process.argv[2] === "dev";
loadEnvConfig(process.cwd(), isDevelopment);
serverEnvCore.validateServerEnv(
  process.env,
  isDevelopment ? "development" : "production",
);

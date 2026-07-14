import "server-only";

import { parseServerEnv } from "./server-env-core";

export { parseServerEnv } from "./server-env-core";
export type ServerEnv = ReturnType<typeof parseServerEnv>;
export type ServerEnvSource = Parameters<typeof parseServerEnv>[0];
export type ServerNodeEnv = Parameters<typeof parseServerEnv>[1];

let cachedServerEnv: ServerEnv | undefined;

export function getServerEnv(): ServerEnv {
  cachedServerEnv ??= parseServerEnv(process.env, process.env.NODE_ENV);
  return cachedServerEnv;
}

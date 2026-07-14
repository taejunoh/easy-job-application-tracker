import serverEnvCore from "../src/lib/server-env-core.js";

serverEnvCore.validateServerEnv(process.env, process.env.NODE_ENV);

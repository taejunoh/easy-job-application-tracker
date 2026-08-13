import "server-only";

import { getServerEnv } from "../server-env";
import { extensionCredentialStore } from "./extension-installation-store";
import { createExtensionInstallationService } from "./extension-installations";

export function configuredExtensionInstallationService() {
  const config = getServerEnv();
  return createExtensionInstallationService({
    encryptionSecret: config.encryptionSecret,
    allowedOrigins: config.corsAllowedOrigins,
    store: extensionCredentialStore,
  });
}

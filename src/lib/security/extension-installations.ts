import "server-only";

import type { UUID } from "node:crypto";

import {
  createInstallationCredential,
  createPairingCredential,
  digestPairingSecret,
  parsePairingCode,
  verifyCredentialDigest,
} from "./extension-credentials";

export const PAIRING_GRANT_LIFETIME_MS = 10 * 60 * 1000;
export const INSTALLATION_LIFETIME_MS = 90 * 24 * 60 * 60 * 1000;

export type PairingGrantRecord = {
  id: string;
  origin: string;
  codeDigest: string;
  expiresAt: Date;
  consumedAt: Date | null;
  installationId: string | null;
  createdAt: Date;
};

export type PersistedInstallation = {
  id: string;
  origin: string;
  tokenDigest: string;
  expiresAt: Date;
  revokedAt: Date | null;
  lastUsedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type InstallationSummary = Omit<
  PersistedInstallation,
  "tokenDigest" | "updatedAt"
>;

export type ExtensionCredentialStore = Readonly<{
  createPairingGrant(grant: PairingGrantRecord): Promise<void>;
  findPairingGrant(id: string): Promise<PairingGrantRecord | null>;
  consumePairingGrant(input: Readonly<{
    grantId: string;
    expectedDigest: string;
    consumedAt: Date;
    installation: PersistedInstallation;
  }>): Promise<boolean>;
  revoke(id: string, revokedAt: Date): Promise<boolean>;
  list(): Promise<readonly PersistedInstallation[]>;
}>;

type ServiceOptions = Readonly<{
  encryptionSecret: string;
  allowedOrigins?: readonly string[];
  store: ExtensionCredentialStore;
  now?: () => number;
  randomUUID?: () => UUID | string;
  randomBytes?: (size: number) => Buffer;
}>;

export function createExtensionInstallationService(options: ServiceOptions) {
  const now = options.now ?? Date.now;
  const credentialOptions = (origin: string) => ({
    encryptionSecret: options.encryptionSecret,
    origin,
    randomUUID: options.randomUUID,
    randomBytes: options.randomBytes,
  });

  function allowedOrigin(origin: string): boolean {
    return (
      /^chrome-extension:\/\/[a-p]{32}$/u.test(origin) &&
      (options.allowedOrigins === undefined ||
        options.allowedOrigins.includes(origin))
    );
  }

  async function validPairingGrant(code: unknown, origin: string) {
    if (!allowedOrigin(origin)) return null;
    const parsed = parsePairingCode(code);
    if (parsed === null) return null;
    const grant = await options.store.findPairingGrant(parsed.selector);
    const observedAt = new Date(now());
    if (
      grant === null ||
      grant.origin !== origin ||
      grant.consumedAt !== null ||
      grant.expiresAt.getTime() <= observedAt.getTime()
    ) {
      return null;
    }
    const digest = digestPairingSecret(
      parsed.selector,
      parsed.secret,
      origin,
      options.encryptionSecret,
    );
    return verifyCredentialDigest(grant.codeDigest, digest)
      ? { grant, observedAt }
      : null;
  }

  return Object.freeze({
    async createPairingGrant(origin: string) {
      if (!allowedOrigin(origin)) throw new TypeError("Invalid extension origin");
      const issuedAt = new Date(now());
      const credential = createPairingCredential(credentialOptions(origin));
      const expiresAt = new Date(
        issuedAt.getTime() + PAIRING_GRANT_LIFETIME_MS,
      );
      await options.store.createPairingGrant({
        id: credential.selector,
        origin,
        codeDigest: credential.digest,
        expiresAt,
        consumedAt: null,
        installationId: null,
        createdAt: issuedAt,
      });
      return Object.freeze({
        id: credential.selector,
        code: credential.code,
        origin,
        expiresAt,
      });
    },

    async validatePairingCode(code: unknown, origin: string) {
      return (await validPairingGrant(code, origin)) !== null;
    },

    async exchangePairingCode(code: unknown, origin: string) {
      const validGrant = await validPairingGrant(code, origin);
      if (validGrant === null) return null;
      const { grant, observedAt } = validGrant;

      const credential = createInstallationCredential(
        credentialOptions(origin),
      );
      const expiresAt = new Date(
        observedAt.getTime() + INSTALLATION_LIFETIME_MS,
      );
      const installation: PersistedInstallation = {
        id: credential.selector,
        origin,
        tokenDigest: credential.digest,
        expiresAt,
        revokedAt: null,
        lastUsedAt: null,
        createdAt: observedAt,
        updatedAt: observedAt,
      };
      const consumed = await options.store.consumePairingGrant({
        grantId: grant.id,
        expectedDigest: grant.codeDigest,
        consumedAt: observedAt,
        installation,
      });
      if (!consumed) return null;
      return Object.freeze({
        installationId: installation.id,
        token: credential.token,
        expiresAt,
      });
    },

    revoke(id: string): Promise<boolean> {
      return options.store.revoke(id, new Date(now()));
    },

    async list(): Promise<readonly InstallationSummary[]> {
      const rows = await options.store.list();
      return rows.map((row) =>
        Object.freeze({
          id: row.id,
          origin: row.origin,
          expiresAt: row.expiresAt,
          revokedAt: row.revokedAt,
          lastUsedAt: row.lastUsedAt,
          createdAt: row.createdAt,
        }),
      );
    },
  });
}

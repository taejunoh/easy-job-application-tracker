import {
  createExtensionInstallationService,
  type ExtensionCredentialStore,
  type PairingGrantRecord,
  type PersistedInstallation,
} from "@/lib/security/extension-installations";

const NOW = Date.UTC(2026, 7, 13, 12, 0, 0);
const ORIGIN = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
const OTHER_ORIGIN = "chrome-extension://ponmlkjihgfedcbaponmlkjihgfedcba";
const SECRET = "encryption-secret-" + "e".repeat(32);

describe("extension installation lifecycle", () => {
  it("stores only a digest and exchanges a pairing code exactly once", async () => {
    const store = memoryStore();
    const service = serviceFor(store);

    const grant = await service.createPairingGrant(ORIGIN);
    expect(grant.code).toMatch(/^jt_pair_v1\./u);
    expect(store.grants.get(grant.id)).toMatchObject({
      origin: ORIGIN,
      consumedAt: null,
    });
    expect(JSON.stringify(store.grants.get(grant.id))).not.toContain(grant.code);

    const installed = await service.exchangePairingCode(grant.code, ORIGIN);
    expect(installed?.token).toMatch(/^jt_install_v1\./u);
    expect(installed?.installationId).not.toBe(grant.id);
    expect(await service.exchangePairingCode(grant.code, ORIGIN)).toBeNull();
    expect(JSON.stringify([...store.installations.values()])).not.toContain(
      installed?.token,
    );
  });

  it("rejects expired, malformed, and wrong-origin grants without consuming", async () => {
    const store = memoryStore();
    const service = serviceFor(store);
    const grant = await service.createPairingGrant(ORIGIN);

    expect(await service.exchangePairingCode("bad", ORIGIN)).toBeNull();
    expect(await service.exchangePairingCode(grant.code, OTHER_ORIGIN)).toBeNull();
    expect(store.grants.get(grant.id)?.consumedAt).toBeNull();

    const expiredService = serviceFor(store, NOW + 10 * 60 * 1000);
    expect(await expiredService.exchangePairingCode(grant.code, ORIGIN)).toBeNull();
    expect(store.grants.get(grant.id)?.consumedAt).toBeNull();
  });

  it("validates a usable pairing code without consuming or installing it", async () => {
    const store = memoryStore();
    const service = serviceFor(store);
    const grant = await service.createPairingGrant(ORIGIN);

    await expect(service.validatePairingCode(grant.code, ORIGIN)).resolves.toBe(
      true,
    );
    await expect(service.validatePairingCode("bad", ORIGIN)).resolves.toBe(false);
    await expect(
      service.validatePairingCode(grant.code, OTHER_ORIGIN),
    ).resolves.toBe(false);
    await expect(
      serviceFor(store, NOW + 10 * 60 * 1000).validatePairingCode(
        grant.code,
        ORIGIN,
      ),
    ).resolves.toBe(false);

    const consumed = await service.createPairingGrant(ORIGIN);
    store.grants.get(consumed.id)!.consumedAt = new Date(NOW);
    await expect(
      service.validatePairingCode(consumed.code, ORIGIN),
    ).resolves.toBe(false);

    expect(store.grants.get(grant.id)?.consumedAt).toBeNull();
    expect(store.installations.size).toBe(0);
  });

  it("creates distinct installations and revokes only the selected one", async () => {
    const store = memoryStore();
    const service = serviceFor(store);
    const firstGrant = await service.createPairingGrant(ORIGIN);
    const secondGrant = await service.createPairingGrant(OTHER_ORIGIN);
    const first = await service.exchangePairingCode(firstGrant.code, ORIGIN);
    const second = await service.exchangePairingCode(
      secondGrant.code,
      OTHER_ORIGIN,
    );

    expect(first?.installationId).not.toBe(second?.installationId);
    expect(first?.token).not.toBe(second?.token);
    expect(await service.revoke(first!.installationId)).toBe(true);
    expect(store.installations.get(first!.installationId)?.revokedAt).toEqual(
      new Date(NOW),
    );
    expect(store.installations.get(second!.installationId)?.revokedAt).toBeNull();
  });

  it("returns a sanitized management list without token digests", async () => {
    const store = memoryStore();
    const service = serviceFor(store);
    const grant = await service.createPairingGrant(ORIGIN);
    await service.exchangePairingCode(grant.code, ORIGIN);

    const installations = await service.list();
    expect(installations).toHaveLength(1);
    expect(installations[0]).toEqual({
      id: expect.any(String),
      origin: ORIGIN,
      createdAt: new Date(NOW),
      expiresAt: new Date(NOW + 90 * 24 * 60 * 60 * 1000),
      lastUsedAt: null,
      revokedAt: null,
    });
    expect(JSON.stringify(installations)).not.toContain("Digest");
  });
});

function serviceFor(store: ReturnType<typeof memoryStore>, now = NOW) {
  let sequence = 0;
  const selectors = [
    "018f9f72-f2e9-7c29-a6fc-001122334455",
    "018f9f72-f2e9-7c29-a6fc-001122334456",
    "018f9f72-f2e9-7c29-a6fc-001122334457",
    "018f9f72-f2e9-7c29-a6fc-001122334458",
  ];
  return createExtensionInstallationService({
    encryptionSecret: SECRET,
    store,
    now: () => now,
    randomUUID: () => selectors[sequence++]!,
    randomBytes: () => Buffer.alloc(32, sequence),
  });
}

function memoryStore(): ExtensionCredentialStore & {
  grants: Map<string, PairingGrantRecord>;
  installations: Map<string, PersistedInstallation>;
} {
  const grants = new Map<string, PairingGrantRecord>();
  const installations = new Map<string, PersistedInstallation>();
  return {
    grants,
    installations,
    async createPairingGrant(grant) {
      grants.set(grant.id, { ...grant });
    },
    async findPairingGrant(id) {
      return grants.get(id) ?? null;
    },
    async consumePairingGrant(input) {
      const grant = grants.get(input.grantId);
      if (
        !grant ||
        grant.consumedAt !== null ||
        grant.codeDigest !== input.expectedDigest ||
        grant.expiresAt.getTime() <= input.consumedAt.getTime()
      ) {
        return false;
      }
      grant.consumedAt = input.consumedAt;
      grant.installationId = input.installation.id;
      installations.set(input.installation.id, { ...input.installation });
      return true;
    },
    async revoke(id, revokedAt) {
      const installation = installations.get(id);
      if (!installation || installation.revokedAt !== null) return false;
      installation.revokedAt = revokedAt;
      return true;
    },
    async list() {
      return [...installations.values()];
    },
  };
}

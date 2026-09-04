import {
  createInstallationCredential,
  createPairingCredential,
} from "@/lib/security/extension-credentials";
import {
  SESSION_COOKIE_NAME,
  createSessionToken,
} from "@/lib/security/auth";

jest.mock("@/lib/server-env", () => {
  const actual = jest.requireActual<typeof import("@/lib/server-env")>(
    "@/lib/server-env",
  );
  const config = actual.parseServerEnv(
    {
      DATABASE_URL: "postgresql://user:password@db.example.com:5432/jobtracker",
      ENCRYPTION_SECRET: "encryption-secret-" + "e".repeat(32),
      APP_ACCESS_TOKEN: "access-token-" + "a".repeat(32),
      APP_BASE_URL: "https://jobs.example.com",
      CORS_ALLOWED_ORIGINS:
        "https://jobs.example.com,chrome-extension://abcdefghijklmnopabcdefghijklmnop",
      APPLICATION_WRITES_ENABLED: "1",
    },
    "production",
  );
  return { ...actual, getServerEnv: jest.fn(() => config) };
});

jest.mock("@/lib/security/extension-installation-store", () => ({
  extensionCredentialStore: {
    createPairingGrant: jest.fn(),
    findPairingGrant: jest.fn(),
    consumePairingGrant: jest.fn(),
    revoke: jest.fn(),
    list: jest.fn(),
  },
  extensionInstallationAuthenticationStore: {
    findForAuthentication: jest.fn(),
    touch: jest.fn(),
  },
}));

jest.mock("@/lib/prisma", () => ({
  prisma: {
    settings: { findFirst: jest.fn() },
  },
}));

import * as pairRoute from "@/app/api/extension/pair/route";
import * as pairingRoute from "@/app/api/extension/pairing/route";
import * as installationsRoute from "@/app/api/extension/installations/route";
import * as installationRoute from "@/app/api/extension/installations/[id]/route";
import * as profileRoute from "@/app/api/extension/profile/route";
import * as revokeRoute from "@/app/api/extension/revoke/route";
import * as verifyRoute from "@/app/api/auth/verify/route";
import { prisma } from "@/lib/prisma";
import { getServerEnv } from "@/lib/server-env";
import { configuredExtensionInstallationService } from "@/lib/security/configured-extension-installations";
import {
  extensionCredentialStore,
  extensionInstallationAuthenticationStore,
} from "@/lib/security/extension-installation-store";

const APP_ORIGIN = "https://jobs.example.com";
const EXTENSION_ORIGIN =
  "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
const SECRET = "encryption-secret-" + "e".repeat(32);
const SESSION_COOKIE = `${SESSION_COOKIE_NAME}=${createSessionToken()}`;
const BASE_ENV = getServerEnv();
const INSTALLATION = createInstallationCredential({
  encryptionSecret: SECRET,
  origin: EXTENSION_ORIGIN,
  randomUUID: () => "018f9f72-f2e9-7c29-a6fc-001122334499",
  randomBytes: () => Buffer.alloc(32, 9),
});

describe("extension installation API", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.mocked(getServerEnv).mockReturnValue(BASE_ENV);
    jest.mocked(extensionCredentialStore.list).mockResolvedValue([]);
    jest.mocked(extensionCredentialStore.revoke).mockResolvedValue(true);
    jest.mocked(extensionCredentialStore.consumePairingGrant).mockResolvedValue(
      true,
    );
    jest
      .mocked(extensionInstallationAuthenticationStore.findForAuthentication)
      .mockResolvedValue({
        id: INSTALLATION.selector,
        origin: EXTENSION_ORIGIN,
        tokenDigest: INSTALLATION.digest,
        expiresAt: new Date(Date.now() + 60_000),
        revokedAt: null,
      });
    jest
      .mocked(extensionInstallationAuthenticationStore.touch)
      .mockResolvedValue(true);
    jest.mocked(prisma.settings.findFirst).mockResolvedValue({
      id: "singleton",
      llmProvider: "openai",
      apiKey: "secret",
      linkedinUrl: "https://linkedin.example/profile",
      githubUrl: "https://github.example/profile",
      resumeText: "private resume contents",
    });
  });

  it("lets only a web session create a configured-origin one-time code", async () => {
    const response = await pairingRoute.POST(
      jsonRequest(`${APP_ORIGIN}/api/extension/pairing`, APP_ORIGIN, {
        origin: EXTENSION_ORIGIN,
      }, { Cookie: SESSION_COOKIE }),
    );

    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.code).toMatch(/^jt_pair_v1\./u);
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    expect(extensionCredentialStore.createPairingGrant).toHaveBeenCalledWith(
      expect.objectContaining({
        origin: EXTENSION_ORIGIN,
        codeDigest: expect.stringMatching(/^[0-9a-f]{64}$/u),
      }),
    );
    expect(JSON.stringify(
      jest.mocked(extensionCredentialStore.createPairingGrant).mock.calls,
    ))
      .not.toContain(body.code);

    const rootResponse = await pairingRoute.POST(
      jsonRequest(`${APP_ORIGIN}/api/extension/pairing`, APP_ORIGIN, {
        origin: EXTENSION_ORIGIN,
      }, { Authorization: `Bearer ${"access-token-" + "a".repeat(32)}` }),
    );
    expect(rootResponse.status).toBe(403);
  });

  it("exchanges once only from the grant's exact configured origin", async () => {
    const pairing = createPairingCredential({
      encryptionSecret: SECRET,
      origin: EXTENSION_ORIGIN,
      randomUUID: () => "018f9f72-f2e9-7c29-a6fc-001122334488",
      randomBytes: () => Buffer.alloc(32, 8),
    });
    jest.mocked(extensionCredentialStore.findPairingGrant).mockResolvedValue({
      id: pairing.selector,
      origin: EXTENSION_ORIGIN,
      codeDigest: pairing.digest,
      expiresAt: new Date(Date.now() + 60_000),
      consumedAt: null,
      installationId: null,
      createdAt: new Date(),
    });

    const response = await pairRoute.POST(
      jsonRequest(`${APP_ORIGIN}/api/extension/pair`, EXTENSION_ORIGIN, {
        code: pairing.code,
      }),
    );

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({
      installationId: expect.any(String),
      token: expect.stringMatching(/^jt_install_v1\./u),
      expiresAt: expect.any(String),
    });
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
      EXTENSION_ORIGIN,
    );
    expect(response.headers.get("Cache-Control")).toContain("no-store");
  });

  it("verifies, reads only minimal profile, and self-revokes its own id", async () => {
    const headers = {
      Origin: EXTENSION_ORIGIN,
      Authorization: `Bearer ${INSTALLATION.token}`,
    };
    const verify = await verifyRoute.POST(
      new Request(`${APP_ORIGIN}/api/auth/verify`, { method: "POST", headers }),
    );
    expect(verify.status).toBe(200);
    await expect(verify.json()).resolves.toEqual({
      authenticated: true,
      installationId: INSTALLATION.selector,
    });

    const profile = await profileRoute.GET(
      new Request(`${APP_ORIGIN}/api/extension/profile`, { headers }),
    );
    expect(profile.status).toBe(200);
    const profileBody = await profile.json();
    expect(profileBody).toEqual({
      linkedinUrl: "https://linkedin.example/profile",
      githubUrl: "https://github.example/profile",
      hasResume: true,
    });
    expect(JSON.stringify(profileBody)).not.toContain("private resume contents");

    const revoked = await revokeRoute.POST(
      new Request(`${APP_ORIGIN}/api/extension/revoke`, {
        method: "POST",
        headers,
      }),
    );
    expect(revoked.status).toBe(200);
    expect(extensionCredentialStore.revoke).toHaveBeenCalledWith(
      INSTALLATION.selector,
      expect.any(Date),
    );
  });

  it("lists and revokes installations only through a web session", async () => {
    jest.mocked(extensionCredentialStore.list).mockResolvedValue([
      {
        id: INSTALLATION.selector,
        origin: EXTENSION_ORIGIN,
        tokenDigest: INSTALLATION.digest,
        expiresAt: new Date("2026-11-11T00:00:00.000Z"),
        revokedAt: null,
        lastUsedAt: null,
        createdAt: new Date("2026-08-13T00:00:00.000Z"),
        updatedAt: new Date("2026-08-13T00:00:00.000Z"),
      },
    ]);
    const headers = { Origin: APP_ORIGIN, Cookie: SESSION_COOKIE };
    const listed = await installationsRoute.GET(
      new Request(`${APP_ORIGIN}/api/extension/installations`, { headers }),
    );
    expect(listed.status).toBe(200);
    const listBody = await listed.json();
    expect(listBody.configuredOrigins).toEqual([EXTENSION_ORIGIN]);
    expect(JSON.stringify(listBody)).not.toContain(INSTALLATION.digest);

    const revoked = await installationRoute.DELETE(
      new Request(
        `${APP_ORIGIN}/api/extension/installations/${INSTALLATION.selector}`,
        { method: "DELETE", headers },
      ),
      { params: Promise.resolve({ id: INSTALLATION.selector }) },
    );
    expect(revoked.status).toBe(200);
    expect(extensionCredentialStore.revoke).toHaveBeenCalledWith(
      INSTALLATION.selector,
      expect.any(Date),
    );
  });

  describe("when application writes are stopped", () => {
    beforeEach(() => {
      jest.mocked(getServerEnv).mockReturnValue({
        ...BASE_ENV,
        applicationWritesEnabled: false,
      });
    });

    it("stops each valid extension credential mutation without persisting it", async () => {
      const pairing = pairingFixture();
      jest.mocked(extensionCredentialStore.findPairingGrant).mockResolvedValue(
        pairing.grant,
      );

      const pairingResponse = await pairingRoute.POST(
        jsonRequest(`${APP_ORIGIN}/api/extension/pairing`, APP_ORIGIN, {
          origin: EXTENSION_ORIGIN,
        }, { Cookie: SESSION_COOKIE }),
      );
      await expectStopped(pairingResponse, APP_ORIGIN);
      expect(extensionCredentialStore.createPairingGrant).not.toHaveBeenCalled();

      const pairResponse = await pairRoute.POST(
        jsonRequest(`${APP_ORIGIN}/api/extension/pair`, EXTENSION_ORIGIN, {
          code: pairing.credential.code,
        }),
      );
      await expectStopped(pairResponse, EXTENSION_ORIGIN);
      expect(extensionCredentialStore.consumePairingGrant).not.toHaveBeenCalled();
      expect(await configuredExtensionInstallationService().validatePairingCode(
        pairing.credential.code,
        EXTENSION_ORIGIN,
      )).toBe(true);

      const revokeResponse = await revokeRoute.POST(
        new Request(`${APP_ORIGIN}/api/extension/revoke`, {
          method: "POST",
          headers: {
            Origin: EXTENSION_ORIGIN,
            Authorization: `Bearer ${INSTALLATION.token}`,
          },
        }),
      );
      await expectStopped(revokeResponse, EXTENSION_ORIGIN);

      const deleteResponse = await installationRoute.DELETE(
        new Request(
          `${APP_ORIGIN}/api/extension/installations/${INSTALLATION.selector}`,
          {
            method: "DELETE",
            headers: { Origin: APP_ORIGIN, Cookie: SESSION_COOKIE },
          },
        ),
        { params: Promise.resolve({ id: INSTALLATION.selector }) },
      );
      await expectStopped(deleteResponse, APP_ORIGIN);
      expect(extensionCredentialStore.revoke).not.toHaveBeenCalled();
      expect(extensionInstallationAuthenticationStore.touch).not.toHaveBeenCalled();
    });

    it("keeps unauthenticated, invalid-code, and rejected-origin requests at 401 or 403", async () => {
      const unauthenticatedPairing = await pairingRoute.POST(
        jsonRequest(`${APP_ORIGIN}/api/extension/pairing`, APP_ORIGIN, {
          origin: EXTENSION_ORIGIN,
        }),
      );
      expect(unauthenticatedPairing.status).toBe(401);

      const invalidCode = await pairRoute.POST(
        jsonRequest(`${APP_ORIGIN}/api/extension/pair`, EXTENSION_ORIGIN, {
          code: "bad",
        }),
      );
      expect(invalidCode.status).toBe(401);
      expect(extensionCredentialStore.consumePairingGrant).not.toHaveBeenCalled();

      for (const grant of [
        { ...pairingFixture().grant, expiresAt: new Date(Date.now() - 1) },
        {
          ...pairingFixture().grant,
          origin: "chrome-extension://ponmlkjihgfedcbaponmlkjihgfedcba",
        },
        { ...pairingFixture().grant, consumedAt: new Date() },
      ]) {
        const pairing = pairingFixture();
        jest.mocked(extensionCredentialStore.findPairingGrant).mockResolvedValue({
          ...grant,
          id: pairing.credential.selector,
          codeDigest: pairing.credential.digest,
        });
        const response = await pairRoute.POST(
          jsonRequest(`${APP_ORIGIN}/api/extension/pair`, EXTENSION_ORIGIN, {
            code: pairing.credential.code,
          }),
        );
        expect(response.status).toBe(401);
      }

      const rejectedOrigin = await installationRoute.DELETE(
        new Request(
          `${APP_ORIGIN}/api/extension/installations/${INSTALLATION.selector}`,
          {
            method: "DELETE",
            headers: {
              Origin: "https://untrusted.example.com",
              Cookie: SESSION_COOKIE,
            },
          },
        ),
        { params: Promise.resolve({ id: INSTALLATION.selector }) },
      );
      expect(rejectedOrigin.status).toBe(403);
      expect(extensionCredentialStore.revoke).not.toHaveBeenCalled();
    });

    it("rechecks immediately before persistence after pairing, revocation, and deletion started open", async () => {
      const pairingCalls = configureWriteRecheck(4);
      const pairingResponse = await pairingRoute.POST(
        jsonRequest(`${APP_ORIGIN}/api/extension/pairing`, APP_ORIGIN, {
          origin: EXTENSION_ORIGIN,
        }, { Cookie: SESSION_COOKIE }),
      );
      await expectStopped(pairingResponse, APP_ORIGIN);
      expect(pairingCalls()).toBe(5);
      expect(extensionCredentialStore.createPairingGrant).not.toHaveBeenCalled();

      const revokeCalls = configureWriteRecheck(3, 2);
      const revokeResponse = await revokeRoute.POST(
        new Request(`${APP_ORIGIN}/api/extension/revoke`, {
          method: "POST",
          headers: {
            Origin: EXTENSION_ORIGIN,
            Authorization: `Bearer ${INSTALLATION.token}`,
          },
        }),
      );
      await expectStopped(revokeResponse, EXTENSION_ORIGIN);
      expect(revokeCalls()).toBe(4);
      expect(extensionCredentialStore.revoke).not.toHaveBeenCalled();
      expect(extensionInstallationAuthenticationStore.touch).not.toHaveBeenCalled();

      const deleteCalls = configureWriteRecheck(3);
      const deleteResponse = await installationRoute.DELETE(
        new Request(
          `${APP_ORIGIN}/api/extension/installations/${INSTALLATION.selector}`,
          {
            method: "DELETE",
            headers: { Origin: APP_ORIGIN, Cookie: SESSION_COOKIE },
          },
        ),
        { params: Promise.resolve({ id: INSTALLATION.selector }) },
      );
      await expectStopped(deleteResponse, APP_ORIGIN);
      expect(deleteCalls()).toBe(4);
      expect(extensionCredentialStore.revoke).not.toHaveBeenCalled();
    });

    it("validates a parsed pairing code before stopping without consuming it", async () => {
      const pairing = pairingFixture();
      jest.mocked(extensionCredentialStore.findPairingGrant).mockResolvedValue(
        pairing.grant,
      );
      const calls = configureWriteRecheck(3);

      const response = await pairRoute.POST(
        jsonRequest(`${APP_ORIGIN}/api/extension/pair`, EXTENSION_ORIGIN, {
          code: pairing.credential.code,
        }),
      );

      await expectStopped(response, EXTENSION_ORIGIN);
      expect(calls()).toBe(4);
      expect(extensionCredentialStore.findPairingGrant).toHaveBeenCalledWith(
        pairing.credential.selector,
      );
      expect(extensionCredentialStore.consumePairingGrant).not.toHaveBeenCalled();
    });
  });

  it("sets the extension credential mutation runtime limit", () => {
    expect(pairingRoute.maxDuration).toBe(30);
    expect(pairRoute.maxDuration).toBe(30);
    expect(revokeRoute.maxDuration).toBe(30);
    expect(installationRoute.maxDuration).toBe(30);
  });
});

function pairingFixture() {
  const credential = createPairingCredential({
    encryptionSecret: SECRET,
    origin: EXTENSION_ORIGIN,
    randomUUID: () => "018f9f72-f2e9-7c29-a6fc-001122334488",
    randomBytes: () => Buffer.alloc(32, 8),
  });
  return {
    credential,
    grant: {
      id: credential.selector,
      origin: EXTENSION_ORIGIN,
      codeDigest: credential.digest,
      expiresAt: new Date(Date.now() + 60_000),
      consumedAt: null,
      installationId: null,
      createdAt: new Date(),
    },
  };
}

function configureWriteRecheck(
  enabledCalls: number,
  disabledAuthenticationCall?: number,
): () => number {
  let calls = 0;
  jest.mocked(getServerEnv).mockImplementation(() => {
    calls += 1;
    if (calls === disabledAuthenticationCall) {
      return { ...BASE_ENV, applicationWritesEnabled: false };
    }
    return {
      ...BASE_ENV,
      applicationWritesEnabled: calls <= enabledCalls,
    };
  });
  return () => calls;
}

async function expectStopped(response: Response, origin: string): Promise<void> {
  expect(response.status).toBe(503);
  await expect(response.json()).resolves.toEqual({
    error: "Application writes are temporarily disabled",
    code: "writes_stopped",
    retryable: true,
  });
  expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  expect(response.headers.get("Pragma")).toBe("no-cache");
  expect(response.headers.get("Retry-After")).toBe("60");
  expect(response.headers.get("Access-Control-Allow-Origin")).toBe(origin);
}

function jsonRequest(
  url: string,
  origin: string,
  body: unknown,
  headers: HeadersInit = {},
): Request {
  return new Request(url, {
    method: "POST",
    headers: {
      Origin: origin,
      "Content-Type": "application/json",
      ...Object.fromEntries(new Headers(headers)),
    },
    body: JSON.stringify(body),
  });
}

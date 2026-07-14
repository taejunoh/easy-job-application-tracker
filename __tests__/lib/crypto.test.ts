describe("crypto", () => {
  const original = "sk-test-api-key-12345";
  const originalEnv = process.env;
  const validEnv: NodeJS.ProcessEnv = {
    DATABASE_URL: "postgresql://user:password@127.0.0.1:5432/jobtracker_test",
    ENCRYPTION_SECRET: "existing-encryption-secret-0123456789-legacy-suffix",
    APP_ACCESS_TOKEN: "test-access-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    APP_BASE_URL: "https://jobtracker.test",
    CORS_ALLOWED_ORIGINS: "https://jobtracker.test",
    NODE_ENV: "production",
  };

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv, ...validEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it("encrypts and decrypts a string back to the original", async () => {
    const { decrypt, encrypt } = await import("@/lib/crypto");
    const encrypted = encrypt(original);
    expect(encrypted).not.toBe(original);
    expect(encrypted).toContain(":");
    const decrypted = decrypt(encrypted);
    expect(decrypted).toBe(original);
  });

  it("produces different ciphertexts for the same input", async () => {
    const { encrypt } = await import("@/lib/crypto");
    const a = encrypt(original);
    const b = encrypt(original);
    expect(a).not.toBe(b);
  });

  it("throws on tampered ciphertext", async () => {
    const { decrypt, encrypt } = await import("@/lib/crypto");
    const encrypted = encrypt(original);
    const tampered = encrypted.slice(0, -4) + "xxxx";
    expect(() => decrypt(tampered)).toThrow();
  });

  it("decrypts ciphertext created by the historical first-32-byte key format", async () => {
    const { decrypt } = await import("@/lib/crypto");
    const historicalCiphertext =
      "00112233445566778899aabbccddeeff:b1f5bdcc3dc231da85f9d9a181c4480d:7d14a64e6676708b0d30849fe000df7517582459ef8e7fa4";

    expect(decrypt(historicalCiphertext)).toBe("sk-existing-provider-key");
  });

  it("refuses to derive an encryption key from an invalid server environment", async () => {
    process.env.ENCRYPTION_SECRET = "short";
    const { encrypt } = await import("@/lib/crypto");

    expect(() => encrypt(original)).toThrow("ENCRYPTION_SECRET");
  });
});

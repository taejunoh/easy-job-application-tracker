import { encrypt, decrypt } from "@/lib/crypto";

describe("crypto", () => {
  const original = "sk-test-api-key-12345";

  it("encrypts and decrypts a string back to the original", () => {
    const encrypted = encrypt(original);
    expect(encrypted).not.toBe(original);
    expect(encrypted).toContain(":");
    const decrypted = decrypt(encrypted);
    expect(decrypted).toBe(original);
  });

  it("produces different ciphertexts for the same input", () => {
    const a = encrypt(original);
    const b = encrypt(original);
    expect(a).not.toBe(b);
  });

  it("throws on tampered ciphertext", () => {
    const encrypted = encrypt(original);
    const tampered = encrypted.slice(0, -4) + "xxxx";
    expect(() => decrypt(tampered)).toThrow();
  });
});

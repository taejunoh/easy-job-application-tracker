import { isPublicIpAddress } from "@/lib/security/ip-address";

describe("isPublicIpAddress", () => {
  it.each([
    "0.0.0.0",
    "0.255.255.255",
    "10.0.0.1",
    "100.64.0.1",
    "100.127.255.254",
    "127.0.0.1",
    "169.254.1.1",
    "172.16.0.1",
    "172.31.255.254",
    "192.0.0.9",
    "192.0.2.1",
    "192.88.99.1",
    "192.168.1.1",
    "198.18.0.1",
    "198.51.100.1",
    "203.0.113.1",
    "224.0.0.1",
    "239.255.255.255",
    "240.0.0.1",
    "255.255.255.255",
  ])("blocks special-use IPv4 address %s", (address) => {
    expect(isPublicIpAddress(address)).toBe(false);
  });

  it.each([
    "1.1.1.1",
    "8.8.8.8",
    "9.255.255.255",
    "100.63.255.255",
    "100.128.0.0",
    "172.15.255.255",
    "172.32.0.0",
    "192.31.196.1",
    "192.175.48.1",
    "198.17.255.255",
    "198.20.0.0",
  ])("allows globally routable IPv4 address %s", (address) => {
    expect(isPublicIpAddress(address)).toBe(true);
  });

  it.each([
    "::",
    "::1",
    "::ffff:7f00:1",
    "::ffff:8.8.8.8",
    "64:ff9b::808:808",
    "64:ff9b:1::1",
    "100::1",
    "100:0:0:1::1",
    "2001::1",
    "2001:1::1",
    "2001:20::1",
    "2001:30::1",
    "2001:db8::1",
    "2002::1",
    "3fff::1",
    "5f00::1",
    "fc00::1",
    "fdff::1",
    "fe80::1",
    "fec0::1",
    "ff02::1",
  ])("blocks non-public or deliberately excluded IPv6 address %s", (address) => {
    expect(isPublicIpAddress(address)).toBe(false);
  });

  it.each([
    "2001:4860:4860::8888",
    "2606:4700:4700::1111",
    "2a00:1450:4009:822::200e",
  ])("allows ordinary global-unicast IPv6 address %s", (address) => {
    expect(isPublicIpAddress(address)).toBe(true);
  });

  it.each([
    "",
    "example.com",
    "999.1.1.1",
    "2001:::1",
    "[::1]",
    "fe80::1%lo0",
    "2001:4860::1%lo0",
  ])(
    "rejects malformed address %s",
    (address) => {
      expect(isPublicIpAddress(address)).toBe(false);
    },
  );
});

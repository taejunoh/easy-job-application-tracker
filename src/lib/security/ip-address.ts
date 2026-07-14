import { isIP } from "node:net";

type Ipv4Range = readonly [network: number, prefixLength: number];
type Ipv6Range = readonly [network: bigint, prefixLength: number];

const BLOCKED_IPV4_RANGES: readonly Ipv4Range[] = [
  ipv4Range("0.0.0.0", 8),
  ipv4Range("10.0.0.0", 8),
  ipv4Range("100.64.0.0", 10),
  ipv4Range("127.0.0.0", 8),
  ipv4Range("169.254.0.0", 16),
  ipv4Range("172.16.0.0", 12),
  // Fail closed on the whole protocol-assignment block, including its narrow
  // globally reachable anycast exceptions.
  ipv4Range("192.0.0.0", 24),
  ipv4Range("192.0.2.0", 24),
  ipv4Range("192.88.99.0", 24),
  ipv4Range("192.168.0.0", 16),
  ipv4Range("198.18.0.0", 15),
  ipv4Range("198.51.100.0", 24),
  ipv4Range("203.0.113.0", 24),
  ipv4Range("224.0.0.0", 4),
  ipv4Range("240.0.0.0", 4),
];

const GLOBAL_UNICAST_IPV6 = ipv6Range("2000::", 3);

// These special-purpose ranges sit inside 2000::/3. They are deliberately
// excluded even where a narrower assignment may be globally reachable.
const BLOCKED_GLOBAL_UNICAST_IPV6_RANGES: readonly Ipv6Range[] = [
  ipv6Range("2001::", 23),
  ipv6Range("2001:db8::", 32),
  ipv6Range("2002::", 16),
  ipv6Range("3fff::", 20),
];

export function isPublicIpAddress(address: string): boolean {
  if (address.includes("%")) return false;

  const family = isIP(address);
  if (family === 4) {
    const value = parseIpv4(address);
    return !BLOCKED_IPV4_RANGES.some((range) => inIpv4Range(value, range));
  }

  if (family === 6) {
    const value = parseIpv6(address);
    return (
      inIpv6Range(value, GLOBAL_UNICAST_IPV6) &&
      !BLOCKED_GLOBAL_UNICAST_IPV6_RANGES.some((range) =>
        inIpv6Range(value, range),
      )
    );
  }

  return false;
}

function ipv4Range(network: string, prefixLength: number): Ipv4Range {
  return [parseIpv4(network), prefixLength];
}

function parseIpv4(address: string): number {
  return address.split(".").reduce((value, octet) => {
    return ((value << 8) | Number(octet)) >>> 0;
  }, 0);
}

function inIpv4Range(value: number, [network, prefixLength]: Ipv4Range) {
  const mask =
    prefixLength === 0 ? 0 : (0xffffffff << (32 - prefixLength)) >>> 0;
  return ((value & mask) >>> 0) === ((network & mask) >>> 0);
}

function ipv6Range(network: string, prefixLength: number): Ipv6Range {
  return [parseIpv6(network), prefixLength];
}

function parseIpv6(address: string): bigint {
  const normalized = normalizeEmbeddedIpv4(address.toLowerCase());
  const [left = "", right = ""] = normalized.split("::");
  const leftGroups = left ? left.split(":") : [];
  const rightGroups = right ? right.split(":") : [];
  const omittedGroups = 8 - leftGroups.length - rightGroups.length;
  const groups = normalized.includes("::")
    ? [...leftGroups, ...Array<string>(omittedGroups).fill("0"), ...rightGroups]
    : leftGroups;

  return groups.reduce((value, group) => {
    return (value << BigInt(16)) | BigInt(`0x${group || "0"}`);
  }, BigInt(0));
}

function normalizeEmbeddedIpv4(address: string): string {
  const finalColon = address.lastIndexOf(":");
  const tail = address.slice(finalColon + 1);
  if (!tail.includes(".")) return address;

  const value = parseIpv4(tail);
  const high = ((value >>> 16) & 0xffff).toString(16);
  const low = (value & 0xffff).toString(16);
  return `${address.slice(0, finalColon + 1)}${high}:${low}`;
}

function inIpv6Range(value: bigint, [network, prefixLength]: Ipv6Range) {
  const shift = BigInt(128 - prefixLength);
  return value >> shift === network >> shift;
}

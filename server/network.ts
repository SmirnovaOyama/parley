// Where a request comes from, as an address: what password reset links are limited by, and what
// each sign-in shows it was last used from (server/sessions.ts).
import { getConnInfo } from "@hono/node-server/conninfo";
import type { Context } from "hono";
import { BlockList, isIPv4, isIPv6 } from "node:net";

// Addresses a reverse proxy in front of the server connects from: this machine, or a private
// network (Docker's, say).
const NEARBY = new BlockList();
for (const [net, prefix] of [["127.0.0.0", 8], ["10.0.0.0", 8], ["172.16.0.0", 12], ["192.168.0.0", 16]] as const) {
  NEARBY.addSubnet(net, prefix, "ipv4");
}
NEARBY.addAddress("::1", "ipv6");
NEARBY.addSubnet("fc00::", 7, "ipv6");

function nearby(ip: string): boolean {
  const v4 = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip)?.[1] ?? (isIPv4(ip) ? ip : null);
  if (v4) return NEARBY.check(v4, "ipv4");
  return isIPv6(ip) && NEARBY.check(ip, "ipv6");
}

/**
 * Where a request comes from: the address that connected or, when that's a proxy on this machine
 * or network, the one the proxy last added to X-Forwarded-For. Someone reaching the server
 * straight from the internet can't pick it.
 */
export function clientAddress(c: Context): string {
  let remote = "";
  try {
    remote = getConnInfo(c).remote.address ?? "";
  } catch {
    // No Node request under it (a test calling the app directly): where it's from is unknown.
  }
  if (nearby(remote)) {
    const forwarded = c.req.header("x-forwarded-for")?.split(",").at(-1)?.trim();
    if (forwarded) return forwarded;
  }
  return remote;
}

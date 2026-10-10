// Which addresses the page reader (read_page, for models without their own search) may connect
// to. Pages are fetched by the server, so nothing inside its own network may be reached, however
// the address is written.
import "./helpers/temp-env.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { blockedAddress, readPage } from "../server/web-tools.ts";

describe("page reader addresses", () => {
  test("reaches public addresses, IPv4 and IPv6", () => {
    for (const ip of ["8.8.8.8", "93.184.215.14", "2606:4700:4700::1111", "2a00:1450:4001:80b::200e"]) {
      assert.equal(blockedAddress(ip), false, ip);
    }
  });

  test("refuses this machine and private networks", () => {
    for (const ip of ["127.0.0.1", "10.0.0.5", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "::", "fd00::1", "fe80::1"]) {
      assert.equal(blockedAddress(ip), true, ip);
    }
  });

  test("judges an IPv6 address that carries an IPv4 one by the IPv4 address", () => {
    // Mapped, NAT64 (as DNS64 hands out on IPv6-only networks) and 6to4, written either way.
    for (const ip of ["::ffff:10.0.0.5", "::ffff:a00:5", "64:ff9b::10.0.0.5", "64:ff9b::a00:5", "64:ff9b::a9fe:a9fe", "2002:a9fe:a9fe::", "2002:7f00:1::1"]) {
      assert.equal(blockedAddress(ip), true, ip);
    }
    for (const ip of ["::ffff:8.8.8.8", "64:ff9b::808:808", "2002:808:808::1"]) {
      assert.equal(blockedAddress(ip), false, ip);
    }
  });

  test("refuses IPv6 ranges that are retired or lead elsewhere", () => {
    // IPv4-compatible, IPv4-translated, local NAT64, discard, Teredo, site-local.
    for (const ip of ["::127.0.0.1", "::7f00:1", "::ffff:0:a9fe:a9fe", "64:ff9b:1::a00:5", "100::1", "2001:0:4136:e378::1", "fec0::1"]) {
      assert.equal(blockedAddress(ip), true, ip);
    }
  });

  test("refuses a fake-IP proxy's addresses unless the site says it runs behind one", () => {
    for (const ip of ["198.18.0.40", "198.19.255.1", "64:ff9b::c612:28"]) {
      assert.equal(blockedAddress(ip, false), true, ip);
      assert.equal(blockedAddress(ip, true), false, ip);
    }
    assert.equal(blockedAddress("10.0.0.5", true), true);
  });

  test("won't fetch an address written out inside the network", async () => {
    for (const url of ["http://[::127.0.0.1]/", "http://[64:ff9b::a00:5]/", "http://[2002:a9fe:a9fe::]/latest/meta-data/", "http://198.18.0.1/"]) {
      await assert.rejects(readPage(url), /inside this server's network/, url);
    }
  });
});

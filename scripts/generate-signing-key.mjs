#!/usr/bin/env node
/**
 * Generate the Ed25519 key pair used to sign dsh-purge releases.
 *
 * Run this ONCE, on a machine you trust, and keep the private key out of the repo:
 *
 *   node scripts/generate-signing-key.mjs
 *
 * It writes:
 *   <cwd>/dsh-purge-signing.key       private key (PKCS8 PEM) — move to a password
 *                                     manager / offline backup, then delete
 *   <cwd>/dsh-purge-signing.key.pub   public key (SPKI base64) — paste into
 *                                     TRUSTED_KEYS in lib/release-signature.js
 *
 * The private key goes into GitHub Actions as the `RELEASE_SIGNING_KEY` secret.
 *
 * NEVER commit either file. Both names are covered by .gitignore.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const PRIVATE_OUT = path.resolve("dsh-purge-signing.key");
const PUBLIC_OUT = path.resolve("dsh-purge-signing.key.pub");

if (fs.existsSync(PRIVATE_OUT)) {
  console.error(`refusing to overwrite existing ${PRIVATE_OUT}`);
  console.error("Delete it deliberately if you really want a new key — replacing a key");
  console.error("invalidates every signature made with the old one.");
  process.exit(1);
}

const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");

const privatePem = privateKey.export({ format: "pem", type: "pkcs8" });
const publicDer = publicKey.export({ format: "der", type: "spki" });
const publicB64 = publicDer.toString("base64");

fs.writeFileSync(PRIVATE_OUT, privatePem, { mode: 0o600 });
fs.writeFileSync(PUBLIC_OUT, `${publicB64}\n`, "utf8");

// Self-test: the key pair must actually round-trip, otherwise the user finds out
// at release time instead of now.
const sample = Buffer.from("dsh-purge self test", "utf8");
const sig = crypto.sign(null, sample, privateKey);
const roundTrip = crypto.verify(null, sample, publicKey, sig);
if (!roundTrip) {
  console.error("self-test FAILED: generated key pair does not verify");
  process.exit(1);
}

console.log("Generated Ed25519 signing key pair.\n");
console.log(`  private : ${PRIVATE_OUT}`);
console.log(`  public  : ${PUBLIC_OUT}`);
console.log("\nNext steps:\n");
console.log("  1. Put the private key into GitHub Secrets as RELEASE_SIGNING_KEY:");
console.log("       gh secret set RELEASE_SIGNING_KEY < " + path.basename(PRIVATE_OUT));
console.log("\n  2. Paste this public key into TRUSTED_KEYS in lib/release-signature.js:");
console.log("\n     {");
console.log('       id: "release-2026",');
console.log(`       publicKey:`);
console.log(`         "${publicB64}",`);
console.log("     },\n");
console.log("  3. Delete the private key file after storing it safely:");
console.log(`       ${PRIVATE_OUT}`);
console.log("\n  Rotation: add the new public key ALONGSIDE the old one, ship a plugin");
console.log("  version carrying both, and only drop the old key once users are past it.");

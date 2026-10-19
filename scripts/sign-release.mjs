#!/usr/bin/env node
/**
 * Sign a release archive with the Ed25519 key held in RELEASE_SIGNING_KEY.
 *
 * Used by .github/workflows/release.yml, and runnable locally to reproduce or
 * verify a release:
 *
 *   RELEASE_SIGNING_KEY=/path/to/key node scripts/sign-release.mjs \
 *     dsh-purge-1.1.72.zip 1.1.72
 *
 * Writes `<archive>.sig` (base64) next to the archive and prints the sha256 so a
 * human can compare it against the published notes.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { signingPayload, SIGNATURE_SUFFIX } from "../lib/release-signature.js";

function usage() {
  console.error("usage: RELEASE_SIGNING_KEY=<path|pem> node scripts/sign-release.mjs <archive> <version>");
  process.exit(2);
}

const [archiveArg, version] = process.argv.slice(2);
if (!archiveArg || !version) usage();

const archive = path.resolve(archiveArg);
if (!fs.existsSync(archive)) {
  console.error(`archive not found: ${archive}`);
  process.exit(2);
}

const rawKey = process.env.RELEASE_SIGNING_KEY;
if (!rawKey || rawKey.trim() === "") {
  console.error("RELEASE_SIGNING_KEY is not set");
  process.exit(2);
}

// Accept either a path to a PEM file or the PEM itself (CI secrets are usually the
// literal content, local runs usually pass a path).
let privateKey;
try {
  const pem = fs.existsSync(rawKey) ? fs.readFileSync(rawKey, "utf8") : rawKey;
  privateKey = crypto.createPrivateKey({ key: pem, format: "pem" });
} catch (e) {
  console.error(`cannot read signing key: ${e.message}`);
  process.exit(2);
}

const zipBytes = fs.readFileSync(archive);
const payload = signingPayload(zipBytes, version);
const signature = crypto.sign(null, payload, privateKey);
const sigPath = archive + SIGNATURE_SUFFIX;
fs.writeFileSync(sigPath, `${signature.toString("base64")}\n`, "utf8");

const sha256 = crypto.createHash("sha256").update(zipBytes).digest("hex");
console.log(`signed   ${path.basename(archive)}`);
console.log(`version  ${version}`);
console.log(`sha256   ${sha256}`);
console.log(`signature ${path.basename(sigPath)} (${signature.length} bytes)`);

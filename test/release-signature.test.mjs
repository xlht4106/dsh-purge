// End-to-end tests for release signature verification.
//
// These generate a throwaway key pair at runtime, so the test needs no secrets and
// no committed keys. They assert the security properties that matter:
//   - a correctly signed release is accepted;
//   - tampered bytes are rejected;
//   - a signature made for a different version is rejected (version is signed);
//   - a downgrade is refused;
//   - an unsigned tag release is refused, while an unsigned branch build is allowed
//     but reported as unverified;
//   - a present-but-invalid signature is fatal even on the dev channel.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const mod = await import("../lib/release-signature.js");

const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
const publicB64 = publicKey.export({ format: "der", type: "spki" }).toString("base64");

// Swap the placeholder keyring for our throwaway key for the duration of the test.
mod.TRUSTED_KEYS.length = 0;
mod.TRUSTED_KEYS.push({ id: "test-key", publicKey: publicB64 });

const zip = Buffer.from("pretend this is a release archive", "utf8");
const VERSION = "1.1.72";

const sign = (bytes, version) =>
  crypto.sign(null, mod.signingPayload(bytes, version), privateKey).toString("base64");

let failures = 0;
function check(label, actual, expected) {
  const ok = actual === expected;
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${ok ? "" : ` (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`}`);
}

console.log("--- keyring ---");
check("hasTrustedKey", mod.hasTrustedKey(), true);

console.log("--- happy path ---");
{
  const r = mod.verifyReleaseSignature({ zipBytes: zip, signature: sign(zip, VERSION), version: VERSION });
  check("valid signature accepted", r.ok, true);
  check("reports matching key id", r.ok ? r.keyId : null, "test-key");
}

console.log("--- tampering ---");
{
  const sig = sign(zip, VERSION);
  const tampered = Buffer.from(zip);
  tampered[0] ^= 0xff;
  const r = mod.verifyReleaseSignature({ zipBytes: tampered, signature: sig, version: VERSION });
  check("tampered payload rejected", r.ok, false);
}
{
  // The version is part of the signed payload, so re-labelling an archive breaks it.
  const r = mod.verifyReleaseSignature({ zipBytes: zip, signature: sign(zip, "1.1.71"), version: VERSION });
  check("signature bound to another version rejected", r.ok, false);
}
{
  const r = mod.verifyReleaseSignature({ zipBytes: zip, signature: null, version: VERSION });
  check("missing signature rejected by verify", r.ok, false);
}
{
  const r = mod.verifyReleaseSignature({ zipBytes: zip, signature: "AAAA", version: VERSION });
  check("wrong-length signature rejected", r.ok, false);
}
{
  const r = mod.verifyReleaseSignature({ zipBytes: zip, signature: sign(zip, VERSION), version: "not-a-version" });
  check("non-semver version rejected", r.ok, false);
}

console.log("--- channel grading ---");
{
  const r = mod.checkRelease({
    zipBytes: zip, signature: sign(zip, VERSION), version: VERSION,
    requiresSignature: true, runningVersion: "1.1.71",
  });
  check("signed tag release installs", r.ok && r.verified, true);
}
{
  const r = mod.checkRelease({
    zipBytes: zip, signature: null, version: VERSION,
    requiresSignature: true, runningVersion: "1.1.71",
  });
  check("unsigned tag release refused", r.ok, false);
}
{
  const r = mod.checkRelease({
    zipBytes: zip, signature: null, version: VERSION,
    requiresSignature: false, runningVersion: "1.1.71",
  });
  check("unsigned branch build allowed", r.ok, true);
  check("unsigned branch build marked unverified", r.ok ? r.verified : null, false);
}
{
  const bad = sign(Buffer.from("other bytes"), VERSION);
  const r = mod.checkRelease({
    zipBytes: zip, signature: bad, version: VERSION,
    requiresSignature: false, runningVersion: "1.1.71",
  });
  check("invalid signature fatal even on dev channel", r.ok, false);
}

console.log("--- rollback protection ---");
{
  const r = mod.checkRelease({
    zipBytes: zip, signature: sign(zip, "1.1.71"), version: "1.1.71",
    requiresSignature: false, runningVersion: "1.1.72",
  });
  check("downgrade refused", r.ok, false);
}
{
  const r = mod.checkRelease({
    zipBytes: zip, signature: sign(zip, VERSION), version: VERSION,
    requiresSignature: false, runningVersion: VERSION,
  });
  check("same version allowed (reinstall)", r.ok, true);
}

console.log("--- placeholder keyring state ---");
{
  // Restore the shipped keyring and confirm it refuses to authenticate anything
  // rather than silently trusting payloads.
  mod.TRUSTED_KEYS.length = 0;
  mod.TRUSTED_KEYS.push({ id: "dev-placeholder", publicKey: "" });
  const r = mod.verifyReleaseSignature({ zipBytes: zip, signature: sign(zip, VERSION), version: VERSION });
  check("empty placeholder key cannot verify", r.ok, false);
  check("hasTrustedKey false with placeholder", mod.hasTrustedKey(), false);
}

console.log(failures === 0 ? "\nSIGNATURE OK" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);

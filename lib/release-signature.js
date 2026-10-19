/**
 * Release signature verification for self-update.
 *
 * Threat model
 * ------------
 * `overlayFromZip()` downloads a zip and copies it over the running plugin. Until
 * now the only integrity guarantee was TLS, which means any of these silently
 * installs attacker code that runs with the user's privileges on next start:
 *
 *   - the GitHub repo or account is compromised;
 *   - a corporate/malicious proxy or CA terminates TLS;
 *   - HTTPS_PROXY points at a hostile node.
 *
 * Transport security cannot fix that: the signer must be someone the *installed*
 * copy already trusts. So releases are signed offline with an Ed25519 key and the
 * plugin ships only the public key(s).
 *
 * Why not checksums
 * -----------------
 * A checksum served from the same origin as the payload only catches corruption,
 * not a deliberate substitution. Ed25519 with an embedded public key is the whole
 * point; the hash below is just a stable identifier.
 *
 * Grading (see docs/update-signing.md)
 * ------------------------------------
 *   tag release  -> signature REQUIRED; missing/invalid => refuse to install
 *   branch/commit-> signature optional; unsigned is allowed but reported as
 *                   "unverified (dev channel)" in status and the UI
 *
 * Rollback protection
 * -------------------
 * A valid signature proves the bytes are authentic, not that they are *current*.
 * The signed payload therefore includes the version, and a release whose version
 * is lower than the running one is rejected as a downgrade.
 */
import crypto from "node:crypto";

/**
 * Trusted signing keys.
 *
 * Rotation: never replace an entry in place. Add the new key alongside the old
 * one, ship a plugin version carrying both, and only drop the old entry once
 * essentially every user is past that version — otherwise an old client rejects
 * every new release.
 *
 * `id` is a short stable label used in logs and status output. `publicKey` is the
 * base64 SPKI DER (what `generate-signing-key.mjs` prints).
 */
export const TRUSTED_KEYS = [
  // Placeholder replaced by `node scripts/generate-signing-key.mjs`.
  // Until a real key is present, tag releases cannot be verified and installs from
  // a tag are refused with a clear message instead of silently trusting the bytes.
  {
    id: "dev-placeholder",
    publicKey: "",
  },
];

/** Suffix of the detached signature published next to the zip. */
export const SIGNATURE_SUFFIX = ".sig";

/** Minimum length of an Ed25519 signature, in bytes. */
const ED25519_SIGNATURE_BYTES = 64;

function keyObjects() {
  const out = [];
  for (const entry of TRUSTED_KEYS) {
    if (!entry || typeof entry.publicKey !== "string" || entry.publicKey.trim() === "") continue;
    try {
      out.push({
        id: entry.id,
        key: crypto.createPublicKey({
          key: Buffer.from(entry.publicKey, "base64"),
          format: "der",
          type: "spki",
        }),
      });
    } catch {
      // A malformed embedded key must not make the whole plugin uninstallable;
      // it is simply unusable for verification.
    }
  }
  return out;
}

/** True when at least one usable public key is embedded. */
export function hasTrustedKey() {
  return keyObjects().length > 0;
}

/**
 * Build the bytes that get signed.
 *
 * The version is inside the signed payload on purpose: it lets us reject a valid
 * but *older* release (rollback), which a bare signature over the zip cannot do.
 * A length-prefixed layout avoids ambiguity between the version and the digest.
 *
 * @param {Buffer} zipBytes raw release archive
 * @param {string} version release version, e.g. "1.1.72"
 * @returns {Buffer} payload to verify
 */
export function signingPayload(zipBytes, version) {
  const versionBytes = Buffer.from(String(version || ""), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32BE(versionBytes.length, 0);
  return Buffer.concat([Buffer.from("dsh-purge-release-v1\n", "utf8"), header, versionBytes, zipBytes]);
}

/**
 * Verify a detached signature.
 *
 * @param {object} input
 * @param {Buffer} input.zipBytes downloaded archive
 * @param {Buffer|string} input.signature detached signature (raw bytes, or base64 text)
 * @param {string} input.version version the archive claims to be
 * @returns {{ok: true, keyId: string} | {ok: false, reason: string}}
 */
export function verifyReleaseSignature({ zipBytes, signature, version }) {
  if (!Buffer.isBuffer(zipBytes) || zipBytes.length === 0) {
    return { ok: false, reason: "release archive is empty" };
  }
  if (!version || !/^\d+\.\d+\.\d+/.test(String(version))) {
    return { ok: false, reason: `release version is not a semantic version: ${JSON.stringify(version)}` };
  }

  const sig = toSignatureBuffer(signature);
  if (!sig) return { ok: false, reason: "release signature is missing" };
  if (sig.length !== ED25519_SIGNATURE_BYTES) {
    return { ok: false, reason: `release signature has ${sig.length} bytes, expected ${ED25519_SIGNATURE_BYTES}` };
  }

  const keys = keyObjects();
  if (keys.length === 0) {
    return { ok: false, reason: "no trusted signing key is embedded in this plugin build" };
  }

  const payload = signingPayload(zipBytes, version);
  for (const { id, key } of keys) {
    try {
      if (crypto.verify(null, payload, key, sig)) return { ok: true, keyId: id };
    } catch {
      // Wrong key type or malformed key: try the next one.
    }
  }
  return { ok: false, reason: "signature does not match any trusted key" };
}

function toSignatureBuffer(signature) {
  if (Buffer.isBuffer(signature)) return signature.length > 0 ? signature : null;
  if (signature instanceof Uint8Array) return signature.length > 0 ? Buffer.from(signature) : null;
  if (typeof signature !== "string") return null;
  // Accept the text form published alongside releases (base64, possibly with
  // trailing newline) so a human can eyeball or re-upload it.
  const cleaned = signature.replace(/\s+/g, "");
  if (cleaned === "") return null;
  try {
    const buf = Buffer.from(cleaned, "base64");
    return buf.length > 0 ? buf : null;
  } catch {
    return null;
  }
}

/**
 * Decide whether an install may proceed.
 *
 * @param {object} input
 * @param {Buffer} input.zipBytes
 * @param {Buffer|string} [input.signature] omitted for unsigned branch builds
 * @param {string} input.version
 * @param {boolean} input.requiresSignature true for tag releases
 * @param {string} [input.runningVersion] current plugin version, for rollback check
 * @returns {{ok: true, verified: boolean, keyId?: string} | {ok: false, reason: string}}
 */
export function checkRelease({ zipBytes, signature, version, requiresSignature, runningVersion }) {
  const rollback = compareVersions(version, runningVersion);
  if (rollback < 0) {
    return { ok: false, reason: `refusing to downgrade from ${runningVersion} to ${version}` };
  }

  const hasSig = toSignatureBuffer(signature) !== null;
  if (!hasSig) {
    if (requiresSignature) {
      return {
        ok: false,
        reason:
          `release ${version} is not signed and this channel requires a signature. ` +
          "Refusing to install bytes that cannot be authenticated.",
      };
    }
    return { ok: true, verified: false };
  }

  const result = verifyReleaseSignature({ zipBytes, signature, version });
  if (!result.ok) {
    // A present-but-bad signature is always fatal, even on the dev channel: it
    // means the payload was tampered with or the version was swapped.
    return { ok: false, reason: `release signature rejected: ${result.reason}` };
  }
  return { ok: true, verified: true, keyId: result.keyId };
}

/**
 * Compare two semantic versions, prerelease-aware.
 *
 * Deliberately local instead of pulling in `semver`: this module is loaded on the
 * update hot path in every install, and the plugin ships with no runtime deps.
 * Handles the subset the plugin actually produces (x.y.z with optional -tag.N).
 *
 * @returns {number} -1 when a < b, 0 when equal, 1 when a > b
 */
export function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return 0; // unknown on either side: never block on it
  for (let i = 0; i < 3; i += 1) {
    if (pa.nums[i] !== pb.nums[i]) return pa.nums[i] < pb.nums[i] ? -1 : 1;
  }
  // A release outranks any prerelease of the same x.y.z.
  if (pa.pre === "" && pb.pre !== "") return 1;
  if (pa.pre !== "" && pb.pre === "") return -1;
  if (pa.pre === pb.pre) return 0;
  return comparePrerelease(pa.pre, pb.pre);
}

function parseVersion(value) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(String(value || "").trim());
  if (!match) return null;
  return {
    nums: [Number(match[1]), Number(match[2]), Number(match[3])],
    pre: match[4] || "",
  };
}

function comparePrerelease(a, b) {
  const as = a.split(".");
  const bs = b.split(".");
  const len = Math.max(as.length, bs.length);
  for (let i = 0; i < len; i += 1) {
    const x = as[i];
    const y = bs[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) {
      const diff = Number(x) - Number(y);
      if (diff !== 0) return diff < 0 ? -1 : 1;
      continue;
    }
    // Numeric identifiers sort below alphanumeric ones.
    if (xn !== yn) return xn ? -1 : 1;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

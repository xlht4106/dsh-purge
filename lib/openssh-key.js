/**
 * Import an OpenSSH Ed25519 private key for release signing.
 *
 * Why this exists
 * ---------------
 * Password managers that "generate an SSH key" hand you an OpenSSH-format private
 * key. Two things block using it directly:
 *
 *   1. Node's crypto cannot parse `-----BEGIN OPENSSH PRIVATE KEY-----`
 *      (verified: "DECODER routines::unsupported").
 *   2. `ssh-keygen -p -m PEM` no longer emits the legacy PEM form on OpenSSH 9.5,
 *      and OpenSSL is not always installed on Windows.
 *
 * So this module parses the OpenSSH wire format itself and re-exports PKCS8.
 *
 * OpenSSH private key blob layout (unencrypted: cipher "none", kdf "none"):
 *
 *   "openssh-key-v1\0"
 *   string ciphername          "none"
 *   string kdfname             "none"
 *   string kdfoptions          empty
 *   uint32 nkeys               1
 *   string publickey           SSH wire format
 *   string privatekey          <section below>
 *
 *   privatekey section:
 *     uint32 check1, uint32 check2   must be equal (integrity check)
 *     string keytype                 "ssh-ed25519"
 *     string pub                     32 bytes
 *     string priv                    64 bytes = seed(32) || pub(32)
 *     string comment
 *     padding 1,2,3,... to an 8-byte boundary
 *
 * Encrypted keys are rejected rather than silently mishandled: signing runs in CI
 * with the raw secret, so an empty passphrase is the expected shape there.
 */
import crypto from "node:crypto";

const AUTH_MAGIC = Buffer.from("openssh-key-v1\0", "binary");
const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const SPKI_ED25519_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

function readU32(buf, state) {
  if (state.off + 4 > buf.length) throw new Error("truncated key blob (uint32)");
  const value = buf.readUInt32BE(state.off);
  state.off += 4;
  return value;
}

function readString(buf, state) {
  const len = readU32(buf, state);
  if (state.off + len > buf.length) throw new Error("truncated key blob (string)");
  const value = buf.subarray(state.off, state.off + len);
  state.off += len;
  return value;
}

/** True when the text looks like an OpenSSH private key (vs PKCS8 PEM). */
export function isOpenSshPrivateKey(text) {
  return /-----BEGIN OPENSSH PRIVATE KEY-----/.test(String(text || ""));
}

/**
 * Convert an unencrypted OpenSSH Ed25519 private key to PKCS8 PEM.
 *
 * @param {string} openSshPem full PEM text including BEGIN/END lines
 * @returns {{pkcs8Pem: string, publicB64: string, rawPublic: Buffer, sshFingerprint: string}}
 * @throws when the key is encrypted, not Ed25519, or corrupt
 */
export function openSshEd25519ToPkcs8(openSshPem) {
  const body = String(openSshPem)
    .replace(/-----BEGIN OPENSSH PRIVATE KEY-----/g, "")
    .replace(/-----END OPENSSH PRIVATE KEY-----/g, "")
    .replace(/\s+/g, "");
  if (body === "") throw new Error("empty key body");

  const blob = Buffer.from(body, "base64");
  if (!blob.subarray(0, AUTH_MAGIC.length).equals(AUTH_MAGIC)) {
    throw new Error("not an openssh-key-v1 blob");
  }
  const state = { off: AUTH_MAGIC.length };

  const cipher = readString(blob, state).toString("utf8");
  const kdf = readString(blob, state).toString("utf8");
  readString(blob, state); // kdfoptions
  const nkeys = readU32(blob, state);

  if (cipher !== "none" || kdf !== "none") {
    throw new Error(
      `encrypted key is not supported (cipher=${cipher}, kdf=${kdf}). ` +
        "Export it without a passphrase, or set the passphrase-protected PEM directly.",
    );
  }
  if (nkeys !== 1) throw new Error(`expected exactly 1 key, found ${nkeys}`);

  readString(blob, state); // public key (re-derived from the private half below)
  const privSection = readString(blob, state);

  const ps = { off: 0 };
  const check1 = readU32(privSection, ps);
  const check2 = readU32(privSection, ps);
  if (check1 !== check2) throw new Error("private key integrity check failed (corrupt blob)");

  const keyType = readString(privSection, ps).toString("utf8");
  if (keyType !== "ssh-ed25519") {
    throw new Error(`unsupported key type: ${keyType}; only ssh-ed25519 can sign releases`);
  }
  const rawPublic = readString(privSection, ps);
  const rawPrivate = readString(privSection, ps);

  if (rawPublic.length !== 32) throw new Error(`unexpected public key length ${rawPublic.length}`);
  if (rawPrivate.length !== 64) throw new Error(`unexpected private key length ${rawPrivate.length}`);
  if (!rawPrivate.subarray(32).equals(rawPublic)) {
    throw new Error("private key does not embed the matching public key");
  }

  const seed = rawPrivate.subarray(0, 32);
  const der = Buffer.concat([PKCS8_ED25519_PREFIX, seed]);
  const privateKey = crypto.createPrivateKey({ key: der, format: "der", type: "pkcs8" });
  const pkcs8Pem = privateKey.export({ format: "pem", type: "pkcs8" });

  const spki = Buffer.concat([SPKI_ED25519_PREFIX, rawPublic]);
  const publicKey = crypto.createPublicKey({ key: spki, format: "der", type: "spki" });

  // Prove the pair is usable before anyone depends on it.
  const sample = Buffer.from("dsh-purge openssh import self test", "utf8");
  if (!crypto.verify(null, sample, publicKey, crypto.sign(null, sample, privateKey))) {
    throw new Error("imported key failed its sign/verify self test");
  }

  return {
    pkcs8Pem,
    publicB64: spki.toString("base64"),
    rawPublic,
    sshFingerprint: sshFingerprintOf(rawPublic),
  };
}

/**
 * Standard OpenSSH fingerprint: base64(sha256(ssh-wire-blob)), no padding.
 *
 * The blob is what `ssh-keygen -l` hashes — length-prefixed "ssh-ed25519" plus the
 * 32-byte key. Hashing the bare key instead produces a different, wrong value.
 */
export function sshFingerprintOf(rawPublic) {
  const type = Buffer.from("ssh-ed25519", "utf8");
  const typeLen = Buffer.alloc(4);
  typeLen.writeUInt32BE(type.length, 0);
  const keyLen = Buffer.alloc(4);
  keyLen.writeUInt32BE(rawPublic.length, 0);
  const blob = Buffer.concat([typeLen, type, keyLen, rawPublic]);
  return crypto.createHash("sha256").update(blob).digest("base64").replace(/=+$/, "");
}

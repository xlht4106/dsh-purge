// Tests for importing OpenSSH Ed25519 private keys.
//
// Password managers ("generate an SSH key" features) hand out OpenSSH-format keys.
// Node cannot parse them and OpenSSH 9.5 no longer emits legacy PEM, so
// lib/openssh-key.js parses the wire format itself.
//
// These tests build real keys with `ssh-keygen` when available, then assert:
//   - the derived public key matches what ssh-keygen reports
//   - the derived fingerprint matches `ssh-keygen -l`
//   - the converted key actually signs, and the signature verifies
//   - encrypted / non-ed25519 / corrupt input is rejected with a clear error
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const mod = await import("../lib/openssh-key.js");

let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${ok ? "" : ` (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`}`);
}

function hasSshKeygen() {
  // `ssh-keygen -?` exits non-zero on some builds, so probe by actually generating
  // into a throwaway directory instead of trusting the exit code.
  const probe = fs.mkdtempSync(path.join(os.tmpdir(), "dshpurge-probe-"));
  try {
    execFileSync("ssh-keygen", ["-t", "ed25519", "-f", path.join(probe, "k"), "-N", "", "-q"], {
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  } finally {
    fs.rmSync(probe, { recursive: true, force: true });
  }
}

console.log("--- format detection ---");
{
  check("recognises OpenSSH header", mod.isOpenSshPrivateKey("-----BEGIN OPENSSH PRIVATE KEY-----\nx\n"), true);
  check("rejects PKCS8 header", mod.isOpenSshPrivateKey("-----BEGIN PRIVATE KEY-----\nx\n"), false);
  check("rejects empty", mod.isOpenSshPrivateKey(""), false);
}

console.log("--- malformed input ---");
{
  let err = null;
  try { mod.openSshEd25519ToPkcs8("-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----"); }
  catch (e) { err = e.message; }
  check("garbage blob rejected", /not an openssh-key-v1 blob/.test(String(err)), true);
}

if (!hasSshKeygen()) {
  console.log("\nSKIP real-key tests: ssh-keygen not available");
  console.log(failures === 0 ? "OPENSSH KEY OK (partial)" : `${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dshpurge-openssh-"));

function generate(name, { passphrase = "" } = {}) {
  const fp = path.join(dir, name);
  const args = ["-t", "ed25519", "-f", fp, "-N", passphrase, "-C", "dsh-purge-test", "-q"];
  execFileSync("ssh-keygen", args, { stdio: "ignore" });
  return { priv: fp, pub: `${fp}.pub` };
}

console.log("--- round trip against ssh-keygen ---");
{
  const { priv, pub } = generate("plain");
  const imported = mod.openSshEd25519ToPkcs8(fs.readFileSync(priv, "utf8"));

  // 1. Public key must match what ssh-keygen prints.
  //    ssh-keygen -y appends the comment, so compare only "type + key" fields.
  const expectedPub = execFileSync("ssh-keygen", ["-y", "-f", priv], { encoding: "utf8" })
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .join(" ");
  const actualPub = `ssh-ed25519 ${Buffer.concat([
    Buffer.from([0, 0, 0, 11]), Buffer.from("ssh-ed25519"),
    Buffer.from([0, 0, 0, 32]), imported.rawPublic,
  ]).toString("base64")}`;
  check("derived public key matches ssh-keygen -y", actualPub, expectedPub);

  // 2. Fingerprint must match `ssh-keygen -l` (which prefixes "SHA256:").
  const listed = execFileSync("ssh-keygen", ["-l", "-f", pub], { encoding: "utf8" }).trim();
  const expectedFp = listed.split(/\s+/)[1].replace(/^SHA256:/, "");
  check("fingerprint matches ssh-keygen -l", imported.sshFingerprint, expectedFp);

  // 3. SPKI must be parseable and the pair must sign/verify.
  const pubObj = crypto.createPublicKey({ key: Buffer.from(imported.publicB64, "base64"), format: "der", type: "spki" });
  const privObj = crypto.createPrivateKey({ key: imported.pkcs8Pem, format: "pem" });
  const msg = Buffer.from("payload", "utf8");
  check("converted pair signs and verifies", crypto.verify(null, msg, pubObj, crypto.sign(null, msg, privObj)), true);

  // 4. The PKCS8 PEM must be a normal PRIVATE KEY block, not OpenSSH.
  check("pkcs8 pem has PKCS8 header", imported.pkcs8Pem.includes("-----BEGIN PRIVATE KEY-----"), true);
  check("pkcs8 pem is not openssh", mod.isOpenSshPrivateKey(imported.pkcs8Pem), false);
}

console.log("--- encrypted key is refused, not silently mishandled ---");
{
  const { priv } = generate("enc", { passphrase: "hunter2" });
  let err = null;
  try { mod.openSshEd25519ToPkcs8(fs.readFileSync(priv, "utf8")); }
  catch (e) { err = e.message; }
  check("encrypted key rejected with reason", /encrypted key is not supported/.test(String(err)), true);
}

console.log("--- two different keys produce different fingerprints ---");
{
  const a = mod.openSshEd25519ToPkcs8(fs.readFileSync(generate("k1").priv, "utf8"));
  const b = mod.openSshEd25519ToPkcs8(fs.readFileSync(generate("k2").priv, "utf8"));
  check("fingerprints differ", a.sshFingerprint !== b.sshFingerprint, true);
  check("public keys differ", a.publicB64 !== b.publicB64, true);
}

fs.rmSync(dir, { recursive: true, force: true });
console.log(failures === 0 ? "\nOPENSSH KEY OK" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);

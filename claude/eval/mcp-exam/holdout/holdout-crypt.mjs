/**
 * Holdout bundle at rest: AES-256-GCM, key = scrypt(passphrase, salt). Same format as the bastion's exam
 * ("MCPX1" | salt(16) | iv(12) | tag(16) | ciphertext). The passphrase lives only in the bastion asset
 * 「本地浏览器 MCP 考卷 · 私藏题解密口令」; the ciphertext sits in evolve/mcp-exam/holdout-YYYY-MM-DD.enc. Judge layer.
 *
 *   seal:  <passphrase on stdin> | node claude/eval/mcp-exam/holdout/holdout-crypt.mjs seal <plain.json> <out.enc>
 *   check: <passphrase on stdin> | node claude/eval/mcp-exam/holdout/holdout-crypt.mjs check <in.enc>   (prints counts only)
 */
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { validateBundle } from '../tasks/task-spec.mjs';

const MAGIC = Buffer.from('MCPX1');
const keyOf = (pass, salt) => scryptSync(pass, salt, 32, { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });

export function sealBundle(bundle, passphrase) {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyOf(passphrase, salt), iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(bundle), 'utf8'), cipher.final()]);
  return Buffer.concat([MAGIC, salt, iv, cipher.getAuthTag(), body]);
}

export function openBundle(data, passphrase) {
  if (!data.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('not a holdout bundle');
  let at = MAGIC.length;
  const salt = data.subarray(at, (at += 16));
  const iv = data.subarray(at, (at += 12));
  const tag = data.subarray(at, (at += 16));
  const decipher = createDecipheriv('aes-256-gcm', keyOf(passphrase, salt), iv);
  decipher.setAuthTag(tag);
  const bundle = JSON.parse(Buffer.concat([decipher.update(data.subarray(at)), decipher.final()]).toString('utf8'));
  if (bundle.set !== 'holdout') throw new Error('holdout bundle has the wrong shape');
  return validateBundle(bundle);
}

async function stdinFirstLine() {
  let raw = '';
  for await (const c of process.stdin) raw += c;
  return raw.split(/\r?\n/)[0].trim();
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [, , cmd, input, output] = process.argv;
  const pass = await stdinFirstLine();
  if (pass.length < 16) throw new Error('passphrase (stdin) must be at least 16 characters');
  if (cmd === 'seal' && input && output) {
    const bundle = validateBundle(JSON.parse(fs.readFileSync(input, 'utf8')));
    fs.writeFileSync(output, sealBundle(bundle, pass));
    const back = openBundle(fs.readFileSync(output), pass);
    console.log(`sealed ${back.tasks.length} holdout tasks → ${output}`);
  } else if (cmd === 'check' && input) {
    const b = openBundle(fs.readFileSync(input), pass);
    console.log(JSON.stringify({ tasks: b.tasks.length, pages: Object.keys(b.worldPatch?.pages ?? {}).length, users: (b.worldPatch?.users ?? []).length }));
  } else {
    console.error('usage: seal <plain.json> <out.enc> | check <in.enc>');
    process.exit(2);
  }
}

import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { chromium } from 'patchright';
import { FingerprintCore } from '../dist/fingerprint-core.js';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fp-meas-'));
const core = new FingerprintCore(dir);
const t = (l, t0) => console.log(l, Date.now() - t0, 'ms');
let t0 = Date.now();
const a = await core.ensureProfile('a', { source: 'direct' }); t('core start + create profile', t0);
t0 = Date.now(); const b = await core.ensureProfile('b', { source: 'direct' }); t('create 2nd profile', t0);
t0 = Date.now(); const oa = await core.open(a.profileId); t('open a', t0);
t0 = Date.now(); const ba = await chromium.connectOverCDP(oa.cdpHttp); t('connect a', t0);
t0 = Date.now(); const [ob, oc] = await Promise.all([core.open(b.profileId), core.ensureProfile('c', { source: 'direct' }).then((c) => core.open(c.profileId))]); t('open b + c in parallel', t0);
const bb = await chromium.connectOverCDP(ob.cdpHttp);
const pa = ba.contexts()[0].pages()[0]; const pb = bb.contexts()[0].pages()[0];
await pa.goto('https://example.com/'); await pb.goto('https://example.com/');
await pb.bringToFront(); await new Promise((r) => setTimeout(r, 1500));
for (const [n, p] of [['a (occluded)', pa], ['b (front)', pb]]) {
  t0 = Date.now(); const buf = await p.screenshot({ timeout: 15000 }).catch((e) => e);
  if (!(buf instanceof Buffer)) { console.log(n, 'screenshot FAILED', String(buf.message).slice(0, 80)); continue; }
  console.log(n, 'screenshot', Date.now() - t0, 'ms', buf.length, 'bytes; visibility', await p.evaluate('document.visibilityState'));
  fs.writeFileSync(path.join(os.tmpdir(), `fp-meas-${n[0]}.png`), buf);
}
await ba.close(); await bb.close(); core.stopSync();
await new Promise((r) => setTimeout(r, 5000)); fs.rmSync(dir, { recursive: true, force: true });

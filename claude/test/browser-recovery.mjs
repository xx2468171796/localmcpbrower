import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const profile = await mkdtemp(path.join(os.tmpdir(), 'mcp-recovery-'));
process.env.USER_DATA_DIR = profile;
process.env.HEADLESS = 'true';
const { getBrowserManager } = await import('../dist/browser.js');
const manager = getBrowserManager();
try {
  const first = await manager.getContext();
  await first.close();
  assert.equal(manager.isAlive(), false);
  const recovered = await Promise.all(Array.from({length: 5}, () => manager.getContext()));
  assert.ok(recovered.every(context => context === recovered[0]));
  assert.notEqual(recovered[0], first);
  assert.equal(manager.isAlive(), true);
  const page = await recovered[0].newPage();
  await page.goto('data:text/html,<title>recovered</title>');
  assert.equal(await page.title(), 'recovered');
  console.log('Browser close / concurrent recovery / navigation: PASS');
} finally {
  await manager.close();
  await rm(profile, {recursive:true,force:true,maxRetries:5,retryDelay:200});
}

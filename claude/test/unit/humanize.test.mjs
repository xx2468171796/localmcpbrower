// 拟人操作纯计算部分的单测(src/humanize/{rng,path,timing}.ts,跑构建产物)
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { seeded } from '../../dist/humanize/rng.js';
import { mousePath, moveDuration, pointInBox } from '../../dist/humanize/path.js';
import { scrollPlan, typingPlan } from '../../dist/humanize/timing.js';
import { humanizeActive, humanizeFromEnv, setHumanizeResolver } from '../../dist/humanize/index.js';

const total = (pts) => pts.reduce((s, p) => s + p.dt, 0);

test('seeded: same seed → same sequence, different seed → different', () => {
  const a = seeded(42); const b = seeded(42); const c = seeded(43);
  const sa = Array.from({ length: 5 }, a); const sb = Array.from({ length: 5 }, b); const sc = Array.from({ length: 5 }, c);
  assert.deepEqual(sa, sb);
  assert.notDeepEqual(sa, sc);
  for (const v of sa) assert.ok(v >= 0 && v < 1);
});

test('mousePath: deterministic per seed', () => {
  const p1 = mousePath({ x: 10, y: 20 }, { x: 600, y: 400 }, seeded(7));
  const p2 = mousePath({ x: 10, y: 20 }, { x: 600, y: 400 }, seeded(7));
  assert.deepEqual(p1, p2);
});

test('mousePath: ends exactly at the target, all points finite, dt positive', () => {
  for (let seed = 1; seed <= 200; seed++) {
    const r = seeded(seed);
    const from = { x: r() * 1900, y: r() * 1000 };
    const to = { x: r() * 1900, y: r() * 1000 };
    const pts = mousePath(from, to, r);
    assert.ok(pts.length >= 1);
    const last = pts.at(-1);
    assert.equal(last.x, to.x);
    assert.equal(last.y, to.y);
    for (const p of pts) {
      assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.dt), `seed ${seed}`);
      assert.ok(p.dt >= 1);
    }
  }
});

test('mousePath: first point starts near the origin (no teleport)', () => {
  const from = { x: 100, y: 100 };
  const to = { x: 900, y: 700 };
  const pts = mousePath(from, to, seeded(3));
  const first = pts[0];
  assert.ok(Math.hypot(first.x - from.x, first.y - from.y) < 100, 'first step is small');
});

test('mousePath: duration within 150–700ms (plus rounding slack), step count grows with distance', () => {
  for (let seed = 1; seed <= 100; seed++) {
    const short = mousePath({ x: 0, y: 0 }, { x: 30, y: 10 }, seeded(seed));
    const long = mousePath({ x: 0, y: 0 }, { x: 1500, y: 800 }, seeded(seed));
    for (const pts of [short, long]) {
      const t = total(pts);
      assert.ok(t >= 140 && t <= 700 + pts.length, `seed ${seed} total ${t}`);
    }
    assert.ok(short.length >= 12, 'enough mousemove events even for short moves');
    assert.ok(long.length > short.length);
  }
  assert.ok(moveDuration(1000, seeded(1)) > moveDuration(20, seeded(1)));
});

test('mousePath: long moves overshoot then come back', () => {
  let overshot = 0;
  for (let seed = 1; seed <= 30; seed++) {
    const pts = mousePath({ x: 0, y: 500 }, { x: 1000, y: 500 }, seeded(seed));
    if (Math.max(...pts.map((p) => p.x)) > 1005) overshot++;
  }
  assert.ok(overshot >= 25, `overshoot in ${overshot}/30`);
  const shortPts = mousePath({ x: 0, y: 0 }, { x: 100, y: 0 }, seeded(1));
  assert.ok(Math.max(...shortPts.map((p) => p.x)) <= 100.0001);
});

test('mousePath: path is curved, not a straight line', () => {
  let curved = 0;
  for (let seed = 1; seed <= 30; seed++) {
    const pts = mousePath({ x: 0, y: 0 }, { x: 800, y: 0 }, seeded(seed));
    if (Math.max(...pts.map((p) => Math.abs(p.y))) > 3) curved++;
  }
  assert.ok(curved >= 20, `curved ${curved}/30`);
});

test('mousePath: zero distance and non-finite input', () => {
  const pts = mousePath({ x: 5, y: 5 }, { x: 5, y: 5 }, seeded(1));
  assert.equal(pts.length, 1);
  assert.equal(pts[0].x, 5);
  assert.throws(() => mousePath({ x: 0, y: 0 }, { x: Number.NaN, y: 0 }, seeded(1)), RangeError);
});

test('pointInBox: inside with ≥ 2px margin, not always the exact centre, tiny boxes use centre', () => {
  const box = { x: 100, y: 200, width: 120, height: 40 };
  const r = seeded(9);
  let offCentre = 0;
  for (let i = 0; i < 500; i++) {
    const p = pointInBox(box, r);
    assert.ok(p.x >= 102 && p.x <= 218 && p.y >= 202 && p.y <= 238, JSON.stringify(p));
    if (Math.abs(p.x - 160) > 1 || Math.abs(p.y - 220) > 1) offCentre++;
  }
  assert.ok(offCentre > 400);
  assert.deepEqual(pointInBox({ x: 0, y: 0, width: 3, height: 3 }, r), { x: 1.5, y: 1.5 });
});

test('typingPlan: one step per code point, deterministic, delays in range', () => {
  const text = 'Hello, world! 你好 🎉';
  const a = typingPlan(text, seeded(5));
  assert.deepEqual(a, typingPlan(text, seeded(5)));
  assert.equal(a.map((s) => s.char).join(''), text);
  assert.equal(a.length, Array.from(text).length);
  for (const s of a) assert.ok(s.delayMs >= 30 && s.delayMs <= 160 + 650, String(s.delayMs));
  const delays = new Set(a.map((s) => s.delayMs));
  assert.ok(delays.size > 5, 'delays vary');
});

test('typingPlan: noTypos never produces typos (even with a high rate)', () => {
  const text = 'correcthorsebatterystaple'.repeat(20);
  for (let seed = 1; seed <= 50; seed++) {
    const plan = typingPlan(text, seeded(seed), { noTypos: true, typoRate: 0.5 });
    assert.ok(plan.every((s) => s.typoBefore === undefined));
  }
});

test('typingPlan: typos only on ASCII letters, adjacent key, same case, then the right char', () => {
  const text = 'The Quick Brown Fox 123 !? 中文'.repeat(30);
  const plan = typingPlan(text, seeded(11), { typoRate: 0.3 });
  const typos = plan.filter((s) => s.typoBefore !== undefined);
  assert.ok(typos.length > 10, `typos ${typos.length}`);
  for (const s of typos) {
    assert.match(s.char, /^[A-Za-z]$/);
    assert.match(s.typoBefore, /^[A-Za-z]$/);
    assert.notEqual(s.typoBefore.toLowerCase(), s.char.toLowerCase());
    assert.equal(s.typoBefore === s.typoBefore.toUpperCase(), s.char === s.char.toUpperCase());
  }
  // 模拟执行:敲错字 → Backspace → 敲正确字,最终文本不变
  let out = '';
  for (const s of plan) {
    if (s.typoBefore) { out += s.typoBefore; out = out.slice(0, -1); }
    out += s.char;
  }
  assert.equal(out, text);
});

test('typingPlan: default typo rate is low (~2%)', () => {
  const text = 'abcdefghijklmnopqrstuvwxyz'.repeat(80);
  const plan = typingPlan(text, seeded(2));
  const rate = plan.filter((s) => s.typoBefore).length / plan.length;
  assert.ok(rate > 0.005 && rate < 0.045, `rate ${rate}`);
});

test('scrollPlan: steps sum exactly to deltaY, sign preserved, decelerating, timing 15–40ms', () => {
  for (const d of [1, 37, 100, 480, 1234, -800, 9999, -25000]) {
    for (let seed = 1; seed <= 20; seed++) {
      const plan = scrollPlan(d, seeded(seed));
      assert.equal(plan.reduce((s, x) => s + x.dy, 0), d, `d=${d} seed=${seed}`);
      for (const st of plan) {
        assert.ok(Number.isInteger(st.dy) && st.dy !== 0);
        assert.equal(Math.sign(st.dy), Math.sign(d));
        assert.ok(st.dt >= 15 && st.dt <= 40, String(st.dt));
      }
      assert.ok(plan.length <= 60);
    }
  }
  const plan = scrollPlan(1200, seeded(4));
  assert.ok(plan.length >= 8);
  assert.ok(Math.abs(plan[0].dy) > Math.abs(plan.at(-1).dy), 'later ticks smaller');
  for (const st of plan.slice(0, -1)) assert.ok(st.dy >= 50 && st.dy <= 140, String(st.dy));
  assert.deepEqual(scrollPlan(0, seeded(1)), []);
});

test('humanizeFromEnv / resolver', () => {
  for (const v of ['1', 'true', 'ON', 'yes']) assert.equal(humanizeFromEnv({ BROWSER_HUMANIZE: v }), true);
  for (const v of ['', '0', 'false', 'off', undefined]) assert.equal(humanizeFromEnv({ BROWSER_HUMANIZE: v }), false);
  setHumanizeResolver(() => true);
  assert.equal(humanizeActive(), true);
  setHumanizeResolver(() => { throw new Error('boom'); });
  assert.equal(humanizeActive(), false);
  setHumanizeResolver(null);
  assert.equal(humanizeActive(), humanizeFromEnv());
});

// Vintimated — tests for the photo-refresh core.
// Copyright (C) 2026 Vintimated contributors
//
// This program is free software: you can redistribute it and/or modify it
// under the terms of the GNU General Public License as published by the Free
// Software Foundation, either version 3 of the License, or (at your option)
// any later version.
//
// This program is distributed in the hope that it will be useful, but WITHOUT
// ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or
// FITNESS FOR A PARTICULAR PURPOSE. See the GNU General Public License for
// more details.
//
// You should have received a copy of the GNU General Public License along
// with this program. If not, see <https://www.gnu.org/licenses/>.

// Every promise the module makes about its numbers is pinned here: the bounds
// the specs live inside, the seeded replay, the geometry that has to cover a
// tilted source, and the pixel arithmetic itself. The core is pure on purpose,
// so all of it runs in Node with no canvas in sight.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const PhotoRefresh = require('../photo-refresh.js');
const { rng, generateSpec, geometry, applyPixels, MODES } = PhotoRefresh;

test('MODES lists the three modes in order', () => {
  assert.deepEqual(MODES, ['off', 'stealth', 'bordered']);
});

test('rng replays the same sequence for the same seed, all of it in [0, 1)', () => {
  const a = rng(42);
  const b = rng(42);
  for (let i = 0; i < 100; i++) {
    const v = a();
    assert.equal(v, b());
    assert.ok(v >= 0 && v < 1);
  }
});

test('rng walks a different sequence for a different seed', () => {
  const draw = (seed) => {
    const r = rng(seed);
    return Array.from({ length: 10 }, () => r());
  };
  assert.notDeepEqual(draw(42), draw(43));
});

test("generateSpec('off') is disabled", () => {
  assert.equal(generateSpec('off', rng(1)).enabled, false);
});

test('generateSpec replays the same spec for the same seed and differs across seeds', () => {
  assert.deepEqual(generateSpec('stealth', rng(7)), generateSpec('stealth', rng(7)));
  assert.notDeepEqual(generateSpec('stealth', rng(7)), generateSpec('stealth', rng(8)));
});

test('generateSpec stays inside the photo-refresh bounds over 50 seeds per mode', () => {
  for (const mode of MODES) {
    for (let seed = 1; seed <= 50; seed++) {
      const spec = generateSpec(mode, rng(seed));
      const where = mode + ' seed ' + seed;

      assert.ok(Math.abs(spec.angleRad) <= 0.0209, where + ' angleRad');
      assert.ok(spec.scale >= 1.02 && spec.scale <= 1.05, where + ' scale');

      assert.equal(spec.channelShift.length, 3, where + ' channelShift length');
      for (const shift of spec.channelShift) {
        assert.ok(Number.isInteger(shift), where + ' channelShift integer');
        assert.ok(Math.abs(shift) <= 6, where + ' channelShift bound');
      }

      assert.ok(Number.isInteger(spec.noiseAmp), where + ' noiseAmp integer');
      assert.ok(spec.noiseAmp >= 1 && spec.noiseAmp <= 3, where + ' noiseAmp bound');

      assert.equal(spec.enabled, mode !== 'off', where + ' enabled');

      if (mode === 'bordered') {
        assert.ok(spec.border !== null, where + ' border');
        assert.ok(spec.border.widthPct >= 0.010 && spec.border.widthPct <= 0.020, where + ' widthPct');
        assert.deepEqual(spec.border.rgba, [255, 255, 255, 255], where + ' rgba');
      } else {
        assert.equal(spec.border, null, where + ' border');
      }
    }
  }
});

test('geometry covers the rotated source and centers the draw', () => {
  const g = geometry(4000, 3000, 0.02, 1.05);
  assert.ok(g.drawW >= 4000);
  assert.ok(g.drawH >= 3000);
  assert.equal(g.offsetX, (4000 - g.drawW) / 2);
  assert.equal(g.offsetY, (3000 - g.drawH) / 2);
});

test('geometry is exact with no tilt and no scale', () => {
  assert.deepEqual(geometry(100, 50, 0, 1), { drawW: 100, drawH: 50, offsetX: 0, offsetY: 0 });
});

// A hand-built spec, so the pixel arithmetic is measured against a plan the
// test chose rather than against whatever the dice produced.
function spec(overrides) {
  return Object.assign({
    enabled: true,
    angleRad: 0,
    scale: 1,
    channelShift: [0, 0, 0],
    noiseAmp: 0,
    border: null
  }, overrides);
}

test('applyPixels shifts R and G per pixel, leaves B and A alone, and returns nothing', () => {
  const data = new Uint8ClampedArray([100, 100, 100, 200, 50, 60, 70, 80]);
  const result = applyPixels(data, spec({ channelShift: [5, -5, 0] }), rng(1));
  assert.equal(result, undefined);
  assert.deepEqual([...data], [105, 95, 100, 200, 55, 55, 70, 80]);
});

test('applyPixels clamps at 255 and 0', () => {
  const data = new Uint8ClampedArray([253, 2, 10, 255]);
  applyPixels(data, spec({ channelShift: [5, -5, 0] }), rng(1));
  assert.deepEqual([...data], [255, 0, 10, 255]);
});

test('applyPixels noise stays within ±noiseAmp and replays per seed', () => {
  const base = [100, 100, 100, 255];
  const one = new Uint8ClampedArray(base);
  const two = new Uint8ClampedArray(base);
  const other = new Uint8ClampedArray(base);
  const s = spec({ noiseAmp: 3 });

  applyPixels(one, s, rng(9));
  applyPixels(two, s, rng(9));
  applyPixels(other, s, rng(10));

  assert.deepEqual([...one], [...two]);
  assert.notDeepEqual([...one], [...other]);
  for (let c = 0; c < 3; c++) {
    assert.ok(Math.abs(one[c] - base[c]) <= 3);
  }
});

test("applyPixels leaves the photo untouched when the spec is disabled", () => {
  const data = new Uint8ClampedArray([100, 100, 100, 255]);
  applyPixels(data, spec({ enabled: false, channelShift: [5, -5, 0], noiseAmp: 3 }), rng(1));
  assert.deepEqual([...data], [100, 100, 100, 255]);
});

// The browser adapter: refresh() decides whether to do anything at all, hands
// the work to decode and draw, and swallows whatever goes wrong — a relist
// must never fail or slow over a photo. Node has neither a canvas nor
// createImageBitmap, so both halves are stubbed and the tests hold refresh to
// its promises about the hand-offs: which dep is called, with what, and what
// comes back out when one of them throws.

test("refresh with mode 'off' returns the same blob and never decodes it", async () => {
  const blob = new Blob(['original']);
  const calls = [];
  const result = await PhotoRefresh.refresh(blob, { mode: 'off' }, {
    decode: async () => {
      calls.push('decode');
      return { width: 4, height: 3 };
    },
    draw: async () => {
      calls.push('draw');
      return new Blob(['drawn']);
    },
  });
  assert.equal(result, blob);
  assert.deepEqual(calls, []);
});

test('refresh returns the original blob when decode throws, and never draws', async () => {
  const blob = new Blob(['original']);
  let drew = false;
  const result = await PhotoRefresh.refresh(blob, { mode: 'stealth' }, {
    decode: async () => {
      throw new Error('no bitmap');
    },
    draw: async () => {
      drew = true;
      return new Blob(['drawn']);
    },
  });
  assert.equal(result, blob);
  assert.equal(drew, false);
});

test('refresh returns the original blob when draw throws', async () => {
  const blob = new Blob(['original']);
  const result = await PhotoRefresh.refresh(blob, { mode: 'bordered' }, {
    decode: async () => ({ width: 4, height: 3 }),
    draw: async () => {
      throw new Error('the canvas is gone');
    },
  });
  assert.equal(result, blob);
});

test('refresh draws the decoded bitmap with an enabled spec and returns the drawn blob', async () => {
  for (const [mode, bordered] of [['stealth', false], ['bordered', true]]) {
    const blob = new Blob(['original']);
    const drawn = new Blob(['drawn']);
    const bitmap = { width: 4, height: 3 };
    let seen = null;
    const result = await PhotoRefresh.refresh(blob, { mode, seed: 5 }, {
      decode: async got => {
        assert.equal(got, blob);
        return bitmap;
      },
      draw: async (map, got, options) => {
        assert.equal(map, bitmap);
        assert.equal(options.mode, mode);
        seen = got;
        return drawn;
      },
    });
    assert.equal(result, drawn);
    assert.equal(seen.enabled, true);
    assert.equal(seen.border !== null, bordered);
  }
});

test('refresh replays the same spec for the same explicit seed', async () => {
  const seen = [];
  for (let i = 0; i < 2; i++) {
    await PhotoRefresh.refresh(new Blob(['original']), { mode: 'bordered', seed: 42 }, {
      decode: async () => ({ width: 4, height: 3 }),
      draw: async (map, got) => {
        seen.push(got);
        return new Blob(['drawn']);
      },
    });
  }
  assert.deepEqual(seen[0], seen[1]);
});

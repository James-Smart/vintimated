// Vintimated — the same photo, never quite the same photo twice.
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

// A relist whose photos arrive unchanged reads to Vinted as the same listing
// twice, so the copy has to wear a photo that is not quite the original: tilted
// a whisker, scaled a whisker, its channels nudged and its grain dusted with
// noise — moves no buyer will notice and no duplicate detector can ignore.
//
// This file is the arithmetic and the canvas that draws it. It decides what to
// do (generateSpec), where the drawing goes (geometry) and what happens to the
// pixels (applyPixels); refresh() is the one door callers use, and behind it
// the browser's own canvas turns those decisions into a picture. Everything
// except that canvas is pure — no DOM — so it runs in Node as comfortably as
// on a page, which is what the tests lean on: refresh() takes its decoder and
// its drawer as arguments, and defaults to the browser's own.
//
// Loaded as a plain script before the caller's own, the way store.js is. Node
// reaches the very same object through require(), at the bottom of the file.

const PhotoRefresh = (() => {
  'use strict';

  // The three ways a relist can treat its photos. 'off' is the seller's choice
  // to leave them alone; 'stealth' changes them invisibly; 'bordered' adds a
  // hairline white frame on top, for photos where invisibility is not enough.
  const MODES = ['off', 'stealth', 'bordered'];

  // The bounds every generated spec lives inside, and the tests hold it to.
  // A tilt of 1.2° and a whisker over 4% of scale is the most a photo can move
  // before a buyer comparing two listings starts to see the seam; the channel
  // shifts and the grain are kept small for the same reason.
  const MAX_ANGLE_RAD = 0.0209; // 1.2°, in radians
  const MIN_SCALE = 1.02;
  const MAX_SCALE = 1.05;
  const MAX_CHANNEL_SHIFT = 6;
  const MIN_NOISE_AMP = 1;
  const MAX_NOISE_AMP = 3;
  const MIN_BORDER_PCT = 0.010;
  const MAX_BORDER_PCT = 0.020;
  const BORDER_RGBA = [255, 255, 255, 255];

  // The dice. mulberry32 — small, seeded, and good enough for tilt and grain.
  // The same seed replays the same choices exactly, so a photo refreshed from a
  // known seed can be reproduced to the identical pixel. Given no seed there is
  // nothing to replay, and Math.random will do.
  function rng(seed) {
    if (seed === undefined) return Math.random;
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // A whole number in [min, max], both ends included — channel shifts and
  // noise amplitudes are integers, because there is no such thing as half a
  // channel step.
  function randInt(r, min, max) {
    return min + Math.floor(r() * (max - min + 1));
  }

  // The plan for one photo: how far to tilt and scale it, how far to nudge its
  // channels, how much grain to add, and whether to frame it.
  //
  //   { enabled, angleRad, scale, channelShift: [r, g, b], noiseAmp,
  //     border: null | { widthPct, rgba: [r, g, b, a] } }
  //
  // The mode decides only what the seller asked for — off, stealth or framed.
  // The numbers are drawn the same way whatever the mode, so even an 'off'
  // spec carries the same bounds and simply never gets applied.
  function generateSpec(mode, r) {
    return {
      enabled: mode !== 'off',
      angleRad: (r() * 2 - 1) * MAX_ANGLE_RAD,
      scale: MIN_SCALE + r() * (MAX_SCALE - MIN_SCALE),
      channelShift: [
        randInt(r, -MAX_CHANNEL_SHIFT, MAX_CHANNEL_SHIFT),
        randInt(r, -MAX_CHANNEL_SHIFT, MAX_CHANNEL_SHIFT),
        randInt(r, -MAX_CHANNEL_SHIFT, MAX_CHANNEL_SHIFT)
      ],
      noiseAmp: randInt(r, MIN_NOISE_AMP, MAX_NOISE_AMP),
      border: mode === 'bordered'
        ? {
            widthPct: MIN_BORDER_PCT + r() * (MAX_BORDER_PCT - MIN_BORDER_PCT),
            rgba: BORDER_RGBA.slice()
          }
        : null
    };
  }

  // Where the drawing goes. A source of w×h turned through θ covers a diamond
  // wider than itself: w·|cos θ| + h·|sin θ| across and w·|sin θ| + h·|cos θ|
  // down — the corners sweep out further than the edges. The scale on top
  // gives the tilt room to breathe. The draw is centered on the source, so the
  // offsets come out negative: the picture sits in the middle of an oversized
  // source, cropped back to w×h afterwards, and no edge of the original can
  // show at an angle.
  function geometry(width, height, angleRad, scale) {
    const cos = Math.abs(Math.cos(angleRad));
    const sin = Math.abs(Math.sin(angleRad));
    const drawW = (width * cos + height * sin) * scale;
    const drawH = (width * sin + height * cos) * scale;
    return {
      drawW,
      drawH,
      offsetX: (width - drawW) / 2,
      offsetY: (height - drawH) / 2
    };
  }

  // The pixels, in place, and nothing back. R, G and B each take the spec's
  // channel shift and a whole-number grain in ±noiseAmp, then are clamped to
  // what a channel can hold. Alpha is never touched — a photo that changed
  // opacity would be a photo the buyer can see through.
  //
  // The grain is drawn even where it amounts to nothing (noiseAmp 0), so one
  // seed moves the stream the same way whatever the spec carries. A disabled
  // spec is the seller's 'off': the buffer is left exactly as it arrived.
  function applyPixels(data, spec, r) {
    if (!spec.enabled) return;
    for (let i = 0; i < data.length; i += 4) {
      for (let c = 0; c < 3; c++) {
        const noise = Math.floor(r() * (2 * spec.noiseAmp + 1)) - spec.noiseAmp;
        const v = data[i + c] + spec.channelShift[c] + noise;
        data[i + c] = v < 0 ? 0 : v > 255 ? 255 : v;
      }
    }
  }

  // The canvas half of a refresh. The picture is rebuilt here from the core's
  // decisions — drawn to cover the frame at whatever tilt and scale the spec
  // carries, dusted with its grain, framed if the spec asks for it — then
  // shrunk to size and handed back as JPEG. Nothing here decides anything.
  function drawOnCanvas(bitmap, spec, options) {
    const width = bitmap.width;
    const height = bitmap.height;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');

    // Cover-fill: geometry sizes the draw so that, turned through the spec's
    // angle about the centre, it reaches every corner of the frame. The
    // picture overhangs on all four sides and is cropped back to width×height,
    // so no tilted edge of the original can show.
    const g = geometry(width, height, spec.angleRad, spec.scale);
    ctx.translate(width / 2, height / 2);
    ctx.rotate(spec.angleRad);
    ctx.drawImage(bitmap, g.offsetX - width / 2, g.offsetY - height / 2, g.drawW, g.drawH);
    // The tilt is spent; the frame and the pixels below are square.
    ctx.setTransform(1, 0, 0, 1, 0, 0);

    // The grain and the channel nudges, from a stream seeded the same way as
    // the spec above, so a photo refreshed from a known seed replays to the
    // identical pixel.
    const image = ctx.getImageData(0, 0, width, height);
    applyPixels(image.data, spec, rng(options.seed));
    ctx.putImageData(image, 0, 0);

    // The frame goes on after the grain, so the border is a clean white line
    // rather than one the noise has dusted. Its width is the spec's fraction
    // of the short edge, drawn inside the photo's own outline.
    if (spec.border) {
      const band = Math.max(1, Math.round(Math.min(width, height) * spec.border.widthPct));
      ctx.strokeStyle = `rgba(${spec.border.rgba.join(',')})`;
      ctx.lineWidth = band;
      ctx.strokeRect(band / 2, band / 2, width - band, height - band);
    }

    // Nothing larger than maxEdge leaves the device: a photo that came in at
    // four thousand pixels is drawn at four thousand and shrinks on the way
    // out, which keeps the transform at source quality and the upload at a
    // size worth uploading.
    let out = canvas;
    const longest = Math.max(width, height);
    if (longest > options.maxEdge) {
      const ratio = options.maxEdge / longest;
      out = document.createElement('canvas');
      out.width = Math.max(1, Math.round(width * ratio));
      out.height = Math.max(1, Math.round(height * ratio));
      out.getContext('2d').drawImage(canvas, 0, 0, out.width, out.height);
    }

    return new Promise((resolve, reject) => {
      out.toBlob(
        blob => (blob ? resolve(blob) : reject(new Error('JPEG encode failed'))),
        'image/jpeg',
        options.quality,
      );
    });
  }

  // The one door callers use. 'off' is the seller's choice to leave the photo
  // alone, and it is answered with the very blob it was handed. Otherwise the
  // photo goes out through decode and draw — the browser's own bitmap and
  // canvas unless the caller brings its own, which is how the tests stand in
  // for a canvas Node does not have.
  //
  // Nothing that goes wrong in there is allowed to reach the caller: a photo
  // that cannot be decoded, drawn or encoded is uploaded exactly as it
  // arrived. A relist must never fail — or pause to worry — over a photo.
  async function refresh(blob, options = {}, deps = {}) {
    try {
      if (options.mode === 'off') return blob;
      const decode = deps.decode || (source => createImageBitmap(source));
      const draw = deps.draw || drawOnCanvas;
      const settings = {
        mode: options.mode,
        seed: options.seed,
        maxEdge: options.maxEdge ?? 2048,
        quality: options.quality ?? 0.92,
      };
      const bitmap = await decode(blob);
      const spec = generateSpec(options.mode, rng(options.seed));
      return await draw(bitmap, spec, settings);
    } catch (_) {
      return blob;
    }
  }

  return { rng, generateSpec, geometry, applyPixels, refresh, MODES };
})();

// require() in Node hands over the same object the extension reads off the
// const above; without a module to hand it to, the line is simply not taken.
if (typeof module !== 'undefined') module.exports = PhotoRefresh;

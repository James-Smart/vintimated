// Vintimated — tests for the bulk queue state machine.
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

// The queue's whole promise is order and restraint: the ids walk one after
// another, a gap is waited between two items that run and never before one
// that will not, a stop lets the item in hand finish, a block or a hard
// rejection halts the walk, and an ordinary failure is just one item's bad
// day. Every door the queue uses is injected and recorded here — the order
// runOne sees, the gaps nextGap hands out, the ms wait is given, the answers
// isBlocked and confirmStart give — so the sequencing is measured, never
// slept through, and no test waits on a clock.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const BulkQueue = require('../bulk-queue.js');

// One harness behind the tests: recording stubs for all five doors and the
// three callbacks, with one behaviour swapped out at a time (stop mid-item,
// block before an item, reject on an item). nextGap hands out 111, 222, 333
// so every wait can be tied back to the gap that produced it.
function harness(behaviour = {}) {
  const calls = {
    order: [],     // ids runOne saw, in order
    gaps: [],      // values nextGap handed out
    waits: [],     // ms wait was given
    blocked: [],   // completed-item count at each isBlocked ask
    confirm: [],   // counts confirmStart was given
    progress: [],  // onProgress events
    itemDone: [],  // onItemDone events
  };
  const gaps = [111, 222, 333];

  const queue = BulkQueue.create({
    ids: behaviour.ids || [1, 2, 3],
    runOne: async (id) => {
      calls.order.push(id);
      if (behaviour.runOne) await behaviour.runOne(id, queue);
    },
    nextGap: () => {
      const gap = gaps[calls.gaps.length];
      calls.gaps.push(gap);
      return gap;
    },
    wait: async (ms) => {
      calls.waits.push(ms);
      if (behaviour.wait) await behaviour.wait(ms, queue);
    },
    isBlocked: async () => {
      calls.blocked.push(calls.order.length);
      return behaviour.isBlocked ? behaviour.isBlocked(calls.blocked.length) : false;
    },
  });

  return {
    calls,
    queue,
    run: () => queue.run({
      confirmStart: async (count) => {
        calls.confirm.push(count);
        return behaviour.confirmStart ? behaviour.confirmStart(count) : true;
      },
      onProgress: (event) => calls.progress.push(event),
      onItemDone: (event) => calls.itemDone.push(event),
    }),
  };
}

test('runs the ids in order with one gap between each pair, asking once before anything runs', async () => {
  const h = harness();
  const result = await h.run();

  assert.deepEqual(h.calls.order, [1, 2, 3]);
  assert.deepEqual(h.calls.gaps, [111, 222]);   // nextGap: n−1 of them, one per pair
  assert.deepEqual(h.calls.waits, [111, 222]);  // each wait got exactly its gap's value
  assert.deepEqual(h.calls.confirm, [3]);       // exactly once, with the total

  assert.deepEqual(result, {
    status: 'done', completed: [1, 2, 3], failed: [], pending: [],
  });

  // Progress is 1-based: index is the item number being started (1..total),
  // ready to drop into a '{0}/{1}' counter. Each item reports done exactly
  // once, ok with no error.
  assert.deepEqual(h.calls.progress, [
    { index: 1, total: 3, id: 1 },
    { index: 2, total: 3, id: 2 },
    { index: 3, total: 3, id: 3 },
  ]);
  assert.deepEqual(h.calls.itemDone, [
    { id: 1, ok: true, error: null },
    { id: 2, ok: true, error: null },
    { id: 3, ok: true, error: null },
  ]);
});

test('stop() during an item lets it finish, then leaves the rest pending', async () => {
  const h = harness({
    runOne: async (id, queue) => {
      if (id === 2) queue.stop();
    },
  });
  const result = await h.run();

  assert.deepEqual(h.calls.order, [1, 2]);  // item 2 finished; 3 never started
  assert.deepEqual(result, {
    status: 'stopped', completed: [1, 2], failed: [], pending: [3],
  });

  // Gaps sit between items that run only — nothing is waited out before item 3.
  assert.deepEqual(h.calls.waits, [111]);

  // An id that never started sees no callback at all; it is only pending.
  assert.deepEqual(h.calls.progress.map((e) => e.id), [1, 2]);
  assert.deepEqual(h.calls.itemDone.map((e) => e.id), [1, 2]);
});

test('a block before an item halts the queue with that id and the rest pending', async () => {
  const h = harness({
    isBlocked: (ask) => ask === 3,  // false for the first two items, true before the third
  });
  const result = await h.run();

  assert.deepEqual(h.calls.blocked, [0, 1, 2]);  // one ask per item, before it starts
  assert.deepEqual(h.calls.order, [1, 2]);
  assert.deepEqual(result, {
    status: 'halted', completed: [1, 2], failed: [], pending: [3],
  });

  // The gap before the blocked item is not waited out either.
  assert.deepEqual(h.calls.waits, [111]);
  assert.deepEqual(h.calls.progress.map((e) => e.id), [1, 2]);
  assert.deepEqual(h.calls.itemDone.map((e) => e.id), [1, 2]);
});

test('a soft runOne failure lands in failed and the queue walks on', async () => {
  const h = harness({
    runOne: async (id) => {
      if (id === 2) throw new Error('listing is gone');
    },
  });
  const result = await h.run();

  assert.deepEqual(h.calls.order, [1, 2, 3]);
  assert.equal(result.status, 'done');
  assert.deepEqual(result.completed, [1, 3]);
  assert.equal(result.failed.length, 1);
  assert.equal(result.failed[0].id, 2);
  assert.equal(result.failed[0].error.message, 'listing is gone');
  assert.deepEqual(result.pending, []);

  // The failed item reports done with ok:false and its error — and does not
  // stop the next item reporting done after it.
  assert.deepEqual(h.calls.itemDone, [
    { id: 1, ok: true, error: null },
    { id: 2, ok: false, error: result.failed[0].error },
    { id: 3, ok: true, error: null },
  ]);

  // The walk keeps its gaps all the way through.
  assert.deepEqual(h.calls.waits, [111, 222]);
});

test('a hard runOne failure halts like a block, leaving the rest pending', async () => {
  const hard = new Error('vinted refused');
  hard.hard = true;
  const h = harness({
    runOne: async (id) => {
      if (id === 2) throw hard;
    },
  });
  const result = await h.run();

  assert.deepEqual(h.calls.order, [1, 2]);  // item 3 is never attempted

  // The failing item is still one item's failure — recorded in failed — and
  // the halt only leaves everything after it untouched.
  assert.deepEqual(result, {
    status: 'halted', completed: [1], failed: [{ id: 2, error: hard }], pending: [3],
  });

  assert.deepEqual(h.calls.waits, [111]);
  assert.deepEqual(h.calls.itemDone.map((e) => e.id), [1, 2]);  // 3 never started
});

test('confirmStart seeing false stops before anything runs, and is asked exactly once', async () => {
  const h = harness({
    confirmStart: async () => false,
  });
  const result = await h.run();

  assert.deepEqual(h.calls.confirm, [3]);  // once, with the total — and no more
  assert.deepEqual(h.calls.order, []);     // nothing ran
  assert.deepEqual(result, {
    status: 'stopped', completed: [], failed: [], pending: [1, 2, 3],
  });

  // A queue stopped before start speaks to no item at all.
  assert.deepEqual(h.calls.progress, []);
  assert.deepEqual(h.calls.itemDone, []);
  assert.deepEqual(h.calls.blocked, []);
  assert.deepEqual(h.calls.gaps, []);
});

test('stop() before run() is asked once, runs nothing, and leaves every id pending', async () => {
  const h = harness();
  h.queue.stop();
  const result = await h.run();

  // Even a queue stopped before it began asks its one question first.
  assert.deepEqual(h.calls.confirm, [3]);
  assert.deepEqual(h.calls.order, []);
  assert.deepEqual(result, {
    status: 'stopped', completed: [], failed: [], pending: [1, 2, 3],
  });
  assert.deepEqual(h.calls.progress, []);
  assert.deepEqual(h.calls.itemDone, []);
});

test('stop() during a gap keeps the next item from starting', async () => {
  const h = harness({
    wait: async (ms, queue) => {
      if (ms === 222) queue.stop();  // the second gap — the one before item 3
    },
  });
  const result = await h.run();

  assert.deepEqual(h.calls.order, [1, 2]);  // the gap before item 3 is where stop landed
  assert.deepEqual(result, {
    status: 'stopped', completed: [1, 2], failed: [], pending: [3],
  });
  assert.deepEqual(h.calls.progress.map((e) => e.id), [1, 2]);
  assert.deepEqual(h.calls.itemDone.map((e) => e.id), [1, 2]);
});

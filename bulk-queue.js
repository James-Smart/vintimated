// Vintimated — bulk relisting, one item at a time.
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

// A hundred relists that behave like one: the ids walk in order, each item
// gets exactly one attempt, and the pause between relists is borrowed rather
// than kept — wait and nextGap arrive as arguments, so the queue owns no
// clock of its own and the tests can walk the whole queue in a millisecond.
//
// Two things may stop the walk, and both leave the same careful mess. A
// seller may call stop(): the item in hand finishes, nothing new starts, and
// the ids not yet touched are reported pending. Vinted may refuse the walk:
// isBlocked() asked before an item, or a runOne rejection carrying .hard,
// halts the queue the same way — remaining ids untouched. Anything short of
// a hard rejection is one item's bad day: it lands in failed and the walk
// goes on.
//
// Loaded as a plain script before the caller's own, the way photo-refresh.js
// is. Node reaches the very same object through require(), at the bottom.

const BulkQueue = (() => {
  'use strict';

  // The queue's five doors, all injected: the ids to walk, the one item's
  // work (runOne), the dice for the pause between items (nextGap) and the
  // pause itself (wait), and the question whether Vinted is still listening
  // (isBlocked). run(), below, takes the caller's three callbacks.
  function create(options) {
    const ids = options.ids.slice();
    const runOne = options.runOne;
    const nextGap = options.nextGap;
    const wait = options.wait;
    const isBlocked = options.isBlocked;

    // stop() only raises a hand. The queue notices before each item starts
    // and again after each gap — so a stop that lands mid-item lets that item
    // finish, and one that lands mid-gap keeps the next item from ever
    // starting. Sticky for the instance: a created queue is one walk.
    let stopRequested = false;

    function stop() {
      stopRequested = true;
    }

    // The result is shaped in one place: everything before `started` was
    // attempted (and either completed or failed); from `started` on nothing
    // was, so those ids are only ever pending.
    function result(status, completed, failed, started) {
      return { status, completed, failed, pending: ids.slice(started) };
    }

    // confirmStart is required — the question before anything runs. The two
    // callbacks are not: onProgress is told before each item that actually
    // starts ({ index: 1-based item number, total, id }), onItemDone after
    // every attempted one ({ id, ok, error: the rejection or null }).
    async function run(hooks) {
      const onProgress = hooks.onProgress;
      const onItemDone = hooks.onItemDone;
      const completed = [];
      const failed = [];

      // The one question, asked exactly once per walk before anything runs —
      // count in hand, even when the answer is no.
      const confirmed = await hooks.confirmStart(ids.length);
      if (!confirmed) return result('stopped', completed, failed, 0);

      for (let i = 0; i < ids.length; i++) {
        if (stopRequested) return result('stopped', completed, failed, i);

        // One ask per item, before it starts: a refusal means this id and
        // everything after it stay untouched.
        if (await isBlocked()) return result('halted', completed, failed, i);

        // The gap belongs between two items that run, never before one that
        // will not — n−1 of them across a whole walk. A stop landing during
        // the wait is honoured before the next item can start.
        if (i > 0) {
          await wait(nextGap());
          if (stopRequested) return result('stopped', completed, failed, i);
        }

        const id = ids[i];
        if (onProgress) onProgress({ index: i + 1, total: ids.length, id });

        try {
          await runOne(id);
          completed.push(id);
          if (onItemDone) onItemDone({ id, ok: true, error: null });
        } catch (error) {
          failed.push({ id, error });
          if (onItemDone) onItemDone({ id, ok: false, error });
          // A hard rejection is Vinted refusing, not one item failing: halt
          // like a block, leaving everything after this id untouched.
          if (error && error.hard === true) return result('halted', completed, failed, i + 1);
        }
      }

      return result('done', completed, failed, ids.length);
    }

    return { run, stop };
  }

  return { create };
})();

// require() in Node hands over the same object the extension reads off the
// const above; without a module to hand it to, the line is simply not taken.
if (typeof module !== 'undefined') module.exports = BulkQueue;

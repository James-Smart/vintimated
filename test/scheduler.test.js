// Vintimated — tests for the schedule core.
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

// Every promise the schedule makes about time is pinned here: the window's
// half-open edges, the gap's bounds, the cap that never goes negative, the
// one decision a single moment can earn, and the state machine that
// remembers where a run has got to. The core is pure on purpose — every
// `now` is plain milliseconds and the dice arrive as an argument — so a week
// of shop hours fits into a sentence and no test ever waits on a clock.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const Scheduler = require('../scheduler.js');

// One ordinary week, pointed at from the seller's own clock: every time here
// is built with the Date constructor, so 'the 19th at 18:00' is the same
// local moment wherever the suite runs, and the weekday of that first day is
// read back off the date rather than trusted to a calendar.
const ts = (dayOffset, h, min) => new Date(2026, 9, 19 + dayOffset, h, min).getTime();
const weekday = (dayOffset) => new Date(2026, 9, 19 + dayOffset).getDay();

const WEEK = 7 * 24 * 60 * 60 * 1000;

// The schedule every test starts from: 18:00–21:00 on the first day's
// weekday, three items a day, gaps of one to two minutes, a period of a week.
function defn(overrides) {
  return {
    days: [weekday(0)],
    fromMin: 18 * 60,
    toMin: 21 * 60,
    endsAt: ts(30, 0, 0),
    gapMinMs: 60000,
    gapMaxMs: 120000,
    maxPerDay: 3,
    ageThresholdDays: 7,
    scope: 'all',
    periodMs: WEEK,
    ...overrides,
  };
}

// The decision context a caller builds from state. Each gate test shuts one
// door at a time; a missing nextDueAt means no gap is pending.
const ctx = (overrides) => ({
  lastFireAt: null,
  todayCount: 0,
  pausedUntil: null,
  nextDueAt: null,
  ...overrides,
});

test('isWithinWindow: 18:00-21:00 on an allowed day is inside', () => {
  const d = defn();
  assert.equal(Scheduler.isWithinWindow(d, ts(0, 18, 0)), true);
  assert.equal(Scheduler.isWithinWindow(d, ts(0, 19, 30)), true);
  assert.equal(Scheduler.isWithinWindow(d, ts(0, 20, 59)), true);
});

test('isWithinWindow: 17:59 and 21:00 are outside', () => {
  const d = defn();
  assert.equal(Scheduler.isWithinWindow(d, ts(0, 17, 59)), false);
  assert.equal(Scheduler.isWithinWindow(d, ts(0, 21, 0)), false);
});

test('isWithinWindow: an allowed hour on a disallowed day is outside', () => {
  assert.equal(Scheduler.isWithinWindow(defn(), ts(1, 19, 0)), false);
});

test('isWithinWindow: at and after endsAt is outside even in the window', () => {
  const d = defn({ endsAt: ts(0, 19, 30) });
  assert.equal(Scheduler.isWithinWindow(d, ts(0, 19, 29)), true);
  assert.equal(Scheduler.isWithinWindow(d, ts(0, 19, 30)), false);
  assert.equal(Scheduler.isWithinWindow(d, ts(0, 19, 31)), false);
});

test('nextGapMs: fifty draws at both extremes stay inside [gapMinMs, gapMaxMs]', () => {
  const d = defn();
  for (const rand of [() => 0, () => 0.999]) {
    for (let i = 0; i < 50; i++) {
      const gap = Scheduler.nextGapMs(d, rand);
      assert.ok(Number.isInteger(gap), 'gap is whole milliseconds');
      assert.ok(gap >= d.gapMinMs && gap <= d.gapMaxMs, 'gap inside the bounds');
    }
  }
  assert.equal(Scheduler.nextGapMs(d, () => 0), d.gapMinMs);
  assert.equal(Scheduler.nextGapMs(d, () => 0.5), 90000);
});

test('capacityLeft: counts below, at and over the cap stay honest', () => {
  const d = defn({ maxPerDay: 3 });
  assert.equal(Scheduler.capacityLeft(d, 0), 3);
  assert.equal(Scheduler.capacityLeft(d, 2), 1);
  assert.equal(Scheduler.capacityLeft(d, 3), 0);
  assert.equal(Scheduler.capacityLeft(d, 4), 0);
  assert.ok(Scheduler.capacityLeft(d, 99) >= 0);
});

test('decide: period-over waits with nothing to wait for', () => {
  const now = ts(0, 19, 0);
  const d = defn({ endsAt: now });
  assert.deepEqual(Scheduler.decide(d, now, ctx({ nextDueAt: now })), {
    action: 'wait',
    reason: 'period-over',
    waitMs: 0,
  });
});

test('decide: paused waits exactly until pausedUntil', () => {
  const now = ts(0, 19, 0);
  assert.deepEqual(
    Scheduler.decide(defn(), now, ctx({ nextDueAt: now, pausedUntil: now + 45000 })),
    { action: 'wait', reason: 'paused', waitMs: 45000 }
  );
});

test('decide: outside-window waits exactly until the next window start', () => {
  const now = ts(0, 17, 0);
  const res = Scheduler.decide(defn(), now, ctx({ nextDueAt: now }));
  assert.equal(res.action, 'wait');
  assert.equal(res.reason, 'outside-window');
  assert.equal(now + res.waitMs, ts(0, 18, 0));
  assert.equal(res.waitMs, 60 * 60 * 1000);
});

test('decide: outside-window past closing waits for the next allowed day', () => {
  const now = ts(0, 22, 0);
  const res = Scheduler.decide(defn(), now, ctx({ nextDueAt: now }));
  assert.equal(res.reason, 'outside-window');
  assert.equal(now + res.waitMs, ts(7, 18, 0));
});

test('decide: gap waits exactly until nextDueAt, the draw never redone', () => {
  const now = ts(0, 19, 0);
  assert.deepEqual(
    Scheduler.decide(defn(), now, ctx({ nextDueAt: now + 12345 })),
    { action: 'wait', reason: 'gap', waitMs: 12345 }
  );
});

test("decide: cap waits exactly until the next day's window start", () => {
  const now = ts(0, 19, 0);
  const res = Scheduler.decide(
    defn({ days: [weekday(0), weekday(1)], maxPerDay: 3 }),
    now,
    ctx({ nextDueAt: now, todayCount: 3 })
  );
  assert.equal(res.action, 'wait');
  assert.equal(res.reason, 'cap');
  assert.equal(now + res.waitMs, ts(1, 18, 0));

  // With tomorrow disallowed the wait lands on the next allowed day instead —
  // the cap is only ever spent at an hour the window would have opened.
  const week = Scheduler.decide(defn({ maxPerDay: 3 }), now, ctx({ nextDueAt: now, todayCount: 3 }));
  assert.equal(week.reason, 'cap');
  assert.equal(now + week.waitMs, ts(7, 18, 0));
});

test('decide: fire when every gate is open', () => {
  const now = ts(0, 19, 0);
  assert.deepEqual(
    Scheduler.decide(defn(), now, ctx({ nextDueAt: now, todayCount: 1, lastFireAt: now - 90000 })),
    { action: 'fire', reason: 'fire', waitMs: 0 }
  );
});

test('decide: the gates are reported in priority order', () => {
  const now = ts(0, 19, 0);
  const busy = { lastFireAt: null, pausedUntil: now + 1000, nextDueAt: now + 1000, todayCount: 99 };

  // Every gate shut at once: the period end outranks them all.
  assert.equal(Scheduler.decide(defn({ endsAt: now }), now, busy).reason, 'period-over');
  // The period still open, the pause comes next.
  assert.equal(Scheduler.decide(defn(), now, busy).reason, 'paused');
  // The pause gone, a shut window outranks a pending gap.
  assert.equal(Scheduler.decide(defn(), ts(0, 22, 0), { ...busy, pausedUntil: null }).reason, 'outside-window');
  // The window open again, the gap is next.
  assert.equal(Scheduler.decide(defn(), now, { ...busy, pausedUntil: null }).reason, 'gap');
  // The gap spent, the cap closes the day.
  assert.equal(Scheduler.decide(defn(), now, { ...busy, pausedUntil: null, nextDueAt: now }).reason, 'cap');
  // Everything open.
  assert.equal(Scheduler.decide(defn(), now, { ...busy, pausedUntil: null, nextDueAt: now, todayCount: 0 }).reason, 'fire');
});

test('decide: a three-day gap is one fire, never a replay of missed slots', () => {
  const now = ts(3, 19, 0);
  const res = Scheduler.decide(defn({ days: [weekday(0), weekday(3)], maxPerDay: 5 }), now, {
    lastFireAt: ts(0, 19, 0),
    todayCount: 0,
    pausedUntil: null,
    nextDueAt: ts(0, 19, 0) + 90000, // due long ago and drawn only once
  });
  // One decision, one fire: there is no slot list to walk and nothing to backfill.
  assert.deepEqual(res, { action: 'fire', reason: 'fire', waitMs: 0 });
});

test('transition: start runs with the period end and the first fire due at once', () => {
  const d = defn();
  const now = ts(0, 18, 0);
  const state = Scheduler.transition(Scheduler.deserialize(null), { type: 'start', defn: d, now });
  assert.equal(state.status, 'running');
  assert.equal(state.startedAt, now);
  assert.equal(state.endsAt, now + d.periodMs);
  assert.equal(state.nextDueAt, now);
  assert.deepEqual(state.defn, d);
});

test('transition: fire keeps the books and rolls the day', () => {
  let state = Scheduler.transition(Scheduler.deserialize(null), {
    type: 'start',
    defn: defn(),
    now: ts(0, 18, 0),
  });

  const f1 = ts(0, 18, 30);
  state = Scheduler.transition(state, { type: 'fire', now: f1, id: 'a', gapMs: 90000 });
  assert.equal(state.lastFireAt, f1);
  assert.equal(state.nextDueAt, f1 + 90000);
  assert.equal(state.dayCount, 1);
  assert.deepEqual(state.doneIds, ['a']);
  assert.equal(state.dayKey, Scheduler.dayKey(f1));

  state = Scheduler.transition(state, { type: 'fire', now: ts(0, 19, 0), id: 'b', gapMs: 90000 });
  assert.equal(state.dayCount, 2);
  assert.deepEqual(state.doneIds, ['a', 'b']);

  // A fire on the next local day rolls dayKey and the count back to one.
  const nextDay = ts(1, 18, 30);
  state = Scheduler.transition(state, { type: 'fire', now: nextDay, id: 'c', gapMs: 90000 });
  assert.equal(state.dayKey, Scheduler.dayKey(nextDay));
  assert.equal(state.dayCount, 1);
  assert.deepEqual(state.doneIds, ['a', 'b', 'c']);
});

test('transition: stop ends the run and keeps the definition', () => {
  const d = defn();
  const running = Scheduler.transition(Scheduler.deserialize(null), { type: 'start', defn: d, now: ts(0, 18, 0) });
  const stopped = Scheduler.transition(running, { type: 'stop', now: ts(0, 19, 0) });
  assert.equal(stopped.status, 'ended');
  assert.deepEqual(stopped.defn, d);
});

test('transition: abort cancels the run, clearing counters and doneIds', () => {
  const d = defn();
  let state = Scheduler.transition(Scheduler.deserialize(null), { type: 'start', defn: d, now: ts(0, 18, 0) });
  state = Scheduler.transition(state, { type: 'fire', now: ts(0, 18, 30), id: 'a', gapMs: 90000 });
  const cancelled = Scheduler.transition(state, { type: 'abort', now: ts(0, 18, 45) });
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.endsAt, null);
  assert.equal(cancelled.dayCount, 0);
  assert.deepEqual(cancelled.doneIds, []);
  assert.deepEqual(cancelled.defn, d);
});

test('transition: pause parks the run and resume lifts it', () => {
  const running = Scheduler.transition(Scheduler.deserialize(null), {
    type: 'start',
    defn: defn(),
    now: ts(0, 18, 0),
  });
  const paused = Scheduler.transition(running, { type: 'pause', until: ts(0, 20, 0) });
  assert.equal(paused.status, 'running');
  assert.equal(paused.pausedUntil, ts(0, 20, 0));

  const resumed = Scheduler.transition(paused, { type: 'resume', now: ts(0, 20, 0) });
  assert.equal(resumed.status, 'running');
  assert.equal(resumed.pausedUntil, null);
});

test('dayKey: the local date as YYYY-MM-DD', () => {
  assert.equal(Scheduler.dayKey(ts(0, 0, 5)), '2026-10-19');
  assert.equal(Scheduler.dayKey(ts(0, 23, 55)), '2026-10-19');
  assert.equal(Scheduler.dayKey(ts(1, 0, 5)), '2026-10-20');
  assert.equal(Scheduler.dayKey(new Date(2026, 0, 5, 12, 0).getTime()), '2026-01-05');
});

test('eligible: age at the threshold counts, closed never does', () => {
  const take = Scheduler.eligible(defn({ ageThresholdDays: 7 }));
  assert.equal(take({ ageDays: 6, closed: false }), false);
  assert.equal(take({ ageDays: 7, closed: false }), true);
  assert.equal(take({ ageDays: 30, closed: false }), true);
  assert.equal(take({ ageDays: 7, closed: true }), false);
  assert.equal(take({ ageDays: 30, closed: true }), false);
});

test('inScope: every id under all, only picked ids under selected', () => {
  const selection = new Set(['a', 'b']);
  assert.equal(Scheduler.inScope(defn({ scope: 'all' }), 'a', selection), true);
  assert.equal(Scheduler.inScope(defn({ scope: 'all' }), 'z', selection), true);
  assert.equal(Scheduler.inScope(defn({ scope: 'selected' }), 'a', selection), true);
  assert.equal(Scheduler.inScope(defn({ scope: 'selected' }), 'b', selection), true);
  assert.equal(Scheduler.inScope(defn({ scope: 'selected' }), 'z', selection), false);
  assert.equal(Scheduler.inScope(defn({ scope: 'selected' }), 'a', new Set()), false);
});

test('leaseValid: alive before until, spent at it', () => {
  const lease = { tabId: 7, until: ts(0, 19, 0) };
  assert.equal(Scheduler.leaseValid(lease, ts(0, 18, 59)), true);
  assert.equal(Scheduler.leaseValid(lease, ts(0, 19, 0)), false);
  assert.equal(Scheduler.leaseValid(lease, ts(0, 19, 1)), false);
});

test('serialize/deserialize: a state survives the round trip unchanged', () => {
  let state = Scheduler.transition(Scheduler.deserialize(null), {
    type: 'start',
    defn: defn(),
    now: ts(0, 18, 0),
  });
  state = Scheduler.transition(state, { type: 'fire', now: ts(0, 18, 30), id: 'a', gapMs: 90000 });
  const raw = Scheduler.serialize(state);
  assert.equal(typeof raw, 'string');
  assert.deepEqual(Scheduler.deserialize(raw), state);
});

test('deserialize: anything malformed comes back as a fresh idle state', () => {
  const idle = Scheduler.deserialize(null);
  assert.equal(idle.status, 'idle');
  assert.deepEqual(idle.doneIds, []);

  for (const garbage of ['', '{oops', '42', 'null', '"hi"', '{"status":"chaos"}', '{"status":"running"}', undefined, 7, [1]]) {
    assert.deepEqual(Scheduler.deserialize(garbage), idle);
  }
});

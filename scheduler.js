// Vintimated — schedule mode: relisting that keeps shop hours.
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

// A week of relisting that behaves like a shop: only on the days the seller
// chose, only between six and nine in the evening, only a handful a day and
// never two too close together — until the period runs out. This file is the
// arithmetic behind that promise and nothing else. No alarms, no tabs, no
// storage: the window and its edges, the gap's bounds, the day's cap, the one
// decision a single moment can earn (decide), and the small state machine
// (transition) that remembers where a run has got to. The callers bring the
// timers and the clicks.
//
// Time arrives as plain milliseconds since the epoch and leaves the same way,
// so the tests can walk a week in a sentence; only dayKey and the window
// maths consult the seller's own clock. The dice come in as an argument, the
// way photo-refresh.js takes its rng — decide() never draws one. The gap
// between two firings is drawn once per firing, carried in the fire event and
// kept in the state as nextDueAt; decide() only ever compares against it, so
// no decision can quietly redraw the wait it is checking.
//
// Loaded as a plain script before the caller's own, the way bulk-queue.js is.
// Node reaches the very same object through require(), at the bottom of the
// file.

const Scheduler = (() => {
  'use strict';

  // The four lives a run can have. 'idle' is before anything (and what a
  // malformed reading falls back to), 'running' is the walk itself, 'ended'
  // is a stop the seller asked for, 'cancelled' is an abort that wipes the
  // books but keeps the definition, ready to be started again.
  const STATUSES = ['idle', 'running', 'ended', 'cancelled'];

  // The local date of a moment, as YYYY-MM-DD — the day a count belongs to.
  function dayKey(now) {
    const d = new Date(now);
    const pad = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }

  // Inside the window when the day is one the seller chose, the local minute
  // is at or past the opening and still short of the closing — the window is
  // half-open, so 17:59 and 21:00 are both outside an 18:00–21:00 evening —
  // and the period itself has not run out from under it.
  function isWithinWindow(defn, now) {
    if (now >= defn.endsAt) return false;
    const d = new Date(now);
    if (!defn.days.includes(d.getDay())) return false;
    const minute = d.getHours() * 60 + d.getMinutes();
    return minute >= defn.fromMin && minute < defn.toMin;
  }

  // One draw for one gap: an integer of milliseconds anywhere in the closed
  // span from gapMinMs to gapMaxMs, the draw arriving from outside so a test
  // can hand over a constant and know the gap before it happens.
  function nextGapMs(defn, rand) {
    return Math.round(defn.gapMinMs + rand() * (defn.gapMaxMs - defn.gapMinMs));
  }

  // What is left of today's allowance. A count over the cap is not a debt to
  // repay: the answer bottoms out at zero.
  function capacityLeft(defn, todayCount) {
    return Math.max(0, defn.maxPerDay - todayCount);
  }

  // The first moment the window opens on an allowed day at or after `fromDate`
  // and strictly after `lowerBound`. Strictly after, so a wait is always a
  // wait: no decision can hand back zero and spin the caller. An empty
  // defn.days has no such moment and is left degenerate, waiting not at all.
  function windowStartAfter(defn, fromDate, lowerBound) {
    for (let i = 0; i < 8; i++) {
      const day = new Date(fromDate.getFullYear(), fromDate.getMonth(), fromDate.getDate() + i);
      if (!defn.days.includes(day.getDay())) continue;
      const opensAt = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, defn.fromMin).getTime();
      if (opensAt > lowerBound) return opensAt;
    }
    return lowerBound;
  }

  // Where the window next opens, from right now.
  function nextWindowStart(defn, now) {
    return windowStartAfter(defn, new Date(now), now);
  }

  // Where the window next opens on a later day — a day whose cap is spent is
  // not topped up by waiting out the evening, so the search starts tomorrow
  // and walks on to the next allowed day if tomorrow is not one.
  function nextDayWindowStart(defn, now) {
    const today = new Date(now);
    const tomorrow = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
    return windowStartAfter(defn, tomorrow, now);
  }

  // The one question a moment can ask: may a relist happen right now? The
  // gates are asked in the order the schedule would be broken in — the period
  // is over, then the seller asked for quiet, then the shop is shut, then the
  // gap has not come round, then the day is full — and the first one to
  // object names the reason and the wait. Only when every gate is open does
  // the answer come back 'fire', and it draws nothing: the gap is already in
  // ctx.nextDueAt, waiting to be compared against.
  function decide(defn, now, ctx) {
    if (now >= defn.endsAt) return { action: 'wait', reason: 'period-over', waitMs: 0 };
    if (ctx.pausedUntil != null && now < ctx.pausedUntil) {
      return { action: 'wait', reason: 'paused', waitMs: ctx.pausedUntil - now };
    }
    if (!isWithinWindow(defn, now)) {
      return { action: 'wait', reason: 'outside-window', waitMs: nextWindowStart(defn, now) - now };
    }
    if (ctx.nextDueAt != null && now < ctx.nextDueAt) {
      return { action: 'wait', reason: 'gap', waitMs: ctx.nextDueAt - now };
    }
    if (capacityLeft(defn, ctx.todayCount) <= 0) {
      return { action: 'wait', reason: 'cap', waitMs: nextDayWindowStart(defn, now) - now };
    }
    return { action: 'fire', reason: 'fire', waitMs: 0 };
  }

  // Which items a run may touch: old enough to be worth the relist and still
  // open on the seller's side — a closed listing has nothing to refresh.
  function eligible(defn) {
    return (item) => !item.closed && item.ageDays >= defn.ageThresholdDays;
  }

  // Which ids a run may touch: the whole wardrobe, or only the ones the
  // seller picked out.
  function inScope(defn, itemId, selection) {
    return defn.scope === 'all' ? true : selection.has(itemId);
  }

  // The tab holding the run alive is only believed while its lease lasts.
  function leaseValid(lease, now) {
    return lease != null && now < lease.until;
  }

  // A claim on the run, renewed ahead of its own expiry by the tab doing the
  // work. Five minutes: long enough that a busy engine never loses the floor
  // mid-relist, short enough that a tab that went away stops holding up the
  // next one before the seller has finished wondering why nothing moves.
  const LEASE_MS = 5 * 60 * 1000;

  function renewLease(now, tabId) {
    return { tabId, until: now + LEASE_MS };
  }

  // The books of a run: what it is running, until when, when it last fired,
  // when it may fire again, which local day the count belongs to and how many
  // it has spent, and the ids it has already touched. pausedUntil rides along
  // so decide()'s caller can hand state over as its context unchanged.
  function idleState() {
    return {
      status: 'idle',
      defn: null,
      startedAt: null,
      endsAt: null,
      lastFireAt: null,
      nextDueAt: null,
      dayKey: null,
      dayCount: 0,
      doneIds: [],
      pausedUntil: null,
    };
  }

  // A pure reducer: one event in, the next state out, the old one untouched.
  // A start is a clean run — the period measured from now and the first
  // firing due at once. A fire is the bookkeeping the gap hangs off: the draw
  // arrives with the event and lands in nextDueAt, the id lands in doneIds,
  // and a fire on a new local day rolls the count back to one. A stop is the
  // seller's own ending and keeps everything; an abort wipes the period, the
  // counters and the ids but keeps the definition, ready to be started again.
  function transition(state, event) {
    switch (event.type) {
      case 'start':
        return {
          ...idleState(),
          status: 'running',
          defn: event.defn,
          startedAt: event.now,
          endsAt: event.now + event.defn.periodMs,
          nextDueAt: event.now,
          dayKey: dayKey(event.now),
        };
      case 'fire': {
        const key = dayKey(event.now);
        return {
          ...state,
          lastFireAt: event.now,
          nextDueAt: event.now + event.gapMs,
          dayKey: key,
          dayCount: (key === state.dayKey ? state.dayCount : 0) + 1,
          doneIds: state.doneIds.concat(event.id),
        };
      }
      case 'stop':
        return { ...state, status: 'ended' };
      case 'abort':
        return {
          ...state,
          status: 'cancelled',
          endsAt: null,
          dayCount: 0,
          doneIds: [],
          pausedUntil: null,
        };
      case 'pause':
        return { ...state, pausedUntil: event.until };
      case 'resume':
        return { ...state, pausedUntil: null };
      default:
        return state;
    }
  }

  // A state through JSON and back, for a run that has to survive being put
  // down. Anything that does not parse into a state — no status worth the
  // name, no ids to speak of, no definition to run — comes back as a fresh
  // idle one instead of a half-believable wreck; deserialize(null) is also
  // simply where a new run gets its first state.
  function serialize(state) {
    return JSON.stringify(state);
  }

  function deserialize(raw) {
    let parsed = raw;
    if (typeof raw === 'string') {
      try {
        parsed = JSON.parse(raw);
      } catch (_) {
        return idleState();
      }
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return idleState();
    if (!STATUSES.includes(parsed.status)) return idleState();
    if (!Array.isArray(parsed.doneIds)) return idleState();
    // A state is only believable alongside the definition it runs — a caller
    // reads defn.days off this — so a defn that is present must be a real
    // one, and only idle may carry none at all. Anything less is the
    // half-state that would come back runnable and read as a crash.
    const hasDefn = parsed.defn != null && typeof parsed.defn === 'object' && !Array.isArray(parsed.defn);
    const defnOk = hasDefn || (parsed.status === 'idle' && parsed.defn == null);
    if (!defnOk) return idleState();
    return { ...idleState(), ...parsed };
  }

  return {
    isWithinWindow,
    nextGapMs,
    capacityLeft,
    decide,
    eligible,
    inScope,
    transition,
    dayKey,
    leaseValid,
    renewLease,
    serialize,
    deserialize,
  };
})();

// require() in Node hands over the same object the extension reads off the
// const above; without a module to hand it to, the line is simply not taken.
if (typeof module !== 'undefined') module.exports = Scheduler;

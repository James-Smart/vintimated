# Schedule Mode — design

**Date:** 2026-10-18
**Status:** Agreed in conversation; awaiting builder review.

## Intent

Let a seller relist qualifying items automatically across a period — without
Vinted ever seeing automated activity. The schedule only runs while they are
browsing Vinted, spaced by random gaps inside human hours, at volumes a tidy
seller would produce by hand, with Stop and Abort always at hand. It is the
bulk relist feature set on a timer, wearing the same pacing discipline.

**Why:** relisting works, but doing it by hand is a chore and doing it in
bursts is what gets accounts flagged. The seller wants the work spread out
for them, invisibly.

## Goals

1. **One-form scheduler.** Period, allowed days, allowed hours, daily cap,
   random gap range, item-age threshold, scope. Start / Stop / Abort.
2. **Runs only while Vinted is open.** No background waking of a closed
   browser; the scheduler lives in the wardrobe tab and does nothing when
   the seller is not there. (Honest note: the extension can see an open
   tab, not a human — the hours, gaps and caps are what keep it human.)
3. **Human pacing as a first-class setting.** Gaps drawn randomly from the
   configured range; nothing metronomic; nothing that bursts after idle.
4. **Age threshold doubles as cadence.** Only items listed N+ days ago
   qualify; a relist makes a listing brand new, so no item can relist more
   than once per N days without any bookkeeping.
5. **Stop and Abort.** Stop ends the schedule after the relist in progress;
   Abort also drops anything still queued. Both reachable from the running
   strip and the popup.
6. **Inherit every safety property.** Copy-before-delete, photo refresh on
   uploaded photos, retried publishing, stand-down on 429/challenge (the
   schedule pauses with the block and resumes after), pacing defaults on.

## Non-goals

- Operating while the browser is closed, overnight, or on another machine;
  wake-the-browser alarms of any kind.
- Defeating bot detection: no captcha solving, no fingerprint spoofing, no
  challenge bypass. When Vinted says stop, we stop. (Anti-goal, below.)
- Catch-up of missed slots (a missed evening is missed, not replayed).
- Per-item schedules, price automation, message automation.
- Mobile.

## Anti-goals

- **Traffic shapes that read as automated:** metronome gaps, backfilled
  bursts, activity outside the seller's own hours.
- **An account warning or ban caused by our traffic.** The existing pacing
  defaults and stand-down machinery stay on; the schedule is strictly
  quieter than hand-clicking.
- **A listing lost between delete and publish.** The inherited sequence is
  sacred; the scheduler is just another caller of `runRelist`.
- **A schedule that is invisible while running.** The running state is
  always on screen wherever schedule controls live.

## Constraints

- GPL-3.0 fork; zero runtime dependencies; vanilla-JS classic scripts.
- Relisting goes through the existing `runRelist(itemId, mode, hooks)` —
  the scheduler adds no new relist path. `BulkQueue`'s pacing and halt
  semantics are the model to reuse or generalize.
- The fetch bridge means every relist needs a live Vinted page: the
  scheduler runs in the content-script world of a wardrobe tab.
- Storage keys `vintimated:*`; existing pacing constants and refusals
  machinery untouched.

## Decided in conversation

- **Panel shape:** one form, every knob visible (Option B). No modes, no
  preset chips.
- **The knobs and defaults, as validated:**
  | Knob | Default |
  | --- | --- |
  | Period | Starts on Start; ends +7 days |
  | Days | All seven |
  | Hours | 18:00–21:00 |
  | Max relists per day | 6 |
  | Gap between relists | 35–90 min, drawn randomly |
  | Item age threshold | listed 10+ days ago |
  | Scope | all active items (or only what the seller ticked in the wardrobe) |
- **Stop/Abort semantics:** Stop = end after the in-progress relist;
  Abort = also drop the queued plan. The running strip shows state, next
  relist ETA, today's count against the cap, and the end date.
- **When it runs:** only while a Vinted tab is open in front of them; the
  schedule exists to be invisible, not to work while they sleep.

## My calls (builder may vary these)

- **Rolling eligibility, not a fixed plan.** Each firing picks the next
  item that currently qualifies (age threshold, scope, not sold/reserved),
  read live from Vinted. No per-item history to maintain; the listing age
  Vinted reports is the cadence. Items deleted or sold since the schedule
  started simply drop out.
- **No catch-up.** Missed hours are not replayed; the next firing happens
  in the next allowed slot. Bursts after idle are the automation tell.
- **Schedule counts land in the same `relistLog` as manual relists**, but
  the schedule's own caps are stricter than the manual budget alarms
  (4/hour, 15/day), so those remain a manual-use guard.
- **Stand-down pauses the schedule, does not kill it.** The existing
  `BLOCK_KEY` machinery sets a pause; the strip shows "paused until X";
  the schedule resumes within its own windows afterwards.
- **Persistence:** the schedule definition and its daily counters live in
  `vintimated:schedule` so a page reload or browser restart doesn't lose
  them; the schedule stays dormant until the seller is back on Vinted
  inside an allowed window.
- **Mixed traffic never prompts and never overruns (builder check).**
  Scheduled firings never raise a modal mid-browse. If manual relists have
  the account near the volume alarms, the firing holds and retries at the
  next allowed slot (that skip is not a "missed slot" to backfill). The
  daily cap counts **all** relists — manual and scheduled — so the account
  never exceeds what the form promises.
- **Open is enough (builder check).** A matching tab merely being open
  satisfies the firing precondition; it need not be the visible tab. The
  agreed promise is "while Vinted is open", and demanding focus would
  under-deliver it. What Vinted observes is identical either way.
- **Abort/Stop mapped onto rolling eligibility (builder check).** The
  validated form text stands: Stop finishes the relist in progress and ends
  the schedule for its period; Abort finishes nothing new and cancels the
  run — clearing the period, counters and run state. Since rolling
  eligibility holds no queue, "drops anything still queued" means the
  period itself. The form values stay filled in either way, so Start can
  bring it back.

## Left to the builder

- Storage schema and counter reset boundaries (per calendar day vs rolling
  24h — calendar days in the seller's local time are the expected answer).
- How the in-tab scheduler sleeps and wakes (idle setTimeout vs checks
  piggybacking on page visibility and existing relist activity).
- Placement details: the running strip alongside the existing bulk bar;
  the schedule form in the popup (it is already the home of settings).
- How "only what I ticked" scope interacts with the existing selection map
  across re-renders and reloads.

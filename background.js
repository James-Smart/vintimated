// Bumpline — relist your Vinted items in one click.
// Copyright (C) 2026 g1ampy
// Modifications Copyright (C) 2026 Vintimated contributors.
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

// The background — a service worker on Chrome, an event page on Firefox —
// exists for three jobs the page cannot do on its own:
//
//   1. Watch the requests Vinted's own site makes and note the security tokens
//      it attaches, so the extension can send requests Vinted will accept.
//   2. Fetch image bytes from the CDN when a cross-origin read from the page is
//      refused.
//   3. Keep a scheduled run of relists alive: its books in storage, a lease
//      naming the one tab that may act on them, and a one-minute alarm that
//      knocks on the wardrobe tabs.

// Two dependencies, both plain scripts: strings.js holds the words for the one
// thing this file puts on screen — the toolbar button's tooltip — and
// scheduler.js holds the arithmetic the schedule's wake wire asks for.
// Chrome's background is a classic service worker, which brings its
// own dependencies in with importScripts. Firefox's is an event page, where the
// manifest lists both ahead of this file — build.mjs writes that array —
// and importScripts does not exist at all. Asking which of the two this is
// covers both without either needing to know about the other.
if (typeof importScripts === 'function') importScripts('strings.js', 'scheduler.js');

// Firefox answers to `browser` and only that namespace returns promises there;
// Chrome answers to `chrome`. One alias, and the rest of the file is written
// once for both.
const ext = globalThis.browser ?? globalThis.chrome;

const TOKEN_KEYS = { csrf: 'vintimated:csrf', anon: 'vintimated:anon' };

// Vinted runs one domain per country; the request filter has to name them all.
const COUNTRY_DOMAINS = [
  'vinted.at', 'vinted.be', 'vinted.bg', 'vinted.ch', 'vinted.co.uk',
  'vinted.com', 'vinted.cz', 'vinted.de', 'vinted.dk', 'vinted.ee',
  'vinted.es', 'vinted.fi', 'vinted.fr', 'vinted.gr', 'vinted.hr',
  'vinted.hu', 'vinted.ie', 'vinted.it', 'vinted.lt', 'vinted.lv',
  'vinted.nl', 'vinted.no', 'vinted.pl', 'vinted.pt', 'vinted.ro',
  'vinted.se', 'vinted.si', 'vinted.sk', 'vinted.com.au',
];

// Both shapes appear in the wild: /api/... at the root, and /<locale>/api/...
const API_URL_FILTERS = COUNTRY_DOMAINS.flatMap(domain => [
  `https://www.${domain}/api/*`,
  `https://www.${domain}/*/api/*`,
]);

let seen = { csrf: null, anon: null };

// Remember the tokens in memory for speed and on disk for content scripts that
// start up in a tab which has not issued an API call yet.
function noteTokens(headers) {
  if (!Array.isArray(headers)) return;

  let changed = false;
  for (const header of headers) {
    if (!header || !header.name || !header.value) continue;
    const name = header.name.toLowerCase();
    if (name === 'x-csrf-token' && header.value !== seen.csrf) {
      seen.csrf = header.value;
      changed = true;
    } else if (name === 'x-anon-id' && header.value !== seen.anon) {
      seen.anon = header.value;
      changed = true;
    }
  }
  if (!changed) return;

  ext.storage.local
    .set({ [TOKEN_KEYS.csrf]: seen.csrf, [TOKEN_KEYS.anon]: seen.anon })
    .catch(() => {
      // Losing the cached copy is survivable: the page can still parse the
      // token out of the markup.
    });
}

ext.webRequest.onBeforeSendHeaders.addListener(
  details => {
    try {
      noteTokens(details.requestHeaders);
    } catch (err) {
      console.debug('[Vintimated] could not read request headers', err);
    }
  },
  { urls: API_URL_FILTERS },
  ['requestHeaders']
);

async function tokensForPage() {
  if (seen.csrf || seen.anon) return { csrf: seen.csrf, anonId: seen.anon };
  try {
    const stored = await ext.storage.local.get([TOKEN_KEYS.csrf, TOKEN_KEYS.anon]);
    return { csrf: stored[TOKEN_KEYS.csrf] || null, anonId: stored[TOKEN_KEYS.anon] || null };
  } catch (_) {
    return { csrf: null, anonId: null };
  }
}

async function fetchBinary(url) {
  try {
    const reply = await fetch(url, { credentials: 'omit' });
    if (!reply.ok) return { ok: false, status: reply.status };
    return {
      ok: true,
      buffer: await reply.arrayBuffer(),
      contentType: reply.headers.get('content-type') || '',
    };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
}

ext.runtime.onMessage.addListener((message, _sender, respond) => {
  if (!message || !message.type) return false;

  if (message.type === 'vintimated:tokens') {
    tokensForPage().then(respond);
    return true; // the reply is asynchronous
  }

  if (message.type === 'vintimated:fetchBinary' && message.url) {
    fetchBinary(message.url).then(respond);
    return true;
  }

  return false;
});

// --- the toolbar icon -----------------------------------------------------

// The icon is the only part of the extension visible when no panel is open, so
// it carries the one thing worth knowing from outside: whether pressing it
// would get you anything. Colour means yes — the switch is on and this tab is a
// Vinted page. Grey means no, for either reason, and the tooltip says which.
// Same drawing, luma only.
const ENABLED_KEY = 'vintimated:enabled';
const LANG_KEY = 'vintimated:lang';

const ACTION_ICONS = {
  on: { 16: 'icons/icon16.png', 24: 'icons/icon24.png', 32: 'icons/icon32.png' },
  off: { 16: 'icons/off16.png', 24: 'icons/off24.png', 32: 'icons/off32.png' },
};

// vinted.it, vinted.com, vinted.co.uk … one domain per country. The same test
// the popup makes, written the same way.
const VINTED_HOST = /(^|\.)vinted\.[a-z]{2,3}(\.[a-z]{2})?$/i;

// A tab's url only reaches an extension that holds a host permission for it,
// which here is exactly the Vinted domains. Everywhere else it arrives
// undefined — and that is not a gap to work around, it is the answer.
function onVinted(url) {
  if (!url) return false;
  try {
    return VINTED_HOST.test(new URL(url).hostname);
  } catch (_) {
    return false;
  }
}

// The switch, cached. The worker is torn down between events and reads it back
// on the way up; every repaint in between needs it, and none of them should
// have to wait on storage for it.
let switchedOn = true;

// Colour needs no explaining, so it says the product name and nothing else —
// the same word in every language, and therefore not a catalogue key. The two
// grey states do need explaining, and the welcome page on the website tells the
// seller to read them, which makes them functional text and not decoration.
function titleFor(colour) {
  if (!switchedOn) return VintimatedText.t('popup.tooltip.off');
  return colour ? 'Vintimated' : VintimatedText.t('popup.tooltip.notVinted');
}

// Without a tabId this is the default every tab starts from; with one it is an
// override for that tab alone, which is what makes the icon able to answer a
// question about the page rather than only about the switch.
function paintIcon(colour, tabId) {
  // Chrome returns promises here and Firefox returns them from a different
  // object; neither failure is worth taking the worker down for, and an icon
  // that did not repaint is not a reason to stop watching request headers. It
  // is worth saying out loud, though: a swallowed rejection here is an icon
  // that never changes and no way to find out why.
  const action = ext.action || ext.browserAction;
  if (!action) return;
  const where = tabId == null ? {} : { tabId };
  try {
    Promise.resolve(action.setIcon({ ...where, path: colour ? ACTION_ICONS.on : ACTION_ICONS.off }))
      .catch(err => console.debug('[Vintimated] could not set the icon', err));
    Promise.resolve(action.setTitle({ ...where, title: titleFor(colour) }))
      .catch(err => console.debug('[Vintimated] could not set the title', err));
  } catch (err) {
    // An older browser without these methods keeps the manifest's icon.
    console.debug('[Vintimated] this browser has no action icon to set', err);
  }
}

// Grey is the default because most tabs are not Vinted, and colour is painted
// over it per tab. A tab that has never been activated or loaded since the
// worker came up is therefore grey, which is the right guess for a tab the
// extension has heard nothing about.
function paintDefault() {
  paintIcon(false);
}

function paintTab(tabId, url) {
  if (tabId == null) return;
  paintIcon(switchedOn && onVinted(url), tabId);
}

// Only the active tab's icon is ever on screen, so that is the one repaint that
// has to happen now; every other tab gets its own when it is activated.
async function paintActiveTab() {
  try {
    const [tab] = await ext.tabs.query({ active: true, lastFocusedWindow: true });
    if (tab) paintTab(tab.id, tab.url);
  } catch (err) {
    console.debug('[Vintimated] could not read the active tab', err);
  }
}

// The worker is torn down between events and the browser forgets a set icon at
// the end of a session, so the switch is read on the way up rather than
// remembered. Absent means on, the same rule the popup and the page use.
//
// The language is read in the same breath and for the same reason: the words
// live in memory, so the catalogue is already in the browser's language by the
// time this runs, and only a seller who overruled the browser costs anything.
// Absent means 'auto', which VintimatedText.use reads as "ask the browser".
async function paintIconFromStore() {
  try {
    const bag = await ext.storage.local.get([ENABLED_KEY, LANG_KEY]);
    switchedOn = bag[ENABLED_KEY] !== false;
    VintimatedText.use(bag[LANG_KEY] || 'auto');
  } catch (_) {
    switchedOn = true;
  }
  paintDefault();
  await paintActiveTab();
}

paintIconFromStore();
ext.runtime.onStartup.addListener(paintIconFromStore);

// The switch is thrown in the popup, which writes it here. Storage is what the
// content scripts already listen to, so the icon follows the same signal rather
// than needing a message of its own. The language is chosen in the same panel
// and written the same way, so it arrives here the same way: either one changes
// what the tooltip should say, and both are answered by repainting it.
ext.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes) return;
  const touched = ENABLED_KEY in changes || LANG_KEY in changes;
  if (!touched) return;
  if (ENABLED_KEY in changes) switchedOn = changes[ENABLED_KEY].newValue !== false;
  if (LANG_KEY in changes) VintimatedText.use(changes[LANG_KEY].newValue || 'auto');
  paintDefault();
  paintActiveTab();
});

// Neither of these needs the "tabs" permission. The events fire either way; the
// url is what is withheld without one, and a withheld url is a tab the
// extension cannot work on — which is the same grey icon as a tab it will not
// work on. The two cases do not have to be told apart.
ext.tabs.onActivated.addListener(({ tabId }) => {
  Promise.resolve(ext.tabs.get(tabId))
    .then(tab => paintTab(tabId, tab && tab.url))
    .catch(() => paintTab(tabId, null));
});

ext.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  // A navigation, or the load finishing. Everything else a tab reports — a
  // title, a favicon, a mute — cannot have changed the answer.
  if (!changeInfo.url && changeInfo.status !== 'complete') return;
  paintTab(tabId, tab && tab.url);
});

// The first page a seller sees and the last one both live with the project's
// source. The first is the README, whose install section shows the pinning
// steps for the browser it opens in and can be corrected without a store
// review; the last opens after the extension is gone, so it could not live
// inside it. Both are plain visits to a public page, in the language the
// browser asks for, with nothing of the seller's attached to them.
const SITE = 'https://github.com/James-Smart/vintimated';

// Installed from the store the extension draws nothing anywhere until you are
// on your own Vinted wardrobe, so a new user sees an empty toolbar and assumes
// it is broken. Opening the README once answers where the icon went and
// where the buttons appear. An update is not a first impression, so it passes.
ext.runtime.onInstalled.addListener(details => {
  if (details.reason !== 'install') return;
  ext.tabs.create({ url: SITE + '#readme' });
});

// The browser opens this address once the extension has been removed: the one
// moment a seller who gave up on it can still say why. It is the project's
// issue tracker, where what the seller writes becomes an issue they can read
// before posting. The address carries no version number either, because
// Firefox counts facts about the add-on as technical data, which may only be
// collected with the user's consent, and a seller who is leaving can type it
// if it matters. Set on every wake rather than once: the call is cheap, and
// the address is then right however the worker came up.
Promise.resolve(ext.runtime.setUninstallURL(SITE + '/issues'))
  .catch(err => console.debug('[Vintimated] could not set the uninstall page', err));

// --- the schedule: persistence, the lease, the wake wire -------------------

// A schedule of relists needs three things from outside the page it runs on:
// books that survive being put down, one tab at a time allowed to act on
// them, and a knock on the door while the seller is off browsing somewhere
// else. That is all this section is. The books are a state the Scheduler has
// already decided on, the lease is five minutes of belief in one tab, and the
// knock is the cheapest thing a worker can be asked to do — post a message to
// the wardrobe tabs and go back to sleep. Nothing here relists anything or
// decides whether to: a knock is only ever a knock.
//
// Five message types join the relay above. The four that come in are each
// answered with the same things — the state as it now stands and the
// definition it runs, lifted out beside it for callers that only want the
// settings — plus the tabId of the tab that asked. The tabId is the one fact
// a content script cannot learn on its own, and the engine needs it to claim
// the lease in its own name; a caller with no tab (the popup) simply gets
// null there:
//
//   vintimated:schedule.start    { defn }  -> { state, defn, tabId }  begin a run
//   vintimated:schedule.stop               -> { state, defn, tabId }  end the period (after a relist in hand)
//   vintimated:schedule.abort              -> { state, defn, tabId }  cancel the run at once
//   vintimated:schedule.status             -> { state, defn, tabId }  just the books
//
// The fifth, vintimated:schedule.wake, only ever goes out: it is the alarm's
// knock on a wardrobe tab, and the tab that hears it — the engine, in
// content.js — decides what a knock means.

// The books. The state travels as Scheduler serializes it, so a run survives
// a worker being torn down between one firing and the next; the lease beside
// it is the claim one tab holds on the run — { tabId, until } — renewed five
// minutes ahead by the engine tab and dropped the moment the run is over.
const SCHEDULE_KEY = 'vintimated:schedule';
const SCHEDULE_LEASE_KEY = 'vintimated:schedule.lease';
const WAKE_ALARM = 'vintimated:schedule-wake';

// Two markers shared with the engine around a relist. 'working' is the
// engine's word that a runRelist is in flight in a named tab ({ tabId, at }) —
// the one thing this worker cannot see for itself, and what a polite Stop
// waits behind. 'pendingEnd' is this worker's own note that an ending is
// parked behind such a relist ({ verb, startedAt }), honoured by the engine
// the moment its relist settles — and only by the run the startedAt names.
const SCHEDULE_WORKING_KEY = 'vintimated:schedule.working';
const SCHEDULE_PENDING_KEY = 'vintimated:schedule.pendingEnd';

// Provenance of the engine tab: the tab the engine OPENED for the run, as
// opposed to one it adopted from the seller's own browsing. The opened tab is
// ours to close when the run is over; an adopted one is only lent to the run
// and is never closed or left worse than found.
const SCHEDULE_ENGINE_TAB_KEY = 'vintimated:schedule.engineTab';

// The wardrobe a run calls home: the profile the content script last found
// the seller's own buttons on. The same key, the same address and the same
// meaning as in popup.js and content.js.
const LAST_PROFILE_KEY = 'vintimated:lastProfile';

// Where a knock can land: exactly the pages the content script is injected
// into — the manifest's /member/* matches — one pattern per country domain.
const WARDROBE_URL_PATTERNS = COUNTRY_DOMAINS.map(domain => `https://www.${domain}/member/*`);

// The alarm lives exactly as long as the books say a run is going: created
// when it is missing and the state is running, cleared when it is there and
// the state is anything else. It is deliberately not re-created on every
// look — a create replaces, and replacing a one-minute alarm on every worker
// wake would keep shoving the next knock out of reach on a busy browsing day.
async function syncScheduleAlarm() {
  try {
    const bag = await ext.storage.local.get([SCHEDULE_KEY]);
    const running = Scheduler.deserialize(bag[SCHEDULE_KEY]).status === 'running';
    const alarm = await ext.alarms.get(WAKE_ALARM);
    if (running && !alarm) {
      Promise.resolve(ext.alarms.create(WAKE_ALARM, { periodInMinutes: 1 }))
        .catch(err => console.debug('[Vintimated] could not set the schedule alarm', err));
    } else if (!running && alarm) {
      await ext.alarms.clear(WAKE_ALARM);
    }
  } catch (err) {
    console.debug('[Vintimated] could not read the schedule state', err);
  }
}

// The whole of what a knock is: say `vintimated:schedule.wake` to every open
// wardrobe tab. No reading the books, no relisting, no deciding — those
// belong to the tab that hears it, which knows whether it holds the lease and
// what the schedule wants next. Several tabs may hear the same knock; the
// lease is what keeps the schedule from being run twice over.
function wakeWardrobeTabs() {
  Promise.resolve(ext.tabs.query({ url: WARDROBE_URL_PATTERNS }))
    .then(tabs => {
      for (const tab of tabs) {
        if (tab.id == null) continue;
        Promise.resolve(ext.tabs.sendMessage(tab.id, { type: 'vintimated:schedule.wake' }))
          // A wardrobe tab whose content script never came up, or has gone
          // away again, is simply not home.
          .catch(() => {});
      }
    })
    .catch(err => console.debug('[Vintimated] could not look for wardrobe tabs', err));
}

ext.alarms.onAlarm.addListener(alarm => {
  if (!alarm || alarm.name !== WAKE_ALARM) return;
  // Off means off: no knock goes round while the extension is switched off.
  if (!switchedOn) return;
  // A knock keeps house as well as rap: the engine tab is put back on the
  // wardrobe if it has wandered off, or reopened if it is gone, before the
  // knock goes round — a wake that finds it elsewhere re-navigates it.
  ensureEngineTab().then(() => wakeWardrobeTabs());
});

// The engine tab: the one wardrobe tab a run lives in. The claim's tabId is
// what names it — the same vintimated:schedule.lease the content engine takes
// the floor with — so there is one answer to "which tab is the engine" and it
// survives the worker being torn down between knocks. The tab is pinned to
// the wardrobe: a wake that finds it somewhere else puts it back on the
// remembered profile. When the run leaves 'running' — stop, abort or a period
// that ran out — or the extension is switched off, only a tab this worker
// OPENED is closed (closeEngineTab below); an adopted tab is the seller's own
// and only stops being the engine.

// On the wardrobe only when on the seller's OWN member page — the remembered
// profile's exact address, the same one popup.js and content.js record. A
// foreign member page has the same URL shape and must not pass: the ladder's
// footing is the member the URL names, and on somebody else's page that is
// somebody else's wardrobe. Comparing the whole address (origin and path) also
// keeps a same-numbered member on another country domain out.
function onWardrobe(url, home) {
  if (!onVinted(url) || !home) return false;
  try {
    const at = new URL(url);
    return `${at.origin}${at.pathname}` === home;
  } catch (_) {
    return false;
  }
}

async function ensureEngineTab() {
  // Off means off: no engine tab is opened or kept while the extension is
  // switched off.
  if (!switchedOn) return null;
  try {
    const bag = await ext.storage.local.get([SCHEDULE_LEASE_KEY, LAST_PROFILE_KEY]);
    const lease = bag[SCHEDULE_LEASE_KEY];
    const home = bag[LAST_PROFILE_KEY];

    // The tab the claim names is the engine for as long as the claim lasts.
    let tab = null;
    if (Scheduler.leaseValid(lease, Date.now()) && lease.tabId != null) {
      tab = await ext.tabs.get(lease.tabId).catch(() => null);
    }
    if (tab) {
      // Pinned to the wardrobe: a wake that finds the engine anywhere but
      // home navigates it back to the remembered profile.
      if (home && !onWardrobe(tab.url, home)) {
        tab = (await ext.tabs.update(tab.id, { url: home })) || tab;
      }
      return tab;
    }

    // No engine to keep: adopt the seller's OWN wardrobe tab when one is open
    // — a foreign member page is nobody's engine room, and the first tab in
    // the browser is as likely to be one as not — or open the remembered
    // profile to be one. Quietly: the tab is the scheduler's engine room, not
    // something the seller asked to see. With no remembered profile there is
    // nothing to verify and nothing to open, so no tab is named and the run
    // waits until the seller's own wardrobe has been seen once.
    const candidates = await ext.tabs.query({ url: WARDROBE_URL_PATTERNS });
    const adopted = candidates.find(candidate => onWardrobe(candidate.url, home)) || null;
    const opened = !adopted && home ? await ext.tabs.create({ url: home, active: false }) : null;
    tab = adopted || opened;
    if (tab && tab.id != null) {
      // Named from the first moment, so a run stopped ten seconds after it
      // started still knows which tab to close. The tab then renews the claim
      // itself as it works.
      await ext.storage.local.set({
        [SCHEDULE_LEASE_KEY]: Scheduler.renewLease(Date.now(), tab.id),
      });
      // Provenance: a tab we opened is ours to close at the end of the run;
      // an adopted one is the seller's, only lent to it.
      if (opened) {
        await ext.storage.local.set({ [SCHEDULE_ENGINE_TAB_KEY]: opened.id });
      }
    }
    return tab;
  } catch (err) {
    console.debug('[Vintimated] could not give the schedule its engine tab', err);
    return null;
  }
}

// The engine tab at the end of the run — and only ever the tab the engine
// OPENED. Provenance is the whole difference: a tab adopted from the seller's
// own browsing is never closed and never dragged about (the lease is simply
// dropped and the tab stops being the engine), while a tab this worker opened
// is ours to close when the state leaves 'running' or the extension is
// switched off. A seller who closed the engine tab mid-run has already tidied
// up for us: the record names a tab that is gone and closes nothing.
async function closeEngineTab() {
  try {
    const bag = await ext.storage.local.get([SCHEDULE_LEASE_KEY, SCHEDULE_ENGINE_TAB_KEY]);
    await ext.storage.local.remove([SCHEDULE_LEASE_KEY, SCHEDULE_ENGINE_TAB_KEY]);
    const ours = bag[SCHEDULE_ENGINE_TAB_KEY];
    if (ours != null) {
      // A tab already gone is not a failure worth more than a debug line.
      Promise.resolve(ext.tabs.remove(ours))
        .catch(err => console.debug('[Vintimated] could not close the engine tab', err));
    }
  } catch (err) {
    console.debug('[Vintimated] could not close the schedule engine tab', err);
  }
}

// Is a scheduled relist in flight? The engine's marker says so while its tab
// lives and its minutes are few. A marker whose tab is gone, or old beyond any
// relist's own few minutes (one hard-cooldown inside a relist is ten seconds),
// is a ghost — a content script that died inside a tab that did not — and
// answers no, so an ending is never parked behind a relist that is not there.
const WORKING_GHOST_MS = 15 * 60 * 1000;

async function scheduleWorking() {
  try {
    const bag = await ext.storage.local.get([SCHEDULE_WORKING_KEY]);
    const mark = bag[SCHEDULE_WORKING_KEY];
    const alive = mark && mark.tabId != null && (await ext.tabs.get(mark.tabId).catch(() => null));
    if (alive && Date.now() - mark.at < WORKING_GHOST_MS) return true;
    await ext.storage.local.remove(SCHEDULE_WORKING_KEY);
    return false;
  } catch (err) {
    console.debug('[Vintimated] could not read the relist in flight', err);
    return false;
  }
}

// The parked ending: written when a Stop waits behind a relist, and stamped
// with the run's startedAt so it is an ending for THAT run and no other. A
// Start that lands before it settles draws a new run and takes the markers
// with it; the stamp is what keeps a marker that slips through anyway from
// stopping the brand-new run over a relist the old one was still finishing.
// Cleared by whatever ends the run — the engine coming back with the Stop it
// was promised, or an Abort that cancels the wait outright.
async function markPendingEnd(verb, startedAt) {
  try {
    if (verb) await ext.storage.local.set({ [SCHEDULE_PENDING_KEY]: { verb, startedAt } });
    else await ext.storage.local.remove(SCHEDULE_PENDING_KEY);
  } catch (err) {
    console.debug('[Vintimated] could not note the schedule ending', err);
  }
}

// Both markers down: the run is over, and nothing may go on waiting for a
// relist or an ending that belonged to it.
async function clearEngineMarkers() {
  try {
    await ext.storage.local.remove([SCHEDULE_WORKING_KEY, SCHEDULE_PENDING_KEY]);
  } catch (err) {
    console.debug('[Vintimated] could not clear the schedule markers', err);
  }
}

// The books through one door, so a storage failure costs a caller an answer
// at the last believable state rather than a reply that never comes.
async function readSchedule() {
  try {
    const bag = await ext.storage.local.get([SCHEDULE_KEY]);
    return Scheduler.deserialize(bag[SCHEDULE_KEY]);
  } catch (err) {
    console.debug('[Vintimated] could not read the schedule', err);
    return Scheduler.deserialize(null);
  }
}

async function writeSchedule(state) {
  try {
    await ext.storage.local.set({ [SCHEDULE_KEY]: Scheduler.serialize(state) });
  } catch (err) {
    console.debug('[Vintimated] could not write the schedule', err);
  }
}

// Every answer, the same shape — and the asking tab named in it as well: the
// engine claims the lease with its own id, and a content script has no other
// way to learn which tab it is.
function scheduleAnswer(state, sender) {
  const tabId = sender && sender.tab && sender.tab.id != null ? sender.tab.id : null;
  return { state, defn: state.defn, tabId };
}

async function scheduleStatus(sender) {
  return scheduleAnswer(await readSchedule(), sender);
}

// A start is the form's defn turned into a run: the state machine draws the
// period from now, and the alarm and the engine tab follow the books. A start
// that lands on a running schedule begins the clean run transition defines —
// one alarm, one tab, never two of either. The engine markers go with the run
// that has just been replaced: a Stop parked behind ITS relist is an ending
// for it, and a relist still settling from it must not stop this one.
async function scheduleStart(defn, sender) {
  // A message that carries no definition is not a start: the caller gets the
  // books back and no run is invented out of a malformed message.
  if (!defn || typeof defn !== 'object' || Array.isArray(defn)) return scheduleStatus(sender);
  await clearEngineMarkers();
  const state = Scheduler.transition(await readSchedule(), {
    type: 'start',
    defn,
    now: Date.now(),
  });
  await writeSchedule(state);
  await syncScheduleAlarm();
  await ensureEngineTab();
  return scheduleAnswer(state, sender);
}

// Stop and abort are different in kind, not only in what they wipe. Stop is
// polite — "the schedule ends after the relist in progress" — so a relist in
// hand is let finish: the ending is parked behind it (pendingEnd, stamped
// with this run's startedAt) and comes back through this same door the moment
// the engine settles it, the books going on saying 'running' until then
// because that is what is true. Abort is hard and cancels at once — "finishes
// nothing new" — with the copy-before-delete and pending recovery already
// protecting whatever was mid-flight.
// Either way the engine tab goes: the tab that held the floor held it for a
// run that is over (the period running out reaches this same door, the engine
// asking for the stop on its own). A stop or abort that finds no definition to
// act on writes nothing at all, so the books only ever hold a state
// deserialize would believe. A marker that cannot say which run it is parked
// for is never parked: with no startedAt to stamp there is nothing a later
// check could honour, so the run ends here instead.
async function scheduleEnd(verb, sender) {
  let state = await readSchedule();

  if (verb === 'stop' && state.defn != null && state.startedAt != null && (await scheduleWorking())) {
    await markPendingEnd('stop', state.startedAt);
    return scheduleAnswer(state, sender);
  }

  await clearEngineMarkers();
  if (state.defn != null) {
    state = Scheduler.transition(state, { type: verb, now: Date.now() });
    await writeSchedule(state);
  }
  await closeEngineTab();
  await syncScheduleAlarm();
  return scheduleAnswer(state, sender);
}

ext.runtime.onMessage.addListener((message, sender, respond) => {
  if (!message || !message.type) return false;

  if (message.type === 'vintimated:schedule.start') {
    scheduleStart(message.defn, sender).then(respond);
    return true; // the reply is asynchronous
  }

  if (message.type === 'vintimated:schedule.stop') {
    scheduleEnd('stop', sender).then(respond);
    return true;
  }

  if (message.type === 'vintimated:schedule.abort') {
    scheduleEnd('abort', sender).then(respond);
    return true;
  }

  if (message.type === 'vintimated:schedule.status') {
    scheduleStatus(sender).then(respond);
    return true;
  }

  return false;
});

// The engine tab writes the books as it works, and the alarm follows the
// state rather than whoever last asked for something: a worker torn down
// between a firing and its consequence comes back to the same truth. The
// switch off is the one change that reaches past the books to the tab: an
// extension that is off keeps no engine room open, and the books stay put
// until the seller comes back or stops the run.
ext.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes) return;
  if (ENABLED_KEY in changes && changes[ENABLED_KEY].newValue === false) closeEngineTab();
  if (SCHEDULE_KEY in changes) syncScheduleAlarm();
});

// And on the way up, because an alarm survives a browser restart but not a
// reload or an update of the extension, and the books may say running either
// way.
syncScheduleAlarm();

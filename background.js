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
// answered with the same two things — the state as it now stands and the
// definition it runs, lifted out beside it for callers that only want the
// settings:
//
//   vintimated:schedule.start    { defn }  -> { state, defn }  begin a run
//   vintimated:schedule.stop               -> { state, defn }  end the period
//   vintimated:schedule.abort              -> { state, defn }  cancel the run
//   vintimated:schedule.status             -> { state, defn }  just the books
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
  wakeWardrobeTabs();
});

// TASK 4 HOOK — the engine tab. A run needs one wardrobe tab to live in, and
// the whole dance — adopt the wardrobe tab that is open or open the remembered
// profile, keep the tab on the wardrobe, close it when the run is over — is
// Task 4's to write. Until then this is the smallest honest version: a
// wardrobe tab already open is the engine tab, and where there is none the
// remembered profile is opened to be one.
async function ensureEngineTab() {
  try {
    const tabs = await ext.tabs.query({ url: WARDROBE_URL_PATTERNS });
    if (tabs.length) return;
    const bag = await ext.storage.local.get([LAST_PROFILE_KEY]);
    if (bag[LAST_PROFILE_KEY]) await ext.tabs.create({ url: bag[LAST_PROFILE_KEY] });
  } catch (err) {
    console.debug('[Vintimated] could not give the schedule its engine tab', err);
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

// Every answer, the same shape.
function scheduleAnswer(state) {
  return { state, defn: state.defn };
}

async function scheduleStatus() {
  return scheduleAnswer(await readSchedule());
}

// A start is the form's defn turned into a run: the state machine draws the
// period from now, and the alarm and the engine tab follow the books. A start
// that lands on a running schedule begins the clean run transition defines —
// one alarm, one tab, never two of either.
async function scheduleStart(defn) {
  // A message that carries no definition is not a start: the caller gets the
  // books back and no run is invented out of a malformed message.
  if (!defn || typeof defn !== 'object' || Array.isArray(defn)) return scheduleStatus();
  const state = Scheduler.transition(await readSchedule(), {
    type: 'start',
    defn,
    now: Date.now(),
  });
  await writeSchedule(state);
  await syncScheduleAlarm();
  await ensureEngineTab();
  return scheduleAnswer(state);
}

// Stop and abort differ only in what the transition wipes — stop keeps the
// period's books, abort clears them — so one handler carries both verbs. The
// lease goes with either: the tab that held the floor held it for a run that
// is over. A stop or abort that finds no definition to act on writes nothing
// at all, so the books only ever hold a state deserialize would believe.
async function scheduleEnd(verb) {
  let state = await readSchedule();
  if (state.defn != null) {
    state = Scheduler.transition(state, { type: verb, now: Date.now() });
    await writeSchedule(state);
  }
  try {
    await ext.storage.local.remove(SCHEDULE_LEASE_KEY);
  } catch (err) {
    console.debug('[Vintimated] could not drop the schedule lease', err);
  }
  await syncScheduleAlarm();
  return scheduleAnswer(state);
}

ext.runtime.onMessage.addListener((message, _sender, respond) => {
  if (!message || !message.type) return false;

  if (message.type === 'vintimated:schedule.start') {
    scheduleStart(message.defn).then(respond);
    return true; // the reply is asynchronous
  }

  if (message.type === 'vintimated:schedule.stop') {
    scheduleEnd('stop').then(respond);
    return true;
  }

  if (message.type === 'vintimated:schedule.abort') {
    scheduleEnd('abort').then(respond);
    return true;
  }

  if (message.type === 'vintimated:schedule.status') {
    scheduleStatus().then(respond);
    return true;
  }

  return false;
});

// The engine tab writes the books as it works, and the alarm follows the
// state rather than whoever last asked for something: a worker torn down
// between a firing and its consequence comes back to the same truth.
ext.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes) return;
  if (SCHEDULE_KEY in changes) syncScheduleAlarm();
});

// And on the way up, because an alarm survives a browser restart but not a
// reload or an update of the extension, and the books may say running either
// way.
syncScheduleAlarm();

# Vintimated

Relist one or many Vinted listings safely, with refreshed photos.

## What Vintimated does

Vintimated is a browser extension for Vinted sellers:

- **Single relist** (in this baseline): one click on a listing copies its photos
  and details, waits until the copy is ready, and only then removes the old
  listing and publishes the copy — so nothing is deleted until its replacement
  exists, and your item goes back on top of the search results.
- **Bulk relist** (lands in a later task of this branch): relist many or all of
  your listings as a paced queue that halts at the first sign of a refusal.
- **Photo refresh** (lands in a later task of this branch): refresh the photos at
  upload so relisted items are not flagged as duplicates.

To be honest about where this branch stands: today the extension relists one
listing at a time. The bulk relist and photo refresh features described above
are the point of this fork, but they are still being built in the later tasks of
this branch and are not in this baseline yet.

## Installation from source

There is no npm install step; the build script uses only Node (18+) built-ins.

1. Build the packages:

   ```bash
   node build.mjs
   ```

   This writes `build/vintimated-<version>-chrome/` and
   `build/vintimated-<version>-firefox/` (plus a store-ready zip for each).

2. Load it unpacked:

   - **Chrome / Edge**: open `chrome://extensions`, enable Developer mode,
     click **Load unpacked**, and choose `build/vintimated-<version>-chrome/`.
   - **Firefox**: open `about:debugging#/runtime/this-firefox`, click
     **Load Temporary Add-on…**, and choose the `manifest.json` inside
     `build/vintimated-<version>-firefox/`.

## Based on Bumpline by g1ampy — GPL-3.0

Vintimated is a fork of [Bumpline by g1ampy](https://github.com/g1ampy/Bumpline),
a one-click Vinted relister. Bumpline is Copyright (C) 2026 g1ampy and is
licensed under the [GNU General Public License v3.0](LICENSE); Vintimated is
distributed under the same license. Upstream's copyright headers are preserved
in every source file, and changes are marked
`Modifications Copyright (C) 2026 Vintimated contributors.`

## Risk and terms of service

Automating Vinted is very likely against Vinted's terms of service. Using this
extension can get your listings removed, your account limited, or your account
banned. Vintimated paces its actions and stops when Vinted refuses a request,
but none of that is permission or protection. **You are responsible for how you
use this.**

## Not affiliated with, endorsed by, or connected to Vinted

Vintimated is an independent, unofficial project. Not affiliated with, endorsed
by, or connected to Vinted.

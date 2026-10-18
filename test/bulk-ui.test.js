// Vintimated — tests for the bulk selection helpers.
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

// "Relist all" walks the whole wardrobe and must never queue an item Vinted
// would refuse to copy: a sold or reserved listing in the queue is a walk that
// stalls over something that could never have worked. filterEditable is the
// whole of that decision — a list in, the ids the predicate accepts out — so it
// is pinned here with the wardrobe shapes that decide it.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const BulkQueue = require('../bulk-queue.js');

test('filterEditable keeps only the items the predicate accepts', () => {
  const items = [
    { id: 101, status: 'active' },
    { id: 102, status: 'active' },
    { id: 103, status: 'sold' },
    { id: 104, status: 'reserved' },
    { id: 105, status: 'active' },
  ];
  const ids = BulkQueue.filterEditable(items, item => item.status === 'active');
  assert.deepEqual(ids, [101, 102, 105]);
});

test('filterEditable on an empty list returns no ids', () => {
  assert.deepEqual(BulkQueue.filterEditable([], item => item.status === 'active'), []);
});

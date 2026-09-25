import { test } from 'node:test';
import assert from 'node:assert/strict';
import { indexExport, isFileUnit, firstPageUrl, repairExportText } from '../src/adapters/bluebook.mjs';

// Two synthetic fileUnit records in the real bulk-export shape (confirmed
// against catalog.archives.gov's own catalog-export-597821.json, 25
// September 2026): a flat JSON array of fileUnits, each carrying naId,
// title, levelOfDescription and digitalObjects[], where each digital object
// carries objectFilename, objectUrl, objectFileSize, objectDesignator,
// objectId, objectDescription and objectType.
const RECORD_A = {
  levelOfDescription: 'fileUnit',
  recordType: 'description',
  naId: 28929100,
  title: 'Hamburg, New York, June 1947',
  accessRestriction: { status: 'Unrestricted' },
  useRestriction: { status: 'Unrestricted' },
  generalRecordsTypes: ['Textual Records'],
  ancestors: [{ naId: 597821, levelOfDescription: 'series', title: 'Sanitized Version of Project Blue Book Case Files on Sightings of Unidentified Flying Objects' }],
  digitalObjects: [
    {
      objectFilename: '0496.jpg',
      objectUrl: 'https://s3.amazonaws.com/NARAprodstorage/opastorage/live/0/9291/28929100/content/TB0106/T1206-ProjectBlueBook/T1206_0001/images/0496.jpg',
      objectFileSize: 12345678,
      objectDesignator: 'Fold3 File #9668679',
      objectId: '28929101',
      objectDescription: 'Image provided by Fold3.',
      objectType: 'Image (JPG)',
    },
    {
      objectFilename: '0497.jpg',
      objectUrl: 'https://s3.amazonaws.com/NARAprodstorage/opastorage/live/0/9291/28929100/content/TB0106/T1206-ProjectBlueBook/T1206_0001/images/0497.jpg',
      objectFileSize: 12345678,
      objectDesignator: 'Fold3 File #9668680',
      objectId: '28929102',
      objectDescription: 'Image provided by Fold3.',
      objectType: 'Image (JPG)',
    },
  ],
};

const RECORD_B = {
  levelOfDescription: 'fileUnit',
  recordType: 'description',
  naId: 28929112,
  title: 'Hungary, June 1947',
  accessRestriction: { status: 'Unrestricted' },
  useRestriction: { status: 'Unrestricted' },
  generalRecordsTypes: ['Textual Records'],
  ancestors: [{ naId: 597821, levelOfDescription: 'series', title: 'Sanitized Version of Project Blue Book Case Files on Sightings of Unidentified Flying Objects' }],
  digitalObjects: [
    {
      objectFilename: '0505.jpg',
      objectUrl: 'https://s3.amazonaws.com/NARAprodstorage/opastorage/live/12/9291/28929112/content/TB0106/T1206-ProjectBlueBook/T1206_0001/images/0505.jpg',
      objectFileSize: 12345678,
      objectDesignator: 'Fold3 File #9668691',
      objectId: '28929113',
      objectDescription: 'Image provided by Fold3.',
      objectType: 'Image (JPG)',
    },
  ],
};

// A record NARA's export can also contain: no digitalObjects at all (never
// digitised), which index must skip rather than error on.
const RECORD_NO_OBJECTS = {
  levelOfDescription: 'fileUnit',
  naId: 99999999,
  title: '[BLANK], [BLANK]',
  digitalObjects: [],
};

test('isFileUnit requires a naId, a title and at least one digital object', () => {
  assert.equal(isFileUnit(RECORD_A), true);
  assert.equal(isFileUnit(RECORD_NO_OBJECTS), false);
  assert.equal(isFileUnit({ naId: 1, title: 'x' }), false);
  assert.equal(isFileUnit({ title: 'x', digitalObjects: [{}] }), false);
  assert.equal(isFileUnit(null), false);
});

test('firstPageUrl prefers an image or PDF page over other digital object types', () => {
  assert.equal(firstPageUrl(RECORD_A.digitalObjects), RECORD_A.digitalObjects[0].objectUrl);
  const withAudioFirst = [{ objectUrl: 'https://example.com/clip.mp3' }, { objectUrl: 'https://example.com/page.pdf' }];
  assert.equal(firstPageUrl(withAudioFirst), 'https://example.com/page.pdf');
  const noUrls = [{ objectFilename: 'x.jpg' }];
  assert.equal(firstPageUrl(noUrls), null);
});

test('indexExport reads the real bulk-export shape: a flat array of fileUnits', () => {
  const { rows, sampleKeys } = indexExport([RECORD_A, RECORD_NO_OBJECTS, RECORD_B]);
  assert.equal(rows.length, 2, 'the record with no digital objects is skipped');
  assert.deepEqual(rows[0], {
    naId: '28929100', title: 'Hamburg, New York, June 1947',
    url: RECORD_A.digitalObjects[0].objectUrl, pages: 2,
  });
  assert.deepEqual(rows[1], {
    naId: '28929112', title: 'Hungary, June 1947',
    url: RECORD_B.digitalObjects[0].objectUrl, pages: 1,
  });
  assert.deepEqual(sampleKeys, {
    unit: Object.keys(RECORD_A),
    object: Object.keys(RECORD_A.digitalObjects[0]),
  });
});

test('indexExport tolerates a non-array export instead of throwing', () => {
  assert.deepEqual(indexExport({ not: 'an array' }), { rows: [], sampleKeys: null });
});

// NARA's own 25 September 2026 download of catalog-export-597821.json has
// exactly one top-level array separator with the comma missing, e.g.:
//   ...
//     "naId": 302569368
//   }
//   {
//     "onlineResources": [...
// (confirmed against a fresh byte-range fetch of the live file, so this is
// NARA's own export, not something our paged download introduced).
const BROKEN_JSON = '[\n  {\n    "naId": 1,\n    "title": "A"\n  }\n  {\n    "naId": 2,\n    "title": "B"\n  }\n]';

test('repairExportText inserts the one missing top-level array comma and reports it', () => {
  const { text, repaired } = repairExportText(BROKEN_JSON);
  assert.equal(repaired, 1);
  assert.deepEqual(JSON.parse(text), [{ naId: 1, title: 'A' }, { naId: 2, title: 'B' }]);
});

test('repairExportText is a no-op on already well-formed JSON', () => {
  const good = '[\n  {\n    "naId": 1\n  },\n  {\n    "naId": 2\n  }\n]';
  const { text, repaired } = repairExportText(good);
  assert.equal(repaired, 0);
  assert.equal(text, good);
});

test('repairExportText leaves correctly comma-separated nested objects (deeper indent) untouched', () => {
  const nested = '[\n  {\n    "naId": 1,\n    "digitalObjects": [\n      {\n        "objectUrl": "a"\n      },\n      {\n        "objectUrl": "b"\n      }\n    ]\n  }\n]';
  const { text, repaired } = repairExportText(nested);
  assert.equal(repaired, 0);
  assert.equal(text, nested);
  assert.equal(JSON.parse(text)[0].digitalObjects.length, 2);
});

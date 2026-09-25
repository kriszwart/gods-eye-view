import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  stripHtml,
  isFreeLicence,
  cleanAuthor,
  filePathUrl,
  imageFilename,
  wikipediaUrl,
  attributionFromImageInfo,
  enrichSite,
} from '../src/adapters/wikidata-enrich.mjs';

// One realistic wbgetentities entity (trimmed to the props the script reads).
const ENTITY_WITH_IMAGE = {
  type: 'item',
  id: 'Q42171',
  claims: {
    P18: [
      {
        mainsnak: {
          snaktype: 'value',
          property: 'P18',
          datavalue: { value: "Stonehenge, Salisbury Plain, England.jpg", type: 'string' },
        },
      },
    ],
  },
  sitelinks: {
    enwiki: { site: 'enwiki', title: 'Stonehenge', badges: [] },
    frwiki: { site: 'frwiki', title: 'Stonehenge', badges: [] },
  },
};

const ENTITY_NO_IMAGE = {
  type: 'item',
  id: 'Q9999',
  claims: {},
  sitelinks: { enwiki: { site: 'enwiki', title: 'Some site', badges: [] } },
};

const ENTITY_NO_ENWIKI = {
  type: 'item',
  id: 'Q8888',
  claims: {
    P18: [{ mainsnak: { snaktype: 'value', property: 'P18', datavalue: { value: 'Only in French wiki.jpg', type: 'string' } } }],
  },
  sitelinks: { frwiki: { site: 'frwiki', title: 'Quelque chose', badges: [] } },
};

// One realistic Commons imageinfo response, keyed by page id, the way the
// query API returns it (the extmetadata Artist value carries HTML).
const IMAGEINFO_FREE = {
  batchcomplete: '',
  query: {
    pages: {
      '12345': {
        pageid: 12345,
        ns: 6,
        title: 'File:Stonehenge, Salisbury Plain, England.jpg',
        imageinfo: [
          {
            extmetadata: {
              LicenseShortName: { value: 'CC BY-SA 3.0' },
              Artist: {
                value:
                  '<a href="//commons.wikimedia.org/wiki/User:Someone" title="User:Someone">Diego&nbsp;Delso</a>',
              },
            },
          },
        ],
      },
    },
  },
};

const IMAGEINFO_NOT_FREE = {
  query: {
    pages: {
      '999': {
        imageinfo: [
          {
            extmetadata: {
              LicenseShortName: { value: 'No restrictions' },
              Artist: { value: 'The British Library' },
            },
          },
        ],
      },
    },
  },
};

const IMAGEINFO_NO_AUTHOR = {
  query: {
    pages: {
      '1000': {
        imageinfo: [
          {
            extmetadata: {
              LicenseShortName: { value: 'Public domain' },
            },
          },
        ],
      },
    },
  },
};

// A real-world Commons Artist value: an old-style unsigned wiki signature
// (leading "--", a trailing timestamp) rather than a plain name.
const IMAGEINFO_NOISY_AUTHOR = {
  query: {
    pages: {
      '1001': {
        imageinfo: [
          {
            extmetadata: {
              LicenseShortName: { value: 'CC BY-SA 3.0' },
              Artist: { value: '--Pinpin 17:43, 1 August 2006 (UTC)' },
            },
          },
        ],
      },
    },
  },
};

test('stripHtml drops tags and decodes entities (textContent semantics)', () => {
  assert.equal(
    stripHtml('<a href="//commons.wikimedia.org/wiki/User:Someone" title="User:Someone">Diego&nbsp;Delso</a>'),
    'Diego Delso',
  );
  assert.equal(stripHtml('Plain text, no markup'), 'Plain text, no markup');
  assert.equal(stripHtml('<span>A &amp; B</span>'), 'A & B');
  assert.equal(stripHtml('  <b>spaced</b>   out  '), 'spaced out');
  assert.equal(stripHtml(null), '');
  assert.equal(stripHtml(undefined), '');
});

test('isFreeLicence accepts only the licences we may ship', () => {
  for (const lic of ['CC0', 'CC BY 4.0', 'CC BY-SA 2.5', 'cc-by-sa-3.0', 'Public domain', 'PDM']) {
    assert.ok(isFreeLicence(lic), lic);
  }
  for (const lic of ['CC SA 1.0', 'No restrictions', '', null, undefined, 'All rights reserved']) {
    assert.ok(!isFreeLicence(lic), String(lic));
  }
});

test('isFreeLicence rejects every non-commercial and no-derivatives variant', () => {
  for (const lic of ['CC BY-NC 4.0', 'CC BY-ND 4.0', 'CC BY-NC-SA 4.0', 'CC BY-NC-ND 4.0']) {
    assert.ok(!isFreeLicence(lic), lic);
  }
});

test('cleanAuthor strips a leading wiki-signature dash, a trailing (talk) link and a trailing signature timestamp', () => {
  assert.equal(cleanAuthor('--Pinpin 17:43, 1 August 2006 (UTC)'), 'Pinpin');
  assert.equal(cleanAuthor('Nevit Dilmen (talk)'), 'Nevit Dilmen');
  assert.equal(cleanAuthor('Diego Delso'), 'Diego Delso');
  assert.equal(cleanAuthor(''), '');
  assert.equal(cleanAuthor(null), '');
  assert.equal(cleanAuthor(undefined), '');
});

test('filePathUrl builds a Special:FilePath URL at width=640, URL-encoded', () => {
  assert.equal(
    filePathUrl('Stonehenge, Salisbury Plain, England.jpg'),
    'https://commons.wikimedia.org/wiki/Special:FilePath/Stonehenge%2C%20Salisbury%20Plain%2C%20England.jpg?width=640',
  );
  assert.equal(
    filePathUrl("Gilgal Refa'im - Rujm el-Hiri.JPG", 320),
    "https://commons.wikimedia.org/wiki/Special:FilePath/Gilgal%20Refa'im%20-%20Rujm%20el-Hiri.JPG?width=320",
  );
});

test('imageFilename reads claims.P18[0].mainsnak.datavalue.value, or null', () => {
  assert.equal(imageFilename(ENTITY_WITH_IMAGE), 'Stonehenge, Salisbury Plain, England.jpg');
  assert.equal(imageFilename(ENTITY_NO_IMAGE), null);
  assert.equal(imageFilename(null), null);
});

test('wikipediaUrl builds the enwiki article URL with underscores, or null', () => {
  assert.equal(wikipediaUrl(ENTITY_WITH_IMAGE), 'https://en.wikipedia.org/wiki/Stonehenge');
  assert.equal(wikipediaUrl(ENTITY_NO_ENWIKI), null);
  assert.equal(wikipediaUrl(null), null);
});

test('wikipediaUrl replaces spaces with underscores for multi-word titles', () => {
  const entity = { sitelinks: { enwiki: { title: 'Menec alignments' } } };
  assert.equal(wikipediaUrl(entity), 'https://en.wikipedia.org/wiki/Menec_alignments');
});

test('attributionFromImageInfo extracts licence and HTML-stripped author for a free licence', () => {
  assert.deepEqual(attributionFromImageInfo(IMAGEINFO_FREE), { licence: 'CC BY-SA 3.0', author: 'Diego Delso' });
});

test('attributionFromImageInfo returns null for a non-free licence', () => {
  assert.equal(attributionFromImageInfo(IMAGEINFO_NOT_FREE), null);
});

test('attributionFromImageInfo cleans a noisy wiki-signature author', () => {
  assert.deepEqual(attributionFromImageInfo(IMAGEINFO_NOISY_AUTHOR), { licence: 'CC BY-SA 3.0', author: 'Pinpin' });
});

test('attributionFromImageInfo returns null when the licence is free but no author is recorded', () => {
  assert.equal(attributionFromImageInfo(IMAGEINFO_NO_AUTHOR), null);
});

test('attributionFromImageInfo returns null for a malformed or missing response', () => {
  assert.equal(attributionFromImageInfo({}), null);
  assert.equal(attributionFromImageInfo(null), null);
  assert.equal(attributionFromImageInfo({ query: { pages: {} } }), null);
});

test('enrichSite fills image, image_attribution and wikipedia when the licence is free', () => {
  const site = { id: 'stonehenge', name: 'Stonehenge', glyph: 'circle' };
  const enriched = enrichSite(site, ENTITY_WITH_IMAGE, IMAGEINFO_FREE);
  assert.equal(enriched.id, 'stonehenge');
  assert.equal(enriched.glyph, 'circle');
  assert.equal(
    enriched.image,
    'https://commons.wikimedia.org/wiki/Special:FilePath/Stonehenge%2C%20Salisbury%20Plain%2C%20England.jpg?width=640',
  );
  assert.deepEqual(enriched.image_attribution, { licence: 'CC BY-SA 3.0', author: 'Diego Delso' });
  assert.equal(enriched.wikipedia, 'https://en.wikipedia.org/wiki/Stonehenge');
});

test('enrichSite leaves image and image_attribution null when the licence is not free', () => {
  const site = { id: 'x' };
  const enriched = enrichSite(site, ENTITY_WITH_IMAGE, IMAGEINFO_NOT_FREE);
  assert.equal(enriched.image, null);
  assert.equal(enriched.image_attribution, null);
  assert.equal(enriched.wikipedia, 'https://en.wikipedia.org/wiki/Stonehenge');
});

test('enrichSite leaves image null when the entity carries no P18 image at all', () => {
  const site = { id: 'x' };
  const enriched = enrichSite(site, ENTITY_NO_IMAGE, IMAGEINFO_FREE);
  assert.equal(enriched.image, null);
  assert.equal(enriched.image_attribution, null);
  assert.equal(enriched.wikipedia, 'https://en.wikipedia.org/wiki/Some site'.replace(' ', '_'));
});

test('enrichSite preserves the original site fields and field order is stable across calls', () => {
  const site = { id: 'x', name: 'X', lat: 1, lon: 2 };
  const a = enrichSite(site, ENTITY_WITH_IMAGE, IMAGEINFO_FREE);
  const b = enrichSite(site, ENTITY_WITH_IMAGE, IMAGEINFO_FREE);
  assert.deepEqual(Object.keys(a), Object.keys(b));
  assert.deepEqual(Object.keys(a), ['id', 'name', 'lat', 'lon', 'image', 'image_attribution', 'wikipedia']);
});

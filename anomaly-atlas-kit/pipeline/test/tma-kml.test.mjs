import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTmaKml } from '../src/adapters/tma-kml.mjs';

const FIXTURE = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>The Modern Antiquarian sites</name>
<Folder><name>Stone Circle (2)</name>
<Placemark><name>Avebury</name><description><![CDATA[Stone Circle<br><a href="https://www.themodernantiquarian.com/site/23/avebury">https://www.themodernantiquarian.com/site/23/avebury</a>]]></description><Point><coordinates>-1.8547071211094,51.42839968297,0</coordinates></Point></Placemark>
</Folder></Document></kml>`;

test('parses placemarks with folder category, swapped lat lon and url', () => {
  const rows = parseTmaKml(FIXTURE);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], {
    name: 'Avebury',
    category: 'Stone Circle',
    lat: 51.42839968297,
    lon: -1.8547071211094,
    url: 'https://www.themodernantiquarian.com/site/23/avebury',
  });
});

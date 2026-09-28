/**
 * Documented report waves marked on the sky chronometer's corona: years when
 * public sources recorded a surge in UAP/UFO sighting reports. Every note is
 * worded as reports or reporting, never as a claim that an object was
 * present (data honesty, see PHENOMENA_DESIGN.md). Portable: no Cesium, no
 * browser globals.
 *
 * The set is the controller-approved landmark list with one swap: "1965
 * South American wave" had no dedicated, well-documented source, so it is
 * replaced with the 1977 Colares wave in Brazil (Operação Prato), a
 * documented, officially investigated South American wave with a dedicated
 * Wikipedia article. See task-2-report.md for the reviewer's note on this
 * swap.
 *
 * @type {Array<{year: number, label: string, note: string, source_url: string}>}
 */
export const WAVES = [
  {
    year: 1947,
    label: '1947 United States wave',
    note: "A wave of reports followed Kenneth Arnold's sighting near Mount Rainier, spreading across the United States within weeks.",
    source_url: 'https://en.wikipedia.org/wiki/1947_flying_disc_craze',
  },
  {
    year: 1952,
    label: '1952 Washington DC flap',
    note: 'A wave of UFO reports over Washington DC in July 1952 drew national press coverage and military scrutiny.',
    source_url:
      'https://en.wikipedia.org/wiki/1952_Washington,_D.C.,_UFO_incident',
  },
  {
    year: 1954,
    label: '1954 French wave',
    note: 'A wave of UFO reports swept France in autumn 1954, among the first such waves reported outside the United States.',
    source_url: 'https://en.wikipedia.org/wiki/UFO_sightings_in_France#1954',
  },
  {
    year: 1977,
    label: '1977 Colares wave (Brazil)',
    note: 'A wave of reports of unexplained lights over Colares, Brazil prompted a Brazilian Air Force investigation in 1977.',
    source_url: 'https://en.wikipedia.org/wiki/Opera%C3%A7%C3%A3o_Prato',
  },
  {
    year: 1989,
    label: '1989 Belgian wave',
    note: "A wave of reports of triangular craft over Belgium ran from late 1989 into 1990, among Europe's best documented waves.",
    source_url: 'https://en.wikipedia.org/wiki/Belgian_UFO_wave',
  },
  {
    year: 2017,
    label: '2017 Nimitz disclosure reporting',
    note: 'In December 2017 the New York Times reported on Navy pilot encounters, bringing the 2004 USS Nimitz case to public attention.',
    source_url: 'https://en.wikipedia.org/wiki/Pentagon_UFO_videos',
  },
];

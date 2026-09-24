// Extraction prompts for the Message Batches API. Output must be JSON only.

export const SYSTEM = `You extract structured facts about reported aerial phenomena from archival documents for a research atlas.
Rules:
- Reply with one JSON object only, no prose and no code fences.
- Never output personal names, addresses, phone numbers or other identifying details of witnesses or officials. Refer to people by role ("a police officer", "two pilots").
- Write "summary" in your own neutral words, at most 280 characters, British English, no quotations from the document, no speculation.
- Dates in ISO 8601 (YYYY-MM-DD, or YYYY-MM or YYYY when that is all the document gives). Use null for anything the document does not state.
- "place" is the nearest named town or feature plus region and country, as written in the document.
- "status" must be one of: explained, insufficient, contested, unresolved. Use the document's own conclusion; do not judge the case yourself.
- "confidence" is your confidence (0 to 1) that the fields match the document.`;

const INCIDENT_FIELDS = `{"date": string|null, "time_local": string|null, "place": string|null, "country": "ISO alpha-2"|null,
 "shape_raw": string|null, "objects": integer|null, "duration_s": number|null, "observer_type": "civilian"|"military"|"pilot"|"police"|"radar"|"mixed"|null,
 "official_conclusion": string|null, "status": "explained"|"insufficient"|"contested"|"unresolved",
 "summary": string, "confidence": number}`;

export const INSTRUCTIONS = {
  bluebook: `This image is the first page of a US Air Force Project Blue Book case file, usually the "Project 10073 Record Card".
Read the card's fields (date, location, date-time group, source, number of objects, length of observation, course, brief summary, conclusions).
Map the ticked conclusion to "official_conclusion" (for example "Balloon", "Aircraft", "Astronomical", "Insufficient data", "Unidentified").
Status: "Unidentified" means unresolved; "Insufficient data" means insufficient; any identified category means explained.
If the page is not a record card, still extract what you can and set confidence below 0.5.
Return: {"incident": ${INCIDENT_FIELDS}, "page_kind": "record_card"|"letter"|"report"|"other"}`,
  pursue: `This is a file from a US Department of War PURSUE release about unidentified anomalous phenomena.
It may describe one incident or several. Extract every distinct incident. Keep the file's own identifier if it shows one (for example "CIA-UAP-017").
Return: {"file_id": string|null, "incidents": [${INCIDENT_FIELDS}]}`,
  ukmod: `These pages come from UK Ministry of Defence UFO files held at The National Archives.
They often contain "Report of an Unidentified Aerial Phenomenon" forms. Extract every distinct report on these pages.
Return: {"file_ref": string|null, "incidents": [${INCIDENT_FIELDS}]}`,
};

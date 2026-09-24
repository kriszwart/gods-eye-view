// Conservative, pattern-based redaction applied to every free-text field after
// extraction. The extraction prompt already forbids names; this is the net.

const PATTERNS = [
  ['email', /[\w.+-]+@[\w-]+\.[\w.-]+/g],
  ['address', /\b\d{1,5}\s+(?:[A-Z][a-zA-Z]+\s){1,3}(?:Street|St|Road|Rd|Avenue|Ave|Lane|Ln|Drive|Close|Way|Court|Ct|Boulevard|Blvd|Crescent|Terrace|Rue|Chemin|Allee)\b\.?/g],
  ['phone', /(?<![\w-])(?:\+?\d{1,3}[\s.-]?)?(?:\(\d{2,4}\)[\s.-]?)?\d{3,4}[\s.-]\d{3,4}(?:[\s.-]\d{2,4})?(?![\w-])/g],
  ['honorific', /\b(?:Mr|Mrs|Ms|Miss|Dr|Sgt|Capt|Lt|Col|Maj|Cpl|Pvt|Mme|Mlle|M\.)\.?\s+[A-Z][a-zA-Z'-]+(?:\s+[A-Z][a-zA-Z'-]+)?/g],
  ['labelled', /\b(?:name|witness|observer|reported by|nom|t[ée]moin)\s*[:=]\s*[^\n,;]{2,60}/gi],
];

export function redactText(text) {
  if (text == null) return { text: null, hits: [] };
  let out = String(text);
  const hits = [];
  for (const [kind, re] of PATTERNS) {
    out = out.replace(re, () => {
      hits.push(kind);
      return '[redacted]';
    });
  }
  return { text: out, hits };
}

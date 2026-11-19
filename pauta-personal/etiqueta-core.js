// Leer una etiqueta: pure logic, no DOM and no network.
// The reader only extracts what is printed. The person confirms every value, and
// the screen then shows only sentences copied word for word from the pauta. Nothing
// here compares a number against anything, scores a product or decides for anyone.

// The label reader (Cloudflare Worker, etiquetas-worker/). Only this address is called.
export const READER_URL = "https://mi-pauta-etiquetas.matiasjbarriah.workers.dev/leer";

// Remembers that the notice was read. Separate from every registro key.
export const NOTICE_KEY = "etiqueta-aviso-v1";

export const MAX_SIDE = 1600;
export const MAX_BYTES = 1_400_000;
export const TIMEOUT_MS = 25_000;

// The reader's three answers, exactly as it writes them.
export const SI = "sí";
export const NO = "no";
export const ILEGIBLE = "no se pudo leer";
const ANSWERS = [SI, NO, ILEGIBLE];

export const SEALS = [
  { key: "alto_en_sodio", label: "«ALTO EN SODIO»" },
  { key: "alto_en_azucares", label: "«ALTO EN AZÚCARES»" },
  { key: "alto_en_grasas_saturadas", label: "«ALTO EN GRASAS SATURADAS»" },
  { key: "alto_en_calorias", label: "«ALTO EN CALORÍAS»" },
];
export const POTASSIUM = { key: "cloruro_de_potasio", label: "«cloruro de potasio» en los ingredientes" };
export const SODIUM = [
  { key: "sodio_mg_100", label: "Sodio por 100 gramos o 100 mililitros" },
  { key: "sodio_mg_porcion", label: "Sodio por porción" },
];

// --- Sentences of the pauta (index.html), copied word for word -------------------

/** index.html, «Para controlar la presión arterial» (section #presion). */
export const PAUTA_SODIO = "Elegir productos con menor cantidad de sodio.";
/** index.html, «Indicaciones generales» (section #indicaciones). */
export const PAUTA_POTASIO = "No usar 'sal light' o sustitutos de sal con potasio.";
export const NEUTRAL = "Tu pauta no tiene una indicación sobre esto. Consulta con tu equipo tratante si tienes dudas.";

/**
 * What to show after the person confirms. Only the two pauta sentences, and only
 * when the person confirmed «sí»; otherwise the neutral line. The sodium numbers
 * are never read here.
 */
export function phrasesFor(confirmed) {
  const c = confirmed || {};
  const out = [];
  if (c.alto_en_sodio === SI) out.push({ text: PAUTA_SODIO, pauta: true, href: "index.html#presion" });
  if (c.cloruro_de_potasio === SI) out.push({ text: PAUTA_POTASIO, pauta: true, href: "index.html#indicaciones" });
  if (!out.length) out.push({ text: NEUTRAL, pauta: false, href: "index.html#inicio" });
  return out;
}

// --- Errors ---------------------------------------------------------------------

const OFFLINE = "Para leer una etiqueta se necesita internet. El resto de Mi pauta sigue funcionando sin conexión.";
const GENERIC = "No se pudo leer la etiqueta en este momento. Inténtalo más tarde.";
const BY_STATUS = {
  400: "La foto no se pudo leer así. Prueba sacando otra foto del envase.",
  413: "La foto quedó demasiado pesada. Prueba sacando otra foto, un poco más lejos.",
  415: "Ese tipo de imagen no se puede leer. Prueba con una foto de la cámara.",
  429: "Se leyeron muchas etiquetas seguidas. Espera un minuto y vuelve a intentarlo.",
  502: "No se pudo leer la etiqueta en esta foto. Prueba con otra foto, con buena luz y más cerca de la tabla nutricional.",
  503: "El lector de etiquetas no está disponible en este momento. Inténtalo más tarde.",
  504: "La lectura tardó demasiado. Vuelve a intentarlo en un momento.",
};

/**
 * Friendly message for a failed reading. `failure` is one of
 * { type: "offline" | "network" | "timeout" | "invalid" } or { type: "status", status }.
 * The reader's own error text is never shown.
 */
export function failureMessage(failure) {
  const f = failure || {};
  if (f.type === "offline" || f.type === "network") return OFFLINE;
  if (f.type === "timeout") return BY_STATUS[504];
  if (f.type === "status" && Object.prototype.hasOwnProperty.call(BY_STATUS, f.status)) return BY_STATUS[f.status];
  return GENERIC;
}

// Shown while preparing the photo, if the browser cannot strip it.
export const PREPARE_FAILED = "No se pudo preparar esta foto. Prueba con otra foto del envase.";

// Every sentence the screen can show from script, for the wording tests.
export const UI_COPY = [
  ...Object.values(BY_STATUS), OFFLINE, GENERIC, PREPARE_FAILED,
  PAUTA_SODIO, PAUTA_POTASIO, NEUTRAL,
  ...SEALS.map((s) => s.label), POTASSIUM.label, ...SODIUM.map((s) => s.label),
  SI, NO, ILEGIBLE,
];

// --- The reader's answer -> the confirmation form -------------------------------

const isAnswer = (v) => ANSWERS.includes(v);
const isAmount = (v) => v === null || (typeof v === "number" && Number.isFinite(v) && v >= 0);

/**
 * Checks the reader's answer and turns it into form values. Returns null when the
 * answer does not have the expected shape. A missing amount (null) becomes an empty
 * field, never 0; a printed 0 stays "0".
 */
export function readingToForm(r) {
  if (!r || typeof r !== "object" || !r.sellos || typeof r.sellos !== "object") return null;
  const out = {};
  for (const { key } of SEALS) {
    if (!isAnswer(r.sellos[key])) return null;
    out[key] = r.sellos[key];
  }
  if (!isAnswer(r[POTASSIUM.key])) return null;
  out[POTASSIUM.key] = r[POTASSIUM.key];
  for (const { key } of SODIUM) {
    if (!isAmount(r[key])) return null;
    out[key] = r[key] === null ? "" : String(r[key]);
  }
  return out;
}

// --- The photo -----------------------------------------------------------------

/** Size that keeps the shape and caps the long side at MAX_SIDE. */
export function fitSize(width, height, max = MAX_SIDE) {
  const long = Math.max(width, height);
  if (long <= max) return { width, height };
  const k = max / long;
  return { width: Math.round(width * k), height: Math.round(height * k) };
}

const QUALITIES = [0.86, 0.78, 0.7, 0.62, 0.54, 0.46];
const SCALES = [1, 0.8, 0.64, 0.5];

/**
 * Encodes at lower and lower quality, then smaller, until the result fits in
 * `max` bytes. `encode(quality, scale)` returns a Blob (or anything with `size`).
 * Returns { blob, quality, scale } or null when nothing fits.
 */
export async function encodeWithin(encode, max = MAX_BYTES) {
  for (const scale of SCALES) {
    for (const quality of QUALITIES) {
      const blob = await encode(quality, scale);
      if (blob && blob.size <= max) return { blob, quality, scale };
    }
  }
  return null;
}

export function isJpeg(b) {
  return b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
}

/**
 * True when the JPEG still carries an APP1 segment (Exif, or XMP, which can hold
 * the location). Walks the marker segments up to the start of scan. Fails closed:
 * anything it cannot walk counts as carrying metadata, so it is never sent.
 */
export function jpegHasApp1(b) {
  if (!isJpeg(b)) return true;
  let i = 2;
  while (i + 1 < b.length) {
    if (b[i] !== 0xff) return true;
    let m = b[i + 1];
    while (m === 0xff && i + 2 < b.length) {
      i += 1;
      m = b[i + 1];
    }
    if (m === 0xe1) return true;
    if (m === 0xda) return false; // start of scan: no more header segments
    if (m === 0xd9) return true; // ended without an image
    if (m === 0x01 || (m >= 0xd0 && m <= 0xd7)) {
      i += 2;
      continue;
    }
    if (i + 3 >= b.length) return true;
    const len = (b[i + 2] << 8) | b[i + 3];
    if (len < 2 || i + 2 + len > b.length) return true;
    i += 2 + len;
  }
  return true;
}

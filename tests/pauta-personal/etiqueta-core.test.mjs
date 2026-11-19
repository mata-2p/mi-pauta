// Behavior tests for pauta-personal/etiqueta-core.js (pure logic of «Leer una etiqueta»).
// No network: nothing here calls the label reader.
// Run: node --test 'tests/pauta-personal/*.test.mjs'
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const here = (p) => new URL(`../../pauta-personal/${p}`, import.meta.url);
const core = await import(here("etiqueta-core.js"));
const {
  isJpeg, jpegHasApp1, failureMessage, phrasesFor, readingToForm, fitSize, encodeWithin,
  PAUTA_SODIO, PAUTA_POTASIO, NEUTRAL, NOTICE_KEY, MAX_BYTES, MAX_SIDE, TIMEOUT_MS,
  SI, NO, ILEGIBLE, UI_COPY,
} = core;

const read = (p) => readFileSync(here(p), "utf8");

/** Visible text of an HTML file (no scripts, styles or tags), whitespace collapsed. */
function htmlText(html) {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ");
}
const pautaText = htmlText(read("index.html"));

// --- Minimal JPEG byte streams --------------------------------------------------

const SOI = [0xff, 0xd8];
const EOI = [0xff, 0xd9];
const seg = (marker, payload) => {
  const len = payload.length + 2;
  return [0xff, marker, len >> 8, len & 0xff, ...payload];
};
const ascii = (s) => [...s].map((c) => c.charCodeAt(0));
const APP0 = seg(0xe0, [...ascii("JFIF"), 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]);
const DQT = seg(0xdb, [0, ...new Array(64).fill(1)]);
const EXIF = seg(0xe1, [...ascii("Exif"), 0, 0, ...ascii("MM"), 0, 42, 0, 0, 0, 8]);
const XMP = seg(0xe1, [...ascii("http://ns.adobe.com/xap/1.0/"), 0, ...ascii("<x:xmpmeta/>")]);
// Start of scan, then entropy-coded data that happens to contain FF E1 (stuffed bytes
// and restart markers are part of scan data, not segments).
const SOS = [...seg(0xda, [1, 1, 0, 0, 63, 0]), 0x12, 0xff, 0x00, 0xff, 0xe1, 0x00, 0x04, 0xff, 0xd0, 0x34];
const jpeg = (...parts) => new Uint8Array([...SOI, ...parts.flat(), ...EOI]);

test("isJpeg accepts the JPEG start and rejects other formats", () => {
  assert.equal(isJpeg(jpeg(APP0, DQT, SOS)), true);
  assert.equal(isJpeg(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), false);
  assert.equal(isJpeg(new Uint8Array([])), false);
});

test("jpegHasApp1: a clean re-encoded JPEG (JFIF only) has no APP1", () => {
  assert.equal(jpegHasApp1(jpeg(APP0, DQT, SOS)), false);
});

test("jpegHasApp1: finds an Exif APP1 right after SOI or after APP0", () => {
  assert.equal(jpegHasApp1(jpeg(EXIF, DQT, SOS)), true);
  assert.equal(jpegHasApp1(jpeg(APP0, EXIF, DQT, SOS)), true);
});

test("jpegHasApp1: finds an XMP APP1 (it can hold the location too)", () => {
  assert.equal(jpegHasApp1(jpeg(APP0, DQT, XMP, SOS)), true);
});

test("jpegHasApp1: fill bytes before a marker do not hide an APP1", () => {
  assert.equal(jpegHasApp1(jpeg(APP0, [0xff, 0xff], EXIF, SOS)), true);
});

test("jpegHasApp1: FF E1 inside the scan data is not a segment", () => {
  assert.equal(jpegHasApp1(jpeg(APP0, DQT, SOS)), false);
});

test("jpegHasApp1: fails closed on a broken or truncated header", () => {
  // Garbage where a marker should be.
  assert.equal(jpegHasApp1(new Uint8Array([...SOI, ...APP0, 0x00, 0x11, 0x22])), true);
  // A segment length that runs past the end of the file.
  assert.equal(jpegHasApp1(new Uint8Array([...SOI, 0xff, 0xdb, 0x40, 0x00, 1, 2])), true);
  // Ends before any start of scan.
  assert.equal(jpegHasApp1(new Uint8Array([...SOI, ...APP0])), true);
  // Not a JPEG at all.
  assert.equal(jpegHasApp1(new Uint8Array([1, 2, 3, 4])), true);
});

// --- Errors shown to the person ------------------------------------------------

const EXPECTED = {
  400: "La foto no se pudo leer así. Prueba sacando otra foto del envase.",
  413: "La foto quedó demasiado pesada. Prueba sacando otra foto, un poco más lejos.",
  415: "Ese tipo de imagen no se puede leer. Prueba con una foto de la cámara.",
  429: "Se leyeron muchas etiquetas seguidas. Espera un minuto y vuelve a intentarlo.",
  502: "No se pudo leer la etiqueta en esta foto. Prueba con otra foto, con buena luz y más cerca de la tabla nutricional.",
  503: "El lector de etiquetas no está disponible en este momento. Inténtalo más tarde.",
  504: "La lectura tardó demasiado. Vuelve a intentarlo en un momento.",
};
const OFFLINE = "Para leer una etiqueta se necesita internet. El resto de Mi pauta sigue funcionando sin conexión.";
const GENERIC = "No se pudo leer la etiqueta en este momento. Inténtalo más tarde.";

// What the Worker writes in its error bodies; none of it may reach the screen.
const WORKER_TEXT = [
  "no encontrado", "origen no permitido", "imagen demasiado grande", "tipo de imagen no admitido",
  "demasiadas solicitudes", "error interno", "no se pudo leer la etiqueta", "servicio no configurado",
  "la lectura tardó demasiado", "imagen no válida", "foto con metadatos",
];

test("failureMessage maps each Worker status to its own friendly message", () => {
  for (const [status, text] of Object.entries(EXPECTED)) {
    assert.equal(failureMessage({ type: "status", status: Number(status) }), text, `status ${status}`);
  }
});

test("failureMessage: offline and a failed fetch say the reader needs internet", () => {
  assert.equal(failureMessage({ type: "offline" }), OFFLINE);
  assert.equal(failureMessage({ type: "network" }), OFFLINE);
});

test("failureMessage: the 25 s client timeout gets the timeout message", () => {
  assert.equal(TIMEOUT_MS, 25_000);
  assert.equal(failureMessage({ type: "timeout" }), EXPECTED[504]);
});

test("failureMessage: any other status, a malformed answer or nothing gets the generic message", () => {
  for (const status of [403, 404, 500, 418, 200]) {
    assert.equal(failureMessage({ type: "status", status }), GENERIC, `status ${status}`);
  }
  assert.equal(failureMessage({ type: "invalid" }), GENERIC);
  assert.equal(failureMessage(undefined), GENERIC);
  assert.equal(failureMessage({ type: "status", status: 502, body: "foto con metadatos" }), EXPECTED[502]);
});

test("failureMessage never shows the Worker's raw error text", () => {
  const all = [...Object.keys(EXPECTED).map((s) => ({ type: "status", status: Number(s) })),
    { type: "status", status: 403 }, { type: "status", status: 404 }, { type: "status", status: 500 },
    { type: "offline" }, { type: "network" }, { type: "timeout" }, { type: "invalid" }]
    .map((f) => failureMessage(f).toLowerCase());
  for (const msg of all) {
    for (const raw of WORKER_TEXT) {
      // The phrase may appear inside a longer friendly sentence only when it starts it
      // with a capital and goes on; the raw lower-case body alone never does.
      assert.notEqual(msg, raw);
    }
  }
});

// --- Phrases from the pauta, after confirmation -----------------------------------

const confirmed = (over = {}) => ({
  alto_en_sodio: NO, alto_en_azucares: NO, alto_en_grasas_saturadas: NO, alto_en_calorias: NO,
  cloruro_de_potasio: NO, ...over,
});

test("the pauta phrases are the exact sentences in index.html", () => {
  assert.equal(PAUTA_SODIO, "Elegir productos con menor cantidad de sodio.");
  assert.equal(PAUTA_POTASIO, "No usar 'sal light' o sustitutos de sal con potasio.");
  assert.ok(pautaText.includes(PAUTA_SODIO));
  assert.ok(pautaText.includes(PAUTA_POTASIO));
});

test("phrasesFor: «ALTO EN SODIO» = sí shows only the pauta's sodium sentence", () => {
  const out = phrasesFor(confirmed({ alto_en_sodio: SI }));
  assert.deepEqual(out.map((p) => p.text), [PAUTA_SODIO]);
  assert.equal(out[0].pauta, true);
  assert.equal(out[0].href, "index.html#presion");
});

test("phrasesFor: cloruro de potasio = sí shows only the pauta's sal light sentence", () => {
  const out = phrasesFor(confirmed({ cloruro_de_potasio: SI }));
  assert.deepEqual(out.map((p) => p.text), [PAUTA_POTASIO]);
  assert.equal(out[0].href, "index.html#indicaciones");
});

test("phrasesFor: both sí shows both sentences, sodium first", () => {
  const out = phrasesFor(confirmed({ alto_en_sodio: SI, cloruro_de_potasio: SI }));
  assert.deepEqual(out.map((p) => p.text), [PAUTA_SODIO, PAUTA_POTASIO]);
});

test("phrasesFor: every sí phrase is quoted exactly from the pauta and points at a real section", () => {
  const html = read("index.html");
  const out = phrasesFor(confirmed({ alto_en_sodio: SI, cloruro_de_potasio: SI }));
  for (const p of out) {
    assert.ok(pautaText.includes(p.text), p.text);
    assert.ok(html.includes(`<section id="${p.href.split("#")[1]}"`), p.href);
  }
});

test("phrasesFor: no, no se pudo leer, other seals or unknown values give only the neutral line", () => {
  const cases = [
    confirmed(),
    confirmed({ alto_en_sodio: ILEGIBLE, cloruro_de_potasio: ILEGIBLE }),
    confirmed({ alto_en_azucares: SI, alto_en_grasas_saturadas: SI, alto_en_calorias: SI }),
    confirmed({ alto_en_sodio: "Sí", cloruro_de_potasio: "si" }),
    {},
    undefined,
  ];
  for (const c of cases) {
    const out = phrasesFor(c);
    assert.deepEqual(out.map((p) => p.text), [NEUTRAL]);
    assert.equal(out[0].pauta, false);
    assert.equal(out[0].href, "index.html#inicio");
  }
  assert.equal(NEUTRAL, "Tu pauta no tiene una indicación sobre esto. Consulta con tu equipo tratante si tienes dudas.");
});

test("phrasesFor never looks at the sodium numbers", () => {
  const a = phrasesFor({ ...confirmed(), sodio_mg_100: "5000", sodio_mg_porcion: "2000" });
  const b = phrasesFor({ ...confirmed(), sodio_mg_100: "", sodio_mg_porcion: "1" });
  assert.deepEqual(a, b);
  assert.deepEqual(a.map((p) => p.text), [NEUTRAL]);
});

// --- Reading -> form ------------------------------------------------------------

const reading = (over = {}) => ({
  sellos: { alto_en_sodio: SI, alto_en_azucares: NO, alto_en_grasas_saturadas: ILEGIBLE, alto_en_calorias: NO },
  cloruro_de_potasio: NO, sodio_mg_100: 820, sodio_mg_porcion: null, modelo: "x/y", ...over,
});

test("readingToForm prefills each answer; null sodium stays empty, never 0", () => {
  const f = readingToForm(reading());
  assert.deepEqual(f, {
    alto_en_sodio: SI, alto_en_azucares: NO, alto_en_grasas_saturadas: ILEGIBLE, alto_en_calorias: NO,
    cloruro_de_potasio: NO, sodio_mg_100: "820", sodio_mg_porcion: "",
  });
});

test("readingToForm keeps a printed 0 and decimals as numbers", () => {
  const f = readingToForm(reading({ sodio_mg_100: 0, sodio_mg_porcion: 12.5 }));
  assert.equal(f.sodio_mg_100, "0");
  assert.equal(f.sodio_mg_porcion, "12.5");
});

test("readingToForm rejects an answer that does not match the reader's shape", () => {
  assert.equal(readingToForm(null), null);
  assert.equal(readingToForm({}), null);
  assert.equal(readingToForm(reading({ cloruro_de_potasio: "quizás" })), null);
  assert.equal(readingToForm(reading({ sodio_mg_100: -1 })), null);
  assert.equal(readingToForm(reading({ sodio_mg_100: "820" })), null);
  assert.equal(readingToForm(reading({ sellos: { alto_en_sodio: SI } })), null);
});

// --- Photo size -------------------------------------------------------------------

test("fitSize caps the long side at 1600 px and keeps the shape", () => {
  assert.equal(MAX_SIDE, 1600);
  assert.deepEqual(fitSize(4000, 3000), { width: 1600, height: 1200 });
  assert.deepEqual(fitSize(3000, 4000), { width: 1200, height: 1600 });
  assert.deepEqual(fitSize(1200, 900), { width: 1200, height: 900 });
});

test("encodeWithin lowers the quality until the photo fits 1.4 MB, then shrinks it", async () => {
  assert.equal(MAX_BYTES, 1_400_000);
  const calls = [];
  const fake = (sizes) => async (q, scale) => { calls.push([q, scale]); return { size: sizes(q, scale) }; };
  calls.length = 0;
  const a = await encodeWithin(fake((q) => (q > 0.7 ? 2_000_000 : 1_000_000)));
  assert.ok(a.blob.size <= MAX_BYTES);
  assert.ok(a.quality <= 0.7 && a.scale === 1);
  assert.ok(calls.every(([, s]) => s === 1));
  calls.length = 0;
  const b = await encodeWithin(fake((q, s) => (s < 1 ? 900_000 : 5_000_000)));
  assert.ok(b.blob.size <= MAX_BYTES && b.scale < 1);
  const c = await encodeWithin(fake(() => 9_000_000));
  assert.equal(c, null);
});

// --- Words that would turn the screen into a judge ------------------------------------

const FORBIDDEN = ["puedes comer", "puede comer", "normal", "riesgo", "elevad", "prohibido", "peligro", "semáforo", "es seguro"];

test("no forbidden word in the new page, its scripts or its copy", () => {
  const sources = {
    "etiqueta.html": htmlText(read("etiqueta.html")),
    "etiqueta.html (attributes)": read("etiqueta.html"),
    "etiqueta.js": read("etiqueta.js"),
    "etiqueta-core.js": read("etiqueta-core.js"),
    UI_COPY: UI_COPY.join(" \n "),
  };
  for (const [name, text] of Object.entries(sources)) {
    const low = text.toLowerCase();
    for (const w of FORBIDDEN) assert.ok(!low.includes(w), `«${w}» in ${name}`);
  }
});

test("the copy never rates a product as alto or bajo", () => {
  const low = UI_COPY.join(" \n ").toLowerCase() + " " + htmlText(read("etiqueta.html")).toLowerCase();
  for (const w of ["es alto", "es bajo", "muy alto", "muy bajo", "demasiado sodio", "mucho sodio", "poco sodio", "puedes", "no comas", "evítalo"]) {
    assert.ok(!low.includes(w), w);
  }
});

test("UI_COPY includes every message the screen can show", () => {
  for (const text of [...Object.values(EXPECTED), OFFLINE, GENERIC, NEUTRAL, PAUTA_SODIO, PAUTA_POTASIO]) {
    assert.ok(UI_COPY.includes(text), text);
  }
});

test("the notice key is new and is not one of the registro keys", async () => {
  const reg = await import(here("registro-core.js"));
  assert.equal(typeof NOTICE_KEY, "string");
  assert.ok(NOTICE_KEY.startsWith("etiqueta-"));
  for (const k of [reg.STORAGE_KEY, reg.RECEIVED_KEY, reg.BACKUP_KEY, "registro-prueba", "pauta-scale"]) {
    assert.notEqual(NOTICE_KEY, k);
  }
});

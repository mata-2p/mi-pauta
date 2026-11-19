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
  UNREAD_SODIO, UNREAD_POTASIO, CRITICAL, parseSodium, formatMg, sodiumEcho, sodiumError,
  readLine, preChecked, missingChoices,
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

test("phrasesFor: confirmed no, other seals or unknown values give only the neutral line", () => {
  const cases = [
    confirmed(),
    confirmed({ alto_en_azucares: SI, alto_en_grasas_saturadas: SI, alto_en_calorias: SI }),
    confirmed({ sodio_mg_100: null, sodio_mg_porcion: null }),
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

// S22 (a): three cases per field. An unread field is never treated as «no».

test("S22a: the two unread lines are calm, name what to check, and are exact", () => {
  assert.equal(UNREAD_SODIO, "No se pudo leer si tiene el sello «ALTO EN SODIO». Revísalo en el envase.");
  assert.equal(UNREAD_POTASIO, "No se pudo leer la lista de ingredientes completa. Revisa en el envase si dice «cloruro de potasio».");
  assert.ok(UI_COPY.includes(UNREAD_SODIO) && UI_COPY.includes(UNREAD_POTASIO));
});

test("S22a: «ALTO EN SODIO» no se pudo leer gives the sodium check line, not the neutral line", () => {
  const out = phrasesFor(confirmed({ alto_en_sodio: ILEGIBLE }));
  assert.deepEqual(out.map((p) => p.text), [UNREAD_SODIO]);
  assert.equal(out[0].pauta, false);
  assert.equal(out[0].kind, "revisar");
});

test("S22a: cloruro de potasio no se pudo leer gives the ingredients check line, not the neutral line", () => {
  const out = phrasesFor(confirmed({ cloruro_de_potasio: ILEGIBLE }));
  assert.deepEqual(out.map((p) => p.text), [UNREAD_POTASIO]);
  assert.equal(out[0].kind, "revisar");
});

test("S22a: both unread give both check lines and no neutral line", () => {
  const out = phrasesFor(confirmed({ alto_en_sodio: ILEGIBLE, cloruro_de_potasio: ILEGIBLE }));
  assert.deepEqual(out.map((p) => p.text), [UNREAD_SODIO, UNREAD_POTASIO]);
  assert.ok(!out.some((p) => p.text === NEUTRAL));
});

test("S22a: confirmed no and no se pudo leer never give the same result", () => {
  for (const key of CRITICAL) {
    const no = phrasesFor(confirmed({ [key]: NO }));
    const unread = phrasesFor(confirmed({ [key]: ILEGIBLE }));
    assert.notDeepEqual(no, unread, key);
  }
  assert.deepEqual(CRITICAL, ["alto_en_sodio", "cloruro_de_potasio"]);
});

test("S22a: a sí in one field and an unread other field show the pauta sentence and the check line", () => {
  assert.deepEqual(phrasesFor(confirmed({ alto_en_sodio: SI, cloruro_de_potasio: ILEGIBLE })).map((p) => p.text),
    [PAUTA_SODIO, UNREAD_POTASIO]);
  assert.deepEqual(phrasesFor(confirmed({ alto_en_sodio: ILEGIBLE, cloruro_de_potasio: SI })).map((p) => p.text),
    [UNREAD_SODIO, PAUTA_POTASIO]);
});

// S22 (b): the sodium sentence also follows a confirmed sodium number, never its size.

test("S22b: a confirmed sodium number shows the pauta's sodium sentence", () => {
  for (const over of [{ sodio_mg_100: 1250 }, { sodio_mg_porcion: 89 }, { sodio_mg_100: 0 }, { sodio_mg_100: 3, sodio_mg_porcion: 1 }]) {
    const out = phrasesFor(confirmed(over));
    assert.deepEqual(out.map((p) => p.text), [PAUTA_SODIO], JSON.stringify(over));
    assert.equal(out[0].pauta, true);
    assert.equal(out[0].href, "index.html#presion");
  }
});

test("S22b: seal sí and a sodium number show the sodium sentence once", () => {
  const out = phrasesFor(confirmed({ alto_en_sodio: SI, sodio_mg_100: 820, sodio_mg_porcion: 120 }));
  assert.deepEqual(out.map((p) => p.text), [PAUTA_SODIO]);
});

test("S22b: the sodium number is never compared: any confirmed amount gives the same result", () => {
  const results = [0, 1, 89, 1250, 18200, 99999].map((n) => phrasesFor(confirmed({ sodio_mg_100: n })));
  for (const r of results) assert.deepEqual(r, results[0]);
});

test("S22b: no sodium number (null, empty, or not a whole number) does not count as confirmed", () => {
  for (const v of [null, undefined, "", "1250", -1, 12.5, NaN]) {
    assert.deepEqual(phrasesFor(confirmed({ sodio_mg_100: v, sodio_mg_porcion: v })).map((p) => p.text), [NEUTRAL], String(v));
  }
});

test("S22b: unread seal plus a confirmed sodium number shows the pauta sentence and the seal check line", () => {
  assert.deepEqual(phrasesFor(confirmed({ alto_en_sodio: ILEGIBLE, sodio_mg_porcion: 450 })).map((p) => p.text),
    [PAUTA_SODIO, UNREAD_SODIO]);
});

// S22 (c): sodium is whole milligrams; «1.250» is never 1,25.

test("S22c: parseSodium reads whole mg with dots or spaces as thousand groups", () => {
  for (const [text, value] of [
    ["1250", 1250], ["1.250", 1250], ["1 250", 1250], [" 1.250 ", 1250], ["0", 0], ["89", 89],
    ["18.200", 18200], ["1.234.567", 1234567], ["1 234 567", 1234567], ["1 250", 1250],
  ]) {
    assert.deepEqual(parseSodium(text), { ok: true, value }, JSON.stringify(text));
  }
});

test("S22c: parseSodium: empty means no se pudo leer (null), never 0", () => {
  for (const text of ["", "   ", null, undefined]) assert.deepEqual(parseSodium(text), { ok: true, value: null });
});

test("S22c: parseSodium rejects a comma, a decimal and malformed groups", () => {
  for (const text of ["1,25", "1,250", "12,5", "1.25", "12.5", "1.2500", "1250.", ".250", "1..250", "1. 250",
    "1.250 300", "-5", "+5", "5 mg", "mil", "1e3", "0x10", "12 50", "99999999999999999999"]) {
    assert.deepEqual(parseSodium(text), { ok: false }, JSON.stringify(text));
  }
});

test("S22c: formatMg and sodiumEcho repeat the value in es-CL", () => {
  assert.equal(formatMg(1250), "1.250");
  assert.equal(formatMg(0), "0");
  assert.equal(formatMg(820), "820");
  assert.equal(formatMg(1234567), "1.234.567");
  assert.equal(sodiumEcho(1250), "Se entiende como: 1.250 mg");
  assert.equal(sodiumEcho(null), "Se entiende como: no se pudo leer");
});

test("S22c: sodiumError asks for the whole number of mg and names the field", () => {
  const msg = sodiumError("Sodio por porción");
  assert.equal(msg, "En «Sodio por porción» escribe los miligramos como número entero, sin coma ni decimales. Por ejemplo: 1250 o 1.250.");
  assert.ok(UI_COPY.some((t) => t.includes("escribe los miligramos como número entero")));
});

// S22 (d): the two critical answers are never pre-checked.

test("S22d: preChecked keeps the reader's answer for the other seals only", () => {
  const values = readingToForm(reading());
  const checked = preChecked(values);
  assert.deepEqual(checked, { alto_en_azucares: NO, alto_en_grasas_saturadas: ILEGIBLE, alto_en_calorias: NO });
  for (const key of CRITICAL) assert.ok(!(key in checked), key);
});

test("S22d: readLine says what was read, in the three cases", () => {
  assert.equal(readLine(SI), "Se leyó: sí");
  assert.equal(readLine(NO), "Se leyó: no");
  assert.equal(readLine(ILEGIBLE), "Se leyó: no se pudo leer");
  assert.equal(readLine("quizás"), "");
});

test("S22d: missingChoices blocks confirmation until both critical answers are chosen", () => {
  const others = { alto_en_azucares: NO, alto_en_grasas_saturadas: NO, alto_en_calorias: NO };
  const none = missingChoices(others);
  assert.deepEqual(none.map((m) => m.key), CRITICAL);
  assert.equal(none[0].message, "Toca tu respuesta para el sello «ALTO EN SODIO»: sí, no o no se pudo leer.");
  assert.equal(none[1].message, "Toca tu respuesta para «cloruro de potasio» en los ingredientes: sí, no o no se pudo leer.");
  assert.deepEqual(missingChoices({ ...others, alto_en_sodio: NO }).map((m) => m.key), ["cloruro_de_potasio"]);
  assert.deepEqual(missingChoices({ ...others, alto_en_sodio: ILEGIBLE, cloruro_de_potasio: SI }), []);
  assert.deepEqual(missingChoices({ ...others, alto_en_sodio: "x", cloruro_de_potasio: SI }).map((m) => m.key), ["alto_en_sodio"]);
  // The other seals keep their old message.
  assert.deepEqual(missingChoices({ alto_en_sodio: NO, cloruro_de_potasio: NO }).map((m) => m.message),
    ["Elige una respuesta para «ALTO EN AZÚCARES».", "Elige una respuesta para «ALTO EN GRASAS SATURADAS».", "Elige una respuesta para «ALTO EN CALORÍAS»."]);
});

test("S22d: etiqueta.html never pre-checks a radio and says why confirm waits", () => {
  const html = read("etiqueta.html");
  assert.ok(!/<input[^>]*type="radio"[^>]*\bchecked\b/.test(html));
  assert.match(html, /id="leido-alto_en_sodio"/);
  assert.match(html, /id="leido-cloruro_de_potasio"/);
});

// S22 (c), markup: whole mg in a text field with a numeric keyboard.

test("S22c: the sodium fields are text with inputmode numeric, each with its own echo", () => {
  const html = read("etiqueta.html");
  assert.ok(!html.includes('type="number"'));
  for (const id of ["sodio-100", "sodio-porcion"]) {
    const tag = html.match(new RegExp(`<input id="${id}"[^>]*>`))?.[0] || "";
    assert.match(tag, /type="text"/, id);
    assert.match(tag, /inputmode="numeric"/, id);
    assert.match(tag, /aria-describedby="eco-[^"]+/, id);
  }
});

// S22 (e): privacy wording says what the code does.

test("S22e: index.html no longer claims nothing is sent, and names the one photo that is", () => {
  const text = htmlText(read("index.html"));
  assert.ok(!text.includes("Esta página no pide ni envía ningún dato tuyo."));
  assert.ok(text.includes("Lo que anotas queda solo en este teléfono. Solo «Leer una etiqueta» envía algo: la foto que tú eliges, sin metadatos, y esa foto no se guarda."));
});

test("S22e: the label notice names the path of the photo and the key is v2", () => {
  const text = htmlText(read("etiqueta.html"));
  assert.ok(text.includes("La foto que eliges sale del teléfono sin metadatos y pasa por Cloudflare y OpenRouter hasta un modelo de Google, fuera de Chile. Se usa solo para leer la etiqueta y no se guarda."));
  assert.equal(NOTICE_KEY, "etiqueta-aviso-v2");
});

// One live region per kind, never role=alert and aria-live together.

test("etiqueta.html: no region carries both role=alert or status and aria-live", () => {
  const html = read("etiqueta.html");
  for (const tag of html.match(/<[a-z]+\b[^>]*>/g)) {
    assert.ok(!(/role="(alert|status)"/.test(tag) && /aria-live=/.test(tag)), tag);
  }
});

// New copy: none of the judging words.

test("S22: the new copy has no judging words (ALTO only inside the literal seal)", () => {
  const copy = [UNREAD_SODIO, UNREAD_POTASIO, sodiumError("Sodio por porción"), sodiumEcho(1250), sodiumEcho(null),
    readLine(SI), readLine(NO), readLine(ILEGIBLE), ...missingChoices({}).map((m) => m.message),
    "Lo que anotas queda solo en este teléfono. Solo «Leer una etiqueta» envía algo: la foto que tú eliges, sin metadatos, y esa foto no se guarda.",
    htmlText(read("etiqueta.html"))].join(" \n ");
  const low = copy.replace(/«ALTO EN [A-ZÁÉÍÓÚ ]+»/g, "«sello»").toLowerCase();
  for (const w of ["puedes comer", "normal", "alto", "bajo", "riesgo", "elevad", "peligro", "exceso", "prohibido"]) {
    assert.ok(!new RegExp(`\\b${w}`).test(low), w);
  }
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

test("readingToForm writes sodium as printed in Chile: thousands with a dot, a decimal with a comma", () => {
  const f = readingToForm(reading({ sodio_mg_100: 0, sodio_mg_porcion: 12.5 }));
  assert.equal(f.sodio_mg_100, "0");
  assert.equal(f.sodio_mg_porcion, "12,5");
  assert.equal(readingToForm(reading({ sodio_mg_100: 1250 })).sodio_mg_100, "1.250");
  // What the form shows reads back as the same whole number; a decimal must be fixed by the person.
  assert.deepEqual(parseSodium(readingToForm(reading({ sodio_mg_100: 18200 })).sodio_mg_100), { ok: true, value: 18200 });
  assert.deepEqual(parseSodium(f.sodio_mg_porcion), { ok: false });
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

test("the notice key is v2 (shown again after the privacy change) and is not one of the registro keys", async () => {
  assert.equal(NOTICE_KEY, "etiqueta-aviso-v2");
  const reg = await import(here("registro-core.js"));
  assert.equal(typeof NOTICE_KEY, "string");
  assert.ok(NOTICE_KEY.startsWith("etiqueta-"));
  for (const k of [reg.STORAGE_KEY, reg.RECEIVED_KEY, reg.BACKUP_KEY, "registro-prueba", "pauta-scale"]) {
    assert.notEqual(NOTICE_KEY, k);
  }
});

test("S22c: parseSodium rejects full-width digits, exponent, sign and comma groups", () => {
  for (const t of ["２５０", "1e3", "+5", "-5", "1,250", "12.5.0", "1.2500"]) assert.deepEqual(parseSodium(t), { ok: false }, t);
  assert.deepEqual(parseSodium("001250"), { ok: true, value: 1250 });
});

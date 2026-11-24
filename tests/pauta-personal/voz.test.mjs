// Behavior tests for «Escuchar» by blocks (S22 g): app.js exposes a pure chunking
// function, here run against a tiny DOM-like tree parsed from the real index.html.
// Run: node --test 'tests/pauta-personal/*.test.mjs'
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const here = (p) => new URL(`../../pauta-personal/${p}`, import.meta.url);
const read = (p) => readFileSync(here(p), "utf8");

// app.js without a document only defines the pure function.
const scope = {};
vm.runInNewContext(read("app.js"), scope);
// Arrays from the vm context are copied so deepEqual compares values, not realms.
const voz = scope.pautaVoz && { chunks: (node) => Array.from(scope.pautaVoz.chunks(node)) };

// --- A tiny HTML parser: elements and text, enough for these pages ---------------

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);
const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', nbsp: " ", "#39": "'" };

// Elements also carry the few DOM methods app.js uses for «Escuchar» (S28 tests).
function el(tag, attrs, parent) {
  const node = {
    nodeType: 1, tagName: tag.toUpperCase(), attrs, childNodes: [], parentNode: parent, listeners: {},
    getAttribute(n) { return Object.prototype.hasOwnProperty.call(this.attrs, n) ? this.attrs[n] : null; },
    hasAttribute(n) { return Object.prototype.hasOwnProperty.call(this.attrs, n); },
    setAttribute(n, v) { this.attrs[n] = String(v); },
    removeAttribute(n) { delete this.attrs[n]; },
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); },
    click() { for (const fn of this.listeners.click || []) fn({ type: "click" }); },
    querySelector(sel) { return all(this, (n) => n !== this && n.tagName === sel.toUpperCase())[0] || null; },
    closest(sel) { let n = this; while (n && n.tagName !== sel.toUpperCase()) n = n.parentNode; return n || null; },
    appendChild(c) { c.parentNode = this; this.childNodes.push(c); return c; },
    replaceChildren(...cs) {
      for (const c of this.childNodes) if (c.nodeType === 1) c.parentNode = null;
      this.childNodes = cs;
      for (const c of cs) c.parentNode = this;
    },
    insertAdjacentElement(where, c) {
      assert.equal(where, "afterend");
      const sib = this.parentNode.childNodes;
      sib.splice(sib.indexOf(this) + 1, 0, c);
      c.parentNode = this.parentNode;
      return c;
    },
  };
  Object.defineProperty(node, "textContent", {
    get() { return textOf(this); },
    set(v) { this.childNodes = v ? [{ nodeType: 3, nodeValue: String(v) }] : []; },
  });
  Object.defineProperty(node, "className", {
    get() { return this.attrs.class || ""; },
    set(v) { this.attrs.class = String(v); },
  });
  return node;
}

function parse(html) {
  const root = el("#root", {}, null);
  let cur = root;
  const re = /<!--[\s\S]*?-->|<!doctype[^>]*>|<(\/?)([a-zA-Z][\w-]*)((?:\s+[^\s=>/]+(?:="[^"]*")?)*)\s*(\/?)>|([^<]+)/gi;
  for (const m of html.matchAll(re)) {
    const [, close, tag, rawAttrs, selfClose, text] = m;
    if (text !== undefined) {
      cur.childNodes.push({ nodeType: 3, nodeValue: text.replace(/&(#?\w+);/g, (s, e) => ENTITIES[e] ?? s) });
    } else if (tag && close) {
      let n = cur;
      while (n && n.tagName !== tag.toUpperCase()) n = n.parentNode;
      if (n && n.parentNode) cur = n.parentNode;
    } else if (tag) {
      const attrs = {};
      for (const a of (rawAttrs || "").matchAll(/([^\s=>/]+)(?:="([^"]*)")?/g)) attrs[a[1]] = a[2] ?? "";
      const node = el(tag, attrs, cur);
      cur.childNodes.push(node);
      if (!selfClose && !VOID.has(tag.toLowerCase())) cur = node;
    }
  }
  return root;
}

function byId(node, id) {
  if (node.nodeType === 1 && node.getAttribute("id") === id) return node;
  for (const c of node.childNodes || []) {
    const hit = byId(c, id);
    if (hit) return hit;
  }
  return null;
}

function all(node, pred, out = []) {
  if (node.nodeType === 1 && pred(node)) out.push(node);
  for (const c of node.childNodes || []) all(c, pred, out);
  return out;
}

const textOf = (n) => (n.nodeType === 3 ? n.nodeValue : n.childNodes.map(textOf).join(""));
const clean = (s) => s.replace(/\s+/g, " ").trim();
const hasClass = (n, c) => (n.getAttribute("class") || "").split(/\s+/).includes(c);

const doc = parse(read("index.html"));
const section = (id) => byId(doc, id);

test("app.js exposes the chunking function without touching the DOM", () => {
  assert.equal(typeof voz?.chunks, "function");
});

test("S22g: each row of the pauta table is one chunk with its group name and both column words", () => {
  const elegir = section("elegir");
  const chunks = voz.chunks(elegir);
  const rows = all(elegir, (n) => n.tagName === "ARTICLE" && hasClass(n, "group"));
  assert.equal(rows.length, 7);
  for (const row of rows) {
    const group = clean(textOf(all(row, (n) => n.tagName === "H3")[0]));
    const [pref, lim] = all(row, (n) => hasClass(n, "half")).map((h) => {
      const ps = all(h, (n) => n.tagName === "P");
      return { tag: clean(textOf(ps[0])), text: clean(textOf(ps[1])) };
    });
    assert.equal(pref.tag, "Preferir");
    assert.equal(lim.tag, "Limitar o evitar");
    const expected = `${group}. Preferir: ${pref.text} Limitar o evitar: ${lim.text}`;
    assert.ok(chunks.includes(expected), `missing row chunk: ${expected}\n${JSON.stringify(chunks, null, 1)}`);
    // Every food is heard with its list name: no chunk carries a column's words alone.
    for (const c of chunks) {
      if (c.includes(pref.text) || c.includes(lim.text)) assert.equal(c, expected);
    }
  }
});

test("S22g: «Qué elegir» starts with its heading and has one chunk per row", () => {
  const chunks = voz.chunks(section("elegir"));
  assert.equal(chunks[0], "¿Qué alimentos elegir?");
  assert.equal(chunks.length, 1 + 7);
});

test("S22g: a section is read as heading, paragraphs and list items, each its own chunk", () => {
  const chunks = voz.chunks(section("indicaciones"));
  assert.deepEqual(chunks, [
    "Indicaciones generales",
    "Objetivo",
    "Ayudar a la recuperación de los riñones, mantener una buena hidratación y controlar la presión arterial, evitando el exceso de sal y alimentos ultraprocesados.",
    "Realizar 4 tiempos de comida al día: desayuno, almuerzo, once y cena. Si necesita una colación, puede incorporarla según apetito y horario.",
    "No agregar sal a las comidas en la mesa. Para dar sabor puede usar limón, ajo, cebolla, orégano, perejil, cilantro, u otras hierbas y especias sin sal.",
    "Preferir alimentos frescos y preparados en casa.",
    "Evitar el consumo frecuente de alimentos envasados, instantáneos y muy salados.",
    "No usar 'sal light' o sustitutos de sal con potasio.",
  ]);
});

test("S22g: buttons, breadcrumbs, the pager and icons are not read", () => {
  for (const id of ["alta", "indicaciones", "elegir", "dia", "presion", "cocina", "etiquetas", "seguimiento"]) {
    const joined = voz.chunks(section(id)).join(" | ");
    for (const w of ["Escuchar", "Volver al inicio", "Siguiente", "Anterior", "Mi pauta"]) {
      assert.ok(!joined.includes(w), `«${w}» read in #${id}`);
    }
    for (const c of voz.chunks(section(id))) assert.equal(c, clean(c), `chunk not trimmed in #${id}`);
  }
});

test("S22g: «+» in the day example is read as «más», and every meal is its own chunk", () => {
  const chunks = voz.chunks(section("dia"));
  assert.equal(chunks[0], "Ejemplo de un día de alimentación");
  assert.ok(chunks.includes("Desayuno"));
  assert.ok(chunks.some((c) => c.startsWith("1 taza de leche descremada o yogurt natural, más 2 rebanadas")));
  assert.ok(chunks.every((c) => !c.includes(" + ")));
});

test("S22g: hidden parts are not read", () => {
  const tree = parse('<div id="r"><h2>Título</h2><p hidden>Oculto</p><div hidden><p>Tampoco</p></div><p>Visible</p></div>');
  assert.deepEqual(voz.chunks(byId(tree, "r")), ["Título", "Visible"]);
});

test("S22g: every pauta sentence in the sections is still read, word for word", () => {
  const all7 = ["indicaciones", "elegir", "dia", "presion", "cocina", "etiquetas", "seguimiento"]
    .flatMap((id) => voz.chunks(section(id))).join(" ");
  for (const s of [
    "Elegir productos con menor cantidad de sodio.",
    "No usar 'sal light' o sustitutos de sal con potasio.",
    "Mantener los controles indicados después del alta para revisar la función renal y ajustar la alimentación según los nuevos exámenes.",
  ]) assert.ok(all7.includes(s), s);
});

test("S23: «Escuchar» reads the discharge indication block, quote as written, nothing else", () => {
  const alta = section("alta");
  assert.ok(alta, "no #alta block");
  const btn = all(alta, (n) => n.tagName === "BUTTON" && hasClass(n, "speak"))[0];
  assert.equal(btn?.getAttribute("data-target"), "alta");
  const chunks = voz.chunks(alta);
  assert.deepEqual(chunks, [
    "Indicación médica del alta",
    "19 de noviembre de 2026",
    "Régimen renal hiposódico, bajo en potasio y fósforo.",
    "Pregunta a tu equipo cómo se combina con esta pauta.",
  ]);
  assert.ok(chunks.includes("Régimen renal hiposódico, bajo en potasio y fósforo."));
});

test("S23: the discharge indication comes before the pauta's first section", () => {
  const routes = all(doc, (n) => n.tagName === "SECTION" && n.hasAttribute("data-route")).map((n) => n.getAttribute("id"));
  assert.equal(routes[0], "alta");
  assert.equal(routes[1], "indicaciones");
});

test("S22g: app.js keeps es-CL, rate 0.9 and a cancellable queue", () => {
  const src = read("app.js");
  assert.match(src, /lang = "es-CL"/);
  assert.match(src, /rate = 0\.9/);
  assert.match(src, /synth\.cancel\(\)/);
});

// --- S28: «Escuchar» that does not sound -----------------------------------------
// app.js runs against the real index.html with a fake speechSynthesis and a fake clock.

const HINT = "¿No se escucha? Sube el volumen y revisa que el teléfono no esté en silencio.";
const FAIL = "No se pudo leer en voz alta en este equipo. Revisa el volumen y que el teléfono no esté en silencio. Si sigue sin sonar, este equipo no tiene una voz para leer en español.";
const ES_ES = { name: "España", lang: "es-ES" };
const ES_CL = { name: "Chile", lang: "es-CL" };

function page({ voices = [ES_ES, ES_CL] } = {}) {
  const tree = parse(read("index.html"));
  let now = 0;
  let timers = [];
  let seq = 0;
  const clock = {
    setTimeout(fn, ms) { const id = ++seq; timers.push({ id, at: now + (ms || 0), fn }); return id; },
    clearTimeout(id) { timers = timers.filter((t) => t.id !== id); },
    tick(ms) {
      const end = now + ms;
      for (;;) {
        const due = timers.filter((t) => t.at <= end).sort((a, b) => a.at - b.at || a.id - b.id)[0];
        if (!due) break;
        timers = timers.filter((t) => t !== due);
        now = due.at;
        due.fn();
      }
      now = end;
    },
    get now() { return now; },
  };
  const log = [];
  const vcListeners = [];
  const synth = {
    voices: voices.slice(), speaking: false, pending: false, queue: [], voiceCalls: 0,
    getVoices() { this.voiceCalls += 1; return this.voices.slice(); },
    voiceListeners() { return vcListeners.length + (typeof this.onvoiceschanged === "function" ? 1 : 0); },
    speak(u) { log.push({ op: "speak", at: now, u }); this.queue.push(u); this.pending = true; },
    cancel() { log.push({ op: "cancel", at: now }); this.queue = []; this.speaking = this.pending = false; },
    addEventListener(type, fn) { if (type === "voiceschanged") vcListeners.push(fn); },
    removeEventListener(type, fn) { const i = vcListeners.indexOf(fn); if (i >= 0) vcListeners.splice(i, 1); },
    // Test helpers: the browser starts or finishes the current utterance.
    start() { const u = this.queue[0]; this.speaking = true; this.pending = this.queue.length > 1; u.onstart && u.onstart({}); },
    end() { const u = this.queue.shift(); this.speaking = false; this.pending = this.queue.length > 0; u.onend && u.onend({}); },
    error() { const u = this.queue.shift(); this.speaking = false; this.pending = this.queue.length > 0; u.onerror && u.onerror({ error: "synthesis-failed" }); },
    voicesArrive(list) { this.voices = list.slice(); vcListeners.slice().forEach((fn) => fn({})); if (this.onvoiceschanged) this.onvoiceschanged({}); },
  };
  const docListeners = {};
  const small = el("button", { id: "smaller" }, null);
  const big = el("button", { id: "bigger" }, null);
  const document = {
    documentElement: { style: { setProperty() {} } },
    getElementById: (id) => (id === "smaller" ? small : id === "bigger" ? big : byId(tree, id)),
    querySelectorAll(sel) {
      assert.equal(sel, ".speak");
      return all(tree, (n) => n.tagName === "BUTTON" && hasClass(n, "speak"));
    },
    addEventListener(type, fn) { (docListeners[type] ||= []).push(fn); },
    dispatch(type) { for (const fn of docListeners[type] || []) fn({ type }); },
    createElement: (tag) => el(tag, {}, null),
  };
  class SpeechSynthesisUtterance { constructor(text) { this.text = text; } }
  const window = { speechSynthesis: synth };
  vm.runInNewContext(read("app.js"), {
    window, document, SpeechSynthesisUtterance, navigator: {}, location: { protocol: "file:" },
    localStorage: { getItem: () => null, setItem() {} },
    setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
  });
  const button = (target) => all(tree, (n) => n.tagName === "BUTTON" && n.getAttribute("data-target") === target)[0];
  const label = (b) => clean(textOf(b));
  const spoken = () => log.filter((e) => e.op === "speak").map((e) => e.u);
  const cancels = () => log.filter((e) => e.op === "cancel");
  // Every live region app.js added, with its text.
  const regions = () => all(tree, (n) => n.hasAttribute("aria-live") || n.getAttribute("role") === "alert");
  const shown = () => regions().filter((n) => clean(textOf(n))).map((n) => clean(textOf(n)));
  const order = (n) => { const list = all(tree, () => true); return list.indexOf(n); };
  return { tree, clock, synth, document, button, label, spoken, cancels, regions, shown, order, log };
}

function regionWith(p, text) { return p.regions().find((n) => clean(textOf(n)) === text); }

test("S28b: with no one speaking, «Escuchar» does not cancel and the first block is spoken", () => {
  const p = page();
  p.button("alta").click();
  assert.equal(p.cancels().length, 0, "cancel called while nothing was speaking or pending");
  p.clock.tick(150);
  assert.equal(p.spoken().length, 1);
  assert.equal(p.spoken()[0].text, "Indicación médica del alta");
});

test("S28b: right after a cancel, speak waits about 100 ms", () => {
  const p = page();
  p.button("alta").click();
  p.clock.tick(150);
  p.synth.start();
  const before = p.spoken().length;
  p.button("indicaciones").click();
  assert.equal(p.cancels().length, 1, "the running voice is cancelled");
  const cancelAt = p.cancels()[0].at;
  assert.equal(p.spoken().length, before, "speak called in the same instant as cancel");
  p.clock.tick(99);
  assert.equal(p.spoken().length, before, "speak called less than 100 ms after cancel");
  p.clock.tick(1);
  assert.equal(p.spoken().length, before + 1);
  const last = p.log.filter((e) => e.op === "speak").at(-1);
  assert.ok(last.at - cancelAt >= 100);
  assert.equal(last.u.text, "Indicaciones generales");
});

test("S28b: the voices are loaded when the page opens, before any tap", () => {
  const p = page({ voices: [] });
  assert.ok(p.synth.voiceCalls >= 1, "getVoices not called at page load");
  assert.ok(p.synth.voiceListeners() >= 1, "no voiceschanged listener at page load");
  assert.equal(p.spoken().length, 0);
});

test("S28b: with an empty voice list at the tap, the first block is spoken inside the tap, es-CL and no voice", () => {
  const p = page({ voices: [] });
  const btn = p.button("alta");
  btn.click();
  // No tick: speak() ran inside the click itself (iOS drops it otherwise).
  assert.equal(p.spoken().length, 1, "speak deferred out of the tap");
  const u = p.spoken()[0];
  assert.equal(u.text, "Indicación médica del alta");
  assert.equal(u.lang, "es-CL");
  assert.equal(u.voice, undefined);
  assert.equal(u.rate, 0.9);
  assert.equal(p.cancels().length, 0);
  assert.equal(p.label(btn), "Detener");
  assert.deepEqual(p.shown(), [HINT]);
});

test("S28b: voices that arrive after the page opens are used at the tap, with the chosen voice's language", () => {
  const p = page({ voices: [] });
  const esUS = { name: "US", lang: "es-US" };
  p.synth.voicesArrive([{ name: "English", lang: "en-US" }, esUS]);
  assert.equal(p.spoken().length, 0, "voices arriving started a reading");
  p.button("alta").click();
  assert.equal(p.spoken().length, 1);
  const u = p.spoken()[0];
  assert.equal(u.voice, esUS);
  assert.equal(u.lang, "es-US");
  assert.equal(u.rate, 0.9);
  assert.equal(p.label(p.button("alta")), "Detener");
});

test("S28b: «Detener» during the 100 ms wait after a cancel speaks nothing", () => {
  const p = page();
  p.button("alta").click();
  p.synth.start();
  const before = p.spoken().length;
  const btn = p.button("indicaciones");
  btn.click();
  assert.equal(p.cancels().length, 1);
  p.clock.tick(50);
  btn.click();
  assert.equal(p.label(btn), "Escuchar");
  assert.equal(btn.getAttribute("aria-pressed"), "false");
  p.clock.tick(5000);
  assert.equal(p.spoken().length, before, "spoke after «Detener»");
  assert.deepEqual(p.shown(), []);
});

test("S28c: while reading, the hint shows below the button in a polite live region, and goes on stop", () => {
  const p = page();
  const btn = p.button("alta");
  // The region exists before it is filled, so screen readers announce the change.
  assert.ok(p.regions().length >= 2, "no live regions created next to the buttons");
  assert.deepEqual(p.shown(), []);
  btn.click();
  const hint = regionWith(p, HINT);
  assert.ok(hint, `hint missing: ${JSON.stringify(p.shown())}`);
  assert.equal(hint.getAttribute("aria-live"), "polite");
  assert.equal(hint.getAttribute("role"), null, "role=alert and aria-live together");
  assert.ok(p.order(hint) > p.order(btn), "hint is not below the button");
  assert.ok(byId(p.tree, "alta") && all(byId(p.tree, "alta"), (n) => n === hint).length === 1, "hint is not in the button's section");
  assert.deepEqual(p.shown(), [HINT]);
  btn.click();
  assert.equal(p.label(btn), "Escuchar");
  assert.deepEqual(p.shown(), []);
});

test("S28c: the hint goes when the last block ends, and on leaving the screen", () => {
  const p = page();
  const btn = p.button("alta");
  btn.click();
  p.clock.tick(150);
  for (let i = 0; i < 4; i++) { p.synth.start(); p.synth.end(); }
  assert.equal(p.spoken().length, 4);
  assert.equal(p.label(btn), "Escuchar");
  assert.deepEqual(p.shown(), []);
  btn.click();
  assert.deepEqual(p.shown(), [HINT]);
  p.document.dispatch("routechange");
  assert.equal(p.label(btn), "Escuchar");
  assert.deepEqual(p.shown(), []);
});

test("S28d: with no voices at all, the button goes back and the message is shown as an alert", () => {
  const p = page({ voices: [] });
  const btn = p.button("alta");
  btn.click();
  assert.equal(p.spoken().length, 1, "no speak inside the tap");
  p.clock.tick(2999);
  assert.equal(p.label(btn), "Detener");
  p.clock.tick(1);
  assert.equal(p.spoken().length, 1);
  assert.ok(p.cancels().length >= 1, "the queued utterance is not cancelled");
  assert.equal(p.label(btn), "Escuchar");
  assert.equal(btn.getAttribute("aria-pressed"), "false");
  const msg = regionWith(p, FAIL);
  assert.ok(msg, `message missing: ${JSON.stringify(p.shown())}`);
  assert.equal(msg.getAttribute("role"), "alert");
  assert.equal(msg.getAttribute("aria-live"), null, "role=alert and aria-live together");
  assert.ok(p.order(msg) > p.order(btn), "message is not below the button");
  assert.deepEqual(p.shown(), [FAIL], "the hint stays with the failure message");
});

test("S28d: if the voice does not start within 3 s, the button goes back and the message is shown", () => {
  const p = page();
  const btn = p.button("alta");
  btn.click();
  const spokeAt = p.log.find((e) => e.op === "speak")?.at ?? (p.clock.tick(150), p.log.find((e) => e.op === "speak").at);
  p.clock.tick(spokeAt + 2999 - p.clock.now);
  assert.equal(p.label(btn), "Detener");
  assert.deepEqual(p.shown(), [HINT]);
  p.clock.tick(1);
  assert.equal(p.label(btn), "Escuchar");
  assert.equal(btn.getAttribute("aria-pressed"), "false");
  assert.deepEqual(p.shown(), [FAIL]);
  assert.ok(p.cancels().length >= 1, "the stuck utterance is not cancelled");
  // A new try clears the message.
  btn.click();
  assert.deepEqual(p.shown(), [HINT]);
});

test("S28d: a voice that is speaking at 3 s counts as started even without onstart (R3-001)", () => {
  const p = page();
  const btn = p.button("alta");
  btn.click();
  p.synth.speaking = true; // some browsers sound but never fire onstart
  p.clock.tick(3000);
  assert.equal(p.label(btn), "Detener");
  assert.equal(btn.getAttribute("aria-pressed"), "true");
  assert.deepEqual(p.shown(), [HINT]);
  assert.equal(p.cancels().length, 0);
  // Treated as started: a later error only resets.
  p.synth.error();
  assert.equal(p.label(btn), "Escuchar");
  assert.deepEqual(p.shown(), []);
});

test("S28d: on failure the queue is always cancelled, even if the browser reports nothing queued (R3-003)", () => {
  const p = page();
  const btn = p.button("alta");
  btn.click();
  p.synth.pending = false; // a stuck utterance the browser does not report
  p.clock.tick(3000);
  assert.deepEqual(p.shown(), [FAIL]);
  assert.equal(p.cancels().length, 1, "the stuck utterance is not cancelled");
});

test("S28d: an error before the voice starts shows the message and the button goes back (R3-004)", () => {
  const p = page();
  const btn = p.button("alta");
  btn.click();
  p.synth.error();
  assert.equal(p.label(btn), "Escuchar");
  assert.equal(btn.getAttribute("aria-pressed"), "false");
  assert.deepEqual(p.shown(), [FAIL]);
  assert.equal(regionWith(p, FAIL).getAttribute("role"), "alert");
  // The watchdog does not fire a second time.
  p.clock.tick(5000);
  assert.deepEqual(p.shown(), [FAIL]);
  assert.equal(p.spoken().length, 1);
});

test("S28d: an error after the voice started only resets, with no message (R3-004)", () => {
  const p = page();
  const btn = p.button("alta");
  btn.click();
  p.synth.start();
  p.synth.error();
  assert.equal(p.label(btn), "Escuchar");
  assert.equal(btn.getAttribute("aria-pressed"), "false");
  assert.deepEqual(p.shown(), []);
  p.clock.tick(5000);
  assert.deepEqual(p.shown(), []);
  assert.equal(p.spoken().length, 1, "the queue went on after the error");
});

test("S28d: voices that arrive after a failure do not start the reading again (R3-004)", () => {
  const p = page({ voices: [] });
  const btn = p.button("alta");
  btn.click();
  p.clock.tick(3000);
  assert.deepEqual(p.shown(), [FAIL]);
  const n = p.spoken().length;
  p.synth.voicesArrive([ES_CL]);
  p.clock.tick(5000);
  assert.equal(p.spoken().length, n);
  assert.equal(p.label(btn), "Escuchar");
  assert.equal(btn.getAttribute("aria-pressed"), "false");
  assert.deepEqual(p.shown(), [FAIL]);
});

test("S28d: once the voice has started, a slow block does not raise the message", () => {
  const p = page();
  const btn = p.button("alta");
  btn.click();
  p.clock.tick(150);
  p.synth.start();
  p.clock.tick(10000);
  assert.equal(p.label(btn), "Detener");
  assert.deepEqual(p.shown(), [HINT]);
});

test("S28e: same text queue, es-CL first, rate 0.9, «Detener», a second click stops", () => {
  const p = page({ voices: [ES_ES, ES_CL] });
  const btn = p.button("alta");
  btn.click();
  assert.equal(p.label(btn), "Detener");
  assert.equal(btn.getAttribute("aria-pressed"), "true");
  p.clock.tick(150);
  p.synth.start(); p.synth.end();
  p.synth.start();
  const texts = p.spoken().map((u) => u.text);
  assert.deepEqual(texts, voz.chunks(byId(parse(read("index.html")), "alta")).slice(0, 2));
  for (const u of p.spoken()) {
    assert.equal(u.voice, ES_CL);
    assert.equal(u.lang, "es-CL");
    assert.equal(u.rate, 0.9);
  }
  btn.click();
  assert.equal(p.label(btn), "Escuchar");
  assert.equal(btn.getAttribute("aria-pressed"), "false");
  assert.ok(p.cancels().length >= 1);
  const n = p.spoken().length;
  p.clock.tick(5000);
  assert.equal(p.spoken().length, n, "the queue went on after «Detener»");
  assert.deepEqual(p.shown(), []);
});

test("S28e: leaving the screen stops the voice", () => {
  const p = page();
  const btn = p.button("alta");
  btn.click();
  p.clock.tick(150);
  p.synth.start();
  p.document.dispatch("routechange");
  assert.equal(p.label(btn), "Escuchar");
  assert.ok(p.cancels().length >= 1);
});

test("S28d: in the guide dialog, the message sits inside the scrollable text, above the button row", () => {
  const p = page({ voices: [] });
  const btn = p.button("guia-texto");
  byId(p.tree, "guia-titulo").textContent = "Bienvenida"; // guia.js fills it in the browser
  btn.click();
  p.clock.tick(3000);
  const msg = regionWith(p, FAIL);
  assert.ok(msg, `message missing: ${JSON.stringify(p.shown())}`);
  const texto = byId(p.tree, "guia-texto");
  assert.equal(all(texto, (n) => n === msg).length, 1, "message is outside the dialog's scrollable text");
  assert.ok(!voz.chunks(texto).some((c) => c.includes("No se pudo leer")));
  assert.equal(p.label(btn), "Escuchar");
});

test("S28d: in the guide, after the step text is replaced, the message is still shown in a connected node (R3-005)", () => {
  const p = page({ voices: [] });
  const btn = p.button("guia-texto");
  const texto = byId(p.tree, "guia-texto");
  const cuerpo = byId(p.tree, "guia-cuerpo");
  const step = (t) => {
    // What guia.js does on each step: stop the voice, set the title, replace the body.
    p.document.dispatch("routechange");
    byId(p.tree, "guia-titulo").textContent = t;
    const para = el("p", {}, null);
    para.textContent = `Texto de ${t}`;
    cuerpo.replaceChildren(para);
  };
  step("Bienvenida");
  btn.click();
  step("Paso 2");
  step("Paso 3");
  btn.click();
  p.clock.tick(3000);
  const msg = regionWith(p, FAIL);
  assert.ok(msg, `message missing or detached: ${JSON.stringify(p.shown())}`);
  let n = msg;
  while (n.parentNode) n = n.parentNode;
  assert.equal(n, p.tree, "message node is not connected to the page");
  assert.equal(all(texto, (x) => x === msg).length, 1, "message is outside the dialog's scrollable text");
  assert.equal(p.label(btn), "Escuchar");
});

test("S28: the messages are not read aloud as part of the section", () => {
  const p = page({ voices: [] });
  p.button("alta").click();
  p.clock.tick(3000);
  assert.deepEqual(p.shown(), [FAIL]);
  assert.ok(!voz.chunks(byId(p.tree, "alta")).some((c) => c.includes("No se pudo leer")));
});

test("S28: styles.css styles the messages and hides them in print", () => {
  const css = read("styles.css");
  assert.match(css, /\.speak-msgs/);
  const print = css.slice(css.indexOf("@media print"));
  assert.match(print, /\.speak-msgs/);
});

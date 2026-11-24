(function (root) {
  "use strict";

  // --- «Escuchar» by blocks: pure, no DOM globals ------------------------------------
  // Works on any tree with nodeType, tagName, childNodes, nodeValue and getAttribute,
  // so it is tested in Node against the real index.html (tests/pauta-personal/voz.test.mjs).

  // Controls and decoration are not content.
  var SKIP = { BUTTON: 1, NAV: 1, SVG: 1, SCRIPT: 1, STYLE: 1, TEMPLATE: 1, NOSCRIPT: 1, INPUT: 1, SELECT: 1, TEXTAREA: 1, CANVAS: 1 };
  var BLOCK = {};
  ("ADDRESS ARTICLE ASIDE BLOCKQUOTE CAPTION DD DETAILS DIV DL DT FIELDSET FIGCAPTION FIGURE FOOTER FORM " +
    "H1 H2 H3 H4 H5 H6 HEADER LEGEND LI MAIN OL P SECTION SUMMARY TABLE TBODY TD TFOOT TH THEAD TR UL")
    .split(" ").forEach(function (t) { BLOCK[t] = 1; });

  function tag(n) { return n.nodeType === 1 ? String(n.tagName).toUpperCase() : ""; }
  function attr(n, name) { return n.getAttribute ? n.getAttribute(name) : null; }
  function hasClass(n, c) { return (" " + (attr(n, "class") || "") + " ").indexOf(" " + c + " ") >= 0; }
  // .speak-msgs holds the «Escuchar» hint and failure message (S28): never read aloud.
  function skipped(n) {
    return n.nodeType === 1 && (SKIP[tag(n)] || attr(n, "hidden") !== null || attr(n, "aria-hidden") === "true" ||
      hasClass(n, "speak-msgs"));
  }
  function kids(n) { return Array.prototype.slice.call(n.childNodes || []); }
  function elements(n) { return kids(n).filter(function (c) { return c.nodeType === 1 && !skipped(c); }); }

  // Read "+" as "más" so the meal examples sound natural.
  function clean(s) { return s.replace(/\s+\+\s+/g, ", más ").replace(/\s+/g, " ").trim(); }

  function textOf(n) {
    if (n.nodeType === 3) return n.nodeValue || "";
    if (n.nodeType !== 1 || skipped(n)) return "";
    return kids(n).map(textOf).join("");
  }

  function hasBlock(n) {
    return elements(n).some(function (c) { return BLOCK[tag(c)] || hasBlock(c); });
  }

  function sentence(s) { return /[.!?…:»]$/.test(s) ? s : s + "."; }

  // A row of the pauta table (<article class="group"> with two .half columns):
  // «<grupo>. Preferir: … Limitar o evitar: …», so every food is heard with its list.
  function rowChunk(n) {
    var cols = elements(n).filter(function (c) { return hasClass(c, "half"); });
    var head = elements(n).filter(function (c) { return /^H[1-6]$/.test(tag(c)); })[0];
    if (!head || cols.length < 2) return null;
    var parts = [sentence(clean(textOf(head)))];
    cols.forEach(function (col) {
      var label = "";
      var body = [];
      elements(col).forEach(function (c) {
        if (!label && hasClass(c, "tag")) label = clean(textOf(c));
        else body.push(clean(textOf(c)));
      });
      parts.push((label ? label + ": " : "") + body.join(" "));
    });
    return clean(parts.join(" "));
  }

  function chunks(section) {
    var out = [];
    function push(s) { s = clean(s); if (s) out.push(s); }
    function walk(n) {
      var buffer = [];
      function flush() { push(buffer.join("")); buffer = []; }
      kids(n).forEach(function (c) {
        if (c.nodeType === 3) { buffer.push(c.nodeValue || ""); return; }
        if (c.nodeType !== 1 || skipped(c)) return;
        var t = tag(c);
        if (t === "ARTICLE" && hasClass(c, "group")) {
          var row = rowChunk(c);
          if (row) { flush(); push(row); return; }
        }
        if (t === "TR") {
          flush();
          push(elements(c).map(function (cell) { return clean(textOf(cell)); }).filter(Boolean).join(", "));
          return;
        }
        if (BLOCK[t] || hasBlock(c)) {
          flush();
          if (hasBlock(c)) walk(c); else push(textOf(c));
          return;
        }
        buffer.push(textOf(c));
      });
      flush();
    }
    walk(section);
    return out;
  }

  root.pautaVoz = { chunks: chunks };
  if (typeof document === "undefined") return;

  // Text size: stored only on this device.
  var SCALES = [1, 1.15, 1.3, 1.5];
  var KEY = "pauta-scale";
  var idx = 0;
  try {
    var saved = parseInt(localStorage.getItem(KEY), 10);
    if (saved >= 0 && saved < SCALES.length) idx = saved;
  } catch (e) { /* storage unavailable: keep default */ }

  function applyScale() {
    document.documentElement.style.setProperty("--scale", SCALES[idx]);
    document.getElementById("smaller").disabled = idx === 0;
    document.getElementById("bigger").disabled = idx === SCALES.length - 1;
    try { localStorage.setItem(KEY, String(idx)); } catch (e) { /* ignore */ }
  }
  document.getElementById("bigger").addEventListener("click", function () {
    if (idx < SCALES.length - 1) { idx++; applyScale(); }
  });
  document.getElementById("smaller").addEventListener("click", function () {
    if (idx > 0) { idx--; applyScale(); }
  });
  applyScale();

  // Offline support. Registered before the voice check so a browser without a
  // voice still works offline.
  if ("serviceWorker" in navigator && location.protocol !== "file:") {
    navigator.serviceWorker.register("sw.js").catch(function () { /* online-only fallback */ });
  }

  // Read aloud with the device's own voice (no network).
  var buttons = Array.prototype.slice.call(document.querySelectorAll(".speak"));
  var synth = window.speechSynthesis;
  if (!synth || typeof SpeechSynthesisUtterance === "undefined") {
    buttons.forEach(function (b) { b.hidden = true; });
    return;
  }

  var active = null;
  // Each «Escuchar» gets a new run; callbacks of a stopped run do nothing.
  var run = 0;

  // S28: some browsers drop a speak() made in the same instant as cancel(), load
  // their voices late, or never start. These bound each case.
  var AFTER_CANCEL_MS = 100;
  var START_WAIT_MS = 3000;

  // S28b: ask for the voices as the page opens, so they are listed by the tap. The
  // tap never waits for them: iOS only sounds a speak() made inside the tap.
  function loadVoices() { synth.getVoices(); }
  loadVoices();
  if (synth.addEventListener) synth.addEventListener("voiceschanged", loadVoices);
  else synth.onvoiceschanged = loadVoices;
  var HINT = "¿No se escucha? Sube el volumen y revisa que el teléfono no esté en silencio.";
  var FAIL = "No se pudo leer en voz alta en este equipo. Revisa el volumen y que el teléfono no esté en silencio. " +
    "Si sigue sin sonar, este equipo no tiene una voz para leer en español.";

  // Below each button's row: a polite region for the hint and an alert for the
  // failure. Both exist (empty) from the start so screen readers announce changes.
  // In a dialog (the guide) the row is the bottom edge, so they go at the end of
  // the scrollable text the button reads, just above the row, and never clip.
  var msgs = [];
  buttons.forEach(function (b) {
    var box = document.createElement("div");
    box.className = "speak-msgs";
    var hint = document.createElement("p");
    hint.className = "speak-hint";
    hint.setAttribute("aria-live", "polite");
    var fail = document.createElement("p");
    fail.className = "speak-fail";
    fail.setAttribute("role", "alert");
    box.appendChild(hint);
    box.appendChild(fail);
    var region = b.closest && b.closest("dialog") && document.getElementById(b.getAttribute("data-target"));
    if (region) region.appendChild(box); else b.parentNode.insertAdjacentElement("afterend", box);
    msgs.push({ btn: b, hint: hint, fail: fail });
  });
  function msgOf(b) {
    for (var i = 0; i < msgs.length; i++) if (msgs[i].btn === b) return msgs[i];
    return null;
  }
  function clearHints() { msgs.forEach(function (m) { if (m.hint.textContent) m.hint.textContent = ""; }); }
  function clearFails() { msgs.forEach(function (m) { if (m.fail.textContent) m.fail.textContent = ""; }); }

  function pickVoice() {
    var voices = synth.getVoices();
    var prefs = ["es-CL", "es-419", "es-US", "es-MX", "es-ES", "es"];
    for (var i = 0; i < prefs.length; i++) {
      for (var j = 0; j < voices.length; j++) {
        if (voices[j].lang && voices[j].lang.replace("_", "-").indexOf(prefs[i]) === 0) return voices[j];
      }
    }
    return null;
  }

  // The label lives in a <span> so the inline icon stays.
  function setLabel(b, text) {
    var span = b.querySelector("span");
    if (span) span.textContent = text; else b.textContent = text;
  }

  function reset() {
    run += 1;
    buttons.forEach(function (b) {
      b.setAttribute("aria-pressed", "false");
      setLabel(b, "Escuchar");
    });
    active = null;
    clearHints();
  }

  // Cancels only when something is speaking or queued. True when it cancelled.
  function silence() {
    if (!synth.speaking && !synth.pending) return false;
    synth.cancel();
    return true;
  }

  function stop() {
    reset();
    return silence();
  }

  // S28d: the voice could not sound here. The button goes back and says so. It
  // always cancels: a stuck utterance may be queued without the browser saying so.
  function fail(btn) {
    reset();
    synth.cancel();
    var m = msgOf(btn);
    if (!m) return;
    m.fail.textContent = FAIL;
    if (m.fail.scrollIntoView) m.fail.scrollIntoView({ block: "nearest" });
  }

  // Leaving a screen stops the voice and clears its messages.
  document.addEventListener("routechange", function () {
    if (active) stop();
    clearFails();
  });

  // Speaks the blocks one after another: a short pause falls between them, and
  // «Detener» (or leaving) drops the rest of the queue. If the first block does
  // not start within START_WAIT_MS, or fails before starting, it reports it.
  // Without a voice it still speaks with es-CL; a device with no Spanish voice then
  // fails through onerror or the watchdog.
  function speakQueue(btn, queue, voice) {
    var mine = run;
    var started = false;
    var watchdog = setTimeout(function () {
      if (mine !== run || active !== btn || started) return;
      // Sounding without an onstart (some browsers) counts as started.
      if (synth.speaking) { started = true; return; }
      fail(btn);
    }, START_WAIT_MS);
    function next() {
      if (mine !== run || active !== btn) return;
      var text = queue.shift();
      if (!text) { clearTimeout(watchdog); reset(); return; }
      var u = new SpeechSynthesisUtterance(text);
      u.lang = "es-CL";
      u.rate = 0.9;
      if (voice) {
        u.voice = voice;
        if (voice.lang) u.lang = voice.lang.replace("_", "-");
      }
      u.onstart = function () {
        if (started) return;
        started = true;
        clearTimeout(watchdog);
      };
      u.onend = next;
      u.onerror = function () {
        if (mine !== run || active !== btn) return;
        clearTimeout(watchdog);
        if (started) reset(); else fail(btn);
      };
      synth.speak(u);
    }
    next();
  }

  buttons.forEach(function (btn) {
    btn.setAttribute("aria-pressed", "false");
    btn.addEventListener("click", function () {
      var wasActive = active === btn;
      var cancelled = stop();
      clearFails();
      if (wasActive) return;

      var section = document.getElementById(btn.getAttribute("data-target"));
      var queue = section ? chunks(section) : [];
      if (!queue.length) return;
      active = btn;
      btn.setAttribute("aria-pressed", "true");
      setLabel(btn, "Detener");
      var m = msgOf(btn);
      if (m) m.hint.textContent = HINT;
      var mine = run;
      function go() { if (mine === run) speakQueue(btn, queue, pickVoice()); }
      // Without a cancel, speak inside the tap itself (iOS needs the gesture), even
      // if no voice is listed yet. The only wait is the one after a real cancel.
      if (cancelled) setTimeout(go, AFTER_CANCEL_MS); else go();
    });
  });

})(this);

(function () {
  "use strict";

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
    buttons.forEach(function (b) {
      b.setAttribute("aria-pressed", "false");
      setLabel(b, "Escuchar");
    });
    active = null;
  }

  // Leaving a screen stops the voice.
  document.addEventListener("routechange", function () {
    if (active) { synth.cancel(); reset(); }
  });

  function sectionText(section) {
    var clone = section.cloneNode(true);
    // Buttons, breadcrumbs and the pager are controls, not content.
    Array.prototype.forEach.call(clone.querySelectorAll("button, nav, svg"), function (n) { n.remove(); });
    // Read "+" as "más" so the meal examples sound natural.
    return clone.textContent.replace(/\s+\+\s+/g, ", más ").replace(/\s+/g, " ").trim();
  }

  buttons.forEach(function (btn) {
    btn.setAttribute("aria-pressed", "false");
    btn.addEventListener("click", function () {
      var wasActive = active === btn;
      synth.cancel();
      reset();
      if (wasActive) return;

      var section = document.getElementById(btn.getAttribute("data-target"));
      var u = new SpeechSynthesisUtterance(sectionText(section));
      u.lang = "es-CL";
      u.rate = 0.9;
      var v = pickVoice();
      if (v) u.voice = v;
      u.onend = u.onerror = function () { if (active === btn) reset(); };

      active = btn;
      btn.setAttribute("aria-pressed", "true");
      setLabel(btn, "Detener");
      synth.speak(u);
    });
  });

})();

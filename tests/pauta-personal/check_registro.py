"""Checks that pauta-personal/registro.html ("Mis anotaciones") offers its sections,
never judges what the person wrote, and loads nothing from outside the site.

It also checks the «Leer una etiqueta» page next to it (etiqueta.html): no
judging words, a label on every control, nothing loaded from outside the site,
and the label reader as the only place its scripts talk to over the network.

Usage: python3 -I tests/pauta-personal/check_registro.py pauta-personal/registro.html
"""
import os
import re
import sys
from html.parser import HTMLParser

# Section id -> nav label.
SECTIONS = {
    "controles": "Mis controles",
    "diario": "Mi diario",
    "mediciones": "Presión y peso",
    "preguntas": "Preguntas",
    "medico": "Para el médico",
    "compartir": "Compartir",
}

# Wording that would turn the page into a judge of what the person wrote.
FORBIDDEN_WORDS = [
    "puedes comer", "puede comer", "está permitido", "es seguro", "semáforo",
    "normal", "riesgo", "elevad", "cumplimiento", "puntaje",
]

SCRIPTS = ["registro.js", "registro-core.js"]

# Browser APIs that would send or fetch data over the network.
NETWORK_APIS = re.compile(r"\bfetch\s*\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon|https?://|import\s*\(")

SCHEME = re.compile(r"^\s*([a-zA-Z][a-zA-Z0-9+.-]*:|//)")

# «Leer una etiqueta»: the page, its scripts, and the one address they may call.
LABEL_PAGE = "etiqueta.html"
LABEL_SCRIPTS = ["etiqueta.js", "etiqueta-core.js"]
LABEL_FORBIDDEN = FORBIDDEN_WORDS + ["prohibido", "peligro"]
READER_URL = re.compile(r"^https://mi-pauta-etiquetas\.[a-z0-9-]+\.workers\.dev/leer$")
URL_IN_JS = re.compile(r"https?://[^\s\"'`)]+")
OTHER_NETWORK = re.compile(r"XMLHttpRequest|WebSocket|EventSource|sendBeacon|import\s*\(")


class Page(HTMLParser):
    def __init__(self):
        super().__init__()
        self.parts = []
        self.skip = 0
        self.urls = []
        self.ids = set()
        self.links = {}
        self.label_for = set()
        self.controls = []
        self._href = None
        self._text = []

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag in ("script", "style"):
            self.skip += 1
        for key in ("src", "href"):
            if a.get(key) is not None:
                self.urls.append(a[key])
        if a.get("id"):
            self.ids.add(a["id"])
        if tag == "label" and a.get("for"):
            self.label_for.add(a["for"])
        if tag in ("input", "select", "textarea") and a.get("type") not in ("hidden", "submit", "button"):
            self.controls.append(a.get("id"))
        if tag == "a" and (a.get("href") or "").startswith("#"):
            self._href = a["href"][1:]
            self._text = []

    def handle_endtag(self, tag):
        if tag in ("script", "style"):
            self.skip -= 1
        if tag == "a" and self._href is not None:
            self.links.setdefault(self._href, []).append(re.sub(r"\s+", " ", "".join(self._text)).strip())
            self._href = None

    def handle_data(self, data):
        if self._href is not None:
            self._text.append(data)
        if not self.skip:
            self.parts.append(data)


def check_label_page(base, registro_page):
    """Returns the problems found in etiqueta.html and its scripts."""
    problems = []
    path = os.path.join(base, LABEL_PAGE)
    if not os.path.isfile(path):
        return [f"LABEL PAGE: missing {LABEL_PAGE}"]
    with open(path, encoding="utf-8") as fh:
        html = fh.read()
    page = Page()
    page.feed(html)
    text = re.sub(r"\s+", " ", " ".join(page.parts)).lower()
    sources = {}
    for name in LABEL_SCRIPTS:
        with open(os.path.join(base, name), encoding="utf-8") as fh:
            sources[name] = fh.read()

    for w in LABEL_FORBIDDEN:
        if w in text or w in html.lower():
            problems.append(f"LABEL PAGE: FORBIDDEN WORD in page: {w}")
        for name, src in sources.items():
            if w in src.lower():
                problems.append(f"LABEL PAGE: FORBIDDEN WORD in {name}: {w}")
    for u in page.urls:
        if SCHEME.match(u):
            problems.append(f"LABEL PAGE: EXTERNAL URL: {u}")
    for c in page.controls:
        if not c or c not in page.label_for:
            problems.append(f"LABEL PAGE: FIELD WITHOUT LABEL: {c}")
    urls = [(name, u) for name, src in sources.items() for u in URL_IN_JS.findall(src)]
    if not urls:
        problems.append("LABEL PAGE: no label reader address in its scripts")
    for name, u in urls:
        if not READER_URL.match(u):
            problems.append(f"LABEL PAGE: URL other than the label reader in {name}: {u}")
    for name, src in sources.items():
        for m in OTHER_NETWORK.findall(src):
            problems.append(f"LABEL PAGE: NETWORK API in {name}: {m}")
    fetches = {name: len(re.findall(r"\bfetch\s*\(", src)) for name, src in sources.items()}
    if fetches.get("etiqueta-core.js"):
        problems.append("LABEL PAGE: etiqueta-core.js must not call fetch (pure logic)")
    if fetches.get("etiqueta.js") != 1:
        problems.append(f"LABEL PAGE: etiqueta.js must call fetch exactly once, found {fetches.get('etiqueta.js')}")
    if 'href="etiqueta.html"' not in registro_page:
        problems.append("LABEL PAGE: registro.html has no link to etiqueta.html")
    return problems


def main(path):
    with open(path, encoding="utf-8") as fh:
        html = fh.read()
    page = Page()
    page.feed(html)
    text = re.sub(r"\s+", " ", " ".join(page.parts)).lower()

    base = os.path.dirname(path)
    sources = {}
    for name in SCRIPTS:
        with open(os.path.join(base, name), encoding="utf-8") as fh:
            sources[name] = fh.read()

    problems = []
    for k, label in SECTIONS.items():
        if f'<section id="{k}"' not in html:
            problems.append(f"MISSING SECTION: {k}")
        if label not in page.links.get(k, []):
            problems.append(f"MISSING NAV LINK: {k} ({label})")
    for w in FORBIDDEN_WORDS:
        if w in text:
            problems.append(f"FORBIDDEN WORD in page: {w}")
        for name, src in sources.items():
            if w in src.lower():
                problems.append(f"FORBIDDEN WORD in {name}: {w}")
    external = [u for u in page.urls if SCHEME.match(u)]
    for u in external:
        problems.append(f"EXTERNAL URL: {u}")
    for name, src in sources.items():
        for m in NETWORK_APIS.findall(src):
            problems.append(f"NETWORK API in {name}: {m}")
    unlabeled = [c for c in page.controls if not c or c not in page.label_for]
    for c in unlabeled:
        problems.append(f"FIELD WITHOUT LABEL: {c}")
    label_problems = check_label_page(base, html)
    problems += label_problems

    for p in problems:
        print(p)
    found = sum(1 for k, label in SECTIONS.items() if f'<section id="{k}"' in html and label in page.links.get(k, []))
    print(
        f"sections with nav links: {found}/{len(SECTIONS)}; "
        f"forbidden words: {sum(1 for p in problems if p.startswith('FORBIDDEN'))}; "
        f"external urls: {len(external)}; "
        f"network apis: {sum(1 for p in problems if p.startswith('NETWORK'))}; "
        f"fields without label: {len(unlabeled)}; "
        f"label page problems: {len(label_problems)}"
    )
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1]))

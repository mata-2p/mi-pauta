"""Checks that pauta-personal/registro.html ("Mis anotaciones") offers its sections,
never judges what the person wrote, and loads nothing from outside the site.

It also checks the «Leer una etiqueta» page next to it (etiqueta.html): no
judging words, a label on every control, nothing loaded from outside the site,
the label reader as the only place its scripts talk to over the network, and
each live region marked once (role=alert or role=status, or aria-live, never both).

And «Mi despensa» (despensa.html): no judging words, a label on every control,
nothing loaded from outside the site, no network at all in its scripts, and
links to it from the pauta and from Mis anotaciones.

And the date and time fields (S30): each sits in a .field, the ones that share a
row sit in a .pair.datetime, and registro.css carries the WebKit/iOS rules that
keep them inside the form (min-width 0, full width, border-box, tap height,
value aligned left, min-width 0 on their wrappers).

And the first-use guide (S26): its scripts (guia.js, guia-core.js) use no network
and no judging words, and every page has the guide dialog without loading
anything from outside.

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
        self.double_live = []
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
        if a.get("role") in ("alert", "status") and "aria-live" in a:
            self.double_live.append(a.get("id") or tag)
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
    for r in page.double_live:
        problems.append(f"LABEL PAGE: LIVE REGION with both role and aria-live: {r}")
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


# «Mi despensa»: the page and its scripts. The pauta's own table inside
# despensa-core.js (between the markers) is checked word for word by
# check_verbatim.py, so it is left out of the wording check here.
DESPENSA_PAGE = "despensa.html"
DESPENSA_SCRIPTS = ["despensa.js", "despensa-core.js"]
DESPENSA_FORBIDDEN = FORBIDDEN_WORDS + ["prohibido", "peligro", "demasiado", "exceso"]


def without_pauta_table(src):
    return re.sub(r"// <pauta-table>.*?// </pauta-table>", "", src, flags=re.S)


def check_despensa_page(base, registro_page):
    """Returns the problems found in despensa.html and its scripts."""
    path = os.path.join(base, DESPENSA_PAGE)
    if not os.path.isfile(path):
        return [f"DESPENSA PAGE: missing {DESPENSA_PAGE}"]
    problems = []
    with open(path, encoding="utf-8") as fh:
        html = fh.read()
    page = Page()
    page.feed(html)
    text = re.sub(r"\s+", " ", " ".join(page.parts)).lower()
    sources = {}
    for name in DESPENSA_SCRIPTS:
        p = os.path.join(base, name)
        if not os.path.isfile(p):
            problems.append(f"DESPENSA PAGE: missing {name}")
            continue
        with open(p, encoding="utf-8") as fh:
            sources[name] = fh.read()
    for w in DESPENSA_FORBIDDEN:
        if w in text:
            problems.append(f"DESPENSA PAGE: FORBIDDEN WORD in page: {w}")
        for name, src in sources.items():
            if w in without_pauta_table(src).lower():
                problems.append(f"DESPENSA PAGE: FORBIDDEN WORD in {name}: {w}")
    for u in page.urls:
        if SCHEME.match(u):
            problems.append(f"DESPENSA PAGE: EXTERNAL URL: {u}")
    for c in page.controls:
        if not c or c not in page.label_for:
            problems.append(f"DESPENSA PAGE: FIELD WITHOUT LABEL: {c}")
    for name, src in sources.items():
        for m in NETWORK_APIS.findall(src):
            problems.append(f"DESPENSA PAGE: NETWORK API in {name}: {m}")
    index = os.path.join(base, "index.html")
    with open(index, encoding="utf-8") as fh:
        if 'href="despensa.html"' not in fh.read():
            problems.append("DESPENSA PAGE: index.html has no link to despensa.html")
    if 'href="despensa.html"' not in registro_page:
        problems.append("DESPENSA PAGE: registro.html has no link to despensa.html")
    return problems


# S30: date and time fields. Pairs that share a row, and the CSS they rely on.
DATETIME_PAIRS = [("c-date", "c-time"), ("m-date", "m-time"), ("p-from", "p-to")]
DATETIME_INPUT = 'input[type="date"]'
TIME_INPUT = 'input[type="time"]'
DATETIME_RULES = {
    "date/time inputs": ((DATETIME_INPUT, TIME_INPUT),
                         ["min-width: 0", "width: 100%", "box-sizing: border-box", "min-height: var(--tap)"]),
    "date/time value": (("::-webkit-date-and-time-value",), ["text-align: left"]),
    "pair wrapper": ((".pair.datetime",), ["min-width: 0"]),
    "field in a pair": ((".pair > .field",), ["min-width: 0"]),
}


class Ancestry(HTMLParser):
    """Records, for each date or time input, the classes of the elements around it."""
    VOID = {"input", "br", "img", "meta", "link", "hr", "source", "use"}

    def __init__(self):
        super().__init__()
        self.stack = []
        self.inputs = {}

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag == "input" and a.get("type") in ("date", "time"):
            self.inputs[a.get("id")] = [set((c or "").split()) for _, c in self.stack]
        if tag not in self.VOID:
            self.stack.append((tag, a.get("class")))

    def handle_endtag(self, tag):
        for i in range(len(self.stack) - 1, -1, -1):
            if self.stack[i][0] == tag:
                del self.stack[i:]
                break


def css_rules(css):
    """(selector, declarations) for each rule, comments removed, nested at-rules flattened."""
    css = re.sub(r"/\*.*?\*/", "", css, flags=re.S)
    return [(sel.strip(), re.sub(r"\s+", " ", body)) for sel, body in re.findall(r"([^{}]+)\{([^{}]*)\}", css)]


def check_datetime(base, html):
    """Returns the problems found in the date and time fields (S30)."""
    problems = []
    tree = Ancestry()
    tree.feed(html)
    if not tree.inputs:
        problems.append("DATETIME: no date or time inputs in registro.html")
    for iid, ancestors in tree.inputs.items():
        if not ancestors or "field" not in ancestors[-1]:
            problems.append(f"DATETIME: {iid} is not directly inside a .field")
    for pair in DATETIME_PAIRS:
        for iid in pair:
            ancestors = tree.inputs.get(iid)
            if ancestors is None:
                problems.append(f"DATETIME: missing input {iid}")
            elif len(ancestors) < 2 or not {"pair", "datetime"} <= ancestors[-2]:
                problems.append(f"DATETIME: {iid} is not in a .pair.datetime")
    with open(os.path.join(base, "registro.css"), encoding="utf-8") as fh:
        rules = css_rules(fh.read())
    for name, (selectors, needed) in DATETIME_RULES.items():
        decls = " ".join(body for sel, body in rules if all(s in sel for s in selectors))
        if not decls:
            problems.append(f"DATETIME CSS: no rule for {name} ({', '.join(selectors)})")
            continue
        for d in needed:
            if not re.search(re.escape(d) + r"\s*(;|$|!)", decls):
                problems.append(f"DATETIME CSS: {name} lacks «{d}»")
    return problems


# The first-use guide: scripts and the pages that carry its dialog.
GUIDE_SCRIPTS = ["guia.js", "guia-core.js"]
GUIDE_PAGES = ["index.html", "registro.html", "despensa.html", "etiqueta.html"]
GUIDE_FORBIDDEN = DESPENSA_FORBIDDEN


def check_guide(base):
    """Returns the problems found in the guide's scripts and dialogs."""
    problems = []
    for name in GUIDE_SCRIPTS:
        p = os.path.join(base, name)
        if not os.path.isfile(p):
            problems.append(f"GUIDE: missing {name}")
            continue
        with open(p, encoding="utf-8") as fh:
            src = fh.read()
        for m in NETWORK_APIS.findall(src):
            problems.append(f"GUIDE: NETWORK API in {name}: {m}")
        for w in GUIDE_FORBIDDEN:
            if w in src.lower():
                problems.append(f"GUIDE: FORBIDDEN WORD in {name}: {w}")
    for name in GUIDE_PAGES:
        with open(os.path.join(base, name), encoding="utf-8") as fh:
            html = fh.read()
        dialog = re.search(r'<dialog id="guia".*?</dialog>', html, re.S)
        if not dialog:
            problems.append(f"GUIDE: {name} has no guide dialog")
            continue
        page = Page()
        page.feed(dialog.group(0))
        text = re.sub(r"\s+", " ", " ".join(page.parts)).lower()
        for w in GUIDE_FORBIDDEN:
            if w in text:
                problems.append(f"GUIDE: FORBIDDEN WORD in the dialog of {name}: {w}")
        for u in page.urls:
            if SCHEME.match(u):
                problems.append(f"GUIDE: EXTERNAL URL in the dialog of {name}: {u}")
        if '<script type="module" src="guia.js"></script>' not in html:
            problems.append(f"GUIDE: {name} does not load guia.js")
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
    despensa_problems = check_despensa_page(base, html)
    problems += despensa_problems
    guide_problems = check_guide(base)
    problems += guide_problems
    datetime_problems = check_datetime(base, html)
    problems += datetime_problems

    for p in problems:
        print(p)
    found = sum(1 for k, label in SECTIONS.items() if f'<section id="{k}"' in html and label in page.links.get(k, []))
    print(
        f"sections with nav links: {found}/{len(SECTIONS)}; "
        f"forbidden words: {sum(1 for p in problems if p.startswith('FORBIDDEN'))}; "
        f"external urls: {len(external)}; "
        f"network apis: {sum(1 for p in problems if p.startswith('NETWORK'))}; "
        f"fields without label: {len(unlabeled)}; "
        f"label page problems: {len(label_problems)}; "
        f"despensa page problems: {len(despensa_problems)}; "
        f"guide problems: {len(guide_problems)}; "
        f"date/time problems: {len(datetime_problems)}"
    )
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1]))

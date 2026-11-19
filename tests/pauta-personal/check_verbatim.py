"""Checks that pauta-personal/index.html carries the nutritionist's pauta verbatim
and adds no clinical numbers of its own.

It also checks the «Leer una etiqueta» screen next to it (etiqueta.html and
etiqueta-core.js): every pauta sentence it quotes is a sentence of the pauta,
word for word, and it adds no clinical numbers or deciding wording either.

And «Mi despensa» (despensa.html, despensa.js, despensa-core.js): the table it
groups by is the pauta's «¿Qué alimentos elegir?» table, word for word, row by
row; its own wording adds no clinical numbers and no judging words.

Usage: python3 -I tests/pauta-personal/check_verbatim.py pauta-personal/index.html
"""
import os
import re
import sys
from html.parser import HTMLParser

# Transcribed by hand from the two paper pages received 2026-11-18.
SOURCE = [
    "Ayudar a la recuperación de los riñones, mantener una buena hidratación y controlar la presión arterial, evitando el exceso de sal y alimentos ultraprocesados.",
    "Realizar 4 tiempos de comida al día: desayuno, almuerzo, once y cena. Si necesita una colación, puede incorporarla según apetito y horario.",
    "No agregar sal a las comidas en la mesa. Para dar sabor puede usar limón, ajo, cebolla, orégano, perejil, cilantro, u otras hierbas y especias sin sal.",
    "Preferir alimentos frescos y preparados en casa.",
    "Evitar el consumo frecuente de alimentos envasados, instantáneos y muy salados.",
    "No usar 'sal light' o sustitutos de sal con potasio.",
    "Pan con bajo contenido de sodio, avena, arroz, fideos, sémola, papa.",
    "Pan muy salado, sopaipillas y productos instantáneos.",
    "Pollo, pavo, pescado, carne magra y huevo. Preferir preparaciones caseras.",
    "Cecinas, vienesas, hamburguesas procesadas, nuggets y carnes muy saladas.",
    "Leche, yogur natural y quesillos bajos en sodio.",
    "Quesos muy salados y lácteos con alto contenido de sodio.",
    "Verduras frescas, cocidas o al vapor, según tolerancia.",
    "Verduras en conserva y preparaciones con mucho caldo o sal.",
    "Fruta fresca, según tolerancia.",
    "Frutas en conserva con almíbar y productos con mucha azúcar añadida.",
    "Aceite de oliva o canola en pequeñas cantidades, palta y frutos secos sin sal.",
    "Mantequilla en exceso, frituras y frutos secos salados.",
    "Agua y líquidos indicados por el equipo de salud.",
    "Bebidas energéticas, sopas instantáneas y exceso de bebidas azucaradas.",
    "1 taza de leche descremada o yogurt natural + 2 rebanadas de pan con bajo contenido de sodio + 1 huevo o quesillo bajo en sodio + 1 porción de fruta.",
    "Ensalada de verduras sin sal agregada + 1 porción de pollo, pescado o carne magra + 1 porción de arroz, fideos o papa + 1 cucharadita de aceite + 1 fruta.",
    "1 taza de leche o yogurt natural + 2 rebanadas de pan con bajo contenido de sodio + huevo, pollo desmenuzado o quesillo bajo en sodio.",
    "1 porción de pollo, pescado, huevo o carne magra + 1 porción de arroz, fideos, papa o puré + verduras. Preparar sin agregar sal.",
    "1 fruta, yogurt natural o una pequeña porción de frutos secos sin sal.",
    "Preferir preparaciones caseras y leer el etiquetado nutricional de los alimentos envasados.",
    "Elegir productos con menor cantidad de sodio.",
    "Evitar agregar sal durante la preparación y al servir.",
    "Disminuir cecinas, caldos en cubo, sopas instantáneas, snacks salados, conservas, salsas comerciales y comida rápida.",
    "Mantener los controles indicados después del alta para revisar la función renal y ajustar la alimentación según los nuevos exámenes.",
]

# Sections the page must offer (id -> nav label). The guides only reorganize the
# pauta and Chilean labeling facts; they add no clinical limits.
SECTIONS = {
    "indicaciones": "Indicaciones",
    "elegir": "Qué elegir",
    "dia": "Un día de ejemplo",
    "presion": "Presión arterial",
    "seguimiento": "Seguimiento",
    "cocina": "Para quien cocina",
    "etiquetas": "Leer etiquetas",
}

# Wording that would turn the page into a decision-maker.
FORBIDDEN_PHRASES = ["puedes comer", "puede comer", "está permitido", "es seguro", "semáforo"]

# Units that would mean the page states a limit the nutritionist did not write.
FORBIDDEN = re.compile(r"\b\d+\s*(mg|g|ml|mL|cc|kcal|litros?|L)\b")


class Text(HTMLParser):
    def __init__(self):
        super().__init__()
        self.parts = []
        self.skip = 0

    def handle_starttag(self, tag, attrs):
        if tag in ("script", "style"):
            self.skip += 1

    def handle_endtag(self, tag):
        if tag in ("script", "style"):
            self.skip -= 1

    def handle_data(self, data):
        if not self.skip:
            self.parts.append(data)


# The only pauta sentences the label screen may show after confirmation.
LABEL_QUOTES = {
    "PAUTA_SODIO": "Elegir productos con menor cantidad de sodio.",
    "PAUTA_POTASIO": "No usar 'sal light' o sustitutos de sal con potasio.",
}
LABEL_FORBIDDEN = FORBIDDEN_PHRASES + ["normal", "riesgo", "elevad", "prohibido", "peligro"]


def page_text(html):
    parser = Text()
    parser.feed(html)
    return re.sub(r"\s+", " ", " ".join(parser.parts))


def check_label_screen(base, source_text):
    """Returns (problems, quotes checked) for etiqueta.html and etiqueta-core.js."""
    problems = []
    paths = {n: os.path.join(base, n) for n in ("etiqueta.html", "etiqueta-core.js")}
    for name, p in paths.items():
        if not os.path.isfile(p):
            problems.append(f"LABEL SCREEN: missing {name}")
    if problems:
        return problems, 0
    with open(paths["etiqueta.html"], encoding="utf-8") as fh:
        text = page_text(fh.read())
    with open(paths["etiqueta-core.js"], encoding="utf-8") as fh:
        core = fh.read()

    checked = 0
    for const, sentence in LABEL_QUOTES.items():
        m = re.search(rf'export const {const} = "((?:[^"\\]|\\.)*)";', core)
        checked += 1
        if not m:
            problems.append(f"LABEL SCREEN: etiqueta-core.js has no {const}")
            continue
        if m.group(1) != sentence:
            problems.append(f"LABEL SCREEN: {const} is not the pauta sentence: {m.group(1)!r}")
        if sentence not in SOURCE or sentence not in source_text:
            problems.append(f"LABEL SCREEN: {const} is not in the pauta: {sentence!r}")
    # Any «…» quotation in the page that ends in a period is meant as a pauta sentence.
    for q in re.findall(r"«([^»]+\.)»", text):
        checked += 1
        if q not in SOURCE:
            problems.append(f"LABEL SCREEN: quoted text is not a pauta sentence: {q!r}")
    for unit in FORBIDDEN.findall(text):
        problems.append(f"LABEL SCREEN: FORBIDDEN UNIT: {unit}")
    low = (text + " " + core).lower()
    for p in LABEL_FORBIDDEN:
        if p in low:
            problems.append(f"LABEL SCREEN: FORBIDDEN PHRASE: {p}")
    return problems, checked


# «Mi despensa»: the pauta's own table, copied between these markers in despensa-core.js.
DESPENSA_FORBIDDEN = LABEL_FORBIDDEN + ["demasiado", "exceso"]
TABLE_START = "// <pauta-table>"
TABLE_END = "// </pauta-table>"
TABLE_ROW = re.compile(r'\{\s*group:\s*"([^"]+)",\s*preferir:\s*"([^"]+)",\s*limitar:\s*"([^"]+)"\s*\}')
INDEX_ROW = re.compile(
    r'<article class="group">\s*<h3>([^<]+)</h3>\s*'
    r'<div class="half pref"><p class="tag">.*?</svg>([^<]+)</p><p>([^<]+)</p></div>\s*'
    r'<div class="half lim"><p class="tag">.*?</svg>([^<]+)</p><p>([^<]+)</p></div>',
    re.S,
)


def check_despensa(base, index_html):
    """Returns (problems, table rows checked) for the despensa page and its scripts."""
    problems = []
    paths = {n: os.path.join(base, n) for n in ("despensa.html", "despensa.js", "despensa-core.js")}
    for name, p in paths.items():
        if not os.path.isfile(p):
            problems.append(f"DESPENSA: missing {name}")
    if problems:
        return problems, 0
    src = {}
    for name, p in paths.items():
        with open(p, encoding="utf-8") as fh:
            src[name] = fh.read()
    core = src["despensa-core.js"]
    if TABLE_START not in core or TABLE_END not in core:
        return ["DESPENSA: despensa-core.js has no pauta table markers"], 0
    head, rest = core.split(TABLE_START, 1)
    block, tail = rest.split(TABLE_END, 1)
    rows = TABLE_ROW.findall(block)
    index_rows = [(g.strip(), pt.strip(), p.strip(), lt.strip(), l.strip()) for g, pt, p, lt, l in INDEX_ROW.findall(index_html)]
    if not index_rows:
        problems.append("DESPENSA: no «Qué elegir» table found in index.html")
    if [(g, p, l) for g, p, l in rows] != [(g, p, l) for g, _, p, _, l in index_rows]:
        problems.append("DESPENSA: the despensa table is not the pauta table, row by row")
    for g, p, l in rows:
        for sentence in (p, l):
            if sentence not in SOURCE:
                problems.append(f"DESPENSA: table sentence is not in the pauta: {sentence!r}")
    labels = {(pt, lt) for _, pt, _, lt, _ in index_rows}
    for pt, lt in labels:
        for word in (pt, lt):
            if f'"{word}"' not in head + tail:
                problems.append(f"DESPENSA: column heading is not the pauta's word: {word!r}")
    # Everything outside the pauta's table is the screen's own wording.
    own = page_text(src["despensa.html"])
    for q in re.findall(r"«([^»]+\.)»", own):
        if q not in SOURCE:
            problems.append(f"DESPENSA: quoted text is not a pauta sentence: {q!r}")
    for unit in FORBIDDEN.findall(own):
        problems.append(f"DESPENSA: FORBIDDEN UNIT: {unit}")
    low = " ".join([own, src["despensa.js"], head, tail]).lower()
    for p in DESPENSA_FORBIDDEN:
        if p in low:
            problems.append(f"DESPENSA: FORBIDDEN PHRASE: {p}")
    return problems, len(rows)


def main(path):
    with open(path, encoding="utf-8") as fh:
        html = fh.read()
    text = page_text(html)

    missing = [s for s in SOURCE if s not in text]
    numbers = FORBIDDEN.findall(text)
    no_section = [k for k in SECTIONS if f'<section id="{k}"' not in html]
    no_link = [k for k, label in SECTIONS.items() if f'<a href="#{k}">{label}</a>' not in html]
    phrases = [p for p in FORBIDDEN_PHRASES if p in text.lower()]

    for s in missing:
        print("MISSING:", s)
    if numbers:
        print("FORBIDDEN UNITS:", numbers)
    for k in no_section:
        print("MISSING SECTION:", k)
    for k in no_link:
        print("MISSING NAV LINK:", k)
    for p in phrases:
        print("FORBIDDEN PHRASE:", p)
    label_problems, quotes = check_label_screen(os.path.dirname(path), text)
    for p in label_problems:
        print(p)
    despensa_problems, rows = check_despensa(os.path.dirname(path), html)
    for p in despensa_problems:
        print(p)
    print(
        f"{len(SOURCE) - len(missing)}/{len(SOURCE)} source sentences present; "
        f"forbidden units: {len(numbers)}; sections: {len(SECTIONS) - len(no_section)}/{len(SECTIONS)}; "
        f"nav links: {len(SECTIONS) - len(no_link)}/{len(SECTIONS)}; forbidden phrases: {len(phrases)}; "
        f"label screen: {quotes} pauta quotes checked, {len(label_problems)} problems; "
        f"despensa: {rows} pauta table rows checked, {len(despensa_problems)} problems"
    )
    return 1 if missing or numbers or no_section or no_link or phrases or label_problems or despensa_problems else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1]))

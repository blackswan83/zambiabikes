"""Build a single self-contained orbit.html.

Unlike tools/bundle-trial.py, which carries each ES module as a `data:` URL
and wires them together with an import map, this one *flattens* the module
graph: every module becomes a function in a tiny registry, its imports become
destructuring from that registry and its exports become the returned object.

The result is one ordinary classic script with no import statements, no import
map and no `data:` URLs anywhere — so it runs from `file://`, from a memory
stick, and inside a strict Content-Security-Policy that only allows inline
script. Which is what makes it publishable as well as portable.

Live bindings become a snapshot taken when the module runs. Three.js exports
classes and constants and never reassigns them, so that costs nothing here.

    python3 tools/bundle-orbit.py
"""
import os, re, sys, json

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ENTRY = "js/orbit.js"
ALIAS = {"three": "js/vendor/three.module.min.js"}
CLASSIC = ["js/orbit-core.js", "js/orbit-audio.js"]
CSS = ["css/styles.css", "css/game.css", "css/trial.css", "css/orbit.css"]
PAGE = "orbit.html"

# The four statement shapes the graph actually uses. Order matters: an
# `export {...} from "..."` must be recognised before a plain `export {...}`.
RE_IMPORT_NS = re.compile(r'import\s*\*\s*as\s+([\w$]+)\s+from\s*(["\'])([^"\']+)\2\s*;?')
RE_IMPORT_NAMED = re.compile(r'import\s*\{([^}]*)\}\s*from\s*(["\'])([^"\']+)\2\s*;?')
RE_IMPORT_BARE = re.compile(r'import\s*(["\'])([^"\']+)\1\s*;?')
RE_EXPORT_FROM = re.compile(r'export\s*\{([^}]*)\}\s*from\s*(["\'])([^"\']+)\2\s*;?')
RE_EXPORT = re.compile(r'export\s*\{([^}]*)\}\s*;?')


def in_comment(src, idx):
    """True if idx sits on a line that is part of a block/line comment.

    The vendored addons carry `@three_import` JSDoc lines that look exactly
    like imports; they are documentation, not module graph."""
    start = src.rfind("\n", 0, idx) + 1
    line = src[start:idx].lstrip()
    return line.startswith("*") or line.startswith("//") or line.startswith("/*")


def resolve(spec, importer):
    if spec in ALIAS:
        return ALIAS[spec]
    if spec.startswith("."):
        return os.path.normpath(os.path.join(os.path.dirname(importer), spec))
    raise SystemExit("unresolved bare specifier %r from %s" % (spec, importer))


def read(path):
    with open(os.path.join(ROOT, path), encoding="utf-8") as f:
        return f.read()


modules = {}   # path -> source
order = []     # dependencies before dependents


def load(path):
    if path in modules:
        return
    src = read(path)
    modules[path] = src
    for rx, group in ((RE_IMPORT_NS, 3), (RE_IMPORT_NAMED, 3),
                      (RE_IMPORT_BARE, 2), (RE_EXPORT_FROM, 3)):
        for m in rx.finditer(src):
            if in_comment(src, m.start()):
                continue
            load(resolve(m.group(group), path))
    order.append(path)


def bindings(spec_list):
    """`Matrix3 as e, Vector2 as t` -> [("Matrix3", "e"), ("Vector2", "t")]"""
    out = []
    for part in spec_list.split(","):
        part = part.strip()
        if not part:
            continue
        bits = re.split(r'\s+as\s+', part)
        name = bits[0].strip()
        local = bits[1].strip() if len(bits) > 1 else name
        out.append((name, local))
    return out


def flatten(path, src):
    """Rewrite one module into the body of a registry function."""
    head, tail = [], []

    def take(rx, handler, group):
        nonlocal src
        pieces, last = [], 0
        for m in rx.finditer(src):
            if in_comment(src, m.start()):
                continue
            handler(m)
            pieces.append(src[last:m.start()])
            last = m.end()
        pieces.append(src[last:])
        src = "".join(pieces)

    def on_ns(m):
        head.append("const %s = __M[%s];" % (m.group(1), json.dumps(resolve(m.group(3), path))))

    def on_named(m):
        pairs = ", ".join("%s: %s" % (n, l) for n, l in bindings(m.group(1)))
        head.append("const { %s } = __M[%s];" % (pairs, json.dumps(resolve(m.group(3), path))))

    def on_bare(m):
        head.append("__M[%s];" % json.dumps(resolve(m.group(2), path)))

    def on_export_from(m):
        key = json.dumps(resolve(m.group(3), path))
        pairs = ", ".join("%s: __M[%s].%s" % (l, key, n) for n, l in bindings(m.group(1)))
        tail.append("{ %s }" % pairs)

    def on_export(m):
        pairs = ", ".join("%s: %s" % (l, n) for n, l in bindings(m.group(1)))
        tail.append("{ %s }" % pairs)

    take(RE_IMPORT_NS, on_ns, 3)
    take(RE_IMPORT_NAMED, on_named, 3)
    take(RE_IMPORT_BARE, on_bare, 2)
    take(RE_EXPORT_FROM, on_export_from, 3)
    take(RE_EXPORT, on_export, 1)

    exports = "Object.assign({}, %s)" % ", ".join(tail) if tail else "{}"
    return ('__M[%s] = (function () {\n"use strict";\n%s\n%s\nreturn %s;\n})();\n'
            % (json.dumps(path), "\n".join(head), src, exports))


load(ENTRY)

bundle = ["/* Orbit — flattened module graph. Generated by tools/bundle-orbit.py */",
          "var __M = {};"]
for path in order:
    bundle.append(flatten(path, modules[path]))
script = "\n".join(bundle)

page = read(PAGE)

# strip the site chrome: a standalone build is the game, nothing else
page = re.sub(r'<header class="site-header">.*?</header>', "", page, flags=re.S)
page = re.sub(r'<footer.*?</footer>', "", page, flags=re.S)
page = re.sub(r'<section class="page-hero">.*?</section>', "", page, flags=re.S)
page = re.sub(r'<div class="trial-blurb">.*?</div>\s*</div>', "</div>", page, flags=re.S)
page = re.sub(r'<a class="skip-link".*?</a>', "", page, flags=re.S)
page = re.sub(r'<link rel="stylesheet" href="css/[^"]+">', "", page)
page = re.sub(r'<link rel="icon"[^>]*>', "", page)
page = re.sub(r'<link rel="preconnect"[^>]*>', "", page)
page = re.sub(r'<link href="https://fonts\.googleapis\.com[^"]*"[^>]*>', "", page)
page = re.sub(r'<script src="js/[^"]+"></script>', "", page)
page = re.sub(r'<script type="importmap">.*?</script>', "", page, flags=re.S)
page = re.sub(r'<script type="module" src="js/orbit\.js"></script>', "", page)
page = re.sub(r'<!--.*?-->', "", page, flags=re.S)

STAGE_CSS = (
    "html,body{background:#05070E;margin:0;}\n"
    ".page-game{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:0;}\n"
    "main#main{width:100%;}\n"
    ".section{padding:0;}\n"
    ".container.game-shell{max-width:min(100vw,1600px);width:100%;padding:0;margin:0 auto;}\n"
    ".game-stage{border-radius:0;border:0;box-shadow:none;aspect-ratio:auto;height:100vh;width:100%;}\n"
)

head_extra = (
    "<style>\n" + "\n".join(read(c) for c in CSS) + "\n" + STAGE_CSS + "</style>\n"
    + "<script>\n" + "\n;\n".join(read(c) for c in CLASSIC) + "\n</script>\n"
)

page = page.replace("</head>", head_extra + "</head>")

# The flattened graph goes last, where the module tag it replaces used to be:
# a classic inline script cannot be deferred, and the entry looks the canvas
# up the moment it runs.
page = page.replace("</body>", "<script>\n" + script + "\n</script>\n</body>")

out = os.path.join(ROOT, "dist", "orbit-standalone.html")
os.makedirs(os.path.dirname(out), exist_ok=True)
with open(out, "w", encoding="utf-8") as f:
    f.write(page)

print("modules flattened:", len(modules))
for p in order:
    print("   ", p)
print("wrote", out, os.path.getsize(out) // 1024, "KB")

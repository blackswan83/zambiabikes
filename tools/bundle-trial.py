"""Build a single self-contained trial.html.

Every ES module in the graph becomes a data: URL, and an import map wires the
specifiers together, so the page needs no server, no network and no build step.
Relative specifiers inside a data: URL module cannot resolve, so each one is
rewritten to a bare key the import map covers.
"""
import base64, os, re, json, sys

ROOT = "/home/user/zambiabikes"
ENTRY = "js/trial.js"
ALIAS = {"three": "js/vendor/three.module.min.js"}

# `from "x"`, side-effect `import "x"`, and `export * from "x"`
SPEC = re.compile(r'((?:^|[\s;}])(?:import|export)\b[^\'";]*?from\s*|(?:^|[\s;}])import\s*)([\'"])([^\'"]+)\2')

modules = {}   # path -> source
order = []

def keyword_at(src, start):
    """The regex captures a leading separator, which may be the newline that
    belongs to the *previous* line. Step forward to the import/export keyword
    itself before deciding what line the statement is on."""
    i = start
    while i < len(src) and src[i] in " \t\r\n;}":
        i += 1
    return i

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
        base = os.path.dirname(importer)
        return os.path.normpath(os.path.join(base, spec))
    raise SystemExit("unresolved bare specifier %r from %s" % (spec, importer))

def load(path):
    if path in modules:
        return
    full = os.path.join(ROOT, path)
    with open(full, encoding="utf-8") as f:
        src = f.read()
    modules[path] = src
    for m in SPEC.finditer(src):
        if in_comment(src, keyword_at(src, m.start())):
            continue
        load(resolve(m.group(3), path))
    order.append(path)

load(ENTRY)

keys = {p: "m%d/%s" % (i, os.path.basename(p)) for i, p in enumerate(sorted(modules))}

def rewrite(path, src):
    def sub(m):
        if in_comment(src, keyword_at(src, m.start())):
            return m.group(0)
        target = resolve(m.group(3), path)
        return m.group(1) + m.group(2) + keys[target] + m.group(2)
    return SPEC.sub(sub, src)

def data_url(src):
    b = base64.b64encode(src.encode("utf-8")).decode("ascii")
    return "data:text/javascript;base64," + b

imports = {}
for p in modules:
    imports[keys[p]] = data_url(rewrite(p, modules[p]))
for alias, p in ALIAS.items():
    imports[alias] = imports[keys[p]]

entry_key = keys[ENTRY]

# classic scripts and stylesheets go inline
def read(p):
    with open(os.path.join(ROOT, p), encoding="utf-8") as f:
        return f.read()

classic = [read("js/bikes.js"), read("js/trial-core.js"), read("js/trial-audio.js")]
css = [read("css/styles.css"), read("css/game.css"), read("css/trial.css")]

page = read("trial.html")

# strip the site chrome: a standalone build is the game, nothing else
page = re.sub(r'<header class="site-header">.*?</header>', "", page, flags=re.S)
page = re.sub(r'<footer.*?</footer>', "", page, flags=re.S)
page = re.sub(r'<section class="page-hero">.*?</section>', "", page, flags=re.S)
page = re.sub(r'<div class="trial-blurb">.*?</div>\s*</div>', "</div>", page, flags=re.S)
page = re.sub(r'<a class="skip-link".*?</a>', "", page, flags=re.S)
page = re.sub(r'<link rel="stylesheet" href="css/[^"]+">', "", page)
page = re.sub(r'<link rel="icon"[^>]*>', "", page)
page = re.sub(r'<script src="js/[^"]+"></script>', "", page)
page = re.sub(r'<script type="importmap">.*?</script>', "", page, flags=re.S)
page = re.sub(r'<script type="module" src="js/trial\.js"></script>', "", page)

head_extra = (
  "<style>\n" + "\n".join(css) + "\n"
  "html,body{background:#0E1A12;margin:0;}\n"
  ".page-game{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:0;}\n"
  "main#main{width:100%;}\n"
  ".section{padding:0;}\n"
  ".container.game-shell{max-width:min(100vw,1600px);width:100%;padding:0;margin:0 auto;}\n"
  ".game-stage{border-radius:0;border:0;box-shadow:none;aspect-ratio:auto;height:100vh;width:100%;}\n"
  "</style>\n"
  "<script>\n" + "\n;\n".join(classic) + "\n</script>\n"
  '<script type="importmap">' + json.dumps({"imports": imports}) + "</script>\n"
  # Chrome refuses a data: URL in a top-level script src, but a module may
  # freely import one, so the entry point is an inline module that goes
  # through the import map.
  '<script type="module">import ' + json.dumps(entry_key) + ';</script>\n'
)

page = page.replace("</head>", head_extra + "</head>")

out = os.path.join(ROOT, "dist", "trial-standalone.html")
os.makedirs(os.path.dirname(out), exist_ok=True)
with open(out, "w", encoding="utf-8") as f:
    f.write(page)
print("modules bundled:", len(modules))
for p in sorted(modules):
    print("   ", p)
print("wrote", out, os.path.getsize(out) // 1024, "KB")

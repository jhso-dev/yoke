// The single static bundle (PLAN 9.2), embedded as a TS template string rather than a raw .html
// file so `tsc` (which does not copy .html into dist/) needs no build-step change. Vanilla JS +
// fetch + inline CSS — no framework, no CDN, no build step (NON-GOALS). Served by server.ts at GET /.
export const html = /* html */ `
<meta charset="utf-8">
<title>yoke — governance workbench</title>
<style>
  :root { color-scheme: light dark; --bd: #8884; --mut: #8889; }
  * { box-sizing: border-box; }
  body { font: 14px/1.5 system-ui, sans-serif; margin: 0; }
  header { padding: 12px 20px; border-bottom: 1px solid var(--bd); }
  header h1 { font-size: 18px; margin: 0 0 8px; }
  nav button { font: inherit; padding: 6px 12px; margin-right: 6px; border: 1px solid var(--bd);
    background: transparent; border-radius: 6px; cursor: pointer; color: inherit; }
  nav button.active { background: #4a90d922; border-color: #4a90d9; }
  main { padding: 20px; }
  section { display: none; }
  section.active { display: block; }
  table { border-collapse: collapse; width: 100%; }
  th, td { text-align: left; padding: 6px 10px; border-bottom: 1px solid var(--bd); vertical-align: top; }
  .cite { font-family: ui-monospace, monospace; font-size: 12px; color: var(--mut); }
  .actions { margin-bottom: 12px; }
  .actions button, .pair button, .persona-bar button { font: inherit; padding: 6px 12px; cursor: pointer;
    border: 1px solid var(--bd); background: transparent; border-radius: 6px; color: inherit; }
  .pair { display: grid; grid-template-columns: 1fr auto 1fr; gap: 12px; align-items: start;
    border: 1px solid var(--bd); border-radius: 8px; padding: 12px; margin-bottom: 12px; }
  .pair .vs { align-self: center; color: var(--mut); }
  .side h3 { margin: 0 0 4px; font-size: 14px; }
  .status { font-size: 12px; color: var(--mut); }
  .hint { color: var(--mut); font-size: 13px; margin: 8px 0; }
  .empty { color: var(--mut); }
  input[type=text] { font: inherit; padding: 6px 8px; border: 1px solid var(--bd); border-radius: 6px;
    background: transparent; color: inherit; }
  ul.knowledge { list-style: none; padding: 0; }
  ul.knowledge li { padding: 6px 0; border-bottom: 1px solid var(--bd); }
</style>

<header>
  <h1>yoke — governance workbench</h1>
  <nav>
    <button data-tab="review" class="active">Review queue</button>
    <button data-tab="conflicts">Conflicts</button>
    <button data-tab="ontology">Ontology</button>
    <button data-tab="persona">Persona preview</button>
  </nav>
</header>
<main>
  <!-- Review queue. DESIGN NOTE (Delphi-style independence guard): this queue intentionally does
       NOT display other reviewers' pending approvals or votes. Showing peers' in-flight decisions
       introduces social influence (anchoring / bandwagon) that measurably degrades independent
       review quality — the Delphi method keeps rounds anonymous for exactly this reason. When v3
       adds multi-reviewer consensus, aggregation must happen AFTER each reviewer commits, never
       before. This section is the hook for that. -->
  <section id="review" class="active">
    <div class="actions">
      <button id="btn-verify">Verify selected</button>
      <button id="btn-deprecate">Deprecate selected</button>
    </div>
    <table><thead><tr><th></th><th>type</th><th>summary</th><th>citation</th></tr></thead>
      <tbody id="review-rows"></tbody></table>
  </section>

  <section id="conflicts">
    <div id="conflict-list"></div>
  </section>

  <section id="ontology">
    <table><thead><tr><th>name</th><th>kind</th><th>attributes</th><th>ttl (days)</th></tr></thead>
      <tbody id="ontology-rows"></tbody></table>
  </section>

  <section id="persona">
    <div class="persona-bar">
      <input type="text" id="persona-id" placeholder="person id (e.g. yoke:system)">
      <button id="btn-persona">Preview</button>
    </div>
    <p class="hint">Export the skill from the CLI: <code>yoke persona &lt;id&gt; --out &lt;dir&gt;</code></p>
    <div id="persona-out"></div>
  </section>
</main>

<script>
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
const getJson = (u) => fetch(u).then((r) => r.json());
const post = (u, body) => fetch(u, { method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify(body) }).then((r) => r.json());

// tabs
document.querySelectorAll("nav button").forEach((b) => b.addEventListener("click", () => {
  document.querySelectorAll("nav button").forEach((x) => x.classList.remove("active"));
  document.querySelectorAll("section").forEach((x) => x.classList.remove("active"));
  b.classList.add("active");
  const sec = $("#" + b.dataset.tab);
  sec.classList.add("active");
  load(b.dataset.tab);
}));

async function loadReview() {
  const rows = await getJson("/api/review");
  const tb = $("#review-rows");
  if (!rows.length) { tb.innerHTML = '<tr><td colspan="4" class="empty">no drafts</td></tr>'; return; }
  tb.innerHTML = rows.map((e) =>
    '<tr><td><input type="checkbox" value="' + esc(e.id) + '"></td>' +
    "<td>" + esc(e.type) + "</td><td>" + esc(e.summary) + "</td>" +
    '<td class="cite">' + esc(e.citation) + "</td></tr>").join("");
}
function selectedIds() {
  return [...document.querySelectorAll("#review-rows input:checked")].map((c) => c.value);
}
async function act(action) {
  const ids = selectedIds();
  if (!ids.length) return;
  await post("/api/" + action, { ids });
  loadReview();
}
$("#btn-verify").addEventListener("click", () => act("verify"));
$("#btn-deprecate").addEventListener("click", () => act("deprecate"));

async function loadConflicts() {
  const pairs = await getJson("/api/conflicts");
  const el = $("#conflict-list");
  if (!pairs.length) { el.innerHTML = '<p class="empty">no conflicts</p>'; return; }
  const sideHtml = (s) => s.missing
    ? "<div class=side><em>" + esc(s.id) + " (missing)</em></div>"
    : "<div class=side><h3>" + esc(s.summary || s.id) + "</h3>" +
      '<div class="status">' + esc(s.status) + "</div>" +
      '<div class="cite">' + esc(s.citation) + "</div>" +
      '<button data-id="' + esc(s.id) + '">Deprecate this side</button></div>";
  el.innerHTML = pairs.map((p) =>
    '<div class="pair">' + sideHtml(p.from) + '<div class="vs">conflicts_with</div>' +
    sideHtml(p.to) + "</div>").join("");
  el.querySelectorAll("button[data-id]").forEach((b) => b.addEventListener("click", async () => {
    await post("/api/deprecate", { ids: [b.dataset.id] });
    loadConflicts();
  }));
}

async function loadOntology() {
  const defs = await getJson("/api/ontology");
  $("#ontology-rows").innerHTML = defs.map((d) =>
    "<tr><td>" + esc(d.name) + "</td><td>" + esc(d.kind) + "</td>" +
    "<td>" + esc(Object.keys(d.attrs || {}).join(", ") || "—") + "</td>" +
    "<td>" + (d.ttl_days == null ? "∞" : d.ttl_days) + "</td></tr>").join("");
}

async function loadPersona() {
  const id = $("#persona-id").value.trim();
  const out = $("#persona-out");
  if (!id) { out.innerHTML = ""; return; }
  const { decisions, facts } = await getJson("/api/persona/" + encodeURIComponent(id));
  const list = (items) => items.length
    ? '<ul class="knowledge">' + items.map((e) =>
        "<li>" + esc(e.summary || e.id) + '<br><span class="cite">' + esc(e.citation) +
        "</span></li>").join("") + "</ul>"
    : '<p class="empty">(none)</p>';
  out.innerHTML = "<h3>Decisions (" + decisions.length + ")</h3>" + list(decisions) +
    "<h3>Facts (" + facts.length + ")</h3>" + list(facts);
}
$("#btn-persona").addEventListener("click", loadPersona);

function load(tab) {
  if (tab === "review") return loadReview();
  if (tab === "conflicts") return loadConflicts();
  if (tab === "ontology") return loadOntology();
}
load("review");
</script>
`;

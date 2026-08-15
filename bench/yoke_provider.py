"""yoke as a memory provider for vectorize-io/agent-memory-benchmark.

Drop this file into the harness at `src/memory_bench/memory/yoke.py`, register it, and run with
`--memory yoke`. See bench/README.md for the two-line registration and the setup.

It drives the real `yoke` CLI rather than reimplementing anything: ingest writes each document as a
file and runs `yoke connect raw` (the extractor proposes records, the gate stages them as drafts),
then promotes them; retrieve runs `yoke inject`. Nothing here reaches past the CLI, so a number this
produces is a number the shipped product produces.

Two things about this arm are worth stating plainly, because they change what the score means:

1. **The gate is bypassed.** yoke's central claim is that a human verifies knowledge before an agent
   can read it, and an automated benchmark has no human. `verify --all-drafts` stands in, so what is
   measured is yoke-with-the-gate-open: its extraction and retrieval, not its governance. There is no
   way to measure the governance here, and pretending otherwise would be the dishonest part.
2. **Half the score is the extraction prompt.** Documents arrive as raw conversation, and what a
   query can find depends on what the extractor filed. That prompt (src/connectors/extract.ts) is
   yoke's, so it is fair to attribute — but a low number does not distinguish "yoke retrieves badly"
   from "this prompt extracted badly", and the fix for each is different. Run `--memory vanilla` and
   `--memory bm25` alongside; they are the floor and the keyword baseline.
"""

import json
import os
import re
import shutil
import subprocess
import tempfile
from pathlib import Path

from .base import MemoryProvider
from ..models import Document


# ── the dated-timeline experiment (YOKE_BENCH_TIMELINE=1) ────────────────────────
#
# Module-level and pure so bench/test_timeline.py can assert on them without a store, a model or a
# subprocess. Everything else in this file needs all three.

# Does the question ask about the CURRENT state?
#
# Zep (arXiv 2501.13956) reads a temporally-ordered memory at query time; PersonaMem's own authors
# (arXiv 2504.14225) report models scoring higher when shown a preference's EVOLUTION than when
# handed only the latest fact — and on this corpus the distractors ARE the user's outdated
# preferences, by construction. Both point at the same read-time move: for a question about now,
# show the trajectory in order and date it, so "which of these is current" stops being a guess.
#
# Regex, not a model. LongMemEval measured small models hallucinating temporal cues, and a
# classifier that invents a recency question is a classifier that reorders the arm that measured a
# LOSS from reordering (bench/README.md: chronological order costs `recall_user_shared_facts` three
# questions). Deterministic and narrow is what makes the two arms comparable.
#
# English only: PersonaMem is an English corpus.
RECENCY_RE = re.compile(
    r"\b("
    r"now|right now|currently|current|nowadays|these days|at the moment|"
    r"latest|most recent|recently|lately|still|as of today|up to date|"
    r"today|this week|this month|this year"
    r")\b",
    re.IGNORECASE,
)


def is_recency_question(query: str) -> bool:
    """Whether the question asks what is true NOW rather than what happened."""
    return bool(RECENCY_RE.search(query or ""))


def source_order(item: dict) -> tuple[str, str, int]:
    """(occurred_at, source file, position in it) — the chronology this corpus actually has.

    `occurred_at` alone does not order these records: PersonaMem sessions are ordered but undated, so
    `sourceTime` fell back to one file mtime per document and every record of a document shares it.
    What order exists beyond that lives in the connector's `external_id`
    (`raw:<NNNNN-file>.md#<n>`), so it is the tiebreak. Nothing here invents a time.
    """
    e = item.get("entity", item)
    ext = str(e.get("attributes", {}).get("external_id", ""))
    path, _, n = ext.rpartition("#")
    return (
        e.get("provenance", {}).get("occurred_at") or "",
        path,
        int(n) if n.isdigit() else 0,
    )


def dated_body(body: str, occurred_at: str | None) -> str:
    """`[2025-03-12] …` — the date stated IN the content, which is the one channel the harness leaves
    standing (`modes/rag.py` renders `## Memory 1..N` and drops every field but the text)."""
    day = str(occurred_at or "")[:10]
    return f"[{day}] {body}" if day else body


class YokeMemoryProvider(MemoryProvider):
    name = "yoke"
    description = "yoke — ontology-based knowledge DB with a model extractor (gate opened for eval)."
    kind = "local"
    link = "https://github.com/jhso-dev/yoke"
    # One sqlite file, and `yoke connect raw` shells out per call. Serialised rather than debugged:
    # concurrent writers on one DB is a different experiment than the one being run.
    concurrency = 1

    def __init__(self) -> None:
        self._db: Path | None = None
        self._bin = os.environ.get("YOKE_BIN", "yoke")
        # Ingest only these user_ids (comma-separated). A cost control, and a sound one: retrieval is
        # namespace-scoped, so a document belonging to a user whose queries are not being asked can
        # never be returned — ingesting it changes the bill and not the score.
        #
        # It is needed because `--unit` does not reach documents on every dataset. PersonaMem leaves
        # `isolation_unit` at its `None` default, so the runner's "load only the queried units' docs"
        # branch never fires and all 195 documents arrive here while 19 queries from one user are
        # what will be asked. At a minute or two of local inference per document that is a six-hour
        # ingest to answer four documents' worth of questions.
        raw = os.environ.get("YOKE_BENCH_ONLY_USERS", "")
        self._only_users = {u.strip() for u in raw.split(",") if u.strip()}
        # Per-user cache of the whole verified store (YOKE_BENCH_FULL_STORE). The store is frozen
        # once answering starts, and 42 extra `yoke list` subprocesses would say nothing new.
        self._store_cache: dict[str | None, list[dict]] = {}
        # Per-user cache of the relation graph (YOKE_BENCH_CHAINS): nodes by id + the
        # change-of-position adjacencies, from one `yoke graph --json` per user. Same freeze
        # argument as above.
        self._graph_cache: dict[str | None, tuple[dict, dict, dict, dict]] = {}

    def _graph(self, user_id: str | None) -> tuple[dict, dict, dict, dict]:
        """(nodes by id, newer_of, older_of, conflicts) from `yoke graph`.

        `from -supersedes-> to` is filed newer→older (the connector's rankOf exists to keep it
        that way), so newer_of[to] lists the records that replaced it, older_of[from] what it
        replaced.

        `conflicts_with` is symmetric — it has no direction to ask about — so both ends are
        filed in one adjacency. It is walked for the same reason `supersedes` is: handed a
        reversal pair, the model labels it `conflicts_with` at least as often, so a reversal
        reaches the store under either type and the arm that ignores one sees half of them.
        `relates_to` and `derived_from` stay unwalked: they are not a change of position, and
        widening the walk re-balloons the context toward the full-store arm (measured -6).
        """
        if user_id not in self._graph_cache:
            raw = self._run(["graph", "--json", "--limit", "2000"], ns=user_id)
            g = json.loads(raw) if raw.strip() else {}
            nodes = {n["id"]: n for n in g.get("nodes", []) if n.get("type") != "person"}
            newer_of: dict[str, list[str]] = {}
            older_of: dict[str, list[str]] = {}
            conflicts: dict[str, list[str]] = {}
            for e in g.get("edges", []):
                etype = e.get("type")
                if etype not in ("supersedes", "conflicts_with"):
                    continue
                frm, to = e.get("from"), e.get("to")
                if frm not in nodes or to not in nodes:
                    continue
                if etype == "supersedes":
                    newer_of.setdefault(to, []).append(frm)
                    older_of.setdefault(frm, []).append(to)
                else:
                    conflicts.setdefault(frm, []).append(to)
                    conflicts.setdefault(to, []).append(frm)
            self._graph_cache[user_id] = (nodes, newer_of, older_of, conflicts)
        return self._graph_cache[user_id]

    @staticmethod
    def _with_chain_lines(doc: Document, newer_of, older_of, conflicts, summary) -> Document:
        """State the chain in content — the one channel the ordering experiment left standing."""
        lines = [f"later superseded by: {summary(n)}" for n in newer_of.get(doc.id, [])]
        lines += [f"supersedes (replaces): {summary(o)}" for o in older_of.get(doc.id, [])]
        lines += [f"conflicts with: {summary(c)}" for c in conflicts.get(doc.id, [])]
        if not lines:
            return doc
        return Document(
            id=doc.id,
            content=doc.content + "\n" + "\n".join(lines),
            user_id=doc.user_id,
            timestamp=doc.timestamp,
            context=doc.context,
        )

    # ── lifecycle ────────────────────────────────────────────────────────────

    def initialize(self) -> None:
        if shutil.which(self._bin) is None:
            raise RuntimeError(
                f"'{self._bin}' is not on PATH. Build and link yoke first "
                "(npm install && npm run build && npm link), or set YOKE_BIN."
            )
        # Checked here rather than at the first ingest, because an unconfigured extractor makes
        # `connect raw` exit 1 on every document and the run would otherwise fail one file at a time.
        missing = [k for k in ("YOKE_LLM_URL", "YOKE_LLM_MODEL") if not os.environ.get(k)]
        if missing:
            raise RuntimeError(
                f"yoke's extractor needs {' and '.join(missing)}. "
                "It is the only part of yoke that calls a model; see .env.example."
            )

    def prepare(self, store_dir: Path, unit_ids: set[str] | None = None, reset: bool = True) -> None:
        store_dir.mkdir(parents=True, exist_ok=True)
        self._db = store_dir / "yoke.db"
        if reset:
            for p in (self._db, Path(f"{self._db}-wal"), Path(f"{self._db}-shm")):
                p.unlink(missing_ok=True)
        if not self._db.exists():
            self._run(["init"])
        # Extra ontology types, seeded here so they survive `reset`. This is not a thumb on the
        # scale, it is the mechanism yoke advertises: the extractor builds its type menu from the
        # ontology, so which types exist decides what a model is even offered. Measured on one
        # PersonaMem document: with the seed ontology alone the model returned `[]` — asked to find
        # "durable work knowledge" in a conversation about reading habits, it correctly found none —
        # and adding a single `preference` type took the same document to two records with no code
        # change. A benchmark run without this measures the vocabulary mismatch, not the system.
        for path in filter(None, os.environ.get("YOKE_BENCH_TYPES", "").split(",")):
            self._run(["ontology", "add-type", path.strip()])

    # ── the CLI ──────────────────────────────────────────────────────────────

    def _run(self, args: list[str], ns: str | None = None) -> str:
        if self._db is None:
            raise RuntimeError("prepare() was not called")
        cmd = [self._bin, *args, "--db", str(self._db)]
        if ns:
            cmd += ["--ns", ns]
        done = subprocess.run(cmd, capture_output=True, text=True)
        # yoke reports per-chunk trouble on stderr — a timeout, a retry, an unreachable endpoint —
        # and a successful exit code says none of that. Capturing it and printing it only on failure
        # made a 50-minute ingest look identical whether the model was answering or not, so this
        # forwards it as it happens. Errors, not the whole stream: it is one line per chunk.
        for line in (done.stderr or "").splitlines():
            if line.strip():
                print(f"  yoke[{(ns or 'shared')[:8]}]: {line.strip()}", flush=True)
        if done.returncode != 0:
            raise RuntimeError(f"{' '.join(cmd)} failed ({done.returncode}): {done.stderr.strip()}")
        return done.stdout

    # ── ingest ───────────────────────────────────────────────────────────────

    def ingest(self, documents: list[Document]) -> None:
        """Documents → files → `connect raw` → `verify --all-drafts`, one batch per user.

        Batched by user because a namespace is yoke's isolation unit and `connect raw` reads a
        directory: one call covers every document for that user, and one model call is made per
        FILE. Documents are written one per file rather than concatenated, so a record's quote is
        traceable to the document it came from (`external_id` is `raw:<file>#<n>`).
        """
        by_user: dict[str, list[Document]] = {}
        for doc in documents:
            if self._only_users and (doc.user_id or "") not in self._only_users:
                continue
            by_user.setdefault(doc.user_id or "", []).append(doc)
        if self._only_users:
            skipped = len(documents) - sum(len(v) for v in by_user.values())
            print(f"yoke: ingesting {sum(len(v) for v in by_user.values())} documents, skipping {skipped} outside YOKE_BENCH_ONLY_USERS")

        for user_id, docs in by_user.items():
            with tempfile.TemporaryDirectory(prefix="yoke-bench-") as tmp:
                for i, doc in enumerate(docs):
                    # The id goes in the filename, not the body: the body is what the model reads,
                    # and a synthetic id in it is one more thing it can decide to quote.
                    safe = "".join(c if c.isalnum() or c in "-_" else "_" for c in str(doc.id))
                    (Path(tmp) / f"{i:05d}-{safe[:60]}.md").write_text(
                        doc.content, encoding="utf-8"
                    )
                self._run(["connect", "raw", tmp], ns=user_id or None)
            # The gate, opened. See the module docstring.
            self._run(["verify", "--all-drafts"], ns=user_id or None)

    # ── retrieve ─────────────────────────────────────────────────────────────

    def retrieve(
        self,
        query: str,
        k: int = 10,
        user_id: str | None = None,
        query_timestamp: str | None = None,
    ) -> tuple[list[Document], dict | None]:
        # YOKE_BENCH_K overrides the harness's k. Motive, measured: every experiment that widened the
        # injected context lost accuracy (the whole verified store -6 questions; a doubled hybrid
        # union -5), so the untested direction is the other one — fewer, better records. A knob
        # rather than a new default, because k belongs to whoever is paying for the context.
        k = int(os.environ.get("YOKE_BENCH_K") or k)
        args = ["inject", query, "--limit", str(k), "--json"]
        # yoke answers "what would this have injected then" natively, so a dataset that stamps its
        # queries gets time-correct retrieval instead of hindsight.
        if query_timestamp:
            args += ["--as-of", query_timestamp]
        raw = self._run(args, ns=user_id)
        items = json.loads(raw) if raw.strip() else []

        # PROBE, off by default (YOKE_BENCH_PROBE_ORDER=1). Not a result — a question.
        #
        # `inject` returns its selection in relevance order, and the harness renders the list as
        # "## Memory 1..N" with no dates (modes/rag.py), so list position is the ONLY order signal the
        # answering model gets. On this dataset that reverses histories: for one
        # track_full_preference_evolution query, "Stepped back from readathons" arrived as Memory 1 and
        # "decided to try the readathon" as Memory 3, and the question is which came first.
        #
        # Sorting here rather than in yoke because the order this corpus has is not a time. All 34
        # records of a user share one `occurred_at` — PersonaMem sessions are ordered but undated, so
        # `sourceTime` fell back to one mtime for every file. What order exists lives in the
        # connector's `external_id` (`raw:<NNNNN-file>.md#<n>`, zero-padded per file, restarting per
        # file), and core parsing that shape would be a connector detail leaking inward. If this probe
        # moves the score, the fix belongs in yoke as something a connector can state.
        if os.environ.get("YOKE_BENCH_PROBE_ORDER") == "1":
            items = sorted(items, key=source_order)

        # EXPERIMENT, off by default (YOKE_BENCH_TIMELINE=1): for a question about NOW, hand over the
        # hits as a dated timeline — oldest first, each record prefixed with its date — instead of in
        # relevance order. Every other question keeps the current rendering, and that restriction is
        # the whole design: the unconditional sort is `YOKE_BENCH_PROBE_ORDER` above and it LOST
        # (bench/README.md), because the questions that want the single most relevant record pay for
        # the questions that want an order. Sorting only where order is what was asked for is the
        # version of that idea that has not been measured.
        #
        # Same record count, same tokens, same selection — only the arrangement and a date per record
        # differ. See `is_recency_question` for why the classifier is a regex.
        timeline = (
            os.environ.get("YOKE_BENCH_TIMELINE") == "1"
            and is_recency_question(query)
        )
        if timeline:
            items = sorted(items, key=source_order)
            # Printed because the classifier is the experiment's one uncontrolled part: the corpus's
            # question texts decide its hit rate, and a run that fires on nothing looks exactly like
            # a run where the timeline did not help.
            print(f"  yoke[timeline]: recency question, {len(items)} records dated oldest-first: {query[:70]!r}", flush=True)

        def _doc(entity: dict, citation=None) -> Document:
            attrs = entity.get("attributes", {})
            # Every declared attribute, in the order the ontology declares them, minus the id this
            # capture path adds for bookkeeping. Guessing one field would drop the rationale of a
            # decision, which is the half that says WHY.
            #
            # `sources` STAYS. It was excluded here as bookkeeping, which was wrong twice over: it
            # carries the verbatim span the record was extracted from, and the shipped MCP tool
            # hands an agent `JSON.stringify(entity.attributes)` — every attribute, this one
            # included (src/front/mcp/index.ts). Dropping it measured less than yoke delivers.
            # Measured on 19 queries: yoke's context covered 0.28 of the answer's content words
            # against bm25's 0.73, and the quote is most of that difference.
            body = "\n".join(
                str(v)
                for key, v in attrs.items()
                if key != "external_id" and v not in (None, "")
            )
            occurred_at = entity.get("provenance", {}).get("occurred_at")
            if timeline:
                body = dated_body(body, occurred_at)
            return Document(
                id=entity.get("id", ""),
                content=body,
                user_id=user_id,
                timestamp=occurred_at,
                context=citation,
            )

        docs = [_doc(item.get("entity", item), item.get("citation")) for item in items]

        # EXPERIMENT, off by default (YOKE_BENCH_FULL_STORE=1): append the rest of the verified
        # store after the query hits. The 32k transcript distills to ~1.5–3k tokens of records —
        # small enough to hand over whole, still under bm25's 5,120-token context. Motive, measured:
        # every suggest_new_ideas gold hinges on a standing preference the store HOLDS but the
        # retrieval query never names (the query is the user's last statement, modes/rag.py), so
        # 0/4 is a selection loss, not an extraction loss. Query hits stay at the head — the head
        # is the measured-winning config, and the answering model attends to it most.
        if os.environ.get("YOKE_BENCH_FULL_STORE") == "1":
            if user_id not in self._store_cache:
                raw_all = self._run(["list", "--status", "verified", "--json"], ns=user_id)
                page = json.loads(raw_all) if raw_all.strip() else {}
                self._store_cache[user_id] = [
                    e for e in page.get("items", []) if e.get("type") != "person"
                ]
            have = {d.id for d in docs}
            docs += [
                _doc(e) for e in self._store_cache[user_id] if e.get("id") not in have
            ]

        # EXPERIMENT, off by default (YOKE_BENCH_CHAINS=1): expand each hit with its supersedes
        # chain. track_full_preference_evolution asks "trace how this changed", and the chain IS
        # that answer — but the unscoped inject path never walks relations, so a `yoke relate`d
        # edge is invisible to it. Two rules learned the hard way this session:
        #   - order is stated in CONTENT ("later superseded by: …"), never by reordering the list
        #     (measured net loss), and hits keep their head positions;
        #   - only the change-of-position types are walked (`supersedes`, `conflicts_with`).
        #     relates_to would re-balloon context toward the full-store arm, which measured -6.
        # This is provider-side on purpose: it is the cheap measurement docs/RESEARCH.md asks for
        # before graph expansion is built into inject itself.
        if os.environ.get("YOKE_BENCH_CHAINS") == "1":
            nodes, newer_of, older_of, conflicts = self._graph(user_id)

            def _summary(eid: str) -> str:
                a = (nodes.get(eid) or {}).get("attributes", {})
                text = a.get("conclusion") or a.get("statement") or a.get("title") or ""
                return str(text)[:120]

            def _chain(eid: str) -> list[str]:
                seen, todo = set(), [eid]
                while todo:
                    cur = todo.pop()
                    if cur in seen:
                        continue
                    seen.add(cur)
                    todo += (
                        newer_of.get(cur, [])
                        + older_of.get(cur, [])
                        + conflicts.get(cur, [])
                    )
                return sorted(seen)

            # BUDGET-NEUTRAL, and that is the whole design. Appending chain members grows the
            # context, and every arm that grew the context lost: the whole store -6, a doubled
            # hybrid union -5. So a chain member takes the place of the LOWEST-ranked hit instead
            # of being added — same record count, same token bill, different composition. If the
            # trajectory questions need the earlier state more than they need hit #10, this wins;
            # if they do not, it loses cleanly and says so.
            budget = len(docs)
            expanded: list[Document] = []
            present = {d.id for d in docs}
            for d in docs:
                expanded.append(
                    self._with_chain_lines(d, newer_of, older_of, conflicts, _summary)
                )
                for m in _chain(d.id):
                    if m == d.id or m in present or m not in nodes:
                        continue
                    present.add(m)
                    expanded.append(
                        self._with_chain_lines(
                            _doc(nodes[m]), newer_of, older_of, conflicts, _summary
                        )
                    )
            # Head order is preserved (the head is what the answering model attends to most), so the
            # cut falls on the tail, where the least relevant hits were.
            docs = expanded[:budget]

        return docs, {"count": len(docs)}

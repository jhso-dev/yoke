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
import shutil
import subprocess
import tempfile
from pathlib import Path

from .base import MemoryProvider
from ..models import Document


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
            def _source_order(item: dict) -> tuple[str, str, int]:
                e = item.get("entity", item)
                ext = str(e.get("attributes", {}).get("external_id", ""))
                path, _, n = ext.rpartition("#")
                return (
                    e.get("provenance", {}).get("occurred_at") or "",
                    path,
                    int(n) if n.isdigit() else 0,
                )

            items = sorted(items, key=_source_order)

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
            return Document(
                id=entity.get("id", ""),
                content=body,
                user_id=user_id,
                timestamp=entity.get("provenance", {}).get("occurred_at"),
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

        return docs, {"count": len(docs)}

"""The runnable check behind the dated-timeline arm (YOKE_BENCH_TIMELINE=1).

    python3 bench/test_timeline.py

Asserts, no framework — three pure functions in yoke_provider.py, none of which need a store, a model
or a subprocess. What it does NOT check is the whole retrieve() path: that one shells out to `yoke`
and belongs to a real run.

The provider is written to live inside the harness (`src/memory_bench/memory/yoke.py`), so importing
it means satisfying two relative imports the harness would provide. They are stubbed rather than
mocked out of the provider, which also makes this a syntax check of the file as it will be dropped in.
"""

import importlib.util
import sys
import types
from pathlib import Path


def _load_provider():
    """yoke_provider.py, loaded as if it were memory_bench.memory.yoke."""
    for name in ("h", "h.memory"):
        pkg = types.ModuleType(name)
        pkg.__path__ = []  # type: ignore[attr-defined]
        sys.modules[name] = pkg
    base = types.ModuleType("h.memory.base")
    base.MemoryProvider = object  # type: ignore[attr-defined]
    models = types.ModuleType("h.models")

    class Document:  # the harness's dataclass, reduced to what the provider passes it
        def __init__(self, id="", content="", user_id=None, timestamp=None, context=None):
            self.id, self.content = id, content
            self.user_id, self.timestamp, self.context = user_id, timestamp, context

    models.Document = Document  # type: ignore[attr-defined]
    sys.modules["h.memory.base"] = base
    sys.modules["h.models"] = models

    path = Path(__file__).with_name("yoke_provider.py")
    spec = importlib.util.spec_from_file_location("h.memory.yoke", path)
    module = importlib.util.module_from_spec(spec)
    sys.modules["h.memory.yoke"] = module
    spec.loader.exec_module(module)
    return module


def test_classifier(m):
    # Asks what is true NOW — the questions the timeline is for.
    for q in (
        "What does she prefer now?",
        "What is the user currently reading?",
        "What's their latest position on readathons?",
        "Does he still go to the book club?",
        "What has she been into recently?",
        "Which format does she use these days?",
        "What is the most recent change to her routine?",
        "At the moment, what does he listen to?",
    ):
        assert m.is_recency_question(q), q

    # Asks what HAPPENED, or asks for something new. Reordering these is the measured loss
    # (bench/README.md: chronological order costs `recall_user_shared_facts` three questions), so a
    # classifier that fires here is worse than one that fires nowhere.
    for q in (
        "Why did she stop reading graphic novels?",
        "What did he say about the readathon when it started?",
        "Suggest a podcast she might enjoy.",
        "Who recommended the book club to her?",
        "How many books did she finish last summer?",
    ):
        assert not m.is_recency_question(q), q


def test_ordering(m):
    # occurred_at first; within one timestamp, the file and the position inside it. This corpus is
    # mostly the second case — one mtime per document, so the ordering rests on external_id.
    items = [
        {"entity": {"id": "c", "attributes": {"external_id": "raw:00002-b.md#0"},
                    "provenance": {"occurred_at": "2026-01-01T00:00:00Z"}}},
        {"entity": {"id": "b", "attributes": {"external_id": "raw:00001-a.md#7"},
                    "provenance": {"occurred_at": "2026-01-01T00:00:00Z"}}},
        {"entity": {"id": "a", "attributes": {"external_id": "raw:00001-a.md#2"},
                    "provenance": {"occurred_at": "2026-01-01T00:00:00Z"}}},
        {"entity": {"id": "old", "attributes": {"external_id": "raw:00009-z.md#0"},
                    "provenance": {"occurred_at": "2025-06-01T00:00:00Z"}}},
    ]
    order = [i["entity"]["id"] for i in sorted(items, key=m.source_order)]
    assert order == ["old", "a", "b", "c"], order

    # A record with no external_id sorts first within its timestamp rather than raising.
    assert m.source_order({"entity": {"provenance": {}}}) == ("", "", 0)


def test_date_prefix(m):
    assert m.dated_body("read on the commute", "2025-03-12T09:00:00Z") == (
        "[2025-03-12] read on the commute"
    )
    # No date recorded → no invented one, and no empty brackets either.
    assert m.dated_body("read on the commute", None) == "read on the commute"
    assert m.dated_body("read on the commute", "") == "read on the commute"


if __name__ == "__main__":
    provider = _load_provider()
    test_classifier(provider)
    test_ordering(provider)
    test_date_prefix(provider)
    print("bench/test_timeline.py: ok")

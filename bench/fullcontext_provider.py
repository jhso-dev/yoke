"""Full-context provider for the benchmark harness — the long-context baseline arm.

Drop into the harness at `src/memory_bench/memory/fullcontext.py` and register it beside yoke.

This is the arm a memory system has to beat to be worth existing: no retrieval, no extraction, just
the user's entire conversation history handed to the model. The published PersonaMem numbers are
this arm (the paper scores frontier models on the raw 32k context), and a vendor reporting
"48% without our memory, 76% with it" is reporting a lift over this, not over an empty prompt.

`--memory none` is a different thing and not a substitute: it returns no context at all, and the
runner marks an empty context wrong before scoring, so it measures the floor rather than a baseline.

Documents are returned newest-last in the order the dataset supplies them, which is the order they
were said in — a conversation reordered by relevance is a different input than the one the paper
scored.
"""
import os

from .base import MemoryProvider
from ..models import Document


class FullContextMemoryProvider(MemoryProvider):
    name = "fullcontext"
    description = "No memory system; the whole per-user history in the prompt (long-context baseline)."
    kind = "local"
    concurrency = int(os.environ.get("SDE_CONCURRENCY", "4"))

    def __init__(self) -> None:
        self._by_user: dict[str, list[Document]] = {}

    def ingest(self, documents: list[Document]) -> None:
        for doc in documents:
            self._by_user.setdefault(doc.user_id or "", []).append(doc)

    def retrieve(self, query: str, k: int = 10, user_id: str | None = None,
                 query_timestamp: str | None = None) -> tuple[list[Document], dict | None]:
        # k is ignored on purpose: "top k of everything" is retrieval, and this arm is the one that
        # does none. The whole history is the point.
        docs = self._by_user.get(user_id or "", [])
        return list(docs), {"count": len(docs)}

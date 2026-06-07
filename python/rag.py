"""
Local RAG store: chunk text → embed → store in FAISS → query by similarity.

Embeddings: sentence-transformers all-MiniLM-L6-v2 (22 MB, runs on CPU, fast).
Index: FAISS FlatL2 (exact search — fine for <10k chunks).
"""

import sys
import textwrap
from typing import Optional

CHUNK_TOKENS   = 500    # approximate target chunk size in tokens
OVERLAP_TOKENS = 100    # overlap between adjacent chunks
# rough conversion: 1 token ≈ 4 chars in Russian/English
CHUNK_CHARS   = CHUNK_TOKENS * 4
OVERLAP_CHARS = OVERLAP_TOKENS * 4

EMBED_MODEL = "all-MiniLM-L6-v2"   # ~22 MB download on first run


class RAGStore:
    def __init__(self):
        self._texts: list[str] = []
        self._index = None          # FAISS index, built lazily
        self._embedder = None       # sentence-transformers model, loaded lazily

    # ── Public ─────────────────────────────────────────────────────────────

    def add_document(self, text: str, source: str = ""):
        """Chunk `text`, embed, and add to the FAISS index."""
        chunks = self._chunk(text, source)
        if not chunks:
            return

        embedder = self._get_embedder()
        import numpy as np
        import faiss  # type: ignore

        vectors = embedder.encode(chunks, show_progress_bar=False, normalize_embeddings=True)
        vectors = np.array(vectors, dtype=np.float32)

        if self._index is None:
            dim = vectors.shape[1]
            self._index = faiss.IndexFlatIP(dim)  # inner product on normalized = cosine sim

        self._index.add(vectors)        # type: ignore[union-attr]
        self._texts.extend(chunks)

    def query(self, question: str, k: int = 4) -> list[str]:
        """Return the top-k most relevant chunks for `question`."""
        if self._index is None or not self._texts:
            return []

        import numpy as np

        embedder = self._get_embedder()
        vec = embedder.encode([question], normalize_embeddings=True)
        vec = np.array(vec, dtype=np.float32)

        distances, indices = self._index.search(vec, min(k, len(self._texts)))  # type: ignore
        results = []
        for idx in indices[0]:
            if 0 <= idx < len(self._texts):
                results.append(self._texts[idx])
        return results

    # ── Helpers ─────────────────────────────────────────────────────────────

    def _chunk(self, text: str, source: str) -> list[str]:
        """Sliding-window chunker with overlap."""
        text = text.strip()
        if not text:
            return []

        chunks = []
        start = 0
        while start < len(text):
            end = start + CHUNK_CHARS
            chunk = text[start:end].strip()
            if chunk:
                prefix = f"[{source}] " if source else ""
                chunks.append(prefix + chunk)
            start += CHUNK_CHARS - OVERLAP_CHARS   # advance by (chunk - overlap)

        return chunks

    def _get_embedder(self):
        if self._embedder is None:
            try:
                from sentence_transformers import SentenceTransformer  # type: ignore
                self._embedder = SentenceTransformer(EMBED_MODEL)
            except ImportError:
                print("[rag] sentence-transformers not installed", file=sys.stderr)
                raise
        return self._embedder

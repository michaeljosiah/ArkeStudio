"""A bounded read-only tool over fictional notes shipped with the audition."""
from pathlib import Path
import re

LIBRARY = Path(__file__).parent / "reference-library"
NOTES = ("skyharbour-storm-protocol", "skyharbour-arrivals", "floating-gardens")


def search_reference_library(query: str, directory: Path = LIBRARY):
    if not isinstance(query, str) or not query.strip() or len(query) > 250:
        raise ValueError("Search query must contain 1–250 characters")
    terms = set(re.findall(r"[\w-]+", query.casefold()))
    matches = []
    root = directory.resolve()
    for note in NOTES:
        path = (root / f"{note}.md").resolve()
        if path.parent != root or path.stat().st_size > 16_384:
            raise ValueError("Sample reference note is outside the tool's fixed library")
        text = path.read_text(encoding="utf-8")
        score = len(terms.intersection(re.findall(r"[\w-]+", text.casefold())))
        if score:
            matches.append({"id": note, "title": text.splitlines()[0].lstrip("# "), "text": text, "score": score})
    matches.sort(key=lambda item: (-item["score"], item["id"]))
    return {"query": query, "matches": matches[:3], "source": "fictional audition reference library"}

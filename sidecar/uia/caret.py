"""Caret, current line and selection of a focused element through UIA.

TextPattern2.GetCaretRange works in Chrome, Edge, VS Code, Word and most
modern apps; plain TextPattern selections cover the rest (an empty
selection is the caret).
"""

from __future__ import annotations

MAX_LINE = 300
MAX_SELECTION = 500


def _first_rect(text_range) -> dict | None:
    try:
        rects = text_range.GetBoundingRectangles()
    except Exception:
        return None
    for r in rects:
        if r.right - r.left >= 0 and r.bottom - r.top > 0:
            return {"x": r.left, "y": r.top, "width": max(1, r.right - r.left), "height": r.bottom - r.top}
    return None


def _caret_rect(auto, raw_range) -> dict | None:
    rng = auto.TextRange(raw_range)
    rect = _first_rect(rng)
    if rect is None:
        # An empty range often has no rectangle: measure the next character instead
        wide = auto.TextRange(raw_range.Clone())
        wide.ExpandToEnclosingUnit(auto.TextUnit.Character, waitTime=0)
        rect = _first_rect(wide)
        if rect is not None:
            rect["width"] = 1
    return rect


def _line(auto, raw_range) -> str | None:
    try:
        line = auto.TextRange(raw_range.Clone())
        line.ExpandToEnclosingUnit(auto.TextUnit.Line, waitTime=0)
        text = line.GetText(MAX_LINE)
    except Exception:
        return None
    return text.strip("\r\n") if text else None


def caret_info(auto, control, with_text: bool) -> tuple[dict | None, str | None, str | None]:
    """(caret rect, current line, selected text) in physical screen pixels."""
    caret = line = selection = None
    raw_caret = None
    tp2 = control.GetPattern(auto.PatternId.TextPattern2)
    if tp2 is not None:
        try:
            _active, raw_caret = tp2.pattern.GetCaretRange()
        except Exception:
            raw_caret = None
    tp = control.GetPattern(auto.PatternId.TextPattern) if tp2 is None else tp2
    selections = []
    if tp is not None:
        try:
            array = tp.pattern.GetSelection()
            selections = [array.GetElement(i) for i in range(array.Length)] if array else []
        except Exception:
            selections = []
    if raw_caret is None and selections:
        raw_caret = selections[0]
    if raw_caret is not None:
        caret = _caret_rect(auto, raw_caret)
        if with_text:
            line = _line(auto, raw_caret)
    if with_text and selections:
        try:
            text = auto.TextRange(selections[0]).GetText(MAX_SELECTION)
            selection = text.strip() or None
        except Exception:
            selection = None
    return caret, line, selection

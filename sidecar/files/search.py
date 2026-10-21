"""Finding files for Lumi's find_files (roadmap 16.3).

Two sources: the Windows Search index (SystemIndex, the one the Start menu
and Explorer search use), queried with SQL through OLE DB (ADODB via
comtypes), and the recent files (the shortcuts Windows keeps in
%APPDATA%\\Microsoft\\Windows\\Recent). Recent ones come first: "the PDF I
opened yesterday" is usually one of them.

Only paths, names, sizes and dates come out, never contents; the log gets
counts and times, never names. COM runs on one thread of its own.
"""

from __future__ import annotations

import logging
import os
import re
import sys
import time
from concurrent.futures import Future, ThreadPoolExecutor
from dataclasses import asdict, dataclass
from datetime import UTC, datetime
from pathlib import Path

log = logging.getLogger("lumi.files")

KINDS = ("any", "document", "pdf", "picture", "video", "music", "folder", "archive")

# System.Kind values (Windows Search), or the extension for pdf
KIND_SQL = {
    "document": "System.Kind = 'document'",
    "picture": "System.Kind = 'picture'",
    "video": "System.Kind = 'video'",
    "music": "System.Kind = 'music'",
    "folder": "System.Kind = 'folder'",
    "pdf": "System.FileExtension = '.pdf'",
    "archive": "System.FileExtension IN ('.zip', '.rar', '.7z', '.tar', '.gz')",
}

# The same kinds by extension, for the recent files (they don't come from the index)
KIND_EXT = {
    "document": {".doc", ".docx", ".odt", ".rtf", ".txt", ".md", ".pdf", ".xls", ".xlsx", ".ods", ".csv", ".ppt", ".pptx", ".odp"},
    "pdf": {".pdf"},
    "picture": {".jpg", ".jpeg", ".png", ".gif", ".bmp", ".webp", ".heic", ".tif", ".tiff", ".svg", ".raw"},
    "video": {".mp4", ".mkv", ".avi", ".mov", ".wmv", ".webm", ".m4v"},
    "music": {".mp3", ".flac", ".wav", ".ogg", ".m4a", ".aac", ".wma", ".opus"},
    "archive": {".zip", ".rar", ".7z", ".tar", ".gz"},
}

# Places nobody means when looking for "their" files
NOISE = ("\\AppData\\", "\\node_modules\\", "\\.git\\", "\\$Recycle.Bin\\", "\\site-packages\\", "\\.venv\\", "C:\\Windows\\", "C:\\Program Files")

MAX_WORDS = 6
RECENT_SCAN = 300
# Rows asked to the index before the noise folders are dropped
INDEX_ROWS = 60


@dataclass
class FileHit:
    path: str
    name: str
    folder: bool
    modified: str
    size: int | None = None
    recent: bool = False


def query_words(query: str | None) -> list[str]:
    """Words of a file name to look for; LIKE wildcards and quotes are dropped."""
    if not query:
        return []
    words = [w for w in re.split(r"[\s_\-.,;:()\[\]{}'\"%]+", query) if len(w) >= 2]
    return words[:MAX_WORDS]


def sql_date(iso: str) -> str | None:
    """An ISO instant as Windows Search's UTC literal, or None when unreadable."""
    try:
        moment = datetime.fromisoformat(iso.replace("Z", "+00:00"))
    except ValueError:
        return None
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=UTC)
    return moment.astimezone(UTC).strftime("%Y-%m-%d %H:%M:%S")


def build_sql(query: str | None, kind: str | None, date_from: str | None, date_to: str | None, limit: int, contains: bool = True) -> str:
    """The SystemIndex query: every word in the file name, the kind, the period; newest first.

    `contains`: words as prefixes through the full-text index (~70 ms);
    else LIKE, which also finds a word inside another (~350 ms). Noise
    folders are dropped afterwards: NOT LIKE on the path took 4 s."""
    conds = ["SCOPE='file:'"]
    words = [w.replace("'", "''") for w in query_words(query)]
    if words and contains:
        conds.append("CONTAINS(System.FileName, '" + " AND ".join(f'"{w}*"' for w in words) + "')")
    else:
        conds.extend(f"System.FileName LIKE '%{w}%'" for w in words)
    if kind and kind in KIND_SQL:
        conds.append(KIND_SQL[kind])
    start = sql_date(date_from) if date_from else None
    end = sql_date(date_to) if date_to else None
    if start:
        conds.append(f"System.DateModified >= '{start}'")
    if end:
        conds.append(f"System.DateModified < '{end}'")
    columns = "System.ItemPathDisplay, System.FileName, System.DateModified, System.Size, System.Kind"
    return f"SELECT TOP {max(1, int(limit))} {columns} FROM SystemIndex WHERE {' AND '.join(conds)} ORDER BY System.DateModified DESC"


def iso(value) -> str:
    """A date from ADO (naive UTC) or the file system (a timestamp) as ISO UTC."""
    if isinstance(value, datetime):
        moment = value if value.tzinfo else value.replace(tzinfo=UTC)
        return moment.astimezone(UTC).isoformat().replace("+00:00", "Z")
    if isinstance(value, (int, float)):
        return datetime.fromtimestamp(value, UTC).isoformat().replace("+00:00", "Z")
    return ""


def hit_from_row(row: tuple) -> FileHit | None:
    """(path, name, modified, size, kind) from the index."""
    path, name, modified, size, kinds = (list(row) + [None] * 5)[:5]
    if not path:
        return None
    kinds = kinds or ()
    folder = "folder" in (kinds if isinstance(kinds, (list, tuple)) else (kinds,))
    return FileHit(path=str(path), name=str(name or Path(str(path)).name), folder=folder, modified=iso(modified), size=int(size) if isinstance(size, (int, float)) and not folder else None)


def name_matches(name: str, words: list[str]) -> bool:
    low = name.lower()
    return all(w.lower() in low for w in words)


def kind_matches(path: str, folder: bool, kind: str | None) -> bool:
    if not kind or kind == "any":
        return True
    if kind == "folder":
        return folder
    return not folder and Path(path).suffix.lower() in KIND_EXT.get(kind, set())


def noise(path: str) -> bool:
    low = path.lower()
    return any(n.lower() in low for n in NOISE)


def merge(recent: list[FileHit], indexed: list[FileHit], limit: int) -> list[FileHit]:
    """Recent files first, then the index; one line per path, none from noise folders."""
    out: list[FileHit] = []
    seen: set[str] = set()
    for hit in [*recent, *indexed]:
        key = hit.path.lower()
        if key in seen or noise(hit.path):
            continue
        seen.add(key)
        out.append(hit)
        if len(out) >= limit:
            break
    return out


class FileSearch:
    """Searches on a single COM thread; `submit` returns a future."""

    def __init__(self) -> None:
        self._pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="files", initializer=self._init_com)
        self._shell = None

    @staticmethod
    def _init_com() -> None:
        if sys.platform == "win32":
            import comtypes

            comtypes.CoInitialize()

    def submit(self, query: str | None, kind: str | None, date_from: str | None, date_to: str | None, limit: int) -> Future:
        return self._pool.submit(self.search, query, kind, date_from, date_to, limit)

    def search(self, query: str | None, kind: str | None, date_from: str | None, date_to: str | None, limit: int) -> list[dict]:
        started = time.monotonic()
        limit = max(1, min(int(limit), 25))
        recent = self._recent(query, kind, date_from, date_to, limit)
        try:
            # Noise folders are dropped after the query: ask for more
            indexed = self._indexed(query, kind, date_from, date_to, INDEX_ROWS, True)
            if not indexed and query_words(query):
                indexed = self._indexed(query, kind, date_from, date_to, INDEX_ROWS, False)
        except Exception as err:  # the Windows Search service may be off
            log.warning("Windows Search query failed: %s", type(err).__name__)
            indexed = []
        hits = merge(recent, indexed, limit)
        log.info("File search: %d recent, %d indexed, %d returned in %d ms", len(recent), len(indexed), len(hits), (time.monotonic() - started) * 1000)
        return [asdict(h) for h in hits]

    def _indexed(self, query, kind, date_from, date_to, limit, contains) -> list[FileHit]:
        if sys.platform != "win32":
            return []
        import comtypes.client

        conn = comtypes.client.CreateObject("ADODB.Connection", dynamic=True)
        conn.Open("Provider=Search.CollatorDSO;Extended Properties='Application=Windows';")
        try:
            result = conn.Execute(build_sql(query, kind, date_from, date_to, limit, contains))
            rs = result[0] if isinstance(result, tuple) else result
            hits: list[FileHit] = []
            while not rs.EOF:
                fields = rs.Fields
                hit = hit_from_row(tuple(fields.Item(i).Value for i in range(5)))
                if hit and not noise(hit.path):
                    hits.append(hit)
                rs.MoveNext()
            return hits
        finally:
            conn.Close()

    def _recent(self, query, kind, date_from, date_to, limit) -> list[FileHit]:
        """Shortcuts in the Recent folder whose name has every word; their targets, if they still exist."""
        words = query_words(query)
        if sys.platform != "win32" or (not words and (not kind or kind == "any")):
            return []
        folder = Path(os.environ.get("APPDATA", "")) / "Microsoft" / "Windows" / "Recent"
        try:
            links = sorted(folder.glob("*.lnk"), key=lambda p: p.stat().st_mtime, reverse=True)[:RECENT_SCAN]
        except OSError:
            return []
        start = sql_date(date_from) if date_from else None
        end = sql_date(date_to) if date_to else None
        hits: list[FileHit] = []
        for link in links:
            if words and not name_matches(link.stem, words):
                continue
            target = self._target(link)
            if not target or not os.path.exists(target):
                continue
            is_dir = os.path.isdir(target)
            if not kind_matches(target, is_dir, kind):
                continue
            stat = os.stat(target)
            modified = iso(stat.st_mtime)
            stamp = modified[:19].replace("T", " ")
            if (start and stamp < start) or (end and stamp >= end):
                continue
            hits.append(FileHit(path=target, name=Path(target).name, folder=is_dir, modified=modified, size=None if is_dir else stat.st_size, recent=True))
            if len(hits) >= limit:
                break
        return hits

    def _target(self, link: Path) -> str:
        try:
            if self._shell is None:
                import comtypes.client

                self._shell = comtypes.client.CreateObject("WScript.Shell", dynamic=True)
            return str(self._shell.CreateShortcut(str(link)).TargetPath or "")
        except Exception:
            return ""

    def close(self) -> None:
        self._pool.shutdown(wait=False, cancel_futures=True)

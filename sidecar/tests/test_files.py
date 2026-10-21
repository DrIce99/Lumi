"""find_files (roadmap 16.3): the Windows Search query, rows to hits, recent files first; the endpoint with a fake search."""

from concurrent.futures import Future
from datetime import datetime

import pytest
from fastapi.testclient import TestClient

import server
from files.search import FileHit, build_sql, hit_from_row, kind_matches, merge, query_words, sql_date


def test_words_drop_wildcards_quotes_and_crumbs():
    assert query_words("bolletta luce_luglio") == ["bolletta", "luce", "luglio"]
    assert query_words("100% 'o' \"x\"") == ["100"]
    assert query_words(None) == []
    assert len(query_words("a1 b2 c3 d4 e5 f6 g7 h8")) == 6


def test_sql_uses_the_full_text_index_then_like_with_kind_and_utc_period():
    sql = build_sql("bolletta luce", "pdf", "2026-10-19T22:00:00.000Z", "2026-10-20T22:00:00.000Z", 60)
    assert sql.startswith("SELECT TOP 60 System.ItemPathDisplay, System.FileName, System.DateModified, System.Size, System.Kind FROM SystemIndex WHERE SCOPE='file:'")
    assert "CONTAINS(System.FileName, '\"bolletta*\" AND \"luce*\"')" in sql
    assert "System.FileExtension = '.pdf'" in sql
    assert "System.DateModified >= '2026-10-19 22:00:00'" in sql and "System.DateModified < '2026-10-20 22:00:00'" in sql
    assert sql.endswith("ORDER BY System.DateModified DESC")
    # Noise folders are filtered afterwards: NOT LIKE on the path took seconds
    assert "NOT" not in sql
    like = build_sql("dell'auto", None, None, None, 10, contains=False)
    assert "System.FileName LIKE '%dell%'" in like and "System.FileName LIKE '%auto%'" in like
    assert "CONTAINS" not in like
    # An unknown kind and unreadable dates add nothing
    assert build_sql(None, "rocket", "ieri", None, 5) == "SELECT TOP 5 System.ItemPathDisplay, System.FileName, System.DateModified, System.Size, System.Kind FROM SystemIndex WHERE SCOPE='file:' ORDER BY System.DateModified DESC"


def test_dates_are_written_in_utc():
    assert sql_date("2026-10-20T10:30:00+02:00") == "2026-10-20 08:30:00"
    assert sql_date("2026-10-20T10:30:00") == "2026-10-20 10:30:00"
    assert sql_date("domani") is None


def test_rows_become_hits():
    hit = hit_from_row(("C:\\Users\\me\\Documenti\\bolletta.pdf", "bolletta.pdf", datetime(2026, 10, 12, 8, 0), 12345, ("document",)))
    assert hit == FileHit(path="C:\\Users\\me\\Documenti\\bolletta.pdf", name="bolletta.pdf", folder=False, modified="2026-10-12T08:00:00Z", size=12345)
    folder = hit_from_row(("C:\\Users\\me\\Download", "Download", None, 0, ("folder",)))
    assert folder.folder and folder.size is None and folder.modified == ""
    assert hit_from_row((None, "x", None, None, None)) is None


def test_kinds_of_recent_files_by_extension():
    assert kind_matches("C:\\a\\b.PDF", False, "pdf")
    assert kind_matches("C:\\a\\b.pdf", False, "document")
    assert not kind_matches("C:\\a\\b.pdf", False, "picture")
    assert kind_matches("C:\\a\\foto", True, "folder") and not kind_matches("C:\\a\\foto", True, "picture")
    assert kind_matches("C:\\a\\x.zzz", False, "any") and kind_matches("C:\\a\\x.zzz", False, None)


def test_recent_first_one_line_per_path_no_noise():
    recent = [FileHit("C:\\Users\\me\\Documenti\\Bolletta.pdf", "Bolletta.pdf", False, "2026-10-12T08:00:00Z", recent=True)]
    indexed = [
        FileHit("c:\\users\\me\\documenti\\bolletta.pdf", "bolletta.pdf", False, "2026-10-12T08:00:00Z"),
        FileHit("C:\\Users\\me\\AppData\\Local\\cache\\bolletta.pdf", "bolletta.pdf", False, "2026-10-13T08:00:00Z"),
        FileHit("C:\\Users\\me\\Download\\bolletta-2.pdf", "bolletta-2.pdf", False, "2026-09-01T08:00:00Z"),
        FileHit("C:\\Users\\me\\proj\\node_modules\\x\\bolletta.pdf", "bolletta.pdf", False, "2026-09-01T08:00:00Z"),
    ]
    out = merge(recent, indexed, 8)
    assert [h.path for h in out] == ["C:\\Users\\me\\Documenti\\Bolletta.pdf", "C:\\Users\\me\\Download\\bolletta-2.pdf"]
    assert out[0].recent
    assert len(merge(recent, indexed, 1)) == 1


class FakeSearch:
    def __init__(self):
        self.calls = []

    def submit(self, *args):
        self.calls.append(args)
        future = Future()
        future.set_result([{"path": "C:\\Users\\me\\a.pdf", "name": "a.pdf", "folder": False, "modified": "2026-10-12T08:00:00Z", "size": 1, "recent": False}])
        return future

    def close(self):
        pass


@pytest.fixture()
def client(monkeypatch):
    monkeypatch.setattr(server, "TOKEN", "")
    fake = FakeSearch()
    monkeypatch.setattr(server, "_files", fake)
    with TestClient(server.app) as c:
        yield c, fake


def test_endpoint_reads_from_and_checks_the_kind(client):
    c, fake = client
    body = c.post("/files/search", json={"query": "bolletta", "kind": "pdf", "from": "2026-10-01T00:00:00Z", "limit": 5}).json()
    assert body["results"][0]["name"] == "a.pdf"
    assert fake.calls == [("bolletta", "pdf", "2026-10-01T00:00:00Z", None, 5)]
    assert c.post("/files/search", json={"kind": "exe"}).status_code == 422

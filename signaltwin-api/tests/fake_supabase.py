"""A small in-memory stand-in for the parts of the Supabase client that SupabaseStorage uses.

It follows the schema in supabase/migrations: primary keys, the unique sha256, cascade delete of job events, and the
sequence function. It cannot prove behaviour of a real project (row level security, limits), only that the adapter
speaks the client's calls correctly and satisfies the same contract as the local storage.
"""

from __future__ import annotations

import copy
from typing import Any

PRIMARY = {"videos": "id", "jobs": "id", "results": "cache_key", "junction": "id", "job_events": "id"}


class _Res:
    def __init__(self, data: Any) -> None:
        self.data = data


class _Query:
    def __init__(self, db: FakeSupabase, table: str) -> None:
        self.db = db
        self.table = table
        self.op = "select"
        self.cols: list[str] | None = None
        self.payload: Any = None
        self.filters: list[tuple[str, str, Any]] = []
        self._order: str | None = None
        self._limit: int | None = None

    def select(self, cols: str = "*") -> _Query:
        self.op, self.cols = "select", None if cols == "*" else [c.strip() for c in cols.split(",")]
        return self

    def insert(self, row: dict[str, Any]) -> _Query:
        self.op, self.payload = "insert", row
        return self

    def upsert(self, row: dict[str, Any]) -> _Query:
        self.op, self.payload = "upsert", row
        return self

    def update(self, row: dict[str, Any]) -> _Query:
        self.op, self.payload = "update", row
        return self

    def delete(self) -> _Query:
        self.op = "delete"
        return self

    def eq(self, col: str, v: Any) -> _Query:
        self.filters.append((col, "eq", v))
        return self

    def gt(self, col: str, v: Any) -> _Query:
        self.filters.append((col, "gt", v))
        return self

    def lt(self, col: str, v: Any) -> _Query:
        self.filters.append((col, "lt", v))
        return self

    def in_(self, col: str, vs: list[Any]) -> _Query:
        self.filters.append((col, "in", vs))
        return self

    def order(self, col: str) -> _Query:
        self._order = col
        return self

    def limit(self, n: int) -> _Query:
        self._limit = n
        return self

    def _match(self, row: dict[str, Any]) -> bool:
        for col, kind, v in self.filters:
            x = row.get(col)
            if kind == "eq" and x != v:
                return False
            if kind == "gt" and not (x is not None and x > v):
                return False
            if kind == "lt" and not (x is not None and x < v):
                return False
            if kind == "in" and x not in v:
                return False
        return True

    def execute(self) -> _Res:
        rows = self.db.tables.setdefault(self.table, [])
        pk = PRIMARY[self.table]
        if self.op == "insert":
            row = copy.deepcopy(self.payload)
            if any(r[pk] == row.get(pk) for r in rows if pk in row):
                raise RuntimeError(f"duplicate key value violates unique constraint on {self.table}.{pk}")
            self.db.check_unique(self.table, row)
            rows.append(row)
            return _Res([copy.deepcopy(row)])
        if self.op == "upsert":
            row = copy.deepcopy(self.payload)
            for i, r in enumerate(rows):
                if r[pk] == row[pk]:
                    rows[i] = {**r, **row}
                    return _Res([copy.deepcopy(rows[i])])
            self.db.check_unique(self.table, row)
            rows.append(row)
            return _Res([copy.deepcopy(row)])
        hit = [r for r in rows if self._match(r)]
        if self.op == "update":
            for r in hit:
                r.update(copy.deepcopy(self.payload))
            return _Res(copy.deepcopy(hit))
        if self.op == "delete":
            for r in hit:
                rows.remove(r)
                if self.table == "jobs":  # on delete cascade
                    self.db.tables["job_events"] = [e for e in self.db.tables.get("job_events", []) if e["job_id"] != r["id"]]
            return _Res(copy.deepcopy(hit))
        if self._order:
            hit.sort(key=lambda r: r[self._order])  # type: ignore[index]
        if self._limit is not None:
            hit = hit[: self._limit]
        if self.cols:
            hit = [{c: r[c] for c in self.cols} for r in hit]
        return _Res(copy.deepcopy(hit))


class _Rpc:
    def __init__(self, db: FakeSupabase, name: str, params: dict[str, Any]) -> None:
        self.db, self.name, self.params = db, name, params

    def execute(self) -> _Res:
        assert self.name == "append_job_event"
        events = self.db.tables.setdefault("job_events", [])
        jid = self.params["p_job_id"]
        if not any(j["id"] == jid for j in self.db.tables.get("jobs", [])):
            raise RuntimeError("insert or update on table job_events violates foreign key constraint")
        seq = max([e["seq"] for e in events if e["job_id"] == jid], default=0) + 1
        events.append({"id": len(events) + 1, "job_id": jid, "seq": seq, "type": self.params["p_type"], "data": copy.deepcopy(self.params["p_data"])})
        return _Res(seq)


class _Bucket:
    def __init__(self, store: dict[str, bytes]) -> None:
        self.store = store

    def upload(self, name: str, f: Any, opts: dict[str, str] | None = None) -> None:
        data = f if isinstance(f, (bytes, bytearray)) else f.read()
        if name in self.store and (opts or {}).get("upsert") != "true":
            raise RuntimeError("The resource already exists")
        self.store[name] = bytes(data)

    def download(self, name: str) -> bytes:
        if name not in self.store:
            raise RuntimeError("Object not found")
        return self.store[name]

    def remove(self, names: list[str]) -> None:
        for n in names:
            self.store.pop(n, None)


class _Storage:
    def __init__(self, buckets: dict[str, dict[str, bytes]]) -> None:
        self.buckets = buckets

    def from_(self, bucket: str) -> _Bucket:
        return _Bucket(self.buckets.setdefault(bucket, {}))


class FakeSupabase:
    def __init__(self) -> None:
        self.tables: dict[str, list[dict[str, Any]]] = {}
        self.buckets: dict[str, dict[str, bytes]] = {}
        self.storage = _Storage(self.buckets)

    def check_unique(self, table: str, row: dict[str, Any]) -> None:
        if table == "videos" and any(r["sha256"] == row["sha256"] for r in self.tables.get("videos", [])):
            raise RuntimeError("duplicate key value violates unique constraint videos_sha256_key")

    def table(self, name: str) -> _Query:
        return _Query(self, name)

    def rpc(self, name: str, params: dict[str, Any]) -> _Rpc:
        return _Rpc(self, name, params)

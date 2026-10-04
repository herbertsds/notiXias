"""Regras de negócio da fila. Funções recebem o `db` (pymongo) e são independentes do FastAPI."""
import os
from datetime import datetime, timedelta, timezone

from pymongo import ASCENDING, DESCENDING, ReturnDocument
from pymongo.errors import DuplicateKeyError

# Um repost de um tweet já visto só volta como entrada nova se a última visualização foi há mais que isto.
REVISIT_AFTER = timedelta(minutes=int(os.environ.get("REVISIT_AFTER_MINUTES", "120")))
DEFAULT_FEED = {"url": "https://x.com/home", "tab_index": 1}
VISIBLE = {"removed": False, "covered": False}


def now() -> datetime:
    return datetime.now(timezone.utc)


def ensure_indexes(db) -> None:
    db.entries.create_index([("seq", ASCENDING)], unique=True)
    # Único: uma mesma aparição nunca pertence a duas entradas (protege contra corrida).
    db.entries.create_index([("appearance_keys", ASCENDING)], unique=True)
    db.entries.create_index([("tweet_id", ASCENDING), ("read_at", ASCENDING)])
    db.entries.create_index([("removed", ASCENDING), ("covered", ASCENDING), ("seq", ASCENDING)])
    db.entries.create_index([("covered_by", ASCENDING)])
    db.views.create_index([("entry_seq", ASCENDING)], unique=True)
    db.views.create_index([("tweet_id", ASCENDING), ("viewed_at", DESCENDING)])
    db.batches.create_index([("created_at", ASCENDING)], expireAfterSeconds=7 * 24 * 3600)
    db.skeletons.create_index([("created_at", ASCENDING)], expireAfterSeconds=90 * 24 * 3600)


def appearance_key(tweet_id: str, reposter: str | None) -> str:
    return f"{tweet_id}|{(reposter or '').lower()}"


def next_seq(db) -> int:
    doc = db.counters.find_one_and_update(
        {"_id": "entries_seq"},
        {"$inc": {"value": 1}},
        upsert=True,
        return_document=ReturnDocument.AFTER,
    )
    return doc["value"]


# ---------- apresentação ----------
def entry_summary(doc: dict) -> dict:
    return {
        "seq": doc["seq"],
        "tweet_id": doc["tweet_id"],
        "url": doc["url"],
        "author": doc["author"],
        "reposters": doc["reposters"],
        "kind": doc["kind"],
        "captured_at": doc["captured_at"],
        "read_at": doc["read_at"],
        "covered": doc["covered"],
        "covered_by": doc["covered_by"],
        "gap_before": doc["gap_before"],
    }


def entry_detail(db, doc: dict) -> dict:
    out = entry_summary(doc)
    # "Visto em": vale qualquer parte da conversa (o próprio tweet ou os que ele agrupa).
    ids = [doc["tweet_id"], *doc.get("members", [])]
    views = list(db.views.find({"tweet_id": {"$in": ids}}).sort("viewed_at", DESCENDING))
    out["views"] = [{"viewed_at": v["viewed_at"], "entry_seq": v["entry_seq"]} for v in views]
    out["view_count"] = len(views)
    out["covered_count"] = db.entries.count_documents({"covered_by": doc["seq"], "removed": False})
    out["members"] = doc.get("members", [])
    # Quem repostou este tweet em QUALQUER entrada (lida ou não): a etiqueta aparece também nas já vistas.
    seen: set[str] = set()
    all_reposters: list[str] = []
    for d in db.entries.find({"tweet_id": doc["tweet_id"], "removed": False}, {"reposters": 1}).sort("seq", ASCENDING):
        for r in d["reposters"]:
            if r.lower() not in seen:
                seen.add(r.lower())
                all_reposters.append(r)
    out["all_reposters"] = all_reposters
    return out


# ---------- fila ----------
def _new_doc(it, seq: int) -> dict:
    return {
        "seq": seq,
        "tweet_id": it.tweet_id,
        "url": f"https://x.com/{it.author}/status/{it.tweet_id}",
        "author": it.author,
        "author_lc": it.author.lower(),
        "reposters": [it.reposter] if it.reposter else [],
        "appearance_keys": [appearance_key(it.tweet_id, it.reposter)],
        "kind": "repost" if it.reposter else ("post" if it.kind == "repost" else it.kind),
        "captured_at": now(),
        "read_at": None,
        "covered": False,
        "covered_by": None,
        "gap_before": False,
        "removed": False,
    }


def _place(db, it, cutoff, stats):
    """Regra de UMA aparição. Devolve (entrada afetada | None, o que aconteceu)."""
    key = appearance_key(it.tweet_id, it.reposter)
    known = db.entries.find_one({"appearance_keys": key})
    if known:
        stats["skipped"] += 1
        return known, "known"

    existing = db.entries.find_one({"tweet_id": it.tweet_id, "read_at": None, "removed": False}, sort=[("seq", ASCENDING)])
    if existing:
        upd = {"$addToSet": {"appearance_keys": key}}
        if it.reposter:
            upd["$addToSet"]["reposters"] = it.reposter
        try:
            db.entries.update_one({"_id": existing["_id"]}, upd)
        except DuplicateKeyError:
            stats["skipped"] += 1
            return existing, "known"
        stats["merged"] += 1
        return existing, "merged"

    # Tweet visto há pouco: o repost não volta à fila; fica registrado na entrada mais recente do tweet
    # (a etiqueta "repostado por" a mostra, inclusive nas já vistas).
    last_view = db.views.find_one({"tweet_id": it.tweet_id}, sort=[("viewed_at", DESCENDING)])
    if last_view and last_view["viewed_at"] > cutoff:
        recent = db.entries.find_one({"tweet_id": it.tweet_id, "removed": False}, sort=[("seq", DESCENDING)])
        if recent:
            upd = {"$addToSet": {"appearance_keys": key}}
            if it.reposter:
                upd["$addToSet"]["reposters"] = it.reposter
            try:
                db.entries.update_one({"_id": recent["_id"]}, upd)
            except DuplicateKeyError:
                stats["skipped"] += 1
                return recent, "known"
            stats["absorbed"] += 1
            return recent, "absorbed"

    doc = _new_doc(it, next_seq(db))
    try:
        db.entries.insert_one(doc)
    except DuplicateKeyError:
        stats["skipped"] += 1
        return None, "known"
    stats["created"] += 1
    if stats["first_new_seq"] is None:
        stats["first_new_seq"] = doc["seq"]
    return doc, "created"


def _place_cluster(db, group, cutoff, stats):
    """Conversa vista no feed (raiz, respostas...), em ordem de baixo para cima: group[0] é a ÚLTIMA resposta.
    Ela é a referência (um único registro de leitura). Os demais membros não lidos ficam cobertos de forma
    provisória: a página da referência confirma o que realmente mostra (`settle_cover`)."""
    ref_doc, _ = _place(db, group[0], cutoff, stats)
    if ref_doc is None:
        return
    members = group[1:]
    for m in members:
        key = appearance_key(m.tweet_id, m.reposter)
        ex = db.entries.find_one({"appearance_keys": key})
        if ex:
            if ex["seq"] != ref_doc["seq"] and ex["read_at"] is None and not ex["covered"] and not ex["removed"]:
                r = db.entries.update_one(
                    {"_id": ex["_id"], "covered": False, "read_at": None},
                    {"$set": {"covered": True, "covered_by": ref_doc["seq"], "cover_tentative": True}},
                )
                stats["linked"] += r.modified_count
            continue
        doc = _new_doc(m, next_seq(db))  # seq maior que o da referência: se for solto depois, vem após ela
        doc.update(covered=True, covered_by=ref_doc["seq"], cover_tentative=True)
        try:
            db.entries.insert_one(doc)
            stats["linked"] += 1
        except DuplicateKeyError:
            stats["skipped"] += 1
    ids = [m.tweet_id for m in members]
    if ids:
        db.entries.update_one({"_id": ref_doc["_id"]}, {"$addToSet": {"members": {"$each": ids}}})


def append_items(db, items: list, anchor_found: bool, batch_id: str | None, revisit_after: timedelta | None = None) -> dict:
    """`items` em ordem do feed (mais novo primeiro). Processa do mais antigo ao mais novo."""
    revisit_after = REVISIT_AFTER if revisit_after is None else revisit_after
    if batch_id:
        prev = db.batches.find_one({"_id": batch_id})
        if prev:
            return prev["result"]

    had_entries = db.entries.find_one({}, {"_id": 1}) is not None
    stats = {"created": 0, "merged": 0, "absorbed": 0, "skipped": 0, "linked": 0, "first_new_seq": None}
    cutoff = now() - revisit_after

    rev = list(reversed(items))
    i = 0
    while i < len(rev):
        it = rev[i]
        if it.cluster is None:
            _place(db, it, cutoff, stats)
            i += 1
            continue
        j = i
        while j < len(rev) and rev[j].cluster == it.cluster:
            j += 1
        _place_cluster(db, rev[i:j], cutoff, stats)
        i = j

    gap = bool(not anchor_found and had_entries and stats["created"] > 0)
    if gap:
        db.entries.update_one({"seq": stats["first_new_seq"]}, {"$set": {"gap_before": True}})

    result = {
        "created": stats["created"],
        "merged": stats["merged"],
        "absorbed": stats["absorbed"],
        "linked": stats["linked"],
        "skipped": stats["skipped"],
        "first_new_seq": stats["first_new_seq"],
        "gap": gap,
    }
    if batch_id:
        try:
            db.batches.insert_one({"_id": batch_id, "result": result, "created_at": now()})
        except DuplicateKeyError:
            pass
    return result


def settle_cover(db, covered_by: int, present_ids: list[str]) -> dict:
    """Confirma a cobertura provisória do que a página da referência realmente mostra; solta o resto."""
    present = set(present_ids)
    confirmed = released = 0
    for e in db.entries.find({"covered_by": covered_by, "cover_tentative": True, "removed": False}):
        if e["tweet_id"] in present:
            db.entries.update_one({"_id": e["_id"]}, {"$set": {"cover_tentative": False}})
            confirmed += 1
        else:
            db.entries.update_one({"_id": e["_id"]}, {"$set": {"covered": False, "covered_by": None, "cover_tentative": False}})
            released += 1
    return {"confirmed": confirmed, "released": released}


def anchor_keys(db, depth: int) -> dict:
    docs = list(db.entries.find({}, {"appearance_keys": 1, "seq": 1}).sort("seq", DESCENDING).limit(depth))
    keys: list[str] = []
    for d in docs:
        keys.extend(d["appearance_keys"])
    return {"keys": keys, "last_seq": docs[0]["seq"] if docs else None}


def list_queue(db, after: int | None, before: int | None, limit: int, include_covered: bool) -> dict:
    flt: dict = {"removed": False}
    if not include_covered:
        flt["covered"] = False
    if before is not None:
        flt["seq"] = {"$lt": before}
        sort = [("seq", DESCENDING)]
    else:
        flt["seq"] = {"$gt": after or 0}
        sort = [("seq", ASCENDING)]
    docs = list(db.entries.find(flt).sort(sort).limit(limit + 1))
    has_more = len(docs) > limit
    return {"items": [entry_summary(d) for d in docs[:limit]], "has_more": has_more}


# ---------- estado ----------
def _state_doc(db) -> dict:
    return db.state.find_one_and_update(
        {"_id": "main"},
        {"$setOnInsert": {"cursor_seq": None, "feed": DEFAULT_FEED, "version": 0, "updated_at": now()}},
        upsert=True,
        return_document=ReturnDocument.AFTER,
    )


def state_view(db) -> dict:
    st = _state_doc(db)
    cursor = st["cursor_seq"]
    total = db.entries.count_documents(VISIBLE)
    if cursor is not None:
        unread_after = db.entries.count_documents({**VISIBLE, "seq": {"$gt": cursor}})
        position = db.entries.count_documents({**VISIBLE, "seq": {"$lte": cursor}})
        cur_doc = db.entries.find_one({"seq": cursor, "removed": False})
    else:
        unread_after, position, cur_doc = total, 0, None
    nxt = db.entries.find_one({**VISIBLE, "seq": {"$gt": cursor or 0}}, {"seq": 1}, sort=[("seq", ASCENDING)])
    return {
        "cursor_seq": cursor,
        "current": entry_detail(db, cur_doc) if cur_doc else None,
        "next_seq": nxt["seq"] if nxt else None,
        "position": position,
        "unread_after": unread_after,
        "total_visible": total,
        "feed": st["feed"],
        "version": st["version"],
        "updated_at": st["updated_at"],
    }


class VersionConflict(Exception):
    pass


class InvalidCursor(Exception):
    pass


def update_state(db, fields: set[str], cursor_seq, feed, expected_version) -> dict:
    st = _state_doc(db)
    if expected_version is not None and st["version"] != expected_version:
        raise VersionConflict()
    sets: dict = {"updated_at": now()}
    if "cursor_seq" in fields:
        if cursor_seq is not None and not db.entries.find_one({"seq": cursor_seq, "removed": False}, {"_id": 1}):
            raise InvalidCursor()
        sets["cursor_seq"] = cursor_seq
    if "feed" in fields and feed is not None:
        sets["feed"] = feed
    res = db.state.update_one({"_id": "main", "version": st["version"]}, {"$set": sets, "$inc": {"version": 1}})
    if res.matched_count == 0:
        raise VersionConflict()
    return state_view(db)


# ---------- visualizações ----------
class UnknownEntry(Exception):
    pass


def record_views(db, seqs: list[int], viewed_at: datetime | None) -> dict:
    wanted = set(seqs)
    found = {d["seq"] for d in db.entries.find({"seq": {"$in": list(wanted)}, "removed": False}, {"seq": 1})}
    if found != wanted:
        raise UnknownEntry()
    # Entradas cobertas pelas que estão sendo vistas contam como vistas no mesmo momento.
    for d in db.entries.find({"covered_by": {"$in": list(wanted)}, "removed": False, "cover_tentative": {"$ne": True}}, {"seq": 1}):
        wanted.add(d["seq"])

    at = viewed_at or now()
    recorded = already = 0
    for seq in sorted(wanted):
        doc = db.entries.find_one_and_update(
            {"seq": seq, "read_at": None},
            {"$set": {"read_at": at}},
            return_document=ReturnDocument.AFTER,
        )
        if doc is None:
            already += 1
            continue
        try:
            db.views.insert_one({"entry_seq": seq, "tweet_id": doc["tweet_id"], "viewed_at": at})
            recorded += 1
        except DuplicateKeyError:
            already += 1
    return {"recorded": recorded, "already": already, "seqs": sorted(wanted)}


# ---------- cobertura ----------
def cover_by_tweet_ids(db, covered_by: int, tweet_ids: list[str], ancestor_ids: list[str] | None = None) -> dict:
    """Marca como cobertas (parte do mesmo registro de leitura) entradas NÃO LIDAS.
    - `tweet_ids`: só as do mesmo autor da entrada de destino (pedaços de thread);
    - `ancestor_ids`: posts acima na conversa (resposta -> original), de qualquer autor, ainda não cobertos."""
    dest = db.entries.find_one({"seq": covered_by, "removed": False})
    if not dest:
        raise UnknownEntry()
    n = 0
    if tweet_ids:
        n += db.entries.update_many(
            {
                "tweet_id": {"$in": tweet_ids},
                "author_lc": dest["author_lc"],
                "read_at": None,
                "removed": False,
                "seq": {"$ne": covered_by},
            },
            {"$set": {"covered": True, "covered_by": covered_by, "cover_tentative": False}},
        ).modified_count
    if ancestor_ids:
        n += db.entries.update_many(
            {
                "tweet_id": {"$in": ancestor_ids},
                "read_at": None,
                "removed": False,
                "seq": {"$ne": covered_by},
                # ainda livres, ou já cobertas de forma provisória por esta mesma referência (confirma)
                "$or": [{"covered": False}, {"covered_by": covered_by, "cover_tentative": True}],
            },
            {"$set": {"covered": True, "covered_by": covered_by, "cover_tentative": False}},
        ).modified_count
    return {"covered": n}


def uncover(db, covered_by: int) -> dict:
    res = db.entries.update_many({"covered_by": covered_by}, {"$set": {"covered": False, "covered_by": None, "cover_tentative": False}})
    return {"reopened": res.modified_count}


def patch_entry(db, seq: int, patch) -> dict | None:
    doc = db.entries.find_one({"seq": seq, "removed": False})
    if not doc:
        return None
    sets: dict = {}
    fields = patch.model_fields_set
    if "covered" in fields and patch.covered is not None:
        if patch.covered:
            if patch.covered_by == seq or not db.entries.find_one({"seq": patch.covered_by, "removed": False}, {"_id": 1}):
                raise UnknownEntry()
            sets.update(covered=True, covered_by=patch.covered_by, cover_tentative=False)
        else:
            sets.update(covered=False, covered_by=None, cover_tentative=False)
    if "removed" in fields and patch.removed is not None:
        sets["removed"] = patch.removed
    if sets:
        db.entries.update_one({"seq": seq}, {"$set": sets})
    return db.entries.find_one({"seq": seq})

"""Regras de negócio da fila. Funções recebem o `db` (pymongo) e são independentes do FastAPI."""
import os
import random
from datetime import datetime, timedelta, timezone

from pymongo import ASCENDING, DESCENDING, ReturnDocument, UpdateOne
from pymongo.errors import DuplicateKeyError

from .robot_policy import crossed_thresholds, tier_for

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
    db.runs.create_index([("at", DESCENDING)], expireAfterSeconds=90 * 24 * 3600)
    db.entries.create_index([("ord", ASCENDING)])
    migrate(db)


def migrate(db) -> None:
    """Entradas antigas: a posição de leitura (`ord`) começa igual ao `seq`; `sort_id` = o próprio tweet."""
    db.entries.update_many({"ord": {"$exists": False}}, [{"$set": {"ord": {"$toDouble": "$seq"}}}])
    db.entries.update_many({"sort_id": {"$exists": False}}, [{"$set": {"sort_id": "$tweet_id"}}])


# ---------- posição de leitura (`ord`) ----------
# `seq` é a identidade da entrada (nunca muda). `ord` é a posição na fila: novas entradas entram entre as não
# lidas pelo horário do tweet (o ID do X cresce com o tempo), sem renumerar ninguém.
NEG = -1e18


def ord_of(db, seq: int | None) -> float:
    if seq is None:
        return NEG
    d = db.entries.find_one({"seq": seq}, {"ord": 1})
    return float(d["ord"]) if d and "ord" in d else float(seq)


def _renumber(db) -> None:
    for i, d in enumerate(db.entries.find({}, {"_id": 1}).sort("ord", ASCENDING), start=1):
        db.entries.update_one({"_id": d["_id"]}, {"$set": {"ord": float(i)}})


def _between(db, lower: float) -> float:
    """Uma posição logo depois de `lower` (e antes da próxima entrada)."""
    nxt = db.entries.find_one({"ord": {"$gt": lower}}, {"ord": 1}, sort=[("ord", ASCENDING)])
    if not nxt:
        return lower + 1.0
    upper = float(nxt["ord"])
    if upper - lower < 1e-6:
        _renumber(db)
        return _between(db, ord_of_value(db, lower))
    return (lower + upper) / 2.0


def ord_of_value(db, old_ord: float) -> float:
    # depois de renumerar, o valor antigo deixou de existir; usa a entrada mais próxima abaixo dele
    d = db.entries.find_one({"ord": {"$lte": old_ord}}, {"ord": 1}, sort=[("ord", DESCENDING)])
    return float(d["ord"]) if d else 0.0


def _insert_ord(db, sort_id: str) -> float:
    """Posição de uma entrada NOVA: entre as NÃO LIDAS depois do cursor, pelo horário do tweet (`sort_id`):
    antes da primeira não lida mais nova que ela; se não houver, no fim."""
    st = db.state.find_one({"_id": "main"}) or {}
    cur_ord = ord_of(db, st.get("cursor_seq"))
    new = int(sort_id)
    cands = db.entries.find(
        {"read_at": None, "removed": False, "covered": False, "ord": {"$gt": cur_ord}},
        {"ord": 1, "sort_id": 1, "tweet_id": 1},
    ).sort("ord", ASCENDING)
    for c in cands:
        if int(c.get("sort_id", c["tweet_id"])) > new:
            upper = float(c["ord"])
            prev = db.entries.find_one({"ord": {"$lt": upper}}, {"ord": 1}, sort=[("ord", DESCENDING)])
            lower = float(prev["ord"]) if prev else upper - 2.0
            if upper - lower < 1e-6:
                _renumber(db)
                return _insert_ord(db, sort_id)
            return (lower + upper) / 2.0
    top = db.entries.find_one({}, {"ord": 1}, sort=[("ord", DESCENDING)])
    return float(top["ord"]) + 1.0 if top else 1.0


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
        # tweet cuja página deve ser aberta: a resposta mais recente da conversa (ou o próprio tweet)
        "open_id": doc.get("open_id", doc["tweet_id"]),
        "url": doc["url"],
        "author": doc["author"],
        "reposters": doc["reposters"],
        "reposter_names": doc.get("reposter_names", {}),
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
    names: dict[str, str] = {}
    for d in db.entries.find({"tweet_id": doc["tweet_id"], "removed": False}, {"reposter_names": 1}):
        for k, v in (d.get("reposter_names") or {}).items():
            names.setdefault(k, v)
    out["all_reposter_names"] = names
    return out


# ---------- fila ----------
def _new_doc(it, seq: int, sort_id: str | None = None, ord_value: float | None = None) -> dict:
    doc = {
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
        "sort_id": sort_id or it.tweet_id,
        "ord": float(seq) if ord_value is None else ord_value,
    }
    if it.reposter and getattr(it, "reposter_name", None):
        doc["reposter_names"] = {it.reposter.lower(): it.reposter_name}
    return doc


def _name_update(it) -> dict:
    if it.reposter and getattr(it, "reposter_name", None):
        return {f"reposter_names.{it.reposter.lower()}": it.reposter_name}
    return {}


def _place(db, it, cutoff, stats, sort_id=None):
    """Regra de UMA aparição. Devolve (entrada afetada | None, o que aconteceu)."""
    key = appearance_key(it.tweet_id, it.reposter)
    known = db.entries.find_one({"appearance_keys": key})
    if known:
        names = _name_update(it)
        if names:
            db.entries.update_one({"_id": known["_id"]}, {"$set": names})
        stats["skipped"] += 1
        return known, "known"

    existing = db.entries.find_one({"tweet_id": it.tweet_id, "read_at": None, "removed": False}, sort=[("seq", ASCENDING)])
    if existing:
        upd = {"$addToSet": {"appearance_keys": key}}
        if it.reposter:
            upd["$addToSet"]["reposters"] = it.reposter
        if _name_update(it):
            upd["$set"] = _name_update(it)
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
            if _name_update(it):
                upd["$set"] = _name_update(it)
            try:
                db.entries.update_one({"_id": recent["_id"]}, upd)
            except DuplicateKeyError:
                stats["skipped"] += 1
                return recent, "known"
            stats["absorbed"] += 1
            return recent, "absorbed"

    sid = sort_id or it.tweet_id
    doc = _new_doc(it, next_seq(db), sid, _insert_ord(db, sid))
    try:
        db.entries.insert_one(doc)
    except DuplicateKeyError:
        stats["skipped"] += 1
        return None, "known"
    stats["created"] += 1
    if stats["first_new_seq"] is None:
        stats["first_new_seq"] = doc["seq"]
    return doc, "created"


def _learn_accounts(db, items) -> None:
    """Aprende quais contas você segue pelo próprio Seguindo: quem tem post próprio no feed, quem reposta e quem
    responde dentro de uma conversa. A RAIZ de uma conversa não conta (pode ser conta que você não segue)."""
    handles: set[str] = set()
    seen_cluster: set[int] = set()
    for it in items:  # ordem do feed
        if it.cluster is None:
            handles.add((it.reposter or it.author).lower())
        elif it.cluster in seen_cluster:
            handles.add(it.author.lower())
        else:
            seen_cluster.add(it.cluster)
    ops = [UpdateOne({"_id": h}, {"$setOnInsert": {"first_seen": now()}}, upsert=True) for h in handles]
    if ops:
        db.accounts.bulk_write(ops, ordered=False)


def _followed(db, handles) -> set[str]:
    """Contas seguidas entre `handles`. Com a lista completa já lida (página de Seguindo), vale só ela (mais as
    mudanças ao vivo); antes disso, soma o que foi aprendido pelo próprio feed."""
    hs = list({h.lower() for h in handles})
    explicit = {d["_id"] for d in db.following.find({"_id": {"$in": hs}})}
    meta = db.meta.find_one({"_id": "following"})
    if meta and meta.get("last_full_at"):
        return explicit
    return explicit | {d["_id"] for d in db.accounts.find({"_id": {"$in": hs}})}


# ---------- contas seguidas ----------
def following_summary(db, include: bool = False) -> dict:
    meta = db.meta.find_one({"_id": "following"}) or {}
    out = {
        "count": db.following.count_documents({}),
        "last_full_at": meta.get("last_full_at"),
        "updated_at": meta.get("updated_at"),
    }
    if include:
        out["accounts"] = [{"handle": d["handle"], "name": d.get("name")} for d in db.following.find().sort("_id", ASCENDING)]
    return out


def put_following(db, accounts: list) -> dict:
    """Substitui a lista pela lida na página de Seguindo (leitura completa)."""
    uniq = {}
    for a in accounts:
        uniq[a.handle.lower()] = a
    ops = [
        UpdateOne({"_id": k}, {"$set": {"handle": a.handle, "name": a.name}, "$setOnInsert": {"added_at": now()}}, upsert=True)
        for k, a in uniq.items()
    ]
    if ops:
        db.following.bulk_write(ops, ordered=False)
    db.following.delete_many({"_id": {"$nin": list(uniq)}})
    t = now()
    db.meta.update_one({"_id": "following"}, {"$set": {"last_full_at": t, "updated_at": t}}, upsert=True)
    return following_summary(db)


def follow_add(db, handle: str, name: str | None) -> dict:
    sets = {"handle": handle}
    if name:  # um "seguir" repetido sem nome não apaga o nome já guardado
        sets["name"] = name
    db.following.update_one({"_id": handle.lower()}, {"$set": sets, "$setOnInsert": {"added_at": now()}}, upsert=True)
    db.meta.update_one({"_id": "following"}, {"$set": {"updated_at": now()}}, upsert=True)
    return following_summary(db)


def follow_remove(db, handle: str) -> dict:
    db.following.delete_one({"_id": handle.lower()})
    db.meta.update_one({"_id": "following"}, {"$set": {"updated_at": now()}}, upsert=True)
    return following_summary(db)


def _place_cluster(db, group, cutoff, stats):
    """Conversa vista no feed (raiz, respostas...), em ordem de baixo para cima: group[0] é a ÚLTIMA resposta.

    1) Se algum membro já está na fila e NÃO foi lido: o registro continua onde estava (mesma posição `seq`);
       só muda o link a abrir (a resposta mais recente) e os outros membros não lidos são cobertos.
    2) Senão (tudo novo, ou os conhecidos já foram lidos): um registro novo, com a última resposta como
       referência, no fim da fila. Os membros ainda não lidos ficam cobertos de forma provisória; a página da
       referência confirma o que realmente mostra (`settle_cover`)."""
    keys = [appearance_key(g.tweet_id, g.reposter) for g in group]
    known = list(db.entries.find({"appearance_keys": {"$in": keys}, "removed": False}))
    unread = sorted((d for d in known if d["read_at"] is None and not d["covered"]), key=lambda d: d["seq"])

    if unread:
        rec = unread[0]  # a que estava primeiro na fila: é ela que mantém o lugar
        ref = group[0]
        upd: dict = {"$addToSet": {"members": {"$each": [g.tweet_id for g in group if g.tweet_id != rec["tweet_id"]]}}}
        new_keys = [k for k in keys if not any(k in d["appearance_keys"] for d in known)]
        if new_keys:
            upd["$addToSet"]["appearance_keys"] = {"$each": new_keys}
        current_open = int(rec.get("open_id", rec["tweet_id"]))
        if int(ref.tweet_id) > current_open:  # nunca volta para uma resposta mais antiga
            upd["$set"] = {"open_id": ref.tweet_id, "url": f"https://x.com/{ref.author}/status/{ref.tweet_id}"}
            stats["updated"] += 1
        try:
            db.entries.update_one({"_id": rec["_id"]}, upd)
        except DuplicateKeyError:
            stats["skipped"] += 1
        for other in unread[1:]:
            r = db.entries.update_one(
                {"_id": other["_id"], "covered": False, "read_at": None},
                {"$set": {"covered": True, "covered_by": rec["seq"], "cover_tentative": True}},
            )
            stats["linked"] += r.modified_count
        return

    # Horário que posiciona o registro: o do post mais ao topo da conversa que seja de uma conta que você segue
    # e que seja NOVO (posts já lidos ou já conhecidos não contam: a conversa volta pelo que há de novo).
    known_keys = {k for d in known for k in d["appearance_keys"]}
    followed = _followed(db, [g.author for g in group])
    key_id = group[0].tweet_id
    for g in reversed(group):  # de cima (raiz) para baixo
        if appearance_key(g.tweet_id, g.reposter) not in known_keys and g.author.lower() in followed:
            key_id = g.tweet_id
            break

    ref_doc, _ = _place(db, group[0], cutoff, stats, sort_id=key_id)
    if ref_doc is None:
        return
    members = group[1:]
    for m in members:
        key = appearance_key(m.tweet_id, m.reposter)
        ex = db.entries.find_one({"appearance_keys": key})
        if ex:
            continue  # já conhecido e lido (ou coberto): não mexe
        # fica logo depois da referência: se for solto no `settle`, aparece em seguida
        doc = _new_doc(m, next_seq(db), None, float(ref_doc["ord"]) + 1e-7)
        doc.update(covered=True, covered_by=ref_doc["seq"], cover_tentative=True)
        try:
            db.entries.insert_one(doc)
            stats["linked"] += 1
        except DuplicateKeyError:
            stats["skipped"] += 1
    ids = [m.tweet_id for m in members]
    if ids:
        db.entries.update_one({"_id": ref_doc["_id"]}, {"$addToSet": {"members": {"$each": ids}}})


def _repost_anchor_id(rev, i):
    """Repost de tweet de conta NÃO seguida. ID do tweet comum (sem repost) vizinho no feed que estima o horário do repost `rev[i]`.
    `rev` está do mais antigo ao mais novo: o vizinho mais antigo vem antes do índice; o repost fica logo depois
    dele. Sem vizinho mais antigo, usa o mais novo; sem nenhum, o próprio tweet."""
    for k in range(i - 1, -1, -1):
        if not rev[k].reposter:
            return rev[k].tweet_id
    for k in range(i + 1, len(rev)):
        if not rev[k].reposter:
            return rev[k].tweet_id
    return rev[i].tweet_id


def append_items(
    db, items: list, anchor_found: bool, batch_id: str | None, revisit_after: timedelta | None = None,
    gap_seq: int | None = None, scan=None, run=None,
) -> dict:
    """`items` em ordem do feed (mais novo primeiro). Processa do mais antigo ao mais novo."""
    revisit_after = REVISIT_AFTER if revisit_after is None else revisit_after
    if batch_id:
        prev = db.batches.find_one({"_id": batch_id})
        if prev:
            return prev["result"]

    had_entries = db.entries.find_one({}, {"_id": 1}) is not None
    stats = {"created": 0, "merged": 0, "absorbed": 0, "skipped": 0, "linked": 0, "updated": 0, "first_new_seq": None}
    cutoff = now() - revisit_after

    _learn_accounts(db, items)
    owners_followed = _followed(db, [it.author for it in items if it.reposter])
    rev = list(reversed(items))
    i = 0
    while i < len(rev):
        it = rev[i]
        if it.cluster is None:
            # Repost: se o DONO do tweet está na sua lista de seguidos, vale o horário do tweet original (pode ir
            # para a frente); se o dono NÃO é seguido, o tweet fica onde o X o mostra no feed (vizinho comum mais
            # antigo), sem mexer na ordem.
            sid = None
            if it.reposter and it.author.lower() not in owners_followed:
                sid = _repost_anchor_id(rev, i)
            _place(db, it, cutoff, stats, sort_id=sid)
            i += 1
            continue
        j = i
        while j < len(rev) and rev[j].cluster == it.cluster:
            j += 1
        _place_cluster(db, rev[i:j], cutoff, stats)
        i = j

    gap = bool(not anchor_found and had_entries and stats["created"] > 0)
    reason = None
    if scan is not None:
        reason = "gap_unresolved" if scan.reason == "anchor" and scan.gap_unresolved else scan.reason
    if gap:
        db.entries.update_one(
            {"seq": stats["first_new_seq"]}, {"$set": {"gap_before": True, "gap_reason": reason or "unknown"}}
        )
    if gap_seq is not None and (anchor_found or gap):
        # A busca tentou preencher a lacuna que começa em `gap_seq`: se chegou ao outro lado, ela fecha; se parou
        # antes, a lacuna restante fica antes do item mais antigo que esta busca criou (a bandeira "anda").
        db.entries.update_one({"seq": gap_seq, "gap_before": True}, {"$set": {"gap_before": False, "gap_reason": None}})

    result = {
        "created": stats["created"],
        "merged": stats["merged"],
        "absorbed": stats["absorbed"],
        "linked": stats["linked"],
        "updated": stats["updated"],
        "skipped": stats["skipped"],
        "first_new_seq": stats["first_new_seq"],
        "gap": gap,
    }
    if run is not None:
        record_run(db, run, ok=True, result=result, scan=scan, anchor_found=anchor_found)
    if batch_id:
        try:
            doc = {"_id": batch_id, "result": result, "created_at": now()}
            if scan is not None:
                doc["scan"] = scan.model_dump()
            db.batches.insert_one(doc)
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
            ref_ord = ord_of(db, covered_by)
            db.entries.update_one(
                {"_id": e["_id"]},
                {"$set": {"covered": False, "covered_by": None, "cover_tentative": False, "ord": _between(db, ref_ord)}},
            )
            released += 1
    return {"confirmed": confirmed, "released": released}


def anchor_keys(db, depth: int) -> dict:
    docs = list(db.entries.find({}, {"appearance_keys": 1, "seq": 1}).sort("seq", DESCENDING).limit(depth))
    keys: list[str] = []
    for d in docs:
        keys.extend(d["appearance_keys"])
    return {"keys": keys, "last_seq": docs[0]["seq"] if docs else None}


# ---------- histórico de execuções ----------
def _trigger(run) -> dict:
    t = getattr(run, "trigger", None)
    return {"trigger": t} if t else {}


def record_run(db, run, *, ok: bool, result: dict | None = None, scan=None, anchor_found: bool | None = None, error: str | None = None) -> None:
    doc = {"at": now(), "source": run.source, "mode": run.mode, "ok": ok, **_trigger(run)}
    if ok and result is not None:
        doc.update(
            created=result["created"], updated=result["updated"], gap=result["gap"], anchor_found=anchor_found,
        )
        if scan is not None:
            doc.update(reason=scan.reason, steps=scan.steps, collected=scan.collected)
    if not ok:
        doc["error"] = (error or "")[:300]
    db.runs.insert_one(doc)


def record_run_report(db, body) -> None:
    doc = {"at": now(), "source": body.source, "mode": body.mode, "ok": True, "started_at": body.started_at, **_trigger(body)}
    doc.update(
        created=body.created, updated=body.updated, gap=body.gap, reason=body.reason, steps=body.steps,
        collected=body.collected, profiles_done=body.profiles_done, profiles_skipped=body.profiles_skipped,
        profile_created=body.profile_created,
    )
    db.runs.insert_one(doc)


def deep_last(db, mode: str = "deep") -> dict:
    """Quando COMEÇOU a última verificação profunda concluída (fronteira da próxima): `mode` "deep" (feed) ou
    "profiles" (perfis). `null` se nunca houve."""
    run = db.runs.find_one({"mode": mode, "ok": True}, sort=[("at", DESCENDING), ("_id", DESCENDING)])
    if not run:
        return {"started_at": None}
    return {"started_at": run.get("started_at") or run["at"]}


def list_runs(db, limit: int) -> dict:
    docs = list(db.runs.find({}, {"_id": 0}).sort([("at", DESCENDING), ("_id", DESCENDING)]).limit(limit))
    return {"items": docs, "next": db.meta.find_one({"_id": "robot_next"}, {"_id": 0})}


def set_robot_next(db, body) -> dict:
    doc = {"at": body.at, "mode": body.mode, "state": body.state, "unread": body.unread, "updated_at": now()}
    db.meta.replace_one({"_id": "robot_next"}, {"_id": "robot_next", **doc}, upsert=True)
    return {"ok": True}


# ---------- não lidas: ritmo do robô e pedidos de busca ----------
def count_unread(db) -> int:
    """Quantas mensagens ainda faltam ler (depois da posição atual, sem as cobertas)."""
    st = _state_doc(db)
    cursor = st["cursor_seq"]
    if cursor is None:
        return db.entries.count_documents(VISIBLE)
    return db.entries.count_documents({**VISIBLE, "ord": {"$gt": ord_of(db, cursor)}})


def robot_policy(db) -> dict:
    n = count_unread(db)
    return {"unread": n, **tier_for(n)}


def _log_run_event(db, kind: str, reason: str, **extra) -> None:
    db.runs.insert_one({"kind": kind, "at": now(), "source": "reading", "reason": reason, **extra})


def request_robot_run(db, reason: str, threshold: int, unread: int) -> None:
    """Pede ao robô uma busca agora (ele confere a cada poucos segundos) e deixa o motivo no histórico."""
    db.meta.replace_one(
        {"_id": "robot_request"},
        {"_id": "robot_request", "pending": True, "reason": reason, "threshold": threshold, "unread": unread, "requested_at": now()},
        upsert=True,
    )
    _log_run_event(db, "request", reason, threshold=threshold, unread=unread)


def evaluate_unread(db, rng=random) -> dict:
    """Chamar depois de qualquer coisa que mude a contagem de não lidas (ler/avançar, cobrir, buscar novas).

    Compara com a última contagem guardada. Só quando a contagem DIMINUI:
    - atravessou 30, 15 ou 6 para baixo -> pede uma busca nova ao robô, com o motivo no histórico;
    - passou para uma faixa de intervalo MENOR e o próximo horário do robô está mais longe que o máximo da nova faixa
      -> sorteia um novo horário dentro da nova faixa (a partir de agora)."""
    new = count_unread(db)
    before = db.meta.find_one_and_update(
        {"_id": "unread_watch"}, {"$set": {"count": new, "updated_at": now()}}, upsert=True, return_document=ReturnDocument.BEFORE
    )
    old = before["count"] if before else None
    out = {"old": old, "new": new, "requested": None, "rescheduled": None}
    if old is None or new >= old:
        return out

    crossed = crossed_thresholds(old, new)
    if crossed:
        t = min(crossed)
        reason = f"restam {new} não lidas (abaixo de {t})"
        request_robot_run(db, reason, t, new)
        out["requested"] = reason

    t_old, t_new = tier_for(old), tier_for(new)
    if t_new["max_minutes"] < t_old["max_minutes"]:
        nxt = db.meta.find_one({"_id": "robot_next"})
        if nxt and nxt.get("state") == "scheduled" and nxt.get("at") and nxt.get("mode") != "profiles":
            remaining = (nxt["at"] - now()).total_seconds() / 60
            if remaining > t_new["max_minutes"]:
                at = now() + timedelta(minutes=rng.uniform(t_new["min_minutes"], t_new["max_minutes"]))
                db.meta.update_one({"_id": "robot_next"}, {"$set": {"at": at, "updated_at": now(), "rescheduled_by": "unread"}})
                reason = f"restam {new} não lidas: próxima busca antecipada ({round(remaining)} min -> {round((at - now()).total_seconds() / 60)} min)"
                _log_run_event(db, "reschedule", reason, unread=new)
                out["rescheduled"] = at
    return out


def robot_request_state(db) -> dict:
    doc = db.meta.find_one({"_id": "robot_request"}, {"_id": 0})
    return doc or {"pending": False}


def ack_robot_request(db) -> dict:
    """O robô pegou o pedido: limpa e devolve o motivo (ou `pending: false` se não havia)."""
    doc = db.meta.find_one_and_update(
        {"_id": "robot_request", "pending": True}, {"$set": {"pending": False, "acked_at": now()}}, return_document=ReturnDocument.BEFORE
    )
    if not doc:
        return {"pending": False}
    return {"pending": True, "reason": doc["reason"], "threshold": doc.get("threshold"), "unread": doc.get("unread"), "requested_at": doc["requested_at"]}


def robot_next_doc(db):
    return db.meta.find_one({"_id": "robot_next"}, {"_id": 0})


def gap_info(db, depth: int, max_age_days: int) -> dict:
    """A lacuna aberta mais antiga ainda alcançável (capturada há no máximo `max_age_days` dias).

    `keys` = aparições das `depth` entradas capturadas logo ANTES da lacuna: são o "outro lado" que a busca precisa
    reencontrar para saber que não há mais nada faltando."""
    since = now() - timedelta(days=max_age_days)
    gap = db.entries.find_one(
        {"gap_before": True, "removed": False, "captured_at": {"$gte": since}}, sort=[("seq", ASCENDING)]
    )
    if not gap:
        return {"seq": None, "keys": []}
    docs = list(db.entries.find({"seq": {"$lt": gap["seq"]}}, {"appearance_keys": 1}).sort("seq", DESCENDING).limit(depth))
    keys: list[str] = []
    for d in docs:
        keys.extend(d["appearance_keys"])
    return {"seq": gap["seq"], "keys": keys, "reason": gap.get("gap_reason")}


def list_queue(db, after: int | None, before: int | None, limit: int, include_covered: bool) -> dict:
    """`after`/`before` são `seq` de entradas; a ordem é a posição de leitura (`ord`)."""
    flt: dict = {"removed": False}
    if not include_covered:
        flt["covered"] = False
    if before is not None:
        flt["ord"] = {"$lt": ord_of(db, before)}
        sort = [("ord", DESCENDING)]
    else:
        flt["ord"] = {"$gt": ord_of(db, after) if after else NEG}
        sort = [("ord", ASCENDING)]
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
    cur_ord = ord_of(db, cursor)
    if cursor is not None:
        unread_after = db.entries.count_documents({**VISIBLE, "ord": {"$gt": cur_ord}})
        position = db.entries.count_documents({**VISIBLE, "ord": {"$lte": cur_ord}})
        cur_doc = db.entries.find_one({"seq": cursor, "removed": False})
    else:
        unread_after, position, cur_doc = total, 0, None
    nxt = db.entries.find_one({**VISIBLE, "ord": {"$gt": cur_ord}}, {"seq": 1}, sort=[("ord", ASCENDING)])
    return {
        "cursor_seq": cursor,
        "current": entry_detail(db, cur_doc) if cur_doc else None,
        "next_seq": nxt["seq"] if nxt else None,
        "position": position,
        "unread_after": unread_after,
        "total_visible": total,
        "feed": st["feed"],
        "following": following_summary(db),
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

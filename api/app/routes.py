from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.encoders import jsonable_encoder
from fastapi.responses import JSONResponse
from pymongo import DESCENDING

from . import services as svc
from .models import (
    AppendIn,
    CoverIn,
    EntryPatch,
    SkeletonIn,
    StateIn,
    UncoverIn,
    ViewsIn,
)
from .security import require_key

router = APIRouter(prefix="/api/v1", dependencies=[Depends(require_key)])


def _db(request: Request):
    return request.app.state.db


# ---------- estado ----------
@router.get("/state")
def get_state(request: Request):
    return svc.state_view(_db(request))


@router.put("/state")
def put_state(body: StateIn, request: Request):
    db = _db(request)
    feed = body.feed.model_dump() if body.feed else None
    try:
        return svc.update_state(db, body.model_fields_set, body.cursor_seq, feed, body.expected_version)
    except svc.VersionConflict:
        return JSONResponse(
            status_code=409,
            content=jsonable_encoder({"detail": "version_conflict", "state": svc.state_view(db)}),
        )
    except svc.InvalidCursor:
        raise HTTPException(status_code=422, detail="cursor_seq inexistente")


# ---------- fila ----------
@router.get("/queue/anchor")
def get_anchor(request: Request, depth: int = Query(10, ge=1, le=50)):
    return svc.anchor_keys(_db(request), depth)


@router.post("/queue/append")
def post_append(body: AppendIn, request: Request):
    return svc.append_items(_db(request), body.items, body.anchor_found, body.batch_id)


@router.get("/queue")
def get_queue(
    request: Request,
    after: int | None = Query(None, ge=0),
    before: int | None = Query(None, ge=1),
    limit: int = Query(20, ge=1, le=100),
    include_covered: bool = False,
):
    if after is not None and before is not None:
        raise HTTPException(status_code=422, detail="use after ou before, não ambos")
    return svc.list_queue(_db(request), after, before, limit, include_covered)


# ---------- entradas ----------
@router.get("/entries/{seq}")
def get_entry(seq: int, request: Request):
    db = _db(request)
    doc = db.entries.find_one({"seq": seq, "removed": False})
    if not doc:
        raise HTTPException(status_code=404, detail="entrada não encontrada")
    return svc.entry_detail(db, doc)


@router.patch("/entries/{seq}")
def patch_entry(seq: int, body: EntryPatch, request: Request):
    db = _db(request)
    try:
        doc = svc.patch_entry(db, seq, body)
    except svc.UnknownEntry:
        raise HTTPException(status_code=422, detail="covered_by inválido")
    if doc is None:
        raise HTTPException(status_code=404, detail="entrada não encontrada")
    return svc.entry_detail(db, doc)


@router.post("/entries/cover")
def post_cover(body: CoverIn, request: Request):
    try:
        return svc.cover_by_tweet_ids(_db(request), body.covered_by, body.tweet_ids, body.ancestor_ids)
    except svc.UnknownEntry:
        raise HTTPException(status_code=404, detail="entrada de destino não encontrada")


@router.post("/entries/uncover")
def post_uncover(body: UncoverIn, request: Request):
    return svc.uncover(_db(request), body.covered_by)


# ---------- visualizações ----------
@router.post("/views")
def post_views(body: ViewsIn, request: Request):
    try:
        return svc.record_views(_db(request), body.seqs, body.viewed_at)
    except svc.UnknownEntry:
        raise HTTPException(status_code=404, detail="alguma entrada não existe")


# ---------- saúde da captura ----------
@router.post("/health/skeleton", status_code=201)
def post_skeleton(body: SkeletonIn, request: Request):
    doc = body.model_dump()
    doc["created_at"] = svc.now()
    _db(request).skeletons.insert_one(doc)
    return {"stored": True}


@router.get("/health/skeleton")
def get_skeletons(request: Request, limit: int = Query(5, ge=1, le=20)):
    docs = _db(request).skeletons.find({}, {"_id": 0}).sort("created_at", DESCENDING).limit(limit)
    return {"items": list(docs)}


# ---------- exportação ----------
@router.get("/export")
def export(request: Request):
    db = _db(request)
    entries = [{k: v for k, v in d.items() if k not in ("_id", "author_lc")} for d in db.entries.find().sort("seq", 1)]
    views = [{k: v for k, v in d.items() if k != "_id"} for d in db.views.find().sort("viewed_at", 1)]
    state = {k: v for k, v in (db.state.find_one({"_id": "main"}) or {}).items() if k != "_id"}
    return {"state": state, "entries": entries, "views": views}

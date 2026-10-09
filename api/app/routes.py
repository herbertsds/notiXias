from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.encoders import jsonable_encoder
from fastapi.responses import JSONResponse
from pymongo import DESCENDING

from . import services as svc
from .models import (
    AppendIn,
    CoverIn,
    EntryPatch,
    FollowAccount,
    FollowingPut,
    RobotNextIn,
    RunReportIn,
    RunFailIn,
    SettleIn,
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
        out = svc.update_state(db, body.model_fields_set, body.cursor_seq, feed, body.expected_version)
        svc.evaluate_unread(db)   # avançou/voltou uma mensagem: confere a contagem (ritmo do robô e pedidos de busca)
        return out
    except svc.VersionConflict:
        return JSONResponse(
            status_code=409,
            content=jsonable_encoder({"detail": "version_conflict", "state": svc.state_view(db)}),
        )
    except svc.InvalidCursor:
        raise HTTPException(status_code=422, detail="cursor_seq inexistente")


# ---------- contas seguidas ----------
@router.get("/accounts/following")
def get_following(request: Request, include: bool = False):
    return svc.following_summary(_db(request), include)


@router.put("/accounts/following")
def put_following(body: FollowingPut, request: Request):
    return svc.put_following(_db(request), body.accounts)


@router.post("/accounts/following/add")
def post_follow_add(body: FollowAccount, request: Request):
    return svc.follow_add(_db(request), body.handle, body.name)


@router.post("/accounts/following/remove")
def post_follow_remove(body: FollowAccount, request: Request):
    return svc.follow_remove(_db(request), body.handle)


# ---------- fila ----------
@router.get("/queue/anchor")
def get_anchor(request: Request, depth: int = Query(10, ge=1, le=200)):
    return svc.anchor_keys(_db(request), depth)


@router.get("/queue/gap")
def get_gap(request: Request, depth: int = Query(25, ge=1, le=100), max_age_days: int = Query(3, ge=1, le=60)):
    return svc.gap_info(_db(request), depth, max_age_days)


@router.post("/queue/append")
def post_append(body: AppendIn, request: Request):
    db = _db(request)
    out = svc.append_items(db, body.items, body.anchor_found, body.batch_id, gap_seq=body.gap_seq, scan=body.scan, run=body.run)
    svc.evaluate_unread(db)
    return out


@router.get("/runs")
def get_runs(request: Request, limit: int = Query(100, ge=1, le=200)):
    return svc.list_runs(_db(request), limit)


@router.get("/runs/deep-last")
def get_deep_last(request: Request, mode: Literal["deep", "profiles"] = "deep"):
    return svc.deep_last(_db(request), mode)


@router.get("/robot/policy")
def get_robot_policy(request: Request):
    return svc.robot_policy(_db(request))


@router.get("/robot/next")
def get_robot_next(request: Request):
    return svc.robot_next_doc(_db(request))


@router.get("/robot/request")
def get_robot_request(request: Request):
    return svc.robot_request_state(_db(request))


@router.post("/robot/request/ack")
def post_robot_request_ack(request: Request):
    return svc.ack_robot_request(_db(request))


@router.post("/runs/report", status_code=201)
def post_run_report(body: RunReportIn, request: Request):
    svc.record_run_report(_db(request), body)
    return {"ok": True}


@router.put("/robot/next")
def put_robot_next(body: RobotNextIn, request: Request):
    return svc.set_robot_next(_db(request), body)


@router.post("/runs", status_code=201)
def post_run_failure(body: RunFailIn, request: Request):
    svc.record_run(_db(request), body, ok=False, error=body.error)
    return {"ok": True}


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
        db = _db(request)
        out = svc.cover_by_tweet_ids(db, body.covered_by, body.tweet_ids, body.ancestor_ids)
        svc.evaluate_unread(db)
        return out
    except svc.UnknownEntry:
        raise HTTPException(status_code=404, detail="entrada de destino não encontrada")


@router.post("/entries/settle")
def post_settle(body: SettleIn, request: Request):
    db = _db(request)
    out = svc.settle_cover(db, body.covered_by, body.present_ids)
    svc.evaluate_unread(db)
    return out


@router.post("/entries/uncover")
def post_uncover(body: UncoverIn, request: Request):
    db = _db(request)
    out = svc.uncover(db, body.covered_by)
    svc.evaluate_unread(db)
    return out


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
    following = svc.following_summary(db, include=True)
    return {"state": state, "entries": entries, "views": views, "following": following}

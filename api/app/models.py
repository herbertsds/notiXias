from datetime import datetime
from typing import Annotated, Literal

from pydantic import BaseModel, Field, StringConstraints, model_validator

TweetId = Annotated[str, StringConstraints(pattern=r"^\d{1,25}$")]
Handle = Annotated[str, StringConstraints(pattern=r"^[A-Za-z0-9_]{1,15}$")]
XUrl = Annotated[str, StringConstraints(pattern=r"^https://(x|twitter)\.com/\S*$", max_length=300)]
Kind = Literal["post", "repost", "reply", "quote"]


# ---------- entrada ----------
class AppearanceIn(BaseModel):
    tweet_id: TweetId
    author: Handle
    reposter: Handle | None = None
    reposter_name: str | None = Field(default=None, max_length=100)  # nome de exibição de quem repostou
    kind: Kind = "post"
    # Itens consecutivos do feed que formam uma conversa (raiz, resposta 1, resposta 2...) têm o mesmo número.
    cluster: int | None = Field(default=None, ge=1, le=1_000_000)


class ScanIn(BaseModel):
    """Como a busca terminou (diagnóstico): por que parou e quanto rolou."""

    reason: str = Field(max_length=30, pattern=r"^[\w\-]+$")  # anchor | max_steps | max_collect | end | backfill | gap_unresolved
    steps: int = Field(default=0, ge=0, le=100_000)
    collected: int = Field(default=0, ge=0, le=100_000)
    gap_unresolved: int = Field(default=0, ge=0, le=100_000)  # lacunas "Mostrar mais" que ficaram sem abrir


class RunIn(BaseModel):
    """Quem disparou a execução e de que tipo (para o histórico de execuções)."""

    source: Literal["manual", "robot"]
    mode: Literal["normal", "deep"] = "normal"


class RunReportIn(RunIn):
    """Fecha uma execução PROFUNDA composta (feed + perfis): totais e quando ela começou."""

    started_at: datetime
    created: int = Field(ge=0, le=1_000_000)
    updated: int = Field(ge=0, le=1_000_000)
    gap: bool = False
    reason: str | None = Field(default=None, max_length=30, pattern=r"^[\w\-]+$")
    steps: int = Field(default=0, ge=0, le=1_000_000)
    collected: int = Field(default=0, ge=0, le=1_000_000)
    profiles_done: int = Field(default=0, ge=0, le=100_000)
    profiles_skipped: int = Field(default=0, ge=0, le=100_000)
    profile_created: int = Field(default=0, ge=0, le=1_000_000)


class RunFailIn(RunIn):
    error: str = Field(max_length=300)


class RobotNextIn(BaseModel):
    """O robô informa quando será a próxima busca automática (e de que tipo), ou por que não há próxima."""

    at: datetime | None = None
    mode: Literal["normal", "deep"] = "normal"
    state: Literal["scheduled", "paused", "waiting_session"] = "scheduled"


class AppendIn(BaseModel):
    """`items` na ordem do feed: o mais novo primeiro."""

    items: list[AppearanceIn] = Field(max_length=1000)
    anchor_found: bool
    gap_seq: int | None = Field(default=None, ge=1)  # busca que tentou preencher a lacuna que começa nesta entrada
    scan: ScanIn | None = None
    run: RunIn | None = None  # se informado, a execução entra no histórico (GET /runs)
    batch_id: str | None = Field(default=None, min_length=1, max_length=100, pattern=r"^[\w.:\-]+$")


class FeedIn(BaseModel):
    url: XUrl
    tab_index: int | None = Field(default=None, ge=0, le=10)


class StateIn(BaseModel):
    cursor_seq: int | None = Field(default=None, ge=1)
    feed: FeedIn | None = None
    expected_version: int | None = Field(default=None, ge=0)


class EntryPatch(BaseModel):
    covered: bool | None = None
    covered_by: int | None = Field(default=None, ge=1)
    removed: bool | None = None

    @model_validator(mode="after")
    def _at_least_one(self):
        if not self.model_fields_set:
            raise ValueError("nenhum campo informado")
        if self.covered is True and self.covered_by is None:
            raise ValueError("covered=true exige covered_by")
        return self


class CoverIn(BaseModel):
    """`tweet_ids`: só do MESMO autor da entrada de destino (pedaços de thread).
    `ancestor_ids`: posts que estão ACIMA do post aberto na conversa (resposta -> original), de qualquer autor."""

    covered_by: int = Field(ge=1)
    tweet_ids: list[TweetId] = Field(default_factory=list, max_length=500)
    ancestor_ids: list[TweetId] = Field(default_factory=list, max_length=500)

    @model_validator(mode="after")
    def _some_ids(self):
        if not self.tweet_ids and not self.ancestor_ids:
            raise ValueError("informe tweet_ids ou ancestor_ids")
        return self


class FollowAccount(BaseModel):
    handle: Handle
    name: str | None = Field(default=None, max_length=100)


class FollowingPut(BaseModel):
    """Lista COMPLETA de contas que você segue (lida da página de Seguindo): substitui a lista guardada."""

    accounts: list[FollowAccount] = Field(max_length=10000)


class SettleIn(BaseModel):
    """Confirma/solta a cobertura provisória de `covered_by` conforme o que a página mostra."""

    covered_by: int = Field(ge=1)
    present_ids: list[TweetId] = Field(default_factory=list, max_length=1000)


class UncoverIn(BaseModel):
    covered_by: int = Field(ge=1)


class ViewsIn(BaseModel):
    seqs: list[int] = Field(min_length=1, max_length=200)
    viewed_at: datetime | None = None


class SkeletonIn(BaseModel):
    page: str = Field(max_length=100)
    user_agent: str = Field(default="", max_length=300)
    skeleton: str = Field(max_length=200_000)
    note: str = Field(default="", max_length=500)

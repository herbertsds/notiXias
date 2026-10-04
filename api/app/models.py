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
    kind: Kind = "post"


class AppendIn(BaseModel):
    """`items` na ordem do feed: o mais novo primeiro."""

    items: list[AppearanceIn] = Field(max_length=1000)
    anchor_found: bool
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
    covered_by: int = Field(ge=1)
    tweet_ids: list[TweetId] = Field(min_length=1, max_length=500)


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

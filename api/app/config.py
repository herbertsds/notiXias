import os
from dataclasses import dataclass


@dataclass(frozen=True)
class Settings:
    env: str
    mongo_url: str
    mongo_db: str
    api_key_hash: str
    log_level: str = "info"

    @property
    def is_prod(self) -> bool:
        return self.env == "prod"

    @classmethod
    def from_env(cls) -> "Settings":
        return cls(
            env=os.environ.get("ENV", "dev"),
            mongo_url=os.environ.get("MONGO_URL", "mongodb://mongo:27017"),
            mongo_db=os.environ.get("MONGO_DB", "notixias"),
            api_key_hash=os.environ.get("API_KEY_HASH", ""),
            log_level=os.environ.get("LOG_LEVEL", "info"),
        )

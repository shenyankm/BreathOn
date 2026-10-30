import os
import asyncio
import math
import json
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import urlsplit

from dotenv import load_dotenv

from .limits import RateLimit
from ..api.auth import password_parts
from ..agents.coach import DEEPSEEK_URL
from ..voice.asr import ASR_URL
from ..voice.tts import TTS_URL
from ..voice.protocol import UPSTREAM_URL

load_dotenv(Path(__file__).resolve().parents[2] / ".env")


def integer_env(name, default):
    try:
        return int(os.getenv(name, default))
    except ValueError:
        raise ValueError(f"{name} must be a positive integer") from None


def login_users_env():
    try:
        return json.loads(os.getenv('LOGIN_USERS_JSON', '{}'))
    except ValueError:
        raise ValueError('LOGIN_USERS_JSON must contain an object of usernames and password hashes') from None


@dataclass
class Settings:
    auth_required: bool = field(default_factory=lambda: os.getenv('AUTH_REQUIRED', 'false').lower() != 'false')
    admin_username: str = field(default_factory=lambda: os.getenv('ADMIN_USERNAME', 'admin'))
    admin_password_hash: str = field(default_factory=lambda: os.getenv('ADMIN_PASSWORD_HASH', ''), repr=False)
    login_users: dict[str, str] = field(default_factory=login_users_env, repr=False)
    api_key: str = field(default_factory=lambda: os.getenv("DOUBAO_API_KEY", ""), repr=False)
    voice: str = field(default_factory=lambda: os.getenv("DOUBAO_VOICE", "zh_male_xiaotian_jupiter_bigtts"))
    origins: tuple[str, ...] = field(default_factory=lambda: tuple(
        item.strip() for item in os.getenv("ALLOWED_ORIGINS", "http://127.0.0.1:5173,http://localhost:5173").split(",") if item.strip()
    ))
    records: Path = field(default_factory=lambda: Path(os.getenv("RECORDS_DIR") or Path(__file__).resolve().parents[2] / "data/sessions"))
    database_url: str = field(default_factory=lambda: os.getenv("DATABASE_URL", ""), repr=False)
    asr_api_key: str = field(default_factory=lambda: os.getenv("SEEDASR_API_KEY", ""), repr=False)
    deepseek_api_key: str = field(default_factory=lambda: os.getenv("DEEPSEEK_API_KEY", ""), repr=False)
    deepseek_model: str = field(default_factory=lambda: os.getenv("DEEPSEEK_MODEL", "deepseek-flash"))
    deepseek_endpoint: str = DEEPSEEK_URL
    deepseek_search_enabled: bool = field(default_factory=lambda: os.getenv("DEEPSEEK_SEARCH_ENABLED", "true").lower() == "true")
    deepseek_max_concurrency: int = field(default_factory=lambda: integer_env("DEEPSEEK_MAX_CONCURRENCY", "2500"))
    deepseek_search_qps: int = field(default_factory=lambda: integer_env("DEEPSEEK_SEARCH_QPS", "100"))
    deepseek_fetch_qps: int = field(default_factory=lambda: integer_env("DEEPSEEK_FETCH_QPS", "25"))
    _deepseek_slots: asyncio.Semaphore = field(init=False, repr=False)
    _search_rate: RateLimit = field(init=False, repr=False)
    _fetch_rate: RateLimit = field(init=False, repr=False)
    tts_api_key: str = field(default_factory=lambda: os.getenv("DOUBAO_TTS_API_KEY", ""), repr=False)
    tts_voice: str = field(default_factory=lambda: os.getenv("DOUBAO_TTS_VOICE", "zh_male_m191_uranus_bigtts"))
    tts_endpoint: str = TTS_URL
    asr_endpoint: str = ASR_URL
    endpoint: str = UPSTREAM_URL
    max_sessions: int = 2
    session_seconds: float = 600
    handshake_seconds: float = 15

    def __post_init__(self):
        for name in ("deepseek_max_concurrency", "deepseek_search_qps", "deepseek_fetch_qps", "max_sessions"):
            value = getattr(self, name)
            if type(value) is not int or value <= 0:
                raise ValueError(f"{name.upper()} must be a positive integer")
        for name in ("session_seconds", "handshake_seconds"):
            value = getattr(self, name)
            if type(value) not in (int, float) or not 0 < value < math.inf:
                raise ValueError(f"{name.upper()} must be finite and positive")
        origins = []
        try:
            if not self.origins or isinstance(self.origins, str):
                raise ValueError
            for origin in self.origins:
                if not isinstance(origin, str):
                    raise ValueError
                parsed = urlsplit(origin)
                if (parsed.scheme not in ('http', 'https') or not parsed.hostname
                        or parsed.username is not None or parsed.password is not None
                        or origin != f'{parsed.scheme}://{parsed.netloc}'
                        or '*' in origin or '\\' in origin or '%' in parsed.netloc
                        or any(character.isspace() or ord(character) < 32 or ord(character) == 127 for character in origin)):
                    raise ValueError
                host = parsed.hostname.encode('idna').decode('ascii').lower()
                host = f'[{host}]' if ':' in host else host
                port = parsed.port
                if port is not None and port != (443 if parsed.scheme == 'https' else 80):
                    host += f':{port}'
                origins.append(f'{parsed.scheme}://{host}')
        except (ValueError, TypeError, UnicodeError):
            raise ValueError('ALLOWED_ORIGINS must contain exact HTTP(S) origins without credentials, paths, queries or wildcards') from None
        self.origins = tuple(origins)
        if self.auth_required:
            if not isinstance(self.login_users, dict) or len(self.login_users) > 32:
                raise ValueError('LOGIN_USERS_JSON must contain at most 32 accounts')
            if not self.login_users:
                self.login_users = {self.admin_username:self.admin_password_hash}
            for username, password_hash in self.login_users.items():
                if not isinstance(username, str) or not username.strip() or len(username) > 100:
                    raise ValueError('Account usernames must contain 1 to 100 characters')
                password_parts(password_hash)
            if any(urlsplit(origin).scheme != 'https' and urlsplit(origin).hostname not in ('localhost', '127.0.0.1', '::1') for origin in self.origins):
                raise ValueError('Authentication requires HTTPS for public ALLOWED_ORIGINS')
        self.records = Path(self.records).expanduser()
        self._deepseek_slots = asyncio.Semaphore(self.deepseek_max_concurrency)
        self._search_rate = RateLimit(self.deepseek_search_qps)
        self._fetch_rate = RateLimit(self.deepseek_fetch_qps)


from pathlib import Path
import json
import shutil
from datetime import datetime, timezone
import os
import logging
import time
import secrets
import base64
import hashlib
import re
from typing import Optional
from fastapi import APIRouter, Body, FastAPI, Request, Response, HTTPException
from fastapi.responses import FileResponse, JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
import sqlite3

try:
    from bs4 import BeautifulSoup as _BeautifulSoup
    _HAS_BS4 = True
except ImportError:
    _HAS_BS4 = False

# --------------------------------------------------------------------------- #
# Logging
# --------------------------------------------------------------------------- #

_log_level = (os.environ.get("SKILLBOTTLE_LOG_LEVEL") or "INFO").upper()
logging.basicConfig(
    level=_log_level,
    format="%(asctime)s %(levelname)s [%(name)s] %(message)s",
)
logger = logging.getLogger("skillbottle")

# --------------------------------------------------------------------------- #
# App setup
# --------------------------------------------------------------------------- #

app = FastAPI(title="SkillBottle Web")

# --------------------------------------------------------------------------- #
# Static files – no-cache for development
# --------------------------------------------------------------------------- #

class NoCacheStaticFiles(StaticFiles):
    async def get_response(self, path: str, scope):
        response = await super().get_response(path, scope)
        response.headers["Cache-Control"] = "no-store"
        return response

# --------------------------------------------------------------------------- #
# Paths (all derived from project root, override via env)
# --------------------------------------------------------------------------- #

PROJECT_ROOT = Path(__file__).resolve().parent
APPS_DIR = Path(os.environ.get("SKILLBOTTLE_APPS_DIR", str(PROJECT_ROOT / "app")))
FRONTEND_DIR = Path(os.environ.get("SKILLBOTTLE_FRONTEND_DIR", str(PROJECT_ROOT / "frontend")))
ADMIN_DB = PROJECT_ROOT / ".skillbottle_admin.db"
RESULT_DIR = PROJECT_ROOT / "result"
RESULT_DIR.mkdir(parents=True, exist_ok=True)

# Result retention: keep exports for max 7 days
RESULT_MAX_AGE_DAYS = 7
_RESULT_CLEANUP_INTERVAL = 3600  # seconds

# --------------------------------------------------------------------------- #
# Database – SQLite for persistent tokens
# --------------------------------------------------------------------------- #

def _get_db() -> sqlite3.Connection:
    conn = sqlite3.connect(str(ADMIN_DB), timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn

def _init_db() -> None:
    """Create DB tables if they don't exist, with migrations for existing DBs."""
    conn = _get_db()
    try:
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS admin_tokens (
                token    TEXT PRIMARY KEY,
                created_at REAL NOT NULL,
                expires_at REAL NOT NULL,
                revoked   INTEGER NOT NULL DEFAULT 0,
                revoked_at REAL
            );
            CREATE TABLE IF NOT EXISTS admin_password (
                id          INTEGER PRIMARY KEY CHECK (id = 1),
                algo        TEXT NOT NULL,
                salt        TEXT NOT NULL,
                dk          TEXT NOT NULL,
                iterations  INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS rate_limits (
                key         TEXT PRIMARY KEY,
                count       INTEGER NOT NULL,
                window_start REAL NOT NULL
            );
            CREATE TABLE IF NOT EXISTS audit_log (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                ts          REAL NOT NULL,
                event       TEXT NOT NULL,
                detail      TEXT
            );
            CREATE TABLE IF NOT EXISTS admin_config (
                key   TEXT PRIMARY KEY,
                value TEXT NOT NULL,
                updated_at REAL NOT NULL DEFAULT (strftime('%s', 'now'))
            );
        """)
        # Migration: add updated_at column if it doesn't exist (table already existed)
        for row in conn.execute("PRAGMA table_info(admin_config)").fetchall():
            if row["name"] == "updated_at":
                break
        else:
            conn.execute("ALTER TABLE admin_config ADD COLUMN updated_at REAL NOT NULL DEFAULT (strftime('%s', 'now'))")

        conn.commit()
    finally:
        conn.close()

_init_db()

# --------------------------------------------------------------------------- #
# Admin password helpers
# --------------------------------------------------------------------------- #

ADMIN_PASSWORD_ENV = os.environ.get("SKILLBOTTLE_ADMIN_PASSWORD") or os.environ.get("ADMIN_PASSWORD") or ""

def _admin_source() -> str:
    if ADMIN_PASSWORD_ENV:
        return "env"
    conn = _get_db()
    try:
        row = conn.execute("SELECT 1 FROM admin_password LIMIT 1").fetchone()
        return "db" if row else "none"
    finally:
        conn.close()

def _hash_password(password: str, iterations: Optional[int] = None) -> dict:
    if iterations is None:
        iterations = int(os.environ.get("SKILLBOTTLE_PBKDF2_ITERATIONS") or "200000")
    salt = secrets.token_bytes(16)
    dk = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, iterations)
    return {
        "algo": "pbkdf2_sha256",
        "salt": base64.b64encode(salt).decode("ascii"),
        "dk": base64.b64encode(dk).decode("ascii"),
        "iterations": iterations,
    }

def _derive_key(password: str, salt: bytes, iterations: int) -> bytes:
    return hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, iterations)

def _verify_password(password: str) -> bool:
    """Verify password against env var or DB record. Returns False on any error."""
    if ADMIN_PASSWORD_ENV:
        return secrets.compare_digest(password, ADMIN_PASSWORD_ENV)

    conn = _get_db()
    try:
        row = conn.execute("SELECT salt, dk, iterations FROM admin_password WHERE id=1").fetchone()
        if not row:
            return False
        try:
            salt = base64.b64decode(row["salt"].encode("ascii"))
            dk_expected = base64.b64decode(row["dk"].encode("ascii"))
            iterations = int(row["iterations"])
        except (ValueError, Exception):
            return False
        dk = _derive_key(password, salt, iterations)
        return secrets.compare_digest(dk, dk_expected)
    finally:
        conn.close()

def _save_password(password: str) -> None:
    secret = _hash_password(password)
    conn = _get_db()
    try:
        conn.execute(
            "INSERT OR REPLACE INTO admin_password (id, algo, salt, dk, iterations) VALUES (1, ?, ?, ?, ?)",
            (secret["algo"], secret["salt"], secret["dk"], secret["iterations"]),
        )
        conn.commit()
    finally:
        conn.close()

def _audit_log(event: str, detail: str = "") -> None:
    """Append a timestamped audit log entry. Errors are logged, not silently ignored."""
    try:
        conn = _get_db()
        try:
            conn.execute(
                "INSERT INTO audit_log (ts, event, detail) VALUES (?, ?, ?)",
                (time.time(), event, detail),
            )
            conn.commit()
        finally:
            conn.close()
    except Exception:
        logger.exception("[audit_log] failed to write audit entry: event=%s detail=%s", event, detail)

# --------------------------------------------------------------------------- #
# Token management (SQLite-backed)
# --------------------------------------------------------------------------- #

_ADMIN_TOKEN_TTL_SECONDS = 8 * 3600  # 8 hours

def _generate_token() -> str:
    token = secrets.token_hex(16)
    now = time.time()
    conn = _get_db()
    try:
        conn.execute(
            "INSERT INTO admin_tokens (token, created_at, expires_at) VALUES (?, ?, ?)",
            (token, now, now + _ADMIN_TOKEN_TTL_SECONDS),
        )
        conn.commit()
    finally:
        conn.close()
    return token

def _verify_token(token: str) -> bool:
    """Check token exists, not expired, and not revoked."""
    conn = _get_db()
    try:
        row = conn.execute(
            "SELECT expires_at, revoked FROM admin_tokens WHERE token=?",
            (token,),
        ).fetchone()
        if not row:
            return False
        if row["revoked"]:
            return False
        if time.time() > row["expires_at"]:
            return False
        return True
    finally:
        conn.close()

def _revoke_token(token: str) -> bool:
    """Revoke a token immediately. Returns True if token existed and was revoked."""
    conn = _get_db()
    try:
        existing = conn.execute(
            "SELECT 1 FROM admin_tokens WHERE token=? AND revoked=0",
            (token,),
        ).fetchone()
        if not existing:
            return False
        conn.execute(
            "UPDATE admin_tokens SET revoked=1, revoked_at=? WHERE token=?",
            (time.time(), token),
        )
        conn.commit()
        return True
    finally:
        conn.close()

def _cleanup_expired_tokens() -> int:
    """Remove expired tokens. Returns count removed."""
    conn = _get_db()
    try:
        cur = conn.execute(
            "DELETE FROM admin_tokens WHERE expires_at < ?",
            (time.time(),),
        )
        conn.commit()
        return cur.rowcount
    finally:
        conn.close()

# Periodic cleanup of expired tokens (once per hour at most)
_last_token_cleanup = time.time()

def _maybe_cleanup_tokens() -> None:
    global _last_token_cleanup
    now = time.time()
    if now - _last_token_cleanup > 3600:
        _last_token_cleanup = now
        try:
            removed = _cleanup_expired_tokens()
            if removed:
                logger.info("cleaned up %d expired tokens", removed)
        except Exception:
            pass

# --------------------------------------------------------------------------- #
# Rate limiting – sliding window per IP
# --------------------------------------------------------------------------- #

# 5 attempts per 15-minute window for /api/admin/verify
RATE_LIMIT_WINDOW = 15 * 60
RATE_LIMIT_MAX = 5

def _check_rate_limit(key: str, max_requests: int = RATE_LIMIT_MAX, window: float = RATE_LIMIT_WINDOW) -> tuple[bool, int]:
    """
    Returns (allowed, remaining). Uses SQLite for persistent sliding-window count.
    """
    now = time.time()
    conn = _get_db()
    try:
        row = conn.execute(
            "SELECT count, window_start FROM rate_limits WHERE key=?",
            (key,),
        ).fetchone()

        if row is None:
            # First request in window
            conn.execute(
                "INSERT INTO rate_limits (key, count, window_start) VALUES (?, 1, ?)",
                (key, now),
            )
            conn.commit()
            return True, max_requests - 1

        count, window_start = row["count"], row["window_start"]

        if now - window_start >= window:
            # Window expired – reset
            conn.execute(
                "UPDATE rate_limits SET count=1, window_start=? WHERE key=?",
                (now, key),
            )
            conn.commit()
            return True, max_requests - 1

        if count >= max_requests:
            remaining = 0
            return False, remaining

        conn.execute(
            "UPDATE rate_limits SET count=? WHERE key=?",
            (count + 1, key),
        )
        conn.commit()
        return True, max_requests - count - 1
    finally:
        conn.close()

def _client_ip(request: Request) -> str:
    """Best-effort client IP, checking X-Forwarded-For first."""
    forwarded = request.headers.get("x-forwarded-for", "")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return request.client.host if request.client else "unknown"

def _is_https(request: Request) -> bool:
    """Detect if the request is over HTTPS."""
    # Check standard headers
    if request.headers.get("x-forwarded-proto", "").lower() == "https":
        return True
    if request.headers.get("x-url-scheme", "").lower() == "https":
        return True
    # Check via url base
    if request.url.scheme == "https":
        return True
    return False

# --------------------------------------------------------------------------- #
# Password strength validation
# --------------------------------------------------------------------------- #

PASSWORD_MIN_LENGTH = 8

def _validate_password_strength(password: str) -> tuple[bool, str]:
    """
    Enforce:
    - minimum 8 characters
    - at least 1 digit
    - at least 1 uppercase or lowercase letter
    Returns (ok, reason).
    """
    if len(password) < PASSWORD_MIN_LENGTH:
        return False, f"密码至少 {PASSWORD_MIN_LENGTH} 位"
    if not re.search(r"[A-Za-z]", password):
        return False, "密码必须包含字母"
    if not re.search(r"\d", password):
        return False, "密码必须包含数字"
    return True, ""

# --------------------------------------------------------------------------- #
# Result directory cleanup
# --------------------------------------------------------------------------- #

_last_result_cleanup = time.time()

def _cleanup_old_exports() -> int:
    """Remove result/export-* directories older than RESULT_MAX_AGE_DAYS. Returns count removed."""
    if not RESULT_DIR.exists():
        return 0
    cutoff = time.time() - RESULT_MAX_AGE_DAYS * 86400
    removed = 0
    for entry in RESULT_DIR.iterdir():
        if entry.is_dir() and entry.name.startswith("export-"):
            try:
                mtime = entry.stat().st_mtime
                if mtime < cutoff:
                    shutil.rmtree(entry)
                    removed += 1
                    logger.info("removed old export: %s", entry.name)
            except Exception as e:
                logger.warning("failed to remove %s: %s", entry.name, e)
    return removed

def _maybe_cleanup_results() -> None:
    global _last_result_cleanup
    now = time.time()
    if now - _last_result_cleanup > _RESULT_CLEANUP_INTERVAL:
        _last_result_cleanup = now
        try:
            removed = _cleanup_old_exports()
            if removed:
                logger.info("cleaned up %d old export directories", removed)
        except Exception:
            pass

# --------------------------------------------------------------------------- #
# Middleware
# --------------------------------------------------------------------------- #

@app.middleware("http")
async def _log_requests(request: Request, call_next):
    start = time.perf_counter()
    request_id = secrets.token_hex(6)
    try:
        response = await call_next(request)
    except Exception:
        logger.exception("[%s] ERR %s %s", request_id, request.method, request.url.path)
        raise

    elapsed_ms = (time.perf_counter() - start) * 1000.0
    path = request.url.path
    if path == "/" or path == "/index.html" or path.startswith("/api"):
        logger.info("[%s] %s %s -> %s %.1fms", request_id, request.method, path, response.status_code, elapsed_ms)
    return response

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:3000",
        "http://127.0.0.1:3000",
        "http://localhost:5173",
        "http://127.0.0.1:5173",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# --------------------------------------------------------------------------- #
# API router
# --------------------------------------------------------------------------- #

api = APIRouter(prefix="/api")

# --------------------------------------------------------------------------- #
# Health
# --------------------------------------------------------------------------- #

@api.get("/health")
def health() -> dict:
    return {"ok": True}

# --------------------------------------------------------------------------- #
# Admin status
# --------------------------------------------------------------------------- #

@api.get("/admin/status")
def admin_status() -> dict:
    source = _admin_source()
    return {"configured": source != "none", "source": source}

# --------------------------------------------------------------------------- #
# Admin password registration
# --------------------------------------------------------------------------- #

@api.post("/admin/register")
def admin_register(payload: dict = Body(...)) -> dict:
    source = _admin_source()
    if source == "env":
        return {"ok": False, "reason": "已通过环境变量配置，无法在界面注册"}
    if source == "db":
        return {"ok": False, "reason": "管理员密码已设置"}

    password = str((payload or {}).get("password", ""))
    ok, reason = _validate_password_strength(password)
    if not ok:
        return {"ok": False, "reason": reason}

    _save_password(password)
    _audit_log("password_set")
    return {"ok": True}

# --------------------------------------------------------------------------- #
# Admin password change
# --------------------------------------------------------------------------- #

@api.post("/admin/change")
def admin_change(payload: dict = Body(...)) -> dict:
    source = _admin_source()
    if source == "env":
        return {"ok": False, "reason": "已通过环境变量配置，无法在界面修改"}
    if source != "db":
        return {"ok": False, "reason": "管理员密码未配置"}

    old_password = str((payload or {}).get("old_password", ""))
    new_password = str((payload or {}).get("new_password", ""))

    if not _verify_password(old_password):
        _audit_log("password_change_failed")
        return {"ok": False, "reason": "原密码错误"}

    ok, reason = _validate_password_strength(new_password)
    if not ok:
        return {"ok": False, "reason": reason}

    _save_password(new_password)
    _audit_log("password_changed")
    return {"ok": True}

# --------------------------------------------------------------------------- #
# Admin verify (rate-limited, returns token in HttpOnly cookie)
# --------------------------------------------------------------------------- #

@api.post("/admin/verify")
def admin_verify(request: Request, payload: dict = Body(...)) -> Response:
    ip = _client_ip(request)
    allowed, remaining = _check_rate_limit(f"verify:{ip}")
    if not allowed:
        _audit_log("rate_limited", ip)
        return JSONResponse(
            {"ok": False, "reason": "尝试次数过多，请 15 分钟后再试"},
            status_code=429,
            headers={"Retry-After": str(int(RATE_LIMIT_WINDOW))},
        )

    source = _admin_source()
    password = str((payload or {}).get("password", ""))

    if source == "none":
        return JSONResponse({"ok": False, "reason": "管理员密码未配置"}, status_code=400)

    if not _verify_password(password):
        _audit_log("login_failed", ip)
        return JSONResponse(
            {"ok": False, "reason": "密码错误", "remaining": remaining},
            status_code=401,
        )

    token = _generate_token()
    _audit_log("login_success", ip)

    # Token in HttpOnly cookie; Secure=True only when request is over HTTPS
    response = JSONResponse({"ok": True, "token": token})
    response.set_cookie(
        key="sb_admin_token",
        value=token,
        httponly=True,
        secure=_is_https(request),
        samesite="lax",
        max_age=_ADMIN_TOKEN_TTL_SECONDS,
        path="/",
    )
    return response

# --------------------------------------------------------------------------- #
# Token revocation
# --------------------------------------------------------------------------- #

@api.post("/admin/revoke")
def admin_revoke(request: Request, payload: dict = Body(...)) -> dict:
    # Token can come from cookie or JSON body
    token = str((payload or {}).get("token", "")) or request.cookies.get("sb_admin_token", "")

    if not token or not _verify_token(token):
        return {"ok": False, "reason": "未授权"}

    ok = _revoke_token(token)
    _audit_log("token_revoked")
    return {"ok": ok}

# --------------------------------------------------------------------------- #
# Admin config (personalize + theme)
# --------------------------------------------------------------------------- #

def _load_admin_json() -> tuple[dict, float]:
    """Load arbitrary admin JSON data from DB (not sensitive secrets).
    Returns (data_dict, updated_at_timestamp).
    """
    conn = _get_db()
    try:
        row = conn.execute("SELECT value, updated_at FROM admin_config WHERE key='data'").fetchone()
        if not row:
            return {}, 0.0
        return json.loads(row["value"]), float(row["updated_at"])
    except Exception:
        return {}, 0.0
    finally:
        conn.close()

def _save_admin_json(data: dict, updated_at: float) -> None:
    conn = _get_db()
    try:
        conn.execute(
            "INSERT OR REPLACE INTO admin_config (key, value, updated_at) VALUES ('data', ?, ?)",
            (json.dumps(data), updated_at),
        )
        conn.commit()
    finally:
        conn.close()

def _token_from_request(request: Request) -> Optional[str]:
    return request.cookies.get("sb_admin_token") or str((request.query_params or {}).get("token", ""))

def _require_admin(request: Request) -> tuple[bool, dict]:
    """Returns (ok, response_dict). If ok=False, response_dict is the error response."""
    token = _token_from_request(request)
    if not token or not _verify_token(token):
        return False, {"ok": False, "reason": "未授权"}
    return True, {}

@api.get("/admin/config")
def admin_config(request: Request) -> dict:
    ok, err = _require_admin(request)
    if not ok:
        raise HTTPException(status_code=401, detail=err)

    data, updated_at = _load_admin_json()
    return {"personalize": data.get("personalize", {}), "theme": data.get("theme", "dark"), "updated_at": updated_at}

@api.post("/admin/config")
def admin_config_update(request: Request, payload: dict = Body(...)) -> dict:
    ok, err = _require_admin(request)
    if not ok:
        raise HTTPException(status_code=401, detail=err)

    client_updated_at = float(payload.get("updated_at", 0) or 0)
    current_data, server_updated_at = _load_admin_json()

    # Last-write-wins: only accept update if client timestamp >= server timestamp
    if client_updated_at < server_updated_at:
        _audit_log("config_update_rejected_stale", f"client_ts={client_updated_at} server_ts={server_updated_at}")
        return {"ok": False, "reason": "数据已过期，请刷新后重试", "updated_at": server_updated_at}

    personalize = payload.get("personalize")
    if isinstance(personalize, dict):
        current_data["personalize"] = personalize
    theme = payload.get("theme")
    if theme in ("dark", "light"):
        current_data["theme"] = theme

    new_updated_at = time.time()
    _save_admin_json(current_data, new_updated_at)
    return {"ok": True, "updated_at": new_updated_at}

# --------------------------------------------------------------------------- #
# App discovery
# --------------------------------------------------------------------------- #

def _discover_apps(apps_dir: Path, href_prefix: str = "/apps") -> list[dict]:
    items: list[dict] = []
    if not apps_dir.exists():
        return items

    for child in sorted(apps_dir.iterdir()):
        if not child.is_dir():
            continue
        index_html = child / "index.html"
        if not index_html.is_file():
            continue
        name = child.name
        prefix = href_prefix.rstrip("/")

        meta_file = child / "meta.json"
        meta = {}
        if meta_file.is_file():
            try:
                meta = json.loads(meta_file.read_text(encoding="utf-8")) or {}
            except (json.JSONDecodeError, OSError):
                meta = {}

        items.append({
            "id": name,
            "label": meta.get("title") or name,
            "href": f"{prefix}/{name}/index.html",
            "icon": meta.get("icon") or "",
            "tags": meta.get("tags") or [],
            "order": int(meta.get("order", 999)) if str(meta.get("order", "")).isdigit() else 999,
        })

    items.sort(key=lambda x: (x["order"], x["label"].lower()))
    return items

# --------------------------------------------------------------------------- #
# Navigation
# --------------------------------------------------------------------------- #

@api.get("/nav")
def nav() -> dict:
    _maybe_cleanup_tokens()
    _maybe_cleanup_results()

    start = time.perf_counter()
    items = _discover_apps(APPS_DIR)
    elapsed_ms = (time.perf_counter() - start) * 1000.0
    logger.debug("nav: %d items in %.1fms", len(items), elapsed_ms)
    return {"items": items}

# --------------------------------------------------------------------------- #
# Static export (DOM-based path rewriting using proper HTML parsing)
# --------------------------------------------------------------------------- #

def _export_static_site(project_root: Path, *, personalize: Optional[dict] = None, theme: Optional[str] = None) -> Path:
    apps_items = _discover_apps(APPS_DIR, href_prefix="apps")

    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    out_dir = RESULT_DIR / f"export-{stamp}"
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "apps").mkdir(parents=True, exist_ok=True)

    # Copy apps
    for item in apps_items:
        src = APPS_DIR / item["id"]
        dst = out_dir / "apps" / item["id"]
        if src.exists():
            shutil.copytree(src, dst, dirs_exist_ok=True)

    # Write manifest
    manifest = {"items": apps_items}
    (out_dir / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8"
    )

    # Build embedded data scripts
    embeds: list[str] = []
    embeds.append(
        '    <script type="application/json" id="sb-manifest">'
        + json.dumps(manifest, ensure_ascii=False)
        + "</script>\n"
    )
    if isinstance(personalize, dict) and personalize:
        embeds.append(
            '    <script type="application/json" id="sb-personalize">'
            + json.dumps(personalize, ensure_ascii=False)
            + "</script>\n"
        )
    if theme in ("dark", "light"):
        embeds.append(
            '    <script type="application/json" id="sb-theme">'
            + json.dumps(theme)
            + "</script>\n"
        )
    embed = "".join(embeds)

    # Rewrite index.html using proper HTML parser
    frontend_dir = project_root / "frontend"
    raw_html = (frontend_dir / "index.html").read_text(encoding="utf-8")

    if _HAS_BS4:
        soup = _BeautifulSoup(raw_html, "html.parser")
        # Path attributes that may contain absolute paths
        PATH_ATTRS = ("href", "src", "action", "data", "poster", "background")
        for tag in soup.find_all():
            if not hasattr(tag, "get"):
                continue  # skip Comment, Doctype, NavigableString nodes
            for attr in PATH_ATTRS:
                val = tag.get(attr)
                if val and isinstance(val, str) and val.startswith("/") and not val.startswith("//"):
                    tag[attr] = "." + val
        # Inject embedded data before the main script tag
        # (needle matching fails because bs4 reformats HTML and strips leading whitespace)
        app_script = soup.find("script", src=lambda v: v and "app.js" in v)
        if app_script:
            embed_soup = _BeautifulSoup(embed, "html.parser")
            for node in embed_soup.find_all(recursive=False):
                app_script.insert_before(node)
        index_html = str(soup)
    else:
        # Fallback: regex that only rewrites known-safe attributes inside known tags
        def rewrite_tag(match):
            tag = match.group(1)
            attrs_str = match.group(2)

            def rewrite_attr(attr_match):
                attr_name = attr_match.group(1)
                quote = attr_match.group(2)
                value = attr_match.group(3)
                if attr_name.lower() in ("href", "src", "action", "data") and \
                   value and value.startswith("/") and not value.startswith("//"):
                    value = "." + value
                return f'{attr_name}={quote}{value}{quote}'

            rewritten_attrs = re.sub(r'(\w+)=(["\'])([^"\']*)', rewrite_attr, attrs_str)
            return f'<{tag}{rewritten_attrs}>'

        index_html = re.sub(
            r'<(?!(?:!--|!DOCTYPE))(\w+)\b([^>]*)>',
            rewrite_tag,
            raw_html,
            flags=re.IGNORECASE,
        )

    # Fallback: inject before </body> to avoid whitespace-sensitive needle matching
    if not _HAS_BS4:
        index_html = index_html.replace("</body>", embed + "</body>", 1)

    (out_dir / "index.html").write_text(index_html, encoding="utf-8")
    shutil.copy2(frontend_dir / "styles.css", out_dir / "styles.css")
    shutil.copy2(frontend_dir / "app.js", out_dir / "app.js")

    return out_dir

# --------------------------------------------------------------------------- #
# Export endpoints
# --------------------------------------------------------------------------- #

@api.post("/export")
def export_post(payload: dict = Body(default=None)) -> dict:
    out_dir = _export_static_site(
        PROJECT_ROOT,
        personalize=payload.get("personalize") if payload else None,
        theme=payload.get("theme") if payload else None,
    )
    return {"ok": True, "out_dir": str(out_dir)}

@api.get("/export")
def export_get() -> dict:
    out_dir = _export_static_site(PROJECT_ROOT)
    return {"ok": True, "out_dir": str(out_dir)}

@api.get("/export/zip")
def export_zip(request: Request) -> Response:
    # Load admin personalize/theme from DB for the exported site
    try:
        data, _ = _load_admin_json()
        personalize = data.get("personalize")
        theme = data.get("theme", "dark")
    except Exception:
        personalize = None
        theme = "dark"

    out_dir = _export_static_site(PROJECT_ROOT, personalize=personalize, theme=theme)

    unique = secrets.token_hex(4)
    zip_base = out_dir.parent / f"export-{out_dir.name}-{unique}"
    zip_path = shutil.make_archive(str(zip_base), "zip", str(out_dir))
    zip_path = Path(zip_path)

    response = FileResponse(
        path=zip_path,
        filename=zip_path.name,
        media_type="application/zip",
    )
    # Clean up zip after response is generated (best-effort)
    # The file will be cleaned up by _cleanup_old_exports eventually
    return response

# --------------------------------------------------------------------------- #
# Mount static files
# --------------------------------------------------------------------------- #

APPS_DIR.mkdir(parents=True, exist_ok=True)
app.include_router(api)

app.mount("/apps", NoCacheStaticFiles(directory=str(APPS_DIR), html=True), name="apps")
app.mount("/", NoCacheStaticFiles(directory=str(FRONTEND_DIR), html=True), name="frontend")

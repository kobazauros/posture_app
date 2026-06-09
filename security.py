"""Token encoding and session registry helpers for posture app auth."""

import os
import time
import base64
import hashlib
import json
from threading import Lock
from dotenv import load_dotenv

# Заставляем Python прочитать файл .env в текущей директории
load_dotenv()

# Вытаскиваем секретный ключ.
SECRET_WEB_TOKEN = os.getenv("SECRET_WEB_TOKEN", "")

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
SESSION_REGISTRY_PATH = os.path.join(BASE_DIR, "results", "session_registry.json")
_REGISTRY_LOCK = Lock()

def encode_token(user_id, lifetime_sec=None):
    """Encode a user id into a token.

    If `lifetime_sec` is None the token is created without an expiry
    marker and considered valid until the session is explicitly closed.
    For compatibility we keep the `user_id:expires` format and use
    expires=0 to indicate "no expiry".
    """
    if lifetime_sec is None:
        expires = 0
    else:
        expires = int(time.time()) + lifetime_sec

    plain_text = f"{user_id}:{expires}"
    
    key_hash = hashlib.sha256(SECRET_WEB_TOKEN.encode()).digest()
    raw_bytes = plain_text.encode()
    cipher_bytes = bytearray(b ^ key_hash[i % len(key_hash)] for i, b in enumerate(raw_bytes))
    
    return base64.urlsafe_b64encode(cipher_bytes).decode().replace('=', '')

def decode_token(token_str):
    """Decode a token and return the user id plus expiry timestamp."""
    # ... твой код дешифровки (без изменений) ...
    try:
        rem = len(token_str) % 4
        if rem:
            token_str += '=' * (4 - rem)
            
        cipher_bytes = base64.urlsafe_b64decode(token_str.encode())
        key_hash = hashlib.sha256(SECRET_WEB_TOKEN.encode()).digest()
        plain_bytes = bytearray(b ^ key_hash[i % len(key_hash)] for i, b in enumerate(cipher_bytes))
        
        user_id, expires = plain_bytes.decode().split(':')
        try:
            exp_int = int(expires)
        except Exception:
            exp_int = 0
        # exp_int == 0 means "no expiry" (token valid until explicit close)
        return user_id, exp_int
    except Exception:
        return None, None


def close_session_by_session_id(session_id):
    """Close and remove a session by its `session_id` from the registry.

    Returns True when an entry was removed, False otherwise.
    """
    if not session_id:
        return False
    registry = load_session_registry()
    for user_id, entry in list(registry.items()):
        if isinstance(entry, dict) and entry.get("session_id") == session_id:
            registry.pop(user_id, None)
            save_session_registry(registry)
            return True
    return False


def close_session_by_client_id(client_id):
    """Close and remove a session by `client_id` as a fallback.

    Returns True when an entry was removed, False otherwise.
    """
    if not client_id:
        return False
    registry = load_session_registry()
    for user_id, entry in list(registry.items()):
        if isinstance(entry, dict) and entry.get("client_id") == client_id:
            registry.pop(user_id, None)
            save_session_registry(registry)
            return True
    return False


def _ensure_registry_dir():
    """Create the session registry directory if needed."""
    os.makedirs(os.path.dirname(SESSION_REGISTRY_PATH), exist_ok=True)


def load_session_registry():
    """Load the session registry as a dictionary."""
    _ensure_registry_dir()
    try:
        with open(SESSION_REGISTRY_PATH, "r", encoding="utf-8") as file_handle:
            data = json.load(file_handle)
            return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def save_session_registry(registry):
    """Persist the session registry to disk."""
    _ensure_registry_dir()
    with _REGISTRY_LOCK:
        with open(SESSION_REGISTRY_PATH, "w", encoding="utf-8") as file_handle:
            json.dump(registry, file_handle, ensure_ascii=False, indent=2)


def register_token(user_id, token):
    """Store a newly issued token for a user id."""
    registry = load_session_registry()
    existing = registry.get(str(user_id)) if isinstance(registry, dict) else None
    # Preserve any existing claimed/session information for the same user_id
    # to avoid invalidating an active session when a new token is issued
    # (e.g., user pressed /start again). We only update the token value.
    if isinstance(existing, dict):
        existing['token'] = token
        registry[str(user_id)] = existing
    else:
        registry[str(user_id)] = {
            "token": token,
            "claimed": False,
            "session_id": None,
            "client_id": None,
            "claimed_at": None,
        }
    save_session_registry(registry)


def claim_token(token, client_id=None):
    """Mark a token as claimed and create a new session id."""
    user_id, expires = decode_token(token)
    if not user_id:
        return None, None

    registry = load_session_registry()
    entry = registry.get(user_id)
    if not entry or entry.get("token") != token or entry.get("claimed"):
        return None, None

    session_id = base64.urlsafe_b64encode(os.urandom(24)).decode().rstrip("=")
    entry["claimed"] = True
    entry["session_id"] = session_id
    if client_id:
        entry["client_id"] = client_id
    entry["claimed_at"] = int(time.time())
    registry[user_id] = entry
    save_session_registry(registry)
    return user_id, session_id


def restore_session(client_id):
    """Restore a claimed session for a known client id."""
    if not client_id:
        return None, None

    registry = load_session_registry()
    for user_id, entry in registry.items():
        if not isinstance(entry, dict):
            continue
        if entry.get("client_id") != client_id or not entry.get("claimed"):
            continue

        session_id = base64.urlsafe_b64encode(os.urandom(24)).decode().rstrip("=")
        entry["session_id"] = session_id
        entry["claimed_at"] = int(time.time())
        registry[user_id] = entry
        save_session_registry(registry)
        return user_id, session_id

    return None, None


def validate_session(session_id):
    """Validate a session id against the registry."""
    if not session_id:
        return None

    registry = load_session_registry()
    for user_id, entry in registry.items():
        if isinstance(entry, dict) and entry.get("session_id") == session_id and entry.get("claimed"):
            return user_id
    return None
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
SECRET_WEB_TOKEN = os.getenv("SECRET_WEB_TOKEN")

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
SESSION_REGISTRY_PATH = os.path.join(BASE_DIR, "results", "session_registry.json")
_REGISTRY_LOCK = Lock()

def encode_token(user_id, lifetime_sec=3600):
    # ... твой код шифрования (без изменений) ...
    expires = int(time.time()) + lifetime_sec
    plain_text = f"{user_id}:{expires}"
    
    key_hash = hashlib.sha256(SECRET_WEB_TOKEN.encode()).digest()
    raw_bytes = plain_text.encode()
    cipher_bytes = bytearray(b ^ key_hash[i % len(key_hash)] for i, b in enumerate(raw_bytes))
    
    return base64.urlsafe_b64encode(cipher_bytes).decode().replace('=', '')

def decode_token(token_str):
    # ... твой код дешифровки (без изменений) ...
    try:
        rem = len(token_str) % 4
        if rem:
            token_str += '=' * (4 - rem)
            
        cipher_bytes = base64.urlsafe_b64decode(token_str.encode())
        key_hash = hashlib.sha256(SECRET_WEB_TOKEN.encode()).digest()
        plain_bytes = bytearray(b ^ key_hash[i % len(key_hash)] for i, b in enumerate(cipher_bytes))
        
        user_id, expires = plain_bytes.decode().split(':')
        return user_id, int(expires)
    except Exception:
        return None, None


def _ensure_registry_dir():
    os.makedirs(os.path.dirname(SESSION_REGISTRY_PATH), exist_ok=True)


def load_session_registry():
    _ensure_registry_dir()
    try:
        with open(SESSION_REGISTRY_PATH, "r", encoding="utf-8") as file_handle:
            data = json.load(file_handle)
            return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def save_session_registry(registry):
    _ensure_registry_dir()
    with _REGISTRY_LOCK:
        with open(SESSION_REGISTRY_PATH, "w", encoding="utf-8") as file_handle:
            json.dump(registry, file_handle, ensure_ascii=False, indent=2)


def register_token(user_id, token):
    registry = load_session_registry()
    registry[str(user_id)] = {
        "token": token,
        "claimed": False,
        "session_id": None,
        "client_id": None,
        "claimed_at": None,
    }
    save_session_registry(registry)


def claim_token(token, client_id=None):
    user_id, expires = decode_token(token)
    if not user_id:
        return None, None

    registry = load_session_registry()
    entry = registry.get(str(user_id))
    if not entry or entry.get("token") != token or entry.get("claimed"):
        return None, None

    session_id = base64.urlsafe_b64encode(os.urandom(24)).decode().rstrip("=")
    entry["claimed"] = True
    entry["session_id"] = session_id
    if client_id:
        entry["client_id"] = client_id
    entry["claimed_at"] = int(time.time())
    registry[str(user_id)] = entry
    save_session_registry(registry)
    return user_id, session_id


def restore_session(client_id):
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
    if not session_id:
        return None

    registry = load_session_registry()
    for user_id, entry in registry.items():
        if isinstance(entry, dict) and entry.get("session_id") == session_id and entry.get("claimed"):
            return user_id
    return None
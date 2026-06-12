import {
    CLIENT_STORAGE_KEY,
    SESSION_STORAGE_KEY,
    TOKEN_STORAGE_KEY,
    state,
    url,
} from './state.js?v=6';

/**
 * Reads a cookie value by name.
 * @param {string} name - Cookie name.
 * @returns {string|null} The decoded cookie value, or null when missing.
 */
function getCookie(name) {
    const match = document.cookie.match(new RegExp(`(?:^|; )${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}=([^;]*)`));
    return match ? decodeURIComponent(match[1]) : null;
}

/**
 * Writes a cookie value with the provided max-age.
 * @param {string} name - Cookie name.
 * @param {string} value - Cookie value.
 * @param {number} maxAgeSeconds - Cookie lifetime in seconds.
 */
function setCookie(name, value, maxAgeSeconds) {
    document.cookie = `${name}=${encodeURIComponent(value)}; path=/; max-age=${maxAgeSeconds}; samesite=lax`;
}

/**
 * Returns the current client id, creating and persisting one when needed.
 * @returns {string} Stable client identifier.
 */
export function getOrCreateClientId() {
    try {
        const existingClientId = getCookie(CLIENT_STORAGE_KEY) || localStorage.getItem(CLIENT_STORAGE_KEY);
        if (existingClientId) {
            try {
                localStorage.setItem(CLIENT_STORAGE_KEY, existingClientId);
            } catch (err) {
                console.warn('[auth] unable to mirror client id into localStorage', err);
            }
            state.clientId = existingClientId;
            return existingClientId;
        }

        const nextClientId = (window.crypto && typeof window.crypto.randomUUID === 'function')
            ? window.crypto.randomUUID()
            : `client_${Date.now()}_${Math.floor(Math.random() * 1000000)}`;

        setCookie(CLIENT_STORAGE_KEY, nextClientId, 60 * 60 * 24 * 365);
        localStorage.setItem(CLIENT_STORAGE_KEY, nextClientId);
        state.clientId = nextClientId;
        return nextClientId;
    } catch (err) {
        console.warn('[auth] unable to persist client id', err);
        const fallbackClientId = `client_${Date.now()}_${Math.floor(Math.random() * 1000000)}`;
        state.clientId = fallbackClientId;
        return fallbackClientId;
    }
}

/**
 * Restores auth inputs from the URL or session storage.
 * @returns {void}
 */
export function bootstrapAuthFromUrl() {
    if (state.token) {
        try {
            sessionStorage.setItem(TOKEN_STORAGE_KEY, state.token);
            // Wipe any stale session that belonged to a previous (possibly different) account.
            sessionStorage.removeItem(SESSION_STORAGE_KEY);
        } catch (err) {
            console.warn('[auth] unable to persist token in sessionStorage', err);
        }

        url.searchParams.delete('t');
        window.history.replaceState({}, document.title, url.pathname + url.search + url.hash);
        return;
    }

    try {
        state.token = sessionStorage.getItem(TOKEN_STORAGE_KEY);
        state.sessionId = sessionStorage.getItem(SESSION_STORAGE_KEY);
    } catch (err) {
        console.warn('[auth] unable to read token from sessionStorage', err);
        state.token = null;
        state.sessionId = null;
    }
}

/**
 * Updates the start button to reflect auth readiness.
 * @param {boolean} enabled - Unused flag kept for call-site clarity.
 * @param {string} message - Button label to show.
 * @returns {void}
 */
export function setAuthState(enabled, message) {
    const startBtn = document.getElementById('to-camera-btn');
    if (startBtn) {
        startBtn.disabled = false;
        startBtn.style.display = 'block';
        startBtn.textContent = message || 'НАЧАТЬ';
    }
}

/**
 * Restores or claims a backend session for the current client.
 * @returns {Promise<Object|boolean>} Authentication payload or false.
 */
export async function initializeAuthSession() {
    // Prioritize token claim if a token is present in the state.
    // IMPORTANT: always claim a new token even if a sessionId is already cached —
    // this handles the dual-SIM / dual-account case where two different Telegram
    // accounts open different links on the same device. Without this check the
    // second account would silently inherit the first account's session.
    if (state.token) {
        // Clear any previously cached session — a new token means a new (possibly
        // different) account is signing in on this device.
        state.sessionId = null;
        try {
            sessionStorage.removeItem(SESSION_STORAGE_KEY);
        } catch (_) { /* ignore */ }
        try {
            const response = await fetch('session/claim', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ token: state.token, client_id: state.clientId }),
            });

            const payload = await response.json().catch(() => ({}));
            if (response.ok && payload.session_id) {
                state.sessionId = payload.session_id;
                try {
                    sessionStorage.setItem(SESSION_STORAGE_KEY, state.sessionId);
                    sessionStorage.removeItem(TOKEN_STORAGE_KEY);
                    setCookie(CLIENT_STORAGE_KEY, state.clientId, 60 * 60 * 24 * 365);
                } catch (err) {
                    console.warn('[auth] unable to persist session id', err);
                }

                state.token = null;
                url.searchParams.delete('t');
                window.history.replaceState({}, document.title, url.pathname + url.search + url.hash);
                setAuthState(true, 'НАЧАТЬ');

                // Save state
                state.isRegistered = payload.is_registered;
                state.role = payload.role;
                state.firstName = payload.first_name;

                return payload;
            } else {
                console.warn('[auth] session claim failed', payload);
                // If a token was provided but failed to claim, DO NOT fall back to restore.
                // This prevents a second Telegram account from inheriting the first account's session.
                return false;
            }
        } catch (err) {
            console.warn('[auth] session claim request failed', err);
            return false;
        }
    }

    // No new token in URL — if we already have a valid sessionId in memory
    // (e.g. fast page reload within the same browser tab / Telegram session),
    // return it immediately without hitting the network.
    if (state.sessionId) {
        setAuthState(true, 'НАЧАТЬ');
        return { session_id: state.sessionId, is_registered: state.isRegistered, role: state.role, first_name: state.firstName };
    }

    // Proceed to attempt restore for this client if no token or claim failed.
    try {
        const restoredResponse = await fetch('session/restore', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ client_id: state.clientId }),
        });
        const restoredPayload = await restoredResponse.json().catch(() => ({}));

        if (restoredResponse.ok && restoredPayload.session_id) {
            state.sessionId = restoredPayload.session_id;
            try {
                sessionStorage.setItem(SESSION_STORAGE_KEY, state.sessionId);
            } catch (err) {
                console.warn('[auth] unable to persist restored session id', err);
            }
            setAuthState(true, 'НАЧАТЬ');

            // Save state
            state.isRegistered = restoredPayload.is_registered;
            state.role = restoredPayload.role;
            state.firstName = restoredPayload.first_name;

            return restoredPayload;
        }
    } catch (err) {
        console.warn('[auth] session restore request failed', err);
    }

    return false;
}

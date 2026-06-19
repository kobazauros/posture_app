import { TELEGRAM_BOT_USERNAME, TOKEN_STORAGE_KEY, SESSION_STORAGE_KEY, state } from './state.js?v=21';
import { stopCamera } from './camera.js?v=21';

/**
 * Clears the auto-redirect timer and countdown state.
 * @returns {void}
 */
export function clearAutoRedirect() {
    if (state.redirectTimer) {
        clearTimeout(state.redirectTimer);
        state.redirectTimer = null;
    }
    if (state.redirectInterval) {
        clearInterval(state.redirectInterval);
        state.redirectInterval = null;
    }

    const countdownEl = document.getElementById('sending-countdown');
    if (countdownEl) countdownEl.style.display = 'none';
}

/**
 * Navigates the user back to the Telegram bot.
 * @returns {void}
 */
const CLOSE_DELAY_MS = 250;
const DEEP_LINK_DELAY_MS = 800;
const FINAL_FALLBACK_DELAY_MS = 1200;

/**
 * Attempt to close the current window, and if that fails perform a
 * best-effort redirect back to the Telegram bot (deep link, then web fallback).
 * @returns {void}
 */
export function closeOrRedirect() {
    const deepLink = `tg://resolve?domain=${TELEGRAM_BOT_USERNAME}`;
    const webLink = `https://t.me/${TELEGRAM_BOT_USERNAME}`;

    try { window.close(); } catch (err) { /* ignore */ }

    const attemptRedirects = () => {
        try { window.location.href = deepLink; } catch (err) { /* ignore */ }

        setTimeout(() => {
            try { window.location.href = webLink; } catch (err) { /* ignore */ }

            setTimeout(() => {
                try { window.close(); } catch (err) { /* ignore */ }
            }, FINAL_FALLBACK_DELAY_MS);
        }, DEEP_LINK_DELAY_MS);
    };

    setTimeout(() => {
        if (!window.closed) attemptRedirects();
    }, CLOSE_DELAY_MS);
}

/**
 * Shows the send/status screen for loading, success, or error states.
 * @param {string} stateName - One of loading, final, success, or error.
 * @param {object} [payload={}] - Optional payload for error messaging.
 * @returns {void}
 */
export function showSendingState(stateName, payload = {}) {
    const title = document.getElementById('sending-title');
    const message = document.getElementById('sending-message');
    const okBtn = document.getElementById('ok-btn');

    const prev = document.getElementById('preview-screen');
    if (prev) prev.style.display = 'none';
    const cam = document.getElementById('camera-screen');
    if (cam) cam.style.display = 'none';

    try {
        stopCamera();
    } catch (err) {
        console.warn('[camera] stopCamera failed', err);
    }

    const sending = document.getElementById('sending-screen');
    if (sending) sending.style.display = 'flex';

    if (stateName === 'loading') {
        if (title) title.textContent = 'Фотографии отправлены на анализ';
        if (message) {
            message.textContent = 'Снимки переданы в систему анализа. ИИ оценивает ракурсы, после чего специалист проверит результат и подготовит персональные рекомендации по коррекции осанки. Обычно это занимает 10–15 секунд. Пожалуйста, ожидайте ответ в боте.';
        }
        if (okBtn) okBtn.style.display = 'none';
        return;
    }

    if (stateName === 'final') {
        clearAutoRedirect();

        if (title) title.textContent = 'Фотографии отправлены на анализ';
        if (message) {
            message.textContent = 'Снимки переданы в систему анализа для оценки Вашей осанки. Рекомендуемый список упражнений будет подготовлен специалистом и отправлен Вам через бот.';
        }

        if (okBtn) {
            okBtn.style.display = 'block';
            okBtn.textContent = 'OK';
            okBtn.onclick = () => {
                clearAutoRedirect();
                closeOrRedirect();
            };
        }

        const countdownEl = document.getElementById('sending-countdown');
        let seconds = 5;
        if (countdownEl) {
            countdownEl.style.display = 'block';
            countdownEl.textContent = `Вы будете перенаправлены в бот через ${seconds} сек.`;
            state.redirectInterval = setInterval(() => {
                seconds -= 1;
                if (seconds <= 0) {
                    countdownEl.textContent = 'Перенаправление...';
                    clearAutoRedirect();
                } else {
                    countdownEl.textContent = `Вы будете перенаправлены в бот через ${seconds} сек.`;
                }
            }, 1000);
        }

        state.redirectTimer = setTimeout(() => {
            closeOrRedirect();
        }, 5000);
        return;
    }

    if (stateName === 'success') {
        showSendingState('final', payload);
        return;
    }

    if (stateName === 'error') {
        if (title) title.textContent = 'Не удалось завершить отправку';
        if (message) {
            message.textContent = payload.message || 'Попробуйте отправить фотографии еще раз.';
        }
        if (okBtn) {
            okBtn.style.display = 'block';
            okBtn.textContent = 'OK';
            okBtn.onclick = () => {
                clearAutoRedirect();
                closeOrRedirect();
            };
        }
    }
}

/**
 * Posts captured photos and form data to the backend upload endpoint.
 * @returns {void}
 */
export function sendPhotosToServer() {
    console.log('[send] sendPhotosToServer() start, finalPhotos:', state.finalPhotos.length);

    const nbtn = document.getElementById('next-step-btn');
    if (nbtn) {
        nbtn.textContent = 'ОТПРАВКА...';
        nbtn.disabled = true;
    }

    const rbtn = document.getElementById('retake-btn');
    if (rbtn) rbtn.disabled = true;

    try {
        showSendingState('final');
    } catch (err) {
        console.error('[send] showSendingState error', err);
    }

    const genderInput = document.querySelector('input[name="gender"]:checked');
    const selectedGender = genderInput ? genderInput.value : 'male';

    fetch('upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            session_id: state.sessionId || sessionStorage.getItem(SESSION_STORAGE_KEY),
            client_id: state.clientId || localStorage.getItem('posture_app_client_id'),
            token: sessionStorage.getItem(TOKEN_STORAGE_KEY) || state.token,
            user_id: state.userId,
            analysis_id: state.analysisId,
            user_data: {
                age: document.getElementById('user-age').value,
                weight: document.getElementById('user-weight').value,
                height: document.getElementById('user-height').value,
                gender: selectedGender,
                patient_first_name: document.getElementById('patient-first-name') ? document.getElementById('patient-first-name').value : undefined,
                patient_last_name: document.getElementById('patient-last-name') ? document.getElementById('patient-last-name').value : undefined
            },
            images: state.finalPhotos,
            orientations: state.finalOrientations,
        }),
    })
        .then(async (response) => {
            if (!response.ok) throw new Error('Ошибка сервера');
            const payload = await response.json();

            if (payload.analysis_error) {
                console.warn('[send] server returned analysis_error', payload.analysis_error);
            } else {
                console.log('[send] upload accepted in background.');
            }

            // Close session immediately after the server accepted the upload.
            // This is the actual lifecycle boundary for the capture session.
            try {
                const closeResponse = await fetch('session/close', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ session_id: state.sessionId, client_id: state.clientId }),
                });
                const closePayload = await closeResponse.json().catch(() => ({}));
                if (!closeResponse.ok || closePayload.status !== 'success') {
                    console.warn('[session] close after upload failed', closeResponse.status, closePayload);
                }
            } catch (err) {
                console.warn('[session] close after upload request failed', err);
            }

            try {
                sessionStorage.removeItem(SESSION_STORAGE_KEY);
                sessionStorage.removeItem(TOKEN_STORAGE_KEY);
                // Clear prefill data ONLY for specialists since they add different clients
                if (state.role === 'specialist-approved') {
                    sessionStorage.removeItem('posture_app_analysis');
                }
            } catch (err) {
                // ignore
            }
            state.sessionId = null;
            state.token = null;

            // Post a debug log noting upload was sent and server accepted
            try {
                const body = JSON.stringify({
                    client_id: state.clientId,
                    session_id: state.sessionId,
                    event: 'upload_sent',
                    payload: { saved_count: payload.saved_count || null }
                });
                if (navigator && typeof navigator.sendBeacon === 'function') {
                    const blob = new Blob([body], { type: 'application/json' });
                    navigator.sendBeacon('debug/log', blob);
                } else {
                    fetch('debug/log', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body }).catch(() => { });
                }
            } catch (err) {
                // ignore
            }
        })
        .catch((err) => {
            console.error(err);
        });
}

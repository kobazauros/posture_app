// Токен из URL используется один раз для первого входа.
// Для повторного открытия после закрытия браузера используется постоянный client_id.
const TOKEN_STORAGE_KEY = 'posture_app_token';
const SESSION_STORAGE_KEY = 'posture_app_session_id';
const CLIENT_STORAGE_KEY = 'posture_app_client_id';
const url = new URL(window.location.href);
let token = url.searchParams.get('t');
let sessionId = null;
let clientId = null;

function getCookie(name) {
    const match = document.cookie.match(new RegExp(`(?:^|; )${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}=([^;]*)`));
    return match ? decodeURIComponent(match[1]) : null;
}

function setCookie(name, value, maxAgeSeconds) {
    document.cookie = `${name}=${encodeURIComponent(value)}; path=/; max-age=${maxAgeSeconds}; samesite=lax`;
}

function getOrCreateClientId() {
    try {
        const existingClientId = getCookie(CLIENT_STORAGE_KEY) || localStorage.getItem(CLIENT_STORAGE_KEY);
        if (existingClientId) {
            try {
                localStorage.setItem(CLIENT_STORAGE_KEY, existingClientId);
            } catch (err) {
                console.warn('[auth] unable to mirror client id into localStorage', err);
            }
            return existingClientId;
        }
        const nextClientId = (window.crypto && typeof window.crypto.randomUUID === 'function')
            ? window.crypto.randomUUID()
            : `client_${Date.now()}_${Math.floor(Math.random() * 1000000)}`;
        setCookie(CLIENT_STORAGE_KEY, nextClientId, 60 * 60 * 24 * 365);
        localStorage.setItem(CLIENT_STORAGE_KEY, nextClientId);
        return nextClientId;
    } catch (err) {
        console.warn('[auth] unable to persist client id', err);
        return `client_${Date.now()}_${Math.floor(Math.random() * 1000000)}`;
    }
}

clientId = getOrCreateClientId();

if (token) {
    try {
        sessionStorage.setItem(TOKEN_STORAGE_KEY, token);
    } catch (err) {
        console.warn('[auth] unable to persist token in sessionStorage', err);
    }
    url.searchParams.delete('t');
    window.history.replaceState({}, document.title, url.pathname + url.search + url.hash);
} else {
    try {
        token = sessionStorage.getItem(TOKEN_STORAGE_KEY);
        sessionId = sessionStorage.getItem(SESSION_STORAGE_KEY);
    } catch (err) {
        console.warn('[auth] unable to read token from sessionStorage', err);
        token = null;
        sessionId = null;
    }
}

function setAuthState(enabled, message) {
    const startBtn = document.getElementById('to-camera-btn');
    if (startBtn) {
        startBtn.disabled = false;
        startBtn.style.display = 'block';
        startBtn.textContent = message || 'НАЧАТЬ';
    }
}

// Получаем ID из URL (например, mysite.com/?id=12345)
const userId = url.searchParams.get('id') || 'web_user_' + Math.floor(Math.random() * 1000);

let currentFacing = 'environment';
let stream = null;
let cameraZoom = 1;
let zoomSupport = false;
let pinchStartDistance = 0;
let pinchStartZoom = 1;
let cameraGesturesBound = false;

// Логика пошагового мастера
let currentStep = 0;
let maxSteps = 3; 
let finalPhotos = []; // Сюда складываем утвержденные фото

// Подсказки для статуса
const stepLabels = [
    "Шаг 1: Вид спереди",
    "Шаг 2: Левый бок",
    "Шаг 3: Правый бок",
    "Шаг 4: Вид со спины"
];

const MIN_CAMERA_ZOOM = 1;
const MAX_CAMERA_ZOOM = 4;
const FORM_LIMITS = {
    age: { min: 1, max: 120, label: 'возраст' },
    weight: { min: 20, max: 300, label: 'вес' },
    height: { min: 50, max: 250, label: 'рост' }
};
const TELEGRAM_BOT_USERNAME = 'PostureTestBot';
let redirectTimer = null;
let redirectInterval = null;

async function initializeAuthSession() {
    if (sessionId) {
        setAuthState(true, 'НАЧАТЬ');
        return true;
    }

    try {
        const restoredResponse = await fetch('/session/restore', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ client_id: clientId })
        });
        const restoredPayload = await restoredResponse.json().catch(() => ({}));
        if (restoredResponse.ok && restoredPayload.session_id) {
            sessionId = restoredPayload.session_id;
            try {
                sessionStorage.setItem(SESSION_STORAGE_KEY, sessionId);
            } catch (err) {
                console.warn('[auth] unable to persist restored session id', err);
            }
            setAuthState(true, 'НАЧАТЬ');
            return true;
        }
    } catch (err) {
        console.warn('[auth] session restore request failed', err);
    }

    if (!token) {
        return false;
    }

    try {
        const response = await fetch('/session/claim', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token, client_id: clientId })
        });

        const payload = await response.json().catch(() => ({}));
        if (!response.ok || !payload.session_id) {
            console.warn('[auth] session claim failed', payload);
            return false;
        }

        sessionId = payload.session_id;
        try {
            sessionStorage.setItem(SESSION_STORAGE_KEY, sessionId);
            sessionStorage.removeItem(TOKEN_STORAGE_KEY);
            setCookie(CLIENT_STORAGE_KEY, clientId, 60 * 60 * 24 * 365);
        } catch (err) {
            console.warn('[auth] unable to persist session id', err);
        }

        token = null;
        url.searchParams.delete('t');
        window.history.replaceState({}, document.title, url.pathname + url.search + url.hash);
        setAuthState(true, 'НАЧАТЬ');
        return true;
    } catch (err) {
        console.warn('[auth] session claim request failed', err);
        return false;
    }
}

const authReady = initializeAuthSession();

// Вектор нормали горизонта
let horizonNormal = { x: 0, y: 1, z: 0 };
const SMOOTHING = 0.08;

// ==========================================
// 1. ПЕРЕХОД К КАМЕРЕ И ИНИЦИАЛИЗАЦИЯ ШАГОВ
// ==========================================
    const _toCameraBtn = document.getElementById('to-camera-btn');
    async function _handleToCameraClick() {
        console.log('[ui] to-camera clicked');
        if (typeof DeviceOrientationEvent.requestPermission === 'function') {
            try {
                const permission = await DeviceOrientationEvent.requestPermission();
                if (permission !== 'granted') {
                    alert("Для работы уровня нужен доступ к датчикам.");
                    return;
                }
            } catch (err) {
                console.error(err);
            }
        }

        if (!validateForm()) {
            return;
        }
	
        const hasHelper = document.getElementById('has-helper');
        maxSteps = (hasHelper && hasHelper.checked) ? 4 : 3;
        currentStep = 0;
        finalPhotos = [];
        document.getElementById('step-indicator').innerText = stepLabels[currentStep];
	
        const formScreen = document.getElementById('form-screen');
        const cameraScreen = document.getElementById('camera-screen');
        if (formScreen) formScreen.style.display = 'none';
        if (cameraScreen) cameraScreen.style.display = 'block';
        startCamera();

        // Try to restore/claim auth in the background so camera start is never blocked.
        initializeAuthSession().catch((err) => {
            console.warn('[auth] background session init failed', err);
        });
    }
	
    if (_toCameraBtn) {
        _toCameraBtn.addEventListener('click', _handleToCameraClick);
        // Also listen for pointerdown to be more responsive on some devices
        _toCameraBtn.addEventListener('pointerdown', () => { console.log('[ui] to-camera pointerdown'); });
    } else {
        // Fallback: delegate clicks in case element isn't present when script ran
        document.addEventListener('click', (e) => {
            if (!e || !e.target) return;
            const t = e.target;
            if (t.id === 'to-camera-btn' || t.closest && t.closest('#to-camera-btn')) {
                console.log('[ui] delegated to-camera click');
                _handleToCameraClick();
            }
        });
    }

['user-age', 'user-weight', 'user-height'].forEach((fieldId) => {
    const field = document.getElementById(fieldId);
    if (!field) return;
    field.addEventListener('input', () => clearFieldError(fieldId));
    field.addEventListener('blur', () => validateSingleField(fieldId));
});

function getErrorId(fieldId) {
    return fieldId.replace('user-', '') + '-error';
}

function clearFieldError(fieldId) {
    const input = document.getElementById(fieldId);
    const error = document.getElementById(getErrorId(fieldId));
    if (input) input.classList.remove('invalid');
    if (error) error.textContent = '';
}

function setFieldError(fieldId, message) {
    const input = document.getElementById(fieldId);
    const error = document.getElementById(getErrorId(fieldId));
    if (input) input.classList.add('invalid');
    if (error) error.textContent = message;
}

function validateSingleField(fieldId) {
    const input = document.getElementById(fieldId);
    if (!input) return false;

    const limits = FORM_LIMITS[fieldId.replace('user-', '')];
    const rawValue = String(input.value || '').trim();

    if (!rawValue) {
        setFieldError(fieldId, `Укажите ${limits.label}.`);
        return false;
    }

    const value = Number(rawValue);
    if (!Number.isFinite(value)) {
        setFieldError(fieldId, `Введите корректный ${limits.label}.`);
        return false;
    }

    if (value < limits.min || value > limits.max) {
        setFieldError(fieldId, `${capitalizeFirstLetter(limits.label)} должен быть от ${limits.min} до ${limits.max}.`);
        return false;
    }

    clearFieldError(fieldId);
    return true;
}

function validateForm() {
    const ageOk = validateSingleField('user-age');
    const weightOk = validateSingleField('user-weight');
    const heightOk = validateSingleField('user-height');

    if (ageOk && weightOk && heightOk) {
        return true;
    }

    const firstInvalidId = ['user-age', 'user-weight', 'user-height'].find((fieldId) => {
        const field = document.getElementById(fieldId);
        return field && field.classList.contains('invalid');
    });

    if (firstInvalidId) {
        const field = document.getElementById(firstInvalidId);
        if (field) field.focus();
    }

    return false;
}

function capitalizeFirstLetter(text) {
    return text ? text.charAt(0).toUpperCase() + text.slice(1) : text;
}

// ==========================================
// 2. РАБОТА КАМЕРЫ И ЗУМА (Без изменений)
// ==========================================
async function startCamera() {
    if (stream) stream.getTracks().forEach(t => t.stop());
    
    try {
        stream = await navigator.mediaDevices.getUserMedia({ 
            video: { 
                facingMode: currentFacing,
                width: { ideal: 1280 },
                height: { ideal: 720 }
            } 
        });
        const video = document.getElementById('camera-feed');
        video.srcObject = stream;
        video.play();
        bindCameraGestures(video);
        cameraZoom = 1;
        updateZoomIndicator();
        applyCameraZoom(1);

        const track = stream.getVideoTracks()[0];
        const capabilities = track && typeof track.getCapabilities === 'function' ? track.getCapabilities() : {};
        zoomSupport = !!(capabilities && typeof capabilities.zoom !== 'undefined');
        initSensors();
    } catch (err) {
        alert("Камера недоступна. Убедитесь, что используете HTTPS.");
    }
}

function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
function getActiveVideoTrack() { return stream && stream.getVideoTracks ? stream.getVideoTracks()[0] : null; }

function applyVideoTransform() {
    const video = document.getElementById('camera-feed');
    if (!video) return;
    video.style.transform = cameraZoom > 1.01 ? `scale(${cameraZoom})` : '';
    updateZoomIndicator();
}

async function applyCameraZoom(nextZoom) {
    cameraZoom = clamp(nextZoom, MIN_CAMERA_ZOOM, MAX_CAMERA_ZOOM);
    const track = getActiveVideoTrack();
    const capabilities = track && typeof track.getCapabilities === 'function' ? track.getCapabilities() : {};

    if (track && zoomSupport && capabilities && typeof capabilities.zoom !== 'undefined') {
        try {
            await track.applyConstraints({ advanced: [{ zoom: cameraZoom }] });
            updateZoomIndicator();
            return;
        } catch (err) { zoomSupport = false; }
    }
    applyVideoTransform();
}

function updateZoomIndicator() {
    const label = document.getElementById('zoom-indicator');
    if (label) label.textContent = `Zoom ${cameraZoom.toFixed(cameraZoom >= 2 ? 0 : 1)}x`;
}

function getTouchDistance(touches) {
    const dx = touches[0].clientX - touches[1].clientX;
    const dy = touches[0].clientY - touches[1].clientY;
    return Math.hypot(dx, dy);
}

function bindCameraGestures(video) {
    if (cameraGesturesBound) return;
    cameraGesturesBound = true;

    video.addEventListener('touchstart', (event) => {
        if (event.touches.length === 2) {
            event.preventDefault();
            pinchStartDistance = getTouchDistance(event.touches);
            pinchStartZoom = cameraZoom;
        }
    }, { passive: false });

    video.addEventListener('touchmove', (event) => {
        if (event.touches.length === 2 && pinchStartDistance > 0) {
            event.preventDefault();
            const currentDistance = getTouchDistance(event.touches);
            applyCameraZoom(pinchStartZoom * (currentDistance / pinchStartDistance));
        }
    }, { passive: false });

    const finishPinch = () => { pinchStartDistance = 0; pinchStartZoom = cameraZoom; };
    video.addEventListener('touchend', finishPinch, { passive: true });
    video.addEventListener('touchcancel', finishPinch, { passive: true });
}

// ==========================================
// 3. СЪЕМКА И ПРЕДПРОСМОТР (Preview)
// ==========================================
document.getElementById('capture-btn').onclick = () => {
    const video = document.getElementById('camera-feed');
    const canvas = document.getElementById('capture-canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');
    const useDigitalZoom = !zoomSupport && cameraZoom > 1.01;
    
    if (currentFacing === 'user') {
        ctx.translate(canvas.width, 0);
        ctx.scale(-1, 1);
    }

    if (useDigitalZoom) {
        const cropWidth = video.videoWidth / cameraZoom;
        const cropHeight = video.videoHeight / cameraZoom;
        const cropX = (video.videoWidth - cropWidth) / 2;
        const cropY = (video.videoHeight - cropHeight) / 2;
        ctx.drawImage(video, cropX, cropY, cropWidth, cropHeight, 0, 0, canvas.width, canvas.height);
    } else {
        ctx.drawImage(video, 0, 0);
    }
    
    if (navigator.vibrate) navigator.vibrate(50);

    // ПОКАЗЫВАЕМ ПРЕДПРОСМОТР
    document.getElementById('preview-image').src = canvas.toDataURL('image/jpeg', 0.8);
    document.getElementById('preview-screen').style.display = 'flex';

    // Меняем текст кнопки, если это последнее фото
    // Обновляем состояние кнопки "Дальше / ОТПРАВИТЬ"
    const nextBtn = document.getElementById('next-step-btn');
    
    if (currentStep === maxSteps - 1) {
        // ЭТО ФИНАЛЬНЫЙ ШАГ
        nextBtn.innerText = "ОТПРАВИТЬ";
        
        // Надежно переключаем класс, если HTML изначально с `primary-btn`
        if (nextBtn.classList.contains('primary-btn')) {
            nextBtn.classList.replace('primary-btn', 'send-btn');
        } else {
            nextBtn.classList.add('send-btn');
        }
    } else {
        // ЭТО ПРОМЕЖУТОЧНЫЙ ШАГ
        nextBtn.innerText = "Дальше";
        
        // ВОЗВРАЩАЕМ base класс, если он был изменен на send-btn
        if (nextBtn.classList.contains('send-btn')) {
            nextBtn.classList.replace('send-btn', 'primary-btn');
        }
    }
};

document.getElementById('retake-btn').onclick = () => {
    // Скрываем предпросмотр, возвращаемся к камере
    document.getElementById('preview-screen').style.display = 'none';
};

document.getElementById('next-step-btn').onclick = () => {
    // Сохраняем утвержденное фото
    finalPhotos.push(document.getElementById('preview-image').src);

    if (currentStep < maxSteps - 1) {
        // ИДЕМ НА СЛЕДУЮЩИЙ ШАГ
        currentStep++;
        document.getElementById('step-indicator').innerText = stepLabels[currentStep];
        document.getElementById('preview-screen').style.display = 'none'; // Скрываем предпросмотр
    } else {
        // ФИНАЛ: ОТПРАВЛЯЕМ НА СЕРВЕР
        sendPhotosToServer();
    }
};

// ==========================================
// 4. ОТПРАВКА НА СЕРВЕР
// ==========================================
function sendPhotosToServer() {
    console.log('[send] sendPhotosToServer() start, finalPhotos:', finalPhotos.length);
    const nextBtn = document.getElementById('next-step-btn');
    if (nextBtn) { nextBtn.innerText = "ОТПРАВКА..."; nextBtn.disabled = true; }
    const retakeBtn = document.getElementById('retake-btn'); if (retakeBtn) retakeBtn.disabled = true;
    // Show final screen immediately. Upload continues in background.
    try { showSendingState('final'); } catch (err) { console.error('[send] showSendingState error', err); }

    // Ищем выбранный пол из радиокнопок
    const genderInput = document.querySelector('input[name="gender"]:checked');
    const selectedGender = genderInput ? genderInput.value : 'male';

    fetch('upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            session_id: sessionId,
            client_id: clientId,
            token: sessionStorage.getItem(TOKEN_STORAGE_KEY) || token,
            user_id: userId,
            user_data: {
                age: document.getElementById('user-age').value,
                weight: document.getElementById('user-weight').value,
                height: document.getElementById('user-height').value,
                gender: selectedGender
            },
            images: finalPhotos // Отправляем готовый массив из 3 или 4 фото
        })
    })
    .then(async (res) => {
        if (!res.ok) throw new Error("Ошибка сервера");
        const payload = await res.json();
        // We do NOT block UX waiting for server response and do not show analysis on web page.
        if (payload.analysis_error) {
            console.warn('[send] server returned analysis_error', payload.analysis_error);
        } else {
            console.log('[send] upload accepted in background.');
        }
    })
    .catch((err) => {
        console.error(err);
        // Keep current final screen UX even if background request fails.
    });
}

function showSendingState(state, payload = {}) {
    const previewScreen = document.getElementById('preview-screen');
    const cameraScreen = document.getElementById('camera-screen');
    const sendingScreen = document.getElementById('sending-screen');
    const title = document.getElementById('sending-title');
    const message = document.getElementById('sending-message');
    const okBtn = document.getElementById('ok-btn');

    console.log('[ui] showSendingState', state, payload ? Object.keys(payload) : null);
    if (previewScreen) previewScreen.style.display = 'none';
    if (cameraScreen) cameraScreen.style.display = 'none';
    // Ensure camera is fully stopped when we show final sending screen
    try { stopCamera(); } catch (err) { console.warn('[camera] stopCamera failed', err); }
    if (sendingScreen) {
        try { sendingScreen.style.display = 'flex'; }
        catch (err) { sendingScreen.style.display = 'block'; }
    }

    // Spinner removed from DOM; no JS handling required.

    if (state === 'loading') {
        if (title) title.textContent = 'Фотографии отправлены на анализ';
        if (message) {
            message.textContent = 'Снимки переданы в систему анализа. ИИ оценивает ракурсы, после чего специалист проверит результат и подготовит персональные рекомендации по коррекции осанки. Обычно это занимает 10–15 секунд. Пожалуйста, ожидайте ответ в боте.';
        }
        if (okBtn) okBtn.style.display = 'none';
        return;
    }

    // Final state: keep a polite static message, show OK button and auto-redirect.
    if (state === 'final') {
        clearAutoRedirect();
        if (title) title.textContent = 'Фотографии отправлены на анализ';
        if (message) {
            message.textContent = 'Снимки переданы в систему анализа для оценки Вашей осанки. Рекомендуемый список упражнений будет подготовлен специалистом и отправлен Вам через бот.';
        }
        // Spinner removed from DOM; nothing to hide here.

        if (okBtn) {
            okBtn.style.display = 'block';
            okBtn.textContent = 'OK';
            okBtn.onclick = () => {
                clearAutoRedirect();
                returnToTelegramBot();
            };
        }

        // Auto-redirect always runs after 5 seconds.
        const countdownEl = document.getElementById('sending-countdown');
        let seconds = 5;
        if (countdownEl) {
            countdownEl.style.display = 'block';
            countdownEl.textContent = `Вы будете перенаправлены в бот через ${seconds} сек.`;
            redirectInterval = setInterval(() => {
                seconds -= 1;
                if (seconds <= 0) {
                    countdownEl.textContent = `Перенаправление...`;
                    clearAutoRedirect();
                } else {
                    countdownEl.textContent = `Вы будете перенаправлены в бот через ${seconds} сек.`;
                }
            }, 1000);
        }

        redirectTimer = setTimeout(() => {
            returnToTelegramBot();
        }, 5000);
        return;
    }

    if (state === 'success') {
        // Treat 'success' same as 'final' to avoid showing analysis in-page
        showSendingState('final', payload);
        return;
    }

    if (state === 'error') {
        if (title) title.textContent = 'Не удалось завершить отправку';
        if (message) {
            message.textContent = payload.message || 'Попробуйте отправить фотографии еще раз.';
        }
        if (okBtn) {
            okBtn.style.display = 'block';
            okBtn.textContent = 'OK';
            okBtn.onclick = () => {
                clearAutoRedirect();
                returnToTelegramBot();
            };
        }
    }
}

function returnToTelegramBot() {
    const deepLink = `tg://resolve?domain=${TELEGRAM_BOT_USERNAME}`;
    const webLink = `https://t.me/${TELEGRAM_BOT_USERNAME}`;

    try {
        window.location.href = deepLink;
        window.setTimeout(() => {
            window.location.href = webLink;
            // Best-effort: try to close the web page after navigation
            try { setTimeout(() => window.close(), 1200); } catch (e) { /* ignore */ }
        }, 800);
    } catch (err) {
        window.location.href = webLink;
    }
}

function stopCamera() {
    try {
        if (stream) {
            stream.getTracks().forEach((t) => {
                try { t.stop(); } catch (e) {}
            });
            stream = null;
        }
        const video = document.getElementById('camera-feed');
        if (video) {
            try { video.pause(); } catch (e) {}
            try { video.srcObject = null; } catch (e) {}
            video.removeAttribute('src');
        }
    } catch (err) {
        console.warn('[camera] stopCamera error', err);
    }
}

function clearAutoRedirect() {
    if (redirectTimer) { clearTimeout(redirectTimer); redirectTimer = null; }
    if (redirectInterval) { clearInterval(redirectInterval); redirectInterval = null; }
    const countdownEl = document.getElementById('sending-countdown');
    if (countdownEl) countdownEl.style.display = 'none';
}

function escapeHtml(value) {
    return String(value)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
}

// ==========================================
// 5. ГИРОСКОП И ВЫРАВНИВАНИЕ
// ==========================================

let currentPitch = 0; 
let targetPitch = 0;  

let currentRoll = 0;
let targetRoll = 0;

function initSensors() {
    window.addEventListener('devicemotion', (e) => {
        const acc = e.accelerationIncludingGravity;
        if (!acc || acc.y === null) return;

        // Вычисляем тангаж (наклоны вперед-назад)
        // atan2(acc.y, acc.z) дает угол в радианах. 
        // Если телефон лежит плашмя, acc.y = 0. Если стоит вертикально - acc.y = 9.8
        const pitchRad = Math.atan2(acc.y, acc.z);
        const pitchDeg = pitchRad * (180 / Math.PI) - 90;

        // Вычисляем крен (наклоны в стороны)
        const rollRad = Math.atan2(acc.x, Math.sqrt(acc.y * acc.y + acc.z * acc.z));
        const rollDeg = rollRad * (180 / Math.PI);

        // Множитель 5 — это "чувствительность". Чем больше число, тем дальше бегает маркер.
        targetPitch = pitchDeg * 5;
        targetRoll = rollDeg;
    }, {passive: true});

    
    function updateUI() {
        const currentPitchDeg = currentPitch / 5;
        const currentRollDeg = currentRoll;

        const statusEl = document.getElementById('status');
        
        let pitchAdvice = "";
        let rollAdvice = "";

        // 1. Определяем тангаж
        if (currentPitchDeg > 10) pitchAdvice = "вперед";
        else if (currentPitchDeg < -10) pitchAdvice = "назад";

        // 2. Определяем крен
        if (currentRollDeg > 3) rollAdvice = "влево";
        else if (currentRollDeg < -3) rollAdvice = "вправо";

        // 3. Формируем сообщение и определяем isLevel
        let isLevel = (pitchAdvice === "" && rollAdvice === "");
        
        if (!isLevel) {
            let message = "Наклоните телефон ";
            if (pitchAdvice !== "" && rollAdvice !== "") {
                message += `${pitchAdvice} и ${rollAdvice}`;
            } else {
                message += (pitchAdvice !== "") ? pitchAdvice : rollAdvice;
            }
            statusEl.textContent = message;
            statusEl.style.display = 'block';
        } else {
            statusEl.style.display = 'none';
        }

        // 4. Управление кнопкой и маркером
        const captureBtn = document.getElementById('capture-btn');
        if (captureBtn) {
            captureBtn.disabled = !isLevel;
            captureBtn.classList.toggle('ready', isLevel);
        }

        const horizon = document.getElementById('moving-horizon');
        if (horizon) {
            horizon.classList.toggle('in-level', isLevel);
        }
    }

    function animate() {
        // LERP: плавно приближаем current к target
        // 0.05 — это коэффициент плавности (вязкости).
        const lerpFactor = 0.05;
        currentPitch += (targetPitch - currentPitch) * lerpFactor;
        currentRoll += (targetRoll - currentRoll) * lerpFactor;

        const horizon = document.getElementById('moving-horizon');
        if (horizon) {
            // Двигаем только по вертикали (translateY)
            horizon.style.transform = `translateY(${currentPitch}px) rotate(${currentRoll}deg)`;
        }
        updateUI();
        requestAnimationFrame(animate);
    }
    requestAnimationFrame(animate);
}


document.getElementById('switch-cam-btn').onclick = () => {
    currentFacing = currentFacing === 'user' ? 'environment' : 'user';
    startCamera();
};
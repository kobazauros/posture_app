/**
 * Application bootstrap that wires together auth, form, camera, and capture modules.
 */
import { bootstrapAuthFromUrl, getOrCreateClientId, initializeAuthSession } from './auth.js';
import { attachFormValidation, validateForm } from './form.js';
import { startCamera, switchCameraFacing } from './camera.js';
import { bindCaptureHandlers, resetCaptureFlow, updateStepIndicator } from './capture.js';
import { TELEGRAM_BOT_USERNAME, state, stepLabels } from './state.js';

bootstrapAuthFromUrl();
getOrCreateClientId();
attachFormValidation();
bindCaptureHandlers();
updateStepIndicator();

// 🔥 Логика работы Splash Screen
(function showSplashScreen() {
    function removeSplash() {
        const splash = document.getElementById('splash-screen');
        if (!splash) return;

        // Держим премиальный черный экран ровно 1.5 секунды
        setTimeout(() => {
            splash.classList.add('fade-out');

            // Удаляем из DOM
            setTimeout(() => {
                splash.remove();
            }, 600); // время CSS-анимации transition
        }, 1500);
    }

    // Проверяем статус загрузки документа
    if (document.readyState === 'loading') {
        // DOM еще грузится, ждем события
        document.addEventListener('DOMContentLoaded', removeSplash);
    } else {
        // DOM уже загружен (событие было пропущено), запускаем сразу
        removeSplash();
    }
})();


/**
 * Handles the transition from the form screen into the camera flow.
 * @returns {Promise<void>}
 */
async function handleToCameraClick() {
    console.log('[ui] to-camera clicked');

    if (typeof DeviceOrientationEvent.requestPermission === 'function') {
        try {
            const permission = await DeviceOrientationEvent.requestPermission();
            if (permission !== 'granted') {
                alert('Для работы уровня нужен доступ к датчикам.');
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
    state.maxSteps = hasHelper && hasHelper.checked ? 4 : 3;
    state.currentStep = 0;
    state.finalPhotos = [];
    resetCaptureFlow();

    const stepIndicator = document.getElementById('step-indicator');
    if (stepIndicator) stepIndicator.innerText = stepLabels[state.currentStep];

    const formScreen = document.getElementById('form-screen');
    if (formScreen) formScreen.style.display = 'none';
    const cam = document.getElementById('camera-screen');
    if (cam) cam.style.display = 'block';

    // Start camera first so user can take photos regardless of session state.
    try {
        await startCamera();
    } catch (err) {
        console.warn('[camera] startCamera failed', err);
        // If camera cannot start, return user to form screen.
        const cam = document.getElementById('camera-screen');
        if (cam) cam.style.display = 'none';
        if (formScreen) formScreen.style.display = 'block';
        return;
    }

    // Initialize or restore the auth session in background; failure should not block camera.
    initializeAuthSession().catch((err) => console.warn('[auth] session init failed', err));
}

const toCameraBtn = document.getElementById('to-camera-btn');
if (toCameraBtn) {
    toCameraBtn.addEventListener('click', handleToCameraClick);
    toCameraBtn.addEventListener('pointerdown', () => { console.log('[ui] to-camera pointerdown'); });
}

const switchCamBtn = document.getElementById('switch-cam-btn');
if (switchCamBtn) {
    switchCamBtn.onclick = () => {
        switchCameraFacing();
    };
}

// Do not initialize session on page load. Sessions are opened when user
// explicitly enters the camera flow via `to-camera` button.
/**
 * Application bootstrap that wires together auth, form, camera, and capture modules.
 */
import { bootstrapAuthFromUrl, getOrCreateClientId, initializeAuthSession } from './auth.js?v=16';
import { attachFormValidation, validateForm } from './form.js?v=16';
import { startCamera, switchCameraFacing } from './camera.js?v=16';
import { bindCaptureHandlers, resetCaptureFlow, updateStepIndicator } from './capture.js?v=16';
import { TELEGRAM_BOT_USERNAME, state, stepLabels } from './state.js?v=16';
import { initDetector } from './detector.js?v=16';
import { closeOrRedirect } from './upload.js?v=16';


bootstrapAuthFromUrl();
getOrCreateClientId();
attachFormValidation();
bindCaptureHandlers();
updateStepIndicator();

// 🔥 Начинаем загрузку данных пользователя НЕМЕДЛЕННО, параллельно со сплэшем
const authPromise = initializeAuthSession().catch(err => {
    console.warn('[auth] early init failed', err);
    return false;
});

// 🔥 Логика работы Splash Screen
(function showSplashScreen() {
    // Временно скрываем основной экран с анкетой
    const formScreen = document.getElementById('form-screen');
    if (formScreen) formScreen.style.display = 'none';
    function removeSplash() {
        const splash = document.getElementById('splash-screen');
        if (!splash) return;
        // Проверяем, загружал ли пользователь ИИ ранее
        const isCached = localStorage.getItem('mediapipe_cached');
        const progressBarContainer = document.getElementById('splash-progress');
        const progressBar = document.getElementById('splash-progress-bar');

        if (!isCached) {
            if (progressBarContainer) progressBarContainer.style.display = 'block';

            // Fake progress animation up to 90%
            setTimeout(() => {
                if (progressBar) progressBar.style.width = '90%';
            }, 50);

            const loadAI = initDetector().then(() => {
                localStorage.setItem('mediapipe_cached', 'true');
                if (progressBar) {
                    progressBar.style.transition = 'width 0.4s ease-out';
                    progressBar.style.width = '100%';
                }
            }).catch(err => console.error('[Splash] Ошибка загрузки ИИ:', err));

            const minTime = new Promise(resolve => setTimeout(resolve, 1200));

            // Ждём ИИ + авторизацию + минимальное время — всё параллельно
            Promise.all([loadAI, authPromise, minTime]).then(() => {
                setTimeout(() => {
                    splash.classList.add('fade-out');
                    setTimeout(() => {
                        splash.style.display = 'none';
                        routeUser();
                    }, 400);
                }, 200);
            });
        } else {
            // Повторный запуск: ждём авторизацию + минимальное время показа лого
            const minTime = new Promise(resolve => setTimeout(resolve, 300));

            Promise.all([authPromise, minTime]).then(() => {
                splash.classList.add('fade-out');
                setTimeout(() => {
                    splash.style.display = 'none';
                    routeUser();
                }, 400);
            });

            // Распаковываем ИИ в фоне (из кэша достанет мгновенно, но WASM нужно развернуть)
            setTimeout(() => {
                initDetector().catch(err => console.warn(err));
            }, 800);
        }
    }

    removeSplash();
})();

// --- ЛОГИКА РОУТИНГА С БАЗОЙ ДАННЫХ ---
async function routeUser() {
    // authPromise уже resolved к этому моменту — await вернёт результат мгновенно
    const authData = await authPromise;

    const showScreen = (id) => {
        document.querySelectorAll('.screen').forEach(s => s.style.display = 'none');
        const el = document.getElementById(id);
        if (el) el.style.display = 'flex';
    };

    if (authData === false) {
        showScreen('error-screen');
        const closeErrorBtn = document.getElementById('close-error-btn');
        if (closeErrorBtn) {
            closeErrorBtn.addEventListener('click', () => {
                if (window.Telegram && window.Telegram.WebApp) {
                    window.Telegram.WebApp.close();
                } else {
                    window.location.href = `tg://resolve?domain=${TELEGRAM_BOT_USERNAME}&start=1`;
                }
            });
        }
        return;
    }

    if (!authData.is_registered) {
        showScreen('onboarding-screen');
    } else {
        const greetingText = document.getElementById('greeting-text');
        if (greetingText && authData.first_name) {
            greetingText.textContent = `Здравствуйте, ${authData.first_name}!`;
        }

        showScreen('greeting-screen');

        setTimeout(() => {
            if (['client', 'admin', 'specialist-approved'].includes(authData.role)) {
                if (['client', 'admin'].includes(authData.role) && state.latestAnalysis) {
                    const latest = state.latestAnalysis;
                    if (latest.age) document.getElementById('user-age').value = latest.age;
                    if (latest.weight) document.getElementById('user-weight').value = latest.weight;
                    if (latest.height) document.getElementById('user-height').value = latest.height;
                    if (latest.gender === 'male' || latest.gender === 'female') {
                        const r = document.getElementById('gender-' + latest.gender);
                        if (r) r.checked = true;
                    }
                }

                if (authData.role === 'specialist-approved') {
                    const helperSwitch = document.querySelector('.helper-switch');
                    if (helperSwitch) helperSwitch.style.display = 'none';
                    const hasHelper = document.getElementById('has-helper');
                    if (hasHelper) hasHelper.checked = true; // force 4 photos
                }

                showScreen('form-screen');
            } else if (['specialist-pending', 'specialist-refused'].includes(authData.role)) {
                const vTitle = document.getElementById('verification-title');
                const vText = document.getElementById('verification-text');

                if (authData.role === 'specialist-pending') {
                    if (vTitle) vTitle.innerHTML = 'Запрос отправлен ⏳';
                    if (vText) vText.innerHTML = 'Ваша заявка на получение статуса Специалиста отправлена администратору. Мы пришлем вам уведомление в Telegram, как только доступ будет открыт.';
                    showScreen('verification-screen');
                    setTimeout(() => closeOrRedirect(), 8000);
                } else if (authData.role === 'specialist-refused') {
                    if (vTitle) vTitle.innerHTML = 'Заявка отклонена ❌';
                    if (vText) vText.innerHTML = 'К сожалению, ваша заявка на статус специалиста была отклонена администратором. Свяжитесь с поддержкой, если считаете это ошибкой.';
                    showScreen('verification-screen');
                }
            } else {
                // Default fallback if role is unrecognized
                showScreen('onboarding-screen');
            }
        }, 800);
    }
}
// 🔥 Логика кнопок Онбординга (регистрации)
async function handleRoleSelection(role) {
    const firstNameInput = document.getElementById('user-firstname');
    const lastNameInput = document.getElementById('user-lastname');
    const errorFirst = document.getElementById('firstname-error');
    const errorLast = document.getElementById('lastname-error');

    firstNameInput.classList.remove('invalid');
    lastNameInput.classList.remove('invalid');
    errorFirst.textContent = '';
    errorLast.textContent = '';

    const firstName = firstNameInput.value.trim();
    const lastName = lastNameInput.value.trim();

    // Валидация
    if (!firstName) {
        firstNameInput.classList.add('invalid');
        errorFirst.textContent = 'Пожалуйста, введите Имя.';
        return;
    }
    if (!lastName) {
        lastNameInput.classList.add('invalid');
        errorLast.textContent = 'Пожалуйста, введите Фамилию.';
        return;
    }

    // Disable button to prevent double-submit
    const btn = document.getElementById('submit-onboarding-btn');
    if (btn) btn.disabled = true;

    try {
        const response = await fetch('user/register', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                session_id: state.sessionId,
                first_name: firstName,
                last_name: lastName,
                role: role // 'patient' or 'doctor' from UI
            })
        });

        const result = await response.json();
        if (result.status === 'success') {
            // Update local state
            state.isRegistered = true;
            state.firstName = firstName;
            state.role = result.role; // Real DB role ('client' or 'specialist-pending')

            // Скрываем онбординг
            document.getElementById('onboarding-screen').style.display = 'none';

            if (['client', 'admin'].includes(state.role)) {
                document.getElementById('form-screen').style.display = 'flex';
            } else {
                const vScreen = document.getElementById('verification-screen');
                if (vScreen) {
                    const vTitle = document.getElementById('verification-title');
                    const vText = document.getElementById('verification-text');
                    if (vTitle) vTitle.innerHTML = 'Запрос отправлен ⏳';
                    if (vText) vText.innerHTML = 'Ваша заявка на получение статуса Специалиста отправлена администратору. Мы пришлем вам уведомление в Telegram, как только доступ будет открыт.';
                    vScreen.style.display = 'flex';
                }
                // Вызываем ту же логику (closeOrRedirect), что и при успешной отправке фото
                setTimeout(() => {
                    closeOrRedirect();
                }, 5000);
            }
        } else {
            alert('Ошибка регистрации: ' + (result.message || 'Неизвестная ошибка'));
        }
    } catch (err) {
        console.error('Registration failed:', err);
        alert('Ошибка сети при регистрации. Проверьте подключение.');
    } finally {
        if (btn) btn.disabled = false;
    }
}
// Привязываем клик к новой кнопке "ПРОДОЛЖИТЬ"
document.getElementById('submit-onboarding-btn')?.addEventListener('click', () => {
    // Узнаем, какой переключатель выбран (patient или doctor)
    const selectedRole = document.querySelector('input[name="role-selection"]:checked').value;
    handleRoleSelection(selectedRole);
});

// Очистка ошибок при вводе в онбординге
['user-firstname', 'user-lastname'].forEach(id => {
    const el = document.getElementById(id);
    if (el) {
        el.addEventListener('input', () => {
            el.classList.remove('invalid');
            const errId = id === 'user-firstname' ? 'firstname-error' : 'lastname-error';
            const errEl = document.getElementById(errId);
            if (errEl) errEl.textContent = '';
        });
    }
});


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

    const genderInput = document.querySelector('input[name="gender"]:checked');
    const selectedGender = genderInput ? genderInput.value : 'male';
    const age = document.getElementById('user-age').value;
    const weight = document.getElementById('user-weight').value;
    const height = document.getElementById('user-height').value;

    const toCameraBtn = document.getElementById('to-camera-btn');
    if (toCameraBtn) {
        toCameraBtn.textContent = 'СОХРАНЕНИЕ...';
        toCameraBtn.disabled = true;
    }

    try {
        const draftRes = await fetch('form/save_draft', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                session_id: state.sessionId,
                client_id: state.clientId,
                token: sessionStorage.getItem('posture_app_token') || state.token,
                user_data: { age, weight, height, gender: selectedGender }
            })
        });
        const draftData = await draftRes.json();
        if (draftData.status === 'success' && draftData.analysis_id) {
            state.analysisId = draftData.analysis_id;
            state.latestAnalysis = { age, weight, height, gender: selectedGender };
            try {
                sessionStorage.setItem('posture_app_analysis', JSON.stringify(state.latestAnalysis));
            } catch (e) { }
        }
    } catch (err) {
        console.warn('[app] save_draft failed', err);
    }

    if (toCameraBtn) {
        toCameraBtn.textContent = 'НАЧАТЬ';
        toCameraBtn.disabled = false;
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

import { state } from './state.js?v=20';

let timerHoldInterval = null;
let holdStartTime = 0;
let captureCountdownInterval = null;

let audioCtx = null;
function playBeep(frequency, duration) {
    try {
        if (!audioCtx) {
            audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        }
        if (audioCtx.state === 'suspended') {
            audioCtx.resume();
        }
        const oscillator = audioCtx.createOscillator();
        const gainNode = audioCtx.createGain();
        oscillator.connect(gainNode);
        gainNode.connect(audioCtx.destination);
        oscillator.type = 'sine';
        oscillator.frequency.value = frequency;

        // Gentle attack and release to avoid clicking
        gainNode.gain.setValueAtTime(0, audioCtx.currentTime);
        gainNode.gain.linearRampToValueAtTime(0.3, audioCtx.currentTime + 0.05);
        gainNode.gain.linearRampToValueAtTime(0, audioCtx.currentTime + duration);

        oscillator.start(audioCtx.currentTime);
        oscillator.stop(audioCtx.currentTime + duration);
    } catch (err) { }
}

export function updateTimerUI() {
    const timerBtn = document.getElementById('timer-btn');
    if (!timerBtn) return;
    if (state.captureTimer > 0) {
        timerBtn.classList.add('has-timer');
        timerBtn.innerText = state.captureTimer + 'с';
    } else {
        timerBtn.classList.remove('has-timer');
        timerBtn.innerText = '';
    }
}

function updateBadge(value, isVisible) {
    const badge = document.getElementById('timer-badge');
    if (!badge) return;
    if (isVisible) {
        badge.innerText = value + 'с';
        badge.classList.add('visible');
    } else {
        badge.classList.remove('visible');
    }
}

export function bindTimerButton() {
    const timerBtn = document.getElementById('timer-btn');
    if (!timerBtn) return;

    const startHold = (e) => {
        if (e.type === 'touchstart') e.preventDefault();
        holdStartTime = Date.now();
        // Скрываем текст на кнопке, пока давим
        timerBtn.innerText = '';
        updateBadge(state.captureTimer, true);

        timerHoldInterval = setInterval(() => {
            if (state.captureTimer < 20) {
                state.captureTimer += 1;
                updateBadge(state.captureTimer, true);
                // Обновляем CSS-класс кнопки, но без текста
                if (state.captureTimer > 0) {
                    timerBtn.classList.add('has-timer');
                }
            }
        }, 500);
    };

    const endHold = () => {
        if (timerHoldInterval) {
            clearInterval(timerHoldInterval);
            timerHoldInterval = null;
        }
        updateBadge(0, false);

        // Если удержание было коротким (< 300мс), сбрасываем таймер
        if (Date.now() - holdStartTime < 300) {
            state.captureTimer = 0;
        }
        updateTimerUI();
    };

    const cancelHold = () => {
        if (timerHoldInterval) {
            clearInterval(timerHoldInterval);
            timerHoldInterval = null;
        }
        updateBadge(0, false);
        updateTimerUI();
    };

    timerBtn.addEventListener('mousedown', startHold);
    timerBtn.addEventListener('touchstart', startHold, { passive: false });

    timerBtn.addEventListener('mouseup', endHold);
    timerBtn.addEventListener('touchend', endHold);

    timerBtn.addEventListener('mouseleave', cancelHold);
    timerBtn.addEventListener('touchcancel', cancelHold);
}

export function handleCaptureWithTimer(captureCallback) {
    const captureBtn = document.getElementById('capture-btn');
    if (!captureBtn) {
        captureCallback();
        return;
    }

    if (state.isTimerPending) {
        // Отмена режима таймера
        state.isTimerPending = false;
        if (captureCountdownInterval) clearInterval(captureCountdownInterval);
        captureBtn.innerText = '';
        captureBtn.classList.remove('timer-waiting');
        return;
    }

    if (state.captureTimer > 0) {
        state.isTimerPending = true;
        state.currentCountdown = state.captureTimer;

        captureBtn.innerText = '';
        captureBtn.classList.add('timer-waiting');
        captureBtn.classList.remove('timer-active');

        captureCountdownInterval = setInterval(() => {
            if (!state.isTimerPending) {
                clearInterval(captureCountdownInterval);
                return;
            }

            const figureOk = !state.detectorReady || (state.figureInBounds && state.poseValid);
            const canCapture = state.isLevel && figureOk;

            if (canCapture) {
                captureBtn.classList.remove('timer-waiting');
                captureBtn.classList.add('timer-active');

                if (state.currentCountdown > 0) {
                    captureBtn.innerText = state.currentCountdown;
                    if (navigator.vibrate) navigator.vibrate(50);
                    playBeep(440, 0.2); // Normal beep
                }

                state.currentCountdown -= 1;

                if (state.currentCountdown < 0) {
                    playBeep(880, 0.4); // Higher, longer beep on capture
                    clearInterval(captureCountdownInterval);
                    state.isTimerPending = false;
                    captureBtn.innerText = '';
                    captureBtn.classList.remove('timer-active');
                    captureCallback();
                }
            } else {
                // Сброс таймера к начальному значению, если условия не выполнены
                state.currentCountdown = state.captureTimer;
                captureBtn.classList.add('timer-waiting');
                captureBtn.classList.remove('timer-active');
                captureBtn.innerText = '';
            }
        }, 1000);
    } else {
        captureCallback();
    }
}

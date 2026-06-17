import { state } from './state.js?v=11';

let timerHoldInterval = null;
let holdStartTime = 0;
let captureCountdownInterval = null;

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

export function bindTimerButton() {
    const timerBtn = document.getElementById('timer-btn');
    if (!timerBtn) return;

    const startHold = (e) => {
        if (e.type === 'touchstart') e.preventDefault();
        holdStartTime = Date.now();
        timerHoldInterval = setInterval(() => {
            if (state.captureTimer < 20) {
                state.captureTimer += 1;
                updateTimerUI();
            }
        }, 500);
    };

    const endHold = () => {
        if (timerHoldInterval) {
            clearInterval(timerHoldInterval);
            timerHoldInterval = null;
        }
        // Если удержание было коротким (< 300мс), сбрасываем таймер
        if (Date.now() - holdStartTime < 300) {
            state.captureTimer = 0;
            updateTimerUI();
        }
    };

    const cancelHold = () => {
        if (timerHoldInterval) {
            clearInterval(timerHoldInterval);
            timerHoldInterval = null;
        }
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
        
        captureBtn.innerText = 'Ждем...';
        captureBtn.classList.add('timer-waiting');

        captureCountdownInterval = setInterval(() => {
            if (!state.isTimerPending) {
                clearInterval(captureCountdownInterval);
                return;
            }

            const figureOk = !state.detectorReady || (state.figureInBounds && state.poseValid);
            const canCapture = state.isLevel && figureOk;

            if (canCapture) {
                captureBtn.classList.remove('timer-waiting');
                
                if (state.currentCountdown > 0) {
                    captureBtn.innerText = state.currentCountdown;
                    if (navigator.vibrate) navigator.vibrate(50);
                }
                
                state.currentCountdown -= 1;
                
                if (state.currentCountdown < 0) {
                    clearInterval(captureCountdownInterval);
                    state.isTimerPending = false;
                    captureBtn.innerText = '';
                    captureCallback();
                }
            } else {
                // Сброс таймера к начальному значению, если условия не выполнены
                state.currentCountdown = state.captureTimer;
                captureBtn.classList.add('timer-waiting');
                captureBtn.innerText = 'Ждем...';
            }
        }, 1000);
    } else {
        captureCallback();
    }
}

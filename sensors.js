import { SENSOR_SMOOTHING, state } from './state.js?v=20';

let sensorsBound = false;
let animationFrameId = null;

/**
 * Updates the on-screen posture guidance and capture button state.
 * @returns {void}
 */
function updateUI() {
    const currentPitchDeg = state.currentPitch / 5;
    const currentRollDeg = state.currentRoll;

    const statusEl = document.getElementById('status');

    let pitchAdvice = '';
    let rollAdvice = '';

    if (currentPitchDeg > 10) pitchAdvice = 'вперед';
    else if (currentPitchDeg < -10) pitchAdvice = 'назад';

    if (currentRollDeg > 3) rollAdvice = 'влево';
    else if (currentRollDeg < -3) rollAdvice = 'вправо';

    const isLevel = pitchAdvice === '' && rollAdvice === '';
    state.isLevel = isLevel;

    if (statusEl) {
        if (!isLevel) {
            let message = 'Наклоните телефон ';
            if (pitchAdvice !== '' && rollAdvice !== '') {
                message += `${pitchAdvice} и ${rollAdvice}`;
            } else {
                message += pitchAdvice !== '' ? pitchAdvice : rollAdvice;
            }
            statusEl.textContent = message;
            statusEl.style.display = 'block';
        } else {
            statusEl.style.display = 'none';
        }
    }

    const captureBtn = document.getElementById('capture-btn');
    if (captureBtn) {
        const figureOk = !state.detectorReady || (state.figureInBounds && state.poseValid);
        const canCapture = isLevel && figureOk;

        // If there's a timer set, the button is ALWAYS enabled (to start the timer wait loop)
        // If no timer, it's enabled only if canCapture is true.
        // We also disable it if isTimerPending is true to prevent multiple clicks.
        const shouldEnable = (!state.isTimerPending) && (state.captureTimer > 0 || canCapture);
        captureBtn.disabled = !shouldEnable;

        if (state.isTimerPending) {
            // Appearance is handled by CSS (e.g. .timer-waiting) and JS
            captureBtn.classList.remove('ready');
        } else {
            captureBtn.classList.toggle('ready', canCapture);
        }
    }

    const horizon = document.getElementById('moving-horizon');
    if (horizon) {
        horizon.classList.toggle('in-level', isLevel);
    }
}

/**
 * Smoothly animates the horizon marker toward the latest sensor target.
 * @returns {void}
 */
function animate() {
    state.currentPitch += (state.targetPitch - state.currentPitch) * SENSOR_SMOOTHING;
    state.currentRoll += (state.targetRoll - state.currentRoll) * SENSOR_SMOOTHING;

    const horizon = document.getElementById('moving-horizon');
    if (horizon) {
        horizon.style.transform = `translateY(${state.currentPitch}px) rotate(${state.currentRoll}deg)`;
    }

    updateUI();
    animationFrameId = requestAnimationFrame(animate);
}

/**
 * Starts listening to device motion events and animates the leveling UI.
 * @returns {void}
 */
export function initSensors() {
    if (!sensorsBound) {
        sensorsBound = true;
        window.addEventListener('devicemotion', (event) => {
            const acc = event.accelerationIncludingGravity;
            if (!acc || acc.y === null) return;

            const pitchRad = Math.atan2(acc.y, acc.z);
            const pitchDeg = pitchRad * (180 / Math.PI) - 90;

            const rollRad = Math.atan2(acc.x, Math.sqrt(acc.y * acc.y + acc.z * acc.z));
            const rollDeg = rollRad * (180 / Math.PI);

            state.targetPitch = pitchDeg * 5;
            state.targetRoll = rollDeg;
            state.currentPitchDeg = pitchDeg;
            state.currentRollDeg = rollDeg;
        }, { passive: true });
    }

    if (!animationFrameId) {
        animationFrameId = requestAnimationFrame(animate);
    }
}

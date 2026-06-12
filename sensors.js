import { SENSOR_SMOOTHING, state } from './state.js?v=8';

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
        // Button requires both: phone is level AND figure is within guide lines.
        // If detector hasn't loaded, skip the figure check so user isn't blocked.
        const figureOk = !state.detectorReady || (state.figureInBounds && state.poseValid);
        const canCapture = isLevel && figureOk;
        captureBtn.disabled = !canCapture;
        captureBtn.classList.toggle('ready', canCapture);
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

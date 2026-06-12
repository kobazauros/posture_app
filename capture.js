import { state, stepLabels } from './state.js?v=3';
import { sendPhotosToServer } from './upload.js?v=3';

/**
 * Updates the visible step label for the capture flow.
 * @returns {void}
 */
function updateStepIndicator() {
    const stepIndicator = document.getElementById('step-indicator');
    if (stepIndicator) stepIndicator.innerText = stepLabels[state.currentStep];
}

/**
 * Updates the primary action button label and modifier classes.
 * @returns {void}
 */
function updateNextButton() {
    const nextBtn = document.getElementById('next-step-btn');
    if (!nextBtn) return;

    if (state.currentStep === state.maxSteps - 1) {
        const nb = document.getElementById('next-step-btn');
        if (nb) {
            nb.textContent = 'ОТПРАВИТЬ';
            if (nb.classList.contains('primary-btn')) nb.classList.replace('primary-btn', 'send-btn');
            else nb.classList.add('send-btn');
        }
    } else {
        const nb = document.getElementById('next-step-btn');
        if (nb) {
            nb.textContent = 'Дальше';
            if (nb.classList.contains('send-btn')) nb.classList.replace('send-btn', 'primary-btn');
            else nb.classList.add('primary-btn');
        }
    }
}

/**
 * Renders the current camera frame into the preview canvas.
 * @returns {void}
 */
function captureFrameToPreview() {
    const video = document.getElementById('camera-feed');
    const canvas = document.getElementById('capture-canvas');
    if (!video || !canvas) return;

    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const useDigitalZoom = !state.zoomSupport && state.cameraZoom > 1.01;

    if (state.currentFacing === 'user') {
        ctx.translate(canvas.width, 0);
        ctx.scale(-1, 1);
    }

    if (useDigitalZoom) {
        const cropWidth = video.videoWidth / state.cameraZoom;
        const cropHeight = video.videoHeight / state.cameraZoom;
        const cropX = (video.videoWidth - cropWidth) / 2;
        const cropY = (video.videoHeight - cropHeight) / 2;
        ctx.drawImage(video, cropX, cropY, cropWidth, cropHeight, 0, 0, canvas.width, canvas.height);
    } else {
        ctx.drawImage(video, 0, 0);
    }

    if (navigator.vibrate) navigator.vibrate(50);

    const previewImage = document.getElementById('preview-image');
    const previewScreen = document.getElementById('preview-screen');
    if (previewImage) previewImage.src = canvas.toDataURL('image/jpeg', 0.8);
    if (previewScreen) previewScreen.style.display = 'flex';

    // Store orientation precisely at capture time
    state.pendingPitchDeg = state.currentPitchDeg;
    state.pendingRollDeg = state.currentRollDeg;

    updateNextButton();
}

/**
 * Binds capture, retake, and next-step button handlers.
 * @returns {void}
 */
export function bindCaptureHandlers() {
    const captureBtn = document.getElementById('capture-btn');
    const retakeBtn = document.getElementById('retake-btn');
    const nextStepBtn = document.getElementById('next-step-btn');

    if (captureBtn) {
        captureBtn.onclick = () => {
            captureFrameToPreview();
        };
    }

    if (retakeBtn) {
        retakeBtn.onclick = () => {
            const ps = document.getElementById('preview-screen');
            if (ps) ps.style.display = 'none';
        };
    }

    if (nextStepBtn) {
        nextStepBtn.onclick = () => {
            const previewImage = document.getElementById('preview-image');
            if (previewImage) {
                state.finalPhotos.push(previewImage.src);
                state.finalOrientations.push({ pitch: state.pendingPitchDeg, roll: state.pendingRollDeg });
            }

            if (state.currentStep < state.maxSteps - 1) {
                state.currentStep += 1;
                updateStepIndicator();

                const ps = document.getElementById('preview-screen');
                if (ps) ps.style.display = 'none';
            } else {
                sendPhotosToServer();
            }
        };
    }
}

/**
 * Resets the capture flow state to the first step.
 * @returns {void}
 */
export function resetCaptureFlow() {
    state.currentStep = 0;
    state.finalPhotos = [];
    state.finalOrientations = [];
    updateStepIndicator();
    updateNextButton();
}

/**
 * Re-exports the current step indicator updater for startup wiring.
 * @returns {void}
 */
export { updateStepIndicator };

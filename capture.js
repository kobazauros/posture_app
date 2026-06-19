import { state, stepLabels } from './state.js?v=21';
import { sendPhotosToServer } from './upload.js?v=21';
import { getFigureStatus } from './detector.js?v=21';
import { bindTimerButton, handleCaptureWithTimer } from './timer.js?v=21';
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

    let cropX = 0, cropY = 0, cropWidth = video.videoWidth, cropHeight = video.videoHeight;
    if (useDigitalZoom) {
        cropWidth = video.videoWidth / state.cameraZoom;
        cropHeight = video.videoHeight / state.cameraZoom;
        cropX = (video.videoWidth - cropWidth) / 2;
        cropY = (video.videoHeight - cropHeight) / 2;
    }

    if (useDigitalZoom) {
        ctx.drawImage(video, cropX, cropY, cropWidth, cropHeight, 0, 0, canvas.width, canvas.height);
    } else {
        ctx.drawImage(video, 0, 0);
    }

    // Save UNBLURRED frame to state for backend MediaPipe
    state.pendingUnblurredPhoto = canvas.toDataURL('image/jpeg', 0.8);

    // --- ПРИМЕНЯЕМ РАЗМЫТИЕ ЛИЦА ТОЛЬКО ДЛЯ ПРЕВЬЮ ---
    const status = getFigureStatus();
    if (status.keypoints && status.keypoints.length >= 11) {
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        const zoomScale = useDigitalZoom ? state.cameraZoom : 1.0;

        for (let i = 0; i <= 10; i++) {
            const lm = status.keypoints[i];
            if (lm && (lm.visibility === undefined || lm.visibility > 0.3)) {
                let x = (lm.x * video.videoWidth - cropX) * zoomScale;
                let y = (lm.y * video.videoHeight - cropY) * zoomScale;
                if (x < minX) minX = x;
                if (x > maxX) maxX = x;
                if (y < minY) minY = y;
                if (y > maxY) maxY = y;
            }
        }

        if (minX !== Infinity) {
            const padX = (maxX - minX) * 0.6;
            const padY = (maxY - minY) * 0.7;
            const fx = Math.max(0, minX - padX);
            const fy = Math.max(0, minY - padY);
            const fw = Math.min(canvas.width - fx, (maxX - minX) + padX * 2);
            const fh = Math.min(canvas.height - fy, (maxY - minY) + padY * 2);

            if (fw > 0 && fh > 0) {
                const blurRadius = Math.max(10, Math.round(Math.max(canvas.width, canvas.height) * 0.02));
                ctx.save();
                ctx.filter = `blur(${blurRadius}px)`;
                ctx.beginPath();
                ctx.ellipse(fx + fw / 2, fy + fh / 2, fw / 2, fh / 2, 0, 0, Math.PI * 2);
                ctx.clip();
                if (useDigitalZoom) {
                    ctx.drawImage(video, cropX, cropY, cropWidth, cropHeight, 0, 0, canvas.width, canvas.height);
                } else {
                    ctx.drawImage(video, 0, 0);
                }
                ctx.restore();
            }
        }
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

    bindTimerButton();

    if (captureBtn) {
        captureBtn.onclick = () => {
            handleCaptureWithTimer(captureFrameToPreview);
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
            if (previewImage && state.pendingUnblurredPhoto) {
                state.finalPhotos.push(state.pendingUnblurredPhoto);
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

import { MAX_CAMERA_ZOOM, MIN_CAMERA_ZOOM, state } from './state.js?v=7';
import { initSensors } from './sensors.js?v=7';
import { initDetector, startDetectionLoop, stopDetectionLoop } from './detector.js?v=7';

/**
 * Clamps a numeric value into the provided range.
 * @param {number} value - Input value.
 * @param {number} min - Lower bound.
 * @param {number} max - Upper bound.
 * @returns {number} Clamped value.
 */
function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

/**
 * Returns the active video track from the current camera stream.
 * @returns {MediaStreamTrack|null} Active video track or null.
 */
function getActiveVideoTrack() {
    return state.stream && state.stream.getVideoTracks ? state.stream.getVideoTracks()[0] : null;
}

/**
 * Updates the zoom status label in the UI.
 * @returns {void}
 */
function updateZoomIndicator() {
    const label = document.getElementById('zoom-indicator');
    if (label) label.textContent = `Zoom ${state.cameraZoom.toFixed(state.cameraZoom >= 2 ? 0 : 1)}x`;
}

/**
 * Applies a CSS transform fallback when native zoom is unavailable.
 * @returns {void}
 */
function applyVideoTransform() {
    const video = document.getElementById('camera-feed');
    if (!video) return;
    video.style.transform = state.cameraZoom > 1.01 ? `scale(${state.cameraZoom})` : '';
    updateZoomIndicator();
}

/**
 * Sets the camera zoom level, using native track zoom when supported.
 * @param {number} nextZoom - Requested zoom level.
 * @returns {Promise<void>}
 */
export async function applyCameraZoom(nextZoom) {
    state.cameraZoom = clamp(nextZoom, MIN_CAMERA_ZOOM, MAX_CAMERA_ZOOM);
    const track = getActiveVideoTrack();
    const capabilities = track && typeof track.getCapabilities === 'function' ? track.getCapabilities() : {};

    if (track && state.zoomSupport && capabilities && typeof capabilities.zoom !== 'undefined') {
        try {
            await track.applyConstraints({ advanced: [{ zoom: state.cameraZoom }] });
            updateZoomIndicator();
            return;
        } catch (err) {
            state.zoomSupport = false;
        }
    }

    applyVideoTransform();
}

/**
 * Measures the distance between the first two touch points.
 * @param {TouchList} touches - Active touch list.
 * @returns {number} Distance in pixels.
 */
function getTouchDistance(touches) {
    const dx = touches[0].clientX - touches[1].clientX;
    const dy = touches[0].clientY - touches[1].clientY;
    return Math.hypot(dx, dy);
}

/**
 * Binds pinch-to-zoom touch gestures to the camera preview.
 * @param {HTMLVideoElement} video - Camera preview element.
 * @returns {void}
 */
function bindCameraGestures(video) {
    if (state.cameraGesturesBound) return;
    state.cameraGesturesBound = true;

    video.addEventListener('touchstart', (event) => {
        if (event.touches.length === 2) {
            event.preventDefault();
            state.pinchStartDistance = getTouchDistance(event.touches);
            state.pinchStartZoom = state.cameraZoom;
        }
    }, { passive: false });

    video.addEventListener('touchmove', (event) => {
        if (event.touches.length === 2 && state.pinchStartDistance > 0) {
            event.preventDefault();
            const currentDistance = getTouchDistance(event.touches);
            applyCameraZoom(state.pinchStartZoom * (currentDistance / state.pinchStartDistance));
        }
    }, { passive: false });

    const finishPinch = () => {
        state.pinchStartDistance = 0;
        state.pinchStartZoom = state.cameraZoom;
    };

    video.addEventListener('touchend', finishPinch, { passive: true });
    video.addEventListener('touchcancel', finishPinch, { passive: true });
}

/**
 * Stops the active camera stream and detaches it from the preview element.
 * @returns {void}
 */
export function stopCamera() {
    try {
        stopDetectionLoop();

        if (state.stream) {
            state.stream.getTracks().forEach((track) => {
                try {
                    track.stop();
                } catch (err) {
                    // ignore
                }
            });
            state.stream = null;
        }

        const video = document.getElementById('camera-feed');
        if (video) {
            try { video.pause(); } catch (err) {}
            try { video.srcObject = null; } catch (err) {}
            video.removeAttribute('src');
        }
    } catch (err) {
        console.warn('[camera] stopCamera error', err);
    }
}

/**
 * Starts the camera with the current facing mode and preview settings.
 * @returns {Promise<void>}
 */
export async function startCamera() {
    if (state.stream) {
        stopCamera();
    }

    try {
        state.stream = await navigator.mediaDevices.getUserMedia({
            video: {
                facingMode: state.currentFacing,
                width: { ideal: 1280 },
                height: { ideal: 720 },
            },
        });

        const video = document.getElementById('camera-feed');
        if (!video) return;

        video.srcObject = state.stream;
        video.play();
        bindCameraGestures(video);
        state.cameraZoom = 1;
        updateZoomIndicator();
        applyCameraZoom(1);

        const track = state.stream.getVideoTracks()[0];
        const capabilities = track && typeof track.getCapabilities === 'function' ? track.getCapabilities() : {};
        state.zoomSupport = !!(capabilities && typeof capabilities.zoom !== 'undefined');
        initSensors();

        // Start figure detection (non-blocking; camera works even if detector fails)
        initDetector()
            .then(() => startDetectionLoop())
            .catch((err) => console.warn('[camera] detector init failed', err));
    } catch (err) {
        alert('Камера недоступна. Убедитесь, что используете HTTPS.');
    }
}

/**
 * Toggles the active camera facing mode and restarts the stream.
 * @returns {Promise<void>}
 */
export async function switchCameraFacing() {
    state.currentFacing = state.currentFacing === 'user' ? 'environment' : 'user';
    await startCamera();
}

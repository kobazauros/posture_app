/**
 * Real-time human figure detection with face blurring.
 * Uses MediaPipe Pose Landmarker (33 keypoints, 3D coordinates).
 *
 * Face blur is a separate reusable function that operates on canvas context.
 * The detection loop handles: face blur overlay, figure bounds checking,
 * guide-line flashing, and capture button coordination.
 */
import { state } from './state.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// TODO(security): Consider self-hosting MediaPipe assets instead of CDN
const MEDIAPIPE_VERSION = '0.10.18';
const VISION_CDN =
    `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MEDIAPIPE_VERSION}`;
const MODEL_URL =
    'https://storage.googleapis.com/mediapipe-models/pose_landmarker/' +
    'pose_landmarker_heavy/float16/1/pose_landmarker_heavy.task';

/** Detection runs at ~20 FPS to balance accuracy and battery life. */
const DETECTION_INTERVAL_MS = 50;

/**
 * MediaPipe Pose landmark indices (33 total).
 * @see https://ai.google.dev/edge/mediapipe/solutions/vision/pose_landmarker
 */
const LM = {
    NOSE: 0,
    LEFT_EYE_INNER: 1, LEFT_EYE: 2, LEFT_EYE_OUTER: 3,
    RIGHT_EYE_INNER: 4, RIGHT_EYE: 5, RIGHT_EYE_OUTER: 6,
    LEFT_EAR: 7, RIGHT_EAR: 8,
    MOUTH_LEFT: 9, MOUTH_RIGHT: 10,
    LEFT_SHOULDER: 11, RIGHT_SHOULDER: 12,
    LEFT_HIP: 23, RIGHT_HIP: 24,
    LEFT_KNEE: 25, RIGHT_KNEE: 26,
    LEFT_ANKLE: 27, RIGHT_ANKLE: 28,
    LEFT_HEEL: 29, RIGHT_HEEL: 30,
    LEFT_FOOT_INDEX: 31, RIGHT_FOOT_INDEX: 32,
};

/** Face landmark indices used to compute the blur bounding box. */
const FACE_INDICES = [
    LM.NOSE,
    LM.LEFT_EYE_INNER, LM.LEFT_EYE, LM.LEFT_EYE_OUTER,
    LM.RIGHT_EYE_INNER, LM.RIGHT_EYE, LM.RIGHT_EYE_OUTER,
    LM.LEFT_EAR, LM.RIGHT_EAR,
    LM.MOUTH_LEFT, LM.MOUTH_RIGHT,
];

/** Upper body landmarks for checking if head is within the top guide. */
const TOP_INDICES = [
    LM.NOSE, LM.LEFT_EYE, LM.RIGHT_EYE, LM.LEFT_EAR, LM.RIGHT_EAR,
];

/** Lower body landmarks for checking if feet are within the bottom guide. */
const BOTTOM_INDICES = [
    LM.LEFT_ANKLE, LM.RIGHT_ANKLE,
    LM.LEFT_HEEL, LM.RIGHT_HEEL,
    LM.LEFT_FOOT_INDEX, LM.RIGHT_FOOT_INDEX,
];

/**
 * Guide line offsets in pixels.
 * Must match CSS: .guide-head { top: 20px }, .guide-feet { bottom: 20px }
 */
const GUIDE_TOP_PX = 20;
const GUIDE_BOTTOM_PX = 20;

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let poseLandmarker = null;
let detectionLoopId = null;
let lastDetectionTime = 0;
let lastLandmarks = null;

// ---------------------------------------------------------------------------
// Coordinate helpers
// ---------------------------------------------------------------------------

/**
 * Computes the mapping needed to convert normalised MediaPipe coordinates
 * (relative to the native video frame) into pixel coordinates on the overlay
 * canvas, accounting for the `object-fit: cover` display mode.
 *
 * @param {number} videoW - Native video width in pixels.
 * @param {number} videoH - Native video height in pixels.
 * @param {number} dispW  - Displayed (canvas) width in pixels.
 * @param {number} dispH  - Displayed (canvas) height in pixels.
 * @returns {{ scale: number, offsetX: number, offsetY: number }}
 */
function getCoverMapping(videoW, videoH, dispW, dispH) {
    const scale = Math.max(dispW / videoW, dispH / videoH);
    return {
        scale,
        offsetX: (dispW - videoW * scale) / 2,
        offsetY: (dispH - videoH * scale) / 2,
    };
}

/**
 * Converts a normalised MediaPipe landmark to canvas pixel coordinates.
 *
 * @param {{ x: number, y: number, visibility?: number }} lm
 * @param {number} videoW
 * @param {number} videoH
 * @param {{ scale: number, offsetX: number, offsetY: number }} mapping
 * @returns {{ x: number, y: number, visibility: number }}
 */
function toCanvas(lm, videoW, videoH, mapping) {
    return {
        x: lm.x * videoW * mapping.scale + mapping.offsetX,
        y: lm.y * videoH * mapping.scale + mapping.offsetY,
        visibility: lm.visibility ?? 0,
    };
}

// ---------------------------------------------------------------------------
// Figure heuristics (Filtering false positives)
// ---------------------------------------------------------------------------

/**
 * Checks if the detected landmarks resemble a standing person.
 * This filters out "ghost" detections (e.g. blankets, textures) and ensures
 * the user is standing upright.
 *
 * @param {Array} landmarks - 33-element landmark array.
 * @returns {boolean} True if the pose is valid and standing.
 */
function isStandingPose(landmarks) {
    if (!landmarks || landmarks.length < 33) return false;

    const getLm = (idx) => {
        const lm = landmarks[idx];
        // Must be reasonably visible
        if (!lm || (lm.visibility !== undefined && lm.visibility < 0.5)) return null;
        return lm;
    };

    // Get key vertical points
    const nose = getLm(LM.NOSE);
    const leftShoulder = getLm(LM.LEFT_SHOULDER);
    const rightShoulder = getLm(LM.RIGHT_SHOULDER);
    const leftHip = getLm(LM.LEFT_HIP);
    const rightHip = getLm(LM.RIGHT_HIP);
    const leftKnee = getLm(LM.LEFT_KNEE);
    const rightKnee = getLm(LM.RIGHT_KNEE);
    const leftAnkle = getLm(LM.LEFT_ANKLE);
    const rightAnkle = getLm(LM.RIGHT_ANKLE);

    // We need at least one point from each vertical tier to verify standing
    const headY = nose ? nose.y : null;
    const shoulderY = (leftShoulder && rightShoulder) ? (leftShoulder.y + rightShoulder.y) / 2 :
        (leftShoulder ? leftShoulder.y : (rightShoulder ? rightShoulder.y : null));
    const hipY = (leftHip && rightHip) ? (leftHip.y + rightHip.y) / 2 :
        (leftHip ? leftHip.y : (rightHip ? rightHip.y : null));

    // For legs, either knee or ankle is acceptable to prove the lower body exists
    const kneeY = (leftKnee && rightKnee) ? (leftKnee.y + rightKnee.y) / 2 :
        (leftKnee ? leftKnee.y : (rightKnee ? rightKnee.y : null));
    const ankleY = (leftAnkle && rightAnkle) ? (leftAnkle.y + rightAnkle.y) / 2 :
        (leftAnkle ? leftAnkle.y : (rightAnkle ? rightAnkle.y : null));
    const legY = kneeY !== null ? kneeY : ankleY;

    // Must have head/shoulders, hips, and legs visible
    if (shoulderY === null || hipY === null || legY === null) {
        return false;
    }

    // Canvas Y-axis goes top (0) to bottom (max).
    // So standing means: head < shoulders < hips < legs
    let isStanding = true;
    if (headY !== null && headY >= shoulderY) isStanding = false;
    if (shoulderY >= hipY) isStanding = false;
    if (hipY >= legY) isStanding = false;

    return isStanding;
}

/**
 * Evaluates the current pose against the expected step.
 * Returns an object {valid: boolean, message: string}.
 */
function evaluateCurrentPose(landmarks) {
    const visibility = (idx) => {
        const lm = landmarks[idx];
        return lm && (lm.visibility ?? 0) >= 0.5;
    };
    const noseVis = visibility(LM.NOSE);
    const leftEyeVis = visibility(LM.LEFT_EYE);
    const rightEyeVis = visibility(LM.RIGHT_EYE);
    const leftEar = landmarks[LM.LEFT_EAR];
    const rightEar = landmarks[LM.RIGHT_EAR];

    const noseX = landmarks[LM.NOSE]?.x ?? 0;

    const step = state.currentStep;
    let valid = false;
    let message = '';
    switch (step) {
        case 0: // frontal
            if (leftEar && rightEar && landmarks[LM.NOSE] && leftEar.x > noseX && noseX > rightEar.x) {
                valid = true;
            } else {
                message = 'Повернитесь к камере фронтально.';
            }
            break;
        case 1: // left side
            if (leftEar && rightEar && landmarks[LM.NOSE]) {
                if (state.currentFacing === 'user') {
                    if (leftEar.x > noseX && rightEar.x > noseX) valid = true;
                } else {
                    if (leftEar.x < noseX && rightEar.x < noseX) valid = true;
                }
            }
            if (!valid) message = 'Повернитесь к камере левым боком.';
            break;
        case 2: // right side
            if (leftEar && rightEar && landmarks[LM.NOSE]) {
                if (state.currentFacing === 'user') {
                    if (leftEar.x < noseX && rightEar.x < noseX) valid = true;
                } else {
                    if (leftEar.x > noseX && rightEar.x > noseX) valid = true;
                }
            }
            if (!valid) message = 'Повернитесь к камере правым боком.';
            break;
        case 3: // rear view
            if (leftEar && rightEar && landmarks[LM.NOSE] && leftEar.x < noseX && noseX < rightEar.x) {
                valid = true;
            } else {
                message = 'Повернитесь к камере спиной.';
            }
            break;
        default:
            valid = true;
    }
    return { valid, message };
}


// ---------------------------------------------------------------------------
// Face blur (reusable)
// ---------------------------------------------------------------------------

/**
 * Draws a blurred ellipse over the face region on a canvas.
 *
 * This function is intentionally decoupled from the detection loop so it can
 * be reused (e.g. to blur faces on saved images before insertion into PDFs).
 *
 * @param {CanvasRenderingContext2D} ctx - Target canvas context.
 * @param {HTMLVideoElement} video      - Source video element.
 * @param {Array} landmarks             - 33-element landmark array.
 * @param {number} canvasW              - Canvas width in pixels.
 * @param {number} canvasH              - Canvas height in pixels.
 * @param {{ scale: number, offsetX: number, offsetY: number }} mapping
 */
export function blurFaceOnCanvas(ctx, video, landmarks, canvasW, canvasH, mapping) {
    const videoW = video.videoWidth;
    const videoH = video.videoHeight;

    // Collect face landmark positions in canvas coordinates.
    const pts = [];
    for (const idx of FACE_INDICES) {
        const lm = landmarks[idx];
        if (!lm || (lm.visibility !== undefined && lm.visibility < 0.3)) continue;
        pts.push(toCanvas(lm, videoW, videoH, mapping));
    }
    if (pts.length < 3) return; // not enough points to define face region

    // Compute bounding box of face landmarks.
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of pts) {
        if (p.x < minX) minX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.x > maxX) maxX = p.x;
        if (p.y > maxY) maxY = p.y;
    }

    // Generous padding so the blur covers the entire face.
    const padX = (maxX - minX) * 0.6;
    const padY = (maxY - minY) * 0.7;
    const fx = Math.max(0, minX - padX);
    const fy = Math.max(0, minY - padY);
    const fw = Math.min(canvasW - fx, (maxX - minX) + padX * 2);
    const fh = Math.min(canvasH - fy, (maxY - minY) + padY * 2);
    if (fw <= 0 || fh <= 0) return;

    // Map face canvas region back to video source coordinates.
    const srcX = Math.max(0, (fx - mapping.offsetX) / mapping.scale);
    const srcY = Math.max(0, (fy - mapping.offsetY) / mapping.scale);
    const srcW = Math.min(videoW - srcX, fw / mapping.scale);
    const srcH = Math.min(videoH - srcY, fh / mapping.scale);

    const blurRadius = Math.max(10, Math.round(Math.max(canvasW, canvasH) * 0.02));

    ctx.save();
    ctx.filter = `blur(${blurRadius}px)`;

    // Clip to an ellipse so the blur blends naturally.
    ctx.beginPath();
    ctx.ellipse(fx + fw / 2, fy + fh / 2, fw / 2, fh / 2, 0, 0, Math.PI * 2);
    ctx.clip();

    // Draw the corresponding video region with the blur filter applied.
    ctx.drawImage(video, srcX, srcY, srcW, srcH, fx, fy, fw, fh);
    ctx.restore();
}

// ---------------------------------------------------------------------------
// Figure bounds
// ---------------------------------------------------------------------------

/**
 * Determines whether the detected figure fits within the guide lines.
 *
 * @param {Array} landmarks - 33-element landmark array.
 * @param {number} videoW
 * @param {number} videoH
 * @param {number} canvasH
 * @param {{ scale: number, offsetX: number, offsetY: number }} mapping
 * @returns {{ detected: boolean, inBounds: boolean, topOverflow: boolean, bottomOverflow: boolean }}
 */
function checkFigureBounds(landmarks, videoW, videoH, canvasH, mapping) {
    const guideTop = GUIDE_TOP_PX;
    const guideBottom = canvasH - GUIDE_BOTTOM_PX;

    let topY = Infinity;
    for (const idx of TOP_INDICES) {
        const lm = landmarks[idx];
        if (!lm || (lm.visibility !== undefined && lm.visibility < 0.3)) continue;
        const y = toCanvas(lm, videoW, videoH, mapping).y;
        if (y < topY) topY = y;
    }

    let bottomY = -Infinity;
    for (const idx of BOTTOM_INDICES) {
        const lm = landmarks[idx];
        if (!lm || (lm.visibility !== undefined && lm.visibility < 0.3)) continue;
        const y = toCanvas(lm, videoW, videoH, mapping).y;
        if (y > bottomY) bottomY = y;
    }

    if (topY === Infinity || bottomY === -Infinity) {
        return { detected: false, inBounds: false, topOverflow: false, bottomOverflow: false };
    }

    const topOverflow = topY < guideTop;
    const bottomOverflow = bottomY > guideBottom;

    return {
        detected: true,
        inBounds: !topOverflow && !bottomOverflow,
        topOverflow,
        bottomOverflow,
    };
}

// ---------------------------------------------------------------------------
// UI helpers
// ---------------------------------------------------------------------------

/**
 * Shows or hides the figure-status message.
 */
function updateFigureStatusUI(figureDetected, bounds) {
    const el = document.getElementById('figure-status');
    if (!el) return;

    if (!figureDetected) {
        el.textContent = 'Фигура не в кадре';
        el.style.display = 'block';
        return;
    }

    // If pose is invalid, show pose error message
    if (!state.poseValid) {
        el.textContent = state.poseErrorMessage || 'Смените позу';
        el.style.display = 'block';
        return;
    }

    if (bounds.inBounds) {
        el.style.display = 'none';
        return;
    }

    if (bounds.topOverflow && bounds.bottomOverflow) {
        el.textContent = 'Отойдите дальше от камеры';
    } else {
        el.textContent = 'Фигура не помещается в кадр';
    }
    el.style.display = 'block';
}

/**
 * Toggles the blinking CSS class on the guide lines.
 */
function updateGuideLines(figureDetected, bounds) {
    const guideHead = document.querySelector('.guide-head');
    const guideFeet = document.querySelector('.guide-feet');

    if (!figureDetected || bounds.inBounds) {
        if (guideHead) guideHead.classList.remove('blinking');
        if (guideFeet) guideFeet.classList.remove('blinking');
        if (guideHead) guideHead.classList.toggle('in-bounds', figureDetected && bounds.inBounds);
        if (guideFeet) guideFeet.classList.toggle('in-bounds', figureDetected && bounds.inBounds);
        return;
    }

    if (guideHead) {
        guideHead.classList.toggle('blinking', bounds.topOverflow);
        guideHead.classList.remove('in-bounds');
    }
    if (guideFeet) {
        guideFeet.classList.toggle('blinking', bounds.bottomOverflow);
        guideFeet.classList.remove('in-bounds');
    }
}

/**
 * Updates the debug landmark visibility indicators on screen.
 * @param {Array|null} landmarks - 33-element landmark array, or null when no figure.
 */
function updateDebugLandmarks(landmarks) {
    /*
    const ids = [
        { el: 'dbg-nose', idx: LM.NOSE, label: '👃' },
        { el: 'dbg-leye', idx: LM.LEFT_EYE, label: '👁L' },
        { el: 'dbg-reye', idx: LM.RIGHT_EYE, label: '👁R' },
        { el: 'dbg-lear', idx: LM.LEFT_EAR, label: '👂L' },
        { el: 'dbg-rear', idx: LM.RIGHT_EAR, label: '👂R' },
    ];
    for (const { el, idx, label } of ids) {
        const span = document.getElementById(el);
        if (!span) continue;
        if (!landmarks) {
            span.textContent = `${label} —`;
            span.style.background = 'rgba(0,0,0,0.55)';
            continue;
        }
        const lm = landmarks[idx];
        const vis = lm?.visibility ?? 0;
        const x = lm?.x ?? 0;
        const y = lm?.y ?? 0;
        const z = lm?.z ?? 0;
        const ok = vis >= 0.5;
        span.textContent = `${label} v${vis.toFixed(2)} x${x.toFixed(2)} y${y.toFixed(2)} z${z.toFixed(2)}`;
        span.style.background = ok
            ? 'rgba(0,180,60,0.7)'
            : 'rgba(200,30,30,0.7)';
    }
    */
}

// ---------------------------------------------------------------------------
// Detection loop
// ---------------------------------------------------------------------------

/**
 * The main requestAnimationFrame loop that runs detection and rendering.
 */
function detectionLoop(video, canvas) {
    if (!video || video.paused || video.ended) {
        detectionLoopId = requestAnimationFrame(() => detectionLoop(video, canvas));
        return;
    }

    const ctx = canvas.getContext('2d');
    if (!ctx) {
        detectionLoopId = requestAnimationFrame(() => detectionLoop(video, canvas));
        return;
    }

    // Keep canvas size in sync with the video display area.
    const rect = video.getBoundingClientRect();
    if (canvas.width !== rect.width || canvas.height !== rect.height) {
        canvas.width = rect.width;
        canvas.height = rect.height;
    }

    const canvasW = canvas.width;
    const canvasH = canvas.height;
    const videoW = video.videoWidth;
    const videoH = video.videoHeight;

    // Clear the overlay every frame.
    ctx.clearRect(0, 0, canvasW, canvasH);

    // Wait until the video is producing frames.
    if (!videoW || !videoH) {
        detectionLoopId = requestAnimationFrame(() => detectionLoop(video, canvas));
        return;
    }

    const now = performance.now();

    // Run MediaPipe detection at the throttled rate.
    if (poseLandmarker && now - lastDetectionTime >= DETECTION_INTERVAL_MS) {
        lastDetectionTime = now;
        try {
            const results = poseLandmarker.detectForVideo(video, now);
            if (results.landmarks && results.landmarks.length > 0) {
                const lms = results.landmarks[0];
                if (isStandingPose(lms)) {
                    lastLandmarks = lms;
                    state.figureDetected = true;
                    state.lastKeypoints = lastLandmarks;
                } else {
                    // Pose detected but it's not a standing person (e.g. blanket)
                    lastLandmarks = null;
                    state.figureDetected = false;
                    state.figureInBounds = false;
                    state.lastKeypoints = null;
                }
            } else {
                lastLandmarks = null;
                state.figureDetected = false;
                state.figureInBounds = false;
                state.lastKeypoints = null;
            }
        } catch (_err) {
            // Continue silently on transient detection errors.
        }
    }

    // Render overlays using the most recent detection result.
    const mapping = getCoverMapping(videoW, videoH, canvasW, canvasH);

    if (lastLandmarks && state.figureDetected) {
        // 1. Face blur
        blurFaceOnCanvas(ctx, video, lastLandmarks, canvasW, canvasH, mapping);

        // 2. Figure bounds check
        const bounds = checkFigureBounds(lastLandmarks, videoW, videoH, canvasH, mapping);
        state.figureInBounds = bounds.inBounds;
        // Evaluate pose for current step
        const poseResult = evaluateCurrentPose(lastLandmarks);
        state.poseValid = poseResult.valid;
        state.poseErrorMessage = poseResult.message || 'Смените позу';

        // 3. UI feedback
        updateFigureStatusUI(true, bounds);
        updateGuideLines(true, bounds);

        // 4. Debug landmarks
        // updateDebugLandmarks(lastLandmarks);
    } else {
        state.figureInBounds = false;
        const noBounds = { inBounds: false, topOverflow: false, bottomOverflow: false };
        updateFigureStatusUI(false, noBounds);
        updateGuideLines(false, noBounds);
        // updateDebugLandmarks(null);
    }

    detectionLoopId = requestAnimationFrame(() => detectionLoop(video, canvas));
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Lazy-loads MediaPipe Tasks Vision from CDN and creates the Pose Landmarker.
 * Shows a loading indicator while the model downloads.
 */
export async function initDetector() {
    if (poseLandmarker) {
        state.detectorReady = true;
        return;
    }
    const statusEl = document.getElementById('figure-status');
    /*
    if (statusEl) {
        statusEl.textContent = 'Загрузка детектора\u2026';
        statusEl.style.display = 'block';
    }*/

    try {
        // Dynamic ESM import from pinned CDN version.
        // TODO(security): Consider self-hosting or adding SRI verification.
        const vision = await import(`${VISION_CDN}/vision_bundle.mjs`);
        const { PoseLandmarker, FilesetResolver } = vision;

        const fileset = await FilesetResolver.forVisionTasks(
            `${VISION_CDN}/wasm`
        );

        poseLandmarker = await PoseLandmarker.createFromOptions(fileset, {
            baseOptions: {
                modelAssetPath: MODEL_URL,
                delegate: 'GPU',
            },
            runningMode: 'VIDEO',
            numPoses: 1,
        });

        state.detectorReady = true;
        if (statusEl) statusEl.style.display = 'none';
    } catch (err) {
        console.warn('[detector] MediaPipe init failed:', err);
        state.detectorReady = false;
        if (statusEl) {
            statusEl.textContent = 'Детектор недоступен';
            setTimeout(() => { if (statusEl) statusEl.style.display = 'none'; }, 3000);
        }
    }
}

/**
 * Starts the detection loop on the camera feed.
 */
export function startDetectionLoop() {
    if (detectionLoopId) return;
    const video = document.getElementById('camera-feed');
    const canvas = document.getElementById('detector-canvas');
    if (!video || !canvas) return;
    detectionLoop(video, canvas);
}

/**
 * Stops the detection loop and resets all related state and UI.
 */
export function stopDetectionLoop() {
    if (detectionLoopId) {
        cancelAnimationFrame(detectionLoopId);
        detectionLoopId = null;
    }
    lastLandmarks = null;

    const canvas = document.getElementById('detector-canvas');
    if (canvas) {
        const ctx = canvas.getContext('2d');
        if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
    }

    state.figureDetected = false;
    state.figureInBounds = false;
    state.lastKeypoints = null;

    const guideHead = document.querySelector('.guide-head');
    const guideFeet = document.querySelector('.guide-feet');
    if (guideHead) guideHead.classList.remove('blinking', 'in-bounds');
    if (guideFeet) guideFeet.classList.remove('blinking', 'in-bounds');

    const figStatus = document.getElementById('figure-status');
    if (figStatus) figStatus.style.display = 'none';
}

/**
 * Returns the current figure detection status (for external consumers).
 */
export function getFigureStatus() {
    return {
        detected: state.figureDetected,
        inBounds: state.figureInBounds,
        keypoints: lastLandmarks,
    };
}

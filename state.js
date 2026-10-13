/**
 * Shared application state and constants used across the posture app modules.
 */
export const TOKEN_STORAGE_KEY = 'posture_app_token';
export const SESSION_STORAGE_KEY = 'posture_app_session_id';
export const CLIENT_STORAGE_KEY = 'posture_app_client_id';

export const url = new URL(window.location.href);

let initialToken = url.searchParams.get('t');
if (!initialToken && window.location.hash) {
    const hashParams = new URLSearchParams(window.location.hash.substring(1));
    initialToken = hashParams.get('t');
}

/**
 * Mutable runtime state shared by the app modules.
 */
export const state = {
    token: initialToken,
    sessionId: null,
    clientId: null,
    isRegistered: false,
    role: null,
    firstName: null,
    userId: url.searchParams.get('id') || `web_user_${Math.floor(Math.random() * 1000)}`,
    currentFacing: 'environment',
    stream: null,
    cameraZoom: 1,
    zoomSupport: false,
    pinchStartDistance: 0,
    pinchStartZoom: 1,
    cameraGesturesBound: false,
    currentStep: 0,
    maxSteps: 3,
    // true = client photographs their reflection in a mirror ("Съемка со стороны" off)
    mirrorMode: false,
    finalPhotos: [],
    finalOrientations: [],
    redirectTimer: null,
    redirectInterval: null,
    currentPitch: 0,
    targetPitch: 0,
    currentRoll: 0,
    targetRoll: 0,
    currentPitchDeg: 0,
    currentRollDeg: 0,
    pendingPitchDeg: 0,
    pendingRollDeg: 0,
    // Detector (MediaPipe Pose)
    detectorReady: false,
    figureDetected: false,
    figureInBounds: false,
    shoulderAngleDeg: 0,
    hipAngleDeg: 0,
    lastKeypoints: null,
    // New pose validation fields
    poseValid: true,
    poseErrorMessage: '',
    latestAnalysis: null,
    analysisId: null,
    // Timer fields
    captureTimer: 0,
    isTimerPending: false,
    currentCountdown: 0,
    isLevel: false,
};

/**
 * Whether camera frames are a mirror image of the scene.
 * getUserMedia frames are never mirrored by the browser (front or rear camera);
 * they are mirrored only when the rear camera films the client's reflection.
 * @returns {boolean}
 */
export function isFrameMirrored() {
    return state.mirrorMode && state.currentFacing === 'environment';
}

/**
 * Labels shown for the capture flow step indicator.
 */
export const stepLabels = [
    'Шаг 1: Вид спереди',
    'Шаг 2: Левый бок',
    'Шаг 3: Правый бок',
    'Шаг 4: Вид со спины',
];

export const MIN_CAMERA_ZOOM = 1;
export const MAX_CAMERA_ZOOM = 4;

/**
 * Validation ranges for the user form fields.
 */
export const FORM_LIMITS = {
    age: { min: 1, max: 120, label: 'возраст' },
    weight: { min: 20, max: 300, label: 'вес' },
    height: { min: 50, max: 250, label: 'рост' },
};

export const TELEGRAM_BOT_USERNAME = 'PostureTestBot';
export const SENSOR_SMOOTHING = 0.05;

# MediaPipe Measurements to Gemini Plan

We will pass the precise numerical measurements calculated by MediaPipe directly to Gemini in the text prompt, rather than relying on the vision model to "read" the lines drawn on the image. This is a much more robust approach for LLMs.

## Proposed Changes

### `server.py`
We will revert passing the annotated images to Gemini. Instead:
- We will still generate and save the annotated images for the final PDF report.
- We will collect the `measurements` dictionary returned by `process_photo(filepath, view_type)` for each of the 3-4 photos.
- We will aggregate these into a `mediapipe_data` dictionary (grouped by view, e.g., `left_profile`, `frontal`).
- We will pass the *clean* original images and the `mediapipe_data` into `analyze_posture_gemini()`.

### `analyze.py`
- Update the signature to `analyze_posture_gemini(images, patient_data=None, mediapipe_data=None)`.
- Create a new helper function `_build_mediapipe_block(mediapipe_data)` that formats the angles into readable text (e.g., "Left Profile: Forward Head Angle = 12.5°").
- Inject this text block into the `request_text` sent to Gemini.

### `posture_ai_prompt.md`
- Add a new section instructing the model to rely on the "MediaPipe Posture Measurements" provided in the prompt to inform and ground its visual analysis, preventing hallucinations about joint angles.

## User Review Required

> [!IMPORTANT]
> **Image Clarity:** Should we still send the face-blurred images to Gemini, or completely clean images? (Currently, your pipeline blurs the face *and* draws lines at the same time in `process_photo`). If we separate them, we might need a dedicated `blur_only` function.

> [!WARNING]
> **Measurements:** Currently `process_photo` returns raw dictionaries like `{'shoulder_angle': 2.5}`. I will format these into human-readable text for the prompt. Let me know if you have specific clinical thresholds you want me to add to the prompt (e.g., "An angle > 15° is severe").

## Verification Plan
1. Check that `server.py` correctly builds the `mediapipe_data` object without crashing.
2. Check that the final prompt sent to Gemini includes the formatted measurements.
3. Verify that Gemini uses these exact numbers in its JSON response (e.g., in the `observations` summary).

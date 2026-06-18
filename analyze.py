"""Posture-analysis helpers built around Vertex AI Gemini responses."""

import vertexai
from vertexai.generative_models import GenerativeModel

# `types` lives in different places depending on the installed SDK version.
# Try the stable location and fall back to None.
try:
    from vertexai import types  # latest / expected location
except Exception:
    types = None
import base64
import json
import os

from dotenv import load_dotenv
import re
import textwrap
import time
from pathlib import Path
from typing import Any, Mapping, Sequence


# Primary and fallback models to try in order
MODEL_CHAIN = [
    "gemini-2.5-flash-image",
    "gemini-2.5-pro",
    "gemini-2.5-flash",
]
BASE_DIR = Path(__file__).resolve().parent
PROMPT_PATH = BASE_DIR / "posture_ai_prompt.md"
EXERCISES_PATH = BASE_DIR / "excercises.md"

# API_KEY = os.getenv("GOOGLE_AI_API_KEY_POSTUREAI")
# client = genai.Client(api_key=API_KEY) if API_KEY else None
load_dotenv()

# Initialize Vertex AI. Project and location can be overridden via env vars.
_PROJECT = os.getenv("VERTEX_PROJECT")
_LOCATION = os.getenv("VERTEX_LOCATION")
vertexai.init(project=_PROJECT, location=_LOCATION)


def _load_text(path: Path) -> str:
    """Read UTF-8 text from a file path."""
    return path.read_text(encoding="utf-8")


def _normalize_text(value: str) -> str:
    """Normalize text for case-insensitive name matching."""
    return re.sub(r"\s+", " ", value).strip().lower()


def _extract_exercise_names(exercises_text: str) -> list[str]:
    """Extract exercise names from the reference markdown file."""
    names = re.findall(r"^###\s+\d+\.\s+(.+)$", exercises_text, flags=re.MULTILINE)
    if not names:
        raise ValueError("No exercises found in excercises.md")
    return names


def _build_patient_block(patient_data: Mapping[str, Any] | None) -> str:
    """Format patient metadata for inclusion in the model prompt."""
    patient_data = patient_data or {}
    photo_count = int(patient_data.get('photo_count') or 3)
    helper_note = "- Фото 4: вид со спины (с помощником)" if photo_count >= 4 else ""
    lines = [
        "Анкетные данные пациента:",
        f"- Возраст: {patient_data.get('age', 'не указан')}",
        f"- Вес: {patient_data.get('weight', 'не указан')}",
        f"- Рост: {patient_data.get('height', 'не указан')}",
        f"- Пол: {patient_data.get('gender', 'не указан')}",
        "",
        "Входные фотографии:",
        "- Фото 1: профиль слева",
        "- Фото 2: профиль справа",
        "- Фото 3: фронтальный или задний вид",
        helper_note,
    ]
    return "\n".join(line for line in lines if line)


def _build_request_text(patient_data: Mapping[str, Any] | None, exercises_text: str) -> str:
    """Construct the full prompt sent to the model."""
    base_prompt = _load_text(PROMPT_PATH)
    patient_block = _build_patient_block(patient_data)
    return textwrap.dedent(
        f"""\
        {base_prompt}

        ---

        {patient_block}

        ---

        Справочник упражнений:
        {exercises_text}

        ---

        Верни только JSON без пояснительного текста и без markdown. Формат ответа:
        {{
            "summary": "Краткое резюме по осанке и данным пациента",
            "observations": {{
                "head": "Краткое описание головы",
                "shoulders": "Краткое описание плеч",
                "pelvis": "Краткое описание таза",
                "spine": "Краткое описание позвоночника",
                "legs": "Краткое описание ног"
            }},
            "recommended_exercises": [
                {{
                    "name": "Название упражнения строго из справочника",
                    "reason": "Почему оно подходит этому пациенту"
                }}
            ],
            "disclaimer": "Краткое предупреждение о предварительном характере рекомендаций"
        }}

        Требования к ответу:
        - Верни ровно 5 упражнений.
        - Используй только названия из справочника.
        - Не придумывай новые упражнения.
        - Если данных недостаточно, укажи это в `observations`, но все равно выбери 5 лучших доступных упражнений из справочника.
        """
    )


def _strip_json_fences(text: str) -> str:
    """Remove markdown fences and return the JSON payload substring."""
    cleaned = text.strip()
    if cleaned.startswith("```"):
        cleaned = re.sub(r"^```(?:json)?\s*", "", cleaned, flags=re.IGNORECASE)
        cleaned = re.sub(r"\s*```$", "", cleaned)
    start = cleaned.find("{")
    end = cleaned.rfind("}")
    if start == -1 or end == -1 or end < start:
        raise ValueError("Model response does not contain JSON")
    return cleaned[start : end + 1]


def _coerce_recommendations(payload: Mapping[str, Any], allowed_names: Sequence[str]) -> dict[str, Any]:
    """Filter model recommendations down to five allowed exercise names."""
    allowed_lookup = {_normalize_text(name): name for name in allowed_names}

    recommendations = payload.get("recommended_exercises")
    if recommendations is None:
        recommendations = payload.get("exercises", [])

    if not isinstance(recommendations, list):
        raise ValueError("Model response must contain a list of recommendations")

    cleaned_recommendations: list[dict[str, Any]] = []
    seen_names: set[str] = set()

    for item in recommendations:
        if len(cleaned_recommendations) == 5:
            break

        if isinstance(item, str):
            name = item
            reason = ""
        elif isinstance(item, Mapping):
            name = str(item.get("name") or item.get("exercise") or "").strip()
            reason = str(item.get("reason") or item.get("why") or item.get("justification") or "").strip()
        else:
            continue

        normalized_name = _normalize_text(name)
        canonical_name = allowed_lookup.get(normalized_name)
        if not canonical_name or canonical_name in seen_names:
            continue

        cleaned_recommendations.append({"name": canonical_name, "reason": reason})
        seen_names.add(canonical_name)

    if not cleaned_recommendations:
        raise ValueError("Model failed to provide any valid exercises from the reference list")

    if len(cleaned_recommendations) != 5:
        print(f"Warning: Expected 5 valid exercises from model, got {len(cleaned_recommendations)}")

    result = dict(payload)
    result["recommended_exercises"] = cleaned_recommendations
    result["summary"] = str(result.get("summary", "")).strip()
    result["disclaimer"] = str(result.get("disclaimer", "")).strip()
    return result


def analyze_posture_gemini(images: Sequence[str], patient_data: Mapping[str, Any] | None = None) -> dict[str, Any]:
    """Analyze posture photos and return 5 exercise recommendations from the reference list.
    
    Tries models in MODEL_CHAIN order, retrying on 503 UNAVAILABLE errors.
    Adds 'model_used' to the result to indicate which model succeeded.
    """

    # Vertex AI is initialized via vertexai.init above; no API client object is required here.

    if isinstance(images, str):
        images = [images]

    if len(images) < 3:
        raise ValueError("At least 3 posture photos are required")

    images = list(images)
    photo_count = min(len(images), 4)

    exercises_text = _load_text(EXERCISES_PATH)
    allowed_names = _extract_exercise_names(exercises_text)
    analysis_patient_data = dict(patient_data or {})
    analysis_patient_data["photo_count"] = photo_count
    request_text = _build_request_text(analysis_patient_data, exercises_text)
    # Build multimodal `Content` (preferred) if `types` is available; otherwise
    # fall back to embedding images as base64 data URLs in a single text prompt.
    # Only use multimodal parts when the imported `types` exposes the
    # expected classes (`Part` and `Content`). Some SDK builds expose a
    # `types` module without these helpers, so check for them explicitly.
    content_parts = None
    prompt = ""
    if types is not None and hasattr(types, "Part") and hasattr(types, "Content"):
        content_parts = [
            types.Part.from_text(text=request_text),
        ]

        for image_base64 in images[:photo_count]:
            encoded_image = image_base64.split(",", 1)[1] if "," in image_base64 else image_base64
            content_parts.append(
                types.Part.from_bytes(
                    data=base64.b64decode(encoded_image),
                    mime_type="image/jpeg",
                )
            )
        use_multimodal = True
    else:
        prompt_parts = [request_text]
        for idx, image_base64 in enumerate(images[:photo_count], start=1):
            encoded_image = image_base64.split(",", 1)[1] if "," in image_base64 else image_base64
            prompt_parts.append(f"---\nPhoto {idx} (base64):\ndata:image/jpeg;base64,{encoded_image}\n")
        prompt = "\n\n".join(prompt_parts)
        use_multimodal = False

    # Try each model in the chain, with retry on 503
    last_error = None
    for model in MODEL_CHAIN:
        for attempt in range(3):  # Up to 3 retries per model
            try:
                model_obj = GenerativeModel(model)
                if types is not None and use_multimodal:
                    response = model_obj.generate_content(
                        contents=types.Content(role="user", parts=content_parts),
                    )
                else:
                    response = model_obj.generate_content(prompt)
                raw_text = response.text or ""
                parsed = json.loads(_strip_json_fences(raw_text))
                if not isinstance(parsed, dict):
                    raise ValueError("Model response must be a JSON object")
                result = _coerce_recommendations(parsed, allowed_names)
                result["model_used"] = model
                return result
            except Exception as e:
                last_error = e
                # If it's a 503 or UNAVAILABLE, retry with backoff
                if "503" in str(e) or "UNAVAILABLE" in str(e):
                    wait_time = 2 ** attempt  # Exponential backoff: 1s, 2s, 4s
                    print(f"Model {model} returned 503, retrying in {wait_time}s (attempt {attempt + 1}/3)")
                    time.sleep(wait_time)
                else:
                    # Other errors don't benefit from retry on same model
                    break
    
    # If we get here, all models and attempts failed
    raise last_error or RuntimeError("All models in MODEL_CHAIN failed to respond")


if __name__ == "__main__":
    print("=" * 60)
    print("Posture Analysis Module")
    print("=" * 60)
    
    print(f"Vertex AI initialized for project: {_PROJECT} ({_LOCATION})")
    
    print("\nModule contains:")
    print("  - analyze_posture_gemini(images, patient_data) -> dict")
    print("    Analyzes 3 posture photos and returns 5 exercise recommendations.")
    print("\nUsage:")
    print("  from analyze import analyze_posture_gemini")
    print("  result = analyze_posture_gemini(images=[img1, img2, img3], patient_data={...})")
    print("=" * 60)

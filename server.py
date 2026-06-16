"""Flask entrypoint for posture analysis uploads, sessions, and PDF delivery."""

from flask import Flask, request, jsonify, send_from_directory, abort
import base64
import os
import json
import logging
import traceback
from datetime import datetime
try:
    from analyze import analyze_posture_gemini
except Exception:
    # analysis backend is optional for endpoint testing; provide a stub
    def analyze_posture_gemini(images=None, patient_data=None):
        raise RuntimeError('analysis backend not available in test environment')

from service import generate_pdf_from_analysis, deliver_pdf_to_telegram
from security import decode_token, claim_token, restore_session, validate_session
from database import save_draft_analysis, update_posture_analysis_photos, update_posture_analysis_result
from routes.auth_routes import auth_bp
from dotenv import load_dotenv

load_dotenv()

app = Flask(__name__, static_folder='.')
logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(message)s')

@app.after_request
def add_header(response):
    """Cache static assets (CSS/JS/images/WASM); disable caching for API and HTML."""
    content_type = response.content_type or ''
    if app.debug:
        response.headers['Cache-Control'] = 'no-store, no-cache, must-revalidate, max-age=0'
        response.headers['Pragma'] = 'no-cache'
        response.headers['Expires'] = '0'
        return response

    if any(ct in content_type for ct in ['text/html', 'text/css', 'javascript', 'image/', 'font/', 'application/wasm']):
        response.headers['Cache-Control'] = 'public, max-age=3600, stale-while-revalidate=86400'
    else:
        response.headers['Cache-Control'] = 'no-store, no-cache, must-revalidate, max-age=0'
        response.headers['Pragma'] = 'no-cache'
        response.headers['Expires'] = '0'
    return response

logger = logging.getLogger(__name__)
BASE_DIR = os.path.dirname(os.path.abspath(__file__))

# Папка для хранения результатов
UPLOAD_FOLDER = os.path.join(BASE_DIR, 'received_photos')
os.makedirs(UPLOAD_FOLDER, exist_ok=True)

RESULTS_FOLDER = os.path.join(BASE_DIR, 'results')
os.makedirs(RESULTS_FOLDER, exist_ok=True)

# Раздача фронтенда
@app.route('/')
def index():
    """Serve the main client application."""
    import time
    start = time.time()
    res = send_from_directory('.', 'index.html')
    elapsed = time.time() - start
    logger.info(f"Served index.html in {elapsed*1000:.2f}ms")
    return res

# Регистрируем роуты авторизации и работы с БД
app.register_blueprint(auth_bp)

# Раздача CSS и JS
@app.route('/<path:path>')
def static_files(path): 
    """Serve static files from the project root."""
    return send_from_directory('.', path)


@app.route('/debug/log', methods=['POST'])
def debug_log():
    """Receive debug logs from clients and append them to a server-side file.

    This helps debugging issues when users can't open DevTools on their device.
    """
    data = request.json or {}
    client_id = data.get('client_id')
    session_id = data.get('session_id')
    event = data.get('event')
    payload = data.get('payload')
    ts = datetime.now().isoformat()
    try:
        fname = os.path.join(RESULTS_FOLDER, 'client_debug_logs.txt')
        with open(fname, 'a', encoding='utf-8') as f:
            entry = {'ts': ts, 'client_id': client_id, 'session_id': session_id, 'event': event, 'payload': payload}
            f.write(json.dumps(entry, ensure_ascii=False) + '\n')
    except Exception as e:
        logger.warning('Failed to write debug log: %s', e)
    return jsonify({'status': 'ok'})

@app.route('/form/save_draft', methods=['POST'])
def save_draft():
    """Save form data as a draft before uploading photos."""
    data = request.json or {}
    session_id = data.get('session_id')
    client_id = data.get('client_id')
    token = data.get('token')
    
    uid = validate_session(session_id)
    if not uid and client_id:
        uid, session_id = restore_session(client_id)
    if not uid and token:
        uid, session_id = claim_token(token, client_id=client_id)
    
    if not uid:
        return jsonify({'status': 'error', 'message': 'Session expired or missing.'}), 403
        
    user_data = data.get('user_data', {})
    age = user_data.get('age')
    weight = user_data.get('weight')
    height = user_data.get('height')
    gender = user_data.get('gender')
    
    analysis_id = save_draft_analysis(uid, age, weight, height, gender)
    if analysis_id is not None:
        return jsonify({'status': 'success', 'analysis_id': analysis_id})
    else:
        return jsonify({'status': 'error', 'message': 'Failed to save draft'}), 500

# ПРИЕМНИК: АНКЕТА + ФОТО
@app.route('/upload', methods=['POST'])
def upload():
    """Receive form data and photos, run analysis, and save the report."""
    data = request.json
    if not data:
        logger.warning('Upload request received without JSON body')
        return jsonify({'status': 'error', 'message': 'No data'}), 400

    session_id = data.get('session_id')
    client_id = data.get('client_id')
    token = data.get('token')
    uid = validate_session(session_id)
    if not uid and client_id:
        uid, session_id = restore_session(client_id)
    if not uid and token:
        uid, session_id = claim_token(token, client_id=client_id)
    if not uid:
        return jsonify({'status': 'error', 'message': 'Session expired or missing. Request a new Telegram link.'}), 403

    info = data.get('user_data', {})
    images = data.get('images', [])
    orientations = data.get('orientations', [])
    analysis_id = data.get('analysis_id')
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")

    # Accept either 3 images (solo) or 4 images (with helper / back view)
    if len(images) not in (3, 4):
        logger.warning('Upload rejected for user_id=%s: expected 3 or 4 images, got %s', uid, len(images))
        return jsonify({
            'status': 'error',
            'message': '3 or 4 images are required for posture analysis.'
        }), 400
    
    # 1. Сохраняем анкету в .txt
    # Теперь ID пользователя ГАРАНТИРОВАННО записывается первой строкой
    info_filename = f"{uid}_{ts}_data.txt"
    analysis_result = None
    analysis_error = None
    pdf_report = None
    try:
        with open(os.path.join(UPLOAD_FOLDER, info_filename), 'w', encoding='utf-8') as f:
            f.write(f"User ID: {uid}\n")
            f.write(f"Age: {info.get('age')}\n")
            f.write(f"Weight: {info.get('weight')}\n")
            f.write(f"Height: {info.get('height')}\n")
            f.write(f"Gender: {info.get('gender')}\n")
    except Exception as e:
        print(f"Ошибка при записи текстового файла: {e}")
    
    # 2. Сохраняем фотографии в .jpg
    saved_photos = []
    for i, img_base64 in enumerate(images):
        try:
            if "," in img_base64:
                encoded = img_base64.split(",", 1)[1]
            else:
                encoded = img_base64
            
            img_data = base64.b64decode(encoded)
            
            pitch = orientations[i].get('pitch') if i < len(orientations) and orientations[i] else None
            roll = orientations[i].get('roll') if i < len(orientations) and orientations[i] else None
            
            if pitch is not None and roll is not None and (abs(pitch) > 0.5 or abs(roll) > 0.5):
                try:
                    import cv2
                    import numpy as np
                    from perspective_utils import correct_image_perspective, get_focal_length_from_exif
                    np_arr = np.frombuffer(img_data, np.uint8)
                    img_cv = cv2.imdecode(np_arr, cv2.IMREAD_COLOR)
                    if img_cv is not None:
                        h, w = img_cv.shape[:2]
                        _, K = get_focal_length_from_exif("", w, h, fallback_35mm=26.0)
                        corrected_cv = correct_image_perspective(img_cv, pitch, roll, K)
                        
                        success, buffer = cv2.imencode('.jpg', corrected_cv, [cv2.IMWRITE_JPEG_QUALITY, 90])
                        if success:
                            img_data = buffer.tobytes()
                            images[i] = "data:image/jpeg;base64," + base64.b64encode(img_data).decode('utf-8')
                except Exception as e:
                    logger.warning("Failed to unwarp image: %s", e)
            
            filename = f"{uid}_{ts}_photo_{i+1}.jpg"
            filepath = os.path.join(UPLOAD_FOLDER, filename)
            
            with open(filepath, 'wb') as f:
                f.write(img_data)
                
            # Если есть ориентация для этого фото, запишем её в EXIF UserComment
            if i < len(orientations) and orientations[i]:
                try:
                    import piexif
                    pitch = orientations[i].get('pitch')
                    roll = orientations[i].get('roll')
                    if pitch is not None and roll is not None:
                        try:
                            exif_dict = piexif.load(filepath)
                        except Exception:
                            exif_dict = {"0th": {}, "Exif": {}, "GPS": {}, "1st": {}, "Interop": {}}
                        
                        if "Exif" not in exif_dict or exif_dict["Exif"] is None:
                            exif_dict["Exif"] = {}
                            
                        # Изображение уже выровнено, поэтому pitch=0, roll=0. 
                        # Сохраним оригинальные углы для отладки.
                        data_json = json.dumps({"pitch": 0.0, "roll": 0.0, "original_pitch": pitch, "original_roll": roll})
                        user_comment = b"ASCII\0\0\0" + data_json.encode('utf-8')
                        exif_dict["Exif"][piexif.ExifIFD.UserComment] = user_comment  # type: ignore
                        exif_bytes = piexif.dump(exif_dict)
                        piexif.insert(exif_bytes, filepath)
                except ImportError:
                    logger.warning("piexif not installed. Cannot save orientation to EXIF.")
                except Exception as e:
                    logger.warning("Failed to save EXIF orientation: %s", e)
                    
            saved_photos.append(filename)
        except Exception as e:
            print(f"Ошибка при сохранении изображения {i}: {e}")

    if len(saved_photos) not in (3, 4):
        return jsonify({
            'status': 'error',
            'message': f'Failed to save all images. Saved: {len(saved_photos)} of expected 3 or 4.'
        }), 500

    if analysis_id:
        update_posture_analysis_photos(analysis_id, len(saved_photos), saved_photos, ts)

    # 3. Анализируем осанку через Gemini и сохраняем результат
    analysis_result = None
    analysis_error = None
    pdf_report = None
    try:
        analysis_result = analyze_posture_gemini(images=images, patient_data=info)
        analysis_filename = f"{uid}_{ts}_analysis.json"
        logger.info('Analysis completed for user_id=%s', uid)

        # Основная копия рядом с медиафайлами
        with open(os.path.join(UPLOAD_FOLDER, analysis_filename), 'w', encoding='utf-8') as f:
            json.dump(analysis_result, f, ensure_ascii=False, indent=2)

        # Параллельная копия в results для последующей интеграции доставки
        with open(os.path.join(RESULTS_FOLDER, analysis_filename), 'w', encoding='utf-8') as f:
            json.dump(analysis_result, f, ensure_ascii=False, indent=2)
            
        if analysis_id:
            update_posture_analysis_result(analysis_id, analysis_result, 'analyzed')
        
        # Generate PDF report from the analysis results
        try:
            pdf_path = generate_pdf_from_analysis(uid, ts)
            logger.info('PDF report generated successfully for user_id=%s: %s', uid, pdf_path)
            pdf_report = pdf_path

            # Delegate delivery to service helper (non-blocking)
            try:
                delivered = deliver_pdf_to_telegram(pdf_path, uid)
                if delivered:
                    logger.info('PDF sent to Telegram for user_id=%s', uid)
                else:
                    logger.info('PDF delivery skipped/failed for user_id=%s', uid)
            except Exception as deliver_err:
                logger.warning('PDF delivery helper failed for user_id=%s: %s', uid, str(deliver_err))

        except Exception as pdf_err:
            logger.warning('Failed to generate PDF report for user_id=%s: %s', uid, str(pdf_err))
            # Don't fail the entire upload if PDF generation fails
            
    except Exception as e:
        analysis_error = str(e)
        logger.exception('Gemini analysis failed for user_id=%s: %s', uid, analysis_error)
        traceback.print_exc()
        error_filename = f"{uid}_{ts}_analysis_error.json"
        error_payload = {
            'user_id': uid,
            'timestamp': ts,
            'status': 'error',
            'message': analysis_error,
        }
        with open(os.path.join(UPLOAD_FOLDER, error_filename), 'w', encoding='utf-8') as f:
            json.dump(error_payload, f, ensure_ascii=False, indent=2)
        with open(os.path.join(RESULTS_FOLDER, error_filename), 'w', encoding='utf-8') as f:
            json.dump(error_payload, f, ensure_ascii=False, indent=2)
            
        if analysis_id:
            update_posture_analysis_result(analysis_id, {'error': analysis_error}, 'error')
            
    logger.info('Upload processed for user_id=%s, saved_photos=%s, analysis_ok=%s', uid, len(saved_photos), analysis_result is not None)
    return jsonify({
        'status': 'success',
        'saved_count': len(saved_photos),
        'analysis': analysis_result,
        'analysis_error': analysis_error,
        'pdf_report': pdf_report,
    })

if __name__ == '__main__':
    # Запуск на порту 8001
    app.run(host='0.0.0.0', port=8001, debug=False, use_reloader=False)

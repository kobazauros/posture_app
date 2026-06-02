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

app = Flask(__name__, static_folder='.')
logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(message)s')
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
    return send_from_directory('.', 'index.html')


@app.route('/session/claim', methods=['POST'])
def claim_session():
    """Claim a Telegram token for the current client session."""
    data = request.json or {}
    token = data.get('token')
    client_id = data.get('client_id')
    if not token:
        return jsonify({'status': 'error', 'message': 'No token provided'}), 400

    # If the token decodes but was already claimed, and it was claimed by the same
    # client_id, return the existing session instead of erroring out. This prevents
    # creating multiple sessions when the user reopens the camera in another
    # window/tab for the same device.
    from security import load_session_registry
    try:
        # Decode token to obtain user_id for registry lookup
        user_id_decoded, _ = decode_token(token)
    except Exception:
        user_id_decoded = None

    if user_id_decoded:
        registry = load_session_registry()
        entry = registry.get(str(user_id_decoded)) if isinstance(registry, dict) else None
        if isinstance(entry, dict) and entry.get('claimed') and entry.get('session_id'):
            # If token belongs to a user who already has a claimed session, prefer
            # returning that existing session instead of creating a new one.
            # If the client_id differs, update it to reflect the current client.
            if client_id and entry.get('client_id') != client_id:
                entry['client_id'] = client_id
                registry[str(user_id_decoded)] = entry
                try:
                    from security import save_session_registry
                    save_session_registry(registry)
                except Exception:
                    pass
            return jsonify({'status': 'success', 'user_id': user_id_decoded, 'session_id': entry.get('session_id')})

    # Not claimed yet: attempt to claim normally.
    user_id, session_id = claim_token(token, client_id=client_id)
    if not user_id or not session_id:
        return jsonify({'status': 'error', 'message': 'Token already used or invalid. Request a new Telegram link.'}), 403

    return jsonify({'status': 'success', 'user_id': user_id, 'session_id': session_id})


@app.route('/session/restore', methods=['POST'])
def restore_existing_session():
    """Restore an existing session for a remembered client id."""
    data = request.json or {}
    client_id = data.get('client_id')
    if not client_id:
        return jsonify({'status': 'error', 'message': 'No client id provided'}), 400

    user_id, session_id = restore_session(client_id)
    if not user_id or not session_id:
        return jsonify({'status': 'error', 'message': 'No existing session'}), 404

    return jsonify({'status': 'success', 'user_id': user_id, 'session_id': session_id})


@app.route('/session/close', methods=['POST'])
def close_session():
    """Close a claimed session by session_id or client_id and remove it from the registry."""
    data = request.json or {}
    session_id = data.get('session_id')
    client_id = data.get('client_id')

    closed = False
    from security import close_session_by_session_id, close_session_by_client_id

    logger.info('session/close called with session_id=%s client_id=%s', session_id, client_id)
    if session_id:
        closed = close_session_by_session_id(session_id)
    elif client_id:
        closed = close_session_by_client_id(client_id)
    else:
        return jsonify({'status': 'error', 'message': 'No session_id or client_id provided'}), 400

    if closed:
        return jsonify({'status': 'success'})
    return jsonify({'status': 'error', 'message': 'Session not found or already closed'}), 404

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
            filename = f"{uid}_{ts}_photo_{i+1}.jpg"
            filepath = os.path.join(UPLOAD_FOLDER, filename)
            
            with open(filepath, 'wb') as f:
                f.write(img_data)
            saved_photos.append(filename)
        except Exception as e:
            print(f"Ошибка при сохранении изображения {i}: {e}")

    if len(saved_photos) not in (3, 4):
        return jsonify({
            'status': 'error',
            'message': f'Failed to save all images. Saved: {len(saved_photos)} of expected 3 or 4.'
        }), 500

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
    app.run(host='0.0.0.0', port=8001, debug=True)

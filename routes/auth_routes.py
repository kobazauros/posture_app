from flask import Blueprint, request, jsonify
import logging
from security import decode_token, claim_token, restore_session, load_session_registry, save_session_registry, close_session_by_session_id, close_session_by_client_id
from database import get_user_by_telegram_id, register_user, get_latest_posture_analysis

logger = logging.getLogger(__name__)

auth_bp = Blueprint('auth', __name__)

@auth_bp.route('/session/claim', methods=['POST'])
def claim_session():
    """Claim a Telegram token for the current client session."""
    data = request.json or {}
    token = data.get('token')
    client_id = data.get('client_id')
    if not token:
        return jsonify({'status': 'error', 'message': 'No token provided'}), 400

    try:
        user_id_decoded, _ = decode_token(token)
    except Exception:
        user_id_decoded = None

    if user_id_decoded:
        registry = load_session_registry()
        entry = registry.get(user_id_decoded) if isinstance(registry, dict) else None
        if isinstance(entry, dict) and entry.get('claimed') and entry.get('session_id'):
            if client_id and entry.get('client_id') != client_id:
                entry['client_id'] = client_id
                for other_id, other_entry in list(registry.items()):
                    if other_id != user_id_decoded and isinstance(other_entry, dict) and other_entry.get("client_id") == client_id:
                        other_entry["client_id"] = None
                        registry[other_id] = other_entry
                registry[user_id_decoded] = entry
                try:
                    save_session_registry(registry)
                except Exception:
                    pass
            
            # Check if user is in Postgres
            logger.info(f"Looking up existing session user in DB by telegram_id: {user_id_decoded}")
            user = get_user_by_telegram_id(user_id_decoded)
            logger.info(f"DB search result: {user}")
            latest_analysis = get_latest_posture_analysis(user_id_decoded)
            
            return jsonify({
                'status': 'success', 
                'user_id': user_id_decoded, 
                'session_id': entry.get('session_id'),
                'is_registered': user is not None,
                'first_name': user.get('first_name') if user else None,
                'last_name': user.get('last_name') if user else None,
                'role': user.get('role') if user else None,
                'latest_analysis': latest_analysis
            })

    # Not claimed yet: attempt to claim normally.
    user_id, session_id = claim_token(token, client_id=client_id)
    if not user_id or not session_id:
        return jsonify({'status': 'error', 'message': 'Token already used or invalid. Request a new Telegram link.'}), 403

    logger.info(f"Looking up new session user in DB by telegram_id: {user_id}")
    user = get_user_by_telegram_id(user_id)
    logger.info(f"DB search result: {user}")
    latest_analysis = get_latest_posture_analysis(user_id)
    
    return jsonify({
        'status': 'success', 
        'user_id': user_id, 
        'session_id': session_id,
        'is_registered': user is not None,
        'first_name': user.get('first_name') if user else None,
        'last_name': user.get('last_name') if user else None,
        'role': user.get('role') if user else None,
        'latest_analysis': latest_analysis
    })


@auth_bp.route('/session/restore', methods=['POST'])
def restore_existing_session():
    """Restore an existing session for a remembered client id."""
    data = request.json or {}
    client_id = data.get('client_id')
    if not client_id:
        return jsonify({'status': 'error', 'message': 'No client id provided'}), 400

    user_id, session_id = restore_session(client_id)
    if not user_id or not session_id:
        return jsonify({'status': 'error', 'message': 'No existing session'}), 404

    logger.info(f"Looking up restored session user in DB by telegram_id: {user_id}")
    user = get_user_by_telegram_id(user_id)
    logger.info(f"DB search result: {user}")
    latest_analysis = get_latest_posture_analysis(user_id)
    
    return jsonify({
        'status': 'success', 
        'user_id': user_id, 
        'session_id': session_id,
        'is_registered': user is not None,
        'first_name': user.get('first_name') if user else None,
        'last_name': user.get('last_name') if user else None,
        'role': user.get('role') if user else None,
        'latest_analysis': latest_analysis
    })


@auth_bp.route('/session/close', methods=['POST'])
def close_session():
    """Close a claimed session by session_id or client_id and remove it from the registry."""
    data = request.json or {}
    session_id = data.get('session_id')
    client_id = data.get('client_id')

    closed = False

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

@auth_bp.route('/user/register', methods=['POST'])
def register_user_endpoint():
    """Register a new user in the database after the onboarding form."""
    data = request.json or {}
    session_id = data.get('session_id')
    first_name = data.get('first_name')
    last_name = data.get('last_name')
    frontend_role = data.get('role')
    
    # We must validate the session_id to get the secure user_id
    from security import validate_session
    user_id = validate_session(session_id)
    
    if not user_id:
        return jsonify({'status': 'error', 'message': 'Invalid session'}), 403
        
    if not first_name or not frontend_role:
        return jsonify({'status': 'error', 'message': 'Missing required fields'}), 400
        
    # Map frontend role to database role
    # DB expects: 'client', 'specialist-pending', 'specialist-refused', 'specialist-approved', 'admin'
    db_role = 'client'
    if frontend_role == 'doctor':
        db_role = 'specialist-pending'
    elif frontend_role == 'patient':
        db_role = 'client'
        
    success = register_user(user_id, first_name, last_name, db_role)
    if success:
        if db_role == 'specialist-pending':
            from database import get_admins
            import telebot
            import os
            from telebot import types
            
            token = os.getenv("TOKEN")
            if token:
                try:
                    bot = telebot.TeleBot(token)
                    admins = get_admins()
                    for admin in admins:
                        admin_id = admin.get('telegram_id')
                        if admin_id:
                            markup = types.InlineKeyboardMarkup()
                            btn_approve = types.InlineKeyboardButton("✅ Одобрить", callback_data=f"approve_spec_{user_id}")
                            btn_reject = types.InlineKeyboardButton("❌ Отказать", callback_data=f"reject_spec_{user_id}")
                            markup.row(btn_approve, btn_reject)
                            bot.send_message(
                                admin_id,
                                f"🆕 <b>Зарегистрирован новый специалист:</b>\n{first_name} {last_name}",
                                reply_markup=markup,
                                parse_mode="HTML"
                            )
                except Exception as e:
                    logger.error(f"Failed to notify admins about new specialist: {e}")

        return jsonify({'status': 'success', 'message': 'User registered successfully', 'role': db_role})
    else:
        return jsonify({'status': 'error', 'message': 'Failed to register user'}), 500

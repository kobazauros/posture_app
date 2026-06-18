import os
import psycopg2
from psycopg2.extras import RealDictCursor
import logging
import json

logger = logging.getLogger(__name__)

def get_db_connection():
    """
    Establish and return a connection to the PostgreSQL database.
    Uses DATABASE_URL from the environment or .env file.
    """
    database_url = os.getenv("DATABASE_URL")
    if not database_url:
        logger.error("DATABASE_URL is not set in the environment.")
        return None
        
    try:
        conn = psycopg2.connect(database_url, cursor_factory=RealDictCursor)
        return conn
    except Exception as e:
        logger.error(f"Failed to connect to database: {e}")
        return None

def get_user_by_telegram_id(telegram_id):
    """
    Fetch a user from the database by their telegram_id.
    Returns a dictionary with user data if found, otherwise None.
    """
    if not telegram_id:
        return None
        
    conn = get_db_connection()
    if not conn:
        return None
        
    try:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT id, telegram_id, role, first_name, last_name FROM users WHERE telegram_id = %s",
                (telegram_id,)
            )
            user = cur.fetchone()
            return dict(user) if user else None
    except Exception as e:
        logger.error(f"Error fetching user by telegram_id {telegram_id}: {e}")
        return None
    finally:
        conn.close()

def register_user(telegram_id, first_name, last_name, role):
    """
    Registers a new user in the database.
    If the user already exists (by telegram_id), ignores the insert (or updates if needed).
    """
    if not telegram_id:
        return False
        
    conn = get_db_connection()
    if not conn:
        return False
        
    try:
        with conn.cursor() as cur:
            # Using ON CONFLICT DO NOTHING to prevent duplicate key errors 
            # if multiple requests arrive simultaneously.
            cur.execute(
                """
                INSERT INTO users (telegram_id, first_name, last_name, role)
                VALUES (%s, %s, %s, %s)
                ON CONFLICT (telegram_id) DO NOTHING
                RETURNING id
                """,
                (telegram_id, first_name, last_name, role)
            )
            conn.commit()
            return True
    except Exception as e:
        logger.error(f"Error registering user {telegram_id}: {e}")
        conn.rollback()
        return False
    finally:
        conn.close()

def get_admins():
    """
    Fetch all users with role 'admin'.
    Returns a list of dictionaries with admin data.
    """
    conn = get_db_connection()
    if not conn:
        return []
        
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT id, telegram_id, role, first_name, last_name FROM users WHERE role = 'admin'")
            admins = cur.fetchall()
            return [dict(admin) for admin in admins]
    except Exception as e:
        logger.error(f"Error fetching admins: {e}")
        return []
    finally:
        conn.close()

def update_user_role(telegram_id, role):
    """
    Updates the role of a user by their telegram_id.
    """
    if not telegram_id:
        return False
        
    conn = get_db_connection()
    if not conn:
        return False
        
    try:
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE users SET role = %s WHERE telegram_id = %s",
                (role, telegram_id)
            )
            conn.commit()
            return True
    except Exception as e:
        logger.error(f"Error updating user role for {telegram_id}: {e}")
        conn.rollback()
        return False
    finally:
        conn.close()

def get_latest_posture_analysis(author_id):
    """
    Fetch the latest posture analysis (draft or other) for a given user.
    """
    if not author_id:
        return None
        
    conn = get_db_connection()
    if not conn:
        return None
        
    try:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT * FROM posture_analyses WHERE author_id = %s ORDER BY created_at DESC LIMIT 1",
                (author_id,)
            )
            analysis = cur.fetchone()
            return dict(analysis) if analysis else None
    except Exception as e:
        logger.error(f"Error fetching latest analysis for {author_id}: {e}")
        return None
    finally:
        conn.close()

def save_draft_analysis(author_id, age, weight, height, gender, analysis_type='basic', patient_first_name=None, patient_last_name=None):
    """
    Creates or updates a draft analysis for the user.
    If the latest analysis is a draft, it updates it. Otherwise, creates a new one.
    Returns the analysis ID.
    """
    if not author_id:
        return None

    conn = get_db_connection()
    if not conn:
        return None
        
    try:
        with conn.cursor() as cur:
            # Check the latest analysis
            cur.execute(
                "SELECT id, status FROM posture_analyses WHERE author_id = %s ORDER BY created_at DESC LIMIT 1",
                (author_id,)
            )
            latest_row = cur.fetchone()
            latest = dict(latest_row) if latest_row else None
            
            if latest and latest.get('status') == 'draft':
                # Update existing draft
                cur.execute(
                    """
                    UPDATE posture_analyses 
                    SET age = %s, weight = %s, height = %s, gender = %s, analysis_type = %s, patient_first_name = %s, patient_last_name = %s, created_at = CURRENT_TIMESTAMP
                    WHERE id = %s
                    RETURNING id
                    """,
                    (age, weight, height, gender, analysis_type, patient_first_name, patient_last_name, latest['id'])
                )
                res = cur.fetchone()
                analysis_id = dict(res)['id'] if res else None
            else:
                # Insert new draft
                cur.execute(
                    """
                    INSERT INTO posture_analyses (author_id, age, weight, height, gender, analysis_type, patient_first_name, patient_last_name, status)
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s, 'draft')
                    RETURNING id
                    """,
                    (author_id, age, weight, height, gender, analysis_type, patient_first_name, patient_last_name)
                )
                res = cur.fetchone()
                analysis_id = dict(res)['id'] if res else None
                
            conn.commit()
            return analysis_id
    except Exception as e:
        logger.error(f"Error saving draft analysis for {author_id}: {e}")
        conn.rollback()
        return None
    finally:
        conn.close()

def update_posture_analysis_photos(analysis_id, photos_count, photo_paths, session_timestamp=None):
    """
    Updates the analysis record with photo information and sets status to 'uploaded'.
    """
    if not analysis_id:
        return False
        
    conn = get_db_connection()
    if not conn:
        return False
        
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                UPDATE posture_analyses 
                SET photos_count = %s, photo_paths = %s, session_timestamp = %s, status = 'uploaded'
                WHERE id = %s
                """,
                (photos_count, json.dumps(photo_paths), session_timestamp, analysis_id)
            )
            conn.commit()
            return True
    except Exception as e:
        logger.error(f"Error updating photos for analysis {analysis_id}: {e}")
        conn.rollback()
        return False
    finally:
        conn.close()

def update_posture_analysis_result(analysis_id, analysis_result, status='analyzed'):
    """
    Updates the analysis record with the Gemini results and sets status to 'analyzed' (or 'error').
    """
    if not analysis_id:
        return False
        
    conn = get_db_connection()
    if not conn:
        return False
        
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                UPDATE posture_analyses 
                SET analysis_result = %s, status = %s
                WHERE id = %s
                """,
                (json.dumps(analysis_result), status, analysis_id)
            )
            conn.commit()
            return True
    except Exception as e:
        logger.error(f"Error updating result for analysis {analysis_id}: {e}")
        conn.rollback()
        return False
    finally:
        conn.close()

# --- SPECIALIST CABINET FUNCTIONS ---

def search_specialist_clients(specialist_id, query='', limit=20, offset=0):
    """
    Find clients for a given specialist. 
    A client analysis belongs to a specialist if they are the author (offline) or assigned specialist (online).
    Groups by patient name/author_id to simulate 'clients'.
    """
    conn = get_db_connection()
    if not conn: return []
    try:
        with conn.cursor() as cur:
            search_param = f'%{query}%'
            
            if query:
                query_sql = """
                    SELECT DISTINCT ON (
                        pa.author_id, 
                        COALESCE(pa.patient_first_name, ''), 
                        COALESCE(pa.patient_last_name, '')
                    )
                        pa.*,
                        u.first_name as tg_first_name,
                        u.last_name as tg_last_name,
                        -- Оптимизация: считаем общее количество за один проход по выборке
                        COUNT(*) OVER(
                            PARTITION BY pa.author_id, 
                                         COALESCE(pa.patient_first_name, ''), 
                                         COALESCE(pa.patient_last_name, '')
                        ) as total_analyses
                    FROM public.posture_analyses pa
                    LEFT JOIN public.users u ON pa.author_id = u.telegram_id::bigint
                    WHERE (pa.specialist_id = %s OR pa.author_id = %s)
                      AND (
                          -- COALESCE гарантирует, что ILIKE сработает, даже если в базе NULL
                          COALESCE(pa.patient_first_name, '') ILIKE %s OR 
                          COALESCE(pa.patient_last_name, '') ILIKE %s OR 
                          u.first_name ILIKE %s OR 
                          u.last_name ILIKE %s
                      )
                    -- Важно: ORDER BY в точности повторяет структуру DISTINCT ON + сортировка по дате
                    ORDER BY 
                        pa.author_id ASC, 
                        COALESCE(pa.patient_first_name, '') ASC, 
                        COALESCE(pa.patient_last_name, '') ASC, 
                        pa.created_at DESC
                """
                params = [specialist_id, specialist_id, search_param, search_param, search_param, search_param]
            else:
                query_sql = """
                    SELECT DISTINCT ON (
                        pa.author_id, 
                        COALESCE(pa.patient_first_name, ''), 
                        COALESCE(pa.patient_last_name, '')
                    )
                        pa.*,
                        u.first_name as tg_first_name,
                        u.last_name as tg_last_name,
                        COUNT(*) OVER(
                            PARTITION BY pa.author_id, 
                                         COALESCE(pa.patient_first_name, ''), 
                                         COALESCE(pa.patient_last_name, '')
                        ) as total_analyses
                    FROM public.posture_analyses pa
                    LEFT JOIN public.users u ON pa.author_id = u.telegram_id::bigint
                    WHERE (pa.specialist_id = %s OR pa.author_id = %s)
                    ORDER BY 
                        pa.author_id ASC, 
                        COALESCE(pa.patient_first_name, '') ASC, 
                        COALESCE(pa.patient_last_name, '') ASC, 
                        pa.created_at DESC
                """
                params = [specialist_id, specialist_id]
                
            # Wrap in a subquery to sort properly by created_at DESC
            final_sql = f"""
                SELECT * FROM ({query_sql}) as sub
                ORDER BY created_at DESC
                LIMIT %s OFFSET %s
            """
            params.extend([limit, offset])
            
            cur.execute(final_sql, tuple(params))
            res = cur.fetchall()
            return [dict(r) for r in res]
    except Exception as e:
        logger.error(f"Error searching specialist clients: {e}")
        return []
    finally:
        conn.close()

def get_premium_pool(limit=20, offset=0):
    """
    Get unassigned premium analyses.
    """
    conn = get_db_connection()
    if not conn: return []
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT pa.*, u.first_name as tg_first_name, u.last_name as tg_last_name,
                       (SELECT COUNT(*) FROM public.posture_analyses prev WHERE prev.author_id = pa.author_id) as previous_count
                FROM public.posture_analyses pa
                LEFT JOIN public.users u ON pa.author_id = u.telegram_id::bigint
                WHERE pa.analysis_type = 'premium' 
                  AND pa.specialist_id IS NULL 
                  AND pa.status != 'draft'
                  AND u.role != 'specialist-approved'
                ORDER BY pa.created_at DESC
                LIMIT %s OFFSET %s
                """,
                (limit, offset)
            )
            res = cur.fetchall()
            return [dict(r) for r in res]
    except Exception as e:
        logger.error(f"Error getting premium pool: {e}")
        return []
    finally:
        conn.close()

def assign_analysis(analysis_id, specialist_id):
    conn = get_db_connection()
    if not conn: return False
    try:
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE public.posture_analyses SET specialist_id = %s WHERE id = %s",
                (specialist_id, analysis_id)
            )
            conn.commit()
            return True
    except Exception as e:
        logger.error(f"Error assigning analysis: {e}")
        conn.rollback()
        return False
    finally:
        conn.close()

def update_recommendations(analysis_id, recommendations):
    conn = get_db_connection()
    if not conn: return False
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT analysis_result FROM public.posture_analyses WHERE id = %s", (analysis_id,))
            res = cur.fetchone()
            if not res or not res[0]: return False
            
            result_json = res[0]
            if isinstance(result_json, str):
                result_json = json.loads(result_json)
                
            result_json['recommendations'] = recommendations
            
            cur.execute(
                "UPDATE public.posture_analyses SET analysis_result = %s WHERE id = %s",
                (json.dumps(result_json) if isinstance(res[0], str) else result_json, analysis_id)
            )
            conn.commit()
            return True
    except Exception as e:
        logger.error(f"Error updating recommendations: {e}")
        conn.rollback()
        return False
    finally:
        conn.close()



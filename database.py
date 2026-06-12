import os
import psycopg2
from psycopg2.extras import RealDictCursor
import logging

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

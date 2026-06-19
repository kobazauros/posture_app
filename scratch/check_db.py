import os
import psycopg2
from psycopg2.extras import RealDictCursor
from dotenv import load_dotenv

load_dotenv()

def check_db():
    database_url = os.getenv("DATABASE_URL")
    if not database_url:
        print("No DATABASE_URL")
        return
        
    try:
        conn = psycopg2.connect(database_url, cursor_factory=RealDictCursor)
        with conn.cursor() as cur:
            cur.execute("""
                SELECT id, age, weight, status, created_at
                FROM posture_analyses
                WHERE author_id = 445198623
                ORDER BY created_at DESC
                LIMIT 5
            """)
            rows = cur.fetchall()
            for row in rows:
                print(dict(row))
    except Exception as e:
        print("DB error:", e)

if __name__ == "__main__":
    check_db()

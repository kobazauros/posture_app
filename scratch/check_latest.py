import os
import psycopg2
from psycopg2.extras import RealDictCursor
from dotenv import load_dotenv

load_dotenv()

def check_db():
    database_url = os.getenv("DATABASE_URL")
    try:
        conn = psycopg2.connect(database_url, cursor_factory=RealDictCursor)
        with conn.cursor() as cur:
            cur.execute("""
                SELECT id, author_id, status 
                FROM posture_analyses 
                ORDER BY created_at DESC 
                LIMIT 10
            """)
            rows = cur.fetchall()
            print("Latest 10 records:")
            for row in rows:
                status_val = row['status']
                author_id = row['author_id']
                print(f"ID: {row['id']} | Author: {repr(author_id)} | Status: {repr(status_val)}")
    except Exception as e:
        print("DB error:", e)
    finally:
        if 'conn' in locals() and conn:
            conn.close()

if __name__ == "__main__":
    check_db()

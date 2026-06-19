import os
import psycopg2
from psycopg2.extras import RealDictCursor
from dotenv import load_dotenv

load_dotenv()

def check_db():
    database_url = os.getenv("DATABASE_URL")
    if not database_url:
        print("No DATABASE_URL in .env")
        return
        
    try:
        # Подключаемся к удаленной базе данных
        conn = psycopg2.connect(database_url, cursor_factory=RealDictCursor)
        with conn.cursor() as cur:
            cur.execute("""
                SELECT id, status 
                FROM posture_analyses 
                WHERE author_id = 445198623 
                ORDER BY created_at DESC 
                LIMIT 5
            """)
            rows = cur.fetchall()
            print("Latest records for user 445198623:")
            for row in rows:
                status_val = row['status']
                print(f"ID: {row['id']} | Status: {repr(status_val)} | Length: {len(status_val) if status_val else 0}")
    except Exception as e:
        print("DB error:", str(e).encode('ascii', 'ignore').decode('ascii'))
    finally:
        if 'conn' in locals() and conn:
            conn.close()

if __name__ == "__main__":
    check_db()

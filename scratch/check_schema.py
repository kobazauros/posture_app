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
                SELECT column_name 
                FROM information_schema.columns 
                WHERE table_name = 'posture_analyses'
            """)
            rows = cur.fetchall()
            columns = [row['column_name'] for row in rows]
            print("Columns in posture_analyses:")
            print(", ".join(columns))
            
            if 'patient_first_name' not in columns:
                print("MISSING patient_first_name!")
            
    except Exception as e:
        print("DB error:", e)

if __name__ == "__main__":
    check_db()

import os
import psycopg2
from dotenv import load_dotenv

load_dotenv()

def run_migration():
    database_url = os.getenv("DATABASE_URL")
    if not database_url:
        print("Ошибка: DATABASE_URL не найден в .env")
        return

    print(f"Подключение к базе данных...")
    try:
        conn = psycopg2.connect(database_url)
        with conn.cursor() as cur:
            # Проверяем колонку patient_first_name
            cur.execute("""
                SELECT column_name 
                FROM information_schema.columns 
                WHERE table_name = 'posture_analyses' AND column_name = 'patient_first_name'
            """)
            if not cur.fetchone():
                print("Добавляем колонку patient_first_name...")
                cur.execute("ALTER TABLE posture_analyses ADD COLUMN patient_first_name VARCHAR(255)")
            else:
                print("Колонка patient_first_name уже существует.")

            # Проверяем колонку patient_last_name
            cur.execute("""
                SELECT column_name 
                FROM information_schema.columns 
                WHERE table_name = 'posture_analyses' AND column_name = 'patient_last_name'
            """)
            if not cur.fetchone():
                print("Добавляем колонку patient_last_name...")
                cur.execute("ALTER TABLE posture_analyses ADD COLUMN patient_last_name VARCHAR(255)")
            else:
                print("Колонка patient_last_name уже существует.")

        conn.commit()
        print("Миграция успешно завершена!")
    except Exception as e:
        print("Ошибка при миграции:", e)
    finally:
        if 'conn' in locals() and conn:
            conn.close()

if __name__ == "__main__":
    run_migration()

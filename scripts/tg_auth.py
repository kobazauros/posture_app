import os
from telethon import TelegramClient
from dotenv import load_dotenv

def main():
    # Загружаем переменные окружения
    env_path = os.path.join(os.path.dirname(os.path.dirname(__file__)), ".env")
    load_dotenv(env_path)
    
    api_id = os.getenv("TG_API_ID")
    api_hash = os.getenv("TG_API_HASH")
    
    if not api_id or not api_hash:
        print("Error: TG_API_ID or TG_API_HASH not found in .env file at " + env_path)
        return

    # Папка tests может быть местом для сохранения сессии, чтобы conftest.py легко её нашел
    session_file = os.path.join(os.path.dirname(os.path.dirname(__file__)), "tests", "tg_test_session")
    
    print("Creating session...")
    client = TelegramClient(session_file, int(api_id), api_hash)
    
    # client.start() запросит номер телефона и код из Telegram при первом запуске
    client.start()
    
    print("\\nSuccess! Session file created at: " + session_file + ".session")
    client.disconnect()

if __name__ == "__main__":
    main()

import telebot
from telebot import types
import os
from dotenv import load_dotenv
import logging
from security import encode_token, register_token
import time

# --- КОНФИГУРАЦИЯ ---
load_dotenv()
# Токен вашего бота от @BotFather
TOKEN = os.getenv("TOKEN")
if not TOKEN:
    raise ValueError("ОШИБКА: TELEGRAM_BOT_TOKEN не найден в файле .env!")

# API_KEY = os.getenv("GOOGLE_AI_API_KEY_POSTUREAI")
# client = genai.Client(api_key=API_KEY) if API_KEY else None


# Базовый URL вашего сайта (через ngrok или постоянный домен)
# Важно: должен быть HTTPS для работы камеры и датчиков в браузере
WEB_URL = "https://speak-better.space/posture/"

# Настройка логирования для отслеживания действий бота
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

# Функция-фильтр против спама таймаутов
def filter_timeout_spam(record):
    message = record.getMessage()
    # Если в логе есть упоминание таймаута — возвращаем False (скрываем лог)
    return "Read timed out" not in message and "ReadTimeout" not in message

# Применяем эту функцию как фильтр к логгеру TeleBot
logging.getLogger('TeleBot').addFilter(filter_timeout_spam)

bot = telebot.TeleBot(TOKEN, threaded=True)

def reset_mini_app_interface():
    """
    Принудительно сбрасывает кнопку меню до стандартной (команды).
    Это критически важно, чтобы Telegram перестал считать бота приложением (Mini App).
    """
    try:
        # Устанавливаем стандартную кнопку 'Menu' вместо 'Web App'
        bot.set_chat_menu_button(menu_button=types.MenuButtonDefault())
        logger.info("Интерфейс Mini App успешно отключен. Кнопка меню сброшена.")
    except Exception as e:
        logger.error(f"Ошибка при сбросе кнопки меню: {e}")

def setup_bot_commands():
    """Устанавливает меню команд бота"""
    commands = [
        types.BotCommand("start", "Начать анализ (получить новую ссылку)"),
        types.BotCommand("help", "Справка по системе"),
        types.BotCommand("id", "Ваш Telegram ID")
    ]
    try:
        bot.set_my_commands(commands)
        logger.info("Меню команд успешно обновлено.")
    except Exception as e:
        logger.error(f"Ошибка при установке команд: {e}")

@bot.message_handler(commands=['start'])
def send_welcome(message):
    """
    Обработчик команды /start. 
    Отправляет пользователю персональную ссылку для открытия в СИСТЕМНОМ браузере.
    """
    user_id = message.from_user.id
    first_name = message.from_user.first_name

    # Генерируем зашифрованный токен (живет до закрытия сессии)
    secure_token = encode_token(user_id)
    register_token(user_id, secure_token)
    
    # Формируем ссылку с ID пользователя для идентификации на сервере
    clean_url = WEB_URL.rstrip('/')
    # Передаем токен ТОЛЬКО через хэш, без query-параметров (?v=11), 
    # чтобы браузер гарантированно брал закэшированную версию страницы.
    personal_link = f"{clean_url}/#t={secure_token}"
    
    # Создаем клавиатуру с кнопкой-ссылкой (url= заставляет открыть внешний браузер)
    markup = types.InlineKeyboardMarkup()
    btn = types.InlineKeyboardButton(
        text="🚀 Начать анализ осанки", 
        url=personal_link
    )
    markup.add(btn)

    welcome_text = (
        f"Здравствуйте, <b>{first_name}</b>! 👋\n\n"
        "Для проведения точного анализа осанки недостаточно встроенной камеры Telegram. "
        "Необходимо испольовать AR-трафарет, для чего необходимо перейти на внешний сайт.\n"
        "<b>Инструкция:</b>\n"
        "1️⃣ Нажмите кнопку ниже.\n"
        "2️⃣ В браузере разрешите доступ к камере.\n"
        "3️⃣ Сделайте 3 снимка, следуя подсказкам уровня.\n\n"
        "<i>Отчет будет отправлен вам в этот чат после проверки врачом.</i>"
    )
    
    bot.send_message(
        message.chat.id, 
        welcome_text, 
        reply_markup=markup, 
        parse_mode="HTML"
    )

@bot.message_handler(commands=['id'])
def show_id(message):
    """Команда для получения ID чата пользователем"""
    bot.reply_to(message, f"Ваш Telegram ID: <code>{message.from_user.id}</code>", parse_mode="HTML")

@bot.message_handler(commands=['help'])
def show_help(message):
    """Справочная информация"""
    help_text = (
        "<b>Как работает система?</b>\n\n"
        "Бот присылает ссылку на внешний сайт. Сайт использует камеру и гироскоп "
        "телефона для создания точных снимков. Как только вы отправите фото, врач "
        "получит уведомление и подготовит отчет."
    )
    bot.send_message(message.chat.id, help_text, parse_mode="HTML")

if __name__ == "__main__":
    # Выполняем сброс настроек Mini App при каждом запуске
    reset_mini_app_interface()
    setup_bot_commands()
    
    print("------------------------------------------")
    print(f"🚀 Бот запущен в режиме ЧИСТОГО ВЕБ-КУРЬЕРА")
    print(f"📡 Ссылка на сайт: {WEB_URL}")
    print("------------------------------------------")
    
    # Запуск бота
    while True:
            try:
                bot.infinity_polling(
                    timeout=60, 
                    long_polling_timeout=60, 
                    skip_pending=True
                )
            except Exception as e:
                logger.error(f"Бот упал с ошибкой: {e}. Перезапуск через 10 секунд...")
                time.sleep(10) # Пауза перед рестартом
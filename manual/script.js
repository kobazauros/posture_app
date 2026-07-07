// manual/script.js

document.addEventListener("DOMContentLoaded", () => {
    // 1. Инициализация Telegram WebApp
    const tg = window.Telegram ? window.Telegram.WebApp : null;

    if (tg && tg.initDataUnsafe && Object.keys(tg.initDataUnsafe).length > 0) {
        tg.ready();
        tg.expand(); // Разворачиваем окно на весь экран

        // Скрываем кнопку печати PDF, если открыто внутри Telegram
        const printBtn = document.querySelector('.print-btn');
        if (printBtn) {
            printBtn.style.display = 'none';
        }
    }

    // 2. Умный роутинг вкладок через URL (поддержка ?role= и #role=)
    let role = 'client';
    if (window.location.search.includes('role=specialist') || window.location.hash.includes('role=specialist')) {
        role = 'specialist';
    }

    if (role === 'specialist') {
        switchTab('specialist', document.querySelectorAll('.nav-btn')[1]);
    } else {
        // По умолчанию клиент
        switchTab('client', document.querySelectorAll('.nav-btn')[0]);
    }
});

// Функция переключения вкладок
function switchTab(tabId, btnElement = null) {
    document.querySelectorAll('.section').forEach(el => el.classList.remove('active'));
    document.querySelectorAll('.nav-btn').forEach(el => el.classList.remove('active'));

    document.getElementById(tabId).classList.add('active');

    if (btnElement) {
        btnElement.classList.add('active');
    } else if (event && event.target) {
        event.target.classList.add('active');
    }
}

document.addEventListener('DOMContentLoaded', () => {
    const sessionId = sessionStorage.getItem('posture_app_session_id');
    const userRole = sessionStorage.getItem('posture_app_role');
    const userFirstName = sessionStorage.getItem('posture_app_fname');

    if (!sessionId || userRole !== 'specialist-approved') {
        window.location.href = './';
        return;
    }

    const nameEl = document.getElementById('specialist-name');
    if (nameEl) {
        nameEl.textContent = userFirstName ? `Д-р ${userFirstName}` : 'Специалист';
    }

    // State
    let currentTab = 'my_clients';
    let myClientsList = [];
    let poolList = [];
    let currentOffset = 0;
    const LIMIT = 20;
    let isLoading = false;
    let hasMore = true;

    // Elements
    const tabRadios = document.querySelectorAll('input[name="dashboard_tab"]');
    const poolFilters = document.getElementById('pool-filters');
    const searchInput = document.getElementById('search-client');
    const listContainer = document.getElementById('clients-list');
    const loadingIndicator = document.getElementById('loading-indicator');
    const filterNew = document.getElementById('filter-new');
    const filterReturning = document.getElementById('filter-returning');

    // Init
    tabRadios.forEach(radio => {
        radio.addEventListener('change', (e) => {
            currentTab = e.target.value;
            if (currentTab === 'pool') {
                poolFilters.style.display = 'flex';
                searchInput.placeholder = 'Поиск по пулу...';
            } else {
                poolFilters.style.display = 'none';
                searchInput.placeholder = 'Поиск по клиентам...';
            }
            resetAndLoad();
        });
    });

    searchInput.addEventListener('input', debounce(() => {
        resetAndLoad();
    }, 500));

    filterNew.addEventListener('change', renderList);
    filterReturning.addEventListener('change', renderList);

    // Infinite scroll
    window.addEventListener('scroll', () => {
        if (window.innerHeight + window.scrollY >= document.body.offsetHeight - 100) {
            if (!isLoading && hasMore) {
                loadData();
            }
        }
    });

    // Initial load
    resetAndLoad();

    function resetAndLoad() {
        listContainer.innerHTML = '';
        currentOffset = 0;
        hasMore = true;
        if (currentTab === 'my_clients') myClientsList = [];
        else poolList = [];
        loadData();
    }

    async function loadData() {
        isLoading = true;
        loadingIndicator.style.display = 'block';

        const query = searchInput.value.trim();
        const endpoint = currentTab === 'my_clients' ? 'api/specialist/clients' : 'api/specialist/pool';

        try {
            const res = await fetch(`${endpoint}?limit=${LIMIT}&offset=${currentOffset}&query=${encodeURIComponent(query)}`, {
                headers: { 'Authorization': sessionId }
            });
            const data = await res.json();

            if (data.error) {
                Swal.fire('Ошибка', data.error, 'error');
                return;
            }

            const items = currentTab === 'my_clients' ? data.clients : data.pool;
            if (items.length < LIMIT) {
                hasMore = false;
            }

            if (currentTab === 'my_clients') {
                myClientsList.push(...items);
            } else {
                poolList.push(...items);
            }

            currentOffset += LIMIT;
            renderList();

        } catch (err) {
            console.error('Failed to load data', err);
            Swal.fire('Ошибка', 'Не удалось загрузить данные', 'error');
        } finally {
            isLoading = false;
            loadingIndicator.style.display = 'none';
        }
    }

    function renderList() {
        listContainer.innerHTML = '';
        let items = currentTab === 'my_clients' ? myClientsList : poolList;

        if (currentTab === 'pool') {
            const showNew = filterNew.checked;
            const showReturning = filterReturning.checked;
            items = items.filter(item => {
                const total = parseInt(item.total_analyses || item.previous_count || 1);
                if (total === 1 && showNew) return true;
                if (total > 1 && showReturning) return true;
                return false;
            });

            // Search filter for pool since API might not search pool
            const q = searchInput.value.trim().toLowerCase();
            if (q) {
                items = items.filter(item => {
                    const name1 = item.patient_first_name || item.tg_first_name || '';
                    const name2 = item.patient_last_name || item.tg_last_name || '';
                    const full = `${name1} ${name2}`.toLowerCase();
                    return full.includes(q);
                });
            }
        }

        if (items.length === 0) {
            listContainer.innerHTML = '<p style="text-align:center; color:var(--text-secondary); margin-top:30px;">Ничего не найдено</p>';
            return;
        }

        items.forEach(item => {
            listContainer.appendChild(createCard(item));
        });
    }

    function createCard(item) {
        const isPool = currentTab === 'pool';
        const totalAnalyses = parseInt(item.total_analyses || item.previous_count || 1);
        const isReturning = totalAnalyses > 1;

        const firstName = item.patient_first_name || item.tg_first_name || 'Неизвестно';
        const lastName = item.patient_last_name || item.tg_last_name || '';
        const fullName = `${firstName} ${lastName}`.trim();

        const dateStr = new Date(item.created_at).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

        const div = document.createElement('div');
        div.className = 'plan-card client-card';
        if (isPool && !isReturning) {
            div.style.borderColor = 'var(--color-green)';
            div.style.boxShadow = '0 0 15px rgba(52, 199, 89, 0.1)';
        }

        let badgeHtml = '';
        if (item.analysis_type === 'premium') {
            badgeHtml = `<span class="plan-badge">PREMIUM</span>`;
        }

        let statusHtml = '';
        if (isPool) {
            if (isReturning) {
                statusHtml = `<span class="status-badge status-waiting" style="background: rgba(0, 255, 255, 0.2); color: var(--color-cyan); border-color: rgba(0, 255, 255, 0.4);">Повторный</span>`;
            } else {
                statusHtml = `<span class="status-badge status-waiting">Ожидает разбора</span>`;
            }
        } else {
            if (item.status === 'draft') {
                statusHtml = `<span class="status-badge" style="background:rgba(255,255,255,0.1); color:var(--text-secondary);">Черновик</span>`;
            } else if (item.status === 'completed') {
                statusHtml = `<span class="status-badge status-done">Завершено</span>`;
            } else {
                statusHtml = `<span class="status-badge status-waiting">Требует анализа</span>`;
            }
        }

        let actionsHtml = '';
        if (isPool) {
            actionsHtml = `<button class="primary-btn action-btn" onclick="takeToWork(${item.id})">ВЗЯТЬ В РАБОТУ</button>`;
            if (isReturning) {
                actionsHtml += `<button class="secondary-btn action-btn" style="flex: 0.5;" onclick="openProfile(${item.id}, '${fullName}')">ПРОФИЛЬ</button>`;
            }
        } else {
            actionsHtml = `<button class="primary-btn action-btn" onclick="openCorrection(${item.id})">КОРРЕКТИРОВАТЬ</button>`;
            if (isReturning) {
                actionsHtml += `<button class="secondary-btn action-btn" style="flex: 0.5;" onclick="openProfile(${item.id}, '${fullName}')">ПРОФИЛЬ</button>`;
            }
        }

        let descText = '';
        if (item.age || item.gender) {
            descText += `${item.gender === 'male' ? 'Мужчина' : 'Женщина'}, ${item.age || '?'} лет. `;
        }
        if (isReturning) {
            descText += `Повторный анализ (всего: ${totalAnalyses}).`;
        } else {
            descText += `Первичный анализ.`;
        }

        div.innerHTML = `
            <div class="card-content-wrapper" style="width: 100%;">
                <div class="client-header">
                    <h3 class="plan-title">${fullName} ${badgeHtml}</h3>
                    ${statusHtml}
                </div>
                <p class="plan-desc">${descText}</p>
                <div class="client-date" style="margin-top: 8px;">Дата: ${dateStr}</div>
                
                <div class="card-actions">
                    ${actionsHtml}
                </div>
            </div>
        `;
        return div;
    }

    // Actions
    window.takeToWork = async (id) => {
        try {
            const res = await fetch(`api/specialist/analyses/${id}/assign`, {
                method: 'POST',
                headers: { 'Authorization': sessionId }
            });
            const data = await res.json();
            if (data.success) {
                Swal.fire({
                    title: 'Успешно',
                    text: 'Заявка взята в работу! Вы найдете её во вкладке "Мои клиенты".',
                    icon: 'success',
                    timer: 2000,
                    showConfirmButton: false
                });
                resetAndLoad();
            } else {
                Swal.fire('Ошибка', data.error || 'Не удалось взять заявку', 'error');
            }
        } catch (e) {
            Swal.fire('Ошибка', 'Сетевая ошибка', 'error');
        }
    };

    window.openProfile = (id, name) => {
        document.getElementById('dashboard-screen').style.display = 'none';
        document.getElementById('profile-screen').style.display = 'block';
        document.getElementById('profile-name').textContent = `История: ${name}`;

        // In a real app we would fetch the history. For now we just show a stub list
        document.getElementById('profile-history-list').innerHTML = `
            <p style="color:var(--text-secondary); text-align:center;">
                Здесь будет загружаться полный список прошлых анализов из БД...
            </p>
        `;
    };

    window.closeProfileScreen = () => {
        document.getElementById('profile-screen').style.display = 'none';
        document.getElementById('dashboard-screen').style.display = 'block';
    };

    window.openCorrection = (id) => {
        // Open Stub screen for correction
        document.getElementById('dashboard-screen').style.display = 'none';
        document.getElementById('stub-screen').style.display = 'block';
    };

    window.closeStubScreen = () => {
        document.getElementById('stub-screen').style.display = 'none';
        document.getElementById('dashboard-screen').style.display = 'block';
    };

    document.getElementById('btn-add-client').addEventListener('click', () => {
        // Offline client - redirect to the camera (index.html)
        window.location.href = './';
    });

    // Helper
    function debounce(func, wait) {
        let timeout;
        return function (...args) {
            clearTimeout(timeout);
            timeout = setTimeout(() => func.apply(this, args), wait);
        };
    }
});

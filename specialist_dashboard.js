import { attachFormValidation, validateForm, setFieldError } from './form.js?v=20';
import { startCamera, switchCameraFacing } from './camera.js?v=20';
import { bindCaptureHandlers, resetCaptureFlow, updateStepIndicator } from './capture.js?v=20';
import { state, stepLabels } from './state.js?v=20';

document.addEventListener('DOMContentLoaded', () => {
    const sessionId = sessionStorage.getItem('posture_app_session_id');
    const userRole = sessionStorage.getItem('posture_app_role');
    const userFirstName = sessionStorage.getItem('posture_app_fname');
    const userLastName = sessionStorage.getItem('posture_app_lname');

    if (!sessionId || userRole !== 'specialist-approved') {
        window.location.href = './';
        return;
    }

    const nameEl = document.getElementById('specialist-name');
    const avatarEl = document.getElementById('specialist-avatar');

    let fullName = 'Специалист';
    if (userFirstName) {
        fullName = `Д-р ${userFirstName}`;
        if (userLastName) {
            fullName += ` ${userLastName}`;
        }
    }

    if (nameEl) {
        nameEl.textContent = fullName;
    }

    if (avatarEl) {
        let initials = '';
        if (userFirstName) initials += userFirstName.charAt(0).toUpperCase();
        if (userLastName) initials += userLastName.charAt(0).toUpperCase();

        if (!initials) initials = 'С';

        avatarEl.textContent = initials;

        if (initials.length > 1) {
            avatarEl.style.fontSize = '14px';
        } else {
            avatarEl.style.fontSize = '16px';
        }
    }

    // State
    let currentTab = 'my_clients';
    let myClientsList = [];
    let poolList = [];
    let currentOffset = 0;
    const LIMIT = 20;
    let isLoading = false;
    let hasMore = true;
    let currentRequestId = 0;

    // Elements
    const tabRadios = document.querySelectorAll('input[name="dashboard_tab"]');
    const poolFilters = document.getElementById('pool-filters');
    const searchInput = document.getElementById('search-client');
    const listContainer = document.getElementById('clients-list');
    const loadingIndicator = document.getElementById('loading-indicator');
    const filterNew = document.getElementById('chip-filter-new');
    const filterReturning = document.getElementById('chip-filter-returning');

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

    function toggleChip(e) {
        e.target.classList.toggle('active');
        renderList();
    }

    filterNew.addEventListener('click', toggleChip);
    filterReturning.addEventListener('click', toggleChip);

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
        const requestId = ++currentRequestId;
        isLoading = true;
        loadingIndicator.style.display = 'block';

        const query = searchInput.value.trim();
        const endpoint = currentTab === 'my_clients' ? 'api/specialist/clients' : 'api/specialist/pool';

        try {
            const res = await fetch(`${endpoint}?limit=${LIMIT}&offset=${currentOffset}&query=${encodeURIComponent(query)}`, {
                headers: { 'Authorization': sessionId }
            });
            const data = await res.json();

            if (currentRequestId !== requestId) return;

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
            if (currentRequestId === requestId) {
                isLoading = false;
                loadingIndicator.style.display = 'none';
            }
        }
    }

    function renderList() {
        listContainer.innerHTML = '';
        let items = currentTab === 'my_clients' ? myClientsList : poolList;

        if (currentTab === 'pool') {
            const showNew = filterNew.classList.contains('active');
            const showReturning = filterReturning.classList.contains('active');
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
        document.getElementById('dashboard-screen').style.display = 'flex';
        window.scrollTo(0, 0);
    };

    window.openCorrection = (id) => {
        // Open Stub screen for correction
        document.getElementById('dashboard-screen').style.display = 'none';
        document.getElementById('stub-screen').style.display = 'flex';
    };

    window.closeStubScreen = () => {
        document.getElementById('stub-screen').style.display = 'none';
        document.getElementById('dashboard-screen').style.display = 'flex';
        window.scrollTo(0, 0);
    };

    // Add Client Flow
    document.getElementById('btn-add-client').addEventListener('click', () => {
        document.getElementById('dashboard-screen').style.display = 'none';
        document.getElementById('form-screen').style.display = 'flex';

        // Initialize logic for the capture flow
        attachFormValidation();
        bindCaptureHandlers();
        updateStepIndicator();

        // Prefill form from cached analysis if available
        const cachedAnalysis = sessionStorage.getItem('posture_app_analysis');
        if (cachedAnalysis && cachedAnalysis !== 'undefined') {
            try {
                const latest = JSON.parse(cachedAnalysis);
                if (latest.status === 'draft' || !latest.status) {
                    if (latest.patient_first_name) document.getElementById('patient-first-name').value = latest.patient_first_name;
                    if (latest.patient_last_name) document.getElementById('patient-last-name').value = latest.patient_last_name;
                    if (latest.age) document.getElementById('user-age').value = latest.age;
                    if (latest.weight) document.getElementById('user-weight').value = latest.weight;
                    if (latest.height) document.getElementById('user-height').value = latest.height;
                    if (latest.gender === 'male' || latest.gender === 'female') {
                        const r = document.getElementById('gender-' + latest.gender);
                        if (r) r.checked = true;
                    }
                }
            } catch (e) {
                console.warn('[specialist] failed to parse cached analysis', e);
            }
        }

        // Ensure state is set for specialist flow
        state.sessionId = sessionId;
        state.maxSteps = 4; // Force 4 photos
    });

    document.getElementById('cancel-client-btn').addEventListener('click', () => {
        document.getElementById('form-screen').style.display = 'none';
        document.getElementById('dashboard-screen').style.display = 'flex';
        window.scrollTo(0, 0);
    });

    document.getElementById('switch-cam-btn')?.addEventListener('click', () => {
        switchCameraFacing();
    });

    document.getElementById('to-camera-btn-specialist').addEventListener('click', async () => {
        // Custom validation for names
        const fnameInput = document.getElementById('patient-first-name');
        const lnameInput = document.getElementById('patient-last-name');
        let namesOk = true;

        if (!fnameInput.value.trim()) {
            setFieldError('patient-first-name', 'Введите имя пациента');
            namesOk = false;
        } else {
            fnameInput.classList.remove('invalid');
            document.getElementById('patient-first-name-error').textContent = '';
        }

        if (!lnameInput.value.trim()) {
            setFieldError('patient-last-name', 'Введите фамилию пациента');
            namesOk = false;
        } else {
            lnameInput.classList.remove('invalid');
            document.getElementById('patient-last-name-error').textContent = '';
        }

        if (!validateForm() || !namesOk) {
            return;
        }

        const genderInput = document.querySelector('input[name="gender"]:checked');
        const selectedGender = genderInput ? genderInput.value : 'male';
        const age = document.getElementById('user-age').value;
        const weight = document.getElementById('user-weight').value;
        const height = document.getElementById('user-height').value;
        const patient_first_name = fnameInput.value.trim();
        const patient_last_name = lnameInput.value.trim();
        const analysisType = 'premium'; // Hardcoded for specialists

        const draftDataToCache = { age, weight, height, gender: selectedGender, analysis_type: analysisType, patient_first_name, patient_last_name };
        try {
            sessionStorage.setItem('posture_app_analysis', JSON.stringify(draftDataToCache));
        } catch (e) { }

        const toCameraBtn = document.getElementById('to-camera-btn-specialist');
        toCameraBtn.textContent = 'СОХРАНЕНИЕ...';
        toCameraBtn.disabled = true;

        try {
            const draftRes = await fetch('form/save_draft', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    session_id: state.sessionId,
                    token: sessionStorage.getItem('posture_app_token') || state.token,
                    user_data: draftDataToCache
                })
            });
            const draftData = await draftRes.json();
            if (draftData.status === 'success' && draftData.analysis_id) {
                state.analysisId = draftData.analysis_id;
            }
        } catch (err) {
            console.warn('[app] save_draft failed', err);
        }

        toCameraBtn.textContent = 'НАЧАТЬ';
        toCameraBtn.disabled = false;

        state.currentStep = 0;
        state.finalPhotos = [];
        resetCaptureFlow();

        const stepIndicator = document.getElementById('step-indicator');
        if (stepIndicator) stepIndicator.innerText = stepLabels[state.currentStep];

        document.getElementById('form-screen').style.display = 'none';
        document.getElementById('camera-screen').style.display = 'block';

        try {
            await startCamera();
        } catch (err) {
            console.warn('[camera] startCamera failed', err);
            document.getElementById('camera-screen').style.display = 'none';
            document.getElementById('form-screen').style.display = 'flex';
        }
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

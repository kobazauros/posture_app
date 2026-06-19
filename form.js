import { FORM_LIMITS } from './state.js?v=20';

/**
 * Returns the validation error element id for a form field.
 * @param {string} fieldId - Input element id.
 * @returns {string} Error element id.
 */
export function getErrorId(fieldId) {
    return fieldId.replace('user-', '') + '-error';
}

/**
 * Clears the validation state for a field.
 * @param {string} fieldId - Input element id.
 * @returns {void}
 */
export function clearFieldError(fieldId) {
    const input = document.getElementById(fieldId);
    const error = document.getElementById(getErrorId(fieldId));
    if (input) input.classList.remove('invalid');
    if (error) error.textContent = '';
}

/**
 * Marks a field as invalid and sets its error message.
 * @param {string} fieldId - Input element id.
 * @param {string} message - Error text to display.
 * @returns {void}
 */
export function setFieldError(fieldId, message) {
    const input = document.getElementById(fieldId);
    const error = document.getElementById(getErrorId(fieldId));
    if (input) input.classList.add('invalid');
    if (error) error.textContent = message;
}

/**
 * Capitalizes the first letter of a string.
 * @param {string} text - Source text.
 * @returns {string} Capitalized text.
 */
export function capitalizeFirstLetter(text) {
    return text ? text.charAt(0).toUpperCase() + text.slice(1) : text;
}

/**
 * Validates a single numeric form field against configured limits.
 * @param {string} fieldId - Input element id.
 * @returns {boolean} True when the value is valid.
 */
export function validateSingleField(fieldId) {
    const input = document.getElementById(fieldId);
    if (!input) return false;

    const limits = FORM_LIMITS[fieldId.replace('user-', '')];
    const rawValue = String(input.value || '').trim();

    if (!rawValue) {
        setFieldError(fieldId, `Укажите ${limits.label}.`);
        return false;
    }

    const value = Number(rawValue);
    if (!Number.isFinite(value)) {
        setFieldError(fieldId, `Введите корректный ${limits.label}.`);
        return false;
    }

    if (value < limits.min || value > limits.max) {
        setFieldError(fieldId, `${capitalizeFirstLetter(limits.label)} должен быть от ${limits.min} до ${limits.max}.`);
        return false;
    }

    clearFieldError(fieldId);
    return true;
}

/**
 * Validates the full user form and focuses the first invalid field.
 * @returns {boolean} True when every required field is valid.
 */
export function validateForm() {
    const ageOk = validateSingleField('user-age');
    const weightOk = validateSingleField('user-weight');
    const heightOk = validateSingleField('user-height');

    if (ageOk && weightOk && heightOk) {
        return true;
    }

    const firstInvalidId = ['user-age', 'user-weight', 'user-height'].find((fieldId) => {
        const field = document.getElementById(fieldId);
        return field && field.classList.contains('invalid');
    });

    if (firstInvalidId) {
        const field = document.getElementById(firstInvalidId);
        if (field) field.focus();
    }

    return false;
}

/**
 * Attaches live validation listeners to the user form fields.
 * @returns {void}
 */
export function attachFormValidation() {
    ['user-age', 'user-weight', 'user-height'].forEach((fieldId) => {
        const field = document.getElementById(fieldId);
        if (!field) return;
        field.addEventListener('input', () => clearFieldError(fieldId));
        field.addEventListener('blur', () => validateSingleField(fieldId));
    });
}

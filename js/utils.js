/**
 * utils.js — General Utilities and Helpers
 * 
 * Provides:
 * - UUID generation
 * - Date/Time formatting
 * - Currency formatting
 * - Validation helpers
 * - Common DOM utilities
 */

(function() {
  'use strict';

  /**
   * Generate UUID v4
   * 
   * @returns {string}
   */
  function generateUUID() {
    return crypto.randomUUID();
  }

  /**
   * Format date to ISO 8601 string
   * 
   * @param {Date|string} date
   * @returns {string}
   */
  function formatISODate(date) {
    if (typeof date === 'string') {
      date = new Date(date);
    }
    return date.toISOString();
  }

  /**
   * Format date for display (local)
   * 
   * @param {Date|string} date
   * @param {string} locale
   * @returns {string}
   */
  function formatDisplayDate(date, locale = 'es-AR') {
    if (typeof date === 'string') {
      date = new Date(date);
    }
    return date.toLocaleDateString(locale);
  }

  /**
   * Format currency value
   * 
   * @param {number} value
   * @param {string} currency
   * @param {string} locale
   * @returns {string}
   */
  function formatCurrency(value, currency = 'ARS', locale = 'es-AR') {
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency: currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(value);
  }

  /**
   * Format number with decimals
   * 
   * @param {number} value
   * @param {number} decimals
   * @returns {string}
   */
  function formatNumber(value, decimals = 2) {
    return parseFloat(value).toFixed(decimals);
  }

  /**
   * Parse currency string to number
   * 
   * @param {string} str
   * @returns {number}
   */
  function parseCurrency(str) {
    return parseFloat(str.replace(/[^\d.-]/g, ''));
  }

  /**
   * Validate email
   * 
   * @param {string} email
   * @returns {boolean}
   */
  function isValidEmail(email) {
    const regex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return regex.test(email);
  }

  /**
   * Validate CUIT (Argentine tax ID)
   * 
   * @param {string} cuit
   * @returns {boolean}
   */
  function isValidCUIT(cuit) {
    // Remove non-digits
    const cleaned = cuit.replace(/\D/g, '');
    
    // CUIT must be 11 digits
    if (cleaned.length !== 11) return false;
    
    // Validate with check digit (last digit)
    const sequence = '5432765432';
    let sum = 0;
    
    for (let i = 0; i < 10; i++) {
      sum += parseInt(cleaned[i]) * parseInt(sequence[i]);
    }
    
    let checkDigit = 11 - (sum % 11);
    if (checkDigit === 11) checkDigit = 0;
    if (checkDigit === 10) checkDigit = 9;
    
    return checkDigit === parseInt(cleaned[10]);
  }

  /**
   * Debounce function calls
   * 
   * @param {Function} func
   * @param {number} ms
   * @returns {Function}
   */
  function debounce(func, ms = 300) {
    let timeout;
    return function (...args) {
      clearTimeout(timeout);
      timeout = setTimeout(() => func.apply(this, args), ms);
    };
  }

  /**
   * Throttle function calls
   * 
   * @param {Function} func
   * @param {number} ms
   * @returns {Function}
   */
  function throttle(func, ms = 300) {
    let lastCall = 0;
    return function (...args) {
      const now = Date.now();
      if (now - lastCall >= ms) {
        lastCall = now;
        func.apply(this, args);
      }
    };
  }

  /**
   * Deep clone object
   * 
   * @param {Object} obj
   * @returns {Object}
   */
  function deepClone(obj) {
    return JSON.parse(JSON.stringify(obj));
  }

  /**
   * Group array by key
   * 
   * @param {Array} arr
   * @param {Function|string} key
   * @returns {Object}
   */
  function groupBy(arr, key) {
    return arr.reduce((acc, item) => {
      const groupKey = typeof key === 'function' ? key(item) : item[key];
      if (!acc[groupKey]) acc[groupKey] = [];
      acc[groupKey].push(item);
      return acc;
    }, {});
  }

  /**
   * Show notification (toast)
   * 
   * @param {string} message
   * @param {string} type - 'success', 'error', 'warning', 'info'
   * @param {number} duration - milliseconds
   */
  function showNotification(message, type = 'info', duration = 3000) {
    const notification = document.createElement('div');
    notification.className = `alert alert-${type}`;
    notification.textContent = message;
    notification.style.position = 'fixed';
    notification.style.bottom = '20px';
    notification.style.right = '20px';
    notification.style.zIndex = 10000;
    
    document.body.appendChild(notification);
    
    setTimeout(() => {
      notification.remove();
    }, duration);
  }

  /**
   * Create element with attributes
   * 
   * @param {string} tag
   * @param {Object} attrs
   * @param {Array} children
   * @returns {HTMLElement}
   */
  function createElement(tag, attrs = {}, children = []) {
    const el = document.createElement(tag);
    
    Object.entries(attrs).forEach(([key, value]) => {
      if (key === 'class') {
        el.className = value;
      } else if (key === 'data') {
        Object.entries(value).forEach(([dataKey, dataValue]) => {
          el.dataset[dataKey] = dataValue;
        });
      } else {
        el.setAttribute(key, value);
      }
    });
    
    children.forEach(child => {
      if (typeof child === 'string') {
        el.textContent += child;
      } else {
        el.appendChild(child);
      }
    });
    
    return el;
  }

  /**
   * Query selector (shorthand)
   * 
   * @param {string} selector
   * @param {Document} context
   * @returns {HTMLElement|null}
   */
  function $(selector, context = document) {
    return context.querySelector(selector);
  }

  /**
   * Query selector all (shorthand)
   * 
   * @param {string} selector
   * @param {Document} context
   * @returns {NodeList}
   */
  function $$(selector, context = document) {
    return context.querySelectorAll(selector);
  }

  // Argentine bill/coin denominations (shared by POS and Caja modules)
  const DENOMINACIONES = [100000, 50000, 20000, 10000, 5000, 2000, 1000, 500, 100];

  /**
   * Format date+time for display — DD/MM/YYYY HH:MM
   * @param {string} isoString
   * @returns {string}
   */
  function formatFecha(isoString) {
    if (!isoString) return '—';
    const d = new Date(isoString);
    return d.toLocaleDateString('es-AR') + ' ' + d.toTimeString().slice(0, 5);
  }

  /**
   * Attach an event listener to a DOM element by ID, logging a warning if the element is missing.
   * Replaces the ge('id')?.addEventListener(...) pattern.
   * @param {string} id
   * @param {string} event
   * @param {Function} handler
   */
  function safeOn(id, event, handler) {
    const el = document.getElementById(id);
    if (!el) { console.warn('safeOn: missing element #' + id); return; }
    el.addEventListener(event, handler);
  }

  // Export functions
  window.SGA_Utils = {
    DENOMINACIONES,
    formatFecha,
    safeOn,
    generateUUID,
    formatISODate,
    formatDisplayDate,
    formatCurrency,
    formatNumber,
    parseCurrency,
    isValidEmail,
    isValidCUIT,
    debounce,
    throttle,
    deepClone,
    groupBy,
    showNotification,
    createElement,
    $,
    $$,
  };
})();

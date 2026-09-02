/**
 * firebase-config.js — Configuración Firebase para Sistema Kalulu
 *
 * Dos proyectos Firebase, elegidos automáticamente según dónde corre la app:
 * - PRODUCCIÓN (kalulu-3139e): cualquier dominio real (GitHub Pages, etc.) —
 *   es la base real que usan el local y vos.
 * - DEV (dev-kalulu): solo cuando se abre desde localhost/127.0.0.1 — para
 *   probar features nuevas (rama `dev`) sin tocar datos reales. Mismo
 *   código en las dos ramas, no hay nada que se pueda pisar en un merge.
 *
 * CÓMO PROBAR CONTRA DEV:
 * - Bajar la rama `dev`, y abrir la app con un servidor local
 *   (ej: `python -m http.server 8000` desde la raíz del repo) y entrar por
 *   http://localhost:8000/ — ahí va a usar dev-kalulu automáticamente.
 *
 * REGLAS DE SEGURIDAD FIRESTORE (pegar en Firestore → Rules, en AMBOS proyectos):
 * -----------------------------------------------------------
 * rules_version = '2';
 * service cloud.firestore {
 *   match /databases/{database}/documents {
 *     match /{document=**} {
 *       allow read: if request.auth != null;
 *       allow write: if request.auth != null;
 *     }
 *   }
 * }
 */

const FIREBASE_CONFIG_PROD = {
  apiKey:            'AIzaSyAJMHYd8SLREmuexmj6EtTtQCHcyzJsBGs',
  authDomain:        'kalulu-3139e.firebaseapp.com',
  projectId:         'kalulu-3139e',
  storageBucket:     'kalulu-3139e.firebasestorage.app',
  messagingSenderId: '691696375666',
  appId:             '1:691696375666:web:a6c57a91a69068a8742feb',
};

const FIREBASE_CONFIG_DEV = {
  apiKey:            'AIzaSyDBOVZfRvxBZEJRIVgGOeQ6NYbk8_ipgIM',
  authDomain:        'dev-kalulu.firebaseapp.com',
  projectId:         'dev-kalulu',
  storageBucket:     'dev-kalulu.firebasestorage.app',
  messagingSenderId: '971104444700',
  appId:             '1:971104444700:web:321dad8bb435e25e9b5ad9',
};

const isLocalTesting = ['localhost', '127.0.0.1'].includes(window.location.hostname);

window.FIREBASE_CONFIG = isLocalTesting ? FIREBASE_CONFIG_DEV : FIREBASE_CONFIG_PROD;

// Aviso bien visible para nunca tener dudas de contra qué base se está corriendo
console.log(
  isLocalTesting
    ? '🧪 Firebase: proyecto de PRUEBAS (dev-kalulu) — localhost detectado'
    : '🟢 Firebase: proyecto de PRODUCCIÓN (kalulu-3139e)'
);

// Identificador de este local en Firestore (útil si en el futuro hay varias sucursales)
window.SK_SUCURSAL_FIREBASE_ID = 'sucursal-1';

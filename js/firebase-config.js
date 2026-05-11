/**
 * firebase-config.js — Configuración Firebase para Sistema Kalulu
 *
 * INSTRUCCIONES DE CONFIGURACIÓN (hacer una sola vez):
 * =====================================================
 * 1. Ir a https://console.firebase.google.com
 * 2. Crear un proyecto nuevo (ej: "sistema-kalulu")
 * 3. En Project Settings > General > "Your apps", clic en el ícono </> (Web App)
 * 4. Registrar la app (no hace falta Firebase Hosting), copiar el objeto firebaseConfig
 * 5. Reemplazar los valores de FIREBASE_CONFIG abajo con los de tu proyecto
 *
 * EN EL PANEL DE FIREBASE, HABILITAR:
 * - Firestore Database → Crear en modo producción
 * - Authentication → Sign-in method → Email/Password (activar)
 *
 * CREAR EL USUARIO ADMIN:
 * - Authentication → Users → Add user
 * - Email: admin@tulocal.com (o el que prefieras)
 * - Password: contraseña segura
 *
 * REGLAS DE SEGURIDAD FIRESTORE (pegar en Firestore → Rules):
 * -----------------------------------------------------------
 * rules_version = '2';
 * service cloud.firestore {
 *   match /databases/{database}/documents {
 *     match /{document=**} {
 *       // El POS escribe con sesión anónima, el admin lee con email/pass
 *       allow read: if request.auth != null;
 *       allow write: if request.auth != null;
 *     }
 *   }
 * }
 */

window.FIREBASE_CONFIG = {
  apiKey:            'AIzaSyAJMHYd8SLREmuexmj6EtTtQCHcyzJsBGs',
  authDomain:        'kalulu-3139e.firebaseapp.com',
  projectId:         'kalulu-3139e',
  storageBucket:     'kalulu-3139e.firebasestorage.app',
  messagingSenderId: '691696375666',
  appId:             '1:691696375666:web:a6c57a91a69068a8742feb',
};

// Identificador de este local en Firestore (útil si en el futuro hay varias sucursales)
window.SK_SUCURSAL_FIREBASE_ID = 'sucursal-1';

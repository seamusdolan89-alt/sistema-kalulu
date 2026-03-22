# Sistema Kalulu - File Structure

This directory contains the Sistema de Gestión de Almacén (SGA), a comprehensive warehouse management system built with vanilla JavaScript, HTML5, CSS3, and local-first offline capabilities.

## Directory Structure

```
/
├── index.html                  # Main entry point
├── manifest.json               # PWA manifest for offline support
├── SPEC.md                     # Complete project specification
├── README.md                   # This file
│
├── /css                        # Stylesheets
│   ├── reset.css              # CSS reset / normalization
│   ├── variables.css          # Design tokens (colors, fonts, spacing)
│   ├── layout.css             # Grid, sidebar, header layouts
│   └── components.css         # Reusable component styles (buttons, forms, modals, etc.)
│
├── /js                        # Core JavaScript modules
│   ├── app.js                 # SPA router and app initialization
│   ├── db.js                  # Database layer (SQLite/IndexedDB abstraction)
│   ├── auth.js                # Firebase Authentication
│   ├── sync.js                # Firestore synchronization
│   ├── utils.js               # Utility functions (UUID, formatting, validation, etc.)
│   ├── print.js               # Printing utilities (receipts, labels, reports)
│   │
│   └── /modules               # Feature modules (one per business domain)
│       ├── productos.js       # Product management (including families and substitutes)
│       ├── pos.js             # Point of Sale system
│       ├── clientes.js        # Customer and accounts receivable management
│       ├── caja.js            # Cash management and reconciliation
│       ├── compras.js         # Purchase management and invoice OCR
│       ├── ordenes.js         # Purchase orders
│       ├── proveedores.js     # Supplier management
│       ├── promociones.js     # Promotions and combos
│       ├── etiquetas.js       # Price label printing
│       └── informes.js        # Reports and analytics
│
├── /views                     # HTML view templates (loaded dynamically)
│   ├── pos.html
│   ├── productos.html
│   ├── clientes.html
│   ├── caja.html
│   ├── compras.html
│   ├── ordenes.html
│   ├── proveedores.html
│   ├── promociones.html
│   ├── etiquetas.html
│   └── informes.html
│
└── /templates                 # Data templates and configurations
    └── /facturas              # OCR templates for invoice processing
        └── README.md          # Documentation for supplier templates
```

## Quick Start

1. Open `index.html` in a modern web browser
2. The application will initialize with:
   - Database connection (SQLite via OPFS or IndexedDB fallback)
   - Firebase authentication setup
   - Navigation system
   - Module loading on demand

## Architecture

### Single-Page Application (SPA)
- Hash-based routing (`/#module-name`)
- Lazy-loading of modules and views
- No build tools required (ES Modules with CDN support)

### Offline-First
- All data stored locally (SQLite or IndexedDB)
- Optional sync with Firebase Firestore when online
- Queue system for pending changes

### Module Pattern
Each feature is isolated in its own module:
- Independent initialization via `init(params)` function
- Self-contained logic and state
- Custom events for inter-module communication

## Technologies

- **Frontend**: HTML5, CSS3, ES6+ JavaScript
- **Local Database**: SQLite via OPFS (or IndexedDB fallback)
- **Cloud Sync**: Firebase Firestore
- **Authentication**: Firebase Auth
- **OCR**: Tesseract.js (offline) + Claude API (smart processing)
- **Printing**: Web Serial API (thermal), Window.print() (labels/reports)

## Development Notes

- No npm, webpack, or build tools required
- Modules use native ES Modules (`export`/`import`)
- CSS uses CSS custom properties for theming
- Utility functions available globally (`window.SGA_*`)

## Browser Requirements

- Chrome/Edge 89+ (for OPFS support)
- Firefox 108+
- Safari 16+ (limited OPFS support)

---

For complete specification, see [SPEC.md](SPEC.md)

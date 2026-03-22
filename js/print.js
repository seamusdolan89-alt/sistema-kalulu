/**
 * print.js — Printing Utilities
 * 
 * Handles:
 * - Thermal receipt printing (ESC/POS)
 * - Price label printing (A4)
 * - Report printing
 */

(function() {
  'use strict';

  const print = {
    serialPort: null,
  };

  /**
   * Initialize printer connection (for thermal printers via USB)
   * 
   * @returns {Promise<void>}
   */
  async function initPrinter() {
    try {
      console.log('🖨️ Initializing thermal printer...');
      
      // Check for Web Serial API support
      if (!navigator.serial) {
        console.warn('⚠️ Web Serial API not available');
        return;
      }

      // TODO: Request and open serial port
      console.log('⚠️ Thermal printer not yet integrated');
    } catch (error) {
      console.error('Printer initialization failed:', error);
    }
  }

  /**
   * Print thermal receipt
   * 
   * @param {Object} receipt - Receipt data {items, subtotal, tax, total, paymentMethod, change}
   * @returns {Promise<void>}
   */
  async function printReceipt(receipt) {
    try {
      console.log('🖨️ Printing thermal receipt...');
      
      if (!print.serialPort) {
        console.warn('Thermal printer not available, showing print preview');
        printReceiptWeb(receipt);
        return;
      }

      // Build ESC/POS commands
      const escpos = buildESCPOS(receipt);
      
      // TODO: Write to serial port using Web Serial API
      console.log('✅ Receipt printed');
    } catch (error) {
      console.error('Print receipt failed:', error);
    }
  }

  /**
   * Build ESC/POS command sequence
   * 
   * @param {Object} receipt
   * @returns {Uint8Array}
   */
  function buildESCPOS(receipt) {
    // ESC/POS printer commands
    const commands = [];

    // Reset printer
    commands.push([27, 64]); // ESC @

    // Center alignment
    commands.push([27, 97, 1]); // ESC a 1

    // Large text
    commands.push([27, 33, 48]); // ESC ! 0
    commands.push(textToBytes('RECIBO DE VENTA'));
    commands.push([13, 10]); // CRLF

    // Normal text
    commands.push([27, 33, 0]);
    commands.push([27, 97, 0]); // Left align

    // TODO: Add receipt items, totals, etc.

    // Cut paper
    commands.push([27, 105]); // ESC i

    // Flatten and convert to Uint8Array
    const flattened = commands.flat();
    return new Uint8Array(flattened);
  }

  /**
   * Convert text to ASCII bytes
   * 
   * @param {string} text
   * @returns {Array}
   */
  function textToBytes(text) {
    return Array.from(text).map(c => c.charCodeAt(0));
  }

  /**
   * Print receipt using browser print dialog (fallback)
   * 
   * @param {Object} receipt
   */
  function printReceiptWeb(receipt) {
    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <style>
          body { font-family: monospace; width: 50mm; margin: 0; padding: 10px; }
          .center { text-align: center; }
          .line { display: flex; justify-content: space-between; }
          .border { border-bottom: 1px dashed #000; margin: 10px 0; }
        </style>
      </head>
      <body>
        <div class="center"><h2>RECIBO DE VENTA</h2></div>
        <div class="border"></div>
        <!-- TODO: Add receipt content -->
        <div class="border"></div>
      </body>
      </html>
    `;

    const printWindow = window.open('', '', 'height=400,width=600');
    printWindow.document.write(html);
    printWindow.document.close();
    printWindow.print();
  }

  /**
   * Print price labels (A4)
   * 
   * @param {Array} labels - [{productName, productCode, price, quantity}]
   */
  function printLabels(labels) {
    console.log('🖨️ Printing price labels...');
    
    // Create print-friendly layout
    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <style>
          body { margin: 0; padding: 0; }
          @media print {
            body { margin: 0; }
          }
          .label-grid {
            display: grid;
            grid-template-columns: repeat(4, 1fr);
            gap: 0;
            padding: 20px;
          }
          .label {
            width: 5cm;
            height: 5cm;
            border: 1px solid #000;
            padding: 5px;
            box-sizing: border-box;
            page-break-inside: avoid;
            display: flex;
            flex-direction: column;
            justify-content: space-between;
            text-align: center;
            font-size: 10pt;
          }
          .label-name { font-weight: bold; font-size: 11pt; }
          .label-price { font-size: 14pt; font-weight: bold; }
          .label-code { font-size: 8pt; color: #666; }
        </style>
      </head>
      <body>
        <div class="label-grid">
          ${labels.map(label => `
            <div class="label">
              <div class="label-name">${label.productName}</div>
              <div class="label-price">$${label.price}</div>
              <div class="label-code">${label.productCode}</div>
            </div>
          `).join('')}
        </div>
        <script>
          window.print();
        </script>
      </body>
      </html>
    `;

    const printWindow = window.open('', '', 'height=600,width=800');
    printWindow.document.write(html);
    printWindow.document.close();
  }

  /**
   * Print report
   * 
   * @param {string} title
   * @param {string} html
   */
  function printReport(title, html) {
    console.log('🖨️ Printing report:', title);
    
    const printWindow = window.open('', '', 'height=600,width=900');
    printWindow.document.write(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>${title}</title>
        <style>
          body { font-family: Arial, sans-serif; margin: 20px; }
          h1 { text-align: center; }
          table { width: 100%; border-collapse: collapse; margin-top: 20px; }
          th, td { border: 1px solid #999; padding: 8px; text-align: left; }
          th { background-color: #f0f0f0; }
        </style>
      </head>
      <body>
        <h1>${title}</h1>
        ${html}
        <script>
          window.print();
        </script>
      </body>
      </html>
    `);
    printWindow.document.close();
  }

  // Export functions
  window.SGA_Print = {
    initPrinter,
    printReceipt,
    printLabels,
    printReport,
  };
})();

/**
 * Tomcat Store – Receptor de clientes y ventas (Google Apps Script)
 *
 * Pegar en la hoja: Extensiones → Apps Script. Ejecutar "configurar" una vez,
 * luego Implementar → Nueva implementación → Aplicación web
 * (Ejecutar como: Yo · Acceso: Cualquier usuario).
 *
 * La clave secreta la genera este script y queda en
 * Configuración del proyecto → Propiedades del script → SECRET.
 * Esa misma clave va en Render como SHEETS_SECRET. Nunca se escribe en la hoja.
 */

const HEADERS = ['Teléfono', 'Nombre', 'Primer contacto', 'Último mensaje', 'Origen', 'ID anuncio', 'Anuncio',
  'Modelo de interés', 'Ciudad', 'Estado', 'Monto (L)', 'Fecha venta', 'Venta reportada a Meta', 'Notas'];
const ESTADOS = ['consulta', 'datos enviados', 'vendido', 'entregado'];
const COL = Object.fromEntries(HEADERS.map((h, i) => [h, i + 1]));

function configurar() {
  const props = PropertiesService.getScriptProperties();
  if (!props.getProperty('SECRET')) {
    props.setProperty('SECRET', Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, ''));
  }
  const sh = hoja_();
  sh.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]).setFontWeight('bold').setBackground('#111111').setFontColor('#ffffff');
  sh.setFrozenRows(1);
  sh.getRange('A:A').setNumberFormat('@');
  sh.getRange('C:D').setNumberFormat('dd/mm/yyyy hh:mm');
  sh.getRange('L:L').setNumberFormat('dd/mm/yyyy hh:mm');
  sh.getRange('K:K').setNumberFormat('#,##0.00');
  const regla = SpreadsheetApp.newDataValidation().requireValueInList(ESTADOS, true).setAllowInvalid(false).build();
  sh.getRange(2, COL['Estado'], 5000, 1).setDataValidation(regla);
  sh.autoResizeColumns(1, HEADERS.length);
  Logger.log('Listo. La clave está en Configuración del proyecto → Propiedades del script → SECRET.');
}

function doPost(e) {
  let body;
  try { body = JSON.parse(e.postData.contents); } catch (_) { return salida_({ ok: false, error: 'json' }); }
  const secret = PropertiesService.getScriptProperties().getProperty('SECRET');
  if (!secret || body.secret !== secret) return salida_({ ok: false, error: 'unauthorized' });
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const fila = guardar_(body.lead || {});
    return salida_({ ok: true, fila });
  } finally {
    lock.releaseLock();
  }
}

function guardar_(lead) {
  const tel = String(lead.phone || '').replace(/\D/g, '');
  if (!tel) throw new Error('phone requerido');
  const sh = hoja_();
  const ultima = sh.getLastRow();
  let fila = 0;
  if (ultima > 1) {
    const tels = sh.getRange(2, 1, ultima - 1, 1).getValues();
    for (let i = 0; i < tels.length; i++) {
      if (String(tels[i][0]).replace(/\D/g, '') === tel) { fila = i + 2; break; }
    }
  }
  const ahora = lead.at ? new Date(lead.at) : new Date();
  if (!fila) {
    fila = Math.max(ultima, 1) + 1;
    sh.getRange(fila, COL['Teléfono']).setValue(tel);
    sh.getRange(fila, COL['Primer contacto']).setValue(ahora);
    sh.getRange(fila, COL['Estado']).setValue('consulta');
    sh.getRange(fila, COL['Origen']).setValue('Orgánico');
  }
  const set = (col, val) => { if (val !== undefined && val !== null && val !== '') sh.getRange(fila, COL[col]).setValue(val); };
  set('Último mensaje', lead.lastMessageAt ? new Date(lead.lastMessageAt) : ahora);
  // El nombre solo se escribe si la celda está vacía (puedes corregirlo a mano)
  if (lead.name && !sh.getRange(fila, COL['Nombre']).getValue()) set('Nombre', lead.name);
  if (lead.adId) { set('Origen', 'Anuncio'); set('ID anuncio', lead.adId); set('Anuncio', lead.adHeadline); }
  if (lead.status) {
    const actual = String(sh.getRange(fila, COL['Estado']).getValue() || 'consulta');
    // Nunca retrocede un estado (p. ej. si lo cambiaste a mano a "datos enviados")
    if (ESTADOS.indexOf(lead.status) > ESTADOS.indexOf(actual)) set('Estado', lead.status);
  }
  if (lead.saleValue) {
    set('Monto (L)', Number(lead.saleValue));
    set('Fecha venta', lead.saleAt ? new Date(lead.saleAt) : ahora);
    set('Venta reportada a Meta', lead.purchaseSent ? 'Sí' : 'No (sin anuncio)');
  }
  return fila;
}

function hoja_() {
  return SpreadsheetApp.getActiveSpreadsheet().getSheets()[0];
}

function salida_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

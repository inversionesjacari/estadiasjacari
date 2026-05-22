/**
 * Apps Script Web App — sirve la info de check-in del Google Sheet como JSON
 * PRIVADO para Estadías Jacarí (lo consume functions/_lib/checkin-info.ts).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * SETUP (una sola vez):
 *
 * 1. Crea un Google Sheet. La PRIMERA FILA debe tener EXACTAMENTE estos
 *    encabezados (los nombres importan; el orden no):
 *
 *      slug | property_name | wifi_network | wifi_password |
 *      access_instructions | arrival_instructions |
 *      local_contact_name | local_contact_phone | extra_notes
 *
 *    Una fila por propiedad. La columna `slug` debe coincidir con los slugs del
 *    sitio (¡exactos!):
 *      villa-b11-palma-real
 *      casa-brisa
 *      casa-marea
 *      centro-morazan
 *      casa-lara-townhouse
 *      la-florida
 *
 * 2. En el Sheet: Extensions → Apps Script. Borra el contenido y pega ESTE
 *    archivo completo.
 *
 * 3. Cambia el valor de SECRET por una cadena larga y secreta. Ese MISMO valor
 *    irá en Cloudflare Pages como la variable SHEET_WEBHOOK_SECRET.
 *
 * 4. Deploy → New deployment → engranaje → Web app:
 *      - Description:    estadias check-in
 *      - Execute as:     Me (tu cuenta)
 *      - Who has access: Anyone
 *    Deploy → Authorize access → acepta los permisos.
 *
 * 5. Copia la "Web app URL" (termina en /exec). Ese valor irá en Cloudflare
 *    Pages como la variable SHEET_WEBHOOK_URL.
 *
 * IMPORTANTE: "Who has access: Anyone" NO hace pública tu hoja. El script solo
 * responde con datos si recibe ?secret= correcto. Sin el secreto correcto
 * devuelve { ok: false, error: 'unauthorized' } y ningún dato.
 *
 * Si más adelante editas este script, recuerda: Deploy → Manage deployments →
 * editar el deployment existente (lápiz) → Version: New version → Deploy, para
 * conservar la MISMA URL.
 * ─────────────────────────────────────────────────────────────────────────────
 */

var SECRET = 'CAMBIA-ESTO-POR-UNA-CADENA-LARGA-Y-SECRETA';

function doGet(e) {
  var params = (e && e.parameter) || {};
  if (params.secret !== SECRET) {
    return jsonOut({ ok: false, error: 'unauthorized' });
  }

  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheets()[0];
  var values = sheet.getDataRange().getValues();
  if (values.length < 2) {
    return jsonOut({ ok: false, error: 'sheet vacío' });
  }

  var headers = values[0].map(function (h) {
    return String(h).trim();
  });

  var rows = [];
  for (var r = 1; r < values.length; r++) {
    var obj = {};
    for (var c = 0; c < headers.length; c++) {
      if (headers[c]) obj[headers[c]] = values[r][c];
    }
    if (obj.slug) {
      obj.slug = String(obj.slug).trim();
      rows.push(obj);
    }
  }

  var slug = params.slug ? String(params.slug).trim() : '';
  if (slug) {
    var match = rows.filter(function (row) {
      return row.slug === slug;
    })[0];
    if (!match) {
      return jsonOut({ ok: false, error: 'slug no encontrado: ' + slug });
    }
    return jsonOut({ ok: true, info: match });
  }

  // Sin slug: devuelve todas las filas (útil para depurar).
  return jsonOut({ ok: true, rows: rows });
}

function jsonOut(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(
    ContentService.MimeType.JSON
  );
}

// ============================================================
// EscaneaYa Pay — Apps Script Completo
// Versión fusionada: doGet (JSONP) + doPost (webhook) + split
// Pegar en: script.google.com → tu proyecto → Code.gs
// ============================================================

// ---- CONFIGURACIÓN — llenar antes de desplegar ----
var CONFIG = {
  // Credenciales de tu cuenta AGREGADOR en Tilopay
  // (las que te dará José, no las del panel de prueba)
  TILOPAY_API_USER: 'TU_API_USER',
  TILOPAY_API_PASS: 'TU_API_PASS',
  TILOPAY_API_KEY:  'TU_API_KEY',
  TILOPAY_BASE_URL: 'https://app.tilopay.com/api/v1',

  // Comisión EscaneaYa que se descuenta de cada pago
  COMISION_PCT:  5.5,   // % del monto cobrado al cliente
  COSTO_FIJO:    0.75,  // costo fijo por transacción ($)
  IVA_PCT:       7,     // IVA sobre la comisión (%)

  // Google Sheets donde se registra todo
  SHEET_ID:           'TU_GOOGLE_SHEET_ID',  // ID de la URL de tu hoja
  HOJA_TRANSACCIONES: 'Transacciones',
  HOJA_COMERCIOS:     'Comercios'
};

// ============================================================
// doGet — JSONP dispatcher (llamado por el frontend)
// Acciones: getTilopayToken | getNegocioPorAlias |
//           guardarTransaccion | enviarRecibo |
//           registrarNegocioEYP | getTransaccionesComercio |
//           calcularComision
// ============================================================
function doGet(e) {
  var params   = e.parameter;
  var action   = params.action   || '';
  var callback = params.callback || 'cb';
  var resultado;

  try {
    switch (action) {

      // Token SDK para el formulario de pago (front-end)
      case 'getTilopayToken':
        resultado = getTilopaySDKToken();
        break;

      // Datos del comercio por alias (escanea-y-paga.html)
      case 'getNegocioPorAlias':
        resultado = getNegocioPorAlias(params.alias || '');
        break;

      // Guardar transacción aprobada + ejecutar split
      // Llamado desde gracias-pago.html cuando code=1
      case 'guardarTransaccion':
        resultado = guardarTransaccion(params);
        break;

      // Enviar recibo por correo al cliente
      case 'enviarRecibo':
        resultado = enviarRecibo(params);
        break;

      // Registrar nuevo comercio (registro-eyp.html)
      case 'registrarNegocioEYP':
        resultado = registrarNegocioEYP(params);
        break;

      // Transacciones del comercio para su dashboard
      case 'getTransaccionesComercio':
        resultado = getTransaccionesComercio(params.email || '');
        break;

      // Preview de comisión antes de pagar (opcional)
      case 'calcularComision':
        resultado = calcularDivision(parseFloat(params.monto || 0));
        break;

      default:
        resultado = { ok: false, error: 'Acción no reconocida: ' + action };
    }
  } catch (err) {
    Logger.log('doGet error [' + action + ']: ' + err.toString());
    resultado = { ok: false, error: err.toString() };
  }

  return ContentService
    .createTextOutput(callback + '(' + JSON.stringify(resultado) + ')')
    .setMimeType(ContentService.MimeType.JAVASCRIPT);
}

// ============================================================
// doPost — Webhook que Tilopay llama cuando confirma un pago
// Configura esta URL en tu cuenta Tilopay como webhook
// ============================================================
function doPost(e) {
  try {
    var raw     = e.postData ? e.postData.contents : '{}';
    var payload = JSON.parse(raw);
    Logger.log('Webhook recibido: ' + JSON.stringify(payload));

    var status = (payload.status || payload.orderStatus || '').toUpperCase();

    // Solo procesamos pagos aprobados
    if (status !== 'A' && status !== 'APPROVED') {
      _registrarEnSheets(payload, 'NO_APROBADO', 0, 0);
      return ContentService.createTextOutput('OK').setMimeType(ContentService.MimeType.TEXT);
    }

    var orderNumber   = payload.orderNumber || payload.order_number || '';
    var montoTotal    = parseFloat(payload.amount || payload.total || 0);
    var emailComercio = (payload.metadata && payload.metadata.comercio_email)
                        ? payload.metadata.comercio_email
                        : _emailDeOrden(orderNumber);

    if (!emailComercio) {
      Logger.log('Webhook: no se encontró email para orden ' + orderNumber);
      _registrarEnSheets(payload, 'SIN_EMAIL', 0, 0);
      return ContentService.createTextOutput('OK').setMimeType(ContentService.MimeType.TEXT);
    }

    var div       = calcularDivision(montoTotal);
    var splitOk   = _ejecutarSplit(orderNumber, emailComercio, div.montoComercio);
    var estado    = splitOk ? 'SPLIT_OK' : 'SPLIT_ERROR';

    _registrarEnSheets(payload, estado, div.montoComercio, div.gananciaEscaneaya);

    return ContentService.createTextOutput('OK').setMimeType(ContentService.MimeType.TEXT);

  } catch (err) {
    Logger.log('doPost error: ' + err.toString());
    return ContentService.createTextOutput('ERROR').setMimeType(ContentService.MimeType.TEXT);
  }
}

// ============================================================
// GUARDAR TRANSACCIÓN + SPLIT
// Llamado desde gracias-pago.html cuando code === '1'
// El split también puede llegar vía webhook — la deduplicación
// en Sheets evita registros dobles (comprueba el orderNumber)
// ============================================================
function guardarTransaccion(p) {
  try {
    var orderNumber   = p.orden         || p.orderNumber || '';
    var negocio       = p.negocio       || '';
    var emailComercio = p.email_negocio || '';
    var montoTotal    = parseFloat(p.monto || 0);
    var correoCliente = p.correo_cliente || '';
    var nombreCliente = p.nombre_cliente || '';
    var fecha         = p.fecha          || '';
    var code          = p.code           || '0';

    // Solo procesar si fue aprobado
    if (code !== '1') {
      return { ok: false, motivo: 'Pago no aprobado' };
    }

    // Verificar si ya fue procesado (deduplicación)
    if (_yaRegistrado(orderNumber)) {
      return { ok: true, motivo: 'Ya registrado' };
    }

    var div     = calcularDivision(montoTotal);
    var splitOk = false;

    // Ejecutar split si tenemos el email del comercio
    if (emailComercio) {
      splitOk = _ejecutarSplit(orderNumber, emailComercio, div.montoComercio);
    }

    // Registrar en Sheets
    var ss    = SpreadsheetApp.openById(CONFIG.SHEET_ID);
    var hoja  = _obtenerOCrearHoja(ss, CONFIG.HOJA_TRANSACCIONES,
      ['Fecha', 'Hora', 'Orden', 'Negocio', 'Email Comercio',
       'Correo Cliente', 'Nombre Cliente', 'Monto Total',
       'Comisión EscaneaYa', 'Monto Comercio', 'Estado Split', 'Descripción']);

    var ahora = new Date();
    hoja.appendRow([
      Utilities.formatDate(ahora, 'America/Panama', 'dd/MM/yyyy'),
      Utilities.formatDate(ahora, 'America/Panama', 'HH:mm:ss'),
      orderNumber,
      negocio,
      emailComercio,
      correoCliente,
      nombreCliente,
      montoTotal,
      div.gananciaEscaneaya,
      div.montoComercio,
      splitOk ? 'SPLIT_OK' : (emailComercio ? 'SPLIT_ERROR' : 'SIN_EMAIL'),
      fecha
    ]);

    return {
      ok:           true,
      orden:        orderNumber,
      splitOk:      splitOk,
      montoComercio: div.montoComercio,
      comision:     div.gananciaEscaneaya
    };

  } catch (err) {
    Logger.log('guardarTransaccion error: ' + err.toString());
    return { ok: false, error: err.toString() };
  }
}

// ============================================================
// ENVIAR RECIBO POR CORREO AL CLIENTE
// ============================================================
function enviarRecibo(p) {
  try {
    var correo  = p.correo   || '';
    var nombre  = p.nombre   || 'Cliente';
    var negocio = p.negocio  || '';
    var monto   = parseFloat(p.monto || 0).toFixed(2);
    var orden   = p.orden    || '';
    var fecha   = p.fecha    || '';

    if (!correo) return { ok: false, error: 'Correo requerido' };

    var asunto = '✅ Recibo de pago — ' + negocio;
    var cuerpo =
      '<div style="font-family:Arial,sans-serif;max-width:480px;margin:auto">' +
      '<div style="background:#0A1F5C;padding:24px;text-align:center;border-radius:12px 12px 0 0">' +
      '<h2 style="color:#fff;margin:0;font-size:20px">EscaneaYa Pay</h2>' +
      '<p style="color:#8C9BD6;margin:4px 0 0;font-size:12px">Un producto de EscaneaYa</p></div>' +
      '<div style="background:#fff;padding:28px;border:1px solid #E1E5EE;border-top:none;border-radius:0 0 12px 12px">' +
      '<p style="font-size:15px">Hola <strong>' + nombre + '</strong>,</p>' +
      '<p style="color:#7A8194;font-size:13px">Tu pago fue procesado exitosamente. Aquí está tu recibo:</p>' +
      '<div style="background:#F3F5F9;border-radius:10px;padding:16px;margin:16px 0">' +
      '<table style="width:100%;font-size:13px;border-collapse:collapse">' +
      '<tr><td style="color:#7A8194;padding:6px 0">Negocio</td><td style="text-align:right;font-weight:700">' + negocio + '</td></tr>' +
      '<tr><td style="color:#7A8194;padding:6px 0">Monto</td><td style="text-align:right;font-weight:700;font-size:16px;color:#0A1F5C">$' + monto + ' USD</td></tr>' +
      '<tr><td style="color:#7A8194;padding:6px 0">Orden</td><td style="text-align:right;font-size:11px">' + orden + '</td></tr>' +
      '<tr><td style="color:#7A8194;padding:6px 0">Fecha</td><td style="text-align:right">' + fecha + '</td></tr>' +
      '<tr><td style="color:#7A8194;padding:6px 0">Estado</td><td style="text-align:right;color:#5FA818;font-weight:700">✓ Aprobado</td></tr>' +
      '</table></div>' +
      '<p style="font-size:12px;color:#7A8194;text-align:center">Pago procesado de forma segura por Tilopay · EscaneaYa Pay</p>' +
      '</div></div>';

    GmailApp.sendEmail(correo, asunto, '', { htmlBody: cuerpo, name: 'EscaneaYa Pay' });
    return { ok: true };

  } catch (err) {
    Logger.log('enviarRecibo error: ' + err.toString());
    return { ok: false, error: err.toString() };
  }
}

// ============================================================
// REGISTRAR NUEVO COMERCIO (registro-eyp.html)
// ============================================================
function registrarNegocioEYP(p) {
  try {
    var negocio  = p.negocio  || '';
    var correo   = p.correo   || '';
    var password = p.password || '';
    var whatsapp = p.whatsapp || '';

    if (!negocio || !correo || !password) {
      return { ok: false, error: 'Faltan campos requeridos' };
    }

    // Verificar si el correo ya existe
    var ss   = SpreadsheetApp.openById(CONFIG.SHEET_ID);
    var hoja = _obtenerOCrearHoja(ss, CONFIG.HOJA_COMERCIOS,
      ['Alias', 'Email', 'Prefijo Orden', 'Nombre Negocio',
       'Logo', 'Color', 'Descripción', 'WhatsApp', 'Fecha Registro',
       'Password Hash', 'Tilopay Sub-ID', 'Activo']);

    var datos = hoja.getDataRange().getValues();
    for (var i = 1; i < datos.length; i++) {
      if ((datos[i][1] + '').toLowerCase() === correo.toLowerCase()) {
        return { ok: false, error: 'Este correo ya está registrado' };
      }
    }

    // Generar alias automático desde el nombre del negocio
    var alias = negocio.toLowerCase()
                  .replace(/\s+/g, '-')
                  .replace(/[^a-z0-9-]/g, '')
                  .substring(0, 20);

    // Prefijo de orden único (3 letras mayúsculas del alias)
    var prefijo = alias.replace(/-/g, '').substring(0, 3).toUpperCase();
    if (!prefijo) prefijo = 'EYP';

    var ahora = Utilities.formatDate(new Date(), 'America/Panama', 'dd/MM/yyyy HH:mm');

    hoja.appendRow([
      alias,
      correo,
      prefijo,
      negocio,
      '',     // Logo (vacío por ahora)
      '',     // Color personalizado
      '',     // Descripción
      whatsapp,
      ahora,
      password, // En producción usar hashing: Utilities.computeDigest(...)
      '',     // Tilopay Sub-ID (se llenará cuando José confirme el API)
      'SI'
    ]);

    // Correo de bienvenida al comercio
    try {
      GmailApp.sendEmail(correo, '¡Bienvenido a EscaneaYa Pay! 🎉', '', {
        htmlBody:
          '<div style="font-family:Arial,sans-serif;max-width:480px;margin:auto">' +
          '<div style="background:#0A1F5C;padding:24px;text-align:center;border-radius:12px 12px 0 0">' +
          '<h2 style="color:#fff;margin:0">EscaneaYa Pay</h2></div>' +
          '<div style="padding:28px;border:1px solid #E1E5EE;border-top:none;border-radius:0 0 12px 12px">' +
          '<p>Hola <strong>' + negocio + '</strong>, ¡ya estás listo para cobrar!</p>' +
          '<p style="color:#7A8194;font-size:13px">Tu alias de pago es: <strong>escaneayapay.com/escanea-y-paga.html?alias=' + alias + '</strong></p>' +
          '<p style="color:#7A8194;font-size:13px">Accede a tu dashboard en: <a href="https://escaneayapay.com/dashboard-eyp.html?correo=' + encodeURIComponent(correo) + '">Mi Dashboard</a></p>' +
          '<p style="font-size:12px;color:#aaa;margin-top:20px">Comisión: 5.5% + $0.75 + IVA por transacción. Sin mensualidad.</p>' +
          '</div></div>',
        name: 'EscaneaYa Pay'
      });
    } catch(mailErr) {
      Logger.log('Correo bienvenida fallido: ' + mailErr.toString());
    }

    return { ok: true, alias: alias, correo: correo };

  } catch (err) {
    Logger.log('registrarNegocioEYP error: ' + err.toString());
    return { ok: false, error: err.toString() };
  }
}

// ============================================================
// TRANSACCIONES DEL COMERCIO (para el dashboard)
// ============================================================
function getTransaccionesComercio(email) {
  try {
    if (!email) return { ok: false, error: 'Email requerido' };

    var ss   = SpreadsheetApp.openById(CONFIG.SHEET_ID);
    var hoja = ss.getSheetByName(CONFIG.HOJA_TRANSACCIONES);
    if (!hoja) return { ok: true, transacciones: [], totalRecibido: 0, cantidad: 0 };

    var datos = hoja.getDataRange().getValues();
    var txs   = [];
    var totalRecibido = 0;

    for (var i = 1; i < datos.length; i++) {
      if ((datos[i][4] + '').toLowerCase() === email.toLowerCase()) {
        var monto = parseFloat(datos[i][9]) || 0; // Monto Comercio (col 9)
        if (datos[i][10] === 'SPLIT_OK') totalRecibido += monto;
        txs.push({
          fecha:         datos[i][0],
          hora:          datos[i][1],
          orden:         datos[i][2],
          negocio:       datos[i][3],
          montoTotal:    datos[i][7],
          comision:      datos[i][8],
          montoRecibido: monto,
          estado:        datos[i][10]
        });
      }
    }

    txs.reverse(); // más recientes primero
    return {
      ok:            true,
      transacciones: txs.slice(0, 50),
      totalRecibido: Math.round(totalRecibido * 100) / 100,
      cantidad:      txs.length
    };

  } catch (err) {
    Logger.log('getTransaccionesComercio error: ' + err.toString());
    return { ok: false, error: err.toString() };
  }
}

// ============================================================
// BUSCAR NEGOCIO POR ALIAS (escanea-y-paga.html)
// ============================================================
function getNegocioPorAlias(alias) {
  try {
    if (!alias) return { error: 'Alias requerido' };

    var ss   = SpreadsheetApp.openById(CONFIG.SHEET_ID);
    var hoja = ss.getSheetByName(CONFIG.HOJA_COMERCIOS);
    if (!hoja) return { error: 'Hoja no encontrada' };

    var datos = hoja.getDataRange().getValues();
    // Col: 0=Alias, 1=Email, 2=Prefijo, 3=Nombre, 4=Logo, 5=Color, 6=Desc, 7=WhatsApp
    for (var i = 1; i < datos.length; i++) {
      if ((datos[i][0] + '').toLowerCase() === alias.toLowerCase()) {
        return {
          ok:          true,
          alias:       datos[i][0],
          email:       datos[i][1],
          prefijo:     datos[i][2],
          nombre:      datos[i][3],
          logo:        datos[i][4],
          color:       datos[i][5],
          descripcion: datos[i][6],
          whatsapp:    datos[i][7]
        };
      }
    }
    return { error: 'Negocio no encontrado', alias: alias };

  } catch (err) {
    return { error: err.toString() };
  }
}

// ============================================================
// CALCULAR DIVISIÓN DE COMISIÓN
// Ejemplo con $100:
//   comisionBase   = $100 × 5.5% = $5.50
//   costoFijo      = $0.75
//   subtotal       = $6.25
//   IVA (7%)       = $0.4375 → $0.44
//   total comisión = $6.69
//   comercio recibe= $100 - $6.69 = $93.31
// ============================================================
function calcularDivision(montoTotal) {
  var comisionBase     = montoTotal * (CONFIG.COMISION_PCT / 100);
  var subtotal         = comisionBase + CONFIG.COSTO_FIJO;
  var iva              = subtotal * (CONFIG.IVA_PCT / 100);
  var totalComision    = subtotal + iva;
  var gananciaEY       = Math.round(totalComision * 100) / 100;
  var montoComercio    = Math.round((montoTotal - totalComision) * 100) / 100;

  return {
    montoTotal:        montoTotal,
    comisionBase:      Math.round(comisionBase * 100) / 100,
    costoFijo:         CONFIG.COSTO_FIJO,
    subtotalComision:  Math.round(subtotal * 100) / 100,
    iva:               Math.round(iva * 100) / 100,
    gananciaEscaneaya: gananciaEY,
    montoComercio:     montoComercio
  };
}

// ============================================================
// TOKEN SDK DE TILOPAY (para el frontend)
// Llama al API con el token de agregador y devuelve el SDK token
// ============================================================
function getTilopaySDKToken() {
  try {
    var apiToken = _obtenerTokenAPI();
    if (!apiToken) return { error: 'No se pudo autenticar con Tilopay' };

    var resp = UrlFetchApp.fetch(CONFIG.TILOPAY_BASE_URL + '/sdk/token', {
      method:  'GET',
      headers: { 'Authorization': 'Bearer ' + apiToken },
      muteHttpExceptions: true
    });

    var body = JSON.parse(resp.getContentText());
    return body; // Devuelve el token SDK al frontend directamente

  } catch (err) {
    Logger.log('getTilopaySDKToken error: ' + err.toString());
    return { error: err.toString() };
  }
}

// ============================================================
// INTERNAS — prefijo _ para distinguirlas
// ============================================================

// Caché en memoria del token API (válido por 23h en esta instancia)
var _tok = null, _tokTime = 0;

function _obtenerTokenAPI() {
  var ahora   = new Date().getTime();
  var _23H    = 23 * 3600 * 1000;
  if (_tok && (ahora - _tokTime) < _23H) return _tok;

  try {
    var resp = UrlFetchApp.fetch(CONFIG.TILOPAY_BASE_URL + '/login', {
      method:      'POST',
      contentType: 'application/json',
      payload:     JSON.stringify({
        user:     CONFIG.TILOPAY_API_USER,
        password: CONFIG.TILOPAY_API_PASS,
        apikey:   CONFIG.TILOPAY_API_KEY
      }),
      muteHttpExceptions: true
    });
    var body = JSON.parse(resp.getContentText());
    if (body && body.token) {
      _tok = body.token; _tokTime = ahora;
      return _tok;
    }
    Logger.log('Login Tilopay fallido: ' + JSON.stringify(body));
    return null;
  } catch (err) {
    Logger.log('_obtenerTokenAPI error: ' + err.toString());
    return null;
  }
}

function _ejecutarSplit(orderNumber, emailComercio, montoComercio) {
  try {
    var token = _obtenerTokenAPI();
    if (!token) { Logger.log('Split: sin token'); return false; }

    var resp = UrlFetchApp.fetch(CONFIG.TILOPAY_BASE_URL + '/orders/liquidation/split', {
      method:      'POST',
      contentType: 'application/json',
      headers:     { 'Authorization': 'Bearer ' + token },
      payload:     JSON.stringify({
        orderNumber: orderNumber,
        email:       emailComercio,
        amount:      montoComercio
      }),
      muteHttpExceptions: true
    });

    var code = resp.getResponseCode();
    var body = resp.getContentText();
    Logger.log('Split [' + code + '] orden=' + orderNumber + ' comercio=' + emailComercio + ' monto=$' + montoComercio + ' resp=' + body);
    return code === 200 || code === 201;

  } catch (err) {
    Logger.log('_ejecutarSplit error: ' + err.toString());
    return false;
  }
}

// Registrar transacción vía webhook (flujo alternativo al JSONP)
function _registrarEnSheets(payload, estado, montoComercio, gananciaEY) {
  try {
    var ss   = SpreadsheetApp.openById(CONFIG.SHEET_ID);
    var hoja = _obtenerOCrearHoja(ss, CONFIG.HOJA_TRANSACCIONES,
      ['Fecha', 'Hora', 'Orden', 'Negocio', 'Email Comercio',
       'Correo Cliente', 'Nombre Cliente', 'Monto Total',
       'Comisión EscaneaYa', 'Monto Comercio', 'Estado Split', 'Descripción']);

    var ahora = new Date();
    hoja.appendRow([
      Utilities.formatDate(ahora, 'America/Panama', 'dd/MM/yyyy'),
      Utilities.formatDate(ahora, 'America/Panama', 'HH:mm:ss'),
      payload.orderNumber || '',
      '',
      payload.metadata && payload.metadata.comercio_email ? payload.metadata.comercio_email : '',
      '',
      '',
      parseFloat(payload.amount || 0),
      gananciaEY,
      montoComercio,
      estado,
      payload.description || ''
    ]);
  } catch (err) {
    Logger.log('_registrarEnSheets error: ' + err.toString());
  }
}

// Verificar si una orden ya fue procesada (evita dobles splits)
function _yaRegistrado(orderNumber) {
  if (!orderNumber) return false;
  try {
    var ss   = SpreadsheetApp.openById(CONFIG.SHEET_ID);
    var hoja = ss.getSheetByName(CONFIG.HOJA_TRANSACCIONES);
    if (!hoja) return false;
    var datos = hoja.getDataRange().getValues();
    for (var i = 1; i < datos.length; i++) {
      if (datos[i][2] === orderNumber) return true;
    }
    return false;
  } catch (err) { return false; }
}

// Email del comercio desde la hoja Comercios (por prefijo de orden)
function _emailDeOrden(orderNumber) {
  try {
    var ss   = SpreadsheetApp.openById(CONFIG.SHEET_ID);
    var hoja = ss.getSheetByName(CONFIG.HOJA_COMERCIOS);
    if (!hoja) return null;
    var datos = hoja.getDataRange().getValues();
    for (var i = 1; i < datos.length; i++) {
      if (orderNumber && datos[i][2] && orderNumber.startsWith(datos[i][2])) {
        return datos[i][1];
      }
    }
    return null;
  } catch (err) { return null; }
}

// Obtener o crear una hoja con encabezados
function _obtenerOCrearHoja(ss, nombre, encabezados) {
  var hoja = ss.getSheetByName(nombre);
  if (!hoja) {
    hoja = ss.insertSheet(nombre);
    hoja.appendRow(encabezados);
    hoja.getRange(1, 1, 1, encabezados.length)
        .setFontWeight('bold')
        .setBackground('#0A1F5C')
        .setFontColor('#FFFFFF');
  }
  return hoja;
}

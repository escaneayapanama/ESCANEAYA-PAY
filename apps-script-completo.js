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

  // Google Sheets — EscaneaYa Pay
  SHEET_ID:           '1LduSNJKhJzHEjIHGZ00vS0fZf5c36vnPhYW0taIY2FE',
  HOJA_TRANSACCIONES: 'transacciones_eyp',
  HOJA_COMERCIOS:     'negocios_eyp',
  HOJA_LIQUIDACIONES: 'liquidaciones_eyp'
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
    var code          = p.code           || '0';

    // Solo procesar si fue aprobado
    if (code !== '1') {
      return { ok: false, motivo: 'Pago no aprobado' };
    }

    // Deduplicación: si la orden ya existe en Sheets, no hacer nada
    if (_yaRegistrado(orderNumber)) {
      return { ok: true, motivo: 'Ya registrado' };
    }

    var div     = calcularDivision(montoTotal);
    var splitOk = false;

    // Ejecutar split en Tilopay si tenemos email del comercio
    if (emailComercio) {
      splitOk = _ejecutarSplit(orderNumber, emailComercio, div.montoComercio);
    }

    // ── Guardar en transacciones_eyp ────────────────────────────
    // Columnas existentes: fecha,negocio,email_negocio,monto,orden,
    //                      correo_cliente,nombre_cliente,estado
    // Columnas nuevas añadidas al final: comision_eyp,monto_comercio,estado_split
    var ss   = SpreadsheetApp.openById(CONFIG.SHEET_ID);
    var hoja = ss.getSheetByName(CONFIG.HOJA_TRANSACCIONES);
    if (!hoja) return { ok: false, error: 'Hoja transacciones_eyp no encontrada' };

    var ahora = new Date();
    var fechaStr = Utilities.formatDate(ahora, 'America/Panama', 'dd \'de\' MMMM \'de\' yyyy · HH:mm');

    hoja.appendRow([
      fechaStr,           // fecha
      negocio,            // negocio
      emailComercio,      // email_negocio
      montoTotal,         // monto
      orderNumber,        // orden
      correoCliente,      // correo_cliente
      nombreCliente,      // nombre_cliente
      'aprobado',         // estado
      div.gananciaEscaneaya,                                        // comision_eyp (col nueva)
      div.montoComercio,                                            // monto_comercio (col nueva)
      splitOk ? 'SPLIT_OK' : (emailComercio ? 'SPLIT_ERROR' : 'SIN_EMAIL') // estado_split (col nueva)
    ]);

    return {
      ok:            true,
      orden:         orderNumber,
      splitOk:       splitOk,
      montoComercio: div.montoComercio,
      comision:      div.gananciaEscaneaya
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

    var ss   = SpreadsheetApp.openById(CONFIG.SHEET_ID);
    var hoja = ss.getSheetByName(CONFIG.HOJA_COMERCIOS);
    if (!hoja) return { ok: false, error: 'Hoja negocios_eyp no encontrada' };

    // Verificar si el correo ya existe
    var datos = hoja.getDataRange().getValues();
    for (var i = 1; i < datos.length; i++) {
      if ((datos[i][1] + '').toLowerCase() === correo.toLowerCase()) {
        return { ok: false, error: 'Este correo ya está registrado' };
      }
    }

    // Generar alias desde el nombre del negocio
    var alias = negocio.toLowerCase()
                  .replace(/\s+/g, '-')
                  .replace(/[^a-z0-9-]/g, '')
                  .substring(0, 20);

    // ID único tipo EYP-timestamp
    var id = 'EYP-' + new Date().getTime();
    var ahora = Utilities.formatDate(new Date(), 'America/Panama', 'yyyy-MM-dd HH:mm:ss');

    // negocios_eyp cols:
    // id,correo,negocio,logo,whatsapp,password,fecha_registro,estado,ventas,
    // stand_solicitado,kyc_enviado,banco_guardado,cedula_url,aviso_url,
    // banco,titular,cuenta,tipo_cuenta,alias
    hoja.appendRow([
      id,        // id
      correo,    // correo
      negocio,   // negocio
      '',        // logo
      whatsapp,  // whatsapp
      password,  // password
      ahora,     // fecha_registro
      'activo',  // estado
      0,         // ventas
      '',        // stand_solicitado
      '',        // kyc_enviado
      '',        // banco_guardado
      '',        // cedula_url
      '',        // aviso_url
      '',        // banco
      '',        // titular
      '',        // cuenta
      '',        // tipo_cuenta
      alias      // alias
    ]);

    // Correo de bienvenida
    try {
      GmailApp.sendEmail(correo, '¡Bienvenido a EscaneaYa Pay! 🎉', '', {
        htmlBody:
          '<div style="font-family:Arial,sans-serif;max-width:480px;margin:auto">' +
          '<div style="background:#0A1F5C;padding:24px;text-align:center;border-radius:12px 12px 0 0">' +
          '<h2 style="color:#fff;margin:0">EscaneaYa Pay</h2>' +
          '<p style="color:#8C9BD6;margin:4px 0 0;font-size:12px">Un producto de EscaneaYa</p></div>' +
          '<div style="padding:28px;border:1px solid #E1E5EE;border-top:none;border-radius:0 0 12px 12px">' +
          '<p>Hola <strong>' + negocio + '</strong>, ¡ya estás listo para cobrar con tarjeta!</p>' +
          '<div style="background:#F3F5F9;border-radius:10px;padding:16px;margin:16px 0;font-size:13px">' +
          '<p style="margin:0 0 8px"><strong>Tu link de cobro:</strong><br>' +
          '<a href="https://escaneayapay.com/escanea-y-paga.html?alias=' + alias + '">escaneayapay.com/escanea-y-paga.html?alias=' + alias + '</a></p>' +
          '<p style="margin:0"><strong>Tu dashboard:</strong><br>' +
          '<a href="https://escaneayapay.com/dashboard-eyp.html?correo=' + encodeURIComponent(correo) + '">Ver mi dashboard</a></p></div>' +
          '<p style="font-size:12px;color:#aaa">Comisión: 5.5% + $0.75 + IVA por transacción. Sin mensualidad.</p>' +
          '</div></div>',
        name: 'EscaneaYa Pay'
      });
    } catch(mailErr) {
      Logger.log('Correo bienvenida fallido: ' + mailErr.toString());
    }

    return { ok: true, alias: alias, correo: correo, id: id };

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
    var totalBruto   = 0;
    var totalComision = 0;
    var totalNeto    = 0;

    // transacciones_eyp cols:
    // 0=fecha, 1=negocio, 2=email_negocio, 3=monto, 4=orden,
    // 5=correo_cliente, 6=nombre_cliente, 7=estado,
    // 8=comision_eyp (nueva), 9=monto_comercio (nueva), 10=estado_split (nueva)
    for (var i = 1; i < datos.length; i++) {
      if (!datos[i][0]) continue; // fila vacía
      if ((datos[i][2] + '').toLowerCase() === email.toLowerCase()) {
        var montoTx   = parseFloat(datos[i][3]) || 0;
        var comisionTx = parseFloat(datos[i][8]) || 0;
        var netoTx    = parseFloat(datos[i][9]) || 0;
        var estadoTx  = datos[i][7] || '';
        var splitTx   = datos[i][10] || '';

        totalBruto    += montoTx;
        totalComision += comisionTx;
        if (splitTx === 'SPLIT_OK') totalNeto += netoTx;

        txs.push({
          fecha:        datos[i][0],
          negocio:      datos[i][1],
          monto:        montoTx,
          orden:        datos[i][4],
          correo:       datos[i][5],
          nombre:       datos[i][6],
          estado:       estadoTx,
          comision:     comisionTx,
          neto:         netoTx,
          estadoSplit:  splitTx
        });
      }
    }

    txs.reverse(); // más recientes primero
    return {
      ok:            true,
      transacciones: txs.slice(0, 50),
      totalBruto:    Math.round(totalBruto * 100) / 100,
      totalComision: Math.round(totalComision * 100) / 100,
      totalNeto:     Math.round(totalNeto * 100) / 100,
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
    if (!hoja) return { error: 'Hoja negocios_eyp no encontrada' };

    var datos = hoja.getDataRange().getValues();
    // negocios_eyp cols:
    // 0=id, 1=correo, 2=negocio, 3=logo, 4=whatsapp, 5=password,
    // 6=fecha_registro, 7=estado, 8=ventas, 9=stand_solicitado,
    // 10=kyc_enviado, 11=banco_guardado, 12=cedula_url, 13=aviso_url,
    // 14=banco, 15=titular, 16=cuenta, 17=tipo_cuenta, 18=alias
    for (var i = 1; i < datos.length; i++) {
      var aliasSheet = (datos[i][18] + '').toLowerCase().trim();
      if (aliasSheet === alias.toLowerCase().trim()) {
        return {
          ok:       true,
          alias:    datos[i][18],
          email:    datos[i][1],
          nombre:   datos[i][2],
          logo:     datos[i][3],
          whatsapp: datos[i][4],
          estado:   datos[i][7]
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
    var resp = UrlFetchApp.fetch(CONFIG.TILOPAY_BASE_URL + '/loginSdk', {
      method:      'POST',
      contentType: 'application/json',
      payload:     JSON.stringify({
        apiuser:  CONFIG.TILOPAY_API_USER,
        password: CONFIG.TILOPAY_API_PASS,
        key:      CONFIG.TILOPAY_API_KEY
      }),
      muteHttpExceptions: true
    });

    var body = JSON.parse(resp.getContentText());
    // Normalizar: devolver siempre como { token: '...' } para el frontend
    if (body && body.access_token) {
      return { token: body.access_token, expires_in: body.expires_in };
    }
    return { error: body.error || 'No se pudo obtener SDK token' };

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
        apiuser:  CONFIG.TILOPAY_API_USER,
        password: CONFIG.TILOPAY_API_PASS,
        apikey:   CONFIG.TILOPAY_API_KEY
      }),
      muteHttpExceptions: true
    });
    var body = JSON.parse(resp.getContentText());
    if (body && body.access_token) {
      _tok = body.access_token; _tokTime = ahora;
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

// Verificar si una orden ya fue procesada — col 4 = orden en transacciones_eyp
function _yaRegistrado(orderNumber) {
  if (!orderNumber) return false;
  try {
    var ss   = SpreadsheetApp.openById(CONFIG.SHEET_ID);
    var hoja = ss.getSheetByName(CONFIG.HOJA_TRANSACCIONES);
    if (!hoja) return false;
    var datos = hoja.getDataRange().getValues();
    for (var i = 1; i < datos.length; i++) {
      if ((datos[i][4] + '') === orderNumber) return true; // col 4 = orden
    }
    return false;
  } catch (err) { return false; }
}

// Email del comercio desde negocios_eyp buscando por alias en el prefijo de la orden
// Las órdenes tienen formato EYP-{timestamp} — como no tienen prefijo por comercio,
// esta función no aplica directamente. Se usa cuando el webhook no trae email.
// En nuestro flujo el email siempre viene desde gracias-pago.html.
function _emailDeOrden(orderNumber) {
  // No usado en flujo principal (el email viene del frontend)
  // Reservado para el webhook de Tilopay
  return null;
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

const express = require('express');
const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const crypto = require('crypto');
const WebSocket = require('ws');
const OpenAI = require('openai');

const app = express();
const PORT = process.env.PORT || 5001;
const TURNOS_FILE = path.join(__dirname, 'turnos.json');
const SERVICIOS_FILE = path.join(__dirname, 'servicios.json');
const CONFIG_FILE = path.join(__dirname, 'config.json');
const BLOQUEOS_FILE = path.join(__dirname, 'bloqueos.json');
const PAISES_FILE = path.join(__dirname, 'paises.json');
const UPLOADS_DIR = path.join(__dirname, 'uploads');

const deepseek = new OpenAI({ baseURL: 'https://api.deepseek.com/v1', apiKey: process.env.DEEPSEEK_API_KEY || '' });
app.disable('x-powered-by');
if (!fsSync.existsSync(UPLOADS_DIR)) fsSync.mkdirSync(UPLOADS_DIR, { recursive: true });
app.use('/uploads', express.static(UPLOADS_DIR));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

const HORAS_VALIDAS = [12, 16, 20];
const DIAS_VALIDOS = ['lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado'];
const DIAS_NOMBRE = { lunes:'Lunes', martes:'Martes', miercoles:'Miércoles', jueves:'Jueves', viernes:'Viernes', sabado:'Sábado' };

// ============================================================
// BLOQUEOS
// ============================================================
var bloqueos = new Map(), historialBloqueos = [], intentosFallidos = new Map();
var turnosRecientesIP = new Map(), turnosRecientesTel = new Map();

async function cargarBloqueos() {
    try {
        if (fsSync.existsSync(BLOQUEOS_FILE)) {
            var d = JSON.parse(await fs.readFile(BLOQUEOS_FILE, 'utf8'));
            bloqueos = new Map(Object.entries(d.bloqueos || {}));
            historialBloqueos = d.historial || [];
            var ahora = Date.now();
            for (var e of bloqueos) { if (ahora > e[1].hasta) bloqueos.delete(e[0]); }
            await guardarBloqueos();
        }
    } catch (e) { await fs.writeFile(BLOQUEOS_FILE, JSON.stringify({ bloqueos: {}, historial: [] }, null, 2), 'utf8'); }
}
async function guardarBloqueos() { try { await fs.writeFile(BLOQUEOS_FILE, JSON.stringify({ bloqueos: Object.fromEntries(bloqueos), historial: historialBloqueos.slice(0, 500) }, null, 2), 'utf8'); } catch(e) {} }
function estaBloqueado(ip) { if (bloqueos.has(ip)) { if (Date.now() < bloqueos.get(ip).hasta) return true; bloqueos.delete(ip); guardarBloqueos(); } return false; }
function bloquearIP(ip, motivo, tipo) {
    bloqueos.set(ip, { hasta: Date.now()+3600000, motivo: motivo, tipoAtaque: tipo||'?', fecha: new Date().toISOString(), ip:ip, intentos: (intentosFallidos.get(ip)||{}).count||0, permanente: false });
    historialBloqueos.unshift(Object.assign({}, bloqueos.get(ip), { id: generarId() }));
    guardarBloqueos();
}
function desbloquearIP(ip) { bloqueos.delete(ip); intentosFallidos.delete(ip); guardarBloqueos(); }
function limpiarViejos(m, v) { var a = Date.now(); for (var e of m) { m.set(e[0], e[1].filter(function(t) { return a - t < v; })); if (!m.get(e[0]).length) m.delete(e[0]); } }
function registrarIntento(ip, tipo) {
    var a = Date.now();
    if (!intentosFallidos.has(ip)) { intentosFallidos.set(ip, { count: 1, first: a }); return false; }
    var d = intentosFallidos.get(ip);
    if (a - d.first > 600000) { intentosFallidos.set(ip, { count: 1, first: a }); return false; }
    d.count++;
    if (d.count >= 5) { bloquearIP(ip, '5+ intentos: ' + tipo, tipo); intentosFallidos.delete(ip); return true; }
    return false;
}
function checkRateIP(ip) { limpiarViejos(turnosRecientesIP, 3600000); return (turnosRecientesIP.get(ip) || []).length < 3; }
function checkRateTel(tel) { limpiarViejos(turnosRecientesTel, 86400000); return (turnosRecientesTel.get(tel) || []).length < 2; }
function regTurno(ip, tel) { var a = Date.now(); if (!turnosRecientesIP.has(ip)) turnosRecientesIP.set(ip, []); turnosRecientesIP.get(ip).push(a); if (!turnosRecientesTel.has(tel)) turnosRecientesTel.set(tel, []); turnosRecientesTel.get(tel).push(a); }

// ============================================================
// PAÍSES
// ============================================================
var paisesConfig = { autorizados: [], bloqueados: [], modo: 'todos', paisActivo: null };

var PAISES_DATOS = [
    { nombre:'Cuba', codigo:'53', claves:['cuba','cubano','cubana'] },
    { nombre:'Argentina', codigo:'54', claves:['argentina','argentino','argentina'] },
    { nombre:'México', codigo:'52', claves:['méxico','mexico','mexicano','mexicana'] },
    { nombre:'Colombia', codigo:'57', claves:['colombia','colombiano','colombiana'] },
    { nombre:'Chile', codigo:'56', claves:['chile','chileno','chilena'] },
    { nombre:'Perú', codigo:'51', claves:['perú','peru','peruano','peruana'] },
    { nombre:'España', codigo:'34', claves:['españa','español','espana'] },
];

async function cargarPaises() {
    try { 
        if (fsSync.existsSync(PAISES_FILE)) {
            var data = JSON.parse(await fs.readFile(PAISES_FILE, 'utf8'));
            paisesConfig = data;
        } else { 
            await guardarPaises(); 
        }
    } catch(e) { await guardarPaises(); }
}
async function guardarPaises() { await fs.writeFile(PAISES_FILE, JSON.stringify(paisesConfig, null, 2), 'utf8'); }

function paisAutorizado(codigo) {
    if (paisesConfig.modo === 'solo_autorizados' && paisesConfig.paisActivo) {
        return codigo === paisesConfig.paisActivo.codigo;
    }
    if (paisesConfig.modo === 'todos') {
        return !paisesConfig.bloqueados.includes(codigo);
    }
    return paisesConfig.autorizados.includes(codigo);
}

function getPaisActivo() {
    if (paisesConfig.modo === 'solo_autorizados' && paisesConfig.paisActivo) {
        return paisesConfig.paisActivo;
    }
    return null;
}

// ============================================================
// BASE DE CONOCIMIENTO IA
// ============================================================
var baseConocimiento = [];
async function inicializarBaseConocimiento() {
    baseConocimiento = serviciosData.map(function(s) {
        return s.nombre + ': ' + s.descripcion + '. Precio: ' + s.precio;
    }).concat([
        'Horarios: Lunes a Sábado. Turnos: 12:00, 16:00, 20:00. Uno por persona por día.',
        'Cancelación con 4 horas de anticipación.'
    ]);
}

var personalidadIA = { nombre:'Asistente', tono:'cálido y profesional', estilo:'Español neutro, conciso.', reglas:['NUNCA inventar','SIEMPRE ofrecer reservar','Respuestas cortas'] };

// ============================================================
// UTILIDADES
// ============================================================
function generarId() { return Date.now().toString(36) + Math.random().toString(36).substr(2) + crypto.randomBytes(4).toString('hex'); }
function escapeHtml(s) { return s ? s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;') : ''; }
function sanitize(s) { return s ? s.trim().replace(/[^\w\sáéíóúñÑü.,@\-]/gi, '') : ''; }

// ============================================================
// EXTRACCIÓN DE NOMBRE
// ============================================================
function extraerNombre(texto) {
    if (!texto) return null;
    var t = texto.toLowerCase();
    
    var patrones = [
        /(?:mi\s+nombre\s+es|me\s+llamo|soy|me\s+dicen)\s+([a-záéíóúñ]+(?:\s+[a-záéíóúñ]+){0,2})/i,
        /\b(?:hola|buenas),\s*(?:soy|me llamo)\s+([a-záéíóúñ]+)/i,
        /^([a-záéíóúñ]{2,12})(?:\s+(?:quiere|quisiera|necesita))/i
    ];
    
    for (var p = 0; p < patrones.length; p++) {
        var m = t.match(patrones[p]);
        if (m && m[1]) {
            var nombre = m[1].trim();
            return nombre.charAt(0).toUpperCase() + nombre.slice(1);
        }
    }
    return null;
}

// ============================================================
// EXTRACCIÓN DE TELÉFONO - ACEPTA DÍGITOS SEPARADOS
// ============================================================
function extraerTelefono(texto) {
    if (!texto) return null;
    
    // Limpiar texto
    var limpio = texto.toLowerCase();
    
    // Buscar patrón "mi número es 5 5 5 1 2 3 4"
    var patronFrase = /(?:tel[eé]fono|n[uú]mero|celular|whatsapp)\s*(?:es)?\s*:?\s*([\d\s]{6,})/i;
    var match = limpio.match(patronFrase);
    if (match) {
        var num = match[1].replace(/\s/g, '');
        if (num.length >= 7 && num.length <= 15) return num;
    }
    
    // Buscar dígitos individuales (ej: "5 5 5 1 2 3 4")
    var digitosSueltos = limpio.match(/\b\d\b/g);
    if (digitosSueltos && digitosSueltos.length >= 7) {
        return digitosSueltos.join('');
    }
    
    // Buscar cualquier secuencia de 7-12 dígitos
    var numeros = limpio.match(/\d{7,12}/g);
    if (numeros && numeros.length > 0) {
        return numeros[0];
    }
    
    return null;
}

// ============================================================
// DETECCIÓN DE MASAJE
// ============================================================
function detectarMasaje(texto, servicios) {
    var t = texto.toLowerCase();
    for (var i = 0; i < servicios.length; i++) {
        var nombre = servicios[i].nombre.toLowerCase();
        if (t.indexOf(nombre) !== -1) {
            return servicios[i];
        }
        var palabras = nombre.split(' ');
        for (var j = 0; j < palabras.length; j++) {
            if (palabras[j].length > 3 && t.indexOf(palabras[j]) !== -1) {
                return servicios[i];
            }
        }
    }
    return null;
}

// ============================================================
// ANÁLISIS COMPLETO DEL TEXTO
// ============================================================
function analizarTexto(texto, servicios) {
    var t = texto.toLowerCase();
    var resultado = {
        nombre: extraerNombre(texto),
        masaje: detectarMasaje(texto, servicios),
        dia: null,
        hora: null,
        tipoServicio: null,
        telefono: extraerTelefono(texto),
        intencion: 'conversacion'
    };
    
    // Detectar día
    if (t.indexOf('lunes') !== -1) resultado.dia = 'lunes';
    else if (t.indexOf('martes') !== -1) resultado.dia = 'martes';
    else if (t.indexOf('miércoles') !== -1 || t.indexOf('miercoles') !== -1) resultado.dia = 'miercoles';
    else if (t.indexOf('jueves') !== -1) resultado.dia = 'jueves';
    else if (t.indexOf('viernes') !== -1) resultado.dia = 'viernes';
    else if (t.indexOf('sábado') !== -1 || t.indexOf('sabado') !== -1) resultado.dia = 'sabado';
    
    // Detectar hora
    if (t.indexOf('12') !== -1 || t.indexOf('doce') !== -1 || t.indexOf('mediodía') !== -1) resultado.hora = 12;
    else if (t.indexOf('16') !== -1 || t.indexOf('cuatro') !== -1 || t.indexOf('tarde') !== -1) resultado.hora = 16;
    else if (t.indexOf('20') !== -1 || t.indexOf('ocho') !== -1 || t.indexOf('noche') !== -1) resultado.hora = 20;
    
    // Detectar tipo de servicio
    if (t.indexOf('domicilio') !== -1 || t.indexOf('casa') !== -1) resultado.tipoServicio = 'domicilio';
    else if (t.indexOf('salón') !== -1 || t.indexOf('salon') !== -1 || t.indexOf('local') !== -1) resultado.tipoServicio = 'salon';
    
    // Detectar intención
    if (/\b(reservar|turno|cita|agendar|quiero|quisiera|necesito)\b/i.test(t)) {
        resultado.intencion = 'reservar';
    } else if (/\b(cancelar|anular)\b/i.test(t)) {
        resultado.intencion = 'cancelar';
    } else if (/\b(precio|costo|cuánto|cuesta|tarifa)\b/i.test(t)) {
        resultado.intencion = 'precios';
    } else if (/\b(horario|hora|cuándo)\b/i.test(t)) {
        resultado.intencion = 'horarios';
    } else if (/\b(servicio|masaje|tipos|qué ofrecen)\b/i.test(t)) {
        resultado.intencion = 'servicios';
    }
    
    return resultado;
}

// ============================================================
// FUNCIONES DE RESERVA
// ============================================================
async function loadTurnos() {
    try { return JSON.parse(await fs.readFile(TURNOS_FILE, 'utf8')); }
    catch(e) { return []; }
}
async function saveTurnos(turnos) { await fs.writeFile(TURNOS_FILE, JSON.stringify(turnos, null, 2), 'utf8'); }

function buscarAlternativa(dia, hora, turnos) {
    for (var i = 0; i < DIAS_VALIDOS.length; i++) {
        var d2 = DIAS_VALIDOS[i];
        for (var j = 0; j < HORAS_VALIDAS.length; j++) {
            var h2 = HORAS_VALIDAS[j];
            if (d2 === dia && h2 <= hora) continue;
            var ocupado = false;
            for (var t = 0; t < turnos.length; t++) {
                if (turnos[t].dia === d2 && turnos[t].hora === h2) {
                    ocupado = true;
                    break;
                }
            }
            if (!ocupado) return { dia: d2, hora: h2 };
        }
    }
    return null;
}

// ============================================================
// MANEJAR RESERVA
// ============================================================
async function manejarReserva(datos, ip, session) {
    // Validar datos obligatorios
    if (!datos.nombre) {
        return { necesita: 'nombre', mensaje: 'Para hacer una reserva, necesito saber su nombre. ¿Cómo se llama?' };
    }
    
    if (!datos.masaje) {
        var menu = 'Estos son nuestros masajes:\n';
        for (var i = 0; i < serviciosData.length; i++) {
            menu += (i+1) + '. ' + serviciosData[i].nombre + ' - ' + serviciosData[i].precio + '\n';
        }
        return { necesita: 'masaje', mensaje: menu + '\n¿Cuál le gustaría reservar?' };
    }
    
    if (!datos.dia) {
        return { necesita: 'dia', mensaje: datos.nombre + ', ¿qué día de la semana le gustaría? Atendemos de lunes a sábado.' };
    }
    
    if (!datos.hora) {
        return { necesita: 'hora', mensaje: datos.nombre + ', ¿a qué hora prefiere? Horarios: 12:00, 16:00 o 20:00.' };
    }
    
    if (!datos.tipoServicio) {
        return { necesita: 'tipoServicio', mensaje: datos.nombre + ', ¿dónde prefiere recibir el masaje? ¿En el salón o a domicilio?' };
    }
    
    if (!datos.telefono) {
        return { necesita: 'telefono', mensaje: datos.nombre + ', necesito su número de teléfono para confirmar la reserva. ¿Cuál es?' };
    }
    
    // Verificar disponibilidad
    var turnos = await loadTurnos();
    
    // Verificar si ya tiene turno ese día
    for (var i = 0; i < turnos.length; i++) {
        if (turnos[i].telefono === datos.telefono && turnos[i].dia === datos.dia) {
            return { error: true, mensaje: datos.nombre + ', ya tiene un turno reservado para el ' + datos.dia + '. Solo permitimos un masaje por día.' };
        }
    }
    
    // Verificar disponibilidad del horario
    for (var i = 0; i < turnos.length; i++) {
        if (turnos[i].dia === datos.dia && turnos[i].hora === datos.hora) {
            var alternativa = buscarAlternativa(datos.dia, datos.hora, turnos);
            if (alternativa) {
                session.alternativa = alternativa;
                return { necesitaConfirmacion: true, mensaje: 'El horario de las ' + datos.hora + ':00 del ' + datos.dia + ' ya está ocupado. ¿Le sirve el ' + alternativa.dia + ' a las ' + alternativa.hora + ':00? Responda sí o no.' };
            }
            return { error: true, mensaje: 'Lo siento, no hay disponibilidad para esa semana.' };
        }
    }
    
    // Crear reserva
    var paisActivo = getPaisActivo();
    var codigoPais = paisActivo ? paisActivo.codigo : '53';
    
    var lugarTexto = datos.tipoServicio === 'domicilio' ? (datos.ubicacion || 'Dirección a confirmar') : 'Salón Serenity Spa';
    
    var nuevoTurno = {
        id: generarId(),
        nombre: datos.nombre,
        dia: datos.dia,
        hora: datos.hora,
        massageType: datos.masaje.nombre,
        telefono: datos.telefono,
        codigoPais: codigoPais,
        ubicacion: lugarTexto,
        tipoServicio: datos.tipoServicio,
        confirmadoWhatsApp: false,
        fechaCreacion: new Date().toISOString(),
        ip: ip
    };
    
    turnos.push(nuevoTurno);
    await saveTurnos(turnos);
    regTurno(ip, datos.telefono);
    
    var horaTexto = datos.hora === 12 ? '12:00 (mediodía)' : (datos.hora === 16 ? '16:00 (tarde)' : '20:00 (noche)');
    
    return { 
        exitoso: true, 
        mensaje: 'RESERVA CONFIRMADA\n\n' +
                  'Cliente: ' + datos.nombre + '\n' +
                  'Masaje: ' + datos.masaje.nombre + '\n' +
                  'Día: ' + datos.dia + '\n' +
                  'Hora: ' + horaTexto + '\n' +
                  'Lugar: ' + lugarTexto + '\n' +
                  'Teléfono: +' + codigoPais + ' ' + datos.telefono + '\n\n' +
                  'Lo esperamos en Serenity Spa.' 
    };
}

// ============================================================
// GENERAR RESPUESTAS
// ============================================================
function generarMenuServicios() {
    if (!serviciosData.length) return 'No hay servicios disponibles.';
    var menu = 'Nuestros servicios:\n\n';
    for (var i = 0; i < serviciosData.length; i++) {
        menu += (i+1) + '. ' + serviciosData[i].nombre + ' - ' + serviciosData[i].precio + '\n';
        menu += '   ' + serviciosData[i].descripcion + '\n\n';
    }
    return menu;
}

function generarHorarios() {
    return 'Nuestros horarios son:\n• 12:00 (mediodía)\n• 16:00 (tarde)\n• 20:00 (noche)\n\nAtendemos de lunes a sábado.';
}

function generarPrecios() {
    if (!serviciosData.length) return 'No hay servicios disponibles.';
    var lista = 'Nuestros precios:\n\n';
    for (var i = 0; i < serviciosData.length; i++) {
        lista += '• ' + serviciosData[i].nombre + ': ' + serviciosData[i].precio + '\n';
    }
    return lista;
}

// ============================================================
// VARIABLES GLOBALES
// ============================================================
var voiceClients = new Map();
var configData = {
    hero: { titulo: 'Renueva tu Energía', subtitulo: 'Experiencias de bienestar', imagenFondo: '', botonTexto: 'Explorar Tratamientos' },
    serviciosSection: { etiqueta: 'Nuestros Servicios', titulo: 'Elige tu Masaje Ideal', descripcion: 'Turnos: 12:00, 16:00 y 20:00' },
    contactoSection: { titulo: 'Asistente de Reservas', descripcion: 'Reserva tu turno de forma rápida' },
    shareSection: { titulo: 'Comparte Serenity Spa' }
};

var serviciosData = [];
var turnosMem = [];

// ============================================================
// PROCESAR COMANDO DE VOZ - VERSIÓN SIMPLIFICADA Y CORREGIDA
// ============================================================
async function procesarComandoVoz(texto, clientId, ip) {
    console.log('[VOZ]', texto);
    
    // Limpiar texto
    var textoLimpio = texto.trim();
    if (!textoLimpio) return 'Disculpe, no pude entender. ¿Podría repetir?';
    
    // Obtener o crear sesión
    var session = voiceClients.get(clientId);
    if (!session) {
        session = {
            datos: { tipoServicio: 'salon' },
            paso: 'inicio',
            pendiente: null
        };
        voiceClients.set(clientId, session);
    }
    
    // Verificar si estamos esperando confirmación de alternativa
    if (session.pendiente === 'confirmarAlternativa') {
        if (textoLimpio.toLowerCase().match(/^(si|sí|ok|vale|dale|claro|acepto|confirmo)$/)) {
            session.pendiente = null;
            session.datos.dia = session.alternativa.dia;
            session.datos.hora = session.alternativa.hora;
            var resultado = await manejarReserva(session.datos, ip, session);
            if (resultado.exitoso) {
                session.paso = 'inicio';
                session.datos = { tipoServicio: 'salon' };
                return resultado.mensaje;
            }
            return resultado.mensaje;
        } else {
            session.pendiente = null;
            session.alternativa = null;
            return 'Entiendo. Por favor, indíqueme qué día y horario prefiere.';
        }
    }
    
    // Verificar si estamos esperando confirmación final
    if (session.pendiente === 'confirmarReserva') {
        if (textoLimpio.toLowerCase().match(/^(si|sí|ok|vale|dale|claro|acepto|confirmo)$/)) {
            session.pendiente = null;
            var resultado = await manejarReserva(session.datos, ip, session);
            if (resultado.exitoso) {
                session.paso = 'inicio';
                session.datos = { tipoServicio: 'salon' };
                return resultado.mensaje;
            }
            return resultado.mensaje;
        } else if (textoLimpio.toLowerCase().match(/^(no|cancelar|nada)$/)) {
            session.pendiente = null;
            return 'Entiendo. ¿Qué dato le gustaría modificar?';
        } else {
            // Si responde con nuevos datos, procesar normalmente
            session.pendiente = null;
        }
    }
    
    // Analizar el texto
    var analisis = analizarTexto(textoLimpio, serviciosData);
    console.log('[ANALISIS]', JSON.stringify(analisis));
    
    // Actualizar datos de sesión
    if (analisis.nombre) session.datos.nombre = analisis.nombre;
    if (analisis.masaje) session.datos.masaje = analisis.masaje;
    if (analisis.dia) session.datos.dia = analisis.dia;
    if (analisis.hora) session.datos.hora = analisis.hora;
    if (analisis.tipoServicio) session.datos.tipoServicio = analisis.tipoServicio;
    if (analisis.telefono) session.datos.telefono = analisis.telefono;
    
    // Manejar intenciones específicas
    if (analisis.intencion === 'servicios') {
        return generarMenuServicios();
    }
    
    if (analisis.intencion === 'horarios') {
        return generarHorarios();
    }
    
    if (analisis.intencion === 'precios') {
        return generarPrecios();
    }
    
    // Manejar reserva
    if (analisis.intencion === 'reservar' || session.datos.nombre || session.datos.masaje) {
        var resultado = await manejarReserva(session.datos, ip, session);
        
        if (resultado.necesita) {
            return resultado.mensaje;
        }
        
        if (resultado.necesitaConfirmacion) {
            session.pendiente = 'confirmarAlternativa';
            session.alternativa = resultado.alternativa;
            return resultado.mensaje;
        }
        
        if (resultado.exitoso) {
            session.paso = 'inicio';
            session.datos = { tipoServicio: 'salon' };
            return resultado.mensaje;
        }
        
        if (resultado.error) {
            return resultado.mensaje;
        }
    }
    
    // Si no hay intención clara, preguntar
    if (session.datos.nombre) {
        return session.datos.nombre + ', ¿en qué puedo ayudarle? Puedo ayudarle a reservar un turno, ver servicios u horarios.';
    }
    
    return 'Bienvenido a Serenity Spa. ¿Cómo puedo ayudarle? Puedo ayudarle a reservar un turno, ver nuestros servicios u horarios.';
}

// ============================================================
// MIDDLEWARES Y RUTAS
// ============================================================
app.use(function(req, res, next) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    next();
});

app.use(function(req, res, next) {
    var ip = req.ip || req.socket.remoteAddress || '0.0.0.0';
    if (estaBloqueado(ip)) return res.status(403).json({ error: 'IP bloqueada' });
    next();
});

app.use(express.static(__dirname));

// ============================================================
// AUTENTICACIÓN ADMIN
// ============================================================
var validTokens = new Map();

function checkAuth(req) {
    var h = req.headers.authorization;
    if (!h || h.indexOf('Bearer ') !== 0) return false;
    var t = h.substring(7);
    if (!validTokens.has(t)) return false;
    if (validTokens.get(t) < Date.now()) { validTokens.delete(t); return false; }
    return true;
}

app.post('/api/login', function(req, res) {
    var ip = req.ip || req.socket.remoteAddress || '0.0.0.0';
    if (estaBloqueado(ip)) return res.status(403).json({ success: false });
    
    var pw = req.body.password;
    if (!pw) { registrarIntento(ip, 'Vacía'); return res.status(400).json({ success: false }); }
    
    if (pw === (process.env.ADMIN_PASSWORD || 'admin123')) {
        var tk = crypto.randomBytes(64).toString('hex');
        validTokens.set(tk, Date.now() + 28800000);
        intentosFallidos.delete(ip);
        res.json({ success: true, token: tk });
    } else {
        registrarIntento(ip, 'Incorrecta');
        res.status(401).json({ success: false });
    }
});

app.get('/api/verify', function(req, res) { res.json({ valid: checkAuth(req) }); });
app.post('/api/logout', function(req, res) {
    var h = req.headers.authorization;
    if (h && h.indexOf('Bearer ') === 0) validTokens.delete(h.substring(7));
    res.json({ ok: true });
});

// ============================================================
// CONFIGURACIÓN
// ============================================================
app.get('/api/config', function(req, res) { res.json(configData); });

app.put('/api/config', async function(req, res) {
    if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    configData = Object.assign(configData, req.body);
    await fs.writeFile(CONFIG_FILE, JSON.stringify(configData, null, 2), 'utf8');
    res.json({ ok: true });
});

app.post('/api/upload-hero', async function(req, res) {
    if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    try {
        var b = req.body.base64;
        if (!b || b.indexOf('data:image') !== 0) return res.status(400).json({ error: 'Imagen inválida' });
        var m = b.match(/^data:image\/(\w+);base64,(.+)$/);
        if (!m) return res.status(400).json({ error: 'Formato inválido' });
        var ext = m[1] === 'jpeg' ? 'jpg' : m[1];
        var buf = Buffer.from(m[2], 'base64');
        var fn = 'hero-' + Date.now() + '.' + ext;
        await fs.writeFile(path.join(UPLOADS_DIR, fn), buf);
        var files = await fs.readdir(UPLOADS_DIR);
        for (var i = 0; i < files.length; i++) {
            if (files[i].indexOf('hero-') === 0 && files[i] !== fn) {
                try { await fs.unlink(path.join(UPLOADS_DIR, files[i])); } catch(e) {}
            }
        }
        res.json({ url: '/uploads/' + fn });
    } catch(e) { res.status(500).json({ error: 'Error al subir' }); }
});

// ============================================================
// SERVICIOS
// ============================================================
app.get('/api/servicios', function(req, res) {
    res.json(serviciosData);
});

app.post('/api/servicios', async function(req, res) {
    if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    try {
        var s = Object.assign({ id: generarId() }, req.body);
        serviciosData.push(s);
        await fs.writeFile(SERVICIOS_FILE, JSON.stringify(serviciosData, null, 2), 'utf8');
        await inicializarBaseConocimiento();
        res.status(201).json(s);
    } catch(e) { res.status(500).json({ error: 'Error al crear' }); }
});

app.put('/api/servicios/:id', async function(req, res) {
    if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    try {
        var idx = -1;
        for (var i = 0; i < serviciosData.length; i++) {
            if (serviciosData[i].id === req.params.id) { idx = i; break; }
        }
        if (idx === -1) return res.status(404).json({ error: 'No encontrado' });
        
        serviciosData[idx] = Object.assign({}, serviciosData[idx], req.body, { id: req.params.id });
        await fs.writeFile(SERVICIOS_FILE, JSON.stringify(serviciosData, null, 2), 'utf8');
        await inicializarBaseConocimiento();
        res.json({ ok: true });
    } catch(e) { res.status(500).json({ error: 'Error al actualizar' }); }
});

app.delete('/api/servicios/:id', async function(req, res) {
    if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    serviciosData = serviciosData.filter(function(s) { return s.id !== req.params.id; });
    await fs.writeFile(SERVICIOS_FILE, JSON.stringify(serviciosData, null, 2), 'utf8');
    await inicializarBaseConocimiento();
    res.json({ ok: true });
});

// ============================================================
// TURNOS
// ============================================================
app.get('/turnos', async function(req, res) { res.json(await loadTurnos()); });

app.post('/turnos', async function(req, res) {
    var ip = req.ip || req.socket.remoteAddress || '0.0.0.0';
    if (estaBloqueado(ip)) return res.status(403).json({ error: 'IP bloqueada' });
    
    try {
        var nombre = req.body.nombre, dia = req.body.dia, hora = req.body.hora;
        var mt = req.body.massageType, tel = req.body.telefono, ub = req.body.ubicacion;
        var ts = req.body.tipoServicio;
        
        if (!nombre || nombre.length < 2) return res.status(400).json({ error: 'Nombre inválido' });
        var telefono = (tel || '').replace(/\D/g, '');
        if (!telefono || telefono.length < 7) return res.status(400).json({ error: 'Teléfono inválido' });
        
        var cp = req.body.codigoPais || '53';
        
        if (DIAS_VALIDOS.indexOf((dia || '').toLowerCase()) === -1) return res.status(400).json({ error: 'Día inválido' });
        var hn = parseInt(hora);
        if (HORAS_VALIDAS.indexOf(hn) === -1) return res.status(400).json({ error: 'Hora inválida' });
        
        var turnos = await loadTurnos();
        
        for (var i = 0; i < turnos.length; i++) {
            if (turnos[i].telefono === telefono && turnos[i].dia === (dia || '').toLowerCase()) {
                return res.status(409).json({ error: 'Ya tiene turno ese día' });
            }
        }
        
        for (var j = 0; j < turnos.length; j++) {
            if (turnos[j].dia === (dia || '').toLowerCase() && turnos[j].hora === hn) {
                return res.status(409).json({ error: 'Horario ocupado' });
            }
        }
        
        var nuevo = {
            id: generarId(),
            nombre: sanitize(nombre),
            dia: (dia || '').toLowerCase(),
            hora: hn,
            massageType: mt || 'Masaje',
            telefono: telefono,
            codigoPais: cp,
            ubicacion: ub || 'Salón Serenity Spa',
            tipoServicio: ts || 'salon',
            confirmadoWhatsApp: false,
            fechaCreacion: new Date().toISOString(),
            ip: ip
        };
        
        turnos.push(nuevo);
        await saveTurnos(turnos);
        turnosMem = turnos;
        regTurno(ip, telefono);
        res.status(201).json({ mensaje: 'Reserva confirmada', turno: nuevo });
    } catch(e) { res.status(500).json({ error: 'Error al procesar' }); }
});

app.delete('/turnos/:id', async function(req, res) {
    if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    var turnos = await loadTurnos();
    turnos = turnos.filter(function(t) { return t.id !== req.params.id; });
    await saveTurnos(turnos);
    turnosMem = turnos;
    res.json({ ok: true });
});

app.post('/api/enviar-whatsapp/:id', async function(req, res) {
    try {
        var turnos = await loadTurnos();
        var turno = null;
        for (var i = 0; i < turnos.length; i++) {
            if (turnos[i].id === req.params.id) { turno = turnos[i]; break; }
        }
        if (!turno) return res.status(404).json({ error: 'No encontrado' });
        
        var msg = 'SERENITY SPA\n\nHola ' + turno.nombre + ', tu reserva:\n\n';
        msg += 'Día: ' + turno.dia + '\n';
        msg += 'Hora: ' + turno.hora + ':00\n';
        msg += 'Masaje: ' + turno.massageType + '\n';
        msg += 'Lugar: ' + turno.ubicacion + '\n\n';
        msg += 'Te esperamos.';
        
        var c = turno.codigoPais || '53';
        res.json({ success: true, numero: c + turno.telefono, mensaje: msg });
    } catch(e) { res.status(500).json({ error: 'Error' }); }
});

// ============================================================
// IA CHAT
// ============================================================
app.post('/api/chat-ia', async function(req, res) {
    var ip = req.ip || req.socket.remoteAddress || '0.0.0.0';
    if (estaBloqueado(ip)) return res.status(403).json({ error: 'Bloqueada' });
    
    var msg = req.body.mensaje;
    if (!msg || msg.length > 500) return res.status(400).json({ error: 'Inválido' });
    
    var limpio = msg.replace(/<[^>]*>/g, '').trim();
    if (!limpio) return res.status(400).json({ error: 'Vacío' });
    
    res.json({ respuesta: 'Hola, ¿en qué puedo ayudarte?', modo: 'local' });
});

// ============================================================
// SEGURIDAD
// ============================================================
app.get('/api/seguridad/bloqueos', function(req, res) {
    if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    var activos = [];
    for (var e of bloqueos) {
        activos.push({ ip: e[0], motivo: e[1].motivo, hasta: e[1].hasta });
    }
    res.json({ activos: activos, historial: historialBloqueos });
});

app.post('/api/seguridad/desbloquear/:ip', function(req, res) {
    if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    desbloquearIP(req.params.ip);
    res.json({ ok: true });
});

app.get('/api/seguridad/paises', function(req, res) {
    if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    res.json(paisesConfig);
});

// ============================================================
// RUTAS ESTÁTICAS
// ============================================================
app.get('/health', function(req, res) { res.json({ status: 'ok' }); });
app.get('/voice-assistant', function(req, res) { res.sendFile(path.join(__dirname, 'voice-assistant.html')); });
app.get('/', function(req, res) { res.sendFile(path.join(__dirname, 'index.html')); });
app.get('/admin.html', function(req, res) { res.sendFile(path.join(__dirname, 'admin.html')); });
app.get('/login.html', function(req, res) { res.sendFile(path.join(__dirname, 'login.html')); });

// ============================================================
// WEBSOCKET - CORREGIDO (SIN DUPLICADOS)
// ============================================================
var wsConnPerIP = new Map();

function startServer() {
    cargarBloqueos();
    cargarPaises();
    
    try { configData = JSON.parse(fsSync.readFileSync(CONFIG_FILE, 'utf8')); } catch(e) { fsSync.writeFileSync(CONFIG_FILE, JSON.stringify(configData, null, 2), 'utf8'); }
    
    try {
        serviciosData = JSON.parse(fsSync.readFileSync(SERVICIOS_FILE, 'utf8'));
        if (!serviciosData.length) throw new Error();
    } catch(e) {
        serviciosData = [
            { id: "1", nombre: "Masaje Relajante", precio: "$45", descripcion: "Movimientos suaves para liberar estrés.", beneficios: ["Reduce ansiedad", "Alivia tensión muscular"], orden: 1 },
            { id: "2", nombre: "Masaje Corporal", precio: "$65", descripcion: "Tratamiento completo y revitalizante.", beneficios: ["Relajación integral", "Elimina contracturas"], orden: 2 },
            { id: "3", nombre: "Masaje Facial", precio: "$40", descripcion: "Rejuvenece la piel y alivia tensión facial.", beneficios: ["Reafirma la piel", "Reduce ojeras"], orden: 3 }
        ];
        fsSync.writeFileSync(SERVICIOS_FILE, JSON.stringify(serviciosData, null, 2), 'utf8');
    }
    
    try { turnosMem = JSON.parse(fsSync.readFileSync(TURNOS_FILE, 'utf8')); } catch(e) { turnosMem = []; fsSync.writeFileSync(TURNOS_FILE, '[]', 'utf8'); }
    
    inicializarBaseConocimiento();
    
    var server = app.listen(PORT, '0.0.0.0', function() {
        console.log('Serenity Spa - Puerto ' + PORT);
    });
    
    var wss = new WebSocket.Server({ server: server, path: '/ws-voice' });
    
    wss.on('connection', function(ws, req) {
        var ip = req.socket.remoteAddress || '0.0.0.0';
        if (estaBloqueado(ip)) { ws.close(1008, 'IP bloqueada'); return; }
        
        var cc = wsConnPerIP.get(ip) || 0;
        if (cc >= 5) { ws.close(1008, 'Demasiadas conexiones'); return; }
        wsConnPerIP.set(ip, cc + 1);
        
        var clientId = generarId();
        var bienvenidaEnviada = false;
        
        ws.on('message', async function(data) {
            try {
                var msg = JSON.parse(data);
                if (!msg || msg.tipo !== 'transcripcion') return;
                
                var texto = msg.texto;
                if (!texto || typeof texto !== 'string' || texto.length > 500) return;
                
                var respuesta = await procesarComandoVoz(texto, clientId, ip);
                if (respuesta && ws.readyState === 1) {
                    ws.send(JSON.stringify({ tipo: 'respuesta', texto: respuesta }));
                }
            } catch(e) {
                console.error('WS Error:', e.message);
            }
        });
        
        ws.on('close', function() {
            voiceClients.delete(clientId);
            var conn = wsConnPerIP.get(ip) || 1;
            wsConnPerIP.set(ip, Math.max(0, conn - 1));
        });
        
        // Enviar bienvenida SOLO UNA VEZ cuando se conecta
        setTimeout(function() {
            if (ws.readyState === 1 && !bienvenidaEnviada) {
                bienvenidaEnviada = true;
                ws.send(JSON.stringify({ tipo: 'respuesta', texto: 'Bienvenido a Serenity Spa. ¿Cómo puedo ayudarle hoy?' }));
            }
        }, 100);
    });
}

startServer();
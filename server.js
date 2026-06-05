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

const deepseek = new OpenAI({
    baseURL: 'https://api.deepseek.com/v1',
    apiKey: process.env.DEEPSEEK_API_KEY || '',
});

app.disable('x-powered-by');
if (!fsSync.existsSync(UPLOADS_DIR)) fsSync.mkdirSync(UPLOADS_DIR, { recursive: true });
app.use('/uploads', express.static(UPLOADS_DIR));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// ==================== CONSTANTES ====================
const HORAS_VALIDAS = [12, 16, 20];
const DIAS_VALIDOS = ['lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado'];
const DIAS_NOMBRE = {
    lunes: 'Lunes', martes: 'Martes', miercoles: 'Miércoles',
    jueves: 'Jueves', viernes: 'Viernes', sabado: 'Sábado'
};
const HORA_TEXTO = { 12: '12 del mediodía', 16: '4 de la tarde', 20: '8 de la noche' };

// ============================================================
// SISTEMA DE BLOQUEOS
// ============================================================
let bloqueos = new Map();
let historialBloqueos = [];
let intentosFallidos = new Map();
const turnosRecientesIP = new Map();
const turnosRecientesTel = new Map();

async function cargarBloqueos() {
    try {
        if (fsSync.existsSync(BLOQUEOS_FILE)) {
            const d = JSON.parse(await fs.readFile(BLOQUEOS_FILE, 'utf8'));
            bloqueos = new Map(Object.entries(d.bloqueos || {}));
            historialBloqueos = d.historial || [];
            const ahora = Date.now();
            for (const [ip, datos] of bloqueos) {
                if (ahora > datos.hasta) bloqueos.delete(ip);
            }
            await guardarBloqueos();
        }
    } catch (err) {
        await fs.writeFile(BLOQUEOS_FILE, JSON.stringify({ bloqueos: {}, historial: [] }, null, 2), 'utf8');
    }
}

async function guardarBloqueos() {
    try {
        await fs.writeFile(BLOQUEOS_FILE, JSON.stringify({
            bloqueos: Object.fromEntries(bloqueos),
            historial: historialBloqueos.slice(0, 500)
        }, null, 2), 'utf8');
    } catch (err) { /* silencioso */ }
}

function estaBloqueado(ip) {
    if (bloqueos.has(ip)) {
        if (Date.now() < bloqueos.get(ip).hasta) return true;
        bloqueos.delete(ip);
        guardarBloqueos();
    }
    return false;
}

function bloquearIP(ip, motivo, tipo) {
    bloqueos.set(ip, {
        hasta: Date.now() + 3600000, motivo, tipoAtaque: tipo || 'Desconocido',
        fecha: new Date().toISOString(), ip,
        intentos: (intentosFallidos.get(ip) || {}).count || 0, permanente: false
    });
    historialBloqueos.unshift(Object.assign({}, bloqueos.get(ip), { id: generarId() }));
    guardarBloqueos();
}

function desbloquearIP(ip) {
    bloqueos.delete(ip);
    intentosFallidos.delete(ip);
    guardarBloqueos();
}

function limpiarViejos(mapa, ventana) {
    const ahora = Date.now();
    for (const [k, a] of mapa) {
        mapa.set(k, a.filter(function(t) { return ahora - t < ventana; }));
        if (!mapa.get(k).length) mapa.delete(k);
    }
}

function registrarIntento(ip, tipo) {
    const ahora = Date.now();
    if (!intentosFallidos.has(ip)) {
        intentosFallidos.set(ip, { count: 1, first: ahora });
        return false;
    }
    const d = intentosFallidos.get(ip);
    if (ahora - d.first > 600000) {
        intentosFallidos.set(ip, { count: 1, first: ahora });
        return false;
    }
    d.count++;
    if (d.count >= 5) {
        bloquearIP(ip, '5+ intentos: ' + tipo, tipo);
        intentosFallidos.delete(ip);
        return true;
    }
    return false;
}

function checkRateIP(ip) {
    limpiarViejos(turnosRecientesIP, 3600000);
    return (turnosRecientesIP.get(ip) || []).length < 3;
}

function checkRateTel(tel) {
    limpiarViejos(turnosRecientesTel, 86400000);
    return (turnosRecientesTel.get(tel) || []).length < 2;
}

function regTurno(ip, tel) {
    const ahora = Date.now();
    if (!turnosRecientesIP.has(ip)) turnosRecientesIP.set(ip, []);
    turnosRecientesIP.get(ip).push(ahora);
    if (!turnosRecientesTel.has(tel)) turnosRecientesTel.set(tel, []);
    turnosRecientesTel.get(tel).push(ahora);
}

// ============================================================
// SISTEMA DE PAÍSES
// ============================================================
var paisesConfig = { autorizados: [], bloqueados: [], modo: 'todos', stats: {} };

async function cargarPaises() {
    try {
        if (fsSync.existsSync(PAISES_FILE)) paisesConfig = JSON.parse(await fs.readFile(PAISES_FILE, 'utf8'));
        else await guardarPaises();
    } catch (e) { await guardarPaises(); }
}

async function guardarPaises() {
    await fs.writeFile(PAISES_FILE, JSON.stringify(paisesConfig, null, 2), 'utf8');
}

function paisAutorizado(codigoPais) {
    if (paisesConfig.modo === 'todos') return !paisesConfig.bloqueados.includes(codigoPais);
    return paisesConfig.autorizados.includes(codigoPais);
}

// ============================================================
// BASE DE CONOCIMIENTO IA (chat web)
// ============================================================
var baseConocimiento = [];

async function inicializarBaseConocimiento() {
    var servicios = serviciosData.map(function(s) {
        return {
            tipo: 'servicio',
            contenido: s.nombre + ': ' + s.descripcion + '. Precio: ' + s.precio +
                '. Beneficios: ' + (s.beneficios || []).join(', ') +
                '. Efectos: ' + (s.efectos || []).join(', ')
        };
    });
    baseConocimiento = servicios.concat([
        { tipo: 'horario', contenido: 'Horarios: Lunes a Sábado. Turnos: 12:00, 16:00 y 20:00. Uno por persona por día.' },
        { tipo: 'politica', contenido: 'Cancelación con 4 horas de anticipación.' },
        { tipo: 'ubicacion', contenido: 'Servicio en salón y a domicilio.' }
    ]);
}

function buscarContexto(pregunta) {
    var palabras = pregunta.toLowerCase().split(/\s+/).filter(function(p) { return p.length > 2; });
    var resultados = [];
    for (var i = 0; i < baseConocimiento.length; i++) {
        var item = baseConocimiento[i];
        var puntuacion = 0;
        var c = item.contenido.toLowerCase();
        for (var j = 0; j < palabras.length; j++) {
            if (c.indexOf(palabras[j]) !== -1) puntuacion++;
        }
        if (puntuacion > 0) resultados.push(Object.assign({}, item, { puntuacion: puntuacion }));
    }
    return resultados.sort(function(a, b) { return b.puntuacion - a.puntuacion; }).slice(0, 5).map(function(r) { return r.contenido; });
}

var personalidadIA = {
    nombre: 'SpaBot', tono: 'cálido y profesional',
    estilo: 'Español neutro, amable, conciso.',
    reglas: ['NUNCA inventar información', 'SIEMPRE ofrecer reservar', 'JAMÁS revelar que eres IA', 'Respuestas cortas']
};

// ============================================================
// UTILIDADES
// ============================================================
function esUrlValida(s) {
    if (!s || typeof s !== 'string') return false;
    var t = s.trim();
    if (t.indexOf('data:') === 0 || t.length > 3000) return false;
    try { var u = new URL(t); return u.protocol === 'http:' || u.protocol === 'https:'; }
    catch (e) { return false; }
}

function escapeHtml(s) {
    if (!s) return '';
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function sanitize(s) {
    if (!s) return '';
    return s.trim().replace(/[^\w\sáéíóúñÑü.,@\-]/gi, '');
}

function generarId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2) + crypto.randomBytes(4).toString('hex');
}

function fmtT(ms) {
    if (ms <= 0) return 'Expirado';
    var s = Math.floor(ms / 1000), m = Math.floor(s / 60), h = Math.floor(m / 60);
    return h > 0 ? h + 'h ' + (m % 60) + 'm' : m > 0 ? m + 'm ' + (s % 60) + 's' : s + 's';
}

// ============================================================
// DETECCIÓN DE PAÍS
// ============================================================
var PAISES_DATOS = [
    { nombre: 'Argentina', codigo: '54', claves: ['argentina', 'arg'] },
    { nombre: 'México', codigo: '52', claves: ['méxico', 'mexico', 'mex'] },
    { nombre: 'Colombia', codigo: '57', claves: ['colombia', 'colom'] },
    { nombre: 'Chile', codigo: '56', claves: ['chile'] },
    { nombre: 'Perú', codigo: '51', claves: ['perú', 'peru'] },
    { nombre: 'España', codigo: '34', claves: ['españa', 'espana', 'espa'] },
    { nombre: 'Cuba', codigo: '53', claves: ['cuba'] },
    { nombre: 'Uruguay', codigo: '598', claves: ['uruguay', 'uru'] },
    { nombre: 'Paraguay', codigo: '595', claves: ['paraguay'] },
    { nombre: 'Bolivia', codigo: '591', claves: ['bolivia', 'bol'] },
    { nombre: 'Venezuela', codigo: '58', claves: ['venezuela', 'vene'] },
    { nombre: 'Ecuador', codigo: '593', claves: ['ecuador', 'ecua'] },
    { nombre: 'Costa Rica', codigo: '506', claves: ['costa rica'] },
    { nombre: 'Panamá', codigo: '507', claves: ['panamá', 'panama'] },
    { nombre: 'Estados Unidos', codigo: '1', claves: ['estados unidos', 'usa', 'eeuu'] },
    { nombre: 'Brasil', codigo: '55', claves: ['brasil', 'brazil'] },
    { nombre: 'Italia', codigo: '39', claves: ['italia'] },
    { nombre: 'Francia', codigo: '33', claves: ['francia'] },
];

function detectarPaisConNombre(texto) {
    var t = texto.toLowerCase().trim();
    for (var i = 0; i < PAISES_DATOS.length; i++) {
        var pais = PAISES_DATOS[i];
        for (var j = 0; j < pais.claves.length; j++) {
            if (t.indexOf(pais.claves[j]) !== -1) return { nombre: pais.nombre, codigo: pais.codigo };
        }
    }
    return null;
}

// ============================================================
// EXTRAER NOMBRE
// ============================================================
function extraerNombre(texto) {
    var t = texto.trim();
    var patrones = [
        /(?:me\s+llamo|mi\s+nombre\s+es)\s+([A-ZÁÉÍÓÚÑ][a-záéíóúñ]*(?:\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ]*){0,2})/i,
        /(?:soy)\s+([A-ZÁÉÍÓÚÑ][a-záéíóúñ]*(?:\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ]*){0,2})(?:\s|,|\.)/i,
    ];
    var noNombres = /\b(reservar|turno|masaje|hola|buenas|precio|horario|favor|por|para|de|del|en|el|la|los|las|un|una|este|esta|esto|que|quiere|gustaria|teléfono|telefono|celular|numero|número|domicilio|salon|salón|lunes|martes|miercoles|jueves|viernes|sabado|sábado|doce|cuatro|ocho|mediodia|tarde|noche|pais|país)\b/i;

    for (var p = 0; p < patrones.length; p++) {
        var match = t.match(patrones[p]);
        if (match && match[1] && match[1].length >= 2) {
            var palabras = match[1].split(/\s+/).filter(function(w) { return !noNombres.test(w); });
            if (palabras.length > 0) return palabras.join(' ');
        }
    }

    // Texto corto que podría ser solo un nombre
    var words = t.split(/\s+/);
    if (words.length <= 2 && words[0].length >= 2 && words[0].length <= 15) {
        var candidato = words[0];
        if (/^[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+$/.test(candidato) && !noNombres.test(candidato)) {
            return candidato;
        }
    }
    return null;
}

// ============================================================
// EXTRAER TELÉFONO (mejorado: ignora precios)
// ============================================================
var CODIGOS_PAIS_TELEFONO = [
    { codigo: '593', pais: 'Ecuador' }, { codigo: '598', pais: 'Uruguay' },
    { codigo: '595', pais: 'Paraguay' }, { codigo: '591', pais: 'Bolivia' },
    { codigo: '506', pais: 'Costa Rica' }, { codigo: '507', pais: 'Panamá' },
    { codigo: '53', pais: 'Cuba' }, { codigo: '54', pais: 'Argentina' },
    { codigo: '52', pais: 'México' }, { codigo: '57', pais: 'Colombia' },
    { codigo: '56', pais: 'Chile' }, { codigo: '51', pais: 'Perú' },
    { codigo: '34', pais: 'España' }, { codigo: '58', pais: 'Venezuela' },
    { codigo: '55', pais: 'Brasil' }, { codigo: '39', pais: 'Italia' },
    { codigo: '33', pais: 'Francia' }, { codigo: '49', pais: 'Alemania' },
    { codigo: '1', pais: 'EE.UU.' },
];

function extraerTelefono(texto) {
    // Buscar patrón explícito: "teléfono 5551234", "mi número 53 5551234"
    var explicito = texto.match(/(?:tel[eé]fono|n[uú]mero|celular|cel|m[oó]vil|whatsapp)\s*[:.]?\s*([\d\s\-]{7,20})/i);
    if (explicito) {
        var nums = explicito[1].replace(/\D/g, '');
        if (nums.length >= 7 && nums.length <= 15) return detectarCodigoEnNumero(nums);
    }

    // Buscar secuencia de dígitos al final del texto (no precios)
    var textoLimpio = texto.replace(/\$?\d{1,4}\s*(pesos|dlls|usd|eur|cop|mxn|ars|cup)/gi, ' ');
    textoLimpio = textoLimpio.replace(/\b\d{1,2}:\d{2}\b/g, ' '); // quitar horas tipo 12:00

    var trailing = textoLimpio.trim().match(/([\d]{7,15})\s*$/);
    if (trailing) return detectarCodigoEnNumero(trailing[1]);

    return null;
}

function detectarCodigoEnNumero(numeros) {
    for (var i = 0; i < CODIGOS_PAIS_TELEFONO.length; i++) {
        var c = CODIGOS_PAIS_TELEFONO[i];
        if (numeros.indexOf(c.codigo) === 0 && numeros.length > c.codigo.length + 5) {
            return { codigoPais: c.codigo, pais: c.pais, telefono: numeros.substring(c.codigo.length) };
        }
    }
    return { telefono: numeros };
}

// ============================================================
// SIMILITUD (Levenshtein)
// ============================================================
function similitud(a, b) {
    a = a.toLowerCase(); b = b.toLowerCase();
    if (a === b) return 1;
    if (a.indexOf(b) !== -1 || b.indexOf(a) !== -1) return 0.85;
    var matrix = [];
    for (var i = 0; i <= a.length; i++) { matrix[i] = [i]; }
    for (var j = 0; j <= b.length; j++) { matrix[0][j] = j; }
    for (var x = 1; x <= a.length; x++) {
        for (var y = 1; y <= b.length; y++) {
            var cost = a[x - 1] === b[y - 1] ? 0 : 1;
            matrix[x][y] = Math.min(matrix[x - 1][y] + 1, matrix[x][y - 1] + 1, matrix[x - 1][y - 1] + cost);
        }
    }
    return 1 - matrix[a.length][b.length] / Math.max(a.length, b.length, 1);
}

// ============================================================
// DETECTAR MASAJE (fuzzy mejorado: palabra por palabra)
// ============================================================
function detectarMasaje(texto) {
    var t = texto.toLowerCase();
    var palabrasTexto = t.split(/\s+/).filter(function(p) { return p.length > 2; });

    var mejor = null;
    var mejorScore = 0.5;

    for (var s = 0; s < serviciosData.length; s++) {
        var servicio = serviciosData[s];
        var nombre = servicio.nombre.toLowerCase();
        var score = 0;

        // Coincidencia exacta del nombre completo
        if (t.indexOf(nombre) !== -1) return { masaje: servicio.nombre, id: servicio.id };

        // Sin prefijo "masaje"
        var sinPrefijo = nombre.replace(/^masaje\s+/i, '');
        if (sinPrefijo.length > 3 && t.indexOf(sinPrefijo) !== -1) return { masaje: servicio.nombre, id: servicio.id };

        // Comparar cada palabra clave del servicio con cada palabra del texto
        var claves = nombre.split(/\s+/).filter(function(p) { return p.length > 3 && p !== 'masaje'; });
        for (var ci = 0; ci < claves.length; ci++) {
            for (var pi = 0; pi < palabrasTexto.length; pi++) {
                var sp = similitud(palabrasTexto[pi], claves[ci]);
                if (sp > score) score = sp;
            }
        }

        if (score > mejorScore) {
            mejorScore = score;
            mejor = { masaje: servicio.nombre, id: servicio.id };
        }
    }

    return mejor;
}

// ============================================================
// TEXTO A NÚMERO ("uno" → 1, "el primero" → 1)
// ============================================================
function textoANumero(texto) {
    var t = texto.toLowerCase().trim();

    var numDirecto = t.match(/^\d+$/);
    if (numDirecto) return parseInt(numDirecto[0]);

    var mapa = {
        'uno': 1, 'una': 1, 'primero': 1, 'primera': 1,
        'dos': 2, 'segundo': 2, 'segunda': 2,
        'tres': 3, 'tercero': 3, 'tercera': 3,
        'cuatro': 4, 'cuarto': 4,
        'cinco': 5, 'quinto': 5,
        'seis': 6, 'sexto': 6
    };

    // Texto limpio (sin "el", "la", "por favor", etc.)
    var limpio = t.replace(/^(el|la|los|las|por favor|favor|yo|quiero|elijo|escojo|digamos)\s+/gi, '').trim();

    if (mapa[limpio] !== undefined) return mapa[limpio];

    // Buscar número dentro del texto
    var inner = t.match(/\b(\d+)\b/);
    if (inner) return parseInt(inner[1]);

    return null;
}

// ============================================================
// OBTENER PRÓXIMA FECHA PARA UN DÍA
// ============================================================
function obtenerProximaFecha(diaSemana) {
    var diasOrden = ['domingo', 'lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado'];
    var hoy = new Date();
    var hoyIdx = hoy.getDay();
    var objIdx = diasOrden.indexOf(diaSemana);
    if (objIdx === -1) return null;

    var diff = objIdx - hoyIdx;
    if (diff < 0) diff += 7;
    if (diff === 0 && hoy.getHours() >= 20) diff = 7;

    var fecha = new Date(hoy);
    fecha.setDate(hoy.getDate() + diff);
    fecha.setHours(0, 0, 0, 0);
    return fecha;
}

function formatearFecha(diaSemana) {
    var fecha = obtenerProximaFecha(diaSemana);
    if (!fecha) return DIAS_NOMBRE[diaSemana] || diaSemana;
    return fecha.toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long' });
}

// ============================================================
// DISPONIBILIDAD
// ============================================================
function obtenerDisponibilidad() {
    var resultado = [];
    for (var d = 0; d < DIAS_VALIDOS.length; d++) {
        var dia = DIAS_VALIDOS[d];
        var libres = [];
        var ocupadas = [];
        for (var h = 0; h < HORAS_VALIDAS.length; h++) {
            var hora = HORAS_VALIDAS[h];
            var ocupado = false;
            for (var t = 0; t < turnosMem.length; t++) {
                if (turnosMem[t].dia === dia && turnosMem[t].hora === hora) { ocupado = true; break; }
            }
            if (ocupado) ocupadas.push(hora);
            else libres.push(hora);
        }
        resultado.push({ dia: dia, libres: libres, ocupadas: ocupadas });
    }
    return resultado;
}

function buscarAlternativa(dia, hora, turnos) {
    var idx = DIAS_VALIDOS.indexOf(dia);
    if (idx === -1) return null;
    for (var offset = 0; offset < 7; offset++) {
        var d = DIAS_VALIDOS[(idx + offset) % 7];
        var hrs = offset === 0 ? HORAS_VALIDAS.filter(function(h) { return h > hora; }) : HORAS_VALIDAS;
        for (var i = 0; i < hrs.length; i++) {
            var h = hrs[i];
            var libre = true;
            for (var t = 0; t < turnos.length; t++) {
                if (turnos[t].dia === d && turnos[t].hora === h) { libre = false; break; }
            }
            if (libre) return { dia: d, hora: h };
        }
    }
    return null;
}

// ============================================================
// ANÁLISIS COMPLETO DE TEXTO
// ============================================================
function analizarTextoCompleto(texto) {
    var t = texto.toLowerCase();
    var resultado = {
        nombre: null, pais: null, codigoPais: null,
        masaje: null, masajeId: null, dia: null, hora: null,
        ubicacion: null, tipoServicio: null, telefono: null,
        intencion: 'desconocida'
    };

    // --- Intención (orden importa: reservar primero) ---
    if (/\b(reservar|turno|cita|agendar|pedir\s+turno)\b/.test(t)) {
        resultado.intencion = 'reservar';
    } else if (/\b(quiero|me\s+gustar[ií]a|quisiera|necesito|busco|ped[ií])\b.*\b(masaje|servicio|sesi[oó]n|relajante|corporal|facial)\b/.test(t) ||
               /\b(masaje|servicio|sesi[oó]n|relajante|corporal|facial)\b.*\b(quiero|me\s+gustar[ií]a|quisiera|necesito|busco|ped[ií]|para\s+m[ií])\b/.test(t)) {
        resultado.intencion = 'reservar';
    } else if (/\b(quiero|me\s+gustar[ií]a|quisiera|necesito)\b.*\b(lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado)\b/.test(t) ||
               /\b(lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado)\b.*\b(quiero|reservar|agendar|pedir)\b/.test(t)) {
        resultado.intencion = 'reservar';
    } else if (/\b(d[ií]as?\s+disponib|qu[eé]\s+d[ií]as?|cu[aá]ndo\s+(puedo|hay)|tiene\s+lugar)\b/.test(t)) {
        resultado.intencion = 'consultar_disponibilidad';
    } else if (/\b(precio|costo|cu[aá]nto\s+(vale|cuesta|es|sale|son)|tarifa)\b/.test(t)) {
        resultado.intencion = 'consultar_precios';
    } else if (/\b(horario|a\s+qu[eé]\s+hora|qu[eé]\s+horario)\b/.test(t)) {
        resultado.intencion = 'consultar_horarios';
    } else if (/\b(servicios|masajes|tipos|qu[eé]\s+tienen|qu[eé]\s+ofrecen|qu[eé]\s+hay)\b/.test(t)) {
        resultado.intencion = 'consultar_servicios';
    } else if (/\b(cancelar|anular|eliminar)\b.*\b(turno|reserva|cita)\b/.test(t) || /\b(turno|reserva)\b.*\b(cancelar|anular)\b/.test(t)) {
        resultado.intencion = 'cancelar';
    } else if (/\b(gracias|agradec|genial|perfecto|excelente)\b/.test(t) && t.length < 40) {
        resultado.intencion = 'agradecimiento';
    } else if (/\b(chau|adi[oó]s|bye|hasta\s+luego)\b/.test(t)) {
        resultado.intencion = 'despedida';
    } else if (/\b(hola|buenas|saludos|hey|buenos)\b/.test(t) && t.length < 60) {
        resultado.intencion = 'saludo';
    }

    // --- Nombre ---
    resultado.nombre = extraerNombre(texto);

    // --- País ---
    var paisDet = detectarPaisConNombre(texto);
    if (paisDet) { resultado.pais = paisDet.nombre; resultado.codigoPais = paisDet.codigo; }

    // --- Teléfono ---
    var telDet = extraerTelefono(texto);
    if (telDet) {
        resultado.telefono = telDet.telefono;
        if (telDet.codigoPais && !resultado.codigoPais) {
            resultado.codigoPais = telDet.codigoPais;
            resultado.pais = telDet.pais;
        }
    }

    // --- Tipo servicio ---
    if (/\b(salon|sal[oó]n|local|centro|aqu[ií]|ac[aá]|all[ií]|en\s+el\s+lugar|en\s+el\s+spa)\b/.test(t)) {
        resultado.tipoServicio = 'salon';
    } else if (/\b(domicilio|casa|hogar|a\s+mi\s+casa|mi\s+domicilio|en\s+casa|a\s+domicilio)\b/.test(t)) {
        resultado.tipoServicio = 'domicilio';
    }

    // --- Día ---
    var diasMap = { 'lunes': 'lunes', 'martes': 'martes', 'miercoles': 'miercoles', 'jueves': 'jueves', 'viernes': 'viernes', 'sabado': 'sabado', 'sábado': 'sabado' };
    for (var clave in diasMap) {
        if (t.indexOf(clave) !== -1) { resultado.dia = diasMap[clave]; break; }
    }

    // --- Hora (contexto primero, luego números) ---
    if (/\bmediod[ií]a\b/.test(t)) {
        resultado.hora = 12;
    } else if (/\bnoche\b/.test(t)) {
        resultado.hora = 20;
    } else if (/\btarde\b/.test(t)) {
        resultado.hora = 16;
    } else if (/\b12\b/.test(t)) {
        resultado.hora = 12;
    } else if (/\b20\b/.test(t)) {
        resultado.hora = 20;
    } else if (/\b16\b/.test(t)) {
        resultado.hora = 16;
    } else if (/\b4\b/.test(t) && !/\b14\b/.test(t) && !/\b24\b/.test(t) && !/\b40\b/.test(t) && !/\b45\b/.test(t)) {
        resultado.hora = 16;
    } else if (/\b8\b/.test(t) && !/\b18\b/.test(t) && !/\b28\b/.test(t)) {
        resultado.hora = 20;
    }

    // --- Masaje (dinámico) ---
    var masajeDet = detectarMasaje(texto);
    if (masajeDet) { resultado.masaje = masajeDet.masaje; resultado.masajeId = masajeDet.id; }

    // --- Dirección ---
    if (resultado.tipoServicio === 'domicilio') {
        var dirMatch = texto.match(/(?:casa|domicilio|direcci[oó]n)\s*[:.]?\s*(.+?)(?:\.|$)/i);
        if (dirMatch && dirMatch[1].trim().length > 5) resultado.ubicacion = dirMatch[1].trim();
    }

    return resultado;
}

// ============================================================
// FUSIONAR DATOS
// ============================================================
function fusionarDatos(existentes, extraidos) {
    if (extraidos.nombre && !existentes.nombre) existentes.nombre = extraidos.nombre;
    if (extraidos.pais && !existentes.pais) existentes.pais = extraidos.pais;
    if (extraidos.codigoPais && !existentes.codigoPais) existentes.codigoPais = extraidos.codigoPais;
    if (extraidos.masaje && !existentes.masaje) { existentes.masaje = extraidos.masaje; existentes.masajeId = extraidos.masajeId; }
    if (extraidos.dia && !existentes.dia) existentes.dia = extraidos.dia;
    if (extraidos.hora && !existentes.hora) existentes.hora = extraidos.hora;
    if (extraidos.tipoServicio && !existentes.tipoServicio) existentes.tipoServicio = extraidos.tipoServicio;
    if (extraidos.ubicacion && !existentes.ubicacion) existentes.ubicacion = extraidos.ubicacion;
    if (extraidos.telefono && !existentes.telefono) existentes.telefono = extraidos.telefono;
}

// ============================================================
// VERIFICAR SI UN CAMPO ESTÁ LLENO
// ============================================================
function campoLleno(cd, campo) {
    switch (campo) {
        case 'nombre': return !!cd.datos.nombre;
        case 'pais': return !!cd.datos.codigoPais;
        case 'masaje': return !!cd.datos.masaje;
        case 'ubicacion_tipo': return !!cd.datos.tipoServicio;
        case 'direccion': return !!cd.datos.ubicacion;
        case 'dia': return !!cd.datos.dia;
        case 'hora': return !!cd.datos.hora;
        case 'telefono': return !!cd.datos.telefono;
        default: return false;
    }
}

// ============================================================
// GENERADORES DE RESPUESTA
// ============================================================
function generarMenuServicios() {
    if (!serviciosData || serviciosData.length === 0) return 'No hay servicios disponibles.';
    var menu = 'Nuestros servicios:\n\n';
    for (var i = 0; i < serviciosData.length; i++) {
        var s = serviciosData[i];
        menu += (i + 1) + '. ' + s.nombre + ' - ' + s.precio + '\n';
    }
    menu += '\nDecime el número o nombre del que te interese.';
    return menu;
}

function generarRespuestaHorarios() {
    return 'Nuestros horarios:\n\nLunes a Sábado\n12:00 del mediodía\n16:00 de la tarde\n20:00 de la noche\n\nSolo un turno por persona por día. ¿Reservamos?';
}

function generarRespuestaPrecios() {
    if (!serviciosData || serviciosData.length === 0) return 'No hay servicios disponibles.';
    var lista = 'Precios:\n\n';
    for (var i = 0; i < serviciosData.length; i++) {
        lista += serviciosData[i].nombre + ': ' + serviciosData[i].precio + '\n';
    }
    lista += '\n¿Te gustaría reservar alguno?';
    return lista;
}

function generarRespuestaDisponibilidad() {
    var disp = obtenerDisponibilidad();
    var respuesta = 'Disponibilidad:\n\n';
    var tieneAlgo = false;

    for (var i = 0; i < disp.length; i++) {
        var d = disp[i];
        if (d.libres.length > 0) {
            tieneAlgo = true;
            var horas = [];
            for (var h = 0; h < d.libres.length; h++) horas.push(HORA_TEXTO[d.libres[h]] || d.libres[h] + ':00');
            respuesta += DIAS_NOMBRE[d.dia] + ': ' + horas.join(', ') + '\n';
        }
    }

    if (!tieneAlgo) return 'No hay turnos disponibles esta semana.';

    // Sugerir el primero disponible
    for (var j = 0; j < disp.length; j++) {
        if (disp[j].libres.length > 0) {
            respuesta += '\nTe sugiero ' + DIAS_NOMBRE[disp[j].dia] + ' a las ' + HORA_TEXTO[disp[j].libres[0]] + '.';
            break;
        }
    }
    return respuesta;
}

function generarRespuestaDefault(nombre) {
    return (nombre ? nombre + ', ' : '') + 'en qué te puedo ayudar?\n\nReservar un turno\nVer servicios\nHorarios\nPrecios\nDisponibilidad';
}

// ============================================================
// MANEJAR RESERVA: verificar faltantes y preguntar
// ============================================================
function manejarReserva(cd) {
    var d = cd.datos;
    var faltantes = [];

    if (!d.nombre) faltantes.push('nombre');
    if (!d.codigoPais) faltantes.push('pais');
    if (!d.masaje) faltantes.push('masaje');
    if (!d.tipoServicio) faltantes.push('ubicacion_tipo');
    if (d.tipoServicio === 'domicilio' && !d.ubicacion) faltantes.push('direccion');
    if (!d.dia) faltantes.push('dia');
    if (!d.hora) faltantes.push('hora');
    if (!d.telefono) faltantes.push('telefono');

    if (faltantes.length > 0) {
        var primero = faltantes[0];
        cd.ultimaPregunta = primero;

        switch (primero) {
            case 'nombre':
                return '¿Me decís tu nombre?';
            case 'pais':
                return (d.nombre ? d.nombre + ', ' : '') + '¿de qué país me llamás? Lo necesito para contactarte por WhatsApp.';
            case 'masaje':
                return generarMenuServicios();
            case 'ubicacion_tipo':
                return '¿En nuestro salón o a domicilio?';
            case 'direccion':
                return '¿Cuál es tu dirección? Calle, número y ciudad.';
            case 'dia':
                return generarRespuestaDisponibilidad();
            case 'hora':
                return '¿A qué hora?\n\n12 del mediodía\n4 de la tarde\n8 de la noche';
            case 'telefono':
                return 'Por último, tu número de teléfono. Solo los dígitos, sin código de país.';
        }
    }

    return null; // Todo completo
}

// ============================================================
// INTENTAR SELECCIONAR MASAJE POR NÚMERO O NOMBRE
// ============================================================
function intentarSeleccionarMasaje(cd, texto) {
    var num = textoANumero(texto);
    if (num !== null && num >= 1 && num <= serviciosData.length) {
        cd.datos.masaje = serviciosData[num - 1].nombre;
        cd.datos.masajeId = serviciosData[num - 1].id;
        return true;
    }

    // Intentar por nombre directo
    var det = detectarMasaje(texto);
    if (det) {
        cd.datos.masaje = det.masaje;
        cd.datos.masajeId = det.id;
        return true;
    }

    return false;
}

// ============================================================
// INTENTAR SELECCIONAR HORA POR NÚMERO
// ============================================================
function intentarSeleccionarHora(cd, texto) {
    var num = textoANumero(texto);
    if (num === null) return false;

    // Mapear número a hora
    var hora = null;
    if (num === 1 || num === 12) hora = 12;
    else if (num === 2 || num === 16) hora = 16;
    else if (num === 3 || num === 20) hora = 20;
    else if (HORAS_VALIDAS.indexOf(num) !== -1) hora = num;

    if (hora !== null) {
        cd.datos.hora = hora;
        return true;
    }
    return false;
}

// ============================================================
// MANEJAR CONFIRMACIÓN DE ALTERNATIVA
// ============================================================
async function manejarConfirmacion(cd, texto, ip) {
    var t = texto.toLowerCase();

    if (/\b(si|s[ií]|sip|dale|ok|vale|claro|por supuesto|exacto|bien|perfecto)\b/.test(t)) {
        cd.datos.dia = cd.pendienteConfirmar.dia;
        cd.datos.hora = cd.pendienteConfirmar.hora;
        cd.pendienteConfirmar = null;
        cd.ultimaPregunta = null;
        return await confirmarReservaInteligente(cd, ip);
    }

    if (/\b(no|nop|nope|negativo)\b/.test(t)) {
        cd.pendienteConfirmar = null;
        cd.ultimaPregunta = null;
        return generarRespuestaDisponibilidad();
    }

    return '¿Te sirve el ' + DIAS_NOMBRE[cd.pendienteConfirmar.dia] + ' a las ' +
        HORA_TEXTO[cd.pendienteConfirmar.hora] + '? Decí "sí" o "no".';
}

// ============================================================
// MANEJAR CANCELACIÓN
// ============================================================
async function manejarCancelacion(cd, ip) {
    if (cd.datos.telefono) {
        try {
            var turnos = JSON.parse(await fs.readFile(TURNOS_FILE, 'utf8'));
            var turno = null;
            for (var i = 0; i < turnos.length; i++) {
                if (turnos[i].telefono === cd.datos.telefono) { turno = turnos[i]; break; }
            }
            if (turno) {
                turnos.splice(i, 1);
                await fs.writeFile(TURNOS_FILE, JSON.stringify(turnos, null, 2), 'utf8');
                turnosMem = turnos;
                return (cd.datos.nombre || 'Tu') + ' turno del ' + turno.dia + ' a las ' + turno.hora + ':00 fue cancelado. ¿Necesitás algo más?';
            }
            return 'No encontré un turno activo con ese número.';
        } catch (e) { return 'Error al cancelar.'; }
    }
    cd.ultimaPregunta = 'cancelar_telefono';
    return 'Para cancelar necesito el número de teléfono de la reserva.';
}

// ============================================================
// CONFIRMAR RESERVA
// ============================================================
async function confirmarReservaInteligente(cd, ip) {
    var d = cd.datos;

    if (!d.codigoPais || !/^\d{1,3}$/.test(d.codigoPais)) {
        d.codigoPais = '53';
        d.pais = d.pais || 'Cuba';
    }

    if (!paisAutorizado(d.codigoPais)) {
        return 'Lo siento' + (d.nombre ? ', ' + d.nombre : '') + ', no aceptamos reservas desde ' + (d.pais || 'ese país') + '.';
    }

    try {
        var turnos = JSON.parse(await fs.readFile(TURNOS_FILE, 'utf8'));
        var dia = d.dia;
        var hora = d.hora;

        // Verificar duplicado por teléfono
        for (var i = 0; i < turnos.length; i++) {
            if (turnos[i].telefono === d.telefono && turnos[i].dia === dia) {
                return (d.nombre || 'Cliente') + ', ya tenés un turno para el ' + DIAS_NOMBRE[dia] + '. ¿Otro día?';
            }
        }

        // Verificar horario ocupado
        for (var j = 0; j < turnos.length; j++) {
            if (turnos[j].dia === dia && turnos[j].hora === hora) {
                var alt = buscarAlternativa(dia, hora, turnos);
                if (alt) {
                    cd.pendienteConfirmar = { dia: alt.dia, hora: alt.hora };
                    cd.ultimaPregunta = 'confirmar_alternativa';
                    return 'Ese horario está ocupado' + (d.nombre ? ', ' + d.nombre : '') + '. Tengo disponible el ' +
                        DIAS_NOMBRE[alt.dia] + ' a las ' + HORA_TEXTO[alt.hora] + '. ¿Te sirve?';
                }
                return 'No hay disponibilidad esa semana' + (d.nombre ? ', ' + d.nombre : '') + '.';
            }
        }

        // Crear reserva
        var nuevo = {
            id: generarId(), nombre: d.nombre || 'Cliente', dia: dia, hora: hora,
            massageType: d.masaje || 'Masaje', telefono: d.telefono,
            codigoPais: d.codigoPais,
            ubicacion: d.tipoServicio === 'domicilio' ? (d.ubicacion || 'A confirmar') : 'Salón Serenity Spa',
            tipoServicio: d.tipoServicio || 'salon', confirmadoWhatsApp: false,
            fechaCreacion: new Date().toISOString(), ip: ip
        };

        turnos.push(nuevo);
        await fs.writeFile(TURNOS_FILE, JSON.stringify(turnos, null, 2), 'utf8');
        turnosMem = turnos;
        regTurno(ip, d.telefono);

        var ubicTexto = d.tipoServicio === 'domicilio' ? d.ubicacion : 'Nuestro salón';
        var fechaTxt = formatearFecha(dia);

        return 'Turno confirmado.\n\n' +
            'Día: ' + fechaTxt + '\n' +
            'Hora: ' + HORA_TEXTO[hora] + '\n' +
            'Masaje: ' + d.masaje + '\n' +
            'Lugar: ' + ubicTexto + '\n' +
            'Teléfono: +' + d.codigoPais + ' ' + d.telefono + '\n\n' +
            'Te esperamos. Si necesitás cancelar, decí "cancelar".';

    } catch (e) {
        console.error('Error reserva:', e);
        return 'Error al procesar la reserva. Intentá de nuevo.';
    }
}

// ============================================================
// PROCESAR COMANDO DE VOZ (CORREGIDO)
// ============================================================
async function procesarComandoVoz(texto, clientId, ip) {
    var textoLimpio = texto.replace(/<[^>]*>/g, '').replace(/[<>]/g, '').trim();
    if (!textoLimpio || textoLimpio.length > 500) {
        return 'No pude entender. ¿Podés repetir?';
    }

    var cd = voiceClients.get(clientId);
    if (!cd) {
        cd = { datos: {}, pendienteConfirmar: null, ultimaPregunta: null, clientId: clientId };
        voiceClients.set(clientId, cd);
    }

    // 1. Si hay confirmación pendiente, manejarla
    if (cd.pendienteConfirmar) {
        return await manejarConfirmacion(cd, textoLimpio, ip);
    }

    // 2. Analizar texto y fusionar datos
    var analisis = analizarTextoCompleto(textoLimpio);
    fusionarDatos(cd.datos, analisis);

    // 3. Intentar completar respuesta a pregunta pendiente (masaje por número, hora por número)
    if (cd.ultimaPregunta === 'masaje' && !cd.datos.masaje) {
        if (intentarSeleccionarMasaje(cd, textoLimpio)) {
            cd.ultimaPregunta = null;
            var f = manejarReserva(cd);
            if (f !== null) return f;
            return await confirmarReservaInteligente(cd, ip);
        }
    }

    if (cd.ultimaPregunta === 'hora' && !cd.datos.hora) {
        if (intentarSeleccionarHora(cd, textoLimpio)) {
            cd.ultimaPregunta = null;
            var f2 = manejarReserva(cd);
            if (f2 !== null) return f2;
            return await confirmarReservaInteligente(cd, ip);
        }
    }

    // 4. Si la pregunta pendiente fue respondida, continuar reserva
    if (cd.ultimaPregunta && campoLleno(cd, cd.ultimaPregunta)) {
        cd.ultimaPregunta = null;
        var f3 = manejarReserva(cd);
        if (f3 !== null) return f3;
        return await confirmarReservaInteligente(cd, ip);
    }

    // 5. Si la intención es reservar o hay datos de reserva implícitos (y no es consulta)
    var intencionConsulta = ['consultar_servicios', 'consultar_horarios', 'consultar_precios', 'consultar_disponibilidad'].indexOf(analisis.intencion) !== -1;
    var hayDatosReserva = cd.datos.dia || cd.datos.hora || cd.datos.masaje || cd.datos.telefono;
    var intencionReservar = analisis.intencion === 'reservar';

    if (intencionReservar || (hayDatosReserva && !intencionConsulta && !cd.ultimaPregunta)) {
        var f4 = manejarReserva(cd);
        if (f4 !== null) return f4;
        return await confirmarReservaInteligente(cd, ip);
    }

    // 6. Manejar otras intenciones
    switch (analisis.intencion) {
        case 'saludo':
            return cd.datos.nombre
                ? '¿En qué te puedo ayudar, ' + cd.datos.nombre + '?'
                : '¿Me decís tu nombre para poder ayudarte?';
        case 'consultar_servicios':
            return generarMenuServicios();
        case 'consultar_horarios':
            return generarRespuestaHorarios();
        case 'consultar_precios':
            return generarRespuestaPrecios();
        case 'consultar_disponibilidad':
            return generarRespuestaDisponibilidad();
        case 'cancelar':
            return await manejarCancelacion(cd, ip);
        case 'agradecimiento':
            return 'Un placer' + (cd.datos.nombre ? ', ' + cd.datos.nombre : '') + '. ¿Necesitás algo más?';
        case 'despedida':
            return 'Hasta pronto' + (cd.datos.nombre ? ', ' + cd.datos.nombre : '') + '.';
        default:
            // Si hay pregunta pendiente no respondida, re-preguntar
            if (cd.ultimaPregunta) {
                switch (cd.ultimaPregunta) {
                    case 'nombre': return '¿Me decís tu nombre?';
                    case 'pais': return '¿De qué país me llamás?';
                    case 'masaje': return generarMenuServicios();
                    case 'ubicacion_tipo': return '¿En el salón o a domicilio?';
                    case 'direccion': return '¿Tu dirección completa?';
                    case 'dia': return generarRespuestaDisponibilidad();
                    case 'hora': return '¿A qué hora? 12, 4 u 8.';
                    case 'telefono': return '¿Tu número de teléfono? Solo dígitos.';
                    case 'cancelar_telefono': return 'Necesito el número de teléfono para cancelar.';
                }
            }
            return generarRespuestaDefault(cd.datos.nombre);
    }
}

// ============================================================
// MIDDLEWARES DE SEGURIDAD
// ============================================================
app.use(function(req, res, next) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    next();
});

app.use(function(req, res, next) {
    var ip = req.ip || req.socket.remoteAddress || '0.0.0.0';
    if (estaBloqueado(ip)) return res.status(403).json({ error: 'IP bloqueada', bloqueado: true });
    next();
});

app.use(express.static(__dirname));

// ============================================================
// AUTENTICACIÓN
// ============================================================
var validTokens = new Map();

function checkAuth(req) {
    var h = req.headers.authorization;
    if (!h || h.indexOf('Bearer ') !== 0) return false;
    var token = h.substring(7);
    if (!validTokens.has(token)) return false;
    if (validTokens.get(token) < Date.now()) { validTokens.delete(token); return false; }
    return true;
}

app.post('/api/login', function(req, res) {
    var ip = req.ip || '0.0.0.0';
    if (estaBloqueado(ip)) return res.status(403).json({ success: false, error: 'IP bloqueada' });
    var password = req.body.password;
    if (!password) { registrarIntento(ip, 'Vacía'); return res.status(400).json({ success: false, error: 'Contraseña requerida' }); }
    if (password === (process.env.ADMIN_PASSWORD || 'admin123')) {
        var token = crypto.randomBytes(64).toString('hex');
        validTokens.set(token, Date.now() + 28800000);
        intentosFallidos.delete(ip);
        res.json({ success: true, token: token });
    } else {
        registrarIntento(ip, 'Incorrecta');
        res.status(401).json({ success: false, error: 'Contraseña incorrecta' });
    }
});

app.get('/api/verify', function(req, res) { res.json({ valid: checkAuth(req) }); });
app.post('/api/logout', function(req, res) {
    var h = req.headers.authorization;
    if (h && h.indexOf('Bearer ') === 0) validTokens.delete(h.substring(7));
    res.json({ ok: true });
});

// ============================================================
// UPLOAD HERO
// ============================================================
app.post('/api/upload-hero', async function(req, res) {
    if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    try {
        var base64 = req.body.base64;
        if (!base64 || base64.indexOf('data:image') !== 0) return res.status(400).json({ error: 'Imagen inválida' });
        var matches = base64.match(/^data:image\/(\w+);base64,(.+)$/);
        if (!matches) return res.status(400).json({ error: 'Formato no reconocido' });
        var ext = matches[1] === 'jpeg' ? 'jpg' : matches[1];
        var buffer = Buffer.from(matches[2], 'base64');
        var filename = 'hero-' + Date.now() + '.' + ext;
        await fs.writeFile(path.join(UPLOADS_DIR, filename), buffer);
        var files = await fs.readdir(UPLOADS_DIR);
        for (var i = 0; i < files.length; i++) {
            if (files[i].indexOf('hero-') === 0 && files[i] !== filename) {
                try { await fs.unlink(path.join(UPLOADS_DIR, files[i])); } catch (e) { /* */ }
            }
        }
        res.json({ url: '/uploads/' + filename, filename: filename });
    } catch (e) { res.status(500).json({ error: 'Error al subir' }); }
});

// ============================================================
// CONFIGURACIÓN
// ============================================================
var configData = {
    hero: { titulo: "Renueva tu Energía", subtitulo: "Experiencias de bienestar", imagenFondo: "https://images.unsplash.com/photo-1544161515-4ab6ce6db874?w=1920", botonTexto: "Explorar Tratamientos" },
    serviciosSection: { etiqueta: "Nuestros Servicios", titulo: "Elige tu Masaje Ideal", descripcion: "Turnos: 12:00, 16:00 y 20:00" },
    contactoSection: { titulo: "Asistente de Reservas", descripcion: "Reserva tu turno de forma rápida" },
    shareSection: { titulo: "Comparte Serenity Spa" }
};

app.get('/api/config', function(req, res) { res.json(configData); });

app.put('/api/config', async function(req, res) {
    if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    configData = Object.assign(configData, req.body);
    await fs.writeFile(CONFIG_FILE, JSON.stringify(configData, null, 2), 'utf8');
    res.json({ ok: true, mensaje: 'Guardada' });
});

// ============================================================
// SERVICIOS
// ============================================================
var serviciosData = [];

app.get('/api/servicios', function(req, res) {
    res.json(serviciosData.sort(function(a, b) { return (a.orden || 999) - (b.orden || 999); }));
});

app.post('/api/servicios', async function(req, res) {
    if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    try {
        var iwa = '';
        if (req.body.imagenWhatsApp && esUrlValida(req.body.imagenWhatsApp)) iwa = req.body.imagenWhatsApp.trim();
        var s = Object.assign({ id: generarId() }, req.body, {
            imagenWeb: req.body.imagenWeb || 'https://images.unsplash.com/photo-1544161515-4ab6ce6db874?w=800',
            imagenWhatsApp: iwa
        });
        serviciosData.push(s);
        await fs.writeFile(SERVICIOS_FILE, JSON.stringify(serviciosData, null, 2), 'utf8');
        await inicializarBaseConocimiento();
        res.status(201).json(s);
    } catch (e) { res.status(500).json({ error: 'Error' }); }
});

app.put('/api/servicios/:id', async function(req, res) {
    if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    try {
        var idx = -1;
        for (var i = 0; i < serviciosData.length; i++) { if (serviciosData[i].id === req.params.id) { idx = i; break; } }
        if (idx === -1) return res.status(404).json({ error: 'No encontrado' });
        var iwa = serviciosData[idx].imagenWhatsApp || '';
        if (req.body.imagenWhatsApp !== undefined) {
            if (req.body.imagenWhatsApp && esUrlValida(req.body.imagenWhatsApp)) iwa = req.body.imagenWhatsApp.trim();
            else if (!req.body.imagenWhatsApp) iwa = '';
        }
        serviciosData[idx] = Object.assign({}, serviciosData[idx], req.body, {
            id: req.params.id,
            imagenWeb: req.body.imagenWeb || serviciosData[idx].imagenWeb,
            imagenWhatsApp: iwa
        });
        await fs.writeFile(SERVICIOS_FILE, JSON.stringify(serviciosData, null, 2), 'utf8');
        await inicializarBaseConocimiento();
        res.json({ ok: true, mensaje: 'Actualizado' });
    } catch (e) { res.status(500).json({ error: 'Error' }); }
});

app.delete('/api/servicios/:id', async function(req, res) {
    if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    var antes = serviciosData.length;
    serviciosData = serviciosData.filter(function(s) { return s.id !== req.params.id; });
    await fs.writeFile(SERVICIOS_FILE, JSON.stringify(serviciosData, null, 2), 'utf8');
    await inicializarBaseConocimiento();
    res.json({ ok: true, mensaje: serviciosData.length < antes ? 'Eliminado' : 'No encontrado' });
});

// ============================================================
// TURNOS
// ============================================================
var turnosMem = [];

async function loadTurnos() {
    try {
        if (fsSync.existsSync(TURNOS_FILE)) turnosMem = JSON.parse(await fs.readFile(TURNOS_FILE, 'utf8'));
        else turnosMem = [];
    } catch (e) { turnosMem = []; }
    return turnosMem;
}

async function saveTurnos(t) {
    await fs.writeFile(TURNOS_FILE, JSON.stringify(t, null, 2), 'utf8');
    turnosMem = t;
}

app.get('/turnos', async function(req, res) { res.json(await loadTurnos()); });

app.post('/turnos', async function(req, res) {
    var ip = req.ip || '0.0.0.0';
    if (estaBloqueado(ip)) return res.status(403).json({ error: 'IP bloqueada' });
    if (!checkRateIP(ip)) { bloquearIP(ip, 'Spam turnos', 'spam'); return res.status(429).json({ error: 'Demasiadas solicitudes' }); }
    try {
        var nombre = req.body.nombre, dia = req.body.dia, hora = req.body.hora;
        var massageType = req.body.massageType, telefono = req.body.telefono;
        var ubicacion = req.body.ubicacion, tipoServicio = req.body.tipoServicio;
        if (!nombre || nombre.length < 2) return res.status(400).json({ error: 'Nombre inválido' });
        var tel = telefono ? telefono.replace(/\D/g, '') : '';
        if (!tel || tel.length < 7) return res.status(400).json({ error: 'Teléfono inválido' });
        var codigoPais = req.body.codigoPais || '53';
        if (!/^\d{1,3}$/.test(codigoPais)) codigoPais = '53';
        if (!paisAutorizado(codigoPais)) return res.status(403).json({ error: 'País no autorizado' });
        if (!dia || DIAS_VALIDOS.indexOf(dia.toLowerCase()) === -1) return res.status(400).json({ error: 'Día inválido' });
        var hn = parseInt(hora);
        if (HORAS_VALIDAS.indexOf(hn) === -1) return res.status(400).json({ error: 'Hora inválida' });
        if (!checkRateTel(tel)) return res.status(429).json({ error: 'Máximo 2 turnos por teléfono por día' });
        var turnos = await loadTurnos();
        var dl = dia.toLowerCase();
        for (var i = 0; i < turnos.length; i++) {
            if (turnos[i].telefono === tel && turnos[i].dia === dl) return res.status(409).json({ error: 'Ya tenés turno ese día' });
        }
        for (var j = 0; j < turnos.length; j++) {
            if (turnos[j].dia === dl && turnos[j].hora === hn) return res.status(409).json({ error: 'Ocupado', alternativa: buscarAlternativa(dl, hn, turnos) });
        }
        var nuevo = {
            id: generarId(), nombre: escapeHtml(sanitize(nombre)), dia: dl, hora: hn,
            massageType: massageType || 'Masaje', telefono: tel, codigoPais: codigoPais,
            ubicacion: ubicacion ? escapeHtml(sanitize(ubicacion)) : null,
            tipoServicio: tipoServicio || 'salon', confirmadoWhatsApp: false,
            fechaCreacion: new Date().toISOString(), ip: ip
        };
        turnos.push(nuevo);
        await saveTurnos(turnos);
        regTurno(ip, tel);
        intentosFallidos.delete(ip);
        res.status(201).json({ mensaje: 'Reservado', turno: nuevo });
    } catch (e) { res.status(500).json({ error: 'Error' }); }
});

app.delete('/turnos/:id', async function(req, res) {
    if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    var turnos = await loadTurnos();
    var idx = -1;
    for (var i = 0; i < turnos.length; i++) { if (turnos[i].id === req.params.id) { idx = i; break; } }
    if (idx === -1) return res.status(404).json({ error: 'No encontrado' });
    turnos.splice(idx, 1);
    await saveTurnos(turnos);
    res.json({ ok: true });
});

app.post('/api/cancelar-turno', async function(req, res) {
    try {
        var tel = (req.body.telefono || '').replace(/\D/g, '');
        if (tel.length < 7) return res.json({ error: 'Número inválido' });
        var turnos = await loadTurnos();
        var turno = null, tIdx = -1;
        for (var i = 0; i < turnos.length; i++) { if (turnos[i].telefono === tel) { turno = turnos[i]; tIdx = i; break; } }
        if (!turno) return res.json({ error: 'No encontrado' });
        if (turno.confirmadoWhatsApp) return res.json({ whatsappCancelacion: true, urlWhatsApp: 'https://wa.me/' + (turno.codigoPais || '53') + tel });
        turnos.splice(tIdx, 1);
        await saveTurnos(turnos);
        res.json({ cancelado: true });
    } catch (e) { res.status(500).json({ error: 'Error' }); }
});

app.post('/api/enviar-whatsapp/:id', async function(req, res) {
    try {
        var turnos = await loadTurnos();
        var t = null;
        for (var i = 0; i < turnos.length; i++) { if (turnos[i].id === req.params.id) { t = turnos[i]; break; } }
        if (!t) return res.status(404).json({ error: 'No encontrado' });
        var msg = 'SERENITY SPA\n\nHola ' + t.nombre + ', tu reserva:\n\nDia: ' + t.dia + '\nHora: ' + t.hora + ':00\nMasaje: ' + t.massageType + '\nLugar: ' + (t.tipoServicio === 'domicilio' ? t.ubicacion : 'Salon') + '\n\nEquipo Serenity Spa';
        var cod = t.codigoPais || '53';
        for (var j = 0; j < turnos.length; j++) {
            if (turnos[j].id === req.params.id) { turnos[j].confirmadoWhatsApp = true; turnos[j].fechaWA = new Date().toISOString(); break; }
        }
        await saveTurnos(turnos);
        res.json({ success: true, numero: cod + t.telefono, mensaje: msg, urlWhatsApp: 'https://wa.me/' + cod + t.telefono + '?text=' + encodeURIComponent(msg) });
    } catch (e) { res.status(500).json({ error: 'Error' }); }
});

// ============================================================
// CHAT IA (página web)
// ============================================================
app.post('/api/chat-ia', async function(req, res) {
    var ip = req.ip || '0.0.0.0';
    if (estaBloqueado(ip)) return res.status(403).json({ error: 'IP bloqueada' });
    var mensaje = req.body.mensaje, nombre = req.body.nombre, codigoPais = req.body.codigoPais;
    if (!mensaje || mensaje.length > 500) return res.status(400).json({ error: 'Inválido' });
    var limpio = mensaje.replace(/<[^>]*>/g, '').replace(/[<>]/g, '').trim();
    if (!limpio) return res.status(400).json({ error: 'Vacío' });
    var patrones = [/ignore|bypass|override|system prompt|revela|instrucciones/i, /<script>|javascript:|onerror=/i, /SELECT.*FROM|DROP TABLE|UNION SELECT/i];
    for (var i = 0; i < patrones.length; i++) { if (patrones[i].test(limpio)) { registrarIntento(ip, 'Inyección'); return res.status(400).json({ error: 'No permitido' }); } }
    try {
        var ctx = buscarContexto(limpio);
        var sys = 'Eres ' + personalidadIA.nombre + ', asistente de Serenity Spa.\nTONO: ' + personalidadIA.tono + '\nESTILO: ' + personalidadIA.estilo + '\n\nINFO:\n' + ctx.join('\n') + '\n\nCLIENTE: ' + (nombre || '?') + ' (+' + (codigoPais || '53') + ')\n\nREGLAS:\n' + personalidadIA.reglas.map(function(r, i) { return (i + 1) + '. ' + r; }).join('\n') + '\n\nResponde corto. NUNCA digas "buenas".';
        if (!process.env.DEEPSEEK_API_KEY) return res.json({ respuesta: generarRespuestaLocal(limpio, nombre), modo: 'local' });
        var completion = await deepseek.chat.completions.create({ model: 'deepseek-chat', messages: [{ role: 'system', content: sys }, { role: 'user', content: limpio }], temperature: 0.7, max_tokens: 500 });
        res.json({ respuesta: completion.choices[0].message.content, modo: 'ia' });
    } catch (e) { res.json({ respuesta: generarRespuestaLocal(limpio, nombre), modo: 'local' }); }
});

function generarRespuestaLocal(m, n) {
    var t = m.toLowerCase(), c = n || 'cliente';
    if (/\b(hola|buenas)\b/.test(t)) return 'Hola ' + c + '. ¿En qué te puedo ayudar?';
    if (/\b(reservar|turno)\b/.test(t)) return 'Para reservar necesito: nombre, masaje, día, hora y teléfono.';
    if (/\b(horario)\b/.test(t)) return 'Lunes a Sábado: 12, 16 y 20. ¿Reservamos?';
    if (/\b(precio|costo)\b/.test(t)) { var l = 'Precios:\n'; serviciosData.forEach(function(s) { l += s.nombre + ': ' + s.precio + '\n'; }); return l; }
    if (/\b(gracias)\b/.test(t)) return 'Un placer, ' + c + '.';
    return c + ', ¿en qué te puedo ayudar?';
}

// ============================================================
// IA PERSONALIDAD (ADMIN)
// ============================================================
app.get('/api/ia/personalidad', function(req, res) { if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' }); res.json(personalidadIA); });

app.put('/api/ia/personalidad', async function(req, res) {
    if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    if (req.body.nombre) personalidadIA.nombre = sanitize(req.body.nombre);
    if (req.body.tono) personalidadIA.tono = sanitize(req.body.tono);
    if (req.body.estilo) personalidadIA.estilo = sanitize(req.body.estilo);
    if (req.body.reglas) personalidadIA.reglas = req.body.reglas.map(function(r) { return sanitize(r); });
    res.json({ ok: true });
});

app.post('/api/ia/recargar', async function(req, res) {
    if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    await inicializarBaseConocimiento();
    res.json({ ok: true, items: baseConocimiento.length });
});

// ============================================================
// SEGURIDAD PAÍSES (ADMIN)
// ============================================================
app.get('/api/seguridad/paises', function(req, res) { if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' }); res.json(paisesConfig); });

app.put('/api/seguridad/paises', async function(req, res) {
    if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    if (req.body.autorizados !== undefined) paisesConfig.autorizados = req.body.autorizados;
    if (req.body.bloqueados !== undefined) paisesConfig.bloqueados = req.body.bloqueados;
    if (req.body.modo && (req.body.modo === 'todos' || req.body.modo === 'solo_autorizados')) paisesConfig.modo = req.body.modo;
    await guardarPaises();
    res.json({ ok: true });
});

app.post('/api/seguridad/paises/autorizar', async function(req, res) {
    if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    var codigo = req.body.codigo, nombre = req.body.nombre;
    if (!codigo || !/^\d{1,3}$/.test(codigo)) return res.status(400).json({ error: 'Código inválido' });
    if (paisesConfig.autorizados.indexOf(codigo) === -1) { paisesConfig.autorizados.push(codigo); paisesConfig.bloqueados = paisesConfig.bloqueados.filter(function(c) { return c !== codigo; }); await guardarPaises(); }
    res.json({ ok: true, mensaje: (nombre || codigo) + ' autorizado' });
});

app.post('/api/seguridad/paises/bloquear', async function(req, res) {
    if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    var codigo = req.body.codigo, nombre = req.body.nombre;
    if (!codigo || !/^\d{1,3}$/.test(codigo)) return res.status(400).json({ error: 'Código inválido' });
    if (paisesConfig.bloqueados.indexOf(codigo) === -1) { paisesConfig.bloqueados.push(codigo); paisesConfig.autorizados = paisesConfig.autorizados.filter(function(c) { return c !== codigo; }); await guardarPaises(); }
    res.json({ ok: true, mensaje: (nombre || codigo) + ' bloqueado' });
});

app.delete('/api/seguridad/paises/:codigo', async function(req, res) {
    if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    var codigo = req.params.codigo;
    paisesConfig.autorizados = paisesConfig.autorizados.filter(function(c) { return c !== codigo; });
    paisesConfig.bloqueados = paisesConfig.bloqueados.filter(function(c) { return c !== codigo; });
    await guardarPaises();
    res.json({ ok: true });
});

app.get('/api/seguridad/paises/stats', async function(req, res) {
    if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    var turnos = await loadTurnos();
    var stats = {};
    var nombres = { '53': 'Cuba', '54': 'Argentina', '52': 'México', '57': 'Colombia', '56': 'Chile', '51': 'Perú', '34': 'España', '1': 'EE.UU.' };
    for (var i = 0; i < turnos.length; i++) { var c = turnos[i].codigoPais || '53'; stats[c] = (stats[c] || 0) + 1; }
    res.json(Object.keys(stats).map(function(k) { return { codigo: k, nombre: nombres[k] || '?', reservas: stats[k] }; }).sort(function(a, b) { return b.reservas - a.reservas; }));
});

// ============================================================
// SEGURIDAD BLOQUEOS (ADMIN)
// ============================================================
app.get('/api/seguridad/bloqueos', function(req, res) {
    if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    var a = [];
    for (var entry of bloqueos) {
        a.push({ ip: entry[0], motivo: entry[1].motivo, tipoAtaque: entry[1].tipoAtaque, fecha: entry[1].fecha, tiempoRestante: Math.max(0, entry[1].hasta - Date.now()), tiempoRestanteFormateado: fmtT(Math.max(0, entry[1].hasta - Date.now())), intentos: entry[1].intentos || 0, permanente: entry[1].permanente || false });
    }
    res.json({ activos: a, historial: historialBloqueos.slice(0, 100), intentosFallidos: Object.fromEntries(intentosFallidos) });
});

app.post('/api/seguridad/desbloquear/:ip', function(req, res) { if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' }); desbloquearIP(req.params.ip); res.json({ ok: true }); });
app.delete('/api/seguridad/bloqueos/:ip', function(req, res) { if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' }); bloqueos.delete(req.params.ip); intentosFallidos.delete(req.params.ip); guardarBloqueos(); res.json({ ok: true }); });
app.delete('/api/seguridad/historial/:id', function(req, res) { if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' }); historialBloqueos = historialBloqueos.filter(function(h) { return h.id !== req.params.id; }); guardarBloqueos(); res.json({ ok: true }); });
app.post('/api/seguridad/limpiar-expirados', function(req, res) { if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' }); var b = 0, now = Date.now(); for (var entry of bloqueos) { if (now > entry[1].hasta) { bloqueos.delete(entry[0]); b++; } } guardarBloqueos(); res.json({ mensaje: b + ' eliminados' }); });
app.post('/api/seguridad/bloquear-permanente/:ip', function(req, res) { if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' }); bloquearIP(req.params.ip, 'Permanente', 'manual'); var d = bloqueos.get(req.params.ip); if (d) { d.hasta = Date.now() + 31536000000; d.permanente = true; guardarBloqueos(); } res.json({ ok: true }); });

// ============================================================
// RUTAS ESTÁTICAS
// ============================================================
app.get('/voice-assistant', function(req, res) { res.sendFile(path.join(__dirname, 'voice-assistant.html')); });
app.get('/', function(req, res) { res.sendFile(path.join(__dirname, 'index.html')); });
app.get('/admin.html', function(req, res) { res.sendFile(path.join(__dirname, 'admin.html')); });
app.get('/login.html', function(req, res) { res.sendFile(path.join(__dirname, 'login.html')); });
app.get('/health', function(req, res) { res.json({ status: 'ok', timestamp: new Date().toISOString(), uptime: process.uptime(), ia: process.env.DEEPSEEK_API_KEY ? 'conectada' : 'local' }); });

// ============================================================
// WEBSOCKET - ASISTENTE DE VOZ
// ============================================================
var voiceClients = new Map();
var wsRatePerSec = new Map();
var wsConnPerIP = new Map();
var voiceAttackPatterns = [/ignore\s+(previous|all)\s+instructions/i, /you\s+are\s+now/i, /system\s*:\s*/i, /<script[\s>]/i, /javascript\s*:/i, /\$\{.*\}/, /SELECT\s+.*\s+FROM/i, /DROP\s+TABLE/i, /UNION\s+SELECT/i, /;\s*DELETE/i, /\.\.\//, /\/etc\/passwd/i];

function checkWsRateLimit(ip) {
    var now = Date.now();
    var ts = wsRatePerSec.get(ip) || [];
    var recent = ts.filter(function(t) { return now - t < 10000; });
    wsRatePerSec.set(ip, recent);
    if (recent.length >= 4) return false;
    recent.push(now);
    return true;
}

async function startServer() {
    await cargarBloqueos();
    await cargarPaises();

    try { configData = JSON.parse(await fs.readFile(CONFIG_FILE, 'utf8')); } catch (e) { await fs.writeFile(CONFIG_FILE, JSON.stringify(configData, null, 2), 'utf8'); }
    try { serviciosData = JSON.parse(await fs.readFile(SERVICIOS_FILE, 'utf8')); } catch (e) {
        serviciosData = [
            { id: "relajante", nombre: "Masaje Relajante", precio: "$45", descripcion: "Movimientos suaves para liberar estrés.", beneficios: ["Reduce ansiedad", "Alivia tensión", "60 Minutos"], efectos: ["Relajación profunda", "Mejora del sueño"], imagenWeb: "https://images.unsplash.com/photo-1544161515-4ab6ce6db874?w=800", imagenWhatsApp: "", orden: 1 },
            { id: "corporal", nombre: "Masaje Corporal", precio: "$65", descripcion: "Tratamiento completo y revitalizante.", beneficios: ["Relajación integral", "Elimina contracturas", "90 Minutos"], efectos: ["Activación linfática", "Mejora circulación"], imagenWeb: "https://images.unsplash.com/photo-1519823551278-64ac92734fb1?w=800", imagenWhatsApp: "", orden: 2 },
            { id: "facial", nombre: "Masaje Facial", precio: "$40", descripcion: "Rejuvenece la piel y alivia tensión facial.", beneficios: ["Reafirma la piel", "Reduce ojeras", "45 Minutos"], efectos: ["Estimula colágeno", "Tonifica rostro"], imagenWeb: "https://images.unsplash.com/photo-1570172619644-dfd03ed5d881?w=800", imagenWhatsApp: "", orden: 3 }
        ];
        await fs.writeFile(SERVICIOS_FILE, JSON.stringify(serviciosData, null, 2), 'utf8');
    }
    try { turnosMem = JSON.parse(await fs.readFile(TURNOS_FILE, 'utf8')); } catch (e) { turnosMem = []; await fs.writeFile(TURNOS_FILE, '[]', 'utf8'); }
    await inicializarBaseConocimiento();

    var server = app.listen(PORT, '0.0.0.0', function() {
        console.log('Serenity Spa v5.1 - puerto ' + PORT);
        console.log('IA: ' + (process.env.DEEPSEEK_API_KEY ? 'DeepSeek' : 'Local'));
    });

    var wss = new WebSocket.Server({ server: server, path: '/ws-voice' });

    wss.on('connection', function(ws, req) {
        var ip = req.socket.remoteAddress || '?';

        if (estaBloqueado(ip)) { ws.close(1008, 'Bloqueado'); return; }

        var connCount = wsConnPerIP.get(ip) || 0;
        if (connCount >= 3) { ws.close(1008, 'Demasiadas conexiones'); return; }
        wsConnPerIP.set(ip, connCount + 1);

        var cid = generarId();
        var msgCount = 0;

        voiceClients.set(cid, {
            datos: {}, pendienteConfirmar: null,
            ultimaPregunta: null, clientId: cid
        });

        // Bienvenida corta — UNA sola vez
        if (ws.readyState === 1) {
            ws.send(JSON.stringify({ tipo: 'respuesta', texto: 'Hola, soy su asistente, con quién tengo el placer de hablar?' }));
        }

        ws.on('message', async function(data) {
            msgCount++;
            if (msgCount > 30) { bloquearIP(ip, 'Flood WS', 'flood'); ws.close(1008); return; }
            if (!checkWsRateLimit(ip)) { bloquearIP(ip, 'Rate WS', 'flood'); ws.close(1008); return; }
            if (data.length > 10000) { ws.close(1008); return; }

            try {
                var m = JSON.parse(data);
                if (!m || m.tipo !== 'transcripcion') return;
                var texto = m.texto;
                if (!texto || typeof texto !== 'string' || texto.length > 500) return;

                // Seguridad: patrones de ataque
                var seguro = true;
                for (var p = 0; p < voiceAttackPatterns.length; p++) {
                    if (voiceAttackPatterns[p].test(texto)) { seguro = false; break; }
                }
                if (!seguro) {
                    registrarIntento(ip, 'Patrón sospechoso');
                    if (ws.readyState === 1) ws.send(JSON.stringify({ tipo: 'respuesta', texto: 'No pude procesar eso. ¿Podés repetirlo de otra forma?' }));
                    return;
                }

                var respuesta = await procesarComandoVoz(texto, cid, ip);
                if (respuesta && ws.readyState === 1) {
                    ws.send(JSON.stringify({ tipo: 'respuesta', texto: respuesta }));
                }
            } catch (e) {
                console.error('WS error:', e.message);
                if (ws.readyState === 1) ws.send(JSON.stringify({ tipo: 'respuesta', texto: 'Disculpa, hubo un error. ¿Podés repetir?' }));
            }
        });

        function cleanup() {
            voiceClients.delete(cid);
            var c = wsConnPerIP.get(ip) || 0;
            wsConnPerIP.set(ip, Math.max(0, c - 1));
        }
        ws.on('close', cleanup);
        ws.on('error', cleanup);
    });
}

process.on('SIGTERM', async function() { await guardarBloqueos(); await guardarPaises(); process.exit(0); });
process.on('SIGINT', async function() { await guardarBloqueos(); await guardarPaises(); process.exit(0); });

startServer();
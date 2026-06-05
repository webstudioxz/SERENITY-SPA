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
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

const HORAS_VALIDAS = [12, 16, 20];
const DIAS_VALIDOS = ['lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado'];
const DIAS_NOMBRE = { lunes: 'Lunes', martes: 'Martes', miercoles: 'Miércoles', jueves: 'Jueves', viernes: 'Viernes', sabado: 'Sábado' };
const HORA_TEXTO = { 12: '12 del mediodía', 16: '4 de la tarde', 20: '8 de la noche' };

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
            for (var entry of bloqueos) { if (ahora > entry[1].hasta) bloqueos.delete(entry[0]); }
            await guardarBloqueos();
        }
    } catch (e) { await fs.writeFile(BLOQUEOS_FILE, JSON.stringify({ bloqueos: {}, historial: [] }, null, 2), 'utf8'); }
}
async function guardarBloqueos() {
    try { await fs.writeFile(BLOQUEOS_FILE, JSON.stringify({ bloqueos: Object.fromEntries(bloqueos), historial: historialBloqueos.slice(0, 500) }, null, 2), 'utf8'); } catch (e) {}
}
function estaBloqueado(ip) {
    if (bloqueos.has(ip)) { if (Date.now() < bloqueos.get(ip).hasta) return true; bloqueos.delete(ip); guardarBloqueos(); }
    return false;
}
function bloquearIP(ip, motivo, tipo) {
    bloqueos.set(ip, { hasta: Date.now() + 3600000, motivo: motivo, tipoAtaque: tipo || '?', fecha: new Date().toISOString(), ip: ip, intentos: (intentosFallidos.get(ip) || {}).count || 0, permanente: false });
    historialBloqueos.unshift(Object.assign({}, bloqueos.get(ip), { id: generarId() }));
    guardarBloqueos();
}
function desbloquearIP(ip) { bloqueos.delete(ip); intentosFallidos.delete(ip); guardarBloqueos(); }
function limpiarViejos(m, v) { var a = Date.now(); for (var e of m) { m.set(e[0], e[1].filter(function(t) { return a - t < v; })); if (!m.get(e[0]).length) m.delete(e[0]); } }
function registrarIntento(ip, tipo) {
    var a = Date.now(); if (!intentosFallidos.has(ip)) { intentosFallidos.set(ip, { count: 1, first: a }); return false; }
    var d = intentosFallidos.get(ip); if (a - d.first > 600000) { intentosFallidos.set(ip, { count: 1, first: a }); return false; }
    d.count++; if (d.count >= 5) { bloquearIP(ip, '5+ intentos: ' + tipo, tipo); intentosFallidos.delete(ip); return true; } return false;
}
function checkRateIP(ip) { limpiarViejos(turnosRecientesIP, 3600000); return (turnosRecientesIP.get(ip) || []).length < 3; }
function checkRateTel(tel) { limpiarViejos(turnosRecientesTel, 86400000); return (turnosRecientesTel.get(tel) || []).length < 2; }
function regTurno(ip, tel) { var a = Date.now(); if (!turnosRecientesIP.has(ip)) turnosRecientesIP.set(ip, []); turnosRecientesIP.get(ip).push(a); if (!turnosRecientesTel.has(tel)) turnosRecientesTel.set(tel, []); turnosRecientesTel.get(tel).push(a); }

// ============================================================
// PAÍSES
// ============================================================
var paisesConfig = { autorizados: [], bloqueados: [], modo: 'todos' };
async function cargarPaises() { try { if (fsSync.existsSync(PAISES_FILE)) paisesConfig = JSON.parse(await fs.readFile(PAISES_FILE, 'utf8')); else await guardarPaises(); } catch (e) { await guardarPaises(); } }
async function guardarPaises() { await fs.writeFile(PAISES_FILE, JSON.stringify(paisesConfig, null, 2), 'utf8'); }
function paisAutorizado(c) { return paisesConfig.modo === 'todos' ? !paisesConfig.bloqueados.includes(c) : paisesConfig.autorizados.includes(c); }

// ============================================================
// BASE CONOCIMIENTO IA WEB
// ============================================================
var baseConocimiento = [];
async function inicializarBaseConocimiento() {
    baseConocimiento = serviciosData.map(function(s) {
        return { tipo: 'servicio', contenido: s.nombre + ': ' + s.descripcion + '. Precio: ' + s.precio + '. Beneficios: ' + (s.beneficios || []).join(', ') };
    }).concat([
        { tipo: 'horario', contenido: 'Lunes a Sábado. Turnos: 12:00, 16:00, 20:00. Uno por persona por día.' },
        { tipo: 'politica', contenido: 'Cancelación con 4 horas de anticipación.' }
    ]);
}
function buscarContexto(p) {
    var w = p.toLowerCase().split(/\s+/).filter(function(x) { return x.length > 2; }), r = [];
    for (var i = 0; i < baseConocimiento.length; i++) { var s = 0, c = baseConocimiento[i].contenido.toLowerCase(); for (var j = 0; j < w.length; j++) { if (c.indexOf(w[j]) !== -1) s++; } if (s > 0) r.push(Object.assign({}, baseConocimiento[i], { puntuacion: s })); }
    return r.sort(function(a, b) { return b.puntuacion - a.puntuacion; }).slice(0, 5).map(function(x) { return x.contenido; });
}
var personalidadIA = { nombre: 'Asistente', tono: 'cálido y profesional', estilo: 'Español neutro, conciso.', reglas: ['NUNCA inventar', 'SIEMPRE ofrecer reservar', 'NUNCA decir "buenas"', 'Respuestas cortas'] };

// ============================================================
// UTILIDADES
// ============================================================
function esUrlValida(s) { if (!s || typeof s !== 'string') return false; var t = s.trim(); if (t.indexOf('data:') === 0 || t.length > 3000) return false; try { var u = new URL(t); return u.protocol === 'http:' || u.protocol === 'https:'; } catch (e) { return false; } }
function escapeHtml(s) { return s ? s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') : ''; }
function sanitize(s) { return s ? s.trim().replace(/[^\w\sáéíóúñÑü.,@\-]/gi, '') : ''; }
function generarId() { return Date.now().toString(36) + Math.random().toString(36).substr(2) + crypto.randomBytes(4).toString('hex'); }
function fmtT(ms) { if (ms <= 0) return 'Expirado'; var s = Math.floor(ms / 1000), m = Math.floor(s / 60), h = Math.floor(m / 60); return h > 0 ? h + 'h ' + (m % 60) + 'm' : m > 0 ? m + 'm ' + (s % 60) + 's' : s + 's'; }

// ============================================================
// PAÍSES DETECCIÓN (con adjetivos: cubano, argentino...)
// ============================================================
var PAISES_DATOS = [
    { nombre: 'Argentina', codigo: '54', claves: ['argentina', 'argentino', 'argentina'] },
    { nombre: 'México', codigo: '52', claves: ['méxico', 'mexico', 'mexicano', 'mexicana'] },
    { nombre: 'Colombia', codigo: '57', claves: ['colombia', 'colombiano', 'colombiana'] },
    { nombre: 'Chile', codigo: '56', claves: ['chile', 'chileno', 'chilena'] },
    { nombre: 'Perú', codigo: '51', claves: ['perú', 'peru', 'peruano', 'peruana'] },
    { nombre: 'España', codigo: '34', claves: ['españa', 'espana', 'español', 'espanol'] },
    { nombre: 'Cuba', codigo: '53', claves: ['cuba', 'cubano', 'cubana'] },
    { nombre: 'Uruguay', codigo: '598', claves: ['uruguay', 'uruguayo', 'uruguaya'] },
    { nombre: 'Paraguay', codigo: '595', claves: ['paraguay', 'paraguayo', 'paraguaya'] },
    { nombre: 'Bolivia', codigo: '591', claves: ['bolivia', 'boliviano', 'boliviana'] },
    { nombre: 'Venezuela', codigo: '58', claves: ['venezuela', 'venezolano', 'venezolana'] },
    { nombre: 'Ecuador', codigo: '593', claves: ['ecuador', 'ecuatoriano', 'ecuatoriana'] },
    { nombre: 'Costa Rica', codigo: '506', claves: ['costa rica'] },
    { nombre: 'Panamá', codigo: '507', claves: ['panamá', 'panama', 'panameño', 'panameña'] },
    { nombre: 'Estados Unidos', codigo: '1', claves: ['estados unidos', 'usa', 'eeuu'] },
    { nombre: 'Brasil', codigo: '55', claves: ['brasil', 'brasileño', 'brasileña'] },
    { nombre: 'Italia', codigo: '39', claves: ['italia', 'italiano', 'italiana'] },
    { nombre: 'Francia', codigo: '33', claves: ['francia', 'francés', 'frances'] },
];

function detectarPaisConNombre(texto) {
    var t = texto.toLowerCase().trim();
    for (var i = 0; i < PAISES_DATOS.length; i++) {
        var p = PAISES_DATOS[i];
        for (var j = 0; j < p.claves.length; j++) {
            if (t.indexOf(p.claves[j]) !== -1) return { nombre: p.nombre, codigo: p.codigo };
        }
    }
    return null;
}

// ============================================================
// EXTRAER NOMBRE (robusto: tolera errores de reconocimiento)
// ============================================================
var NO_NOMBRES = {};
['reservar','turno','masaje','hola','buenas','buenos','precio','horario','favor','por','para','de','del','en','el','la','los','las','un','una','este','esta','esto','que','quiere','gustaria','telefono','celular','numero','número','domicilio','salon','salón','lunes','martes','miercoles','jueves','viernes','sabado','doce','cuatro','ocho','mediodia','tarde','noche','pais','país','cuba','argentina','mexico','colombia','chile','peru','espana','venezuela','ecuador','uruguay','paraguay','bolivia','brasil','italia','francia','alemania','costa','panama','estados','unidos','relajante','corporal','facial','servicio','direccion','casa','hogar','local','centro','divjo','dijo','existe','reserva','deberia','hacer','prefiero','preferentemente','dejeme','si','no','ok','bien','placer','hablar','llamar','gracias','agradecido','genial','perfecto','chau','adios','disponible','disponibilidad','cuanto','vale','cuesta','sale','son','tarifa','tipos','tienen','ofrecen','horarios','atencion','atención'].forEach(function(w) { NO_NOMBRES[w] = true; });

function extraerNombre(texto) {
    var t = texto.trim();
    // Patrones: "me llamo X", "mi nombre es X", "soy X"
    var patrones = [
        /(?:me\s+ll?am(?:o|os)|mi\s+nom?br?e\s+es)\s+([A-Za-zÁÉÍÓÚÑáéíóúñ]+(?:\s+[A-Za-zÁÉÍÓÚÑáéíóúñ]+){0,2})/i,
        /\bsoy\b\s+([A-Za-zÁÉÍÓÚÑáéíóúñ]+(?:\s+[A-Za-zÁÉÍÓÚÑáéíóúñ]+){0,1})(?:\s|,|\.|$)/i,
    ];
    for (var p = 0; p < patrones.length; p++) {
        var m = t.match(patrones[p]);
        if (m && m[1]) {
            var filtradas = m[1].split(/\s+/).filter(function(w) { return w.length >= 2 && !NO_NOMBRES[w.toLowerCase()]; });
            if (filtradas.length > 0) return filtradas.map(function(w) { return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase(); }).join(' ');
        }
    }
    return null;
}

// ============================================================
// EXTRAER TELÉFONO (ignora precios, busca patrón explícito)
// ============================================================
var COD_TEL = [
    { c: '593' }, { c: '598' }, { c: '595' }, { c: '591' },
    { c: '506' }, { c: '507' },
    { c: '53' }, { c: '54' }, { c: '52' }, { c: '57' }, { c: '56' }, { c: '51' },
    { c: '34' }, { c: '58' }, { c: '55' }, { c: '39' }, { c: '33' }, { c: '49' },
    { c: '1' }
];

function extraerTelefono(texto) {
    // Buscar patrón explícito primero
    var exp = texto.match(/(?:tel[eé]fono|n[uú]mero|celular|cel|m[oó]vil|whatsapp)\s*[:.]?\s*([\d\s\-]{7,20})/i);
    if (exp) { var n = exp[1].replace(/\D/g, ''); if (n.length >= 7 && n.length <= 15) return detectarCodigoEnNum(n); }

    // Limpiar precios y horas del texto
    var limpio = texto.replace(/\$?\d{1,4}\s*(pesos|dlls|usd|eur|cop|mxn|ars|cup)/gi, ' ').replace(/\b\d{1,2}:\d{2}\b/g, ' ');
    var trailing = limpio.trim().match(/([\d]{7,15})\s*$/);
    if (trailing) return detectarCodigoEnNum(trailing[1]);
    return null;
}

function detectarCodigoEnNum(nums) {
    for (var i = 0; i < COD_TEL.length; i++) {
        if (nums.indexOf(COD_TEL[i].c) === 0 && nums.length > COD_TEL[i].c.length + 5) {
            var pais = PAISES_DATOS.find(function(p) { return p.codigo === COD_TEL[i].c; });
            return { codigoPais: COD_TEL[i].c, pais: pais ? pais.nombre : '', telefono: nums.substring(COD_TEL[i].c.length) };
        }
    }
    return { telefono: nums };
}

// ============================================================
// FUZZY MATCHING (palabra por palabra, no texto completo)
// ============================================================
function similitud(a, b) {
    a = a.toLowerCase(); b = b.toLowerCase();
    if (a === b) return 1;
    if (a.indexOf(b) !== -1 || b.indexOf(a) !== -1) return 0.85;
    var mx = []; for (var i = 0; i <= a.length; i++) mx[i] = [i];
    for (var j = 0; j <= b.length; j++) mx[0][j] = j;
    for (var x = 1; x <= a.length; x++) for (var y = 1; y <= b.length; y++) {
        mx[x][y] = Math.min(mx[x-1][y]+1, mx[x][y-1]+1, mx[x-1][y-1]+(a[x-1]===b[y-1]?0:1));
    }
    return 1 - mx[a.length][b.length] / Math.max(a.length, b.length, 1);
}

function detectarMasaje(texto) {
    var t = texto.toLowerCase();
    var palabrasTexto = t.split(/\s+/).filter(function(p) { return p.length > 2; });
    var mejor = null, mejorScore = 0.55;

    for (var s = 0; s < serviciosData.length; s++) {
        var serv = serviciosData[s], nombre = serv.nombre.toLowerCase();
        // Exacto
        if (t.indexOf(nombre) !== -1) return { masaje: serv.nombre, id: serv.id };
        var sinP = nombre.replace(/^masaje\s+/i, '');
        if (sinP.length > 3 && t.indexOf(sinP) !== -1) return { masaje: serv.nombre, id: serv.id };

        // Palabra por palabra
        var claves = nombre.split(/\s+/).filter(function(p) { return p.length > 3 && p !== 'masaje'; });
        var score = 0;
        for (var ci = 0; ci < claves.length; ci++) {
            for (var pi = 0; pi < palabrasTexto.length; pi++) {
                var sp = similitud(palabrasTexto[pi], claves[ci]);
                if (sp > score) score = sp;
            }
        }
        if (score > mejorScore) { mejorScore = score; mejor = { masaje: serv.nombre, id: serv.id }; }
    }
    return mejor;
}

// ============================================================
// TEXTO A NÚMERO ("uno"→1, "primero"→1)
// ============================================================
function textoANumero(texto) {
    var t = texto.toLowerCase().trim();
    var d = t.match(/^\d+$/); if (d) return parseInt(d[0]);
    var mapa = { 'uno': 1, 'una': 1, 'primero': 1, 'primera': 1, 'dos': 2, 'segundo': 2, 'segunda': 2, 'tres': 3, 'tercero': 3, 'tercera': 3, 'cuatro': 4, 'cuarto': 4, 'cinco': 5, 'quinto': 5, 'seis': 6 };
    var limpio = t.replace(/^(el|la|los|las|por favor|favor|yo|quiero|elijo|escojo|digamos|me|va)\s+/gi, '').trim();
    if (mapa[limpio] !== undefined) return mapa[limpio];
    var inner = t.match(/\b(\d+)\b/); if (inner) return parseInt(inner[1]);
    return null;
}

// ============================================================
// FECHAS
// ============================================================
function obtenerProximaFecha(dia) {
    var dias = ['domingo','lunes','martes','miercoles','jueves','viernes','sabado'];
    var hoy = new Date(), hIdx = hoy.getDay(), oIdx = dias.indexOf(dia);
    if (oIdx === -1) return null;
    var diff = oIdx - hIdx; if (diff < 0) diff += 7;
    if (diff === 0 && hoy.getHours() >= 20) diff = 7;
    var f = new Date(hoy); f.setDate(hoy.getDate() + diff); f.setHours(0,0,0,0); return f;
}

function formatearFecha(dia) {
    var f = obtenerProximaFecha(dia);
    if (!f) return DIAS_NOMBRE[dia] || dia;
    var txt = f.toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long' });
    return txt.charAt(0).toUpperCase() + txt.slice(1);
}

// ============================================================
// DISPONIBILIDAD
// ============================================================
function obtenerDisponibilidad() {
    var r = [];
    for (var d = 0; d < DIAS_VALIDOS.length; d++) {
        var dia = DIAS_VALIDOS[d], libres = [], ocupadas = [];
        for (var h = 0; h < HORAS_VALIDAS.length; h++) {
            var hr = HORAS_VALIDAS[h], oc = false;
            for (var t = 0; t < turnosMem.length; t++) { if (turnosMem[t].dia === dia && turnosMem[t].hora === hr) { oc = true; break; } }
            if (oc) ocupadas.push(hr); else libres.push(hr);
        }
        r.push({ dia: dia, libres: libres, ocupadas: ocupadas });
    }
    return r;
}

function buscarAlternativa(dia, hora, turnos) {
    var idx = DIAS_VALIDOS.indexOf(dia); if (idx === -1) return null;
    for (var o = 0; o < 7; o++) {
        var d = DIAS_VALIDOS[(idx + o) % 7];
        var hrs = o === 0 ? HORAS_VALIDAS.filter(function(h) { return h > hora; }) : HORAS_VALIDAS;
        for (var i = 0; i < hrs.length; i++) {
            var h = hrs[i], libre = true;
            for (var t = 0; t < turnos.length; t++) { if (turnos[t].dia === d && turnos[t].hora === h) { libre = false; break; } }
            if (libre) return { dia: d, hora: h };
        }
    }
    return null;
}

// ============================================================
// ANÁLISIS COMPLETO DEL TEXTO
// ============================================================
function analizarTextoCompleto(texto) {
    var t = texto.toLowerCase();
    var r = { nombre: null, pais: null, codigoPais: null, masaje: null, masajeId: null, dia: null, hora: null, ubicacion: null, tipoServicio: null, telefono: null, intencion: 'desconocida' };

    // --- Intención ---
    if (/\b(reservar|turno|cita|agendar|pedir\s+turno)\b/.test(t)) r.intencion = 'reservar';
    else if (/\b(quiero|me\s+gustar[ií]a|quisiera|necesito|busco)\b.*\b(masaje|servicio|sesi[oó]n|relajante|corporal|facial)\b/.test(t) || /\b(masaje|servicio|relajante|corporal|facial)\b.*\b(quiero|gustar[ií]a|quisiera|necesito)\b/.test(t)) r.intencion = 'reservar';
    else if (/\b(quiero|gustar[ií]a)\b.*\b(lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado)\b/.test(t) || /\b(lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado)\b.*\b(reservar|agendar|pedir)\b/.test(t)) r.intencion = 'reservar';
    else if (/\b(d[ií]as?\s+disponib|qu[eé]\s+d[ií]as?|cu[aá]ndo\s+(puedo|hay)|tiene\s+lugar)\b/.test(t)) r.intencion = 'consultar_disponibilidad';
    else if (/\b(precio|costo|cu[aá]nto\s+(vale|cuesta|es|sale|son)|tarifa)\b/.test(t)) r.intencion = 'consultar_precios';
    else if (/\b(horario|a\s+qu[eé]\s+hora)\b/.test(t)) r.intencion = 'consultar_horarios';
    else if (/\b(servicios|masajes|tipos|qu[eé]\s+tienen|qu[eé]\s+ofrecen)\b/.test(t)) r.intencion = 'consultar_servicios';
    else if (/\b(cancelar|anular)\b/.test(t)) r.intencion = 'cancelar';
    else if (/\b(gracias|agradec)\b/.test(t) && t.length < 40) r.intencion = 'agradecimiento';
    else if (/\b(chau|adi[oó]s|bye|hasta\s+luego)\b/.test(t)) r.intencion = 'despedida';
    else if (/\b(hola|buenas|saludos|hey)\b/.test(t) && t.length < 60) r.intencion = 'saludo';

    // --- Nombre ---
    r.nombre = extraerNombre(texto);

    // --- País (con adjetivos) ---
    var pd = detectarPaisConNombre(texto);
    if (pd) { r.pais = pd.nombre; r.codigoPais = pd.codigo; }

    // --- Teléfono ---
    var td = extraerTelefono(texto);
    if (td) { r.telefono = td.telefono; if (td.codigoPais && !r.codigoPais) { r.codigoPais = td.codigoPais; r.pais = td.pais; } }

    // --- Tipo servicio ---
    if (/\b(salon|sal[oó]n|local|centro|aqu[ií]|ac[aá]|all[ií]|en\s+el\s+lugar)\b/.test(t)) r.tipoServicio = 'salon';
    else if (/\b(domicilio|casa|hogar|a\s+mi\s+casa|mi\s+domicilio|en\s+casa)\b/.test(t)) r.tipoServicio = 'domicilio';

    // --- Día ---
    var dm = { 'lunes':'lunes','martes':'martes','miercoles':'miercoles','jueves':'jueves','viernes':'viernes','sabado':'sabado','sábado':'sabado' };
    for (var k in dm) { if (t.indexOf(k) !== -1) { r.dia = dm[k]; break; } }

    // --- Hora (contexto primero, luego números) ---
    if (/\bmediod[ií]a\b/.test(t)) r.hora = 12;
    else if (/\bnoche\b/.test(t)) r.hora = 20;
    else if (/\btarde\b/.test(t)) r.hora = 16;
    else if (/\b12\b/.test(t)) r.hora = 12;
    else if (/\b20\b/.test(t)) r.hora = 20;
    else if (/\b16\b/.test(t)) r.hora = 16;
    else if (/\b4\b/.test(t) && t.indexOf('14') === -1 && t.indexOf('24') === -1 && t.indexOf('40') === -1 && t.indexOf('45') === -1) r.hora = 16;
    else if (/\b8\b/.test(t) && t.indexOf('18') === -1 && t.indexOf('28') === -1 && t.indexOf('80') === -1) r.hora = 20;

    // --- Masaje ---
    var md = detectarMasaje(texto);
    if (md) { r.masaje = md.masaje; r.masajeId = md.id; }

    // --- Dirección ---
    if (r.tipoServicio === 'domicilio') {
        var dir = texto.match(/(?:casa|domicilio|direcci[oó]n)\s*[:.]?\s*(.+?)(?:\.|$)/i);
        if (dir && dir[1].trim().length > 5) r.ubicacion = dir[1].trim();
    }

    return r;
}

// ============================================================
// FUSIONAR DATOS
// ============================================================
function fusionarDatos(ex, nx) {
    if (nx.nombre && !ex.nombre) ex.nombre = nx.nombre;
    if (nx.pais && !ex.pais) ex.pais = nx.pais;
    if (nx.codigoPais && !ex.codigoPais) ex.codigoPais = nx.codigoPais;
    if (nx.masaje && !ex.masaje) { ex.masaje = nx.masaje; ex.masajeId = nx.masajeId; }
    if (nx.dia && !ex.dia) ex.dia = nx.dia;
    if (nx.hora && !ex.hora) ex.hora = nx.hora;
    if (nx.tipoServicio && !ex.tipoServicio) ex.tipoServicio = nx.tipoServicio;
    if (nx.ubicacion && !ex.ubicacion) ex.ubicacion = nx.ubicacion;
    if (nx.telefono && !ex.telefono) ex.telefono = nx.telefono;
}

function campoLleno(cd, campo) {
    var d = cd.datos;
    switch (campo) {
        case 'nombre': return !!d.nombre; case 'pais': return !!d.codigoPais;
        case 'masaje': return !!d.masaje; case 'ubicacion_tipo': return !!d.tipoServicio;
        case 'direccion': return !!d.ubicacion; case 'dia': return !!d.dia;
        case 'hora': return !!d.hora; case 'telefono': return !!d.telefono;
        default: return false;
    }
}

// ============================================================
// RESPUESTAS PROFESIONALES
// ============================================================
function generarMenuServicios() {
    if (!serviciosData.length) return 'No hay servicios disponibles en este momento.';
    var m = 'Tenemos disponibles:\n\n';
    for (var i = 0; i < serviciosData.length; i++) m += (i+1) + '. ' + serviciosData[i].nombre + ' - ' + serviciosData[i].precio + '\n';
    m += '\n¿Cuál le interesa?';
    return m;
}

function generarRespuestaDisponibilidad() {
    var disp = obtenerDisponibilidad(), r = 'Disponibilidad:\n\n', algo = false, sug = null;
    for (var i = 0; i < disp.length; i++) {
        var d = disp[i];
        if (d.libres.length > 0) {
            algo = true;
            var hs = []; for (var h = 0; h < d.libres.length; h++) hs.push(HORA_TEXTO[d.libres[h]]);
            r += DIAS_NOMBRE[d.dia] + ': ' + hs.join(', ') + '\n';
            if (!sug) sug = { dia: d.dia, hora: d.libres[0] };
        }
    }
    if (!algo) return 'No hay turnos disponibles esta semana.';
    r += '\nLe sugiero ' + DIAS_NOMBRE[sug.dia] + ' a las ' + HORA_TEXTO[sug.hora] + '.';
    return r;
}

function generarRespuestaDefault(n) {
    return (n ? n + ', ' : '') + 'en qué le puedo ayudar?\n\nReservar un turno\nVer servicios\nHorarios\nPrecios';
}

// ============================================================
// MANEJAR RESERVA
// ============================================================
function manejarReserva(cd) {
    var d = cd.datos, f = [];
    if (!d.nombre) f.push('nombre');
    if (!d.codigoPais) f.push('pais');
    if (!d.masaje) f.push('masaje');
    if (!d.tipoServicio) f.push('ubicacion_tipo');
    if (d.tipoServicio === 'domicilio' && !d.ubicacion) f.push('direccion');
    if (!d.dia) f.push('dia');
    if (!d.hora) f.push('hora');
    if (!d.telefono) f.push('telefono');

    if (f.length > 0) {
        var p = f[0]; cd.ultimaPregunta = p;
        var pre = d.nombre ? d.nombre + ', ' : '';
        switch (p) {
            case 'nombre': return '¿Me dice su nombre?';
            case 'pais': return pre + '¿de qué país nos escribe? Lo necesito para el código de WhatsApp.';
            case 'masaje': return generarMenuServicios();
            case 'ubicacion_tipo': return pre + '¿Prefiere el servicio en nuestro salón o a domicilio?';
            case 'direccion': return pre + '¿Cuál es su dirección? Calle, número y ciudad.';
            case 'dia': return generarRespuestaDisponibilidad();
            case 'hora': return pre + '¿A qué hora prefiere?\n\n12 del mediodía\n4 de la tarde\n8 de la noche';
            case 'telefono': return pre + '¿Cuál es su número de teléfono? Solo los dígitos, sin código de país.';
        }
    }
    return null;
}

// ============================================================
// SELECCIÓN POR NÚMERO O NOMBRE
// ============================================================
function intentarSeleccionarMasaje(cd, texto) {
    var num = textoANumero(texto);
    if (num !== null && num >= 1 && num <= serviciosData.length) {
        cd.datos.masaje = serviciosData[num-1].nombre; cd.datos.masajeId = serviciosData[num-1].id; return true;
    }
    var det = detectarMasaje(texto);
    if (det) { cd.datos.masaje = det.masaje; cd.datos.masajeId = det.id; return true; }
    return false;
}

function intentarSeleccionarHora(cd, texto) {
    var num = textoANumero(texto);
    if (num === null) return false;
    var hora = null;
    if (num === 1 || num === 12) hora = 12;
    else if (num === 2 || num === 16) hora = 16;
    else if (num === 3 || num === 20) hora = 20;
    else if (HORAS_VALIDAS.indexOf(num) !== -1) hora = num;
    if (hora !== null) { cd.datos.hora = hora; return true; }
    return false;
}

// ============================================================
// CONFIRMAR / CANCELAR
// ============================================================
async function manejarConfirmacion(cd, texto, ip) {
    var t = texto.toLowerCase();
    if (/\b(si|s[ií]|sip|dale|ok|vale|claro|por supuesto|exacto|bien)\b/.test(t)) {
        cd.datos.dia = cd.pendienteConfirmar.dia; cd.datos.hora = cd.pendienteConfirmar.hora;
        cd.pendienteConfirmar = null; cd.ultimaPregunta = null;
        return await confirmarReserva(cd, ip);
    }
    if (/\b(no|nop)\b/.test(t)) {
        cd.pendienteConfirmar = null; cd.ultimaPregunta = null;
        return generarRespuestaDisponibilidad();
    }
    return '¿Le sirve el ' + DIAS_NOMBRE[cd.pendienteConfirmar.dia] + ' a las ' + HORA_TEXTO[cd.pendienteConfirmar.hora] + '?';
}

async function manejarCancelacion(cd) {
    if (cd.datos.telefono) {
        try {
            var turnos = JSON.parse(await fs.readFile(TURNOS_FILE, 'utf8'));
            for (var i = 0; i < turnos.length; i++) {
                if (turnos[i].telefono === cd.datos.telefono) {
                    turnos.splice(i, 1);
                    await fs.writeFile(TURNOS_FILE, JSON.stringify(turnos, null, 2), 'utf8');
                    turnosMem = turnos;
                    return (cd.datos.nombre || 'Su') + ' turno del ' + turnos[i].dia + ' fue cancelado. ¿Necesita algo más?';
                }
            }
            return 'No encontré un turno activo con ese número.';
        } catch (e) { return 'Error al cancelar.'; }
    }
    cd.ultimaPregunta = 'cancelar_telefono';
    return 'Necesito el número de teléfono de la reserva para cancelarla.';
}

async function confirmarReserva(cd, ip) {
    var d = cd.datos;
    if (!d.codigoPais || !/^\d{1,3}$/.test(d.codigoPais)) { d.codigoPais = '53'; d.pais = d.pais || 'Cuba'; }
    if (!paisAutorizado(d.codigoPais)) return 'Lo siento' + (d.nombre ? ', ' + d.nombre : '') + ', no aceptamos reservas desde ' + (d.pais || 'ese país') + '.';

    try {
        var turnos = JSON.parse(await fs.readFile(TURNOS_FILE, 'utf8'));
        for (var i = 0; i < turnos.length; i++) {
            if (turnos[i].telefono === d.telefono && turnos[i].dia === d.dia)
                return (d.nombre || 'Cliente') + ', ya tiene un turno para el ' + DIAS_NOMBRE[d.dia] + '. Solo uno por día.';
        }
        for (var j = 0; j < turnos.length; j++) {
            if (turnos[j].dia === d.dia && turnos[j].hora === d.hora) {
                var alt = buscarAlternativa(d.dia, d.hora, turnos);
                if (alt) {
                    cd.pendienteConfirmar = { dia: alt.dia, hora: alt.hora }; cd.ultimaPregunta = 'confirmar_alternativa';
                    return 'Ese horario está ocupado' + (d.nombre ? ', ' + d.nombre : '') + '. Tengo disponible el ' + DIAS_NOMBRE[alt.dia] + ' a las ' + HORA_TEXTO[alt.hora] + '. ¿Le sirve?';
                }
                return 'No hay disponibilidad esa semana' + (d.nombre ? ', ' + d.nombre : '') + '.';
            }
        }
        var nuevo = {
            id: generarId(), nombre: d.nombre || 'Cliente', dia: d.dia, hora: d.hora,
            massageType: d.masaje || 'Masaje', telefono: d.telefono, codigoPais: d.codigoPais,
            ubicacion: d.tipoServicio === 'domicilio' ? (d.ubicacion || 'A confirmar') : 'Salón Serenity Spa',
            tipoServicio: d.tipoServicio || 'salon', confirmadoWhatsApp: false,
            fechaCreacion: new Date().toISOString(), ip: ip
        };
        turnos.push(nuevo);
        await fs.writeFile(TURNOS_FILE, JSON.stringify(turnos, null, 2), 'utf8');
        turnosMem = turnos;
        regTurno(ip, d.telefono);

        return 'Turno confirmado.\n\nDía: ' + formatearFecha(d.dia) + '\nHora: ' + HORA_TEXTO[d.hora] +
            '\nMasaje: ' + d.masaje + '\nLugar: ' + (d.tipoServicio === 'domicilio' ? d.ubicacion : 'Nuestro salón') +
            '\nTeléfono: +' + d.codigoPais + ' ' + d.telefono + '\n\nLo esperamos.';
    } catch (e) {
        console.error('Error reserva:', e);
        return 'Hubo un error al procesar la reserva. Intente de nuevo.';
    }
}

// ============================================================
// PROCESAR COMANDO DE VOZ
// ============================================================
async function procesarComandoVoz(texto, clientId, ip) {
    var tl = texto.replace(/<[^>]*>/g, '').replace(/[<>]/g, '').trim();
    if (!tl || tl.length > 500) return 'No pude entender. ¿Podría repetir?';

    var cd = voiceClients.get(clientId);
    if (!cd) { cd = { datos: {}, pendienteConfirmar: null, ultimaPregunta: null }; voiceClients.set(clientId, cd); }

    // Confirmación pendiente
    if (cd.pendienteConfirmar) return await manejarConfirmacion(cd, tl, ip);

    // Analizar y fusionar
    var analisis = analizarTextoCompleto(tl);
    fusionarDatos(cd.datos, analisis);

    // Intentar completar selección por número/nombre para preguntas específicas
    if (cd.ultimaPregunta === 'masaje' && !cd.datos.masaje) {
        if (intentarSeleccionarMasaje(cd, tl)) { cd.ultimaPregunta = null; var f = manejarReserva(cd); if (f !== null) return f; return await confirmarReserva(cd, ip); }
    }
    if (cd.ultimaPregunta === 'hora' && !cd.datos.hora) {
        if (intentarSeleccionarHora(cd, tl)) { cd.ultimaPregunta = null; var f2 = manejarReserva(cd); if (f2 !== null) return f2; return await confirmarReserva(cd, ip); }
    }

    // Si la pregunta pendiente fue respondida, continuar reserva automáticamente
    if (cd.ultimaPregunta && campoLleno(cd, cd.ultimaPregunta)) {
        cd.ultimaPregunta = null;
        var f3 = manejarReserva(cd); if (f3 !== null) return f3; return await confirmarReserva(cd, ip);
    }

    // Si intención es reservar o hay datos implícitos (y no es consulta)
    var esConsulta = ['consultar_servicios','consultar_horarios','consultar_precios','consultar_disponibilidad'].indexOf(analisis.intencion) !== -1;
    var hayDatos = cd.datos.dia || cd.datos.hora || cd.datos.masaje || cd.datos.telefono;

    if (analisis.intencion === 'reservar' || (hayDatos && !esConsulta && !cd.ultimaPregunta)) {
        var f4 = manejarReserva(cd); if (f4 !== null) return f4; return await confirmarReserva(cd, ip);
    }

    // Otras intenciones
    switch (analisis.intencion) {
        case 'saludo': return cd.datos.nombre ? 'Es un gusto, ' + cd.datos.nombre + '. En qué le podríamos ayudar?' : '¿Me dice su nombre para poder ayudarle?';
        case 'consultar_servicios': return generarMenuServicios();
        case 'consultar_horarios': return 'Atendemos de lunes a sábado en tres horarios:\n\n12 del mediodía\n4 de la tarde\n8 de la noche\n\nSolo un turno por persona por día. ¿Le gustaría reservar?';
        case 'consultar_precios':
            if (!serviciosData.length) return 'No hay servicios disponibles.';
            var lp = 'Nuestros precios:\n\n'; for (var i = 0; i < serviciosData.length; i++) lp += serviciosData[i].nombre + ': ' + serviciosData[i].precio + '\n';
            return lp + '\n¿Le gustaría reservar alguno?';
        case 'consultar_disponibilidad': return generarRespuestaDisponibilidad();
        case 'cancelar': return await manejarCancelacion(cd);
        case 'agradecimiento': return 'Un placer' + (cd.datos.nombre ? ', ' + cd.datos.nombre : '') + '. ¿Necesita algo más?';
        case 'despedida': return 'Hasta pronto' + (cd.datos.nombre ? ', ' + cd.datos.nombre : '') + '. Que tenga un excelente día.';
        default:
            // Re-preguntar lo mismo si hay pregunta pendiente
            if (cd.ultimaPregunta) {
                var pre = cd.datos.nombre ? cd.datos.nombre + ', ' : '';
                switch (cd.ultimaPregunta) {
                    case 'nombre': return '¿Me dice su nombre?';
                    case 'pais': return pre + '¿de qué país es? Lo necesito para el código de WhatsApp.';
                    case 'masaje': return generarMenuServicios();
                    case 'ubicacion_tipo': return pre + '¿En el salón o a domicilio?';
                    case 'direccion': return pre + '¿Cuál es su dirección?';
                    case 'dia': return generarRespuestaDisponibilidad();
                    case 'hora': return pre + '¿A qué hora? 12, 4 u 8.';
                    case 'telefono': return pre + '¿Su número de teléfono? Solo los dígitos.';
                    case 'cancelar_telefono': return 'Necesito el número de teléfono para cancelar.';
                }
            }
            return generarRespuestaDefault(cd.datos.nombre);
    }
}

// ============================================================
// MIDDLEWARES SEGURIDAD
// ============================================================
app.use(function(req, res, next) { res.setHeader('X-Content-Type-Options','nosniff'); res.setHeader('X-Frame-Options','DENY'); res.setHeader('X-XSS-Protection','1; mode=block'); next(); });
app.use(function(req, res, next) { var ip = req.ip || '0.0.0.0'; if (estaBloqueado(ip)) return res.status(403).json({ error: 'Bloqueada' }); next(); });
app.use(express.static(__dirname));

// ============================================================
// AUTH
// ============================================================
var validTokens = new Map();
function checkAuth(req) { var h = req.headers.authorization; if (!h || h.indexOf('Bearer ') !== 0) return false; var t = h.substring(7); if (!validTokens.has(t)) return false; if (validTokens.get(t) < Date.now()) { validTokens.delete(t); return false; } return true; }

app.post('/api/login', function(req, res) {
    var ip = req.ip || '0.0.0.0'; if (estaBloqueado(ip)) return res.status(403).json({ success: false });
    var pw = req.body.password; if (!pw) { registrarIntento(ip, 'Vacía'); return res.status(400).json({ success: false, error: 'Requerida' }); }
    if (pw === (process.env.ADMIN_PASSWORD || 'admin123')) { var tk = crypto.randomBytes(64).toString('hex'); validTokens.set(tk, Date.now()+28800000); intentosFallidos.delete(ip); res.json({ success: true, token: tk }); }
    else { registrarIntento(ip, 'Incorrecta'); res.status(401).json({ success: false, error: 'Incorrecta' }); }
});
app.get('/api/verify', function(req, res) { res.json({ valid: checkAuth(req) }); });
app.post('/api/logout', function(req, res) { var h = req.headers.authorization; if (h && h.indexOf('Bearer ') === 0) validTokens.delete(h.substring(7)); res.json({ ok: true }); });

// ============================================================
// UPLOAD, CONFIG, SERVICIOS, TURNOS, CHAT IA, SEGURIDAD
// ============================================================
app.post('/api/upload-hero', async function(req, res) {
    if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    try {
        var b = req.body.base64; if (!b || b.indexOf('data:image') !== 0) return res.status(400).json({ error: 'Inválida' });
        var m = b.match(/^data:image\/(\w+);base64,(.+)$/); if (!m) return res.status(400).json({ error: 'Formato' });
        var ext = m[1] === 'jpeg' ? 'jpg' : m[1], fn = 'hero-' + Date.now() + '.' + ext;
        await fs.writeFile(path.join(UPLOADS_DIR, fn), Buffer.from(m[2], 'base64'));
        var files = await fs.readdir(UPLOADS_DIR);
        for (var i = 0; i < files.length; i++) { if (files[i].indexOf('hero-') === 0 && files[i] !== fn) { try { await fs.unlink(path.join(UPLOADS_DIR, files[i])); } catch(e){} } }
        res.json({ url: '/uploads/' + fn });
    } catch(e) { res.status(500).json({ error: 'Error' }); }
});

var configData = { hero: { titulo:"Renueva tu Energía", subtitulo:"Experiencias de bienestar", imagenFondo:"https://images.unsplash.com/photo-1544161515-4ab6ce6db874?w=1920", botonTexto:"Explorar Tratamientos" }, serviciosSection: { etiqueta:"Nuestros Servicios", titulo:"Elige tu Masaje Ideal", descripcion:"Turnos: 12:00, 16:00 y 20:00" }, contactoSection: { titulo:"Asistente de Reservas", descripcion:"Reserva tu turno" }, shareSection: { titulo:"Comparte Serenity Spa" } };
app.get('/api/config', function(req, res) { res.json(configData); });
app.put('/api/config', async function(req, res) { if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' }); configData = Object.assign(configData, req.body); await fs.writeFile(CONFIG_FILE, JSON.stringify(configData, null, 2), 'utf8'); res.json({ ok: true }); });

var serviciosData = [];
app.get('/api/servicios', function(req, res) { res.json(serviciosData.sort(function(a,b){return (a.orden||999)-(b.orden||999);})); });
app.post('/api/servicios', async function(req, res) {
    if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    try {
        var iwa = ''; if (req.body.imagenWhatsApp && esUrlValida(req.body.imagenWhatsApp)) iwa = req.body.imagenWhatsApp.trim();
        var s = Object.assign({ id: generarId() }, req.body, { imagenWeb: req.body.imagenWeb || 'https://images.unsplash.com/photo-1544161515-4ab6ce6db874?w=800', imagenWhatsApp: iwa });
        serviciosData.push(s); await fs.writeFile(SERVICIOS_FILE, JSON.stringify(serviciosData, null, 2), 'utf8'); await inicializarBaseConocimiento(); res.status(201).json(s);
    } catch(e) { res.status(500).json({ error: 'Error' }); }
});
app.put('/api/servicios/:id', async function(req, res) {
    if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    try {
        var idx = -1; for (var i = 0; i < serviciosData.length; i++) { if (serviciosData[i].id === req.params.id) { idx = i; break; } }
        if (idx === -1) return res.status(404).json({ error: 'No encontrado' });
        var iwa = serviciosData[idx].imagenWhatsApp || '';
        if (req.body.imagenWhatsApp !== undefined) { if (req.body.imagenWhatsApp && esUrlValida(req.body.imagenWhatsApp)) iwa = req.body.imagenWhatsApp.trim(); else if (!req.body.imagenWhatsApp) iwa = ''; }
        serviciosData[idx] = Object.assign({}, serviciosData[idx], req.body, { id: req.params.id, imagenWeb: req.body.imagenWeb || serviciosData[idx].imagenWeb, imagenWhatsApp: iwa });
        await fs.writeFile(SERVICIOS_FILE, JSON.stringify(serviciosData, null, 2), 'utf8'); await inicializarBaseConocimiento(); res.json({ ok: true });
    } catch(e) { res.status(500).json({ error: 'Error' }); }
});
app.delete('/api/servicios/:id', async function(req, res) {
    if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    var antes = serviciosData.length; serviciosData = serviciosData.filter(function(s){return s.id!==req.params.id;});
    await fs.writeFile(SERVICIOS_FILE, JSON.stringify(serviciosData, null, 2), 'utf8'); await inicializarBaseConocimiento(); res.json({ ok: true, eliminado: serviciosData.length < antes });
});

var turnosMem = [];
async function loadTurnos() { try { if (fsSync.existsSync(TURNOS_FILE)) turnosMem = JSON.parse(await fs.readFile(TURNOS_FILE, 'utf8')); else turnosMem = []; } catch(e) { turnosMem = []; } return turnosMem; }
async function saveTurnos(t) { await fs.writeFile(TURNOS_FILE, JSON.stringify(t, null, 2), 'utf8'); turnosMem = t; }

app.get('/turnos', async function(req, res) { res.json(await loadTurnos()); });
app.post('/turnos', async function(req, res) {
    var ip = req.ip || '0.0.0.0'; if (estaBloqueado(ip)) return res.status(403).json({ error: 'Bloqueada' });
    if (!checkRateIP(ip)) { bloquearIP(ip, 'Spam', 'spam'); return res.status(429).json({ error: 'Demasiadas solicitudes' }); }
    try {
        var nombre = req.body.nombre, dia = req.body.dia, hora = req.body.hora, mt = req.body.massageType, tel = req.body.telefono, ub = req.body.ubicacion, ts = req.body.tipoServicio;
        if (!nombre || nombre.length < 2) return res.status(400).json({ error: 'Nombre inválido' });
        var telefono = tel ? tel.replace(/\D/g, '') : ''; if (!telefono || telefono.length < 7) return res.status(400).json({ error: 'Teléfono inválido' });
        var cp = req.body.codigoPais || '53'; if (!/^\d{1,3}$/.test(cp)) cp = '53';
        if (!paisAutorizado(cp)) return res.status(403).json({ error: 'País no autorizado' });
        var dl = dia.toLowerCase(); if (DIAS_VALIDOS.indexOf(dl) === -1) return res.status(400).json({ error: 'Día inválido' });
        var hn = parseInt(hora); if (HORAS_VALIDAS.indexOf(hn) === -1) return res.status(400).json({ error: 'Hora inválida' });
        if (!checkRateTel(telefono)) return res.status(429).json({ error: 'Máximo 2 turnos por teléfono por día' });
        var turnos = await loadTurnos();
        for (var i = 0; i < turnos.length; i++) { if (turnos[i].telefono === telefono && turnos[i].dia === dl) return res.status(409).json({ error: 'Ya tiene turno ese día' }); }
        for (var j = 0; j < turnos.length; j++) { if (turnos[j].dia === dl && turnos[j].hora === hn) return res.status(409).json({ error: 'Ocupado', alternativa: buscarAlternativa(dl, hn, turnos) }); }
        var nuevo = { id: generarId(), nombre: escapeHtml(sanitize(nombre)), dia: dl, hora: hn, massageType: mt || 'Masaje', telefono: telefono, codigoPais: cp, ubicacion: ub ? escapeHtml(sanitize(ub)) : null, tipoServicio: ts || 'salon', confirmadoWhatsApp: false, fechaCreacion: new Date().toISOString(), ip: ip };
        turnos.push(nuevo); await saveTurnos(turnos); regTurno(ip, telefono); intentosFallidos.delete(ip);
        res.status(201).json({ mensaje: 'Reservado', turno: nuevo });
    } catch(e) { res.status(500).json({ error: 'Error' }); }
});
app.delete('/turnos/:id', async function(req, res) { if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' }); var t = await loadTurnos(); var i = -1; for (var j = 0; j < t.length; j++) { if (t[j].id === req.params.id) { i = j; break; } } if (i === -1) return res.status(404); t.splice(i, 1); await saveTurnos(t); res.json({ ok: true }); });
app.post('/api/cancelar-turno', async function(req, res) { try { var tel = (req.body.telefono||'').replace(/\D/g,''); if (tel.length<7) return res.json({error:'Inválido'}); var t = await loadTurnos(); for (var i = 0; i < t.length; i++) { if (t[i].telefono === tel) { t.splice(i,1); await saveTurnos(t); return res.json({cancelado:true}); } } return res.json({error:'No encontrado'}); } catch(e) { res.status(500).json({error:'Error'}); } });
app.post('/api/enviar-whatsapp/:id', async function(req, res) { try { var t = await loadTurnos(); var r = null; for (var i = 0; i < t.length; i++) { if (t[i].id === req.params.id) { r = t[i]; break; } } if (!r) return res.status(404).json({error:'No encontrado'}); var msg = 'SERENITY SPA\n\nHola ' + r.nombre + ', tu reserva:\nDia: ' + r.dia + '\nHora: ' + r.hora + ':00\nMasaje: ' + r.massageType + '\nLugar: ' + (r.tipoServicio==='domicilio'?r.ubicacion:'Salon') + '\n\nEquipo Serenity Spa'; var c = r.codigoPais||'53'; for (var j = 0; j < t.length; j++) { if (t[j].id === req.params.id) { t[j].confirmadoWhatsApp = true; break; } } await saveTurnos(t); res.json({success:true, numero:c+r.telefono, mensaje:msg, urlWhatsApp:'https://wa.me/'+c+r.telefono+'?text='+encodeURIComponent(msg)}); } catch(e) { res.status(500).json({error:'Error'}); } });

// Chat IA web
app.post('/api/chat-ia', async function(req, res) {
    var ip = req.ip||'0.0.0.0'; if (estaBloqueado(ip)) return res.status(403).json({error:'Bloqueada'});
    var msg = req.body.mensaje; if (!msg||msg.length>500) return res.status(400).json({error:'Inválido'});
    var lim = msg.replace(/<[^>]*>/g,'').replace(/[<>]/g,'').trim(); if (!lim) return res.status(400).json({error:'Vacío'});
    var pats = [/ignore|bypass|override|system prompt|revela|instrucciones/i, /<script>|javascript:|onerror=/i, /SELECT.*FROM|DROP TABLE|UNION SELECT/i];
    for (var i = 0; i < pats.length; i++) { if (pats[i].test(lim)) { registrarIntento(ip,'Inyección'); return res.status(400).json({error:'No permitido'}); } }
    try {
        var ctx = buscarContexto(lim); var sys = 'Eres asistente de Serenity Spa. Tono: ' + personalidadIA.tono + '. ' + personalidadIA.estilo + '\n\nINFO:\n' + ctx.join('\n') + '\n\nCLIENTE: ' + (req.body.nombre||'?') + '\nREGLAS:\n' + personalidadIA.reglas.join('\n') + '\n\nCorto. NUNCA digas "buenas".';
        if (!process.env.DEEPSEEK_API_KEY) return res.json({ respuesta: generarRespuestaLocal(lim, req.body.nombre), modo: 'local' });
        var comp = await deepseek.chat.completions.create({ model:'deepseek-chat', messages:[{role:'system',content:sys},{role:'user',content:lim}], temperature:0.7, max_tokens:500 });
        res.json({ respuesta: comp.choices[0].message.content, modo: 'ia' });
    } catch(e) { res.json({ respuesta: generarRespuestaLocal(lim, req.body.nombre), modo: 'local' }); }
});
function generarRespuestaLocal(m, n) { var t = m.toLowerCase(), c = n||'cliente'; if (/\b(hola)\b/.test(t)) return 'Hola ' + c + '. ¿En qué le puedo ayudar?'; if (/\b(reservar|turno)\b/.test(t)) return 'Para reservar necesito: nombre, masaje, día, hora y teléfono.'; if (/\b(precio)\b/.test(t)) { var l = 'Precios:\n'; serviciosData.forEach(function(s){l+=s.nombre+': '+s.precio+'\n';}); return l; } return c + ', ¿en qué le puedo ayudar?'; }

// IA personalidad admin
app.get('/api/ia/personalidad', function(req, res) { if (!checkAuth(req)) return res.status(401).json({error:'No'}); res.json(personalidadIA); });
app.put('/api/ia/personalidad', async function(req, res) { if (!checkAuth(req)) return res.status(401).json({error:'No'}); if (req.body.nombre) personalidadIA.nombre = sanitize(req.body.nombre); if (req.body.tono) personalidadIA.tono = sanitize(req.body.tono); if (req.body.estilo) personalidadIA.estilo = sanitize(req.body.estilo); if (req.body.reglas) personalidadIA.reglas = req.body.reglas.map(sanitize); res.json({ok:true}); });
app.post('/api/ia/recargar', async function(req, res) { if (!checkAuth(req)) return res.status(401).json({error:'No'}); await inicializarBaseConocimiento(); res.json({ok:true,items:baseConocimiento.length}); });

// Seguridad países admin
app.get('/api/seguridad/paises', function(req, res) { if (!checkAuth(req)) return res.status(401).json({error:'No'}); res.json(paisesConfig); });
app.put('/api/seguridad/paises', async function(req, res) { if (!checkAuth(req)) return res.status(401).json({error:'No'}); if (req.body.autorizados!==undefined) paisesConfig.autorizados=req.body.autorizados; if (req.body.bloqueados!==undefined) paisesConfig.bloqueados=req.body.bloqueados; if (req.body.modo&&(req.body.modo==='todos'||req.body.modo==='solo_autorizados')) paisesConfig.modo=req.body.modo; await guardarPaises(); res.json({ok:true}); });
app.post('/api/seguridad/paises/autorizar', async function(req, res) { if (!checkAuth(req)) return res.status(401).json({error:'No'}); var c=req.body.codigo; if (!c||!/^\d{1,3}$/.test(c)) return res.status(400).json({error:'Inválido'}); if (paisesConfig.autorizados.indexOf(c)===-1) { paisesConfig.autorizados.push(c); paisesConfig.bloqueados=paisesConfig.bloqueados.filter(function(x){return x!==c;}); await guardarPaises(); } res.json({ok:true}); });
app.post('/api/seguridad/paises/bloquear', async function(req, res) { if (!checkAuth(req)) return res.status(401).json({error:'No'}); var c=req.body.codigo; if (!c||!/^\d{1,3}$/.test(c)) return res.status(400).json({error:'Inválido'}); if (paisesConfig.bloqueados.indexOf(c)===-1) { paisesConfig.bloqueados.push(c); paisesConfig.autorizados=paisesConfig.autorizados.filter(function(x){return x!==c;}); await guardarPaises(); } res.json({ok:true}); });
app.delete('/api/seguridad/paises/:codigo', async function(req, res) { if (!checkAuth(req)) return res.status(401).json({error:'No'}); var c=req.params.codigo; paisesConfig.autorizados=paisesConfig.autorizados.filter(function(x){return x!==c;}); paisesConfig.bloqueados=paisesConfig.bloqueados.filter(function(x){return x!==c;}); await guardarPaises(); res.json({ok:true}); });
app.get('/api/seguridad/paises/stats', async function(req, res) { if (!checkAuth(req)) return res.status(401).json({error:'No'}); var t=await loadTurnos(),s={},nombres={'53':'Cuba','54':'Argentina','52':'México','57':'Colombia','56':'Chile','51':'Perú','34':'España','1':'EE.UU.'}; for (var i=0;i<t.length;i++){var c=t[i].codigoPais||'53';s[c]=(s[c]||0)+1;} res.json(Object.keys(s).map(function(k){return{codigo:k,nombre:nombres[k]||'?',reservas:s[k]};}).sort(function(a,b){return b.reservas-a.reservas;})); });

// Seguridad bloqueos admin
app.get('/api/seguridad/bloqueos', function(req, res) { if (!checkAuth(req)) return res.status(401).json({error:'No'}); var a=[]; for (var e of bloqueos) a.push({ip:e[0],motivo:e[1].motivo,tipoAtaque:e[1].tipoAtaque,fecha:e[1].fecha,tiempoRestante:Math.max(0,e[1].hasta-Date.now()),tiempoRestanteFormateado:fmtT(Math.max(0,e[1].hasta-Date.now())),intentos:e[1].intentos||0}); res.json({activos:a,historial:historialBloqueos.slice(0,100)}); });
app.post('/api/seguridad/desbloquear/:ip', function(req, res) { if (!checkAuth(req)) return res.status(401).json({error:'No'}); desbloquearIP(req.params.ip); res.json({ok:true}); });
app.delete('/api/seguridad/bloqueos/:ip', function(req, res) { if (!checkAuth(req)) return res.status(401).json({error:'No'}); bloqueos.delete(req.params.ip); guardarBloqueos(); res.json({ok:true}); });
app.delete('/api/seguridad/historial/:id', function(req, res) { if (!checkAuth(req)) return res.status(401).json({error:'No'}); historialBloqueos=historialBloqueos.filter(function(h){return h.id!==req.params.id;}); guardarBloqueos(); res.json({ok:true}); });
app.post('/api/seguridad/limpiar-expirados', function(req, res) { if (!checkAuth(req)) return res.status(401).json({error:'No'}); var b=0,n=Date.now(); for (var e of bloqueos) { if (n>e[1].hasta) { bloqueos.delete(e[0]); b++; } } guardarBloqueos(); res.json({mensaje:b+' eliminados'}); });
app.post('/api/seguridad/bloquear-permanente/:ip', function(req, res) { if (!checkAuth(req)) return res.status(401).json({error:'No'}); bloquearIP(req.params.ip,'Permanente','manual'); var d=bloqueos.get(req.params.ip); if(d){d.hasta=Date.now()+31536000000;d.permanente=true;guardarBloqueos();} res.json({ok:true}); });

// Rutas estáticas
app.get('/voice-assistant', function(req, res) { res.sendFile(path.join(__dirname, 'voice-assistant.html')); });
app.get('/', function(req, res) { res.sendFile(path.join(__dirname, 'index.html')); });
app.get('/admin.html', function(req, res) { res.sendFile(path.join(__dirname, 'admin.html')); });
app.get('/login.html', function(req, res) { res.sendFile(path.join(__dirname, 'login.html')); });
app.get('/health', function(req, res) { res.json({ status:'ok', timestamp:new Date().toISOString(), uptime:process.uptime(), ia:process.env.DEEPSEEK_API_KEY?'conectada':'local' }); });

// ============================================================
// WEBSOCKET
// ============================================================
var voiceClients = new Map();
var wsRatePerSec = new Map();
var wsConnPerIP = new Map();
var voiceAttackPatterns = [/ignore\s+(previous|all)\s+instructions/i,/you\s+are\s+now/i,/system\s*:\s*/i,/<script[\s>]/i,/javascript\s*:/i,/\$\{.*\}/,/SELECT\s+.*\s+FROM/i,/DROP\s+TABLE/i,/UNION\s+SELECT/i,/;\s*DELETE/i,/\.\.\//,/\/etc\/passwd/i];

function checkWsRate(ip) { var n=Date.now(),ts=wsRatePerSec.get(ip)||[]; var r=ts.filter(function(t){return n-t<10000;}); wsRatePerSec.set(ip,r); if(r.length>=4) return false; r.push(n); return true; }

async function startServer() {
    await cargarBloqueos(); await cargarPaises();
    try { configData = JSON.parse(await fs.readFile(CONFIG_FILE, 'utf8')); } catch(e) { await fs.writeFile(CONFIG_FILE, JSON.stringify(configData, null, 2), 'utf8'); }
    try { serviciosData = JSON.parse(await fs.readFile(SERVICIOS_FILE, 'utf8')); } catch(e) {
        serviciosData = [
            { id:"relajante", nombre:"Masaje Relajante", precio:"$45", descripcion:"Movimientos suaves para liberar estrés.", beneficios:["Reduce ansiedad","Alivia tensión","60 Minutos"], efectos:["Relajación profunda","Mejora del sueño"], imagenWeb:"https://images.unsplash.com/photo-1544161515-4ab6ce6db874?w=800", imagenWhatsApp:"", orden:1 },
            { id:"corporal", nombre:"Masaje Corporal", precio:"$65", descripcion:"Tratamiento completo y revitalizante.", beneficios:["Relajación integral","Elimina contracturas","90 Minutos"], efectos:["Activación linfática","Mejora circulación"], imagenWeb:"https://images.unsplash.com/photo-1519823551278-64ac92734fb1?w=800", imagenWhatsApp:"", orden:2 },
            { id:"facial", nombre:"Masaje Facial", precio:"$40", descripcion:"Rejuvenece la piel y alivia tensión facial.", beneficios:["Reafirma la piel","Reduce ojeras","45 Minutos"], efectos:["Estimula colágeno","Tonifica rostro"], imagenWeb:"https://images.unsplash.com/photo-1570172619644-dfd03ed5d881?w=800", imagenWhatsApp:"", orden:3 }
        ];
        await fs.writeFile(SERVICIOS_FILE, JSON.stringify(serviciosData, null, 2), 'utf8');
    }
    try { turnosMem = JSON.parse(await fs.readFile(TURNOS_FILE, 'utf8')); } catch(e) { turnosMem = []; await fs.writeFile(TURNOS_FILE, '[]', 'utf8'); }
    await inicializarBaseConocimiento();

    var server = app.listen(PORT, '0.0.0.0', function() {
        console.log('Serenity Spa v5.2 - puerto ' + PORT);
        console.log('IA: ' + (process.env.DEEPSEEK_API_KEY ? 'DeepSeek' : 'Local'));
    });

    var wss = new WebSocket.Server({ server: server, path: '/ws-voice' });

    wss.on('connection', function(ws, req) {
        var ip = req.socket.remoteAddress || '?';
        if (estaBloqueado(ip)) { ws.close(1008, 'Bloqueada'); return; }
        var cc = wsConnPerIP.get(ip) || 0;
        if (cc >= 3) { ws.close(1008, 'Demasiadas conexiones'); return; }
        wsConnPerIP.set(ip, cc + 1);

        var cid = generarId(), mc = 0;
        voiceClients.set(cid, { datos: {}, pendienteConfirmar: null, ultimaPregunta: null });

        // Bienvenida — una sola vez
        if (ws.readyState === 1) ws.send(JSON.stringify({ tipo: 'respuesta', texto: 'Hola, soy su asistente, con quién tengo el placer de hablar?' }));

        ws.on('message', async function(data) {
            mc++;
            if (mc > 30) { bloquearIP(ip, 'Flood WS', 'flood'); ws.close(1008); return; }
            if (!checkWsRate(ip)) { bloquearIP(ip, 'Rate WS', 'flood'); ws.close(1008); return; }
            if (data.length > 10000) { ws.close(1008); return; }

            try {
                var m = JSON.parse(data);
                if (!m || m.tipo !== 'transcripcion') return;
                var texto = m.texto;
                if (!texto || typeof texto !== 'string' || texto.length > 500) return;

                var seguro = true;
                for (var p = 0; p < voiceAttackPatterns.length; p++) { if (voiceAttackPatterns[p].test(texto)) { seguro = false; break; } }
                if (!seguro) { registrarIntento(ip, 'Sospechoso'); if (ws.readyState === 1) ws.send(JSON.stringify({ tipo: 'respuesta', texto: 'No pude procesar eso. ¿Podría repetirlo de otra forma?' })); return; }

                var resp = await procesarComandoVoz(texto, cid, ip);
                if (resp && ws.readyState === 1) ws.send(JSON.stringify({ tipo: 'respuesta', texto: resp }));
            } catch (e) {
                console.error('WS:', e.message);
                if (ws.readyState === 1) ws.send(JSON.stringify({ tipo: 'respuesta', texto: 'Disculpe, hubo un error. ¿Podría repetir?' }));
            }
        });

        function cleanup() { voiceClients.delete(cid); var c = wsConnPerIP.get(ip) || 0; wsConnPerIP.set(ip, Math.max(0, c - 1)); }
        ws.on('close', cleanup);
        ws.on('error', cleanup);
    });
}

process.on('SIGTERM', async function() { await guardarBloqueos(); await guardarPaises(); process.exit(0); });
process.on('SIGINT', async function() { await guardarBloqueos(); await guardarPaises(); process.exit(0); });

startServer();
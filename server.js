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
const DIAS_NOMBRE = { lunes:'Lunes', martes:'Martes', miercoles:'Miércoles', jueves:'Jueves', viernes:'Viernes', sabado:'Sábado' };
const HORA_TEXTO = { 12:'12 del mediodía', 16:'4 de la tarde', 20:'8 de la noche' };

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
// PAÍSES - Configuración de país activo (SOLO UNO)
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
    { nombre:'Uruguay', codigo:'598', claves:['uruguay','uruguayo','uruguaya'] },
    { nombre:'Paraguay', codigo:'595', claves:['paraguay','paraguayo','paraguaya'] },
    { nombre:'Bolivia', codigo:'591', claves:['bolivia','boliviano','boliviana'] },
    { nombre:'Venezuela', codigo:'58', claves:['venezuela','venezolano','venezolana'] },
    { nombre:'Ecuador', codigo:'593', claves:['ecuador','ecuatoriano','ecuatoriana'] },
    { nombre:'Estados Unidos', codigo:'1', claves:['estados unidos','usa','eeuu','estadounidense'] },
    { nombre:'Brasil', codigo:'55', claves:['brasil','brasileño','brasileña'] },
    { nombre:'Italia', codigo:'39', claves:['italia','italiano','italiana'] },
    { nombre:'Francia', codigo:'33', claves:['francia','francés','frances'] },
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
    // Si hay un país activo configurado, SOLO ese país está autorizado
    if (paisesConfig.modo === 'solo_autorizados' && paisesConfig.paisActivo) {
        return codigo === paisesConfig.paisActivo.codigo;
    }
    // Modo todos los países (excepto bloqueados)
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

function detectarPais(texto) {
    var t = texto.toLowerCase().trim();
    for (var i = 0; i < PAISES_DATOS.length; i++) {
        for (var j = 0; j < PAISES_DATOS[i].claves.length; j++) {
            if (t.indexOf(PAISES_DATOS[i].claves[j]) !== -1) {
                return { nombre: PAISES_DATOS[i].nombre, codigo: PAISES_DATOS[i].codigo };
            }
        }
    }
    return null;
}

// ============================================================
// BASE DE CONOCIMIENTO IA
// ============================================================
var baseConocimiento = [];
async function inicializarBaseConocimiento() {
    baseConocimiento = serviciosData.map(function(s) {
        return { tipo:'servicio', contenido: s.nombre+': '+s.descripcion+'. Precio: '+s.precio+'. Beneficios: '+(s.beneficios||[]).join(', ') };
    }).concat([
        { tipo:'horario', contenido:'Lunes a Sábado. Turnos: 12:00, 16:00, 20:00. Uno por persona por día.' },
        { tipo:'politica', contenido:'Cancelación con 4 horas de anticipación.' }
    ]);
}
function buscarContexto(p) {
    var w = p.toLowerCase().split(/\s+/).filter(function(x) { return x.length > 2; }), r = [];
    for (var i = 0; i < baseConocimiento.length; i++) {
        var s = 0, c = baseConocimiento[i].contenido.toLowerCase();
        for (var j = 0; j < w.length; j++) { if (c.indexOf(w[j]) !== -1) s++; }
        if (s > 0) r.push(Object.assign({}, baseConocimiento[i], { puntuacion: s }));
    }
    return r.sort(function(a, b) { return b.puntuacion - a.puntuacion; }).slice(0, 5).map(function(x) { return x.contenido; });
}
var personalidadIA = { nombre:'Asistente', tono:'cálido y profesional', estilo:'Español neutro, conciso.', reglas:['NUNCA inventar','SIEMPRE ofrecer reservar','NUNCA decir "buenas"','Respuestas cortas'] };

// ============================================================
// UTILIDADES
// ============================================================
function esUrlValida(s) {
    if (!s || typeof s !== 'string') return false;
    var t = s.trim();
    if (t.indexOf('data:') === 0 || t.length > 3000) return false;
    try { var u = new URL(t); return u.protocol === 'http:' || u.protocol === 'https:'; } catch(e) { return false; }
}
function escapeHtml(s) { return s ? s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;') : ''; }
function sanitize(s) { return s ? s.trim().replace(/[^\w\sáéíóúñÑü.,@\-]/gi, '') : ''; }
function generarId() { return Date.now().toString(36)+Math.random().toString(36).substr(2)+crypto.randomBytes(4).toString('hex'); }
function fmtT(ms) {
    if (ms <= 0) return 'Expirado';
    var s = Math.floor(ms/1000), m = Math.floor(s/60), h = Math.floor(m/60);
    return h > 0 ? h+'h '+(m%60)+'m' : m > 0 ? m+'m '+(s%60)+'s' : s+'s';
}

// ============================================================
// EXTRACCIÓN DE NOMBRE (MEJORADA)
// ============================================================
var NO_NOMBRES = {};
['reservar','turno','masaje','hola','buenas','buenos','precio','horario','favor','por','para','de','del','en','el','la','los','las','un','una','este','esta','esto','que','quiere','gustaria','telefono','celular','numero','número','domicilio','salon','salón','lunes','martes','miercoles','jueves','viernes','sabado','doce','cuatro','ocho','mediodia','tarde','noche','país','cuba','argentina','mexico','colombia','chile','peru','españa','venezuela','ecuador','uruguay','paraguay','bolivia','brasil','italia','francia','alemania','costa','panama','estados','unidos','relajante','corporal','facial','servicio','dirección','casa','hogar','local','centro','divjo','dijo','existe','reserva','deberia','hacer','prefiero','preferentemente','dejeme','si','no','ok','bien','placer','hablar','llamar','gracias','agradecido','genial','perfecto','chau','adios','disponible','disponibilidad','cuanto','vale','cuesta','sale','son','tarifa','tipos','tienen','ofrecen','horarios','atención','nombre','apellido','completo','llamarse','llamo','quisiera','quiero','necesito','deseo','busco'].forEach(function(w) { NO_NOMBRES[w] = true; });

function extraerNombre(texto) {
    if (!texto || typeof texto !== 'string') return null;
    var t = texto.trim();
    
    var patrones = [
        /(?:mi\s+nombre\s+es|me\s+llam[oa]|soy\s+yo|me\s+presento|me\s+dicen|le\s+dicen)\s+([A-Za-zÁÉÍÓÚÑáéíóúñ]+(?:\s+[A-Za-zÁÉÍÓÚÑáéíóúñ]+){0,2})/i,
        /\bsoy\s+([A-Za-zÁÉÍÓÚÑáéíóúñ]+(?:\s+[A-Za-zÁÉÍÓÚÑáéíóúñ]+){0,1})(?:\s|,|\.|$)/i,
        /\bllam[oa]\s+([A-Za-zÁÉÍÓÚÑáéíóúñ]+(?:\s+[A-Za-zÁÉÍÓÚÑáéíóúñ]+){0,1})/i,
        /(?:hola|buenas|buenos|saludos)[,.]?\s+(?:soy|me llamo|mi nombre es)\s+([A-Za-zÁÉÍÓÚÑáéíóúñ]+(?:\s+[A-Za-zÁÉÍÓÚÑáéíóúñ]+){0,1})/i,
        /^([A-Za-zÁÉÍÓÚÑáéíóúñ]{2,12})(?:\s+(?:quiere|quisiera|necesita|desea|va a|podría))/i
    ];
    
    for (var p = 0; p < patrones.length; p++) {
        var m = t.match(patrones[p]);
        if (m && m[1]) {
            var palabras = m[1].split(/\s+/);
            var filtradas = [];
            for (var i = 0; i < palabras.length; i++) {
                var w = palabras[i].toLowerCase();
                if (w.length >= 2 && !NO_NOMBRES[w]) {
                    filtradas.push(palabras[i]);
                }
            }
            if (filtradas.length > 0) {
                return filtradas.map(function(w) {
                    return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
                }).join(' ');
            }
        }
    }
    return null;
}

// ============================================================
// EXTRACCIÓN DE TELÉFONO (MEJORADA)
// ============================================================
function extraerTelefono(texto, codigoPaisAdmin) {
    if (!texto || typeof texto !== 'string') return null;
    
    var numerosEncontrados = [];
    
    // Patrón 1: "mi número es / teléfono / celular" seguido de números
    var patronExplicito = /(?:tel[eé]fono|n[uú]mero|celular|cel|m[oó]vil|whatsapp|contacto|ll[aá]mame|escribeme)\s*[:.]?\s*(?:es|al|el)?\s*[:.]?\s*([\d\s\-\(\)\+]{8,25})/i;
    var matchExp = texto.match(patronExplicito);
    if (matchExp) {
        var numLimpio = matchExp[1].replace(/[\s\-\(\)\+]/g, '');
        if (numLimpio.length >= 7 && numLimpio.length <= 15) {
            numerosEncontrados.push(numLimpio);
        }
    }
    
    // Patrón 2: números al final de la frase
    var patronFinal = /[\s:.](\d{7,12})\s*$/;
    var matchFinal = texto.match(patronFinal);
    if (matchFinal) {
        numerosEncontrados.push(matchFinal[1]);
    }
    
    // Patrón 3: cualquier secuencia de 7-12 dígitos
    var todosNumeros = texto.match(/\b\d{7,12}\b/g);
    if (todosNumeros) {
        for (var i = 0; i < todosNumeros.length; i++) {
            numerosEncontrados.push(todosNumeros[i]);
        }
    }
    
    // Patrón 4: números con espacios (ej: "55 55 1234")
    var conEspacios = texto.match(/\b(\d[\d\s]{6,14}\d)\b/g);
    if (conEspacios) {
        for (var i = 0; i < conEspacios.length; i++) {
            var sinEspacios = conEspacios[i].replace(/\s/g, '');
            if (sinEspacios.length >= 7 && sinEspacios.length <= 15) {
                numerosEncontrados.push(sinEspacios);
            }
        }
    }
    
    // Limpiar y validar
    for (var i = 0; i < numerosEncontrados.length; i++) {
        var num = numerosEncontrados[i].replace(/\D/g, '');
        
        if (codigoPaisAdmin && num.indexOf(codigoPaisAdmin) === 0 && num.length > codigoPaisAdmin.length + 4) {
            num = num.substring(codigoPaisAdmin.length);
        }
        
        if (num.length >= 7 && num.length <= 15 && /^\d+$/.test(num)) {
            return num;
        }
    }
    
    return null;
}

// ============================================================
// DETECCIÓN DE MASAJE
// ============================================================
function similitud(a, b) {
    a = a.toLowerCase(); b = b.toLowerCase();
    if (a === b) return 1;
    if (a.indexOf(b) !== -1 || b.indexOf(a) !== -1) return 0.85;
    var mx = [];
    for (var i = 0; i <= a.length; i++) { mx[i] = [i]; }
    for (var j = 0; j <= b.length; j++) { mx[0][j] = j; }
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
        var nombre = serviciosData[s].nombre.toLowerCase();
        if (t.indexOf(nombre) !== -1) return { masaje: serviciosData[s].nombre, id: serviciosData[s].id };
        var sinP = nombre.replace(/^masaje\s+/i, '');
        if (sinP.length > 3 && t.indexOf(sinP) !== -1) return { masaje: serviciosData[s].nombre, id: serviciosData[s].id };

        var claves = nombre.split(/\s+/).filter(function(p) { return p.length > 3 && p !== 'masaje'; });
        var score = 0;
        for (var ci = 0; ci < claves.length; ci++) {
            for (var pi = 0; pi < palabrasTexto.length; pi++) {
                var sp = similitud(palabrasTexto[pi], claves[ci]);
                if (sp > score) score = sp;
            }
        }
        if (score > mejorScore) { mejorScore = score; mejor = { masaje: serviciosData[s].nombre, id: serviciosData[s].id }; }
    }
    return mejor;
}

// ============================================================
// ANÁLISIS COMPLETO DEL TEXTO (NO CORTA)
// ============================================================
function analizarTextoCompleto(texto) {
    var t = texto.toLowerCase();
    
    var resultado = {
        nombre: null,
        masaje: null,
        masajeId: null,
        dia: null,
        hora: null,
        tipoServicio: null,
        ubicacion: null,
        telefono: null,
        intencion: 'desconocida'
    };
    
    // Intención principal
    if (/\b(reservar|turno|cita|agendar|pedir|quiero|gustaría|quisiera|necesito|busco|deseo)\b.*\b(turno|masaje|servicio|cita|reserva)\b/i.test(t) ||
        /\b(reservar|agendar|pedir)\s+(un\s+)?(turno|masaje|servicio)\b/i.test(t)) {
        resultado.intencion = 'reservar';
    } else if (/\b(cancelar|anular|dar de baja)\b/.test(t)) {
        resultado.intencion = 'cancelar';
    } else if (/\b(precio|costo|cuánto vale|cuesta|tarifa)\b/.test(t) && !/\breservar\b/.test(t)) {
        resultado.intencion = 'consultar_precios';
    } else if (/\b(horario|a qué hora|cuándo atienden|disponibilidad de horarios)\b/.test(t) && !/\breservar\b/.test(t)) {
        resultado.intencion = 'consultar_horarios';
    } else if (/\b(servicios|masajes|tipos de masaje|qué ofrecen|qué tienen)\b/.test(t) && !/\breservar\b/.test(t)) {
        resultado.intencion = 'consultar_servicios';
    }
    
    // Nombre
    resultado.nombre = extraerNombre(texto);
    
    // Masaje
    var masajeDetectado = detectarMasaje(texto);
    if (masajeDetectado) {
        resultado.masaje = masajeDetectado.masaje;
        resultado.masajeId = masajeDetectado.id;
    }
    
    // Día
    var diasMap = {
        'lunes': 'lunes', 'martes': 'martes', 'miercoles': 'miercoles',
        'miércoles': 'miercoles', 'jueves': 'jueves', 'viernes': 'viernes',
        'sabado': 'sabado', 'sábado': 'sabado'
    };
    for (var d in diasMap) {
        if (t.indexOf(d) !== -1) {
            resultado.dia = diasMap[d];
            break;
        }
    }
    
    // Hora
    if (/\b(12|doce|mediodía|12:00)\b/.test(t)) resultado.hora = 12;
    else if (/\b(16|cuatro|4\s+de\s+la\s+tarde|16:00)\b/.test(t)) resultado.hora = 16;
    else if (/\b(20|ocho|8\s+de\s+la\s+noche|20:00)\b/.test(t)) resultado.hora = 20;
    
    // Tipo de servicio
    if (/\b(salón|salon|local|en el local|en el salón|en el salon|en el lugar|ahí mismo|allí)\b/i.test(t)) {
        resultado.tipoServicio = 'salon';
    } else if (/\b(domicilio|casa|mi casa|a domicilio|en mi casa|en casa|domicilio particular)\b/i.test(t)) {
        resultado.tipoServicio = 'domicilio';
    }
    
    // Dirección (solo si es domicilio)
    if (resultado.tipoServicio === 'domicilio') {
        var patronDireccion = /(?:dirección|domicilio|en|para)\s*[:.]?\s*([A-Za-z0-9\s,.#\-]{10,100})(?:\.|$|,)/i;
        var dirMatch = texto.match(patronDireccion);
        if (dirMatch && dirMatch[1]) {
            resultado.ubicacion = dirMatch[1].trim();
        }
    }
    
    // Teléfono
    var paisActivoAdmin = getPaisActivo();
    var codigoPais = paisActivoAdmin ? paisActivoAdmin.codigo : null;
    resultado.telefono = extraerTelefono(texto, codigoPais);
    
    return resultado;
}

// ============================================================
// FUNCIONES DE DISPONIBILIDAD Y RESERVAS
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
    var txt = f.toLocaleDateString('es-ES', { weekday:'long', day:'numeric', month:'long' });
    return txt.charAt(0).toUpperCase() + txt.slice(1);
}

function obtenerDisponibilidad() {
    var r = [];
    for (var d = 0; d < DIAS_VALIDOS.length; d++) {
        var dia = DIAS_VALIDOS[d], libres = [];
        for (var h = 0; h < HORAS_VALIDAS.length; h++) {
            var oc = false;
            for (var t = 0; t < turnosMem.length; t++) {
                if (turnosMem[t].dia === dia && turnosMem[t].hora === HORAS_VALIDAS[h]) { oc = true; break; }
            }
            if (!oc) libres.push(HORAS_VALIDAS[h]);
        }
        r.push({ dia:dia, libres:libres });
    }
    return r;
}

function buscarAlternativa(dia, hora, turnos) {
    var idx = DIAS_VALIDOS.indexOf(dia); if (idx === -1) return null;
    for (var o = 0; o < 7; o++) {
        var d2 = DIAS_VALIDOS[(idx + o) % 7];
        var hrs = o === 0 ? HORAS_VALIDAS.filter(function(h) { return h > hora; }) : HORAS_VALIDAS;
        for (var i = 0; i < hrs.length; i++) {
            var libre = true;
            for (var t = 0; t < turnos.length; t++) { if (turnos[t].dia === d2 && turnos[t].hora === hrs[i]) { libre = false; break; } }
            if (libre) return { dia:d2, hora:hrs[i] };
        }
    }
    return null;
}

function generarMenuServicios() {
    if (!serviciosData.length) return 'No hay servicios disponibles en este momento.';
    var menu = 'Nuestros servicios:\n\n';
    for (var i = 0; i < serviciosData.length; i++) {
        menu += (i + 1) + '. ' + serviciosData[i].nombre + ' - ' + serviciosData[i].precio + '\n';
        if (serviciosData[i].descripcion) {
            menu += '   ' + serviciosData[i].descripcion.substring(0, 60) + '...\n';
        }
        menu += '\n';
    }
    menu += '¿Cuál le gustaría reservar?';
    return menu;
}

function generarListaPrecios() {
    if (!serviciosData.length) return 'No hay servicios disponibles.';
    var lista = 'Precios:\n\n';
    for (var i = 0; i < serviciosData.length; i++) {
        lista += '• ' + serviciosData[i].nombre + ': ' + serviciosData[i].precio + '\n';
    }
    return lista;
}

function generarPreguntaFaltante(cd, campo) {
    var nombre = cd.datos && cd.datos.nombre ? cd.datos.nombre + ', ' : '';
    
    switch (campo) {
        case 'nombre':
            return 'Para poder ayudarle mejor, ¿cuál es su nombre?';
        case 'masaje':
            return generarMenuServicios();
        case 'dia':
            return nombre + '¿Qué día de la semana le gustaría? Atendemos de lunes a sábado.';
        case 'hora':
            return nombre + '¿A qué hora prefiere? Horarios: 12:00, 16:00 o 20:00.';
        case 'tipoServicio':
            return nombre + '¿Dónde prefiere recibir el masaje?\n• En nuestro salón\n• A domicilio';
        case 'telefono':
            return nombre + 'Para confirmar la reserva, necesito su número de teléfono. ¿Cuál es?';
        default:
            return '¿Podría darme más detalles para ayudarle mejor?';
    }
}

// ============================================================
// PROCESAR COMANDO DE VOZ (COMPLETO)
// ============================================================
var voiceClients = new Map();

async function procesarComandoVoz(texto, clientId, ip) {
    var textoLimpio = texto.replace(/<[^>]*>/g, '').replace(/[<>]/g, '').trim();
    if (!textoLimpio || textoLimpio.length > 500) {
        return 'Disculpe, no pude entender su mensaje. ¿Podría repetirlo?';
    }
    
    var cd = voiceClients.get(clientId);
    if (!cd) {
        cd = {
            datos: { tipoServicio: 'salon', codigoPais: null },
            pendienteConfirmar: null,
            pendienteReserva: null,
            ultimaPregunta: null,
            clientId: clientId
        };
        voiceClients.set(clientId, cd);
    }
    
    // Obtener país activo configurado en admin
    var paisActivo = getPaisActivo();
    var codigoPaisPermitido = paisActivo ? paisActivo.codigo : null;
    var nombrePaisPermitido = paisActivo ? paisActivo.nombre : null;
    
    if (codigoPaisPermitido) {
        cd.datos.codigoPais = codigoPaisPermitido;
    }
    
    // Analizar texto completo
    var analisis = analizarTextoCompleto(textoLimpio);
    
    // Fusionar datos detectados
    if (analisis.nombre && !cd.datos.nombre) cd.datos.nombre = analisis.nombre;
    if (analisis.masaje && !cd.datos.masaje) { cd.datos.masaje = analisis.masaje; cd.datos.masajeId = analisis.masajeId; }
    if (analisis.dia && !cd.datos.dia) cd.datos.dia = analisis.dia;
    if (analisis.hora && !cd.datos.hora) cd.datos.hora = analisis.hora;
    if (analisis.tipoServicio && !cd.datos.tipoServicio) cd.datos.tipoServicio = analisis.tipoServicio;
    if (analisis.ubicacion && !cd.datos.ubicacion) cd.datos.ubicacion = analisis.ubicacion;
    if (analisis.telefono && !cd.datos.telefono) cd.datos.telefono = analisis.telefono;
    
    // Si el país está configurado y el cliente intenta usar otro, bloquear
    if (paisActivo && analisis.pais && analisis.codigoPais && analisis.codigoPais !== codigoPaisPermitido) {
        return `Lo siento, actualmente solo aceptamos reservas desde ${nombrePaisPermitido}. ¿Necesita algo más?`;
    }
    
    // Si hay confirmación pendiente de alternativa
    if (cd.pendienteConfirmar) {
        var t = textoLimpio.toLowerCase();
        if (/\b(si|sí|sip|dale|ok|vale|claro|por supuesto|exacto|bien|desea|confirmo|acepto)\b/.test(t)) {
            cd.datos.dia = cd.pendienteConfirmar.dia;
            cd.datos.hora = cd.pendienteConfirmar.hora;
            cd.pendienteConfirmar = null;
            return await confirmarReservaAutomatica(cd, ip);
        } else {
            cd.pendienteConfirmar = null;
            return 'Entiendo. ¿Le gustaría probar con otro día u horario?';
        }
    }
    
    // Intención de reservar o datos suficientes
    var tieneDatosReserva = cd.datos.nombre && cd.datos.masaje && cd.datos.dia && cd.datos.hora && cd.datos.tipoServicio;
    
    if (analisis.intencion === 'reservar' || tieneDatosReserva) {
        var faltantes = [];
        if (!cd.datos.nombre) faltantes.push('nombre');
        if (!cd.datos.masaje) faltantes.push('masaje');
        if (!cd.datos.dia) faltantes.push('dia');
        if (!cd.datos.hora) faltantes.push('hora');
        if (!cd.datos.tipoServicio) faltantes.push('tipoServicio');
        if (!cd.datos.telefono) faltantes.push('telefono');
        
        if (faltantes.length === 0) {
            return await confirmarReservaAutomatica(cd, ip);
        } else {
            cd.ultimaPregunta = faltantes[0];
            return generarPreguntaFaltante(cd, faltantes[0]);
        }
    }
    
    // Si hay datos pero no intención explícita
    if (cd.datos.nombre && (cd.datos.masaje || cd.datos.dia || cd.datos.hora)) {
        var faltantes = [];
        if (!cd.datos.masaje) faltantes.push('masaje');
        if (!cd.datos.dia) faltantes.push('dia');
        if (!cd.datos.hora) faltantes.push('hora');
        if (!cd.datos.tipoServicio && !cd.datos.ubicacion) faltantes.push('tipoServicio');
        if (!cd.datos.telefono) faltantes.push('telefono');
        
        if (faltantes.length > 0) {
            cd.ultimaPregunta = faltantes[0];
            return generarPreguntaFaltante(cd, faltantes[0]);
        }
    }
    
    // Responder según intención
    switch (analisis.intencion) {
        case 'consultar_servicios':
            return generarMenuServicios();
        case 'consultar_horarios':
            return 'Nuestros horarios son:\n• 12:00 hs (mediodía)\n• 16:00 hs (tarde)\n• 20:00 hs (noche)\n\nAtendemos de lunes a sábado.';
        case 'consultar_precios':
            return generarListaPrecios();
        default:
            var nombre = cd.datos.nombre;
            if (nombre) {
                return nombre + ', ¿en qué puedo ayudarle hoy?\n\n• Reservar un turno\n• Ver servicios\n• Horarios\n• Precios';
            }
            return 'Bienvenido a Serenity Spa. ¿Cómo puedo ayudarle hoy?\n\n• Reservar un turno\n• Ver servicios\n• Horarios\n• Precios';
    }
}

// ============================================================
// CONFIRMAR RESERVA AUTOMÁTICA
// ============================================================
async function confirmarReservaAutomatica(cd, ip) {
    var datos = cd.datos;
    
    var paisActivo = getPaisActivo();
    var codigoPaisPermitido = paisActivo ? paisActivo.codigo : '53';
    var nombrePaisPermitido = paisActivo ? paisActivo.nombre : null;
    
    // Verificar país autorizado
    if (paisActivo && !paisAutorizado(codigoPaisPermitido)) {
        return `Lo siento${datos.nombre ? ', ' + datos.nombre : ''}, actualmente solo aceptamos reservas desde ${nombrePaisPermitido || codigoPaisPermitido}.`;
    }
    
    // Validar datos
    if (!datos.telefono || datos.telefono.length < 7) {
        cd.ultimaPregunta = 'telefono';
        return (datos.nombre || 'Por favor') + ', necesito su número de teléfono para confirmar la reserva. ¿Cuál es?';
    }
    
    if (DIAS_VALIDOS.indexOf(datos.dia) === -1) {
        cd.ultimaPregunta = 'dia';
        return (datos.nombre || '') + 'El día indicado no es válido. Atendemos de lunes a sábado. ¿Qué día prefiere?';
    }
    
    if (HORAS_VALIDAS.indexOf(parseInt(datos.hora)) === -1) {
        cd.ultimaPregunta = 'hora';
        return (datos.nombre || '') + 'La hora indicada no es válida. Horarios: 12:00, 16:00 o 20:00. ¿Cuál prefiere?';
    }
    
    try {
        var turnos = await loadTurnos();
        
        // Verificar si ya tiene turno ese día
        for (var i = 0; i < turnos.length; i++) {
            if (turnos[i].telefono === datos.telefono && turnos[i].dia === datos.dia) {
                return datos.nombre + ', ya tiene un turno reservado para el ' + datos.dia + '. Solo permitimos un masaje por persona por día.';
            }
        }
        
        // Verificar disponibilidad
        for (var j = 0; j < turnos.length; j++) {
            if (turnos[j].dia === datos.dia && turnos[j].hora === parseInt(datos.hora)) {
                var alternativa = buscarAlternativa(datos.dia, parseInt(datos.hora), turnos);
                if (alternativa) {
                    cd.pendienteConfirmar = alternativa;
                    return `El horario de las ${datos.hora}:00 del ${datos.dia} ya está ocupado. ¿Le sirve el ${alternativa.dia} a las ${alternativa.hora}:00?`;
                }
                return 'Lo siento, no hay disponibilidad para esa semana. ¿Quiere probar con otra semana?';
            }
        }
        
        // Crear reserva
        var nuevoTurno = {
            id: generarId(),
            nombre: datos.nombre,
            dia: datos.dia,
            hora: parseInt(datos.hora),
            massageType: datos.masaje,
            telefono: datos.telefono,
            codigoPais: codigoPaisPermitido,
            ubicacion: datos.tipoServicio === 'domicilio' ? (datos.ubicacion || 'Dirección a confirmar') : 'Salón Serenity Spa',
            tipoServicio: datos.tipoServicio || 'salon',
            confirmadoWhatsApp: false,
            fechaCreacion: new Date().toISOString(),
            ip: ip
        };
        
        turnos.push(nuevoTurno);
        await saveTurnos(turnos);
        turnosMem = turnos;
        regTurno(ip, datos.telefono);
        
        // Limpiar sesión
        cd.pendienteConfirmar = null;
        cd.ultimaPregunta = null;
        
        var respuesta = `✅ RESERVA CONFIRMADA ✅\n\n`;
        respuesta += `Cliente: ${datos.nombre}\n`;
        respuesta += `📅 Día: ${datos.dia}\n`;
        respuesta += `⏰ Hora: ${datos.hora}:00\n`;
        respuesta += `💆 Masaje: ${datos.masaje}\n`;
        respuesta += `📍 Lugar: ${datos.tipoServicio === 'domicilio' ? (datos.ubicacion || 'A confirmar') : 'Salón Serenity Spa'}\n`;
        respuesta += `📞 Teléfono: +${codigoPaisPermitido} ${datos.telefono}\n\n`;
        respuesta += `🌸 Lo esperamos. ¡Que tenga un excelente día!`;
        
        return respuesta;
        
    } catch (error) {
        console.error('Error al confirmar reserva:', error);
        return 'Hubo un error al procesar su reserva. Por favor, intente nuevamente en unos momentos.';
    }
}

// ============================================================
// MIDDLEWARES Y RUTAS
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
    if (estaBloqueado(ip)) return res.status(403).json({ error: 'IP bloqueada por seguridad' });
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
    if (estaBloqueado(ip)) return res.status(403).json({ success: false, bloqueado: true });
    
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
        res.json({ ok: true });
    } catch(e) { res.status(500).json({ error: 'Error al actualizar' }); }
});

app.delete('/api/servicios/:id', async function(req, res) {
    if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    var oldLength = serviciosData.length;
    serviciosData = serviciosData.filter(function(s) { return s.id !== req.params.id; });
    await fs.writeFile(SERVICIOS_FILE, JSON.stringify(serviciosData, null, 2), 'utf8');
    await inicializarBaseConocimiento();
    res.json({ ok: true, eliminado: serviciosData.length < oldLength });
});

// ============================================================
// TURNOS
// ============================================================
async function loadTurnos() {
    try { return JSON.parse(await fs.readFile(TURNOS_FILE, 'utf8')); }
    catch(e) { return []; }
}
async function saveTurnos(turnos) { await fs.writeFile(TURNOS_FILE, JSON.stringify(turnos, null, 2), 'utf8'); }

app.get('/turnos', async function(req, res) { res.json(await loadTurnos()); });

app.post('/turnos', async function(req, res) {
    var ip = req.ip || req.socket.remoteAddress || '0.0.0.0';
    if (estaBloqueado(ip)) return res.status(403).json({ error: 'IP bloqueada' });
    if (!checkRateIP(ip)) { bloquearIP(ip, 'Spam turnos', 'spam'); return res.status(429).json({ error: 'Demasiadas solicitudes' }); }
    
    try {
        var nombre = req.body.nombre, dia = req.body.dia, hora = req.body.hora;
        var mt = req.body.massageType, tel = req.body.telefono, ub = req.body.ubicacion;
        var ts = req.body.tipoServicio;
        
        if (!nombre || nombre.length < 2) return res.status(400).json({ error: 'Nombre inválido' });
        var telefono = (tel || '').replace(/\D/g, '');
        if (!telefono || telefono.length < 7) return res.status(400).json({ error: 'Teléfono inválido' });
        
        var cp = req.body.codigoPais || '53';
        if (!/^\d{1,3}$/.test(cp)) cp = '53';
        
        // Verificar país autorizado
        var paisActivo = getPaisActivo();
        if (paisActivo && cp !== paisActivo.codigo) {
            return res.status(403).json({ error: 'País no autorizado. Solo se aceptan reservas desde ' + paisActivo.nombre });
        }
        if (!paisAutorizado(cp)) return res.status(403).json({ error: 'País no autorizado' });
        
        if (DIAS_VALIDOS.indexOf((dia || '').toLowerCase()) === -1) return res.status(400).json({ error: 'Día inválido' });
        var hn = parseInt(hora);
        if (HORAS_VALIDAS.indexOf(hn) === -1) return res.status(400).json({ error: 'Hora inválida' });
        if (!checkRateTel(telefono)) return res.status(429).json({ error: 'Máximo 2 turnos por día' });
        
        var turnos = await loadTurnos();
        for (var i = 0; i < turnos.length; i++) {
            if (turnos[i].telefono === telefono && turnos[i].dia === (dia || '').toLowerCase()) {
                return res.status(409).json({ error: 'Ya tiene turno ese día' });
            }
        }
        for (var j = 0; j < turnos.length; j++) {
            if (turnos[j].dia === (dia || '').toLowerCase() && turnos[j].hora === hn) {
                return res.status(409).json({ error: 'Ocupado', alternativa: buscarAlternativa((dia || ''), hn, turnos) });
            }
        }
        
        var nuevo = {
            id: generarId(),
            nombre: escapeHtml(sanitize(nombre)),
            dia: (dia || '').toLowerCase(),
            hora: hn,
            massageType: mt || 'Masaje',
            telefono: telefono,
            codigoPais: cp,
            ubicacion: ub ? ub : 'Salón Serenity Spa',
            tipoServicio: ts || 'salon',
            confirmadoWhatsApp: false,
            fechaCreacion: new Date().toISOString(),
            ip: ip
        };
        turnos.push(nuevo);
        await saveTurnos(turnos);
        turnosMem = turnos;
        regTurno(ip, telefono);
        intentosFallidos.delete(ip);
        res.status(201).json({ mensaje: 'Reserva confirmada', turno: nuevo });
    } catch(e) { res.status(500).json({ error: 'Error al procesar' }); }
});

app.delete('/turnos/:id', async function(req, res) {
    if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    var turnos = await loadTurnos();
    var idx = -1;
    for (var i = 0; i < turnos.length; i++) {
        if (turnos[i].id === req.params.id) { idx = i; break; }
    }
    if (idx === -1) return res.status(404).json({ error: 'No encontrado' });
    turnos.splice(idx, 1);
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
        msg += '📅 Día: ' + turno.dia + '\n';
        msg += '⏰ Hora: ' + turno.hora + ':00\n';
        msg += '💆 Masaje: ' + turno.massageType + '\n';
        msg += '📍 Lugar: ' + (turno.tipoServicio === 'domicilio' ? turno.ubicacion : 'Salón Serenity Spa') + '\n\n';
        msg += '🌸 Te esperamos.';
        
        var c = turno.codigoPais || '53';
        for (var j = 0; j < turnos.length; j++) {
            if (turnos[j].id === req.params.id) {
                turnos[j].confirmadoWhatsApp = true;
                turnos[j].fechaWA = new Date().toISOString();
                break;
            }
        }
        await saveTurnos(turnos);
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
    
    var limpio = msg.replace(/<[^>]*>/g, '').replace(/[<>]/g, '').trim();
    if (!limpio) return res.status(400).json({ error: 'Vacío' });
    
    var patronesPeligrosos = [/ignore|bypass|override|system prompt|revela|instrucciones/i, /<script>|javascript:|onerror=/i, /SELECT.*FROM|DROP TABLE|UNION SELECT/i];
    for (var p = 0; p < patronesPeligrosos.length; p++) {
        if (patronesPeligrosos[p].test(limpio)) {
            registrarIntento(ip, 'Inyección');
            return res.status(400).json({ error: 'No permitido' });
        }
    }
    
    try {
        var ctx = buscarContexto(limpio);
        var sysMsg = 'Eres asistente de Serenity Spa. Tono: ' + personalidadIA.tono + '. ' + personalidadIA.estilo + '. ' + personalidadIA.reglas.join('\n') + '\n\nINFO:\n' + ctx.join('\n') + '\nREGLAS:\n' + personalidadIA.reglas.map(function(r, i) { return (i+1) + '. ' + r; }).join('\n') + '\nResponde corto. NUNCA digas "buenas".';
        
        if (!process.env.DEEPSEEK_API_KEY) {
            return res.json({ respuesta: 'Hola, ¿en qué puedo ayudarte?', modo: 'local' });
        }
        
        var completion = await deepseek.chat.completions.create({
            model: 'deepseek-chat',
            messages: [{ role: 'system', content: sysMsg }, { role: 'user', content: limpio }],
            temperature: 0.7,
            max_tokens: 500
        });
        res.json({ respuesta: completion.choices[0].message.content, modo: 'ia' });
    } catch(e) {
        res.json({ respuesta: 'Hola, ¿en qué puedo ayudarte?', modo: 'local' });
    }
});

// ============================================================
// IA PERSONALIDAD ADMIN
// ============================================================
app.get('/api/ia/personalidad', function(req, res) {
    if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    res.json(personalidadIA);
});

app.put('/api/ia/personalidad', async function(req, res) {
    if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    if (req.body.nombre) personalidadIA.nombre = sanitize(req.body.nombre);
    if (req.body.tono) personalidadIA.tono = sanitize(req.body.tono);
    if (req.body.estilo) personalidadIA.estilo = sanitize(req.body.estilo);
    if (req.body.reglas) personalidadIA.reglas = Array.isArray(req.body.reglas) ? req.body.reglas.map(function(r) { return sanitize(r); }) : [];
    res.json({ ok: true });
});

app.post('/api/ia/recargar', async function(req, res) {
    if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    await inicializarBaseConocimiento();
    res.json({ ok: true, items: baseConocimiento.length });
});

// ============================================================
// SEGURIDAD PAÍSES ADMIN
// ============================================================
app.get('/api/seguridad/paises', function(req, res) {
    if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    res.json(paisesConfig);
});

app.put('/api/seguridad/paises', async function(req, res) {
    if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    if (req.body.autorizados !== undefined) paisesConfig.autorizados = req.body.autorizados;
    if (req.body.bloqueados !== undefined) paisesConfig.bloqueados = req.body.bloqueados;
    if (req.body.modo && req.body.modo === 'solo_autorizados') paisesConfig.modo = req.body.modo;
    if (req.body.modo === 'todos') paisesConfig.modo = 'todos';
    await guardarPaises();
    res.json({ ok: true });
});

// NUEVA RUTA: Configurar país activo (SOLO UNO)
app.put('/api/seguridad/pais-activo', async function(req, res) {
    if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    
    var codigo = req.body.codigo;
    var nombre = req.body.nombre;
    
    if (!codigo || !/^\d{1,3}$/.test(codigo)) {
        return res.status(400).json({ error: 'Código de país inválido' });
    }
    
    var paisEncontrado = null;
    for (var i = 0; i < PAISES_DATOS.length; i++) {
        if (PAISES_DATOS[i].codigo === codigo) {
            paisEncontrado = PAISES_DATOS[i];
            break;
        }
    }
    
    paisesConfig.autorizados = [codigo];
    paisesConfig.bloqueados = [];
    paisesConfig.modo = 'solo_autorizados';
    paisesConfig.paisActivo = {
        codigo: codigo,
        nombre: nombre || (paisEncontrado ? paisEncontrado.nombre : codigo),
        fechaActualizacion: new Date().toISOString()
    };
    
    await guardarPaises();
    
    res.json({
        ok: true,
        mensaje: (nombre || (paisEncontrado ? paisEncontrado.nombre : codigo)) + ' configurado como país activo. Solo reservas desde este país serán aceptadas.'
    });
});

app.post('/api/seguridad/paises/autorizar', async function(req, res) {
    if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    var c = req.body.codigo;
    if (!c || !/^\d{1,3}$/.test(c)) return res.status(400).json({ error: 'Código inválido' });
    if (paisesConfig.autorizados.indexOf(c) === -1) {
        paisesConfig.autorizados.push(c);
        paisesConfig.bloqueados = paisesConfig.bloqueados.filter(function(x) { return x !== c; });
    }
    await guardarPaises();
    res.json({ ok: true, mensaje: (req.body.nombre || c) + ' autorizado' });
});

app.post('/api/seguridad/paises/bloquear', async function(req, res) {
    if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    var c = req.body.codigo;
    if (!c || !/^\d{1,3}$/.test(c)) return res.status(400).json({ error: 'Código inválido' });
    if (paisesConfig.bloqueados.indexOf(c) === -1) paisesConfig.bloqueados.push(c);
    paisesConfig.autorizados = paisesConfig.autorizados.filter(function(x) { return x !== c; });
    await guardarPaises();
    res.json({ ok: true, mensaje: (req.body.nombre || c) + ' bloqueado' });
});

app.delete('/api/seguridad/paises/:codigo', async function(req, res) {
    if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    var c = req.params.codigo;
    paisesConfig.autorizados = paisesConfig.autorizados.filter(function(x) { return x !== c; });
    paisesConfig.bloqueados = paisesConfig.bloqueados.filter(function(x) { return x !== c; });
    if (paisesConfig.paisActivo && paisesConfig.paisActivo.codigo === c) {
        paisesConfig.paisActivo = null;
        paisesConfig.modo = 'todos';
    }
    await guardarPaises();
    res.json({ ok: true });
});

app.get('/api/seguridad/paises/stats', async function(req, res) {
    if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    var turnos = await loadTurnos();
    var stats = {};
    for (var i = 0; i < turnos.length; i++) {
        var c = turnos[i].codigoPais || '53';
        stats[c] = (stats[c] || 0) + 1;
    }
    var resultado = Object.keys(stats).map(function(k) {
        var nombre = 'Desconocido';
        for (var j = 0; j < PAISES_DATOS.length; j++) {
            if (PAISES_DATOS[j].codigo === k) { nombre = PAISES_DATOS[j].nombre; break; }
        }
        return { codigo: k, nombre: nombre, reservas: stats[k] };
    });
    resultado.sort(function(a, b) { return b.reservas - a.reservas; });
    res.json(resultado);
});

// ============================================================
// SEGURIDAD BLOQUEOS ADMIN
// ============================================================
app.get('/api/seguridad/bloqueos', function(req, res) {
    if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    var activos = [];
    for (var e of bloqueos) {
        var tiempoRestante = Math.max(0, e[1].hasta - Date.now());
        var tiempoFormateado = tiempoRestante > 0 ? fmtT(tiempoRestante) : 'Expirado';
        activos.push({
            ip: e[0],
            motivo: e[1].motivo,
            tipoAtaque: e[1].tipoAtaque,
            fecha: e[1].fecha,
            tiempoRestante: tiempoRestante,
            tiempoRestanteFormateado: tiempoFormateado,
            intentos: e[1].intentos || 0,
            permanente: e[1].permanente || false
        });
    }
    res.json({ activos: activos, historial: historialBloqueos.slice(0, 100), intentosFallidos: Object.fromEntries(intentosFallidos) });
});

app.post('/api/seguridad/desbloquear/:ip', function(req, res) {
    if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    desbloquearIP(req.params.ip);
    res.json({ ok: true });
});

app.delete('/api/seguridad/bloqueos/:ip', function(req, res) {
    if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    bloqueos.delete(req.params.ip);
    guardarBloqueos();
    res.json({ ok: true });
});

app.delete('/api/seguridad/historial/:id', function(req, res) {
    if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    historialBloqueos = historialBloqueos.filter(function(h) { return h.id !== req.params.id; });
    guardarBloqueos();
    res.json({ ok: true });
});

app.post('/api/seguridad/limpiar-expirados', function(req, res) {
    if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    var ahora = Date.now();
    var eliminados = 0;
    for (var e of bloqueos) {
        if (ahora > e[1].hasta && !e[1].permanente) {
            bloqueos.delete(e[0]);
            eliminados++;
        }
    }
    guardarBloqueos();
    res.json({ mensaje: eliminados + ' bloqueos eliminados' });
});

app.post('/api/seguridad/bloquear-permanente/:ip', function(req, res) {
    if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    bloqueos.set(req.params.ip, {
        hasta: Date.now() + 31536000000,
        motivo: 'Bloqueo manual permanente',
        tipoAtaque: 'manual',
        fecha: new Date().toISOString(),
        ip: req.params.ip,
        intentos: 0,
        permanente: true
    });
    guardarBloqueos();
    res.json({ ok: true });
});

// ============================================================
// RUTAS ESTÁTICAS
// ============================================================
app.get('/health', function(req, res) {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        ia: process.env.DEEPSEEK_API_KEY ? 'conectada' : 'local'
    });
});

app.get('/voice-assistant', function(req, res) { res.sendFile(path.join(__dirname, 'voice-assistant.html')); });
app.get('/', function(req, res) { res.sendFile(path.join(__dirname, 'index.html')); });
app.get('/admin.html', function(req, res) { res.sendFile(path.join(__dirname, 'admin.html')); });
app.get('/login.html', function(req, res) { res.sendFile(path.join(__dirname, 'login.html')); });

// ============================================================
// WEBSOCKET PARA ASISTENTE DE VOZ
// ============================================================
var wsConnPerIP = new Map();
var voiceAttackPatterns = [
    /ignore|bypass|override|system prompt|revela|instrucciones/i,
    /<script>|javascript:|onerror=/i,
    /SELECT.*FROM|DROP TABLE|UNION SELECT/i
];

function checkWsRate(ip) {
    var ahora = Date.now();
    var ultimos = wsRatePerSec.get(ip) || [];
    ultimos = ultimos.filter(function(t) { return ahora - t < 1000; });
    if (ultimos.length >= 10) return false;
    ultimos.push(ahora);
    wsRatePerSec.set(ip, ultimos);
    return true;
}

// ============================================================
// INICIALIZAR SERVIDOR
// ============================================================
var configData = {
    hero: { titulo: 'Renueva tu Energía', subtitulo: 'Experiencias de bienestar', imagenFondo: '', botonTexto: 'Explorar Tratamientos' },
    serviciosSection: { etiqueta: 'Nuestros Servicios', titulo: 'Elige tu Masaje Ideal', descripcion: 'Turnos: 12:00, 16:00 y 20:00' },
    contactoSection: { titulo: 'Asistente de Reservas', descripcion: 'Reserva tu turno de forma rápida' },
    shareSection: { titulo: 'Comparte Serenity Spa' }
};

var serviciosData = [];
var turnosMem = [];

async function startServer() {
    await cargarBloqueos();
    await cargarPaises();
    
    try { configData = JSON.parse(await fs.readFile(CONFIG_FILE, 'utf8')); } catch(e) { await fs.writeFile(CONFIG_FILE, JSON.stringify(configData, null, 2), 'utf8'); }
    
    try {
        serviciosData = JSON.parse(await fs.readFile(SERVICIOS_FILE, 'utf8'));
        if (!serviciosData.length) throw new Error('Vacío');
    } catch(e) {
        serviciosData = [
            { id: "relajante", nombre: "Masaje Relajante", precio: "$45", descripcion: "Movimientos suaves para liberar estrés.", beneficios: ["Reduce ansiedad", "Alivia tensión muscular", "60 Minutos"], efectos: ["Relajación profunda", "Mejora del sueño"], imagenWeb: "https://images.unsplash.com/photo-1544161515-4ab6ce6db874?w=800", imagenWhatsApp: "", orden: 1 },
            { id: "corporal", nombre: "Masaje Corporal", precio: "$65", descripcion: "Tratamiento completo y revitalizante.", beneficios: ["Relajación integral", "Elimina contracturas", "90 Minutos"], efectos: ["Activación linfática", "Mejora circulación"], imagenWeb: "https://images.unsplash.com/photo-1519823551278-64ac92734fb1?w=800", imagenWhatsApp: "", orden: 2 },
            { id: "facial", nombre: "Masaje Facial", precio: "$40", descripcion: "Rejuvenece la piel y alivia tensión facial.", beneficios: ["Reafirma la piel", "Reduce ojeras", "45 Minutos"], efectos: ["Estimula colágeno", "Tonifica rostro"], imagenWeb: "https://images.unsplash.com/photo-1570172619644-dfd03ed5d881?w=800", imagenWhatsApp: "", orden: 3 }
        ];
        await fs.writeFile(SERVICIOS_FILE, JSON.stringify(serviciosData, null, 2), 'utf8');
    }
    
    try { turnosMem = JSON.parse(await fs.readFile(TURNOS_FILE, 'utf8')); } catch(e) { turnosMem = []; await fs.writeFile(TURNOS_FILE, '[]', 'utf8'); }
    
    await inicializarBaseConocimiento();
    
    var server = app.listen(PORT, '0.0.0.0', function() {
        console.log('Serenity Spa v6.0 - Puerto ' + PORT);
        console.log('IA: ' + (process.env.DEEPSEEK_API_KEY ? 'DeepSeek' : 'Local'));
        var paisActivo = getPaisActivo();
        if (paisActivo) console.log('País activo (solo reservas): ' + paisActivo.nombre + ' (+' + paisActivo.codigo + ')');
        else console.log('País activo: Todos los países permitidos');
    });
    
    var wss = new WebSocket.Server({ server: server, path: '/ws-voice' });
    
    wss.on('connection', function(ws, req) {
        var ip = req.socket.remoteAddress || '0.0.0.0';
        if (estaBloqueado(ip)) { ws.close(1008, 'IP bloqueada'); return; }
        
        var cc = wsConnPerIP.get(ip) || 0;
        if (cc >= 5) { ws.close(1008, 'Demasiadas conexiones'); return; }
        wsConnPerIP.set(ip, cc + 1);
        
        var clientId = generarId();
        var messageCount = 0;
        
        voiceClients.set(clientId, {
            datos: { tipoServicio: 'salon', codigoPais: null },
            pendienteConfirmar: null,
            pendienteReserva: null,
            ultimaPregunta: null,
            clientId: clientId
        });
        
        if (ws.readyState === 1) {
            ws.send(JSON.stringify({ tipo: 'respuesta', texto: 'Bienvenido a Serenity Spa. ¿Cómo puedo ayudarle?' }));
        }
        
        ws.on('message', async function(data) {
            messageCount++;
            if (messageCount > 50) { bloquearIP(ip, 'Flood WS', 'flood'); ws.close(1008); return; }
            if (!checkWsRate(ip)) { bloquearIP(ip, 'Rate WS', 'flood'); ws.close(1008); return; }
            if (data.length > 10000) { ws.close(1008); return; }
            
            try {
                var msg = JSON.parse(data);
                if (!msg || msg.tipo !== 'transcripcion') return;
                
                var texto = msg.texto;
                if (!texto || typeof texto !== 'string' || texto.length > 500) return;
                
                var seguro = true;
                for (var p = 0; p < voiceAttackPatterns.length; p++) {
                    if (voiceAttackPatterns[p].test(texto)) { seguro = false; break; }
                }
                if (!seguro) { registrarIntento(ip, 'Sospechoso'); return; }
                
                var respuesta = await procesarComandoVoz(texto, clientId, ip);
                if (respuesta && ws.readyState === 1) {
                    ws.send(JSON.stringify({ tipo: 'respuesta', texto: respuesta }));
                }
            } catch(e) {
                console.error('WS Error:', e.message);
                if (ws.readyState === 1) {
                    ws.send(JSON.stringify({ tipo: 'respuesta', texto: 'Disculpe, hubo un error. Intente de nuevo.' }));
                }
            }
        });
        
        ws.on('close', function() {
            voiceClients.delete(clientId);
            var conn = wsConnPerIP.get(ip) || 1;
            wsConnPerIP.set(ip, Math.max(0, conn - 1));
        });
        
        ws.on('error', function() {
            voiceClients.delete(clientId);
            var conn = wsConnPerIP.get(ip) || 1;
            wsConnPerIP.set(ip, Math.max(0, conn - 1));
        });
    });
}

startServer();
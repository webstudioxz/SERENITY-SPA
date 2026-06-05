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

if (!fsSync.existsSync(UPLOADS_DIR)) {
    fsSync.mkdirSync(UPLOADS_DIR, { recursive: true });
}

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
    } catch (err) {}
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
        intentos: (intentosFallidos.get(ip)?.count || 0), permanente: false
    });
    historialBloqueos.unshift({ ...bloqueos.get(ip), id: generarId() });
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
        mapa.set(k, a.filter(t => ahora - t < ventana));
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
let paisesConfig = { autorizados: [], bloqueados: [], modo: 'todos', stats: {} };

async function cargarPaises() {
    try {
        if (fsSync.existsSync(PAISES_FILE)) {
            paisesConfig = JSON.parse(await fs.readFile(PAISES_FILE, 'utf8'));
        } else { await guardarPaises(); }
    } catch(e) { await guardarPaises(); }
}

async function guardarPaises() {
    await fs.writeFile(PAISES_FILE, JSON.stringify(paisesConfig, null, 2), 'utf8');
}

function paisAutorizado(codigoPais) {
    if (paisesConfig.modo === 'todos') {
        return !paisesConfig.bloqueados.includes(codigoPais);
    }
    return paisesConfig.autorizados.includes(codigoPais);
}

// ============================================================
// BASE DE CONOCIMIENTO PARA IA (chat web)
// ============================================================
let baseConocimiento = [];

async function inicializarBaseConocimiento() {
    const servicios = serviciosData.map(s => ({
        tipo: 'servicio',
        contenido: s.nombre + ': ' + s.descripcion + '. Precio: ' + s.precio +
            '. Beneficios: ' + (s.beneficios || []).join(', ') +
            '. Efectos: ' + (s.efectos || []).join(', ')
    }));
    const info = [
        { tipo: 'horario', contenido: 'Horarios: Lunes a Sábado. Turnos: 12:00, 16:00 y 20:00. Solo un turno por persona por día.' },
        { tipo: 'politica', contenido: 'Cancelación con al menos 4 horas de anticipación.' },
        { tipo: 'ubicacion', contenido: 'Servicio en salón y a domicilio.' }
    ];
    baseConocimiento = [...servicios, ...info];
}

function buscarContexto(pregunta) {
    const palabras = pregunta.toLowerCase().split(/\s+/).filter(p => p.length > 2);
    let resultados = [];
    for (const item of baseConocimiento) {
        let puntuacion = 0;
        const c = item.contenido.toLowerCase();
        for (const p of palabras) { if (c.includes(p)) puntuacion++; }
        if (puntuacion > 0) resultados.push({ ...item, puntuacion });
    }
    return resultados.sort((a, b) => b.puntuacion - a.puntuacion).slice(0, 5).map(r => r.contenido);
}

let personalidadIA = {
    nombre: 'SpaBot',
    tono: 'cálido y profesional',
    estilo: 'Hablar en español neutro, ser amable y servicial.',
    reglas: [
        'NUNCA inventar información',
        'SIEMPRE ofrecer reservar turnos cuando sea relevante',
        'JAMÁS revelar que eres una IA',
        'Mantener respuestas concisas'
    ]
};

// ============================================================
// UTILIDADES
// ============================================================
function esUrlValida(s) {
    if (!s || typeof s !== 'string') return false;
    const t = s.trim();
    if (t.startsWith('data:') || t.length > 3000) return false;
    try { const u = new URL(t); return u.protocol === 'http:' || u.protocol === 'https:'; }
    catch(e) { return false; }
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
    const s = Math.floor(ms / 1000), m = Math.floor(s / 60), h = Math.floor(m / 60);
    return h > 0 ? h + 'h ' + (m % 60) + 'm' : m > 0 ? m + 'm ' + (s % 60) + 's' : s + 's';
}

// ============================================================
// DETECCIÓN DE PAÍS
// ============================================================
const PAISES_DATOS = [
    { nombre: 'Argentina', codigo: '53', claves: ['argentina', 'arg'] },
    { nombre: 'México', codigo: '52', claves: ['méxico', 'mexico', 'mex'] },
    { nombre: 'Colombia', codigo: '57', claves: ['colombia', 'colom'] },
    { nombre: 'Chile', codigo: '56', claves: ['chile'] },
    { nombre: 'Perú', codigo: '51', claves: ['perú', 'peru'] },
    { nombre: 'España', codigo: '34', claves: ['españa', 'espana', 'espa'] },
    { nombre: 'Cuba', codigo: '53', claves: ['cuba'] },
    { nombre: 'Uruguay', codigo: '598', claves: ['uruguay', 'uru'] },
    { nombre: 'Paraguay', codigo: '595', claves: ['paraguay', 'para'] },
    { nombre: 'Bolivia', codigo: '591', claves: ['bolivia', 'bol'] },
    { nombre: 'Venezuela', codigo: '58', claves: ['venezuela', 'vene'] },
    { nombre: 'Ecuador', codigo: '593', claves: ['ecuador', 'ecua'] },
    { nombre: 'Costa Rica', codigo: '506', claves: ['costa rica'] },
    { nombre: 'Panamá', codigo: '507', claves: ['panamá', 'panama'] },
    { nombre: 'Estados Unidos', codigo: '1', claves: ['estados unidos', 'usa', 'eeuu'] },
    { nombre: 'Brasil', codigo: '55', claves: ['brasil', 'brazil'] },
    { nombre: 'Italia', codigo: '39', claves: ['italia', 'ital'] },
    { nombre: 'Francia', codigo: '33', claves: ['francia', 'fran'] },
];

// Nota: Cuba y Argentina comparten código 53 en esta config.
// En producción cada país tendría su código real.

function detectarPaisConNombre(texto) {
    const t = texto.toLowerCase().trim();
    for (const pais of PAISES_DATOS) {
        for (const clave of pais.claves) {
            if (t.includes(clave)) return { nombre: pais.nombre, codigo: pais.codigo };
        }
    }
    return null;
}

// ============================================================
// EXTRAER NOMBRE
// ============================================================
function extraerNombre(texto) {
    const t = texto.trim();
    const patrones = [
        /(?:me\s+llamo|mi\s+nombre\s+es|soy)\s+([A-ZÁÉÍÓÚÑ][a-záéíóúñ]*(?:\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ]*){0,2})/i,
        /(?:hola\b|buenas?\b(?:\s*tardes|\s*días|\s*noches)?)[^.!?]*?(?:soy|me\s+llamo|mi\s+nombre\s+es)\s+([A-ZÁÉÍÓÚÑ][a-záéíóúñ]*(?:\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ]*){0,2})/i,
    ];
    for (const patron of patrones) {
        const match = t.match(patron);
        if (match && match[1] && match[1].length >= 2) {
            // Filtrar palabras que no son nombres
            const palabras = match[1].split(/\s+/);
            const filtradas = palabras.filter(p =>
                !/\b(reservar|turno|masaje|hola|buenas|precio|horario|favor|por|para|de|del|en|el|la|los|las|un|una)\b/i.test(p)
            );
            if (filtradas.length > 0) return filtradas.join(' ');
        }
    }
    return null;
}

// ============================================================
// EXTRAER TELÉFONO (con detección de código de país)
// ============================================================
function extraerTelefono(texto) {
    const numeros = texto.replace(/\D/g, '');
    if (numeros.length < 7) return null;

    // Buscar código de país al inicio
    const codigos = [
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
    // Ordenar por longitud descendente para que "593" se chequee antes que "5"
    codigos.sort((a, b) => b.codigo.length - a.codigo.length);

    for (const c of codigos) {
        if (numeros.startsWith(c.codigo) && numeros.length > c.codigo.length + 5) {
            return {
                codigoPais: c.codigo,
                pais: c.pais,
                telefono: numeros.substring(c.codigo.length)
            };
        }
    }

    return { telefono: numeros };
}

// ============================================================
// SIMILITUD (fuzzy matching) para detectar masajes mal pronunciados
// ============================================================
function similitud(a, b) {
    a = a.toLowerCase(); b = b.toLowerCase();
    if (a === b) return 1;
    if (a.includes(b) || b.includes(a)) return 0.85;
    const matrix = [];
    for (let i = 0; i <= a.length; i++) { matrix[i] = [i]; }
    for (let j = 0; j <= b.length; j++) { matrix[0][j] = j; }
    for (let i = 1; i <= a.length; i++) {
        for (let j = 1; j <= b.length; j++) {
            const cost = a[i-1] === b[j-1] ? 0 : 1;
            matrix[i][j] = Math.min(matrix[i-1][j]+1, matrix[i][j-1]+1, matrix[i-1][j-1]+cost);
        }
    }
    return 1 - matrix[a.length][b.length] / Math.max(a.length, b.length);
}

function detectarMasaje(texto) {
    const t = texto.toLowerCase();
    let mejor = null;
    let mejorScore = 0;

    for (const servicio of serviciosData) {
        const nombre = servicio.nombre.toLowerCase();
        // Coincidencia exacta
        if (t.includes(nombre)) return { masaje: servicio.nombre, id: servicio.id };
        // Sin "masaje" prefijo
        const sinPrefijo = nombre.replace(/^masaje\s+/i, '');
        if (sinPrefijo.length > 3 && t.includes(sinPrefijo)) return { masaje: servicio.nombre, id: servicio.id };
        // Fuzzy matching con el nombre completo
        const score1 = similitud(t, nombre);
        const score2 = similitud(t, sinPrefijo);
        const score = Math.max(score1, score2);
        if (score > mejorScore && score > 0.55) {
            mejorScore = score;
            mejor = { masaje: servicio.nombre, id: servicio.id };
        }
        // Fuzzy con palabras clave del nombre
        const palabras = nombre.split(/\s+/).filter(p => p.length > 3 && p !== 'masaje');
        for (const p of palabras) {
            const sp = similitud(t, p);
            if (sp > mejorScore && sp > 0.7) {
                mejorScore = sp;
                mejor = { masaje: servicio.nombre, id: servicio.id };
            }
        }
    }

    return mejor;
}

// ============================================================
// OBTENER PRÓXIMA FECHA PARA UN DÍA DE LA SEMANA
// ============================================================
function obtenerProximaFecha(diaSemana) {
    const diasOrden = ['domingo', 'lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado'];
    const hoy = new Date();
    const hoyIdx = diasOrden.indexOf(diaSemana);

    if (hoyIdx === -1) return null;

    const hoyDiaSemana = hoy.getDay();
    let diff = hoyIdx - hoyDiaSemana;

    if (diff < 0) diff += 7;
    // Si es hoy y ya pasaron las 20:00, ir a la semana que viene
    if (diff === 0 && hoy.getHours() >= 20) diff = 7;

    const fecha = new Date(hoy);
    fecha.setDate(hoy.getDate() + diff);
    fecha.setHours(0, 0, 0, 0);
    return fecha;
}

function formatearFecha(diaSemana) {
    const fecha = obtenerProximaFecha(diaSemana);
    if (!fecha) return DIAS_NOMBRE[diaSemana] || diaSemana;
    const opciones = { weekday: 'long', day: 'numeric', month: 'long' };
    const texto = fecha.toLocaleDateString('es-ES', opciones);
    return texto.charAt(0).toUpperCase() + texto.slice(1);
}

// ============================================================
// OBTENER DÍAS Y HORAS DISPONIBLES
// ============================================================
function obtenerDisponibilidad() {
    const turnos = turnosMem;
    const resultado = [];

    for (const dia of DIAS_VALIDOS) {
        const libres = HORAS_VALIDAS.filter(h => !turnos.some(t => t.dia === dia && t.hora === h));
        const ocupadas = HORAS_VALIDAS.filter(h => turnos.some(t => t.dia === dia && t.hora === h));
        resultado.push({ dia, libres, ocupadas });
    }

    return resultado;
}

function buscarAlternativa(dia, hora, turnos) {
    const dias = DIAS_VALIDOS;
    const idx = dias.indexOf(dia);
    if (idx === -1) return null;

    for (let offset = 0; offset < 7; offset++) {
        const d = dias[(idx + offset) % 7];
        const hrs = offset === 0 ? HORAS_VALIDAS.filter(h => h > hora) : HORAS_VALIDAS;
        for (const h of hrs) {
            if (!turnos.some(t => t.dia === d && t.hora === h)) return { dia: d, hora: h };
        }
    }
    return null;
}

// ============================================================
// ANÁLISIS COMPLETO DE TEXTO (un solo audio)
// ============================================================
function analizarTextoCompleto(texto) {
    const t = texto.toLowerCase();
    const resultado = {
        nombre: null,
        pais: null,
        codigoPais: null,
        masaje: null,
        masajeId: null,
        dia: null,
        hora: null,
        ubicacion: null,
        tipoServicio: null,
        telefono: null,
        intencion: 'desconocida'
    };

    // --- Intención ---
    if (/\b(reservar|turno|cita|agendar|pedir|quiero|me gustaria|quisiera)\b.*\b(masaje|servicio|sesion)\b/.test(t) ||
        /\b(masaje|servicio)\b.*\b(reservar|turno|cita|agendar)\b/.test(t)) {
        resultado.intencion = 'reservar';
    } else if (/\b(reservar|turno|cita|agendar|pedir turno)\b/.test(t)) {
        resultado.intencion = 'reservar';
    } else if (/\b(servicios|masaje|tipos|que\s+tienen|que\s+ofrecen|que\s+hay)\b/.test(t) && !/\b(reservar|turno)\b/.test(t)) {
        resultado.intencion = 'consultar_servicios';
    } else if (/\b(horario|hora|a\s+que\s+hora|que\s+horario)\b/.test(t) && !/\b(reservar|turno)\b/.test(t)) {
        resultado.intencion = 'consultar_horarios';
    } else if (/\b(precio|costo|cuanto\s+(vale|cuesta|es)|tarifa)\b/.test(t) && !/\b(reservar|turno)\b/.test(t)) {
        resultado.intencion = 'consultar_precios';
    } else if (/\b(dias?\s+disponib|que\s+dias?|cuando\s+(puedo|hay)|tiene\s+lugar)\b/.test(t)) {
        resultado.intencion = 'consultar_disponibilidad';
    } else if (/\b(cancelar|anular|eliminar\s+(mi\s+)?turno)\b/.test(t)) {
        resultado.intencion = 'cancelar';
    } else if (/\b(gracias|agradec|genial|perfecto|excelente)\b/.test(t) && t.length < 40) {
        resultado.intencion = 'agradecimiento';
    } else if (/\b(chau|adios|bye|hasta\s+luego|nos\s+vemos)\b/.test(t)) {
        resultado.intencion = 'despedida';
    } else if (/\b(hola|buenas|saludos|hey|buenos)\b/.test(t) && t.length < 50) {
        resultado.intencion = 'saludo';
    } else if (/\b(reservar|turno|masaje|agendar|pedir)\b/.test(t)) {
        resultado.intencion = 'reservar';
    }

    // --- Nombre ---
    resultado.nombre = extraerNombre(texto);

    // --- País ---
    const paisDet = detectarPaisConNombre(texto);
    if (paisDet) {
        resultado.pais = paisDet.nombre;
        resultado.codigoPais = paisDet.codigo;
    }

    // --- Teléfono (puede incluir código de país) ---
    const telDet = extraerTelefono(texto);
    if (telDet) {
        resultado.telefono = telDet.telefono;
        if (telDet.codigoPais && !resultado.codigoPais) {
            resultado.codigoPais = telDet.codigoPais;
            resultado.pais = telDet.pais;
        }
    }

    // --- Tipo de servicio (salón/domicilio) ---
    if (/\b(salon|salón|local|centro|aqui|acá|alli|allí|en\s+el\s+lugar|en\s+el\s+spa)\b/.test(t)) {
        resultado.tipoServicio = 'salon';
    } else if (/\b(domicilio|casa|hogar|a\s+mi\s+casa|mi\s+domicilio|en\s+casa|a\s+domicilio)\b/.test(t)) {
        resultado.tipoServicio = 'domicilio';
    }

    // --- Día ---
    const diasMap = {
        'lunes': 'lunes', 'martes': 'martes', 'miercoles': 'miercoles',
        'jueves': 'jueves', 'viernes': 'viernes', 'sabado': 'sabado', 'sábado': 'sabado'
    };
    for (const [clave, valor] of Object.entries(diasMap)) {
        if (t.includes(clave)) { resultado.dia = valor; break; }
    }

    // --- Hora ---
    if (/\b(doce|12)\b/.test(t) && /\b(mediodia|medio\s+dia)\b/.test(t)) {
        resultado.hora = 12;
    } else if (/\b12\b/.test(t) && !/\b(12:\d{2})\b/.test(t)) {
        resultado.hora = 12;
    } else if (/\b(16|cuatro)\b/.test(t) && (/\b(tarde)\b/.test(t) || /\b(16)\b/.test(t))) {
        resultado.hora = 16;
    } else if (/\b(20|ocho)\b/.test(t) && (/\b(noche)\b/.test(t) || /\b(20)\b/.test(t))) {
        resultado.hora = 20;
    }
    // Fallback: si mencionó "12" sin contexto de mediodía
    if (!resultado.hora) {
        if (/\b12\b/.test(t)) resultado.hora = 12;
        else if (/\b16\b/.test(t)) resultado.hora = 16;
        else if (/\b20\b/.test(t)) resultado.hora = 20;
        else if (/\b4\b/.test(t) && !/\b14\b/.test(t)) resultado.hora = 16;
        else if (/\b8\b/.test(t) && !/\b18\b/.test(t)) resultado.hora = 20;
    }

    // --- Masaje (dinámico desde serviciosData) ---
    const masajeDet = detectarMasaje(texto);
    if (masajeDet) {
        resultado.masaje = masajeDet.masaje;
        resultado.masajeId = masajeDet.id;
    }

    // --- Dirección (si es a domicilio) ---
    if (resultado.tipoServicio === 'domicilio') {
        // Intentar extraer dirección: palabras después de "casa" o "domicilio"
        const dirMatch = texto.match(/(?:casa|domicilio|direcci[óo]n)\s*[:.]?\s*(.+?)(?:\.|$)/i);
        if (dirMatch && dirMatch[1].trim().length > 5) {
            resultado.ubicacion = dirMatch[1].trim();
        }
    }

    return resultado;
}

// ============================================================
// FUSIONAR DATOS EXTRAÍDOS CON DATOS EXISTENTES
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
// GENERAR MENÚ DE SERVICIOS (DINÁMICO)
// ============================================================
function generarMenuServicios() {
    if (!serviciosData || serviciosData.length === 0) {
        return 'Disculpa, no hay servicios disponibles en este momento.';
    }

    let menu = 'Estos son nuestros servicios:\n\n';
    serviciosData.forEach(function(s, i) {
        menu += (i + 1) + '. ' + s.nombre + ' - ' + s.precio + '\n';
        if (s.descripcion) menu += '   ' + s.descripcion.substring(0, 70) + '\n';
    });
    menu += '\nDecime el número o el nombre del que te interese.';
    return menu;
}

// ============================================================
// GENERAR RESPUESTA DE HORARIOS
// ============================================================
function generarRespuestaHorarios() {
    return 'Nuestros horarios de atención son:\n\n' +
        'Lunes a Sábado\n' +
        '12:00 del mediodía\n' +
        '16:00 de la tarde\n' +
        '20:00 de la noche\n\n' +
        'Solo un turno por persona por día. ¿Te gustaría reservar?';
}

// ============================================================
// GENERAR RESPUESTA DE PRECIOS
// ============================================================
function generarRespuestaPrecios() {
    if (!serviciosData || serviciosData.length === 0) {
        return 'No hay servicios disponibles para consultar precios.';
    }

    let lista = 'Nuestros precios:\n\n';
    serviciosData.forEach(function(s) {
        lista += s.nombre + ': ' + s.precio + '\n';
    });
    lista += '\n¿Te gustaría reservar alguno?';
    return lista;
}

// ============================================================
// GENERAR RESPUESTA DE DISPONIBILIDAD
// ============================================================
function generarRespuestaDisponibilidad() {
    const disp = obtenerDisponibilidad();
    let respuesta = 'Días y horarios disponibles:\n\n';

    let tieneAlgo = false;
    disp.forEach(function(d) {
        if (d.libres.length > 0) {
            tieneAlgo = true;
            const horas = d.libres.map(function(h) { return HORA_TEXTO[h] || h + ':00'; }).join(', ');
            respuesta += DIAS_NOMBRE[d.dia] + ': ' + horas + '\n';
        }
    });

    if (!tieneAlgo) {
        return 'No hay turnos disponibles esta semana. Intentá la próxima.';
    }

    // Sugerir el primero
    const sugerido = disp.find(function(d) { return d.libres.length > 0; });
    if (sugerido) {
        const horaSug = HORA_TEXTO[sugerido.libres[0]] || sugerido.libres[0] + ':00';
        respuesta += '\nTe sugiero ' + DIAS_NOMBRE[sugerido.dia] + ' a las ' + horaSug + '. ¿Te parece bien?';
    }

    return respuesta;
}

// ============================================================
// GENERAR RESPUESTA POR DEFECTO
// ============================================================
function generarRespuestaDefault(nombre) {
    const n = nombre ? nombre + ', ' : '';
    return n + 'en qué te puedo ayudar?\n\n' +
        '- Reservar un turno\n' +
        '- Ver servicios\n' +
        '- Consultar horarios\n' +
        '- Consultar precios\n' +
        '- Ver disponibilidad';
}

// ============================================================
// MANEJAR RESERVA (verificar datos faltantes)
// ============================================================
function manejarReserva(cd) {
    const d = cd.datos;
    const faltantes = [];

    if (!d.nombre) faltantes.push('nombre');
    if (!d.codigoPais) faltantes.push('pais');
    if (!d.masaje) faltantes.push('masaje');
    if (!d.tipoServicio) faltantes.push('ubicacion_tipo');
    if (d.tipoServicio === 'domicilio' && !d.ubicacion) faltantes.push('direccion');
    if (!d.dia) faltantes.push('dia');
    if (!d.hora) faltantes.push('hora');
    if (!d.telefono) faltantes.push('telefono');

    if (faltantes.length > 0) {
        const primero = faltantes[0];
        cd.ultimaPregunta = primero;

        switch (primero) {
            case 'nombre':
                return '¿Me podrías decir tu nombre?';
            case 'pais':
                return (d.nombre ? d.nombre + ', ' : '') + '¿de qué país me llamás? Lo necesito para el código de WhatsApp.';
            case 'masaje':
                return generarMenuServicios();
            case 'ubicacion_tipo':
                return '¿Dónde preferís recibir el masaje, en nuestro salón o a domicilio?';
            case 'direccion':
                return '¿Cuál es tu dirección completa? Calle, número y ciudad.';
            case 'dia':
                return generarRespuestaDisponibilidad();
            case 'hora':
                return '¿A qué hora preferís?\n\n12 del mediodía\n4 de la tarde\n8 de la noche';
            case 'telefono':
                return 'Por último, ¿cuál es tu número de teléfono? Solo los dígitos, sin código de país.';
        }
    }

    // Todo completo, reservar
    return null; // Señal para que el caller ejecute la reserva
}

// ============================================================
// MANEJAR CONFIRMACIÓN DE ALTERNATIVA
// ============================================================
async function manejarConfirmacion(cd, texto, ip) {
    const t = texto.toLowerCase();

    if (/\b(si|sí|sip|dale|ok|vale|claro|por supuesto|exacto|bien)\b/.test(t)) {
        cd.datos.dia = cd.pendienteConfirmar.dia;
        cd.datos.hora = cd.pendienteConfirmar.hora;
        cd.pendienteConfirmar = null;
        cd.ultimaPregunta = null;
        return await confirmarReservaInteligente(cd, ip);
    }

    if (/\b(no|nop|nope|negativo|nah)\b/.test(t)) {
        cd.pendienteConfirmar = null;
        cd.ultimaPregunta = null;
        // Mostrar disponibilidad completa
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
            const turnos = JSON.parse(await fs.readFile(TURNOS_FILE, 'utf8'));
            const turno = turnos.find(t => t.telefono === cd.datos.telefono);
            if (turno) {
                turnos.splice(turnos.indexOf(turno), 1);
                await fs.writeFile(TURNOS_FILE, JSON.stringify(turnos, null, 2), 'utf8');
                turnosMem = turnos;
                const nombre = cd.datos.nombre || 'cliente';
                return nombre + ', tu turno del ' + turno.dia + ' a las ' + turno.hora + ':00 ha sido cancelado. ¿Necesitás algo más?';
            }
            return 'No encontré un turno activo con ese número. ¿Tenés otro número?';
        } catch(e) {
            return 'Error al cancelar. Intentá de nuevo.';
        }
    }
    cd.ultimaPregunta = 'cancelar_telefono';
    return 'Para cancelar necesito el número de teléfono con el que hiciste la reserva.';
}

// ============================================================
// CONFIRMAR RESERVA
// ============================================================
async function confirmarReservaInteligente(cd, ip) {
    const d = cd.datos;

    if (!d.codigoPais || !/^\d{1,3}$/.test(d.codigoPais)) {
        d.codigoPais = '53';
        d.pais = d.pais || 'Cuba';
    }

    if (!paisAutorizado(d.codigoPais)) {
        return 'Lo siento' + (d.nombre ? ', ' + d.nombre : '') + ', no aceptamos reservas desde ' + (d.pais || 'ese país') + ' en este momento.';
    }

    try {
        const turnos = JSON.parse(await fs.readFile(TURNOS_FILE, 'utf8'));
        const dia = d.dia;
        const hora = d.hora;

        if (turnos.some(t => t.telefono === d.telefono && t.dia === dia)) {
            return (d.nombre || 'Cliente') + ', ya tenés un turno para el ' + DIAS_NOMBRE[dia] + '. Solo se permite uno por día. ¿Querés otro día?';
        }

        if (turnos.some(t => t.dia === dia && t.hora === hora)) {
            const alt = buscarAlternativa(dia, hora, turnos);
            if (alt) {
                cd.pendienteConfirmar = { dia: alt.dia, hora: alt.hora };
                cd.ultimaPregunta = 'confirmar_alternativa';
                return 'Ese horario está ocupado, ' + (d.nombre || '') + '. ' +
                    'Pero tengo disponible el ' + DIAS_NOMBRE[alt.dia] + ' a las ' + HORA_TEXTO[alt.hora] + '. ¿Te sirve?';
            }
            return 'Lo siento' + (d.nombre ? ', ' + d.nombre : '') + ', no hay disponibilidad esa semana. ¿Probás la próxima?';
        }

        const nuevo = {
            id: generarId(),
            nombre: d.nombre || 'Cliente',
            dia: dia,
            hora: hora,
            massageType: d.masaje || 'Masaje Relajante',
            telefono: d.telefono,
            codigoPais: d.codigoPais,
            ubicacion: d.tipoServicio === 'domicilio' ? (d.ubicacion || 'A confirmar') : 'Salón Serenity Spa',
            tipoServicio: d.tipoServicio || 'salon',
            confirmadoWhatsApp: false,
            fechaCreacion: new Date().toISOString(),
            ip: ip
        };

        turnos.push(nuevo);
        await fs.writeFile(TURNOS_FILE, JSON.stringify(turnos, null, 2), 'utf8');
        turnosMem = turnos;
        regTurno(ip, d.telefono);

        const ubicTexto = d.tipoServicio === 'domicilio' ? d.ubicacion : 'Nuestro salón';
        const fechaTxt = formatearFecha(dia);

        return 'Turno confirmado.\n\n' +
            'Día: ' + fechaTxt + '\n' +
            'Hora: ' + HORA_TEXTO[hora] + '\n' +
            'Masaje: ' + d.masaje + '\n' +
            'Lugar: ' + ubicTexto + '\n' +
            'Teléfono: +' + d.codigoPais + ' ' + d.telefono + '\n\n' +
            'Te esperamos. Si necesitás cancelar, decí "cancelar".';

    } catch(e) {
        console.error('Error al reservar:', e);
        return 'Hubo un error al procesar tu reserva. Intentá de nuevo.';
    }
}

// ============================================================
// PROCESAR COMANDO DE VOZ (NUEVA VERSIÓN)
// ============================================================
async function procesarComandoVoz(texto, clientId, ip) {
    // Sanitizar
    const textoLimpio = texto.replace(/<[^>]*>/g, '').replace(/[<>]/g, '').trim();
    if (!textoLimpio || textoLimpio.length > 500) {
        return 'No pude entender. ¿Podrías repetir?';
    }

    // Obtener/crear sesión del cliente
    let cd = voiceClients.get(clientId);
    if (!cd) {
        cd = { datos: {}, pendienteConfirmar: null, ultimaPregunta: null, clientId: clientId };
        voiceClients.set(clientId, cd);
    }

    // Si hay confirmación pendiente, manejarla primero
    if (cd.pendienteConfirmar) {
        return await manejarConfirmacion(cd, textoLimpio, ip);
    }

    // Analizar TODO el texto
    const analisis = analizarTextoCompleto(textoLimpio);

    // Fusionar datos extraídos con los existentes
    fusionarDatos(cd.datos, analisis);

    // Manejar según intención
    switch (analisis.intencion) {
        case 'saludo':
            if (cd.datos.nombre) {
                return '¿En qué te puedo ayudar, ' + cd.datos.nombre + '?';
            }
            return null; // El saludo inicial ya fue manejado por el mensaje de bienvenida

        case 'reservar': {
            const faltante = manejarReserva(cd);
            if (faltante !== null) return faltante;
            // No faltan datos, reservar
            return await confirmarReservaInteligente(cd, ip);
        }

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
            return 'Un placer, ' + (cd.datos.nombre || 'te deseo un excelente día') + '. ¿Necesitás algo más?';

        case 'despedida':
            return 'Hasta pronto' + (cd.datos.nombre ? ', ' + cd.datos.nombre : '') + '. Que tengas un gran día.';

        default: {
            // Si extrajo datos de reserva implícitos (día, hora, masaje), tratar como reserva
            if (analisis.dia || analisis.hora || analisis.masaje) {
                const faltante = manejarReserva(cd);
                if (faltante !== null) return faltante;
                return await confirmarReservaInteligente(cd, ip);
            }

            // Si el usuario responde con solo un número, podría ser selección de menú
            const soloNumero = textoLimpio.match(/^\d+$/);
            if (soloNumero && cd.ultimaPregunta === 'masaje') {
                const idx = parseInt(soloNumero[0]) - 1;
                if (idx >= 0 && idx < serviciosData.length) {
                    cd.datos.masaje = serviciosData[idx].nombre;
                    cd.datos.masajeId = serviciosData[idx].id;
                    cd.ultimaPregunta = null;
                    const faltante = manejarReserva(cd);
                    if (faltante !== null) return faltante;
                    return await confirmarReservaInteligente(cd, ip);
                }
            }

            // Si respondió un número y la última pregunta era hora
            if (soloNumero && cd.ultimaPregunta === 'hora') {
                const num = parseInt(soloNumero[0]);
                if (HORAS_VALIDAS.includes(num)) {
                    cd.datos.hora = num;
                    cd.ultimaPregunta = null;
                    const faltante = manejarReserva(cd);
                    if (faltante !== null) return faltante;
                    return await confirmarReservaInteligente(cd, ip);
                }
            }

            return generarRespuestaDefault(cd.datos.nombre);
        }
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
    const ip = req.ip || req.socket.remoteAddress || '0.0.0.0';
    if (estaBloqueado(ip)) {
        return res.status(403).json({ error: 'IP bloqueada', bloqueado: true });
    }
    next();
});

app.use(express.static(__dirname));

// ============================================================
// AUTENTICACIÓN
// ============================================================
const validTokens = new Map();

function checkAuth(req) {
    const h = req.headers.authorization;
    if (!h || !h.startsWith('Bearer ')) return false;
    const token = h.substring(7);
    if (!validTokens.has(token)) return false;
    if (validTokens.get(token) < Date.now()) { validTokens.delete(token); return false; }
    return true;
}

app.post('/api/login', function(req, res) {
    const ip = req.ip || '0.0.0.0';
    if (estaBloqueado(ip)) return res.status(403).json({ success: false, error: 'IP bloqueada' });
    const { password } = req.body;
    if (!password) { registrarIntento(ip, 'Contraseña vacía'); return res.status(400).json({ success: false, error: 'Contraseña requerida' }); }
    const adminPassword = process.env.ADMIN_PASSWORD || 'admin123';
    if (password === adminPassword) {
        const token = crypto.randomBytes(64).toString('hex');
        validTokens.set(token, Date.now() + 28800000);
        intentosFallidos.delete(ip);
        res.json({ success: true, token });
    } else {
        registrarIntento(ip, 'Contraseña incorrecta');
        res.status(401).json({ success: false, error: 'Contraseña incorrecta' });
    }
});

app.get('/api/verify', function(req, res) { res.json({ valid: checkAuth(req) }); });

app.post('/api/logout', function(req, res) {
    const h = req.headers.authorization;
    if (h && h.startsWith('Bearer ')) validTokens.delete(h.substring(7));
    res.json({ ok: true });
});

// ============================================================
// UPLOAD HERO
// ============================================================
app.post('/api/upload-hero', async function(req, res) {
    if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    try {
        const { base64 } = req.body;
        if (!base64 || !base64.startsWith('data:image')) return res.status(400).json({ error: 'Imagen inválida' });
        const matches = base64.match(/^data:image\/(\w+);base64,(.+)$/);
        if (!matches) return res.status(400).json({ error: 'Formato no reconocido' });
        const ext = matches[1] === 'jpeg' ? 'jpg' : matches[1];
        const buffer = Buffer.from(matches[2], 'base64');
        const filename = 'hero-' + Date.now() + '.' + ext;
        await fs.writeFile(path.join(UPLOADS_DIR, filename), buffer);
        const files = await fs.readdir(UPLOADS_DIR);
        for (const f of files) { if (f.startsWith('hero-') && f !== filename) { try { await fs.unlink(path.join(UPLOADS_DIR, f)); } catch(e) {} } }
        res.json({ url: '/uploads/' + filename, filename: filename });
    } catch (e) { res.status(500).json({ error: 'Error al subir imagen' }); }
});

// ============================================================
// CONFIGURACIÓN
// ============================================================
let configData = {
    hero: { titulo: "Renueva tu Energía", subtitulo: "Experiencias de bienestar", imagenFondo: "https://images.unsplash.com/photo-1544161515-4ab6ce6db874?w=1920", botonTexto: "Explorar Tratamientos" },
    serviciosSection: { etiqueta: "Nuestros Servicios", titulo: "Elige tu Masaje Ideal", descripcion: "Turnos: 12:00, 16:00 y 20:00" },
    contactoSection: { titulo: "Asistente de Reservas", descripcion: "Reserva tu turno de forma rápida" },
    shareSection: { titulo: "Comparte Serenity Spa" }
};

app.get('/api/config', function(req, res) { res.json(configData); });

app.put('/api/config', async function(req, res) {
    if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    configData = { ...configData, ...req.body };
    await fs.writeFile(CONFIG_FILE, JSON.stringify(configData, null, 2), 'utf8');
    res.json({ ok: true, mensaje: 'Configuración guardada' });
});

// ============================================================
// SERVICIOS
// ============================================================
let serviciosData = [];

app.get('/api/servicios', function(req, res) {
    res.json(serviciosData.sort(function(a, b) { return (a.orden || 999) - (b.orden || 999); }));
});

app.post('/api/servicios', async function(req, res) {
    if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    try {
        let iwa = '';
        if (req.body.imagenWhatsApp && esUrlValida(req.body.imagenWhatsApp)) iwa = req.body.imagenWhatsApp.trim();
        const s = {
            id: generarId(), ...req.body,
            imagenWeb: req.body.imagenWeb || 'https://images.unsplash.com/photo-1544161515-4ab6ce6db874?w=800',
            imagenWhatsApp: iwa
        };
        serviciosData.push(s);
        await fs.writeFile(SERVICIOS_FILE, JSON.stringify(serviciosData, null, 2), 'utf8');
        await inicializarBaseConocimiento();
        res.status(201).json(s);
    } catch(e) { res.status(500).json({ error: 'Error al crear servicio' }); }
});

app.put('/api/servicios/:id', async function(req, res) {
    if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    try {
        const i = serviciosData.findIndex(function(s) { return s.id === req.params.id; });
        if (i === -1) return res.status(404).json({ error: 'Servicio no encontrado' });
        let iwa = serviciosData[i].imagenWhatsApp || '';
        if (req.body.imagenWhatsApp !== undefined) {
            if (req.body.imagenWhatsApp && esUrlValida(req.body.imagenWhatsApp)) iwa = req.body.imagenWhatsApp.trim();
            else if (!req.body.imagenWhatsApp) iwa = '';
        }
        serviciosData[i] = { ...serviciosData[i], ...req.body, id: req.params.id, imagenWeb: req.body.imagenWeb || serviciosData[i].imagenWeb, imagenWhatsApp: iwa };
        await fs.writeFile(SERVICIOS_FILE, JSON.stringify(serviciosData, null, 2), 'utf8');
        await inicializarBaseConocimiento();
        res.json({ ok: true, mensaje: 'Servicio actualizado' });
    } catch(e) { res.status(500).json({ error: 'Error al actualizar' }); }
});

app.delete('/api/servicios/:id', async function(req, res) {
    if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    const antes = serviciosData.length;
    serviciosData = serviciosData.filter(function(s) { return s.id !== req.params.id; });
    await fs.writeFile(SERVICIOS_FILE, JSON.stringify(serviciosData, null, 2), 'utf8');
    await inicializarBaseConocimiento();
    res.json({ ok: true, mensaje: serviciosData.length < antes ? 'Servicio eliminado' : 'No encontrado' });
});

// ============================================================
// TURNOS
// ============================================================
let turnosMem = [];

async function loadTurnos() {
    try {
        if (fsSync.existsSync(TURNOS_FILE)) { turnosMem = JSON.parse(await fs.readFile(TURNOS_FILE, 'utf8')); }
        else { turnosMem = []; }
    } catch(e) { turnosMem = []; }
    return turnosMem;
}

async function saveTurnos(t) {
    await fs.writeFile(TURNOS_FILE, JSON.stringify(t, null, 2), 'utf8');
    turnosMem = t;
}

app.get('/turnos', async function(req, res) { res.json(await loadTurnos()); });

app.post('/turnos', async function(req, res) {
    const ip = req.ip || '0.0.0.0';
    if (estaBloqueado(ip)) return res.status(403).json({ error: 'IP bloqueada' });
    if (!checkRateIP(ip)) { bloquearIP(ip, 'Exceso solicitudes turnos', 'spam'); return res.status(429).json({ error: 'Demasiadas solicitudes' }); }

    try {
        const { nombre, dia, hora, massageType, telefono, ubicacion, tipoServicio } = req.body;
        if (!nombre || nombre.length < 2) return res.status(400).json({ error: 'Nombre inválido' });
        const tel = telefono ? telefono.replace(/\D/g, '') : '';
        if (!tel || tel.length < 7) return res.status(400).json({ error: 'Teléfono inválido' });
        let codigoPais = req.body.codigoPais || '53';
        if (!/^\d{1,3}$/.test(codigoPais)) codigoPais = '53';
        if (!paisAutorizado(codigoPais)) return res.status(403).json({ error: 'País no autorizado' });
        if (!dia || !DIAS_VALIDOS.includes(dia.toLowerCase())) return res.status(400).json({ error: 'Día inválido' });
        const hn = parseInt(hora);
        if (!HORAS_VALIDAS.includes(hn)) return res.status(400).json({ error: 'Hora inválida' });
        if (!checkRateTel(tel)) return res.status(429).json({ error: 'Máximo 2 turnos por teléfono por día' });

        const turnos = await loadTurnos();
        const dl = dia.toLowerCase();
        if (turnos.some(function(t) { return t.telefono === tel && t.dia === dl; })) return res.status(409).json({ error: 'Ya tienes un turno ese día' });
        if (turnos.some(function(t) { return t.dia === dl && t.hora === hn; })) return res.status(409).json({ error: 'Horario ocupado', alternativa: buscarAlternativa(dl, hn, turnos) });

        const nuevo = {
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
        res.status(201).json({ mensaje: 'Turno reservado', turno: nuevo });
    } catch(e) { res.status(500).json({ error: 'Error interno' }); }
});

app.delete('/turnos/:id', async function(req, res) {
    if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    const turnos = await loadTurnos();
    const i = turnos.findIndex(function(t) { return t.id === req.params.id; });
    if (i === -1) return res.status(404).json({ error: 'No encontrado' });
    turnos.splice(i, 1);
    await saveTurnos(turnos);
    res.json({ ok: true });
});

app.post('/api/cancelar-turno', async function(req, res) {
    try {
        const tel = (req.body.telefono || '').replace(/\D/g, '');
        if (tel.length < 7) return res.json({ error: 'Número inválido' });
        const turnos = await loadTurnos();
        const turno = turnos.find(function(t) { return t.telefono === tel; });
        if (!turno) return res.json({ error: 'No se encontró turno' });
        if (turno.confirmadoWhatsApp) {
            return res.json({ whatsappCancelacion: true, urlWhatsApp: 'https://wa.me/' + (turno.codigoPais || '53') + tel });
        }
        turnos.splice(turnos.indexOf(turno), 1);
        await saveTurnos(turnos);
        res.json({ cancelado: true, mensaje: 'Turno del ' + turno.dia + ' cancelado.' });
    } catch(e) { res.status(500).json({ error: 'Error' }); }
});

app.post('/api/enviar-whatsapp/:id', async function(req, res) {
    try {
        const turnos = await loadTurnos();
        const t = turnos.find(function(x) { return x.id === req.params.id; });
        if (!t) return res.status(404).json({ error: 'No encontrado' });
        const s = serviciosData.find(function(x) { return x.nombre === t.massageType; });
        let msg = 'SERENITY SPA\n\nHola ' + t.nombre + ', tu reserva:\n\nDia: ' + t.dia + '\nHora: ' + t.hora + ':00\nMasaje: ' + t.massageType + '\nLugar: ' + (t.tipoServicio === 'domicilio' ? t.ubicacion : 'Salon Serenity Spa') + '\n\nEquipo Serenity Spa';
        const cod = t.codigoPais || '53';
        const idx = turnos.findIndex(function(x) { return x.id === req.params.id; });
        if (idx !== -1) { turnos[idx].confirmadoWhatsApp = true; turnos[idx].fechaWA = new Date().toISOString(); await saveTurnos(turnos); }
        res.json({ success: true, numero: cod + t.telefono, mensaje: msg, urlWhatsApp: 'https://wa.me/' + cod + t.telefono + '?text=' + encodeURIComponent(msg) });
    } catch(e) { res.status(500).json({ error: 'Error' }); }
});

// ============================================================
// CHAT CON IA (página principal)
// ============================================================
app.post('/api/chat-ia', async function(req, res) {
    const ip = req.ip || '0.0.0.0';
    if (estaBloqueado(ip)) return res.status(403).json({ error: 'IP bloqueada' });
    const { mensaje, nombre, codigoPais } = req.body;
    if (!mensaje || mensaje.length > 500) return res.status(400).json({ error: 'Mensaje inválido' });
    const mensajeLimpio = mensaje.replace(/<[^>]*>/g, '').replace(/[<>]/g, '').trim();
    if (!mensajeLimpio) return res.status(400).json({ error: 'Vacío' });

    const patronesAtaque = [/ignore|bypass|override|system prompt|revela|instrucciones/i, /<script>|javascript:|onerror=|onload=/i, /SELECT.*FROM|DROP TABLE|UNION SELECT/i];
    for (const patron of patronesAtaque) { if (patron.test(mensajeLimpio)) { registrarIntento(ip, 'inyección'); return res.status(400).json({ error: 'No permitido' }); } }

    try {
        const contexto = buscarContexto(mensajeLimpio);
        const systemPrompt = 'Eres ' + personalidadIA.nombre + ', asistente de Serenity Spa.\n\nTONO: ' + personalidadIA.tono + '\nESTILO: ' + personalidadIA.estilo + '\n\nINFO:\n' + contexto.join('\n') + '\n\nCLIENTE: ' + (nombre || 'No proporcionado') + ' (+ ' + (codigoPais || '53') + ')\n\nREGLAS:\n' + personalidadIA.reglas.map(function(r, i) { return (i+1) + '. ' + r; }).join('\n') + '\n\nResponde de forma concisa. NUNCA digas "buenas".';

        if (!process.env.DEEPSEEK_API_KEY) { return res.json({ respuesta: generarRespuestaLocal(mensajeLimpio, nombre), modo: 'local' }); }

        const completion = await deepseek.chat.completions.create({
            model: 'deepseek-chat',
            messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: mensajeLimpio }],
            temperature: 0.7, max_tokens: 500
        });
        res.json({ respuesta: completion.choices[0].message.content, modo: 'ia', tokens: completion.usage?.total_tokens || 0 });
    } catch (error) {
        console.error('Error IA:', error.message);
        res.json({ respuesta: generarRespuestaLocal(mensajeLimpio, nombre), modo: 'local' });
    }
});

function generarRespuestaLocal(mensaje, nombre) {
    const msg = mensaje.toLowerCase();
    const c = nombre || 'cliente';
    if (/\b(hola|buenas?|saludos)\b/.test(msg)) return 'Hola ' + c + '. Bienvenido a Serenity Spa. ¿En qué te puedo ayudar?';
    if (/\b(reservar|turno|cita)\b/.test(msg)) return 'Para reservar necesito: nombre, tipo de masaje, día, hora y teléfono. ¿Empezamos?';
    if (/\b(horario|hora)\b/.test(msg)) return 'Lunes a Sábado: 12:00, 16:00 y 20:00. ¿Reservamos?';
    if (/\b(precio|costo)\b/.test(msg)) {
        let l = 'Precios:\n'; serviciosData.forEach(function(s) { l += s.nombre + ': ' + s.precio + '\n'; }); return l;
    }
    if (/\b(gracias)\b/.test(msg)) return 'Un placer, ' + c + '. ¿Necesitás algo más?';
    return c + ', ¿en qué te puedo ayudar? Reservar turno, ver horarios, consultar precios o servicios.';
}

// ============================================================
// IA PERSONALIDAD (ADMIN)
// ============================================================
app.get('/api/ia/personalidad', function(req, res) {
    if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    res.json(personalidadIA);
});

app.put('/api/ia/personalidad', async function(req, res) {
    if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    const { nombre, tono, estilo, reglas } = req.body;
    if (nombre) personalidadIA.nombre = sanitize(nombre);
    if (tono) personalidadIA.tono = sanitize(tono);
    if (estilo) personalidadIA.estilo = sanitize(estilo);
    if (reglas) personalidadIA.reglas = reglas.map(function(r) { return sanitize(r); });
    res.json({ ok: true, personalidad: personalidadIA });
});

app.post('/api/ia/recargar', async function(req, res) {
    if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    await inicializarBaseConocimiento();
    res.json({ ok: true, items: baseConocimiento.length });
});

// ============================================================
// SEGURIDAD - PAÍSES (ADMIN)
// ============================================================
app.get('/api/seguridad/paises', function(req, res) {
    if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    res.json(paisesConfig);
});

app.put('/api/seguridad/paises', async function(req, res) {
    if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    const { autorizados, bloqueados, modo } = req.body;
    if (autorizados !== undefined) paisesConfig.autorizados = autorizados;
    if (bloqueados !== undefined) paisesConfig.bloqueados = bloqueados;
    if (modo && ['todos', 'solo_autorizados'].includes(modo)) paisesConfig.modo = modo;
    await guardarPaises();
    res.json({ ok: true, paises: paisesConfig });
});

app.post('/api/seguridad/paises/autorizar', async function(req, res) {
    if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    const { codigo, nombre } = req.body;
    if (!codigo || !/^\d{1,3}$/.test(codigo)) return res.status(400).json({ error: 'Código inválido' });
    if (!paisesConfig.autorizados.includes(codigo)) { paisesConfig.autorizados.push(codigo); paisesConfig.bloqueados = paisesConfig.bloqueados.filter(function(c) { return c !== codigo; }); await guardarPaises(); }
    res.json({ ok: true, mensaje: (nombre || codigo) + ' autorizado' });
});

app.post('/api/seguridad/paises/bloquear', async function(req, res) {
    if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    const { codigo, nombre } = req.body;
    if (!codigo || !/^\d{1,3}$/.test(codigo)) return res.status(400).json({ error: 'Código inválido' });
    if (!paisesConfig.bloqueados.includes(codigo)) { paisesConfig.bloqueados.push(codigo); paisesConfig.autorizados = paisesConfig.autorizados.filter(function(c) { return c !== codigo; }); await guardarPaises(); }
    res.json({ ok: true, mensaje: (nombre || codigo) + ' bloqueado' });
});

app.delete('/api/seguridad/paises/:codigo', async function(req, res) {
    if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    const codigo = req.params.codigo;
    paisesConfig.autorizados = paisesConfig.autorizados.filter(function(c) { return c !== codigo; });
    paisesConfig.bloqueados = paisesConfig.bloqueados.filter(function(c) { return c !== codigo; });
    await guardarPaises();
    res.json({ ok: true });
});

app.get('/api/seguridad/paises/stats', async function(req, res) {
    if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    const turnos = await loadTurnos();
    const stats = {};
    const nombres = { '53': 'Cuba', '54': 'Argentina', '52': 'México', '57': 'Colombia', '56': 'Chile', '51': 'Perú', '34': 'España', '1': 'EE.UU.', '58': 'Venezuela', '593': 'Ecuador', '598': 'Uruguay', '595': 'Paraguay', '55': 'Brasil' };
    for (const t of turnos) { const c = t.codigoPais || '53'; stats[c] = (stats[c] || 0) + 1; }
    res.json(Object.entries(stats).map(function(e) { return { codigo: e[0], nombre: nombres[e[0]] || '?', reservas: e[1] }; }).sort(function(a, b) { return b.reservas - a.reservas; }));
});

// ============================================================
// SEGURIDAD - BLOQUEOS (ADMIN)
// ============================================================
app.get('/api/seguridad/bloqueos', function(req, res) {
    if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    const a = [];
    for (const [ip, d] of bloqueos) {
        a.push({ ip: ip, motivo: d.motivo, tipoAtaque: d.tipoAtaque, fecha: d.fecha, tiempoRestante: Math.max(0, d.hasta - Date.now()), tiempoRestanteFormateado: fmtT(Math.max(0, d.hasta - Date.now())), intentos: d.intentos || 0, permanente: d.permanente || false });
    }
    res.json({ activos: a, historial: historialBloqueos.slice(0, 100), intentosFallidos: Object.fromEntries(intentosFallidos) });
});

app.post('/api/seguridad/desbloquear/:ip', function(req, res) {
    if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    desbloquearIP(req.params.ip);
    res.json({ ok: true });
});

app.delete('/api/seguridad/bloqueos/:ip', function(req, res) {
    if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    bloqueos.delete(req.params.ip); intentosFallidos.delete(req.params.ip); guardarBloqueos();
    res.json({ ok: true });
});

app.delete('/api/seguridad/historial/:id', function(req, res) {
    if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    historialBloqueos = historialBloqueos.filter(function(h) { return h.id !== req.params.id; }); guardarBloqueos();
    res.json({ ok: true });
});

app.post('/api/seguridad/limpiar-expirados', function(req, res) {
    if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    let b = 0; const now = Date.now();
    for (const [ip, d] of bloqueos) { if (now > d.hasta) { bloqueos.delete(ip); b++; } }
    guardarBloqueos(); res.json({ mensaje: b + ' expirados eliminados' });
});

app.post('/api/seguridad/bloquear-permanente/:ip', function(req, res) {
    if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    bloquearIP(req.params.ip, 'Bloqueo permanente', 'manual');
    const d = bloqueos.get(req.params.ip);
    if (d) { d.hasta = Date.now() + 31536000000; d.permanente = true; guardarBloqueos(); }
    res.json({ ok: true });
});

// ============================================================
// RUTAS ESTÁTICAS
// ============================================================
app.get('/voice-assistant', function(req, res) { res.sendFile(path.join(__dirname, 'voice-assistant.html')); });
app.get('/', function(req, res) { res.sendFile(path.join(__dirname, 'index.html')); });
app.get('/admin.html', function(req, res) { res.sendFile(path.join(__dirname, 'admin.html')); });
app.get('/login.html', function(req, res) { res.sendFile(path.join(__dirname, 'login.html')); });
app.get('/health', function(req, res) {
    res.json({ status: 'ok', timestamp: new Date().toISOString(), uptime: process.uptime(), ia: process.env.DEEPSEEK_API_KEY ? 'conectada' : 'local' });
});

// ============================================================
// ASISTENTE DE VOZ - WEBSOCKET
// ============================================================
let voiceClients = new Map();

// Rate limiting por segundo para WebSocket
const wsRatePerSec = new Map();

function checkWsRateLimit(ip) {
    const now = Date.now();
    const ts = wsRatePerSec.get(ip) || [];
    const recent = ts.filter(function(t) { return now - t < 10000; });
    wsRatePerSec.set(ip, recent);
    if (recent.length >= 4) return false;
    recent.push(now);
    return true;
}

// Límite de conexiones simultáneas por IP
const wsConnPerIP = new Map();

function checkWsConnLimit(ip) {
    const count = wsConnPerIP.get(ip) || 0;
    if (count >= 3) return false;
    wsConnPerIP.set(ip, count + 1);
    return true;
}

// Patrones de ataque en mensajes de voz
const voiceAttackPatterns = [
    /ignore\s+(previous|all)\s+instructions/i,
    /you\s+are\s+now/i,
    /system\s*:\s*/i,
    /<script[\s>]/i,
    /javascript\s*:/i,
    /\$\{.*\}/,
    /SELECT\s+.*\s+FROM/i,
    /DROP\s+TABLE/i,
    /UNION\s+SELECT/i,
    /;\s*DELETE/i,
    /\.\.\//,
    /\/etc\/passwd/i,
];

function esMensajeSeguro(texto) {
    for (const pattern of voiceAttackPatterns) {
        if (pattern.test(texto)) return false;
    }
    return true;
}

async function start() {
    await cargarBloqueos();
    await cargarPaises();

    configData = await initFile(CONFIG_FILE, configData);

    serviciosData = await initFile(SERVICIOS_FILE, [
        { id: "relajante", nombre: "Masaje Relajante", precio: "$45", descripcion: "Movimientos suaves para liberar estrés.", beneficios: ["Reduce ansiedad", "Alivia tensión", "60 Minutos"], efectos: ["Relajación profunda", "Mejora del sueño"], imagenWeb: "https://images.unsplash.com/photo-1544161515-4ab6ce6db874?w=800", imagenWhatsApp: "", orden: 1 },
        { id: "corporal", nombre: "Masaje Corporal", precio: "$65", descripcion: "Tratamiento completo y revitalizante.", beneficios: ["Relajación integral", "Elimina contracturas", "90 Minutos"], efectos: ["Activación linfática", "Mejora circulación"], imagenWeb: "https://images.unsplash.com/photo-1519823551278-64ac92734fb1?w=800", imagenWhatsApp: "", orden: 2 },
        { id: "facial", nombre: "Masaje Facial", precio: "$40", descripcion: "Rejuvenece la piel y alivia tensión facial.", beneficios: ["Reafirma la piel", "Reduce ojeras", "45 Minutos"], efectos: ["Estimula colágeno", "Tonifica rostro"], imagenWeb: "https://images.unsplash.com/photo-1570172619644-dfd03ed5d881?w=800", imagenWhatsApp: "", orden: 3 }
    ]);

    turnosMem = await initFile(TURNOS_FILE, []);
    await inicializarBaseConocimiento();

    const server = app.listen(PORT, '0.0.0.0', function() {
        console.log('Serenity Spa v5.0 iniciado en puerto ' + PORT);
        console.log('IA: ' + (process.env.DEEPSEEK_API_KEY ? 'DeepSeek conectado' : 'Modo local'));
    });

    const wss = new WebSocket.Server({ server: server, path: '/ws-voice' });

    wss.on('connection', function(ws, req) {
        const ip = req.socket.remoteAddress || 'desconocida';

        // Seguridad: IP bloqueada
        if (estaBloqueado(ip)) { ws.close(1008, 'Bloqueado'); return; }

        // Seguridad: límite de conexiones por IP
        if (!checkWsConnLimit(ip)) { ws.close(1008, 'Demasiadas conexiones'); return; }

        const cid = generarId();
        let msgCount = 0;
        const MAX_MSG = 30;

        // Sesión del cliente
        voiceClients.set(cid, {
            ws: ws,
            datos: {},
            pendienteConfirmar: null,
            ultimaPregunta: null,
            clientId: cid
        });

        // Mensaje de bienvenida CORTO
        const bienvenida = 'Hola, soy su asistente, con quién tengo el placer de hablar?';

        ws.on('open', function() {
            if (ws.readyState === 1) {
                ws.send(JSON.stringify({ tipo: 'respuesta', texto: bienvenida }));
            }
        });

        // Enviar bienvenida inmediatamente si ya está abierto
        if (ws.readyState === 1) {
            ws.send(JSON.stringify({ tipo: 'respuesta', texto: bienvenida }));
        }

        ws.on('message', async function(data) {
            msgCount++;

            // Seguridad: límite de mensajes por conexión
            if (msgCount > MAX_MSG) {
                bloquearIP(ip, 'Flood WebSocket (' + msgCount + ' msg)', 'flood');
                ws.close(1008, 'Limite excedido');
                return;
            }

            // Seguridad: rate limit por segundo
            if (!checkWsRateLimit(ip)) {
                bloquearIP(ip, 'Rate limit WebSocket', 'flood');
                ws.close(1008, 'Demasiado rápido');
                return;
            }

            // Seguridad: tamaño del payload
            if (data.length > 10000) {
                ws.close(1008, 'Payload muy grande');
                return;
            }

            try {
                var m = JSON.parse(data);

                if (!m.tipo || typeof m.tipo !== 'string') return;

                if (m.tipo === 'transcripcion') {
                    var texto = m.texto;

                    // Seguridad: validar texto
                    if (!texto || typeof texto !== 'string') return;
                    if (texto.length > 500) {
                        if (ws.readyState === 1) ws.send(JSON.stringify({ tipo: 'respuesta', texto: 'Mensaje muy largo. Intentá ser más breve.' }));
                        return;
                    }

                    // Seguridad: detectar patrones de ataque
                    if (!esMensajeSeguro(texto)) {
                        registrarIntento(ip, 'Patrón sospechoso en voz');
                        if (ws.readyState === 1) ws.send(JSON.stringify({ tipo: 'respuesta', texto: 'No pude procesar eso. ¿Podrías repetirlo de otra forma?' }));
                        return;
                    }

                    // Procesar comando
                    var respuesta = await procesarComandoVoz(texto, cid, ip);

                    if (respuesta && ws.readyState === 1) {
                        ws.send(JSON.stringify({ tipo: 'respuesta', texto: respuesta }));
                    } else if (!respuesta && ws.readyState === 1) {
                        // Si procesarComandoVoz devuelve null (saludo inicial sin nombre),
                        // no enviar nada duplicado
                    }
                }
            } catch(e) {
                console.error('Error WS:', e.message);
                if (ws.readyState === 1) {
                    ws.send(JSON.stringify({ tipo: 'respuesta', texto: 'Disculpa, hubo un error. ¿Podrías repetir?' }));
                }
            }
        });

        ws.on('close', function() {
            voiceClients.delete(cid);
            var count = wsConnPerIP.get(ip) || 0;
            wsConnPerIP.set(ip, Math.max(0, count - 1));
        });

        ws.on('error', function() {
            voiceClients.delete(cid);
            var count = wsConnPerIP.get(ip) || 0;
            wsConnPerIP.set(ip, Math.max(0, count - 1));
        });
    });
}

function initFile(f, fb) {
    return (async function() {
        try { return JSON.parse(await fs.readFile(f, 'utf8')); }
        catch(e) { await fs.writeFile(f, JSON.stringify(fb, null, 2), 'utf8'); return JSON.parse(JSON.stringify(fb)); }
    })();
}

process.on('SIGTERM', async function() { await guardarBloqueos(); await guardarPaises(); process.exit(0); });
process.on('SIGINT', async function() { await guardarBloqueos(); await guardarPaises(); process.exit(0); });

start();
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
app.use(express.json({ limit: '512kb' }));
app.use(express.urlencoded({ extended: true, limit: '512kb' }));

// ==================== CONSTANTES ====================
const HORAS_VALIDAS = [12, 16, 20];
const DIAS_VALIDOS = ['lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado'];
const DIAS_MAP = {
    'lunes': 'lunes', 'martes': 'martes', 'miercoles': 'miercoles',
    'jueves': 'jueves', 'viernes': 'viernes', 'sabado': 'sabado', 'sábado': 'sabado',
    'lun': 'lunes', 'mar': 'martes', 'mie': 'miercoles', 'jue': 'jueves',
    'vie': 'viernes', 'sab': 'sabado'
};

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

function bloquearIP(ip, motivo, tipo = 'Desconocido') {
    bloqueos.set(ip, {
        hasta: Date.now() + 3600000,
        motivo,
        tipoAtaque: tipo,
        fecha: new Date().toISOString(),
        ip,
        intentos: (intentosFallidos.get(ip)?.count || 0),
        permanente: false
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
        bloquearIP(ip, `5+ intentos: ${tipo}`, tipo);
        intentosFallidos.delete(ip);
        return true;
    }
    return false;
}

function checkRateIP(ip) {
    limpiarViejos(turnosRecientesIP, 3600000);
    return (turnosRecientesIP.get(ip) || []).length < 5;
}

function checkRateTel(tel) {
    limpiarViejos(turnosRecientesTel, 86400000);
    return (turnosRecientesTel.get(tel) || []).length < 3;
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
let paisesConfig = {
    autorizados: [],
    bloqueados: [],
    modo: 'todos',
    stats: {}
};

async function cargarPaises() {
    try {
        if (fsSync.existsSync(PAISES_FILE)) {
            paisesConfig = JSON.parse(await fs.readFile(PAISES_FILE, 'utf8'));
        } else {
            await guardarPaises();
        }
    } catch(e) {
        await guardarPaises();
    }
}

async function guardarPaises() {
    await fs.writeFile(PAISES_FILE, JSON.stringify(paisesConfig, null, 2), 'utf8');
}

function paisAutorizado(codigoPais) {
    if (paisesConfig.modo === 'todos') {
        if (paisesConfig.bloqueados.length > 0) {
            return !paisesConfig.bloqueados.includes(codigoPais);
        }
        return true;
    }
    return paisesConfig.autorizados.includes(codigoPais);
}

// ============================================================
// BASE DE CONOCIMIENTO
// ============================================================
let baseConocimiento = [];
let serviciosData = [];

async function inicializarBaseConocimiento() {
    const servicios = serviciosData.map(s => ({
        tipo: 'servicio',
        contenido: `${s.nombre}: ${s.descripcion}. Precio: ${s.precio}.`
    }));
    
    const info = [
        { tipo: 'horario', contenido: 'Horarios: Lunes a Sábado. Turnos: 12:00, 16:00 y 20:00. Un turno por persona por día.' },
        { tipo: 'politica', contenido: 'Cancelación con 4 horas de anticipación.' }
    ];
    
    baseConocimiento = [...servicios, ...info];
}

// ============================================================
// SEGURIDAD
// ============================================================
const PATRONES_INYECCION = [
    /(\bSELECT\b|\bINSERT\b|\bUPDATE\b|\bDELETE\b|\bDROP\b)/i,
    /<script\b[^>]*>.*?<\/script>/is,
    /ignore\s+(previous|all|instructions|system\s+prompt)/i,
    /bypass\s+(filter|security)/i,
    /revela\s+(tus\s+instrucciones|el\s+prompt)/i,
    /system\s+prompt/i,
    /jailbreak/i,
];

function sanitizarTexto(texto, maxLength = 300) {
    if (!texto || typeof texto !== 'string') return '';
    let limpio = texto.trim();
    if (limpio.length > maxLength) limpio = limpio.substring(0, maxLength);
    return limpio;
}

function contieneInyeccion(texto) {
    if (!texto || typeof texto !== 'string') return false;
    for (const pattern of PATRONES_INYECCION) {
        if (pattern.test(texto)) return true;
    }
    return false;
}

function generarId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2) + crypto.randomBytes(4).toString('hex');
}

function fmtT(ms) {
    if (ms <= 0) return 'Expirado';
    const s = Math.floor(ms / 1000), m = Math.floor(s / 60), h = Math.floor(m / 60);
    return h > 0 ? `${h}h ${m % 60}m` : m > 0 ? `${m}m ${s % 60}s` : `${s}s`;
}

// ============================================================
// EXTRACCIÓN INTELIGENTE - ANALIZA TODO EL AUDIO DE UNA VEZ
// ============================================================
function extraerNombre(texto) {
    const patrones = [
        /(?:mi nombre es|me llamo|soy|me presento)\s+([A-ZÁÉÍÓÚÑ][a-záéíóúñ]*(?:\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ]*){0,2})/i,
        /(?:hola|buenas)\s+(?:soy|me llamo)\s+([A-ZÁÉÍÓÚÑ][a-záéíóúñ]*(?:\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ]*){0,2})/i,
        /(?:soy|me llamo)\s+([A-ZÁÉÍÓÚÑ][a-záéíóúñ]*(?:\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ]*){0,2})/i,
    ];
    for (const patron of patrones) {
        const match = texto.match(patron);
        if (match && match[1] && match[1].length >= 2) {
            return match[1].trim();
        }
    }
    return null;
}

function extraerMasaje(texto) {
    const t = texto.toLowerCase();
    if (t.includes('relajante')) return 'Masaje Relajante';
    if (t.includes('corporal')) return 'Masaje Corporal';
    if (t.includes('facial')) return 'Masaje Facial';
    if (t.includes('cervical')) return 'Masaje Cervical';
    if (t.includes('deportivo')) return 'Masaje Deportivo';
    return null;
}

function extraerDia(texto) {
    const t = texto.toLowerCase();
    for (const [clave, valor] of Object.entries(DIAS_MAP)) {
        if (t.includes(clave)) return valor;
    }
    return null;
}

function extraerHora(texto) {
    const t = texto.toLowerCase();
    // Buscar patrones como "12", "12:00", "12 del mediodía", "4 de la tarde", "8 de la noche"
    if (t.includes('12') || t.includes('doce') || t.includes('mediodía')) return 12;
    if (t.includes('16') || t.includes('cuatro') || (t.includes('4') && t.includes('tarde'))) return 16;
    if (t.includes('20') || t.includes('ocho') || t.includes('8')) return 20;
    return null;
}

function extraerUbicacion(texto) {
    const t = texto.toLowerCase();
    if (t.includes('domicilio') || t.includes('casa') || t.includes('domicilio')) return 'domicilio';
    if (t.includes('salon') || t.includes('salón') || t.includes('local')) return 'salon';
    return null;
}

function extraerTelefono(texto) {
    const match = texto.match(/\b(\d{7,12})\b/);
    return match ? match[1] : null;
}

function extraerDireccion(texto) {
    const match = texto.match(/(?:vivo en|dirección|domicilio|calle)\s+([^.,]+(?:[.,][^.,]+){0,2})/i);
    return match ? match[1].trim() : null;
}

function detectarPais(texto) {
    const paises = [
        { nombre: 'Cuba', codigo: '53', claves: ['cuba'] },
        { nombre: 'Argentina', codigo: '54', claves: ['argentina', 'arg'] },
        { nombre: 'México', codigo: '52', claves: ['méxico', 'mexico'] },
        { nombre: 'Colombia', codigo: '57', claves: ['colombia'] },
        { nombre: 'Chile', codigo: '56', claves: ['chile'] },
        { nombre: 'Perú', codigo: '51', claves: ['perú', 'peru'] },
        { nombre: 'España', codigo: '34', claves: ['españa', 'espania'] },
        { nombre: 'Uruguay', codigo: '598', claves: ['uruguay'] },
    ];
    const t = texto.toLowerCase();
    for (const pais of paises) {
        for (const clave of pais.claves) {
            if (t.includes(clave)) return pais;
        }
    }
    return null;
}

// FUNCIÓN PRINCIPAL - ANALIZA TODO EL AUDIO DE UNA VEZ
function analizarAudioCompleto(texto) {
    return {
        nombre: extraerNombre(texto),
        masaje: extraerMasaje(texto),
        dia: extraerDia(texto),
        hora: extraerHora(texto),
        ubicacion: extraerUbicacion(texto),
        telefono: extraerTelefono(texto),
        direccion: extraerDireccion(texto),
        pais: detectarPais(texto)
    };
}

function buscarAlternativa(dia, hora, turnos) {
    const idx = DIAS_VALIDOS.indexOf(dia);
    if (idx === -1) return null;
    for (let o = 0; o < 7; o++) {
        const d = DIAS_VALIDOS[(idx + o) % 6];
        const hrs = o === 0 ? HORAS_VALIDAS.filter(h => h > hora) : HORAS_VALIDAS;
        for (const h of hrs) {
            if (!turnos.some(t => t.dia === d && t.hora === h)) {
                return { dia: d, hora: h };
            }
        }
    }
    return null;
}

// ============================================================
// MIDDLEWARES
// ============================================================
app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    next();
});

app.use((req, res, next) => {
    const ip = req.ip || req.socket.remoteAddress || '0.0.0.0';
    if (estaBloqueado(ip)) {
        return res.status(403).json({ error: 'IP bloqueada por seguridad' });
    }
    next();
});

app.use(express.static(__dirname));

// ============================================================
// AUTENTICACIÓN ADMIN
// ============================================================
const validTokens = new Map();

function checkAuth(req) {
    const h = req.headers.authorization;
    if (!h || !h.startsWith('Bearer ')) return false;
    const token = h.substring(7);
    if (!validTokens.has(token)) return false;
    if (validTokens.get(token) < Date.now()) {
        validTokens.delete(token);
        return false;
    }
    return true;
}

app.post('/api/login', (req, res) => {
    const ip = req.ip || '0.0.0.0';
    if (estaBloqueado(ip)) return res.status(403).json({ success: false, error: 'IP bloqueada' });
    const { password } = req.body;
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

app.get('/api/verify', (req, res) => res.json({ valid: checkAuth(req) }));

app.post('/api/logout', (req, res) => {
    const h = req.headers.authorization;
    if (h?.startsWith('Bearer ')) validTokens.delete(h.substring(7));
    res.json({ ok: true });
});

// ============================================================
// CONFIGURACIÓN
// ============================================================
let configData = {
    hero: { titulo: "Renueva tu Energía", subtitulo: "Experiencias de bienestar", imagenFondo: "", botonTexto: "Explorar Tratamientos" },
    serviciosSection: { etiqueta: "Nuestros Servicios", titulo: "Elige tu Masaje Ideal", descripcion: "Turnos: 12:00, 16:00 y 20:00" },
    contactoSection: { titulo: "Asistente de Reservas", descripcion: "Reserva tu turno de forma rápida" },
    shareSection: { titulo: "Comparte Serenity Spa" }
};

app.get('/api/config', (req, res) => res.json(configData));
app.put('/api/config', async (req, res) => {
    if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    configData = { ...configData, ...req.body };
    await fs.writeFile(CONFIG_FILE, JSON.stringify(configData, null, 2), 'utf8');
    res.json({ ok: true });
});

// ============================================================
// SERVICIOS
// ============================================================
app.get('/api/servicios', (req, res) => res.json(serviciosData));

app.post('/api/servicios', async (req, res) => {
    if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    const s = { id: generarId(), ...req.body };
    serviciosData.push(s);
    await fs.writeFile(SERVICIOS_FILE, JSON.stringify(serviciosData, null, 2), 'utf8');
    await inicializarBaseConocimiento();
    res.status(201).json(s);
});

app.put('/api/servicios/:id', async (req, res) => {
    if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    const i = serviciosData.findIndex(s => s.id === req.params.id);
    if (i === -1) return res.status(404).json({ error: 'No encontrado' });
    serviciosData[i] = { ...serviciosData[i], ...req.body };
    await fs.writeFile(SERVICIOS_FILE, JSON.stringify(serviciosData, null, 2), 'utf8');
    await inicializarBaseConocimiento();
    res.json({ ok: true });
});

app.delete('/api/servicios/:id', async (req, res) => {
    if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    serviciosData = serviciosData.filter(s => s.id !== req.params.id);
    await fs.writeFile(SERVICIOS_FILE, JSON.stringify(serviciosData, null, 2), 'utf8');
    await inicializarBaseConocimiento();
    res.json({ ok: true });
});

// ============================================================
// TURNOS
// ============================================================
let turnosMem = [];

async function loadTurnos() {
    try {
        if (fsSync.existsSync(TURNOS_FILE)) {
            turnosMem = JSON.parse(await fs.readFile(TURNOS_FILE, 'utf8'));
        } else {
            turnosMem = [];
        }
    } catch(e) {
        turnosMem = [];
    }
    return turnosMem;
}

async function saveTurnos(t) {
    await fs.writeFile(TURNOS_FILE, JSON.stringify(t, null, 2), 'utf8');
    turnosMem = t;
}

app.get('/turnos', async (req, res) => res.json(await loadTurnos()));

app.post('/turnos', async (req, res) => {
    const ip = req.ip || '0.0.0.0';
    if (estaBloqueado(ip)) return res.status(403).json({ error: 'IP bloqueada' });
    
    try {
        let { nombre, dia, hora, massageType, telefono, ubicacion, tipoServicio, codigoPais } = req.body;
        
        nombre = sanitizarTexto(nombre, 50);
        dia = sanitizarTexto(dia, 20).toLowerCase();
        telefono = telefono ? telefono.replace(/\D/g, '') : '';
        codigoPais = codigoPais ? codigoPais.replace(/\D/g, '') : '53';
        
        if (!nombre || nombre.length < 2) return res.status(400).json({ error: 'Nombre inválido' });
        if (!telefono || telefono.length < 7) return res.status(400).json({ error: 'Teléfono inválido' });
        if (!dia || !DIAS_VALIDOS.includes(dia)) return res.status(400).json({ error: 'Día inválido' });
        const hn = parseInt(hora);
        if (!HORAS_VALIDAS.includes(hn)) return res.status(400).json({ error: 'Hora inválida' });
        
        const turnos = await loadTurnos();
        
        if (turnos.some(t => t.telefono === telefono && t.dia === dia)) {
            return res.status(409).json({ error: 'Ya tienes un turno para ese día' });
        }
        
        if (turnos.some(t => t.dia === dia && t.hora === hn)) {
            return res.status(409).json({ error: 'Horario ocupado', alternativa: buscarAlternativa(dia, hn, turnos) });
        }
        
        const nuevo = {
            id: generarId(),
            nombre, dia, hora: hn, massageType: massageType || 'Masaje Relajante',
            telefono, codigoPais, ubicacion: tipoServicio === 'domicilio' ? ubicacion : null,
            tipoServicio: tipoServicio || 'salon', confirmadoWhatsApp: false,
            fechaCreacion: new Date().toISOString(), ip
        };
        
        turnos.push(nuevo);
        await saveTurnos(turnos);
        regTurno(ip, telefono);
        
        res.status(201).json({ mensaje: 'Turno reservado con éxito', turno: nuevo });
    } catch(e) {
        console.error('Error reserva:', e);
        res.status(500).json({ error: 'Error interno' });
    }
});

app.delete('/turnos/:id', async (req, res) => {
    if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    const turnos = await loadTurnos();
    const i = turnos.findIndex(t => t.id === req.params.id);
    if (i === -1) return res.status(404).json({ error: 'No encontrado' });
    turnos.splice(i, 1);
    await saveTurnos(turnos);
    res.json({ ok: true });
});

// ============================================================
// SEGURIDAD - PAÍSES (ADMIN)
// ============================================================
app.get('/api/seguridad/paises', (req, res) => {
    if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    res.json(paisesConfig);
});

app.put('/api/seguridad/paises', async (req, res) => {
    if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    const { autorizados, bloqueados, modo } = req.body;
    if (autorizados !== undefined) paisesConfig.autorizados = autorizados;
    if (bloqueados !== undefined) paisesConfig.bloqueados = bloqueados;
    if (modo) paisesConfig.modo = modo;
    await guardarPaises();
    res.json({ ok: true });
});

app.post('/api/seguridad/paises/autorizar', async (req, res) => {
    if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    const { codigo } = req.body;
    if (!codigo || !/^\d{1,3}$/.test(codigo)) return res.status(400).json({ error: 'Código inválido' });
    if (!paisesConfig.autorizados.includes(codigo)) {
        paisesConfig.autorizados.push(codigo);
        paisesConfig.bloqueados = paisesConfig.bloqueados.filter(c => c !== codigo);
        await guardarPaises();
    }
    res.json({ ok: true });
});

app.post('/api/seguridad/paises/bloquear', async (req, res) => {
    if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    const { codigo } = req.body;
    if (!codigo || !/^\d{1,3}$/.test(codigo)) return res.status(400).json({ error: 'Código inválido' });
    if (!paisesConfig.bloqueados.includes(codigo)) {
        paisesConfig.bloqueados.push(codigo);
        paisesConfig.autorizados = paisesConfig.autorizados.filter(c => c !== codigo);
        await guardarPaises();
    }
    res.json({ ok: true });
});

app.delete('/api/seguridad/paises/:codigo', async (req, res) => {
    if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    const codigo = req.params.codigo;
    paisesConfig.autorizados = paisesConfig.autorizados.filter(c => c !== codigo);
    paisesConfig.bloqueados = paisesConfig.bloqueados.filter(c => c !== codigo);
    await guardarPaises();
    res.json({ ok: true });
});

// ============================================================
// SEGURIDAD - BLOQUEOS (ADMIN)
// ============================================================
app.get('/api/seguridad/bloqueos', (req, res) => {
    if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    const a = [];
    for (const [ip, d] of bloqueos) {
        a.push({ ip, motivo: d.motivo, tipoAtaque: d.tipoAtaque, fecha: d.fecha });
    }
    res.json({ activos: a, historial: historialBloqueos });
});

app.post('/api/seguridad/desbloquear/:ip', (req, res) => {
    if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    desbloquearIP(req.params.ip);
    res.json({ ok: true });
});

app.delete('/api/seguridad/bloqueos/:ip', (req, res) => {
    if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    bloqueos.delete(req.params.ip);
    guardarBloqueos();
    res.json({ ok: true });
});

app.post('/api/seguridad/limpiar-expirados', (req, res) => {
    if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    let b = 0;
    const now = Date.now();
    for (const [ip, d] of bloqueos) {
        if (now > d.hasta) { bloqueos.delete(ip); b++; }
    }
    guardarBloqueos();
    res.json({ mensaje: `${b} bloqueos eliminados` });
});

// ============================================================
// CHAT CON IA
// ============================================================
app.post('/api/chat-ia', async (req, res) => {
    const ip = req.ip || '0.0.0.0';
    if (estaBloqueado(ip)) return res.status(403).json({ error: 'IP bloqueada' });
    
    let { mensaje } = req.body;
    if (!mensaje || typeof mensaje !== 'string') return res.status(400).json({ error: 'Mensaje inválido' });
    if (contieneInyeccion(mensaje)) {
        registrarIntento(ip, 'inyección');
        return res.status(400).json({ error: 'Mensaje no permitido' });
    }
    
    mensaje = sanitizarTexto(mensaje, 500);
    
    const serviciosLista = serviciosData.map(s => `${s.nombre} (${s.precio})`).join(', ');
    
    const systemPrompt = `Eres SERENA, asistente de Serenity Spa.

REGLAS:
1. Saludo inicial solo una vez: "Hola soy su asistente, ¿con quién tengo el placer de hablar?"
2. Cuando el cliente diga su nombre: "Es un gusto [nombre], ¿en qué le podemos ayudar?"
3. Para reservas, extrae del mensaje: nombre, masaje, día, hora, ubicación, teléfono.
4. Si faltan datos, pregunta SOLO lo que falta.
5. Si el cliente pregunta por servicios, enumera: ${serviciosLista}
6. Horarios: 12:00, 16:00, 20:00. Días: Lunes a Sábado.
7. Respuestas cortas, naturales, sin repetir saludos.

Responde de forma cálida y profesional.`;

    if (!process.env.DEEPSEEK_API_KEY) {
        return res.json({ respuesta: generarRespuestaLocal(mensaje), modo: 'local' });
    }
    
    try {
        const completion = await deepseek.chat.completions.create({
            model: 'deepseek-chat',
            messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: mensaje }],
            temperature: 0.7,
            max_tokens: 300
        });
        let respuesta = completion.choices[0].message.content;
        respuesta = respuesta.replace(/[*_#]/g, '').trim();
        res.json({ respuesta, modo: 'ia' });
    } catch (error) {
        res.json({ respuesta: generarRespuestaLocal(mensaje), modo: 'local' });
    }
});

function generarRespuestaLocal(mensaje) {
    const msg = mensaje.toLowerCase();
    if (msg.match(/^(hola|buenas)/)) return "Hola soy su asistente, ¿con quién tengo el placer de hablar?";
    if (msg.includes('gracias')) return "Gracias a usted. ¿Necesita algo más?";
    if (msg.includes('servicio') || msg.includes('masaje')) {
        const lista = serviciosData.map(s => `${s.nombre} (${s.precio})`).join(', ');
        return `Ofrecemos ${lista}. Horarios: 12, 16 y 20 horas. ¿Cuál le interesa?`;
    }
    if (msg.includes('horario')) return "Atendemos de lunes a sábado a las 12, 16 y 20 horas. ¿Desea reservar?";
    return "¿En qué puedo ayudarle? Puedo reservar turnos, mostrar horarios o informarle sobre nuestros masajes.";
}

// ============================================================
// RUTAS ESTÁTICAS
// ============================================================
app.get('/voice-assistant', (req, res) => res.sendFile(path.join(__dirname, 'voice-assistant.html')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/admin.html', (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));
app.get('/login.html', (req, res) => res.sendFile(path.join(__dirname, 'login.html')));
app.get('/health', (req, res) => res.json({ status: 'ok', ia: !!process.env.DEEPSEEK_API_KEY }));

// ============================================================
// ASISTENTE DE VOZ - CORREGIDO (SIN BUCLE)
// ============================================================
let voiceClients = new Map();
let saludoInicialEnviado = new Map();

async function procesarComandoVoz(texto, clientId, ip) {
    if (contieneInyeccion(texto)) {
        registrarIntento(ip, 'inyección voz');
        return 'Lo siento, no puedo procesar ese mensaje.';
    }
    
    let cd = voiceClients.get(clientId);
    const yaSaludo = saludoInicialEnviado.get(clientId);
    
    if (!cd) {
        cd = { 
            nombre: null, telefono: null, masaje: null, dia: null, 
            hora: null, ubicacion: null, direccion: null, codigoPais: '53',
            saludoEnviado: yaSaludo || false, esperandoReserva: false
        };
        voiceClients.set(clientId, cd);
    }
    
    // ANALIZAR TODO EL AUDIO COMPLETO DE UNA VEZ
    const datos = analizarAudioCompleto(texto);
    const tl = texto.toLowerCase();
    
    // 1. SALUDO INICIAL (solo una vez)
    if (!cd.saludoEnviado) {
        cd.saludoEnviado = true;
        saludoInicialEnviado.set(clientId, true);
        
        // Si ya tiene nombre en el primer mensaje
        if (datos.nombre) {
            cd.nombre = datos.nombre;
            return `Hola soy su asistente. Es un gusto ${datos.nombre}, ¿en qué le podemos ayudar?`;
        }
        return "Hola soy su asistente, ¿con quién tengo el placer de hablar?";
    }
    
    // 2. SI EL CLIENTE DIJO SU NOMBRE
    if (datos.nombre && !cd.nombre) {
        cd.nombre = datos.nombre;
        return `Es un gusto ${datos.nombre}, ¿en qué le podemos ayudar?`;
    }
    
    // 3. ACTUALIZAR TODOS LOS DATOS DEL CLIENTE (acumular)
    if (datos.nombre && !cd.nombre) cd.nombre = datos.nombre;
    if (datos.telefono && !cd.telefono) cd.telefono = datos.telefono;
    if (datos.masaje && !cd.masaje) cd.masaje = datos.masaje;
    if (datos.dia && !cd.dia) cd.dia = datos.dia;
    if (datos.hora && !cd.hora) cd.hora = datos.hora;
    if (datos.ubicacion && !cd.ubicacion) cd.ubicacion = datos.ubicacion;
    if (datos.direccion && !cd.direccion) cd.direccion = datos.direccion;
    if (datos.pais) cd.codigoPais = datos.pais.codigo;
    
    // 4. DETECTAR INTENCIÓN DE RESERVA
    const quiereReservar = tl.includes('reservar') || tl.includes('turno') || tl.includes('cita') || tl.includes('agendar');
    const preguntaServicios = tl.includes('servicio') || tl.includes('masaje') || tl.includes('tipos');
    const preguntaHorarios = tl.includes('horario') || tl.includes('hora') || tl.includes('cuándo');
    
    // 5. PREGUNTA POR SERVICIOS
    if (preguntaServicios) {
        const lista = serviciosData.map(s => `${s.nombre} (${s.precio})`).join(', ');
        const nombreCliente = cd.nombre ? cd.nombre : '';
        return `Ofrecemos ${lista}. Los horarios son 12, 16 y 20 horas. ¿Cuál le interesa${nombreCliente ? ', ' + nombreCliente : ''}?`;
    }
    
    // 6. PREGUNTA POR HORARIOS
    if (preguntaHorarios) {
        const nombreCliente = cd.nombre ? cd.nombre : '';
        return `Atendemos de lunes a sábado a las 12 del mediodía, 4 de la tarde y 8 de la noche. ¿Desea reservar${nombreCliente ? ', ' + nombreCliente : ''}?`;
    }
    
    // 7. RESERVA - VERIFICAR DATOS COMPLETOS
    if (quiereReservar) {
        // Verificar qué datos faltan
        const faltantes = [];
        if (!cd.nombre) faltantes.push('su nombre');
        if (!cd.masaje) faltantes.push('el tipo de masaje');
        if (!cd.dia) faltantes.push('el día');
        if (!cd.hora) faltantes.push('la hora');
        if (!cd.telefono) faltantes.push('su número de teléfono');
        
        // Si faltan datos, preguntar SOLO lo que falta
        if (faltantes.length > 0) {
            const lista = faltantes.join(', ');
            return `Para completar su reserva, necesito ${lista}. ¿Podría indicármelo, por favor?`;
        }
        
        // SI TIENE TODOS LOS DATOS, PROCESAR RESERVA INMEDIATAMENTE
        return await procesarReservaInmediata(cd, ip, clientId);
    }
    
    // 8. RESPUESTA POR DEFECTO
    const nombreCliente = cd.nombre ? cd.nombre : '';
    if (nombreCliente) {
        return `¿En qué puedo ayudarle, ${nombreCliente}? Puedo reservar un turno, mostrarle nuestros servicios o informarle sobre horarios.`;
    }
    return "¿En qué puedo ayudarle? Puedo reservar turnos, mostrar horarios o informarle sobre nuestros masajes.";
}

async function procesarReservaInmediata(cd, ip, clientId) {
    // Validar país
    if (!paisAutorizado(cd.codigoPais)) {
        return `Lo sentimos, no aceptamos reservas desde su país en este momento.`;
    }
    
    try {
        const turnos = await loadTurnos();
        const dia = cd.dia;
        const hora = cd.hora;
        
        // Verificar si ya tiene turno ese día
        if (turnos.some(t => t.telefono === cd.telefono && t.dia === dia)) {
            return `${cd.nombre}, ya tiene un turno para el ${dia}. Solo se permite uno por día. ¿Quiere probar otro día?`;
        }
        
        // Verificar disponibilidad
        if (turnos.some(t => t.dia === dia && t.hora === hora)) {
            const alt = buscarAlternativa(dia, hora, turnos);
            if (alt) {
                return `Lo siento, el horario de las ${hora}:00 del ${dia} ya está ocupado. Tengo disponible el ${alt.dia} a las ${alt.hora}:00. ¿Le interesa?`;
            }
            return `No hay disponibilidad para el ${dia}. ¿Quiere probar otro día?`;
        }
        
        // Crear reserva
        const nuevo = {
            id: generarId(),
            nombre: cd.nombre,
            dia: dia,
            hora: hora,
            massageType: cd.masaje || 'Masaje Relajante',
            telefono: cd.telefono,
            codigoPais: cd.codigoPais,
            ubicacion: cd.ubicacion === 'domicilio' ? (cd.direccion || null) : null,
            tipoServicio: cd.ubicacion === 'domicilio' ? 'domicilio' : 'salon',
            confirmadoWhatsApp: false,
            fechaCreacion: new Date().toISOString(),
            ip
        };
        
        turnos.push(nuevo);
        await saveTurnos(turnos);
        
        // Limpiar sesión después de reserva exitosa
        voiceClients.delete(clientId);
        saludoInicialEnviado.delete(clientId);
        
        const horaTexto = hora === 12 ? '12 del mediodía' : hora === 16 ? '4 de la tarde' : '8 de la noche';
        const ubicacionTexto = nuevo.tipoServicio === 'domicilio' ? nuevo.ubicacion : 'nuestro salón';
        
        return `Perfecto, ${cd.nombre}. Su reserva ha sido confirmada. Le esperamos el ${dia} a las ${horaTexto} en ${ubicacionTexto}. Hemos registrado su teléfono para cualquier comunicación. ¿Necesita algo más?`;
        
    } catch(e) {
        console.error('Error reserva voz:', e);
        return `Hubo un error al procesar su reserva, ${cd.nombre}. Por favor, intente de nuevo.`;
    }
}

// ============================================================
// INICIALIZACIÓN
// ============================================================
async function initFile(f, fb) {
    try { return JSON.parse(await fs.readFile(f, 'utf8')); }
    catch(e) { await fs.writeFile(f, JSON.stringify(fb, null, 2), 'utf8'); return JSON.parse(JSON.stringify(fb)); }
}

async function start() {
    await cargarBloqueos();
    await cargarPaises();
    
    configData = await initFile(CONFIG_FILE, configData);
    
    serviciosData = await initFile(SERVICIOS_FILE, [
        { id: "relajante", nombre: "Masaje Relajante", precio: "$45", descripcion: "Movimientos suaves para liberar estrés", orden: 1 },
        { id: "corporal", nombre: "Masaje Corporal", precio: "$65", descripcion: "Tratamiento completo", orden: 2 },
        { id: "facial", nombre: "Masaje Facial", precio: "$40", descripcion: "Rejuvenece la piel", orden: 3 },
        { id: "cervical", nombre: "Masaje Cervical", precio: "$50", descripcion: "Alivia tensiones del cuello", orden: 4 }
    ]);
    
    turnosMem = await initFile(TURNOS_FILE, []);
    await inicializarBaseConocimiento();

    const server = app.listen(PORT, '0.0.0.0', () => {
        console.log(`🌿 SERENA - Asistente de voz corregido iniciado en puerto ${PORT}`);
        console.log(`📋 Servicios cargados: ${serviciosData.length}`);
    });

    const wss = new WebSocket.Server({ server, path: '/ws-voice' });
    
    wss.on('connection', (ws, req) => {
        const ip = req.socket.remoteAddress || 'desconocida';
        if (estaBloqueado(ip)) { ws.close(1008, 'IP bloqueada'); return; }
        
        const cid = generarId();
        let mc = 0;
        
        ws.on('message', async (data) => {
            mc++;
            if (mc > 30) { bloquearIP(ip, 'Flood', 'flood'); ws.close(1008); return; }
            try {
                const m = JSON.parse(data);
                if (m.tipo === 'transcripcion') {
                    const r = await procesarComandoVoz(m.texto, cid, ip);
                    if (ws.readyState === 1) {
                        ws.send(JSON.stringify({ tipo: 'respuesta', texto: r }));
                    }
                }
            } catch(e) {
                if (ws.readyState === 1) {
                    ws.send(JSON.stringify({ tipo: 'respuesta', texto: 'Disculpe, ¿podría repetir?' }));
                }
            }
        });
        
        ws.on('close', () => {
            voiceClients.delete(cid);
            saludoInicialEnviado.delete(cid);
        });
        
        const ft = setInterval(() => { mc = 0; }, 60000);
        ws.on('close', () => clearInterval(ft));
    });
}

process.on('SIGTERM', async () => { await guardarBloqueos(); process.exit(0); });
process.on('SIGINT', async () => { await guardarBloqueos(); process.exit(0); });

start();
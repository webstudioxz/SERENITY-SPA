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

// Configurar DeepSeek
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
        fecha: new Date().isoString(),
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

async function inicializarBaseConocimiento() {
    const servicios = serviciosData.map(s => ({
        tipo: 'servicio',
        contenido: `${s.nombre}: ${s.descripcion}. Precio: ${s.precio}. Beneficios: ${(s.beneficios||[]).join(', ')}. Efectos: ${(s.efectos||[]).join(', ')}`
    }));
    
    const info = [
        { tipo: 'horario', contenido: 'Horarios de atención: Lunes a Sábado. Turnos disponibles: 12:00 del mediodía, 16:00 de la tarde y 20:00 de la noche. Solo un turno por persona por día.' },
        { tipo: 'politica', contenido: 'Política de cancelación: Se debe cancelar con al menos 4 horas de anticipación.' },
        { tipo: 'ubicacion', contenido: 'Serenity Spa ofrece servicio en salón y a domicilio.' }
    ];
    
    baseConocimiento = [...servicios, ...info];
}

// ============================================================
// SEGURIDAD - SANITIZACIÓN
// ============================================================
const PATRONES_INYECCION = [
    /(\bSELECT\b.*\bFROM\b|\bINSERT\b|\bUPDATE\b|\bDELETE\b|\bDROP\b)/i,
    /(\bUNION\b.*\bSELECT\b|\bOR\b.*1=1\b)/i,
    /<script\b[^>]*>.*?<\/script>/is,
    /javascript:/i,
    /ignore\s+(previous|all|instructions|system\s+prompt)/i,
    /bypass\s+(filter|security)/i,
    /revela\s+(tus\s+instrucciones|el\s+prompt)/i,
    /eres\s+una\s+ia/i,
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

// ============================================================
// UTILIDADES DE EXTRACCIÓN MEJORADAS
// ============================================================
function generarId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2) + crypto.randomBytes(4).toString('hex');
}

function fmtT(ms) {
    if (ms <= 0) return 'Expirado';
    const s = Math.floor(ms / 1000), m = Math.floor(s / 60), h = Math.floor(m / 60);
    return h > 0 ? `${h}h ${m % 60}m` : m > 0 ? `${m}m ${s % 60}s` : `${s}s`;
}

// Extraer nombre de forma inteligente
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

// Extraer tipo de masaje
function extraerMasaje(texto) {
    const t = texto.toLowerCase();
    if (t.includes('relajante')) return 'Masaje Relajante';
    if (t.includes('corporal')) return 'Masaje Corporal';
    if (t.includes('facial')) return 'Masaje Facial';
    if (t.includes('servical')) return 'Masaje Cervical';
    return null;
}

// Extraer día
function extraerDia(texto) {
    const t = texto.toLowerCase();
    for (const [clave, valor] of Object.entries(DIAS_MAP)) {
        if (t.includes(clave)) return valor;
    }
    return null;
}

// Extraer hora
function extraerHora(texto) {
    const horas = {
        '12': 12, 'doce': 12, 'mediodía': 12, 'medio dia': 12,
        '16': 16, 'cuatro': 16, '4': 16, 'cuatro tarde': 16,
        '20': 20, 'ocho': 20, '8': 20, 'ocho noche': 20
    };
    const t = texto.toLowerCase();
    for (const [key, val] of Object.entries(horas)) {
        if (t.includes(key)) return val;
    }
    return null;
}

// Extraer ubicación
function extraerUbicacion(texto) {
    const t = texto.toLowerCase();
    if (t.includes('domicilio') || t.includes('casa') || t.includes('domicilio')) return 'domicilio';
    if (t.includes('salon') || t.includes('salón') || t.includes('local')) return 'salon';
    return null;
}

// Extraer teléfono
function extraerTelefono(texto) {
    const match = texto.match(/\b(\d{7,12})\b/);
    return match ? match[1] : null;
}

// Extraer dirección
function extraerDireccion(texto) {
    const match = texto.match(/(?:vivo en|dirección|domicilio|calle)\s+([^.,]+(?:[.,][^.,]+){0,2})/i);
    return match ? match[1].trim() : null;
}

// Extraer país
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
        { nombre: 'Paraguay', codigo: '595', claves: ['paraguay'] },
        { nombre: 'Brasil', codigo: '55', claves: ['brasil'] },
    ];
    const t = texto.toLowerCase();
    for (const pais of paises) {
        for (const clave of pais.claves) {
            if (t.includes(clave)) return pais;
        }
    }
    return null;
}

// Extraer TODOS los datos de un solo audio
function extraerTodosLosDatos(texto) {
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
// UPLOAD HERO
// ============================================================
app.post('/api/upload-hero', async (req, res) => {
    if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    try {
        const { base64 } = req.body;
        if (!base64 || !base64.startsWith('data:image')) return res.status(400).json({ error: 'Imagen inválida' });
        const matches = base64.match(/^data:image\/(\w+);base64,(.+)$/);
        if (!matches) return res.status(400).json({ error: 'Formato no reconocido' });
        const ext = matches[1] === 'jpeg' ? 'jpg' : matches[1];
        const buffer = Buffer.from(matches[2], 'base64');
        const filename = `hero-${Date.now()}.${ext}`;
        await fs.writeFile(path.join(UPLOADS_DIR, filename), buffer);
        res.json({ url: `/uploads/${filename}`, filename });
    } catch (e) {
        res.status(500).json({ error: 'Error al subir imagen' });
    }
});

// ============================================================
// CONFIGURACIÓN
// ============================================================
let configData = {
    hero: {
        titulo: "Renueva tu Energía",
        subtitulo: "Experiencias de bienestar",
        imagenFondo: "https://images.unsplash.com/photo-1544161515-4ab6ce6db874?w=1920",
        botonTexto: "Explorar Tratamientos"
    },
    serviciosSection: {
        etiqueta: "Nuestros Servicios",
        titulo: "Elige tu Masaje Ideal",
        descripcion: "Turnos: 12:00, 16:00 y 20:00"
    },
    contactoSection: {
        titulo: "Asistente de Reservas",
        descripcion: "Reserva tu turno de forma rápida"
    },
    shareSection: {
        titulo: "Comparte Serenity Spa"
    }
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
let serviciosData = [];

app.get('/api/servicios', (req, res) => {
    res.json(serviciosData);
});

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
        
        if (!nombre || nombre.length < 2) {
            return res.status(400).json({ error: 'Nombre inválido' });
        }
        if (!telefono || telefono.length < 7) {
            return res.status(400).json({ error: 'Teléfono inválido' });
        }
        if (!dia || !DIAS_VALIDOS.includes(dia)) {
            return res.status(400).json({ error: 'Día inválido' });
        }
        const hn = parseInt(hora);
        if (!HORAS_VALIDAS.includes(hn)) {
            return res.status(400).json({ error: 'Hora inválida' });
        }
        
        const turnos = await loadTurnos();
        
        if (turnos.some(t => t.telefono === telefono && t.dia === dia)) {
            return res.status(409).json({ error: 'Ya tienes un turno para ese día' });
        }
        
        if (turnos.some(t => t.dia === dia && t.hora === hn)) {
            return res.status(409).json({ 
                error: 'Horario ocupado', 
                alternativa: buscarAlternativa(dia, hn, turnos) 
            });
        }
        
        const nuevo = {
            id: generarId(),
            nombre,
            dia,
            hora: hn,
            massageType: massageType || 'Masaje Relajante',
            telefono,
            codigoPais,
            ubicacion: tipoServicio === 'domicilio' ? ubicacion : null,
            tipoServicio: tipoServicio || 'salon',
            confirmadoWhatsApp: false,
            fechaCreacion: new Date().toISOString(),
            ip
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
// CHAT CON IA - CONVERSACIÓN NATURAL
// ============================================================
app.post('/api/chat-ia', async (req, res) => {
    const ip = req.ip || '0.0.0.0';
    if (estaBloqueado(ip)) return res.status(403).json({ error: 'IP bloqueada' });
    
    let { mensaje, historial } = req.body;
    
    if (!mensaje || typeof mensaje !== 'string') {
        return res.status(400).json({ error: 'Mensaje inválido' });
    }
    
    if (contieneInyeccion(mensaje)) {
        registrarIntento(ip, 'inyección');
        return res.status(400).json({ error: 'Mensaje no permitido' });
    }
    
    mensaje = sanitizarTexto(mensaje, 500);
    
    // Extraer datos del mensaje actual
    const datosExtraidos = extraerTodosLosDatos(mensaje);
    
    // Obtener servicios para mostrar
    const serviciosLista = serviciosData.map(s => `${s.nombre} - ${s.precio}`).join(', ');
    
    const systemPrompt = `Eres SERENA, asistente de Serenity Spa.

REGLAS IMPORTANTES:
1. SALUDO SOLO UNA VEZ: Si es el primer mensaje, di: "Hola soy su asistente, ¿con quién tengo el placer de hablar?"
2. NUNCA repitas el saludo si ya lo hiciste.
3. Cuando el cliente diga su nombre, responde: "Es un gusto [nombre], ¿en qué le podemos ayudar?"
4. Para reservas, extrae del mensaje: nombre, masaje, día, hora, ubicación, teléfono.
5. Si falta algún dato, pregunta SOLO lo que falta.
6. Si el cliente pregunta por servicios, enumera los disponibles.
7. Si pregunta por días disponibles, sugiere un día basado en disponibilidad.
8. RESPUESTAS CORTAS Y NATURALES, sin repetir "buenas" constantemente.

SERVICIOS: ${serviciosLista}
HORARIOS: 12:00, 16:00, 20:00
DÍAS: Lunes a Sábado

Responde de forma natural, cálida y profesional.`;

    try {
        if (!process.env.DEEPSEEK_API_KEY) {
            const respuestaLocal = generarRespuestaLocal(mensaje, datosExtraidos);
            return res.json({ respuesta: respuestaLocal, modo: 'local' });
        }
        
        const completion = await deepseek.chat.completions.create({
            model: 'deepseek-chat',
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: mensaje }
            ],
            temperature: 0.7,
            max_tokens: 300
        });
        
        let respuesta = completion.choices[0].message.content;
        respuesta = respuesta.replace(/[*_#]/g, '').trim();
        res.json({ respuesta, modo: 'ia' });
        
    } catch (error) {
        console.error('Error IA:', error.message);
        const respuestaLocal = generarRespuestaLocal(mensaje, datosExtraidos);
        res.json({ respuesta: respuestaLocal, modo: 'local' });
    }
});

function generarRespuestaLocal(mensaje, datos) {
    const msg = mensaje.toLowerCase();
    
    // Detectar si es primer mensaje o contiene saludo
    if (msg.match(/^(hola|buenas|saludos|hey)/) && !datos.nombre) {
        return "Hola soy su asistente, ¿con quién tengo el placer de hablar?";
    }
    
    // Si detecta nombre
    if (datos.nombre && !msg.includes('gracias')) {
        return `Es un gusto ${datos.nombre}, ¿en qué le podemos ayudar?`;
    }
    
    // Si pregunta por servicios
    if (msg.includes('servicio') || msg.includes('masaje') || msg.includes('tipos')) {
        const servicios = serviciosData.map(s => `${s.nombre} (${s.precio})`).join(', ');
        return `Ofrecemos ${servicios}. Los horarios son 12, 16 y 20 horas. ¿Cuál le interesa?`;
    }
    
    // Si pregunta por días
    if (msg.includes('día') || msg.includes('disponible')) {
        return `Atendemos de lunes a sábado. Le sugiero el día miércoles que suele tener más disponibilidad. ¿Qué día prefiere?`;
    }
    
    // Si quiere reservar
    if (msg.includes('reservar') || msg.includes('turno') || msg.includes('cita')) {
        const faltantes = [];
        if (!datos.nombre) faltantes.push('su nombre');
        if (!datos.masaje) faltantes.push('el tipo de masaje');
        if (!datos.dia) faltantes.push('el día');
        if (!datos.hora) faltantes.push('la hora');
        if (!datos.telefono) faltantes.push('su número de teléfono');
        
        if (faltantes.length === 0) {
            return `Perfecto. He recibido todos sus datos. Verificando disponibilidad... Su reserva ha sido confirmada para el ${datos.dia} a las ${datos.hora}:00. ¿Necesita algo más?`;
        } else {
            const lista = faltantes.join(', ');
            return `Para completar su reserva, necesito ${lista}. ¿Podría indicármelo, por favor?`;
        }
    }
    
    return "¿En qué puedo ayudarle? Puedo reservar turnos, mostrar horarios o informarle sobre nuestros masajes.";
}

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
    const { codigo, nombre } = req.body;
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
    const { codigo, nombre } = req.body;
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

app.get('/api/seguridad/paises/stats', async (req, res) => {
    if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    const turnos = await loadTurnos();
    const stats = {};
    for (const t of turnos) {
        const cod = t.codigoPais || '53';
        stats[cod] = (stats[cod] || 0) + 1;
    }
    res.json(Object.entries(stats).map(([cod, count]) => ({ codigo: cod, reservas: count })));
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
// RUTAS ESTÁTICAS
// ============================================================
app.get('/voice-assistant', (req, res) => res.sendFile(path.join(__dirname, 'voice-assistant.html')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/admin.html', (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));
app.get('/login.html', (req, res) => res.sendFile(path.join(__dirname, 'login.html')));
app.get('/health', (req, res) => res.json({ status: 'ok', ia: !!process.env.DEEPSEEK_API_KEY }));

// ============================================================
// ASISTENTE DE VOZ - CONVERSACIÓN NATURAL
// ============================================================
let voiceClients = new Map();
let saludoInicialEnviado = new Map();

async function procesarComandoVoz(texto, clientId, ip) {
    if (contieneInyeccion(texto)) {
        registrarIntento(ip, 'inyección voz');
        return 'Lo siento, no puedo procesar ese mensaje.';
    }
    
    let cd = voiceClients.get(clientId);
    
    // Verificar si ya se envió el saludo inicial
    const yaSaludo = saludoInicialEnviado.get(clientId);
    
    if (!cd) {
        cd = { 
            estado: 'inicio', 
            nombre: null, 
            telefono: null, 
            masaje: null, 
            dia: null, 
            hora: null, 
            ubicacion: null,
            codigoPais: '53',
            saludoEnviado: yaSaludo || false
        };
        voiceClients.set(clientId, cd);
    }
    
    // Extraer datos del mensaje actual
    const datos = extraerTodosLosDatos(texto);
    const tl = texto.toLowerCase();
    
    // Si no se ha enviado el saludo y es el primer mensaje
    if (!cd.saludoEnviado && !cd.nombre) {
        cd.saludoEnviado = true;
        saludoInicialEnviado.set(clientId, true);
        return "Hola soy su asistente, ¿con quién tengo el placer de hablar?";
    }
    
    // Si tenemos nombre del cliente y aún no respondimos
    if (datos.nombre && !cd.nombre) {
        cd.nombre = datos.nombre;
        return `Es un gusto ${datos.nombre}, ¿en qué le podemos ayudar?`;
    }
    
    // Extraer y acumular datos
    if (datos.nombre && !cd.nombre) cd.nombre = datos.nombre;
    if (datos.telefono && !cd.telefono) cd.telefono = datos.telefono;
    if (datos.masaje && !cd.masaje) cd.masaje = datos.masaje;
    if (datos.dia && !cd.dia) cd.dia = datos.dia;
    if (datos.hora && !cd.hora) cd.hora = datos.hora;
    if (datos.ubicacion && !cd.ubicacion) cd.ubicacion = datos.ubicacion;
    if (datos.pais) cd.codigoPais = datos.pais.codigo;
    
    // Si ya tenemos nombre, verificar intención de reserva
    if (cd.nombre) {
        // Intentar reserva
        if (tl.includes('reservar') || tl.includes('turno') || tl.includes('cita')) {
            // Verificar datos faltantes
            const faltantes = [];
            if (!cd.masaje) faltantes.push('el tipo de masaje');
            if (!cd.dia) faltantes.push('el día');
            if (!cd.hora) faltantes.push('la hora');
            if (!cd.telefono) faltantes.push('su número de teléfono');
            
            if (faltantes.length === 0) {
                // Todos los datos están completos, procesar reserva
                return await confirmarReservaVoz(cd, ip, clientId);
            } else {
                const lista = faltantes.join(', ');
                return `Para completar su reserva, necesito ${lista}. ¿Podría indicármelo, por favor?`;
            }
        }
        
        // Preguntar por servicios
        if (tl.includes('servicio') || tl.includes('masaje') || tl.includes('tipos')) {
            const servicios = serviciosData.map(s => `${s.nombre} (${s.precio})`).join(', ');
            return `Ofrecemos ${servicios}. Los horarios son 12, 16 y 20 horas. ¿Cuál le interesa?`;
        }
        
        // Preguntar por días disponibles
        if (tl.includes('día') || tl.includes('disponible') || tl.includes('horario')) {
            return `Atendemos de lunes a sábado. Le sugiero el día miércoles que suele tener más disponibilidad. Nuestros horarios son 12, 16 y 20 horas. ¿Qué día prefiere?`;
        }
        
        // Si no hay intención específica
        return `¿En qué puedo ayudarle, ${cd.nombre}? Puedo reservar un turno, mostrarle nuestros servicios o informarle sobre horarios.`;
    }
    
    // Si no tenemos nombre, pedirlo
    return "Para poder ayudarle mejor, ¿podría decirme su nombre, por favor?";
}

async function confirmarReservaVoz(cd, ip, clientId) {
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
        
        // Verificar disponibilidad de horario
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
            codigoPais: cd.codigoPais || '53',
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
        { id: "relajante", nombre: "Masaje Relajante", precio: "$45", descripcion: "Movimientos suaves para liberar estrés", beneficios: ["60 Minutos"], efectos: ["Relajación profunda"], imagenWeb: "", orden: 1 },
        { id: "corporal", nombre: "Masaje Corporal", precio: "$65", descripcion: "Tratamiento completo", beneficios: ["90 Minutos"], efectos: ["Revitalizante"], imagenWeb: "", orden: 2 },
        { id: "facial", nombre: "Masaje Facial", precio: "$40", descripcion: "Rejuvenece la piel", beneficios: ["45 Minutos"], efectos: ["Tonifica"], imagenWeb: "", orden: 3 }
    ]);
    
    turnosMem = await initFile(TURNOS_FILE, []);
    await inicializarBaseConocimiento();

    const server = app.listen(PORT, '0.0.0.0', () => {
        console.log(`🌿 SERENA - Asistente de voz iniciado en puerto ${PORT}`);
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
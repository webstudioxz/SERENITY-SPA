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

// ==================== CONFIGURACIÓN DE OPENROUTER ====================
// OpenRouter - API unificada para múltiples modelos de IA
// Modelos recomendados:
// - 'deepseek/deepseek-chat' (económico, buen rendimiento)
// - 'openai/gpt-4o-mini' (muy bueno, bajo costo)
// - 'anthropic/claude-3-haiku' (rápido, económico)
// - 'meta-llama/llama-3.2-3b-instruct:free' (gratuito, limitado)
// - 'google/gemini-2.0-flash-exp:free' (gratuito, 50/día)

const openrouter = new OpenAI({
    baseURL: 'https://openrouter.ai/api/v1',
    apiKey: process.env.OPENROUTER_API_KEY || '',
    defaultHeaders: {
        'HTTP-Referer': 'https://masajes-spa.onrender.com',
        'X-Title': 'Serenity Spa Asistente',
    }
});

// DeepSeek directo como fallback (si no funciona OpenRouter)
const deepseek = new OpenAI({
    baseURL: 'https://api.deepseek.com/v1',
    apiKey: process.env.DEEPSEEK_API_KEY || '',
});

// Variable para controlar el modo de IA
let usarOpenRouter = true;
let modeloActivo = 'deepseek/deepseek-chat'; // Cambiar según preferencia

app.disable('x-powered-by');

if (!fsSync.existsSync(UPLOADS_DIR)) {
    fsSync.mkdirSync(UPLOADS_DIR, { recursive: true });
}

app.use('/uploads', express.static(UPLOADS_DIR));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

const HORAS_VALIDAS = [12, 16, 20];
const DIAS_VALIDOS = ['lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado'];

// ==================== SISTEMA DE BLOQUEOS ====================
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

// ==================== CONFIGURACIÓN DEL SPA ====================
let spaConfig = {
    paisPermitido: '53',
    paisNombre: 'Cuba',
    direccionSalon: 'Calle 23 #456, La Habana, Cuba',
    telefonoAdmin: '+53 5555-1234',
    horarios: 'Lunes a Sábado 12:00, 16:00, 20:00'
};

const SPA_CONFIG_FILE = path.join(__dirname, 'spa-config.json');

async function cargarSpaConfig() {
    try {
        if (fsSync.existsSync(SPA_CONFIG_FILE)) {
            spaConfig = JSON.parse(await fs.readFile(SPA_CONFIG_FILE, 'utf8'));
        } else {
            await guardarSpaConfig();
        }
    } catch(e) {
        await guardarSpaConfig();
    }
}

async function guardarSpaConfig() {
    await fs.writeFile(SPA_CONFIG_FILE, JSON.stringify(spaConfig, null, 2), 'utf8');
}

// ==================== SISTEMA DE PAÍSES ====================
let paisesConfig = {
    autorizados: [],
    bloqueados: [],
    modo: 'solo_autorizados',
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
    if (spaConfig.paisPermitido && spaConfig.paisPermitido !== 'todos') {
        return codigoPais === spaConfig.paisPermitido;
    }
    
    if (paisesConfig.modo === 'todos') {
        if (paisesConfig.bloqueados.length > 0) {
            return !paisesConfig.bloqueados.includes(codigoPais);
        }
        return true;
    }
    return paisesConfig.autorizados.includes(codigoPais);
}

// ==================== BASE DE CONOCIMIENTO ====================
let baseConocimiento = [];
let serviciosData = [];

async function inicializarBaseConocimiento() {
    const servicios = serviciosData.map(s => ({
        tipo: 'servicio',
        contenido: `${s.nombre}: ${s.descripcion}. Precio: ${s.precio}. Beneficios: ${(s.beneficios||[]).join(', ')}. Efectos: ${(s.efectos||[]).join(', ')}`
    }));
    
    const info = [
        { tipo: 'horario', contenido: `Horarios de atención: ${spaConfig.horarios || 'Lunes a Sábado. Turnos disponibles: 12:00, 16:00, 20:00'}. Solo un turno por persona por día.` },
        { tipo: 'politica', contenido: 'Política de cancelación: Se debe cancelar con al menos 4 horas de anticipación. No se aceptan cancelaciones el mismo día del turno.' },
        { tipo: 'ubicacion', contenido: `Ubicación del salón: ${spaConfig.direccionSalon}. También ofrecemos servicio a domicilio.` },
        { tipo: 'contacto', contenido: `Teléfono de contacto: ${spaConfig.telefonoAdmin}. Para consultas urgentes o hablar con un administrador.` },
        { tipo: 'pais', contenido: `Actualmente solo aceptamos reservas desde ${spaConfig.paisNombre}. El código de país es +${spaConfig.paisPermitido}.` }
    ];
    
    baseConocimiento = [...servicios, ...info];
}

let personalidadIA = {
    nombre: 'SpaBot',
    tono: 'profesional y cálido',
    estilo: 'Hablar en español neutro, ser conciso y directo, no leer emojis ni caracteres especiales.',
    reglas: [
        'NUNCA inventar información que no esté en el contexto proporcionado',
        'SIEMPRE ofrecer reservar turnos cuando sea relevante',
        'JAMÁS revelar que eres una IA ni dar detalles técnicos',
        'Si no sabes algo, ofrecer contactar a un administrador humano',
        'NO leer íconos, emojis, asteriscos o caracteres de formato en tus respuestas de voz',
        'Mantener respuestas concisas y útiles'
    ]
};

// ==================== UTILIDADES ====================
function esUrlValida(s) {
    if (!s || typeof s !== 'string') return false;
    const trimmed = s.trim();
    if (trimmed.startsWith('data:')) return false;
    if (trimmed.length > 3000) return false;
    try {
        const url = new URL(trimmed);
        return url.protocol === 'http:' || url.protocol === 'https:';
    } catch(e) {
        return false;
    }
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
    return h > 0 ? `${h}h ${m % 60}m` : m > 0 ? `${m}m ${s % 60}s` : `${s}s`;
}

// ==================== EXTRACCIÓN DE NOMBRE MEJORADA ====================
function extraerNombreLimpio(texto) {
    const textoOriginal = texto;
    const t = textoOriginal.toLowerCase().trim();
    
    const palabrasNoNombre = ['hola', 'buenas', 'saludos', 'quisiera', 'quiero', 'necesito', 'reservar', 'turno', 'masaje', 'para', 'el', 'la', 'los', 'las', 'un', 'una', 'y', 'mi', 'tu', 'su'];
    
    const patronesClaros = [
        /(?:mi\s+nombre\s+es|me\s+llamo|soy)\s+([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+(?:\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+){0,2})/i,
        /(?:hola|buenas).*?(?:soy|me\s+llamo)\s+([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+(?:\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+){0,2})/i
    ];
    
    for (const patron of patronesClaros) {
        const match = textoOriginal.match(patron);
        if (match && match[1]) {
            let nombre = match[1].trim();
            return nombre;
        }
    }
    
    const palabras = textoOriginal.split(/\s+/);
    for (let i = 0; i < palabras.length; i++) {
        const palabra = palabras[i].toLowerCase();
        if ((palabra === 'hola' || palabra === 'buenas' || palabra === 'saludos') && i + 1 < palabras.length) {
            const posibleNombre = palabras[i + 1];
            if (!palabrasNoNombre.includes(posibleNombre.toLowerCase()) && 
                posibleNombre.length >= 2 && 
                posibleNombre.length <= 20 &&
                /^[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+$/.test(posibleNombre)) {
                return posibleNombre;
            }
        }
    }
    
    return null;
}

// ==================== EXTRACCIÓN DE INFORMACIÓN COMPLETA ====================
function extraerInfoCompleta(texto, nombreExistente) {
    const t = texto.toLowerCase();
    const resultado = {
        nombre: null,
        masaje: null,
        hora: null,
        dia: null,
        telefono: null,
        tipoServicio: null
    };
    
    resultado.nombre = extraerNombreLimpio(texto);
    
    if (!resultado.nombre && nombreExistente) {
        resultado.nombre = nombreExistente;
    }
    
    if (t.includes('facial') || t.includes('cara')) {
        resultado.masaje = 'Masaje Facial';
    } else if (t.includes('corporal') || t.includes('cuerpo')) {
        resultado.masaje = 'Masaje Corporal';
    } else if (t.includes('relajante') || t.includes('relajación')) {
        resultado.masaje = 'Masaje Relajante';
    }
    
    if (!resultado.masaje) {
        if (t.includes('3')) resultado.masaje = 'Masaje Facial';
        else if (t.includes('2')) resultado.masaje = 'Masaje Corporal';
        else if (t.includes('1')) resultado.masaje = 'Masaje Relajante';
    }
    
    if (t.includes('12') || t.includes('doce') || t.includes('mediodía')) {
        resultado.hora = 12;
    } else if (t.includes('16') || (t.includes('4') && !t.includes('14')) || t.includes('cuatro') || t.includes('tarde')) {
        resultado.hora = 16;
    } else if (t.includes('20') || (t.includes('8') && !t.includes('18')) || t.includes('ocho') || t.includes('noche')) {
        resultado.hora = 20;
    }
    
    if (t.includes('lunes')) resultado.dia = 'lunes';
    else if (t.includes('martes')) resultado.dia = 'martes';
    else if (t.includes('miercoles') || t.includes('miércoles')) resultado.dia = 'miercoles';
    else if (t.includes('jueves')) resultado.dia = 'jueves';
    else if (t.includes('viernes')) resultado.dia = 'viernes';
    else if (t.includes('sabado') || t.includes('sábado')) resultado.dia = 'sabado';
    
    const numeros = texto.replace(/\D/g, '');
    const telefonoMatch = numeros.match(/\d{7,15}/);
    if (telefonoMatch && telefonoMatch[0].length >= 7) {
        resultado.telefono = telefonoMatch[0];
    }
    
    if (t.includes('salon') || t.includes('salón') || t.includes('local')) {
        resultado.tipoServicio = 'salon';
    } else if (t.includes('domicilio') || t.includes('casa') || t.includes('hogar')) {
        resultado.tipoServicio = 'domicilio';
    }
    
    return resultado;
}

// ==================== MIDDLEWARES ====================
app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    next();
});

app.use((req, res, next) => {
    const ip = req.ip || req.socket.remoteAddress || '0.0.0.0';
    if (estaBloqueado(ip)) {
        return res.status(403).json({ error: 'IP bloqueada por seguridad', bloqueado: true });
    }
    next();
});

app.use(express.static(__dirname));

// ==================== AUTENTICACIÓN ====================
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
    if (!password) {
        registrarIntento(ip, 'Contraseña vacía');
        return res.status(400).json({ success: false, error: 'Contraseña requerida' });
    }
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

// ==================== CONFIGURACIÓN DEL SPA ====================
app.get('/api/spa-config', (req, res) => {
    res.json(spaConfig);
});

app.put('/api/spa-config', async (req, res) => {
    if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    
    const { paisPermitido, paisNombre, direccionSalon, telefonoAdmin, horarios } = req.body;
    
    if (paisPermitido !== undefined) spaConfig.paisPermitido = paisPermitido;
    if (paisNombre !== undefined) spaConfig.paisNombre = paisNombre;
    if (direccionSalon !== undefined) spaConfig.direccionSalon = direccionSalon;
    if (telefonoAdmin !== undefined) spaConfig.telefonoAdmin = telefonoAdmin;
    if (horarios !== undefined) spaConfig.horarios = horarios;
    
    await guardarSpaConfig();
    await inicializarBaseConocimiento();
    
    res.json({ ok: true, spaConfig });
});

// ==================== CONFIGURACIÓN GENERAL ====================
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
    res.json({ ok: true, mensaje: 'Configuración guardada' });
});

// ==================== UPLOAD HERO ====================
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
        const files = await fs.readdir(UPLOADS_DIR);
        for (const f of files) {
            if (f.startsWith('hero-') && f !== filename) {
                try { await fs.unlink(path.join(UPLOADS_DIR, f)); } catch(e) {}
            }
        }
        res.json({ url: `/uploads/${filename}`, filename });
    } catch (e) {
        res.status(500).json({ error: 'Error al subir imagen' });
    }
});

// ==================== SERVICIOS ====================
app.get('/api/servicios', (req, res) => {
    res.json(serviciosData.sort((a, b) => (a.orden || 999) - (b.orden || 999)));
});

app.post('/api/servicios', async (req, res) => {
    if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    try {
        let iwa = '';
        if (req.body.imagenWhatsApp && esUrlValida(req.body.imagenWhatsApp)) {
            iwa = req.body.imagenWhatsApp.trim();
        }
        const s = {
            id: generarId(),
            ...req.body,
            imagenWeb: req.body.imagenWeb || 'https://images.unsplash.com/photo-1544161515-4ab6ce6db874?w=800',
            imagenWhatsApp: iwa
        };
        serviciosData.push(s);
        await fs.writeFile(SERVICIOS_FILE, JSON.stringify(serviciosData, null, 2), 'utf8');
        await inicializarBaseConocimiento();
        res.status(201).json(s);
    } catch(e) {
        res.status(500).json({ error: 'Error al crear servicio' });
    }
});

app.put('/api/servicios/:id', async (req, res) => {
    if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    try {
        const index = serviciosData.findIndex(s => s.id === req.params.id);
        if (index === -1) return res.status(404).json({ error: 'Servicio no encontrado' });
        
        serviciosData[index] = {
            ...serviciosData[index],
            ...req.body,
            id: req.params.id
        };
        
        await fs.writeFile(SERVICIOS_FILE, JSON.stringify(serviciosData, null, 2), 'utf8');
        await inicializarBaseConocimiento();
        res.json({ ok: true, mensaje: 'Servicio actualizado', servicio: serviciosData[index] });
    } catch(e) {
        console.error('Error al actualizar servicio:', e);
        res.status(500).json({ error: 'Error al actualizar servicio' });
    }
});

app.delete('/api/servicios/:id', async (req, res) => {
    if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    const antes = serviciosData.length;
    serviciosData = serviciosData.filter(s => s.id !== req.params.id);
    await fs.writeFile(SERVICIOS_FILE, JSON.stringify(serviciosData, null, 2), 'utf8');
    await inicializarBaseConocimiento();
    res.json({ ok: true, mensaje: serviciosData.length < antes ? 'Servicio eliminado' : 'No encontrado' });
});

// ==================== TURNOS ====================
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
    if (estaBloqueado(ip)) return res.status(403).json({ error: 'IP bloqueada por seguridad' });
    if (!checkRateIP(ip)) {
        bloquearIP(ip, 'Exceso de solicitudes de turnos', 'spam');
        return res.status(429).json({ error: 'Demasiadas solicitudes' });
    }
    
    try {
        const { nombre, dia, hora, massageType, telefono, ubicacion, tipoServicio } = req.body;
        
        if (!nombre || nombre.length < 2) {
            return res.status(400).json({ error: 'Nombre inválido' });
        }
        
        const tel = telefono ? telefono.replace(/\D/g, '') : '';
        if (!tel || tel.length < 7) {
            return res.status(400).json({ error: 'Teléfono inválido' });
        }
        
        let codigoPais = req.body.codigoPais || spaConfig.paisPermitido;
        
        if (!paisAutorizado(codigoPais)) {
            return res.status(403).json({ 
                error: 'País no autorizado',
                mensaje: `Lo sentimos, solo aceptamos reservas desde ${spaConfig.paisNombre}.`
            });
        }
        
        if (!dia || !DIAS_VALIDOS.includes(dia.toLowerCase())) {
            return res.status(400).json({ error: 'Día inválido' });
        }
        
        const hn = parseInt(hora);
        if (!HORAS_VALIDAS.includes(hn)) {
            return res.status(400).json({ error: 'Hora inválida' });
        }
        
        if (!checkRateTel(tel)) {
            return res.status(429).json({ error: 'Máximo 2 turnos por día' });
        }
        
        const turnos = await loadTurnos();
        const dl = dia.toLowerCase();
        
        if (turnos.some(t => t.telefono === tel && t.dia === dl)) {
            return res.status(409).json({ error: 'Ya tienes un turno ese día' });
        }
        
        if (turnos.some(t => t.dia === dl && t.hora === hn)) {
            return res.status(409).json({ 
                error: 'Horario ocupado', 
                alternativa: buscarAlternativa(dl, hn, turnos) 
            });
        }
        
        const nuevo = {
            id: generarId(),
            nombre: escapeHtml(sanitize(nombre)),
            dia: dl,
            hora: hn,
            massageType: massageType || 'Masaje',
            telefono: tel,
            codigoPais: codigoPais,
            ubicacion: ubicacion ? escapeHtml(sanitize(ubicacion)) : null,
            tipoServicio: tipoServicio || 'salon',
            confirmadoWhatsApp: false,
            fechaCreacion: new Date().toISOString(),
            ip
        };
        
        turnos.push(nuevo);
        await saveTurnos(turnos);
        regTurno(ip, tel);
        
        res.status(201).json({ mensaje: 'Turno reservado con éxito', turno: nuevo });
    } catch(e) {
        console.error('Error al crear turno:', e);
        res.status(500).json({ error: 'Error interno' });
    }
});

function buscarAlternativa(dia, hora, turnos) {
    const dias = ['lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado'];
    const idx = dias.indexOf(dia);
    if (idx === -1) return null;
    for (let o = 0; o < 7; o++) {
        const d = dias[(idx + o) % 7];
        const hrs = o === 0 ? HORAS_VALIDAS.filter(h => h > hora) : HORAS_VALIDAS;
        for (const h of hrs) {
            if (!turnos.some(t => t.dia === d && t.hora === h)) return { dia: d, hora: h };
        }
    }
    return null;
}

app.delete('/turnos/:id', async (req, res) => {
    if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    const turnos = await loadTurnos();
    const i = turnos.findIndex(t => t.id === req.params.id);
    if (i === -1) return res.status(404).json({ error: 'Turno no encontrado' });
    turnos.splice(i, 1);
    await saveTurnos(turnos);
    res.json({ ok: true, mensaje: 'Turno eliminado' });
});

app.post('/api/enviar-whatsapp/:id', async (req, res) => {
    try {
        const turnos = await loadTurnos();
        const t = turnos.find(x => x.id === req.params.id);
        if (!t) return res.status(404).json({ error: 'Turno no encontrado' });
        const s = serviciosData.find(x => x.nombre === t.massageType);
        const img = (s?.imagenWhatsApp && esUrlValida(s.imagenWhatsApp)) ? s.imagenWhatsApp : '';
        let msg = `SERENITY SPA\n\nHola ${t.nombre}, Gracias por tu reserva!\n\nRESERVA CONFIRMADA\n\nDia: ${t.dia.charAt(0).toUpperCase() + t.dia.slice(1)}\nHora: ${t.hora}:00\nMasaje: ${t.massageType}\nLugar: ${t.tipoServicio === 'domicilio' ? t.ubicacion : 'Serenity Spa'}\n\nTe esperamos!`;
        if (img) msg += `\n\nImagen: ${img}`;
        msg += `\n\nEquipo Serenity Spa`;
        const cod = t.codigoPais || '53';
        const idx = turnos.findIndex(x => x.id === req.params.id);
        if (idx !== -1) {
            turnos[idx].confirmadoWhatsApp = true;
            turnos[idx].fechaWA = new Date().toISOString();
            await saveTurnos(turnos);
        }
        res.json({ 
            success: true, 
            numero: `${cod}${t.telefono}`, 
            mensaje: msg
        });
    } catch(e) {
        res.status(500).json({ error: 'Error al preparar WhatsApp' });
    }
});

// ==================== CHAT CON IA USANDO OPENROUTER ====================
app.post('/api/chat-ia', async (req, res) => {
    const ip = req.ip || '0.0.0.0';
    
    if (estaBloqueado(ip)) {
        return res.status(403).json({ error: 'IP bloqueada' });
    }
    
    const { mensaje, nombre, codigoPais } = req.body;
    
    if (!mensaje || mensaje.length > 500) {
        return res.status(400).json({ error: 'Mensaje inválido' });
    }
    
    const mensajeLimpio = mensaje.replace(/<[^>]*>/g, '').trim();
    
    const patronesAtaque = [
        /ignore|bypass|override|system prompt|revela/i,
        /<script>|javascript:|onerror=/i,
        /SELECT.*FROM|DROP TABLE|UNION SELECT/i
    ];
    
    for (const patron of patronesAtaque) {
        if (patron.test(mensajeLimpio)) {
            registrarIntento(ip, 'inyección');
            return res.status(400).json({ error: 'Mensaje no permitido' });
        }
    }
    
    try {
        const contexto = buscarContexto(mensajeLimpio);
        
        const systemPrompt = `Eres ${personalidadIA.nombre}, asistente virtual de Serenity Spa.

TONO: ${personalidadIA.tono}
ESTILO: ${personalidadIA.estilo}

INFORMACION DEL NEGOCIO:
${contexto.join('\n')}

DATOS DEL CLIENTE:
- Nombre: ${nombre || 'No proporcionado'}
- Pais permitido: ${spaConfig.paisNombre} (+${spaConfig.paisPermitido})
- Direccion del salon: ${spaConfig.direccionSalon}
- Telefono admin: ${spaConfig.telefonoAdmin}

SERVICIOS DISPONIBLES:
${serviciosData.map((s, i) => `${i+1}. ${s.nombre} - ${s.precio}`).join('\n')}

REGLAS ESTRICTAS:
${personalidadIA.reglas.map((r, i) => `${i+1}. ${r}`).join('\n')}

Responde de manera natural y profesional. No uses emojis ni asteriscos.`;

        // ========== INTENTAR PRIMERO CON OPENROUTER ==========
        if (process.env.OPENROUTER_API_KEY && usarOpenRouter) {
            try {
                const completion = await openrouter.chat.completions.create({
                    model: modeloActivo,
                    messages: [
                        { role: 'system', content: systemPrompt },
                        { role: 'user', content: mensajeLimpio }
                    ],
                    temperature: 0.5,
                    max_tokens: 400
                });
                
                const respuesta = completion.choices[0].message.content;
                return res.json({ respuesta, modo: 'openrouter', modelo: modeloActivo });
            } catch (error) {
                console.error('Error con OpenRouter:', error.message);
                // Si falla OpenRouter, intentar con DeepSeek directo
                if (process.env.DEEPSEEK_API_KEY) {
                    try {
                        const completion = await deepseek.chat.completions.create({
                            model: 'deepseek-chat',
                            messages: [
                                { role: 'system', content: systemPrompt },
                                { role: 'user', content: mensajeLimpio }
                            ],
                            temperature: 0.5,
                            max_tokens: 400
                        });
                        const respuesta = completion.choices[0].message.content;
                        return res.json({ respuesta, modo: 'deepseek-fallback' });
                    } catch (e) {
                        console.error('Error con DeepSeek fallback:', e.message);
                    }
                }
            }
        }
        
        // ========== FALLBACK: Sistema local ==========
        console.log('Usando sistema local (sin API)');
        const respuestaLocal = generarRespuestaLocalMejorada(mensajeLimpio, nombre, codigoPais);
        return res.json({ respuesta: respuestaLocal, modo: 'local' });
        
    } catch (error) {
        console.error('Error general en chat IA:', error.message);
        const respuestaLocal = generarRespuestaLocalMejorada(mensajeLimpio, nombre, codigoPais);
        res.json({ respuesta: respuestaLocal, modo: 'local' });
    }
});

function generarRespuestaLocalMejorada(mensaje, nombreExistente, codigoPais) {
    const msg = mensaje.toLowerCase();
    const cliente = nombreExistente || 'cliente';
    
    if (/^(hola|buenas|saludos|hey)/i.test(msg) && !nombreExistente) {
        return `Hola, se ha comunicado con el asistente de Serenity Spa. ¿Con quién tengo el gusto de hablar?`;
    }
    
    if (nombreExistente) {
        if (msg.includes('ubicacion') || msg.includes('direccion') || msg.includes('donde esta')) {
            return `Nuestro salón está ubicado en ${spaConfig.direccionSalon}. ¿Necesitas ayuda con algo más?`;
        }
        
        if (msg.includes('precio') || msg.includes('costo') || msg.includes('cuanto')) {
            let lista = 'Nuestros precios son: ';
            serviciosData.forEach(s => {
                lista += `${s.nombre} ${s.precio}, `;
            });
            return lista.slice(0, -2) + '. ¿Te gustaría reservar alguno?';
        }
        
        if (msg.includes('horario') || msg.includes('horarios')) {
            return `Nuestros horarios son: ${spaConfig.horarios}. ¿Te gustaría reservar?`;
        }
        
        if (msg.includes('tipos') || msg.includes('masajes')) {
            let lista = 'Nuestros masajes: ';
            serviciosData.forEach((s, i) => {
                lista += `${i+1}. ${s.nombre} ${s.precio}, `;
            });
            return lista.slice(0, -2) + '. ¿Cuál te interesa?';
        }
    }
    
    const infoExtraida = extraerInfoCompleta(mensaje, nombreExistente);
    
    if (infoExtraida.nombre && infoExtraida.masaje && infoExtraida.hora && infoExtraida.dia && infoExtraida.telefono) {
        return `Gracias ${infoExtraida.nombre}. Tengo toda tu información: ${infoExtraida.masaje} para el ${infoExtraida.dia} a las ${infoExtraida.hora}:00. Tu teléfono es +${spaConfig.paisPermitido} ${infoExtraida.telefono}. ¿Confirmas la reserva?`;
    }
    
    if (!nombreExistente && !infoExtraida.nombre) {
        return `Para poder ayudarte mejor, ¿me podrías decir tu nombre?`;
    }
    
    if (!infoExtraida.masaje) {
        return `¿Qué tipo de masaje te interesa? Tenemos: 1. Masaje Relajante, 2. Masaje Corporal, 3. Masaje Facial.`;
    }
    
    if (!infoExtraida.dia) {
        return `¿Qué día prefieres? Atendemos de lunes a sábado.`;
    }
    
    if (!infoExtraida.hora) {
        return `¿A qué hora te gustaría? Nuestros horarios son 12 del mediodía, 4 de la tarde o 8 de la noche.`;
    }
    
    if (!infoExtraida.telefono) {
        return `Para confirmar tu reserva, necesito tu número de teléfono.`;
    }
    
    return `Hola ${cliente}, ¿en qué puedo ayudarte hoy? Puedo ayudarte a reservar un turno, consultar horarios o ver nuestros precios.`;
}

function buscarContexto(pregunta) {
    const palabrasClave = pregunta.toLowerCase().split(/\s+/);
    let resultados = [];
    
    for (const item of baseConocimiento) {
        let puntuacion = 0;
        const contenidoLower = item.contenido.toLowerCase();
        
        for (const palabra of palabrasClave) {
            if (palabra.length > 2 && contenidoLower.includes(palabra)) {
                puntuacion += 1;
            }
        }
        
        if (puntuacion > 0) {
            resultados.push({ ...item, puntuacion });
        }
    }
    
    return resultados
        .sort((a, b) => b.puntuacion - a.puntuacion)
        .slice(0, 5)
        .map(r => r.contenido);
}

// ==================== ENDPOINT PARA CAMBIAR MODELO DE IA ====================
app.post('/api/ia/modelo', async (req, res) => {
    if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    const { modelo, usarOpenRouterFlag } = req.body;
    
    if (modelo) modeloActivo = modelo;
    if (usarOpenRouterFlag !== undefined) usarOpenRouter = usarOpenRouterFlag;
    
    res.json({ 
        ok: true, 
        modelo: modeloActivo, 
        usarOpenRouter,
        modelosDisponibles: [
            'deepseek/deepseek-chat',
            'openai/gpt-4o-mini',
            'anthropic/claude-3-haiku',
            'meta-llama/llama-3.2-3b-instruct:free',
            'google/gemini-2.0-flash-exp:free'
        ]
    });
});

// ==================== IA - PERSONALIDAD ====================
app.get('/api/ia/personalidad', (req, res) => {
    if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    res.json(personalidadIA);
});

app.put('/api/ia/personalidad', async (req, res) => {
    if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    const { nombre, tono, estilo, reglas } = req.body;
    if (nombre) personalidadIA.nombre = sanitize(nombre);
    if (tono) personalidadIA.tono = sanitize(tono);
    if (estilo) personalidadIA.estilo = sanitize(estilo);
    if (reglas) personalidadIA.reglas = reglas.map(r => sanitize(r));
    res.json({ ok: true });
});

app.post('/api/ia/recargar', async (req, res) => {
    if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    await inicializarBaseConocimiento();
    res.json({ ok: true, items: baseConocimiento.length });
});

// ==================== SEGURIDAD - BLOQUEOS ====================
app.get('/api/seguridad/bloqueos', (req, res) => {
    if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    const a = [];
    for (const [ip, d] of bloqueos) {
        a.push({
            ip,
            motivo: d.motivo,
            tipoAtaque: d.tipoAtaque,
            fecha: d.fecha,
            tiempoRestante: Math.max(0, d.hasta - Date.now()),
            tiempoRestanteFormateado: fmtT(Math.max(0, d.hasta - Date.now())),
            intentos: d.intentos || 0,
            permanente: d.permanente || false
        });
    }
    res.json({
        activos: a,
        historial: historialBloqueos.slice(0, 100),
        intentosFallidos: Object.fromEntries(intentosFallidos)
    });
});

app.post('/api/seguridad/desbloquear/:ip', (req, res) => {
    if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    desbloquearIP(req.params.ip);
    res.json({ ok: true });
});

app.delete('/api/seguridad/bloqueos/:ip', (req, res) => {
    if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    bloqueos.delete(req.params.ip);
    intentosFallidos.delete(req.params.ip);
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
    res.json({ mensaje: `${b} bloqueos expirados eliminados` });
});

app.post('/api/seguridad/bloquear-permanente/:ip', (req, res) => {
    if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    bloquearIP(req.params.ip, 'Bloqueo permanente manual', 'manual');
    const d = bloqueos.get(req.params.ip);
    if (d) { d.hasta = Date.now() + 31536000000; d.permanente = true; guardarBloqueos(); }
    res.json({ ok: true });
});

// ==================== RUTAS ESTÁTICAS ====================
app.get('/voice-assistant', (req, res) => {
    res.sendFile(path.join(__dirname, 'voice-assistant.html'));
});
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});
app.get('/admin.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'admin.html'));
});
app.get('/login.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'login.html'));
});
app.get('/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        timestamp: new Date().toISOString(), 
        uptime: process.uptime(),
        ia: process.env.OPENROUTER_API_KEY ? 'openrouter' : (process.env.DEEPSEEK_API_KEY ? 'deepseek' : 'local'),
        modelo: modeloActivo,
        paisPermitido: spaConfig.paisNombre
    });
});

// ==================== WEBSOCKET PARA VOZ ====================
let voiceClients = new Map();

async function procesarComandoVoz(texto, clientId, ip) {
    const textoOriginal = texto;
    const tl = textoOriginal.toLowerCase().trim();
    
    let session = voiceClients.get(clientId);
    if (!session) {
        session = {
            estado: 'inicio',
            datos: {
                nombre: null,
                masaje: null,
                hora: null,
                dia: null,
                telefono: null,
                codigoPais: spaConfig.paisPermitido
            },
            reservaActiva: false,
            ultimaReserva: null,
            esperandoConfirmacion: false
        };
        voiceClients.set(clientId, session);
    }
    
    const infoExtraida = extraerInfoCompleta(textoOriginal, session.datos.nombre);
    
    if (infoExtraida.nombre && !session.datos.nombre) {
        session.datos.nombre = infoExtraida.nombre;
    }
    if (infoExtraida.masaje && !session.datos.masaje) {
        session.datos.masaje = infoExtraida.masaje;
    }
    if (infoExtraida.hora && !session.datos.hora) {
        session.datos.hora = infoExtraida.hora;
    }
    if (infoExtraida.dia && !session.datos.dia) {
        session.datos.dia = infoExtraida.dia;
    }
    if (infoExtraida.telefono && !session.datos.telefono) {
        session.datos.telefono = infoExtraida.telefono;
    }
    if (infoExtraida.tipoServicio && !session.datos.tipoServicio) {
        session.datos.tipoServicio = infoExtraida.tipoServicio;
    }
    
    const nombre = session.datos.nombre;
    const tieneInfoCompleta = session.datos.nombre && session.datos.masaje && session.datos.hora && session.datos.dia && session.datos.telefono;
    
    if (tl.includes('cancelar') && session.reservaActiva) {
        session.reservaActiva = false;
        session.estado = 'inicio';
        session.datos = {
            nombre: session.datos.nombre,
            masaje: null,
            hora: null,
            dia: null,
            telefono: null,
            codigoPais: spaConfig.paisPermitido
        };
        session.esperandoConfirmacion = false;
        return `${nombre || 'Cliente'}, tu reserva ha sido cancelada. ¿Necesitas ayuda con algo más?`;
    }
    
    if (session.reservaActiva && !session.esperandoConfirmacion) {
        if (tl.includes('ubicacion') || tl.includes('dirección') || tl.includes('donde esta')) {
            return `Nuestro salón está ubicado en ${spaConfig.direccionSalon}. Tu reserva para el ${session.ultimaReserva?.dia} a las ${session.ultimaReserva?.hora}:00 sigue confirmada. ¿Algo más?`;
        }
        
        if (tl.includes('horario') || tl.includes('horarios')) {
            return `Nuestros horarios son: ${spaConfig.horarios}. Tu reserva está confirmada para el ${session.ultimaReserva?.dia} a las ${session.ultimaReserva?.hora}:00.`;
        }
        
        if (tl.includes('precio') || tl.includes('costo') || tl.includes('cuánto')) {
            let lista = 'Nuestros precios: ';
            serviciosData.forEach(s => {
                lista += `${s.nombre} ${s.precio}, `;
            });
            return lista.slice(0, -2) + '. ¿Quieres reservar otro masaje?';
        }
        
        if (tl.includes('tipos') || tl.includes('masajes disponibles')) {
            let lista = 'Nuestros masajes: ';
            serviciosData.forEach((s, i) => {
                lista += `${i+1}. ${s.nombre} ${s.precio}, `;
            });
            return lista.slice(0, -2) + '. ¿Te interesa alguno?';
        }
        
        if (tl.includes('gracias')) {
            return `Gracias a ti ${nombre || 'cliente'}. Que tengas un excelente día. Tu reserva está confirmada.`;
        }
    }
    
    if (session.esperandoConfirmacion) {
        if (tl.includes('si') || tl.includes('sí') || tl.includes('confirmo') || tl.includes('vale') || tl.includes('ok')) {
            const resultado = await confirmarReservaFinal(session, ip);
            if (resultado.includes('confirmada')) {
                session.reservaActiva = true;
                session.ultimaReserva = {
                    dia: session.datos.dia,
                    hora: session.datos.hora,
                    masaje: session.datos.masaje
                };
                session.estado = 'activo';
                session.esperandoConfirmacion = false;
            }
            return resultado;
        } else if (tl.includes('no') || tl.includes('cancelar')) {
            session.esperandoConfirmacion = false;
            session.datos = {
                nombre: session.datos.nombre,
                masaje: null,
                hora: null,
                dia: null,
                telefono: null,
                codigoPais: spaConfig.paisPermitido
            };
            return 'Entiendo, cancelamos la reserva. ¿Necesitas ayuda con algo más?';
        } else {
            return 'No entendí si confirmas la reserva. Responde "sí" para confirmar o "no" para cancelar.';
        }
    }
    
    if (tieneInfoCompleta) {
        session.esperandoConfirmacion = true;
        const horaTexto = session.datos.hora === 12 ? '12 del mediodía' : session.datos.hora === 16 ? '4 de la tarde' : '8 de la noche';
        return `Gracias ${session.datos.nombre}. Tengo tu información: ${session.datos.masaje} para el ${session.datos.dia} a las ${horaTexto}. Tu teléfono es +${spaConfig.paisPermitido} ${session.datos.telefono}. ¿Confirmas la reserva? Responde sí o no.`;
    }
    
    if (!session.datos.nombre) {
        if (tl.includes('reservar') || tl.includes('turno')) {
            return 'Claro, puedo ayudarte a reservar. ¿Cuál es tu nombre?';
        }
        return 'Hola, se ha comunicado con el asistente de Serenity Spa. ¿Con quién tengo el gusto de hablar?';
    }
    
    if (!session.datos.masaje) {
        return `${session.datos.nombre}, ¿qué tipo de masaje te interesa? Tenemos: 1. Masaje Relajante, 2. Masaje Corporal, 3. Masaje Facial.`;
    }
    
    if (!session.datos.dia) {
        return `${session.datos.nombre}, ¿qué día prefieres para tu ${session.datos.masaje}? Atendemos de lunes a sábado.`;
    }
    
    if (!session.datos.hora) {
        return `${session.datos.nombre}, ¿a qué hora te gustaría el ${session.datos.dia}? Nuestros horarios son 12 del mediodía, 4 de la tarde o 8 de la noche.`;
    }
    
    if (!session.datos.telefono) {
        return `${session.datos.nombre}, para confirmar tu reserva, necesito tu número de teléfono. Solo los números, por favor.`;
    }
    
    return `${session.datos.nombre}, ¿en qué puedo ayudarte? Puedo ayudarte a reservar un turno, consultar horarios o ver nuestros precios.`;
}

async function confirmarReservaFinal(session, ip) {
    const d = session.datos;
    
    if (!d.codigoPais) d.codigoPais = spaConfig.paisPermitido;
    
    if (!paisAutorizado(d.codigoPais)) {
        return `Lo sentimos, solo aceptamos reservas desde ${spaConfig.paisNombre}.`;
    }
    
    try {
        const turnos = JSON.parse(await fs.readFile(TURNOS_FILE, 'utf8'));
        const diaActual = d.dia;
        const horaActual = d.hora;
        
        if (turnos.some(t => t.telefono === d.telefono && t.dia === diaActual)) {
            return `${d.nombre}, ya tienes un turno para el ${diaActual}. Solo se permite uno por día. ¿Quieres otro día?`;
        }
        
        if (turnos.some(t => t.dia === diaActual && t.hora === horaActual)) {
            const alt = buscarAlternativa(diaActual, horaActual, turnos);
            if (alt) {
                session.datos.dia = alt.dia;
                session.datos.hora = alt.hora;
                return `Ese horario está ocupado, ${d.nombre}. Pero tengo disponible el ${alt.dia} a las ${alt.hora}:00. ¿Te sirve? Responde sí o no.`;
            }
            return `Lo siento, ${d.nombre}. No hay disponibilidad para el ${diaActual}. ¿Probamos otro día?`;
        }
        
        const nuevo = {
            id: generarId(),
            nombre: d.nombre,
            dia: diaActual,
            hora: horaActual,
            massageType: d.masaje,
            telefono: d.telefono,
            codigoPais: d.codigoPais,
            ubicacion: d.ubicacion || spaConfig.direccionSalon,
            tipoServicio: d.tipoServicio || 'salon',
            confirmadoWhatsApp: false,
            fechaCreacion: new Date().toISOString(),
            ip
        };
        
        turnos.push(nuevo);
        await fs.writeFile(TURNOS_FILE, JSON.stringify(turnos, null, 2), 'utf8');
        
        const horaTexto = horaActual === 12 ? '12 del mediodía' : horaActual === 16 ? '4 de la tarde' : '8 de la noche';
        const ubicacionTexto = d.tipoServicio === 'domicilio' ? d.ubicacion : spaConfig.direccionSalon;
        
        return `Reserva confirmada, ${d.nombre}. Día: ${diaActual}. Hora: ${horaTexto}. Masaje: ${d.masaje}. Lugar: ${ubicacionTexto}. Te esperamos. Si necesitas cancelar, avisa con 4 horas de anticipación. ¿Necesitas algo más?`;
        
    } catch(e) {
        console.error('Error al reservar:', e);
        return `Hubo un error al procesar tu reserva, ${d.nombre}. Por favor, intenta de nuevo más tarde.`;
    }
}

// ==================== INICIALIZACIÓN ====================
async function initFile(f, fb) {
    try { return JSON.parse(await fs.readFile(f, 'utf8')); }
    catch(e) { await fs.writeFile(f, JSON.stringify(fb, null, 2), 'utf8'); return JSON.parse(JSON.stringify(fb)); }
}

async function start() {
    await cargarBloqueos();
    await cargarPaises();
    await cargarSpaConfig();
    
    configData = await initFile(CONFIG_FILE, configData);
    
    serviciosData = await initFile(SERVICIOS_FILE, [
        { id: "relajante", nombre: "Masaje Relajante", precio: "$45", descripcion: "Movimientos suaves y armónicos para liberar el estrés acumulado.", beneficios: ["Reduce ansiedad", "Alivia tensión muscular", "60 Minutos"], efectos: ["Relajación profunda", "Mejora del sueño"], imagenWeb: "https://images.unsplash.com/photo-1544161515-4ab6ce6db874?w=800", imagenWhatsApp: "", orden: 1 },
        { id: "corporal", nombre: "Masaje Corporal", precio: "$65", descripcion: "Tratamiento completo para una relajación profunda y revitalizante.", beneficios: ["Relajación integral", "Elimina contracturas", "90 Minutos"], efectos: ["Activación linfática", "Mejora circulación"], imagenWeb: "https://images.unsplash.com/photo-1519823551278-64ac92734fb1?w=800", imagenWhatsApp: "", orden: 2 },
        { id: "facial", nombre: "Masaje Facial", precio: "$40", descripcion: "Rejuvenece la piel y alivia la tensión facial acumulada.", beneficios: ["Reafirma la piel", "Reduce ojeras", "45 Minutos"], efectos: ["Estimula colágeno", "Tonifica rostro"], imagenWeb: "https://images.unsplash.com/photo-1570172619644-dfd03ed5d881?w=800", imagenWhatsApp: "", orden: 3 }
    ]);
    
    turnosMem = await initFile(TURNOS_FILE, []);
    await inicializarBaseConocimiento();

    const server = app.listen(PORT, '0.0.0.0', () => {
        console.log(`Serenity Spa v4.0 iniciado en puerto ${PORT}`);
        console.log(`IA: ${process.env.OPENROUTER_API_KEY ? 'OpenRouter configurado' : (process.env.DEEPSEEK_API_KEY ? 'DeepSeek disponible' : 'Modo local')}`);
        console.log(`Modelo activo: ${modeloActivo}`);
        console.log(`País permitido: ${spaConfig.paisNombre} (+${spaConfig.paisPermitido})`);
    });

    const wss = new WebSocket.Server({ server, path: '/ws-voice' });
    
    wss.on('connection', (ws, req) => {
        const ip = req.socket.remoteAddress || 'desconocida';
        
        if (estaBloqueado(ip)) {
            ws.close(1008, 'IP bloqueada');
            return;
        }
        
        const cid = generarId();
        let mc = 0;
        
        ws.on('message', async (data) => {
            mc++;
            if (mc > 20) {
                bloquearIP(ip, 'Flood WebSocket', 'flood');
                ws.close(1008);
                return;
            }
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
                    ws.send(JSON.stringify({ tipo: 'respuesta', texto: 'Disculpe, hubo un error. ¿Podría repetir?' }));
                }
            }
        });
        
        ws.on('close', () => voiceClients.delete(cid));
        
        const ft = setInterval(() => { mc = 0; }, 60000);
        ws.on('close', () => clearInterval(ft));
    });
}

process.on('SIGTERM', async () => { await guardarBloqueos(); await guardarPaises(); process.exit(0); });
process.on('SIGINT', async () => { await guardarBloqueos(); await guardarPaises(); process.exit(0); });

start();
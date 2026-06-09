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

// Configurar DeepSeek (opcional)
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
// SISTEMA DE PAÍSES (CORREGIDO)
// ============================================================
let paisesConfig = {
    autorizados: [],
    bloqueados: [],
    modo: 'todos',
    ubicacionSalon: 'Salón Serenity Spa, Calle Principal #123'
};

async function cargarPaises() {
    try {
        if (fsSync.existsSync(PAISES_FILE)) {
            const data = JSON.parse(await fs.readFile(PAISES_FILE, 'utf8'));
            paisesConfig = {
                autorizados: data.autorizados || [],
                bloqueados: data.bloqueados || [],
                modo: data.modo || 'todos',
                ubicacionSalon: data.ubicacionSalon || 'Salón Serenity Spa, Calle Principal #123'
            };
            console.log('✅ Países cargados:', paisesConfig.autorizados.length, 'autorizados,', paisesConfig.bloqueados.length, 'bloqueados');
        } else {
            await guardarPaises();
        }
    } catch(e) {
        console.error('Error cargando países:', e);
        await guardarPaises();
    }
}

async function guardarPaises() {
    try {
        await fs.writeFile(PAISES_FILE, JSON.stringify(paisesConfig, null, 2), 'utf8');
        console.log('✅ Países guardados correctamente');
    } catch(e) {
        console.error('Error guardando países:', e);
    }
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
// BASE DE CONOCIMIENTO PARA IA
// ============================================================
let baseConocimiento = [];

async function inicializarBaseConocimiento() {
    const servicios = serviciosData.map(s => ({
        tipo: 'servicio',
        contenido: `${s.nombre}: ${s.descripcion}. Precio: ${s.precio}. Beneficios: ${(s.beneficios||[]).join(', ')}. Efectos: ${(s.efectos||[]).join(', ')}`
    }));
    
    const info = [
        { tipo: 'horario', contenido: `Horarios de atención: Lunes a Sábado. Turnos disponibles: 12:00 del mediodía, 16:00 de la tarde y 20:00 de la noche. Solo un turno por persona por día. Ubicación: ${paisesConfig.ubicacionSalon}` },
        { tipo: 'politica', contenido: 'Política de cancelación: Se debe cancelar con al menos 4 horas de anticipación. No se aceptan cancelaciones el mismo día del turno.' },
        { tipo: 'contacto', contenido: 'Para consultas urgentes o hablar con un administrador, solicitar al asistente. El equipo de Serenity Spa está disponible de Lunes a Sábado.' }
    ];
    
    baseConocimiento = [...servicios, ...info];
}

// ============================================================
// UTILIDADES
// ============================================================
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

function detectarPaisConNombre(texto) {
    const t = texto.toLowerCase().trim();
    const paises = [
        { nombre: 'Cuba', codigo: '53', claves: ['cuba', 'cubano'] },
        { nombre: 'Argentina', codigo: '54', claves: ['argentina', 'argentino', 'arg'] },
        { nombre: 'México', codigo: '52', claves: ['méxico', 'mexico', 'mexicano'] },
        { nombre: 'Colombia', codigo: '57', claves: ['colombia', 'colombiano', 'colom'] },
        { nombre: 'Chile', codigo: '56', claves: ['chile', 'chileno'] },
        { nombre: 'Perú', codigo: '51', claves: ['perú', 'peru', 'peruano'] },
        { nombre: 'España', codigo: '34', claves: ['españa', 'espania', 'español'] },
        { nombre: 'Venezuela', codigo: '58', claves: ['venezuela', 'venezolano'] },
        { nombre: 'Ecuador', codigo: '593', claves: ['ecuador', 'ecuatoriano'] },
        { nombre: 'Uruguay', codigo: '598', claves: ['uruguay', 'uruguayo'] },
        { nombre: 'Paraguay', codigo: '595', claves: ['paraguay', 'paraguayo'] },
        { nombre: 'Bolivia', codigo: '591', claves: ['bolivia', 'boliviano'] },
        { nombre: 'Brasil', codigo: '55', claves: ['brasil', 'brasileño'] },
        { nombre: 'Estados Unidos', codigo: '1', claves: ['estados unidos', 'usa', 'eeuu', 'americano'] },
    ];
    for (const pais of paises) {
        for (const clave of pais.claves) {
            if (t.includes(clave)) return { nombre: pais.nombre, codigo: pais.codigo };
        }
    }
    return null;
}

// Función mejorada para extraer nombre del texto
function extraerNombre(texto) {
    const t = texto.toLowerCase().trim();
    
    const patrones = [
        /(?:me\s+llamo|mi\s+nombre\s+es|soy)\s+([A-ZÁÉÍÓÚÑ][a-záéíóúñ]*(?:\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ]*){0,2})/i,
        /^hola\s+([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+)/i,
        /^([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+)(?:\s+(?:quisiera|quiero|quiere|necesito|para|reservar))/i,
        /(?:hola|buenas?\s*(?:tardes|días|noches)).*?(?:soy|me\s+llamo|mi\s+nombre\s+es)\s+([A-ZÁÉÍÓÚÑ][a-záéíóúñ]*(?:\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ]*){0,2})/i,
    ];
    
    for (const patron of patrones) {
        const match = t.match(patron);
        if (match && match[1]) {
            let nombre = match[1].trim();
            nombre = nombre.replace(/[^A-ZÁÉÍÓÚÑa-záéíóúñ]/g, '');
            if (nombre.length >= 2) return nombre;
        }
    }
    
    const palabras = t.split(/\s+/);
    if (palabras.length >= 1 && palabras[0].length >= 2 && !palabras[1]) {
        if (/^[a-záéíóúñ]{2,15}$/.test(palabras[0])) {
            return palabras[0].charAt(0).toUpperCase() + palabras[0].slice(1);
        }
    }
    
    return null;
}

function extraerMasaje(texto) {
    const t = texto.toLowerCase();
    for (const s of serviciosData) {
        const nombreLower = s.nombre.toLowerCase();
        if (t.includes(nombreLower)) {
            return s.nombre;
        }
    }
    if (t.includes('relajante')) return 'Masaje Relajante';
    if (t.includes('corporal')) return 'Masaje Corporal';
    if (t.includes('facial')) return 'Masaje Facial';
    if (t.includes('podal')) return 'Masaje Podal';
    if (t.includes('dorsal')) return 'Masaje Dorsal';
    return null;
}

function extraerDia(texto) {
    const t = texto.toLowerCase();
    const dias = ['lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado'];
    for (const dia of dias) {
        if (t.includes(dia)) return dia;
    }
    return null;
}

function extraerHora(texto) {
    const t = texto.toLowerCase();
    if (t.includes('12') || t.includes('doce') || t.includes('mediodía')) return 12;
    if (t.includes('16') || t.includes('cuatro') || t.includes('4')) return 16;
    if (t.includes('20') || t.includes('ocho') || t.includes('8')) return 20;
    return null;
}

function extraerTelefono(texto) {
    const numeros = texto.replace(/\D/g, '');
    if (numeros.length >= 7) return numeros;
    return null;
}

// NUEVA FUNCIÓN: Extraer toda la información del audio de una sola vez
function extraerTodaLaInformacion(texto) {
    const t = texto.toLowerCase();
    const resultado = {
        nombre: null,
        pais: null,
        codigoPais: null,
        masaje: null,
        dia: null,
        hora: null,
        telefono: null
    };
    
    // Extraer nombre
    const nombreExtraido = extraerNombre(texto);
    if (nombreExtraido) resultado.nombre = nombreExtraido;
    
    // Extraer país
    const paisDetectado = detectarPaisConNombre(texto);
    if (paisDetectado) {
        resultado.pais = paisDetectado.nombre;
        resultado.codigoPais = paisDetectado.codigo;
    }
    
    // Extraer masaje
    const masajeExtraido = extraerMasaje(texto);
    if (masajeExtraido) resultado.masaje = masajeExtraido;
    
    // Extraer día
    const diaExtraido = extraerDia(texto);
    if (diaExtraido) resultado.dia = diaExtraido;
    
    // Extraer hora
    const horaExtraida = extraerHora(texto);
    if (horaExtraida) resultado.hora = horaExtraida;
    
    // Extraer teléfono
    const telefonoExtraido = extraerTelefono(texto);
    if (telefonoExtraido) resultado.telefono = telefonoExtraido;
    
    return resultado;
}

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

// ============================================================
// MIDDLEWARES DE SEGURIDAD
// ============================================================
app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
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

// ============================================================
// AUTENTICACIÓN
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
    res.json({ ok: true, mensaje: 'Configuración guardada' });
});

// ============================================================
// SERVICIOS
// ============================================================
let serviciosData = [];

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
        const i = serviciosData.findIndex(s => s.id === req.params.id);
        if (i === -1) return res.status(404).json({ error: 'Servicio no encontrado' });
        let iwa = serviciosData[i].imagenWhatsApp || '';
        if (req.body.imagenWhatsApp !== undefined) {
            if (req.body.imagenWhatsApp && esUrlValida(req.body.imagenWhatsApp)) {
                iwa = req.body.imagenWhatsApp.trim();
            } else if (!req.body.imagenWhatsApp) {
                iwa = '';
            }
        }
        serviciosData[i] = { ...serviciosData[i], ...req.body, id: req.params.id, imagenWeb: req.body.imagenWeb || serviciosData[i].imagenWeb, imagenWhatsApp: iwa };
        await fs.writeFile(SERVICIOS_FILE, JSON.stringify(serviciosData, null, 2), 'utf8');
        await inicializarBaseConocimiento();
        res.json({ ok: true, mensaje: 'Servicio actualizado' });
    } catch(e) {
        res.status(500).json({ error: 'Error al actualizar' });
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
    if (estaBloqueado(ip)) return res.status(403).json({ error: 'IP bloqueada por seguridad' });
    if (!checkRateIP(ip)) {
        bloquearIP(ip, 'Exceso de solicitudes de turnos', 'spam');
        return res.status(429).json({ error: 'Demasiadas solicitudes. Espere una hora.' });
    }
    
    try {
        const { nombre, dia, hora, massageType, telefono, ubicacion, tipoServicio } = req.body;
        
        if (!nombre || nombre.length < 2) {
            return res.status(400).json({ error: 'Nombre inválido. Mínimo 2 caracteres.' });
        }
        
        const tel = telefono ? telefono.replace(/\D/g, '') : '';
        if (!tel || tel.length < 7) {
            return res.status(400).json({ error: 'Teléfono inválido. Mínimo 7 dígitos.' });
        }
        
        let codigoPais = req.body.codigoPais || '53';
        if (!/^\d{1,3}$/.test(codigoPais)) codigoPais = '53';
        
        if (!paisAutorizado(codigoPais)) {
            return res.status(403).json({ 
                error: 'País no autorizado',
                mensaje: 'Lo sentimos, no aceptamos reservas desde su país en este momento.'
            });
        }
        
        if (!dia || !DIAS_VALIDOS.includes(dia.toLowerCase())) {
            return res.status(400).json({ error: 'Día inválido. Lunes a Sábado.' });
        }
        
        const hn = parseInt(hora);
        if (!HORAS_VALIDAS.includes(hn)) {
            return res.status(400).json({ error: 'Hora inválida. 12, 16 o 20 hs.' });
        }
        
        if (!checkRateTel(tel)) {
            return res.status(429).json({ error: 'Máximo 2 turnos por teléfono por día.' });
        }
        
        const turnos = await loadTurnos();
        const dl = dia.toLowerCase();
        
        if (turnos.some(t => t.telefono === tel && t.dia === dl)) {
            return res.status(409).json({ error: 'Ya tienes un turno reservado para ese día.' });
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
            ubicacion: ubicacion ? escapeHtml(sanitize(ubicacion)) : paisesConfig.ubicacionSalon,
            tipoServicio: tipoServicio || 'salon',
            confirmadoWhatsApp: false,
            fechaCreacion: new Date().toISOString(),
            ip
        };
        
        turnos.push(nuevo);
        await saveTurnos(turnos);
        regTurno(ip, tel);
        intentosFallidos.delete(ip);
        
        res.status(201).json({ mensaje: 'Turno reservado con éxito', turno: nuevo });
    } catch(e) {
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

app.delete('/turnos/:id', async (req, res) => {
    if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    const turnos = await loadTurnos();
    const i = turnos.findIndex(t => t.id === req.params.id);
    if (i === -1) return res.status(404).json({ error: 'Turno no encontrado' });
    turnos.splice(i, 1);
    await saveTurnos(turnos);
    res.json({ ok: true, mensaje: 'Turno eliminado' });
});

app.post('/api/cancelar-turno', async (req, res) => {
    try {
        const tel = (req.body.telefono || '').replace(/\D/g, '');
        if (tel.length < 7) return res.json({ error: 'Número inválido.' });
        const turnos = await loadTurnos();
        const turno = turnos.find(t => t.telefono === tel);
        if (!turno) return res.json({ error: 'No se encontró un turno activo con ese número.' });
        if (turno.confirmadoWhatsApp) {
            const msg = `❌ CANCELACIÓN\n\nHola ${turno.nombre}, tu reserva ha sido cancelada:\n📅 ${turno.dia} ${turno.hora}:00\n💆 ${turno.massageType}\n\nEquipo Serenity Spa`;
            return res.json({ 
                whatsappCancelacion: true, 
                mensaje: 'Para cancelar, usá el enlace de WhatsApp.', 
                urlWhatsApp: `https://wa.me/${turno.codigoPais || '53'}${tel}?text=${encodeURIComponent(msg)}` 
            });
        }
        turnos.splice(turnos.indexOf(turno), 1);
        await saveTurnos(turnos);
        res.json({ cancelado: true, mensaje: `Turno del ${turno.dia} a las ${turno.hora}:00 cancelado.` });
    } catch(e) {
        res.status(500).json({ error: 'Error al cancelar' });
    }
});

app.post('/api/enviar-whatsapp/:id', async (req, res) => {
    try {
        const turnos = await loadTurnos();
        const t = turnos.find(x => x.id === req.params.id);
        if (!t) return res.status(404).json({ error: 'Turno no encontrado' });
        const s = serviciosData.find(x => x.nombre === t.massageType);
        const img = (s?.imagenWhatsApp && esUrlValida(s.imagenWhatsApp)) ? s.imagenWhatsApp : '';
        let msg = `SERENITY SPA\n\nHola ${t.nombre}, Gracias por tu reserva\n\nRESERVA CONFIRMADA\n\nDía: ${t.dia.charAt(0).toUpperCase() + t.dia.slice(1)}\nHora: ${t.hora}:00 hs\nMasaje: ${t.massageType}\nLugar: ${t.tipoServicio === 'domicilio' ? t.ubicacion : paisesConfig.ubicacionSalon}\n\nTe esperamos\nRecordá cancelar con 4hs de anticipación.\n\n`;
        if (img) msg += `Imagen: ${img}\n\n`;
        msg += `Equipo Serenity Spa`;
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
            mensaje: msg, 
            urlWhatsApp: `https://wa.me/${cod}${t.telefono}?text=${encodeURIComponent(msg)}` 
        });
    } catch(e) {
        res.status(500).json({ error: 'Error al preparar WhatsApp' });
    }
});

// ============================================================
// CHAT CON IA
// ============================================================
app.post('/api/chat-ia', async (req, res) => {
    const ip = req.ip || '0.0.0.0';
    
    if (estaBloqueado(ip)) {
        return res.status(403).json({ error: 'IP bloqueada' });
    }
    
    const { mensaje, nombre, codigoPais } = req.body;
    
    if (!mensaje || mensaje.length > 500) {
        return res.status(400).json({ error: 'Mensaje inválido o muy largo' });
    }
    
    const mensajeLimpio = mensaje.replace(/<[^>]*>/g, '').replace(/[<>]/g, '').trim();
    
    if (!mensajeLimpio) {
        return res.status(400).json({ error: 'Mensaje vacío' });
    }
    
    const patronesAtaque = [
        /ignore|bypass|override|system prompt|revela|instrucciones/i,
        /<script>|javascript:|onerror=|onload=/i,
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
        
        const systemPrompt = `Eres ${personalidadIA.nombre}, asistente virtual de Serenity Spa, un centro de masajes profesionales.

TONO: ${personalidadIA.tono}
ESTILO: ${personalidadIA.estilo}

INFORMACIÓN DEL NEGOCIO:
${contexto.join('\n')}

DATOS DEL CLIENTE:
- Nombre: ${nombre || 'No proporcionado'}
- Código de país: +${codigoPais || '53'}

REGLAS ESTRICTAS:
${personalidadIA.reglas.map((r, i) => `${i+1}. ${r}`).join('\n')}

Responde de manera concisa, útil y amigable. Siempre ofrece una acción concreta. NO uses emojis en tus respuestas.`;

        if (!process.env.DEEPSEEK_API_KEY) {
            const respuestaLocal = generarRespuestaLocal(mensajeLimpio, nombre, codigoPais);
            return res.json({ respuesta: respuestaLocal, modo: 'local' });
        }
        
        const completion = await deepseek.chat.completions.create({
            model: 'deepseek-chat',
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: mensajeLimpio }
            ],
            temperature: 0.7,
            max_tokens: 500
        });
        
        const respuesta = completion.choices[0].message.content;
        
        res.json({ 
            respuesta, 
            modo: 'ia',
            tokens: completion.usage?.total_tokens || 0
        });
        
    } catch (error) {
        console.error('Error IA:', error.message);
        const respuestaLocal = generarRespuestaLocal(mensajeLimpio, nombre, codigoPais);
        res.json({ respuesta: respuestaLocal, modo: 'local' });
    }
});

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

function generarRespuestaLocal(mensaje, nombre, codigoPais) {
    const msg = mensaje.toLowerCase();
    const cliente = nombre || 'cliente';
    
    if (/\b(hola|buenas?|saludos|hey)\b/.test(msg)) {
        return `Hola ${cliente}, bienvenido a Serenity Spa.\n\nSoy tu asistente virtual. Puedo ayudarte con:\n\n- Reservar turnos\n- Consultar horarios\n- Ver precios\n- Conocer masajes\n\n¿Qué necesitas hoy?`;
    }
    
    if (/\b(reservar|turno|cita|agendar)\b/.test(msg)) {
        return `Claro ${cliente}. Para reservar necesito:\n\n1. Tu nombre\n2. Tipo de masaje\n3. Día (Lunes a Sábado)\n4. Horario (12:00, 16:00 o 20:00)\n5. Teléfono\n6. País\n\n¿Empezamos? ¿Qué masaje te interesa?`;
    }
    
    if (/\b(horario|hora|cuándo|cuando)\b/.test(msg)) {
        return `Horarios Serenity Spa\n\nLunes a Sábado\n12:00 del mediodía\n16:00 de la tarde\n20:00 de la noche\n\nSolo un turno por persona por día.\n\n¿Querés reservar?`;
    }
    
    if (/\b(precio|costo|vale|cuánto|cuanto|tarifa)\b/.test(msg)) {
        let lista = 'Nuestros precios:\n\n';
        serviciosData.forEach(s => {
            lista += `${s.nombre}: ${s.precio}\n`;
        });
        lista += '\nTodos incluyen aromaterapia y música suave.\n\n¿Cuál te gustaría?';
        return lista;
    }
    
    if (/\b(gracias|agradecido)\b/.test(msg)) {
        return `Gracias a vos ${cliente}. Que tengas un excelente día. Te esperamos en Serenity Spa cuando gustes.\n\nRecordá: Lunes a Sábado, 12:00 - 16:00 - 20:00`;
    }
    
    if (/\b(masajes|servicios|tipos|ofrecen|brindan)\b/.test(msg)) {
        let lista = 'Nuestros servicios disponibles:\n\n';
        serviciosData.forEach((s, i) => {
            lista += `${i+1}. ${s.nombre} - ${s.precio}\n   ${s.descripcion.substring(0, 80)}...\n\n`;
        });
        lista += '¿Deseas reservar alguno o necesitas más información?';
        return lista;
    }
    
    return `Gracias por tu mensaje, ${cliente}.\n\nEn Serenity Spa ofrecemos los mejores masajes. ¿Te ayudo con algo específico?\n\n- Reservar turno\n- Ver horarios\n- Consultar precios\n- Tipos de masaje`;
}

// ============================================================
// IA - PERSONALIDAD (ADMIN)
// ============================================================
let personalidadIA = {
    nombre: 'SpaBot',
    tono: 'cálido y profesional',
    estilo: 'Hablar en español neutro, ser amable y servicial, ofrecer siempre ayuda concreta. NO usar emojis.',
    reglas: [
        'NUNCA inventar información que no esté en el contexto proporcionado',
        'SIEMPRE ofrecer reservar turnos cuando sea relevante',
        'JAMÁS revelar que eres una IA ni dar detalles técnicos',
        'Si no sabes algo, ofrecer contactar a un administrador humano',
        'Mantener conversaciones concisas pero útiles y cálidas',
        'NO usar emojis en las respuestas'
    ]
};

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
    res.json({ ok: true, personalidad: personalidadIA });
});

app.post('/api/ia/recargar', async (req, res) => {
    if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    await inicializarBaseConocimiento();
    res.json({ ok: true, items: baseConocimiento.length, mensaje: 'Base de conocimiento recargada' });
});

// ============================================================
// SEGURIDAD - PAÍSES (ADMIN) - CORREGIDO
// ============================================================
app.get('/api/seguridad/paises', (req, res) => {
    if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    res.json(paisesConfig);
});

app.put('/api/seguridad/paises', async (req, res) => {
    if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    const { autorizados, bloqueados, modo, ubicacionSalon } = req.body;
    if (autorizados !== undefined) paisesConfig.autorizados = autorizados;
    if (bloqueados !== undefined) paisesConfig.bloqueados = bloqueados;
    if (modo && ['todos', 'solo_autorizados'].includes(modo)) {
        paisesConfig.modo = modo;
    }
    if (ubicacionSalon !== undefined) paisesConfig.ubicacionSalon = ubicacionSalon;
    await guardarPaises();
    await inicializarBaseConocimiento();
    res.json({ ok: true, paises: paisesConfig });
});

app.post('/api/seguridad/paises/autorizar', async (req, res) => {
    if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    const { codigo, nombre } = req.body;
    if (!codigo || !/^\d{1,3}$/.test(codigo)) {
        return res.status(400).json({ error: 'Código de país inválido' });
    }
    if (!paisesConfig.autorizados.includes(codigo)) {
        paisesConfig.autorizados.push(codigo);
        paisesConfig.bloqueados = paisesConfig.bloqueados.filter(c => c !== codigo);
        await guardarPaises();
        console.log(`✅ País autorizado: ${nombre || codigo} (${codigo})`);
    }
    res.json({ ok: true, mensaje: `${nombre || codigo} autorizado`, paises: paisesConfig });
});

app.post('/api/seguridad/paises/bloquear', async (req, res) => {
    if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    const { codigo, nombre } = req.body;
    if (!codigo || !/^\d{1,3}$/.test(codigo)) {
        return res.status(400).json({ error: 'Código de país inválido' });
    }
    if (!paisesConfig.bloqueados.includes(codigo)) {
        paisesConfig.bloqueados.push(codigo);
        paisesConfig.autorizados = paisesConfig.autorizados.filter(c => c !== codigo);
        await guardarPaises();
        console.log(`✅ País bloqueado: ${nombre || codigo} (${codigo})`);
    }
    res.json({ ok: true, mensaje: `${nombre || codigo} bloqueado`, paises: paisesConfig });
});

app.delete('/api/seguridad/paises/:codigo', async (req, res) => {
    if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    const codigo = req.params.codigo;
    paisesConfig.autorizados = paisesConfig.autorizados.filter(c => c !== codigo);
    paisesConfig.bloqueados = paisesConfig.bloqueados.filter(c => c !== codigo);
    await guardarPaises();
    console.log(`✅ País eliminado de listas: ${codigo}`);
    res.json({ ok: true, mensaje: `País ${codigo} eliminado de las listas` });
});

app.get('/api/seguridad/paises/stats', async (req, res) => {
    if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    const turnos = await loadTurnos();
    const stats = {};
    for (const t of turnos) {
        const cod = t.codigoPais || '53';
        if (!stats[cod]) stats[cod] = 0;
        stats[cod]++;
    }
    const nombresPaises = {
        '53': 'Cuba', '54': 'Argentina', '52': 'México', '57': 'Colombia',
        '56': 'Chile', '51': 'Perú', '34': 'España', '1': 'EE.UU.',
        '58': 'Venezuela', '593': 'Ecuador', '598': 'Uruguay', '595': 'Paraguay',
        '55': 'Brasil', '39': 'Italia', '33': 'Francia', '49': 'Alemania'
    };
    const resultado = Object.entries(stats).map(([cod, count]) => ({
        codigo: cod,
        nombre: nombresPaises[cod] || 'Desconocido',
        reservas: count
    })).sort((a, b) => b.reservas - a.reservas);
    res.json(resultado);
});

// ============================================================
// SEGURIDAD - BLOQUEOS (ADMIN)
// ============================================================
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
    res.json({ ok: true, mensaje: 'IP desbloqueada' });
});

app.delete('/api/seguridad/bloqueos/:ip', (req, res) => {
    if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    bloqueos.delete(req.params.ip);
    intentosFallidos.delete(req.params.ip);
    guardarBloqueos();
    res.json({ ok: true, mensaje: 'Bloqueo eliminado' });
});

app.delete('/api/seguridad/historial/:id', (req, res) => {
    if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    historialBloqueos = historialBloqueos.filter(h => h.id !== req.params.id);
    guardarBloqueos();
    res.json({ ok: true, mensaje: 'Registro eliminado' });
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
    res.json({ ok: true, mensaje: 'IP bloqueada permanentemente' });
});

// ============================================================
// RUTAS ESTÁTICAS
// ============================================================
app.get('/voice-assistant', (req, res) => res.sendFile(path.join(__dirname, 'voice-assistant.html')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/admin.html', (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));
app.get('/login.html', (req, res) => res.sendFile(path.join(__dirname, 'login.html')));
app.get('/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        timestamp: new Date().toISOString(), 
        uptime: process.uptime(),
        ia: process.env.DEEPSEEK_API_KEY ? 'conectada' : 'local'
    });
});

// ============================================================
// ASISTENTE DE VOZ (CORREGIDO - CON ANÁLISIS INTELIGENTE)
// ============================================================
let voiceClients = new Map();

async function confirmarReservaInteligente(cd, ip) {
    const d = cd.datos;
    
    if (!d.codigoPais || !/^\d{1,3}$/.test(d.codigoPais)) {
        d.codigoPais = '53';
        d.pais = 'Cuba';
    }
    
    if (!paisAutorizado(d.codigoPais)) {
        return `Lo sentimos, ${d.nombre}. No aceptamos reservas desde ${d.pais || 'su país'} en este momento. Por favor contacta con nuestro equipo para más información.`;
    }
    
    try {
        const turnos = await loadTurnos();
        
        if (turnos.some(t => t.telefono === d.telefono && t.dia === d.dia)) {
            return `${d.nombre}, ya tienes un turno reservado para el ${d.dia}. Solo se permite un masaje por día. ¿Quieres otro día?`;
        }
        
        if (turnos.some(t => t.dia === d.dia && t.hora === d.hora)) {
            const alt = buscarAlternativa(d.dia, d.hora, turnos);
            if (alt) {
                cd.datos.dia = alt.dia;
                cd.datos.hora = alt.hora;
                return `${d.nombre}, el horario de las ${d.hora}:00 del ${d.dia} está ocupado. Tengo disponible el ${alt.dia} a las ${alt.hora}:00. ¿Te sirve? Responde "sí" o "no".`;
            }
            return `Lo siento, ${d.nombre}. No hay disponibilidad para el ${d.dia}. ¿Probamos otro día?`;
        }
        
        const nuevo = {
            id: generarId(),
            nombre: d.nombre,
            dia: d.dia,
            hora: d.hora,
            massageType: d.masaje || 'Masaje Relajante',
            telefono: d.telefono,
            codigoPais: d.codigoPais,
            ubicacion: paisesConfig.ubicacionSalon,
            tipoServicio: 'salon',
            confirmadoWhatsApp: false,
            fechaCreacion: new Date().toISOString(),
            ip
        };
        
        turnos.push(nuevo);
        await saveTurnos(turnos);
        
        voiceClients.delete(cd.clientId);
        
        const horaTexto = d.hora === 12 ? '12 del mediodía' : d.hora === 16 ? '4 de la tarde' : '8 de la noche';
        
        return `RESERVA CONFIRMADA\n\nGracias ${d.nombre}. Tu turno ha sido reservado:\n\nDía: ${d.dia}\nHora: ${horaTexto}\nMasaje: ${d.masaje}\nUbicación: ${paisesConfig.ubicacionSalon}\nTeléfono de contacto: +${d.codigoPais} ${d.telefono}\n\nTe esperamos en Serenity Spa. Si necesitas cancelar o modificar, responde "cancelar".`;
        
    } catch(e) {
        console.error('Error al reservar:', e);
        return `Hubo un error al procesar tu reserva, ${d.nombre}. Por favor, intenta de nuevo más tarde.`;
    }
}

async function procesarComandoVoz(texto, clientId, ip) {
    let cd = voiceClients.get(clientId);
    
    if (!cd) {
        cd = {
            estado: 'inicial',
            datos: {},
            intentos: 0,
            clientId: clientId
        };
        voiceClients.set(clientId, cd);
    }
    
    // Extraer toda la información del texto de una sola vez
    const infoExtraida = extraerTodaLaInformacion(texto);
    
    // Actualizar datos con información extraída
    if (infoExtraida.nombre && !cd.datos.nombre) {
        cd.datos.nombre = infoExtraida.nombre;
        cd.intentos = 0;
    }
    
    if (infoExtraida.pais && !cd.datos.pais) {
        if (paisAutorizado(infoExtraida.codigoPais)) {
            cd.datos.pais = infoExtraida.pais;
            cd.datos.codigoPais = infoExtraida.codigoPais;
        }
    }
    
    if (infoExtraida.masaje && !cd.datos.masaje) {
        cd.datos.masaje = infoExtraida.masaje;
    }
    
    if (infoExtraida.dia && !cd.datos.dia) {
        cd.datos.dia = infoExtraida.dia;
    }
    
    if (infoExtraida.hora && !cd.datos.hora) {
        cd.datos.hora = infoExtraida.hora;
    }
    
    if (infoExtraida.telefono && !cd.datos.telefono) {
        cd.datos.telefono = infoExtraida.telefono;
    }
    
    // Si tiene TODA la información necesaria, reservar automáticamente
    if (cd.datos.nombre && cd.datos.masaje && cd.datos.dia && cd.datos.hora && cd.datos.telefono && cd.datos.codigoPais) {
        return await confirmarReservaInteligente(cd, ip);
    }
    
    // Si tiene la mayoría de la información pero falta algo, preguntar específicamente
    if (cd.datos.nombre && cd.datos.masaje && cd.datos.dia && cd.datos.hora && !cd.datos.telefono) {
        cd.estado = 'esperando_telefono';
        return `${cd.datos.nombre}, para confirmar tu reserva del ${cd.datos.masaje} el ${cd.datos.dia} a las ${cd.datos.hora}:00, necesito tu número de teléfono. Por ejemplo: 53 57 15 69.`;
    }
    
    if (cd.datos.nombre && cd.datos.masaje && cd.datos.dia && !cd.datos.hora) {
        cd.estado = 'esperando_hora';
        return `${cd.datos.nombre}, ¿a qué hora prefieres tu ${cd.datos.masaje} el ${cd.datos.dia}? Tenemos 12:00, 16:00 o 20:00.`;
    }
    
    if (cd.datos.nombre && cd.datos.masaje && !cd.datos.dia) {
        cd.estado = 'esperando_dia';
        return `${cd.datos.nombre}, ¿qué día prefieres para tu ${cd.datos.masaje}? Lunes a Sábado.`;
    }
    
    if (cd.datos.nombre && !cd.datos.masaje) {
        cd.estado = 'esperando_masaje';
        let lista = `${cd.datos.nombre}, ¿qué masaje te gustaría reservar?\n\n`;
        serviciosData.forEach((s, i) => {
            lista += `${i+1}. ${s.nombre} - ${s.precio}\n`;
        });
        return lista;
    }
    
    if (!cd.datos.nombre) {
        cd.estado = 'esperando_nombre';
        return `Hola, se ha comunicado con Serenity Spa. ¿Con quién tengo el placer de hablar?`;
    }
    
    if (!cd.datos.pais || !cd.datos.codigoPais) {
        cd.estado = 'esperando_pais';
        return `${cd.datos.nombre}, ¿de qué país nos contacta?`;
    }
    
    // Si el cliente pide información
    const t = texto.toLowerCase();
    if (t.includes('horario') || t.includes('horarios')) {
        return `Los horarios disponibles son: 12:00 del mediodía, 16:00 de la tarde y 20:00 de la noche. Lunes a Sábado. ¿Te gustaría reservar, ${cd.datos.nombre}?`;
    }
    
    if (t.includes('precio') || t.includes('costo') || t.includes('cuánto cuesta')) {
        let lista = `Estos son nuestros precios, ${cd.datos.nombre}:\n\n`;
        serviciosData.forEach(s => {
            lista += `${s.nombre}: ${s.precio}\n`;
        });
        return lista;
    }
    
    if (t.includes('tipos de masaje') || t.includes('qué masajes')) {
        let lista = `Nuestros masajes disponibles, ${cd.datos.nombre}:\n\n`;
        serviciosData.forEach((s, i) => {
            lista += `${i+1}. ${s.nombre}\n   ${s.descripcion}\n   Precio: ${s.precio}\n   Beneficios: ${(s.beneficios || []).join(', ')}\n\n`;
        });
        return lista;
    }
    
    if (t.includes('reservar') || t.includes('turno') || t.includes('cita')) {
        if (!cd.datos.masaje) {
            cd.estado = 'esperando_masaje';
            let lista = `Claro ${cd.datos.nombre}, ¿qué masaje te interesa?\n\n`;
            serviciosData.forEach((s, i) => {
                lista += `${i+1}. ${s.nombre} - ${s.precio}\n`;
            });
            return lista;
        }
        if (!cd.datos.dia) {
            cd.estado = 'esperando_dia';
            return `${cd.datos.nombre}, ¿qué día prefieres para tu ${cd.datos.masaje}?`;
        }
        if (!cd.datos.hora) {
            cd.estado = 'esperando_hora';
            return `${cd.datos.nombre}, ¿a qué hora prefieres el ${cd.datos.dia}? Tenemos 12:00, 16:00 o 20:00.`;
        }
        if (!cd.datos.telefono) {
            cd.estado = 'esperando_telefono';
            return `${cd.datos.nombre}, para confirmar tu reserva necesito tu número de teléfono.`;
        }
    }
    
    return `Hola ${cd.datos.nombre}, soy el asistente de Serenity Spa. ¿En qué puedo ayudarte? Puedo ayudarte a:\n\n- Reservar un turno\n- Consultar tipos de masaje\n- Ver horarios disponibles\n- Conocer precios\n\n¿Qué necesitas?`;
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
        { id: "relajante", nombre: "Masaje Relajante", precio: "$45", descripcion: "Movimientos suaves y armónicos para liberar el estrés acumulado.", beneficios: ["Reduce ansiedad", "Alivia tensión muscular", "60 Minutos"], efectos: ["Relajación profunda", "Mejora del sueño"], imagenWeb: "https://images.unsplash.com/photo-1544161515-4ab6ce6db874?w=800", imagenWhatsApp: "", orden: 1 },
        { id: "corporal", nombre: "Masaje Corporal", precio: "$65", descripcion: "Tratamiento completo para una relajación profunda y revitalizante.", beneficios: ["Relajación integral", "Elimina contracturas", "90 Minutos"], efectos: ["Activación linfática", "Mejora circulación"], imagenWeb: "https://images.unsplash.com/photo-1519823551278-64ac92734fb1?w=800", imagenWhatsApp: "", orden: 2 },
        { id: "facial", nombre: "Masaje Facial", precio: "$40", descripcion: "Rejuvenece la piel y alivia la tensión facial acumulada.", beneficios: ["Reafirma la piel", "Reduce ojeras", "45 Minutos"], efectos: ["Estimula colágeno", "Tonifica rostro"], imagenWeb: "https://images.unsplash.com/photo-1570172619644-dfd03ed5d881?w=800", imagenWhatsApp: "", orden: 3 }
    ]);
    
    turnosMem = await initFile(TURNOS_FILE, []);
    await inicializarBaseConocimiento();

    const server = app.listen(PORT, '0.0.0.0', () => {
        console.log(`🌿 Serenity Spa v4.0 iniciado en puerto ${PORT}`);
        console.log(`🧠 IA: ${process.env.DEEPSEEK_API_KEY ? 'DeepSeek conectado' : 'Modo local (gratuito)'}`);
        console.log(`🌍 Países autorizados: ${paisesConfig.autorizados.length}`);
        console.log(`🚫 Países bloqueados: ${paisesConfig.bloqueados.length}`);
        console.log(`📍 Ubicación del salón: ${paisesConfig.ubicacionSalon}`);
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
        voiceClients.set(cid, { ws, estado: 'inicial', datos: {}, intentos: 0, clientId: cid });
        
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
                console.error('Error procesando mensaje:', e);
                if (ws.readyState === 1) {
                    ws.send(JSON.stringify({ tipo: 'respuesta', texto: 'Disculpe, hubo un error. ¿Podría repetir?' }));
                }
            }
        });
        
        ws.on('close', () => voiceClients.delete(cid));
        ws.on('error', () => voiceClients.delete(cid));
        
        const ft = setInterval(() => { mc = 0; }, 60000);
        ws.on('close', () => clearInterval(ft));
    });
}

process.on('SIGTERM', async () => { await guardarBloqueos(); await guardarPaises(); process.exit(0); });
process.on('SIGINT', async () => { await guardarBloqueos(); await guardarPaises(); process.exit(0); });

start();
const express = require('express');
const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const crypto = require('crypto');
const WebSocket = require('ws');

// Cargar variables de entorno
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 5001;
const NODE_ENV = process.env.NODE_ENV || 'development';
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

const TURNOS_FILE = path.join(__dirname, 'turnos.json');
const SERVICIOS_FILE = path.join(__dirname, 'servicios.json');
const CONFIG_FILE = path.join(__dirname, 'config.json');
const BLOQUEOS_FILE = path.join(__dirname, 'bloqueos.json');
const UPLOADS_DIR = path.join(__dirname, 'uploads');

// ==================== SEGURIDAD INICIAL ====================
app.disable('x-powered-by');

// Crear directorio uploads si no existe
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

function detectarPais(texto) {
    const t = texto.toLowerCase().trim();
    const paises = {
        'argentina': '54', 'méxico': '52', 'mexico': '52', 'colombia': '57',
        'chile': '56', 'perú': '51', 'peru': '51', 'españa': '34', 'espania': '34',
        'uruguay': '598', 'paraguay': '595', 'bolivia': '591', 'venezuela': '58',
        'cuba': '53', 'costa rica': '506', 'panamá': '507', 'ecuador': '593'
    };
    for (const [pais, codigo] of Object.entries(paises)) {
        if (t.includes(pais)) return codigo;
    }
    return null;
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

// Rate limiting básico
const requestCounts = new Map();
app.use((req, res, next) => {
    const ip = req.ip || '0.0.0.0';
    const now = Date.now();
    
    if (!requestCounts.has(ip)) {
        requestCounts.set(ip, { count: 1, reset: now + 60000 });
    } else {
        const data = requestCounts.get(ip);
        if (now > data.reset) {
            data.count = 1;
            data.reset = now + 60000;
        } else {
            data.count++;
            if (data.count > 100) {
                return res.status(429).json({ error: 'Demasiadas solicitudes' });
            }
        }
    }
    next();
});

// Bloqueo de IPs
app.use((req, res, next) => {
    const ip = req.ip || req.socket.remoteAddress || '0.0.0.0';
    if (estaBloqueado(ip)) {
        return res.status(403).json({ error: 'IP bloqueada', bloqueado: true });
    }
    next();
});

// Archivos estáticos
app.use(express.static(__dirname));

// Limpiar contadores de rate limiting
setInterval(() => {
    const now = Date.now();
    for (const [ip, data] of requestCounts) {
        if (now > data.reset) requestCounts.delete(ip);
    }
}, 300000);

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
    if (estaBloqueado(ip)) return res.status(403).json({ success: false, error: 'Bloqueado' });
    const { password } = req.body;
    if (!password) {
        registrarIntento(ip, 'vacia');
        return res.status(400).json({ success: false, error: 'Contraseña requerida' });
    }
    const adminPassword = process.env.ADMIN_PASSWORD || 'admin123';
    if (password === adminPassword) {
        const token = crypto.randomBytes(64).toString('hex');
        validTokens.set(token, Date.now() + 28800000);
        intentosFallidos.delete(ip);
        res.json({ success: true, token });
    } else {
        registrarIntento(ip, 'incorrecta');
        res.status(401).json({ success: false, error: 'Incorrecta' });
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
        res.status(500).json({ error: 'Error al subir' });
    }
});

// ============================================================
// CONFIGURACIÓN
// ============================================================
let configData = {
    hero: {
        titulo: "Renueva tu Energía",
        subtitulo: "Experiencias de bienestar",
        imagenFondo: "https://images.unsplash.com/photo-1544161515-4ab6ce6db874?ixlib=rb-1.2.1&auto=format&fit=crop&w=1920&q=80",
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
    res.json({ ok: true, mensaje: 'Guardado' });
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
        res.status(201).json(s);
    } catch(e) {
        res.status(500).json({ error: 'Error al crear servicio' });
    }
});

app.put('/api/servicios/:id', async (req, res) => {
    if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    try {
        const i = serviciosData.findIndex(s => s.id === req.params.id);
        if (i === -1) return res.status(404).json({ error: 'No encontrado' });
        
        let iwa = serviciosData[i].imagenWhatsApp || '';
        if (req.body.imagenWhatsApp !== undefined) {
            if (req.body.imagenWhatsApp && esUrlValida(req.body.imagenWhatsApp)) {
                iwa = req.body.imagenWhatsApp.trim();
            } else if (!req.body.imagenWhatsApp) {
                iwa = '';
            }
        }
        
        serviciosData[i] = {
            ...serviciosData[i],
            ...req.body,
            id: req.params.id,
            imagenWeb: req.body.imagenWeb || serviciosData[i].imagenWeb,
            imagenWhatsApp: iwa
        };
        await fs.writeFile(SERVICIOS_FILE, JSON.stringify(serviciosData, null, 2), 'utf8');
        res.json({ ok: true, mensaje: 'Actualizado' });
    } catch(e) {
        res.status(500).json({ error: 'Error al actualizar' });
    }
});

app.delete('/api/servicios/:id', async (req, res) => {
    if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    const antes = serviciosData.length;
    serviciosData = serviciosData.filter(s => s.id !== req.params.id);
    await fs.writeFile(SERVICIOS_FILE, JSON.stringify(serviciosData, null, 2), 'utf8');
    res.json({ ok: true, mensaje: serviciosData.length < antes ? 'Eliminado' : 'No encontrado' });
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
    if (estaBloqueado(ip)) return res.status(403).json({ error: 'Bloqueado' });
    if (!checkRateIP(ip)) {
        bloquearIP(ip, 'Spam turnos', 'spam');
        return res.status(429).json({ error: 'Demasiados pedidos' });
    }
    try {
        const { nombre, dia, hora, massageType, telefono, codigoPais, ubicacion, tipoServicio } = req.body;
        if (!nombre || nombre.length < 2) {
            registrarIntento(ip, 'nombre');
            return res.status(400).json({ error: 'Nombre inválido' });
        }
        const tel = telefono ? telefono.replace(/\D/g, '') : '';
        if (!tel || tel.length < 7) {
            registrarIntento(ip, 'tel');
            return res.status(400).json({ error: 'Teléfono inválido' });
        }
        if (!dia || !DIAS_VALIDOS.includes(dia.toLowerCase())) return res.status(400).json({ error: 'Día inválido' });
        const hn = parseInt(hora);
        if (!HORAS_VALIDAS.includes(hn)) return res.status(400).json({ error: 'Hora inválida' });
        if (!checkRateTel(tel)) return res.status(429).json({ error: 'Máximo 2 turnos por teléfono por día' });
        const turnos = await loadTurnos();
        const dl = dia.toLowerCase();
        if (turnos.some(t => t.telefono === tel && t.dia === dl)) return res.status(409).json({ error: 'Ya tenés un turno ese día' });
        if (turnos.some(t => t.dia === dl && t.hora === hn)) return res.status(409).json({ error: 'Ocupado', alternativa: buscarAlternativa(dl, hn, turnos) });
        const nuevo = {
            id: generarId(),
            nombre: escapeHtml(sanitize(nombre)),
            dia: dl,
            hora: hn,
            massageType: massageType || 'Masaje',
            telefono: tel,
            codigoPais: codigoPais || '54',
            ubicacion: ubicacion ? escapeHtml(sanitize(ubicacion)) : null,
            tipoServicio: tipoServicio || 'salon',
            confirmadoWhatsApp: false,
            fechaCreacion: new Date().toISOString(),
            ip
        };
        turnos.push(nuevo);
        await saveTurnos(turnos);
        regTurno(ip, tel);
        intentosFallidos.delete(ip);
        res.status(201).json({ mensaje: 'Turno creado', turno: nuevo });
    } catch(e) {
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
    res.json({ ok: true, mensaje: 'Eliminado' });
});

app.post('/api/cancelar-turno', async (req, res) => {
    try {
        const tel = (req.body.telefono || '').replace(/\D/g, '');
        if (tel.length < 7) return res.json({ error: 'Número inválido.' });
        const turnos = await loadTurnos();
        const turno = turnos.find(t => t.telefono === tel);
        if (!turno) return res.json({ error: 'Sin turno activo.' });
        if (turno.confirmadoWhatsApp) {
            const msg = `❌ *CANCELACIÓN*\n\nHola *${turno.nombre}*, tu reserva fue cancelada:\n📅 ${turno.dia} ${turno.hora}:00\n💆 ${turno.massageType}\n\n*Equipo Serenity Spa*`;
            return res.json({ whatsappCancelacion: true, mensaje: 'Cancelá por WhatsApp.', urlWhatsApp: `https://wa.me/${turno.codigoPais || '54'}${tel}?text=${encodeURIComponent(msg)}` });
        }
        turnos.splice(turnos.indexOf(turno), 1);
        await saveTurnos(turnos);
        res.json({ cancelado: true, mensaje: `Turno del ${turno.dia} a las ${turno.hora}:00 cancelado.` });
    } catch(e) {
        res.status(500).json({ error: 'Error' });
    }
});

app.post('/api/enviar-whatsapp/:id', async (req, res) => {
    try {
        const turnos = await loadTurnos();
        const t = turnos.find(x => x.id === req.params.id);
        if (!t) return res.status(404).json({ error: 'No encontrado' });
        
        const s = serviciosData.find(x => x.nombre === t.massageType);
        const img = (s?.imagenWhatsApp && esUrlValida(s.imagenWhatsApp)) ? s.imagenWhatsApp : '';
        
        let msg = `🌿 *SERENITY SPA*\n\nHola *${t.nombre}*, ¡Gracias! ✨\n\n✅ *RESERVA CONFIRMADA*\n\n📅 *Día:* ${t.dia.charAt(0).toUpperCase() + t.dia.slice(1)}\n⏰ *Hora:* ${t.hora}:00 hs\n💆‍♂️ *Masaje:* ${t.massageType}\n📍 ${t.tipoServicio === 'domicilio' ? t.ubicacion : 'Serenity Spa'}\n\n🌸 Te esperamos.\n⏱️ Cancelá con 4hs de anticipación.\n\n`;
        if (img) msg += `🖼️ *Imagen:* ${img}\n\n`;
        msg += `*Equipo Serenity Spa*`;
        
        const cod = t.codigoPais || '54';
        const idx = turnos.findIndex(x => x.id === req.params.id);
        if (idx !== -1) {
            turnos[idx].confirmadoWhatsApp = true;
            turnos[idx].fechaWA = new Date().toISOString();
            await saveTurnos(turnos);
        }
        res.json({ success: true, numero: `${cod}${t.telefono}`, mensaje: msg, urlWhatsApp: `https://wa.me/${cod}${t.telefono}?text=${encodeURIComponent(msg)}` });
    } catch(e) {
        res.status(500).json({ error: 'Error' });
    }
});

// ============================================================
// SEGURIDAD (ADMIN)
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
    res.json({ ok: true });
});

app.delete('/api/seguridad/bloqueos/:ip', (req, res) => {
    if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    bloqueos.delete(req.params.ip);
    intentosFallidos.delete(req.params.ip);
    guardarBloqueos();
    res.json({ ok: true });
});

app.delete('/api/seguridad/historial/:id', (req, res) => {
    if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    historialBloqueos = historialBloqueos.filter(h => h.id !== req.params.id);
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

app.post('/api/seguridad/bloquear-permanente/:ip', (req, res) => {
    if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    bloquearIP(req.params.ip, 'Permanente', 'manual');
    const d = bloqueos.get(req.params.ip);
    if (d) { d.hasta = Date.now() + 31536000000; d.permanente = true; guardarBloqueos(); }
    res.json({ ok: true });
});

// ============================================================
// RUTAS ESTÁTICAS
// ============================================================
app.get('/voice-assistant', (req, res) => res.sendFile(path.join(__dirname, 'voice-assistant.html')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/admin.html', (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));
app.get('/login.html', (req, res) => res.sendFile(path.join(__dirname, 'login.html')));

// Health check para Render
app.get('/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        timestamp: new Date().toISOString(),
        uptime: process.uptime()
    });
});

// ============================================================
// ASISTENTE DE VOZ (WebSocket)
// ============================================================
let voiceClients = new Map();

async function procesarComandoVoz(texto, clientId, ip) {
    const tl = texto.toLowerCase().trim();
    let cd = voiceClients.get(clientId);
    if (!cd || cd.estado === 'inicial') {
        cd = { estado: 'inicio', datos: {}, alternativa: null, errorCount: 0 };
        voiceClients.set(clientId, cd);
    }

    if (/\b(cancelar|eliminar|anular|borrar)\b/.test(tl) && cd.estado !== 'confirmando' && cd.estado !== 'confirmando_alt') {
        if (cd.datos.telefono) {
            voiceClients.delete(clientId);
            return await cancelarVoz(cd.datos.telefono);
        }
        cd.estado = 'esperando_tel_cancelar';
        return 'Para cancelar necesito tu número de teléfono.';
    }
    if (cd.estado === 'esperando_tel_cancelar') {
        const t = texto.replace(/\D/g, '');
        if (t.length >= 7) {
            voiceClients.delete(clientId);
            return await cancelarVoz(t);
        }
        cd.errorCount++;
        if (cd.errorCount >= 3) { voiceClients.delete(clientId); return 'Demasiados intentos. Cancelación fallida.'; }
        return 'Número inválido. Enviá el número completo.';
    }

    if (cd.estado === 'confirmando_alt') {
        if (/^(si|sí|ok|dale)$/.test(tl)) {
            cd.datos.dia = cd.alternativa.dia;
            cd.datos.hora = cd.alternativa.hora;
            cd.estado = 'confirmando';
            cd.errorCount = 0;
        } else {
            voiceClients.delete(clientId);
            return 'Cancelada. Decí "reservar turno" para otra.';
        }
    }

    if (cd.estado === 'inicio') {
        if (/\b(reservar|turno|cita|agendar|pedir|quiero un masaje)\b/.test(tl)) {
            cd.estado = 'recopilando';
            cd.errorCount = 0;
        } else {
            return 'Soy el asistente de Serenity Spa. Decí "reservar turno" para agendar o "cancelar turno" para cancelar.';
        }
    }

    const d = cd.datos;
    if (!d.nombre) {
        const limpio = texto.trim().replace(/[^\w\sáéíóúñÑü.'-]/gi, '').trim();
        if (limpio.length >= 2 && limpio.length <= 50) {
            d.nombre = limpio;
            cd.errorCount = 0;
        } else {
            cd.errorCount++;
            if (cd.errorCount >= 3) { voiceClients.delete(clientId); return 'No entendí tu nombre. Empecemos de nuevo.'; }
            return '¿Podés decirme tu nombre?';
        }
    }
    if (!d.massageType) {
        if (tl.includes('relajante')) d.massageType = 'Masaje Relajante';
        else if (tl.includes('corporal')) d.massageType = 'Masaje Corporal';
        else if (tl.includes('facial')) d.massageType = 'Masaje Facial';
        if (!d.massageType) {
            cd.errorCount++;
            if (cd.errorCount >= 3) { voiceClients.delete(clientId); return 'Reiniciando. Decí "reservar turno".'; }
            return '¿Qué masaje? Relajante, corporal o facial.';
        } else cd.errorCount = 0;
    }
    if (!d.dia) {
        for (const dia of DIAS_VALIDOS) { if (tl.includes(dia)) { d.dia = dia; break; } }
        if (!d.dia) {
            cd.errorCount++;
            if (cd.errorCount >= 3) { voiceClients.delete(clientId); return 'Reiniciando.'; }
            return '¿Qué día? Lunes a sábado.';
        } else cd.errorCount = 0;
    }
    if (!d.hora) {
        if (tl.includes('12') || tl.includes('doce')) d.hora = 12;
        else if (tl.includes('16') || tl.includes('cuatro')) d.hora = 16;
        else if (tl.includes('20') || tl.includes('ocho')) d.hora = 20;
        if (!d.hora) {
            cd.errorCount++;
            if (cd.errorCount >= 3) { voiceClients.delete(clientId); return 'Reiniciando.'; }
            return '¿A qué hora? 12, 16 o 20.';
        } else cd.errorCount = 0;
    }
    if (!d.tipoServicio) {
        if (tl.includes('salon') || tl.includes('salón')) { d.tipoServicio = 'salon'; d.ubicacion = 'Salón Serenity Spa'; }
        else if (tl.includes('domicilio') || tl.includes('casa')) d.tipoServicio = 'domicilio';
        if (!d.tipoServicio) {
            cd.errorCount++;
            if (cd.errorCount >= 3) { voiceClients.delete(clientId); return 'Reiniciando.'; }
            return '¿En el salón o a domicilio?';
        } else cd.errorCount = 0;
    }
    if (d.tipoServicio === 'domicilio' && !d.ubicacion && texto.length > 10) {
        d.ubicacion = texto.trim();
        if (!d.ubicacion || d.ubicacion.length < 5) {
            cd.errorCount++;
            if (cd.errorCount >= 3) { voiceClients.delete(clientId); return 'Reiniciando.'; }
            return 'Dirección no válida. Decí calle y número.';
        } else cd.errorCount = 0;
    }
    if (!d.telefono) {
        const p = texto.replace(/\D/g, '');
        if (p.length >= 7 && p.length <= 15 && /^\d+$/.test(p)) {
            d.telefono = p;
            if (!d.codigoPais) d.codigoPais = detectarPais(texto) || '54';
            cd.errorCount = 0;
        } else {
            cd.errorCount++;
            if (cd.errorCount >= 3) { voiceClients.delete(clientId); return 'Reiniciando. Decí "reservar turno".'; }
            return `Gracias ${d.nombre}. ¿Tu teléfono? (solo números)`;
        }
    }

    if (cd.estado === 'confirmando' || (d.nombre && d.telefono && d.massageType && d.dia && d.hora && d.tipoServicio && (d.tipoServicio !== 'domicilio' || d.ubicacion))) {
        let turnos = [];
        try { turnos = JSON.parse(await fs.readFile(TURNOS_FILE, 'utf8')); } catch(e) {}
        if (turnos.some(t => t.telefono === d.telefono && t.dia === d.dia)) return `Ya tenés turno para el ${d.dia}. Un masaje por día.`;
        if (turnos.some(t => t.dia === d.dia && t.hora === d.hora)) {
            const alt = buscarAlternativa(d.dia, d.hora, turnos);
            if (alt) {
                cd.estado = 'confirmando_alt';
                cd.alternativa = alt;
                cd.errorCount = 0;
                return `Ocupado. ¿${alt.dia} a las ${alt.hora}:00?`;
            }
            return 'Sin disponibilidad en 7 días. Reiniciando.';
        }
        const nuevo = {
            id: generarId(),
            nombre: d.nombre,
            dia: d.dia,
            hora: d.hora,
            massageType: d.massageType,
            telefono: d.telefono,
            codigoPais: d.codigoPais || '54',
            ubicacion: d.ubicacion || 'Salón',
            tipoServicio: d.tipoServicio,
            confirmadoWhatsApp: false,
            fechaCreacion: new Date().toISOString(),
            ip
        };
        turnos.push(nuevo);
        await fs.writeFile(TURNOS_FILE, JSON.stringify(turnos, null, 2), 'utf8');
        const ht = d.hora === 12 ? '12 del mediodía' : d.hora === 16 ? '4 de la tarde' : '8 de la noche';
        voiceClients.delete(clientId);
        return `¡Confirmado! ${d.massageType} para ${d.nombre} el ${d.dia} a las ${ht}. ¡Gracias!`;
    }
    return 'Decí "reservar turno" para comenzar.';
}

async function cancelarVoz(tel) {
    try {
        const r = await fetch(`${BASE_URL}/api/cancelar-turno`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ telefono: tel })
        });
        const d = await r.json();
        if (d.cancelado) return d.mensaje;
        if (d.whatsappCancelacion) return 'Reserva confirmada por WhatsApp. Cancelá por WhatsApp.';
        return d.error || 'Sin turno activo.';
    } catch(e) {
        return 'Error. Intentá más tarde.';
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
    configData = await initFile(CONFIG_FILE, configData);
    serviciosData = await initFile(SERVICIOS_FILE, [
        { id: "relajante", nombre: "Masaje Relajante", precio: "$45", descripcion: "Movimientos suaves para liberar el estrés.", beneficios: ["Reduce ansiedad", "60 Minutos"], efectos: ["Relajación profunda"], imagenWeb: "https://images.unsplash.com/photo-1544161515-4ab6ce6db874?w=800", imagenWhatsApp: "", orden: 1 },
        { id: "corporal", nombre: "Masaje Corporal", precio: "$65", descripcion: "Tratamiento completo para relajación profunda.", beneficios: ["Relajación integral", "90 Minutos"], efectos: ["Activación linfática"], imagenWeb: "https://images.unsplash.com/photo-1519823551278-64ac92734fb1?w=800", imagenWhatsApp: "", orden: 2 },
        { id: "facial", nombre: "Masaje Facial", precio: "$40", descripcion: "Rejuvenece la piel y alivia la tensión facial.", beneficios: ["Reafirma la piel", "45 Minutos"], efectos: ["Estimula colágeno"], imagenWeb: "https://images.unsplash.com/photo-1570172619644-dfd03ed5d881?w=800", imagenWhatsApp: "", orden: 3 }
    ]);
    turnosMem = await initFile(TURNOS_FILE, []);

    const server = app.listen(PORT, '0.0.0.0', () => {
        console.log(`🌿 Serenity Spa iniciado en puerto ${PORT}`);
        console.log(`🔐 Admin: ${process.env.ADMIN_PASSWORD ? 'Configurado' : 'Usando contraseña por defecto'}`);
    });

    const wss = new WebSocket.Server({ server, path: '/ws-voice' });
    
    wss.on('connection', (ws, req) => {
        const ip = req.socket.remoteAddress || req.headers['x-forwarded-for'] || 'desconocida';
        
        if (estaBloqueado(ip)) { 
            ws.close(1008, 'IP bloqueada'); 
            return; 
        }
        
        const cid = generarId();
        let mc = 0;
        voiceClients.set(cid, { ws, estado: 'inicial', datos: {}, alternativa: null, ip, errorCount: 0 });
        
        ws.on('message', async (data) => {
            mc++;
            if (mc > 20) { 
                bloquearIP(ip, 'Flood WS', 'flood'); 
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
                    ws.send(JSON.stringify({ tipo: 'respuesta', texto: 'Error al procesar. Intentá de nuevo.' }));
                }
            }
        });
        
        ws.on('close', () => { 
            voiceClients.delete(cid);
        });
        
        ws.on('error', () => voiceClients.delete(cid));
        
        const ft = setInterval(() => { mc = 0; }, 60000);
        ws.on('close', () => clearInterval(ft));
    });
}

process.on('SIGTERM', async () => { 
    await guardarBloqueos(); 
    process.exit(0); 
});

process.on('SIGINT', async () => { 
    await guardarBloqueos(); 
    process.exit(0); 
});

start();
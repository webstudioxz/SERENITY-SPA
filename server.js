const express = require('express');
const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const crypto = require('crypto');
const WebSocket = require('ws');

const app = express();
const PORT = process.env.PORT || 5001;
const TURNOS_FILE = path.join(__dirname, 'turnos.json');
const SERVICIOS_FILE = path.join(__dirname, 'servicios.json');
const CONFIG_FILE = path.join(__dirname, 'config.json');
const BLOQUEOS_FILE = path.join(__dirname, 'bloqueos.json');
const UPLOADS_DIR = path.join(__dirname, 'uploads');

app.disable('x-powered-by');

if (!fsSync.existsSync(UPLOADS_DIR)) {
    fsSync.mkdirSync(UPLOADS_DIR, { recursive: true });
}

app.use('/uploads', express.static(UPLOADS_DIR));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

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

function esUrlValida(s) {
    if (!s || typeof s !== 'string') return false;
    const trimmed = s.trim();
    if (trimmed.startsWith('data:')) return false;
    if (trimmed.length > 3000) return false;
    try {
        const url = new URL(trimmed);
        return url.protocol === 'http:' || url.protocol === 'https:';
    } catch(e) { return false; }
}

function escapeHtml(s) { if (!s) return ''; return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function sanitize(s) { if (!s) return ''; return s.trim().replace(/[^\w\sáéíóúñÑü.,@\-]/gi, ''); }
function generarId() { return Date.now().toString(36) + Math.random().toString(36).substr(2) + crypto.randomBytes(4).toString('hex'); }
function fmtT(ms) { if (ms <= 0) return 'Expirado'; const s = Math.floor(ms / 1000), m = Math.floor(s / 60), h = Math.floor(m / 60); return h > 0 ? `${h}h ${m % 60}m` : m > 0 ? `${m}m ${s % 60}s` : `${s}s`; }

function detectarPaisConNombre(texto) {
    const t = texto.toLowerCase().trim();
    const paises = [
        { nombre: 'Cuba', codigo: '53', claves: ['cuba'] },
        { nombre: 'Argentina', codigo: '54', claves: ['argentina', 'arg'] },
        { nombre: 'México', codigo: '52', claves: ['méxico', 'mexico', 'mex'] },
        { nombre: 'Colombia', codigo: '57', claves: ['colombia', 'colom'] },
        { nombre: 'Chile', codigo: '56', claves: ['chile', 'chil'] },
        { nombre: 'Perú', codigo: '51', claves: ['perú', 'peru'] },
        { nombre: 'España', codigo: '34', claves: ['españa', 'espania', 'espa'] },
        { nombre: 'Uruguay', codigo: '598', claves: ['uruguay', 'uru'] },
        { nombre: 'Paraguay', codigo: '595', claves: ['paraguay', 'para'] },
        { nombre: 'Bolivia', codigo: '591', claves: ['bolivia', 'bol'] },
        { nombre: 'Venezuela', codigo: '58', claves: ['venezuela', 'vene'] },
        { nombre: 'Ecuador', codigo: '593', claves: ['ecuador', 'ecua'] },
        { nombre: 'Costa Rica', codigo: '506', claves: ['costa rica'] },
        { nombre: 'Panamá', codigo: '507', claves: ['panamá', 'panama'] },
        { nombre: 'Estados Unidos', codigo: '1', claves: ['estados unidos', 'usa', 'eeuu'] },
        { nombre: 'Puerto Rico', codigo: '1', claves: ['puerto rico'] },
        { nombre: 'República Dominicana', codigo: '1', claves: ['república dominicana', 'republica dominicana', 'dominicana'] },
        { nombre: 'Brasil', codigo: '55', claves: ['brasil', 'brazil'] },
        { nombre: 'Italia', codigo: '39', claves: ['italia', 'ital'] },
        { nombre: 'Francia', codigo: '33', claves: ['francia', 'fran'] },
    ];
    for (const pais of paises) {
        for (const clave of pais.claves) {
            if (t.includes(clave)) return pais;
        }
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

function extraerNombre(texto) {
    const t = texto.trim();
    const patrones = [
        /(?:me\s+llamo|me\s+llaman)\s+([A-ZÁÉÍÓÚÑ][a-záéíóúñ]{1,20}(?:\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ]{1,20})?)/i,
        /(?:mi\s+nombre\s+es)\s+([A-ZÁÉÍÓÚÑ][a-záéíóúñ]{1,20}(?:\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ]{1,20})?)/i,
        /(?:soy|yo\s+soy)\s+([A-ZÁÉÍÓÚÑ][a-záéíóúñ]{1,20}(?:\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ]{1,20})?)/i,
        /(?:hola|buenas?|saludos?)\s+(?:soy\s+)?([A-ZÁÉÍÓÚÑ][a-záéíóúñ]{1,20})/i,
    ];
    const noNombres = ['hola', 'buenas', 'buenos', 'dias', 'días', 'tardes', 'noches', 'quiero', 'necesito', 'reservar', 'turno', 'masaje', 'gracias', 'señor', 'señora', 'señorita', 'doctor', 'doctora', 'cuba', 'argentina', 'mexico', 'méxico', 'españa', 'chile', 'perú', 'peru'];
    
    for (const patron of patrones) {
        const match = t.match(patron);
        if (match && match[1]) {
            const nombre = match[1].trim();
            if (!noNombres.includes(nombre.toLowerCase()) && nombre.length >= 2) {
                return nombre.charAt(0).toUpperCase() + nombre.slice(1).toLowerCase();
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
    if (estaBloqueado(ip)) return res.status(403).json({ error: 'IP bloqueada', bloqueado: true });
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

app.post('/api/login', (req, res) => {
    const ip = req.ip || '0.0.0.0';
    if (estaBloqueado(ip)) return res.status(403).json({ success: false, error: 'Bloqueado' });
    const { password } = req.body;
    if (!password) { registrarIntento(ip, 'vacia'); return res.status(400).json({ success: false, error: 'Contraseña requerida' }); }
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
        for (const f of files) { if (f.startsWith('hero-') && f !== filename) { try { await fs.unlink(path.join(UPLOADS_DIR, f)); } catch(e) {} } }
        res.json({ url: `/uploads/${filename}`, filename });
    } catch (e) { res.status(500).json({ error: 'Error al subir' }); }
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
        if (req.body.imagenWhatsApp && esUrlValida(req.body.imagenWhatsApp)) iwa = req.body.imagenWhatsApp.trim();
        const s = { id: generarId(), ...req.body, imagenWeb: req.body.imagenWeb || 'https://images.unsplash.com/photo-1544161515-4ab6ce6db874?w=800', imagenWhatsApp: iwa };
        serviciosData.push(s);
        await fs.writeFile(SERVICIOS_FILE, JSON.stringify(serviciosData, null, 2), 'utf8');
        res.status(201).json(s);
    } catch(e) { res.status(500).json({ error: 'Error al crear servicio' }); }
});

app.put('/api/servicios/:id', async (req, res) => {
    if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    try {
        const i = serviciosData.findIndex(s => s.id === req.params.id);
        if (i === -1) return res.status(404).json({ error: 'No encontrado' });
        let iwa = serviciosData[i].imagenWhatsApp || '';
        if (req.body.imagenWhatsApp !== undefined) {
            if (req.body.imagenWhatsApp && esUrlValida(req.body.imagenWhatsApp)) iwa = req.body.imagenWhatsApp.trim();
            else if (!req.body.imagenWhatsApp) iwa = '';
        }
        serviciosData[i] = { ...serviciosData[i], ...req.body, id: req.params.id, imagenWeb: req.body.imagenWeb || serviciosData[i].imagenWeb, imagenWhatsApp: iwa };
        await fs.writeFile(SERVICIOS_FILE, JSON.stringify(serviciosData, null, 2), 'utf8');
        res.json({ ok: true, mensaje: 'Actualizado' });
    } catch(e) { res.status(500).json({ error: 'Error al actualizar' }); }
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
    try { if (fsSync.existsSync(TURNOS_FILE)) { turnosMem = JSON.parse(await fs.readFile(TURNOS_FILE, 'utf8')); } else { turnosMem = []; } } catch(e) { turnosMem = []; }
    return turnosMem;
}

async function saveTurnos(t) { await fs.writeFile(TURNOS_FILE, JSON.stringify(t, null, 2), 'utf8'); turnosMem = t; }

app.get('/turnos', async (req, res) => res.json(await loadTurnos()));

app.post('/turnos', async (req, res) => {
    const ip = req.ip || '0.0.0.0';
    if (estaBloqueado(ip)) return res.status(403).json({ error: 'Bloqueado' });
    if (!checkRateIP(ip)) { bloquearIP(ip, 'Spam turnos', 'spam'); return res.status(429).json({ error: 'Demasiados pedidos' }); }
    try {
        const { nombre, dia, hora, massageType, telefono, ubicacion, tipoServicio } = req.body;
        if (!nombre || nombre.length < 2) return res.status(400).json({ error: 'Nombre inválido' });
        const tel = telefono ? telefono.replace(/\D/g, '') : '';
        if (!tel || tel.length < 7) return res.status(400).json({ error: 'Teléfono inválido' });
        let codigoPais = req.body.codigoPais || '53';
        if (!/^\d{1,3}$/.test(codigoPais)) codigoPais = '53';
        if (!dia || !DIAS_VALIDOS.includes(dia.toLowerCase())) return res.status(400).json({ error: 'Día inválido' });
        const hn = parseInt(hora);
        if (!HORAS_VALIDAS.includes(hn)) return res.status(400).json({ error: 'Hora inválida' });
        if (!checkRateTel(tel)) return res.status(429).json({ error: 'Máximo 2 turnos por teléfono por día' });
        const turnos = await loadTurnos();
        const dl = dia.toLowerCase();
        if (turnos.some(t => t.telefono === tel && t.dia === dl)) return res.status(409).json({ error: 'Ya tenés un turno ese día' });
        if (turnos.some(t => t.dia === dl && t.hora === hn)) return res.status(409).json({ error: 'Ocupado', alternativa: buscarAlternativa(dl, hn, turnos) });
        const nuevo = { id: generarId(), nombre: escapeHtml(sanitize(nombre)), dia: dl, hora: hn, massageType: massageType || 'Masaje', telefono: tel, codigoPais: codigoPais, ubicacion: ubicacion ? escapeHtml(sanitize(ubicacion)) : null, tipoServicio: tipoServicio || 'salon', confirmadoWhatsApp: false, fechaCreacion: new Date().toISOString(), ip };
        turnos.push(nuevo);
        await saveTurnos(turnos);
        regTurno(ip, tel);
        intentosFallidos.delete(ip);
        res.status(201).json({ mensaje: 'Turno creado', turno: nuevo });
    } catch(e) { res.status(500).json({ error: 'Error interno' }); }
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
            return res.json({ whatsappCancelacion: true, mensaje: 'Cancelá por WhatsApp.', urlWhatsApp: `https://wa.me/${turno.codigoPais || '53'}${tel}?text=${encodeURIComponent(msg)}` });
        }
        turnos.splice(turnos.indexOf(turno), 1);
        await saveTurnos(turnos);
        res.json({ cancelado: true, mensaje: `Turno del ${turno.dia} a las ${turno.hora}:00 cancelado.` });
    } catch(e) { res.status(500).json({ error: 'Error' }); }
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
        const cod = t.codigoPais || '53';
        const idx = turnos.findIndex(x => x.id === req.params.id);
        if (idx !== -1) { turnos[idx].confirmadoWhatsApp = true; turnos[idx].fechaWA = new Date().toISOString(); await saveTurnos(turnos); }
        res.json({ success: true, numero: `${cod}${t.telefono}`, mensaje: msg, urlWhatsApp: `https://wa.me/${cod}${t.telefono}?text=${encodeURIComponent(msg)}` });
    } catch(e) { res.status(500).json({ error: 'Error' }); }
});

// ============================================================
// SEGURIDAD
// ============================================================
app.get('/api/seguridad/bloqueos', (req, res) => {
    if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    const a = [];
    for (const [ip, d] of bloqueos) { a.push({ ip, motivo: d.motivo, tipoAtaque: d.tipoAtaque, fecha: d.fecha, tiempoRestante: Math.max(0, d.hasta - Date.now()), tiempoRestanteFormateado: fmtT(Math.max(0, d.hasta - Date.now())), intentos: d.intentos || 0, permanente: d.permanente || false }); }
    res.json({ activos: a, historial: historialBloqueos.slice(0, 100), intentosFallidos: Object.fromEntries(intentosFallidos) });
});

app.post('/api/seguridad/desbloquear/:ip', (req, res) => { if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' }); desbloquearIP(req.params.ip); res.json({ ok: true }); });
app.delete('/api/seguridad/bloqueos/:ip', (req, res) => { if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' }); bloqueos.delete(req.params.ip); intentosFallidos.delete(req.params.ip); guardarBloqueos(); res.json({ ok: true }); });
app.delete('/api/seguridad/historial/:id', (req, res) => { if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' }); historialBloqueos = historialBloqueos.filter(h => h.id !== req.params.id); guardarBloqueos(); res.json({ ok: true }); });
app.post('/api/seguridad/limpiar-expirados', (req, res) => { if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' }); let b = 0; const now = Date.now(); for (const [ip, d] of bloqueos) { if (now > d.hasta) { bloqueos.delete(ip); b++; } } guardarBloqueos(); res.json({ mensaje: `${b} bloqueos eliminados` }); });
app.post('/api/seguridad/bloquear-permanente/:ip', (req, res) => { if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' }); bloquearIP(req.params.ip, 'Permanente', 'manual'); const d = bloqueos.get(req.params.ip); if (d) { d.hasta = Date.now() + 31536000000; d.permanente = true; guardarBloqueos(); } res.json({ ok: true }); });

// ============================================================
// RUTAS ESTÁTICAS
// ============================================================
app.get('/voice-assistant', (req, res) => res.sendFile(path.join(__dirname, 'voice-assistant.html')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/admin.html', (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));
app.get('/login.html', (req, res) => res.sendFile(path.join(__dirname, 'login.html')));
app.get('/health', (req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString(), uptime: process.uptime() }));

// ============================================================
// ASISTENTE DE VOZ - IA INTELIGENTE
// ============================================================
let voiceClients = new Map();

async function procesarComandoVoz(texto, clientId, ip) {
    const tl = texto.toLowerCase().trim();
    let cd = voiceClients.get(clientId);
    
    if (!cd) {
        cd = { estado: 'saludo_inicial', datos: {}, nombreRecordado: null, intentos: 0, intentosPais: 0, clientId: clientId };
        voiceClients.set(clientId, cd);
    }
    
    const nombreExtraido = extraerNombre(texto);
    if (nombreExtraido && !cd.datos.nombre) {
        cd.datos.nombre = nombreExtraido;
        cd.nombreRecordado = nombreExtraido;
    }
    
    const nombre = cd.datos.nombre;
    
    // CORRECCIÓN DE PAÍS
    if ((tl.includes('corregir') || tl.includes('error') || tl.includes('equivocado') || tl.includes('cambiar')) && cd.datos.codigoPais) {
        cd.datos.pais = null;
        cd.datos.codigoPais = null;
        cd.estado = 'confirmando_pais';
        cd.intentosPais = 0;
        return `Disculpe${nombre ? ', ' + nombre : ''}. Vamos a corregirlo. ¿Cuál es su país?`;
    }
    
    // SALUDO INICIAL
    if (cd.estado === 'saludo_inicial') {
        const paisDetectado = detectarPaisConNombre(texto);
        if (paisDetectado) { cd.datos.pais = paisDetectado.nombre; cd.datos.codigoPais = paisDetectado.codigo; }
        
        if (nombre && cd.datos.codigoPais) {
            cd.estado = 'nombre_conocido';
            return `Es un gusto, ${nombre}. ${cd.datos.pais} (+${cd.datos.codigoPais}) registrado. ¿En qué le puedo ayudar? Puede decir "reservar turno", "ver horarios" o "conocer masajes".`;
        }
        
        if (nombre) {
            cd.estado = 'confirmando_pais';
            cd.intentosPais = 0;
            return `Es un gusto, ${nombre}. Para contactarle correctamente por WhatsApp, ¿de qué país es?`;
        }
        
        cd.estado = 'pidiendo_nombre';
        return 'Hola, sea bienvenido a Serenity Spa. Soy su asistente virtual. ¿Me podría decir su nombre y de qué país es?';
    }
    
    // PIDIENDO NOMBRE
    if (cd.estado === 'pidiendo_nombre') {
        if (nombre) {
            const paisDetectado = detectarPaisConNombre(texto);
            if (paisDetectado) { cd.datos.pais = paisDetectado.nombre; cd.datos.codigoPais = paisDetectado.codigo; }
            
            if (cd.datos.codigoPais) {
                cd.estado = 'nombre_conocido';
                return `Es un gusto, ${nombre}. ${cd.datos.pais} (+${cd.datos.codigoPais}) registrado. ¿En qué le puedo ayudar?`;
            }
            
            cd.estado = 'confirmando_pais';
            cd.intentosPais = 0;
            return `Es un gusto, ${nombre}. ¿De qué país es?`;
        }
        cd.intentos++;
        if (cd.intentos >= 3) {
            cd.datos.nombre = 'Cliente';
            cd.estado = 'confirmando_pais';
            return 'No he podido entender su nombre. Le llamaré "Cliente". ¿De qué país es?';
        }
        return 'Disculpe, no entendí su nombre. ¿Me lo podría repetir?';
    }
    
    // CONFIRMANDO PAÍS
    if (cd.estado === 'confirmando_pais') {
        const paisDetectado = detectarPaisConNombre(texto);
        
        if (paisDetectado) {
            cd.datos.pais = paisDetectado.nombre;
            cd.datos.codigoPais = paisDetectado.codigo;
            cd.estado = 'nombre_conocido';
            return `Perfecto. ${paisDetectado.nombre} (+${paisDetectado.codigo}) registrado. ¿En qué le puedo ayudar, ${nombre || 'Cliente'}?`;
        }
        
        // Si menciona un código numérico
        const codigoMatch = texto.match(/\+?(\d{1,3})/);
        if (codigoMatch && codigoMatch[1].length <= 3) {
            cd.datos.codigoPais = codigoMatch[1];
            cd.datos.pais = 'País registrado';
            cd.estado = 'nombre_conocido';
            return `Código +${codigoMatch[1]} registrado. ¿En qué le puedo ayudar?`;
        }
        
        cd.intentosPais++;
        if (cd.intentosPais >= 3) {
            cd.datos.codigoPais = '53';
            cd.datos.pais = 'Cuba';
            cd.estado = 'nombre_conocido';
            return `Usaré el código de Cuba (+53). Si no es correcto, diga "corregir país". ¿En qué le puedo ayudar?`;
        }
        
        return '¿De qué país es? Por ejemplo: Cuba, Argentina, México, España...';
    }
    
    // NOMBRE CONOCIDO
    if (cd.estado === 'nombre_conocido') {
        if (/\b(reservar|turno|cita|agendar)\b/.test(tl)) {
            cd.estado = 'eligiendo_masaje';
            return `${nombre}, ¿qué masaje prefiere?\n✨ Relajante - $45\n💪 Corporal - $65\n🌸 Facial - $40`;
        }
        if (/\b(horario|hora)\b/.test(tl)) {
            return `${nombre}, horarios: Lunes a sábado. 12:00, 16:00 y 20:00. ¿Quiere reservar?`;
        }
        if (/\b(precio|costo|cuánto)\b/.test(tl)) {
            return `${nombre}, precios: Relajante $45, Corporal $65, Facial $40.`;
        }
        if (/\b(cancelar|anular)\b/.test(tl)) {
            cd.estado = 'cancelando';
            return `${nombre}, para cancelar necesito su número de teléfono.`;
        }
        if (/\b(gracias)\b/.test(tl)) {
            return `¡A usted, ${nombre}! Que tenga un excelente día.`;
        }
        return `${nombre}, ¿en qué puedo ayudarle? Puede reservar, ver horarios o precios.`;
    }
    
    // ELIGIENDO MASAJE
    if (cd.estado === 'eligiendo_masaje') {
        if (tl.includes('relajante')) { cd.datos.masaje = 'Masaje Relajante'; cd.estado = 'eligiendo_ubicacion'; return `Relajante. ¿Salón o domicilio?`; }
        if (tl.includes('corporal')) { cd.datos.masaje = 'Masaje Corporal'; cd.estado = 'eligiendo_ubicacion'; return `Corporal. ¿Salón o domicilio?`; }
        if (tl.includes('facial')) { cd.datos.masaje = 'Masaje Facial'; cd.estado = 'eligiendo_ubicacion'; return `Facial. ¿Salón o domicilio?`; }
        return '¿Relajante, corporal o facial?';
    }
    
    // ELIGIENDO UBICACIÓN
    if (cd.estado === 'eligiendo_ubicacion') {
        if (tl.includes('salon') || tl.includes('salón')) { cd.datos.ubicacion = 'salon'; cd.estado = 'eligiendo_dia'; return `Salón. ¿Qué día? Lunes a sábado.`; }
        if (tl.includes('domicilio') || tl.includes('casa')) { cd.datos.ubicacion = 'domicilio'; cd.estado = 'pidiendo_direccion'; return `Domicilio. ¿Dirección completa?`; }
        return '¿Salón o domicilio?';
    }
    
    // PIDIENDO DIRECCIÓN
    if (cd.estado === 'pidiendo_direccion') {
        if (texto.trim().length > 5) { cd.datos.direccion = texto.trim(); cd.estado = 'eligiendo_dia'; return `Dirección registrada. ¿Qué día?`; }
        return 'Dígame su dirección completa.';
    }
    
    // ELIGIENDO DÍA
    if (cd.estado === 'eligiendo_dia') {
        for (const dia of DIAS_VALIDOS) { if (tl.includes(dia)) { cd.datos.dia = dia; cd.estado = 'eligiendo_hora'; return `${dia}. ¿Hora? 12, 16 o 20.`; } }
        return '¿Qué día? Lunes a sábado.';
    }
    
    // ELIGIENDO HORA
    if (cd.estado === 'eligiendo_hora') {
        let hora = null;
        if (tl.includes('12') || tl.includes('doce')) hora = 12;
        else if (tl.includes('16') || tl.includes('cuatro')) hora = 16;
        else if (tl.includes('20') || tl.includes('ocho')) hora = 20;
        if (hora) { cd.datos.hora = hora; cd.estado = 'pidiendo_telefono'; return `¿Su número de teléfono?`; }
        return '¿12, 16 o 20 horas?';
    }
    
    // PIDIENDO TELÉFONO
    if (cd.estado === 'pidiendo_telefono') {
        const nums = texto.replace(/\D/g, '');
        if (nums.length >= 7) { cd.datos.telefono = nums; return await confirmarReservaInteligente(cd, ip); }
        cd.intentos++;
        if (cd.intentos >= 3) { voiceClients.delete(clientId); return 'No pude registrar su número. Intente más tarde.'; }
        return 'Repita su número, solo dígitos.';
    }
    
    // CANCELANDO
    if (cd.estado === 'cancelando') {
        const tel = texto.replace(/\D/g, '');
        if (tel.length >= 7) {
            try {
                const turnos = await loadTurnos();
                const turno = turnos.find(t => t.telefono === tel);
                if (turno) { turnos.splice(turnos.indexOf(turno), 1); await saveTurnos(turnos); voiceClients.delete(clientId); return `Turno cancelado, ${nombre}. Buen día.`; }
                return 'No encontré turno con ese número.';
            } catch(e) { return 'Error. Intente de nuevo.'; }
        }
        return 'Necesito su número para cancelar.';
    }
    
    return `${nombre || 'Disculpe'}, ¿podría repetir?`;
}

async function confirmarReservaInteligente(cd, ip) {
    const d = cd.datos;
    if (!d.codigoPais || !/^\d{1,3}$/.test(d.codigoPais)) { d.codigoPais = '53'; d.pais = 'Cuba'; }
    
    try {
        const turnos = JSON.parse(await fs.readFile(TURNOS_FILE, 'utf8'));
        if (turnos.some(t => t.telefono === d.telefono && t.dia === d.dia)) {
            return `${d.nombre}, ya tiene turno ese día. ¿Otro día?`;
        }
        if (turnos.some(t => t.dia === d.dia && t.hora === d.hora)) {
            const alt = buscarAlternativa(d.dia, d.hora, turnos);
            if (alt) { cd.datos.dia = alt.dia; cd.datos.hora = alt.hora; return `Ocupado. ¿${alt.dia} ${alt.hora}:00?`; }
            return 'Sin disponibilidad. ¿Otro día?';
        }
        
        const nuevo = { id: generarId(), nombre: d.nombre, dia: d.dia, hora: d.hora, massageType: d.masaje, telefono: d.telefono, codigoPais: d.codigoPais, ubicacion: d.direccion || 'Salón Serenity Spa', tipoServicio: d.ubicacion === 'domicilio' ? 'domicilio' : 'salon', confirmadoWhatsApp: false, fechaCreacion: new Date().toISOString(), ip };
        turnos.push(nuevo);
        await fs.writeFile(TURNOS_FILE, JSON.stringify(turnos, null, 2), 'utf8');
        voiceClients.delete(cd.clientId);
        const ht = d.hora === 12 ? '12 del mediodía' : d.hora === 16 ? '4 de la tarde' : '8 de la noche';
        return `¡Confirmado, ${d.nombre}! ${d.masaje} el ${d.dia} a las ${ht}. WhatsApp: +${d.codigoPais} ${d.telefono}. ¡Gracias!`;
    } catch(e) { return 'Error. Intente de nuevo.'; }
}

// ============================================================
// INICIALIZACIÓN
// ============================================================
async function initFile(f, fb) { try { return JSON.parse(await fs.readFile(f, 'utf8')); } catch(e) { await fs.writeFile(f, JSON.stringify(fb, null, 2), 'utf8'); return JSON.parse(JSON.stringify(fb)); } }

async function start() {
    await cargarBloqueos();
    configData = await initFile(CONFIG_FILE, configData);
    serviciosData = await initFile(SERVICIOS_FILE, [
        { id: "relajante", nombre: "Masaje Relajante", precio: "$45", descripcion: "Movimientos suaves.", beneficios: ["Reduce ansiedad", "60 Min"], efectos: ["Relajación"], imagenWeb: "https://images.unsplash.com/photo-1544161515-4ab6ce6db874?w=800", imagenWhatsApp: "", orden: 1 },
        { id: "corporal", nombre: "Masaje Corporal", precio: "$65", descripcion: "Tratamiento completo.", beneficios: ["Relajación integral", "90 Min"], efectos: ["Activación linfática"], imagenWeb: "https://images.unsplash.com/photo-1519823551278-64ac92734fb1?w=800", imagenWhatsApp: "", orden: 2 },
        { id: "facial", nombre: "Masaje Facial", precio: "$40", descripcion: "Rejuvenece.", beneficios: ["Reafirma", "45 Min"], efectos: ["Estimula colágeno"], imagenWeb: "https://images.unsplash.com/photo-1570172619644-dfd03ed5d881?w=800", imagenWhatsApp: "", orden: 3 }
    ]);
    turnosMem = await initFile(TURNOS_FILE, []);

    const server = app.listen(PORT, '0.0.0.0', () => { console.log(`🌿 Serenity Spa - Puerto ${PORT}`); });

    const wss = new WebSocket.Server({ server, path: '/ws-voice' });
    wss.on('connection', (ws, req) => {
        const ip = req.socket.remoteAddress || 'desconocida';
        if (estaBloqueado(ip)) { ws.close(1008, 'IP bloqueada'); return; }
        const cid = generarId();
        let mc = 0;
        voiceClients.set(cid, { ws, estado: 'saludo_inicial', datos: {}, intentos: 0, intentosPais: 0, clientId: cid });
        ws.on('message', async (data) => {
            mc++;
            if (mc > 20) { bloquearIP(ip, 'Flood', 'flood'); ws.close(1008); return; }
            try {
                const m = JSON.parse(data);
                if (m.tipo === 'transcripcion') {
                    const r = await procesarComandoVoz(m.texto, cid, ip);
                    if (ws.readyState === 1) ws.send(JSON.stringify({ tipo: 'respuesta', texto: r }));
                }
            } catch(e) { if (ws.readyState === 1) ws.send(JSON.stringify({ tipo: 'respuesta', texto: 'Error. Repita.' })); }
        });
        ws.on('close', () => voiceClients.delete(cid));
        ws.on('error', () => voiceClients.delete(cid));
        const ft = setInterval(() => { mc = 0; }, 60000);
        ws.on('close', () => clearInterval(ft));
    });
}

process.on('SIGTERM', async () => { await guardarBloqueos(); process.exit(0); });
process.on('SIGINT', async () => { await guardarBloqueos(); process.exit(0); });

start();
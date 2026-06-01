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

// ==================== UTILIDADES ====================
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
function fmtT(ms) {
    if (ms <= 0) return 'Expirado';
    const s = Math.floor(ms / 1000), m = Math.floor(s / 60), h = Math.floor(m / 60);
    return h > 0 ? `${h}h ${m % 60}m` : m > 0 ? `${m}m ${s % 60}s` : `${s}s`;
}

// ==================== DETECCIÓN DE PAÍS (SOLO CUBA) ====================
function detectarPaisConNombre(texto) {
    const t = texto.toLowerCase().trim();
    
    const paises = [
        { nombre: 'Cuba', codigo: '53', claves: ['cuba'] }
    ];
    
    for (const pais of paises) {
        for (const clave of pais.claves) {
            if (t.includes(clave)) return { nombre: pais.nombre, codigo: pais.codigo };
        }
    }
    
    const otrosPaises = [
        'argentina', 'méxico', 'mexico', 'colombia', 'chile', 'perú', 'peru',
        'españa', 'espania', 'uruguay', 'paraguay', 'bolivia', 'venezuela',
        'ecuador', 'costa rica', 'panamá', 'estados unidos', 'usa', 'eeuu',
        'puerto rico', 'república dominicana', 'dominicana', 'brasil', 'italia',
        'francia', 'alemania', 'inglaterra', 'reino unido', 'canadá', 'canada'
    ];
    
    for (const otro of otrosPaises) {
        if (t.includes(otro)) return { nombre: 'no_permitido', codigo: '00' };
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

// ==================== EXTRACCIÓN DE NOMBRES ====================
function extraerNombre(texto) {
    const t = texto.trim();
    const patrones = [
        /(?:me\s+llamo|mi\s+nombre\s+es|soy)\s+([A-ZÁÉÍÓÚÑ][a-záéíóúñ]*(?:\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ]*){0,2})/i,
        /(?:es\s+un\s+gusto|mucho\s+gusto).*?(?:soy|me\s+llamo)\s+([A-ZÁÉÍÓÚÑ][a-záéíóúñ]*(?:\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ]*){0,2})/i,
        /(?:hola|buenas?\s*(?:tardes|días|noches)).*?(?:soy|me\s+llamo|mi\s+nombre\s+es)\s+([A-ZÁÉÍÓÚÑ][a-záéíóúñ]*(?:\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ]*){0,2})/i,
    ];
    for (const patron of patrones) {
        const match = t.match(patron);
        if (match && match[1] && match[1].length >= 2) return match[1].trim();
    }
    return null;
}

// ==================== MIDDLEWARES ====================
app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    next();
});

app.use((req, res, next) => {
    const ip = req.ip || req.socket.remoteAddress || '0.0.0.0';
    if (estaBloqueado(ip)) return res.status(403).json({ error: 'IP bloqueada', bloqueado: true });
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
        for (const f of files) { if (f.startsWith('hero-') && f !== filename) { try { await fs.unlink(path.join(UPLOADS_DIR, f)); } catch(e) {} } }
        res.json({ url: `/uploads/${filename}`, filename });
    } catch (e) { res.status(500).json({ error: 'Error al subir' }); }
});

// ==================== CONFIGURACIÓN ====================
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

// ==================== SERVICIOS ====================
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

// ==================== TURNOS ====================
let turnosMem = [];

async function loadTurnos() {
    try { turnosMem = fsSync.existsSync(TURNOS_FILE) ? JSON.parse(await fs.readFile(TURNOS_FILE, 'utf8')) : []; }
    catch(e) { turnosMem = []; }
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
        let codigoPais = '53';
        if (!dia || !DIAS_VALIDOS.includes(dia.toLowerCase())) return res.status(400).json({ error: 'Día inválido' });
        const hn = parseInt(hora);
        if (!HORAS_VALIDAS.includes(hn)) return res.status(400).json({ error: 'Hora inválida' });
        if (!checkRateTel(tel)) return res.status(429).json({ error: 'Máximo 2 turnos por teléfono por día' });
        const turnos = await loadTurnos();
        const dl = dia.toLowerCase();
        if (turnos.some(t => t.telefono === tel && t.dia === dl)) return res.status(409).json({ error: 'Ya tenés un turno ese día' });
        if (turnos.some(t => t.dia === dl && t.hora === hn)) return res.status(409).json({ error: 'Ocupado', alternativa: buscarAlternativa(dl, hn, turnos) });
        const nuevo = {
            id: generarId(), nombre: escapeHtml(sanitize(nombre)), dia: dl, hora: hn,
            massageType: massageType || 'Masaje', telefono: tel, codigoPais: codigoPais,
            ubicacion: ubicacion ? escapeHtml(sanitize(ubicacion)) : null,
            tipoServicio: tipoServicio || 'salon', confirmadoWhatsApp: false,
            fechaCreacion: new Date().toISOString(), ip
        };
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
        const cod = '53';
        const idx = turnos.findIndex(x => x.id === req.params.id);
        if (idx !== -1) { turnos[idx].confirmadoWhatsApp = true; turnos[idx].fechaWA = new Date().toISOString(); await saveTurnos(turnos); }
        res.json({ success: true, numero: `${cod}${t.telefono}`, mensaje: msg, urlWhatsApp: `https://wa.me/${cod}${t.telefono}?text=${encodeURIComponent(msg)}` });
    } catch(e) { res.status(500).json({ error: 'Error' }); }
});

// ==================== SEGURIDAD ====================
app.get('/api/seguridad/bloqueos', (req, res) => {
    if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    const a = [];
    for (const [ip, d] of bloqueos) a.push({ ip, motivo: d.motivo, tipoAtaque: d.tipoAtaque, fecha: d.fecha, tiempoRestante: Math.max(0, d.hasta - Date.now()), tiempoRestanteFormateado: fmtT(Math.max(0, d.hasta - Date.now())), intentos: d.intentos || 0, permanente: d.permanente || false });
    res.json({ activos: a, historial: historialBloqueos.slice(0, 100), intentosFallidos: Object.fromEntries(intentosFallidos) });
});

app.post('/api/seguridad/desbloquear/:ip', (req, res) => { if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' }); desbloquearIP(req.params.ip); res.json({ ok: true }); });
app.delete('/api/seguridad/bloqueos/:ip', (req, res) => { if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' }); bloqueos.delete(req.params.ip); intentosFallidos.delete(req.params.ip); guardarBloqueos(); res.json({ ok: true }); });
app.delete('/api/seguridad/historial/:id', (req, res) => { if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' }); historialBloqueos = historialBloqueos.filter(h => h.id !== req.params.id); guardarBloqueos(); res.json({ ok: true }); });
app.post('/api/seguridad/limpiar-expirados', (req, res) => { if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' }); let b = 0; const now = Date.now(); for (const [ip, d] of bloqueos) { if (now > d.hasta) { bloqueos.delete(ip); b++; } } guardarBloqueos(); res.json({ mensaje: `${b} bloqueos eliminados` }); });
app.post('/api/seguridad/bloquear-permanente/:ip', (req, res) => { if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' }); bloquearIP(req.params.ip, 'Permanente', 'manual'); const d = bloqueos.get(req.params.ip); if (d) { d.hasta = Date.now() + 31536000000; d.permanente = true; guardarBloqueos(); } res.json({ ok: true }); });

// ==================== RUTAS ESTÁTICAS ====================
app.get('/voice-assistant', (req, res) => res.sendFile(path.join(__dirname, 'voice-assistant.html')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/admin.html', (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));
app.get('/login.html', (req, res) => res.sendFile(path.join(__dirname, 'login.html')));
app.get('/health', (req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString(), uptime: process.uptime() }));

// ==================== ASISTENTE DE VOZ - SOLO CUBA ====================
let voiceClients = new Map();

async function procesarComandoVoz(texto, clientId, ip) {
    const tl = texto.toLowerCase().trim();
    let cd = voiceClients.get(clientId);
    
    if (!cd) {
        cd = { estado: 'saludo_inicial', datos: {}, nombreRecordado: null, intentos: 0, clientId: clientId };
        voiceClients.set(clientId, cd);
    }
    
    const nombreExtraido = extraerNombre(texto);
    if (nombreExtraido && !cd.datos.nombre) { cd.datos.nombre = nombreExtraido; cd.nombreRecordado = nombreExtraido; }
    const nombre = cd.datos.nombre;
    
    // ===== SALUDO INICIAL =====
    if (cd.estado === 'saludo_inicial') {
        if (nombre) { cd.estado = 'confirmando_pais'; cd.intentos = 0; return `Es un gusto, ${nombre}. Este servicio de reservas está disponible únicamente para Cuba. ¿Me confirma que se encuentra en Cuba?`; }
        if (/\b(reservar|turno|masaje|horario|precio)\b/.test(tl)) return 'Antes de continuar, ¿me podría decir su nombre, por favor? Este servicio solo está disponible en Cuba.';
        if (/\b(hola|buenas?|saludos)\b/.test(tl)) return 'Hola, ¿cómo está? Sea bienvenido a Serenity Spa. Este servicio de reservas está disponible para Cuba. ¿Me podría decir su nombre?';
        return 'Bienvenido a Serenity Spa. Nuestro servicio de reservas está disponible para Cuba. ¿Me podría decir su nombre?';
    }
    
    // ===== CONFIRMANDO PAÍS =====
    if (cd.estado === 'confirmando_pais') {
        const paisDetectado = detectarPaisConNombre(texto);
        if (paisDetectado) {
            if (paisDetectado.codigo === '00') return `Lo siento${nombre ? ', ' + nombre : ''}, este servicio de reservas está destinado únicamente para Cuba. No puedo procesar reservas desde otro país.`;
            cd.datos.pais = 'Cuba'; cd.datos.codigoPais = '53'; cd.estado = 'nombre_conocido'; cd.intentos = 0;
            return `Perfecto${nombre ? ', ' + nombre : ''}. Su reserva será para Cuba (+53). ¿En qué le puedo ayudar? Puede reservar un turno, consultar horarios o conocer nuestros masajes.`;
        }
        cd.intentos++;
        if (cd.intentos >= 3) { cd.datos.codigoPais = '53'; cd.datos.pais = 'Cuba'; cd.estado = 'nombre_conocido'; return `Usaré el código de Cuba (+53). Si esto no es correcto, por favor dígalo. ¿En qué le puedo ayudar?`; }
        return `Disculpe${nombre ? ', ' + nombre : ''}, ¿podría confirmar que se encuentra en Cuba? Este servicio solo está disponible para residentes en Cuba.`;
    }
    
    // ===== NOMBRE CONOCIDO =====
    if (cd.estado === 'nombre_conocido') {
        if (!cd.datos.codigoPais) { cd.estado = 'confirmando_pais'; cd.intentos = 0; return `${nombre}, antes de continuar necesito confirmar que está en Cuba. ¿Es correcto?`; }
        if (/\b(reservar|turno|cita|agendar)\b/.test(tl)) { cd.estado = 'eligiendo_masaje'; return `Perfecto, ${nombre}. ¿Qué tipo de masaje le gustaría?\n\n1️⃣ Relajante - 60 min - $45\n2️⃣ Corporal - 90 min - $65\n3️⃣ Facial - 45 min - $40\n\nPuede decir el nombre o el número.`; }
        if (/\b(horario|hora|cuándo|cuando)\b/.test(tl)) return `${nombre}, nuestros horarios son de lunes a sábado: 12 del mediodía, 4 de la tarde y 8 de la noche. ¿Le gustaría reservar?`;
        if (/\b(precio|costo|vale|cuánto|cuanto)\b/.test(tl)) return `${nombre}, Relajante: $45, Corporal: $65, Facial: $40. ¿Cuál le interesa?`;
        if (/\b(cancelar|anular|eliminar)\b/.test(tl)) { cd.estado = 'cancelando'; return `${nombre}, para cancelar necesito su número de teléfono. ¿Me lo podría dar?`; }
        if (/\b(gracias|agradecido)\b/.test(tl)) return `Ha sido un placer, ${nombre}. ¡Vuelva pronto a Serenity Spa!`;
        return `${nombre}, ¿en qué puedo ayudarle?\n📅 Reservar | ⏰ Horarios | 💰 Precios | 💆 Masajes`;
    }
    
    // ===== CANCELANDO =====
    if (cd.estado === 'cancelando') {
        const tel = texto.replace(/\D/g, '');
        if (tel.length >= 7) {
            try {
                const turnos = await loadTurnos();
                const turno = turnos.find(t => t.telefono === tel);
                if (turno) { turnos.splice(turnos.indexOf(turno), 1); await saveTurnos(turnos); voiceClients.delete(clientId); return `Listo, ${nombre}. Su turno del ${turno.dia} a las ${turno.hora}:00 ha sido cancelado.`; }
                return `No encontré un turno con ese número, ${nombre}. ¿Quiere intentar de nuevo?`;
            } catch(e) { return 'Error al cancelar. Intente de nuevo.'; }
        }
        cd.intentos++; if (cd.intentos >= 3) { voiceClients.delete(clientId); return 'No pude cancelar. Intente más tarde.'; }
        return 'Necesito su número de teléfono. Solo dígitos.';
    }
    
    // ===== ELIGIENDO MASAJE =====
    if (cd.estado === 'eligiendo_masaje') {
        if (tl.includes('relajante') || tl.includes('suave') || tl.includes('1')) { cd.datos.masaje = 'Masaje Relajante'; cd.estado = 'eligiendo_ubicacion'; return `Relajante, 60 min por $45. ¿Prefiere en nuestro salón o a domicilio?`; }
        if (tl.includes('corporal') || tl.includes('cuerpo') || tl.includes('completo') || tl.includes('2')) { cd.datos.masaje = 'Masaje Corporal'; cd.estado = 'eligiendo_ubicacion'; return `Corporal, 90 min por $65. ¿Salón o domicilio?`; }
        if (tl.includes('facial') || tl.includes('cara') || tl.includes('rostro') || tl.includes('3')) { cd.datos.masaje = 'Masaje Facial'; cd.estado = 'eligiendo_ubicacion'; return `Facial, 45 min por $40. ¿Salón o domicilio?`; }
        return `${nombre}, dígame el nombre o número: 1-Relajante, 2-Corporal, 3-Facial.`;
    }
    
    // ===== ELIGIENDO UBICACIÓN =====
    if (cd.estado === 'eligiendo_ubicacion') {
        if (tl.includes('salon') || tl.includes('salón') || tl.includes('local') || tl.includes('tienda') || tl.includes('centro') || tl.includes('allá') || tl.includes('alla') || tl.includes('prefiero el salón') || tl.includes('en el salon') || tl.includes('gustaría en el salón') || tl.includes('preferentemente en el salón')) {
            cd.datos.ubicacion = 'salon'; cd.estado = 'eligiendo_dia'; return `Perfecto, será en nuestro salón. ¿Qué día? Lunes a sábado.`; }
        if (tl.includes('domicilio') || tl.includes('casa') || tl.includes('hogar') || tl.includes('domi') || tl.includes('mi casa') || tl.includes('en casa') || tl.includes('prefiero a domicilio') || tl.includes('gustaría a domicilio') || tl.includes('vengan') || tl.includes('venga') || tl.includes('aquí') || tl.includes('aqui') || tl.includes('donde estoy') || tl.includes('donde vivo')) {
            cd.datos.ubicacion = 'domicilio'; cd.estado = 'pidiendo_direccion'; return `Perfecto, a domicilio. ¿Me da su dirección completa? Calle, número y municipio.`; }
        return `${nombre}, ¿prefiere en nuestro salón o a domicilio?`;
    }
    
    // ===== PIDIENDO DIRECCIÓN =====
    if (cd.estado === 'pidiendo_direccion') {
        if (texto.trim().length > 5) { cd.datos.direccion = texto.trim(); cd.estado = 'eligiendo_dia'; return `Dirección registrada. ¿Qué día? Lunes a sábado.`; }
        return 'Por favor, dígame su dirección completa: calle, número y municipio.';
    }
    
    // ===== ELIGIENDO DÍA =====
    if (cd.estado === 'eligiendo_dia') {
        const diasMap = { 'lunes': 'lunes', 'martes': 'martes', 'miercoles': 'miércoles', 'miércoles': 'miércoles', 'jueves': 'jueves', 'viernes': 'viernes', 'sabado': 'sábado', 'sábado': 'sábado' };
        for (const [clave, dia] of Object.entries(diasMap)) {
            if (tl.includes(clave)) { cd.datos.dia = dia.replace('é', 'e').replace('á', 'a'); cd.estado = 'eligiendo_hora'; return `${dia.charAt(0).toUpperCase() + dia.slice(1)}. ¿A qué hora? 12 del mediodía, 4 de la tarde u 8 de la noche.`; }
        }
        return `${nombre}, ¿qué día? Lunes, martes, miércoles, jueves, viernes o sábado.`;
    }
    
    // ===== ELIGIENDO HORA =====
    if (cd.estado === 'eligiendo_hora') {
        let hora = null;
        if (tl.includes('12') || tl.includes('doce') || tl.includes('mediodía') || tl.includes('mediodia') || tl.includes('medio día') || tl.includes('medio dia')) hora = 12;
        else if (tl.includes('16') || tl.includes('cuatro') || tl.includes('4') || tl.includes('tarde')) hora = 16;
        else if (tl.includes('20') || tl.includes('ocho') || tl.includes('8') || tl.includes('noche')) hora = 20;
        if (hora) { cd.datos.hora = hora; cd.estado = 'pidiendo_telefono'; const ht = hora === 12 ? '12 del mediodía' : hora === 16 ? '4 de la tarde' : '8 de la noche'; return `${ht}. ¿Su número de teléfono, ${nombre}?`; }
        return `${nombre}, horarios: 12 del mediodía, 4 de la tarde u 8 de la noche. ¿Cuál?`;
    }
    
    // ===== PIDIENDO TELÉFONO =====
    if (cd.estado === 'pidiendo_telefono') {
        const numeros = texto.replace(/\D/g, '');
        if (numeros.length >= 7) { cd.datos.telefono = numeros; return await confirmarReservaInteligente(cd, ip); }
        cd.intentos++; if (cd.intentos >= 3) { voiceClients.delete(clientId); return 'No pude registrar su número. Intente más tarde.'; }
        return `${nombre}, ¿podría repetir su número? Solo dígitos.`;
    }
    
    return `${nombre ? nombre : 'Disculpe'}, ¿podría repetir? No le entendí bien.`;
}

async function confirmarReservaInteligente(cd, ip) {
    const d = cd.datos;
    d.codigoPais = '53';
    d.pais = 'Cuba';
    
    try {
        const turnos = JSON.parse(await fs.readFile(TURNOS_FILE, 'utf8'));
        if (turnos.some(t => t.telefono === d.telefono && t.dia === d.dia)) return `${d.nombre}, ya tiene un turno el ${d.dia}. Un masaje por día. ¿Otro día?`;
        if (turnos.some(t => t.dia === d.dia && t.hora === d.hora)) {
            const alt = buscarAlternativa(d.dia, d.hora, turnos);
            if (alt) { cd.datos.dia = alt.dia; cd.datos.hora = alt.hora; return `Ocupado, ${d.nombre}. Tengo el ${alt.dia} a las ${alt.hora}:00. ¿Le sirve?`; }
            return `Sin disponibilidad, ${d.nombre}. ¿Otro día?`;
        }
        const nuevo = {
            id: generarId(), nombre: d.nombre, dia: d.dia, hora: d.hora, massageType: d.masaje,
            telefono: d.telefono, codigoPais: '53',
            ubicacion: d.direccion || 'Salón Serenity Spa',
            tipoServicio: d.ubicacion === 'domicilio' ? 'domicilio' : 'salon',
            confirmadoWhatsApp: false, fechaCreacion: new Date().toISOString(), ip
        };
        turnos.push(nuevo);
        await fs.writeFile(TURNOS_FILE, JSON.stringify(turnos, null, 2), 'utf8');
        voiceClients.delete(cd.clientId);
        const ht = d.hora === 12 ? '12 del mediodía' : d.hora === 16 ? '4 de la tarde' : '8 de la noche';
        return `¡Confirmado, ${d.nombre}!\n📅 ${d.dia}\n⏰ ${ht}\n💆 ${d.masaje}\n📍 ${d.ubicacion === 'domicilio' ? d.direccion : 'Salón Serenity Spa'}\n📞 +53 ${d.telefono}\n\nLe esperamos. ¡Gracias!`;
    } catch(e) { return `Error, ${d.nombre}. Intente de nuevo.`; }
}

// ==================== INICIALIZACIÓN ====================
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

    const server = app.listen(PORT, '0.0.0.0', () => console.log(`🌿 Serenity Spa iniciado en puerto ${PORT}`));

    const wss = new WebSocket.Server({ server, path: '/ws-voice' });
    wss.on('connection', (ws, req) => {
        const ip = req.socket.remoteAddress || 'desconocida';
        if (estaBloqueado(ip)) { ws.close(1008, 'IP bloqueada'); return; }
        const cid = generarId();
        let mc = 0;
        voiceClients.set(cid, { ws, estado: 'saludo_inicial', datos: {}, intentos: 0, clientId: cid });
        ws.on('message', async (data) => {
            mc++;
            if (mc > 20) { bloquearIP(ip, 'Flood WS', 'flood'); ws.close(1008); return; }
            try {
                const m = JSON.parse(data);
                if (m.tipo === 'transcripcion') {
                    const r = await procesarComandoVoz(m.texto, cid, ip);
                    if (ws.readyState === 1) ws.send(JSON.stringify({ tipo: 'respuesta', texto: r }));
                }
            } catch(e) { if (ws.readyState === 1) ws.send(JSON.stringify({ tipo: 'respuesta', texto: 'Disculpe, hubo un error. ¿Podría repetir?' })); }
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
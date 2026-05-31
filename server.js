const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const WebSocket = require('ws');

const app = express();
const PORT = process.env.PORT || 5001;
const TURNOS_FILE = path.join(__dirname, 'turnos.json');
const SERVICIOS_FILE = path.join(__dirname, 'servicios.json');
const CONFIG_FILE = path.join(__dirname, 'config.json');
const BLOQUEOS_FILE = path.join(__dirname, 'bloqueos.json');

console.log('🌿 SERENITY SPA v6.0 - Cancelación + Admin corregido');

let bloqueos = new Map();
let historialBloqueos = [];

async function cargarBloqueos() {
    try {
        await fs.access(BLOQUEOS_FILE);
        const data = await fs.readFile(BLOQUEOS_FILE, 'utf8');
        const parsed = JSON.parse(data);
        bloqueos = new Map(Object.entries(parsed.bloqueos || {}));
        historialBloqueos = parsed.historial || [];
        let changes = false;
        for (const [ip, d] of bloqueos) { if (Date.now() > d.hasta) { bloqueos.delete(ip); changes = true; } }
        if (changes) await guardarBloqueos();
        console.log(`📂 ${bloqueos.size} IPs bloqueadas, ${historialBloqueos.length} históricos`);
    } catch {
        await fs.writeFile(BLOQUEOS_FILE, JSON.stringify({ bloqueos: {}, historial: [] }, null, 2), 'utf8');
    }
}

async function guardarBloqueos() {
    await fs.writeFile(BLOQUEOS_FILE, JSON.stringify({ bloqueos: Object.fromEntries(bloqueos), historial: historialBloqueos.slice(0, 500) }, null, 2), 'utf8');
}

function estaBloqueado(ip) {
    if (bloqueos.has(ip)) {
        if (Date.now() < bloqueos.get(ip).hasta) return true;
        bloqueos.delete(ip); guardarBloqueos(); return false;
    }
    return false;
}

function bloquearIP(ip, motivo, tipo = 'Desconocido') {
    bloqueos.set(ip, { hasta: Date.now() + 3600000, motivo, tipoAtaque: tipo, fecha: new Date().toISOString(), ip, intentos: (intentosFallidos.get(ip)?.count || 0) });
    historialBloqueos.unshift({ ...bloqueos.get(ip), id: generarId() });
    guardarBloqueos();
}

const intentosFallidos = new Map();

function registrarIntento(ip, tipo) {
    const now = Date.now();
    if (!intentosFallidos.has(ip)) { intentosFallidos.set(ip, { count: 1, first: now, tipo, history: [tipo] }); return false; }
    const d = intentosFallidos.get(ip);
    if (now - d.first > 600000) { intentosFallidos.set(ip, { count: 1, first: now, tipo, history: [tipo] }); return false; }
    d.count++; d.tipo = tipo; d.history.push(tipo);
    if (d.count >= 5) { bloquearIP(ip, `5+ intentos de ${tipo}`, tipo); intentosFallidos.delete(ip); return true; }
    return false;
}

function limpiarIntentos(ip) { intentosFallidos.delete(ip); }
function desbloquearIP(ip) { bloqueos.delete(ip); intentosFallidos.delete(ip); guardarBloqueos(); }

function esUrlValida(s) {
    if (!s || typeof s !== 'string' || s.startsWith('data:') || s.length > 2048) return false;
    try { const u = new URL(s.trim()); return u.protocol === 'http:' || u.protocol === 'https:'; } catch { return false; }
}

// ==================== MIDDLEWARES ====================
app.use(express.json({ limit: '1mb' }));
app.use((req, res, next) => { if (estaBloqueado(req.ip || '0.0.0.0')) return res.status(403).json({ error: 'Bloqueado', bloqueado: true }); next(); });
app.use((req, res, next) => { res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('X-Frame-Options', 'DENY'); next(); });
app.use((req, res, next) => { if (req.url === '/' || req.url.endsWith('.html')) { res.setHeader('Cache-Control', 'no-store'); res.setHeader('Pragma', 'no-cache'); } next(); });
app.use(express.static(__dirname));

const HORAS_VALIDAS = [12, 16, 20];
const DIAS_VALIDOS = ['lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado'];

const PAISES = {
    'argentina': { c: '54', p: /^[1-9]\d{7,11}$/, e: '11 2345 6789' }, 'méxico': { c: '52', p: /^[1-9]\d{9,11}$/, e: '55 1234 5678' },
    'mexico': { c: '52', p: /^[1-9]\d{9,11}$/, e: '55 1234 5678' }, 'colombia': { c: '57', p: /^3\d{9}$/, e: '321 1234567' },
    'chile': { c: '56', p: /^[1-9]\d{8,10}$/, e: '9 1234 5678' }, 'perú': { c: '51', p: /^[1-9]\d{8,10}$/, e: '987 654 321' },
    'peru': { c: '51', p: /^[1-9]\d{8,10}$/, e: '987 654 321' }, 'españa': { c: '34', p: /^[6-7]\d{8}$/, e: '612 34 56 78' },
    'espania': { c: '34', p: /^[6-7]\d{8}$/, e: '612 34 56 78' }, 'uruguay': { c: '598', p: /^[1-9]\d{7,9}$/, e: '94 123 456' },
    'paraguay': { c: '595', p: /^[1-9]\d{7,9}$/, e: '981 234567' }, 'bolivia': { c: '591', p: /^[1-9]\d{7,9}$/, e: '71234567' },
    'venezuela': { c: '58', p: /^[1-9]\d{9}$/, e: '412 1234567' }, 'ecuador': { c: '593', p: /^[1-9]\d{8,10}$/, e: '99 123 4567' }
};

function extraerNombre(texto) {
    if (!texto || texto.length < 2) return null;
    const t = texto.trim();
    const pat = [
        /(?:me\s+(?:llamo|llaman))\s+([a-zA-ZáéíóúñÑü\s]{2,50}?)(?:\s+(?:es\s+un\s+gusto|mucho\s+gusto|un\s+placer|gracias|\.|,|!|$))/i,
        /(?:soy|mi\s+nombre\s+es)\s+([a-zA-ZáéíóúñÑü\s]{2,50}?)(?:\s+(?:es\s+un\s+gusto|mucho\s+gusto|un\s+placer|gracias|\.|,|!|$))/i,
        /(?:hola|buenos\s+días|buenas\s+tardes|buenas\s+noches|saludos),?\s+(?:soy|me\s+llamo|mi\s+nombre\s+es)?\s*([a-zA-ZáéíóúñÑü\s]{2,50}?)(?:\s+(?:es\s+un\s+gusto|mucho\s+gusto|un\s+placer|gracias|\.|,|!|$))/i
    ];
    for (const p of pat) {
        const m = t.match(p);
        if (m && m[1]) { let n = m[1].trim().replace(/\s+(?:es\s+un\s+gusto|mucho\s+gusto|un\s+placer|gracias).*/i, '').replace(/[.,!]$/, '').trim(); if (n.length >= 2 && n.length <= 50 && /^[a-zA-ZáéíóúñÑü\s.]+$/.test(n)) return n; }
    }
    const stop = ['hola','buenos','buenas','días','dias','tardes','noches','soy','me','llamo','mi','nombre','es','un','una','gusto','mucho','placer','para','por','favor','quiero','deseo','necesito','reservar','turno','cita','masaje','el','la','los','las','de','del','en','con','gracias','saludos','cancelar','eliminar','anular','borrar','cambiar','modificar','no'];
    const words = t.split(/\s+/).filter(w => w.length > 1 && !stop.includes(w.toLowerCase()) && !/\d/.test(w) && w.length < 20);
    if (words.length > 0 && words.length <= 4) { const n = words.join(' '); if (n.length >= 2 && /^[a-zA-ZáéíóúñÑü\s.]+$/.test(n)) return n; }
    return null;
}

function detectarPais(texto) {
    const tl = texto.toLowerCase().trim();
    for (const [pais, d] of Object.entries(PAISES)) { if (tl === pais || tl.includes(pais)) return { pais, ...d }; }
    const claves = { 'argen':'argentina','arg':'argentina','méx':'méxico','mex':'méxico','cdmx':'méxico','colom':'colombia','chil':'chile','peru':'perú','lima':'perú','espa':'españa','madrid':'españa' };
    for (const [k, dest] of Object.entries(claves)) { if (tl.includes(k)) { const d = PAISES[dest]; if (d) return { pais: dest, ...d }; } }
    return null;
}

function escapeHtml(s) { return s ? s.replace(/[&<>]/g, m => m === '&' ? '&amp;' : m === '<' ? '&lt;' : '&gt;') : ''; }
function sanitize(s) { return s ? s.trim().replace(/[^\w\sáéíóúñÑü.,@\-]/gi, '') : ''; }
function generarId() { return Date.now().toString(36) + Math.random().toString(36).substr(2) + crypto.randomBytes(4).toString('hex'); }

function buscarAlternativa(dia, hora, turnos) {
    const dias = ['lunes','martes','miercoles','jueves','viernes','sabado'];
    const idx = dias.indexOf(dia);
    if (idx === -1) return null;
    for (let o = 0; o < 7; o++) {
        const d = dias[(idx + o) % 7];
        const hrs = o === 0 ? HORAS_VALIDAS.filter(h => h > hora) : HORAS_VALIDAS;
        for (const h of hrs) { if (!turnos.some(t => t.dia === d && t.hora === h)) return { dia: d, hora: h }; }
    }
    return null;
}

// ==================== DATOS ====================
let turnosMem = [];
let configData = {
    hero: { titulo: "Renueva tu Energía", subtitulo: "Experiencias de bienestar", imagenFondo: "https://images.unsplash.com/photo-1544161515-4ab6ce6db874?ixlib=rb-1.2.1&auto=format&fit=crop&w=1920&q=80", botonTexto: "Explorar Tratamientos" },
    serviciosSection: { etiqueta: "Nuestros Servicios", titulo: "Elige tu Masaje Ideal", descripcion: "Turnos: 12:00, 16:00 y 20:00" },
    contactoSection: { titulo: "Asistente de Reservas", descripcion: "Reserva tu turno de forma rápida" },
    shareSection: { titulo: "Comparte Serenity Spa" }
};
let serviciosData = [];

async function initFile(file, fallback) {
    try { await fs.access(file); return JSON.parse(await fs.readFile(file, 'utf8')); } catch { await fs.writeFile(file, JSON.stringify(fallback, null, 2), 'utf8'); return JSON.parse(JSON.stringify(fallback)); }
}

// ==================== API CONFIG ====================
app.get('/api/config', (req, res) => res.json(configData));
app.put('/api/config', async (req, res) => {
    if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    configData = { ...configData, ...req.body };
    await fs.writeFile(CONFIG_FILE, JSON.stringify(configData, null, 2), 'utf8');
    res.json({ mensaje: 'OK' });
});

// ==================== API SERVICIOS ====================
app.get('/api/servicios', (req, res) => res.json(serviciosData.sort((a, b) => (a.orden || 999) - (b.orden || 999))));

app.post('/api/servicios', async (req, res) => {
    if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    const iw = req.body.imagenWeb || 'https://images.unsplash.com/photo-1544161515-4ab6ce6db874?ixlib=rb-1.2.1&auto=format&fit=crop&w=800&q=80';
    let iwa = '';
    if (req.body.imagenWhatsApp && esUrlValida(req.body.imagenWhatsApp)) iwa = req.body.imagenWhatsApp.trim();
    const s = { id: generarId(), ...req.body, imagenWeb: iw, imagenWhatsApp: iwa };
    serviciosData.push(s);
    await fs.writeFile(SERVICIOS_FILE, JSON.stringify(serviciosData, null, 2), 'utf8');
    res.status(201).json(s);
});

app.put('/api/servicios/:id', async (req, res) => {
    if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    const i = serviciosData.findIndex(s => s.id === req.params.id);
    if (i === -1) return res.status(404).json({ error: 'No encontrado' });
    const iw = req.body.imagenWeb || serviciosData[i].imagenWeb;
    let iwa = '';
    if (req.body.imagenWhatsApp && esUrlValida(req.body.imagenWhatsApp)) iwa = req.body.imagenWhatsApp.trim();
    serviciosData[i] = { ...serviciosData[i], ...req.body, id: req.params.id, imagenWeb: iw, imagenWhatsApp: iwa };
    await fs.writeFile(SERVICIOS_FILE, JSON.stringify(serviciosData, null, 2), 'utf8');
    res.json(serviciosData[i]);
});

app.delete('/api/servicios/:id', async (req, res) => {
    if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    serviciosData = serviciosData.filter(s => s.id !== req.params.id);
    await fs.writeFile(SERVICIOS_FILE, JSON.stringify(serviciosData, null, 2), 'utf8');
    res.json({ mensaje: 'Eliminado' });
});

// ==================== API TURNOS ====================
app.get('/turnos', async (req, res) => { try { turnosMem = JSON.parse(await fs.readFile(TURNOS_FILE, 'utf8')); } catch {} res.json(turnosMem); });

app.post('/turnos', async (req, res) => {
    const ip = req.ip || '0.0.0.0';
    if (estaBloqueado(ip)) return res.status(403).json({ error: 'Bloqueado' });
    try {
        const { nombre, dia, hora, massageType, telefono, codigoPais, ubicacion, tipoServicio } = req.body;
        if (!nombre || nombre.length < 2) { registrarIntento(ip, 'nombre'); return res.status(400).json({ error: 'Nombre inválido' }); }
        if (!telefono || telefono.replace(/\D/g, '').length < 7) { registrarIntento(ip, 'tel'); return res.status(400).json({ error: 'Teléfono inválido' }); }
        if (!dia || !DIAS_VALIDOS.includes(dia.toLowerCase())) return res.status(400).json({ error: 'Día inválido' });
        const hn = parseInt(hora);
        if (!HORAS_VALIDAS.includes(hn)) return res.status(400).json({ error: 'Hora inválida' });
        const turnos = await loadTurnos();
        const tel = telefono.replace(/\D/g, '');
        if (turnos.some(t => t.telefono === tel && t.dia === dia.toLowerCase())) return res.status(409).json({ error: 'Ya tienes turno ese día' });
        if (turnos.some(t => t.dia === dia.toLowerCase() && t.hora === hn)) { return res.status(409).json({ error: 'Ocupado', alternativa: buscarAlternativa(dia.toLowerCase(), hn, turnos) }); }
        const nuevo = { id: generarId(), nombre: escapeHtml(sanitize(nombre)), dia: dia.toLowerCase(), hora: hn, massageType: massageType || 'Masaje', telefono: tel, codigoPais: codigoPais || '54', ubicacion: ubicacion ? escapeHtml(sanitize(ubicacion)) : null, tipoServicio: tipoServicio || 'salon', confirmadoWhatsApp: false, fechaCreacion: new Date().toISOString(), ip };
        turnos.push(nuevo); await saveTurnos(turnos); limpiarIntentos(ip);
        res.status(201).json({ mensaje: 'Turno creado', turno: nuevo });
    } catch (e) { console.error('Error turno:', e); res.status(500).json({ error: 'Error interno' }); }
});

app.delete('/turnos/:id', async (req, res) => {
    if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    const turnos = await loadTurnos();
    const i = turnos.findIndex(t => t.id === req.params.id);
    if (i === -1) return res.status(404).json({ error: 'No encontrado' });
    turnos.splice(i, 1); await saveTurnos(turnos);
    res.json({ mensaje: 'Eliminado' });
});

// ==================== CANCELAR TURNO (desde chat/voz) ====================
app.post('/api/cancelar-turno', async (req, res) => {
    try {
        const { telefono } = req.body;
        if (!telefono) return res.status(400).json({ error: 'Teléfono requerido' });
        const tel = telefono.replace(/\D/g, '');
        if (tel.length < 7) return res.json({ error: 'Número inválido' });
        const turnos = await loadTurnos();
        const turno = turnos.find(t => t.telefono === tel);
        if (!turno) return res.json({ error: 'No se encontró un turno activo con ese número.' });

        // Si fue confirmado por WhatsApp desde administración → cancelación vía WhatsApp
        if (turno.confirmadoWhatsApp) {
            let msg = `❌ *CANCELACIÓN DE RESERVA*\n\n`;
            msg += `Hola *${turno.nombre}*,\n\n`;
            msg += `⚠️ Tu reserva ha sido cancelada:\n\n`;
            msg += `📅 *Día:* ${turno.dia.charAt(0).toUpperCase() + turno.dia.slice(1)}\n`;
            msg += `⏰ *Hora:* ${turno.hora}:00 hs\n`;
            msg += `💆‍♂️ *Masaje:* ${turno.massageType}\n\n`;
            msg += `Pedimos disculpas por cualquier inconveniente.\n`;
            msg += `Podés reservar nuevamente cuando lo desees.\n\n`;
            msg += `*Equipo Serenity Spa* 💆‍♀️`;
            const codigo = turno.codigoPais || '54';
            return res.json({
                whatsappCancelacion: true,
                mensaje: `Tu reserva del ${turno.dia} a las ${turno.hora}:00 hs fue confirmada por WhatsApp. Para cancelar, contactá directamente por WhatsApp.`,
                urlWhatsApp: `https://wa.me/${codigo}${tel}?text=${encodeURIComponent(msg)}`,
                detalle: { dia: turno.dia, hora: turno.hora, masaje: turno.massageType, nombre: turno.nombre }
            });
        }

        // No confirmado por WA → eliminar directamente
        const idx = turnos.indexOf(turno);
        turnos.splice(idx, 1);
        await saveTurnos(turnos);
        res.json({ cancelado: true, mensaje: `Tu turno del ${turno.dia} a las ${turno.hora}:00 hs (${turno.massageType}) ha sido cancelado.` });
    } catch (e) { console.error('Error cancelar:', e); res.status(500).json({ error: 'Error interno' }); }
});

// ==================== WHATSAPP (marca confirmado) ====================
app.post('/api/enviar-whatsapp/:id', async (req, res) => {
    try {
        const turnos = await loadTurnos();
        const turno = turnos.find(t => t.id === req.params.id);
        if (!turno) return res.status(404).json({ error: 'No encontrado' });
        const servicio = serviciosData.find(s => s.nombre === turno.massageType);
        const img = (servicio?.imagenWhatsApp && esUrlValida(servicio.imagenWhatsApp)) ? servicio.imagenWhatsApp : '';
        let msg = `🌿 *SERENITY SPA* 🌿\n\nHola *${turno.nombre}*,\n¡Gracias por confiar en nosotros! ✨\n\n✅ *TU RESERVA HA SIDO CONFIRMADA*\n\n📅 *Día:* ${turno.dia.charAt(0).toUpperCase() + turno.dia.slice(1)}\n⏰ *Hora:* ${turno.hora}:00 hs\n💆‍♂️ *Masaje:* ${turno.massageType}\n📍 *Lugar:* ${turno.tipoServicio === 'domicilio' ? turno.ubicacion : 'Serenity Spa - Salón'}\n\n🌸 *Te esperamos con aromaterapia y música suave.*\n⏱️ Podés modificar o cancelar con 4 horas de anticipación.\n\n`;
        if (img) msg += `🖼️ *Imagen del servicio:* ${img}\n\n`;
        msg += `✨ *¡Te deseamos una experiencia inolvidable!*\n\nCon cariño,\n*Equipo Serenity Spa* 💆‍♀️💆‍♂️`;
        const tel = turno.telefono.replace(/\D/g, '');
        const codigo = turno.codigoPais || '54';

        // Marcar como confirmado por WhatsApp
        const idx = turnos.findIndex(t => t.id === req.params.id);
        if (idx !== -1) {
            turnos[idx].confirmadoWhatsApp = true;
            turnos[idx].fechaConfirmacionWhatsApp = new Date().toISOString();
            await saveTurnos(turnos);
        }

        res.json({ success: true, numero: `${codigo}${tel}`, mensaje: msg, imagenUrl: img, urlWhatsApp: `https://wa.me/${codigo}${tel}?text=${encodeURIComponent(msg)}` });
    } catch (e) { console.error('Error WA:', e); res.status(500).json({ error: 'Error' }); }
});

// ==================== SEGURIDAD ====================
app.get('/api/seguridad/bloqueos', (req, res) => {
    if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    const activos = [];
    for (const [ip, d] of bloqueos) { activos.push({ ip, motivo: d.motivo, tipoAtaque: d.tipoAtaque, fecha: d.fecha, tiempoRestante: Math.max(0, d.hasta - Date.now()), tiempoRestanteFormateado: fmtTime(Math.max(0, d.hasta - Date.now())), intentos: d.intentos || 0, permanente: d.permanente || false }); }
    res.json({ activos, historial: historialBloqueos.slice(0, 100), intentosFallidos: Object.fromEntries(intentosFallidos) });
});
app.post('/api/seguridad/desbloquear/:ip', (req, res) => { if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' }); desbloquearIP(req.params.ip); res.json({ ok: true }); });
app.delete('/api/seguridad/bloqueos/:ip', (req, res) => { if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' }); bloqueos.delete(req.params.ip); intentosFallidos.delete(req.params.ip); guardarBloqueos(); res.json({ ok: true }); });
app.delete('/api/seguridad/historial/:id', (req, res) => { if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' }); historialBloqueos = historialBloqueos.filter(h => h.id !== req.params.id); guardarBloqueos(); res.json({ ok: true }); });
app.post('/api/seguridad/limpiar-expirados', (req, res) => { if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' }); let b = 0; const now = Date.now(); for (const [ip, d] of bloqueos) { if (now > d.hasta) { bloqueos.delete(ip); b++; } } const before = historialBloqueos.length; historialBloqueos = historialBloqueos.filter(h => now < h.hasta); guardarBloqueos(); res.json({ mensaje: `${b} bloqueos y ${before - historialBloqueos.length} registros eliminados` }); });
app.post('/api/seguridad/bloquear-permanente/:ip', (req, res) => { if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' }); const d = bloquearIP(req.params.ip, 'Bloqueo permanente', 'manual'); d.hasta = Date.now() + 31536000000; d.permanente = true; guardarBloqueos(); res.json({ ok: true }); });
function fmtTime(ms) { if (ms <= 0) return 'Expirado'; const s = Math.floor(ms/1000), m = Math.floor(s/60), h = Math.floor(m/60); return h > 0 ? `${h}h ${m%60}m` : m > 0 ? `${m}m ${s%60}s` : `${s}s`; }

// ==================== AUTH ====================
const validTokens = new Map();
function checkAuth(req) { const h = req.headers.authorization; return h && h.startsWith('Bearer ') && validTokens.has(h.substring(7)) && validTokens.get(h.substring(7)) > Date.now(); }

app.post('/api/login', (req, res) => {
    const ip = req.ip || '0.0.0.0';
    if (estaBloqueado(ip)) return res.status(403).json({ success: false, error: 'Bloqueado' });
    const { password } = req.body;
    if (!password) { registrarIntento(ip, 'vacia'); return res.status(400).json({ success: false, error: 'Contraseña requerida' }); }
    if (password === (process.env.ADMIN_PASSWORD || 'admin123')) { const t = crypto.randomBytes(64).toString('hex'); validTokens.set(t, Date.now() + 28800000); limpiarIntentos(ip); res.json({ success: true, token: t }); }
    else { registrarIntento(ip, 'incorrecta'); res.status(401).json({ success: false, error: 'Incorrecta' }); }
});

app.get('/api/verify', (req, res) => { res.json({ valid: checkAuth(req) }); });
app.post('/api/logout', (req, res) => { const h = req.headers.authorization; if (h?.startsWith('Bearer ')) validTokens.delete(h.substring(7)); res.json({ ok: true }); });

// ==================== ASISTENTE DE VOZ ====================
app.get('/voice-assistant', (req, res) => res.sendFile(path.join(__dirname, 'voice-assistant.html')));
let voiceClients = new Map();

async function procesarComandoVoz(texto, clientId, ip) {
    const tl = texto.toLowerCase().trim();
    let cd = voiceClients.get(clientId);
    if (!cd) { cd = { estado: 'recopilando', datos: {}, alternativa: null }; voiceClients.set(clientId, cd); }
    if (!cd.estado || cd.estado === 'inicial') { cd.estado = 'recopilando'; cd.datos = {}; cd.alternativa = null; }
    const d = cd.datos;

    // Estado: esperar teléfono para cancelar
    if (cd.estado === 'esperando_tel_cancelar') {
        const tel = texto.replace(/\D/g, '');
        if (tel.length >= 7) { voiceClients.delete(clientId); return await cancelarTurnoVoz(tel); }
        return 'Número inválido. Dime tu número de teléfono completo.';
    }

    // Estado: confirmar alternativa
    if (cd.estado === 'confirmando_alt') {
        if (tl.includes('si') || tl.includes('sí') || tl.includes('ok') || tl.includes('dale')) { d.dia = cd.alternativa.dia; d.hora = cd.alternativa.hora; cd.estado = 'confirmando'; }
        else { voiceClients.delete(clientId); return 'Entiendo. Reserva cancelada. Di reservar turno para iniciar otra.'; }
    }

    // DETECTAR CANCELACIÓN / MODIFICACIÓN
    if (tl.includes('cancelar') || tl.includes('eliminar') || tl.includes('anular') || tl.includes('borrar') || tl.includes('no quiero') || tl.includes('ya no') || tl.includes('no necesito')) {
        if (d.telefono) { voiceClients.delete(clientId); return await cancelarTurnoVoz(d.telefono); }
        cd.estado = 'esperando_tel_cancelar';
        return 'Para cancelar tu reserva necesito tu número de teléfono. ¿Cuál es?';
    }

    if (tl.includes('cambiar') || tl.includes('modificar')) {
        if (d.telefono) {
            voiceClients.delete(clientId);
            const r = await cancelarTurnoVoz(d.telefono);
            return r + ' Una vez cancelado, podés hacer una nueva reserva diciendo reservar turno.';
        }
        cd.estado = 'esperando_tel_cancelar';
        return 'Para modificar tu reserva primero la cancelamos. Necesito tu número de teléfono.';
    }

    // Extraer datos
    if (!d.nombre) { const n = extraerNombre(texto); if (n) d.nombre = n; }
    if (!d.massageType) { if (tl.includes('relajante')) d.massageType = 'Masaje Relajante'; else if (tl.includes('corporal')) d.massageType = 'Masaje Corporal'; else if (tl.includes('facial')) d.massageType = 'Masaje Facial'; }
    if (!d.dia) { for (const dia of DIAS_VALIDOS) { if (tl.includes(dia)) { d.dia = dia; break; } } }
    if (!d.hora) { if (tl.includes('12') || tl.includes('doce')) d.hora = 12; else if (tl.includes('16') || tl.includes('cuatro')) d.hora = 16; else if (tl.includes('20') || tl.includes('ocho')) d.hora = 20; }
    if (!d.tipoServicio) { if (tl.includes('salon') || tl.includes('salón') || tl.includes('local')) { d.tipoServicio = 'salon'; d.ubicacion = 'Salón Serenity Spa'; } else if (tl.includes('domicilio') || tl.includes('casa')) d.tipoServicio = 'domicilio'; }
    if (d.tipoServicio === 'domicilio' && !d.ubicacion && texto.length > 10 && !tl.includes('reservar') && !tl.includes('turno')) d.ubicacion = texto.trim();
    if (!d.telefono) { const p = texto.replace(/\D/g, ''); if (p.length >= 7 && p.length <= 15 && /^\d+$/.test(p)) { d.telefono = p; if (!d.codigoPais) { const pa = detectarPais(texto); d.codigoPais = pa?.c || '54'; } } }
    if (!d.codigoPais) { const pa = detectarPais(texto); if (pa) d.codigoPais = pa.c; }

    // Confirmar si tiene todo
    if (cd.estado === 'confirmando' || (d.nombre && d.telefono && d.massageType && d.dia && d.hora && d.tipoServicio)) {
        let turnos = []; try { turnos = JSON.parse(await fs.readFile(TURNOS_FILE, 'utf8')); } catch {}
        if (turnos.some(t => t.telefono === d.telefono && t.dia === d.dia)) { voiceClients.delete(clientId); return `Ya tienes un turno para el ${d.dia}. Un masaje por día.`; }
        if (turnos.some(t => t.dia === d.dia && t.hora === d.hora)) {
            const alt = buscarAlternativa(d.dia, d.hora, turnos);
            if (alt) { cd.estado = 'confirmando_alt'; cd.alternativa = alt; const ht = alt.hora === 12 ? '12 del mediodía' : alt.hora === 16 ? '4 de la tarde' : '8 de la noche'; return `Las ${d.hora}:00 del ${d.dia} está ocupado. ¿Reservar para el ${alt.dia} a las ${ht}? Di sí o no.`; }
            voiceClients.delete(clientId); return 'Sin disponibilidad en los próximos 7 días.';
        }
        const nuevo = { id: generarId(), nombre: d.nombre, dia: d.dia, hora: d.hora, massageType: d.massageType, telefono: d.telefono, codigoPais: d.codigoPais || '54', ubicacion: d.ubicacion || (d.tipoServicio === 'salon' ? 'Salón Serenity Spa' : ''), tipoServicio: d.tipoServicio, confirmadoWhatsApp: false, fechaCreacion: new Date().toISOString(), ip };
        turnos.push(nuevo); await fs.writeFile(TURNOS_FILE, JSON.stringify(turnos, null, 2), 'utf8');
        const ht = d.hora === 12 ? '12 del mediodía' : d.hora === 16 ? '4 de la tarde' : '8 de la noche';
        voiceClients.delete(clientId);
        return `¡Reserva confirmada! ${d.massageType} para ${d.nombre} el ${d.dia} a las ${ht}. ${d.tipoServicio === 'domicilio' ? 'A domicilio: ' + d.ubicacion : 'En nuestro salón'}. ¡Gracias!`;
    }

    // Pedir datos faltantes
    if (!d.nombre) { cd.estado = 'esperando_nombre'; return 'Bienvenido a Serenity Spa. ¿Cuál es tu nombre?'; }
    if (!d.telefono) { cd.estado = 'esperando_tel'; return `Gracias ${d.nombre}. ¿Cuál es tu número de teléfono?`; }
    if (!d.massageType) { cd.estado = 'esperando_masaje'; return `${d.nombre}, ¿qué masaje deseas? Relajante, corporal o facial.`; }
    if (!d.tipoServicio) { cd.estado = 'esperando_ubicacion'; return '¿Prefieres en el salón o a domicilio?'; }
    if (d.tipoServicio === 'domicilio' && !d.ubicacion) { cd.estado = 'esperando_dir'; return '¿Cuál es tu dirección completa?'; }
    if (!d.dia) { cd.estado = 'esperando_dia'; return '¿Qué día? Lunes a sábado.'; }
    if (!d.hora) { cd.estado = 'esperando_hora'; return '¿A qué hora? 12, 16 o 20 horas.'; }
    return "Di 'reservar turno' para comenzar. También podés decir 'cancelar' si necesitás anular una reserva.";
}

async function cancelarTurnoVoz(telefono) {
    try {
        const r = await fetch(`http://localhost:${PORT}/api/cancelar-turno`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ telefono }) });
        const data = await r.json();
        if (data.cancelado) return data.mensaje;
        if (data.whatsappCancelacion) return `Tu reserva fue confirmada por WhatsApp. Para cancelarla, necesitás contactarnos directamente por WhatsApp. Lo sentimos por las molestias.`;
        return data.error || 'No se encontró un turno activo.';
    } catch { return 'Error al procesar la cancelación. Intentá más tarde.'; }
}

// ==================== RUTAS HTML ====================
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/admin.html', (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));
app.get('/login.html', (req, res) => res.sendFile(path.join(__dirname, 'login.html')));
app.get('/1.html', (req, res) => res.redirect('/admin.html'));

async function loadTurnos() { try { turnosMem = JSON.parse(await fs.readFile(TURNOS_FILE, 'utf8')); } catch {} return turnosMem; }
async function saveTurnos(t) { await fs.writeFile(TURNOS_FILE, JSON.stringify(t, null, 2), 'utf8'); turnosMem = t; }

// ==================== INICIAR ====================
async function start() {
    try {
        await cargarBloqueos();
        configData = await initFile(CONFIG_FILE, configData);
        const servDef = [
            { id: "relajante", nombre: "Masaje Relajante", precio: "$45", descripcion: "Movimientos suaves para liberar el estrés.", beneficios: ["Reduce ansiedad", "60 Minutos"], efectos: ["Relajación profunda"], imagenWeb: "https://images.unsplash.com/photo-1544161515-4ab6ce6db874?ixlib=rb-1.2.1&auto=format&fit=crop&w=800&q=80", imagenWhatsApp: "", orden: 1 },
            { id: "corporal", nombre: "Masaje Corporal", precio: "$65", descripcion: "Tratamiento completo.", beneficios: ["Relajación integral", "90 Minutos"], efectos: ["Activación linfática"], imagenWeb: "https://images.unsplash.com/photo-1519823551278-64ac92734fb1?ixlib=rb-1.2.1&auto=format&fit=crop&w=800&q=80", imagenWhatsApp: "", orden: 2 },
            { id: "facial", nombre: "Masaje Facial", precio: "$40", descripcion: "Rejuvenece la piel.", beneficios: ["Reafirma la piel", "45 Minutos"], efectos: ["Estimula colágeno"], imagenWeb: "https://images.unsplash.com/photo-1570172619644-dfd03ed5d881?ixlib=rb-1.2.1&auto=format&fit=crop&w=800&q=80", imagenWhatsApp: "", orden: 3 }
        ];
        serviciosData = await initFile(SERVICIOS_FILE, servDef);
        turnosMem = await initFile(TURNOS_FILE, []);

        const server = app.listen(PORT, '0.0.0.0', () => {
            console.log('\n' + '='.repeat(55));
            console.log('  🌿 SERENITY SPA v6.0');
            console.log('='.repeat(55));
            console.log(`  📍 Puerto: ${PORT}`);
            console.log(`  🎤 Voz: /voice-assistant (push-to-talk)`);
            console.log(`  🗑️ Cancelar turno: POST /api/cancelar-turno`);
            console.log(`  📱 Confirmado WA: marca en turno`);
            console.log(`  🔒 Bloqueados: ${bloqueos.size}`);
            console.log('  ✅ Listo');
            console.log('='.repeat(55) + '\n');
        });

        const wss = new WebSocket.Server({ server, path: '/ws-voice' });
        wss.on('connection', (ws, req) => {
            const ip = req.socket.remoteAddress || '?';
            if (estaBloqueado(ip)) { ws.close(1008, 'Bloqueado'); return; }
            const cid = generarId();
            voiceClients.set(cid, { ws, estado: 'recopilando', datos: {}, alternativa: null, ip });
            ws.on('message', async (data) => {
                try { const m = JSON.parse(data); if (m.tipo === 'transcripcion') { const r = await procesarComandoVoz(m.texto, cid, ip); if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ tipo: 'respuesta', texto: r })); } }
                catch (e) { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ tipo: 'respuesta', texto: 'Error. Intentá de nuevo.' })); }
            });
            ws.on('close', () => voiceClients.delete(cid));
            ws.on('error', () => voiceClients.delete(cid));
        });
    } catch (e) { console.error('❌ Fatal:', e); process.exit(1); }
}

process.on('SIGTERM', () => { guardarBloqueos(); process.exit(0); });
process.on('SIGINT', () => { guardarBloqueos(); process.exit(0); });
start();
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
const HORARIOS_FILE = path.join(__dirname, 'horarios.json');
const PALABRAS_BANEADAS_FILE = path.join(__dirname, 'palabras-baneadas.json');
const CANCELACIONES_FILE = path.join(__dirname, 'cancelaciones.json');
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
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// ==================== CONSTANTES ====================
let HORAS_VALIDAS = [12, 16, 20];
let DIAS_VALIDOS = ['lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado'];

// ==================== SISTEMA DE CANCELACIONES ====================
let cancelacionesPorIP = new Map();

async function cargarCancelaciones() {
    try {
        if (fsSync.existsSync(CANCELACIONES_FILE)) {
            const data = JSON.parse(await fs.readFile(CANCELACIONES_FILE, 'utf8'));
            cancelacionesPorIP = new Map(Object.entries(data.cancelaciones || {}));
            const ahora = Date.now();
            for (const [ip, datos] of cancelacionesPorIP) {
                if (ahora - datos.firstCancelTime > 3600000) {
                    cancelacionesPorIP.delete(ip);
                }
            }
            await guardarCancelaciones();
        } else {
            await guardarCancelaciones();
        }
    } catch(e) {
        console.error('Error cargando cancelaciones:', e);
        await guardarCancelaciones();
    }
}

async function guardarCancelaciones() {
    try {
        await fs.writeFile(CANCELACIONES_FILE, JSON.stringify({
            cancelaciones: Object.fromEntries(cancelacionesPorIP)
        }, null, 2), 'utf8');
    } catch(e) {
        console.error('Error guardando cancelaciones:', e);
    }
}

function registrarCancelacion(ip, telefono, codigoCancelacion) {
    const ahora = Date.now();
    const ipLimpia = ip.replace('::ffff:', '');
    
    if (!cancelacionesPorIP.has(ipLimpia)) {
        cancelacionesPorIP.set(ipLimpia, {
            count: 1,
            firstCancelTime: ahora,
            cancelaciones: [{
                fecha: ahora,
                telefono: telefono,
                codigo: codigoCancelacion
            }]
        });
    } else {
        const datos = cancelacionesPorIP.get(ipLimpia);
        if (ahora - datos.firstCancelTime < 3600000) {
            datos.count++;
            datos.cancelaciones.push({
                fecha: ahora,
                telefono: telefono,
                codigo: codigoCancelacion
            });
            
            if (datos.count >= 3) {
                bloquearIP(ipLimpia, `3 cancelaciones en menos de 1 hora (${datos.count} cancelaciones)`, 'ABUSO DE CANCELACIONES', null, false);
                console.log(`🚫 IP ${ipLimpia} bloqueada por ${datos.count} cancelaciones en 1 hora`);
            }
        } else {
            cancelacionesPorIP.set(ipLimpia, {
                count: 1,
                firstCancelTime: ahora,
                cancelaciones: [{
                    fecha: ahora,
                    telefono: telefono,
                    codigo: codigoCancelacion
                }]
            });
        }
    }
    guardarCancelaciones();
}

// ==================== CONFIGURACIÓN DE HORARIOS ====================
let horariosConfig = {
    dias: ['lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado'],
    horarios: ['12:00', '16:00', '20:00']
};

// ==================== PALABRAS BANEADAS ====================
let palabrasBaneadas = [
    'puta', 'puto', 'mierda', 'coño', 'carajo', 'verga', 'chinga', 'chingue',
    'fuck', 'shit', 'bitch', 'asshole', 'motherfucker', 'cunt',
    'idiota', 'estupido', 'imbecil', 'tarado', 'estúpido', 'imbécil',
    'pendejo', 'cabron', 'cabrón', 'hijodeputa', 'hijo de puta',
    'malparido', 'gonorrea', 'carechimba', 'carepicha', 'concha su madre',
    'culo', 'cojones', 'pelotudo', 'boludo', 'forro', 'mogólico'
];

async function cargarPalabrasBaneadas() {
    try {
        if (fsSync.existsSync(PALABRAS_BANEADAS_FILE)) {
            const data = JSON.parse(await fs.readFile(PALABRAS_BANEADAS_FILE, 'utf8'));
            palabrasBaneadas = data.palabras || palabrasBaneadas;
            console.log('✅ Palabras baneadas cargadas:', palabrasBaneadas.length);
        } else {
            await guardarPalabrasBaneadas();
        }
    } catch(e) {
        console.error('Error cargando palabras baneadas:', e);
        await guardarPalabrasBaneadas();
    }
}

async function guardarPalabrasBaneadas() {
    try {
        await fs.writeFile(PALABRAS_BANEADAS_FILE, JSON.stringify({ palabras: palabrasBaneadas }, null, 2), 'utf8');
        console.log('✅ Palabras baneadas guardadas');
    } catch(e) {
        console.error('Error guardando palabras baneadas:', e);
    }
}

function contienePalabraBaneada(texto) {
    if (!texto) return null;
    const textoLower = texto.toLowerCase();
    for (const palabra of palabrasBaneadas) {
        if (textoLower.includes(palabra.toLowerCase())) {
            return palabra;
        }
    }
    return null;
}

// ==================== SISTEMA DE BLOQUEOS MEJORADO ====================
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
                if (ahora > datos.hasta && !datos.permanente) bloqueos.delete(ip);
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
    const ipLimpia = ip.replace('::ffff:', '');
    if (bloqueos.has(ipLimpia)) {
        const datos = bloqueos.get(ipLimpia);
        if (datos.permanente) return true;
        if (Date.now() < datos.hasta) return true;
        bloqueos.delete(ipLimpia);
        guardarBloqueos();
    }
    return false;
}

function bloquearIP(ip, motivo, tipo = 'Desconocido', palabraOfensiva = null, permanente = false) {
    const ipLimpia = ip.replace('::ffff:', '');
    const duracion = permanente ? 31536000000 : 3600000;
    
    bloqueos.set(ipLimpia, {
        hasta: Date.now() + duracion,
        motivo: motivo,
        tipoAtaque: tipo,
        fecha: new Date().toISOString(),
        ip: ipLimpia,
        intentos: (intentosFallidos.get(ipLimpia)?.count || 0),
        permanente: permanente,
        palabraOfensiva: palabraOfensiva
    });
    
    historialBloqueos.unshift({ 
        ...bloqueos.get(ipLimpia), 
        id: generarId()
    });
    
    guardarBloqueos();
    
    // Limpiar datos asociados
    intentosFallidos.delete(ipLimpia);
    cancelacionesPorIP.delete(ipLimpia);
    turnosRecientesIP.delete(ipLimpia);
    turnosRecientesTel.delete(ipLimpia);
    
    console.log(`🔒 IP ${ipLimpia} BLOQUEADA: ${motivo} (${permanente ? 'PERMANENTE' : '1 hora'})`);
}

function desbloquearIP(ip) {
    const ipLimpia = ip.replace('::ffff:', '');
    bloqueos.delete(ipLimpia);
    intentosFallidos.delete(ipLimpia);
    cancelacionesPorIP.delete(ipLimpia);
    guardarBloqueos();
    console.log(`🔓 IP ${ipLimpia} DESBLOQUEADA`);
}

function registrarIntento(ip, tipo, detalles = '') {
    const ipLimpia = ip.replace('::ffff:', '');
    const ahora = Date.now();
    
    if (!intentosFallidos.has(ipLimpia)) {
        intentosFallidos.set(ipLimpia, { count: 1, first: ahora, tipo, detalles });
        return false;
    }
    
    const d = intentosFallidos.get(ipLimpia);
    if (ahora - d.first > 600000) {
        intentosFallidos.set(ipLimpia, { count: 1, first: ahora, tipo, detalles });
        return false;
    }
    
    d.count++;
    d.tipo = tipo;
    d.detalles = detalles;
    
    if (d.count >= 5) {
        bloquearIP(ipLimpia, `5+ intentos sospechosos: ${tipo}`, tipo);
        intentosFallidos.delete(ipLimpia);
        return true;
    }
    return false;
}

function checkRateIP(ip) {
    const ipLimpia = ip.replace('::ffff:', '');
    limpiarViejos(turnosRecientesIP, 3600000);
    return (turnosRecientesIP.get(ipLimpia) || []).length < 3;
}

function checkRateTel(tel) {
    limpiarViejos(turnosRecientesTel, 86400000);
    return (turnosRecientesTel.get(tel) || []).length < 2;
}

function regTurno(ip, tel) {
    const ipLimpia = ip.replace('::ffff:', '');
    const ahora = Date.now();
    
    if (!turnosRecientesIP.has(ipLimpia)) turnosRecientesIP.set(ipLimpia, []);
    turnosRecientesIP.get(ipLimpia).push(ahora);
    
    if (!turnosRecientesTel.has(tel)) turnosRecientesTel.set(tel, []);
    turnosRecientesTel.get(tel).push(ahora);
}

function limpiarViejos(mapa, ventana) {
    const ahora = Date.now();
    for (const [k, a] of mapa) {
        mapa.set(k, a.filter(t => ahora - t < ventana));
        if (!mapa.get(k).length) mapa.delete(k);
    }
}

// ==================== SISTEMA DE PAÍSES ====================
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
            console.log('✅ Países cargados');
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

// ==================== FUNCIONES DE VALIDACIÓN ====================
function esFechaValida(dia) {
    const diasSemana = ['domingo', 'lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado'];
    const hoy = new Date();
    const diaActual = diasSemana[hoy.getDay()];
    const indiceDia = DIAS_VALIDOS.indexOf(dia);
    const indiceHoy = DIAS_VALIDOS.indexOf(diaActual);
    
    if (indiceDia === -1) return false;
    if (indiceDia > indiceHoy) return true;
    if (indiceDia === indiceHoy) return true;
    return false;
}

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

function generarCodigoCancelacion() {
    const caracteres = 'ABCDEFGHJKLMNPQRSTUVWXYZ0123456789';
    let codigo = '';
    for (let i = 0; i < 6; i++) {
        codigo += caracteres[Math.floor(Math.random() * caracteres.length)];
    }
    return codigo;
}

// ==================== MIDDLEWARE DE BLOQUEO - APLICA A TODAS LAS RUTAS ====================
app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    next();
});

// Middleware de verificación de IP bloqueada - PARA TODAS LAS RUTAS
app.use((req, res, next) => {
    const ip = req.ip || req.socket.remoteAddress || '0.0.0.0';
    
    if (estaBloqueado(ip)) {
        const bloqueo = bloqueos.get(ip.replace('::ffff:', ''));
        return res.status(403).send(`
            <!DOCTYPE html>
            <html lang="es">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>Servicio Suspendido | Serenity Spa</title>
                <style>
                    *{margin:0;padding:0;box-sizing:border-box}
                    body{
                        font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
                        background: linear-gradient(135deg, #0a0806 0%, #1a1008 100%);
                        min-height: 100vh;
                        display: flex;
                        align-items: center;
                        justify-content: center;
                        padding: 1rem;
                    }
                    .suspension-card{
                        max-width: 550px;
                        background: rgba(30, 25, 20, 0.95);
                        backdrop-filter: blur(10px);
                        border-radius: 28px;
                        border: 1px solid rgba(201, 168, 122, 0.3);
                        padding: 2.5rem;
                        text-align: center;
                        box-shadow: 0 20px 40px rgba(0,0,0,0.4);
                        animation: fadeIn 0.5s ease-out;
                    }
                    @keyframes fadeIn{
                        from{opacity:0;transform:translateY(-20px)}
                        to{opacity:1;transform:translateY(0)}
                    }
                    .icono-suspension{
                        width: 80px;
                        height: 80px;
                        background: rgba(220, 38, 38, 0.15);
                        border-radius: 50%;
                        display: flex;
                        align-items: center;
                        justify-content: center;
                        margin: 0 auto 1.5rem;
                        border: 1px solid rgba(220, 38, 38, 0.3);
                    }
                    .icono-suspension i{
                        font-size: 2.8rem;
                        color: #dc2626;
                    }
                    h1{
                        font-family: 'Georgia', serif;
                        color: #dc2626;
                        font-size: 1.6rem;
                        margin-bottom: 0.5rem;
                    }
                    .badge{
                        display: inline-block;
                        background: rgba(220, 38, 38, 0.2);
                        padding: 0.3rem 1rem;
                        border-radius: 40px;
                        font-size: 0.7rem;
                        color: #dc2626;
                        margin-bottom: 1.5rem;
                        border: 1px solid rgba(220, 38, 38, 0.3);
                    }
                    p{
                        color: #d4c5a9;
                        line-height: 1.6;
                        margin-bottom: 1rem;
                    }
                    .motivo{
                        background: rgba(0,0,0,0.4);
                        border-radius: 12px;
                        padding: 1rem;
                        margin: 1.5rem 0;
                        font-size: 0.85rem;
                        border-left: 3px solid #dc2626;
                        text-align: left;
                    }
                    .motivo strong{
                        color: #c9a87a;
                    }
                    .motivo .text-danger{
                        color: #dc2626;
                    }
                    .btn-home{
                        display: inline-block;
                        background: rgba(201,168,122,0.15);
                        border: 1px solid rgba(201,168,122,0.4);
                        color: #c9a87a;
                        padding: 0.7rem 1.5rem;
                        border-radius: 40px;
                        text-decoration: none;
                        font-size: 0.85rem;
                        transition: all 0.3s;
                        margin-top: 1rem;
                    }
                    .btn-home:hover{
                        background: rgba(201,168,122,0.3);
                        border-color: #c9a87a;
                    }
                    .footer{
                        margin-top: 1.5rem;
                        font-size: 0.7rem;
                        color: rgba(212, 197, 169, 0.5);
                    }
                    .separator{
                        height: 1px;
                        background: linear-gradient(90deg, transparent, rgba(201,168,122,0.3), transparent);
                        margin: 1rem 0;
                    }
                </style>
                <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
            </head>
            <body>
                <div class="suspension-card">
                    <div class="icono-suspension">
                        <i class="fas fa-gavel"></i>
                    </div>
                    <h1>Servicio Suspendido</h1>
                    <div class="badge">
                        <i class="fas fa-ban"></i> Acceso Restringido
                    </div>
                    <p>El servicio ha sido suspendido debido a usos indebidos y violación de los términos de conducta de Serenity Spa.</p>
                    <div class="motivo">
                        <strong><i class="fas fa-shield-alt"></i> Motivo de la suspensión:</strong><br>
                        <span class="text-danger">⚠️ ${escapeHtml(bloqueo?.motivo || 'Actividad sospechosa detectada')}</span><br><br>
                        <strong><i class="fas fa-clock"></i> Fecha:</strong> ${new Date(bloqueo?.fecha || Date.now()).toLocaleString()}<br>
                        <strong><i class="fas fa-microchip"></i> Identificador:</strong> ${escapeHtml(ip.replace('::ffff:', ''))}<br>
                        ${bloqueo?.palabraOfensiva ? `<strong><i class="fas fa-comment-slash"></i> Palabra ofensiva:</strong> "<span class="text-danger">${escapeHtml(bloqueo.palabraOfensiva)}</span>"<br>` : ''}
                        ${bloqueo?.permanente ? '<strong><i class="fas fa-lock"></i> Estado:</strong> Suspensión permanente' : '<strong><i class="fas fa-hourglass-half"></i> Estado:</strong> Suspensión temporal'}
                    </div>
                    <div class="separator"></div>
                    <p><i class="fas fa-info-circle"></i> Si considera que esto es un error, por favor contacte a nuestro equipo de soporte.</p>
                    <a href="/" class="btn-home"><i class="fas fa-home"></i> Volver al inicio</a>
                    <div class="footer">
                        Serenity Spa - Todos los derechos reservados
                    </div>
                </div>
            </body>
            </html>
        `);
    }
    next();
});

// Middleware para detectar palabras ofensivas en el nombre
app.use((req, res, next) => {
    if (req.body && req.body.nombre) {
        const palabraOfensiva = contienePalabraBaneada(req.body.nombre);
        if (palabraOfensiva) {
            const ip = req.ip || req.socket.remoteAddress || '0.0.0.0';
            bloquearIP(ip, `Uso de lenguaje ofensivo: "${req.body.nombre}" contiene "${palabraOfensiva}"`, 'LENGUAJE OFENSIVO', palabraOfensiva, false);
            return res.status(403).json({ error: 'Servicio suspendido por uso de lenguaje inapropiado.' });
        }
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

// ==================== RUTAS API ====================

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

// ==================== API PALABRAS BANEADAS ====================
app.get('/api/palabras-baneadas', (req, res) => {
    if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    res.json({ palabras: palabrasBaneadas });
});

app.post('/api/palabras-baneadas', async (req, res) => {
    if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    const { palabra, accion } = req.body;
    
    if (accion === 'agregar') {
        if (!palabra || palabra.length < 2) {
            return res.status(400).json({ error: 'Palabra inválida' });
        }
        if (!palabrasBaneadas.includes(palabra.toLowerCase())) {
            palabrasBaneadas.push(palabra.toLowerCase());
            await guardarPalabrasBaneadas();
        }
    } else if (accion === 'eliminar') {
        palabrasBaneadas = palabrasBaneadas.filter(p => p !== palabra);
        await guardarPalabrasBaneadas();
    }
    
    res.json({ ok: true, palabras: palabrasBaneadas });
});

// ==================== API CANCELACIONES ====================
app.get('/api/cancelaciones/stats', (req, res) => {
    if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    const stats = [];
    for (const [ip, datos] of cancelacionesPorIP) {
        stats.push({
            ip: ip,
            count: datos.count,
            firstCancelTime: datos.firstCancelTime,
            cancelaciones: datos.cancelaciones
        });
    }
    res.json(stats);
});

// ==================== CONFIGURACIÓN ====================
async function cargarHorarios() {
    try {
        if (fsSync.existsSync(HORARIOS_FILE)) {
            const data = JSON.parse(await fs.readFile(HORARIOS_FILE, 'utf8'));
            horariosConfig = data;
            actualizarHorariosGlobales();
        } else {
            await guardarHorarios();
        }
    } catch(e) {
        console.error('Error cargando horarios:', e);
        await guardarHorarios();
    }
}

async function guardarHorarios() {
    try {
        await fs.writeFile(HORARIOS_FILE, JSON.stringify(horariosConfig, null, 2), 'utf8');
    } catch(e) {
        console.error('Error guardando horarios:', e);
    }
}

function actualizarHorariosGlobales() {
    HORAS_VALIDAS = horariosConfig.horarios.map(h => parseInt(h.split(':')[0])).filter(h => !isNaN(h));
    DIAS_VALIDOS = horariosConfig.dias;
    if (HORAS_VALIDAS.length === 0) HORAS_VALIDAS = [12, 16, 20];
    if (DIAS_VALIDOS.length === 0) DIAS_VALIDOS = ['lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado'];
}

app.get('/api/config/horarios', (req, res) => {
    res.json(horariosConfig);
});

app.put('/api/config/horarios', async (req, res) => {
    if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    try {
        const { dias, horarios } = req.body;
        if (dias && Array.isArray(dias)) horariosConfig.dias = dias;
        if (horarios && Array.isArray(horarios)) horariosConfig.horarios = horarios;
        await guardarHorarios();
        actualizarHorariosGlobales();
        res.json({ ok: true });
    } catch(e) {
        res.status(500).json({ error: 'Error' });
    }
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
    if (estaBloqueado(ip)) return res.status(403).json({ error: 'Servicio suspendido por uso indebido' });
    if (!checkRateIP(ip)) {
        bloquearIP(ip, 'Exceso de solicitudes', 'SPAM');
        return res.status(429).json({ error: 'Demasiadas solicitudes.' });
    }
    
    try {
        const { nombre, dia, hora, massageType, telefono, ubicacion, tipoServicio, codigoPais } = req.body;
        
        const palabraOfensiva = contienePalabraBaneada(nombre);
        if (palabraOfensiva) {
            bloquearIP(ip, `Lenguaje ofensivo: "${nombre}" contiene "${palabraOfensiva}"`, 'LENGUAJE OFENSIVO', palabraOfensiva, false);
            return res.status(403).json({ error: 'Servicio suspendido por uso de lenguaje inapropiado.' });
        }
        
        if (!nombre || nombre.length < 2) {
            return res.status(400).json({ error: 'Nombre inválido' });
        }
        
        const tel = telefono ? telefono.replace(/\D/g, '') : '';
        if (!tel || tel.length < 7) {
            return res.status(400).json({ error: 'Teléfono inválido' });
        }
        
        let codPais = codigoPais || '53';
        if (!/^\d{1,3}$/.test(codPais)) codPais = '53';
        
        if (!paisAutorizado(codPais)) {
            return res.status(403).json({ error: 'País no autorizado' });
        }
        
        let diaLower = dia.toLowerCase();
        if (!diaLower || !DIAS_VALIDOS.includes(diaLower)) {
            return res.status(400).json({ error: `Día inválido` });
        }
        
        if (!esFechaValida(diaLower)) {
            return res.status(400).json({ error: `No se puede reservar para un día que ya pasó` });
        }
        
        const hn = parseInt(hora);
        if (!HORAS_VALIDAS.includes(hn)) {
            return res.status(400).json({ error: `Hora inválida` });
        }
        
        if (!checkRateTel(tel)) {
            return res.status(429).json({ error: 'Máximo 2 turnos por teléfono por día.' });
        }
        
        const turnos = await loadTurnos();
        
        if (turnos.some(t => t.telefono === tel && t.dia === diaLower)) {
            return res.status(409).json({ error: 'Ya tienes un turno para ese día.' });
        }
        
        if (turnos.some(t => t.dia === diaLower && t.hora === hn)) {
            const alternativa = buscarAlternativa(diaLower, hn, turnos);
            if (alternativa) {
                return res.status(409).json({ 
                    error: 'Horario ocupado', 
                    alternativa: alternativa
                });
            }
            return res.status(409).json({ error: 'Horario ocupado' });
        }
        
        const codigoCancelacion = generarCodigoCancelacion();
        
        const nuevo = {
            id: generarId(),
            nombre: escapeHtml(sanitize(nombre)),
            dia: diaLower,
            hora: hn,
            massageType: massageType || 'Masaje',
            telefono: tel,
            codigoPais: codPais,
            ubicacion: ubicacion || paisesConfig.ubicacionSalon,
            tipoServicio: tipoServicio || 'salon',
            confirmadoWhatsApp: false,
            fechaCreacion: new Date().toISOString(),
            ip: ip.replace('::ffff:', ''),
            codigoCancelacion: codigoCancelacion
        };
        
        turnos.push(nuevo);
        await saveTurnos(turnos);
        regTurno(ip, tel);
        intentosFallidos.delete(ip);
        
        res.status(201).json({ 
            mensaje: 'Turno reservado', 
            turno: nuevo,
            codigoCancelacion: codigoCancelacion
        });
    } catch(e) {
        console.error('Error:', e);
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

app.post('/api/cancelar-por-codigo', async (req, res) => {
    const ip = req.ip || '0.0.0.0';
    const { codigo, telefono } = req.body;
    
    if (!codigo || codigo.length !== 6) {
        return res.status(400).json({ error: 'Código inválido' });
    }
    
    const resultado = await cancelarPorCodigo(codigo.toUpperCase(), ip, telefono);
    res.json(resultado);
});

// ==================== BLOQUEOS API ====================
app.get('/api/seguridad/bloqueos', (req, res) => {
    if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    const activos = [];
    for (const [ip, d] of bloqueos) {
        activos.push({
            ip,
            motivo: d.motivo,
            tipoAtaque: d.tipoAtaque,
            fecha: d.fecha,
            tiempoRestante: Math.max(0, d.hasta - Date.now()),
            tiempoRestanteFormateado: fmtT(Math.max(0, d.hasta - Date.now())),
            intentos: d.intentos || 0,
            permanente: d.permanente || false,
            palabraOfensiva: d.palabraOfensiva || null
        });
    }
    res.json({
        activos: activos,
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
    guardarBloqueos();
    res.json({ ok: true });
});

app.post('/api/seguridad/bloquear-permanente/:ip', (req, res) => {
    if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    bloquearIP(req.params.ip, 'Bloqueo permanente por administrador', 'MANUAL', null, true);
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
        if (now > d.hasta && !d.permanente) { 
            bloqueos.delete(ip); 
            b++; 
        }
    }
    guardarBloqueos();
    res.json({ mensaje: `${b} bloqueos eliminados` });
});

// ==================== RUTAS ESTÁTICAS ====================
app.get('/voice-assistant', (req, res) => res.sendFile(path.join(__dirname, 'voice-assistant.html')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/admin.html', (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));
app.get('/login.html', (req, res) => res.sendFile(path.join(__dirname, 'login.html')));
app.get('/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        timestamp: new Date().toISOString(), 
        uptime: process.uptime()
    });
});

// ==================== INICIALIZACIÓN ====================
async function start() {
    await cargarBloqueos();
    await cargarPaises();
    await cargarHorarios();
    await cargarPalabrasBaneadas();
    await cargarCancelaciones();
    
    // Cargar servicios por defecto
    try {
        if (fsSync.existsSync(SERVICIOS_FILE)) {
            serviciosData = JSON.parse(await fs.readFile(SERVICIOS_FILE, 'utf8'));
        } else {
            serviciosData = [
                { id: "relajante", nombre: "Masaje Relajante", precio: "$45", descripcion: "Movimientos suaves y armónicos para liberar el estrés.", beneficios: ["60 Minutos"], efectos: ["Relajación profunda"], imagenWeb: "https://images.unsplash.com/photo-1544161515-4ab6ce6db874?w=800", orden: 1 },
                { id: "corporal", nombre: "Masaje Corporal", precio: "$65", descripcion: "Tratamiento completo para una relajación profunda.", beneficios: ["90 Minutos"], efectos: ["Activación linfática"], imagenWeb: "https://images.unsplash.com/photo-1519823551278-64ac92734fb1?w=800", orden: 2 },
                { id: "facial", nombre: "Masaje Facial", precio: "$40", descripcion: "Rejuvenece la piel y alivia la tensión facial.", beneficios: ["45 Minutos"], efectos: ["Estimula colágeno"], imagenWeb: "https://images.unsplash.com/photo-1570172619644-dfd03ed5d881?w=800", orden: 3 }
            ];
            await fs.writeFile(SERVICIOS_FILE, JSON.stringify(serviciosData, null, 2), 'utf8');
        }
    } catch(e) {
        console.error('Error cargando servicios:', e);
    }

    const server = app.listen(PORT, '0.0.0.0', () => {
        console.log(`🌿 Serenity Spa iniciado en puerto ${PORT}`);
        console.log(`📅 Días: ${DIAS_VALIDOS.join(', ')}`);
        console.log(`⏰ Horarios: ${horariosConfig.horarios.join(', ')}`);
        console.log(`🔑 Palabras baneadas: ${palabrasBaneadas.length}`);
        console.log(`🔒 Sistema de seguridad activo`);
    });
}

process.on('SIGTERM', async () => { 
    await guardarBloqueos(); 
    await guardarPaises(); 
    await guardarHorarios(); 
    await guardarPalabrasBaneadas();
    await guardarCancelaciones();
    process.exit(0); 
});

start();
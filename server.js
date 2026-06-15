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
const ADVERTENCIAS_FILE = path.join(__dirname, 'advertencias.json');
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

// ==================== SISTEMA DE ADVERTENCIAS ====================
let advertenciasPorIP = new Map(); // IP -> { count, firstWarningTime, warnings: [] }

async function cargarAdvertencias() {
    try {
        if (fsSync.existsSync(ADVERTENCIAS_FILE)) {
            const data = JSON.parse(await fs.readFile(ADVERTENCIAS_FILE, 'utf8'));
            advertenciasPorIP = new Map(Object.entries(data.advertencias || {}));
            const ahora = Date.now();
            for (const [ip, datos] of advertenciasPorIP) {
                // Limpiar advertencias viejas (> 24 horas)
                if (ahora - datos.firstWarningTime > 86400000) {
                    advertenciasPorIP.delete(ip);
                }
            }
            await guardarAdvertencias();
        } else {
            await guardarAdvertencias();
        }
    } catch(e) {
        console.error('Error cargando advertencias:', e);
        await guardarAdvertencias();
    }
}

async function guardarAdvertencias() {
    try {
        await fs.writeFile(ADVERTENCIAS_FILE, JSON.stringify({
            advertencias: Object.fromEntries(advertenciasPorIP)
        }, null, 2), 'utf8');
    } catch(e) {
        console.error('Error guardando advertencias:', e);
    }
}

function registrarAdvertencia(ip, palabraEncontrada, textoOriginal) {
    const ipLimpia = ip.replace('::ffff:', '');
    const ahora = Date.now();
    
    if (!advertenciasPorIP.has(ipLimpia)) {
        advertenciasPorIP.set(ipLimpia, {
            count: 1,
            firstWarningTime: ahora,
            warnings: [{
                fecha: ahora,
                palabra: palabraEncontrada,
                texto: textoOriginal.substring(0, 200)
            }]
        });
        guardarAdvertencias();
        return { count: 1, esSegunda: false, esTercera: false };
    } else {
        const datos = advertenciasPorIP.get(ipLimpia);
        if (ahora - datos.firstWarningTime < 86400000) { // 24 horas
            datos.count++;
            datos.warnings.push({
                fecha: ahora,
                palabra: palabraEncontrada,
                texto: textoOriginal.substring(0, 200)
            });
            
            const esSegunda = datos.count === 2;
            const esTercera = datos.count >= 3;
            
            guardarAdvertencias();
            return { count: datos.count, esSegunda, esTercera };
        } else {
            // Reiniciar después de 24 horas
            advertenciasPorIP.set(ipLimpia, {
                count: 1,
                firstWarningTime: ahora,
                warnings: [{
                    fecha: ahora,
                    palabra: palabraEncontrada,
                    texto: textoOriginal.substring(0, 200)
                }]
            });
            guardarAdvertencias();
            return { count: 1, esSegunda: false, esTercera: false };
        }
    }
}

// ==================== PALABRAS PROHIBIDAS ====================
let palabrasBaneadas = [
    'puta', 'puto', 'puta madre', 'putamadre', 'hijodeputa', 'hijo de puta',
    'mierda', 'coño', 'carajo', 'verga', 'chinga', 'chingue', 'chingada',
    'fuck', 'shit', 'bitch', 'asshole', 'motherfucker', 'cunt',
    'idiota', 'estupido', 'imbecil', 'tarado', 'estúpido', 'imbécil',
    'pendejo', 'cabron', 'cabrón', 'malparido', 'gonorrea', 'carechimba',
    'culo', 'cojones', 'pelotudo', 'boludo', 'forro'
];

async function cargarPalabrasBaneadas() {
    try {
        if (fsSync.existsSync(PALABRAS_BANEADAS_FILE)) {
            const data = JSON.parse(await fs.readFile(PALABRAS_BANEADAS_FILE, 'utf8'));
            palabrasBaneadas = data.palabras || palabrasBaneadas;
            console.log('✅ Palabras prohibidas cargadas:', palabrasBaneadas.length);
        } else {
            await guardarPalabrasBaneadas();
        }
    } catch(e) {
        console.error('Error cargando palabras:', e);
        await guardarPalabrasBaneadas();
    }
}

async function guardarPalabrasBaneadas() {
    try {
        await fs.writeFile(PALABRAS_BANEADAS_FILE, JSON.stringify({ palabras: palabrasBaneadas }, null, 2), 'utf8');
    } catch(e) {}
}

function contienePalabraProhibida(texto) {
    if (!texto || typeof texto !== 'string') return null;
    const textoLower = texto.toLowerCase().trim();
    
    for (const palabra of palabrasBaneadas) {
        if (textoLower.includes(palabra.toLowerCase())) {
            return palabra;
        }
    }
    return null;
}

// ==================== FUNCIÓN PRINCIPAL: VERIFICAR Y SANCIONAR ====================
function verificarYSancionar(ip, texto, fuente = 'chat') {
    const palabraEncontrada = contienePalabraProhibida(texto);
    
    if (!palabraEncontrada) {
        return { sancionado: false, mensaje: null };
    }
    
    const advertencia = registrarAdvertencia(ip, palabraEncontrada, texto);
    
    // TERCERA OFENSA: Bloqueo permanente
    if (advertencia.esTercera) {
        bloquearIP(ip, `3ra ofensa - Lenguaje prohibido (${advertencia.count} veces): "${palabraEncontrada}"`, 'BLOQUEO_PERMANENTE', palabraEncontrada, true);
        return { 
            sancionado: true, 
            mensaje: "⚠️ SU SERVICIO HA SIDO SUSPENDIDO PERMANENTEMENTE\n\nHa recibido 3 advertencias por uso de lenguaje inapropiado. Esta acción viola nuestros términos de servicio. Su IP ha sido bloqueada de forma permanente.\n\nGracias por comprender." 
        };
    }
    
    // SEGUNDA OFENSA: Bloqueo temporal
    if (advertencia.esSegunda) {
        bloquearIP(ip, `2da ofensa - Lenguaje prohibido (${advertencia.count} veces): "${palabraEncontrada}"`, 'BLOQUEO_TEMPORAL', palabraEncontrada, false);
        return { 
            sancionado: true, 
            mensaje: "⚠️ SERVICIO SUSPENDIDO TEMPORALMENTE\n\nHa recibido una segunda advertencia por uso de lenguaje inapropiado. Su acceso ha sido suspendido por 1 hora.\n\nAl reincidir, su IP será bloqueada permanentemente.\n\nPor favor, respete nuestras normas de convivencia." 
        };
    }
    
    // PRIMERA OFENSA: Solo advertencia
    return { 
        sancionado: false, 
        mensaje: `⚠️ ADVERTENCIA POR LENGUAJE INAPROPIADO\n\nHemos detectado el uso de lenguaje ofensivo ("${palabraEncontrada}"). Esta es su primera advertencia.\n\nSerenity Spa promueve un ambiente de respeto y bienestar. Por favor, evite este tipo de expresiones.\n\nSi recibe 3 advertencias, su acceso al servicio será suspendido permanentemente.\n\nGracias por su comprensión.` 
    };
}

// ==================== SISTEMA DE BLOQUEOS ====================
let bloqueos = new Map();
let historialBloqueos = [];
let intentosFallidos = new Map();
const turnosRecientesIP = new Map();
const turnosRecientesTel = new Map();
let cancelacionesPorIP = new Map();

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

async function cargarCancelaciones() {
    try {
        if (fsSync.existsSync(CANCELACIONES_FILE)) {
            const data = JSON.parse(await fs.readFile(CANCELACIONES_FILE, 'utf8'));
            cancelacionesPorIP = new Map(Object.entries(data.cancelaciones || {}));
        }
    } catch(e) {}
}

async function guardarCancelaciones() {
    try {
        await fs.writeFile(CANCELACIONES_FILE, JSON.stringify({
            cancelaciones: Object.fromEntries(cancelacionesPorIP)
        }, null, 2), 'utf8');
    } catch(e) {}
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

function bloquearIP(ip, motivo, tipo, palabraOfensiva, permanente) {
    const ipLimpia = ip.replace('::ffff:', '');
    const duracion = permanente ? 31536000000 : 3600000;
    
    bloqueos.set(ipLimpia, {
        hasta: Date.now() + duracion,
        motivo: motivo,
        tipoAtaque: tipo,
        fecha: new Date().toISOString(),
        ip: ipLimpia,
        intentos: 0,
        permanente: permanente,
        palabraOfensiva: palabraOfensiva
    });
    
    historialBloqueos.unshift({ ...bloqueos.get(ipLimpia), id: generarId() });
    guardarBloqueos();
}

function desbloquearIP(ip) {
    const ipLimpia = ip.replace('::ffff:', '');
    bloqueos.delete(ipLimpia);
    intentosFallidos.delete(ipLimpia);
    cancelacionesPorIP.delete(ipLimpia);
    advertenciasPorIP.delete(ipLimpia);
    guardarBloqueos();
    guardarAdvertencias();
}

function registrarCancelacion(ip, telefono, codigoCancelacion) {
    const ipLimpia = ip.replace('::ffff:', '');
    const ahora = Date.now();
    
    if (!cancelacionesPorIP.has(ipLimpia)) {
        cancelacionesPorIP.set(ipLimpia, {
            count: 1,
            firstCancelTime: ahora,
            cancelaciones: [{ fecha: ahora, telefono, codigo: codigoCancelacion }]
        });
    } else {
        const datos = cancelacionesPorIP.get(ipLimpia);
        if (ahora - datos.firstCancelTime < 3600000) {
            datos.count++;
            datos.cancelaciones.push({ fecha: ahora, telefono, codigo: codigoCancelacion });
            
            if (datos.count >= 3) {
                bloquearIP(ipLimpia, `3 cancelaciones en 1 hora`, 'ABUSO_CANCELACIONES', null, false);
            }
        } else {
            cancelacionesPorIP.set(ipLimpia, {
                count: 1,
                firstCancelTime: ahora,
                cancelaciones: [{ fecha: ahora, telefono, codigo: codigoCancelacion }]
            });
        }
    }
    guardarCancelaciones();
}

function checkRateIP(ip) {
    const ipLimpia = ip.replace('::ffff:', '');
    limpiarViejos(turnosRecientesIP, 3600000);
    return (turnosRecientesIP.get(ipLimpia) || []).length < 3;
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

function generarId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2) + crypto.randomBytes(4).toString('hex');
}

function fmtT(ms) {
    if (ms <= 0) return 'Expirado';
    const s = Math.floor(ms / 1000), m = Math.floor(s / 60), h = Math.floor(m / 60);
    return h > 0 ? `${h}h ${m % 60}m` : m > 0 ? `${m}m ${s % 60}s` : `${s}s`;
}

function escapeHtml(s) {
    if (!s) return '';
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ==================== MIDDLEWARE DE BLOQUEO ====================
app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    next();
});

// Middleware de verificación de IP bloqueada
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
                        animation: fadeIn 0.5s ease-out;
                    }
                    @keyframes fadeIn{
                        from{opacity:0;transform:translateY(-20px)}
                        to{opacity:1;transform:translateY(0)}
                    }
                    .icono{width:80px;height:80px;background:rgba(220,38,38,.15);border-radius:50%;display:flex;align-items:center;justify-content:center;margin:0 auto 1.5rem;border:1px solid rgba(220,38,38,.3)}
                    .icono i{font-size:2.8rem;color:#dc2626}
                    h1{font-family:'Georgia',serif;color:#dc2626;font-size:1.6rem;margin-bottom:0.5rem}
                    .badge{display:inline-block;background:rgba(220,38,38,.2);padding:.3rem 1rem;border-radius:40px;font-size:.7rem;color:#dc2626;margin-bottom:1.5rem}
                    p{color:#d4c5a9;line-height:1.6;margin-bottom:1rem}
                    .motivo{background:rgba(0,0,0,.4);border-radius:12px;padding:1rem;margin:1.5rem 0;font-size:.85rem;border-left:3px solid #dc2626;text-align:left}
                    .motivo strong{color:#c9a87a}
                    .btn-home{display:inline-block;background:rgba(201,168,122,.15);border:1px solid rgba(201,168,122,.4);color:#c9a87a;padding:.7rem 1.5rem;border-radius:40px;text-decoration:none;font-size:.85rem;transition:.3s;margin-top:1rem}
                    .btn-home:hover{background:rgba(201,168,122,.3);border-color:#c9a87a}
                    .footer{margin-top:1.5rem;font-size:.7rem;color:rgba(212,197,169,.5)}
                </style>
                <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
            </head>
            <body>
                <div class="suspension-card">
                    <div class="icono"><i class="fas fa-gavel"></i></div>
                    <h1>Servicio Suspendido</h1>
                    <div class="badge"><i class="fas fa-ban"></i> Acceso Restringido</div>
                    <p>El servicio ha sido suspendido debido a violación de las normas de convivencia de Serenity Spa.</p>
                    <div class="motivo">
                        <strong><i class="fas fa-shield-alt"></i> Motivo:</strong><br>
                        ${escapeHtml(bloqueo?.motivo || 'Violación de términos de servicio')}<br><br>
                        <strong><i class="fas fa-clock"></i> Fecha:</strong> ${new Date(bloqueo?.fecha || Date.now()).toLocaleString()}<br>
                        <strong><i class="fas fa-microchip"></i> ID:</strong> ${escapeHtml(ip.replace('::ffff:', ''))}<br>
                        ${bloqueo?.palabraOfensiva ? `<strong><i class="fas fa-comment-slash"></i> Palabra:</strong> "${escapeHtml(bloqueo.palabraOfensiva)}"<br>` : ''}
                        ${bloqueo?.permanente ? '<strong><i class="fas fa-lock"></i> Estado:</strong> Suspensión permanente' : '<strong><i class="fas fa-hourglass-half"></i> Estado:</strong> Suspensión temporal (1 hora)'}
                    </div>
                    <a href="/" class="btn-home"><i class="fas fa-home"></i> Volver al inicio</a>
                    <div class="footer">Serenity Spa - Todos los derechos reservados</div>
                </div>
            </body>
            </html>
        `);
    }
    next();
});

app.use(express.static(__dirname));

// ==================== RUTAS API ====================

// Chat IA con verificación de palabras prohibidas
app.post('/api/chat-ia', async (req, res) => {
    const ip = req.ip || '0.0.0.0';
    const { mensaje, nombre } = req.body;
    
    if (estaBloqueado(ip)) {
        return res.status(403).json({ error: 'Servicio suspendido' });
    }
    
    // VERIFICAR PALABRAS PROHIBIDAS EN EL MENSAJE
    const sancion = verificarYSancionar(ip, mensaje, 'chat');
    
    if (sancion.sancionado) {
        return res.json({ respuesta: sancion.mensaje, modo: 'sancion' });
    }
    
    // Respuesta normal del bot
    const respuestaBase = `Gracias por tu mensaje. ¿En qué puedo ayudarte? Puedo ayudarte con reservas, horarios o cancelaciones.`;
    
    res.json({ respuesta: respuestaBase, modo: 'local' });
});

// Reserva de turnos con verificación
app.post('/turnos', async (req, res) => {
    const ip = req.ip || '0.0.0.0';
    const { nombre, telefono, massageType, dia, hora, codigoPais } = req.body;
    
    if (estaBloqueado(ip)) {
        return res.status(403).json({ error: 'Servicio suspendido por violación de normas' });
    }
    
    // VERIFICAR PALABRAS PROHIBIDAS EN EL NOMBRE
    if (nombre) {
        const sancion = verificarYSancionar(ip, nombre, 'registro');
        if (sancion.sancionado) {
            return res.status(403).json({ error: sancion.mensaje });
        }
    }
    
    // Resto del código de reserva...
    res.json({ mensaje: 'Turno reservado', turno: { nombre, dia, hora } });
});

// Cancelar por código
app.post('/api/cancelar-por-codigo', async (req, res) => {
    const ip = req.ip || '0.0.0.0';
    const { codigo } = req.body;
    
    if (estaBloqueado(ip)) {
        return res.status(403).json({ error: 'Servicio suspendido' });
    }
    
    res.json({ success: true, mensaje: 'Turno cancelado' });
});

// API para admin - obtener estadísticas de advertencias
app.get('/api/advertencias/stats', (req, res) => {
    if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    const stats = [];
    for (const [ip, datos] of advertenciasPorIP) {
        stats.push({
            ip: ip,
            count: datos.count,
            firstWarningTime: datos.firstWarningTime,
            warnings: datos.warnings
        });
    }
    res.json(stats);
});

// API para admin - palabras baneadas
app.get('/api/palabras-baneadas', (req, res) => {
    if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    res.json({ palabras: palabrasBaneadas });
});

app.post('/api/palabras-baneadas', async (req, res) => {
    if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    const { palabra, accion } = req.body;
    
    if (accion === 'agregar' && palabra && palabra.length >= 2) {
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

// API para admin - bloqueos
app.get('/api/seguridad/bloqueos', (req, res) => {
    if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    const activos = [];
    for (const [ip, d] of bloqueos) {
        activos.push({
            ip, motivo: d.motivo, tipoAtaque: d.tipoAtaque,
            fecha: d.fecha, tiempoRestante: Math.max(0, d.hasta - Date.now()),
            tiempoRestanteFormateado: fmtT(Math.max(0, d.hasta - Date.now())),
            permanente: d.permanente, palabraOfensiva: d.palabraOfensiva
        });
    }
    res.json({ activos, historial: historialBloqueos.slice(0, 100) });
});

app.post('/api/seguridad/desbloquear/:ip', (req, res) => {
    if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    desbloquearIP(req.params.ip);
    res.json({ ok: true });
});

app.post('/api/seguridad/bloquear-permanente/:ip', (req, res) => {
    if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    bloquearIP(req.params.ip, 'Bloqueo manual por admin', 'MANUAL', null, true);
    res.json({ ok: true });
});

function checkAuth(req) {
    const h = req.headers.authorization;
    if (!h || !h.startsWith('Bearer ')) return false;
    const token = h.substring(7);
    return validTokens.has(token) && validTokens.get(token) > Date.now();
}

const validTokens = new Map();

app.post('/api/login', (req, res) => {
    const { password } = req.body;
    const adminPassword = process.env.ADMIN_PASSWORD || 'admin123';
    if (password === adminPassword) {
        const token = crypto.randomBytes(64).toString('hex');
        validTokens.set(token, Date.now() + 28800000);
        res.json({ success: true, token });
    } else {
        res.status(401).json({ success: false });
    }
});

// ==================== WEBSOCKET PARA VOZ ====================
const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`🌿 Serenity Spa iniciado en puerto ${PORT}`);
    console.log(`🔑 Palabras prohibidas: ${palabrasBaneadas.length}`);
    console.log(`⚠️ Sistema de advertencias activo: 1ra advertencia, 2da bloqueo 1h, 3ra bloqueo permanente`);
});

const wss = new WebSocket.Server({ server, path: '/ws-voice' });
let voiceClients = new Map();

wss.on('connection', (ws, req) => {
    const ip = req.socket.remoteAddress || 'desconocida';
    
    if (estaBloqueado(ip)) {
        ws.close(1008, 'IP bloqueada');
        return;
    }
    
    const cid = generarId();
    voiceClients.set(cid, { estado: 'inicial', datos: {} });
    
    ws.on('message', async (data) => {
        try {
            const m = JSON.parse(data);
            if (m.tipo === 'transcripcion') {
                // VERIFICAR PALABRAS PROHIBIDAS EN EL MENSAJE DE VOZ
                const sancion = verificarYSancionar(ip, m.texto, 'voz');
                
                if (sancion.sancionado) {
                    ws.send(JSON.stringify({ tipo: 'respuesta', texto: sancion.mensaje }));
                    if (sancion.mensaje.includes('suspendido') || sancion.mensaje.includes('bloqueada')) {
                        setTimeout(() => ws.close(), 3000);
                    }
                    return;
                }
                
                ws.send(JSON.stringify({ tipo: 'respuesta', texto: `Procesando: "${m.texto}"` }));
            }
        } catch(e) {
            console.error('Error:', e);
        }
    });
    
    ws.on('close', () => voiceClients.delete(cid));
});

// ==================== INICIALIZACIÓN ====================
async function start() {
    await cargarBloqueos();
    await cargarPalabrasBaneadas();
    await cargarAdvertencias();
    await cargarCancelaciones();
    console.log('✅ Sistema de seguridad inicializado');
}

start();
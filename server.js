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
let serviciosData = [];
let horariosConfig = {
    dias: ['lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado'],
    horarios: ['12:00', '16:00', '20:00']
};

// ==================== PALABRAS PROHIBIDAS ====================
let palabrasBaneadas = [
    'puta', 'puto', 'puta madre', 'putamadre', 'hijodeputa', 'hijo de puta',
    'mierda', 'coño', 'carajo', 'verga', 'chinga', 'chingue', 'chingada',
    'fuck', 'shit', 'bitch', 'asshole', 'motherfucker', 'cunt',
    'idiota', 'estupido', 'imbecil', 'tarado', 'estúpido', 'imbécil',
    'pendejo', 'cabron', 'cabrón', 'malparido', 'gonorrea', 'carechimba',
    'culo', 'cojones', 'pelotudo', 'boludo', 'forro', 'marica', 'maricon'
];

// ==================== SISTEMA DE BLOQUEOS ====================
let bloqueos = new Map();
let historialBloqueos = [];
let intentosFallidos = new Map();
let cancelacionesPorIP = new Map();
const turnosRecientesIP = new Map();

// ==================== FUNCIONES PRINCIPALES ====================
function generarId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2) + crypto.randomBytes(4).toString('hex');
}

function escapeHtml(s) {
    if (!s) return '';
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
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

function bloquearIP(ip, motivo, tipo, palabraOfensiva, permanente = false) {
    const ipLimpia = ip.replace('::ffff:', '');
    const duracion = permanente ? 31536000000 : 3600000;
    
    bloqueos.set(ipLimpia, {
        hasta: Date.now() + duracion,
        motivo: motivo,
        tipoAtaque: tipo,
        fecha: new Date().toISOString(),
        ip: ipLimpia,
        permanente: permanente,
        palabraOfensiva: palabraOfensiva
    });
    
    historialBloqueos.unshift({ 
        ...bloqueos.get(ipLimpia), 
        id: generarId(),
        intentos: 0
    });
    
    cancelacionesPorIP.delete(ipLimpia);
    turnosRecientesIP.delete(ipLimpia);
    intentosFallidos.delete(ipLimpia);
    
    console.log(`🔴 IP BLOQUEADA: ${ipLimpia} - ${motivo}`);
    
    // Guardar inmediatamente en disco
    fs.writeFile(BLOQUEOS_FILE, JSON.stringify({
        bloqueos: Object.fromEntries(bloqueos),
        historial: historialBloqueos.slice(0, 500)
    }, null, 2)).catch(e => console.error('Error guardando:', e));
    
    return ipLimpia;
}

function estaBloqueado(ip) {
    const ipLimpia = ip.replace('::ffff:', '');
    if (bloqueos.has(ipLimpia)) {
        const datos = bloqueos.get(ipLimpia);
        if (datos.permanente) return true;
        if (Date.now() < datos.hasta) return true;
        bloqueos.delete(ipLimpia);
        return false;
    }
    return false;
}

function obtenerBloqueo(ip) {
    const ipLimpia = ip.replace('::ffff:', '');
    if (bloqueos.has(ipLimpia)) {
        const datos = bloqueos.get(ipLimpia);
        if (datos.permanente) return datos;
        if (Date.now() < datos.hasta) return datos;
        bloqueos.delete(ipLimpia);
        return null;
    }
    return null;
}

function verificarYSancionar(ip, texto) {
    const palabraEncontrada = contienePalabraProhibida(texto);
    if (palabraEncontrada) {
        const ipLimpia = bloquearIP(ip, `Uso de lenguaje prohibido: "${palabraEncontrada}"`, 'PALABRA_PROHIBIDA', palabraEncontrada, false);
        return { 
            bloqueado: true, 
            ip: ipLimpia,
            mensaje: `🚫 SERVICIO CANCELADO\n\nSu IP ha sido bloqueada por violar las normas de servicio.\n\nMotivo: Uso de lenguaje inapropiado ("${palabraEncontrada}")\n\nSi considera que es un error, contacte con soporte.` 
        };
    }
    return { bloqueado: false, mensaje: null };
}

function registrarCancelacion(ip) {
    const ipLimpia = ip.replace('::ffff:', '');
    const ahora = Date.now();
    
    if (!cancelacionesPorIP.has(ipLimpia)) {
        cancelacionesPorIP.set(ipLimpia, { count: 1, firstTime: ahora });
    } else {
        const datos = cancelacionesPorIP.get(ipLimpia);
        if (ahora - datos.firstTime < 3600000) {
            datos.count++;
            if (datos.count >= 3) {
                bloquearIP(ipLimpia, `3 cancelaciones en menos de 1 hora`, 'ABUSO_CANCELACIONES', null, false);
            }
        } else {
            cancelacionesPorIP.set(ipLimpia, { count: 1, firstTime: ahora });
        }
    }
}

function checkRateIP(ip) {
    const ipLimpia = ip.replace('::ffff:', '');
    const ahora = Date.now();
    const registros = turnosRecientesIP.get(ipLimpia) || [];
    const registrosRecientes = registros.filter(t => ahora - t < 3600000);
    turnosRecientesIP.set(ipLimpia, registrosRecientes);
    return registrosRecientes.length < 3;
}

function regTurno(ip) {
    const ipLimpia = ip.replace('::ffff:', '');
    const ahora = Date.now();
    if (!turnosRecientesIP.has(ipLimpia)) turnosRecientesIP.set(ipLimpia, []);
    turnosRecientesIP.get(ipLimpia).push(ahora);
}

async function guardarPalabrasBaneadas() {
    try {
        await fs.writeFile(PALABRAS_BANEADAS_FILE, JSON.stringify({ palabras: palabrasBaneadas }, null, 2), 'utf8');
    } catch(e) {
        console.error('Error guardando palabras:', e);
    }
}

// ==================== PÁGINA DE BLOQUEO ====================
function paginaBloqueo(bloqueo, ip) {
    return `
        <!DOCTYPE html>
        <html lang="es">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Servicio Cancelado | Serenity Spa</title>
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
                .cancel-card{
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
                .icono{
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
                .icono i{
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
                }
                p{
                    color: #d4c5a9;
                    line-height: 1.6;
                    margin-bottom: 1rem;
                }
                .motivo{
                    background: rgba(0, 0, 0, 0.4);
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
                .btn-home{
                    display: inline-block;
                    background: rgba(201, 168, 122, 0.15);
                    border: 1px solid rgba(201, 168, 122, 0.4);
                    color: #c9a87a;
                    padding: 0.7rem 1.5rem;
                    border-radius: 40px;
                    text-decoration: none;
                    font-size: 0.85rem;
                    transition: all 0.3s;
                    margin-top: 1rem;
                }
                .btn-home:hover{
                    background: rgba(201, 168, 122, 0.3);
                    border-color: #c9a87a;
                }
                .footer{
                    margin-top: 1.5rem;
                    font-size: 0.7rem;
                    color: rgba(212, 197, 169, 0.5);
                }
            </style>
            <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
        </head>
        <body>
            <div class="cancel-card">
                <div class="icono"><i class="fas fa-ban"></i></div>
                <h1>Servicio Cancelado</h1>
                <div class="badge"><i class="fas fa-gavel"></i> Violación de Términos</div>
                <p>Su acceso ha sido suspendido por violar las normas de convivencia.</p>
                <div class="motivo">
                    <strong><i class="fas fa-shield-alt"></i> Motivo:</strong><br>
                    ${escapeHtml(bloqueo?.motivo || 'Violación de términos')}<br><br>
                    <strong><i class="fas fa-clock"></i> Fecha:</strong> ${new Date(bloqueo?.fecha || Date.now()).toLocaleString()}<br>
                    ${bloqueo?.palabraOfensiva ? `<strong><i class="fas fa-comment-slash"></i> Palabra:</strong> "${escapeHtml(bloqueo.palabraOfensiva)}"<br>` : ''}
                    ${bloqueo?.permanente ? '<strong>Estado:</strong> Suspensión permanente' : '<strong>Estado:</strong> Suspensión temporal (1 hora)'}
                </div>
                <a href="/" class="btn-home"><i class="fas fa-home"></i> Volver al inicio</a>
                <div class="footer">Serenity Spa - Todos los derechos reservados</div>
            </div>
        </body>
        </html>
    `;
}

// ==================== INICIALIZACIÓN DE ARCHIVOS ====================
async function initAllFiles() {
    console.log('🔧 Inicializando archivos...');
    
    if (!fsSync.existsSync(SERVICIOS_FILE)) {
        const serviciosDefault = [
            { id: "relajante", nombre: "Masaje Relajante", precio: "$45", descripcion: "Movimientos suaves para liberar el estrés.", beneficios: ["60 Minutos"], efectos: ["Relajación profunda"], imagenWeb: "https://images.unsplash.com/photo-1544161515-4ab6ce6db874?w=800", orden: 1 },
            { id: "corporal", nombre: "Masaje Corporal", precio: "$65", descripcion: "Tratamiento completo para una relajación profunda.", beneficios: ["90 Minutos"], efectos: ["Activación linfática"], imagenWeb: "https://images.unsplash.com/photo-1519823551278-64ac92734fb1?w=800", orden: 2 },
            { id: "facial", nombre: "Masaje Facial", precio: "$40", descripcion: "Rejuvenece la piel y alivia la tensión facial.", beneficios: ["45 Minutos"], efectos: ["Estimula colágeno"], imagenWeb: "https://images.unsplash.com/photo-1570172619644-dfd03ed5d881?w=800", orden: 3 }
        ];
        await fs.writeFile(SERVICIOS_FILE, JSON.stringify(serviciosDefault, null, 2));
        console.log('✅ servicios.json creado');
    }
    
    if (!fsSync.existsSync(TURNOS_FILE)) {
        await fs.writeFile(TURNOS_FILE, JSON.stringify([], null, 2));
        console.log('✅ turnos.json creado');
    }
    
    if (!fsSync.existsSync(HORARIOS_FILE)) {
        await fs.writeFile(HORARIOS_FILE, JSON.stringify(horariosConfig, null, 2));
        console.log('✅ horarios.json creado');
    }
    
    if (!fsSync.existsSync(PAISES_FILE)) {
        await fs.writeFile(PAISES_FILE, JSON.stringify({ autorizados: [], bloqueados: [], modo: 'todos', ubicacionSalon: 'Salón Serenity Spa' }, null, 2));
        console.log('✅ paises.json creado');
    }
    
    if (!fsSync.existsSync(PALABRAS_BANEADAS_FILE)) {
        await fs.writeFile(PALABRAS_BANEADAS_FILE, JSON.stringify({ palabras: palabrasBaneadas }, null, 2));
        console.log('✅ palabras-baneadas.json creado');
    }
    
    if (fsSync.existsSync(BLOQUEOS_FILE)) {
        try {
            const data = JSON.parse(await fs.readFile(BLOQUEOS_FILE, 'utf8'));
            bloqueos = new Map(Object.entries(data.bloqueos || {}));
            historialBloqueos = data.historial || [];
            const ahora = Date.now();
            for (const [ip, datos] of bloqueos) {
                if (ahora > datos.hasta && !datos.permanente) bloqueos.delete(ip);
            }
        } catch(e) {}
    }
    
    const data = await fs.readFile(SERVICIOS_FILE, 'utf8');
    serviciosData = JSON.parse(data);
    console.log(`✅ Servicios cargados: ${serviciosData.length}`);
    console.log(`🔒 Bloqueos activos: ${bloqueos.size}`);
}

// ==================== MIDDLEWARE DE BLOQUEO ====================
// Este middleware se ejecuta ANTES que las rutas de API
app.use((req, res, next) => {
    const ip = req.ip || req.socket.remoteAddress || '0.0.0.0';
    
    // Rutas que SIEMPRE están permitidas (admin, login, etc.)
    const rutasPermitidas = [
        '/admin', '/admin.html', '/login', '/login.html', 
        '/api/login', '/api/verify', '/admin-emergencia',
        '/api/seguridad/estado/current', '/api/seguridad/estado',
        '/api/seguridad/bloqueos', '/api/seguridad/desbloquear',
        '/api/seguridad/historial', '/api/seguridad/limpiar-expirados',
        '/api/seguridad/bloquear-permanente', '/api/seguridad/paises',
        '/api/seguridad/paises/autorizar', '/api/seguridad/paises/bloquear',
        '/api/palabras-baneadas', '/api/config', '/api/config/horarios',
        '/api/servicios', '/api/upload-hero', '/api/ia',
        '/api/recargar', '/api/enviar-whatsapp', '/api/chat-ia'
    ];
    
    // Si la ruta comienza con alguna de las permitidas, pasar
    for (const ruta of rutasPermitidas) {
        if (req.path.startsWith(ruta)) {
            return next();
        }
    }
    
    // Verificar si la IP está bloqueada
    if (estaBloqueado(ip)) {
        const bloqueo = obtenerBloqueo(ip);
        // Si es una API, devolver JSON
        if (req.path.startsWith('/api/') || req.path.startsWith('/turnos')) {
            return res.status(403).json({ 
                error: 'Servicio cancelado', 
                bloqueado: true,
                motivo: bloqueo?.motivo || 'Violación de términos'
            });
        }
        // Si es una página web, mostrar la página de bloqueo
        return res.status(403).send(paginaBloqueo(bloqueo, ip));
    }
    
    next();
});

// ==================== MIDDLEWARE DE SEGURIDAD ====================
app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    next();
});

// ==================== RUTA DE EMERGENCIA ====================
app.get('/admin-emergencia/:token', (req, res) => {
    const { token } = req.params;
    if (token === 'SERENITY2024') {
        const ip = req.ip || req.socket.remoteAddress || '0.0.0.0';
        const ipLimpia = ip.replace('::ffff:', '');
        
        if (bloqueos.has(ipLimpia)) {
            bloqueos.delete(ipLimpia);
            fs.writeFileSync(BLOQUEOS_FILE, JSON.stringify({
                bloqueos: Object.fromEntries(bloqueos),
                historial: historialBloqueos
            }, null, 2));
            return res.send(`
                <h1 style="color:green;">✅ IP Desbloqueada</h1>
                <p>Tu IP ${ipLimpia} ha sido desbloqueada.</p>
                <a href="/admin.html">Ir al Admin</a>
                <script>setTimeout(() => { window.location.href = '/admin.html'; }, 2000);</script>
            `);
        }
        return res.send(`<h1>ℹ️ IP no estaba bloqueada</h1><a href="/admin.html">Ir al Admin</a>`);
    }
    res.status(404).send('Acceso denegado');
});

app.use(express.static(__dirname));

// ==================== RUTAS HTML ====================
app.get('/voice-assistant', (req, res) => {
    res.sendFile(path.join(__dirname, 'voice-assistant.html'));
});
app.get('/voice-assistant.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'voice-assistant.html'));
});
app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'admin.html'));
});
app.get('/admin.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'admin.html'));
});
app.get('/login', (req, res) => {
    res.sendFile(path.join(__dirname, 'login.html'));
});
app.get('/login.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'login.html'));
});
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// ==================== RUTAS API ====================

app.get('/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        timestamp: new Date().toISOString(), 
        servicios: serviciosData.length,
        ia: process.env.DEEPSEEK_API_KEY ? 'conectada' : 'no-configurada'
    });
});

app.get('/api/servicios', (req, res) => {
    res.json(serviciosData.sort((a, b) => (a.orden || 999) - (b.orden || 999)));
});

app.get('/api/config/horarios', (req, res) => {
    res.json(horariosConfig);
});

app.put('/api/config/horarios', async (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'No autorizado' });
    }
    const token = authHeader.substring(7);
    if (!validTokens.has(token) || validTokens.get(token) < Date.now()) {
        return res.status(401).json({ error: 'Sesión expirada' });
    }
    
    try {
        const data = req.body;
        if (data.dias && Array.isArray(data.dias)) {
            horariosConfig.dias = data.dias;
        }
        if (data.horarios && Array.isArray(data.horarios)) {
            horariosConfig.horarios = data.horarios;
            HORAS_VALIDAS = data.horarios.map(h => parseInt(h.split(':')[0]));
        }
        await fs.writeFile(HORARIOS_FILE, JSON.stringify(horariosConfig, null, 2));
        res.json({ success: true, horarios: horariosConfig });
    } catch(e) {
        res.status(500).json({ error: 'Error al guardar' });
    }
});

app.post('/api/chat-ia', async (req, res) => {
    const ip = req.ip || req.socket.remoteAddress || '0.0.0.0';
    const { mensaje } = req.body;
    
    // VERIFICAR BLOQUEO PRIMERO
    if (estaBloqueado(ip)) {
        return res.status(403).json({ 
            error: 'Servicio cancelado',
            modo: 'bloqueado',
            mensaje: '🚫 Su IP ha sido bloqueada por violar las normas de servicio.'
        });
    }
    
    // Verificar palabras prohibidas
    const sancion = verificarYSancionar(ip, mensaje);
    if (sancion.bloqueado) {
        return res.json({ 
            respuesta: sancion.mensaje, 
            modo: 'bloqueado',
            ip: sancion.ip 
        });
    }
    
    // Intentar usar IA si está configurada
    try {
        if (process.env.DEEPSEEK_API_KEY) {
            const completion = await deepseek.chat.completions.create({
                model: "deepseek-chat",
                messages: [
                    { role: "system", content: "Eres un asistente de un spa llamado Serenity Spa. Ayudas a los clientes a reservar turnos, responder preguntas sobre servicios y horarios. Sé amable y profesional." },
                    { role: "user", content: mensaje }
                ],
                max_tokens: 300,
                temperature: 0.7
            });
            
            const respuesta = completion.choices[0].message.content;
            return res.json({ respuesta, modo: 'ia' });
        }
    } catch(e) {
        console.error('Error IA:', e);
    }
    
    // Respuesta local si no hay IA
    res.json({ 
        respuesta: "Hola, ¿en qué puedo ayudarte? Puedo ayudarte con reservas, horarios y cancelaciones.", 
        modo: 'local' 
    });
});

app.post('/turnos', async (req, res) => {
    const ip = req.ip || req.socket.remoteAddress || '0.0.0.0';
    const { nombre, telefono, massageType, dia, hora, codigoPais, ubicacion, tipoServicio } = req.body;
    
    // VERIFICAR BLOQUEO PRIMERO
    if (estaBloqueado(ip)) {
        return res.status(403).json({ error: 'Servicio cancelado' });
    }
    
    // Verificar nombre
    if (nombre) {
        const sancion = verificarYSancionar(ip, nombre);
        if (sancion.bloqueado) {
            return res.status(403).json({ error: sancion.mensaje });
        }
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
    
    let diaLower = dia?.toLowerCase();
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
    
    if (!checkRateIP(ip)) {
        return res.status(429).json({ error: 'Demasiadas solicitudes. Espere una hora.' });
    }
    
    const turnos = JSON.parse(await fs.readFile(TURNOS_FILE, 'utf8'));
    
    if (turnos.some(t => t.telefono === tel && t.dia === diaLower)) {
        return res.status(409).json({ error: 'Ya tienes un turno para ese día.' });
    }
    
    if (turnos.some(t => t.dia === diaLower && t.hora === hn)) {
        return res.status(409).json({ error: 'Horario ocupado' });
    }
    
    const codigoCancelacion = generarCodigoCancelacion();
    
    const nuevoTurno = {
        id: generarId(),
        nombre: escapeHtml(nombre),
        dia: diaLower,
        hora: hn,
        massageType: massageType || 'Masaje',
        telefono: tel,
        codigoPais: codPais,
        ubicacion: ubicacion || 'Salón Serenity Spa',
        tipoServicio: tipoServicio || 'salon',
        confirmadoWhatsApp: false,
        fechaCreacion: new Date().toISOString(),
        ip: ip.replace('::ffff:', ''),
        codigoCancelacion: codigoCancelacion
    };
    
    turnos.push(nuevoTurno);
    await fs.writeFile(TURNOS_FILE, JSON.stringify(turnos, null, 2), 'utf8');
    regTurno(ip);
    
    res.status(201).json({ 
        mensaje: 'Turno reservado', 
        turno: nuevoTurno,
        codigoCancelacion: codigoCancelacion
    });
});

app.post('/api/cancelar-por-codigo', async (req, res) => {
    const ip = req.ip || req.socket.remoteAddress || '0.0.0.0';
    const { codigo } = req.body;
    
    if (estaBloqueado(ip)) {
        return res.status(403).json({ error: 'Servicio cancelado' });
    }
    
    if (!codigo || codigo.length !== 6) {
        return res.status(400).json({ error: 'Código inválido' });
    }
    
    const turnos = JSON.parse(await fs.readFile(TURNOS_FILE, 'utf8'));
    const turnoIndex = turnos.findIndex(t => t.codigoCancelacion === codigo.toUpperCase());
    
    if (turnoIndex === -1) {
        return res.json({ success: false, error: 'Código incorrecto' });
    }
    
    const turno = turnos[turnoIndex];
    turnos.splice(turnoIndex, 1);
    await fs.writeFile(TURNOS_FILE, JSON.stringify(turnos, null, 2), 'utf8');
    
    registrarCancelacion(ip);
    
    res.json({ success: true, mensaje: `✅ Turno del ${turno.dia} a las ${turno.hora}:00 cancelado.` });
});

// ==================== AUTENTICACIÓN ADMIN ====================
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

app.get('/api/verify', (req, res) => {
    const h = req.headers.authorization;
    if (!h || !h.startsWith('Bearer ')) return res.json({ valid: false });
    const token = h.substring(7);
    res.json({ valid: validTokens.has(token) && validTokens.get(token) > Date.now() });
});

// ==================== API DE SEGURIDAD ====================

// Verificar estado de una IP específica
app.get('/api/seguridad/estado/:ip', (req, res) => {
    const ip = req.params.ip;
    const ipLimpia = ip.replace('::ffff:', '');
    const bloqueado = estaBloqueado(ipLimpia);
    const datos = bloqueos.get(ipLimpia);
    
    res.json({
        bloqueado: bloqueado,
        datos: datos ? {
            motivo: datos.motivo,
            tipoAtaque: datos.tipoAtaque,
            fecha: datos.fecha,
            permanente: datos.permanente || false,
            palabraOfensiva: datos.palabraOfensiva || null,
            tiempoRestante: Math.max(0, datos.hasta - Date.now())
        } : null
    });
});

// Verificar estado de la IP actual
app.get('/api/seguridad/estado/current', (req, res) => {
    const ip = req.ip || req.socket.remoteAddress || '0.0.0.0';
    const ipLimpia = ip.replace('::ffff:', '');
    const bloqueado = estaBloqueado(ipLimpia);
    const datos = bloqueos.get(ipLimpia);
    
    res.json({
        bloqueado: bloqueado,
        datos: datos ? {
            motivo: datos.motivo,
            tipoAtaque: datos.tipoAtaque,
            fecha: datos.fecha,
            permanente: datos.permanente || false,
            palabraOfensiva: datos.palabraOfensiva || null,
            tiempoRestante: Math.max(0, datos.hasta - Date.now())
        } : null
    });
});

app.get('/api/seguridad/bloqueos', (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'No autorizado' });
    }
    const token = authHeader.substring(7);
    if (!validTokens.has(token) || validTokens.get(token) < Date.now()) {
        return res.status(401).json({ error: 'Sesión expirada' });
    }
    
    const activos = [];
    for (const [ip, datos] of bloqueos) {
        activos.push({
            ip: ip,
            motivo: datos.motivo,
            tipoAtaque: datos.tipoAtaque,
            fecha: datos.fecha,
            tiempoRestante: Math.max(0, datos.hasta - Date.now()),
            tiempoRestanteFormateado: fmtT(Math.max(0, datos.hasta - Date.now())),
            permanente: datos.permanente || false,
            palabraOfensiva: datos.palabraOfensiva || null
        });
    }
    
    const intentosMap = {};
    for (const [ip, datos] of intentosFallidos) {
        intentosMap[ip] = datos;
    }
    
    res.json({
        activos: activos,
        historial: historialBloqueos.slice(0, 100),
        intentosFallidos: intentosMap
    });
});

app.post('/api/seguridad/desbloquear/:ip', (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'No autorizado' });
    }
    const token = authHeader.substring(7);
    if (!validTokens.has(token) || validTokens.get(token) < Date.now()) {
        return res.status(401).json({ error: 'Sesión expirada' });
    }
    
    const ipDesbloquear = req.params.ip;
    if (bloqueos.has(ipDesbloquear)) {
        bloqueos.delete(ipDesbloquear);
        cancelacionesPorIP.delete(ipDesbloquear);
        intentosFallidos.delete(ipDesbloquear);
        
        fs.writeFileSync(BLOQUEOS_FILE, JSON.stringify({
            bloqueos: Object.fromEntries(bloqueos),
            historial: historialBloqueos
        }, null, 2));
        
        console.log(`🔓 IP ${ipDesbloquear} desbloqueada por administrador`);
        res.json({ ok: true, mensaje: `IP ${ipDesbloquear} desbloqueada` });
    } else {
        res.json({ ok: false, mensaje: 'IP no estaba bloqueada' });
    }
});

app.delete('/api/seguridad/historial/:id', (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'No autorizado' });
    }
    const token = authHeader.substring(7);
    if (!validTokens.has(token) || validTokens.get(token) < Date.now()) {
        return res.status(401).json({ error: 'Sesión expirada' });
    }
    
    const id = req.params.id;
    historialBloqueos = historialBloqueos.filter(h => h.id !== id);
    
    fs.writeFileSync(BLOQUEOS_FILE, JSON.stringify({
        bloqueos: Object.fromEntries(bloqueos),
        historial: historialBloqueos
    }, null, 2));
    
    res.json({ ok: true });
});

app.post('/api/seguridad/limpiar-expirados', (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'No autorizado' });
    }
    const token = authHeader.substring(7);
    if (!validTokens.has(token) || validTokens.get(token) < Date.now()) {
        return res.status(401).json({ error: 'Sesión expirada' });
    }
    
    const ahora = Date.now();
    let eliminados = 0;
    for (const [ip, datos] of bloqueos) {
        if (ahora > datos.hasta && !datos.permanente) {
            bloqueos.delete(ip);
            eliminados++;
        }
    }
    
    fs.writeFileSync(BLOQUEOS_FILE, JSON.stringify({
        bloqueos: Object.fromEntries(bloqueos),
        historial: historialBloqueos
    }, null, 2));
    
    res.json({ mensaje: `${eliminados} bloqueos expirados eliminados` });
});

app.post('/api/seguridad/bloquear-permanente/:ip', (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'No autorizado' });
    }
    const token = authHeader.substring(7);
    if (!validTokens.has(token) || validTokens.get(token) < Date.now()) {
        return res.status(401).json({ error: 'Sesión expirada' });
    }
    
    const ipBloquear = req.params.ip;
    bloquearIP(ipBloquear, 'Bloqueo permanente por administrador', 'MANUAL', null, true);
    res.json({ ok: true });
});

app.delete('/api/seguridad/bloqueos/:ip', (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'No autorizado' });
    }
    const token = authHeader.substring(7);
    if (!validTokens.has(token) || validTokens.get(token) < Date.now()) {
        return res.status(401).json({ error: 'Sesión expirada' });
    }
    
    const ipEliminar = req.params.ip;
    if (bloqueos.has(ipEliminar)) {
        bloqueos.delete(ipEliminar);
        fs.writeFileSync(BLOQUEOS_FILE, JSON.stringify({
            bloqueos: Object.fromEntries(bloqueos),
            historial: historialBloqueos
        }, null, 2));
        res.json({ ok: true });
    } else {
        res.status(404).json({ error: 'IP no encontrada' });
    }
});

app.get('/api/palabras-baneadas', (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'No autorizado' });
    }
    const token = authHeader.substring(7);
    if (!validTokens.has(token) || validTokens.get(token) < Date.now()) {
        return res.status(401).json({ error: 'Sesión expirada' });
    }
    
    res.json({ palabras: palabrasBaneadas });
});

app.post('/api/palabras-baneadas', async (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'No autorizado' });
    }
    const token = authHeader.substring(7);
    if (!validTokens.has(token) || validTokens.get(token) < Date.now()) {
        return res.status(401).json({ error: 'Sesión expirada' });
    }
    
    const { palabra, accion } = req.body;
    
    if (accion === 'agregar' && palabra && palabra.length >= 2) {
        if (!palabrasBaneadas.includes(palabra.toLowerCase())) {
            palabrasBaneadas.push(palabra.toLowerCase());
            await guardarPalabrasBaneadas();
            console.log(`✅ Palabra agregada: ${palabra}`);
        }
    } else if (accion === 'eliminar' && palabra) {
        palabrasBaneadas = palabrasBaneadas.filter(p => p !== palabra);
        await guardarPalabrasBaneadas();
        console.log(`✅ Palabra eliminada: ${palabra}`);
    }
    
    res.json({ ok: true, palabras: palabrasBaneadas });
});

// ==================== CONFIGURACIÓN ====================
app.get('/api/config', async (req, res) => {
    try {
        const data = await fs.readFile(CONFIG_FILE, 'utf8');
        res.json(JSON.parse(data));
    } catch {
        res.json({});
    }
});

app.put('/api/config', async (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'No autorizado' });
    }
    const token = authHeader.substring(7);
    if (!validTokens.has(token) || validTokens.get(token) < Date.now()) {
        return res.status(401).json({ error: 'Sesión expirada' });
    }
    
    try {
        await fs.writeFile(CONFIG_FILE, JSON.stringify(req.body, null, 2));
        res.json({ success: true });
    } catch(e) {
        res.status(500).json({ error: 'Error al guardar' });
    }
});

// ==================== PAÍSES ====================
app.get('/api/seguridad/paises', (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'No autorizado' });
    }
    const token = authHeader.substring(7);
    if (!validTokens.has(token) || validTokens.get(token) < Date.now()) {
        return res.status(401).json({ error: 'Sesión expirada' });
    }
    
    fs.readFile(PAISES_FILE, 'utf8')
        .then(data => res.json(JSON.parse(data)))
        .catch(() => res.json({ autorizados: [], bloqueados: [], modo: 'todos', ubicacionSalon: '' }));
});

app.put('/api/seguridad/paises', async (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'No autorizado' });
    }
    const token = authHeader.substring(7);
    if (!validTokens.has(token) || validTokens.get(token) < Date.now()) {
        return res.status(401).json({ error: 'Sesión expirada' });
    }
    
    try {
        const data = JSON.parse(await fs.readFile(PAISES_FILE, 'utf8'));
        const { modo, ubicacionSalon } = req.body;
        if (modo) data.modo = modo;
        if (ubicacionSalon !== undefined) data.ubicacionSalon = ubicacionSalon;
        await fs.writeFile(PAISES_FILE, JSON.stringify(data, null, 2));
        res.json({ success: true });
    } catch(e) {
        res.status(500).json({ error: 'Error al guardar' });
    }
});

app.post('/api/seguridad/paises/autorizar', async (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'No autorizado' });
    }
    const token = authHeader.substring(7);
    if (!validTokens.has(token) || validTokens.get(token) < Date.now()) {
        return res.status(401).json({ error: 'Sesión expirada' });
    }
    
    const { codigo } = req.body;
    try {
        const data = JSON.parse(await fs.readFile(PAISES_FILE, 'utf8'));
        if (!data.autorizados.includes(codigo)) {
            data.autorizados.push(codigo);
        }
        data.bloqueados = data.bloqueados.filter(c => c !== codigo);
        await fs.writeFile(PAISES_FILE, JSON.stringify(data, null, 2));
        res.json({ success: true });
    } catch(e) {
        res.status(500).json({ error: 'Error al autorizar' });
    }
});

app.post('/api/seguridad/paises/bloquear', async (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'No autorizado' });
    }
    const token = authHeader.substring(7);
    if (!validTokens.has(token) || validTokens.get(token) < Date.now()) {
        return res.status(401).json({ error: 'Sesión expirada' });
    }
    
    const { codigo } = req.body;
    try {
        const data = JSON.parse(await fs.readFile(PAISES_FILE, 'utf8'));
        if (!data.bloqueados.includes(codigo)) {
            data.bloqueados.push(codigo);
        }
        data.autorizados = data.autorizados.filter(c => c !== codigo);
        await fs.writeFile(PAISES_FILE, JSON.stringify(data, null, 2));
        res.json({ success: true });
    } catch(e) {
        res.status(500).json({ error: 'Error al bloquear' });
    }
});

app.delete('/api/seguridad/paises/:codigo', async (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'No autorizado' });
    }
    const token = authHeader.substring(7);
    if (!validTokens.has(token) || validTokens.get(token) < Date.now()) {
        return res.status(401).json({ error: 'Sesión expirada' });
    }
    
    const { codigo } = req.params;
    try {
        const data = JSON.parse(await fs.readFile(PAISES_FILE, 'utf8'));
        data.autorizados = data.autorizados.filter(c => c !== codigo);
        data.bloqueados = data.bloqueados.filter(c => c !== codigo);
        await fs.writeFile(PAISES_FILE, JSON.stringify(data, null, 2));
        res.json({ success: true });
    } catch(e) {
        res.status(500).json({ error: 'Error al eliminar' });
    }
});

app.get('/api/seguridad/paises/stats', async (req, res) => {
    try {
        const turnos = JSON.parse(await fs.readFile(TURNOS_FILE, 'utf8'));
        const stats = {};
        for (const t of turnos) {
            const codigo = t.codigoPais || '53';
            if (!stats[codigo]) stats[codigo] = 0;
            stats[codigo]++;
        }
        const result = Object.entries(stats).map(([codigo, reservas]) => ({
            codigo,
            reservas
        }));
        res.json(result);
    } catch {
        res.json([]);
    }
});

// ==================== WEBSOCKET PARA VOZ ====================
const server = app.listen(PORT, '0.0.0.0', async () => {
    await initAllFiles();
    console.log(`🌿 Serenity Spa iniciado en puerto ${PORT}`);
    console.log(`🔑 Palabras prohibidas: ${palabrasBaneadas.length}`);
    console.log(`🔒 Sistema de bloqueo activo - Admin excluido`);
    console.log(`🆘 Ruta de emergencia: /admin-emergencia/SERENITY2024`);
    console.log(`📋 Rutas de API protegidas por bloqueo de IP`);
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
                // Verificar palabras prohibidas en el mensaje de voz
                const sancion = verificarYSancionar(ip, m.texto);
                if (sancion.bloqueado) {
                    ws.send(JSON.stringify({ tipo: 'respuesta', texto: sancion.mensaje }));
                    setTimeout(() => ws.close(), 2000);
                    return;
                }
                ws.send(JSON.stringify({ tipo: 'respuesta', texto: `Procesando tu solicitud...` }));
            }
        } catch(e) {
            console.error('Error en WebSocket:', e);
        }
    });
    
    ws.on('close', () => voiceClients.delete(cid));
});

console.log('✅ Servidor completamente cargado con sistema de bloqueo mejorado');
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
const PREMIUM_USUARIOS_FILE = path.join(__dirname, 'premium_usuarios.json');
const PREMIUM_CONFIG_FILE = path.join(__dirname, 'premium_config.json');
const NOTIFICACIONES_FILE = path.join(__dirname, 'notificaciones.json');
const RESENAS_FILE = path.join(__dirname, 'resenas.json');

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
    
    historialBloqueos.unshift({ ...bloqueos.get(ipLimpia), id: generarId() });
    
    cancelacionesPorIP.delete(ipLimpia);
    turnosRecientesIP.delete(ipLimpia);
    intentosFallidos.delete(ipLimpia);
    
    console.log(`🔴 IP BLOQUEADA: ${ipLimpia} - ${motivo}`);
    
    fs.writeFile(BLOQUEOS_FILE, JSON.stringify({
        bloqueos: Object.fromEntries(bloqueos),
        historial: historialBloqueos.slice(0, 500)
    }, null, 2)).catch(e => console.error('Error guardando:', e));
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

function verificarYSancionar(ip, texto) {
    const palabraEncontrada = contienePalabraProhibida(texto);
    if (palabraEncontrada) {
        bloquearIP(ip, `Uso de lenguaje prohibido: "${palabraEncontrada}"`, 'PALABRA_PROHIBIDA', palabraEncontrada, false);
        return { 
            bloqueado: true, 
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

// ==================== INICIALIZACIÓN DE ARCHIVOS PREMIUM ====================
async function initPremiumFiles() {
    if (!fsSync.existsSync(PREMIUM_USUARIOS_FILE)) {
        await fs.writeFile(PREMIUM_USUARIOS_FILE, JSON.stringify([], null, 2));
    }
    if (!fsSync.existsSync(PREMIUM_CONFIG_FILE)) {
        await fs.writeFile(PREMIUM_CONFIG_FILE, JSON.stringify({
            descuento_premium: 15,
            bienvenida_premium: "¡Bienvenido a Serenity Spa Premium! Disfruta de descuentos exclusivos.",
            membresia_gratuita_anual: true
        }, null, 2));
    }
    if (!fsSync.existsSync(NOTIFICACIONES_FILE)) {
        await fs.writeFile(NOTIFICACIONES_FILE, JSON.stringify([], null, 2));
    }
    if (!fsSync.existsSync(RESENAS_FILE)) {
        await fs.writeFile(RESENAS_FILE, JSON.stringify([], null, 2));
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
    
    await initPremiumFiles();
    
    const data = await fs.readFile(SERVICIOS_FILE, 'utf8');
    serviciosData = JSON.parse(data);
    console.log(`✅ Servicios cargados: ${serviciosData.length}`);
    console.log(`🔒 Bloqueos activos: ${bloqueos.size}`);
}

// ==================== MIDDLEWARE ====================
app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    next();
});

// RUTA DE EMERGENCIA PARA DESBLOQUEAR
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

// Middleware de bloqueo - EXCLUYE rutas de administración
app.use((req, res, next) => {
    const ip = req.ip || req.socket.remoteAddress || '0.0.0.0';
    
    const rutasPermitidas = ['/admin', '/admin.html', '/login', '/login.html', '/api/login', '/api/verify', '/admin-emergencia', '/api/seguridad', '/api/premium', '/api/resenas'];
    if (rutasPermitidas.some(ruta => req.path.startsWith(ruta))) {
        return next();
    }
    
    if (estaBloqueado(ip)) {
        const bloqueo = bloqueos.get(ip.replace('::ffff:', ''));
        return res.status(403).send(paginaBloqueo(bloqueo, ip));
    }
    next();
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
app.get('/premium-dashboard', (req, res) => {
    res.sendFile(path.join(__dirname, 'premium-dashboard.html'));
});
app.get('/premium-dashboard.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'premium-dashboard.html'));
});
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// ==================== RUTAS API ====================

app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString(), servicios: serviciosData.length });
});

app.get('/api/servicios', (req, res) => {
    res.json(serviciosData.sort((a, b) => (a.orden || 999) - (b.orden || 999)));
});

app.get('/api/config/horarios', (req, res) => {
    res.json(horariosConfig);
});

app.post('/api/chat-ia', async (req, res) => {
    const ip = req.ip || req.socket.remoteAddress || '0.0.0.0';
    const { mensaje } = req.body;
    
    if (estaBloqueado(ip)) {
        return res.status(403).json({ error: 'Servicio cancelado' });
    }
    
    const sancion = verificarYSancionar(ip, mensaje);
    if (sancion.bloqueado) {
        return res.json({ respuesta: sancion.mensaje, modo: 'bloqueado' });
    }
    
    res.json({ respuesta: "Hola, ¿en qué puedo ayudarte? Puedo ayudarte con reservas, horarios y cancelaciones.", modo: 'local' });
});

app.post('/turnos', async (req, res) => {
    const ip = req.ip || req.socket.remoteAddress || '0.0.0.0';
    const { nombre, telefono, massageType, dia, hora, codigoPais, email } = req.body;
    
    if (estaBloqueado(ip)) {
        return res.status(403).json({ error: 'Servicio cancelado' });
    }
    
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
        ubicacion: 'Salón Serenity Spa',
        tipoServicio: 'salon',
        confirmadoWhatsApp: false,
        fechaCreacion: new Date().toISOString(),
        ip: ip.replace('::ffff:', ''),
        codigoCancelacion: codigoCancelacion,
        email: email || null
    };
    
    turnos.push(nuevoTurno);
    await fs.writeFile(TURNOS_FILE, JSON.stringify(turnos, null, 2), 'utf8');
    regTurno(ip);
    
    // Actualizar teléfono del usuario premium si existe
    if (email) {
        try {
            let usuarios = JSON.parse(await fs.readFile(PREMIUM_USUARIOS_FILE, 'utf8'));
            const index = usuarios.findIndex(u => u.email === email);
            if (index >= 0) {
                usuarios[index].telefono = tel;
                usuarios[index].codigoPais = codPais;
                await fs.writeFile(PREMIUM_USUARIOS_FILE, JSON.stringify(usuarios, null, 2));
            }
        } catch(e) {}
    }
    
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

// ==================== API DE SEGURIDAD (BLOQUEOS) ====================

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

// ==================== RUTAS PREMIUM ====================

// Obtener usuario premium
app.get('/api/premium/usuario', async (req, res) => {
    const { email } = req.query;
    if (!email) return res.status(400).json({ error: 'Email requerido' });
    
    try {
        const usuarios = JSON.parse(await fs.readFile(PREMIUM_USUARIOS_FILE, 'utf8'));
        const usuario = usuarios.find(u => u.email === email);
        res.json(usuario || null);
    } catch(e) {
        res.status(500).json({ error: 'Error' });
    }
});

// Crear/Actualizar usuario premium
app.post('/api/premium/usuario', async (req, res) => {
    const usuario = req.body;
    try {
        let usuarios = JSON.parse(await fs.readFile(PREMIUM_USUARIOS_FILE, 'utf8'));
        const index = usuarios.findIndex(u => u.email === usuario.email);
        
        if (index >= 0) {
            usuarios[index] = { ...usuarios[index], ...usuario };
        } else {
            usuarios.push(usuario);
        }
        
        await fs.writeFile(PREMIUM_USUARIOS_FILE, JSON.stringify(usuarios, null, 2));
        res.json({ success: true });
    } catch(e) {
        res.status(500).json({ error: 'Error' });
    }
});

app.put('/api/premium/usuario', async (req, res) => {
    const usuario = req.body;
    try {
        let usuarios = JSON.parse(await fs.readFile(PREMIUM_USUARIOS_FILE, 'utf8'));
        const index = usuarios.findIndex(u => u.email === usuario.email);
        
        if (index >= 0) {
            usuarios[index] = { ...usuarios[index], ...usuario };
            await fs.writeFile(PREMIUM_USUARIOS_FILE, JSON.stringify(usuarios, null, 2));
        }
        res.json({ success: true });
    } catch(e) {
        res.status(500).json({ error: 'Error' });
    }
});

// Obtener todos los usuarios (admin)
app.get('/api/premium/usuarios', async (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'No autorizado' });
    }
    const token = authHeader.substring(7);
    if (!validTokens.has(token) || validTokens.get(token) < Date.now()) {
        return res.status(401).json({ error: 'Sesión expirada' });
    }
    
    try {
        const usuarios = JSON.parse(await fs.readFile(PREMIUM_USUARIOS_FILE, 'utf8'));
        res.json(usuarios);
    } catch(e) {
        res.json([]);
    }
});

// Cancelar cuenta de usuario (admin)
app.delete('/api/premium/usuario/:email', async (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'No autorizado' });
    }
    const token = authHeader.substring(7);
    if (!validTokens.has(token) || validTokens.get(token) < Date.now()) {
        return res.status(401).json({ error: 'Sesión expirada' });
    }
    
    const { email } = req.params;
    try {
        let usuarios = JSON.parse(await fs.readFile(PREMIUM_USUARIOS_FILE, 'utf8'));
        usuarios = usuarios.filter(u => u.email !== email);
        await fs.writeFile(PREMIUM_USUARIOS_FILE, JSON.stringify(usuarios, null, 2));
        res.json({ success: true });
    } catch(e) {
        res.status(500).json({ error: 'Error' });
    }
});

// Obtener configuración premium
app.get('/api/premium/config', async (req, res) => {
    try {
        const config = JSON.parse(await fs.readFile(PREMIUM_CONFIG_FILE, 'utf8'));
        res.json(config);
    } catch(e) {
        res.json({ descuento_premium: 15, membresia_gratuita_anual: true });
    }
});

// Actualizar configuración premium
app.put('/api/premium/config', async (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'No autorizado' });
    }
    const token = authHeader.substring(7);
    if (!validTokens.has(token) || validTokens.get(token) < Date.now()) {
        return res.status(401).json({ error: 'Sesión expirada' });
    }
    
    const { descuento_premium } = req.body;
    try {
        const config = JSON.parse(await fs.readFile(PREMIUM_CONFIG_FILE, 'utf8'));
        config.descuento_premium = descuento_premium;
        await fs.writeFile(PREMIUM_CONFIG_FILE, JSON.stringify(config, null, 2));
        res.json({ success: true });
    } catch(e) {
        res.status(500).json({ error: 'Error' });
    }
});

// Obtener notificaciones
app.get('/api/premium/notificaciones', async (req, res) => {
    const { email } = req.query;
    try {
        const todas = JSON.parse(await fs.readFile(NOTIFICACIONES_FILE, 'utf8'));
        const usuarioNotif = todas.filter(n => n.email === email);
        res.json({ notificaciones: usuarioNotif });
    } catch(e) {
        res.json({ notificaciones: [] });
    }
});

// Enviar notificación
app.post('/api/premium/notificar', async (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'No autorizado' });
    }
    const token = authHeader.substring(7);
    if (!validTokens.has(token) || validTokens.get(token) < Date.now()) {
        return res.status(401).json({ error: 'Sesión expirada' });
    }
    
    const { titulo, mensaje } = req.body;
    
    try {
        const usuarios = JSON.parse(await fs.readFile(PREMIUM_USUARIOS_FILE, 'utf8'));
        let notificaciones = JSON.parse(await fs.readFile(NOTIFICACIONES_FILE, 'utf8'));
        
        for (const usuario of usuarios) {
            if (usuario.notifications_enabled !== false) {
                notificaciones.push({
                    id: Date.now() + Math.random().toString(36),
                    email: usuario.email,
                    titulo: titulo,
                    mensaje: mensaje,
                    fecha: new Date().toISOString(),
                    leida: false
                });
            }
        }
        
        if (notificaciones.length > 1000) {
            notificaciones = notificaciones.slice(-1000);
        }
        
        await fs.writeFile(NOTIFICACIONES_FILE, JSON.stringify(notificaciones, null, 2));
        res.json({ success: true, enviadas: usuarios.length });
    } catch(e) {
        res.status(500).json({ error: 'Error' });
    }
});

app.post('/api/premium/notificaciones/:id/leer', async (req, res) => {
    const { id } = req.params;
    try {
        let notificaciones = JSON.parse(await fs.readFile(NOTIFICACIONES_FILE, 'utf8'));
        const index = notificaciones.findIndex(n => n.id === id);
        if (index >= 0) {
            notificaciones[index].leida = true;
            await fs.writeFile(NOTIFICACIONES_FILE, JSON.stringify(notificaciones, null, 2));
        }
        res.json({ success: true });
    } catch(e) {
        res.status(500).json({ error: 'Error' });
    }
});

// Registrar reserva premium
app.post('/api/premium/registrar-reserva', async (req, res) => {
    const { email, montoOriginal, montoPagado, dias } = req.body;
    
    try {
        let usuarios = JSON.parse(await fs.readFile(PREMIUM_USUARIOS_FILE, 'utf8'));
        const index = usuarios.findIndex(u => u.email === email);
        
        if (index >= 0) {
            usuarios[index].reservas_realizadas = (usuarios[index].reservas_realizadas || 0) + 1;
            usuarios[index].total_dias_masaje = (usuarios[index].total_dias_masaje || 0) + (dias || 1);
            usuarios[index].total_ahorrado = (usuarios[index].total_ahorrado || 0) + (montoOriginal - montoPagado);
            
            const ahora = new Date();
            const ultimoMasajeGratuito = usuarios[index].ultimo_masaje_gratuito ? new Date(usuarios[index].ultimo_masaje_gratuito) : null;
            if (!ultimoMasajeGratuito || (ahora - ultimoMasajeGratuito) >= 365 * 24 * 60 * 60 * 1000) {
                usuarios[index].masaje_gratuito_disponible = true;
            }
            
            await fs.writeFile(PREMIUM_USUARIOS_FILE, JSON.stringify(usuarios, null, 2));
        }
        
        res.json({ success: true });
    } catch(e) {
        res.status(500).json({ error: 'Error' });
    }
});

// Canjear masaje gratuito
app.post('/api/premium/canjear-gratuito', async (req, res) => {
    const { email } = req.body;
    
    try {
        let usuarios = JSON.parse(await fs.readFile(PREMIUM_USUARIOS_FILE, 'utf8'));
        const index = usuarios.findIndex(u => u.email === email);
        
        if (index >= 0 && usuarios[index].masaje_gratuito_disponible) {
            usuarios[index].masaje_gratuito_disponible = false;
            usuarios[index].ultimo_masaje_gratuito = new Date().toISOString();
            await fs.writeFile(PREMIUM_USUARIOS_FILE, JSON.stringify(usuarios, null, 2));
            res.json({ success: true, mensaje: "¡Masaje gratuito canjeado! Agenda tu cita." });
        } else {
            res.json({ success: false, mensaje: "No tienes un masaje gratuito disponible." });
        }
    } catch(e) {
        res.status(500).json({ error: 'Error' });
    }
});

// Actualizar nombre del usuario
app.post('/api/premium/actualizar-nombre', async (req, res) => {
    const { email, nombre } = req.body;
    
    try {
        let usuarios = JSON.parse(await fs.readFile(PREMIUM_USUARIOS_FILE, 'utf8'));
        const index = usuarios.findIndex(u => u.email === email);
        
        if (index >= 0) {
            usuarios[index].nombre = nombre;
            await fs.writeFile(PREMIUM_USUARIOS_FILE, JSON.stringify(usuarios, null, 2));
        }
        
        res.json({ success: true });
    } catch(e) {
        res.status(500).json({ error: 'Error' });
    }
});

// ==================== RESEÑAS ====================

// Obtener reseñas públicas
app.get('/api/resenas', async (req, res) => {
    try {
        const resenas = JSON.parse(await fs.readFile(RESENAS_FILE, 'utf8'));
        res.json(resenas.filter(r => r.aprobada !== false).slice(-20));
    } catch(e) {
        res.json([]);
    }
});

// Crear reseña (solo premium)
app.post('/api/resenas', async (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'No autorizado' });
    }
    const token = authHeader.substring(7);
    if (!validTokens.has(token) || validTokens.get(token) < Date.now()) {
        return res.status(401).json({ error: 'Sesión expirada' });
    }
    
    const { email, nombre, mensaje, imagenUrl } = req.body;
    
    if (!email || !mensaje) {
        return res.status(400).json({ error: 'Faltan datos' });
    }
    
    try {
        const usuarios = JSON.parse(await fs.readFile(PREMIUM_USUARIOS_FILE, 'utf8'));
        const usuario = usuarios.find(u => u.email === email);
        if (!usuario) {
            return res.status(403).json({ error: 'Solo usuarios premium pueden escribir reseñas' });
        }
        
        let resenas = JSON.parse(await fs.readFile(RESENAS_FILE, 'utf8'));
        const nuevaResena = {
            id: Date.now() + Math.random().toString(36),
            email: email,
            nombre: nombre || usuario.nombre || email.split('@')[0],
            mensaje: mensaje,
            imagenUrl: imagenUrl || null,
            fecha: new Date().toISOString(),
            aprobada: true
        };
        
        resenas.unshift(nuevaResena);
        
        if (resenas.length > 50) {
            resenas = resenas.slice(0, 50);
        }
        
        await fs.writeFile(RESENAS_FILE, JSON.stringify(resenas, null, 2));
        res.json({ success: true, resena: nuevaResena });
    } catch(e) {
        res.status(500).json({ error: 'Error' });
    }
});

// Eliminar reseña (admin)
app.delete('/api/resenas/:id', async (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'No autorizado' });
    }
    const token = authHeader.substring(7);
    if (!validTokens.has(token) || validTokens.get(token) < Date.now()) {
        return res.status(401).json({ error: 'Sesión expirada' });
    }
    
    const { id } = req.params;
    try {
        let resenas = JSON.parse(await fs.readFile(RESENAS_FILE, 'utf8'));
        resenas = resenas.filter(r => r.id !== id);
        await fs.writeFile(RESENAS_FILE, JSON.stringify(resenas, null, 2));
        res.json({ success: true });
    } catch(e) {
        res.status(500).json({ error: 'Error' });
    }
});

// ==================== WEBSOCKET PARA VOZ ====================
const server = app.listen(PORT, '0.0.0.0', async () => {
    await initAllFiles();
    console.log(`🌿 Serenity Spa iniciado en puerto ${PORT}`);
    console.log(`🔑 Palabras prohibidas: ${palabrasBaneadas.length}`);
    console.log(`🔒 Sistema de bloqueo activo - Admin excluido`);
    console.log(`🆘 Ruta de emergencia: /admin-emergencia/SERENITY2024`);
    console.log(`👑 Sistema Premium activado`);
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
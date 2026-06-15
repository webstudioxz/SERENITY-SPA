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
    'culo', 'cojones', 'pelotudo', 'boludo', 'forro'
];

// ==================== SISTEMA DE BLOQUEOS ====================
let bloqueos = new Map(); // IP -> { hasta, motivo, tipo, fecha, permanente, palabraOfensiva }
let historialBloqueos = [];
let cancelacionesPorIP = new Map(); // IP -> { count, firstCancelTime }
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

// Función para BLOQUEAR IP (con página de suspensión)
function bloquearIP(ip, motivo, tipo, palabraOfensiva, permanente = false) {
    const ipLimpia = ip.replace('::ffff:', '');
    const duracion = permanente ? 31536000000 : 3600000; // 1 año o 1 hora
    
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
    
    // Limpiar caché del usuario
    cancelacionesPorIP.delete(ipLimpia);
    turnosRecientesIP.delete(ipLimpia);
    
    console.log(`🔴 IP BLOQUEADA: ${ipLimpia} - ${motivo} (${permanente ? 'PERMANENTE' : '1 HORA'})`);
    
    // Guardar en archivo
    fs.writeFile(BLOQUEOS_FILE, JSON.stringify({
        bloqueos: Object.fromEntries(bloqueos),
        historial: historialBloqueos.slice(0, 500)
    }, null, 2)).catch(e => console.error('Error guardando bloqueo:', e));
}

function estaBloqueado(ip) {
    const ipLimpia = ip.replace('::ffff:', '');
    if (bloqueos.has(ipLimpia)) {
        const datos = bloqueos.get(ipLimpia);
        if (datos.permanente) return true;
        if (Date.now() < datos.hasta) return true;
        // Expirado, eliminar
        bloqueos.delete(ipLimpia);
        return false;
    }
    return false;
}

// Verificar palabras prohibidas y bloquear automáticamente
function verificarYSancionar(ip, texto) {
    const palabraEncontrada = contienePalabraProhibida(texto);
    if (palabraEncontrada) {
        // BLOQUEO INMEDIATO POR PALABRA PROHIBIDA
        bloquearIP(ip, `Uso de lenguaje prohibido: "${palabraEncontrada}"`, 'PALABRA_PROHIBIDA', palabraEncontrada, false);
        return { 
            bloqueado: true, 
            mensaje: `🚫 SERVICIO CANCELADO\n\nSu IP ha sido bloqueada por violar las normas de servicio de Serenity Spa.\n\nMotivo: Uso de lenguaje inapropiado ("${palabraEncontrada}")\n\nSi considera que es un error, contacte con soporte.` 
        };
    }
    return { bloqueado: false, mensaje: null };
}

// Registrar cancelación para control de spam
function registrarCancelacion(ip) {
    const ipLimpia = ip.replace('::ffff:', '');
    const ahora = Date.now();
    
    if (!cancelacionesPorIP.has(ipLimpia)) {
        cancelacionesPorIP.set(ipLimpia, { count: 1, firstTime: ahora });
    } else {
        const datos = cancelacionesPorIP.get(ipLimpia);
        if (ahora - datos.firstTime < 3600000) { // 1 hora
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
    }
    
    if (!fsSync.existsSync(HORARIOS_FILE)) {
        await fs.writeFile(HORARIOS_FILE, JSON.stringify(horariosConfig, null, 2));
    }
    
    if (!fsSync.existsSync(PAISES_FILE)) {
        await fs.writeFile(PAISES_FILE, JSON.stringify({ autorizados: [], bloqueados: [], modo: 'todos', ubicacionSalon: 'Salón Serenity Spa' }, null, 2));
    }
    
    if (!fsSync.existsSync(PALABRAS_BANEADAS_FILE)) {
        await fs.writeFile(PALABRAS_BANEADAS_FILE, JSON.stringify({ palabras: palabrasBaneadas }, null, 2));
    }
    
    if (fsSync.existsSync(BLOQUEOS_FILE)) {
        try {
            const data = JSON.parse(await fs.readFile(BLOQUEOS_FILE, 'utf8'));
            bloqueos = new Map(Object.entries(data.bloqueos || {}));
            historialBloqueos = data.historial || [];
            // Limpiar expirados
            const ahora = Date.now();
            for (const [ip, datos] of bloqueos) {
                if (ahora > datos.hasta && !datos.permanente) bloqueos.delete(ip);
            }
        } catch(e) {}
    }
    
    // Cargar servicios
    const data = await fs.readFile(SERVICIOS_FILE, 'utf8');
    serviciosData = JSON.parse(data);
    console.log(`✅ Servicios cargados: ${serviciosData.length}`);
    console.log(`🔒 Bloqueos activos: ${bloqueos.size}`);
}

// ==================== MIDDLEWARE DE VERIFICACIÓN DE IP ====================
app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    next();
});

// Middleware que muestra la página de bloqueo si la IP está bloqueada
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
                        border: 1px solid rgba(220, 38, 38, 0.3);
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
                    .separator{
                        height: 1px;
                        background: linear-gradient(90deg, transparent, rgba(201, 168, 122, 0.3), transparent);
                        margin: 1rem 0;
                    }
                </style>
                <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
            </head>
            <body>
                <div class="cancel-card">
                    <div class="icono">
                        <i class="fas fa-ban"></i>
                    </div>
                    <h1>Servicio Cancelado</h1>
                    <div class="badge">
                        <i class="fas fa-gavel"></i> Violación de Términos de Servicio
                    </div>
                    <p>Su acceso a Serenity Spa ha sido suspendido debido a una violación de nuestras normas de convivencia y términos de servicio.</p>
                    <div class="motivo">
                        <strong><i class="fas fa-shield-alt"></i> Motivo de la cancelación:</strong><br>
                        <span style="color: #dc2626;">⚠️ ${escapeHtml(bloqueo?.motivo || 'Violación de términos de servicio')}</span><br><br>
                        <strong><i class="fas fa-clock"></i> Fecha:</strong> ${new Date(bloqueo?.fecha || Date.now()).toLocaleString()}<br>
                        <strong><i class="fas fa-microchip"></i> Identificador:</strong> ${escapeHtml(ip.replace('::ffff:', ''))}<br>
                        ${bloqueo?.palabraOfensiva ? `<strong><i class="fas fa-comment-slash"></i> Término utilizado:</strong> "<span style="color: #dc2626;">${escapeHtml(bloqueo.palabraOfensiva)}</span>"<br>` : ''}
                        ${bloqueo?.permanente ? '<strong><i class="fas fa-lock"></i> Estado:</strong> Suspensión permanente' : '<strong><i class="fas fa-hourglass-half"></i> Estado:</strong> Suspensión temporal (1 hora)'}
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

// Health check
app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString(), servicios: serviciosData.length });
});

// Servicios
app.get('/api/servicios', (req, res) => {
    res.json(serviciosData.sort((a, b) => (a.orden || 999) - (b.orden || 999)));
});

// Horarios
app.get('/api/config/horarios', (req, res) => {
    res.json(horariosConfig);
});

// Chat IA con verificación de palabras prohibidas
app.post('/api/chat-ia', async (req, res) => {
    const ip = req.ip || req.socket.remoteAddress || '0.0.0.0';
    const { mensaje } = req.body;
    
    if (estaBloqueado(ip)) {
        return res.status(403).json({ error: 'Servicio cancelado por violación de normas' });
    }
    
    // VERIFICAR Y BLOQUEAR SI HAY PALABRAS PROHIBIDAS
    const sancion = verificarYSancionar(ip, mensaje);
    if (sancion.bloqueado) {
        return res.json({ respuesta: sancion.mensaje, modo: 'bloqueado' });
    }
    
    // Respuesta normal
    res.json({ respuesta: "Hola, ¿en qué puedo ayudarte?", modo: 'local' });
});

// Reserva de turnos
app.post('/turnos', async (req, res) => {
    const ip = req.ip || req.socket.remoteAddress || '0.0.0.0';
    const { nombre, telefono, massageType, dia, hora, codigoPais } = req.body;
    
    if (estaBloqueado(ip)) {
        return res.status(403).json({ error: 'Servicio cancelado por violación de normas' });
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
        ubicacion: 'Salón Serenity Spa',
        tipoServicio: 'salon',
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

// Cancelar por código
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
    
    // Registrar cancelación para control de spam
    registrarCancelacion(ip);
    
    res.json({ success: true, mensaje: `Turno del ${turno.dia} a las ${turno.hora}:00 cancelado.` });
});

// ==================== WEBSOCKET PARA VOZ ====================
const server = app.listen(PORT, '0.0.0.0', async () => {
    await initAllFiles();
    console.log(`🌿 Serenity Spa iniciado en puerto ${PORT}`);
    console.log(`🔑 Palabras prohibidas: ${palabrasBaneadas.length}`);
    console.log(`🔒 Sistema de bloqueo de IP activo`);
});

const wss = new WebSocket.Server({ server, path: '/ws-voice' });
let voiceClients = new Map();

wss.on('connection', (ws, req) => {
    const ip = req.socket.remoteAddress || 'desconocida';
    
    if (estaBloqueado(ip)) {
        ws.close(1008, 'IP bloqueada por violación de normas');
        return;
    }
    
    const cid = generarId();
    voiceClients.set(cid, { estado: 'inicial', datos: {} });
    
    ws.on('message', async (data) => {
        try {
            const m = JSON.parse(data);
            if (m.tipo === 'transcripcion') {
                // VERIFICAR PALABRAS PROHIBIDAS EN EL MENSAJE DE VOZ
                const sancion = verificarYSancionar(ip, m.texto);
                
                if (sancion.bloqueado) {
                    ws.send(JSON.stringify({ tipo: 'respuesta', texto: sancion.mensaje }));
                    setTimeout(() => ws.close(1008, 'Bloqueado'), 2000);
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
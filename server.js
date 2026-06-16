const express = require('express');
const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const crypto = require('crypto');
const WebSocket = require('ws');

const app = express();
const PORT = process.env.PORT || 5001;

// Archivos de datos
const TURNOS_FILE = path.join(__dirname, 'turnos.json');
const SERVICIOS_FILE = path.join(__dirname, 'servicios.json');
const CONFIG_FILE = path.join(__dirname, 'config.json');
const BLOQUEOS_FILE = path.join(__dirname, 'bloqueos.json');
const HORARIOS_FILE = path.join(__dirname, 'horarios.json');
const PALABRAS_BANEADAS_FILE = path.join(__dirname, 'palabras-baneadas.json');
const PREMIUM_USUARIOS_FILE = path.join(__dirname, 'premium_usuarios.json');
const PREMIUM_CONFIG_FILE = path.join(__dirname, 'premium_config.json');
const NOTIFICACIONES_FILE = path.join(__dirname, 'notificaciones.json');
const RESENAS_FILE = path.join(__dirname, 'resenas.json');
const IA_PERSONALIDAD_FILE = path.join(__dirname, 'ia_personalidad.json');
const UPLOADS_DIR = path.join(__dirname, 'uploads');

app.disable('x-powered-by');
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static(__dirname));
app.use('/uploads', express.static(UPLOADS_DIR));

if (!fsSync.existsSync(UPLOADS_DIR)) {
    fsSync.mkdirSync(UPLOADS_DIR, { recursive: true });
}

// ==================== RUTAS HTML ====================
app.get('/voice-assistant', (req, res) => res.sendFile(path.join(__dirname, 'voice-assistant.html')));
app.get('/voice-assistant.html', (req, res) => res.sendFile(path.join(__dirname, 'voice-assistant.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));
app.get('/admin.html', (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'login.html')));
app.get('/login.html', (req, res) => res.sendFile(path.join(__dirname, 'login.html')));
app.get('/premium-dashboard', (req, res) => res.sendFile(path.join(__dirname, 'premium-dashboard.html')));
app.get('/premium-dashboard.html', (req, res) => res.sendFile(path.join(__dirname, 'premium-dashboard.html')));
app.get('/registro', (req, res) => res.sendFile(path.join(__dirname, 'registro.html')));
app.get('/registro.html', (req, res) => res.sendFile(path.join(__dirname, 'registro.html')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// ==================== HEALTH CHECK ====================
app.get('/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        timestamp: new Date().toISOString()
    });
});

// ==================== CONFIGURACIÓN FRONTEND ====================
app.get('/api/config-frontend', (req, res) => {
    res.json({
        supabaseUrl: process.env.SUPABASE_URL || '',
        supabaseAnonKey: process.env.SUPABASE_ANON_KEY || ''
    });
});

// ==================== CONSTANTES ====================
let horariosConfig = {
    dias: ['lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado'],
    horarios: ['12:00', '16:00', '20:00']
};
let serviciosData = [];
let iaPersonalidad = {
    nombre: 'Asistente IA',
    tono: 'cálido y profesional',
    estilo: 'Soy un asistente virtual amable y servicial de Serenity Spa'
};
let palabrasBaneadas = [
    'puta', 'puto', 'mierda', 'coño', 'carajo', 'verga', 'chinga',
    'fuck', 'shit', 'bitch', 'idiota', 'estupido', 'imbecil', 'tarado',
    'pendejo', 'cabron', 'culo', 'cojones', 'pelotudo', 'boludo', 'maricon'
];
let bloqueos = new Map();
let historialBloqueos = [];
const validTokens = new Map();

// IPs permitidas para admin (siempre pueden acceder)
const ADMIN_IPS = new Set([
    '127.0.0.1',
    '::1',
    '::ffff:127.0.0.1'
]);

// ==================== FUNCIONES UTILITARIAS ====================
function generarId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2) + crypto.randomBytes(4).toString('hex');
}

function escapeHtml(s) {
    if (!s) return '';
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function generarCodigoCancelacion() {
    const caracteres = 'ABCDEFGHJKLMNPQRSTUVWXYZ0123456789';
    let codigo = '';
    for (let i = 0; i < 6; i++) {
        codigo += caracteres[Math.floor(Math.random() * caracteres.length)];
    }
    return codigo;
}

function getIpLimpia(ip) {
    return ip.replace('::ffff:', '').replace(/^::1$/, '127.0.0.1');
}

function estaBloqueado(ip) {
    const ipLimpia = getIpLimpia(ip);
    
    // Las IPs de admin nunca están bloqueadas
    if (ADMIN_IPS.has(ipLimpia)) return false;
    
    if (bloqueos.has(ipLimpia)) {
        const datos = bloqueos.get(ipLimpia);
        if (datos.permanente) return true;
        if (Date.now() < datos.hasta) return true;
        bloqueos.delete(ipLimpia);
        return false;
    }
    return false;
}

function bloquearIP(ip, motivo, tipo, palabraOfensiva, permanente = true) {
    const ipLimpia = getIpLimpia(ip);
    
    // No bloquear IPs de admin
    if (ADMIN_IPS.has(ipLimpia)) return;
    
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
        id: generarId() 
    });
    
    console.log(`🔴 IP BLOQUEADA PERMANENTEMENTE: ${ipLimpia} - ${motivo}`);
    
    fs.writeFile(BLOQUEOS_FILE, JSON.stringify({
        bloqueos: Object.fromEntries(bloqueos),
        historial: historialBloqueos.slice(0, 500)
    }, null, 2)).catch(e => console.error('Error guardando:', e));
}

// ==================== MIDDLEWARE DE BLOQUEO ====================
app.use((req, res, next) => {
    const ip = req.ip || req.socket.remoteAddress || '0.0.0.0';
    const ipLimpia = getIpLimpia(ip);
    
    // Rutas que siempre están permitidas (admin, login, assets)
    const rutasPublicas = [
        '/admin', '/admin.html', '/login', '/login.html', 
        '/api/login', '/api/verify', '/api/seguridad',
        '/health', '/uploads', '/api/config-frontend',
        '/favicon.ico', '/css/', '/js/', '/fonts/'
    ];
    
    // Si es una ruta pública o de admin, permitir siempre
    if (rutasPublicas.some(ruta => req.path.startsWith(ruta))) {
        return next();
    }
    
    // Verificar si está bloqueado
    if (estaBloqueado(ip)) {
        const datos = bloqueos.get(ipLimpia);
        return res.status(403).send(`
            <!DOCTYPE html>
            <html lang="es">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>Acceso Denegado | Serenity Spa</title>
                <style>
                    *{margin:0;padding:0;box-sizing:border-box}
                    body{
                        font-family: 'Arial', sans-serif;
                        background: #0d0804;
                        min-height: 100vh;
                        display: flex;
                        align-items: center;
                        justify-content: center;
                        padding: 1rem;
                        color: #e8d5b8;
                    }
                    .blocked-card{
                        max-width: 550px;
                        width: 100%;
                        background: #1c1009;
                        border: 2px solid #dc2626;
                        border-radius: 24px;
                        padding: 2.5rem 2rem;
                        text-align: center;
                    }
                    .blocked-card .icon{
                        font-size: 4rem;
                        color: #dc2626;
                        margin-bottom: 1rem;
                    }
                    .blocked-card h1{
                        font-size: 1.8rem;
                        color: #dc2626;
                        margin-bottom: 0.5rem;
                    }
                    .blocked-card .subtitle{
                        color: #a8906e;
                        font-size: 0.9rem;
                        margin-bottom: 1.5rem;
                    }
                    .blocked-card .reason{
                        background: rgba(220, 38, 38, 0.1);
                        border: 1px solid rgba(220, 38, 38, 0.3);
                        border-radius: 12px;
                        padding: 1rem;
                        margin-bottom: 1.5rem;
                        font-size: 0.85rem;
                        color: #f87171;
                    }
                    .blocked-card .reason strong{
                        display: block;
                        margin-bottom: 0.3rem;
                        color: #dc2626;
                    }
                    .blocked-card .btn-back{
                        display: inline-block;
                        padding: 0.7rem 1.8rem;
                        background: rgba(255,255,255,0.05);
                        border: 1px solid rgba(255,255,255,0.1);
                        border-radius: 50px;
                        color: #e8d5b8;
                        text-decoration: none;
                        transition: all 0.3s;
                        font-size: 0.85rem;
                    }
                    .blocked-card .btn-back:hover{
                        background: rgba(255,255,255,0.1);
                        border-color: #c9a87a;
                    }
                    .blocked-card .footer-text{
                        margin-top: 1.5rem;
                        font-size: 0.7rem;
                        color: #4b5563;
                    }
                </style>
            </head>
            <body>
                <div class="blocked-card">
                    <div class="icon"><i class="fas fa-ban"></i></div>
                    <h1>🚫 Acceso Denegado</h1>
                    <p class="subtitle">Su cuenta ha sido suspendida permanentemente</p>
                    <div class="reason">
                        <strong>Motivo:</strong>
                        ${escapeHtml(datos?.motivo || 'Violación de los términos de servicio')}
                        ${datos?.palabraOfensiva ? `<br><span style="color:#f87171;">Palabra ofensiva: "<strong>${escapeHtml(datos.palabraOfensiva)}</strong>"</span>` : ''}
                        <br><br>
                        <span style="color:#a8906e;font-size:0.75rem;">
                            Fecha: ${new Date(datos?.fecha || Date.now()).toLocaleString()}
                        </span>
                    </div>
                    <p style="color:#a8906e;font-size:0.85rem;margin-bottom:1rem;">
                        Su IP ha sido bloqueada por no respetar los términos de servicio.<br>
                        Esta acción es permanente y no se puede deshacer.
                    </p>
                    <a href="/" class="btn-back"><i class="fas fa-arrow-left"></i> Volver al inicio</a>
                    <div class="footer-text">
                        Serenity Spa · Todos los derechos reservados
                    </div>
                </div>
                <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
            </body>
            </html>
        `);
    }
    next();
});

// ==================== AUTENTICACIÓN ADMIN ====================
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

// ==================== CONFIGURACIÓN ====================
app.get('/api/config', async (req, res) => {
    try {
        const config = JSON.parse(await fs.readFile(CONFIG_FILE, 'utf8'));
        res.json(config);
    } catch(e) {
        res.json({ hero: {}, serviciosSection: {} });
    }
});

app.put('/api/config', async (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) return res.status(401).json({ error: 'No autorizado' });
    try {
        await fs.writeFile(CONFIG_FILE, JSON.stringify(req.body, null, 2));
        res.json({ success: true });
    } catch(e) {
        res.status(500).json({ error: 'Error' });
    }
});

app.get('/api/config/horarios', async (req, res) => {
    try {
        const data = JSON.parse(await fs.readFile(HORARIOS_FILE, 'utf8'));
        res.json(data);
    } catch(e) {
        res.json(horariosConfig);
    }
});

app.put('/api/config/horarios', async (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) return res.status(401).json({ error: 'No autorizado' });
    try {
        horariosConfig = req.body;
        await fs.writeFile(HORARIOS_FILE, JSON.stringify(horariosConfig, null, 2));
        res.json({ success: true });
    } catch(e) {
        res.status(500).json({ error: 'Error' });
    }
});

// ==================== SUBIDA DE IMÁGENES ====================
app.post('/api/upload', async (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) return res.status(401).json({ error: 'No autorizado' });
    
    const { image } = req.body;
    if (!image) return res.status(400).json({ error: 'No image provided' });
    
    try {
        const matches = image.match(/^data:image\/([A-Za-z-+\/]+);base64,(.+)$/);
        if (!matches || matches.length !== 3) {
            return res.status(400).json({ error: 'Invalid image format' });
        }
        
        const ext = matches[1].split('/')[0];
        const filename = `${generarId()}.${ext}`;
        const filepath = path.join(UPLOADS_DIR, filename);
        
        await fs.writeFile(filepath, matches[2], 'base64');
        res.json({ url: `/uploads/${filename}` });
    } catch(e) {
        res.status(500).json({ error: 'Error uploading image' });
    }
});

// ==================== SERVICIOS ====================
app.get('/api/servicios', (req, res) => {
    res.json(serviciosData.sort((a, b) => (a.orden || 999) - (b.orden || 999)));
});

app.post('/api/servicios', async (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) return res.status(401).json({ error: 'No autorizado' });
    
    try {
        const nuevoServicio = {
            id: generarId(),
            nombre: req.body.nombre || 'Servicio',
            precio: req.body.precio || '$0',
            descripcion: req.body.descripcion || '',
            videoUrl: req.body.videoUrl || '',
            imagenWeb: req.body.imagenWeb || '',
            imagenWhatsApp: req.body.imagenWhatsApp || '',
            beneficios: req.body.beneficios || [],
            efectos: req.body.efectos || [],
            orden: serviciosData.length + 1
        };
        
        serviciosData.push(nuevoServicio);
        await fs.writeFile(SERVICIOS_FILE, JSON.stringify(serviciosData, null, 2));
        res.status(201).json(nuevoServicio);
    } catch(e) {
        res.status(500).json({ error: 'Error al crear servicio' });
    }
});

app.put('/api/servicios/:id', async (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) return res.status(401).json({ error: 'No autorizado' });
    
    const id = req.params.id;
    const index = serviciosData.findIndex(s => s.id === id);
    
    if (index === -1) return res.status(404).json({ error: 'Servicio no encontrado' });
    
    try {
        serviciosData[index] = {
            ...serviciosData[index],
            nombre: req.body.nombre || serviciosData[index].nombre,
            precio: req.body.precio || serviciosData[index].precio,
            descripcion: req.body.descripcion || serviciosData[index].descripcion,
            videoUrl: req.body.videoUrl || serviciosData[index].videoUrl || '',
            imagenWeb: req.body.imagenWeb || serviciosData[index].imagenWeb || '',
            imagenWhatsApp: req.body.imagenWhatsApp || serviciosData[index].imagenWhatsApp || '',
            beneficios: req.body.beneficios || serviciosData[index].beneficios || [],
            efectos: req.body.efectos || serviciosData[index].efectos || []
        };
        
        await fs.writeFile(SERVICIOS_FILE, JSON.stringify(serviciosData, null, 2));
        res.json(serviciosData[index]);
    } catch(e) {
        res.status(500).json({ error: 'Error al actualizar servicio' });
    }
});

app.delete('/api/servicios/:id', async (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) return res.status(401).json({ error: 'No autorizado' });
    
    serviciosData = serviciosData.filter(s => s.id !== req.params.id);
    await fs.writeFile(SERVICIOS_FILE, JSON.stringify(serviciosData, null, 2));
    res.json({ success: true });
});

// ==================== TURNOS ====================
app.get('/turnos', async (req, res) => {
    try {
        const turnos = JSON.parse(await fs.readFile(TURNOS_FILE, 'utf8'));
        res.json(turnos);
    } catch(e) {
        res.json([]);
    }
});

app.post('/turnos', async (req, res) => {
    const ip = req.ip || req.socket.remoteAddress || '0.0.0.0';
    const { nombre, telefono, massageType, dia, hora, codigoPais, ubicacion, tipoServicio, email } = req.body;
    
    console.log('📝 Intentando reservar turno:', { nombre, telefono, massageType, dia, hora });
    
    // Verificar bloqueo (el middleware ya lo hace, pero lo reforzamos)
    if (estaBloqueado(ip)) {
        return res.status(403).json({ error: 'IP bloqueada permanentemente' });
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
    if (!diaLower || !horariosConfig.dias.includes(diaLower)) {
        return res.status(400).json({ error: `Día inválido. Días disponibles: ${horariosConfig.dias.join(', ')}` });
    }
    
    const hn = parseInt(hora);
    const horasValidas = horariosConfig.horarios.map(h => parseInt(h.split(':')[0]));
    if (!horasValidas.includes(hn)) {
        return res.status(400).json({ error: `Hora inválida. Horarios: ${horariosConfig.horarios.join(', ')}` });
    }
    
    try {
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
            codigoCancelacion: codigoCancelacion,
            email: email || null
        };
        
        turnos.push(nuevoTurno);
        await fs.writeFile(TURNOS_FILE, JSON.stringify(turnos, null, 2));
        
        console.log(`✅ Turno reservado: ${nuevoTurno.nombre} - ${nuevoTurno.dia} ${nuevoTurno.hora}:00`);
        
        res.status(201).json({ 
            mensaje: 'Turno reservado', 
            turno: nuevoTurno,
            codigoCancelacion: codigoCancelacion
        });
    } catch(e) {
        console.error('❌ Error reservando turno:', e);
        res.status(500).json({ error: 'Error al reservar turno' });
    }
});

app.delete('/turnos/:id', async (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) return res.status(401).json({ error: 'No autorizado' });
    
    try {
        const turnos = JSON.parse(await fs.readFile(TURNOS_FILE, 'utf8'));
        const nuevosTurnos = turnos.filter(t => t.id !== req.params.id);
        await fs.writeFile(TURNOS_FILE, JSON.stringify(nuevosTurnos, null, 2));
        res.json({ success: true });
    } catch(e) {
        res.status(500).json({ error: 'Error al eliminar turno' });
    }
});

app.post('/api/cancelar-por-codigo', async (req, res) => {
    const ip = req.ip || req.socket.remoteAddress || '0.0.0.0';
    const { codigo } = req.body;
    
    if (estaBloqueado(ip)) {
        return res.status(403).json({ error: 'IP bloqueada' });
    }
    
    if (!codigo || codigo.length !== 6) {
        return res.status(400).json({ error: 'Código inválido' });
    }
    
    try {
        const turnos = JSON.parse(await fs.readFile(TURNOS_FILE, 'utf8'));
        const turnoIndex = turnos.findIndex(t => t.codigoCancelacion === codigo.toUpperCase());
        
        if (turnoIndex === -1) {
            return res.json({ success: false, error: 'Código incorrecto. Verifica tu código de cancelación.' });
        }
        
        const turno = turnos[turnoIndex];
        turnos.splice(turnoIndex, 1);
        await fs.writeFile(TURNOS_FILE, JSON.stringify(turnos, null, 2));
        
        res.json({ success: true, mensaje: `✅ Turno del ${turno.dia} a las ${turno.hora}:00 cancelado correctamente.` });
    } catch(e) {
        res.status(500).json({ error: 'Error al cancelar turno' });
    }
});

// ==================== CHAT IA (RESERVA DIRECTA) ====================
app.post('/api/chat-ia', async (req, res) => {
    const ip = req.ip || req.socket.remoteAddress || '0.0.0.0';
    const { mensaje, nombre, codigoPais, isPremium, discount } = req.body;
    
    if (estaBloqueado(ip)) {
        return res.json({ respuesta: '🚫 Su IP ha sido bloqueada permanentemente por violar los términos de servicio. No puede utilizar este servicio.' });
    }
    
    try {
        const iaData = JSON.parse(await fs.readFile(IA_PERSONALIDAD_FILE, 'utf8'));
        iaPersonalidad = iaData;
    } catch(e) {}
    
    let respuesta = '';
    const msg = mensaje.toLowerCase().trim();
    
    // Verificar palabras prohibidas - BLOQUEO PERMANENTE
    for (const palabra of palabrasBaneadas) {
        if (msg.includes(palabra)) {
            // Bloquear IP permanentemente
            bloquearIP(ip, `Uso de lenguaje prohibido: "${palabra}"`, 'PALABRA_PROHIBIDA', palabra, true);
            return res.json({ 
                respuesta: `🚫 SERVICIO CANCELADO\n\nSu IP ha sido BLOQUEADA PERMANENTEMENTE por violar los términos de servicio.\n\nMotivo: Uso de lenguaje inapropiado ("${palabra}")\n\nEsta acción es permanente y no se puede deshacer.` 
            });
        }
    }
    
    // ==================== FLUJO DE RESERVA DIRECTO ====================
    if (msg.includes('reservar') || msg.includes('turno') || msg.includes('cita') || msg.includes('agendar')) {
        if (!nombre) {
            respuesta = `📅 ¡Perfecto! Voy a ayudarte a reservar un turno.\n\n📛 ¿Cuál es tu nombre completo?`;
            res.json({ respuesta });
            return;
        }
        
        const nombreRegex = /(?:me\s+llamo|mi\s+nombre\s+es|soy)\s+([A-ZÁÉÍÓÚÑ][a-záéíóúñ]*(?:\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ]*){0,2})/i;
        const nombreMatch = msg.match(nombreRegex);
        const nombreCliente = nombreMatch ? nombreMatch[1] : nombre;
        
        const paisesMap = {
            'cuba': '53', 'argentina': '54', 'mexico': '52', 'colombia': '57',
            'chile': '56', 'peru': '51', 'españa': '34', 'venezuela': '58',
            'ecuador': '593', 'uruguay': '598', 'paraguay': '595', 'bolivia': '591',
            'brasil': '55', 'estados unidos': '1', 'usa': '1'
        };
        let codPais = codigoPais || '53';
        for (const [pais, codigo] of Object.entries(paisesMap)) {
            if (msg.includes(pais)) {
                codPais = codigo;
                break;
            }
        }
        
        const diasMap = {
            'lunes': 'lunes', 'martes': 'martes', 'miercoles': 'miercoles',
            'miércoles': 'miercoles', 'jueves': 'jueves', 'viernes': 'viernes',
            'sabado': 'sabado', 'sábado': 'sabado'
        };
        let diaSeleccionado = null;
        for (const [key, value] of Object.entries(diasMap)) {
            if (msg.includes(key)) {
                diaSeleccionado = value;
                break;
            }
        }
        
        const horasValidas = horariosConfig.horarios.map(h => parseInt(h.split(':')[0]));
        let horaSeleccionada = null;
        for (const h of horasValidas) {
            if (msg.includes(h.toString()) || msg.includes(`${h}:00`)) {
                horaSeleccionada = h;
                break;
            }
        }
        
        const masajesMap = {
            'relajante': 'Relajante',
            'corporal': 'Corporal',
            'facial': 'Facial'
        };
        let masajeSeleccionado = null;
        for (const [key, value] of Object.entries(masajesMap)) {
            if (msg.includes(key)) {
                masajeSeleccionado = value;
                break;
            }
        }
        
        const telefonoRegex = /(\d{7,15})/g;
        const telefonoMatch = msg.match(telefonoRegex);
        let telefono = telefonoMatch ? telefonoMatch[0] : null;
        
        if (nombreCliente && telefono && diaSeleccionado && horaSeleccionada !== null) {
            try {
                const turnos = JSON.parse(await fs.readFile(TURNOS_FILE, 'utf8'));
                if (turnos.some(t => t.telefono === telefono && t.dia === diaSeleccionado)) {
                    respuesta = `❌ Ya tienes un turno reservado para el día ${diaSeleccionado}.`;
                    res.json({ respuesta });
                    return;
                }
                
                if (turnos.some(t => t.dia === diaSeleccionado && t.hora === horaSeleccionada)) {
                    respuesta = `❌ Horario ocupado para el ${diaSeleccionado} a las ${horaSeleccionada}:00. Por favor, elige otro horario.`;
                    res.json({ respuesta });
                    return;
                }
                
                const codigoCancelacion = generarCodigoCancelacion();
                const nuevoTurno = {
                    id: generarId(),
                    nombre: escapeHtml(nombreCliente),
                    dia: diaSeleccionado,
                    hora: horaSeleccionada,
                    massageType: masajeSeleccionado || 'Masaje',
                    telefono: telefono,
                    codigoPais: codPais,
                    ubicacion: 'Salón Serenity Spa',
                    tipoServicio: 'salon',
                    confirmadoWhatsApp: false,
                    fechaCreacion: new Date().toISOString(),
                    ip: ip.replace('::ffff:', ''),
                    codigoCancelacion: codigoCancelacion,
                    email: req.body.email || null
                };
                
                turnos.push(nuevoTurno);
                await fs.writeFile(TURNOS_FILE, JSON.stringify(turnos, null, 2));
                
                respuesta = `✅ ¡TURNO CONFIRMADO!\n\n📛 Nombre: ${nombreCliente}\n📆 Día: ${diaSeleccionado}\n⏰ Hora: ${horaSeleccionada}:00\n💆 Masaje: ${masajeSeleccionado || 'Masaje'}\n📞 Teléfono: +${codPais} ${telefono}\n🔑 Código de cancelación: ${codigoCancelacion}\n\nTe esperamos en Serenity Spa. ¡Gracias por tu reserva!`;
            } catch(e) {
                console.error('Error reservando turno:', e);
                respuesta = '❌ Hubo un error al procesar tu reserva. Por favor, intenta de nuevo.';
            }
        } else {
            let faltantes = [];
            if (!telefono) faltantes.push('📞 tu número de teléfono');
            if (!diaSeleccionado) faltantes.push(`📆 qué día prefieres (${horariosConfig.dias.join(', ')})`);
            if (horaSeleccionada === null) faltantes.push(`⏰ a qué hora (${horariosConfig.horarios.join(', ')})`);
            if (!masajeSeleccionado) faltantes.push('💆 qué tipo de masaje (Relajante, Corporal, Facial)');
            
            respuesta = `📅 Para completar tu reserva, necesito:\n\n${faltantes.map((f, i) => `${i+1}. ${f}`).join('\n')}\n\nResponde con los datos que faltan.`;
        }
        
        res.json({ respuesta });
        return;
    }
    
    // CANCELAR TURNO
    if (msg.includes('cancelar') || msg.includes('anular') || msg.includes('eliminar')) {
        const codigoRegex = /\b([A-Z0-9]{6})\b/i;
        const codigoMatch = msg.match(codigoRegex);
        
        if (codigoMatch) {
            try {
                const turnos = JSON.parse(await fs.readFile(TURNOS_FILE, 'utf8'));
                const turnoIndex = turnos.findIndex(t => t.codigoCancelacion === codigoMatch[1].toUpperCase());
                
                if (turnoIndex === -1) {
                    respuesta = `❌ Código incorrecto. Verifica tu código de cancelación.`;
                } else {
                    const turno = turnos[turnoIndex];
                    turnos.splice(turnoIndex, 1);
                    await fs.writeFile(TURNOS_FILE, JSON.stringify(turnos, null, 2));
                    respuesta = `✅ Turno del ${turno.dia} a las ${turno.hora}:00 cancelado correctamente.`;
                }
            } catch(e) {
                respuesta = '❌ Error al cancelar. Intenta nuevamente.';
            }
        } else {
            respuesta = `🔑 Para cancelar tu reserva, necesito tu código de cancelación de 6 dígitos (ejemplo: A3B7X9).\n\nEste código te lo enviamos en el mensaje de confirmación de tu reserva.\n\nPor favor, ingresa tu código para continuar.`;
        }
        res.json({ respuesta });
        return;
    }
    
    // HORARIOS
    if (msg.includes('horario') || msg.includes('disponible') || msg.includes('días')) {
        respuesta = `🕐 Nuestros horarios disponibles son:\n\n${horariosConfig.horarios.join(' hs\n')} hs\n\n📅 Días de atención: ${horariosConfig.dias.map(d => d.charAt(0).toUpperCase() + d.slice(1)).join(', ')}.\n\n¿Te gustaría reservar un turno?`;
        res.json({ respuesta });
        return;
    }
    
    // PRECIOS
    if (msg.includes('precio') || msg.includes('cuesta') || msg.includes('costo') || msg.includes('valor')) {
        let lista = '💰 Estos son nuestros servicios y precios:\n\n';
        serviciosData.slice(0, 5).forEach(s => {
            lista += `• ${s.nombre}: ${s.precio}\n`;
        });
        if (isPremium) {
            lista += `\n✨ Como miembro premium, tienes ${discount}% de descuento en todos los servicios.`;
        }
        respuesta = lista;
        res.json({ respuesta });
        return;
    }
    
    // SALUDO
    if (msg.includes('hola') || msg.includes('buenas') || msg.includes('saludos') || msg.includes('hey')) {
        if (nombre) {
            respuesta = `👋 ¡Hola ${nombre}! Soy ${iaPersonalidad.nombre}, tu asistente de Serenity Spa.\n\n¿En qué puedo ayudarte hoy? Puedo:\n• Reservar un turno\n• Ver horarios disponibles\n• Consultar precios\n• Cancelar una reserva\n\n¿Qué necesitas?`;
        } else {
            respuesta = `👋 ¡Hola! Soy ${iaPersonalidad.nombre}, tu asistente de Serenity Spa.\n\n¿Cuál es tu nombre para comenzar? Así puedo conocerte mejor.`;
        }
        res.json({ respuesta });
        return;
    }
    
    // MENSAJE POR DEFECTO
    if (!nombre) {
        respuesta = `👋 ¡Hola! Soy ${iaPersonalidad.nombre}, tu asistente de Serenity Spa.\n\n¿Cuál es tu nombre para comenzar?\n\nPuedo ayudarte con:\n• Reservar un turno\n• Ver horarios disponibles\n• Consultar precios\n• Cancelar una reserva`;
    } else {
        respuesta = `${iaPersonalidad.estilo || 'Soy el asistente de Serenity Spa'}\n\nHola ${nombre}, ¿en qué puedo ayudarte hoy?\n\nPuedo asistirte con:\n• Reservar un turno\n• Ver horarios disponibles (${horariosConfig.horarios.join(', ')} hs)\n• Conocer precios de servicios\n• Cancelar una reserva con tu código\n\n¿Qué necesitas?`;
    }
    
    res.json({ respuesta });
});

// ==================== IA PERSONALIDAD ====================
app.get('/api/ia/personalidad', async (req, res) => {
    try {
        const data = JSON.parse(await fs.readFile(IA_PERSONALIDAD_FILE, 'utf8'));
        res.json(data);
    } catch(e) {
        res.json(iaPersonalidad);
    }
});

app.put('/api/ia/personalidad', async (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) return res.status(401).json({ error: 'No autorizado' });
    
    iaPersonalidad = req.body;
    await fs.writeFile(IA_PERSONALIDAD_FILE, JSON.stringify(iaPersonalidad, null, 2));
    res.json({ success: true });
});

// ==================== PALABRAS BANEADAS ====================
app.get('/api/palabras-baneadas', async (req, res) => {
    try {
        const data = JSON.parse(await fs.readFile(PALABRAS_BANEADAS_FILE, 'utf8'));
        res.json(data);
    } catch(e) {
        res.json({ palabras: palabrasBaneadas });
    }
});

app.post('/api/palabras-baneadas', async (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) return res.status(401).json({ error: 'No autorizado' });
    
    const { palabra, accion } = req.body;
    
    try {
        const data = JSON.parse(await fs.readFile(PALABRAS_BANEADAS_FILE, 'utf8'));
        let palabras = data.palabras || palabrasBaneadas;
        
        if (accion === 'agregar' && palabra && !palabras.includes(palabra.toLowerCase())) {
            palabras.push(palabra.toLowerCase());
        } else if (accion === 'eliminar' && palabra) {
            palabras = palabras.filter(p => p !== palabra);
        }
        
        await fs.writeFile(PALABRAS_BANEADAS_FILE, JSON.stringify({ palabras }, null, 2));
        res.json({ ok: true, palabras });
    } catch(e) {
        res.status(500).json({ error: 'Error' });
    }
});

// ==================== SEGURIDAD ====================
app.get('/api/seguridad/bloqueos', (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) return res.status(401).json({ error: 'No autorizado' });
    
    const activos = [];
    for (const [ip, datos] of bloqueos) {
        activos.push({ 
            ip, 
            motivo: datos.motivo, 
            tipoAtaque: datos.tipoAtaque, 
            fecha: datos.fecha, 
            permanente: datos.permanente,
            palabraOfensiva: datos.palabraOfensiva || null
        });
    }
    
    res.json({ activos, historial: historialBloqueos.slice(0, 100), intentosFallidos: {} });
});

app.post('/api/seguridad/desbloquear/:ip', (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) return res.status(401).json({ error: 'No autorizado' });
    
    const ipDesbloquear = req.params.ip;
    if (bloqueos.has(ipDesbloquear)) {
        bloqueos.delete(ipDesbloquear);
        fs.writeFileSync(BLOQUEOS_FILE, JSON.stringify({
            bloqueos: Object.fromEntries(bloqueos),
            historial: historialBloqueos
        }, null, 2));
        res.json({ ok: true, mensaje: `IP ${ipDesbloquear} desbloqueada` });
    } else {
        res.json({ ok: false, mensaje: 'IP no estaba bloqueada' });
    }
});

// ==================== PREMIUM ====================
app.get('/api/premium/usuarios', async (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) return res.status(401).json({ error: 'No autorizado' });
    
    try {
        const usuarios = JSON.parse(await fs.readFile(PREMIUM_USUARIOS_FILE, 'utf8'));
        res.json(usuarios);
    } catch(e) {
        res.json([]);
    }
});

app.get('/api/premium/usuario', async (req, res) => {
    const { email } = req.query;
    if (!email) return res.status(400).json({ error: 'Email requerido' });
    
    try {
        const usuarios = JSON.parse(await fs.readFile(PREMIUM_USUARIOS_FILE, 'utf8'));
        const usuario = usuarios.find(u => u.email === email);
        res.json(usuario || null);
    } catch(e) {
        res.json(null);
    }
});

app.post('/api/premium/usuario', async (req, res) => {
    const usuario = req.body;
    console.log('📝 Recibiendo usuario premium:', usuario.email);
    
    try {
        let usuarios = [];
        try {
            const data = await fs.readFile(PREMIUM_USUARIOS_FILE, 'utf8');
            usuarios = JSON.parse(data);
        } catch(e) {
            console.log('📂 Creando nuevo archivo premium_usuarios.json');
        }
        
        const index = usuarios.findIndex(u => u.email === usuario.email);
        
        if (index >= 0) {
            usuarios[index] = { ...usuarios[index], ...usuario };
            console.log(`✏️ Usuario actualizado: ${usuario.email}`);
        } else {
            usuarios.push(usuario);
            console.log(`➕ Nuevo usuario agregado: ${usuario.email}`);
        }
        
        await fs.writeFile(PREMIUM_USUARIOS_FILE, JSON.stringify(usuarios, null, 2));
        console.log(`✅ Usuario premium guardado: ${usuario.email} - Total: ${usuarios.length}`);
        res.json({ success: true, usuario: usuario });
    } catch(e) {
        console.error('❌ Error guardando usuario premium:', e);
        res.status(500).json({ error: 'Error al guardar usuario premium' });
    }
});

app.delete('/api/premium/usuario/:email', async (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) return res.status(401).json({ error: 'No autorizado' });
    
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

app.get('/api/premium/config', async (req, res) => {
    try {
        const config = JSON.parse(await fs.readFile(PREMIUM_CONFIG_FILE, 'utf8'));
        res.json(config);
    } catch(e) {
        res.json({ descuento_premium: 15 });
    }
});

app.put('/api/premium/config', async (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) return res.status(401).json({ error: 'No autorizado' });
    
    await fs.writeFile(PREMIUM_CONFIG_FILE, JSON.stringify(req.body, null, 2));
    res.json({ success: true });
});

app.post('/api/premium/notificar', async (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) return res.status(401).json({ error: 'No autorizado' });
    
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
        
        await fs.writeFile(NOTIFICACIONES_FILE, JSON.stringify(notificaciones.slice(-500), null, 2));
        res.json({ success: true, enviadas: usuarios.length });
    } catch(e) {
        res.status(500).json({ error: 'Error' });
    }
});

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

app.post('/api/premium/registrar-reserva', async (req, res) => {
    const { email, montoOriginal, montoPagado, dias } = req.body;
    
    try {
        let usuarios = JSON.parse(await fs.readFile(PREMIUM_USUARIOS_FILE, 'utf8'));
        const index = usuarios.findIndex(u => u.email === email);
        
        if (index >= 0) {
            usuarios[index].reservas_realizadas = (usuarios[index].reservas_realizadas || 0) + 1;
            usuarios[index].total_dias_masaje = (usuarios[index].total_dias_masaje || 0) + (dias || 1);
            usuarios[index].total_ahorrado = (usuarios[index].total_ahorrado || 0) + (montoOriginal - montoPagado);
            await fs.writeFile(PREMIUM_USUARIOS_FILE, JSON.stringify(usuarios, null, 2));
        }
        res.json({ success: true });
    } catch(e) {
        res.status(500).json({ error: 'Error' });
    }
});

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

// ==================== RESEÑAS ====================
app.get('/api/resenas', async (req, res) => {
    try {
        const resenas = JSON.parse(await fs.readFile(RESENAS_FILE, 'utf8'));
        res.json(resenas.filter(r => r.aprobada !== false).slice(-20));
    } catch(e) {
        res.json([]);
    }
});

app.post('/api/resenas', async (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) return res.status(401).json({ error: 'No autorizado' });
    
    const { email, nombre, mensaje, imagenUrl } = req.body;
    
    if (!mensaje) {
        return res.status(400).json({ error: 'Mensaje requerido' });
    }
    
    try {
        let resenas = JSON.parse(await fs.readFile(RESENAS_FILE, 'utf8'));
        const nuevaResena = {
            id: Date.now() + Math.random().toString(36),
            email: email || 'anonimo',
            nombre: nombre || 'Usuario Premium',
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

app.delete('/api/resenas/:id', async (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) return res.status(401).json({ error: 'No autorizado' });
    
    try {
        let resenas = JSON.parse(await fs.readFile(RESENAS_FILE, 'utf8'));
        resenas = resenas.filter(r => r.id !== req.params.id);
        await fs.writeFile(RESENAS_FILE, JSON.stringify(resenas, null, 2));
        res.json({ success: true });
    } catch(e) {
        res.status(500).json({ error: 'Error' });
    }
});

// ==================== WHATSAPP ====================
app.post('/api/enviar-whatsapp/:id', async (req, res) => {
    const { id } = req.params;
    try {
        const turnos = JSON.parse(await fs.readFile(TURNOS_FILE, 'utf8'));
        const turno = turnos.find(t => t.id === id);
        
        if (!turno) {
            return res.status(404).json({ error: 'Turno no encontrado' });
        }
        
        const mensaje = `Hola ${turno.nombre}, te recordamos tu turno en Serenity Spa para el día ${turno.dia} a las ${turno.hora}:00 hs. Tu código de cancelación es: ${turno.codigoCancelacion}. Si necesitas cancelar, usa este código. ¡Te esperamos!`;
        const numero = `${turno.codigoPais}${turno.telefono}`;
        
        res.json({ success: true, mensaje, numero });
    } catch(e) {
        res.status(500).json({ error: 'Error' });
    }
});

// ==================== WEBSOCKET ====================
const server = app.listen(PORT, '0.0.0.0', async () => {
    await initAllFiles();
    console.log(`🌿 Serenity Spa iniciado en puerto ${PORT}`);
    console.log(`🔑 Admin password: admin123`);
    console.log(`👑 Sistema Premium activado`);
    console.log(`🎤 WebSocket de voz disponible en /ws-voice`);
    console.log(`🛡️ Sistema de bloqueo permanente activado`);
});

const wss = new WebSocket.Server({ server, path: '/ws-voice' });

wss.on('connection', (ws, req) => {
    const ip = req.socket.remoteAddress || 'desconocida';
    console.log(`🎤 Cliente de voz conectado desde ${ip}`);
    
    // Verificar si está bloqueado
    if (estaBloqueado(ip)) {
        ws.send(JSON.stringify({ 
            tipo: 'respuesta', 
            texto: '🚫 SU IP HA SIDO BLOQUEADA PERMANENTEMENTE por violar los términos de servicio. No puede utilizar este servicio.' 
        }));
        ws.close();
        return;
    }
    
    ws.on('message', async (data) => {
        try {
            const m = JSON.parse(data);
            if (m.tipo === 'transcripcion' && m.texto) {
                console.log(`📝 Mensaje de voz: ${m.texto}`);
                
                const msg = m.texto.toLowerCase();
                let respuesta = '';
                
                for (const palabra of palabrasBaneadas) {
                    if (msg.includes(palabra)) {
                        bloquearIP(ip, `Uso de lenguaje prohibido en voz: "${palabra}"`, 'PALABRA_PROHIBIDA', palabra, true);
                        ws.send(JSON.stringify({ 
                            tipo: 'respuesta', 
                            texto: `🚫 SU IP HA SIDO BLOQUEADA PERMANENTEMENTE por usar lenguaje inapropiado ("${palabra}"). Esta acción es irreversible.` 
                        }));
                        ws.close();
                        return;
                    }
                }
                
                if (msg.includes('reservar') || msg.includes('turno') || msg.includes('cita')) {
                    respuesta = '📅 Para reservar un turno, dime tu nombre, teléfono, día, hora y tipo de masaje. Por ejemplo: "Quiero reservar un masaje relajante para el lunes a las 16:00, mi nombre es Juan, teléfono 555123456"';
                } else if (msg.includes('cancelar') || msg.includes('anular')) {
                    respuesta = '🔑 Para cancelar una reserva, necesito tu código de 6 dígitos. Por ejemplo: "Cancelar con código A3B7X9"';
                } else if (msg.includes('horario') || msg.includes('disponible')) {
                    respuesta = `🕐 Horarios disponibles: ${horariosConfig.horarios.join(', ')} hs. Días: ${horariosConfig.dias.join(', ')}.`;
                } else if (msg.includes('hola') || msg.includes('buenas')) {
                    respuesta = '👋 ¡Hola! Soy el asistente de voz de Serenity Spa. ¿En qué puedo ayudarte? Puedo reservar turnos, mostrar horarios o cancelar reservas.';
                } else if (msg.includes('precio') || msg.includes('cuesta')) {
                    respuesta = '💰 Nuestros servicios: Masaje Relajante $45, Masaje Corporal $65, Masaje Facial $40.';
                } else {
                    respuesta = '🤔 ¿En qué más puedo ayudarte? Puedo reservar turnos, mostrar horarios de atención, precios de servicios, o cancelar una reserva con tu código.';
                }
                
                ws.send(JSON.stringify({ tipo: 'respuesta', texto: respuesta }));
            }
        } catch(e) {
            console.error('Error en WebSocket:', e);
        }
    });
    
    ws.on('close', () => {
        console.log(`🎤 Cliente de voz desconectado`);
    });
    
    ws.send(JSON.stringify({ 
        tipo: 'respuesta', 
        texto: '🎤 Conectado al asistente de voz de Serenity Spa.\n\nPuedo ayudarte con:\n• Reservar un turno\n• Información de horarios\n• Precios de servicios\n• Cancelar una reserva con tu código\n\n¿En qué puedo ayudarte?' 
    }));
});
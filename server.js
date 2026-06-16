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

// ==================== MIDDLEWARE BÁSICO ====================
app.disable('x-powered-by');
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

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
    if (!ip) return '0.0.0.0';
    return ip.replace('::ffff:', '').replace(/^::1$/, '127.0.0.1');
}

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

// ==================== FUNCIONES DE BLOQUEO ====================
function estaBloqueado(ip) {
    const ipLimpia = getIpLimpia(ip);
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
    
    try {
        fsSync.writeFileSync(BLOQUEOS_FILE, JSON.stringify({
            bloqueos: Object.fromEntries(bloqueos),
            historial: historialBloqueos.slice(0, 500)
        }, null, 2));
    } catch(e) {
        console.error('Error guardando bloqueos:', e);
    }
}

function contienePalabraProhibida(texto) {
    if (!texto) return null;
    const textoLower = texto.toLowerCase();
    for (const palabra of palabrasBaneadas) {
        if (textoLower.includes(palabra.toLowerCase())) {
            return palabra;
        }
    }
    return null;
}

function renderBlockedPage(datos) {
    return `
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
                    border: 3px solid #dc2626;
                    border-radius: 24px;
                    padding: 2.5rem 2rem;
                    text-align: center;
                    box-shadow: 0 0 60px rgba(220,38,38,0.15);
                }
                .blocked-card .icon{
                    font-size: 4rem;
                    color: #dc2626;
                    margin-bottom: 1rem;
                }
                .blocked-card .icon i{
                    animation: pulse 1.5s ease-in-out infinite;
                }
                @keyframes pulse{
                    0%,100%{transform:scale(1)}
                    50%{transform:scale(1.15)}
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
                    background: rgba(220,38,38,0.08);
                    border: 1px solid rgba(220,38,38,0.25);
                    border-radius: 12px;
                    padding: 1rem;
                    margin-bottom: 1.5rem;
                    font-size: 0.85rem;
                    color: #f87171;
                    text-align: left;
                }
                .blocked-card .reason strong{
                    display: block;
                    margin-bottom: 0.3rem;
                    color: #dc2626;
                    font-size: 0.9rem;
                }
                .blocked-card .reason .palabra{
                    display: inline-block;
                    background: rgba(220,38,38,0.2);
                    padding: 0.15rem 0.7rem;
                    border-radius: 20px;
                    color: #fca5a5;
                    font-weight: 700;
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
                .blocked-card .ip-info{
                    font-size: 0.7rem;
                    color: #4b5563;
                    margin-top: 0.5rem;
                }
                .blocked-card .divider{
                    width: 40px;
                    height: 2px;
                    background: #dc2626;
                    margin: 0.8rem auto;
                    opacity: 0.3;
                }
            </style>
        </head>
        <body>
            <div class="blocked-card">
                <div class="icon"><i class="fas fa-ban"></i></div>
                <h1>🚫 Acceso Denegado</h1>
                <p class="subtitle">Su cuenta ha sido suspendida permanentemente</p>
                <div class="divider"></div>
                <div class="reason">
                    <strong>⚠️ Motivo del bloqueo:</strong>
                    ${escapeHtml(datos?.motivo || 'Violación de los términos de servicio')}
                    ${datos?.palabraOfensiva ? `<br><br><span style="color:#f87171;">📝 Palabra ofensiva detectada: <span class="palabra">"${escapeHtml(datos.palabraOfensiva)}"</span></span>` : ''}
                    <br><br>
                    <span style="color:#a8906e;font-size:0.75rem;">
                        📅 Fecha: ${new Date(datos?.fecha || Date.now()).toLocaleString()}
                        <br>
                        🌐 IP: <span style="color:#e8d5b8;">${datos?.ip || 'Desconocida'}</span>
                    </span>
                </div>
                <p style="color:#a8906e;font-size:0.85rem;margin-bottom:1rem;line-height:1.6;">
                    Su IP ha sido bloqueada permanentemente por no respetar los<br>
                    <strong style="color:#e8d5b8;">Términos y Condiciones de Serenity Spa</strong>.
                    <br><br>
                    <span style="font-size:0.75rem;color:#4b5563;">
                        Esta acción es irreversible. Si considera que es un error,<br>
                        contacte con el administrador.
                    </span>
                </p>
                <a href="/" class="btn-back"><i class="fas fa-arrow-left"></i> Volver al inicio</a>
                <div class="footer-text">
                    Serenity Spa · Todos los derechos reservados
                </div>
            </div>
            <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
        </body>
        </html>
    `;
}

// ==================== INICIALIZACIÓN DE ARCHIVOS ====================
async function initAllFiles() {
    console.log('🔧 Inicializando archivos...');
    
    // Crear directorio uploads
    if (!fsSync.existsSync(UPLOADS_DIR)) {
        fsSync.mkdirSync(UPLOADS_DIR, { recursive: true });
    }
    
    if (!fsSync.existsSync(SERVICIOS_FILE)) {
        const serviciosDefault = [
            { id: generarId(), nombre: "Masaje Relajante", precio: "$45", descripcion: "Movimientos suaves para liberar el estrés.", beneficios: ["60 Minutos de relajación", "Aceites esenciales"], efectos: ["Relajación profunda", "Reducción del estrés"], videoUrl: "", imagenWeb: "https://images.unsplash.com/photo-1544161515-4ab6ce6db874?w=800", imagenWhatsApp: "", orden: 1 },
            { id: generarId(), nombre: "Masaje Corporal", precio: "$65", descripcion: "Tratamiento completo para una relajación profunda.", beneficios: ["90 Minutos", "Técnica personalizada"], efectos: ["Activación linfática", "Alivio muscular"], videoUrl: "", imagenWeb: "https://images.unsplash.com/photo-1519823551278-64ac92734fb1?w=800", imagenWhatsApp: "", orden: 2 },
            { id: generarId(), nombre: "Masaje Facial", precio: "$40", descripcion: "Rejuvenece la piel y alivia la tensión facial.", beneficios: ["45 Minutos", "Productos naturales"], efectos: ["Estimula colágeno", "Piel radiante"], videoUrl: "", imagenWeb: "https://images.unsplash.com/photo-1570172619644-dfd03ed5d881?w=800", imagenWhatsApp: "", orden: 3 }
        ];
        await fs.writeFile(SERVICIOS_FILE, JSON.stringify(serviciosDefault, null, 2));
        console.log('✅ servicios.json creado');
    }
    
    const files = [
        { path: TURNOS_FILE, data: [] },
        { path: HORARIOS_FILE, data: horariosConfig },
        { path: PALABRAS_BANEADAS_FILE, data: { palabras: palabrasBaneadas } },
        { path: PREMIUM_USUARIOS_FILE, data: [] },
        { path: PREMIUM_CONFIG_FILE, data: { descuento_premium: 15 } },
        { path: NOTIFICACIONES_FILE, data: [] },
        { path: RESENAS_FILE, data: [] },
        { path: IA_PERSONALIDAD_FILE, data: iaPersonalidad },
        { path: CONFIG_FILE, data: { hero: {}, serviciosSection: {} } }
    ];
    
    for (const file of files) {
        if (!fsSync.existsSync(file.path)) {
            await fs.writeFile(file.path, JSON.stringify(file.data, null, 2));
            console.log(`✅ ${path.basename(file.path)} creado`);
        }
    }
    
    // Cargar bloqueos existentes
    if (fsSync.existsSync(BLOQUEOS_FILE)) {
        try {
            const data = JSON.parse(await fs.readFile(BLOQUEOS_FILE, 'utf8'));
            bloqueos = new Map(Object.entries(data.bloqueos || {}));
            historialBloqueos = data.historial || [];
            console.log(`✅ Bloqueos cargados: ${bloqueos.size} IPs bloqueadas`);
        } catch(e) {}
    }
    
    // Cargar servicios
    try {
        const data = await fs.readFile(SERVICIOS_FILE, 'utf8');
        serviciosData = JSON.parse(data);
        console.log(`✅ Servicios cargados: ${serviciosData.length}`);
    } catch(e) {
        console.error('❌ Error cargando servicios:', e);
    }
}

// ==================== MIDDLEWARE DE BLOQUEO (PRIMERO - ANTES DE TODO) ====================
app.use((req, res, next) => {
    const ip = req.ip || req.socket.remoteAddress || '0.0.0.0';
    const ipLimpia = getIpLimpia(ip);
    
    // Rutas de admin SIEMPRE permitidas
    const rutasAdmin = [
        '/admin', '/admin.html', '/login', '/login.html', 
        '/api/login', '/api/verify', '/api/seguridad',
        '/health', '/api/config-frontend',
        '/favicon.ico'
    ];
    
    // Permitir siempre las rutas de admin
    if (rutasAdmin.some(ruta => req.path.startsWith(ruta))) {
        return next();
    }
    
    // VERIFICAR BLOQUEO - Si la IP está bloqueada, interceptar TODO
    if (estaBloqueado(ip)) {
        const datos = bloqueos.get(ipLimpia);
        console.log(`🚫 BLOQUEADO: ${ipLimpia} intentó acceder a ${req.path}`);
        
        // Para peticiones AJAX/API, devolver JSON de error
        if (req.path.startsWith('/api/')) {
            return res.status(403).json({ 
                error: 'BLOQUEADO', 
                mensaje: 'Su IP ha sido bloqueada permanentemente por violar los términos de servicio.',
                bloqueado: true
            });
        }
        
        // Para peticiones de archivos estáticos (CSS, JS, imágenes)
        if (req.path.match(/\.(css|js|png|jpg|jpeg|gif|svg|ico|webp)$/i)) {
            // No mostrar página de bloqueo para assets, solo devolver 403
            return res.status(403).send('Acceso denegado');
        }
        
        // Para peticiones normales (HTML), mostrar página de bloqueo
        return res.status(403).send(renderBlockedPage(datos));
    }
    
    next();
});

// ==================== SERVIR ARCHIVOS ESTÁTICOS ====================
app.use(express.static(__dirname));
app.use('/uploads', express.static(UPLOADS_DIR));

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
        timestamp: new Date().toISOString(),
        bloqueosActivos: bloqueos.size
    });
});

// ==================== CONFIGURACIÓN FRONTEND ====================
app.get('/api/config-frontend', (req, res) => {
    res.json({
        supabaseUrl: process.env.SUPABASE_URL || '',
        supabaseAnonKey: process.env.SUPABASE_ANON_KEY || ''
    });
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

// ==================== CHAT IA ====================
app.post('/api/chat-ia', async (req, res) => {
    const ip = req.ip || req.socket.remoteAddress || '0.0.0.0';
    const { mensaje, nombre, codigoPais, isPremium, discount } = req.body;
    
    // Verificar si ya está bloqueado
    if (estaBloqueado(ip)) {
        return res.json({ 
            bloqueado: true,
            respuesta: '🚫 SU IP HA SIDO BLOQUEADA PERMANENTEMENTE por violar los términos de servicio. No puede utilizar este servicio.' 
        });
    }
    
    try {
        const iaData = JSON.parse(await fs.readFile(IA_PERSONALIDAD_FILE, 'utf8'));
        iaPersonalidad = iaData;
    } catch(e) {}
    
    let respuesta = '';
    const msg = mensaje ? mensaje.toLowerCase().trim() : '';
    
    // Verificar palabras prohibidas - BLOQUEO PERMANENTE INMEDIATO
    const palabraEncontrada = contienePalabraProhibida(msg);
    if (palabraEncontrada) {
        // Bloquear IP inmediatamente
        bloquearIP(ip, `Uso de lenguaje prohibido en chat: "${palabraEncontrada}"`, 'PALABRA_PROHIBIDA', palabraEncontrada, true);
        
        // Devolver respuesta con flag de bloqueo
        return res.json({ 
            bloqueado: true,
            respuesta: `🚫 SERVICIO CANCELADO\n\nSu IP ha sido BLOQUEADA PERMANENTEMENTE por violar los términos de servicio.\n\nMotivo: Uso de lenguaje inapropiado ("${palabraEncontrada}")\n\nEsta acción es permanente y no se puede deshacer.\n\nLa página se recargará automáticamente.` 
        });
    }
    
    // Respuesta normal del chat
    if (!nombre) {
        respuesta = `👋 ¡Hola! Soy ${iaPersonalidad.nombre}, tu asistente de Serenity Spa.\n\n¿Cuál es tu nombre para comenzar?\n\nPuedo ayudarte con:\n• Reservar un turno\n• Ver horarios disponibles\n• Consultar precios\n• Cancelar una reserva`;
    } else {
        respuesta = `${iaPersonalidad.estilo || 'Soy el asistente de Serenity Spa'}\n\nHola ${nombre}, ¿en qué puedo ayudarte hoy?\n\nPuedo asistirte con:\n• Reservar un turno\n• Ver horarios disponibles (${horariosConfig.horarios.join(', ')} hs)\n• Conocer precios de servicios\n• Cancelar una reserva con tu código\n\n¿Qué necesitas?`;
    }
    
    res.json({ respuesta, bloqueado: false });
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
        try {
            fsSync.writeFileSync(BLOQUEOS_FILE, JSON.stringify({
                bloqueos: Object.fromEntries(bloqueos),
                historial: historialBloqueos
            }, null, 2));
        } catch(e) {
            console.error('Error guardando bloqueos:', e);
        }
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
    console.log(`📊 ${bloqueos.size} IPs bloqueadas actualmente`);
});

const wss = new WebSocket.Server({ server, path: '/ws-voice' });

wss.on('connection', (ws, req) => {
    const ip = req.socket.remoteAddress || 'desconocida';
    const ipLimpia = getIpLimpia(ip);
    console.log(`🎤 Cliente de voz conectado desde ${ipLimpia}`);
    
    if (estaBloqueado(ip)) {
        ws.send(JSON.stringify({ 
            tipo: 'respuesta', 
            bloqueado: true,
            texto: '🚫 SU IP HA SIDO BLOQUEADA PERMANENTEMENTE por violar los términos de servicio.' 
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
                
                const palabraEncontrada = contienePalabraProhibida(msg);
                if (palabraEncontrada) {
                    bloquearIP(ip, `Uso de lenguaje prohibido en voz: "${palabraEncontrada}"`, 'PALABRA_PROHIBIDA', palabraEncontrada, true);
                    ws.send(JSON.stringify({ 
                        tipo: 'respuesta', 
                        bloqueado: true,
                        texto: `🚫 SU IP HA SIDO BLOQUEADA PERMANENTEMENTE por usar lenguaje inapropiado ("${palabraEncontrada}").` 
                    }));
                    ws.close();
                    return;
                }
                
                if (msg.includes('reservar') || msg.includes('turno') || msg.includes('cita')) {
                    respuesta = '📅 Para reservar un turno, dime tu nombre, teléfono, día, hora y tipo de masaje.';
                } else if (msg.includes('cancelar') || msg.includes('anular')) {
                    respuesta = '🔑 Para cancelar una reserva, necesito tu código de 6 dígitos.';
                } else if (msg.includes('horario') || msg.includes('disponible')) {
                    respuesta = `🕐 Horarios disponibles: ${horariosConfig.horarios.join(', ')} hs. Días: ${horariosConfig.dias.join(', ')}.`;
                } else if (msg.includes('hola') || msg.includes('buenas')) {
                    respuesta = '👋 ¡Hola! Soy el asistente de voz de Serenity Spa. ¿En qué puedo ayudarte?';
                } else if (msg.includes('precio') || msg.includes('cuesta')) {
                    respuesta = '💰 Nuestros servicios: Masaje Relajante $45, Masaje Corporal $65, Masaje Facial $40.';
                } else {
                    respuesta = '🤔 ¿En qué más puedo ayudarte? Puedo reservar turnos, mostrar horarios o cancelar reservas.';
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
        texto: '🎤 Conectado al asistente de voz de Serenity Spa.\n\nPuedo ayudarte con:\n• Reservar un turno\n• Información de horarios\n• Precios de servicios\n• Cancelar una reserva\n\n¿En qué puedo ayudarte?' 
    }));
});
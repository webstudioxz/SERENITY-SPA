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
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ==================== CONSTANTES ====================
let HORAS_VALIDAS = [12, 16, 20];
let DIAS_VALIDOS = ['lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado'];
let serviciosData = [];
let horariosConfig = {
    dias: ['lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado'],
    horarios: ['12:00', '16:00', '20:00']
};
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
    console.log(`🔴 IP BLOQUEADA: ${ipLimpia} - ${motivo}`);
    
    fs.writeFile(BLOQUEOS_FILE, JSON.stringify({
        bloqueos: Object.fromEntries(bloqueos),
        historial: historialBloqueos.slice(0, 500)
    }, null, 2)).catch(e => console.error('Error guardando:', e));
}

// ==================== INICIALIZACIÓN ====================
async function initAllFiles() {
    console.log('🔧 Inicializando archivos...');
    
    // Crear servicios por defecto si no existe
    if (!fsSync.existsSync(SERVICIOS_FILE)) {
        const serviciosDefault = [
            { id: generarId(), nombre: "Masaje Relajante", precio: "$45", descripcion: "Movimientos suaves para liberar el estrés.", beneficios: ["60 Minutos de relajación", "Aceites esenciales"], efectos: ["Relajación profunda", "Reducción del estrés"], videoUrl: "", imagenWeb: "https://images.unsplash.com/photo-1544161515-4ab6ce6db874?w=800", imagenWhatsApp: "", orden: 1 },
            { id: generarId(), nombre: "Masaje Corporal", precio: "$65", descripcion: "Tratamiento completo para una relajación profunda.", beneficios: ["90 Minutos", "Técnica personalizada"], efectos: ["Activación linfática", "Alivio muscular"], videoUrl: "", imagenWeb: "https://images.unsplash.com/photo-1519823551278-64ac92734fb1?w=800", imagenWhatsApp: "", orden: 2 },
            { id: generarId(), nombre: "Masaje Facial", precio: "$40", descripcion: "Rejuvenece la piel y alivia la tensión facial.", beneficios: ["45 Minutos", "Productos naturales"], efectos: ["Estimula colágeno", "Piel radiante"], videoUrl: "", imagenWeb: "https://images.unsplash.com/photo-1570172619644-dfd03ed5d881?w=800", imagenWhatsApp: "", orden: 3 }
        ];
        await fs.writeFile(SERVICIOS_FILE, JSON.stringify(serviciosDefault, null, 2));
        console.log('✅ servicios.json creado');
    }
    
    // Crear turnos.json si no existe
    if (!fsSync.existsSync(TURNOS_FILE)) {
        await fs.writeFile(TURNOS_FILE, JSON.stringify([], null, 2));
        console.log('✅ turnos.json creado');
    }
    
    // Crear horarios.json si no existe
    if (!fsSync.existsSync(HORARIOS_FILE)) {
        await fs.writeFile(HORARIOS_FILE, JSON.stringify(horariosConfig, null, 2));
        console.log('✅ horarios.json creado');
    }
    
    // Crear palabras-baneadas.json si no existe
    if (!fsSync.existsSync(PALABRAS_BANEADAS_FILE)) {
        await fs.writeFile(PALABRAS_BANEADAS_FILE, JSON.stringify({ palabras: palabrasBaneadas }, null, 2));
        console.log('✅ palabras-baneadas.json creado');
    }
    
    // Crear premium_usuarios.json si no existe
    if (!fsSync.existsSync(PREMIUM_USUARIOS_FILE)) {
        await fs.writeFile(PREMIUM_USUARIOS_FILE, JSON.stringify([], null, 2));
        console.log('✅ premium_usuarios.json creado');
    }
    
    // Crear premium_config.json si no existe
    if (!fsSync.existsSync(PREMIUM_CONFIG_FILE)) {
        await fs.writeFile(PREMIUM_CONFIG_FILE, JSON.stringify({ descuento_premium: 15 }, null, 2));
        console.log('✅ premium_config.json creado');
    }
    
    // Crear notificaciones.json si no existe
    if (!fsSync.existsSync(NOTIFICACIONES_FILE)) {
        await fs.writeFile(NOTIFICACIONES_FILE, JSON.stringify([], null, 2));
        console.log('✅ notificaciones.json creado');
    }
    
    // Crear resenas.json si no existe
    if (!fsSync.existsSync(RESENAS_FILE)) {
        await fs.writeFile(RESENAS_FILE, JSON.stringify([], null, 2));
        console.log('✅ resenas.json creado');
    }
    
    // Crear ia_personalidad.json si no existe
    if (!fsSync.existsSync(IA_PERSONALIDAD_FILE)) {
        await fs.writeFile(IA_PERSONALIDAD_FILE, JSON.stringify(iaPersonalidad, null, 2));
        console.log('✅ ia_personalidad.json creado');
    }
    
    // Crear config.json si no existe
    if (!fsSync.existsSync(CONFIG_FILE)) {
        await fs.writeFile(CONFIG_FILE, JSON.stringify({ hero: {}, serviciosSection: {} }, null, 2));
        console.log('✅ config.json creado');
    }
    
    // Cargar bloqueos existentes
    if (fsSync.existsSync(BLOQUEOS_FILE)) {
        try {
            const data = JSON.parse(await fs.readFile(BLOQUEOS_FILE, 'utf8'));
            bloqueos = new Map(Object.entries(data.bloqueos || {}));
            historialBloqueos = data.historial || [];
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

// ==================== MIDDLEWARE ====================
app.use((req, res, next) => {
    const ip = req.ip || req.socket.remoteAddress || '0.0.0.0';
    const rutasPermitidas = ['/admin', '/admin.html', '/login', '/login.html', '/api/login', '/api/verify', '/api/seguridad', '/api/premium', '/api/resenas', '/api/ia', '/api/config', '/api/servicios', '/api/palabras-baneadas', '/turnos', '/api/cancelar-por-codigo', '/api/chat-ia', '/ws-voice', '/voice-assistant', '/voice-assistant.html', '/premium-dashboard', '/premium-dashboard.html', '/health', '/registro', '/registro.html', '/uploads', '/api/upload', '/api/enviar-whatsapp', '/api/config-frontend'];
    
    if (rutasPermitidas.some(ruta => req.path.startsWith(ruta))) {
        return next();
    }
    
    if (estaBloqueado(ip)) {
        return res.status(403).send(`
            <!DOCTYPE html>
            <html>
            <head><meta charset="UTF-8"><title>Acceso Denegado</title>
            <style>body{font-family:Arial;background:#1a1a2e;color:#fff;text-align:center;padding:50px}</style>
            </head>
            <body><h1>🚫 Acceso Denegado</h1><p>Su IP ha sido bloqueada por violar las normas.</p><a href="/">Volver</a></body>
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
        HORAS_VALIDAS = req.body.horarios.map(h => parseInt(h.split(':')[0]));
        DIAS_VALIDOS = req.body.dias;
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
        console.log(`✅ Servicio creado: ${nuevoServicio.nombre}`);
        res.status(201).json(nuevoServicio);
    } catch(e) {
        console.error('❌ Error creando servicio:', e);
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
        console.log(`✅ Servicio actualizado: ${serviciosData[index].nombre}`);
        res.json(serviciosData[index]);
    } catch(e) {
        console.error('❌ Error actualizando servicio:', e);
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
        return res.status(403).json({ error: 'IP bloqueada por violar las normas' });
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
        return res.status(400).json({ error: `Día inválido. Días disponibles: ${DIAS_VALIDOS.join(', ')}` });
    }
    
    const hn = parseInt(hora);
    if (!HORAS_VALIDAS.includes(hn)) {
        return res.status(400).json({ error: `Hora inválida. Horarios: ${HORAS_VALIDAS.join(', ')}` });
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
    
    if (estaBloqueado(ip)) {
        return res.json({ respuesta: 'Lo siento, tu IP ha sido bloqueada por violar las normas. No puedo atenderte en este momento.' });
    }
    
    try {
        const iaData = JSON.parse(await fs.readFile(IA_PERSONALIDAD_FILE, 'utf8'));
        iaPersonalidad = iaData;
    } catch(e) {}
    
    let respuesta = '';
    const msg = mensaje.toLowerCase().trim();
    
    for (const palabra of palabrasBaneadas) {
        if (msg.includes(palabra)) {
            bloquearIP(ip, `Uso de lenguaje prohibido: "${palabra}"`, 'PALABRA_PROHIBIDA', palabra, false);
            return res.json({ 
                respuesta: `🚫 SERVICIO CANCELADO\n\nSu IP ha sido bloqueada por violar las normas de servicio.\n\nMotivo: Uso de lenguaje inapropiado ("${palabra}")\n\nSi considera que es un error, contacte con soporte.` 
            });
        }
    }
    
    // RESERVAR TURNO
    if (msg.includes('reservar') || msg.includes('turno') || msg.includes('cita') || msg.includes('agendar')) {
        respuesta = `📅 Para reservar un turno, necesito que me proporciones estos datos:\n\n1. 📛 Tu nombre completo\n2. 📞 Tu número de teléfono (con código de país)\n3. 📆 ¿Qué día prefieres? (${horariosConfig.dias.join(', ')})\n4. ⏰ ¿A qué hora? (${horariosConfig.horarios.join(', ')} hs)\n5. 💆 ¿Qué tipo de masaje deseas? (Relajante, Corporal, Facial)\n\nResponde con tus datos y te confirmaré tu turno.`;
    }
    // CANCELAR TURNO
    else if (msg.includes('cancelar') || msg.includes('anular') || msg.includes('eliminar') || msg.includes('dar de baja')) {
        respuesta = `🔑 Para cancelar tu reserva, necesito tu código de cancelación de 6 dígitos (ejemplo: A3B7X9).\n\nEste código te lo enviamos en el mensaje de confirmación de tu reserva.\n\nPor favor, ingresa tu código para continuar con la cancelación.`;
    }
    // HORARIOS
    else if (msg.includes('horario') || msg.includes('disponible') || msg.includes('días')) {
        respuesta = `🕐 Nuestros horarios disponibles son:\n\n${horariosConfig.horarios.join(' hs\n')} hs\n\n📅 Días de atención: ${horariosConfig.dias.map(d => d.charAt(0).toUpperCase() + d.slice(1)).join(', ')}.\n\n¿Qué día te gustaría reservar?`;
    }
    // PRECIOS
    else if (msg.includes('precio') || msg.includes('cuesta') || msg.includes('costo') || msg.includes('valor')) {
        let lista = '💰 Estos son nuestros servicios y precios:\n\n';
        serviciosData.slice(0, 5).forEach(s => {
            lista += `• ${s.nombre}: ${s.precio}\n`;
        });
        if (isPremium) {
            lista += `\n✨ Como miembro premium, tienes ${discount}% de descuento en todos los servicios.`;
        }
        respuesta = lista;
    }
    // SALUDO
    else if (msg.includes('hola') || msg.includes('buenas') || msg.includes('saludos') || msg.includes('hey')) {
        if (nombre) {
            respuesta = `👋 ¡Hola ${nombre}! Soy ${iaPersonalidad.nombre}, tu asistente de Serenity Spa.\n\n¿En qué puedo ayudarte hoy? Puedo:\n• Reservar un turno\n• Ver horarios disponibles\n• Consultar precios\n• Cancelar una reserva\n\n¿Qué necesitas?`;
        } else {
            respuesta = `👋 ¡Hola! Soy ${iaPersonalidad.nombre}, tu asistente de Serenity Spa.\n\n¿Cuál es tu nombre para comenzar? Así puedo conocerte mejor.`;
        }
    }
    // GRACIAS
    else if (msg.includes('gracias')) {
        respuesta = `🙏 ¡Gracias a ti! Que tengas un excelente día.\n\n¿Necesitas algo más? Estoy aquí para ayudarte.`;
    }
    // MENSAJE POR DEFECTO
    else {
        if (!nombre) {
            respuesta = `👋 ¡Hola! Soy ${iaPersonalidad.nombre}, tu asistente de Serenity Spa.\n\n¿Cuál es tu nombre para comenzar? Así puedo conocerte mejor.\n\nTambién puedo ayudarte con:\n• Reservar un turno\n• Ver horarios disponibles\n• Consultar precios\n• Cancelar una reserva`;
        } else {
            respuesta = `${iaPersonalidad.estilo || 'Soy el asistente de Serenity Spa'}\n\nHola ${nombre}, ¿en qué puedo ayudarte hoy?\n\nPuedo asistirte con:\n• Reservar un turno\n• Ver horarios disponibles (${horariosConfig.horarios.join(', ')} hs)\n• Conocer precios de servicios\n• Cancelar una reserva con tu código\n\n¿Qué necesitas?`;
        }
    }
    
    res.json({ respuesta: respuesta });
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

app.delete('/api/seguridad/bloqueos/:ip', (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) return res.status(401).json({ error: 'No autorizado' });
    
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

// ==================== CONFIGURACIÓN FRONTEND ====================
app.get('/api/config-frontend', (req, res) => {
    res.json({
        supabaseUrl: process.env.SUPABASE_URL || 'https://tu-proyecto.supabase.co',
        supabaseAnonKey: process.env.SUPABASE_ANON_KEY || 'tu-anon-key-aqui'
    });
});

// ==================== WEBSOCKET ====================
const server = app.listen(PORT, '0.0.0.0', async () => {
    await initAllFiles();
    console.log(`🌿 Serenity Spa iniciado en puerto ${PORT}`);
    console.log(`🔑 Admin password: admin123`);
    console.log(`👑 Sistema Premium activado`);
    console.log(`🎤 WebSocket de voz disponible en /ws-voice`);
});

const wss = new WebSocket.Server({ server, path: '/ws-voice' });

wss.on('connection', (ws, req) => {
    const ip = req.socket.remoteAddress || 'desconocida';
    console.log(`🎤 Cliente de voz conectado desde ${ip}`);
    
    ws.on('message', async (data) => {
        try {
            const m = JSON.parse(data);
            if (m.tipo === 'transcripcion' && m.texto) {
                console.log(`📝 Mensaje de voz: ${m.texto}`);
                
                // Procesar mensaje de voz
                const msg = m.texto.toLowerCase();
                let respuesta = '';
                
                // Verificar palabras prohibidas
                for (const palabra of palabrasBaneadas) {
                    if (msg.includes(palabra)) {
                        bloquearIP(ip, `Uso de lenguaje prohibido en voz: "${palabra}"`, 'PALABRA_PROHIBIDA', palabra, false);
                        ws.send(JSON.stringify({ tipo: 'respuesta', texto: `🚫 Su IP ha sido bloqueada por usar lenguaje inapropiado.` }));
                        ws.close();
                        return;
                    }
                }
                
                // Respuestas del asistente de voz
                if (msg.includes('reservar') || msg.includes('turno') || msg.includes('cita')) {
                    respuesta = '📅 Para reservar un turno, visita nuestra página principal y usa el chat de texto. Allí podrás completar tu reserva fácilmente paso a paso.';
                } else if (msg.includes('cancelar') || msg.includes('anular')) {
                    respuesta = '🔑 Para cancelar una reserva, necesitas tu código de cancelación de 6 dígitos. Puedes ingresarlo en el chat de la página principal.';
                } else if (msg.includes('horario') || msg.includes('disponible')) {
                    respuesta = `🕐 Horarios disponibles: ${horariosConfig.horarios.join(', ')} hs. Días: ${horariosConfig.dias.join(', ')}.`;
                } else if (msg.includes('hola') || msg.includes('buenas')) {
                    respuesta = '👋 ¡Hola! Soy el asistente de voz de Serenity Spa. ¿En qué puedo ayudarte? Puedo informarte sobre horarios, precios de servicios, o ayudarte a cancelar una reserva con tu código.';
                } else if (msg.includes('precio') || msg.includes('cuesta')) {
                    respuesta = '💰 Nuestros servicios: Masaje Relajante $45, Masaje Corporal $65, Masaje Facial $40.';
                } else {
                    respuesta = '🤔 ¿En qué más puedo ayudarte? Puedo informarte sobre horarios, precios de servicios, o ayudarte a cancelar una reserva con tu código.';
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
    
    // Mensaje de bienvenida al conectar
    ws.send(JSON.stringify({ 
        tipo: 'respuesta', 
        texto: '🎤 Conectado al asistente de voz de Serenity Spa.\n\nPuedo ayudarte con:\n• Información de horarios\n• Precios de servicios\n• Cancelar una reserva con tu código\n\n¿En qué puedo ayudarte?' 
    }));
});
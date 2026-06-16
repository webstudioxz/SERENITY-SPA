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

app.disable('x-powered-by');
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static(__dirname));

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

// ==================== PALABRAS PROHIBIDAS ====================
let palabrasBaneadas = [
    'puta', 'puto', 'mierda', 'coño', 'carajo', 'verga', 'chinga',
    'fuck', 'shit', 'bitch', 'idiota', 'estupido', 'imbecil', 'tarado',
    'pendejo', 'cabron', 'culo', 'cojones', 'pelotudo', 'boludo', 'maricon'
];

// ==================== SISTEMA DE BLOQUEOS ====================
let bloqueos = new Map();
let historialBloqueos = [];

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

// ==================== INICIALIZACIÓN DE ARCHIVOS ====================
async function initAllFiles() {
    console.log('🔧 Inicializando archivos...');
    
    if (!fsSync.existsSync(SERVICIOS_FILE)) {
        const serviciosDefault = [
            { id: generarId(), nombre: "Masaje Relajante", precio: "$45", descripcion: "Movimientos suaves para liberar el estrés.", beneficios: ["60 Minutos de relajación"], efectos: ["Relajación profunda"], videoUrl: "", imagenWeb: "https://images.unsplash.com/photo-1544161515-4ab6ce6db874?w=800", imagenWhatsApp: "", orden: 1 },
            { id: generarId(), nombre: "Masaje Corporal", precio: "$65", descripcion: "Tratamiento completo para una relajación profunda.", beneficios: ["90 Minutos"], efectos: ["Activación linfática"], videoUrl: "", imagenWeb: "https://images.unsplash.com/photo-1519823551278-64ac92734fb1?w=800", imagenWhatsApp: "", orden: 2 },
            { id: generarId(), nombre: "Masaje Facial", precio: "$40", descripcion: "Rejuvenece la piel y alivia la tensión facial.", beneficios: ["45 Minutos"], efectos: ["Estimula colágeno"], videoUrl: "", imagenWeb: "https://images.unsplash.com/photo-1570172619644-dfd03ed5d881?w=800", imagenWhatsApp: "", orden: 3 }
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
    
    if (!fsSync.existsSync(PALABRAS_BANEADAS_FILE)) {
        await fs.writeFile(PALABRAS_BANEADAS_FILE, JSON.stringify({ palabras: palabrasBaneadas }, null, 2));
        console.log('✅ palabras-baneadas.json creado');
    }
    
    if (!fsSync.existsSync(PREMIUM_USUARIOS_FILE)) {
        await fs.writeFile(PREMIUM_USUARIOS_FILE, JSON.stringify([], null, 2));
        console.log('✅ premium_usuarios.json creado');
    }
    
    if (!fsSync.existsSync(PREMIUM_CONFIG_FILE)) {
        await fs.writeFile(PREMIUM_CONFIG_FILE, JSON.stringify({ descuento_premium: 15 }, null, 2));
        console.log('✅ premium_config.json creado');
    }
    
    if (!fsSync.existsSync(NOTIFICACIONES_FILE)) {
        await fs.writeFile(NOTIFICACIONES_FILE, JSON.stringify([], null, 2));
        console.log('✅ notificaciones.json creado');
    }
    
    if (!fsSync.existsSync(RESENAS_FILE)) {
        await fs.writeFile(RESENAS_FILE, JSON.stringify([], null, 2));
        console.log('✅ resenas.json creado');
    }
    
    if (!fsSync.existsSync(IA_PERSONALIDAD_FILE)) {
        await fs.writeFile(IA_PERSONALIDAD_FILE, JSON.stringify(iaPersonalidad, null, 2));
        console.log('✅ ia_personalidad.json creado');
    }
    
    if (fsSync.existsSync(BLOQUEOS_FILE)) {
        try {
            const data = JSON.parse(await fs.readFile(BLOQUEOS_FILE, 'utf8'));
            bloqueos = new Map(Object.entries(data.bloqueos || {}));
            historialBloqueos = data.historial || [];
        } catch(e) {}
    }
    
    const data = await fs.readFile(SERVICIOS_FILE, 'utf8');
    serviciosData = JSON.parse(data);
    console.log(`✅ Servicios cargados: ${serviciosData.length}`);
}

// ==================== MIDDLEWARE ====================
app.use((req, res, next) => {
    const ip = req.ip || req.socket.remoteAddress || '0.0.0.0';
    const rutasPermitidas = ['/admin', '/admin.html', '/login', '/login.html', '/api/login', '/api/verify', '/api/seguridad', '/api/premium', '/api/resenas', '/api/ia', '/api/config', '/api/servicios', '/api/palabras-baneadas', '/turnos', '/api/cancelar-por-codigo', '/api/chat-ia', '/ws-voice', '/voice-assistant', '/voice-assistant.html', '/premium-dashboard', '/premium-dashboard.html', '/health'];
    
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

// ==================== RUTAS HTML ====================
app.get('/voice-assistant', (req, res) => res.sendFile(path.join(__dirname, 'voice-assistant.html')));
app.get('/voice-assistant.html', (req, res) => res.sendFile(path.join(__dirname, 'voice-assistant.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));
app.get('/admin.html', (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'login.html')));
app.get('/login.html', (req, res) => res.sendFile(path.join(__dirname, 'login.html')));
app.get('/premium-dashboard', (req, res) => res.sendFile(path.join(__dirname, 'premium-dashboard.html')));
app.get('/premium-dashboard.html', (req, res) => res.sendFile(path.join(__dirname, 'premium-dashboard.html')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// ==================== HEALTH CHECK ====================
app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString(), servicios: serviciosData.length });
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

// ==================== SERVICIOS (CORREGIDO - AGREGAR/EDITAR/VIDEO) ====================
app.get('/api/servicios', (req, res) => {
    res.json(serviciosData.sort((a, b) => (a.orden || 999) - (b.orden || 999)));
});

app.post('/api/servicios', async (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) return res.status(401).json({ error: 'No autorizado' });
    
    const nuevoServicio = {
        id: generarId(),
        ...req.body,
        beneficios: req.body.beneficios || [],
        efectos: req.body.efectos || [],
        videoUrl: req.body.videoUrl || '',
        imagenWeb: req.body.imagenWeb || '',
        imagenWhatsApp: req.body.imagenWhatsApp || ''
    };
    
    serviciosData.push(nuevoServicio);
    await fs.writeFile(SERVICIOS_FILE, JSON.stringify(serviciosData, null, 2));
    res.status(201).json(nuevoServicio);
});

app.put('/api/servicios/:id', async (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) return res.status(401).json({ error: 'No autorizado' });
    
    const id = req.params.id;
    const index = serviciosData.findIndex(s => s.id === id);
    
    if (index === -1) return res.status(404).json({ error: 'Servicio no encontrado' });
    
    serviciosData[index] = {
        ...serviciosData[index],
        ...req.body,
        id: id,
        videoUrl: req.body.videoUrl || serviciosData[index].videoUrl || '',
        imagenWeb: req.body.imagenWeb || serviciosData[index].imagenWeb || '',
        imagenWhatsApp: req.body.imagenWhatsApp || serviciosData[index].imagenWhatsApp || ''
    };
    
    await fs.writeFile(SERVICIOS_FILE, JSON.stringify(serviciosData, null, 2));
    res.json(serviciosData[index]);
});

app.delete('/api/servicios/:id', async (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) return res.status(401).json({ error: 'No autorizado' });
    
    serviciosData = serviciosData.filter(s => s.id !== req.params.id);
    await fs.writeFile(SERVICIOS_FILE, JSON.stringify(serviciosData, null, 2));
    res.json({ success: true });
});

// ==================== TURNOS (RESERVAR Y CANCELAR) ====================
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
    
    if (estaBloqueado(ip)) {
        return res.status(403).json({ error: 'IP bloqueada' });
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
    
    res.status(201).json({ 
        mensaje: 'Turno reservado', 
        turno: nuevoTurno,
        codigoCancelacion: codigoCancelacion
    });
});

app.delete('/turnos/:id', async (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) return res.status(401).json({ error: 'No autorizado' });
    
    const turnos = JSON.parse(await fs.readFile(TURNOS_FILE, 'utf8'));
    const nuevosTurnos = turnos.filter(t => t.id !== req.params.id);
    await fs.writeFile(TURNOS_FILE, JSON.stringify(nuevosTurnos, null, 2));
    res.json({ success: true });
});

app.post('/api/cancelar-por-codigo', async (req, res) => {
    const { codigo } = req.body;
    
    if (!codigo || codigo.length !== 6) {
        return res.status(400).json({ error: 'Código inválido' });
    }
    
    const turnos = JSON.parse(await fs.readFile(TURNOS_FILE, 'utf8'));
    const turnoIndex = turnos.findIndex(t => t.codigoCancelacion === codigo.toUpperCase());
    
    if (turnoIndex === -1) {
        return res.json({ success: false, error: 'Código incorrecto. Verifica tu código de cancelación.' });
    }
    
    const turno = turnos[turnoIndex];
    turnos.splice(turnoIndex, 1);
    await fs.writeFile(TURNOS_FILE, JSON.stringify(turnos, null, 2));
    
    res.json({ success: true, mensaje: `✅ Turno del ${turno.dia} a las ${turno.hora}:00 cancelado correctamente.` });
});

// ==================== CHAT IA (CORREGIDO) ====================
app.post('/api/chat-ia', async (req, res) => {
    const { mensaje, nombre, codigoPais, isPremium, discount } = req.body;
    const ip = req.ip || req.socket.remoteAddress || '0.0.0.0';
    
    if (estaBloqueado(ip)) {
        return res.json({ respuesta: 'Lo siento, no puedo atenderte en este momento.' });
    }
    
    let respuesta = '';
    const msg = mensaje.toLowerCase();
    
    try {
        const iaData = JSON.parse(await fs.readFile(IA_PERSONALIDAD_FILE, 'utf8'));
        iaPersonalidad = iaData;
    } catch(e) {}
    
    if (msg.includes('hola') || msg.includes('buenas') || msg.includes('saludos')) {
        if (nombre) {
            respuesta = `¡Hola ${nombre}! Soy ${iaPersonalidad.nombre}, tu asistente de Serenity Spa. ¿En qué puedo ayudarte hoy? Puedo ayudarte a reservar un turno, ver horarios disponibles, o cancelar una reserva con tu código.`;
        } else {
            respuesta = `¡Hola! Soy ${iaPersonalidad.nombre}, tu asistente de Serenity Spa. ¿Cuál es tu nombre para comenzar?`;
        }
    }
    else if (msg.includes('horario') || msg.includes('disponible')) {
        respuesta = `Nuestros horarios disponibles son: ${horariosConfig.horarios.join(', ')} hs.\nDías de atención: ${horariosConfig.dias.map(d => d.charAt(0).toUpperCase() + d.slice(1)).join(', ')}.\n¿Qué día te gustaría reservar?`;
    }
    else if (msg.includes('precio') || msg.includes('cuesta') || msg.includes('costo')) {
        let lista = 'Estos son nuestros servicios y precios:\n\n';
        serviciosData.slice(0, 5).forEach(s => {
            lista += `• ${s.nombre}: ${s.precio}\n`;
        });
        if (isPremium) {
            lista += `\n✨ Como miembro premium, tienes ${discount}% de descuento en todos los servicios.`;
        }
        respuesta = lista;
    }
    else if (msg.includes('reservar') || msg.includes('turno') || msg.includes('cita')) {
        respuesta = `Para reservar un turno, necesito saber:\n1. ¿Qué día prefieres? (${horariosConfig.dias.join(', ')})\n2. ¿A qué hora? (${horariosConfig.horarios.join(', ')} hs)\n3. ¿Qué tipo de masaje deseas?\n\n¿Puedes proporcionarme estos datos?`;
    }
    else if (msg.includes('cancelar') || msg.includes('anular')) {
        respuesta = `Para cancelar tu reserva, necesito tu código de cancelación de 6 dígitos (ejemplo: A3B7X9). Por favor, ingresa tu código.\n\nSi no lo tienes, revisa el mensaje de confirmación que recibiste al reservar.`;
    }
    else if (msg.includes('gracias')) {
        respuesta = `¡Gracias a ti! Que tengas un excelente día. ¿Necesitas algo más?`;
    }
    else {
        respuesta = `${iaPersonalidad.estilo || 'Soy el asistente de Serenity Spa'}\n\nPuedo ayudarte con:\n• Reservar un turno\n• Ver horarios disponibles (${horariosConfig.horarios.join(', ')} hs)\n• Conocer precios de servicios\n• Cancelar una reserva con tu código\n\n¿Qué necesitas?`;
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

// ==================== SEGURIDAD ====================
app.get('/api/seguridad/bloqueos', (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) return res.status(401).json({ error: 'No autorizado' });
    
    const activos = [];
    for (const [ip, datos] of bloqueos) {
        activos.push({ ip, motivo: datos.motivo, tipoAtaque: datos.tipoAtaque, fecha: datos.fecha, permanente: datos.permanente });
    }
    
    res.json({ activos, historial: historialBloqueos, intentosFallidos: {} });
});

app.post('/api/seguridad/desbloquear/:ip', (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) return res.status(401).json({ error: 'No autorizado' });
    
    const ipDesbloquear = req.params.ip;
    if (bloqueos.has(ipDesbloquear)) {
        bloqueos.delete(ipDesbloquear);
        res.json({ ok: true });
    } else {
        res.json({ ok: false });
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
            notificaciones.push({
                id: Date.now() + Math.random().toString(36),
                email: usuario.email,
                titulo: titulo,
                mensaje: mensaje,
                fecha: new Date().toISOString(),
                leida: false
            });
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
    const turnos = JSON.parse(await fs.readFile(TURNOS_FILE, 'utf8'));
    const turno = turnos.find(t => t.id === id);
    
    if (!turno) {
        return res.status(404).json({ error: 'Turno no encontrado' });
    }
    
    const mensaje = `Hola ${turno.nombre}, te recordamos tu turno en Serenity Spa para el día ${turno.dia} a las ${turno.hora}:00 hs. Tu código de cancelación es: ${turno.codigoCancelacion}. Si necesitas cancelar, usa este código. ¡Te esperamos!`;
    const numero = `${turno.codigoPais}${turno.telefono}`;
    
    res.json({ success: true, mensaje, numero });
});

// ==================== CONFIGURACIÓN FRONTEND ====================
app.get('/api/config-frontend', (req, res) => {
    res.json({
        supabaseUrl: process.env.SUPABASE_URL || 'https://tu-proyecto.supabase.co',
        supabaseAnonKey: process.env.SUPABASE_ANON_KEY || 'tu-anon-key-aqui'
    });
});

// ==================== WEBSOCKET PARA VOZ (CORREGIDO) ====================
const server = app.listen(PORT, '0.0.0.0', async () => {
    await initAllFiles();
    console.log(`🌿 Serenity Spa iniciado en puerto ${PORT}`);
    console.log(`🔑 Admin password: admin123 (configurable con variable ADMIN_PASSWORD)`);
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
                
                let respuesta = '';
                const msg = m.texto.toLowerCase();
                
                if (msg.includes('hola') || msg.includes('buenas')) {
                    respuesta = '¡Hola! Soy el asistente de Serenity Spa. ¿En qué puedo ayudarte? Puedo ayudarte a reservar un turno, ver horarios o cancelar una reserva.';
                } else if (msg.includes('horario')) {
                    respuesta = `Horarios disponibles: ${horariosConfig.horarios.join(', ')} hs. Días: ${horariosConfig.dias.join(', ')}.`;
                } else if (msg.includes('reservar') || msg.includes('turno')) {
                    respuesta = 'Para reservar un turno, por favor visita nuestra página principal y usa el chat de texto. Allí podrás completar tu reserva fácilmente.';
                } else if (msg.includes('cancelar')) {
                    respuesta = 'Para cancelar una reserva, necesitas tu código de cancelación de 6 dígitos. Puedes ingresarlo en el chat de la página principal.';
                } else {
                    respuesta = '¿En qué más puedo ayudarte? Puedo informarte sobre horarios, precios de servicios, o ayudarte a cancelar una reserva con tu código.';
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
    
    ws.send(JSON.stringify({ tipo: 'respuesta', texto: 'Conectado al asistente de voz de Serenity Spa. ¿En qué puedo ayudarte?' }));
});
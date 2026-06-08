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
const UPLOADS_DIR = path.join(__dirname, 'uploads');

// ==================== CONFIGURACIÓN DE OPENROUTER ====================
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || '';
const MODELO_IA = process.env.MODELO_IA || 'deepseek/deepseek-chat';

let openrouter = null;
let iaDisponible = false;

if (OPENROUTER_API_KEY && OPENROUTER_API_KEY !== '') {
    try {
        openrouter = new OpenAI({
            baseURL: 'https://openrouter.ai/api/v1',
            apiKey: OPENROUTER_API_KEY,
            defaultHeaders: {
                'HTTP-Referer': 'https://masajes-spa.onrender.com',
                'X-Title': 'Serenity Spa Asistente de Voz',
            }
        });
        iaDisponible = true;
        console.log('✅ OpenRouter configurado correctamente');
        console.log(`📌 Modelo: ${MODELO_IA}`);
    } catch(e) {
        console.log('❌ Error configurando OpenRouter:', e.message);
    }
} else {
    console.log('❌ OPENROUTER_API_KEY no encontrada');
}

app.disable('x-powered-by');

if (!fsSync.existsSync(UPLOADS_DIR)) {
    fsSync.mkdirSync(UPLOADS_DIR, { recursive: true });
}

app.use('/uploads', express.static(UPLOADS_DIR));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

const HORAS_VALIDAS = [12, 16, 20];
const DIAS_VALIDOS = ['lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado'];

// ==================== SISTEMA DE BLOQUEOS ====================
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
                if (ahora > datos.hasta) bloqueos.delete(ip);
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
    if (bloqueos.has(ip)) {
        if (Date.now() < bloqueos.get(ip).hasta) return true;
        bloqueos.delete(ip);
        guardarBloqueos();
    }
    return false;
}

function bloquearIP(ip, motivo, tipo = 'Desconocido') {
    bloqueos.set(ip, {
        hasta: Date.now() + 3600000,
        motivo,
        tipoAtaque: tipo,
        fecha: new Date().toISOString(),
        ip,
        intentos: (intentosFallidos.get(ip)?.count || 0),
        permanente: false
    });
    historialBloqueos.unshift({ ...bloqueos.get(ip), id: generarId() });
    guardarBloqueos();
}

function desbloquearIP(ip) {
    bloqueos.delete(ip);
    intentosFallidos.delete(ip);
    guardarBloqueos();
}

function limpiarViejos(mapa, ventana) {
    const ahora = Date.now();
    for (const [k, a] of mapa) {
        mapa.set(k, a.filter(t => ahora - t < ventana));
        if (!mapa.get(k).length) mapa.delete(k);
    }
}

function registrarIntento(ip, tipo) {
    const ahora = Date.now();
    if (!intentosFallidos.has(ip)) {
        intentosFallidos.set(ip, { count: 1, first: ahora });
        return false;
    }
    const d = intentosFallidos.get(ip);
    if (ahora - d.first > 600000) {
        intentosFallidos.set(ip, { count: 1, first: ahora });
        return false;
    }
    d.count++;
    if (d.count >= 5) {
        bloquearIP(ip, `5+ intentos: ${tipo}`, tipo);
        intentosFallidos.delete(ip);
        return true;
    }
    return false;
}

function checkRateIP(ip) {
    limpiarViejos(turnosRecientesIP, 3600000);
    return (turnosRecientesIP.get(ip) || []).length < 3;
}

function checkRateTel(tel) {
    limpiarViejos(turnosRecientesTel, 86400000);
    return (turnosRecientesTel.get(tel) || []).length < 2;
}

function regTurno(ip, tel) {
    const ahora = Date.now();
    if (!turnosRecientesIP.has(ip)) turnosRecientesIP.set(ip, []);
    turnosRecientesIP.get(ip).push(ahora);
    if (!turnosRecientesTel.has(tel)) turnosRecientesTel.set(tel, []);
    turnosRecientesTel.get(tel).push(ahora);
}

// ==================== CONFIGURACIÓN DEL SPA ====================
let spaConfig = {
    paisPermitido: '53',
    paisNombre: 'Cuba',
    direccionSalon: 'Calle 23 #456, La Habana, Cuba',
    telefonoAdmin: '+53 5555-1234',
    horarios: 'Lunes a Sábado 12:00, 16:00, 20:00'
};

const SPA_CONFIG_FILE = path.join(__dirname, 'spa-config.json');

async function cargarSpaConfig() {
    try {
        if (fsSync.existsSync(SPA_CONFIG_FILE)) {
            spaConfig = JSON.parse(await fs.readFile(SPA_CONFIG_FILE, 'utf8'));
        } else {
            await guardarSpaConfig();
        }
    } catch(e) {
        await guardarSpaConfig();
    }
}

async function guardarSpaConfig() {
    await fs.writeFile(SPA_CONFIG_FILE, JSON.stringify(spaConfig, null, 2), 'utf8');
}

// ==================== SISTEMA DE PAÍSES ====================
let paisesConfig = {
    autorizados: [],
    bloqueados: [],
    modo: 'solo_autorizados',
    stats: {}
};

async function cargarPaises() {
    try {
        if (fsSync.existsSync(PAISES_FILE)) {
            paisesConfig = JSON.parse(await fs.readFile(PAISES_FILE, 'utf8'));
        } else {
            await guardarPaises();
        }
    } catch(e) {
        await guardarPaises();
    }
}

async function guardarPaises() {
    await fs.writeFile(PAISES_FILE, JSON.stringify(paisesConfig, null, 2), 'utf8');
}

function paisAutorizado(codigoPais) {
    if (spaConfig.paisPermitido && spaConfig.paisPermitido !== 'todos') {
        return codigoPais === spaConfig.paisPermitido;
    }
    return true;
}

// ==================== DATOS ====================
let serviciosData = [];
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

// ==================== FUNCIÓN PRINCIPAL DE IA PARA VOZ ====================
async function procesarConIA(mensaje, historial, nombreCliente, codigoPais, horariosDisponibles, turnosActuales) {
    if (!iaDisponible || !openrouter) {
        return null;
    }
    
    // Construir lista de horarios ocupados
    const horariosOcupados = turnosActuales.map(t => `${t.dia} ${t.hora}:00`).join(', ');
    
    // Construir lista de servicios
    const serviciosInfo = serviciosData.map(s => 
        `- ${s.nombre}: ${s.descripcion}. Precio: ${s.precio}`
    ).join('\n');
    
    const systemPrompt = `Eres un asistente virtual profesional de Serenity Spa, un centro de masajes de lujo.

INFORMACIÓN DEL NEGOCIO:
- Nombre del spa: Serenity Spa
- Ubicación del salón: ${spaConfig.direccionSalon}
- Teléfono de contacto: ${spaConfig.telefonoAdmin}
- Horarios disponibles: ${spaConfig.horarios}
- Días de atención: Lunes a Sábado
- País donde operamos: ${spaConfig.paisNombre} (código +${spaConfig.paisPermitido})
- Política: Un turno por persona por día. Cancelación con 4 horas de anticipación.

SERVICIOS OFRECIDOS:
${serviciosInfo}

HORARIOS OCUPADOS ACTUALMENTE:
${horariosOcupados || 'Ninguno ocupado aún'}

CLIENTE ACTUAL:
- Nombre: ${nombreCliente || 'No proporcionado aún'}
- Código de país: +${codigoPais || spaConfig.paisPermitido}

REGLAS IMPORTANTES:
1. Tu objetivo es ayudar al cliente a reservar un turno de masaje.
2. Si el cliente pregunta sobre precios, horarios, ubicación o servicios, responde naturalmente.
3. Para reservar, necesitas: nombre, tipo de masaje, día, hora y teléfono.
4. Si falta información, pregunta SOLO por lo que falta.
5. Si el cliente ya tiene reserva, manten el contexto y responde sus preguntas.
6. Si el horario que pide está ocupado, sugiere alternativas disponibles.
7. Responde en español, de forma natural, cálida y profesional.
8. NO uses emojis, asteriscos ni caracteres especiales.
9. Sé conciso pero útil.`;

    try {
        const messages = [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: mensaje }
        ];
        
        // Agregar historial reciente para mantener contexto
        if (historial && historial.length > 0) {
            const historialReciente = historial.slice(-8);
            for (const item of historialReciente) {
                messages.push({ role: item.role, content: item.content });
            }
        }
        
        const completion = await openrouter.chat.completions.create({
            model: MODELO_IA,
            messages: messages,
            temperature: 0.6,
            max_tokens: 300
        });
        
        return completion.choices[0].message.content;
        
    } catch (error) {
        console.error('❌ Error en OpenRouter:', error.message);
        return null;
    }
}

// ==================== FUNCIÓN PARA CREAR RESERVA ====================
async function crearReserva(datos, ip) {
    const turnos = await loadTurnos();
    const diaActual = datos.dia.toLowerCase();
    const horaActual = parseInt(datos.hora);
    
    // Verificar si ya tiene turno ese día
    if (turnos.some(t => t.telefono === datos.telefono && t.dia === diaActual)) {
        return { exito: false, mensaje: `Ya tienes un turno para el ${diaActual}. Solo se permite uno por día.` };
    }
    
    // Verificar disponibilidad
    if (turnos.some(t => t.dia === diaActual && t.hora === horaActual)) {
        const alternativas = [];
        for (const hora of HORAS_VALIDAS) {
            if (!turnos.some(t => t.dia === diaActual && t.hora === hora)) {
                alternativas.push(hora);
            }
        }
        if (alternativas.length > 0) {
            return { exito: false, mensaje: `El horario de las ${horaActual}:00 está ocupado. Tengo disponible a las ${alternativas.join(':00 o las ')}:00. ¿Te sirve alguno?` };
        }
        return { exito: false, mensaje: `No hay disponibilidad para el ${diaActual}. ¿Podemos probar otro día?` };
    }
    
    const nuevoTurno = {
        id: generarId(),
        nombre: datos.nombre,
        dia: diaActual,
        hora: horaActual,
        massageType: datos.masaje,
        telefono: datos.telefono,
        codigoPais: datos.codigoPais || spaConfig.paisPermitido,
        ubicacion: datos.ubicacion || spaConfig.direccionSalon,
        tipoServicio: datos.tipoServicio || 'salon',
        confirmadoWhatsApp: false,
        fechaCreacion: new Date().toISOString(),
        ip
    };
    
    turnos.push(nuevoTurno);
    await saveTurnos(turnos);
    
    const horaTexto = horaActual === 12 ? '12 del mediodía' : horaActual === 16 ? '4 de la tarde' : '8 de la noche';
    return { 
        exito: true, 
        mensaje: `Reserva confirmada, ${datos.nombre}. Día: ${diaActual}. Hora: ${horaTexto}. Masaje: ${datos.masaje}. Lugar: ${spaConfig.direccionSalon}. Te esperamos. ¿Necesitas algo más?` 
    };
}

// ==================== MIDDLEWARES ====================
app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    next();
});

app.use((req, res, next) => {
    const ip = req.ip || req.socket.remoteAddress || '0.0.0.0';
    if (estaBloqueado(ip)) {
        return res.status(403).json({ error: 'IP bloqueada por seguridad', bloqueado: true });
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

app.post('/api/login', (req, res) => {
    const ip = req.ip || '0.0.0.0';
    if (estaBloqueado(ip)) return res.status(403).json({ success: false, error: 'IP bloqueada' });
    const { password } = req.body;
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

// ==================== CONFIGURACIÓN DEL SPA ====================
app.get('/api/spa-config', (req, res) => res.json(spaConfig));

app.put('/api/spa-config', async (req, res) => {
    if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    const { paisPermitido, paisNombre, direccionSalon, telefonoAdmin, horarios } = req.body;
    if (paisPermitido !== undefined) spaConfig.paisPermitido = paisPermitido;
    if (paisNombre !== undefined) spaConfig.paisNombre = paisNombre;
    if (direccionSalon !== undefined) spaConfig.direccionSalon = direccionSalon;
    if (telefonoAdmin !== undefined) spaConfig.telefonoAdmin = telefonoAdmin;
    if (horarios !== undefined) spaConfig.horarios = horarios;
    await guardarSpaConfig();
    res.json({ ok: true, spaConfig });
});

// ==================== CONFIGURACIÓN GENERAL ====================
let configData = {
    hero: {
        titulo: "Renueva tu Energía",
        subtitulo: "Experiencias de bienestar",
        imagenFondo: "https://images.unsplash.com/photo-1544161515-4ab6ce6db874?w=1920",
        botonTexto: "Explorar Tratamientos"
    },
    serviciosSection: {
        etiqueta: "Nuestros Servicios",
        titulo: "Elige tu Masaje Ideal",
        descripcion: "Turnos: 12:00, 16:00 y 20:00"
    },
    contactoSection: {
        titulo: "Asistente de Reservas",
        descripcion: "Reserva tu turno de forma rápida"
    },
    shareSection: {
        titulo: "Comparte Serenity Spa"
    }
};

app.get('/api/config', (req, res) => res.json(configData));

app.put('/api/config', async (req, res) => {
    if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    configData = { ...configData, ...req.body };
    await fs.writeFile(CONFIG_FILE, JSON.stringify(configData, null, 2), 'utf8');
    res.json({ ok: true });
});

// ==================== UPLOAD HERO ====================
app.post('/api/upload-hero', async (req, res) => {
    if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    try {
        const { base64 } = req.body;
        if (!base64 || !base64.startsWith('data:image')) return res.status(400).json({ error: 'Imagen inválida' });
        const matches = base64.match(/^data:image\/(\w+);base64,(.+)$/);
        if (!matches) return res.status(400).json({ error: 'Formato no reconocido' });
        const ext = matches[1] === 'jpeg' ? 'jpg' : matches[1];
        const buffer = Buffer.from(matches[2], 'base64');
        const filename = `hero-${Date.now()}.${ext}`;
        await fs.writeFile(path.join(UPLOADS_DIR, filename), buffer);
        const files = await fs.readdir(UPLOADS_DIR);
        for (const f of files) {
            if (f.startsWith('hero-') && f !== filename) {
                try { await fs.unlink(path.join(UPLOADS_DIR, f)); } catch(e) {}
            }
        }
        res.json({ url: `/uploads/${filename}`, filename });
    } catch (e) {
        res.status(500).json({ error: 'Error al subir imagen' });
    }
});

// ==================== SERVICIOS ====================
app.get('/api/servicios', (req, res) => res.json(serviciosData));

app.post('/api/servicios', async (req, res) => {
    if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    const s = { id: generarId(), ...req.body };
    serviciosData.push(s);
    await fs.writeFile(SERVICIOS_FILE, JSON.stringify(serviciosData, null, 2), 'utf8');
    res.status(201).json(s);
});

app.put('/api/servicios/:id', async (req, res) => {
    if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    const index = serviciosData.findIndex(s => s.id === req.params.id);
    if (index === -1) return res.status(404).json({ error: 'No encontrado' });
    serviciosData[index] = { ...serviciosData[index], ...req.body, id: req.params.id };
    await fs.writeFile(SERVICIOS_FILE, JSON.stringify(serviciosData, null, 2), 'utf8');
    res.json({ ok: true });
});

app.delete('/api/servicios/:id', async (req, res) => {
    if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    serviciosData = serviciosData.filter(s => s.id !== req.params.id);
    await fs.writeFile(SERVICIOS_FILE, JSON.stringify(serviciosData, null, 2), 'utf8');
    res.json({ ok: true });
});

// ==================== TURNOS ====================
app.get('/turnos', async (req, res) => res.json(await loadTurnos()));

app.post('/turnos', async (req, res) => {
    const ip = req.ip || '0.0.0.0';
    if (estaBloqueado(ip)) return res.status(403).json({ error: 'IP bloqueada' });
    
    const { nombre, dia, hora, massageType, telefono, codigoPais, ubicacion, tipoServicio } = req.body;
    
    if (!nombre || nombre.length < 2) return res.status(400).json({ error: 'Nombre inválido' });
    if (!telefono || telefono.length < 7) return res.status(400).json({ error: 'Teléfono inválido' });
    if (!dia || !DIAS_VALIDOS.includes(dia.toLowerCase())) return res.status(400).json({ error: 'Día inválido' });
    
    const hn = parseInt(hora);
    if (!HORAS_VALIDAS.includes(hn)) return res.status(400).json({ error: 'Hora inválida' });
    
    const turnos = await loadTurnos();
    const dl = dia.toLowerCase();
    
    if (turnos.some(t => t.telefono === telefono && t.dia === dl)) {
        return res.status(409).json({ error: 'Ya tienes un turno ese día' });
    }
    
    if (turnos.some(t => t.dia === dl && t.hora === hn)) {
        return res.status(409).json({ error: 'Horario ocupado' });
    }
    
    const nuevo = {
        id: generarId(),
        nombre: nombre,
        dia: dl,
        hora: hn,
        massageType: massageType || 'Masaje',
        telefono: telefono,
        codigoPais: codigoPais || spaConfig.paisPermitido,
        ubicacion: ubicacion || spaConfig.direccionSalon,
        tipoServicio: tipoServicio || 'salon',
        confirmadoWhatsApp: false,
        fechaCreacion: new Date().toISOString(),
        ip
    };
    
    turnos.push(nuevo);
    await saveTurnos(turnos);
    res.status(201).json({ mensaje: 'Turno reservado', turno: nuevo });
});

app.delete('/turnos/:id', async (req, res) => {
    if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    const turnos = await loadTurnos();
    const nuevos = turnos.filter(t => t.id !== req.params.id);
    await saveTurnos(nuevos);
    res.json({ ok: true });
});

// ==================== WEBHOOK PARA CREAR RESERVA DESDE IA ====================
app.post('/api/crear-reserva', async (req, res) => {
    const ip = req.ip || '0.0.0.0';
    const datos = req.body;
    
    const resultado = await crearReserva(datos, ip);
    res.json(resultado);
});

// ==================== CHAT IA PARA TEXTO ====================
app.post('/api/chat-ia', async (req, res) => {
    const { mensaje, nombre, codigoPais, historial } = req.body;
    const turnos = await loadTurnos();
    
    const respuesta = await procesarConIA(mensaje, historial, nombre, codigoPais, spaConfig.horarios, turnos);
    
    if (respuesta) {
        res.json({ respuesta, modo: 'openrouter' });
    } else {
        res.json({ respuesta: 'Lo siento, el asistente no está disponible en este momento. Por favor, intenta más tarde.', modo: 'error' });
    }
});

// ==================== SEGURIDAD ====================
app.get('/api/seguridad/bloqueos', (req, res) => {
    if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    const a = [];
    for (const [ip, d] of bloqueos) {
        a.push({ ip, motivo: d.motivo, tipoAtaque: d.tipoAtaque, fecha: d.fecha });
    }
    res.json({ activos: a, historial: historialBloqueos.slice(0, 100) });
});

app.post('/api/seguridad/desbloquear/:ip', (req, res) => {
    if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    desbloquearIP(req.params.ip);
    res.json({ ok: true });
});

// ==================== RUTAS ESTÁTICAS ====================
app.get('/voice-assistant', (req, res) => res.sendFile(path.join(__dirname, 'voice-assistant.html')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/admin.html', (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));
app.get('/login.html', (req, res) => res.sendFile(path.join(__dirname, 'login.html')));

app.get('/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        ia: iaDisponible ? 'openrouter' : 'no disponible',
        modelo: MODELO_IA,
        timestamp: new Date().toISOString()
    });
});

// ==================== WEBSOCKET PARA VOZ ====================
function generarId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2, 8);
}

// Almacenar historial por cliente
const historialesCliente = new Map();

const wss = new WebSocket.Server({ server: null, path: '/ws-voice' });

async function manejarMensajeVoz(texto, clientId, ip) {
    console.log(`🎤 Cliente ${clientId}: "${texto}"`);
    
    // Obtener o crear historial del cliente
    let historial = historialesCliente.get(clientId) || [];
    let nombreCliente = null;
    
    // Buscar nombre en el historial
    for (const msg of historial) {
        if (msg.role === 'user' && msg.content.match(/mi nombre es|me llamo|soy/i)) {
            const match = msg.content.match(/(?:mi nombre es|me llamo|soy)\s+([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+)/i);
            if (match) nombreCliente = match[1];
        }
    }
    
    const turnos = await loadTurnos();
    
    // Procesar con IA
    let respuesta = await procesarConIA(texto, historial, nombreCliente, spaConfig.paisPermitido, spaConfig.horarios, turnos);
    
    // Si la IA no respondió, usar respuesta de emergencia
    if (!respuesta) {
        respuesta = "Lo siento, el asistente no está disponible en este momento. Por favor, intenta más tarde o contacta con nuestro equipo al " + spaConfig.telefonoAdmin;
    }
    
    // Verificar si la respuesta contiene una solicitud de reserva
    const reservaMatch = respuesta.match(/reservar|confirmar|agendar/i);
    
    // Guardar en historial
    historial.push({ role: 'user', content: texto });
    historial.push({ role: 'assistant', content: respuesta });
    
    // Limitar historial a 20 mensajes
    if (historial.length > 20) {
        historial = historial.slice(-20);
    }
    historialesCliente.set(clientId, historial);
    
    console.log(`🤖 Respuesta: "${respuesta.substring(0, 100)}..."`);
    
    return respuesta;
}

// ==================== INICIALIZACIÓN ====================
async function initFile(f, fb) {
    try { return JSON.parse(await fs.readFile(f, 'utf8')); }
    catch(e) { await fs.writeFile(f, JSON.stringify(fb, null, 2), 'utf8'); return JSON.parse(JSON.stringify(fb)); }
}

async function start() {
    await cargarBloqueos();
    await cargarPaises();
    await cargarSpaConfig();
    
    configData = await initFile(CONFIG_FILE, configData);
    
    serviciosData = await initFile(SERVICIOS_FILE, [
        { id: "1", nombre: "Masaje Relajante", precio: "$45", descripcion: "Movimientos suaves para liberar el estrés", beneficios: ["Reduce ansiedad", "60 Minutos"], efectos: ["Relajación profunda"], imagenWeb: "", orden: 1 },
        { id: "2", nombre: "Masaje Corporal", precio: "$65", descripcion: "Tratamiento completo para relajación profunda", beneficios: ["Relajación integral", "90 Minutos"], efectos: ["Activación linfática"], imagenWeb: "", orden: 2 },
        { id: "3", nombre: "Masaje Facial", precio: "$40", descripcion: "Rejuvenece la piel y alivia la tensión facial", beneficios: ["Reafirma la piel", "45 Minutos"], efectos: ["Estimula colágeno"], imagenWeb: "", orden: 3 }
    ]);
    
    turnosMem = await initFile(TURNOS_FILE, []);

    const server = app.listen(PORT, '0.0.0.0', () => {
        console.log(`🌿 Serenity Spa v5.0 iniciado en puerto ${PORT}`);
        console.log(`🤖 IA: ${iaDisponible ? `OpenRouter (${MODELO_IA})` : 'NO DISPONIBLE'}`);
        console.log(`🌍 País: ${spaConfig.paisNombre} (+${spaConfig.paisPermitido})`);
    });
    
    // Configurar WebSocket en el mismo servidor
    const wssServer = new WebSocket.Server({ server, path: '/ws-voice' });
    
    wssServer.on('connection', (ws, req) => {
        const ip = req.socket.remoteAddress || 'desconocida';
        const clientId = generarId();
        console.log(`🔌 Cliente conectado: ${clientId} (${ip})`);
        
        // Enviar mensaje de bienvenida
        ws.send(JSON.stringify({ 
            tipo: 'respuesta', 
            texto: 'Hola, soy el asistente de Serenity Spa. ¿En qué puedo ayudarte? Puedo ayudarte a reservar un turno, consultar precios, horarios o la ubicación de nuestro salón.' 
        }));
        
        ws.on('message', async (data) => {
            try {
                const msg = JSON.parse(data);
                if (msg.tipo === 'transcripcion') {
                    const respuesta = await manejarMensajeVoz(msg.texto, clientId, ip);
                    if (ws.readyState === 1) {
                        ws.send(JSON.stringify({ tipo: 'respuesta', texto: respuesta }));
                    }
                }
            } catch(e) {
                console.error('❌ Error:', e.message);
                if (ws.readyState === 1) {
                    ws.send(JSON.stringify({ tipo: 'respuesta', texto: 'Disculpa, hubo un error. ¿Podrías repetir?' }));
                }
            }
        });
        
        ws.on('close', () => {
            console.log(`🔌 Cliente desconectado: ${clientId}`);
            historialesCliente.delete(clientId);
        });
    });
    
    console.log(`🎤 WebSocket listo en /ws-voice`);
}

process.on('SIGTERM', async () => { await guardarBloqueos(); process.exit(0); });
process.on('SIGINT', async () => { await guardarBloqueos(); process.exit(0); });

start();
const express = require('express');
const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const crypto = require('crypto');
const WebSocket = require('ws');
const OpenAI = require('openai');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 5001;

// ==================== SUPABASE (PERSISTENCIA) ====================
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
let supabase = null;

if (supabaseUrl && supabaseKey) {
    supabase = createClient(supabaseUrl, supabaseKey);
    console.log('✅ Supabase conectado - Los datos serán persistentes');
} else {
    console.log('⚠️ Supabase no configurado - Usando archivos locales (no persistentes en Render)');
}

// ==================== OPENROUTER ====================
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const MODELOS_GRATUITOS = [
    'google/gemini-2.0-flash-lite-preview-02-05:free',
    'meta-llama/llama-3.2-1b-instruct:free',
    'qwen/qwen-2.5-3b-instruct:free'
];
let modeloActualIndex = 0;
let openrouter = null;

if (OPENROUTER_API_KEY && OPENROUTER_API_KEY !== '') {
    openrouter = new OpenAI({
        baseURL: 'https://openrouter.ai/api/v1',
        apiKey: OPENROUTER_API_KEY,
        defaultHeaders: {
            'HTTP-Referer': 'https://masajes-spa.onrender.com',
            'X-Title': 'Serenity Spa Asistente',
        }
    });
    console.log('✅ OpenRouter configurado');
}

app.disable('x-powered-by');

const UPLOADS_DIR = path.join(__dirname, 'uploads');
if (!fsSync.existsSync(UPLOADS_DIR)) {
    fsSync.mkdirSync(UPLOADS_DIR, { recursive: true });
}

app.use('/uploads', express.static(UPLOADS_DIR));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.static(__dirname));

const HORAS_VALIDAS = [12, 16, 20];
const DIAS_VALIDOS = ['lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado'];

// ==================== SISTEMA DE BLOQUEOS (en memoria por ahora) ====================
let bloqueos = new Map();
let historialBloqueos = [];
let intentosFallidos = new Map();

function estaBloqueado(ip) {
    if (bloqueos.has(ip)) {
        if (Date.now() < bloqueos.get(ip).hasta) return true;
        bloqueos.delete(ip);
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
        intentos: (intentosFallidos.get(ip)?.count || 0)
    });
    historialBloqueos.unshift({ ...bloqueos.get(ip), id: generarId() });
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

// ==================== FUNCIONES CON SUPABASE ====================
async function cargarTurnos() {
    if (supabase) {
        const { data } = await supabase.from('turnos').select('*').order('fechaCreacion', { ascending: false });
        return data || [];
    }
    try {
        if (fsSync.existsSync('./turnos.json')) {
            return JSON.parse(await fs.readFile('./turnos.json', 'utf8'));
        }
    } catch(e) {}
    return [];
}

async function guardarTurnos(turnos) {
    if (supabase) {
        // Sincronizar con Supabase
        for (const turno of turnos) {
            await supabase.from('turnos').upsert([turno]);
        }
        // Eliminar los que ya no están
        const { data: existentes } = await supabase.from('turnos').select('id');
        if (existentes) {
            const idsActuales = new Set(turnos.map(t => t.id));
            for (const existente of existentes) {
                if (!idsActuales.has(existente.id)) {
                    await supabase.from('turnos').delete().eq('id', existente.id);
                }
            }
        }
    }
    await fs.writeFile('./turnos.json', JSON.stringify(turnos, null, 2), 'utf8');
}

async function cargarServicios() {
    if (supabase) {
        const { data } = await supabase.from('servicios').select('*').order('orden', { ascending: true });
        if (data && data.length > 0) return data;
    }
    try {
        if (fsSync.existsSync('./servicios.json')) {
            return JSON.parse(await fs.readFile('./servicios.json', 'utf8'));
        }
    } catch(e) {}
    return [];
}

async function guardarServicios(servicios) {
    if (supabase) {
        for (const servicio of servicios) {
            await supabase.from('servicios').upsert([servicio]);
        }
    }
    await fs.writeFile('./servicios.json', JSON.stringify(servicios, null, 2), 'utf8');
}

async function cargarConfig() {
    if (supabase) {
        const { data } = await supabase.from('config_data').select('value').eq('key', 'config').single();
        if (data) return data.value;
    }
    try {
        if (fsSync.existsSync('./config.json')) {
            return JSON.parse(await fs.readFile('./config.json', 'utf8'));
        }
    } catch(e) {}
    return {
        hero: { titulo: "Renueva tu Energía", subtitulo: "Experiencias de bienestar", imagenFondo: "", botonTexto: "Explorar Tratamientos" },
        serviciosSection: { etiqueta: "Nuestros Servicios", titulo: "Elige tu Masaje Ideal", descripcion: "" },
        contactoSection: { titulo: "Asistente de Reservas", descripcion: "Reserva tu turno de forma rápida" },
        shareSection: { titulo: "Comparte Serenity Spa" }
    };
}

async function guardarConfig(config) {
    if (supabase) {
        await supabase.from('config_data').upsert([{ key: 'config', value: config }]);
    }
    await fs.writeFile('./config.json', JSON.stringify(config, null, 2), 'utf8');
}

// ==================== AUTENTICACIÓN ====================
const validTokens = new Map();

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

app.get('/api/verify', (req, res) => {
    const token = req.headers.authorization?.split(' ')[1];
    res.json({ valid: token && validTokens.has(token) });
});

function checkAuth(req) {
    const token = req.headers.authorization?.split(' ')[1];
    return token && validTokens.has(token);
}

// ==================== CONFIGURACIÓN ====================
let configData = null;

app.get('/api/config', async (req, res) => {
    if (!configData) configData = await cargarConfig();
    res.json(configData);
});

app.put('/api/config', async (req, res) => {
    if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    configData = { ...configData, ...req.body };
    await guardarConfig(configData);
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
        res.json({ url: `/uploads/${filename}` });
    } catch (e) {
        res.status(500).json({ error: 'Error al subir imagen' });
    }
});

// ==================== SERVICIOS ====================
let serviciosData = [];

app.get('/api/servicios', async (req, res) => {
    if (serviciosData.length === 0) serviciosData = await cargarServicios();
    res.json(serviciosData);
});

app.post('/api/servicios', async (req, res) => {
    if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    const nuevo = { id: generarId(), ...req.body };
    serviciosData.push(nuevo);
    await guardarServicios(serviciosData);
    res.status(201).json(nuevo);
});

app.put('/api/servicios/:id', async (req, res) => {
    if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    const index = serviciosData.findIndex(s => s.id === req.params.id);
    if (index === -1) return res.status(404).json({ error: 'No encontrado' });
    serviciosData[index] = { ...serviciosData[index], ...req.body };
    await guardarServicios(serviciosData);
    res.json({ ok: true });
});

app.delete('/api/servicios/:id', async (req, res) => {
    if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    serviciosData = serviciosData.filter(s => s.id !== req.params.id);
    await guardarServicios(serviciosData);
    res.json({ ok: true });
});

// ==================== TURNOS ====================
let turnosMem = [];

app.get('/turnos', async (req, res) => {
    if (turnosMem.length === 0) turnosMem = await cargarTurnos();
    res.json(turnosMem);
});

app.post('/turnos', async (req, res) => {
    const ip = req.ip || '0.0.0.0';
    if (estaBloqueado(ip)) return res.status(403).json({ error: 'IP bloqueada' });
    
    const { nombre, dia, hora, massageType, telefono, codigoPais, ubicacion, tipoServicio } = req.body;
    
    if (!nombre || nombre.length < 2) return res.status(400).json({ error: 'Nombre inválido' });
    if (!telefono || telefono.length < 7) return res.status(400).json({ error: 'Teléfono inválido' });
    if (!dia || !DIAS_VALIDOS.includes(dia.toLowerCase())) return res.status(400).json({ error: 'Día inválido' });
    
    const hn = parseInt(hora);
    if (!HORAS_VALIDAS.includes(hn)) return res.status(400).json({ error: 'Hora inválida' });
    
    const dl = dia.toLowerCase();
    const turnos = await cargarTurnos();
    
    if (turnos.some(t => t.telefono === telefono && t.dia === dl)) {
        return res.status(409).json({ error: 'Ya tienes un turno ese día' });
    }
    
    if (turnos.some(t => t.dia === dl && t.hora === hn)) {
        return res.status(409).json({ error: 'Horario ocupado' });
    }
    
    const nuevo = {
        id: generarId(),
        nombre,
        dia: dl,
        hora: hn,
        massageType: massageType || 'Masaje',
        telefono: telefono.replace(/\D/g, ''),
        codigoPais: codigoPais || '53',
        ubicacion: ubicacion || 'Salón Serenity Spa',
        tipoServicio: tipoServicio || 'salon',
        confirmadoWhatsApp: false,
        fechaCreacion: new Date().toISOString(),
        ip
    };
    
    turnos.push(nuevo);
    await guardarTurnos(turnos);
    turnosMem = turnos;
    
    res.status(201).json({ mensaje: 'Turno reservado', turno: nuevo });
});

app.delete('/turnos/:id', async (req, res) => {
    if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    const turnos = await cargarTurnos();
    const nuevos = turnos.filter(t => t.id !== req.params.id);
    await guardarTurnos(nuevos);
    turnosMem = nuevos;
    res.json({ ok: true });
});

// ==================== CHAT IA ====================
async function responderConIA(mensaje, historial) {
    if (!openrouter) {
        return "Hola, soy el asistente de Serenity Spa. ¿En qué puedo ayudarte?";
    }
    
    const servicios = await cargarServicios();
    const serviciosInfo = servicios.map(s => `- ${s.nombre}: ${s.precio}`).join('\n');
    
    const systemPrompt = `Eres el asistente de Serenity Spa. Ayudas a reservar turnos.

SERVICIOS:
${serviciosInfo}

REGLAS:
1. Ayuda a reservar turnos (nombre, masaje, día, hora, teléfono)
2. Si falta información, pregunta solo eso
3. NO uses emojis ni asteriscos
4. Responde en español`;

    try {
        let modeloActual = MODELOS_GRATUITOS[modeloActualIndex];
        const completion = await openrouter.chat.completions.create({
            model: modeloActual,
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: mensaje }
            ],
            temperature: 0.6,
            max_tokens: 300
        });
        return completion.choices[0].message.content;
    } catch (error) {
        console.error('Error IA:', error.message);
        modeloActualIndex = (modeloActualIndex + 1) % MODELOS_GRATUITOS.length;
        return "¿En qué puedo ayudarte? Puedo ayudarte a reservar un turno.";
    }
}

app.post('/api/chat-ia', async (req, res) => {
    const { mensaje, historial } = req.body;
    const respuesta = await responderConIA(mensaje, historial);
    res.json({ respuesta });
});

// ==================== SEGURIDAD ====================
app.get('/api/seguridad/bloqueos', (req, res) => {
    if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    const activos = [];
    for (const [ip, datos] of bloqueos) {
        activos.push({
            ip,
            motivo: datos.motivo,
            tipoAtaque: datos.tipoAtaque,
            fecha: datos.fecha,
            tiempoRestante: Math.max(0, datos.hasta - Date.now())
        });
    }
    res.json({ activos, historial: historialBloqueos.slice(0, 100) });
});

app.post('/api/seguridad/desbloquear/:ip', (req, res) => {
    if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    bloqueos.delete(req.params.ip);
    res.json({ ok: true });
});

app.post('/api/seguridad/limpiar-expirados', (req, res) => {
    if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    const ahora = Date.now();
    for (const [ip, datos] of bloqueos) {
        if (ahora > datos.hasta) bloqueos.delete(ip);
    }
    res.json({ mensaje: 'Bloqueos expirados eliminados' });
});

// ==================== RUTAS ESTÁTICAS ====================
app.get('/voice-assistant', (req, res) => res.sendFile(path.join(__dirname, 'voice-assistant.html')));
app.get('/admin.html', (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));
app.get('/login.html', (req, res) => res.sendFile(path.join(__dirname, 'login.html')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/health', (req, res) => res.json({ status: 'ok', supabase: !!supabase }));

// ==================== WEBSOCKET ====================
function generarId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2, 8);
}

const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`🌿 Servidor iniciado en puerto ${PORT}`);
    console.log(`💾 Supabase: ${supabase ? 'CONECTADO (datos persistentes)' : 'NO CONECTADO'}`);
});

const wss = new WebSocket.Server({ server, path: '/ws-voice' });

wss.on('connection', (ws, req) => {
    const clientId = generarId();
    console.log(`🎤 Cliente conectado: ${clientId}`);
    
    ws.send(JSON.stringify({ 
        tipo: 'respuesta', 
        texto: 'Hola, soy el asistente de Serenity Spa. ¿En qué puedo ayudarte?' 
    }));
    
    ws.on('message', async (data) => {
        try {
            const msg = JSON.parse(data);
            if (msg.tipo === 'transcripcion') {
                console.log(`🎤 Cliente: "${msg.texto}"`);
                const respuesta = await responderConIA(msg.texto, []);
                ws.send(JSON.stringify({ tipo: 'respuesta', texto: respuesta }));
            }
        } catch(e) {
            console.error('Error:', e.message);
        }
    });
    
    ws.on('close', () => console.log(`🔌 Cliente desconectado: ${clientId}`));
});
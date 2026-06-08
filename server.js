const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const WebSocket = require('ws');
const OpenAI = require('openai');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 5001;

// ==================== CONFIGURACIÓN DE SUPABASE ====================
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ANON_KEY;
let supabase = null;

if (supabaseUrl && supabaseKey) {
    try {
        supabase = createClient(supabaseUrl, supabaseKey);
        console.log('✅ Supabase conectado correctamente');
    } catch(e) {
        console.log('❌ Error conectando Supabase:', e.message);
    }
} else {
    console.log('⚠️ Variables de Supabase no configuradas');
}

// ==================== CONFIGURACIÓN DE OPENROUTER ====================
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
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
                'X-Title': 'Serenity Spa Asistente',
            }
        });
        iaDisponible = true;
        console.log('✅ OpenRouter configurado');
    } catch(e) {
        console.log('❌ Error OpenRouter:', e.message);
    }
}

app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use(express.static(__dirname));

// ==================== MIDDLEWARE DE SEGURIDAD ====================
app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    next();
});

// ==================== AUTENTICACIÓN ADMIN ====================
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
    const { password } = req.body;
    const adminPassword = process.env.ADMIN_PASSWORD || 'admin123';
    if (password === adminPassword) {
        const token = crypto.randomBytes(64).toString('hex');
        validTokens.set(token, Date.now() + 28800000);
        res.json({ success: true, token });
    } else {
        res.status(401).json({ success: false, error: 'Contraseña incorrecta' });
    }
});

app.get('/api/verify', (req, res) => {
    res.json({ valid: checkAuth(req) });
});

// ==================== CONFIGURACIÓN DEL SPA ====================
let spaConfig = {
    paisPermitido: '53',
    paisNombre: 'Cuba',
    direccionSalon: 'Calle 23 #456, La Habana, Cuba',
    telefonoAdmin: '+53 5555-1234',
    horarios: 'Lunes a Sábado 12:00, 16:00, 20:00'
};

app.get('/api/spa-config', (req, res) => {
    res.json(spaConfig);
});

app.put('/api/spa-config', async (req, res) => {
    if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    spaConfig = { ...spaConfig, ...req.body };
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

app.get('/api/config', (req, res) => {
    res.json(configData);
});

app.put('/api/config', async (req, res) => {
    if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    configData = { ...configData, ...req.body };
    res.json({ ok: true });
});

// ==================== SERVICIOS ====================
app.get('/api/servicios', async (req, res) => {
    try {
        if (supabase) {
            const { data, error } = await supabase
                .from('servicios')
                .select('*')
                .order('orden', { ascending: true });
            
            if (error) throw error;
            if (data && data.length > 0) {
                return res.json(data);
            }
        }
        
        // Datos por defecto si no hay en Supabase
        const defaultServicios = [
            { id: "1", nombre: "Masaje Relajante", precio: "$45", descripcion: "Movimientos suaves para liberar el estrés", beneficios: ["Reduce ansiedad", "60 Minutos"], efectos: ["Relajación profunda"], imagenWeb: "", orden: 1 },
            { id: "2", nombre: "Masaje Corporal", precio: "$65", descripcion: "Tratamiento completo para relajación profunda", beneficios: ["Relajación integral", "90 Minutos"], efectos: ["Activación linfática"], imagenWeb: "", orden: 2 },
            { id: "3", nombre: "Masaje Facial", precio: "$40", descripcion: "Rejuvenece la piel", beneficios: ["Reafirma la piel", "45 Minutos"], efectos: ["Estimula colágeno"], imagenWeb: "", orden: 3 }
        ];
        res.json(defaultServicios);
    } catch(e) {
        console.error('Error en servicios:', e);
        res.status(500).json({ error: 'Error al cargar servicios' });
    }
});

app.post('/api/servicios', async (req, res) => {
    if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    try {
        const nuevo = { id: Date.now().toString(), ...req.body };
        if (supabase) {
            const { data, error } = await supabase.from('servicios').insert([nuevo]).select();
            if (error) throw error;
            return res.status(201).json(data[0]);
        }
        res.status(201).json(nuevo);
    } catch(e) {
        res.status(500).json({ error: 'Error al crear servicio' });
    }
});

app.put('/api/servicios/:id', async (req, res) => {
    if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    try {
        const { id } = req.params;
        if (supabase) {
            const { data, error } = await supabase.from('servicios').update(req.body).eq('id', id).select();
            if (error) throw error;
            return res.json(data[0]);
        }
        res.json({ ok: true });
    } catch(e) {
        res.status(500).json({ error: 'Error al actualizar' });
    }
});

app.delete('/api/servicios/:id', async (req, res) => {
    if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    try {
        const { id } = req.params;
        if (supabase) {
            await supabase.from('servicios').delete().eq('id', id);
        }
        res.json({ ok: true });
    } catch(e) {
        res.status(500).json({ error: 'Error al eliminar' });
    }
});

// ==================== TURNOS ====================
app.get('/turnos', async (req, res) => {
    try {
        if (supabase) {
            const { data, error } = await supabase
                .from('turnos')
                .select('*')
                .order('fechaCreacion', { ascending: false });
            
            if (error) throw error;
            if (data) return res.json(data);
        }
        res.json([]);
    } catch(e) {
        console.error('Error en turnos:', e);
        res.json([]);
    }
});

app.post('/turnos', async (req, res) => {
    const { nombre, dia, hora, massageType, telefono, codigoPais, ubicacion, tipoServicio } = req.body;
    
    if (!nombre || !telefono || !dia || !hora) {
        return res.status(400).json({ error: 'Faltan datos requeridos' });
    }
    
    const nuevo = {
        id: Date.now().toString(),
        nombre,
        dia: dia.toLowerCase(),
        hora: parseInt(hora),
        massageType: massageType || 'Masaje',
        telefono: telefono.replace(/\D/g, ''),
        codigoPais: codigoPais || '53',
        ubicacion: ubicacion || spaConfig.direccionSalon,
        tipoServicio: tipoServicio || 'salon',
        confirmadoWhatsApp: false,
        fechaCreacion: new Date().toISOString()
    };
    
    try {
        if (supabase) {
            const { data, error } = await supabase.from('turnos').insert([nuevo]).select();
            if (error) throw error;
            return res.status(201).json(data[0]);
        }
        res.status(201).json(nuevo);
    } catch(e) {
        console.error('Error al crear turno:', e);
        res.status(500).json({ error: 'Error al crear turno' });
    }
});

app.delete('/turnos/:id', async (req, res) => {
    if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    try {
        const { id } = req.params;
        if (supabase) {
            await supabase.from('turnos').delete().eq('id', id);
        }
        res.json({ ok: true });
    } catch(e) {
        res.status(500).json({ error: 'Error al eliminar' });
    }
});

// ==================== CHAT CON IA (OPENROUTER) ====================
app.post('/api/chat-ia', async (req, res) => {
    const { mensaje, nombre, historial } = req.body;
    
    if (!iaDisponible) {
        return res.json({ 
            respuesta: "Hola, soy el asistente de Serenity Spa. ¿En qué puedo ayudarte? Puedo ayudarte a reservar un turno.", 
            modo: 'local' 
        });
    }
    
    const systemPrompt = `Eres el asistente virtual de Serenity Spa, un centro de masajes profesional.

INFORMACIÓN DEL NEGOCIO:
- Ubicación: ${spaConfig.direccionSalon}
- Teléfono: ${spaConfig.telefonoAdmin}
- Horarios: ${spaConfig.horarios}
- País: ${spaConfig.paisNombre} (+${spaConfig.paisPermitido})

REGLAS:
- Ayuda al cliente a reservar turnos
- Responde preguntas sobre precios, horarios y ubicación
- Sé cálido, profesional y conciso
- NO uses emojis ni asteriscos
- Si no sabes algo, sugiere contactar al administrador`;

    try {
        const messages = [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: mensaje }
        ];
        
        if (historial && historial.length > 0) {
            const recentHistory = historial.slice(-6);
            for (const msg of recentHistory) {
                if (msg.role === 'user' || msg.role === 'assistant') {
                    messages.push({ role: msg.role, content: msg.content });
                }
            }
        }
        
        const completion = await openrouter.chat.completions.create({
            model: MODELO_IA,
            messages: messages,
            temperature: 0.6,
            max_tokens: 250
        });
        
        const respuesta = completion.choices[0].message.content;
        res.json({ respuesta, modo: 'openrouter' });
        
    } catch (error) {
        console.error('Error OpenRouter:', error.message);
        res.json({ 
            respuesta: "Hola, soy el asistente de Serenity Spa. ¿En qué puedo ayudarte?", 
            modo: 'error' 
        });
    }
});

// ==================== RUTAS ESTÁTICAS ====================
app.get('/voice-assistant', (req, res) => {
    res.sendFile(path.join(__dirname, 'voice-assistant.html'));
});

app.get('/admin.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'admin.html'));
});

app.get('/login.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'login.html'));
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        timestamp: new Date().toISOString(),
        ia: iaDisponible ? 'openrouter' : 'no',
        supabase: supabase ? 'conectado' : 'no',
        modelo: MODELO_IA
    });
});

// ==================== WEBSOCKET PARA VOZ ====================
const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`🌿 Serenity Spa iniciado en puerto ${PORT}`);
    console.log(`🤖 OpenRouter: ${iaDisponible ? 'ACTIVO' : 'INACTIVO'}`);
    console.log(`💾 Supabase: ${supabase ? 'CONECTADO' : 'NO CONECTADO'}`);
});

const wss = new WebSocket.Server({ server, path: '/ws-voice' });
const historialesCliente = new Map();

wss.on('connection', (ws, req) => {
    const clientId = Date.now().toString(36);
    const ip = req.socket.remoteAddress;
    console.log(`🎤 Cliente conectado: ${clientId} (${ip})`);
    
    // Mensaje de bienvenida
    ws.send(JSON.stringify({ 
        tipo: 'respuesta', 
        texto: 'Hola, soy el asistente de Serenity Spa. ¿En qué puedo ayudarte? Puedo ayudarte a reservar un turno, consultar precios, horarios o la ubicación de nuestro salón.' 
    }));
    
    ws.on('message', async (data) => {
        try {
            const msg = JSON.parse(data);
            if (msg.tipo === 'transcripcion') {
                console.log(`🎤 Cliente dice: "${msg.texto}"`);
                
                // Obtener historial
                let historial = historialesCliente.get(clientId) || [];
                historial.push({ role: 'user', content: msg.texto });
                
                // Llamar a la IA
                try {
                    const response = await fetch(`http://localhost:${PORT}/api/chat-ia`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ 
                            mensaje: msg.texto, 
                            historial: historial.slice(-10) 
                        })
                    });
                    
                    const result = await response.json();
                    const respuesta = result.respuesta || "Lo siento, no pude procesar tu solicitud. ¿Podrías repetir?";
                    
                    historial.push({ role: 'assistant', content: respuesta });
                    if (historial.length > 20) historial = historial.slice(-20);
                    historialesCliente.set(clientId, historial);
                    
                    if (ws.readyState === 1) {
                        ws.send(JSON.stringify({ tipo: 'respuesta', texto: respuesta }));
                    }
                } catch(e) {
                    console.error('Error en IA:', e.message);
                    if (ws.readyState === 1) {
                        ws.send(JSON.stringify({ tipo: 'respuesta', texto: 'Disculpa, hubo un error. ¿Podrías repetir?' }));
                    }
                }
            }
        } catch(e) {
            console.error('Error en WebSocket:', e.message);
        }
    });
    
    ws.on('close', () => {
        console.log(`🔌 Cliente desconectado: ${clientId}`);
        historialesCliente.delete(clientId);
    });
});

// ==================== MANEJO DE CIERRE ====================
process.on('SIGTERM', () => {
    console.log('Cerrando servidor...');
    process.exit(0);
});

process.on('SIGINT', () => {
    console.log('Cerrando servidor...');
    process.exit(0);
});
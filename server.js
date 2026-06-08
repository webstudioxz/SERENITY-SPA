const express = require('express');
const path = require('path');
const crypto = require('crypto');
const WebSocket = require('ws');
const OpenAI = require('openai');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 5001;

// ==================== SUPABASE ====================
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
let supabase = null;

if (supabaseUrl && supabaseKey) {
    supabase = createClient(supabaseUrl, supabaseKey);
    console.log('✅ Supabase conectado');
}

// ==================== OPENROUTER ====================
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;

// Modelos gratuitos en orden de prioridad (si uno falla, usa el siguiente)
const MODELOS_GRATUITOS = [
    { nombre: 'Gemini 2.0 Flash', id: 'google/gemini-2.0-flash-exp:free', disponible: true },
    { nombre: 'Llama 3.2 3B', id: 'meta-llama/llama-3.2-3b-instruct:free', disponible: true },
    { nombre: 'Phi-3 Mini', id: 'microsoft/phi-3-mini-128k-instruct:free', disponible: true },
    { nombre: 'Gemma 2 9B', id: 'google/gemma-2-9b-it:free', disponible: true }
];

let modeloActual = 0; // Índice del modelo actual
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
    console.log(`📌 Modelo inicial: ${MODELOS_GRATUITOS[0].id}`);
} else {
    console.log('❌ OPENROUTER_API_KEY no encontrada');
}

app.use(express.json());
app.use(express.static(__dirname));

// ==================== CONFIGURACIÓN DEL SPA ====================
const spaConfig = {
    paisPermitido: '53',
    paisNombre: 'Cuba',
    direccionSalon: 'Calle 23 #456, La Habana, Cuba',
    telefonoAdmin: '+53 5555-1234',
    horarios: '12:00, 16:00, 20:00'
};

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
    const token = req.headers.authorization?.split(' ')[1];
    res.json({ valid: token && validTokens.has(token) });
});

// ==================== SERVICIOS ====================
app.get('/api/servicios', async (req, res) => {
    if (supabase) {
        const { data } = await supabase.from('servicios').select('*');
        if (data && data.length) return res.json(data);
    }
    res.json([
        { id: "1", nombre: "Masaje Relajante", precio: "$45", descripcion: "Libera el estrés", beneficios: ["60 min", "Relajación"], orden: 1 },
        { id: "2", nombre: "Masaje Corporal", precio: "$65", descripcion: "Relajación profunda", beneficios: ["90 min", "Completo"], orden: 2 },
        { id: "3", nombre: "Masaje Facial", precio: "$40", descripcion: "Rejuvenece la piel", beneficios: ["45 min", "Facial"], orden: 3 }
    ]);
});

app.post('/api/servicios', async (req, res) => {
    if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    const nuevo = { id: Date.now().toString(), ...req.body };
    if (supabase) {
        await supabase.from('servicios').insert([nuevo]);
    }
    res.status(201).json(nuevo);
});

app.put('/api/servicios/:id', async (req, res) => {
    if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    const { id } = req.params;
    if (supabase) {
        await supabase.from('servicios').update(req.body).eq('id', id);
    }
    res.json({ ok: true });
});

app.delete('/api/servicios/:id', async (req, res) => {
    if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    const { id } = req.params;
    if (supabase) {
        await supabase.from('servicios').delete().eq('id', id);
    }
    res.json({ ok: true });
});

// ==================== TURNOS ====================
app.get('/turnos', async (req, res) => {
    if (supabase) {
        const { data } = await supabase.from('turnos').select('*').order('fechaCreacion', { ascending: false });
        if (data) return res.json(data);
    }
    res.json([]);
});

app.post('/turnos', async (req, res) => {
    const { nombre, dia, hora, massageType, telefono, codigoPais, ubicacion } = req.body;
    
    const nuevoTurno = {
        id: Date.now().toString(),
        nombre,
        dia: dia.toLowerCase(),
        hora: parseInt(hora),
        massageType,
        telefono: telefono.replace(/\D/g, ''),
        codigoPais: codigoPais || '53',
        ubicacion: ubicacion || spaConfig.direccionSalon,
        fechaCreacion: new Date().toISOString()
    };
    
    if (supabase) {
        const { error } = await supabase.from('turnos').insert([nuevoTurno]);
        if (!error) return res.status(201).json(nuevoTurno);
    }
    res.status(201).json(nuevoTurno);
});

app.delete('/turnos/:id', async (req, res) => {
    if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    const { id } = req.params;
    if (supabase) {
        await supabase.from('turnos').delete().eq('id', id);
    }
    res.json({ ok: true });
});

// ==================== FUNCIÓN PARA CAMBIAR MODELO AUTOMÁTICAMENTE ====================
async function cambiarAlSiguienteModelo() {
    modeloActual++;
    if (modeloActual >= MODELOS_GRATUITOS.length) {
        modeloActual = 0; // Volver al primero
        console.log('⚠️ Todos los modelos gratuitos fallaron, reintentando desde el primero');
    }
    console.log(`🔄 Cambiando al modelo: ${MODELOS_GRATUITOS[modeloActual].id}`);
    return MODELOS_GRATUITOS[modeloActual].id;
}

// ==================== FUNCIÓN PRINCIPAL DE IA CON FAILOVER ====================
async function responderConIA(mensaje, historial, turnosActuales, intentos = 0) {
    if (!openrouter) {
        return "El asistente está configurándose. Por favor, intenta de nuevo en unos momentos.";
    }
    
    if (intentos >= MODELOS_GRATUITOS.length * 2) {
        return "Lo siento, todos los servicios están ocupados. Por favor, intenta más tarde o contacta con nuestro equipo al " + spaConfig.telefonoAdmin;
    }
    
    // Obtener servicios
    let servicios = [];
    if (supabase) {
        const { data } = await supabase.from('servicios').select('*');
        if (data) servicios = data;
    }
    
    const modeloActualId = MODELOS_GRATUITOS[modeloActual].id;
    const horariosOcupados = turnosActuales.map(t => `${t.dia} a las ${t.hora}:00`).join(', ');
    
    const systemPrompt = `Eres el asistente de Serenity Spa. Debes ayudar al cliente a reservar un turno.

DATOS DEL SPA:
- Dirección: ${spaConfig.direccionSalon}
- Teléfono: ${spaConfig.telefonoAdmin}
- Horarios disponibles: ${spaConfig.horarios} (solo estos horarios)
- Días: Lunes a Sábado
- País: ${spaConfig.paisNombre} (código +${spaConfig.paisPermitido})

SERVICIOS:
${servicios.map(s => `- ${s.nombre}: ${s.precio} - ${s.descripcion}`).join('\n')}

TURNOS OCUPADOS:
${horariosOcupados || 'Ninguno aún'}

REGLAS:
1. Ayuda a RESERVAR un turno
2. Para reservar necesitas: NOMBRE, MASAJE, DÍA, HORA, TELÉFONO
3. Si falta algo, pregunta SOLO eso
4. Si el horario está ocupado, ofrece alternativas
5. Responde preguntas sobre precios, horarios y ubicación
6. NO uses emojis, ni asteriscos
7. Sé profesional, cálido y CONCISO`;

    try {
        const messages = [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: mensaje }
        ];
        
        if (historial && historial.length > 0) {
            const recent = historial.slice(-8);
            for (const msg of recent) {
                if (msg.role === 'user' || msg.role === 'assistant') {
                    messages.push({ role: msg.role, content: msg.content });
                }
            }
        }
        
        const completion = await openrouter.chat.completions.create({
            model: modeloActualId,
            messages: messages,
            temperature: 0.6,
            max_tokens: 300
        });
        
        console.log(`✅ Respuesta usando modelo: ${modeloActualId}`);
        return completion.choices[0].message.content;
        
    } catch (error) {
        console.error(`❌ Error con modelo ${modeloActualId}:`, error.message);
        
        // Si es error de créditos o rate limit, cambiar al siguiente modelo
        if (error.message.includes('insufficient') || 
            error.message.includes('credits') || 
            error.message.includes('rate') ||
            error.message.includes('quota')) {
            
            console.log(`⚠️ Modelo ${modeloActualId} falló, cambiando al siguiente...`);
            await cambiarAlSiguienteModelo();
            return await responderConIA(mensaje, historial, turnosActuales, intentos + 1);
        }
        
        return "Lo siento, tuve un problema técnico. ¿Podrías repetir tu mensaje?";
    }
}

// ==================== ENDPOINT PARA CHAT ====================
app.post('/api/chat-ia', async (req, res) => {
    const { mensaje, historial } = req.body;
    
    let turnos = [];
    if (supabase) {
        const { data } = await supabase.from('turnos').select('*');
        if (data) turnos = data;
    }
    
    const respuesta = await responderConIA(mensaje, historial || [], turnos);
    res.json({ respuesta });
});

// ==================== FUNCIÓN DE AUTENTICACIÓN ====================
function checkAuth(req) {
    const token = req.headers.authorization?.split(' ')[1];
    return token && validTokens.has(token);
}

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
        ia: openrouter ? 'activa' : 'inactiva',
        modeloActual: MODELOS_GRATUITOS[modeloActual].id,
        modelosDisponibles: MODELOS_GRATUITOS.map(m => m.id)
    });
});

// ==================== WEBSOCKET PARA VOZ ====================
const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ Servidor iniciado en puerto ${PORT}`);
    console.log(`🎤 WebSocket disponible en /ws-voice`);
});

const wss = new WebSocket.Server({ server, path: '/ws-voice' });
const sesiones = new Map();

wss.on('connection', (ws, req) => {
    const sessionId = Date.now().toString(36);
    const historial = [];
    console.log(`🎤 Cliente conectado: ${sessionId}`);
    
    // Enviar saludo inicial
    ws.send(JSON.stringify({ 
        tipo: 'respuesta', 
        texto: 'Hola, soy el asistente de Serenity Spa. ¿En qué puedo ayudarte? Puedo ayudarte a reservar un turno, consultar precios, horarios o la ubicación de nuestro salón.' 
    }));
    
    ws.on('message', async (data) => {
        try {
            const msg = JSON.parse(data);
            if (msg.tipo === 'transcripcion') {
                console.log(`🎤 Cliente: "${msg.texto}"`);
                
                // Guardar en historial
                historial.push({ role: 'user', content: msg.texto });
                
                // Obtener turnos actuales
                let turnos = [];
                if (supabase) {
                    const { data } = await supabase.from('turnos').select('*');
                    if (data) turnos = data;
                }
                
                // Generar respuesta con IA
                const respuesta = await responderConIA(msg.texto, historial, turnos);
                
                // Guardar respuesta
                historial.push({ role: 'assistant', content: respuesta });
                if (historial.length > 20) historial.shift();
                
                // Enviar respuesta
                if (ws.readyState === 1) {
                    ws.send(JSON.stringify({ tipo: 'respuesta', texto: respuesta }));
                }
            }
        } catch(e) {
            console.error('Error:', e.message);
            if (ws.readyState === 1) {
                ws.send(JSON.stringify({ tipo: 'respuesta', texto: 'Disculpa, hubo un error. ¿Podrías repetir?' }));
            }
        }
    });
    
    ws.on('close', () => {
        console.log(`🔌 Cliente desconectado: ${sessionId}`);
    });
});

console.log('✅ Servidor listo');
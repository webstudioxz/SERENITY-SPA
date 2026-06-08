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
const supabaseKey = process.env.SUPABASE_ANON_KEY;
let supabase = null;

if (supabaseUrl && supabaseKey) {
    supabase = createClient(supabaseUrl, supabaseKey);
    console.log('✅ Supabase conectado');
} else {
    console.log('⚠️ Supabase no configurado');
}

// ==================== OPENROUTER ====================
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const MODELO_IA = process.env.MODELO_IA || 'deepseek/deepseek-chat';

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
} else {
    console.log('❌ OPENROUTER_API_KEY no encontrada');
}

app.use(express.json());
app.use(express.static(__dirname));

// ==================== CONFIGURACIÓN ====================
const spaConfig = {
    paisPermitido: '53',
    paisNombre: 'Cuba',
    direccionSalon: 'Calle 23 #456, La Habana, Cuba',
    telefonoAdmin: '+53 5555-1234',
    horarios: '12:00, 16:00, 20:00'
};

// ==================== AUTENTICACIÓN ====================
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
        const { data, error } = await supabase.from('turnos').insert([nuevoTurno]).select();
        if (!error && data) return res.status(201).json(data[0]);
    }
    res.status(201).json(nuevoTurno);
});

// ==================== FUNCIÓN PRINCIPAL DE IA ====================
async function responderConIA(mensaje, historial, turnosActuales) {
    if (!openrouter) {
        return "Lo siento, el asistente no está disponible en este momento. Por favor, intenta más tarde.";
    }
    
    // Obtener servicios
    let servicios = [];
    if (supabase) {
        const { data } = await supabase.from('servicios').select('*');
        if (data) servicios = data;
    }
    
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

REGLAS ESTRICTAS:
1. Tu objetivo es ayudar a RESERVAR un turno.
2. Para reservar necesitas: NOMBRE, MASAJE, DÍA, HORA, TELÉFONO.
3. Si falta algo, pregunta SOLO eso.
4. Si el horario está ocupado, ofrece alternativas.
5. Responde preguntas sobre precios, horarios y ubicación.
6. NO uses emojis, ni asteriscos, ni caracteres especiales.
7. Sé profesional, cálido y CONCISO.
8. Confirma la reserva antes de crearla.`;

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
            model: MODELO_IA,
            messages: messages,
            temperature: 0.5,
            max_tokens: 300
        });
        
        return completion.choices[0].message.content;
        
    } catch (error) {
        console.error('Error IA:', error.message);
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
    
    const respuesta = await responderConIA(mensaje, historial, turnos);
    res.json({ respuesta });
});

// ==================== WEBSOCKET PARA VOZ ====================
const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ Servidor iniciado en puerto ${PORT}`);
    console.log(`🤖 OpenRouter: ${openrouter ? 'ACTIVO' : 'INACTIVO'}`);
});

const wss = new WebSocket.Server({ server, path: '/ws-voice' });
const sesiones = new Map(); // Almacena historial por cliente

wss.on('connection', (ws) => {
    const sessionId = Date.now().toString(36);
    let historial = [];
    console.log(`🎤 Cliente conectado: ${sessionId}`);
    
    // Enviar saludo inicial con IA
    (async () => {
        let turnos = [];
        if (supabase) {
            const { data } = await supabase.from('turnos').select('*');
            if (data) turnos = data;
        }
        const saludo = await responderConIA("Hola, soy un cliente nuevo", [], turnos);
        ws.send(JSON.stringify({ tipo: 'respuesta', texto: saludo }));
    })();
    
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
                
                // Guardar respuesta en historial
                historial.push({ role: 'assistant', content: respuesta });
                if (historial.length > 20) historial = historial.slice(-20);
                sesiones.set(sessionId, historial);
                
                // Enviar respuesta
                ws.send(JSON.stringify({ tipo: 'respuesta', texto: respuesta }));
                
                // VERIFICAR SI HAY QUE CREAR RESERVA
                // Buscar patrones de confirmación en la respuesta del cliente
                const textoLower = msg.texto.toLowerCase();
                const confirmacion = textoLower.includes('si') || textoLower.includes('sí') || textoLower.includes('confirmo');
                const tieneDatos = msg.texto.match(/\d{7,}/); // tiene teléfono
                
                if (confirmacion && tieneDatos) {
                    // Intentar extraer datos de la conversación
                    const datosExtraidos = extraerDatosDeConversacion(historial);
                    if (datosExtraidos.nombre && datosExtraidos.masaje && datosExtraidos.dia && datosExtraidos.hora && datosExtraidos.telefono) {
                        const nuevoTurno = {
                            nombre: datosExtraidos.nombre,
                            dia: datosExtraidos.dia,
                            hora: datosExtraidos.hora,
                            massageType: datosExtraidos.masaje,
                            telefono: datosExtraidos.telefono,
                            codigoPais: '53'
                        };
                        
                        if (supabase) {
                            const { error } = await supabase.from('turnos').insert([{
                                id: Date.now().toString(),
                                ...nuevoTurno,
                                fechaCreacion: new Date().toISOString()
                            }]);
                            if (!error) {
                                ws.send(JSON.stringify({ tipo: 'respuesta', texto: `✅ Reserva confirmada, ${datosExtraidos.nombre}. Te esperamos.` }));
                            }
                        }
                    }
                }
            }
        } catch(e) {
            console.error('Error:', e.message);
        }
    });
    
    ws.on('close', () => {
        console.log(`🔌 Cliente desconectado: ${sessionId}`);
        sesiones.delete(sessionId);
    });
});

// Función para extraer datos de la conversación
function extraerDatosDeConversacion(historial) {
    const textoCompleto = historial.map(h => h.content).join(' ').toLowerCase();
    const resultado = {};
    
    // Extraer nombre
    const nombreMatch = textoCompleto.match(/(?:me llamo|soy|mi nombre es)\s+([a-záéíóúñ]+)/i);
    if (nombreMatch) resultado.nombre = nombreMatch[1].charAt(0).toUpperCase() + nombreMatch[1].slice(1);
    
    // Extraer masaje
    if (textoCompleto.includes('facial')) resultado.masaje = 'Masaje Facial';
    else if (textoCompleto.includes('corporal')) resultado.masaje = 'Masaje Corporal';
    else if (textoCompleto.includes('relajante')) resultado.masaje = 'Masaje Relajante';
    
    // Extraer día
    if (textoCompleto.includes('lunes')) resultado.dia = 'lunes';
    else if (textoCompleto.includes('martes')) resultado.dia = 'martes';
    else if (textoCompleto.includes('miércoles') || textoCompleto.includes('miercoles')) resultado.dia = 'miercoles';
    else if (textoCompleto.includes('jueves')) resultado.dia = 'jueves';
    else if (textoCompleto.includes('viernes')) resultado.dia = 'viernes';
    else if (textoCompleto.includes('sábado') || textoCompleto.includes('sabado')) resultado.dia = 'sabado';
    
    // Extraer hora
    if (textoCompleto.includes('12')) resultado.hora = 12;
    else if (textoCompleto.includes('16')) resultado.hora = 16;
    else if (textoCompleto.includes('20') || textoCompleto.includes('8')) resultado.hora = 20;
    
    // Extraer teléfono
    const telefonoMatch = textoCompleto.match(/\d{7,}/);
    if (telefonoMatch) resultado.telefono = telefonoMatch[0];
    
    return resultado;
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
    res.json({ status: 'ok', ia: openrouter ? 'activa' : 'inactiva' });
});
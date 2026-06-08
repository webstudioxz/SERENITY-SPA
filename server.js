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

// ==================== OPENROUTER (MODELOS GRATUITOS ACTUALIZADOS) ====================
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
let openrouter = null;

// MODELOS GRATUITOS QUE SÍ FUNCIONAN EN OPENROUTER (actualizados abril 2026)
const MODELOS_GRATUITOS = [
    { id: 'deepseek/deepseek-chat', nombre: 'DeepSeek Chat', gratuito: false, costo: 'muy bajo' },
    { id: 'google/gemini-2.0-flash-lite-preview-02-05:free', nombre: 'Gemini 2.0 Flash Lite', gratuito: true },
    { id: 'meta-llama/llama-3.2-1b-instruct:free', nombre: 'Llama 3.2 1B', gratuito: true },
    { id: 'qwen/qwen-2.5-3b-instruct:free', nombre: 'Qwen 2.5 3B', gratuito: true },
    { id: 'microsoft/phi-3-mini-4k-instruct:free', nombre: 'Phi-3 Mini', gratuito: true }
];
let modeloActualIndex = 0;

if (OPENROUTER_API_KEY && OPENROUTER_API_KEY !== '') {
    openrouter = new OpenAI({
        baseURL: 'https://openrouter.ai/api/v1',
        apiKey: OPENROUTER_API_KEY,
        defaultHeaders: {
            'HTTP-Referer': 'https://masajes-spa.onrender.com',
            'X-Title': 'Serenity Spa Asistente de Voz',
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

// ==================== TURNOS ====================
app.get('/turnos', async (req, res) => {
    if (supabase) {
        const { data } = await supabase.from('turnos').select('*').order('fechaCreacion', { ascending: false });
        if (data) return res.json(data);
    }
    res.json([]);
});

app.post('/turnos', async (req, res) => {
    const { nombre, dia, hora, massageType, telefono, codigoPais, ubicacion, tipoServicio } = req.body;
    
    const nuevoTurno = {
        id: Date.now().toString(),
        nombre,
        dia: dia.toLowerCase(),
        hora: parseInt(hora),
        massageType,
        telefono: telefono.replace(/\D/g, ''),
        codigoPais: codigoPais || '53',
        ubicacion: ubicacion || spaConfig.direccionSalon,
        tipoServicio: tipoServicio || 'salon',
        confirmadoWhatsApp: false,
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

function checkAuth(req) {
    const token = req.headers.authorization?.split(' ')[1];
    return token && validTokens.has(token);
}

// ==================== FUNCIÓN PARA CAMBIAR DE MODELO ====================
function cambiarAlSiguienteModelo() {
    modeloActualIndex = (modeloActualIndex + 1) % MODELOS_GRATUITOS.length;
    console.log(`🔄 Cambiando a modelo: ${MODELOS_GRATUITOS[modeloActualIndex].id} (${MODELOS_GRATUITOS[modeloActualIndex].gratuito ? 'gratuito' : 'pago'})`);
    return MODELOS_GRATUITOS[modeloActualIndex].id;
}

// ==================== FUNCIÓN PRINCIPAL DE IA CON OPENROUTER ====================
async function responderConOpenRouter(mensaje, historial, turnosActuales, nombreCliente = null) {
    if (!openrouter) {
        console.log('⚠️ OpenRouter no disponible');
        return null;
    }
    
    // Obtener servicios
    let servicios = [];
    if (supabase) {
        const { data } = await supabase.from('servicios').select('*');
        if (data) servicios = data;
    }
    
    const horariosOcupados = turnosActuales.map(t => `${t.dia} a las ${t.hora}:00`).join(', ');
    
    const systemPrompt = `Eres el asistente virtual de Serenity Spa, un centro de masajes profesional. Tu trabajo es ayudar a los clientes a RESERVAR turnos.

INFORMACIÓN DEL NEGOCIO:
- Dirección del salón: ${spaConfig.direccionSalon}
- Teléfono de contacto: ${spaConfig.telefonoAdmin}
- Horarios disponibles: ${spaConfig.horarios} (SOLO estos horarios)
- Días de atención: Lunes, Martes, Miércoles, Jueves, Viernes, Sábado
- País de operación: ${spaConfig.paisNombre} (código +${spaConfig.paisPermitido})

SERVICIOS OFRECIDOS:
${servicios.map(s => `- ${s.nombre}: ${s.precio} - ${s.descripcion}`).join('\n')}

TURNOS ACTUALMENTE OCUPADOS:
${horariosOcupados || 'Ningún turno ocupado aún'}

REGLAS ESTRICTAS QUE DEBES SEGUIR:
1. Tu OBJETIVO PRINCIPAL es ayudar a RESERVAR un turno.
2. Para crear una reserva necesitas: NOMBRE, TIPO DE MASAJE, DÍA, HORA, TELÉFONO y TIPO DE SERVICIO (salón o domicilio).
3. Si el cliente quiere DOMICILIO, también necesitas DIRECCIÓN.
4. Si falta información, pregunta SOLO por lo que falta, de uno en uno.
5. Si el horario que pide está OCUPADO, sugiere horarios alternativos disponibles.
6. Responde preguntas sobre PRECIOS, HORARIOS y UBICACIÓN del salón.
7. NO uses emojis, NO uses asteriscos, NO uses caracteres especiales.
8. Sé PROFESIONAL, CÁLIDO y CONCISO en tus respuestas.
9. Responde SIEMPRE en ESPAÑOL.

EJEMPLO DE RESPUESTA CORRECTA:
Cliente: "Hola, quiero reservar"
Asistente: "Hola, bienvenido a Serenity Spa. Para ayudarte a reservar, ¿cuál es tu nombre?"`;

    let modeloActual = MODELOS_GRATUITOS[modeloActualIndex].id;
    let ultimoError = null;
    
    // Intentar con el modelo actual, si falla probar con los demás
    for (let intento = 0; intento < MODELOS_GRATUITOS.length * 2; intento++) {
        try {
            const messages = [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: mensaje }
            ];
            
            if (historial && historial.length > 0) {
                const recentHistory = historial.slice(-8);
                for (const msg of recentHistory) {
                    if (msg.role === 'user' || msg.role === 'assistant') {
                        messages.push({ role: msg.role, content: msg.content });
                    }
                }
            }
            
            const completion = await openrouter.chat.completions.create({
                model: modeloActual,
                messages: messages,
                temperature: 0.6,
                max_tokens: 350
            });
            
            const respuesta = completion.choices[0].message.content;
            console.log(`✅ OpenRouter respondió con: ${modeloActual}`);
            return respuesta;
            
        } catch (error) {
            console.error(`❌ Error con modelo ${modeloActual}:`, error.message);
            ultimoError = error;
            
            // Cambiar al siguiente modelo
            cambiarAlSiguienteModelo();
            modeloActual = MODELOS_GRATUITOS[modeloActualIndex].id;
        }
    }
    
    console.log('⚠️ Todos los modelos fallaron');
    return null;
}

// ==================== FUNCIÓN DE RESPUESTA LOCAL (FALLBACK INTELIGENTE) ====================
function respuestaLocalFallback(mensaje, estadoSesion) {
    const msg = mensaje.toLowerCase();
    
    if (!estadoSesion.paso) {
        estadoSesion.paso = 'inicio';
        estadoSesion.datos = {
            nombre: null, masaje: null, dia: null, hora: null, telefono: null, tipoServicio: null, ubicacion: null
        };
    }
    
    const datos = estadoSesion.datos;
    
    // Extraer información del mensaje
    const nombreMatch = msg.match(/(?:me llamo|soy|mi nombre es)\s+([a-záéíóúñ]+)/i);
    if (nombreMatch && !datos.nombre) datos.nombre = nombreMatch[1].charAt(0).toUpperCase() + nombreMatch[1].slice(1);
    
    if (!datos.masaje) {
        if (msg.includes('facial')) datos.masaje = 'Masaje Facial';
        else if (msg.includes('corporal')) datos.masaje = 'Masaje Corporal';
        else if (msg.includes('relajante')) datos.masaje = 'Masaje Relajante';
    }
    
    if (!datos.dia) {
        if (msg.includes('lunes')) datos.dia = 'lunes';
        else if (msg.includes('martes')) datos.dia = 'martes';
        else if (msg.includes('miercoles') || msg.includes('miércoles')) datos.dia = 'miércoles';
        else if (msg.includes('jueves')) datos.dia = 'jueves';
        else if (msg.includes('viernes')) datos.dia = 'viernes';
        else if (msg.includes('sabado') || msg.includes('sábado')) datos.dia = 'sábado';
    }
    
    if (!datos.hora) {
        if (msg.includes('12') || msg.includes('mediodía')) datos.hora = 12;
        else if (msg.includes('16') || msg.includes('cuatro')) datos.hora = 16;
        else if (msg.includes('20') || msg.includes('ocho')) datos.hora = 20;
    }
    
    const telefonoMatch = msg.match(/\d{7,}/);
    if (telefonoMatch && !datos.telefono) datos.telefono = telefonoMatch[0];
    
    if (!datos.tipoServicio) {
        if (msg.includes('domicilio') || msg.includes('casa')) datos.tipoServicio = 'domicilio';
        else if (msg.includes('salon') || msg.includes('salón')) datos.tipoServicio = 'salon';
    }
    
    if (datos.tipoServicio === 'domicilio' && !datos.ubicacion) {
        const direccionMatch = mensaje.match(/(?:calle|dirección|en)\s+([^.,]{5,})/i);
        if (direccionMatch) datos.ubicacion = direccionMatch[1].trim();
    }
    
    // Verificar si tenemos todos los datos
    const tieneTodo = datos.nombre && datos.masaje && datos.dia && datos.hora && datos.telefono && datos.tipoServicio;
    
    // Confirmar reserva
    if (estadoSesion.paso === 'confirmando') {
        if (msg.includes('sí') || msg.includes('si') || msg.includes('confirmo')) {
            estadoSesion.paso = 'completado';
            return `✅ Reserva confirmada, ${datos.nombre}. Te esperamos en Serenity Spa. ¿Necesitas algo más?`;
        } else if (msg.includes('no')) {
            estadoSesion.paso = 'inicio';
            return 'Entiendo, cancelamos la reserva. ¿Necesitas ayuda con algo más?';
        }
    }
    
    // Si tiene todos los datos, confirmar
    if (tieneTodo) {
        if (datos.tipoServicio === 'domicilio' && !datos.ubicacion) {
            return `${datos.nombre}, para servicio a domicilio, necesito tu dirección completa.`;
        }
        estadoSesion.paso = 'confirmando';
        const horaTexto = datos.hora === 12 ? '12:00' : datos.hora === 16 ? '16:00' : '20:00';
        const lugarTexto = datos.tipoServicio === 'salon' ? `en nuestro salón (${spaConfig.direccionSalon})` : `en tu domicilio (${datos.ubicacion})`;
        return `${datos.nombre}, confirmo tu reserva: ${datos.masaje} el ${datos.dia} a las ${horaTexto} ${lugarTexto}. Teléfono: +53 ${datos.telefono}. ¿Confirmas la reserva? Responde sí o no.`;
    }
    
    // Flujo de preguntas
    if (!datos.nombre) return "Hola, para ayudarte a reservar, ¿cuál es tu nombre?";
    if (!datos.masaje) return `${datos.nombre}, ¿qué tipo de masaje prefieres? Tenemos: Relajante ($45), Corporal ($65) o Facial ($40).`;
    if (!datos.dia) return `${datos.nombre}, ¿qué día prefieres para tu ${datos.masaje}? Atendemos de lunes a sábado.`;
    if (!datos.hora) return `${datos.nombre}, ¿a qué hora te gustaría el ${datos.dia}? Horarios: 12:00, 16:00 o 20:00.`;
    if (!datos.tipoServicio) return `${datos.nombre}, ¿dónde prefieres el masaje? ¿En el salón o a domicilio?`;
    if (!datos.telefono) return `${datos.nombre}, necesito tu número de teléfono para confirmar la reserva.`;
    
    return "¿En qué puedo ayudarte? Puedo ayudarte a reservar un turno.";
}

// ==================== ENDPOINT PARA CHAT IA ====================
app.post('/api/chat-ia', async (req, res) => {
    const { mensaje, historial, nombre } = req.body;
    
    let turnos = [];
    if (supabase) {
        const { data } = await supabase.from('turnos').select('*');
        if (data) turnos = data;
    }
    
    let respuesta = await responderConOpenRouter(mensaje, historial || [], turnos, nombre);
    
    if (!respuesta) {
        const estadoSesion = { paso: 'inicio', datos: {} };
        respuesta = respuestaLocalFallback(mensaje, estadoSesion);
    }
    
    res.json({ respuesta });
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
        openrouter: openrouter ? 'conectado' : 'no',
        modeloActual: MODELOS_GRATUITOS[modeloActualIndex].id
    });
});

// ==================== WEBSOCKET PARA VOZ ====================
const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ Servidor iniciado en puerto ${PORT}`);
    console.log(`🎤 WebSocket: /ws-voice`);
});

const wss = new WebSocket.Server({ server, path: '/ws-voice' });
const sesiones = new Map();

wss.on('connection', (ws) => {
    const sessionId = Date.now().toString(36);
    const historial = [];
    let estadoSesion = { paso: 'inicio', datos: {} };
    let nombreCliente = null;
    
    console.log(`🎤 Cliente conectado: ${sessionId}`);
    
    ws.send(JSON.stringify({ 
        tipo: 'respuesta', 
        texto: 'Hola, soy el asistente de Serenity Spa. ¿En qué puedo ayudarte? Puedo ayudarte a reservar un turno.' 
    }));
    
    ws.on('message', async (data) => {
        try {
            const msg = JSON.parse(data);
            if (msg.tipo === 'transcripcion') {
                console.log(`🎤 Cliente: "${msg.texto}"`);
                
                historial.push({ role: 'user', content: msg.texto });
                
                let turnos = [];
                if (supabase) {
                    const { data } = await supabase.from('turnos').select('*');
                    if (data) turnos = data;
                }
                
                // 1. INTENTAR CON OPENROUTER
                let respuesta = await responderConOpenRouter(msg.texto, historial, turnos, nombreCliente);
                
                // 2. SI FALLA, USAR RESPUESTA LOCAL
                if (!respuesta) {
                    respuesta = respuestaLocalFallback(msg.texto, estadoSesion);
                    if (estadoSesion.datos.nombre && !nombreCliente) {
                        nombreCliente = estadoSesion.datos.nombre;
                    }
                }
                
                historial.push({ role: 'assistant', content: respuesta });
                if (historial.length > 20) historial.shift();
                
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
        sesiones.delete(sessionId);
    });
});
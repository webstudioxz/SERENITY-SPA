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
} else {
    console.log('⚠️ Supabase no configurado');
}

// ==================== OPENROUTER ====================
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
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

// Modelos gratuitos en orden de prioridad
const MODELOS_GRATUITOS = [
    'google/gemini-2.0-flash-exp:free',      // Mejor en español
    'meta-llama/llama-3.2-3b-instruct:free', // Alternativa
    'microsoft/phi-3-mini-128k-instruct:free' // Último recurso
];
let indiceModeloActual = 0;

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

function checkAuth(req) {
    const token = req.headers.authorization?.split(' ')[1];
    return token && validTokens.has(token);
}

// ==================== FUNCIÓN DE EMERGENCIA (LOCAL E INTELIGENTE) ====================
function respuestaLocalInteligente(mensaje, historial) {
    const msg = mensaje.toLowerCase();
    
    // --- EXTRACCIÓN DE INFORMACIÓN DEL MENSAJE ACTUAL ---
    const nombreMatch = msg.match(/(?:me llamo|soy|mi nombre es)\s+([a-záéíóúñ]+)/i);
    const tieneMasaje = msg.includes('facial') || msg.includes('corporal') || msg.includes('relajante');
    const tieneDia = msg.includes('lunes') || msg.includes('martes') || msg.includes('miércoles') || msg.includes('miercoles') || msg.includes('jueves') || msg.includes('viernes') || msg.includes('sábado') || msg.includes('sabado');
    const tieneHora = msg.includes('12') || msg.includes('16') || msg.includes('20') || msg.includes('ocho') || msg.includes('cuatro') || msg.includes('mediodía') || msg.includes('tarde') || msg.includes('noche');
    const telefonoMatch = msg.match(/\d{7,}/);
    
    // --- VERIFICAR INFORMACIÓN EN EL HISTORIAL ---
    let nombre = null;
    let masaje = null;
    let dia = null;
    let hora = null;
    let telefono = null;

    for (const item of historial) {
        if (item.role === 'user') {
            const content = item.content.toLowerCase();
            if (!nombre) {
                const nMatch = content.match(/(?:me llamo|soy|mi nombre es)\s+([a-záéíóúñ]+)/i);
                if (nMatch) nombre = nMatch[1];
            }
            if (!masaje && (content.includes('facial') || content.includes('corporal') || content.includes('relajante'))) {
                if (content.includes('facial')) masaje = 'Masaje Facial';
                else if (content.includes('corporal')) masaje = 'Masaje Corporal';
                else if (content.includes('relajante')) masaje = 'Masaje Relajante';
            }
            if (!dia && (content.includes('lunes') || content.includes('martes') || content.includes('miércoles') || content.includes('miercoles') || content.includes('jueves') || content.includes('viernes') || content.includes('sábado') || content.includes('sabado'))) {
                if (content.includes('lunes')) dia = 'lunes';
                else if (content.includes('martes')) dia = 'martes';
                else if (content.includes('miércoles') || content.includes('miercoles')) dia = 'miércoles';
                else if (content.includes('jueves')) dia = 'jueves';
                else if (content.includes('viernes')) dia = 'viernes';
                else if (content.includes('sábado') || content.includes('sabado')) dia = 'sábado';
            }
            if (!hora && (content.includes('12') || content.includes('16') || content.includes('20'))) {
                if (content.includes('12') || content.includes('mediodía')) hora = '12:00';
                else if (content.includes('16') || content.includes('cuatro')) hora = '16:00';
                else if (content.includes('20') || content.includes('ocho')) hora = '20:00';
            }
            if (!telefono) {
                const tMatch = content.match(/\d{7,}/);
                if (tMatch) telefono = tMatch[0];
            }
        }
    }
    
    // Actualizar con la información del mensaje actual
    if (nombreMatch) nombre = nombreMatch[1];
    if (tieneMasaje) {
        if (msg.includes('facial')) masaje = 'Masaje Facial';
        else if (msg.includes('corporal')) masaje = 'Masaje Corporal';
        else if (msg.includes('relajante')) masaje = 'Masaje Relajante';
    }
    if (tieneDia) {
        if (msg.includes('lunes')) dia = 'lunes';
        else if (msg.includes('martes')) dia = 'martes';
        else if (msg.includes('miércoles') || msg.includes('miercoles')) dia = 'miércoles';
        else if (msg.includes('jueves')) dia = 'jueves';
        else if (msg.includes('viernes')) dia = 'viernes';
        else if (msg.includes('sábado') || msg.includes('sabado')) dia = 'sábado';
    }
    if (tieneHora) {
        if (msg.includes('12') || msg.includes('mediodía')) hora = '12:00';
        else if (msg.includes('16') || msg.includes('cuatro')) hora = '16:00';
        else if (msg.includes('20') || msg.includes('ocho')) hora = '20:00';
    }
    if (telefonoMatch) telefono = telefonoMatch[0];
    
    // --- FLUJO DE LA CONVERSACIÓN ---
    
    // 1. Verificar si ya tenemos todo para reservar
    if (nombre && masaje && dia && hora && telefono) {
        return `✅ Genial ${nombre}. Confirmo: ${masaje}, el ${dia} a las ${hora}. Teléfono: +53 ${telefono}. ¿Confirmas la reserva? (responde "sí" o "no")`;
    }
    
    // 2. Confirmar reserva
    if (msg.includes('sí') || msg.includes('si') || msg.includes('confirmo')) {
        return `✅ ¡Reserva confirmada, ${nombre || 'cliente'}! Te esperamos en ${spaConfig.direccionSalon}. ¿Necesitas algo más?`;
    }
    if (msg.includes('no') && (historial.length > 0 && historial[historial.length-1].content.includes('confirmas'))) {
        return `Entiendo, cancelamos la reserva. ¿Necesitas ayuda con algo más?`;
    }
    
    // 3. Preguntas generales (siempre disponibles)
    if (msg.includes('precio') || msg.includes('costo') || msg.includes('cuánto') || msg.includes('cuanto')) {
        return "Nuestros precios son: Masaje Relajante $45, Masaje Corporal $65, Masaje Facial $40. ¿Te gustaría reservar alguno?";
    }
    if (msg.includes('horario') || msg.includes('horarios')) {
        return `Nuestros horarios son: 12:00, 16:00 y 20:00. Atendemos de lunes a sábado. ¿Te gustaría reservar un turno?`;
    }
    if (msg.includes('ubicacion') || msg.includes('dirección') || msg.includes('dónde están')) {
        return `Estamos en ${spaConfig.direccionSalon}. ¿Necesitas ayuda con algo más?`;
    }
    
    // 4. Flujo de reserva (preguntar lo que falta)
    if (!nombre) {
        return "Para ayudarte a reservar, ¿cuál es tu nombre?";
    }
    if (!masaje) {
        return `${nombre}, ¿qué tipo de masaje prefieres? Tenemos: Relajante ($45), Corporal ($65) o Facial ($40).`;
    }
    if (!dia) {
        return `${nombre}, ¿qué día prefieres para tu ${masaje}? Atendemos de lunes a sábado.`;
    }
    if (!hora) {
        return `${nombre}, ¿a qué hora te gustaría el ${dia}? Nuestros horarios son: 12:00, 16:00 o 20:00.`;
    }
    if (!telefono) {
        return `${nombre}, para confirmar tu reserva, necesito tu número de teléfono.`;
    }
    
    return "Lo siento, no entendí. ¿Puedes repetir tu mensaje? Recuerda que puedo ayudarte a reservar un turno.";
}

// ==================== FUNCIÓN PRINCIPAL DE IA CON FALLBACK ====================
async function responderConIA(mensaje, historial, turnosActuales) {
    // Si no hay OpenRouter configurado, usar respuesta local
    if (!openrouter) {
        console.log('📝 Usando respuesta local (OpenRouter no configurado)');
        return respuestaLocalInteligente(mensaje, historial);
    }

    // Obtener servicios para el contexto
    let servicios = [];
    if (supabase) {
        const { data } = await supabase.from('servicios').select('*');
        if (data) servicios = data;
    }
    
    const horariosOcupados = turnosActuales.map(t => `${t.dia} a las ${t.hora}:00`).join(', ');
    
    const systemPrompt = `Eres el asistente de Serenity Spa. Ayudas a reservar turnos.

INFORMACIÓN DEL SPA:
- Dirección: ${spaConfig.direccionSalon}
- Teléfono: ${spaConfig.telefonoAdmin}
- Horarios: ${spaConfig.horarios} (solo estos horarios)
- Días: Lunes a Sábado

SERVICIOS:
${servicios.map(s => `- ${s.nombre}: ${s.precio}`).join('\n')}

TURNOS OCUPADOS:
${horariosOcupados || 'Ninguno'}

REGLAS IMPORTANTES:
- SIEMPRE responde en ESPAÑOL.
- SI el cliente saluda, preséntate y ofrece ayuda para reservar.
- Para reservar necesitas: NOMBRE, MASAJE, DÍA, HORA, TELÉFONO.
- SI falta información, pregunta SOLO lo que falta.
- SI el horario está ocupado, SUGIERE alternativas.
- Responde preguntas sobre PRECIOS, HORARIOS y UBICACIÓN.
- NO uses emojis, NO uses asteriscos.
- Sé amable, profesional y CONCISO.`;

    // Intentar con el modelo actual, y si falla, probar los demás
    for (let intento = 0; intento < MODELOS_GRATUITOS.length; intento++) {
        const modeloActual = MODELOS_GRATUITOS[indiceModeloActual];
        try {
            const messages = [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: mensaje }
            ];
            
            const completion = await openrouter.chat.completions.create({
                model: modeloActual,
                messages: messages,
                temperature: 0.6,
                max_tokens: 300
            });
            
            const respuesta = completion.choices[0].message.content;
            console.log(`✅ IA respondió con: ${modeloActual}`);
            return respuesta;
            
        } catch (error) {
            console.error(`❌ Error con modelo ${modeloActual}:`, error.message);
            // Pasar al siguiente modelo
            indiceModeloActual = (indiceModeloActual + 1) % MODELOS_GRATUITOS.length;
            console.log(`🔄 Cambiando al modelo: ${MODELOS_GRATUITOS[indiceModeloActual]}`);
        }
    }
    
    // Si todos los modelos fallaron, usar respuesta local
    console.log('⚠️ Todos los modelos fallaron, usando respuesta local');
    return respuestaLocalInteligente(mensaje, historial);
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
        openrouter: openrouter ? 'configurado' : 'no',
        modeloActual: MODELOS_GRATUITOS[indiceModeloActual]
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
    
    ws.send(JSON.stringify({ 
        tipo: 'respuesta', 
        texto: 'Hola, soy el asistente de Serenity Spa. ¿En qué puedo ayudarte? Puedo ayudarte a reservar un turno, consultar precios, horarios o la ubicación de nuestro salón.' 
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
                
                const respuesta = await responderConIA(msg.texto, historial, turnos);
                
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
    });
});
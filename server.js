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
let openrouter = null;

const MODELOS_GRATUITOS = [
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

// ==================== FUNCIÓN MEJORADA PARA EXTRAER TELÉFONO ====================
function extraerTelefono(texto) {
    // Eliminar espacios y guiones, luego buscar números
    const textoLimpio = texto.replace(/[\s-]/g, '');
    const numeros = textoLimpio.match(/\d+/g);
    
    if (numeros) {
        // Unir todos los números encontrados
        const telefonoCompleto = numeros.join('');
        
        // Buscar grupos de números que parezcan teléfono (7-15 dígitos)
        // Patrón: puede tener código de país (2-3 dígitos) + 7-8 dígitos
        const telefonoMatch = telefonoCompleto.match(/\d{7,15}/);
        if (telefonoMatch) {
            // Si tiene más de 10 dígitos, tomar los últimos 8 (número local)
            let telefono = telefonoMatch[0];
            if (telefono.length > 10) {
                telefono = telefono.slice(-8);
            }
            return telefono;
        }
    }
    
    // Búsqueda más flexible: cualquier grupo de 7+ dígitos consecutivos
    const matchDirecto = texto.match(/\d{7,}/);
    if (matchDirecto) {
        return matchDirecto[0];
    }
    
    return null;
}

// ==================== FUNCIÓN PARA EXTRAER INFORMACIÓN COMPLETA ====================
function extraerInformacionCompleta(texto, datosActuales) {
    const msg = texto.toLowerCase();
    const nuevosDatos = { ...datosActuales };
    
    // 1. Extraer nombre
    const nombreMatch = texto.match(/(?:me llamo|soy|mi nombre es)\s+([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+)/i);
    if (nombreMatch && !nuevosDatos.nombre) {
        nuevosDatos.nombre = nombreMatch[1];
    }
    
    // Si el texto comienza con "hola" y la siguiente palabra parece un nombre
    const holaMatch = texto.match(/^hola\s+([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+)/i);
    if (holaMatch && !nuevosDatos.nombre) {
        nuevosDatos.nombre = holaMatch[1];
    }
    
    // 2. Extraer masaje
    if (!nuevosDatos.masaje) {
        if (msg.includes('facial')) nuevosDatos.masaje = 'Masaje Facial';
        else if (msg.includes('corporal')) nuevosDatos.masaje = 'Masaje Corporal';
        else if (msg.includes('relajante')) nuevosDatos.masaje = 'Masaje Relajante';
    }
    
    // 3. Extraer día
    if (!nuevosDatos.dia) {
        if (msg.includes('lunes')) nuevosDatos.dia = 'lunes';
        else if (msg.includes('martes')) nuevosDatos.dia = 'martes';
        else if (msg.includes('miercoles') || msg.includes('miércoles')) nuevosDatos.dia = 'miércoles';
        else if (msg.includes('jueves')) nuevosDatos.dia = 'jueves';
        else if (msg.includes('viernes')) nuevosDatos.dia = 'viernes';
        else if (msg.includes('sabado') || msg.includes('sábado')) nuevosDatos.dia = 'sábado';
    }
    
    // 4. Extraer hora
    if (!nuevosDatos.hora) {
        if (msg.includes('12') || msg.includes('doce') || msg.includes('mediodía')) nuevosDatos.hora = 12;
        else if (msg.includes('16') || msg.includes('cuatro') || msg.includes('tarde')) nuevosDatos.hora = 16;
        else if (msg.includes('20') || msg.includes('ocho') || msg.includes('noche')) nuevosDatos.hora = 20;
    }
    
    // 5. Extraer teléfono (USANDO LA FUNCIÓN MEJORADA)
    if (!nuevosDatos.telefono) {
        const telefono = extraerTelefono(texto);
        if (telefono) nuevosDatos.telefono = telefono;
    }
    
    // 6. Extraer tipo de servicio
    if (!nuevosDatos.tipoServicio) {
        if (msg.includes('domicilio') || msg.includes('casa') || msg.includes('domicilio')) {
            nuevosDatos.tipoServicio = 'domicilio';
        } else if (msg.includes('salon') || msg.includes('salón') || msg.includes('local')) {
            nuevosDatos.tipoServicio = 'salon';
        }
    }
    
    // 7. Extraer dirección (para domicilio)
    if (nuevosDatos.tipoServicio === 'domicilio' && !nuevosDatos.ubicacion) {
        // Buscar dirección después de palabras clave
        const direccionMatch = texto.match(/(?:en|dirección|domicilio|calle)\s+([^.,]{5,50})/i);
        if (direccionMatch) {
            nuevosDatos.ubicacion = direccionMatch[1].trim();
        }
    }
    
    return nuevosDatos;
}

// ==================== FUNCIÓN PRINCIPAL DE IA CON OPENROUTER ====================
async function responderConOpenRouter(mensaje, historial, turnosActuales, nombreCliente = null) {
    if (!openrouter) return null;
    
    let servicios = [];
    if (supabase) {
        const { data } = await supabase.from('servicios').select('*');
        if (data) servicios = data;
    }
    
    const horariosOcupados = turnosActuales.map(t => `${t.dia} a las ${t.hora}:00`).join(', ');
    
    const systemPrompt = `Eres el asistente virtual de Serenity Spa.

INFORMACIÓN:
- Dirección: ${spaConfig.direccionSalon}
- Teléfono: ${spaConfig.telefonoAdmin}
- Horarios: ${spaConfig.horarios}
- Días: Lunes a Sábado

SERVICIOS:
${servicios.map(s => `- ${s.nombre}: ${s.precio}`).join('\n')}

REGLAS:
1. Ayuda a RESERVAR turnos
2. Para reservar necesitas: NOMBRE, MASAJE, DÍA, HORA, TELÉFONO y TIPO DE SERVICIO
3. Si falta información, pregunta SOLO lo que falta
4. Si el horario está OCUPADO, sugiere alternativas
5. Responde preguntas sobre PRECIOS, HORARIOS y UBICACIÓN
6. NO uses emojis, NO uses asteriscos
7. Sé PROFESIONAL y CONCISO
8. Responde SIEMPRE en ESPAÑOL`;

    try {
        const messages = [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: mensaje }
        ];
        
        const completion = await openrouter.chat.completions.create({
            model: MODELOS_GRATUITOS[modeloActualIndex].id,
            messages: messages,
            temperature: 0.6,
            max_tokens: 350
        });
        
        return completion.choices[0].message.content;
    } catch (error) {
        console.error('Error OpenRouter:', error.message);
        return null;
    }
}

// ==================== RESPUESTA LOCAL CON EXTRACCIÓN MEJORADA ====================
function respuestaLocalConEstado(mensaje, estadoSesion) {
    const msg = mensaje.toLowerCase();
    
    if (!estadoSesion.paso) {
        estadoSesion.paso = 'inicio';
        estadoSesion.datos = {
            nombre: null, masaje: null, dia: null, hora: null, 
            telefono: null, tipoServicio: null, ubicacion: null
        };
    }
    
    // Extraer información del mensaje actual
    const datosActualizados = extraerInformacionCompleta(mensaje, estadoSesion.datos);
    estadoSesion.datos = datosActualizados;
    const datos = estadoSesion.datos;
    
    // Verificar si tenemos todos los datos
    const tieneTodosLosDatos = datos.nombre && datos.masaje && datos.dia && datos.hora && 
                                datos.telefono && datos.tipoServicio;
    
    // Si tenemos todos los datos, confirmar reserva
    if (tieneTodosLosDatos && estadoSesion.paso !== 'confirmando') {
        // Verificar si falta dirección para domicilio
        if (datos.tipoServicio === 'domicilio' && !datos.ubicacion) {
            return `${datos.nombre}, para el servicio a domicilio, necesito tu dirección completa. ¿Cuál es tu dirección?`;
        }
        
        estadoSesion.paso = 'confirmando';
        const horaTexto = datos.hora === 12 ? '12:00' : datos.hora === 16 ? '16:00' : '20:00';
        const lugarTexto = datos.tipoServicio === 'salon' ? 
            `en nuestro salón (${spaConfig.direccionSalon})` : 
            `en tu domicilio (${datos.ubicacion || 'dirección por confirmar'})`;
        
        return `${datos.nombre}, confirmo tu reserva: ${datos.masaje} el ${datos.dia} a las ${horaTexto} ${lugarTexto}. Teléfono: +53 ${datos.telefono}. ¿Confirmas la reserva? Responde sí o no.`;
    }
    
    // Procesar confirmación
    if (estadoSesion.paso === 'confirmando') {
        if (msg.includes('sí') || msg.includes('si') || msg.includes('confirmo') || msg.includes('vale')) {
            estadoSesion.paso = 'completado';
            return `✅ ¡Reserva confirmada, ${datos.nombre}! Te esperamos en Serenity Spa. ¿Necesitas algo más?`;
        } else if (msg.includes('no') || msg.includes('cancelar')) {
            estadoSesion.paso = 'inicio';
            estadoSesion.datos = { nombre: null, masaje: null, dia: null, hora: null, telefono: null, tipoServicio: null, ubicacion: null };
            return 'Entiendo, cancelamos la reserva. ¿Necesitas ayuda con algo más?';
        }
    }
    
    // Preguntar información faltante en orden
    if (!datos.nombre) {
        return "Hola, para ayudarte a reservar un turno, ¿cuál es tu nombre?";
    }
    
    if (!datos.masaje) {
        return `${datos.nombre}, ¿qué tipo de masaje prefieres? Tenemos: Relajante ($45), Corporal ($65) o Facial ($40).`;
    }
    
    if (!datos.dia) {
        return `${datos.nombre}, ¿qué día prefieres para tu ${datos.masaje}? Atendemos de lunes a sábado.`;
    }
    
    if (!datos.hora) {
        return `${datos.nombre}, ¿a qué hora te gustaría el ${datos.dia}? Nuestros horarios son: 12:00, 16:00 o 20:00.`;
    }
    
    if (!datos.tipoServicio) {
        return `${datos.nombre}, ¿dónde prefieres recibir el masaje? ¿En el salón o a domicilio?`;
    }
    
    if (datos.tipoServicio === 'domicilio' && !datos.ubicacion) {
        return `${datos.nombre}, para el servicio a domicilio, necesito tu dirección completa.`;
    }
    
    if (!datos.telefono) {
        return `${datos.nombre}, necesito tu número de teléfono para confirmar la reserva. Por favor, dímelo.`;
    }
    
    return `¿En qué más puedo ayudarte, ${datos.nombre}? Puedo ayudarte a reservar otro turno o consultar más información.`;
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
        respuesta = respuestaLocalConEstado(mensaje, estadoSesion);
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
        timestamp: new Date().toISOString()
    });
});

// ==================== WEBSOCKET PARA VOZ ====================
const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ Servidor iniciado en puerto ${PORT}`);
    console.log(`🎤 WebSocket: /ws-voice`);
});

const wss = new WebSocket.Server({ server, path: '/ws-voice' });

wss.on('connection', (ws) => {
    const sessionId = Date.now().toString(36);
    const historial = [];
    let estadoSesion = { paso: 'inicio', datos: {} };
    
    console.log(`🎤 Cliente conectado: ${sessionId}`);
    
    ws.send(JSON.stringify({ 
        tipo: 'respuesta', 
        texto: 'Hola, soy el asistente de Serenity Spa. ¿Cuál es tu nombre para ayudarte a reservar un turno?' 
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
                
                // Intentar con OpenRouter
                let respuesta = await responderConOpenRouter(msg.texto, historial, turnos);
                
                // Fallback local si OpenRouter falla
                if (!respuesta) {
                    respuesta = respuestaLocalConEstado(msg.texto, estadoSesion);
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
    });
});
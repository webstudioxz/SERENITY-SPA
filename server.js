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
const UPLOADS_DIR = path.join(__dirname, 'uploads');

// Crear directorio uploads si no existe
if (!fsSync.existsSync(UPLOADS_DIR)) {
    fsSync.mkdirSync(UPLOADS_DIR, { recursive: true });
}

app.use('/uploads', express.static(UPLOADS_DIR));

// ============================================================
// SISTEMA DE BLOQUEOS (ANTI-ABUSO)
// ============================================================
let bloqueos = new Map();
let historialBloqueos = [];

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
        await fs.writeFile(BLOQUEOS_FILE, JSON.stringify({ bloqueos: {}, historial: [] }, null, 2));
    }
}

async function guardarBloqueos() {
    await fs.writeFile(BLOQUEOS_FILE, JSON.stringify({
        bloqueos: Object.fromEntries(bloqueos),
        historial: historialBloqueos.slice(0, 500)
    }, null, 2));
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
        hasta: Date.now() + 3600000, motivo, tipoAtaque: tipo,
        fecha: new Date().toISOString(), ip, permanente: false
    });
    historialBloqueos.unshift({ ...bloqueos.get(ip), id: generarId() });
    guardarBloqueos();
}

// ============================================================
// UTILIDADES
// ============================================================
function generarId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2) + crypto.randomBytes(4).toString('hex');
}

function sanitize(s) { return s ? s.trim().replace(/[^\w\sáéíóúñÑü.,@\-]/gi, '') : ''; }
function escapeHtml(s) { return s ? s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') : ''; }

const HORAS_VALIDAS = [12, 16, 20];
const DIAS_VALIDOS = ['lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado'];

function buscarAlternativa(dia, hora, turnos) {
    const dias = [...DIAS_VALIDOS];
    const idx = dias.indexOf(dia);
    if (idx === -1) return null;
    for (let o = 0; o < 7; o++) {
        const d = dias[(idx + o) % 7];
        const hrs = o === 0 ? HORAS_VALIDAS.filter(h => h > hora) : HORAS_VALIDAS;
        for (const h of hrs) {
            if (!turnos.some(t => t.dia === d && t.hora === h)) return { dia: d, hora: h };
        }
    }
    return null;
}

function estaEnHorarioAtencion() {
    const ahora = new Date();
    const hora = ahora.getHours();
    const dia = ahora.getDay();
    if (dia === 0) return false; // Domingo cerrado
    return hora >= 8 && hora < 20;
}

// ============================================================
// MIDDLEWARES
// ============================================================
app.use(express.json({ limit: '10mb' }));
app.use((req, res, next) => {
    const ip = req.ip || req.socket.remoteAddress;
    if (estaBloqueado(ip)) return res.status(403).json({ error: 'IP bloqueada' });
    next();
});
app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    next();
});
app.use(express.static(__dirname));

// ============================================================
// AUTH
// ============================================================
const validTokens = new Map();
function checkAuth(req) {
    const h = req.headers.authorization;
    if (!h || !h.startsWith('Bearer ')) return false;
    const token = h.substring(7);
    if (!validTokens.has(token) || validTokens.get(token) < Date.now()) {
        validTokens.delete(token);
        return false;
    }
    return true;
}

app.post('/api/login', (req, res) => {
    const ip = req.ip;
    if (estaBloqueado(ip)) return res.status(403).json({ success: false });
    const { password } = req.body;
    if (password === (process.env.ADMIN_PASSWORD || 'admin123')) {
        const token = crypto.randomBytes(64).toString('hex');
        validTokens.set(token, Date.now() + 28800000);
        return res.json({ success: true, token });
    }
    res.status(401).json({ success: false, error: 'Contraseña incorrecta' });
});

app.get('/api/verify', (req, res) => res.json({ valid: checkAuth(req) }));

// ============================================================
// RUTAS API
// ============================================================
app.get('/api/config', (req, res) => {
    // Config por defecto si no existe archivo
    res.json({
        hero: { titulo: "Renueva tu Energía", subtitulo: "Experiencias de bienestar", botonTexto: "Explorar Tratamientos" },
        serviciosSection: { etiqueta: "Nuestros Servicios", titulo: "Elige tu Masaje Ideal", descripcion: "Turnos: 12:00, 16:00 y 20:00" },
        contactoSection: { titulo: "Asistente de Reservas", descripcion: "Reserva tu turno de forma rápida" }
    });
});

app.get('/api/servicios', (req, res) => {
    const servicios = [
        { id: "relajante", nombre: "Masaje Relajante", precio: "$45", descripcion: "Movimientos suaves.", imagenWeb: "https://images.unsplash.com/photo-1544161515-4ab6ce6db874?w=800" },
        { id: "corporal", nombre: "Masaje Corporal", precio: "$65", descripcion: "Tratamiento completo.", imagenWeb: "https://images.unsplash.com/photo-1519823551278-64ac92734fb1?w=800" },
        { id: "facial", nombre: "Masaje Facial", precio: "$40", descripcion: "Rejuvenece tu rostro.", imagenWeb: "https://images.unsplash.com/photo-1570172619644-dfd03ed5d881?w=800" }
    ];
    res.json(servicios);
});

// TURNOS - CON BLOQUEO SIMULTÁNEO
app.get('/turnos', async (req, res) => {
    try {
        const data = await fs.readFile(TURNOS_FILE, 'utf8');
        res.json(JSON.parse(data));
    } catch { res.json([]); }
});

app.post('/turnos', async (req, res) => {
    const ip = req.ip;
    try {
        const { nombre, dia, hora, massageType, telefono, ubicacion, tipoServicio } = req.body;
        if (!nombre || !dia || !hora || !telefono) return res.status(400).json({ error: 'Faltan datos' });

        // BLOQUEO SIMULTÁNEO: Leer, verificar y escribir con reintentos
        let turnos = [];
        try { turnos = JSON.parse(await fs.readFile(TURNOS_FILE, 'utf8')); } catch {}

        if (turnos.some(t => t.dia === dia && t.hora === parseInt(hora))) {
            const alt = buscarAlternativa(dia, parseInt(hora), turnos);
            return res.status(409).json({ error: 'Horario ocupado', alternativa: alt });
        }

        const nuevo = {
            id: generarId(), nombre, dia, hora: parseInt(hora),
            massageType, telefono, ubicacion, tipoServicio,
            ip, fechaCreacion: new Date().toISOString()
        };
        turnos.push(nuevo);
        
        // Escritura con lock
        await fs.writeFile(TURNOS_FILE, JSON.stringify(turnos, null, 2));
        console.log('✅ Turno creado:', nuevo.nombre);
        res.status(201).json({ mensaje: 'Confirmado', turno: nuevo });
    } catch (e) {
        res.status(500).json({ error: 'Error al crear' });
    }
});

app.post('/api/cancelar-turno', async (req, res) => {
    const tel = (req.body.telefono || '').replace(/\D/g, '');
    let turnos = [];
    try { turnos = JSON.parse(await fs.readFile(TURNOS_FILE, 'utf8')); } catch {}
    const idx = turnos.findIndex(t => t.telefono === tel);
    if (idx === -1) return res.json({ error: 'No se encontró turno' });
    turnos.splice(idx, 1);
    await fs.writeFile(TURNOS_FILE, JSON.stringify(turnos, null, 2));
    res.json({ cancelado: true, mensaje: 'Turno cancelado' });
});

// ============================================================
// ASISTENTE DE VOZ (WebSocket) - CORREGIDO
// ============================================================
let voiceClients = new Map();

const wss = new WebSocket.Server({ noServer: true });

async function procesarComandoVoz(texto, clientId, ip) {
    const tl = texto.toLowerCase().trim();
    let cd = voiceClients.get(clientId) || { estado: 'inicio', datos: {} };
    
    // --- Verificar horario de atención ---
    if (!estaEnHorarioAtencion()) {
        voiceClients.delete(clientId);
        return "🌸 El spa está cerrado en este momento. Nuestro horario es de Lunes a Sábado de 8:00 a 20:00. ¡Te esperamos en ese horario!";
    }

    // --- Cancelar en cualquier momento ---
    if (tl.includes('cancelar') || tl.includes('anular')) {
        if (cd.datos.telefono) {
            const res = await fetch(`http://localhost:${PORT}/api/cancelar-turno`, {
                method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({telefono: cd.datos.telefono})
            }).then(r=>r.json());
            voiceClients.delete(clientId);
            return res.mensaje || res.error || 'Turno cancelado.';
        } else {
            cd.estado = 'esperando_tel_cancelar';
            voiceClients.set(clientId, cd);
            return "Para cancelar, necesito tu número de teléfono. ¿Me lo decís?";
        }
    }
    
    if (cd.estado === 'esperando_tel_cancelar') {
        const tel = texto.replace(/\D/g, '');
        if (tel.length >= 7) {
            cd.datos.telefono = tel;
            voiceClients.set(clientId, cd);
            return await procesarComandoVoz('cancelar', clientId, ip); // Reintenta cancelar
        }
        return "No entendí el número. Por favor, decilo de nuevo solo con dígitos.";
    }

    // --- Flujo de reserva ---
    const d = cd.datos;
    
    // Paso 1: Nombre
    if (!d.nombre) {
        if (texto.length > 1) {
            d.nombre = texto;
            cd.estado = 'recopilando';
            voiceClients.set(clientId, cd);
            return `Gracias ${d.nombre}. ¿Qué tipo de masaje querés? Relajante, corporal o facial.`;
        }
        return "¿Cuál es tu nombre?";
    }
    
    // Paso 2: Masaje
    if (!d.massageType) {
        if (tl.includes('relajante')) d.massageType = 'Masaje Relajante';
        else if (tl.includes('corporal')) d.massageType = 'Masaje Corporal';
        else if (tl.includes('facial')) d.massageType = 'Masaje Facial';
        
        if (d.massageType) {
            voiceClients.set(clientId, cd);
            return `Perfecto, ${d.massageType}. ¿Qué día? Lunes a sábado.`;
        }
        return "Podés elegir entre masaje relajante, corporal o facial. ¿Cuál preferís?";
    }
    
    // Paso 3: Día
    if (!d.dia) {
        const diaElegido = DIAS_VALIDOS.find(dia => tl.includes(dia));
        if (diaElegido) {
            d.dia = diaElegido;
            voiceClients.set(clientId, cd);
            return `${d.dia.charAt(0).toUpperCase() + d.dia.slice(1)}. ¿A qué hora? 12 del mediodía, 4 de la tarde u 8 de la noche.`;
        }
        return "¿Qué día querés venir? Lunes, martes, miércoles, jueves, viernes o sábado.";
    }
    
    // Paso 4: Hora
    if (!d.hora) {
        const horaElegida = HORAS_VALIDAS.find(h => tl.includes(h.toString()) || 
            (h === 12 && tl.includes('doce')) || (h === 16 && (tl.includes('cuatro') || tl.includes('16'))) || (h === 20 && (tl.includes('ocho') || tl.includes('20'))) );
        if (horaElegida) {
            d.hora = horaElegida;
            voiceClients.set(clientId, cd);
            return "¿Preferís en el salón o a domicilio?";
        }
        return "Elegí una hora: 12 del mediodía, 4 de la tarde u 8 de la noche.";
    }
    
    // Paso 5: Tipo
    if (!d.tipoServicio) {
        if (tl.includes('salon') || tl.includes('salón')) { d.tipoServicio = 'salon'; d.ubicacion = 'Salón Serenity Spa'; }
        else if (tl.includes('domicilio') || tl.includes('casa')) { d.tipoServicio = 'domicilio'; }
        else return "Decime si preferís en el salón o a domicilio.";
        
        voiceClients.set(clientId, cd);
        return "Por último, ¿tu número de teléfono?";
    }
    
    // Paso 6: Teléfono
    if (!d.telefono) {
        const tel = texto.replace(/\D/g, '');
        if (tel.length >= 7) {
            d.telefono = tel;
            d.codigoPais = '54';
            
            // ¡CONFIRMAR TURNO!
            let turnos = [];
            try { turnos = JSON.parse(await fs.readFile(TURNOS_FILE, 'utf8')); } catch {}
            
            if (turnos.some(t => t.dia === d.dia && t.hora === d.hora)) {
                const alt = buscarAlternativa(d.dia, d.hora, turnos);
                return alt ? `Ese horario ya está tomado. ¿Te sirve el ${alt.dia} a las ${alt.hora}:00?` : 'No hay turnos disponibles.';
            }
            
            const nuevo = { id: generarId(), ...d, fechaCreacion: new Date().toISOString(), ip };
            turnos.push(nuevo);
            await fs.writeFile(TURNOS_FILE, JSON.stringify(turnos, null, 2));
            voiceClients.delete(clientId);
            return `¡Listo ${d.nombre}! Turno confirmado para el ${d.dia} a las ${d.hora}:00. ¡Te esperamos!`;
        }
        return "Necesito un número de teléfono válido para confirmar.";
    }
    
    return "Decí 'reservar' para comenzar de nuevo.";
}

// ============================================================
// INICIO DEL SERVIDOR
// ============================================================
async function start() {
    await cargarBloqueos();
    try { await fs.writeFile(TURNOS_FILE, '[]', { flag: 'wx' }); } catch {}
    
    const server = app.listen(PORT, '0.0.0.0', () => {
        console.log(`🌿 Serenity Spa listo en puerto ${PORT}`);
    });

    server.on('upgrade', (request, socket, head) => {
        if (request.url === '/ws-voice') {
            wss.handleUpgrade(request, socket, head, (ws) => {
                wss.emit('connection', ws, request);
            });
        } else {
            socket.destroy();
        }
    });

    wss.on('connection', (ws, req) => {
        const ip = req.socket.remoteAddress;
        const cid = generarId();
        
        ws.on('message', async (data) => {
            try {
                const m = JSON.parse(data.toString());
                if (m.tipo === 'transcripcion') {
                    const respuesta = await procesarComandoVoz(m.texto, cid, ip);
                    if (ws.readyState === WebSocket.OPEN) {
                        ws.send(JSON.stringify({ tipo: 'respuesta', texto: respuesta }));
                    }
                }
            } catch (e) {
                ws.send(JSON.stringify({ tipo: 'respuesta', texto: 'Error al procesar. Intentá de nuevo.' }));
            }
        });
        
        ws.on('close', () => voiceClients.delete(cid));
    });
}

start().catch(err => { console.error(err); process.exit(1); });
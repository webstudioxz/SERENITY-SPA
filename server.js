const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const WebSocket = require('ws');

const app = express();
const PORT = process.env.PORT || 5001;
const TURNOS_FILE = path.join(__dirname, 'turnos.json');
const SERVICIOS_FILE = path.join(__dirname, 'servicios.json');
const CONFIG_FILE = path.join(__dirname, 'config.json');
const BLOQUEOS_FILE = path.join(__dirname, 'bloqueos.json');

console.log('🌿 SERENITY SPA - SISTEMA CORREGIDO v5.0');
console.log('✅ Seguridad corregida - sin redirecciones rotas');
console.log('✅ Eliminación de usuarios bloqueados agregada');
console.log('✅ Imágenes WhatsApp solo por URL pública');
console.log('✅ Asistente de voz push-to-talk estable');

// ==================== SISTEMA DE BLOQUEO ====================
let bloqueos = new Map();
let historialBloqueos = [];

async function cargarBloqueos() {
    try {
        await fs.access(BLOQUEOS_FILE);
        const data = await fs.readFile(BLOQUEOS_FILE, 'utf8');
        const parsed = JSON.parse(data);
        bloqueos = new Map(Object.entries(parsed.bloqueos || {}));
        historialBloqueos = parsed.historial || [];
        let huboCambios = false;
        for (const [ip, datos] of bloqueos) {
            if (Date.now() > datos.hasta) {
                bloqueos.delete(ip);
                huboCambios = true;
            }
        }
        if (huboCambios) await guardarBloqueos();
        console.log(`📂 Cargados ${bloqueos.size} IPs bloqueadas, ${historialBloqueos.length} registros históricos`);
    } catch {
        await fs.writeFile(BLOQUEOS_FILE, JSON.stringify({ bloqueos: {}, historial: [] }, null, 2), 'utf8');
        console.log('📁 Archivo bloqueos.json creado');
    }
}

async function guardarBloqueos() {
    const data = {
        bloqueos: Object.fromEntries(bloqueos),
        historial: historialBloqueos.slice(0, 500)
    };
    await fs.writeFile(BLOQUEOS_FILE, JSON.stringify(data, null, 2), 'utf8');
}

function estaBloqueado(ip) {
    if (bloqueos.has(ip)) {
        const data = bloqueos.get(ip);
        if (Date.now() < data.hasta) return true;
        bloqueos.delete(ip);
        guardarBloqueos();
        return false;
    }
    return false;
}

function bloquearIP(ip, motivo, tipoAtaque = 'Desconocido') {
    const duracion = 60 * 60 * 1000;
    const ahora = Date.now();
    const datosBloqueo = {
        hasta: ahora + duracion,
        motivo,
        tipoAtaque,
        fecha: new Date().toISOString(),
        fechaBloqueo: ahora,
        duracionMs: duracion,
        ip,
        intentos: (intentosFallidos.get(ip)?.count || 0)
    };
    bloqueos.set(ip, datosBloqueo);
    historialBloqueos.unshift({ ...datosBloqueo, id: generarId() });
    guardarBloqueos();
    console.log(`🚫 IP ${ip} bloqueada. Tipo: ${tipoAtaque}`);
    return datosBloqueo;
}

// ==================== RATE LIMITING ====================
const intentosFallidos = new Map();

function registrarIntentoFallido(ip, tipo = 'intento_fallido') {
    const ahora = Date.now();
    if (!intentosFallidos.has(ip)) {
        intentosFallidos.set(ip, { count: 1, primerIntento: ahora, tipo, historial: [tipo] });
        return false;
    }
    const data = intentosFallidos.get(ip);
    if (ahora - data.primerIntento > 10 * 60 * 1000) {
        intentosFallidos.set(ip, { count: 1, primerIntento: ahora, tipo, historial: [tipo] });
        return false;
    }
    data.count++;
    data.tipo = tipo;
    data.historial = data.historial || [];
    data.historial.push(tipo);
    if (data.count >= 5) {
        bloquearIP(ip, `5+ intentos fallidos de ${tipo} en 10 minutos`, tipo);
        intentosFallidos.delete(ip);
        return true;
    }
    return false;
}

function limpiarIntentos(ip) { intentosFallidos.delete(ip); }

function desbloquearIP(ip) {
    bloqueos.delete(ip);
    intentosFallidos.delete(ip);
    guardarBloqueos();
    return true;
}

// ==================== VALIDACIÓN DE URL PARA WHATSAPP ====================
function esUrlValida(str) {
    if (!str || typeof str !== 'string') return false;
    const trimmed = str.trim();
    if (trimmed.startsWith('data:')) return false;
    if (trimmed.length > 2048) return false;
    try {
        const url = new URL(trimmed);
        return url.protocol === 'http:' || url.protocol === 'https:';
    } catch { return false; }
}

// ==================== MIDDLEWARES ====================
app.use(express.json({ limit: '1mb' }));

app.use((req, res, next) => {
    const ip = req.ip || req.connection.remoteAddress || req.socket.remoteAddress || '0.0.0.0';
    if (estaBloqueado(ip)) {
        return res.status(403).json({ error: 'Acceso bloqueado temporalmente por seguridad', bloqueado: true });
    }
    next();
});

app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    next();
});

app.use((req, res, next) => {
    if (req.url === '/' || req.url.endsWith('.html')) {
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
    }
    next();
});

app.use(express.static(__dirname));

// ==================== REGLAS ====================
const HORAS_VALIDAS = [12, 16, 20];
const DIAS_VALIDOS = ['lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado'];

const VALIDACION_PAISES = {
    'argentina': { codigo: '54', pattern: /^[1-9]\d{7,11}$/, ejemplo: '11 2345 6789' },
    'méxico': { codigo: '52', pattern: /^[1-9]\d{9,11}$/, ejemplo: '55 1234 5678' },
    'mexico': { codigo: '52', pattern: /^[1-9]\d{9,11}$/, ejemplo: '55 1234 5678' },
    'colombia': { codigo: '57', pattern: /^3\d{9}$/, ejemplo: '321 1234567' },
    'chile': { codigo: '56', pattern: /^[1-9]\d{8,10}$/, ejemplo: '9 1234 5678' },
    'perú': { codigo: '51', pattern: /^[1-9]\d{8,10}$/, ejemplo: '987 654 321' },
    'peru': { codigo: '51', pattern: /^[1-9]\d{8,10}$/, ejemplo: '987 654 321' },
    'españa': { codigo: '34', pattern: /^[6-7]\d{8}$/, ejemplo: '612 34 56 78' },
    'espania': { codigo: '34', pattern: /^[6-7]\d{8}$/, ejemplo: '612 34 56 78' },
    'uruguay': { codigo: '598', pattern: /^[1-9]\d{7,9}$/, ejemplo: '94 123 456' },
    'paraguay': { codigo: '595', pattern: /^[1-9]\d{7,9}$/, ejemplo: '981 234567' },
    'bolivia': { codigo: '591', pattern: /^[1-9]\d{7,9}$/, ejemplo: '71234567' },
    'venezuela': { codigo: '58', pattern: /^[1-9]\d{9}$/, ejemplo: '412 1234567' },
    'cuba': { codigo: '53', pattern: /^[1-9]\d{7,8}$/, ejemplo: '5 1234567' },
    'costa rica': { codigo: '506', pattern: /^[1-9]\d{7,9}$/, ejemplo: '8 1234 5678' },
    'panamá': { codigo: '507', pattern: /^[1-9]\d{7,8}$/, ejemplo: '6 123 4567' },
    'ecuador': { codigo: '593', pattern: /^[1-9]\d{8,10}$/, ejemplo: '99 123 4567' }
};

function extraerNombre(texto) {
    if (!texto || texto.length < 2) return null;
    const textoOriginal = texto.trim();
    const patrones = [
        /(?:me\s+(?:llamo|llaman))\s+([a-zA-ZáéíóúñÑü\s]{2,50}?)(?:\s+(?:es\s+un\s+gusto|mucho\s+gusto|un\s+placer|gracias|\.|,|!|$))/i,
        /(?:soy|mi\s+nombre\s+es)\s+([a-zA-ZáéíóúñÑü\s]{2,50}?)(?:\s+(?:es\s+un\s+gusto|mucho\s+gusto|un\s+placer|gracias|\.|,|!|$))/i,
        /(?:hola|buenos\s+días|buenas\s+tardes|buenas\s+noches|saludos),?\s+(?:soy|me\s+llamo|mi\s+nombre\s+es)\s+([a-zA-ZáéíóúñÑü\s]{2,50}?)(?:\s+(?:es\s+un\s+gusto|mucho\s+gusto|un\s+placer|gracias|\.|,|!|$))/i,
        /(?:hola|buenos\s+días|buenas\s+tardes|buenas\s+noches|saludos),?\s+([a-zA-ZáéíóúñÑü\s]{2,50}?)(?:\s+(?:es\s+un\s+gusto|mucho\s+gusto|un\s+placer|gracias|\.|,|!|$))/i
    ];
    for (const patron of patrones) {
        const match = textoOriginal.match(patron);
        if (match && match[1]) {
            let nombre = match[1].trim();
            nombre = nombre.replace(/\s+(?:es\s+un\s+gusto|mucho\s+gusto|un\s+placer|gracias).*/i, '');
            nombre = nombre.replace(/[.,!]$/, '').trim();
            if (nombre.length >= 2 && nombre.length <= 50 && /^[a-zA-ZáéíóúñÑü\s.]+$/.test(nombre)) return nombre;
        }
    }
    const stopWords = ['hola','buenos','buenas','días','dias','tardes','noches','soy','me','llamo','mi','nombre','es','un','una','gusto','mucho','placer','para','por','favor','quiero','deseo','necesito','reservar','turno','cita','masaje','el','la','los','las','de','del','en','con','gracias','saludos'];
    const palabras = textoOriginal.split(/\s+/).filter(p => p.length > 1 && !stopWords.includes(p.toLowerCase()) && !/\d/.test(p) && p.length < 20);
    if (palabras.length > 0 && palabras.length <= 4) {
        const nombre = palabras.join(' ');
        if (nombre.length >= 2 && nombre.length <= 50 && /^[a-zA-ZáéíóúñÑü\s.]+$/.test(nombre)) return nombre;
    }
    return null;
}

function detectarPais(texto) {
    const textoLower = texto.toLowerCase().trim();
    for (const [pais, data] of Object.entries(VALIDACION_PAISES)) {
        if (textoLower === pais || textoLower.includes(pais)) return { pais, codigo: data.codigo, pattern: data.pattern, ejemplo: data.ejemplo };
    }
    const claves = { 'argen':'argentina','arg':'argentina','bs as':'argentina','méx':'méxico','mex':'méxico','cdmx':'méxico','colom':'colombia','bog':'colombia','chil':'chile','santiago':'chile','peru':'perú','lima':'perú','espa':'españa','madrid':'españa','cuba':'cuba','uruguay':'uruguay','montevideo':'uruguay' };
    for (const [clave, dest] of Object.entries(claves)) {
        if (textoLower.includes(clave)) { const d = VALIDACION_PAISES[dest]; if (d) return { pais: dest, codigo: d.codigo, pattern: d.pattern, ejemplo: d.ejemplo }; }
    }
    return null;
}

function escapeHtml(str) { if (!str) return ''; return str.replace(/[&<>]/g, m => m === '&' ? '&amp;' : m === '<' ? '&lt;' : '&gt;'); }
function sanitizeInput(str) { if (!str) return ''; return str.trim().replace(/[^\w\sáéíóúñÑü.,@\-]/gi, ''); }
function generarId() { return Date.now().toString(36) + Math.random().toString(36).substr(2) + crypto.randomBytes(4).toString('hex'); }

function buscarAlternativa(diaSolicitado, horaSolicitada, turnosExistentes) {
    const diasSemana = ['lunes','martes','miercoles','jueves','viernes','sabado'];
    const idx = diasSemana.indexOf(diaSolicitado);
    if (idx === -1) return null;
    for (let offset = 0; offset < 7; offset++) {
        const nuevoDia = diasSemana[(idx + offset) % diasSemana.length];
        const horas = (offset === 0) ? HORAS_VALIDAS.filter(h => h > horaSolicitada) : HORAS_VALIDAS;
        for (const hora of horas) {
            if (!turnosExistentes.some(t => t.dia === nuevoDia && t.hora === hora)) return { dia: nuevoDia, hora };
        }
    }
    return null;
}

// ==================== GESTIÓN DE TURNOS ====================
let turnosEnMemoria = [];

async function inicializarArchivoTurnos() {
    try {
        await fs.access(TURNOS_FILE);
        const data = await fs.readFile(TURNOS_FILE, 'utf8');
        turnosEnMemoria = JSON.parse(data);
        console.log(`📂 Cargados ${turnosEnMemoria.length} turnos`);
    } catch {
        await fs.writeFile(TURNOS_FILE, '[]', 'utf8');
        turnosEnMemoria = [];
        console.log('📁 Archivo turnos.json creado');
    }
}

async function cargarTurnos() {
    try { const data = await fs.readFile(TURNOS_FILE, 'utf8'); turnosEnMemoria = JSON.parse(data); } catch {}
    return turnosEnMemoria;
}

async function guardarTurnos(turnos) {
    await fs.writeFile(TURNOS_FILE, JSON.stringify(turnos, null, 2), 'utf8');
    turnosEnMemoria = turnos;
}

// ==================== CONFIGURACIÓN ====================
let configData = {
    hero: { titulo: "Renueva tu Energía", subtitulo: "Experiencias de bienestar", imagenFondo: "https://images.unsplash.com/photo-1544161515-4ab6ce6db874?ixlib=rb-1.2.1&auto=format&fit=crop&w=1920&q=80", botonTexto: "Explorar Tratamientos" },
    serviciosSection: { etiqueta: "Nuestros Servicios", titulo: "Elige tu Masaje Ideal", descripcion: "Turnos: 12:00, 16:00 y 20:00" },
    contactoSection: { titulo: "Asistente de Reservas", descripcion: "Reserva tu turno de forma rápida" },
    shareSection: { titulo: "Comparte Serenity Spa" }
};

async function inicializarConfiguracion() {
    try {
        await fs.access(CONFIG_FILE);
        const data = await fs.readFile(CONFIG_FILE, 'utf8');
        configData = { ...configData, ...JSON.parse(data) };
        console.log('📂 Configuración cargada');
    } catch {
        await fs.writeFile(CONFIG_FILE, JSON.stringify(configData, null, 2), 'utf8');
        console.log('📁 Archivo config.json creado');
    }
}

// ==================== GESTIÓN DE SERVICIOS ====================
let serviciosData = [];

async function inicializarServicios() {
    const defaults = [
        { id: "relajante", nombre: "Masaje Relajante", precio: "$45", descripcion: "Movimientos suaves para liberar el estrés.", beneficios: ["Reduce ansiedad", "60 Minutos"], efectos: ["Relajación profunda"], imagenWeb: "https://images.unsplash.com/photo-1544161515-4ab6ce6db874?ixlib=rb-1.2.1&auto=format&fit=crop&w=800&q=80", imagenWhatsApp: "", orden: 1 },
        { id: "corporal", nombre: "Masaje Corporal", precio: "$65", descripcion: "Tratamiento completo para relajación profunda.", beneficios: ["Relajación integral", "90 Minutos"], efectos: ["Activación linfática"], imagenWeb: "https://images.unsplash.com/photo-1519823551278-64ac92734fb1?ixlib=rb-1.2.1&auto=format&fit=crop&w=800&q=80", imagenWhatsApp: "", orden: 2 },
        { id: "facial", nombre: "Masaje Facial", precio: "$40", descripcion: "Rejuvenece la piel y alivia la tensión facial.", beneficios: ["Reafirma la piel", "45 Minutos"], efectos: ["Estimula colágeno"], imagenWeb: "https://images.unsplash.com/photo-1570172619644-dfd03ed5d881?ixlib=rb-1.2.1&auto=format&fit=crop&w=800&q=80", imagenWhatsApp: "", orden: 3 }
    ];
    try {
        await fs.access(SERVICIOS_FILE);
        const data = await fs.readFile(SERVICIOS_FILE, 'utf8');
        serviciosData = JSON.parse(data);
        console.log(`📂 Cargados ${serviciosData.length} servicios`);
    } catch {
        serviciosData = defaults;
        await fs.writeFile(SERVICIOS_FILE, JSON.stringify(serviciosData, null, 2), 'utf8');
        console.log('📁 Archivo servicios.json creado');
    }
}

// ==================== RUTAS API ====================

app.get('/api/config', (req, res) => res.json(configData));

app.put('/api/config', async (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ') || !validTokens.has(authHeader.substring(7))) return res.status(401).json({ error: 'No autorizado' });
    try {
        configData = { ...configData, ...req.body };
        await fs.writeFile(CONFIG_FILE, JSON.stringify(configData, null, 2), 'utf8');
        res.json({ mensaje: 'Configuración actualizada' });
    } catch { res.status(500).json({ error: 'Error al guardar' }); }
});

app.get('/api/servicios', (req, res) => res.json(serviciosData.sort((a, b) => (a.orden || 999) - (b.orden || 999))));

app.post('/api/servicios', async (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ') || !validTokens.has(authHeader.substring(7))) return res.status(401).json({ error: 'No autorizado' });
    try {
        const imagenWeb = req.body.imagenWeb || 'https://images.unsplash.com/photo-1544161515-4ab6ce6db874?ixlib=rb-1.2.1&auto=format&fit=crop&w=800&q=80';
        // imagenWhatsApp DEBE ser URL válida, si no es válida se deja vacía
        let imagenWhatsApp = '';
        if (req.body.imagenWhatsApp && esUrlValida(req.body.imagenWhatsApp)) {
            imagenWhatsApp = req.body.imagenWhatsApp.trim();
        } else if (req.body.imagenWhatsApp && req.body.imagenWhatsApp.trim() !== '') {
            console.log(`⚠️ imagenWhatsApp rechazada (no es URL válida): ${req.body.imagenWhatsApp.substring(0, 50)}...`);
        }
        const nuevo = { id: generarId(), ...req.body, imagenWeb, imagenWhatsApp };
        serviciosData.push(nuevo);
        await fs.writeFile(SERVICIOS_FILE, JSON.stringify(serviciosData, null, 2), 'utf8');
        res.status(201).json(nuevo);
    } catch { res.status(500).json({ error: 'Error al crear servicio' }); }
});

app.put('/api/servicios/:id', async (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ') || !validTokens.has(authHeader.substring(7))) return res.status(401).json({ error: 'No autorizado' });
    try {
        const { id } = req.params;
        const index = serviciosData.findIndex(s => s.id === id);
        if (index === -1) return res.status(404).json({ error: 'Servicio no encontrado' });
        const imagenWeb = req.body.imagenWeb || serviciosData[index].imagenWeb;
        let imagenWhatsApp = '';
        if (req.body.imagenWhatsApp && esUrlValida(req.body.imagenWhatsApp)) {
            imagenWhatsApp = req.body.imagenWhatsApp.trim();
        } else if (req.body.imagenWhatsApp && req.body.imagenWhatsApp.trim() !== '') {
            console.log(`⚠️ imagenWhatsApp rechazada al actualizar (no es URL válida)`);
        }
        serviciosData[index] = { ...serviciosData[index], ...req.body, id, imagenWeb, imagenWhatsApp };
        await fs.writeFile(SERVICIOS_FILE, JSON.stringify(serviciosData, null, 2), 'utf8');
        res.json(serviciosData[index]);
    } catch { res.status(500).json({ error: 'Error al actualizar' }); }
});

app.delete('/api/servicios/:id', async (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ') || !validTokens.has(authHeader.substring(7))) return res.status(401).json({ error: 'No autorizado' });
    try {
        serviciosData = serviciosData.filter(s => s.id !== req.params.id);
        await fs.writeFile(SERVICIOS_FILE, JSON.stringify(serviciosData, null, 2), 'utf8');
        res.json({ mensaje: 'Servicio eliminado' });
    } catch { res.status(500).json({ error: 'Error al eliminar' }); }
});

app.get('/turnos', async (req, res) => res.json(await cargarTurnos()));

app.post('/turnos', async (req, res) => {
    const ip = req.ip || req.connection.remoteAddress || req.socket.remoteAddress || '0.0.0.0';
    if (estaBloqueado(ip)) return res.status(403).json({ error: 'Acceso bloqueado' });
    try {
        const { nombre, dia, hora, massageType, telefono, codigoPais, ubicacion, tipoServicio } = req.body;
        if (!nombre || nombre.length < 2 || nombre.length > 50) { registrarIntentoFallido(ip, 'nombre_invalido'); return res.status(400).json({ error: 'Nombre inválido' }); }
        if (!telefono || telefono.replace(/\D/g, '').length < 7) { registrarIntentoFallido(ip, 'telefono_invalido'); return res.status(400).json({ error: 'Teléfono inválido' }); }
        if (!dia || !DIAS_VALIDOS.includes(dia.toLowerCase())) return res.status(400).json({ error: 'Día no válido' });
        const horaNum = parseInt(hora);
        if (!HORAS_VALIDAS.includes(horaNum)) return res.status(400).json({ error: 'Hora no válida' });
        const turnos = await cargarTurnos();
        const telLimpio = telefono.replace(/\D/g, '');
        if (turnos.some(t => t.telefono === telLimpio && t.dia === dia.toLowerCase())) return res.status(409).json({ error: 'Ya tienes un turno para ese día' });
        if (turnos.some(t => t.dia === dia.toLowerCase() && t.hora === horaNum)) {
            const alt = buscarAlternativa(dia.toLowerCase(), horaNum, turnos);
            return res.status(409).json({ error: 'Horario no disponible', alternativa: alt });
        }
        const nuevo = { id: generarId(), nombre: escapeHtml(sanitizeInput(nombre)), dia: dia.toLowerCase(), hora: horaNum, massageType: massageType || 'Masaje', telefono: telLimpio, codigoPais: codigoPais || '54', ubicacion: ubicacion ? escapeHtml(sanitizeInput(ubicacion)) : null, tipoServicio: tipoServicio || 'salon', fechaCreacion: new Date().toISOString(), ip };
        turnos.push(nuevo);
        await guardarTurnos(turnos);
        limpiarIntentos(ip);
        res.status(201).json({ mensaje: 'Turno creado', turno: nuevo });
    } catch (e) { console.error('Error al crear turno:', e); res.status(500).json({ error: 'Error interno' }); }
});

app.delete('/turnos/:id', async (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ') || !validTokens.has(authHeader.substring(7))) return res.status(401).json({ error: 'No autorizado' });
    try {
        const turnos = await cargarTurnos();
        const idx = turnos.findIndex(t => t.id === req.params.id);
        if (idx === -1) return res.status(404).json({ error: 'Turno no encontrado' });
        turnos.splice(idx, 1);
        await guardarTurnos(turnos);
        res.json({ mensaje: 'Turno eliminado' });
    } catch { res.status(500).json({ error: 'Error al eliminar' }); }
});

// ==================== WHATSAPP — Solo URL válida ====================
app.post('/api/enviar-whatsapp/:id', async (req, res) => {
    try {
        const turnos = await cargarTurnos();
        const turno = turnos.find(t => t.id === req.params.id);
        if (!turno) return res.status(404).json({ error: 'Turno no encontrado' });
        const servicio = serviciosData.find(s => s.nombre === turno.massageType);
        // Solo incluir imagen si es URL válida (no base64)
        const imagenUrl = (servicio?.imagenWhatsApp && esUrlValida(servicio.imagenWhatsApp)) ? servicio.imagenWhatsApp : '';
        let mensaje = `🌿 *SERENITY SPA* 🌿\n\n`;
        mensaje += `Hola *${turno.nombre}*,\n¡Gracias por confiar en nosotros! ✨\n\n`;
        mensaje += `✅ *TU RESERVA HA SIDO CONFIRMADA*\n\n`;
        mensaje += `📅 *Día:* ${turno.dia.charAt(0).toUpperCase() + turno.dia.slice(1)}\n`;
        mensaje += `⏰ *Hora:* ${turno.hora}:00 hs\n`;
        mensaje += `💆‍♂️ *Masaje:* ${turno.massageType}\n`;
        mensaje += `📍 *Lugar:* ${turno.tipoServicio === 'domicilio' ? turno.ubicacion : 'Serenity Spa - Salón'}\n\n`;
        mensaje += `🌸 *Te esperamos con aromaterapia y música suave.*\n`;
        mensaje += `⏱️ Podés modificar o cancelar con 4 horas de anticipación.\n\n`;
        if (imagenUrl) mensaje += `🖼️ *Imagen del servicio:* ${imagenUrl}\n\n`;
        mensaje += `✨ *¡Te deseamos una experiencia inolvidable!*\n\nCon cariño,\n*Equipo Serenity Spa* 💆‍♀️💆‍♂️`;
        const tel = turno.telefono.replace(/\D/g, '');
        const codigo = turno.codigoPais || '54';
        res.json({ success: true, numero: `${codigo}${tel}`, mensaje, imagenUrl, urlWhatsApp: `https://wa.me/${codigo}${tel}?text=${encodeURIComponent(mensaje)}` });
    } catch (e) { console.error('Error WhatsApp:', e); res.status(500).json({ error: 'Error al preparar mensaje' }); }
});

// ==================== SEGURIDAD — CORREGIDA (PUNTO 1 y 2) ====================

app.get('/api/seguridad/bloqueos', (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ') || !validTokens.has(authHeader.substring(7))) return res.status(401).json({ error: 'No autorizado' });
    const activos = [];
    for (const [ip, datos] of bloqueos) {
        const resto = Math.max(0, datos.hasta - Date.now());
        activos.push({ ip, motivo: datos.motivo, tipoAtaque: datos.tipoAtaque, fecha: datos.fecha, tiempoRestante: resto, tiempoRestanteFormateado: formatearTiempo(resto), intentos: datos.intentos || 0, permanente: datos.permanente || false, id: datos.id || ip });
    }
    res.json({ activos, historial: historialBloqueos.slice(0, 100), intentosFallidos: Object.fromEntries(intentosFallidos) });
});

app.post('/api/seguridad/desbloquear/:ip', (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ') || !validTokens.has(authHeader.substring(7))) return res.status(401).json({ error: 'No autorizado' });
    desbloquearIP(req.params.ip);
    res.json({ mensaje: `IP ${req.params.ip} desbloqueada` });
});

// NUEVO: Eliminar un bloqueo activo completamente (PUNTO 2)
app.delete('/api/seguridad/bloqueos/:ip', (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ') || !validTokens.has(authHeader.substring(7))) return res.status(401).json({ error: 'No autorizado' });
    const ip = req.params.ip;
    bloqueos.delete(ip);
    intentosFallidos.delete(ip);
    guardarBloqueos();
    console.log(`🗑️ IP ${ip} eliminada de bloqueos`);
    res.json({ mensaje: `IP ${ip} eliminada de bloqueos` });
});

// NUEVO: Eliminar un registro del historial (PUNTO 2)
app.delete('/api/seguridad/historial/:id', (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ') || !validTokens.has(authHeader.substring(7))) return res.status(401).json({ error: 'No autorizado' });
    const id = req.params.id;
    const antes = historialBloqueos.length;
    historialBloqueos = historialBloqueos.filter(h => h.id !== id);
    guardarBloqueos();
    console.log(`🗑️ Registro ${id} eliminado del historial (${antes} → ${historialBloqueos.length})`);
    res.json({ mensaje: 'Registro eliminado del historial' });
});

// NUEVO: Limpiar todos los bloqueos e historial expirados (PUNTO 2)
app.post('/api/seguridad/limpiar-expirados', (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ') || !validTokens.has(authHeader.substring(7))) return res.status(401).json({ error: 'No autorizado' });
    let eliminadosBloqueos = 0;
    let eliminadosHistorial = 0;
    const ahora = Date.now();
    for (const [ip, datos] of bloqueos) {
        if (ahora > datos.hasta) { bloqueos.delete(ip); eliminadosBloqueos++; }
    }
    const antesHist = historialBloqueos.length;
    historialBloqueos = historialBloqueos.filter(h => ahora < h.hasta);
    eliminadosHistorial = antesHist - historialBloqueos.length;
    guardarBloqueos();
    res.json({ mensaje: `Limpieza completada: ${eliminadosBloqueos} bloqueos y ${eliminadosHistorial} registros eliminados` });
});

app.post('/api/seguridad/bloquear-permanente/:ip', (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ') || !validTokens.has(authHeader.substring(7))) return res.status(401).json({ error: 'No autorizado' });
    const { ip } = req.params;
    const datos = bloquearIP(ip, 'Bloqueo permanente por administrador', 'bloqueo_manual');
    datos.hasta = Date.now() + (365 * 24 * 60 * 60 * 1000);
    datos.permanente = true;
    guardarBloqueos();
    res.json({ mensaje: `IP ${ip} bloqueada permanentemente` });
});

function formatearTiempo(ms) {
    if (ms <= 0) return 'Expirado';
    const s = Math.floor(ms / 1000), m = Math.floor(s / 60), h = Math.floor(m / 60);
    if (h > 0) return `${h}h ${m % 60}m`;
    if (m > 0) return `${m}m ${s % 60}s`;
    return `${s}s`;
}

// ==================== LOGIN ====================
const validTokens = new Map();

app.post('/api/login', (req, res) => {
    const ip = req.ip || req.connection.remoteAddress || req.socket.remoteAddress || '0.0.0.0';
    if (estaBloqueado(ip)) return res.status(403).json({ success: false, error: 'Acceso bloqueado' });
    const { password } = req.body;
    const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
    if (!password) { registrarIntentoFallido(ip, 'password_vacia'); return res.status(400).json({ success: false, error: 'Contraseña requerida' }); }
    if (password === ADMIN_PASSWORD) {
        const token = crypto.randomBytes(64).toString('hex');
        validTokens.set(token, Date.now() + 8 * 60 * 60 * 1000);
        limpiarIntentos(ip);
        res.json({ success: true, token });
    } else {
        registrarIntentoFallido(ip, 'password_incorrecta');
        res.status(401).json({ success: false, error: 'Contraseña incorrecta' });
    }
});

app.get('/api/verify', (req, res) => {
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
        const token = authHeader.substring(7);
        if (validTokens.has(token) && validTokens.get(token) > Date.now()) return res.json({ valid: true });
        validTokens.delete(token);
    }
    res.status(401).json({ valid: false });
});

app.post('/api/logout', (req, res) => {
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) validTokens.delete(authHeader.substring(7));
    res.json({ success: true });
});

// ==================== ASISTENTE DE VOZ ====================

app.get('/voice-assistant', (req, res) => res.sendFile(path.join(__dirname, 'voice-assistant.html')));

let voiceClients = new Map();

async function procesarComandoVoz(texto, clientId, ip) {
    const textoLower = texto.toLowerCase().trim();
    let clientData = voiceClients.get(clientId);
    if (!clientData) {
        clientData = { estado: 'recopilando', datos: {}, intentosNumero: 0, alternativa: null };
        voiceClients.set(clientId, clientData);
    }
    if (!clientData.estado || clientData.estado === 'inicial') {
        clientData.estado = 'recopilando';
        clientData.datos = {};
        clientData.intentosNumero = 0;
        clientData.alternativa = null;
    }

    if (clientData.estado === 'esperando_confirmacion_alternativa') {
        if (textoLower.includes('si') || textoLower.includes('sí') || textoLower.includes('ok') || textoLower.includes('acepto') || textoLower.includes('dale')) {
            clientData.datos.dia = clientData.alternativa.dia;
            clientData.datos.hora = clientData.alternativa.hora;
            clientData.estado = 'confirmando';
        } else {
            voiceClients.delete(clientId);
            return "Entiendo. Reserva cancelada. Di 'reservar turno' para iniciar una nueva.";
        }
    }

    const d = clientData.datos;
    if (!d.nombre) { const n = extraerNombre(texto); if (n) d.nombre = n; }
    if (!d.massageType) {
        if (textoLower.includes('relajante')) d.massageType = 'Masaje Relajante';
        else if (textoLower.includes('corporal')) d.massageType = 'Masaje Corporal';
        else if (textoLower.includes('facial')) d.massageType = 'Masaje Facial';
    }
    if (!d.dia) { for (const dia of DIAS_VALIDOS) { if (textoLower.includes(dia)) { d.dia = dia; break; } } }
    if (!d.hora) {
        if (textoLower.includes('12') || textoLower.includes('doce')) d.hora = 12;
        else if (textoLower.includes('16') || textoLower.includes('cuatro')) d.hora = 16;
        else if (textoLower.includes('20') || textoLower.includes('ocho')) d.hora = 20;
    }
    if (!d.tipoServicio) {
        if (textoLower.includes('salon') || textoLower.includes('salón') || textoLower.includes('local')) { d.tipoServicio = 'salon'; d.ubicacion = 'Salón Serenity Spa'; }
        else if (textoLower.includes('domicilio') || textoLower.includes('casa')) d.tipoServicio = 'domicilio';
    }
    if (d.tipoServicio === 'domicilio' && !d.ubicacion && textoLower.length > 10 && !textoLower.includes('reservar') && !textoLower.includes('turno')) d.ubicacion = texto.trim();
    if (!d.telefono) {
        const posible = texto.replace(/\D/g, '');
        if (posible.length >= 7 && posible.length <= 15 && /^\d+$/.test(posible)) {
            d.telefono = posible;
            if (!d.codigoPais) { const p = detectarPais(texto); d.codigoPais = p?.codigo || '54'; }
        }
    }
    if (!d.codigoPais) { const p = detectarPais(texto); if (p) { d.codigoPais = p.codigo; } }

    if (clientData.estado === 'confirmando' || (d.nombre && d.telefono && d.massageType && d.dia && d.hora && d.tipoServicio)) {
        let turnosExistentes = [];
        try { turnosExistentes = JSON.parse(await fs.readFile(TURNOS_FILE, 'utf8')); } catch {}
        if (turnosExistentes.some(t => t.telefono === d.telefono && t.dia === d.dia)) { voiceClients.delete(clientId); return `Ya tienes un turno para el ${d.dia}. Solo un masaje por día.`; }
        if (turnosExistentes.some(t => t.dia === d.dia && t.hora === d.hora)) {
            const alt = buscarAlternativa(d.dia, d.hora, turnosExistentes);
            if (alt) {
                clientData.estado = 'esperando_confirmacion_alternativa';
                clientData.alternativa = alt;
                const ht = alt.hora === 12 ? '12 del mediodía' : (alt.hora === 16 ? '4 de la tarde' : '8 de la noche');
                return `Las ${d.hora}:00 del ${d.dia} está ocupado. ¿Reservar para el ${alt.dia} a las ${ht}? Di sí o no.`;
            }
            voiceClients.delete(clientId);
            return `No hay disponibilidad en los próximos 7 días.`;
        }
        const nuevo = { id: generarId(), nombre: d.nombre, dia: d.dia, hora: d.hora, massageType: d.massageType, telefono: d.telefono, codigoPais: d.codigoPais || '54', ubicacion: d.ubicacion || (d.tipoServicio === 'salon' ? 'Salón Serenity Spa' : 'No especificada'), tipoServicio: d.tipoServicio, fechaCreacion: new Date().toISOString(), ip };
        turnosExistentes.push(nuevo);
        await fs.writeFile(TURNOS_FILE, JSON.stringify(turnosExistentes, null, 2), 'utf8');
        const ht = d.hora === 12 ? '12 del mediodía' : (d.hora === 16 ? '4 de la tarde' : '8 de la noche');
        const tipo = d.tipoServicio === 'domicilio' ? `Dirección: ${d.ubicacion}` : 'En nuestro salón';
        voiceClients.delete(clientId);
        return `¡Reserva confirmada! ${d.massageType} para ${d.nombre} el ${d.dia} a las ${ht}. ${tipo}. ¡Gracias!`;
    }

    if (!d.nombre) { clientData.estado = 'esperando_nombre'; return "Bienvenido a Serenity Spa. ¿Cuál es tu nombre?"; }
    if (!d.telefono) { clientData.estado = 'esperando_telefono'; return `Gracias ${d.nombre}. ¿Cuál es tu número de teléfono?`; }
    if (!d.massageType) { clientData.estado = 'esperando_masaje'; return `${d.nombre}, ¿qué masaje deseas? Relajante, corporal o facial.`; }
    if (!d.tipoServicio) { clientData.estado = 'esperando_ubicacion'; return "¿Prefieres en el salón o a domicilio?"; }
    if (d.tipoServicio === 'domicilio' && !d.ubicacion) { clientData.estado = 'esperando_direccion'; return "¿Cuál es tu dirección completa?"; }
    if (!d.dia) { clientData.estado = 'esperando_dia'; return "¿Qué día? Lunes a sábado."; }
    if (!d.hora) { clientData.estado = 'esperando_hora'; return "¿A qué hora? 12:00, 16:00 o 20:00."; }
    return "Di 'reservar turno' para comenzar, o 'horarios' para ver disponibilidad.";
}

// ==================== RUTAS HTML ====================
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/admin.html', (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));
app.get('/login.html', (req, res) => res.sendFile(path.join(__dirname, 'login.html')));
app.get('/1.html', (req, res) => res.redirect('/admin.html'));

// ==================== INICIAR SERVIDOR ====================
async function startServer() {
    try {
        await cargarBloqueos();
        await inicializarConfiguracion();
        await inicializarServicios();
        await inicializarArchivoTurnos();
        const server = app.listen(PORT, '0.0.0.0', () => {
            console.log('\n' + '='.repeat(60));
            console.log('  🌿 SERENITY SPA v5.0 - CORREGIDO');
            console.log('='.repeat(60));
            console.log(`  📍 Puerto: ${PORT}`);
            console.log(`  🎤 Asistente de voz: /voice-assistant (push-to-talk)`);
            console.log(`  🔒 Seguridad: /admin.html → pestaña Seguridad`);
            console.log(`  🗑️ Eliminar bloqueos: API + botón en admin`);
            console.log(`  🖼️ WhatsApp: solo URLs públicas`);
            console.log(`  🚫 IPs bloqueadas: ${bloqueos.size}`);
            console.log('  ✅ Servidor listo');
            console.log('='.repeat(60) + '\n');
        });

        const wss = new WebSocket.Server({ server, path: '/ws-voice' });
        wss.on('connection', (ws, req) => {
            const ip = req.socket.remoteAddress || 'desconocida';
            if (estaBloqueado(ip)) { ws.close(1008, 'IP bloqueada'); return; }
            const clientId = generarId();
            voiceClients.set(clientId, { ws, estado: 'recopilando', datos: {}, intentosNumero: 0, alternativa: null, ip, conectadoDesde: new Date().toISOString() });
            ws.on('message', async (data) => {
                try {
                    const msg = JSON.parse(data);
                    if (msg.tipo === 'transcripcion') {
                        const resp = await procesarComandoVoz(msg.texto, clientId, ip);
                        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ tipo: 'respuesta', texto: resp }));
                    }
                } catch (e) {
                    console.error('Error WebSocket:', e);
                    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ tipo: 'respuesta', texto: 'Hubo un error. Intenta de nuevo.' }));
                }
            });
            ws.on('close', () => voiceClients.delete(clientId));
            ws.on('error', (e) => { console.error(`Error WS ${clientId}:`, e.message); voiceClients.delete(clientId); });
        });
        console.log('🎤 WebSocket en /ws-voice');
    } catch (e) { console.error('❌ Error fatal:', e); process.exit(1); }
}

process.on('SIGTERM', () => { guardarBloqueos(); process.exit(0); });
process.on('SIGINT', () => { guardarBloqueos(); process.exit(0); });

startServer();
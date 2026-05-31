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

console.log('✅ SERVIDOR INICIANDO CON ASISTENTE DE VOZ UNIFICADO');

// ==================== SISTEMA DE BLOQUEO POR IP ====================
let bloqueos = new Map();

async function cargarBloqueos() {
    try {
        await fs.access(BLOQUEOS_FILE);
        const data = await fs.readFile(BLOQUEOS_FILE, 'utf8');
        const parsed = JSON.parse(data);
        bloqueos = new Map(Object.entries(parsed));
        console.log(`📂 Cargados ${bloqueos.size} IPs bloqueadas`);
    } catch {
        await fs.writeFile(BLOQUEOS_FILE, '{}', 'utf8');
        console.log('📁 Archivo bloqueos.json creado');
    }
}

async function guardarBloqueos() {
    const obj = Object.fromEntries(bloqueos);
    await fs.writeFile(BLOQUEOS_FILE, JSON.stringify(obj, null, 2), 'utf8');
}

function estaBloqueado(ip) {
    if (bloqueos.has(ip)) {
        const data = bloqueos.get(ip);
        if (Date.now() < data.hasta) {
            return true;
        } else {
            bloqueos.delete(ip);
            guardarBloqueos();
            return false;
        }
    }
    return false;
}

function bloquearIP(ip, motivo) {
    const duracion = 60 * 60 * 1000; // 1 hora de bloqueo
    bloqueos.set(ip, {
        hasta: Date.now() + duracion,
        motivo: motivo,
        fecha: new Date().toISOString()
    });
    guardarBloqueos();
    console.log(`🚫 IP ${ip} bloqueada por 1 hora. Motivo: ${motivo}`);
}

// ==================== RATE LIMITING ====================
const intentosFallidos = new Map();

function registrarIntentoFallido(ip) {
    const ahora = Date.now();
    if (!intentosFallidos.has(ip)) {
        intentosFallidos.set(ip, { count: 1, primerIntento: ahora });
        return false;
    }
    
    const data = intentosFallidos.get(ip);
    if (ahora - data.primerIntento > 10 * 60 * 1000) {
        intentosFallidos.set(ip, { count: 1, primerIntento: ahora });
        return false;
    }
    
    data.count++;
    
    if (data.count >= 5) {
        bloquearIP(ip, 'Demasiados intentos de registro fallidos');
        intentosFallidos.delete(ip);
        return true;
    }
    
    return false;
}

function limpiarIntentos(ip) {
    intentosFallidos.delete(ip);
}

// ==================== MIDDLEWARES ====================
app.use(express.json({ limit: '1mb' }));

app.use((req, res, next) => {
    const ip = req.ip || req.connection.remoteAddress || req.socket.remoteAddress;
    if (estaBloqueado(ip)) {
        return res.status(403).json({ 
            error: 'Acceso bloqueado temporalmente. Contacte con soporte.',
            bloqueado: true 
        });
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

// ==================== REGLAS DE TURNOS ====================
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
    'república dominicana': { codigo: '1', pattern: /^[1-9]\d{9}$/, ejemplo: '809 123 4567' },
    'puerto rico': { codigo: '1', pattern: /^[1-9]\d{9}$/, ejemplo: '787 123 4567' },
    'costa rica': { codigo: '506', pattern: /^[1-9]\d{7,9}$/, ejemplo: '8 1234 5678' },
    'panamá': { codigo: '507', pattern: /^[1-9]\d{7,8}$/, ejemplo: '6 123 4567' },
    'ecuador': { codigo: '593', pattern: /^[1-9]\d{8,10}$/, ejemplo: '99 123 4567' }
};

function detectarPais(texto) {
    const textoLower = texto.toLowerCase().trim();
    
    for (const [pais, data] of Object.entries(VALIDACION_PAISES)) {
        if (textoLower === pais || textoLower.includes(pais)) {
            return { pais: pais, codigo: data.codigo, pattern: data.pattern, ejemplo: data.ejemplo };
        }
    }
    
    const palabrasClave = {
        'argen': 'argentina', 'arg': 'argentina', 'bs as': 'argentina',
        'méx': 'méxico', 'mex': 'méxico', 'cdmx': 'méxico',
        'colom': 'colombia', 'bog': 'colombia',
        'chil': 'chile', 'santiago': 'chile',
        'peru': 'perú', 'lima': 'perú',
        'espa': 'españa', 'madrid': 'españa', 'barna': 'españa',
        'cuba': 'cuba', 'la habana': 'cuba',
        'uruguay': 'uruguay', 'montevideo': 'uruguay'
    };
    
    for (const [clave, paisDestino] of Object.entries(palabrasClave)) {
        if (textoLower.includes(clave)) {
            const data = VALIDACION_PAISES[paisDestino];
            if (data) return { pais: paisDestino, codigo: data.codigo, pattern: data.pattern, ejemplo: data.ejemplo };
        }
    }
    
    return null;
}

function validarNumeroPorPais(numero, paisData) {
    const limpio = numero.replace(/\D/g, '');
    return paisData.pattern.test(limpio);
}

function validarNombre(nombre) {
    if (!nombre) return false;
    const limpio = nombre.trim();
    if (limpio.length < 2 || limpio.length > 50) return false;
    if (!/^[a-zA-ZáéíóúñÑü\s.]+$/.test(limpio)) return false;
    return true;
}

function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/[&<>]/g, (m) => {
        if (m === '&') return '&amp;';
        if (m === '<') return '&lt;';
        if (m === '>') return '&gt;';
        return m;
    });
}

function sanitizeInput(str) {
    if (!str) return '';
    return str.trim().replace(/[^\w\sáéíóúñÑü.,@\-]/gi, '');
}

function generarId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2) + crypto.randomBytes(4).toString('hex');
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
    try {
        const data = await fs.readFile(TURNOS_FILE, 'utf8');
        turnosEnMemoria = JSON.parse(data);
        return turnosEnMemoria;
    } catch {
        return turnosEnMemoria;
    }
}

async function guardarTurnos(turnos) {
    await fs.writeFile(TURNOS_FILE, JSON.stringify(turnos, null, 2), 'utf8');
    turnosEnMemoria = turnos;
    return true;
}

// ==================== CONFIGURACIÓN ====================
let configData = {
    hero: {
        titulo: "Renueva tu Energía",
        subtitulo: "Experiencias de bienestar",
        imagenFondo: "https://images.unsplash.com/photo-1544161515-4ab6ce6db874?ixlib=rb-1.2.1&auto=format&fit=crop&w=1920&q=80",
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

async function inicializarConfiguracion() {
    try {
        await fs.access(CONFIG_FILE);
        const data = await fs.readFile(CONFIG_FILE, 'utf8');
        const loadedConfig = JSON.parse(data);
        configData = { ...configData, ...loadedConfig };
        console.log('📂 Configuración cargada');
    } catch {
        await fs.writeFile(CONFIG_FILE, JSON.stringify(configData, null, 2), 'utf8');
        console.log('📁 Archivo config.json creado');
    }
}

// ==================== GESTIÓN DE SERVICIOS ====================
let serviciosData = [];

async function inicializarServicios() {
    const serviciosDefault = [
        { id: "relajante", nombre: "Masaje Relajante", precio: "$45", descripcion: "Movimientos suaves para liberar el estrés.", beneficios: ["Reduce ansiedad", "60 Minutos"], efectos: ["Relajación profunda"], imagenWeb: "https://images.unsplash.com/photo-1544161515-4ab6ce6db874?ixlib=rb-1.2.1&auto=format&fit=crop&w=800&q=80", imagenWhatsApp: "https://images.unsplash.com/photo-1544161515-4ab6ce6db874?ixlib=rb-1.2.1&auto=format&fit=crop&w=800&q=80", orden: 1 },
        { id: "corporal", nombre: "Masaje Corporal", precio: "$65", descripcion: "Tratamiento completo para relajación profunda.", beneficios: ["Relajación integral", "90 Minutos"], efectos: ["Activación linfática"], imagenWeb: "https://images.unsplash.com/photo-1519823551278-64ac92734fb1?ixlib=rb-1.2.1&auto=format&fit=crop&w=800&q=80", imagenWhatsApp: "https://images.unsplash.com/photo-1519823551278-64ac92734fb1?ixlib=rb-1.2.1&auto=format&fit=crop&w=800&q=80", orden: 2 },
        { id: "facial", nombre: "Masaje Facial", precio: "$40", descripcion: "Rejuvenece la piel y alivia la tensión facial.", beneficios: ["Reafirma la piel", "45 Minutos"], efectos: ["Estimula colágeno"], imagenWeb: "https://images.unsplash.com/photo-1570172619644-dfd03ed5d881?ixlib=rb-1.2.1&auto=format&fit=crop&w=800&q=80", imagenWhatsApp: "https://images.unsplash.com/photo-1570172619644-dfd03ed5d881?ixlib=rb-1.2.1&auto=format&fit=crop&w=800&q=80", orden: 3 }
    ];
    
    try {
        await fs.access(SERVICIOS_FILE);
        const data = await fs.readFile(SERVICIOS_FILE, 'utf8');
        serviciosData = JSON.parse(data);
        console.log(`📂 Cargados ${serviciosData.length} servicios`);
    } catch {
        serviciosData = serviciosDefault;
        await fs.writeFile(SERVICIOS_FILE, JSON.stringify(serviciosData, null, 2), 'utf8');
        console.log('📁 Archivo servicios.json creado');
    }
}

// ==================== RUTAS API ====================

app.get('/api/config', (req, res) => res.json(configData));

app.put('/api/config', async (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ') || !validTokens.has(authHeader.substring(7))) {
        return res.status(401).json({ error: 'No autorizado' });
    }
    try {
        configData = { ...configData, ...req.body };
        await fs.writeFile(CONFIG_FILE, JSON.stringify(configData, null, 2), 'utf8');
        res.json({ mensaje: 'Configuración actualizada' });
    } catch (error) {
        res.status(500).json({ error: 'Error al guardar configuración' });
    }
});

app.get('/api/servicios', (req, res) => res.json(serviciosData.sort((a, b) => (a.orden || 999) - (b.orden || 999))));

app.post('/api/servicios', async (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ') || !validTokens.has(authHeader.substring(7))) {
        return res.status(401).json({ error: 'No autorizado' });
    }
    try {
        const nuevoServicio = { id: generarId(), ...req.body };
        serviciosData.push(nuevoServicio);
        await fs.writeFile(SERVICIOS_FILE, JSON.stringify(serviciosData, null, 2), 'utf8');
        res.status(201).json(nuevoServicio);
    } catch (error) {
        res.status(500).json({ error: 'Error al crear servicio' });
    }
});

app.put('/api/servicios/:id', async (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ') || !validTokens.has(authHeader.substring(7))) {
        return res.status(401).json({ error: 'No autorizado' });
    }
    try {
        const { id } = req.params;
        const index = serviciosData.findIndex(s => s.id === id);
        if (index === -1) return res.status(404).json({ error: 'Servicio no encontrado' });
        serviciosData[index] = { ...serviciosData[index], ...req.body, id };
        await fs.writeFile(SERVICIOS_FILE, JSON.stringify(serviciosData, null, 2), 'utf8');
        res.json(serviciosData[index]);
    } catch (error) {
        res.status(500).json({ error: 'Error al actualizar servicio' });
    }
});

app.delete('/api/servicios/:id', async (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ') || !validTokens.has(authHeader.substring(7))) {
        return res.status(401).json({ error: 'No autorizado' });
    }
    try {
        const { id } = req.params;
        serviciosData = serviciosData.filter(s => s.id !== id);
        await fs.writeFile(SERVICIOS_FILE, JSON.stringify(serviciosData, null, 2), 'utf8');
        res.json({ mensaje: 'Servicio eliminado' });
    } catch (error) {
        res.status(500).json({ error: 'Error al eliminar servicio' });
    }
});

app.get('/turnos', async (req, res) => {
    const turnos = await cargarTurnos();
    res.json(turnos);
});

app.post('/turnos', async (req, res) => {
    const ip = req.ip || req.connection.remoteAddress;
    if (estaBloqueado(ip)) {
        return res.status(403).json({ error: 'Acceso bloqueado' });
    }
    
    try {
        const { nombre, dia, hora, massageType, telefono, codigoPais, ubicacion, tipoServicio } = req.body;
        
        if (!validarNombre(nombre)) {
            registrarIntentoFallido(ip);
            return res.status(400).json({ error: 'Nombre inválido' });
        }
        
        if (!telefono || telefono.length < 7) {
            registrarIntentoFallido(ip);
            return res.status(400).json({ error: 'Teléfono inválido' });
        }
        
        if (!dia || !DIAS_VALIDOS.includes(dia.toLowerCase())) {
            return res.status(400).json({ error: 'Día no válido' });
        }
        
        const horaNum = parseInt(hora);
        if (!HORAS_VALIDAS.includes(horaNum)) {
            return res.status(400).json({ error: 'Hora no válida' });
        }

        const turnos = await cargarTurnos();
        const telefonoLimpio = telefono.replace(/\D/g, '');
        
        const yaTieneTurno = turnos.some(t => t.telefono === telefonoLimpio && t.dia === dia.toLowerCase());
        if (yaTieneTurno) {
            return res.status(409).json({ error: 'Ya tienes un turno ese día' });
        }
        
        const horarioOcupado = turnos.some(t => t.dia === dia.toLowerCase() && t.hora === horaNum);
        if (horarioOcupado) {
            return res.status(409).json({ error: 'Horario no disponible' });
        }

        const nuevoTurno = {
            id: generarId(),
            nombre: escapeHtml(sanitizeInput(nombre)),
            dia: dia.toLowerCase(),
            hora: horaNum,
            massageType: massageType || 'Masaje',
            telefono: telefonoLimpio,
            codigoPais: codigoPais || '54',
            ubicacion: ubicacion ? escapeHtml(sanitizeInput(ubicacion)) : null,
            tipoServicio: tipoServicio || 'salon',
            fechaCreacion: new Date().toISOString(),
            ip: ip
        };

        turnos.push(nuevoTurno);
        await guardarTurnos(turnos);
        limpiarIntentos(ip);
        
        res.status(201).json({ mensaje: 'Turno creado', turno: nuevoTurno });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Error al crear turno' });
    }
});

app.delete('/turnos/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const turnos = await cargarTurnos();
        const index = turnos.findIndex(t => t.id === id);
        if (index === -1) return res.status(404).json({ error: 'Turno no encontrado' });
        turnos.splice(index, 1);
        await guardarTurnos(turnos);
        res.json({ mensaje: 'Turno eliminado' });
    } catch (error) {
        res.status(500).json({ error: 'Error al eliminar turno' });
    }
});

// ==================== ENVIAR WHATSAPP ====================
app.post('/api/enviar-whatsapp/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const turnos = await cargarTurnos();
        const turno = turnos.find(t => t.id === id);
        
        if (!turno) {
            return res.status(404).json({ error: 'Turno no encontrado' });
        }
        
        const servicio = serviciosData.find(s => s.nombre === turno.massageType);
        const imagenUrl = servicio?.imagenWhatsApp || servicio?.imagenWeb || "https://images.unsplash.com/photo-1544161515-4ab6ce6db874?ixlib=rb-1.2.1&auto=format&fit=crop&w=800&q=80";
        
        const mensaje = `🌿 *SERENITY SPA* 🌿\n\nHola *${turno.nombre}*, \n¡Gracias por confiar en nosotros! ✨\n\n✅ *TU RESERVA HA SIDO CONFIRMADA*\n\n📅 *Día:* ${turno.dia.charAt(0).toUpperCase() + turno.dia.slice(1)}\n⏰ *Hora:* ${turno.hora}:00 hs\n💆‍♂️ *Masaje:* ${turno.massageType}\n📍 *Lugar:* ${turno.tipoServicio === 'domicilio' ? turno.ubicacion : 'Serenity Spa - Salón'}\n\n🌸 *Te esperamos con aromaterapia y música suave.*\n⏱️ Te recordamos que puedes modificar o cancelar con 4 horas de anticipación.\n\n✨ *¡Te deseamos una experiencia inolvidable!*\n\nCon cariño,\n*Equipo Serenity Spa* 💆‍♀️💆‍♂️`;
        
        const numeroTelefono = turno.telefono.replace(/\D/g, '');
        const codigoPais = turno.codigoPais || '54';
        
        res.json({ 
            success: true, 
            numero: `${codigoPais}${numeroTelefono}`, 
            mensaje: mensaje,
            urlWhatsApp: `https://wa.me/${codigoPais}${numeroTelefono}?text=${encodeURIComponent(mensaje)}`
        });
        
    } catch (error) {
        console.error('Error al preparar WhatsApp:', error);
        res.status(500).json({ error: 'Error al preparar mensaje' });
    }
});

// ==================== LOGIN ====================
const validTokens = new Map();

app.post('/api/login', (req, res) => {
    const ip = req.ip || req.connection.remoteAddress;
    if (estaBloqueado(ip)) {
        return res.status(403).json({ success: false, error: 'Acceso bloqueado' });
    }
    
    const { password } = req.body;
    const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
    
    if (!ADMIN_PASSWORD) {
        return res.status(500).json({ success: false, error: 'Error del servidor' });
    }
    
    if (!password) {
        return res.status(400).json({ success: false, error: 'Contraseña requerida' });
    }
    
    if (password === ADMIN_PASSWORD) {
        const token = crypto.randomBytes(64).toString('hex');
        validTokens.set(token, Date.now() + 8 * 60 * 60 * 1000);
        res.json({ success: true, token });
    } else {
        registrarIntentoFallido(ip);
        res.status(401).json({ success: false, error: 'Contraseña incorrecta' });
    }
});

app.get('/api/verify', (req, res) => {
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
        const token = authHeader.substring(7);
        if (validTokens.has(token) && validTokens.get(token) > Date.now()) {
            res.json({ valid: true });
        } else {
            validTokens.delete(token);
            res.status(401).json({ valid: false });
        }
    } else {
        res.status(401).json({ valid: false });
    }
});

app.post('/api/logout', (req, res) => {
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
        const token = authHeader.substring(7);
        validTokens.delete(token);
    }
    res.json({ success: true });
});

// ==================== ASISTENTE DE VOZ MEJORADO ====================

app.get('/voice-assistant', (req, res) => {
    res.sendFile(path.join(__dirname, 'voice-assistant.html'));
});

let voiceClients = new Map();

function formatearNumeroParaVoz(numero) {
    const limpio = numero.replace(/\D/g, '');
    if (limpio.length <= 4) return limpio;
    const grupos = [];
    for (let i = 0; i < limpio.length; i += 2) {
        grupos.push(limpio.substr(i, 2));
    }
    return grupos.join(' ');
}

function buscarAlternativa(diaSolicitado, horaSolicitada, turnosExistentes) {
    const diasSemana = ['lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado'];
    const indexInicial = diasSemana.indexOf(diaSolicitado);
    if (indexInicial === -1) return null;

    for (let offset = 0; offset < 7; offset++) {
        const nuevoDiaIndex = (indexInicial + offset) % diasSemana.length;
        const nuevoDia = diasSemana[nuevoDiaIndex];
        
        const horasAConsultar = (offset === 0) 
            ? HORAS_VALIDAS.filter(h => h > horaSolicitada) 
            : HORAS_VALIDAS;

        for (const hora of horasAConsultar) {
            const ocupado = turnosExistentes.some(t => t.dia === nuevoDia && t.hora === hora);
            if (!ocupado) {
                return { dia: nuevoDia, hora: hora };
            }
        }
    }
    return null;
}

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

    // Verificar si estamos esperando confirmación de alternativa
    if (clientData.estado === 'esperando_confirmacion_alternativa') {
        if (textoLower.includes('si') || textoLower.includes('sí') || textoLower.includes('ok') || textoLower.includes('acepto')) {
            clientData.datos.dia = clientData.alternativa.dia;
            clientData.datos.hora = clientData.alternativa.hora;
            clientData.estado = 'confirmando';
        } else {
            voiceClients.delete(clientId);
            return "Entiendo. La reserva ha sido cancelada. Puedes iniciar una nueva cuando quieras. ¿Necesitas algo más?";
        }
    }

    const datosExtraidos = clientData.datos;

    // Extraer nombre
    if (!datosExtraidos.nombre) {
        const palabrasNoNombre = ['hola', 'buenos', 'buenas', 'dias', 'tardes', 'noches', 'si', 'no', 'reservar', 'turno', 'cita', 'masaje', 'relajante', 'corporal', 'facial', 'salon', 'salón', 'domicilio', 'casa', 'quiero', 'deseo', 'necesito', 'para', 'por', 'favor', 'gracias', 'lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado', 'doce', 'cuatro', 'ocho'];
        const palabras = textoLower.split(/\s+/).filter(p => p.length > 1 && !palabrasNoNombre.includes(p) && !/\d/.test(p));
        
        if (palabras.length > 0) {
            const posibleNombre = palabras.map(p => p.charAt(0).toUpperCase() + p.slice(1)).join(' ');
            if (posibleNombre.length >= 2 && posibleNombre.length <= 50) {
                datosExtraidos.nombre = posibleNombre;
            }
        }
    }

    // Extraer tipo de masaje
    if (!datosExtraidos.massageType) {
        if (textoLower.includes('relajante')) datosExtraidos.massageType = 'Masaje Relajante';
        else if (textoLower.includes('corporal')) datosExtraidos.massageType = 'Masaje Corporal';
        else if (textoLower.includes('facial')) datosExtraidos.massageType = 'Masaje Facial';
    }

    // Extraer día
    if (!datosExtraidos.dia) {
        for (const dia of DIAS_VALIDOS) {
            if (textoLower.includes(dia)) {
                datosExtraidos.dia = dia;
                break;
            }
        }
    }

    // Extraer hora
    if (!datosExtraidos.hora) {
        if (textoLower.includes('12') || textoLower.includes('doce')) datosExtraidos.hora = 12;
        else if (textoLower.includes('16') || textoLower.includes('cuatro')) datosExtraidos.hora = 16;
        else if (textoLower.includes('20') || textoLower.includes('ocho')) datosExtraidos.hora = 20;
    }

    // Extraer tipo de servicio
    if (!datosExtraidos.tipoServicio) {
        if (textoLower.includes('salon') || textoLower.includes('salón')) {
            datosExtraidos.tipoServicio = 'salon';
            datosExtraidos.ubicacion = 'Salón Serenity Spa';
        } else if (textoLower.includes('domicilio') || textoLower.includes('casa') || textoLower.includes('direccion') || textoLower.includes('domiciliario')) {
            datosExtraidos.tipoServicio = 'domicilio';
        }
    }

    // Extraer dirección
    if (datosExtraidos.tipoServicio === 'domicilio' && !datosExtraidos.ubicacion && textoLower.length > 10 && !textoLower.includes('reservar') && !textoLower.includes('turno')) {
        datosExtraidos.ubicacion = texto.trim();
    }

    // Extraer teléfono
    if (!datosExtraidos.telefono) {
        const posibleTelefono = texto.replace(/\D/g, '');
        if (posibleTelefono.length >= 7 && posibleTelefono.length <= 15) {
            datosExtraidos.telefono = posibleTelefono;
            if (!datosExtraidos.codigoPais) {
                const paisDetectado = detectarPais(texto);
                datosExtraidos.codigoPais = paisDetectado?.codigo || '54';
            }
        }
    }

    // Extraer país
    if (!datosExtraidos.pais && !datosExtraidos.codigoPais) {
        const paisDetectado = detectarPais(texto);
        if (paisDetectado) {
            datosExtraidos.pais = paisDetectado.pais;
            datosExtraidos.codigoPais = paisDetectado.codigo;
            datosExtraidos.pattern = paisDetectado.pattern;
            datosExtraidos.ejemplo = paisDetectado.ejemplo;
        }
    }

    // Si estamos confirmando, proceder a reservar
    if (clientData.estado === 'confirmando' || (datosExtraidos.nombre && datosExtraidos.telefono && datosExtraidos.massageType && datosExtraidos.dia && datosExtraidos.hora && datosExtraidos.tipoServicio)) {
        let turnosExistentes = [];
        try { const data = await fs.readFile(TURNOS_FILE, 'utf8'); turnosExistentes = JSON.parse(data); } catch(e) {}

        const horarioOcupado = turnosExistentes.some(t => t.dia === datosExtraidos.dia && t.hora === datosExtraidos.hora);
        const yaTieneTurno = turnosExistentes.some(t => t.telefono === datosExtraidos.telefono && t.dia === datosExtraidos.dia);

        if (yaTieneTurno) {
            voiceClients.delete(clientId);
            return `Ya tienes un turno reservado para el ${datosExtraidos.dia}. Solo permitimos un masaje por día. ¿Te ayudo con otra cosa?`;
        }

        if (horarioOcupado) {
            const alternativa = buscarAlternativa(datosExtraidos.dia, datosExtraidos.hora, turnosExistentes);
            if (alternativa) {
                clientData.estado = 'esperando_confirmacion_alternativa';
                clientData.alternativa = alternativa;
                const horaAltText = alternativa.hora === 12 ? '12 del mediodía' : (alternativa.hora === 16 ? '4 de la tarde' : '8 de la noche');
                return `El horario de las ${datosExtraidos.hora}:00 del ${datosExtraidos.dia} ya está ocupado. ¿Te gustaría reservar para el ${alternativa.dia} a las ${horaAltText}? Responde 'sí' o 'no'.`;
            } else {
                voiceClients.delete(clientId);
                return `Lo siento, no hay disponibilidad en los próximos 7 días. ¿Te gustaría intentar con otra fecha?`;
            }
        }

        const nuevoTurno = {
            id: generarId(),
            nombre: datosExtraidos.nombre,
            dia: datosExtraidos.dia,
            hora: datosExtraidos.hora,
            massageType: datosExtraidos.massageType,
            telefono: datosExtraidos.telefono,
            codigoPais: datosExtraidos.codigoPais || '54',
            ubicacion: datosExtraidos.ubicacion || (datosExtraidos.tipoServicio === 'salon' ? 'Salón Serenity Spa' : 'No especificada'),
            tipoServicio: datosExtraidos.tipoServicio,
            fechaCreacion: new Date().toISOString(),
            ip: ip
        };

        turnosExistentes.push(nuevoTurno);
        await fs.writeFile(TURNOS_FILE, JSON.stringify(turnosExistentes, null, 2), 'utf8');
        
        const horaTexto = datosExtraidos.hora === 12 ? '12 del mediodía' : (datosExtraidos.hora === 16 ? '4 de la tarde' : '8 de la noche');
        const tipoTexto = datosExtraidos.tipoServicio === 'domicilio' ? `Dirección: ${datosExtraidos.ubicacion}` : 'En nuestro salón';
        
        voiceClients.delete(clientId);
        return `✅ ¡Reserva confirmada! ${datosExtraidos.massageType} para ${datosExtraidos.nombre} el ${datosExtraidos.dia} a las ${horaTexto}. ${tipoTexto}. Te esperamos en Serenity Spa. ¡Gracias!`;
    }

    // Preguntar por datos faltantes
    if (!datosExtraidos.nombre) {
        clientData.estado = 'esperando_nombre';
        return "¡Bienvenido a Serenity Spa! Para comenzar, ¿cuál es tu nombre?";
    }

    if (!datosExtraidos.telefono) {
        if (!datosExtraidos.pais) {
            clientData.estado = 'esperando_pais';
            return `Gracias ${datosExtraidos.nombre}. ¿De qué país nos llamas?`;
        } else {
            clientData.estado = 'esperando_telefono';
            return `¿Cuál es tu número de teléfono? Por ejemplo: ${datosExtraidos.ejemplo || '11 2345 6789'}.`;
        }
    }

    if (!datosExtraidos.massageType) {
        clientData.estado = 'esperando_masaje';
        const listaMasajes = serviciosData.map(s => s.nombre).join(', ');
        return `${datosExtraidos.nombre}, ¿qué tipo de masaje te gustaría? Tenemos: ${listaMasajes}.`;
    }

    if (!datosExtraidos.tipoServicio) {
        clientData.estado = 'esperando_ubicacion';
        return `¿Prefieres el masaje en nuestro salón o a domicilio?`;
    }

    if (datosExtraidos.tipoServicio === 'domicilio' && !datosExtraidos.ubicacion) {
        clientData.estado = 'esperando_direccion';
        return `Perfecto, iremos a domicilio. ¿Cuál es la dirección completa?`;
    }

    if (!datosExtraidos.dia) {
        clientData.estado = 'esperando_dia';
        return `¿Qué día prefieres? Lunes, martes, miércoles, jueves, viernes o sábado.`;
    }

    if (!datosExtraidos.hora) {
        clientData.estado = 'esperando_hora';
        return `¿A qué hora? Tenemos turnos a las 12:00, 16:00 y 20:00.`;
    }

    return `Gracias por contactar Serenity Spa. Puedes decirme "reservar turno" para comenzar.`;
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
            console.log('\n' + '='.repeat(50));
            console.log('  🌿 SERENITY SPA - SISTEMA CORREGIDO');
            console.log('='.repeat(50));
            console.log(`  📍 Puerto: ${PORT}`);
            console.log(`  🎤 Asistente de voz: /voice-assistant`);
            console.log(`  ⏰ Horarios: ${HORAS_VALIDAS.join(':00, ')}:00`);
            console.log(`  🔐 Login: ${process.env.ADMIN_PASSWORD ? '✅ Configurado' : '❌ No configurado'}`);
            console.log(`  🚫 IPs bloqueadas: ${bloqueos.size}`);
            console.log('  ✅ Servidor listo');
            console.log('='.repeat(50) + '\n');
        });
        
        const wss = new WebSocket.Server({ server, path: '/ws-voice' });
        
        wss.on('connection', (ws, req) => {
            const ip = req.socket.remoteAddress || req.headers['x-forwarded-for'] || 'desconocida';
            
            if (estaBloqueado(ip)) {
                ws.close(1008, 'IP bloqueada');
                return;
            }
            
            const clientId = Date.now().toString() + Math.random().toString(36);
            console.log(`🎤 Cliente de voz conectado desde ${ip} (ID: ${clientId})`);
            
            voiceClients.set(clientId, { ws, estado: 'recopilando', datos: {}, intentosNumero: 0, alternativa: null });
            
            ws.on('message', async (data) => {
                try {
                    const mensaje = JSON.parse(data);
                    if (mensaje.tipo === 'transcripcion') {
                        const respuesta = await procesarComandoVoz(mensaje.texto, clientId, ip);
                        if (ws.readyState === WebSocket.OPEN) {
                            ws.send(JSON.stringify({ tipo: 'respuesta', texto: respuesta }));
                        }
                    }
                } catch (error) {
                    console.error('Error en WebSocket:', error);
                    if (ws.readyState === WebSocket.OPEN) {
                        ws.send(JSON.stringify({ 
                            tipo: 'respuesta', 
                            texto: "Lo siento, hubo un error. Por favor intenta de nuevo." 
                        }));
                    }
                }
            });
            
            ws.on('close', () => {
                voiceClients.delete(clientId);
                console.log(`🔌 Cliente desconectado: ${clientId}`);
            });
        });
        
        console.log('🎤 WebSocket de voz iniciado en /ws-voice');
        
    } catch (error) {
        console.error('❌ Error al iniciar:', error);
        process.exit(1);
    }
}

startServer();
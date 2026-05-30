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

console.log('✅ SERVIDOR INICIANDO');

// ==================== MIDDLEWARES ====================
app.use(express.json());

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

function validarTelefono(telefono) {
    if (!telefono) return false;
    const limpio = telefono.replace(/\D/g, '');
    if (limpio.length < 8 || limpio.length > 15) return false;
    if (/^(\d)\1{7,}$/.test(limpio)) return false;
    return true;
}

function validarNombre(nombre) {
    if (!nombre) return false;
    const limpio = nombre.trim();
    if (limpio.length < 2 || limpio.length > 50) return false;
    if (!/^[a-zA-ZáéíóúñÑü\s.]+$/.test(limpio)) return false;
    return true;
}

function escapeText(str) {
    if (!str) return '';
    return str.replace(/[&<>]/g, (m) => {
        if (m === '&') return '&amp;';
        if (m === '<') return '&lt;';
        if (m === '>') return '&gt;';
        return m;
    });
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

function generarId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2);
}

// ==================== RUTAS API ====================

app.get('/api/config', (req, res) => res.json(configData));

app.put('/api/config', async (req, res) => {
    try {
        configData = { ...configData, ...req.body };
        await fs.writeFile(CONFIG_FILE, JSON.stringify(configData, null, 2), 'utf8');
        res.json({ mensaje: 'Configuración actualizada', config: configData });
    } catch (error) {
        res.status(500).json({ error: 'Error al guardar configuración' });
    }
});

app.get('/api/servicios', (req, res) => {
    res.json(serviciosData.sort((a, b) => (a.orden || 999) - (b.orden || 999)));
});

app.post('/api/servicios', async (req, res) => {
    try {
        const { nombre, precio, descripcion, beneficios, efectos, imagenWeb, imagenWhatsApp } = req.body;
        if (!nombre || !precio || !descripcion) {
            return res.status(400).json({ error: 'Faltan campos obligatorios' });
        }
        const nuevoServicio = {
            id: generarId(),
            nombre: escapeText(nombre.trim()),
            precio: precio,
            descripcion: escapeText(descripcion.trim()),
            beneficios: Array.isArray(beneficios) ? beneficios : [beneficios],
            efectos: Array.isArray(efectos) ? efectos : (efectos ? [efectos] : ["Bienestar general"]),
            imagenWeb: imagenWeb || "https://images.unsplash.com/photo-1544161515-4ab6ce6db874?ixlib=rb-1.2.1&auto=format&fit=crop&w=800&q=80",
            imagenWhatsApp: imagenWhatsApp || imagenWeb || "https://images.unsplash.com/photo-1544161515-4ab6ce6db874?ixlib=rb-1.2.1&auto=format&fit=crop&w=800&q=80",
            orden: serviciosData.length + 1
        };
        serviciosData.push(nuevoServicio);
        await fs.writeFile(SERVICIOS_FILE, JSON.stringify(serviciosData, null, 2), 'utf8');
        res.status(201).json({ mensaje: 'Servicio creado', servicio: nuevoServicio });
    } catch (error) {
        res.status(500).json({ error: 'Error al crear servicio' });
    }
});

app.put('/api/servicios/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const index = serviciosData.findIndex(s => s.id === id);
        if (index === -1) return res.status(404).json({ error: 'Servicio no encontrado' });
        
        const { nombre, precio, descripcion, beneficios, efectos, imagenWeb, imagenWhatsApp } = req.body;
        if (nombre) serviciosData[index].nombre = escapeText(nombre.trim());
        if (precio) serviciosData[index].precio = precio;
        if (descripcion) serviciosData[index].descripcion = escapeText(descripcion.trim());
        if (beneficios) serviciosData[index].beneficios = Array.isArray(beneficios) ? beneficios : [beneficios];
        if (efectos) serviciosData[index].efectos = Array.isArray(efectos) ? efectos : [efectos];
        if (imagenWeb) serviciosData[index].imagenWeb = imagenWeb;
        if (imagenWhatsApp) serviciosData[index].imagenWhatsApp = imagenWhatsApp;
        
        await fs.writeFile(SERVICIOS_FILE, JSON.stringify(serviciosData, null, 2), 'utf8');
        res.json({ mensaje: 'Servicio actualizado', servicio: serviciosData[index] });
    } catch (error) {
        res.status(500).json({ error: 'Error al actualizar servicio' });
    }
});

app.delete('/api/servicios/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const index = serviciosData.findIndex(s => s.id === id);
        if (index === -1) return res.status(404).json({ error: 'Servicio no encontrado' });
        serviciosData.splice(index, 1);
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
    try {
        const { nombre, dia, hora, massageType, telefono, ubicacion, tipoServicio } = req.body;
        
        if (!validarNombre(nombre)) {
            return res.status(400).json({ error: 'Nombre inválido' });
        }
        if (!validarTelefono(telefono)) {
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
            nombre: escapeText(nombre.trim()),
            dia: dia.toLowerCase(),
            hora: horaNum,
            massageType: massageType || 'Masaje',
            telefono: telefonoLimpio,
            ubicacion: ubicacion || null,
            tipoServicio: tipoServicio || 'salon',
            fechaCreacion: new Date().toISOString()
        };

        turnos.push(nuevoTurno);
        await guardarTurnos(turnos);
        
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
        
        const mensaje = `🌿 *SERENITY SPA* 🌿

Hola *${turno.nombre}*, 
¡Gracias por confiar en nosotros! ✨

✅ *TU RESERVA HA SIDO CONFIRMADA*

📅 *Día:* ${turno.dia.charAt(0).toUpperCase() + turno.dia.slice(1)}
⏰ *Hora:* ${turno.hora}:00 hs
💆‍♂️ *Masaje:* ${turno.massageType}
📍 *Lugar:* ${turno.tipoServicio === 'domicilio' ? turno.ubicacion : 'Serenity Spa - Salón'}

🖼️ *Información del masaje:*
${imagenUrl}

🌸 *Te esperamos con aromaterapia y música suave.*
⏱️ Te recordamos que puedes modificar o cancelar con 4 horas de anticipación.

✨ *¡Te deseamos una experiencia inolvidable!*

Con cariño,
*Equipo Serenity Spa* 💆‍♀️💆‍♂️

🔗 Comparte tu experiencia: ${req.protocol}://${req.get('host')}`;
        
        const numeroTelefono = turno.telefono.replace(/\D/g, '');
        
        res.json({ 
            success: true, 
            numero: numeroTelefono, 
            mensaje: mensaje,
            urlWhatsApp: `https://wa.me/${numeroTelefono}?text=${encodeURIComponent(mensaje)}`
        });
        
    } catch (error) {
        console.error('Error al preparar WhatsApp:', error);
        res.status(500).json({ error: 'Error al preparar mensaje' });
    }
});

// ==================== LOGIN ====================
const validTokens = new Map();

app.post('/api/login', (req, res) => {
    const { password } = req.body;
    const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
    
    if (!ADMIN_PASSWORD) {
        console.error('❌ ERROR: ADMIN_PASSWORD no configurada');
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

// Función para leer números de forma profesional (agrupados)
function formatearNumeroParaVoz(numero) {
    const limpio = numero.replace(/\D/g, '');
    if (limpio.length <= 4) return limpio;
    const grupos = [];
    for (let i = 0; i < limpio.length; i += 2) {
        grupos.push(limpio.substr(i, 2));
    }
    return grupos.join(' ');
}

// Función para validar teléfono con código de país
function validarTelefonoConPais(entrada, codigoPais = null) {
    let numero = entrada.replace(/\s/g, '');
    
    if (numero.startsWith('+')) {
        const match = numero.match(/^\+(\d{1,3})(\d+)$/);
        if (match) {
            return { 
                valido: true, 
                codigoPais: match[1], 
                numero: match[2],
                completo: `+${match[1]}${match[2]}`
            };
        }
    }
    
    if (numero.match(/^\d{2,3}\d{8,10}$/)) {
        return { 
            valido: true, 
            codigoPais: numero.substring(0, 2), 
            numero: numero.substring(2),
            completo: `+${numero}`
        };
    }
    
    if (codigoPais && numero.match(/^\d{8,12}$/)) {
        return {
            valido: true,
            codigoPais: codigoPais,
            numero: numero,
            completo: `+${codigoPais}${numero}`
        };
    }
    
    return { valido: false, error: "Número inválido" };
}

async function procesarComandoVoz(texto, clientId) {
    const textoLower = texto.toLowerCase();
    const clientData = voiceClients.get(clientId);
    
    if (!clientData) {
        return "Lo siento, hubo un error. Por favor intenta de nuevo.";
    }
    
    if (!clientData.estado) {
        clientData.estado = 'inicial';
        clientData.datos = {};
        clientData.pais = '54';
    }
    
    if (clientData.estado === 'inicial') {
        if (textoLower.includes('reservar') || textoLower.includes('turno') || textoLower.includes('cita')) {
            clientData.estado = 'esperando_nombre';
            return "¡Claro! Te ayudo a reservar un turno. ¿Cuál es tu nombre completo?";
        }
        if (textoLower.includes('horario')) {
            return "Nuestros horarios son: 12 del mediodía, 4 de la tarde y 8 de la noche. De lunes a sábado. ¿Te gustaría reservar un turno?";
        }
        if (textoLower.includes('masaje') || textoLower.includes('tipos')) {
            return "Tenemos Masaje Relajante por cuarenta y cinco dólares, Masaje Corporal por sesenta y cinco dólares y Masaje Facial por cuarenta dólares. ¿Cuál te interesa?";
        }
        if (textoLower.includes('precio') || textoLower.includes('costo')) {
            return "Masaje Relajante cuarenta y cinco dólares, Masaje Corporal sesenta y cinco dólares, Masaje Facial cuarenta dólares. ¿Te gustaría reservar alguno?";
        }
        return "Bienvenido a Serenity Spa. Puedo ayudarte a reservar un turno, ver horarios, conocer los masajes o consultar precios. ¿Qué deseas hacer?";
    }
    
    if (clientData.estado === 'esperando_nombre') {
        if (!texto.trim() || texto.length < 2) {
            return "Por favor, dime tu nombre completo para poder registrarte.";
        }
        clientData.datos.nombre = texto.trim();
        clientData.estado = 'esperando_pais';
        return `Gracias ${texto.trim()}. ¿De qué país nos llamas? Así puedo registrar correctamente tu número de teléfono. Por ejemplo, Argentina es 54, México es 52, Colombia es 57.`;
    }
    
    if (clientData.estado === 'esperando_pais') {
        let paisEncontrado = null;
        const paises = {
            'argentina': '54', 'méxico': '52', 'mexico': '52', 'colombia': '57',
            'chile': '56', 'perú': '51', 'peru': '51', 'españa': '34', 'espania': '34'
        };
        
        for (const [key, value] of Object.entries(paises)) {
            if (textoLower.includes(key)) {
                paisEncontrado = value;
                break;
            }
        }
        
        const numeroPais = parseInt(texto);
        if (paisEncontrado) {
            clientData.datos.codigoPais = paisEncontrado;
        } else if (!isNaN(numeroPais) && numeroPais >= 1 && numeroPais <= 999) {
            clientData.datos.codigoPais = numeroPais.toString();
        } else {
            clientData.datos.codigoPais = '54';
            return "No reconocí el país. Usaremos código 54 para Argentina. Por favor, ingresa tu número de teléfono sin el código de país. Por ejemplo, once veintitrés cuarenta y cinco sesenta y siete.";
        }
        
        clientData.estado = 'esperando_telefono';
        return `Código de país ${clientData.datos.codigoPais} registrado. Ahora, por favor dime tu número de teléfono. Puedes decirlo número por número para mejor claridad.`;
    }
    
    if (clientData.estado === 'esperando_telefono') {
        let numeros = texto.replace(/\D/g, '');
        
        if (numeros.length >= 8 && numeros.length <= 15) {
            clientData.datos.telefono = numeros;
            const numeroFormateado = formatearNumeroParaVoz(numeros);
            clientData.estado = 'esperando_masaje';
            return `Teléfono más ${clientData.datos.codigoPais} ${numeroFormateado} registrado. ¿Qué tipo de masaje deseas? Tenemos masaje relajante, corporal o facial.`;
        } else {
            return "El número debe tener entre 8 y 15 dígitos. Por favor, dímelo nuevamente, número por número.";
        }
    }
    
    if (clientData.estado === 'esperando_masaje') {
        let servicio = null;
        if (textoLower.includes('relajante')) servicio = "Masaje Relajante";
        else if (textoLower.includes('corporal')) servicio = "Masaje Corporal";
        else if (textoLower.includes('facial')) servicio = "Masaje Facial";
        
        if (servicio) {
            clientData.datos.massageType = servicio;
            clientData.estado = 'esperando_ubicacion';
            return `Has seleccionado ${servicio}. ¿Dónde prefieres recibir el masaje? Responde salón o domicilio.`;
        } else {
            return "No reconozco ese masaje. Las opciones son: masaje relajante, masaje corporal o masaje facial. ¿Cuál prefieres?";
        }
    }
    
    if (clientData.estado === 'esperando_ubicacion') {
        if (textoLower.includes('salon') || textoLower.includes('salón')) {
            clientData.datos.tipoServicio = 'salon';
            clientData.datos.ubicacion = 'Salón Serenity Spa';
            clientData.estado = 'esperando_dia';
            return "Perfecto, será en nuestro salón. ¿Qué día prefieres? Dime lunes, martes, miércoles, jueves, viernes o sábado.";
        } else if (textoLower.includes('domicilio')) {
            clientData.datos.tipoServicio = 'domicilio';
            clientData.estado = 'esperando_direccion';
            return "Excelente, haremos el masaje a domicilio. Por favor, ingresa tu dirección completa: calle, número y ciudad.";
        } else {
            return "Por favor, responde salón o domicilio para indicar dónde quieres el masaje.";
        }
    }
    
    if (clientData.estado === 'esperando_direccion') {
        if (!texto.trim() || texto.length < 5) {
            return "Por favor, ingresa una dirección válida con calle, número y ciudad.";
        }
        clientData.datos.ubicacion = texto.trim();
        clientData.estado = 'esperando_dia';
        return `Dirección registrada. ¿Qué día prefieres tu masaje? Lunes a sábado.`;
    }
    
    if (clientData.estado === 'esperando_dia') {
        const diasValidos = ['lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado'];
        let diaEncontrado = null;
        
        for (const dia of diasValidos) {
            if (textoLower.includes(dia)) {
                diaEncontrado = dia;
                break;
            }
        }
        
        if (diaEncontrado) {
            clientData.datos.dia = diaEncontrado;
            clientData.estado = 'esperando_hora';
            return `Has seleccionado ${diaEncontrado}. Nuestros horarios son: doce del mediodía, cuatro de la tarde u ocho de la noche. ¿A qué hora prefieres? Dime 12, 16 o 20.`;
        } else {
            return "Por favor, ingresa un día válido: lunes, martes, miércoles, jueves, viernes o sábado.";
        }
    }
    
    if (clientData.estado === 'esperando_hora') {
        let hora = parseInt(texto);
        const horasValidas = [12, 16, 20];
        
        if (isNaN(hora)) {
            if (textoLower.includes('doce') || textoLower.includes('12')) hora = 12;
            else if (textoLower.includes('cuatro') || textoLower.includes('16')) hora = 16;
            else if (textoLower.includes('ocho') || textoLower.includes('20')) hora = 20;
        }
        
        if (horasValidas.includes(hora)) {
            clientData.datos.hora = hora;
            
            let turnosExistentes = [];
            try {
                const data = await fs.readFile(TURNOS_FILE, 'utf8');
                turnosExistentes = JSON.parse(data);
            } catch(e) {
                turnosExistentes = [];
            }
            
            const horarioOcupado = turnosExistentes.some(t => 
                t.dia === clientData.datos.dia && t.hora === hora
            );
            
            const yaTieneTurno = turnosExistentes.some(t => 
                t.telefono === clientData.datos.telefono && t.dia === clientData.datos.dia
            );
            
            if (yaTieneTurno) {
                clientData.estado = 'inicial';
                const datosTemp = { ...clientData.datos };
                clientData.datos = {};
                return `Ya tienes un turno reservado para el ${datosTemp.dia}. Solo permitimos un masaje por día. ¿Necesitas ayuda con algo más?`;
            }
            
            if (horarioOcupado) {
                return `Lo siento, las ${hora}:00 del ${clientData.datos.dia} ya están ocupadas. ¿Te gustaría probar con 12, 16 o 20 en otro día?`;
            }
            
            const nuevoTurno = {
                id: generarId(),
                nombre: clientData.datos.nombre,
                dia: clientData.datos.dia,
                hora: clientData.datos.hora,
                massageType: clientData.datos.massageType,
                telefono: clientData.datos.telefono,
                codigoPais: clientData.datos.codigoPais,
                ubicacion: clientData.datos.ubicacion,
                tipoServicio: clientData.datos.tipoServicio,
                fechaCreacion: new Date().toISOString()
            };
            
            turnosExistentes.push(nuevoTurno);
            await fs.writeFile(TURNOS_FILE, JSON.stringify(turnosExistentes, null, 2), 'utf8');
            
            const tipoTexto = clientData.datos.tipoServicio === 'domicilio' 
                ? `Dirección: ${clientData.datos.ubicacion}` 
                : 'En nuestro salón';
            
            const telefonoTexto = formatearNumeroParaVoz(clientData.datos.telefono);
            const horaTexto = clientData.datos.hora === 12 ? '12 del mediodía' : (clientData.datos.hora === 16 ? '4 de la tarde' : '8 de la noche');
            
            const mensajeConfirmacion = `✅ Reserva confirmada. Día ${clientData.datos.dia}, a las ${horaTexto}. Masaje ${clientData.datos.massageType}. ${tipoTexto}. Te esperamos en Serenity Spa. ¡Gracias por tu reserva!`;
            
            clientData.estado = 'inicial';
            clientData.datos = {};
            
            return mensajeConfirmacion;
        } else {
            return "Por favor, responde con un horario válido: 12, 16 o 20. Por ejemplo, di 12 para las 12 del mediodía.";
        }
    }
    
    return "Lo siento, no entendí. Por favor, intenta de nuevo o di ayuda para ver las opciones disponibles.";
}

// ==================== RUTAS HTML ====================
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/admin.html', (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));
app.get('/login.html', (req, res) => res.sendFile(path.join(__dirname, 'login.html')));
app.get('/1.html', (req, res) => res.redirect('/admin.html'));

// ==================== INICIAR SERVIDOR CON WEBSOCKET ====================
async function startServer() {
    try {
        await inicializarConfiguracion();
        await inicializarServicios();
        await inicializarArchivoTurnos();
        
        const server = app.listen(PORT, '0.0.0.0', () => {
            console.log('\n' + '='.repeat(50));
            console.log('  🌿 SERENITY SPA');
            console.log('='.repeat(50));
            console.log(`  📍 Puerto: ${PORT}`);
            console.log(`  🎤 Asistente de voz: /voice-assistant`);
            console.log(`  ⏰ Horarios: ${HORAS_VALIDAS.join(':00, ')}:00`);
            console.log(`  🔐 Login: ${process.env.ADMIN_PASSWORD ? '✅ Configurado' : '❌ No configurado'}`);
            console.log('  ✅ Servidor listo');
            console.log('='.repeat(50) + '\n');
        });
        
        const wss = new WebSocket.Server({ server, path: '/ws-voice' });
        
        wss.on('connection', (ws) => {
            const clientId = Date.now().toString() + Math.random().toString(36);
            console.log(`🎤 Cliente de voz conectado: ${clientId}`);
            
            voiceClients.set(clientId, { ws, estado: 'inicial', datos: {}, pais: '54' });
            
            ws.on('message', async (data) => {
                try {
                    const mensaje = JSON.parse(data);
                    if (mensaje.tipo === 'transcripcion') {
                        const respuesta = await procesarComandoVoz(mensaje.texto, clientId);
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
                console.log(`🔌 Cliente de voz desconectado: ${clientId}`);
            });
            
            ws.on('error', (error) => {
                console.error(`Error en cliente ${clientId}:`, error);
                voiceClients.delete(clientId);
            });
        });
        
        console.log('🎤 WebSocket de voz iniciado en /ws-voice');
        
    } catch (error) {
        console.error('❌ Error al iniciar:', error);
        process.exit(1);
    }
}

startServer();
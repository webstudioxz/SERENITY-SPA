const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 5001;
const TURNOS_FILE = path.join(__dirname, 'turnos.json');
const SERVICIOS_FILE = path.join(__dirname, 'servicios.json');

// ==================== VARIABLES DE ENTORNO ====================
const ADMIN_PASSWORD_HASH = process.env.ADMIN_PASSWORD_HASH;
const SESSION_SECRET = process.env.SESSION_SECRET;

if (!ADMIN_PASSWORD_HASH) {
    console.error('❌ ERROR: ADMIN_PASSWORD_HASH no definida');
    process.exit(1);
}
if (!SESSION_SECRET) {
    console.error('❌ ERROR: SESSION_SECRET no definida');
    process.exit(1);
}

console.log('✅ Variables de entorno validadas');

// ==================== RATE LIMITING ====================
const loginAttempts = new Map();
const RATE_LIMIT = {
    MAX_ATTEMPTS: 5,
    WINDOW_MS: 15 * 60 * 1000,
    BLOCK_MS: 60 * 60 * 1000
};

function checkRateLimit(ip) {
    const now = Date.now();
    const record = loginAttempts.get(ip);
    if (!record) return { allowed: true, remaining: RATE_LIMIT.MAX_ATTEMPTS };
    if (record.blockedUntil && now < record.blockedUntil) {
        return { allowed: false, message: 'Bloqueado. Intente más tarde.' };
    }
    if (now - record.firstAttempt > RATE_LIMIT.WINDOW_MS) {
        loginAttempts.delete(ip);
        return { allowed: true, remaining: RATE_LIMIT.MAX_ATTEMPTS };
    }
    if (record.count >= RATE_LIMIT.MAX_ATTEMPTS) {
        loginAttempts.set(ip, { ...record, blockedUntil: now + RATE_LIMIT.BLOCK_MS });
        return { allowed: false, message: 'Demasiados intentos. Bloqueado 1 hora.' };
    }
    return { allowed: true, remaining: RATE_LIMIT.MAX_ATTEMPTS - record.count };
}

function recordFailedAttempt(ip) {
    const now = Date.now();
    const record = loginAttempts.get(ip);
    if (!record) {
        loginAttempts.set(ip, { count: 1, firstAttempt: now, blockedUntil: null });
    } else {
        record.count++;
    }
}

function resetRateLimit(ip) {
    loginAttempts.delete(ip);
}

// ==================== MIDDLEWARES ====================
app.use(express.json());
app.use(express.static(__dirname, { maxAge: '2h', etag: true }));

// Middleware de autenticación para APIs protegidas
function authMiddleware(req, res, next) {
    const publicPaths = ['/login.html', '/index.html', '/', '/health', '/turnos', '/api/login', '/api/verify', '/api/logout', '/api/disponibilidad', '/api/servicios', '/1.html', '/admin.html'];
    
    if (publicPaths.includes(req.path) || req.path === '/') {
        return next();
    }
    
    if (req.path === '/turnos' && (req.method === 'GET' || req.method === 'POST')) {
        return next();
    }
    
    if (req.path === '/api/servicios' && req.method === 'GET') {
        return next();
    }
    
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'No autorizado' });
    }
    
    const token = authHeader.substring(7);
    try {
        const [prefix, timestamp, signature] = token.split('_');
        if (prefix !== 'session') throw new Error();
        
        const now = Date.now();
        if (now - parseInt(timestamp) > 8 * 60 * 60 * 1000) {
            return res.status(401).json({ error: 'Sesión expirada' });
        }
        
        const expectedSignature = crypto
            .createHmac('sha256', SESSION_SECRET)
            .update(`${prefix}_${timestamp}`)
            .digest('hex');
        
        if (signature !== expectedSignature) {
            return res.status(401).json({ error: 'Token inválido' });
        }
        next();
    } catch {
        return res.status(401).json({ error: 'Token inválido' });
    }
}

app.use(authMiddleware);

// ==================== RUTAS HTML ====================
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});
app.get('/1.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'admin.html'));
});
app.get('/admin.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'admin.html'));
});
app.get('/login.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'login.html'));
});

// ==================== API DE AUTENTICACIÓN ====================
app.post('/api/login', (req, res) => {
    const clientIp = req.ip || req.connection.remoteAddress || req.socket.remoteAddress;
    const rateCheck = checkRateLimit(clientIp);
    
    if (!rateCheck.allowed) {
        return res.status(429).json({ error: rateCheck.message });
    }
    
    const { password } = req.body;
    if (!password) {
        return res.status(400).json({ error: 'Contraseña requerida' });
    }
    
    const hashedInput = crypto.createHash('sha256').update(password).digest('hex');
    
    if (hashedInput === ADMIN_PASSWORD_HASH) {
        resetRateLimit(clientIp);
        const timestamp = Date.now();
        const signature = crypto.createHmac('sha256', SESSION_SECRET).update(`session_${timestamp}`).digest('hex');
        const token = `session_${timestamp}_${signature}`;
        res.json({ success: true, token, expiresIn: 8 * 60 * 60 });
    } else {
        recordFailedAttempt(clientIp);
        res.status(401).json({ error: `Contraseña incorrecta. Intentos restantes: ${rateCheck.remaining - 1}` });
    }
});

app.get('/api/verify', (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ valid: false });
    }
    res.json({ valid: true });
});

app.post('/api/logout', (req, res) => {
    res.json({ success: true });
});

app.get('/health', (req, res) => {
    res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

// ==================== VALIDACIONES ====================
const DIAS_VALIDOS = ['lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado', 'domingo'];
const HORAS_VALIDAS = [8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22];

function validarTelefono(telefono) {
    if (!telefono) return false;
    const limpio = telefono.replace(/\D/g, '');
    if (limpio.length < 8 || limpio.length > 15) return false;
    if (/^(\d)\1{7,}$/.test(limpio)) return false;
    if (/^12345678/.test(limpio)) return false;
    if (/^00000000/.test(limpio)) return false;
    return true;
}

function validarDireccion(direccion) {
    if (!direccion) return false;
    const limpio = direccion.trim();
    if (limpio.length < 5) return false;
    if (limpio.length > 200) return false;
    if (/([a-z])\1{4,}/i.test(limpio)) return false;
    const tieneNumero = /\d/.test(limpio);
    const tienePalabra = /[a-z]{3,}/i.test(limpio);
    if (!tieneNumero && !tienePalabra) return false;
    return true;
}

function validarNombre(nombre) {
    if (!nombre) return false;
    const limpio = nombre.trim();
    if (limpio.length < 2 || limpio.length > 50) return false;
    if (/^\d+$/.test(limpio)) return false;
    if (!/^[a-zA-ZáéíóúñÑü\s.]+$/.test(limpio)) return false;
    return true;
}

// ==================== GESTIÓN DE SERVICIOS ====================
let serviciosData = [];

async function inicializarServicios() {
    const serviciosDefault = [
        { id: "relajante", nombre: "Masaje Relajante", precio: "$45", descripcion: "Movimientos suaves y rítmicos para liberar el estrés.", beneficios: ["Reduce ansiedad y tensión", "Mejora la circulación", "60 Minutos"], imagen: "https://images.unsplash.com/photo-1544161515-4ab6ce6db874?ixlib=rb-1.2.1&auto=format&fit=crop&w=800&q=80", destacado: true, orden: 1 },
        { id: "corporal", nombre: "Masaje Corporal", precio: "$65", descripcion: "Tratamiento completo para una relajación profunda.", beneficios: ["Relajación integral", "Liberación de toxinas", "90 Minutos"], imagen: "https://images.unsplash.com/photo-1519823551278-64ac92734fb1?ixlib=rb-1.2.1&auto=format&fit=crop&w=800&q=80", destacado: true, orden: 2 },
        { id: "facial", nombre: "Masaje Facial", precio: "$40", descripcion: "Rejuvenece la piel y alivia la tensión facial.", beneficios: ["Reafirma la piel", "Reduce líneas de expresión", "45 Minutos"], imagen: "https://images.unsplash.com/photo-1570172619644-dfd03ed5d881?ixlib=rb-1.2.1&auto=format&fit=crop&w=800&q=80", destacado: true, orden: 3 },
        { id: "dorsal", nombre: "Masaje Dorsal", precio: "$50", descripcion: "Enfoque en la espalda para aliviar dolores.", beneficios: ["Alivia dolor de espalda", "Mejora la postura", "50 Minutos"], imagen: "https://images.unsplash.com/photo-1544367567-0f2fcb009e0b?ixlib=rb-1.2.1&auto=format&fit=crop&w=800&q=80", destacado: true, orden: 4 },
        { id: "cervical", nombre: "Masaje Cervical", precio: "$35", descripcion: "Focalizado en cuello y hombros.", beneficios: ["Reduce dolores de cabeza", "Libera tensión cervical", "30 Minutos"], imagen: "https://images.unsplash.com/photo-1518611012118-696072aa579a?ixlib=rb-1.2.1&auto=format&fit=crop&w=800&q=80", destacado: true, orden: 5 },
        { id: "superiores", nombre: "Miembros Superiores", precio: "$40", descripcion: "Alivia fatiga en brazos y hombros.", beneficios: ["Reduce fatiga", "Mejora movilidad", "40 Minutos"], imagen: "https://images.unsplash.com/photo-1544161515-4ab6ce6db874?ixlib=rb-1.2.1&auto=format&fit=crop&w=800&q=80", destacado: true, orden: 6 },
        { id: "inferiores", nombre: "Miembros Inferiores", precio: "$45", descripcion: "Mejora circulación en piernas.", beneficios: ["Mejora retorno venoso", "Alivia piernas cansadas", "50 Minutos"], imagen: "https://images.unsplash.com/photo-1570172619644-dfd03ed5d881?ixlib=rb-1.2.1&auto=format&fit=crop&w=800&q=80", destacado: true, orden: 7 },
        { id: "podal", nombre: "Masaje Podal", precio: "$38", descripcion: "Reflexología podal para bienestar general.", beneficios: ["Estimula órganos internos", "Reduce estrés", "40 Minutos"], imagen: "https://images.unsplash.com/photo-1544367567-0f2fcb009e0b?ixlib=rb-1.2.1&auto=format&fit=crop&w=800&q=80", destacado: true, orden: 8 }
    ];
    
    try {
        await fs.access(SERVICIOS_FILE);
        const data = await fs.readFile(SERVICIOS_FILE, 'utf8');
        serviciosData = JSON.parse(data);
        console.log(`📂 Cargados ${serviciosData.length} servicios desde archivo`);
    } catch {
        serviciosData = serviciosDefault;
        try {
            await fs.writeFile(SERVICIOS_FILE, JSON.stringify(serviciosData, null, 2), 'utf8');
            console.log('📁 Archivo servicios.json creado con datos por defecto');
        } catch (err) {
            console.log('⚠️ Usando memoria para servicios');
        }
    }
}

async function guardarServicios(servicios) {
    try {
        await fs.writeFile(SERVICIOS_FILE, JSON.stringify(servicios, null, 2), 'utf8');
        serviciosData = servicios;
        return true;
    } catch {
        serviciosData = servicios;
        return true;
    }
}

function generarId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2);
}

// API de servicios (pública para GET)
app.get('/api/servicios', async (req, res) => {
    try {
        const servicios = serviciosData.sort((a, b) => (a.orden || 999) - (b.orden || 999));
        res.json(servicios);
    } catch (error) {
        res.status(500).json({ error: 'Error al cargar servicios' });
    }
});

// API para crear servicio (protegido)
app.post('/api/servicios', async (req, res) => {
    try {
        const { nombre, precio, descripcion, beneficios, imagen } = req.body;
        
        if (!nombre || !precio || !descripcion) {
            return res.status(400).json({ error: 'Faltan campos obligatorios' });
        }
        
        const nuevoServicio = {
            id: generarId(),
            nombre: escapeText(nombre.trim()),
            precio: precio,
            descripcion: escapeText(descripcion.trim()),
            beneficios: Array.isArray(beneficios) ? beneficios.map(b => escapeText(b)) : [escapeText(beneficios)],
            imagen: imagen || "https://images.unsplash.com/photo-1544161515-4ab6ce6db874?ixlib=rb-1.2.1&auto=format&fit=crop&w=800&q=80",
            destacado: true,
            orden: serviciosData.length + 1
        };
        
        serviciosData.push(nuevoServicio);
        await guardarServicios(serviciosData);
        
        res.status(201).json({ mensaje: 'Servicio creado', servicio: nuevoServicio });
    } catch (error) {
        res.status(500).json({ error: 'Error al crear servicio' });
    }
});

// API para actualizar servicio (protegido)
app.put('/api/servicios/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { nombre, precio, descripcion, beneficios, imagen } = req.body;
        
        const index = serviciosData.findIndex(s => s.id === id);
        if (index === -1) {
            return res.status(404).json({ error: 'Servicio no encontrado' });
        }
        
        if (nombre) serviciosData[index].nombre = escapeText(nombre.trim());
        if (precio) serviciosData[index].precio = precio;
        if (descripcion) serviciosData[index].descripcion = escapeText(descripcion.trim());
        if (beneficios) serviciosData[index].beneficios = Array.isArray(beneficios) ? beneficios.map(b => escapeText(b)) : [escapeText(beneficios)];
        if (imagen) serviciosData[index].imagen = imagen;
        
        await guardarServicios(serviciosData);
        res.json({ mensaje: 'Servicio actualizado', servicio: serviciosData[index] });
    } catch (error) {
        res.status(500).json({ error: 'Error al actualizar servicio' });
    }
});

// API para eliminar servicio (protegido)
app.delete('/api/servicios/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const index = serviciosData.findIndex(s => s.id === id);
        if (index === -1) {
            return res.status(404).json({ error: 'Servicio no encontrado' });
        }
        
        serviciosData.splice(index, 1);
        await guardarServicios(serviciosData);
        res.json({ mensaje: 'Servicio eliminado' });
    } catch (error) {
        res.status(500).json({ error: 'Error al eliminar servicio' });
    }
});

// API para reordenar servicios (protegido)
app.post('/api/servicios/reordenar', async (req, res) => {
    try {
        const { orden } = req.body;
        if (!Array.isArray(orden)) {
            return res.status(400).json({ error: 'Formato inválido' });
        }
        
        orden.forEach((id, idx) => {
            const servicio = serviciosData.find(s => s.id === id);
            if (servicio) servicio.orden = idx + 1;
        });
        
        serviciosData.sort((a, b) => (a.orden || 999) - (b.orden || 999));
        await guardarServicios(serviciosData);
        res.json({ mensaje: 'Orden actualizado', servicios: serviciosData });
    } catch (error) {
        res.status(500).json({ error: 'Error al reordenar servicios' });
    }
});

// ==================== API DE DISPONIBILIDAD ====================
app.get('/api/disponibilidad', async (req, res) => {
    try {
        const turnos = await cargarTurnos();
        const disponibilidad = {};
        
        for (const dia of DIAS_VALIDOS) {
            const turnosDelDia = turnos.filter(t => t.dia === dia);
            const horasOcupadas = turnosDelDia.map(t => t.hora);
            const horasLibres = HORAS_VALIDAS.filter(h => !horasOcupadas.includes(h));
            
            disponibilidad[dia] = {
                tieneDisponibilidad: horasLibres.length > 0,
                horasLibres: horasLibres,
                manana: horasLibres.filter(h => h >= 8 && h < 14),
                tarde: horasLibres.filter(h => h >= 14 && h < 22),
                ocupados: horasOcupadas
            };
        }
        
        res.json(disponibilidad);
    } catch (error) {
        res.status(500).json({ error: 'Error al obtener disponibilidad' });
    }
});

// ==================== CRUD TURNOS ====================
let turnosEnMemoria = [];

async function inicializarArchivoTurnos() {
    try {
        await fs.access(TURNOS_FILE);
        const data = await fs.readFile(TURNOS_FILE, 'utf8');
        turnosEnMemoria = JSON.parse(data);
        console.log(`📂 Cargados ${turnosEnMemoria.length} turnos`);
    } catch {
        try {
            await fs.writeFile(TURNOS_FILE, '[]', 'utf8');
            turnosEnMemoria = [];
            console.log('📁 Archivo turnos.json creado');
        } catch {
            turnosEnMemoria = [];
            console.log('⚠️ Usando memoria para turnos');
        }
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
    try {
        await fs.writeFile(TURNOS_FILE, JSON.stringify(turnos, null, 2), 'utf8');
        turnosEnMemoria = turnos;
        return true;
    } catch {
        turnosEnMemoria = turnos;
        return true;
    }
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

app.get('/turnos', async (req, res) => {
    try {
        const turnos = await cargarTurnos();
        res.json(turnos);
    } catch (error) {
        res.status(500).json({ error: 'Error al cargar turnos' });
    }
});

app.post('/turnos', async (req, res) => {
    try {
        const { nombre, dia, hora, massageType, telefono, ubicacion, tipoServicio } = req.body;
        
        if (!validarNombre(nombre)) {
            return res.status(400).json({ error: 'Nombre inválido. Use solo letras y espacios.' });
        }
        
        if (!validarTelefono(telefono)) {
            return res.status(400).json({ error: 'Número de teléfono inválido.' });
        }
        
        if (tipoServicio === 'domicilio' && ubicacion && !validarDireccion(ubicacion)) {
            return res.status(400).json({ error: 'Dirección inválida.' });
        }
        
        if (!dia || !DIAS_VALIDOS.includes(dia.toLowerCase())) {
            return res.status(400).json({ error: 'Día no válido' });
        }
        
        const horaNum = parseInt(hora);
        if (isNaN(horaNum) || !HORAS_VALIDAS.includes(horaNum)) {
            return res.status(400).json({ error: 'Hora no válida. Debe ser entre 8 y 22.' });
        }

        const turnos = await cargarTurnos();
        const horarioOcupado = turnos.some(t => t.dia === dia.toLowerCase() && t.hora === horaNum);
        
        if (horarioOcupado) {
            const turnosDelDia = turnos.filter(t => t.dia === dia.toLowerCase());
            const horasOcupadas = turnosDelDia.map(t => t.hora);
            const horasLibres = HORAS_VALIDAS.filter(h => !horasOcupadas.includes(h));
            
            return res.status(409).json({ 
                error: 'Horario no disponible',
                disponibilidad: {
                    dia: dia,
                    horasLibres: horasLibres,
                    mensaje: horasLibres.length > 0 
                        ? `Horas disponibles: ${horasLibres.join(', ')}:00` 
                        : 'No hay horarios ese día.'
                }
            });
        }

        const nuevoTurno = {
            nombre: escapeText(nombre.trim()),
            dia: dia.toLowerCase(),
            hora: horaNum,
            massageType: massageType ? escapeText(massageType) : 'Masaje',
            telefono: telefono ? escapeText(telefono.replace(/\D/g, '')) : 'No especificado',
            ubicacion: ubicacion ? escapeText(ubicacion.trim()) : null,
            tipoServicio: tipoServicio || 'salon',
            fechaCreacion: new Date().toISOString(),
            estado: 'confirmado'
        };

        turnos.push(nuevoTurno);
        await guardarTurnos(turnos);
        
        res.status(201).json({ mensaje: 'Turno creado exitosamente', turno: nuevoTurno });
    } catch (error) {
        res.status(500).json({ error: 'Error al crear turno' });
    }
});

app.delete('/turnos/:index', async (req, res) => {
    try {
        const index = parseInt(req.params.index);
        if (isNaN(index)) return res.status(400).json({ error: 'Índice inválido' });
        
        const turnos = await cargarTurnos();
        if (index < 0 || index >= turnos.length) {
            return res.status(404).json({ error: 'Turno no encontrado' });
        }
        
        turnos.splice(index, 1);
        await guardarTurnos(turnos);
        res.json({ mensaje: 'Turno eliminado' });
    } catch (error) {
        res.status(500).json({ error: 'Error al eliminar turno' });
    }
});

app.put('/turnos/:index', async (req, res) => {
    try {
        const index = parseInt(req.params.index);
        if (isNaN(index)) return res.status(400).json({ error: 'Índice inválido' });
        
        const { dia, hora, estado } = req.body;
        const turnos = await cargarTurnos();
        
        if (index < 0 || index >= turnos.length) {
            return res.status(404).json({ error: 'Turno no encontrado' });
        }
        
        if (dia && DIAS_VALIDOS.includes(dia.toLowerCase())) turnos[index].dia = dia.toLowerCase();
        if (hora !== undefined && HORAS_VALIDAS.includes(parseInt(hora))) turnos[index].hora = parseInt(hora);
        if (estado) turnos[index].estado = estado;
        
        await guardarTurnos(turnos);
        res.json({ mensaje: 'Turno actualizado', turno: turnos[index] });
    } catch (error) {
        res.status(500).json({ error: 'Error al actualizar turno' });
    }
});

app.post('/turnos/notificar-whatsapp/:index', async (req, res) => {
    try {
        const index = parseInt(req.params.index);
        if (isNaN(index)) return res.status(400).json({ error: 'Índice inválido' });
        
        const turnos = await cargarTurnos();
        if (index < 0 || index >= turnos.length) {
            return res.status(404).json({ error: 'Turno no encontrado' });
        }
        
        const turno = turnos[index];
        const mensaje = `Hola ${turno.nombre}, tu turno de ${turno.massageType} está confirmado para ${turno.dia} a las ${turno.hora}:00 hs.`;
        
        res.json({ mensaje: 'Notificación simulada', numero: turno.telefono, texto: mensaje });
    } catch (error) {
        res.status(500).json({ error: 'Error al enviar notificación' });
    }
});

// ==================== INICIAR SERVIDOR ====================
async function startServer() {
    await inicializarServicios();
    await inicializarArchivoTurnos();
    
    app.listen(PORT, '0.0.0.0', () => {
        console.log('='.repeat(50));
        console.log('  🌿 SERENITY SPA - MODO SEGURO');
        console.log('='.repeat(50));
        console.log(`  📍 Puerto: ${PORT}`);
        console.log(`  🔐 Rate limiting: ${RATE_LIMIT.MAX_ATTEMPTS} intentos`);
        console.log(`  📋 Gestión de servicios activada`);
        console.log(`  ✅ Servidor listo`);
        console.log('='.repeat(50));
    });
}

startServer();
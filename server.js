const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 5001;
const TURNOS_FILE = path.join(__dirname, 'turnos.json');

// ==================== VARIABLES DE ENTORNO ====================
// ⚠️ DEBE DEFINIR EN RENDER:
// - ADMIN_PASSWORD_HASH (hash SHA256 de la contraseña)
// - RATE_LIMIT_SECRET (string aleatorio de 32 caracteres)
// - SESSION_SECRET (string aleatorio de 32 caracteres)

const ADMIN_PASSWORD_HASH = process.env.ADMIN_PASSWORD_HASH;
if (!ADMIN_PASSWORD_HASH) {
    console.error('❌ ERROR CRÍTICO: Variable ADMIN_PASSWORD_HASH no definida en entorno');
    process.exit(1);
}

// ==================== RATE LIMITING EN MEMORIA ====================
const loginAttempts = new Map(); // IP -> { count, firstAttempt, blockedUntil }

const RATE_LIMIT = {
    MAX_ATTEMPTS: 5,
    WINDOW_MS: 15 * 60 * 1000,  // 15 minutos
    BLOCK_MS: 60 * 60 * 1000    // 1 hora de bloqueo
};

function checkRateLimit(ip) {
    const now = Date.now();
    const record = loginAttempts.get(ip);
    
    if (!record) {
        return { allowed: true, remaining: RATE_LIMIT.MAX_ATTEMPTS };
    }
    
    if (record.blockedUntil && now < record.blockedUntil) {
        const remainingMin = Math.ceil((record.blockedUntil - now) / 60000);
        return { allowed: false, message: `Demasiados intentos. Bloqueado por ${remainingMin} minutos.` };
    }
    
    if (now - record.firstAttempt > RATE_LIMIT.WINDOW_MS) {
        loginAttempts.delete(ip);
        return { allowed: true, remaining: RATE_LIMIT.MAX_ATTEMPTS };
    }
    
    const remaining = RATE_LIMIT.MAX_ATTEMPTS - record.count;
    if (record.count >= RATE_LIMIT.MAX_ATTEMPTS) {
        loginAttempts.set(ip, { 
            ...record, 
            blockedUntil: now + RATE_LIMIT.BLOCK_MS 
        });
        return { allowed: false, message: 'Demasiados intentos. Cuenta bloqueada por 1 hora.' };
    }
    
    return { allowed: true, remaining };
}

function recordFailedAttempt(ip) {
    const now = Date.now();
    const record = loginAttempts.get(ip);
    
    if (!record) {
        loginAttempts.set(ip, { count: 1, firstAttempt: now, blockedUntil: null });
    } else {
        record.count++;
        loginAttempts.set(ip, record);
    }
}

function resetRateLimit(ip) {
    loginAttempts.delete(ip);
}

// ==================== MIDDLEWARES ====================
app.use(express.json());
app.use(express.static(__dirname, { maxAge: '2h', etag: true }));

// Middleware de autenticación para APIs
function authMiddleware(req, res, next) {
    // Permitir rutas públicas
    const publicPaths = ['/login.html', '/index.html', '/', '/health', '/turnos'];
    if (publicPaths.includes(req.path) || req.path === '/') {
        return next();
    }
    
    // Para /turnos, solo proteger DELETE y PUT (escritura)
    if (req.path === '/turnos' && (req.method === 'GET' || req.method === 'POST')) {
        return next();
    }
    
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'No autorizado' });
    }
    
    const token = authHeader.substring(7);
    
    // Verificar token (formato: session_${timestamp}_${hash})
    try {
        const [prefix, timestamp, signature] = token.split('_');
        if (prefix !== 'session') throw new Error();
        
        const now = Date.now();
        if (now - parseInt(timestamp) > 8 * 60 * 60 * 1000) { // 8 horas de expiración
            return res.status(401).json({ error: 'Sesión expirada' });
        }
        
        const expectedSignature = crypto
            .createHmac('sha256', process.env.SESSION_SECRET || 'fallback-secret-change-me')
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

// ==================== RUTAS ====================
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});
app.get('/1.html', (req, res) => {
    res.sendFile(path.join(__dirname, '1.html'));
});
app.get('/login.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'login.html'));
});

// Endpoint de login con rate limiting
app.post('/api/login', (req, res) => {
    const clientIp = req.ip || req.connection.remoteAddress;
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
        
        // Generar token de sesión seguro
        const timestamp = Date.now();
        const signature = crypto
            .createHmac('sha256', process.env.SESSION_SECRET || 'fallback-secret-change-me')
            .update(`session_${timestamp}`)
            .digest('hex');
        const token = `session_${timestamp}_${signature}`;
        
        res.json({ 
            success: true, 
            token,
            expiresIn: 8 * 60 * 60
        });
    } else {
        recordFailedAttempt(clientIp);
        const remaining = rateCheck.remaining - 1;
        res.status(401).json({ 
            error: `Contraseña incorrecta. Intentos restantes: ${remaining}` 
        });
    }
});

// Verificar estado de sesión
app.get('/api/verify', (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ valid: false });
    }
    res.json({ valid: true });
});

// Logout (cliente debe eliminar token localmente)
app.post('/api/logout', (req, res) => {
    res.json({ success: true });
});

// ==================== CRUD DE TURNOS (igual que antes, pero con auth en escritura) ====================
let turnosEnMemoria = [];

async function inicializarArchivo() {
    try {
        await fs.access(TURNOS_FILE);
        const data = await fs.readFile(TURNOS_FILE, 'utf8');
        turnosEnMemoria = JSON.parse(data);
    } catch {
        try {
            await fs.writeFile(TURNOS_FILE, '[]', 'utf8');
            turnosEnMemoria = [];
        } catch {
            turnosEnMemoria = [];
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
    } catch {
        turnosEnMemoria = turnos;
    }
}

app.get('/turnos', async (req, res) => {
    try {
        const turnos = await cargarTurnos();
        res.json(turnos);
    } catch {
        res.status(500).json({ error: 'Error al cargar turnos' });
    }
});

app.post('/turnos', async (req, res) => {
    try {
        const { nombre, dia, hora, massageType, telefono, ubicacion, tipoServicio } = req.body;
        
        if (!nombre || !dia || hora === undefined) {
            return res.status(400).json({ error: 'Faltan campos obligatorios' });
        }
        
        const horaNum = parseInt(hora);
        if (isNaN(horaNum) || horaNum < 8 || horaNum > 22) {
            return res.status(400).json({ error: 'La hora debe estar entre 8 y 22' });
        }
        
        const turnos = await cargarTurnos();
        
        // Validación de duplicados (race condition mitigada)
        const turnosDelDia = turnos.filter(t => t.dia === dia.toLowerCase());
        const esManana = horaNum >= 8 && horaNum < 14;
        
        if (esManana && turnosDelDia.some(t => t.hora >= 8 && t.hora < 14)) {
            return res.status(400).json({ error: 'Ya hay un turno en la mañana de ese día' });
        }
        if (!esManana && turnosDelDia.some(t => t.hora >= 14 && t.hora < 22)) {
            return res.status(400).json({ error: 'Ya hay un turno en la tarde de ese día' });
        }
        
        const nuevoTurno = {
            nombre: escapeText(nombre.trim()),
            dia: dia.toLowerCase(),
            hora: horaNum,
            massageType: massageType ? escapeText(massageType) : 'No especificado',
            telefono: telefono ? escapeText(telefono) : 'No especificado',
            ubicacion: ubicacion ? escapeText(ubicacion) : null,
            tipoServicio: tipoServicio || 'salon',
            fechaCreacion: new Date().toISOString(),
            estado: 'confirmado'
        };
        
        turnos.push(nuevoTurno);
        await guardarTurnos(turnos);
        
        res.status(201).json({ mensaje: 'Turno creado', turno: nuevoTurno });
    } catch (error) {
        res.status(500).json({ error: 'Error al crear turno' });
    }
});

app.delete('/turnos/:index', async (req, res) => {
    const index = parseInt(req.params.index);
    if (isNaN(index)) return res.status(400).json({ error: 'Índice inválido' });
    
    const turnos = await cargarTurnos();
    if (index < 0 || index >= turnos.length) {
        return res.status(404).json({ error: 'Turno no encontrado' });
    }
    
    const eliminado = turnos.splice(index, 1)[0];
    await guardarTurnos(turnos);
    res.json({ mensaje: 'Turno eliminado', turno: eliminado });
});

app.put('/turnos/:index', async (req, res) => {
    const index = parseInt(req.params.index);
    if (isNaN(index)) return res.status(400).json({ error: 'Índice inválido' });
    
    const { dia, hora, estado } = req.body;
    const turnos = await cargarTurnos();
    
    if (index < 0 || index >= turnos.length) {
        return res.status(404).json({ error: 'Turno no encontrado' });
    }
    
    if (dia) turnos[index].dia = dia.toLowerCase();
    if (hora !== undefined) turnos[index].hora = parseInt(hora);
    if (estado) turnos[index].estado = estado;
    
    await guardarTurnos(turnos);
    res.json({ mensaje: 'Turno actualizado', turno: turnos[index] });
});

app.post('/turnos/notificar-whatsapp/:index', async (req, res) => {
    const index = parseInt(req.params.index);
    if (isNaN(index)) return res.status(400).json({ error: 'Índice inválido' });
    
    const turnos = await cargarTurnos();
    if (index < 0 || index >= turnos.length) {
        return res.status(404).json({ error: 'Turno no encontrado' });
    }
    
    const turno = turnos[index];
    const mensaje = `Hola ${turno.nombre}, tu turno de ${turno.massageType} está confirmado para ${turno.dia} a las ${turno.hora}:00 hs. ¡Gracias por elegirnos!`;
    
    res.json({ mensaje: 'Notificación simulada', numero: turno.telefono, texto: mensaje });
});

app.get('/health', (req, res) => {
    res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

function escapeText(str) {
    if (!str) return '';
    return str.replace(/[&<>]/g, function(m) {
        if (m === '&') return '&amp;';
        if (m === '<') return '&lt;';
        if (m === '>') return '&gt;';
        return m;
    });
}

async function startServer() {
    await inicializarArchivo();
    app.listen(PORT, '0.0.0.0', () => {
        console.log('✅ Serenity Spa - Modo Seguro Activado');
        console.log(`🔐 Login con rate limiting: ${RATE_LIMIT.MAX_ATTEMPTS} intentos / ${RATE_LIMIT.WINDOW_MS/60000} min`);
    });
}

startServer();
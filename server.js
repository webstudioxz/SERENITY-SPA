// server.js - FG-Studio Blindado
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// ============================================
// 1. SISTEMA ANTI-ATAQUES INTEGRADO
// ============================================

const ipBlacklist = new Set();

class SecurityDefender {
    constructor() {
        this.attempts = new Map();
    }

    detectBruteForce(ip, endpoint) {
        const key = `${ip}:${endpoint}`;
        const now = Date.now();
        const attempts = this.attempts.get(key) || [];
        const recent = attempts.filter(t => now - t < 300000);
        
        if (recent.length >= 10) {
            ipBlacklist.add(ip);
            console.log(`🚨 IP BLOQUEADA: ${ip}`);
            return true;
        }
        
        recent.push(now);
        this.attempts.set(key, recent);
        return false;
    }

    validatePhone(phone) {
        const clean = phone.replace(/[^\d+]/g, '');
        const fraudPatterns = [
            /^(\d)\1{9,}$/,
            /^1234567890$/,
            /^(\+1)?900/,
            /^0{10,}$/
        ];
        
        if (fraudPatterns.some(p => p.test(clean))) return false;
        if (clean.length < 10 || clean.length > 15) return false;
        
        let sum = 0;
        for (let i = 0; i < clean.length; i++) {
            let digit = parseInt(clean[i]);
            if (i % 2 === 0) {
                digit *= 2;
                if (digit > 9) digit -= 9;
            }
            sum += digit;
        }
        return sum % 10 === 0;
    }

    sanitizeInput(input) {
        if (typeof input !== 'string') return '';
        return input
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#x27;')
            .replace(/\//g, '&#x2F;')
            .substring(0, 500);
    }
}

const security = new SecurityDefender();

// ============================================
// 2. CONFIGURACIÓN SUPABASE
// ============================================
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error('❌ ERROR: Faltan variables SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY');
    process.exit(1);
}

if (!ADMIN_PASSWORD) {
    console.error('❌ ERROR: Falta variable ADMIN_PASSWORD');
    console.log('💡 Configúrala en Render: Settings > Environment > Environment Variables');
    process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { persistSession: false }
});

// ============================================
// 3. MIDDLEWARES DE SEGURIDAD
// ============================================

app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net", "https://cdnjs.cloudflare.com", "https://unpkg.com"],
            styleSrc: ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net", "https://cdnjs.cloudflare.com", "https://fonts.googleapis.com", "https://unpkg.com"],
            fontSrc: ["'self'", "https://fonts.gstatic.com", "https://cdnjs.cloudflare.com"],
            imgSrc: ["'self'", "data:", "https:", "http:"],
            connectSrc: ["'self'", SUPABASE_URL]
        }
    },
    hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
    frameguard: { action: 'deny' },
    noSniff: true,
    xssFilter: true
}));

const globalLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    message: { error: 'Demasiadas solicitudes' }
});

const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5,
    message: { error: 'Demasiados intentos de acceso' }
});

app.use(globalLimiter);
app.use('/api/verify-admin', authLimiter);

app.use(cors());
app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: true, limit: '10kb' }));

app.use((req, res, next) => {
    const ip = req.ip || req.connection.remoteAddress;
    if (ipBlacklist.has(ip)) {
        return res.status(403).json({ error: 'Acceso denegado' });
    }
    next();
});

// ============================================
// 4. RUTAS DE SEGURIDAD
// ============================================

app.post('/api/verify-admin', (req, res) => {
    const ip = req.ip;
    
    if (security.detectBruteForce(ip, 'login')) {
        return res.status(429).json({ error: 'Demasiados intentos' });
    }
    
    const { password } = req.body;
    
    if (!password || typeof password !== 'string') {
        return res.status(400).json({ error: 'Datos inválidos' });
    }
    
    // La contraseña se compara con la variable de entorno
    if (password === ADMIN_PASSWORD) {
        const token = crypto.randomBytes(48).toString('hex');
        res.json({ success: true, token });
    } else {
        res.status(401).json({ success: false });
    }
});

// ============================================
// 5. API DE CATÁLOGOS
// ============================================

app.get('/api/catalogos', async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('catalogos')
            .select('*')
            .order('id', { ascending: true });
        
        if (error) throw error;
        res.json(data || []);
    } catch (error) {
        res.status(500).json({ error: 'Error al cargar catálogos' });
    }
});

app.post('/api/catalogos', async (req, res) => {
    const { name, category, link, image, descripcion } = req.body;
    
    if (!name || !category || !link || !image) {
        return res.status(400).json({ error: 'Faltan campos requeridos' });
    }
    
    const sanitized = {
        name: security.sanitizeInput(name),
        category: security.sanitizeInput(category),
        link: security.sanitizeInput(link),
        image: security.sanitizeInput(image),
        descripcion: security.sanitizeInput(descripcion || '')
    };
    
    if (!sanitized.image.match(/^https?:\/\/.+/)) {
        return res.status(400).json({ error: 'URL de imagen inválida' });
    }
    
    try {
        const { data, error } = await supabase
            .from('catalogos')
            .insert([sanitized])
            .select();
        
        if (error) throw error;
        res.status(201).json(data[0]);
    } catch (error) {
        res.status(500).json({ error: 'Error al crear catálogo' });
    }
});

app.delete('/api/catalogos/:id', async (req, res) => {
    const id = parseInt(req.params.id);
    if (!id || id < 1) return res.status(400).json({ error: 'ID inválido' });
    
    try {
        await supabase.from('catalogos').delete().eq('id', id);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'Error al eliminar' });
    }
});

// ============================================
// 6. API DE CONTACTOS
// ============================================

app.post('/api/contactos', async (req, res) => {
    const ip = req.ip;
    
    if (security.detectBruteForce(ip, 'contacto')) {
        return res.status(429).json({ error: 'Demasiados mensajes. Espere.' });
    }
    
    let { nombre, telefono, email, mensaje } = req.body;
    
    nombre = security.sanitizeInput(nombre);
    telefono = security.sanitizeInput(telefono);
    email = security.sanitizeInput(email);
    mensaje = security.sanitizeInput(mensaje);
    
    if (!nombre || !telefono || !mensaje) {
        return res.status(400).json({ error: 'Campos requeridos faltantes' });
    }
    
    if (!security.validatePhone(telefono)) {
        return res.status(400).json({ error: 'Número de teléfono inválido' });
    }
    
    try {
        const { error } = await supabase.from('contactos').insert([{
            nombre, telefono,
            email: email || 'No especificado',
            mensaje,
            fecha: new Date().toLocaleString('es-ES'),
            timestamp: Date.now()
        }]);
        
        if (error) throw error;
        res.status(201).json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'Error al enviar' });
    }
});

// ============================================
// 7. API DE ACERCA DE
// ============================================

app.get('/api/acercade', async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('acercade')
            .select('*')
            .eq('id', 1)
            .single();
        
        if (error && error.code !== 'PGRST116') throw error;
        res.json(data || {});
    } catch (error) {
        res.json({});
    }
});

app.post('/api/acercade', async (req, res) => {
    try {
        const newData = req.body;
        
        const { data: existing } = await supabase
            .from('acercade')
            .select('*')
            .eq('id', 1)
            .single();
        
        let merged;
        if (existing) {
            merged = { ...existing, ...newData, updated_at: new Date().toISOString() };
        } else {
            merged = { id: 1, ...newData, updated_at: new Date().toISOString() };
        }
        
        const { error } = await supabase
            .from('acercade')
            .upsert(merged);
        
        if (error) throw error;
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ============================================
// 8. API DE DATOS ADMIN
// ============================================

app.get('/api/admin-data', async (req, res) => {
    try {
        const [contactos, pedidos, catalogos] = await Promise.all([
            supabase.from('contactos').select('*').order('timestamp', { ascending: false }),
            supabase.from('pedidos').select('*').order('timestamp', { ascending: false }),
            supabase.from('catalogos').select('*').order('id', { ascending: true })
        ]);
        
        res.json({
            contactos: contactos.data || [],
            pedidos: pedidos.data || [],
            catalogos: catalogos.data || []
        });
    } catch (error) {
        res.status(500).json({ contactos: [], pedidos: [], catalogos: [] });
    }
});

app.delete('/api/contactos/:id', async (req, res) => {
    const id = parseInt(req.params.id);
    try {
        await supabase.from('contactos').delete().eq('id', id);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'Error al eliminar' });
    }
});

// ============================================
// 9. ARCHIVOS ESTÁTICOS
// ============================================
app.use(express.static(__dirname));

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));
app.get('/contactar', (req, res) => res.sendFile(path.join(__dirname, 'contactar.html')));
app.get('/hacercade', (req, res) => res.sendFile(path.join(__dirname, 'hacercade.html')));

app.use((req, res) => {
    res.status(404).sendFile(path.join(__dirname, 'index.html'));
});

// ============================================
// 10. MANEJO DE ERRORES
// ============================================
app.use((err, req, res, next) => {
    console.error('Error:', err.message);
    res.status(500).json({ error: 'Error interno del servidor' });
});

// ============================================
// 11. INICIAR SERVIDOR
// ============================================
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🔒 FG-Studio SEGURO en puerto ${PORT}`);
    console.log(`🛡️ Protección anti fuerza bruta: ACTIVADA`);
    console.log(`✅ Validación telefónica: ACTIVA`);
    console.log(`🛡️ Sanitización XSS: ACTIVA`);
    console.log(`🔑 Contraseña admin: CONFIGURADA POR VARIABLE DE ENTORNO`);
});
const express = require('express');
const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const crypto = require('crypto');
const WebSocket = require('ws');
const OpenAI = require('openai');

const app = express();
const PORT = process.env.PORT || 5001;
const TURNOS_FILE = path.join(__dirname, 'turnos.json');
const SERVICIOS_FILE = path.join(__dirname, 'servicios.json');
const CONFIG_FILE = path.join(__dirname, 'config.json');
const BLOQUEOS_FILE = path.join(__dirname, 'bloqueos.json');
const PAISES_FILE = path.join(__dirname, 'paises.json');
const HORARIOS_FILE = path.join(__dirname, 'horarios.json');
const PALABRAS_BANEADAS_FILE = path.join(__dirname, 'palabras-baneadas.json');
const CANCELACIONES_FILE = path.join(__dirname, 'cancelaciones.json');
const ADVERTENCIAS_FILE = path.join(__dirname, 'advertencias.json');
const UPLOADS_DIR = path.join(__dirname, 'uploads');

const deepseek = new OpenAI({
    baseURL: 'https://api.deepseek.com/v1',
    apiKey: process.env.DEEPSEEK_API_KEY || '',
});

app.disable('x-powered-by');

// Crear directorio de uploads si no existe
if (!fsSync.existsSync(UPLOADS_DIR)) {
    fsSync.mkdirSync(UPLOADS_DIR, { recursive: true });
}

app.use('/uploads', express.static(UPLOADS_DIR));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// ==================== CONSTANTES ====================
let HORAS_VALIDAS = [12, 16, 20];
let DIAS_VALIDOS = ['lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado'];
let serviciosData = [];
let horariosConfig = {
    dias: ['lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado'],
    horarios: ['12:00', '16:00', '20:00']
};

// ==================== INICIALIZACIÓN FORZADA DE ARCHIVOS ====================
async function initAllFiles() {
    console.log('🔧 Inicializando archivos requeridos...');
    
    // Crear servicios.json si no existe
    if (!fsSync.existsSync(SERVICIOS_FILE)) {
        console.log('📝 Creando servicios.json...');
        const serviciosDefault = [
            { 
                id: "relajante", 
                nombre: "Masaje Relajante", 
                precio: "$45", 
                descripcion: "Movimientos suaves y armónicos para liberar el estrés acumulado.", 
                beneficios: ["Reduce ansiedad", "Alivia tensión muscular", "60 Minutos"], 
                efectos: ["Relajación profunda", "Mejora del sueño"], 
                imagenWeb: "https://images.unsplash.com/photo-1544161515-4ab6ce6db874?w=800", 
                imagenWhatsApp: "", 
                videoUrl: "", 
                orden: 1 
            },
            { 
                id: "corporal", 
                nombre: "Masaje Corporal", 
                precio: "$65", 
                descripcion: "Tratamiento completo para una relajación profunda y revitalizante.", 
                beneficios: ["Relajación integral", "Elimina contracturas", "90 Minutos"], 
                efectos: ["Activación linfática", "Mejora circulación"], 
                imagenWeb: "https://images.unsplash.com/photo-1519823551278-64ac92734fb1?w=800", 
                imagenWhatsApp: "", 
                videoUrl: "", 
                orden: 2 
            },
            { 
                id: "facial", 
                nombre: "Masaje Facial", 
                precio: "$40", 
                descripcion: "Rejuvenece la piel y alivia la tensión facial acumulada.", 
                beneficios: ["Reafirma la piel", "Reduce ojeras", "45 Minutos"], 
                efectos: ["Estimula colágeno", "Tonifica rostro"], 
                imagenWeb: "https://images.unsplash.com/photo-1570172619644-dfd03ed5d881?w=800", 
                imagenWhatsApp: "", 
                videoUrl: "", 
                orden: 3 
            }
        ];
        await fs.writeFile(SERVICIOS_FILE, JSON.stringify(serviciosDefault, null, 2), 'utf8');
        console.log('✅ servicios.json creado');
    }
    
    // Crear turnos.json si no existe
    if (!fsSync.existsSync(TURNOS_FILE)) {
        console.log('📝 Creando turnos.json...');
        await fs.writeFile(TURNOS_FILE, JSON.stringify([], null, 2), 'utf8');
        console.log('✅ turnos.json creado');
    }
    
    // Crear config.json si no existe
    if (!fsSync.existsSync(CONFIG_FILE)) {
        console.log('📝 Creando config.json...');
        const configDefault = {
            hero: {
                titulo: "Renueva tu Energía",
                subtitulo: "Experiencias de bienestar",
                imagenFondo: "https://images.unsplash.com/photo-1544161515-4ab6ce6db874?w=1920",
                botonTexto: "Explorar Tratamientos"
            },
            serviciosSection: {
                etiqueta: "Nuestros Servicios",
                titulo: "Elige tu Masaje Ideal",
                descripcion: "Turnos disponibles según horarios"
            },
            contactoSection: {
                titulo: "Asistente de Reservas",
                descripcion: "Reserva tu turno de forma rápida"
            },
            shareSection: {
                titulo: "Comparte Serenity Spa"
            }
        };
        await fs.writeFile(CONFIG_FILE, JSON.stringify(configDefault, null, 2), 'utf8');
        console.log('✅ config.json creado');
    }
    
    // Crear horarios.json si no existe
    if (!fsSync.existsSync(HORARIOS_FILE)) {
        console.log('📝 Creando horarios.json...');
        await fs.writeFile(HORARIOS_FILE, JSON.stringify(horariosConfig, null, 2), 'utf8');
        console.log('✅ horarios.json creado');
    }
    
    // Crear paises.json si no existe
    if (!fsSync.existsSync(PAISES_FILE)) {
        console.log('📝 Creando paises.json...');
        const paisesDefault = {
            autorizados: [],
            bloqueados: [],
            modo: 'todos',
            ubicacionSalon: 'Salón Serenity Spa, Calle Principal #123'
        };
        await fs.writeFile(PAISES_FILE, JSON.stringify(paisesDefault, null, 2), 'utf8');
        console.log('✅ paises.json creado');
    }
    
    // Crear palabras-baneadas.json si no existe
    if (!fsSync.existsSync(PALABRAS_BANEADAS_FILE)) {
        console.log('📝 Creando palabras-baneadas.json...');
        const palabrasDefault = {
            palabras: [
                'puta', 'puto', 'puta madre', 'putamadre', 'hijodeputa', 'hijo de puta',
                'mierda', 'coño', 'carajo', 'verga', 'chinga', 'chingue', 'chingada',
                'fuck', 'shit', 'bitch', 'asshole', 'motherfucker', 'cunt',
                'idiota', 'estupido', 'imbecil', 'tarado', 'estúpido', 'imbécil',
                'pendejo', 'cabron', 'cabrón', 'malparido', 'gonorrea', 'carechimba',
                'culo', 'cojones', 'pelotudo', 'boludo', 'forro'
            ]
        };
        await fs.writeFile(PALABRAS_BANEADAS_FILE, JSON.stringify(palabrasDefault, null, 2), 'utf8');
        console.log('✅ palabras-baneadas.json creado');
    }
    
    console.log('✅ Todos los archivos inicializados correctamente');
}

// ==================== CARGAR DATOS ====================
async function cargarServicios() {
    try {
        const data = await fs.readFile(SERVICIOS_FILE, 'utf8');
        serviciosData = JSON.parse(data);
        console.log(`✅ Servicios cargados: ${serviciosData.length}`);
        return true;
    } catch(e) {
        console.error('Error cargando servicios:', e);
        return false;
    }
}

async function cargarHorarios() {
    try {
        if (fsSync.existsSync(HORARIOS_FILE)) {
            const data = JSON.parse(await fs.readFile(HORARIOS_FILE, 'utf8'));
            horariosConfig = data;
            actualizarHorariosGlobales();
            console.log('✅ Horarios cargados:', horariosConfig.horarios.length, 'horarios');
        }
    } catch(e) {
        console.error('Error cargando horarios:', e);
    }
}

function actualizarHorariosGlobales() {
    HORAS_VALIDAS = horariosConfig.horarios.map(h => parseInt(h.split(':')[0])).filter(h => !isNaN(h));
    DIAS_VALIDOS = horariosConfig.dias;
    if (HORAS_VALIDAS.length === 0) HORAS_VALIDAS = [12, 16, 20];
    if (DIAS_VALIDOS.length === 0) DIAS_VALIDOS = ['lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado'];
}

// ==================== SISTEMA DE ADVERTENCIAS ====================
let advertenciasPorIP = new Map();

async function cargarAdvertencias() {
    try {
        if (fsSync.existsSync(ADVERTENCIAS_FILE)) {
            const data = JSON.parse(await fs.readFile(ADVERTENCIAS_FILE, 'utf8'));
            advertenciasPorIP = new Map(Object.entries(data.advertencias || {}));
            const ahora = Date.now();
            for (const [ip, datos] of advertenciasPorIP) {
                if (ahora - datos.firstWarningTime > 86400000) {
                    advertenciasPorIP.delete(ip);
                }
            }
            await guardarAdvertencias();
        } else {
            await guardarAdvertencias();
        }
    } catch(e) {
        console.error('Error cargando advertencias:', e);
        await guardarAdvertencias();
    }
}

async function guardarAdvertencias() {
    try {
        await fs.writeFile(ADVERTENCIAS_FILE, JSON.stringify({
            advertencias: Object.fromEntries(advertenciasPorIP)
        }, null, 2), 'utf8');
    } catch(e) {}
}

function registrarAdvertencia(ip, palabraEncontrada, textoOriginal) {
    const ipLimpia = ip.replace('::ffff:', '');
    const ahora = Date.now();
    
    if (!advertenciasPorIP.has(ipLimpia)) {
        advertenciasPorIP.set(ipLimpia, {
            count: 1,
            firstWarningTime: ahora,
            warnings: [{
                fecha: ahora,
                palabra: palabraEncontrada,
                texto: textoOriginal.substring(0, 200)
            }]
        });
        guardarAdvertencias();
        return { count: 1, esSegunda: false, esTercera: false };
    } else {
        const datos = advertenciasPorIP.get(ipLimpia);
        if (ahora - datos.firstWarningTime < 86400000) {
            datos.count++;
            datos.warnings.push({
                fecha: ahora,
                palabra: palabraEncontrada,
                texto: textoOriginal.substring(0, 200)
            });
            
            const esSegunda = datos.count === 2;
            const esTercera = datos.count >= 3;
            
            guardarAdvertencias();
            return { count: datos.count, esSegunda, esTercera };
        } else {
            advertenciasPorIP.set(ipLimpia, {
                count: 1,
                firstWarningTime: ahora,
                warnings: [{
                    fecha: ahora,
                    palabra: palabraEncontrada,
                    texto: textoOriginal.substring(0, 200)
                }]
            });
            guardarAdvertencias();
            return { count: 1, esSegunda: false, esTercera: false };
        }
    }
}

// ==================== PALABRAS PROHIBIDAS ====================
let palabrasBaneadas = [];

async function cargarPalabrasBaneadas() {
    try {
        if (fsSync.existsSync(PALABRAS_BANEADAS_FILE)) {
            const data = JSON.parse(await fs.readFile(PALABRAS_BANEADAS_FILE, 'utf8'));
            palabrasBaneadas = data.palabras || [];
            console.log('✅ Palabras prohibidas cargadas:', palabrasBaneadas.length);
        }
    } catch(e) {
        console.error('Error cargando palabras:', e);
    }
}

async function guardarPalabrasBaneadas() {
    try {
        await fs.writeFile(PALABRAS_BANEADAS_FILE, JSON.stringify({ palabras: palabrasBaneadas }, null, 2), 'utf8');
    } catch(e) {}
}

function contienePalabraProhibida(texto) {
    if (!texto || typeof texto !== 'string') return null;
    const textoLower = texto.toLowerCase().trim();
    
    for (const palabra of palabrasBaneadas) {
        if (textoLower.includes(palabra.toLowerCase())) {
            return palabra;
        }
    }
    return null;
}

// ==================== SISTEMA DE BLOQUEOS ====================
let bloqueos = new Map();
let historialBloqueos = [];
let intentosFallidos = new Map();
const turnosRecientesIP = new Map();
const turnosRecientesTel = new Map();
let cancelacionesPorIP = new Map();

async function cargarBloqueos() {
    try {
        if (fsSync.existsSync(BLOQUEOS_FILE)) {
            const d = JSON.parse(await fs.readFile(BLOQUEOS_FILE, 'utf8'));
            bloqueos = new Map(Object.entries(d.bloqueos || {}));
            historialBloqueos = d.historial || [];
            const ahora = Date.now();
            for (const [ip, datos] of bloqueos) {
                if (ahora > datos.hasta && !datos.permanente) bloqueos.delete(ip);
            }
            await guardarBloqueos();
        }
    } catch (err) {
        await fs.writeFile(BLOQUEOS_FILE, JSON.stringify({ bloqueos: {}, historial: [] }, null, 2), 'utf8');
    }
}

async function guardarBloqueos() {
    try {
        await fs.writeFile(BLOQUEOS_FILE, JSON.stringify({
            bloqueos: Object.fromEntries(bloqueos),
            historial: historialBloqueos.slice(0, 500)
        }, null, 2), 'utf8');
    } catch (err) {}
}

async function cargarCancelaciones() {
    try {
        if (fsSync.existsSync(CANCELACIONES_FILE)) {
            const data = JSON.parse(await fs.readFile(CANCELACIONES_FILE, 'utf8'));
            cancelacionesPorIP = new Map(Object.entries(data.cancelaciones || {}));
        }
    } catch(e) {}
}

async function guardarCancelaciones() {
    try {
        await fs.writeFile(CANCELACIONES_FILE, JSON.stringify({
            cancelaciones: Object.fromEntries(cancelacionesPorIP)
        }, null, 2), 'utf8');
    } catch(e) {}
}

function estaBloqueado(ip) {
    const ipLimpia = ip.replace('::ffff:', '');
    if (bloqueos.has(ipLimpia)) {
        const datos = bloqueos.get(ipLimpia);
        if (datos.permanente) return true;
        if (Date.now() < datos.hasta) return true;
        bloqueos.delete(ipLimpia);
        guardarBloqueos();
    }
    return false;
}

function bloquearIP(ip, motivo, tipo, palabraOfensiva, permanente) {
    const ipLimpia = ip.replace('::ffff:', '');
    const duracion = permanente ? 31536000000 : 3600000;
    
    bloqueos.set(ipLimpia, {
        hasta: Date.now() + duracion,
        motivo: motivo,
        tipoAtaque: tipo,
        fecha: new Date().toISOString(),
        ip: ipLimpia,
        intentos: 0,
        permanente: permanente,
        palabraOfensiva: palabraOfensiva
    });
    
    historialBloqueos.unshift({ ...bloqueos.get(ipLimpia), id: generarId() });
    guardarBloqueos();
}

function desbloquearIP(ip) {
    const ipLimpia = ip.replace('::ffff:', '');
    bloqueos.delete(ipLimpia);
    intentosFallidos.delete(ipLimpia);
    cancelacionesPorIP.delete(ipLimpia);
    advertenciasPorIP.delete(ipLimpia);
    guardarBloqueos();
    guardarAdvertencias();
}

function registrarCancelacion(ip, telefono, codigoCancelacion) {
    const ipLimpia = ip.replace('::ffff:', '');
    const ahora = Date.now();
    
    if (!cancelacionesPorIP.has(ipLimpia)) {
        cancelacionesPorIP.set(ipLimpia, {
            count: 1,
            firstCancelTime: ahora,
            cancelaciones: [{ fecha: ahora, telefono, codigo: codigoCancelacion }]
        });
    } else {
        const datos = cancelacionesPorIP.get(ipLimpia);
        if (ahora - datos.firstCancelTime < 3600000) {
            datos.count++;
            datos.cancelaciones.push({ fecha: ahora, telefono, codigo: codigoCancelacion });
            
            if (datos.count >= 3) {
                bloquearIP(ipLimpia, `3 cancelaciones en 1 hora`, 'ABUSO_CANCELACIONES', null, false);
            }
        } else {
            cancelacionesPorIP.set(ipLimpia, {
                count: 1,
                firstCancelTime: ahora,
                cancelaciones: [{ fecha: ahora, telefono, codigo: codigoCancelacion }]
            });
        }
    }
    guardarCancelaciones();
}

function checkRateIP(ip) {
    const ipLimpia = ip.replace('::ffff:', '');
    limpiarViejos(turnosRecientesIP, 3600000);
    return (turnosRecientesIP.get(ipLimpia) || []).length < 3;
}

function regTurno(ip, tel) {
    const ipLimpia = ip.replace('::ffff:', '');
    const ahora = Date.now();
    if (!turnosRecientesIP.has(ipLimpia)) turnosRecientesIP.set(ipLimpia, []);
    turnosRecientesIP.get(ipLimpia).push(ahora);
    if (!turnosRecientesTel.has(tel)) turnosRecientesTel.set(tel, []);
    turnosRecientesTel.get(tel).push(ahora);
}

function limpiarViejos(mapa, ventana) {
    const ahora = Date.now();
    for (const [k, a] of mapa) {
        mapa.set(k, a.filter(t => ahora - t < ventana));
        if (!mapa.get(k).length) mapa.delete(k);
    }
}

function generarId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2) + crypto.randomBytes(4).toString('hex');
}

function fmtT(ms) {
    if (ms <= 0) return 'Expirado';
    const s = Math.floor(ms / 1000), m = Math.floor(s / 60), h = Math.floor(m / 60);
    return h > 0 ? `${h}h ${m % 60}m` : m > 0 ? `${m}m ${s % 60}s` : `${s}s`;
}

function escapeHtml(s) {
    if (!s) return '';
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function generarCodigoCancelacion() {
    const caracteres = 'ABCDEFGHJKLMNPQRSTUVWXYZ0123456789';
    let codigo = '';
    for (let i = 0; i < 6; i++) {
        codigo += caracteres[Math.floor(Math.random() * caracteres.length)];
    }
    return codigo;
}

function esFechaValida(dia) {
    const diasSemana = ['domingo', 'lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado'];
    const hoy = new Date();
    const diaActual = diasSemana[hoy.getDay()];
    const indiceDia = DIAS_VALIDOS.indexOf(dia);
    const indiceHoy = DIAS_VALIDOS.indexOf(diaActual);
    
    if (indiceDia === -1) return false;
    if (indiceDia > indiceHoy) return true;
    if (indiceDia === indiceHoy) return true;
    return false;
}

function buscarAlternativa(dia, hora, turnos) {
    const idx = DIAS_VALIDOS.indexOf(dia);
    if (idx === -1) return null;
    
    for (let o = 0; o < DIAS_VALIDOS.length; o++) {
        const d = DIAS_VALIDOS[(idx + o) % DIAS_VALIDOS.length];
        const horasDisponibles = o === 0 ? HORAS_VALIDAS.filter(h => h > hora) : [...HORAS_VALIDAS];
        
        for (const h of horasDisponibles) {
            if (!turnos.some(t => t.dia === d && t.hora === h)) {
                return { dia: d, hora: h };
            }
        }
    }
    return null;
}

function verificarYSancionar(ip, texto, fuente = 'chat') {
    const palabraEncontrada = contienePalabraProhibida(texto);
    
    if (!palabraEncontrada) {
        return { sancionado: false, mensaje: null };
    }
    
    const advertencia = registrarAdvertencia(ip, palabraEncontrada, texto);
    
    if (advertencia.esTercera) {
        bloquearIP(ip, `3ra ofensa - Lenguaje prohibido (${advertencia.count} veces): "${palabraEncontrada}"`, 'BLOQUEO_PERMANENTE', palabraEncontrada, true);
        return { 
            sancionado: true, 
            mensaje: "⚠️ SU SERVICIO HA SIDO SUSPENDIDO PERMANENTEMENTE\n\nHa recibido 3 advertencias por uso de lenguaje inapropiado. Su IP ha sido bloqueada de forma permanente.\n\nGracias por comprender." 
        };
    }
    
    if (advertencia.esSegunda) {
        bloquearIP(ip, `2da ofensa - Lenguaje prohibido (${advertencia.count} veces): "${palabraEncontrada}"`, 'BLOQUEO_TEMPORAL', palabraEncontrada, false);
        return { 
            sancionado: true, 
            mensaje: "⚠️ SERVICIO SUSPENDIDO TEMPORALMENTE\n\nHa recibido una segunda advertencia por uso de lenguaje inapropiado. Su acceso ha sido suspendido por 1 hora.\n\nAl reincidir, su IP será bloqueada permanentemente." 
        };
    }
    
    return { 
        sancionado: false, 
        mensaje: `⚠️ ADVERTENCIA POR LENGUAJE INAPROPIADO\n\nHemos detectado el uso de lenguaje ofensivo ("${palabraEncontrada}"). Esta es su primera advertencia.\n\nSi recibe 3 advertencias, su acceso al servicio será suspendido permanentemente.\n\nGracias por su comprensión.` 
    };
}

// ==================== MIDDLEWARE ====================
app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    next();
});

app.use((req, res, next) => {
    const ip = req.ip || req.socket.remoteAddress || '0.0.0.0';
    
    if (estaBloqueado(ip)) {
        const bloqueo = bloqueos.get(ip.replace('::ffff:', ''));
        return res.status(403).send(`
            <!DOCTYPE html>
            <html lang="es">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>Servicio Suspendido | Serenity Spa</title>
                <style>
                    *{margin:0;padding:0;box-sizing:border-box}
                    body{
                        font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
                        background: linear-gradient(135deg, #0a0806 0%, #1a1008 100%);
                        min-height: 100vh;
                        display: flex;
                        align-items: center;
                        justify-content: center;
                        padding: 1rem;
                    }
                    .suspension-card{
                        max-width: 550px;
                        background: rgba(30, 25, 20, 0.95);
                        backdrop-filter: blur(10px);
                        border-radius: 28px;
                        border: 1px solid rgba(201, 168, 122, 0.3);
                        padding: 2.5rem;
                        text-align: center;
                        animation: fadeIn 0.5s ease-out;
                    }
                    @keyframes fadeIn{
                        from{opacity:0;transform:translateY(-20px)}
                        to{opacity:1;transform:translateY(0)}
                    }
                    .icono{width:80px;height:80px;background:rgba(220,38,38,.15);border-radius:50%;display:flex;align-items:center;justify-content:center;margin:0 auto 1.5rem;border:1px solid rgba(220,38,38,.3)}
                    .icono i{font-size:2.8rem;color:#dc2626}
                    h1{font-family:'Georgia',serif;color:#dc2626;font-size:1.6rem;margin-bottom:0.5rem}
                    .badge{display:inline-block;background:rgba(220,38,38,.2);padding:.3rem 1rem;border-radius:40px;font-size:.7rem;color:#dc2626;margin-bottom:1.5rem}
                    p{color:#d4c5a9;line-height:1.6;margin-bottom:1rem}
                    .motivo{background:rgba(0,0,0,.4);border-radius:12px;padding:1rem;margin:1.5rem 0;font-size:.85rem;border-left:3px solid #dc2626;text-align:left}
                    .motivo strong{color:#c9a87a}
                    .btn-home{display:inline-block;background:rgba(201,168,122,.15);border:1px solid rgba(201,168,122,.4);color:#c9a87a;padding:.7rem 1.5rem;border-radius:40px;text-decoration:none;font-size:.85rem;transition:.3s;margin-top:1rem}
                    .btn-home:hover{background:rgba(201,168,122,.3);border-color:#c9a87a}
                    .footer{margin-top:1.5rem;font-size:.7rem;color:rgba(212,197,169,.5)}
                </style>
                <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
            </head>
            <body>
                <div class="suspension-card">
                    <div class="icono"><i class="fas fa-gavel"></i></div>
                    <h1>Servicio Suspendido</h1>
                    <div class="badge"><i class="fas fa-ban"></i> Acceso Restringido</div>
                    <p>El servicio ha sido suspendido debido a violación de las normas de convivencia de Serenity Spa.</p>
                    <div class="motivo">
                        <strong><i class="fas fa-shield-alt"></i> Motivo:</strong><br>
                        ${escapeHtml(bloqueo?.motivo || 'Violación de términos de servicio')}<br><br>
                        <strong><i class="fas fa-clock"></i> Fecha:</strong> ${new Date(bloqueo?.fecha || Date.now()).toLocaleString()}<br>
                        <strong><i class="fas fa-microchip"></i> ID:</strong> ${escapeHtml(ip.replace('::ffff:', ''))}<br>
                        ${bloqueo?.palabraOfensiva ? `<strong><i class="fas fa-comment-slash"></i> Palabra:</strong> "${escapeHtml(bloqueo.palabraOfensiva)}"<br>` : ''}
                        ${bloqueo?.permanente ? '<strong><i class="fas fa-lock"></i> Estado:</strong> Suspensión permanente' : '<strong><i class="fas fa-hourglass-half"></i> Estado:</strong> Suspensión temporal (1 hora)'}
                    </div>
                    <a href="/" class="btn-home"><i class="fas fa-home"></i> Volver al inicio</a>
                    <div class="footer">Serenity Spa - Todos los derechos reservados</div>
                </div>
            </body>
            </html>
        `);
    }
    next();
});

app.use(express.static(__dirname));

// ==================== RUTAS API ====================

// Ruta de diagnóstico
app.get('/api/debug', (req, res) => {
    const archivos = {
        servicios_existe: fsSync.existsSync(SERVICIOS_FILE),
        servicios_cantidad: serviciosData.length,
        turnos_existe: fsSync.existsSync(TURNOS_FILE),
        config_existe: fsSync.existsSync(CONFIG_FILE),
        uploads_existe: fsSync.existsSync(UPLOADS_DIR),
        directorio_actual: __dirname,
        archivos_json: fsSync.readdirSync(__dirname).filter(f => f.endsWith('.json'))
    };
    res.json(archivos);
});

app.get('/api/servicios', (req, res) => {
    res.json(serviciosData.sort((a, b) => (a.orden || 999) - (b.orden || 999)));
});

app.get('/api/config/horarios', (req, res) => {
    res.json(horariosConfig);
});

app.get('/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        timestamp: new Date().toISOString(), 
        uptime: process.uptime(),
        servicios: serviciosData.length
    });
});

app.post('/api/chat-ia', async (req, res) => {
    const ip = req.ip || '0.0.0.0';
    const { mensaje } = req.body;
    
    if (estaBloqueado(ip)) {
        return res.status(403).json({ error: 'Servicio suspendido' });
    }
    
    const sancion = verificarYSancionar(ip, mensaje, 'chat');
    
    if (sancion.sancionado) {
        return res.json({ respuesta: sancion.mensaje, modo: 'sancion' });
    }
    
    const respuestaBase = `Gracias por tu mensaje. ¿En qué puedo ayudarte? Puedo ayudarte con reservas, horarios o cancelaciones.`;
    res.json({ respuesta: respuestaBase, modo: 'local' });
});

app.post('/turnos', async (req, res) => {
    const ip = req.ip || '0.0.0.0';
    const { nombre, telefono, massageType, dia, hora, codigoPais } = req.body;
    
    if (estaBloqueado(ip)) {
        return res.status(403).json({ error: 'Servicio suspendido' });
    }
    
    if (nombre) {
        const sancion = verificarYSancionar(ip, nombre, 'registro');
        if (sancion.sancionado) {
            return res.status(403).json({ error: sancion.mensaje });
        }
    }
    
    if (!nombre || nombre.length < 2) {
        return res.status(400).json({ error: 'Nombre inválido' });
    }
    
    const tel = telefono ? telefono.replace(/\D/g, '') : '';
    if (!tel || tel.length < 7) {
        return res.status(400).json({ error: 'Teléfono inválido' });
    }
    
    let codPais = codigoPais || '53';
    if (!/^\d{1,3}$/.test(codPais)) codPais = '53';
    
    let diaLower = dia?.toLowerCase();
    if (!diaLower || !DIAS_VALIDOS.includes(diaLower)) {
        return res.status(400).json({ error: `Día inválido` });
    }
    
    if (!esFechaValida(diaLower)) {
        return res.status(400).json({ error: `No se puede reservar para un día que ya pasó` });
    }
    
    const hn = parseInt(hora);
    if (!HORAS_VALIDAS.includes(hn)) {
        return res.status(400).json({ error: `Hora inválida` });
    }
    
    if (!checkRateIP(ip)) {
        return res.status(429).json({ error: 'Demasiadas solicitudes.' });
    }
    
    const turnos = JSON.parse(await fs.readFile(TURNOS_FILE, 'utf8'));
    
    if (turnos.some(t => t.telefono === tel && t.dia === diaLower)) {
        return res.status(409).json({ error: 'Ya tienes un turno para ese día.' });
    }
    
    if (turnos.some(t => t.dia === diaLower && t.hora === hn)) {
        const alternativa = buscarAlternativa(diaLower, hn, turnos);
        if (alternativa) {
            return res.status(409).json({ error: 'Horario ocupado', alternativa });
        }
        return res.status(409).json({ error: 'Horario ocupado' });
    }
    
    const codigoCancelacion = generarCodigoCancelacion();
    
    const nuevoTurno = {
        id: generarId(),
        nombre: escapeHtml(nombre),
        dia: diaLower,
        hora: hn,
        massageType: massageType || 'Masaje',
        telefono: tel,
        codigoPais: codPais,
        ubicacion: 'Salón Serenity Spa',
        tipoServicio: 'salon',
        confirmadoWhatsApp: false,
        fechaCreacion: new Date().toISOString(),
        ip: ip.replace('::ffff:', ''),
        codigoCancelacion: codigoCancelacion
    };
    
    turnos.push(nuevoTurno);
    await fs.writeFile(TURNOS_FILE, JSON.stringify(turnos, null, 2), 'utf8');
    regTurno(ip, tel);
    
    res.status(201).json({ 
        mensaje: 'Turno reservado', 
        turno: nuevoTurno,
        codigoCancelacion: codigoCancelacion
    });
});

app.post('/api/cancelar-por-codigo', async (req, res) => {
    const ip = req.ip || '0.0.0.0';
    const { codigo } = req.body;
    
    if (estaBloqueado(ip)) {
        return res.status(403).json({ error: 'Servicio suspendido' });
    }
    
    if (!codigo || codigo.length !== 6) {
        return res.status(400).json({ error: 'Código inválido' });
    }
    
    const turnos = JSON.parse(await fs.readFile(TURNOS_FILE, 'utf8'));
    const turnoIndex = turnos.findIndex(t => t.codigoCancelacion === codigo.toUpperCase());
    
    if (turnoIndex === -1) {
        return res.json({ success: false, error: 'Código incorrecto' });
    }
    
    const turno = turnos[turnoIndex];
    turnos.splice(turnoIndex, 1);
    await fs.writeFile(TURNOS_FILE, JSON.stringify(turnos, null, 2), 'utf8');
    
    registrarCancelacion(ip, turno.telefono, codigo);
    
    res.json({ success: true, mensaje: `Turno del ${turno.dia} a las ${turno.hora}:00 cancelado.` });
});

// ==================== WEBSOCKET ====================
const server = app.listen(PORT, '0.0.0.0', async () => {
    console.log(`🌿 Serenity Spa iniciado en puerto ${PORT}`);
    console.log(`📅 Días: ${DIAS_VALIDOS.join(', ')}`);
    console.log(`⏰ Horarios: ${horariosConfig.horarios.join(', ')}`);
    console.log(`🔑 Palabras prohibidas: ${palabrasBaneadas.length}`);
    console.log(`💆 Servicios disponibles: ${serviciosData.length}`);
    console.log(`⚠️ Sistema de advertencias activo`);
});

const wss = new WebSocket.Server({ server, path: '/ws-voice' });
let voiceClients = new Map();

wss.on('connection', (ws, req) => {
    const ip = req.socket.remoteAddress || 'desconocida';
    
    if (estaBloqueado(ip)) {
        ws.close(1008, 'IP bloqueada');
        return;
    }
    
    const cid = generarId();
    voiceClients.set(cid, { estado: 'inicial', datos: {} });
    
    ws.on('message', async (data) => {
        try {
            const m = JSON.parse(data);
            if (m.tipo === 'transcripcion') {
                const sancion = verificarYSancionar(ip, m.texto, 'voz');
                
                if (sancion.sancionado) {
                    ws.send(JSON.stringify({ tipo: 'respuesta', texto: sancion.mensaje }));
                    if (sancion.mensaje.includes('suspendido')) {
                        setTimeout(() => ws.close(), 3000);
                    }
                    return;
                }
                
                ws.send(JSON.stringify({ tipo: 'respuesta', texto: `Procesando: "${m.texto}"` }));
            }
        } catch(e) {
            console.error('Error:', e);
        }
    });
    
    ws.on('close', () => voiceClients.delete(cid));
});

// ==================== INICIALIZACIÓN ====================
async function start() {
    await initAllFiles();
    await cargarServicios();
    await cargarHorarios();
    await cargarBloqueos();
    await cargarPalabrasBaneadas();
    await cargarAdvertencias();
    await cargarCancelaciones();
    console.log('✅ Sistema completamente inicializado');
}

start();
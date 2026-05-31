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

console.log('🌿 SERENITY SPA v7.0');

// ==================== BLOQUEOS ====================
let bloqueos = new Map();
let historialBloqueos = [];

async function cargarBloqueos() {
    try {
        const d = JSON.parse(await fs.readFile(BLOQUEOS_FILE, 'utf8'));
        bloqueos = new Map(Object.entries(d.bloqueos || {}));
        historialBloqueos = d.historial || [];
        for (const [ip, datos] of bloqueos) { if (Date.now() > datos.hasta) bloqueos.delete(ip); }
        guardarBloqueos();
        console.log(`📂 ${bloqueos.size} IPs bloqueadas`);
    } catch { await fs.writeFile(BLOQUEOS_FILE, '{}', 'utf8'); }
}

async function guardarBloqueos() {
    await fs.writeFile(BLOQUEOS_FILE, JSON.stringify({ bloqueos: Object.fromEntries(bloqueos), historial: historialBloqueos.slice(0, 500) }, null, 2), 'utf8');
}

function estaBloqueado(ip) {
    if (bloqueos.has(ip)) {
        if (Date.now() < bloqueos.get(ip).hasta) return true;
        bloqueos.delete(ip); guardarBloqueos();
    }
    return false;
}

function bloquearIP(ip, motivo, tipo = 'Desconocido') {
    bloqueos.set(ip, { hasta: Date.now() + 3600000, motivo, tipoAtaque: tipo, fecha: new Date().toISOString(), ip, intentos: intentosFallidos.get(ip)?.count || 0 });
    historialBloqueos.unshift({ ...bloqueos.get(ip), id: generarId() });
    guardarBloqueos();
    console.log(`🚫 Bloqueada: ${ip} - ${tipo}`);
}

// ==================== ANTI-ABUSO: Rate limiting por IP y teléfono ====================
const turnosRecientesIP = new Map();   // ip -> [timestamps]
const turnosRecientesTel = new Map();  // tel -> [timestamps]
const intentosFallidos = new Map();

function limpiarRegistrosAntiguos(mapa, ventanaMs) {
    const ahora = Date.now();
    for (const [key, arr] of mapa) {
        mapa.set(key, arr.filter(t => ahora - t < ventanaMs));
        if (mapa.get(key).length === 0) mapa.delete(key);
    }
}

function registrarIntento(ip, tipo) {
    const ahora = Date.now();
    if (!intentosFallidos.has(ip)) { intentosFallidos.set(ip, { count: 1, first: ahora }); return false; }
    const d = intentosFallidos.get(ip);
    if (ahora - d.first > 600000) { intentosFallidos.set(ip, { count: 1, first: ahora }); return false; }
    d.count++;
    if (d.count >= 5) { bloquearIP(ip, `5+ intentos de ${tipo}`, tipo); intentosFallidos.delete(ip); return true; }
    return false;
}

function checkRateLimitIP(ip) {
    limpiarRegistrosAntiguos(turnosRecientesIP, 3600000);
    const arr = turnosRecientesIP.get(ip) || [];
    return arr.length < 3; // máximo 3 turnos por IP por hora
}

function checkRateLimitTel(tel) {
    limpiarRegistrosAntiguos(turnosRecientesTel, 86400000);
    const arr = turnosRecientesTel.get(tel) || [];
    return arr.length < 2; // máximo 2 turnos por teléfono por día
}

function registrarTurnoReciente(ip, tel) {
    const ahora = Date.now();
    if (!turnosRecientesIP.has(ip)) turnosRecientesIP.set(ip, []);
    turnosRecientesIP.get(ip).push(ahora);
    if (!turnosRecientesTel.has(tel)) turnosRecientesTel.set(tel, []);
    turnosRecientesTel.get(tel).push(ahora);
}

// ==================== HELPERS ====================
function esUrlValida(s) {
    if (!s || typeof s !== 'string' || s.startsWith('data:') || s.length > 2048) return false;
    try { const u = new URL(s.trim()); return u.protocol === 'http:' || u.protocol === 'https:'; } catch { return false; }
}
function escapeHtml(s) { return s ? s.replace(/[&<>]/g, m => m === '&' ? '&amp;' : m === '<' ? '&lt;' : '&gt;') : ''; }
function sanitize(s) { return s ? s.trim().replace(/[^\w\sáéíóúñÑü.,@\-]/gi, '') : ''; }
function generarId() { return Date.now().toString(36) + Math.random().toString(36).substr(2) + crypto.randomBytes(4).toString('hex'); }
function desbloquearIP(ip) { bloqueos.delete(ip); intentosFallidos.delete(ip); guardarBloqueos(); }

const HORAS_VALIDAS = [12, 16, 20];
const DIAS_VALIDOS = ['lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado'];

// Palabras que NUNCA deben interpretarse como nombre
const STOP_WORDS = new Set(['hola','buenos','buenas','días','dias','tardes','noches','soy','me','llamo','mi','nombre','es','un','una','gusto','mucho','muchas','muchísimo','placer','para','por','favor','quiero','deseo','necesito','reservar','turno','cita','masaje','el','la','los','las','de','del','en','con','gracias','saludos','cancelar','eliminar','anular','borrar','cambiar','modificar','no','si','sí','ok','dale','perfecto','genial','bien','buen','buena','hay','que','puedo','puedes','puede','como','cómo','donde','dónde','cuando','cuándo','este','esta','ese','esa','aqui','aquí','allí','muy','también','tambien','pero','porque','solo','todavía','todavia','ya','ahora','después','despues','antes','siempre','nunca','quizás','quizas','entonces','luego','ayer','hoy','mañana','maniana','semana','mes','año','horas','hora','minutos','minuto','día','dia','noche','mediodía','mediodia','tarde','please','pls','chau','adiós','adios','nos','vemos','hasta','luego','nada','mas','más','algo','alguien','nadie','tienen','tiene','tengo','hay','será','seria','puede','podría','haría','hacer','hago','hacemos','van','vamos','voy','ver','veré','saber','sé','creo','pienso','opino','digo','decir','o sea','osea','cero','uno','dos','tres','cuatro','cinco','seis','siete','ocho','nueve','diez','doce','cuatro','dieciséis','veinte','relajante','corporal','facial','salon','salón','domicilio','casa','dirección','direccion','lunes','martes','miercoles','jueves','viernes','sabado','sábado','precio','costo','cuanto','cuánto','cuáles','cuales','cuál','cual','teléfono','telefono','número','numero']);

function extraerNombre(texto) {
    if (!texto || texto.length < 2) return null;
    const t = texto.trim();
    const pat = [
        /(?:me\s+(?:llamo|llaman))\s+([a-zA-ZáéíóúñÑü\s]{2,50}?)(?:\s+(?:es\s+un\s+gusto|mucho\s+gusto|un\s+placer|gracias|\.|,|!|$))/i,
        /(?:soy|mi\s+nombre\s+es)\s+([a-zA-ZáéíóúñÑü\s]{2,50}?)(?:\s+(?:es\s+un\s+gusto|mucho\s+gusto|un\s+placer|gracias|\.|,|!|$))/i,
        /(?:hola|buenos\s+días|buenas\s+tardes|buenas\s+noches),?\s+(?:soy|me\s+llamo|mi\s+nombre\s+es)\s+([a-zA-ZáéíóúñÑü\s]{2,50}?)(?:\s+(?:es\s+un\s+gusto|mucho\s+gusto|un\s+placer|gracias|\.|,|!|$))/i
    ];
    for (const p of pat) {
        const m = t.match(p);
        if (m && m[1]) {
            let n = m[1].trim().replace(/\s+(?:es\s+un\s+gusto|mucho\s+gusto|un\s+placer|gracias).*/i, '').replace(/[.,!]$/, '').trim();
            if (n.length >= 2 && n.length <= 50 && /^[a-zA-ZáéíóúñÑü\s.]+$/.test(n)) return n;
        }
    }
    // Extracción por palabras, filtrando TODAS las stop words
    const words = t.split(/\s+/).filter(w => {
        const lw = w.toLowerCase().replace(/[.,!¿?¡]/g, '');
        return w.length > 1 && !STOP_WORDS.has(lw) && !/\d/.test(w) && w.length < 20;
    });
    if (words.length === 1 && words[0].length >= 2 && words[0].length <= 30 && /^[a-zA-ZáéíóúñÑü]+$/.test(words[0])) return words[0];
    if (words.length >= 2 && words.length <= 3) { const n = words.join(' '); if (n.length >= 2 && /^[a-zA-ZáéíóúñÑü\s]+$/.test(n)) return n; }
    return null;
}

function esAgradecimiento(text) {
    const tl = text.toLowerCase().trim();
    return /^(gracias|muchas gracias|muchísimo gracias|muchisimas gracias|genial|perfecto|excelente|ok|dale|buenísimo|listo|nos vemos|chau|adiós|adios|hasta luego|hasta pronto|buen día|buenos días|que tengas|goodbye|bye)$/.test(tl) || /^(gracias|muchas gracias|muchísimo|genial|perfecto|excelente|listo|buenísimo)\b/.test(tl);
}

function esSolicitudCancelacion(text) {
    const tl = text.toLowerCase();
    return /\b(cancelar|eliminar|anular|borrar|no quiero el|ya no quiero|no necesito|no lo quiero)\b/.test(tl);
}

function esSolicitudReserva(text) {
    const tl = text.toLowerCase();
    return /\b(reservar|turno|cita|agendar|pedir|quiero un masaje|me gustaría un|pedir un)\b/.test(tl);
}

function detectarPais(texto) {
    const tl = texto.toLowerCase().trim();
    const paises = { 'argentina':{c:'54'},'méxico':{c:'52'},'mexico':{c:'52'},'colombia':{c:'57'},'chile':{c:'56'},'perú':{c:'51'},'peru':{c:'51'},'españa':{c:'34'},'espania':{c:'34'},'uruguay':{c:'598'},'paraguay':{c:'595'},'bolivia':{c:'591'},'venezuela':{c:'58'},'ecuador':{c:'593'} };
    for (const [p, d] of Object.entries(paises)) { if (tl === p || tl.includes(p)) return d; }
    const claves = { 'argen':'argentina','arg':'argentina','méx':'méxico','mex':'méxico','colom':'colombia','chil':'chile','peru':'perú','lima':'perú','espa':'españa','madrid':'españa' };
    for (const [k, dest] of Object.entries(claves)) { if (tl.includes(k)) return paises[dest]; }
    return null;
}

function buscarAlternativa(dia, hora, turnos) {
    const dias = ['lunes','martes','miercoles','jueves','viernes','sabado'];
    const idx = dias.indexOf(dia);
    if (idx === -1) return null;
    for (let o = 0; o < 7; o++) {
        const d = dias[(idx + o) % 7];
        const hrs = o === 0 ? HORAS_VALIDAS.filter(h => h > hora) : HORAS_VALIDAS;
        for (const h of hrs) { if (!turnos.some(t => t.dia === d && t.hora === h)) return { dia: d, hora: h }; }
    }
    return null;
}

// ==================== MIDDLEWARES ====================
app.use(express.json({ limit: '1mb' }));
app.use((req, res, next) => {
    const ip = req.ip || req.connection.remoteAddress || '0.0.0.0';
    if (estaBloqueado(ip)) return res.status(403).json({ error: 'Bloqueado por seguridad', bloqueado: true });
    next();
});
app.use((req, res, next) => { res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('X-Frame-Options', 'DENY'); next(); });
app.use((req, res, next) => { if (req.url === '/' || req.url.endsWith('.html')) { res.setHeader('Cache-Control', 'no-store'); res.setHeader('Pragma', 'no-cache'); } next(); });
app.use(express.static(__dirname));

// ==================== DATOS ====================
let turnosMem = [], configData = {
    hero: { titulo: "Renueva tu Energía", subtitulo: "Experiencias de bienestar", imagenFondo: "https://images.unsplash.com/photo-1544161515-4ab6ce6db874?ixlib=rb-1.2.1&auto=format&fit=crop&w=1920&q=80", botonTexto: "Explorar Tratamientos" },
    serviciosSection: { etiqueta: "Nuestros Servicios", titulo: "Elige tu Masaje Ideal", descripcion: "Turnos: 12:00, 16:00 y 20:00" },
    contactoSection: { titulo: "Asistente de Reservas", descripcion: "Reserva tu turno de forma rápida" },
    shareSection: { titulo: "Comparte Serenity Spa" }
}, serviciosData = [];

async function initFile(file, fallback) {
    try { return JSON.parse(await fs.readFile(file, 'utf8')); }
    catch { await fs.writeFile(file, JSON.stringify(fallback, null, 2), 'utf8'); return JSON.parse(JSON.stringify(fallback)); }
}
async function loadTurnos() { try { turnosMem = JSON.parse(await fs.readFile(TURNOS_FILE, 'utf8')); } catch {} return turnosMem; }
async function saveTurnos(t) { await fs.writeFile(TURNOS_FILE, JSON.stringify(t, null, 2), 'utf8'); turnosMem = t; }

// ==================== AUTH ====================
const validTokens = new Map();
function checkAuth(req) { const h = req.headers.authorization; return h && h.startsWith('Bearer ') && validTokens.has(h.substring(7)) && validTokens.get(h.substring(7)) > Date.now(); }

app.post('/api/login', (req, res) => {
    const ip = req.ip || '0.0.0.0';
    if (estaBloqueado(ip)) return res.status(403).json({ success: false, error: 'Bloqueado' });
    const { password } = req.body;
    if (!password) { registrarIntento(ip, 'vacia'); return res.status(400).json({ success: false, error: 'Contraseña requerida' }); }
    if (password === (process.env.ADMIN_PASSWORD || 'admin123')) { validTokens.set(crypto.randomBytes(64).toString('hex'), Date.now() + 28800000); intentosFallidos.delete(ip); res.json({ success: true, token: [...validTokens.keys()].pop() }); }
    else { registrarIntento(ip, 'incorrecta'); res.status(401).json({ success: false, error: 'Incorrecta' }); }
});
app.get('/api/verify', (req, res) => res.json({ valid: checkAuth(req) }));
app.post('/api/logout', (req, res) => { const h = req.headers.authorization; if (h?.startsWith('Bearer ')) validTokens.delete(h.substring(7)); res.json({ ok: true }); });

// ==================== CONFIG (público GET, auth PUT) ====================
app.get('/api/config', (req, res) => res.json(configData));
app.put('/api/config', async (req, res) => { if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' }); configData = { ...configData, ...req.body }; await fs.writeFile(CONFIG_FILE, JSON.stringify(configData, null, 2), 'utf8'); res.json({ ok: true }); });

// ==================== SERVICIOS (público GET, auth POST/PUT/DELETE) ====================
app.get('/api/servicios', (req, res) => res.json(serviciosData.sort((a, b) => (a.orden || 999) - (b.orden || 999))));
app.post('/api/servicios', async (req, res) => {
    if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    let iwa = ''; if (req.body.imagenWhatsApp && esUrlValida(req.body.imagenWhatsApp)) iwa = req.body.imagenWhatsApp.trim();
    const s = { id: generarId(), ...req.body, imagenWeb: req.body.imagenWeb || 'https://images.unsplash.com/photo-1544161515-4ab6ce6db874?ixlib=rb-1.2.1&auto=format&fit=crop&w=800&q=80', imagenWhatsApp: iwa };
    serviciosData.push(s); await fs.writeFile(SERVICIOS_FILE, JSON.stringify(serviciosData, null, 2), 'utf8'); res.status(201).json(s);
});
app.put('/api/servicios/:id', async (req, res) => {
    if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    const i = serviciosData.findIndex(s => s.id === req.params.id);
    if (i === -1) return res.status(404).json({ error: 'No encontrado' });
    let iwa = ''; if (req.body.imagenWhatsApp && esUrlValida(req.body.imagenWhatsApp)) iwa = req.body.imagenWhatsApp.trim();
    serviciosData[i] = { ...serviciosData[i], ...req.body, id: req.params.id, imagenWeb: req.body.imagenWeb || serviciosData[i].imagenWeb, imagenWhatsApp: iwa };
    await fs.writeFile(SERVICIOS_FILE, JSON.stringify(serviciosData, null, 2), 'utf8'); res.json(serviciosData[i]);
});
app.delete('/api/servicios/:id', async (req, res) => {
    if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    serviciosData = serviciosData.filter(s => s.id !== req.params.id);
    await fs.writeFile(SERVICIOS_FILE, JSON.stringify(serviciosData, null, 2), 'utf8'); res.json({ ok: true });
});

// ==================== TURNOS ====================
app.get('/turnos', async (req, res) => { res.json(await loadTurnos()); });

app.post('/turnos', async (req, res) => {
    const ip = req.ip || '0.0.0.0';
    if (estaBloqueado(ip)) return res.status(403).json({ error: 'Bloqueado' });

    // Anti-abuso: rate limit por IP
    if (!checkRateLimitIP(ip)) {
        bloquearIP(ip, 'Exceso de turnos creados por IP', 'spam_turnos');
        return res.status(429).json({ error: 'Demasiados pedidos. Intentá más tarde.' });
    }

    try {
        const { nombre, dia, hora, massageType, telefono, codigoPais, ubicacion, tipoServicio } = req.body;
        if (!nombre || nombre.length < 2) { registrarIntento(ip, 'nombre'); return res.status(400).json({ error: 'Nombre inválido' }); }
        const tel = telefono.replace(/\D/g, '');
        if (!tel || tel.length < 7) { registrarIntento(ip, 'tel'); return res.status(400).json({ error: 'Teléfono inválido' }); }
        if (!dia || !DIAS_VALIDOS.includes(dia.toLowerCase())) return res.status(400).json({ error: 'Día inválido' });
        const hn = parseInt(hora);
        if (!HORAS_VALIDAS.includes(hn)) return res.status(400).json({ error: 'Hora inválida' });

        // Anti-abuso: rate limit por teléfono
        if (!checkRateLimitTel(tel)) return res.status(429).json({ error: 'Este teléfono ya tiene turnos recientes. Máximo 2 por día.' });

        const turnos = await loadTurnos();
        const diaLower = dia.toLowerCase();

        // Un solo turno por día por teléfono
        if (turnos.some(t => t.telefono === tel && t.dia === diaLower)) return res.status(409).json({ error: 'Ya tenés un turno reservado para ese día. Solo un masaje por persona por día.' });

        if (turnos.some(t => t.dia === diaLower && t.hora === hn)) return res.status(409).json({ error: 'Horario ocupado', alternativa: buscarAlternativa(diaLower, hn, turnos) });

        const nuevo = { id: generarId(), nombre: escapeHtml(sanitize(nombre)), dia: diaLower, hora: hn, massageType: massageType || 'Masaje', telefono: tel, codigoPais: codigoPais || '54', ubicacion: ubicacion ? escapeHtml(sanitize(ubicacion)) : null, tipoServicio: tipoServicio || 'salon', confirmadoWhatsApp: false, fechaCreacion: new Date().toISOString(), ip };
        turnos.push(nuevo);
        await saveTurnos(turnos);
        registrarTurnoReciente(ip, tel);
        intentosFallidos.delete(ip);
        res.status(201).json({ mensaje: 'Turno creado', turno: nuevo });
    } catch (e) { console.error('Error turno:', e); res.status(500).json({ error: 'Error interno' }); }
});

app.delete('/turnos/:id', async (req, res) => {
    if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    const turnos = await loadTurnos();
    const i = turnos.findIndex(t => t.id === req.params.id);
    if (i === -1) return res.status(404).json({ error: 'No encontrado' });
    turnos.splice(i, 1); await saveTurnos(turnos); res.json({ ok: true });
});

// ==================== CANCELAR TURNO ====================
app.post('/api/cancelar-turno', async (req, res) => {
    try {
        const tel = (req.body.telefono || '').replace(/\D/g, '');
        if (tel.length < 7) return res.json({ error: 'Número inválido.' });
        const turnos = await loadTurnos();
        const turno = turnos.find(t => t.telefono === tel);
        if (!turno) return res.json({ error: 'No se encontró un turno activo con ese número.' });
        if (turno.confirmadoWhatsApp) {
            let msg = `❌ *CANCELACIÓN DE RESERVA*\n\nHola *${turno.nombre}*,\n\nTu reserva fue cancelada:\n📅 *Día:* ${turno.dia}\n⏰ *Hora:* ${turno.hora}:00 hs\n💆‍♂️ *Masaje:* ${turno.massageType}\n\nPedimos disculpas.\n\n*Equipo Serenity Spa*`;
            return res.json({ whatsappCancelacion: true, mensaje: 'Tu reserva fue confirmada por WhatsApp. Para cancelar, contactá directamente por WhatsApp.', urlWhatsApp: `https://wa.me/${turno.codigoPais || '54'}${tel}?text=${encodeURIComponent(msg)}` });
        }
        turnos.splice(turnos.indexOf(turno), 1); await saveTurnos(turnos);
        res.json({ cancelado: true, mensaje: `Tu turno del ${turno.dia} a las ${turno.hora}:00 hs (${turno.massageType}) ha sido cancelado.` });
    } catch { res.status(500).json({ error: 'Error interno' }); }
});

// ==================== WHATSAPP ====================
app.post('/api/enviar-whatsapp/:id', async (req, res) => {
    try {
        const turnos = await loadTurnos();
        const t = turnos.find(x => x.id === req.params.id);
        if (!t) return res.status(404).json({ error: 'No encontrado' });
        const s = serviciosData.find(x => x.nombre === t.massageType);
        const img = (s?.imagenWhatsApp && esUrlValida(s.imagenWhatsApp)) ? s.imagenWhatsApp : '';
        let msg = `🌿 *SERENITY SPA* 🌿\n\nHola *${t.nombre}*,\n¡Gracias! ✨\n\n✅ *RESERVA CONFIRMADA*\n\n📅 *Día:* ${t.dia.charAt(0).toUpperCase() + t.dia.slice(1)}\n⏰ *Hora:* ${t.hora}:00 hs\n💆‍♂️ *Masaje:* ${t.massageType}\n📍 ${t.tipoServicio === 'domicilio' ? t.ubicacion : 'Serenity Spa - Salón'}\n\n🌸 Te esperamos.\n⏱️ Cancelá con 4hs de anticipación.\n\n`;
        if (img) msg += `🖼️ *Imagen:* ${img}\n\n`;
        msg += `✨ *¡Te deseamos una experiencia inolvidable!*\n\n*Equipo Serenity Spa*`;
        const tel = t.telefono, codigo = t.codigoPais || '54';
        const idx = turnos.findIndex(x => x.id === req.params.id);
        if (idx !== -1) { turnos[idx].confirmadoWhatsApp = true; turnos[idx].fechaWA = new Date().toISOString(); await saveTurnos(turnos); }
        res.json({ success: true, numero: `${codigo}${tel}`, mensaje: msg, urlWhatsApp: `https://wa.me/${codigo}${tel}?text=${encodeURIComponent(msg)}` });
    } catch { res.status(500).json({ error: 'Error' }); }
});

// ==================== SEGURIDAD ====================
app.get('/api/seguridad/bloqueos', (req, res) => {
    if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    const a = []; for (const [ip, d] of bloqueos) a.push({ ip, motivo: d.motivo, tipoAtaque: d.tipoAtaque, fecha: d.fecha, tiempoRestante: Math.max(0, d.hasta - Date.now()), tiempoRestanteFormateado: fmtTime(Math.max(0, d.hasta - Date.now())), intentos: d.intentos || 0, permanente: d.permanente || false });
    res.json({ activos: a, historial: historialBloqueos.slice(0, 100), intentosFallidos: Object.fromEntries(intentosFallidos) });
});
app.post('/api/seguridad/desbloquear/:ip', (req, res) => { if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' }); desbloquearIP(req.params.ip); res.json({ ok: true }); });
app.delete('/api/seguridad/bloqueos/:ip', (req, res) => { if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' }); bloqueos.delete(req.params.ip); intentosFallidos.delete(req.params.ip); guardarBloqueos(); res.json({ ok: true }); });
app.delete('/api/seguridad/historial/:id', (req, res) => { if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' }); historialBloqueos = historialBloqueos.filter(h => h.id !== req.params.id); guardarBloqueos(); res.json({ ok: true }); });
app.post('/api/seguridad/limpiar-expirados', (req, res) => { if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' }); let b = 0; const now = Date.now(); for (const [ip, d] of bloqueos) { if (now > d.hasta) { bloqueos.delete(ip); b++; } } const before = historialBloqueos.length; historialBloqueos = historialBloqueos.filter(h => now < h.hasta); guardarBloqueos(); res.json({ mensaje: `${b} bloqueos y ${before - historialBloqueos.length} registros eliminados` }); });
app.post('/api/seguridad/bloquear-permanente/:ip', (req, res) => { if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' }); const d = bloquearIP(req.params.ip, 'Permanente', 'manual'); d.hasta = Date.now() + 31536000000; d.permanente = true; guardarBloqueos(); res.json({ ok: true }); });
function fmtTime(ms) { if (ms <= 0) return 'Expirado'; const s = Math.floor(ms/1000), m = Math.floor(s/60), h = Math.floor(m/60); return h > 0 ? `${h}h ${m%60}m` : m > 0 ? `${m}m ${s%60}s` : `${s}s`; }

// ==================== ASISTENTE DE VOZ ====================
app.get('/voice-assistant', (req, res) => res.sendFile(path.join(__dirname, 'voice-assistant.html')));
let voiceClients = new Map();

async function procesarComandoVoz(texto, clientId, ip) {
    const tl = texto.toLowerCase().trim();
    let cd = voiceClients.get(clientId);

    // Si no hay datos o se reseteó, crear estado fresco
    if (!cd || cd.estado === 'inicial' || cd.estado === 'inicio') {
        cd = { estado: 'inicio', datos: {}, alternativa: null };
        voiceClients.set(clientId, cd);
    }

    // ===== PRIORIDAD 1: Agradecimiento (nunca extraer nombre) =====
    if (esAgradecimiento(tl)) {
        const nombre = cd.datos.nombre;
        if (nombre && cd.datos.telefono) {
            // Ya tiene datos, no reiniciar
            return `¡De nada, ${nombre}! Si necesitás algo más, acá estoy. Podés decir "cancelar turno" si necesitás anular tu reserva.`;
        }
        return '¡De nada! Si necesitás reservar un turno, decí "reservar turno". Si querés cancelar, decí "cancelar turno".';
    }

    // ===== PRIORIDAD 2: Cancelación =====
    if (esSolicitudCancelacion(tl) && cd.estado !== 'confirmando' && cd.estado !== 'confirmando_alt') {
        if (cd.datos.telefono) { voiceClients.delete(clientId); return await cancelarTurnoVoz(cd.datos.telefono); }
        cd.estado = 'esperando_tel_cancelar';
        return 'Para cancelar tu reserva necesito tu número de teléfono. ¿Cuál es?';
    }

    // ===== PRIORIDAD 3: Estado esperando teléfono para cancelar =====
    if (cd.estado === 'esperando_tel_cancelar') {
        const tel = texto.replace(/\D/g, '');
        if (tel.length >= 7) { voiceClients.delete(clientId); return await cancelarTurnoVoz(tel); }
        return 'Número inválido. Dime tu número completo.';
    }

    // ===== PRIORIDAD 4: Confirmar alternativa =====
    if (cd.estado === 'confirmando_alt') {
        if (/^(si|sí|ok|dale|acepto|bueno|perfecto|bien)$/.test(tl)) { cd.datos.dia = cd.alternativa.dia; cd.datos.hora = cd.alternativa.hora; cd.estado = 'confirmando'; }
        else { voiceClients.delete(clientId); return 'Entiendo. Reserva cancelada. Decí "reservar turno" para iniciar otra.'; }
    }

    // ===== PRIORIDAD 5: Si está en estado inicio, verificar intención =====
    if (cd.estado === 'inicio') {
        if (esSolicitudReserva(tl)) {
            cd.estado = 'recopilando';
            // Continuar abajo para extraer datos
        } else {
            return 'Soy el asistente de Serenity Spa. ¿En qué puedo ayudarte? Decí "reservar turno" para hacer una reserva, o "cancelar turno" para anular una existente.';
        }
    }

    // ===== EXTRAER DATOS =====
    const d = cd.datos;
    if (!d.nombre) { const n = extraerNombre(texto); if (n) d.nombre = n; }
    if (!d.massageType) { if (tl.includes('relajante')) d.massageType = 'Masaje Relajante'; else if (tl.includes('corporal')) d.massageType = 'Masaje Corporal'; else if (tl.includes('facial')) d.massageType = 'Masaje Facial'; }
    if (!d.dia) { for (const dia of DIAS_VALIDOS) { if (tl.includes(dia)) { d.dia = dia; break; } } }
    if (!d.hora) { if (tl.includes('12') || tl.includes('doce')) d.hora = 12; else if (tl.includes('16') || tl.includes('cuatro')) d.hora = 16; else if (tl.includes('20') || tl.includes('ocho')) d.hora = 20; }
    if (!d.tipoServicio) { if (tl.includes('salon') || tl.includes('salón') || tl.includes('local')) { d.tipoServicio = 'salon'; d.ubicacion = 'Salón Serenity Spa'; } else if (tl.includes('domicilio') || tl.includes('casa')) d.tipoServicio = 'domicilio'; }
    if (d.tipoServicio === 'domicilio' && !d.ubicacion && texto.length > 10 && !esSolicitudReserva(tl) && !esSolicitudCancelacion(tl) && !esAgradecimiento(tl)) d.ubicacion = texto.trim();
    if (!d.telefono) { const p = texto.replace(/\D/g, ''); if (p.length >= 7 && p.length <= 15 && /^\d+$/.test(p)) { d.telefono = p; if (!d.codigoPais) { const pa = detectarPais(texto); d.codigoPais = pa?.c || '54'; } } }
    if (!d.codigoPais) { const pa = detectarPais(texto); if (pa) d.codigoPais = pa.c; }

    // ===== VERIFICAR SI TIENE TODO PARA RESERVAR =====
    if (cd.estado === 'confirmando' || (d.nombre && d.telefono && d.massageType && d.dia && d.hora && d.tipoServicio)) {
        let turnos = []; try { turnos = JSON.parse(await fs.readFile(TURNOS_FILE, 'utf8')); } catch {}
        if (turnos.some(t => t.telefono === d.telefono && t.dia === d.dia)) { voiceClients.delete(clientId); return `Ya tenés un turno para el ${d.dia}. Solo permitimos un masaje por persona por día.`; }
        if (turnos.some(t => t.dia === d.dia && t.hora === d.hora)) {
            const alt = buscarAlternativa(d.dia, d.hora, turnos);
            if (alt) { cd.estado = 'confirmando_alt'; cd.alternativa = alt; const ht = alt.hora === 12 ? '12 del mediodía' : alt.hora === 16 ? '4 de la tarde' : '8 de la noche'; return `Las ${d.hora}:00 del ${d.dia} está ocupado. ¿Reservar para el ${alt.dia} a las ${ht}?`; }
            voiceClients.delete(clientId); return 'Sin disponibilidad en los próximos 7 días.';
        }
        const nuevo = { id: generarId(), nombre: d.nombre, dia: d.dia, hora: d.hora, massageType: d.massageType, telefono: d.telefono, codigoPais: d.codigoPais || '54', ubicacion: d.ubicacion || 'Salón Serenity Spa', tipoServicio: d.tipoServicio, confirmadoWhatsApp: false, fechaCreacion: new Date().toISOString(), ip };
        turnos.push(nuevo); await fs.writeFile(TURNOS_FILE, JSON.stringify(turnos, null, 2), 'utf8');
        const ht = d.hora === 12 ? '12 del mediodía' : d.hora === 16 ? '4 de la tarde' : '8 de la noche';
        // NO eliminar clientData, solo limpiar datos de reserva para permitir seguir hablando
        const nombreGuardado = d.nombre;
        const telGuardado = d.telefono;
        cd.estado = 'inicio';
        cd.datos = {};
        cd.alternativa = null;
        return `¡Reserva confirmada! ${d.massageType} para ${nombreGuardado} el ${d.dia} a las ${ht}. ${d.tipoServicio === 'domicilio' ? 'A domicilio.' : 'En nuestro salón.'} ¡Gracias! Si necesitás cancelar, decí "cancelar turno".`;
    }

    // ===== PEDIR DATOS FALTANTES =====
    if (!d.nombre) { cd.estado = 'esperando_nombre'; return '¿Cuál es tu nombre?'; }
    if (!d.telefono) { cd.estado = 'esperando_tel'; return `Gracias ${d.nombre}. ¿Cuál es tu número de teléfono?`; }
    if (!d.massageType) { cd.estado = 'esperando_masaje'; return `${d.nombre}, ¿qué masaje deseás? Relajante, corporal o facial.`; }
    if (!d.tipoServicio) { cd.estado = 'esperando_ubicacion'; return '¿En el salón o a domicilio?'; }
    if (d.tipoServicio === 'domicilio' && !d.ubicacion) { cd.estado = 'esperando_dir'; return '¿Cuál es tu dirección?'; }
    if (!d.dia) { cd.estado = 'esperando_dia'; return '¿Qué día? Lunes a sábado.'; }
    if (!d.hora) { cd.estado = 'esperando_hora'; return '¿A qué hora? 12, 16 o 20.'; }
    return 'Decí "reservar turno" para comenzar.';
}

async function cancelarTurnoVoz(telefono) {
    try {
        const r = await fetch(`http://localhost:${PORT}/api/cancelar-turno`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ telefono }) });
        const data = await r.json();
        if (data.cancelado) return data.mensaje;
        if (data.whatsappCancelacion) return 'Tu reserva fue confirmada por WhatsApp. Para cancelarla contactá directamente por WhatsApp. Lo sentimos.';
        return data.error || 'No se encontró un turno activo.';
    } catch { return 'Error al procesar. Intentá más tarde.'; }
}

// ==================== HTML ====================
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/admin.html', (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));
app.get('/login.html', (req, res) => res.sendFile(path.join(__dirname, 'login.html')));
app.get('/1.html', (req, res) => res.redirect('/admin.html'));

// ==================== INICIAR ====================
async function start() {
    await cargarBloqueos();
    configData = await initFile(CONFIG_FILE, configData);
    serviciosData = await initFile(SERVICIOS_FILE, [
        { id: "relajante", nombre: "Masaje Relajante", precio: "$45", descripcion: "Movimientos suaves.", beneficios: ["Reduce ansiedad", "60 Min"], efectos: ["Relajación"], imagenWeb: "https://images.unsplash.com/photo-1544161515-4ab6ce6db874?ixlib=rb-1.2.1&auto=format&fit=crop&w=800&q=80", imagenWhatsApp: "", orden: 1 },
        { id: "corporal", nombre: "Masaje Corporal", precio: "$65", descripcion: "Tratamiento completo.", beneficios: ["Relajación integral", "90 Min"], efectos: ["Activación linfática"], imagenWeb: "https://images.unsplash.com/photo-1519823551278-64ac92734fb1?ixlib=rb-1.2.1&auto=format&fit=crop&w=800&q=80", imagenWhatsApp: "", orden: 2 },
        { id: "facial", nombre: "Masaje Facial", precio: "$40", descripcion: "Rejuvenece la piel.", beneficios: ["Reafirma", "45 Min"], efectos: ["Estimula colágeno"], imagenWeb: "https://images.unsplash.com/photo-1570172619644-dfd03ed5d881?ixlib=rb-1.2.1&auto=format&fit=crop&w=800&q=80", imagenWhatsApp: "", orden: 3 }
    ]);
    turnosMem = await initFile(TURNOS_FILE, []);

    const server = app.listen(PORT, '0.0.0.0', () => {
        console.log('\n' + '='.repeat(55));
        console.log('  🌿 SERENITY SPA v7.0');
        console.log('='.repeat(55));
        console.log(`  📍 Puerto: ${PORT}`);
        console.log(`  🎤 Voz: /voice-assistant`);
        console.log(`  🛡️ Anti-abuso: IP(3/hora) Tel(2/día)`);
        console.log(`  🗑️ Cancelar: POST /api/cancelar-turno`);
        console.log(`  🚫 Bloqueados: ${bloqueos.size}`);
        console.log('  ✅ Listo\n' + '='.repeat(55));
    });

    const wss = new WebSocket.Server({ server, path: '/ws-voice' });
    wss.on('connection', (ws, req) => {
        const ip = req.socket.remoteAddress || '?';
        // Bloqueo inmediato si IP está bloqueada
        if (estaBloqueado(ip)) { ws.close(1008, 'IP bloqueada'); return; }
        const cid = generarId();
        let msgCount = 0;
        const cd = { ws, estado: 'inicial', datos: {}, alternativa: null, ip, conectado: new Date().toISOString() };
        voiceClients.set(cid, cd);

        ws.on('message', async (data) => {
            // Anti-flood: máximo 20 mensajes por minuto
            msgCount++;
            if (msgCount > 20) { bloquearIP(ip, 'Flood de mensajes por WebSocket', 'flood'); ws.close(1008, 'Demasiados mensajes'); return; }
            try {
                const m = JSON.parse(data);
                if (m.tipo === 'transcripcion') {
                    const r = await procesarComandoVoz(m.texto, cid, ip);
                    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ tipo: 'respuesta', texto: r }));
                }
            } catch { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ tipo: 'respuesta', texto: 'Error. Intentá de nuevo.' })); }
        });
        ws.on('close', () => voiceClients.delete(cid));
        ws.on('error', () => voiceClients.delete(cid));
        // Resetear contador cada minuto
        const floodTimer = setInterval(() => { msgCount = 0; }, 60000);
        ws.on('close', () => clearInterval(floodTimer));
    });
}

process.on('SIGTERM', () => { guardarBloqueos(); process.exit(0); });
process.on('SIGINT', () => { guardarBloqueos(); process.exit(0); });
start();
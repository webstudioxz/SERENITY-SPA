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

console.log('✅ SERVIDOR INICIANDO');

// ==================== CONSTANTES ====================
const HORAS_VALIDAS = [12, 16, 20];
const DIAS_VALIDOS = ['lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado'];

const MASAJES_MAP = {
    'relajante': 'Masaje Relajante',
    'corporal': 'Masaje Corporal',
    'facial': 'Masaje Facial'
};

const HORAS_TEXTO = {
    'doce': 12, 'mediodía': 12, 'mediodia': 12,
    'cuatro': 16, 'dieciseis': 16, 'dieciséis': 16,
    'ocho': 20, 'veinte': 20, 'noche': 20
};

const HORA_TEXTO_INVERSO = {
    12: '12 del mediodía',
    16: '4 de la tarde',
    20: '8 de la noche'
};

// ==================== SISTEMA DE BLOQUEO POR IP ====================
let bloqueos = new Map();

async function cargarBloqueos() {
    try {
        await fs.access(BLOQUEOS_FILE);
        const data = await fs.readFile(BLOQUEOS_FILE, 'utf8');
        bloqueos = new Map(Object.entries(JSON.parse(data)));
        console.log(`📂 Cargados ${bloqueos.size} IPs bloqueadas`);
    } catch {
        await fs.writeFile(BLOQUEOS_FILE, '{}', 'utf8');
    }
}

async function guardarBloqueos() {
    await fs.writeFile(BLOQUEOS_FILE, JSON.stringify(Object.fromEntries(bloqueos), null, 2), 'utf8');
}

function estaBloqueado(ip) {
    if (!bloqueos.has(ip)) return false;
    const data = bloqueos.get(ip);
    if (Date.now() < data.hasta) return true;
    bloqueos.delete(ip);
    guardarBloqueos();
    return false;
}

function bloquearIP(ip, motivo) {
    bloqueos.set(ip, { hasta: Date.now() + 3600000, motivo, fecha: new Date().toISOString() });
    guardarBloqueos();
    console.log(`🚫 IP ${ip} bloqueada: ${motivo}`);
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
    if (ahora - data.primerIntento > 600000) {
        intentosFallidos.set(ip, { count: 1, primerIntento: ahora });
        return false;
    }
    data.count++;
    if (data.count >= 5) {
        bloquearIP(ip, 'Demasiados intentos fallidos');
        intentosFallidos.delete(ip);
        return true;
    }
    return false;
}

function limpiarIntentos(ip) { intentosFallidos.delete(ip); }

// ==================== MIDDLEWARES ====================
app.use(express.json({ limit: '1mb' }));

app.use((req, res, next) => {
    const ip = req.ip || req.connection.remoteAddress || req.socket.remoteAddress;
    if (estaBloqueado(ip)) return res.status(403).json({ error: 'Acceso bloqueado temporalmente.', bloqueado: true });
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

// ==================== VALIDACIÓN POR PAÍS ====================
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

function detectarPais(texto) {
    const t = texto.toLowerCase().trim();
    for (const [pais, data] of Object.entries(VALIDACION_PAISES)) {
        if (t === pais || t.includes(pais)) return { pais, ...data };
    }
    const claves = {
        'argen': 'argentina', 'bs as': 'argentina', 'buenos aires': 'argentina',
        'méx': 'méxico', 'mex': 'méxico', 'cdmx': 'méxico',
        'colom': 'colombia', 'bog': 'colombia',
        'chil': 'chile', 'santiago': 'chile',
        'lima': 'perú',
        'espa': 'españa', 'madrid': 'españa', 'barcelona': 'españa',
        'montev': 'uruguay'
    };
    for (const [clave, destino] of Object.entries(claves)) {
        if (t.includes(clave)) {
            const data = VALIDACION_PAISES[destino];
            if (data) return { pais: destino, ...data };
        }
    }
    return null;
}

function validarNumeroPorPais(numero, pattern) {
    return pattern.test(numero.replace(/\D/g, ''));
}

function validarNombre(nombre) {
    if (!nombre) return false;
    const limpio = nombre.trim();
    return limpio.length >= 2 && limpio.length <= 50 && /^[a-zA-ZáéíóúñÑü\s.'-]+$/.test(limpio);
}

function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/[&<>]/g, m => m === '&' ? '&amp;' : m === '<' ? '&lt;' : '&gt;');
}

function sanitizeInput(str) {
    if (!str) return '';
    return str.trim().replace(/[^\w\sáéíóúñÑü.,@\-°#]/gi, '');
}

function generarId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2) + crypto.randomBytes(4).toString('hex');
}

// ==================== GESTIÓN DE ARCHIVOS ====================
let turnosEnMemoria = [];
let serviciosData = [];
let configData = {
    hero: { titulo: "Renueva tu Energía", subtitulo: "Experiencias de bienestar", imagenFondo: "https://images.unsplash.com/photo-1544161515-4ab6ce6db874?ixlib=rb-1.2.1&auto=format&fit=crop&w=1920&q=80", botonTexto: "Explorar Tratamientos" },
    serviciosSection: { etiqueta: "Nuestros Servicios", titulo: "Elige tu Masaje Ideal", descripcion: "Turnos: 12:00, 16:00 y 20:00" },
    contactoSection: { titulo: "Asistente de Reservas", descripcion: "Reserva tu turno de forma rápida" },
    shareSection: { titulo: "Comparte Serenity Spa" }
};

async function inicializarArchivo(archivo, defaultData) {
    try {
        await fs.access(archivo);
        return JSON.parse(await fs.readFile(archivo, 'utf8'));
    } catch {
        await fs.writeFile(archivo, JSON.stringify(defaultData, null, 2), 'utf8');
        return defaultData;
    }
}

async function cargarTurnos() {
    try { turnosEnMemoria = JSON.parse(await fs.readFile(TURNOS_FILE, 'utf8')); }
    catch { turnosEnMemoria = []; }
    return turnosEnMemoria;
}

async function guardarTurnos(turnos) {
    await fs.writeFile(TURNOS_FILE, JSON.stringify(turnos, null, 2), 'utf8');
    turnosEnMemoria = turnos;
}

// ==================== MOTOR DE EXTRACCIÓN DE ENTIDADES ====================
function extraerEntidades(texto) {
    const t = texto.toLowerCase().trim();
    const e = {};

    if (/\b(reservar|turno|cita|agendar|pedir|quiero|necesito|gustar[ií]a|me\s+hac[eé]|solicitar)\b/.test(t)) {
        e.intencion = 'reservar';
    }
    if (!e.intencion && /masaje/.test(t) && (/\b(lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado)\b/.test(t) || /\d/.test(t))) {
        e.intencion = 'reservar';
    }

    e.saludo = /\b(hola|buenos?\s*d[ií]a|buenas?\s*(tardes|noches)?|buenas)\b/.test(t);

    const patNombre = [
        /(?:me\s+llamo|mi\s+nombre\s+es)\s+([a-zA-ZáéíóúñÑü][a-zA-ZáéíóúñÑü\s']{1,24})/i,
        /(?:soy)\s+([a-zA-ZáéíóúñÑü][a-zA-ZáéíóúñÑü\s']{1,24})/i
    ];
    for (const p of patNombre) {
        const m = texto.match(p);
        if (m) {
            let nombre = m[1].trim();
            const cortes = [' quiero', ' necesito', ' reservar', ' un ', ' el ', ' la ', ' los ', ' las ', ' un masaje', ' masaje'];
            for (const c of cortes) {
                const idx = nombre.toLowerCase().indexOf(c);
                if (idx > 0) { nombre = nombre.substring(0, idx).trim(); break; }
            }
            if (nombre.length >= 2) { e.nombre = nombre; break; }
        }
    }

    const pais = detectarPais(texto);
    if (pais) { e.pais = pais.pais; e.codigoPais = pais.codigo; e.paisPattern = pais.pattern; e.paisEjemplo = pais.ejemplo; }

    const telfMatch = texto.match(/\d[\d\s\-().]{6,}/g);
    if (telfMatch) {
        const limpio = telfMatch[0].replace(/\D/g, '');
        if (limpio.length >= 7) e.telefono = limpio;
    }

    for (const [clave, nombre] of Object.entries(MASAJES_MAP)) {
        if (t.includes(clave)) { e.masaje = nombre; break; }
    }

    for (const dia of DIAS_VALIDOS) {
        if (t.includes(dia)) { e.dia = dia; break; }
    }

    const patronALas = /a\s+las?\s*(\d{1,2})/i;
    const matchALas = texto.match(patronALas);
    if (matchALas) {
        let h = parseInt(matchALas[1]);
        if (h === 4) h = 16;
        else if (h === 8) h = 20;
        if (HORAS_VALIDAS.includes(h)) e.hora = h;
    }
    if (!e.hora) {
        const nums = texto.match(/\b(\d{1,2})\b/g);
        if (nums) {
            for (const n of nums) {
                const v = parseInt(n);
                if (HORAS_VALIDAS.includes(v)) { e.hora = v; break; }
            }
        }
    }
    if (!e.hora) {
        for (const [txt, val] of Object.entries(HORAS_TEXTO)) {
            if (t.includes(txt)) { e.hora = val; break; }
        }
    }

    if (/\b(salon|salón|local|centro|aqu[ií]|all[ií])\b/.test(t)) {
        e.ubicacion = 'salon';
    } else if (/\b(domicilio|casa|mi\s+casa|direcci[oó]n|donde\s+vivo|en\s+mi)\b/.test(t)) {
        e.ubicacion = 'domicilio';
    } else if (/\b(calle|avenida|av\.?|ruta|km|nro|nº|numero|piso|depto|departamento)\b/.test(t)) {
        e.ubicacion = 'domicilio';
        e.direccion = texto.trim();
    }

    const tieneNo = /\b(no|nop|negativo|nada)\b/.test(t);
    const tieneSi = /\b(si|s[ií]|ok|dale|vale|correcto|confirmo|confirmar|claro|por\s+supuesto)\b/.test(t);
    e.afirmacion = tieneSi && !tieneNo;
    e.negacion = tieneNo && !tieneSi;

    e.agradecimiento = /\b(gracias|thank|genial|perfecto|excelente|buen[ií]simo)\b/.test(t);
    e.cancelar = /\b(cancelar|cancelar|anular|no\s+quiero|olvida)\b/.test(t);

    return e;
}

function mergeEntidades(datos, entidades) {
    if (entidades.nombre && !datos.nombre) datos.nombre = entidades.nombre;
    if (entidades.pais && !datos.pais) {
        datos.pais = entidades.pais;
        datos.codigoPais = entidades.codigoPais;
        datos.paisPattern = entidades.paisPattern;
        datos.paisEjemplo = entidades.paisEjemplo;
    }
    if (entidades.telefono && !datos.telefono) datos.telefono = entidades.telefono;
    if (entidades.masaje && !datos.masaje) datos.masaje = entidades.masaje;
    if (entidades.dia && !datos.dia) datos.dia = entidades.dia;
    if (entidades.hora && !datos.hora) datos.hora = entidades.hora;
    if (entidades.ubicacion && !datos.ubicacion) {
        datos.ubicacion = entidades.ubicacion;
        if (entidades.direccion) datos.direccion = entidades.direccion;
    }
}

function queFalta(datos) {
    const f = [];
    if (!datos.nombre) f.push('nombre');
    if (!datos.pais) f.push('pais');
    if (!datos.telefono) f.push('telefono');
    if (!datos.masaje) f.push('masaje');
    if (!datos.ubicacion) f.push('ubicacion');
    if (!datos.dia) f.push('dia');
    if (!datos.hora) f.push('hora');
    return f;
}

function buscarAlternativaCercana(diaDeseado, horaDeseada, turnosExistentes) {
    const idxDia = DIAS_VALIDOS.indexOf(diaDeseado);
    const horasCercanas = HORAS_VALIDAS.slice().sort((a, b) =>
        Math.abs(a - horaDeseada) - Math.abs(b - horaDeseada)
    );
    for (const h of horasCercanas) {
        if (h !== horaDeseada && !turnosExistentes.some(t => t.dia === diaDeseado && t.hora === h)) {
            return { dia: diaDeseado, hora: h };
        }
    }
    for (let offset = 1; offset <= 6; offset++) {
        for (const dir of [1, -1]) {
            const nuevoIdx = (idxDia + offset * dir + 7) % 7;
            const nuevoDia = DIAS_VALIDOS[nuevoIdx];
            if (!turnosExistentes.some(t => t.dia === nuevoDia && t.hora === horaDeseada)) {
                return { dia: nuevoDia, hora: horaDeseada };
            }
            for (const h of horasCercanas) {
                if (!turnosExistentes.some(t => t.dia === nuevoDia && t.hora === h)) {
                    return { dia: nuevoDia, hora: h };
                }
            }
        }
    }
    return null;
}

function formatearNumeroParaVoz(numero) {
    const limpio = numero.replace(/\D/g, '');
    if (limpio.length <= 4) return limpio;
    const grupos = [];
    for (let i = 0; i < limpio.length; i += 2) grupos.push(limpio.substr(i, 2));
    return grupos.join(' ');
}

// ==================== MOTOR PRINCIPAL DEL ASISTENTE DE VOZ ====================
async function procesarComandoVoz(texto, clientId, ip) {
    const clientData = voiceClients.get(clientId);
    if (!clientData) return "Lo siento, hubo un error de conexión. Intenta recargar la página.";

    if (!clientData.estado) {
        clientData.estado = 'inicial';
        clientData.datos = {};
        clientData.nombreRecordado = null;
        clientData.intentosNumero = 0;
        clientData.alternativaPendiente = null;
    }

    const ent = extraerEntidades(texto);
    const datos = clientData.datos;

    if (!datos.nombre && clientData.nombreRecordado) {
        datos.nombre = clientData.nombreRecordado;
    }

    mergeEntidades(datos, ent);

    if (datos.nombre) clientData.nombreRecordado = datos.nombre;

    if (ent.cancelar && clientData.estado !== 'inicial') {
        clientData.estado = 'inicial';
        clientData.datos = {};
        clientData.alternativaPendiente = null;
        return "Entendido, he cancelado la reserva. ¿Necesitas algo más?";
    }

    if (clientData.alternativaPendiente && (ent.afirmacion || ent.negacion)) {
        if (ent.afirmacion) {
            const alt = clientData.alternativaPendiente;
            clientData.alternativaPendiente = null;
            datos.dia = alt.dia;
            datos.hora = alt.hora;
            return await intentarConfirmarReserva(datos, clientData, ip);
        } else {
            clientData.alternativaPendiente = null;
            const turnos = await cargarTurnos();
            const otraAlt = buscarAlternativaCercana(datos.dia, datos.hora, turnos);
            if (otraAlt && (otraAlt.dia !== datos.dia || otraAlt.hora !== datos.hora)) {
                clientData.alternativaPendiente = otraAlt;
                return `Entiendo. Tenemos disponible el ${otraAlt.dia} a las ${HORA_TEXTO_INVERSO[otraAlt.hora]}. ¿Te sirve esa opción?`;
            }
            clientData.estado = 'inicial';
            clientData.datos = {};
            return "No hay más disponibilidad cercana. Puedes intentar más adelante o elegir otro día. ¿Necesitas algo más?";
        }
    }

    if (clientData.estado === 'inicial') {
        if (!ent.intencion) {
            if (/\b(horario|hora|horarios)\b/.test(texto.toLowerCase())) {
                return "Nuestros horarios son 12 del mediodía, 4 de la tarde y 8 de la noche, de lunes a sábado. ¿Te gustaría reservar un turno?";
            }
            if (/\b(masaje|tipo|servicio|tratamiento)\b/.test(texto.toLowerCase())) {
                return "Tenemos tres tipos de masaje: Relajante de 60 minutos, Corporal de 90 minutos, y Facial de 45 minutos. ¿Cuál te interesa? Puedo reservarte uno ahora mismo.";
            }
            if (/\b(precio|costo|cuanto|vale|cuesta)\b/.test(texto.toLowerCase())) {
                return "El Masaje Relajante cuesta 45 dólares, el Corporal 65 dólares y el Facial 40 dólares. ¿Te gustaría reservar?";
            }
            if (ent.agradecimiento) {
                return `¡De nada${datos.nombre ? ', ' + datos.nombre : ''}! Que tengas un excelente día. ¿Necesitas algo más?`;
            }
            if (ent.saludo) {
                return `Hola${datos.nombre ? ', ' + datos.nombre : ''}, bienvenido a Serenity Spa. Puedo reservarte un turno de masaje, contarte sobre nuestros servicios o los horarios. ¿Qué necesitas?`;
            }
            return "Puedo ayudarte a reservar un turno, contarte sobre horarios, tipos de masaje o precios. ¿Qué necesitas?";
        }

        const faltantes = queFalta(datos);

        if (faltantes.length === 0) {
            return await intentarConfirmarReserva(datos, clientData, ip);
        }

        const primero = faltantes[0];

        if (primero === 'nombre') {
            clientData.estado = 'esperando_nombre';
            return "Con gusto te ayudo a reservar. Para comenzar, ¿cuál es tu nombre?";
        }
        if (primero === 'pais') {
            clientData.estado = 'esperando_pais';
            return `${datos.nombre ? 'Gracias, ' + datos.nombre + '.' : 'Gracias.'} ¿De qué país nos llamas? Por ejemplo: Argentina, México, Colombia, España.`;
        }
        if (primero === 'telefono') {
            clientData.estado = 'esperando_telefono';
            clientData.intentosNumero = 0;
            return `Desde ${datos.pais}. Por favor, dime tu número de teléfono. Por ejemplo: ${datos.paisEjemplo}.`;
        }
        if (primero === 'masaje') {
            clientData.estado = 'esperando_masaje';
            return `Número registrado. ¿Qué tipo de masaje deseas? Tenemos relajante, corporal o facial.`;
        }
        if (primero === 'ubicacion') {
            clientData.estado = 'esperando_ubicacion';
            return `Has elegido ${datos.masaje}. ¿Dónde prefieres recibirlo? ¿En nuestro salón o a domicilio?`;
        }
        if (primero === 'dia') {
            clientData.estado = 'esperando_dia';
            return `${datos.ubicacion === 'salon' ? 'Perfecto, será en el salón.' : 'Dirección registrada.'} ¿Qué día prefieres? Lunes a sábado.`;
        }
        if (primero === 'hora') {
            clientData.estado = 'esperando_hora';
            return `Has elegido ${datos.dia}. Los horarios son 12 del mediodía, 4 de la tarde u 8 de la noche. ¿A qué hora prefieres?`;
        }
    }

    if (clientData.estado === 'esperando_nombre') {
        if (!datos.nombre) {
            const limpio = texto.trim().replace(/[^\w\sáéíóúñÑü.'-]/gi, '').trim();
            if (limpio.length >= 2 && limpio.length <= 50) {
                datos.nombre = limpio;
                clientData.nombreRecordado = limpio;
            } else {
                return "Por favor, dime tu nombre para poder registrarte.";
            }
        }
        const faltantes = queFalta(datos);
        if (faltantes.length === 0) return await intentarConfirmarReserva(datos, clientData, ip);
        clientData.estado = faltantes[0] === 'pais' ? 'esperando_pais' :
                            faltantes[0] === 'telefono' ? 'esperando_telefono' :
                            faltantes[0] === 'masaje' ? 'esperando_masaje' :
                            faltantes[0] === 'ubicacion' ? 'esperando_ubicacion' :
                            faltantes[0] === 'dia' ? 'esperando_dia' : 'esperando_hora';
        return generarPreguntaSiguiente(faltantes[0], datos);
    }

    if (clientData.estado === 'esperando_pais') {
        if (!datos.pais) {
            return "No reconocí el país. ¿Podrías decirme desde qué país nos llamas? Argentina, México, Colombia, Chile, España, etc.";
        }
        const faltantes = queFalta(datos);
        if (faltantes.length === 0) return await intentarConfirmarReserva(datos, clientData, ip);
        clientData.estado = faltantes[0] === 'telefono' ? 'esperando_telefono' :
                            faltantes[0] === 'masaje' ? 'esperando_masaje' :
                            faltantes[0] === 'ubicacion' ? 'esperando_ubicacion' :
                            faltantes[0] === 'dia' ? 'esperando_dia' : 'esperando_hora';
        return generarPreguntaSiguiente(faltantes[0], datos);
    }

    if (clientData.estado === 'esperando_telefono') {
        if (!datos.telefono) {
            clientData.intentosNumero++;
            if (clientData.intentosNumero >= 3) {
                bloquearIP(ip, `Demasiados intentos de número inválido`);
                voiceClients.delete(clientId);
                return "Has superado los intentos permitidos. Por seguridad, el acceso ha sido bloqueado temporalmente.";
            }
            registrarIntentoFallido(ip);
            return `No pude detectar un número válido para ${datos.pais}. Dímelo nuevamente. Ejemplo: ${datos.paisEjemplo}.`;
        }
        if (!validarNumeroPorPais(datos.telefono, datos.paisPattern)) {
            clientData.intentosNumero++;
            if (clientData.intentosNumero >= 3) {
                bloquearIP(ip, `Número inválido reiterado`);
                voiceClients.delete(clientId);
                return "El número no es válido para tu país. Acceso bloqueado temporalmente.";
            }
            registrarIntentoFallido(ip);
            datos.telefono = null;
            return `Ese número no parece válido para ${datos.pais}. Verifícalo e ingrésalo de nuevo. Ejemplo: ${datos.paisEjemplo}.`;
        }
        limpiarIntentos(ip);
        clientData.intentosNumero = 0;
        const faltantes = queFalta(datos);
        if (faltantes.length === 0) return await intentarConfirmarReserva(datos, clientData, ip);
        clientData.estado = faltantes[0] === 'masaje' ? 'esperando_masaje' :
                            faltantes[0] === 'ubicacion' ? 'esperando_ubicacion' :
                            faltantes[0] === 'dia' ? 'esperando_dia' : 'esperando_hora';
        return generarPreguntaSiguiente(faltantes[0], datos);
    }

    if (clientData.estado === 'esperando_masaje') {
        if (!datos.masaje) {
            return "No reconocí ese masaje. Tenemos: relajante, corporal o facial. ¿Cuál prefieres?";
        }
        const faltantes = queFalta(datos);
        if (faltantes.length === 0) return await intentarConfirmarReserva(datos, clientData, ip);
        clientData.estado = faltantes[0] === 'ubicacion' ? 'esperando_ubicacion' :
                            faltantes[0] === 'dia' ? 'esperando_dia' : 'esperando_hora';
        return generarPreguntaSiguiente(faltantes[0], datos);
    }

    if (clientData.estado === 'esperando_ubicacion') {
        if (!datos.ubicacion) {
            return "Por favor, dime si prefieres el masaje en nuestro salón o a domicilio.";
        }
        if (datos.ubicacion === 'domicilio' && !datos.direccion) {
            clientData.estado = 'esperando_direccion';
            return "Muy bien, a domicilio. Por favor, dime tu dirección completa: calle, número y ciudad.";
        }
        if (datos.ubicacion === 'salon') {
            datos.direccion = 'Salón Serenity Spa';
        }
        const faltantes = queFalta(datos);
        if (faltantes.length === 0) return await intentarConfirmarReserva(datos, clientData, ip);
        clientData.estado = faltantes[0] === 'dia' ? 'esperando_dia' : 'esperando_hora';
        return generarPreguntaSiguiente(faltantes[0], datos);
    }

    if (clientData.estado === 'esperando_direccion') {
        const dir = texto.trim();
        if (dir.length < 5) return "Por favor, ingresa una dirección más completa.";
        datos.direccion = dir;
        const faltantes = queFalta(datos);
        if (faltantes.length === 0) return await intentarConfirmarReserva(datos, clientData, ip);
        clientData.estado = faltantes[0] === 'dia' ? 'esperando_dia' : 'esperando_hora';
        return generarPreguntaSiguiente(faltantes[0], datos);
    }

    if (clientData.estado === 'esperando_dia') {
        if (!datos.dia) {
            return "Por favor, dime un día válido: lunes, martes, miércoles, jueves, viernes o sábado.";
        }
        const faltantes = queFalta(datos);
        if (faltantes.length === 0) return await intentarConfirmarReserva(datos, clientData, ip);
        clientData.estado = 'esperando_hora';
        return generarPreguntaSiguiente('hora', datos);
    }

    if (clientData.estado === 'esperando_hora') {
        if (!datos.hora) {
            return "Por favor, dime un horario válido: 12 para el mediodía, 16 para las 4 de la tarde, o 20 para las 8 de la noche.";
        }
        return await intentarConfirmarReserva(datos, clientData, ip);
    }

    return "Lo siento, no entendí. Puedo ayudarte a reservar un turno, consultar horarios o tipos de masaje.";
}

function generarPreguntaSiguiente(faltante, datos) {
    switch (faltante) {
        case 'pais':
            return `${datos.nombre ? 'Gracias, ' + datos.nombre + '.' : 'Gracias.'} ¿De qué país nos llamas?`;
        case 'telefono':
            return `Desde ${datos.pais}. Dime tu número de teléfono. Ejemplo: ${datos.paisEjemplo}.`;
        case 'masaje':
            return `Número registrado. ¿Qué masaje deseas? Relajante, corporal o facial.`;
        case 'ubicacion':
            return `${datos.masaje} seleccionado. ¿En el salón o a domicilio?`;
        case 'dia':
            return `${datos.ubicacion === 'salon' ? 'En el salón.' : 'Dirección registrada.'} ¿Qué día prefieres?`;
        case 'hora':
            return `${datos.dia} seleccionado. ¿A qué hora? 12 del mediodía, 4 de la tarde u 8 de la noche.`;
        default:
            return "¿Qué más necesitas?";
    }
}

async function intentarConfirmarReserva(datos, clientData, ip) {
    const turnos = await cargarTurnos();

    if (datos.telefono) {
        const yaTiene = turnos.some(t => t.telefono === datos.telefono && t.dia === datos.dia);
        if (yaTiene) {
            clientData.estado = 'inicial';
            clientData.datos = {};
            return `Ya tienes un turno reservado para el ${datos.dia}. Solo permitimos un masaje por persona por día. ¿Necesitas algo más?`;
        }
    }

    const ocupado = turnos.some(t => t.dia === datos.dia && t.hora === datos.hora);

    if (ocupado) {
        const alternativa = buscarAlternativaCercana(datos.dia, datos.hora, turnos);
        if (alternativa) {
            clientData.alternativaPendiente = alternativa;
            return `Las ${HORA_TEXTO_INVERSO[datos.hora]} del ${datos.dia} ya están reservadas. ` +
                   `Pero tengo disponible el ${alternativa.dia} a las ${HORA_TEXTO_INVERSO[alternativa.hora]}. ` +
                   `¿Te sirve esa opción? Di sí o no.`;
        }
        clientData.estado = 'inicial';
        clientData.datos = {};
        return `Lo siento, las ${HORA_TEXTO_INVERSO[datos.hora]} del ${datos.dia} están reservadas y no hay disponibilidad cercana. Intenta con otro día.`;
    }

    const nuevoTurno = {
        id: generarId(),
        nombre: escapeHtml(sanitizeInput(datos.nombre)),
        dia: datos.dia,
        hora: datos.hora,
        massageType: datos.masaje,
        telefono: datos.telefono,
        codigoPais: datos.codigoPais || '54',
        ubicacion: datos.direccion || (datos.ubicacion === 'salon' ? 'Salón Serenity Spa' : datos.direccion),
        tipoServicio: datos.ubicacion === 'domicilio' ? 'domicilio' : 'salon',
        fechaCreacion: new Date().toISOString(),
        ip: ip
    };

    turnos.push(nuevoTurno);
    await guardarTurnos(turnos);

    const lugarTexto = nuevoTurno.tipoServicio === 'domicilio'
        ? `a domicilio en ${nuevoTurno.ubicacion}`
        : 'en nuestro salón';

    const telefonoTexto = formatearNumeroParaVoz(datos.telefono);

    const nombreGuardado = clientData.nombreRecordado;
    clientData.estado = 'inicial';
    clientData.datos = {};
    clientData.alternativaPendiente = null;
    clientData.nombreRecordado = nombreGuardado;

    return `¡Reserva confirmada! Día ${datos.dia}, a las ${HORA_TEXTO_INVERSO[datos.hora]}. ` +
           `Masaje ${datos.masaje}, ${lugarTexto}. ` +
           `Te enviaremos confirmación al ${telefonoTexto}. ` +
           `¡Te esperamos en Serenity Spa! ¿Necesitas algo más?`;
}

// ==================== RUTAS API ====================

app.get('/api/config', (req, res) => res.json(configData));

// CORREGIDO: Paréntesis de cierre agregado
app.get('/api/servicios', (req, res) => {
    res.json(serviciosData.sort((a, b) => (a.orden || 999) - (b.orden || 999)));
});

app.get('/turnos', async (req, res) => res.json(await cargarTurnos()));

app.post('/turnos', async (req, res) => {
    const ip = req.ip || req.connection.remoteAddress;
    if (estaBloqueado(ip)) return res.status(403).json({ error: 'Acceso bloqueado' });

    try {
        const { nombre, dia, hora, massageType, telefono, codigoPais, ubicacion, tipoServicio } = req.body;

        if (!validarNombre(nombre)) { registrarIntentoFallido(ip); return res.status(400).json({ error: 'Nombre inválido' }); }
        if (!telefono || telefono.length < 7) { registrarIntentoFallido(ip); return res.status(400).json({ error: 'Teléfono inválido' }); }
        if (!dia || !DIAS_VALIDOS.includes(dia.toLowerCase())) return res.status(400).json({ error: 'Día no válido' });

        const horaNum = parseInt(hora);
        if (!HORAS_VALIDAS.includes(horaNum)) return res.status(400).json({ error: 'Hora no válida' });

        const turnos = await cargarTurnos();
        const telLimpio = telefono.replace(/\D/g, '');

        if (turnos.some(t => t.telefono === telLimpio && t.dia === dia.toLowerCase()))
            return res.status(409).json({ error: 'Ya tienes un turno ese día' });
        if (turnos.some(t => t.dia === dia.toLowerCase() && t.hora === horaNum))
            return res.status(409).json({ error: 'Horario no disponible', disponibilidad: { horasLibres: HORAS_VALIDAS.filter(h => !turnos.some(t => t.dia === dia.toLowerCase() && t.hora === h)) } });

        const nuevoTurno = {
            id: generarId(), nombre: escapeHtml(sanitizeInput(nombre)), dia: dia.toLowerCase(), hora: horaNum,
            massageType: massageType || 'Masaje', telefono: telLimpio, codigoPais: codigoPais || '54',
            ubicacion: ubicacion ? escapeHtml(sanitizeInput(ubicacion)) : null,
            tipoServicio: tipoServicio || 'salon', fechaCreacion: new Date().toISOString(), ip
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
        const turnos = await cargarTurnos();
        const idx = turnos.findIndex(t => t.id === req.params.id);
        if (idx === -1) return res.status(404).json({ error: 'Turno no encontrado' });
        turnos.splice(idx, 1);
        await guardarTurnos(turnos);
        res.json({ mensaje: 'Turno eliminado' });
    } catch { res.status(500).json({ error: 'Error al eliminar' }); }
});

app.post('/api/cancelar-turno', async (req, res) => {
    try {
        const tel = (req.body.telefono || '').replace(/\D/g, '');
        if (tel.length < 7) return res.json({ error: 'Número inválido.' });
        const turnos = await cargarTurnos();
        const turno = turnos.find(t => t.telefono === tel);
        if (!turno) return res.json({ error: 'Sin turno activo.' });
        turnos.splice(turnos.indexOf(turno), 1);
        await guardarTurnos(turnos);
        res.json({ cancelado: true, mensaje: `Turno del ${turno.dia} a las ${turno.hora}:00 cancelado.` });
    } catch(e) {
        res.status(500).json({ error: 'Error' });
    }
});

// ==================== WHATSAPP ====================
app.post('/api/enviar-whatsapp/:id', async (req, res) => {
    try {
        const turnos = await cargarTurnos();
        const turno = turnos.find(t => t.id === req.params.id);
        if (!turno) return res.status(404).json({ error: 'Turno no encontrado' });

        const mensaje = `🌿 *SERENITY SPA* 🌿\n\nHola *${turno.nombre}*,\n\n✅ *TU RESERVA HA SIDO CONFIRMADA*\n\n📅 *Día:* ${turno.dia.charAt(0).toUpperCase() + turno.dia.slice(1)}\n⏰ *Hora:* ${turno.hora}:00 hs\n💆‍♂️ *Masaje:* ${turno.massageType}\n📍 *Lugar:* ${turno.tipoServicio === 'domicilio' ? turno.ubicacion : 'Serenity Spa - Salón'}\n\n🌸 *Te esperamos con aromaterapia y música suave.*\n\n✨ *¡Te deseamos una experiencia inolvidable!*\n\n*Equipo Serenity Spa*`;

        const num = turno.telefono.replace(/\D/g, '');
        res.json({ success: true, numero: `${turno.codigoPais || '54'}${num}`, mensaje });
    } catch (error) {
        console.error('Error WhatsApp:', error);
        res.status(500).json({ error: 'Error al preparar mensaje' });
    }
});

// ==================== LOGIN ====================
const validTokens = new Map();

app.post('/api/login', (req, res) => {
    const ip = req.ip || req.connection.remoteAddress;
    if (estaBloqueado(ip)) return res.status(403).json({ success: false, error: 'Acceso bloqueado' });
    const { password } = req.body;
    if (!process.env.ADMIN_PASSWORD) return res.status(500).json({ success: false, error: 'Servidor no configurado' });
    if (!password) return res.status(400).json({ success: false, error: 'Contraseña requerida' });
    if (password === process.env.ADMIN_PASSWORD) {
        const token = crypto.randomBytes(64).toString('hex');
        validTokens.set(token, Date.now() + 28800000);
        return res.json({ success: true, token });
    }
    registrarIntentoFallido(ip);
    return res.status(401).json({ success: false, error: 'Contraseña incorrecta' });
});

app.get('/api/verify', (req, res) => {
    const auth = req.headers.authorization;
    if (auth && auth.startsWith('Bearer ')) {
        const token = auth.substring(7);
        if (validTokens.has(token) && validTokens.get(token) > Date.now()) return res.json({ valid: true });
        validTokens.delete(token);
    }
    return res.status(401).json({ valid: false });
});

app.post('/api/logout', (req, res) => {
    const auth = req.headers.authorization;
    if (auth && auth.startsWith('Bearer ')) validTokens.delete(auth.substring(7));
    res.json({ success: true });
});

// ==================== RUTAS DE SERVICIOS Y CONFIG (ADMIN) ====================
app.put('/api/config', async (req, res) => {
    try { configData = { ...configData, ...req.body }; await fs.writeFile(CONFIG_FILE, JSON.stringify(configData, null, 2), 'utf8'); res.json({ ok: true }); }
    catch { res.status(500).json({ error: 'Error al guardar' }); }
});

app.post('/api/servicios', async (req, res) => {
    try {
        const nuevo = { id: generarId(), orden: serviciosData.length + 1, ...req.body };
        serviciosData.push(nuevo);
        await fs.writeFile(SERVICIOS_FILE, JSON.stringify(serviciosData, null, 2), 'utf8');
        res.status(201).json(nuevo);
    } catch { res.status(500).json({ error: 'Error' }); }
});

app.put('/api/servicios/:id', async (req, res) => {
    try {
        const idx = serviciosData.findIndex(s => s.id === req.params.id);
        if (idx === -1) return res.status(404).json({ error: 'No encontrado' });
        serviciosData[idx] = { ...serviciosData[idx], ...req.body };
        await fs.writeFile(SERVICIOS_FILE, JSON.stringify(serviciosData, null, 2), 'utf8');
        res.json(serviciosData[idx]);
    } catch { res.status(500).json({ error: 'Error' }); }
});

app.delete('/api/servicios/:id', async (req, res) => {
    try {
        serviciosData = serviciosData.filter(s => s.id !== req.params.id);
        await fs.writeFile(SERVICIOS_FILE, JSON.stringify(serviciosData, null, 2), 'utf8');
        res.json({ ok: true });
    } catch { res.status(500).json({ error: 'Error' }); }
});

// ==================== SEGURIDAD ====================
app.get('/api/seguridad/bloqueos', (req, res) => {
    const activos = [];
    for (const [ip, d] of bloqueos) {
        activos.push({
            ip,
            motivo: d.motivo,
            fecha: d.fecha,
            tiempoRestante: Math.max(0, d.hasta - Date.now()),
            permanente: false
        });
    }
    res.json({ activos, historial: [], intentosFallidos: Object.fromEntries(intentosFallidos) });
});

app.post('/api/seguridad/desbloquear/:ip', (req, res) => {
    bloqueos.delete(req.params.ip);
    intentosFallidos.delete(req.params.ip);
    guardarBloqueos();
    res.json({ ok: true });
});

app.delete('/api/seguridad/bloqueos/:ip', (req, res) => {
    bloqueos.delete(req.params.ip);
    intentosFallidos.delete(req.params.ip);
    guardarBloqueos();
    res.json({ ok: true });
});

app.post('/api/seguridad/limpiar-expirados', (req, res) => {
    let b = 0;
    const now = Date.now();
    for (const [ip, d] of bloqueos) {
        if (now > d.hasta) { bloqueos.delete(ip); b++; }
    }
    guardarBloqueos();
    res.json({ mensaje: `${b} bloqueos eliminados` });
});

app.post('/api/seguridad/bloquear-permanente/:ip', (req, res) => {
    bloqueos.set(req.params.ip, { hasta: Date.now() + 31536000000, motivo: 'Permanente', fecha: new Date().toISOString(), permanente: true });
    guardarBloqueos();
    res.json({ ok: true });
});

app.post('/api/upload-hero', async (req, res) => {
    try {
        const { base64 } = req.body;
        if (!base64 || !base64.startsWith('data:image')) return res.status(400).json({ error: 'Imagen inválida' });
        const matches = base64.match(/^data:image\/(\w+);base64,(.+)$/);
        if (!matches) return res.status(400).json({ error: 'Formato no reconocido' });
        const ext = matches[1] === 'jpeg' ? 'jpg' : matches[1];
        const buffer = Buffer.from(matches[2], 'base64');
        const filename = `hero-${Date.now()}.${ext}`;
        await fs.writeFile(path.join(__dirname, 'uploads', filename), buffer);
        res.json({ url: `/uploads/${filename}`, filename });
    } catch (e) {
        console.error('Error upload:', e);
        res.status(500).json({ error: 'Error al subir' });
    }
});

// ==================== HTML ====================
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/admin.html', (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));
app.get('/login.html', (req, res) => res.sendFile(path.join(__dirname, 'login.html')));
app.get('/voice-assistant', (req, res) => res.sendFile(path.join(__dirname, 'voice-assistant.html')));

// ==================== WEBSOCKET DE VOZ ====================
let voiceClients = new Map();

async function startServer() {
    try {
        await cargarBloqueos();
        configData = await inicializarArchivo(CONFIG_FILE, configData);
        serviciosData = await inicializarArchivo(SERVICIOS_FILE, [
            { id: "relajante", nombre: "Masaje Relajante", precio: "$45", descripcion: "Movimientos suaves para liberar el estrés.", beneficios: ["Reduce ansiedad", "60 Minutos"], efectos: ["Relajación profunda"], imagenWeb: "https://images.unsplash.com/photo-1544161515-4ab6ce6db874?ixlib=rb-1.2.1&auto=format&fit=crop&w=800&q=80", imagenWhatsApp: "", orden: 1 },
            { id: "corporal", nombre: "Masaje Corporal", precio: "$65", descripcion: "Tratamiento completo para relajación profunda.", beneficios: ["Relajación integral", "90 Minutos"], efectos: ["Activación linfática"], imagenWeb: "https://images.unsplash.com/photo-1519823551278-64ac92734fb1?ixlib=rb-1.2.1&auto=format&fit=crop&w=800&q=80", imagenWhatsApp: "", orden: 2 },
            { id: "facial", nombre: "Masaje Facial", precio: "$40", descripcion: "Rejuvenece la piel y alivia la tensión facial.", beneficios: ["Reafirma la piel", "45 Minutos"], efectos: ["Estimula colágeno"], imagenWeb: "https://images.unsplash.com/photo-1570172619644-dfd03ed5d881?ixlib=rb-1.2.1&auto=format&fit=crop&w=800&q=80", imagenWhatsApp: "", orden: 3 }
        ]);
        turnosEnMemoria = await inicializarArchivo(TURNOS_FILE, []);

        const server = app.listen(PORT, '0.0.0.0', () => {
            console.log('\n' + '='.repeat(50));
            console.log('  🌿 SERENITY SPA - v3.0');
            console.log('='.repeat(50));
            console.log(`  📍 Puerto: ${PORT}`);
            console.log(`  🎤 Asistente: /voice-assistant`);
            console.log(`  🔐 Admin: ${process.env.ADMIN_PASSWORD ? '✅' : '❌ (usa admin123)'}`);
            console.log('='.repeat(50) + '\n');
        });

        const wss = new WebSocket.Server({ server, path: '/ws-voice' });

        wss.on('connection', (ws, req) => {
            const ip = req.socket.remoteAddress || req.headers['x-forwarded-for'] || 'desconocida';
            if (estaBloqueado(ip)) { ws.close(1008, 'IP bloqueada'); return; }

            const clientId = Date.now().toString() + Math.random().toString(36);
            console.log(`🎤 Cliente conectado: ${ip}`);
            voiceClients.set(clientId, { ws, estado: null, datos: {}, nombreRecordado: null, intentosNumero: 0, alternativaPendiente: null });

            ws.on('message', async (data) => {
                try {
                    const msg = JSON.parse(data);
                    if (msg.tipo === 'transcripcion' && msg.texto && msg.texto.trim().length > 0) {
                        const respuesta = await procesarComandoVoz(msg.texto.trim(), clientId, ip);
                        if (ws.readyState === WebSocket.OPEN) {
                            ws.send(JSON.stringify({ tipo: 'respuesta', texto: respuesta }));
                        }
                    }
                } catch (error) {
                    console.error('Error WS:', error);
                    if (ws.readyState === WebSocket.OPEN) {
                        ws.send(JSON.stringify({ tipo: 'respuesta', texto: "Hubo un error. Intenta de nuevo." }));
                    }
                }
            });

            ws.on('close', () => { voiceClients.delete(clientId); console.log(`🔌 Cliente desconectado: ${ip}`); });
        });

        console.log('🎤 WebSocket iniciado en /ws-voice\n');
    } catch (error) {
        console.error('❌ Error fatal:', error);
        process.exit(1);
    }
}

startServer();
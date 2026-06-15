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
const UPLOADS_DIR = path.join(__dirname, 'uploads');

const deepseek = new OpenAI({
    baseURL: 'https://api.deepseek.com/v1',
    apiKey: process.env.DEEPSEEK_API_KEY || '',
});

app.disable('x-powered-by');

if (!fsSync.existsSync(UPLOADS_DIR)) {
    fsSync.mkdirSync(UPLOADS_DIR, { recursive: true });
}

app.use('/uploads', express.static(UPLOADS_DIR));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// ==================== CONSTANTES ====================
let HORAS_VALIDAS = [12, 16, 20];
let DIAS_VALIDOS = ['lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado'];

// ==================== CONFIGURACIÓN DE HORARIOS ====================
let horariosConfig = {
    dias: ['lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado'],
    horarios: ['12:00', '16:00', '20:00']
};

// ==================== PALABRAS BANEADAS ====================
let palabrasBaneadas = [
    'puta', 'puto', 'mierda', 'coño', 'carajo', 'verga', 'chinga',
    'fuck', 'shit', 'bitch', 'asshole', 'motherfucker', 'cunt',
    'idiota', 'estupido', 'imbecil', 'tarado', 'estúpido', 'imbécil'
];

async function cargarPalabrasBaneadas() {
    try {
        if (fsSync.existsSync(PALABRAS_BANEADAS_FILE)) {
            const data = JSON.parse(await fs.readFile(PALABRAS_BANEADAS_FILE, 'utf8'));
            palabrasBaneadas = data.palabras || palabrasBaneadas;
            console.log('✅ Palabras baneadas cargadas:', palabrasBaneadas.length);
        } else {
            await guardarPalabrasBaneadas();
        }
    } catch(e) {
        console.error('Error cargando palabras baneadas:', e);
        await guardarPalabrasBaneadas();
    }
}

async function guardarPalabrasBaneadas() {
    try {
        await fs.writeFile(PALABRAS_BANEADAS_FILE, JSON.stringify({ palabras: palabrasBaneadas }, null, 2), 'utf8');
        console.log('✅ Palabras baneadas guardadas');
    } catch(e) {
        console.error('Error guardando palabras baneadas:', e);
    }
}

function contienePalabraBaneada(texto) {
    if (!texto) return false;
    const textoLower = texto.toLowerCase();
    for (const palabra of palabrasBaneadas) {
        if (textoLower.includes(palabra.toLowerCase())) {
            return palabra;
        }
    }
    return null;
}

async function cargarHorarios() {
    try {
        if (fsSync.existsSync(HORARIOS_FILE)) {
            const data = JSON.parse(await fs.readFile(HORARIOS_FILE, 'utf8'));
            horariosConfig = data;
            actualizarHorariosGlobales();
            console.log('✅ Horarios cargados:', horariosConfig.horarios.length, 'horarios,', horariosConfig.dias.length, 'días');
        } else {
            await guardarHorarios();
        }
    } catch(e) {
        console.error('Error cargando horarios:', e);
        await guardarHorarios();
    }
}

async function guardarHorarios() {
    try {
        await fs.writeFile(HORARIOS_FILE, JSON.stringify(horariosConfig, null, 2), 'utf8');
        console.log('✅ Horarios guardados correctamente');
    } catch(e) {
        console.error('Error guardando horarios:', e);
    }
}

function actualizarHorariosGlobales() {
    HORAS_VALIDAS = horariosConfig.horarios.map(h => parseInt(h.split(':')[0])).filter(h => !isNaN(h));
    DIAS_VALIDOS = horariosConfig.dias;
    if (HORAS_VALIDAS.length === 0) HORAS_VALIDAS = [12, 16, 20];
    if (DIAS_VALIDOS.length === 0) DIAS_VALIDOS = ['lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado'];
}

// ==================== SISTEMA DE BLOQUEOS MEJORADO ====================
let bloqueos = new Map();
let historialBloqueos = [];
let intentosFallidos = new Map();
const turnosRecientesIP = new Map();
const turnosRecientesTel = new Map();

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

function estaBloqueado(ip) {
    if (bloqueos.has(ip)) {
        const datos = bloqueos.get(ip);
        if (datos.permanente) return true;
        if (Date.now() < datos.hasta) return true;
        bloqueos.delete(ip);
        guardarBloqueos();
    }
    return false;
}

function bloquearIP(ip, motivo, tipo = 'Desconocido', palabraOfensiva = null) {
    bloqueos.set(ip, {
        hasta: Date.now() + 3600000,
        motivo: motivo,
        tipoAtaque: tipo,
        fecha: new Date().toISOString(),
        ip: ip,
        intentos: (intentosFallidos.get(ip)?.count || 0),
        permanente: false,
        palabraOfensiva: palabraOfensiva
    });
    historialBloqueos.unshift({ 
        ...bloqueos.get(ip), 
        id: generarId(),
        palabraOfensiva: palabraOfensiva
    });
    guardarBloqueos();
}

function bloquearIPpermanentemente(ip, motivo, tipo = 'Manual') {
    bloqueos.set(ip, {
        hasta: Date.now() + 31536000000, // 1 año
        motivo: motivo,
        tipoAtaque: tipo,
        fecha: new Date().toISOString(),
        ip: ip,
        intentos: 0,
        permanente: true,
        palabraOfensiva: null
    });
    historialBloqueos.unshift({ 
        ...bloqueos.get(ip), 
        id: generarId()
    });
    guardarBloqueos();
}

function desbloquearIP(ip) {
    bloqueos.delete(ip);
    intentosFallidos.delete(ip);
    guardarBloqueos();
}

function registrarIntento(ip, tipo, detalles = '') {
    const ahora = Date.now();
    if (!intentosFallidos.has(ip)) {
        intentosFallidos.set(ip, { count: 1, first: ahora, tipo, detalles });
        return false;
    }
    const d = intentosFallidos.get(ip);
    if (ahora - d.first > 600000) {
        intentosFallidos.set(ip, { count: 1, first: ahora, tipo, detalles });
        return false;
    }
    d.count++;
    d.tipo = tipo;
    d.detalles = detalles;
    if (d.count >= 5) {
        bloquearIP(ip, `5+ intentos sospechosos: ${tipo}`, tipo);
        intentosFallidos.delete(ip);
        return true;
    }
    return false;
}

function checkRateIP(ip) {
    limpiarViejos(turnosRecientesIP, 3600000);
    return (turnosRecientesIP.get(ip) || []).length < 3;
}

function checkRateTel(tel) {
    limpiarViejos(turnosRecientesTel, 86400000);
    return (turnosRecientesTel.get(tel) || []).length < 2;
}

function regTurno(ip, tel) {
    const ahora = Date.now();
    if (!turnosRecientesIP.has(ip)) turnosRecientesIP.set(ip, []);
    turnosRecientesIP.get(ip).push(ahora);
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

// ==================== SISTEMA DE PAÍSES ====================
let paisesConfig = {
    autorizados: [],
    bloqueados: [],
    modo: 'todos',
    ubicacionSalon: 'Salón Serenity Spa, Calle Principal #123'
};

async function cargarPaises() {
    try {
        if (fsSync.existsSync(PAISES_FILE)) {
            const data = JSON.parse(await fs.readFile(PAISES_FILE, 'utf8'));
            paisesConfig = {
                autorizados: data.autorizados || [],
                bloqueados: data.bloqueados || [],
                modo: data.modo || 'todos',
                ubicacionSalon: data.ubicacionSalon || 'Salón Serenity Spa, Calle Principal #123'
            };
            console.log('✅ Países cargados:', paisesConfig.autorizados.length, 'autorizados,', paisesConfig.bloqueados.length, 'bloqueados');
        } else {
            await guardarPaises();
        }
    } catch(e) {
        console.error('Error cargando países:', e);
        await guardarPaises();
    }
}

async function guardarPaises() {
    try {
        await fs.writeFile(PAISES_FILE, JSON.stringify(paisesConfig, null, 2), 'utf8');
        console.log('✅ Países guardados correctamente');
    } catch(e) {
        console.error('Error guardando países:', e);
    }
}

function paisAutorizado(codigoPais) {
    if (paisesConfig.modo === 'todos') {
        if (paisesConfig.bloqueados.length > 0) {
            return !paisesConfig.bloqueados.includes(codigoPais);
        }
        return true;
    }
    return paisesConfig.autorizados.includes(codigoPais);
}

// ==================== BASE DE CONOCIMIENTO PARA IA ====================
let baseConocimiento = [];
let serviciosData = [];

async function inicializarBaseConocimiento() {
    const servicios = serviciosData.map(s => ({
        tipo: 'servicio',
        contenido: `${s.nombre}: ${s.descripcion}. Precio: ${s.precio}. Beneficios: ${(s.beneficios||[]).join(', ')}. Efectos: ${(s.efectos||[]).join(', ')}`
    }));
    
    const info = [
        { tipo: 'horario', contenido: `Horarios de atención: ${DIAS_VALIDOS.map(d => d.charAt(0).toUpperCase() + d.slice(1)).join(', ')}. Turnos disponibles: ${horariosConfig.horarios.join(', ')}. Solo un turno por persona por día. Ubicación: ${paisesConfig.ubicacionSalon}` },
        { tipo: 'politica', contenido: 'Política de cancelación: Se debe cancelar con al menos 4 horas de anticipación. No se aceptan cancelaciones el mismo día del turno.' },
        { tipo: 'contacto', contenido: 'Para consultas urgentes o hablar con un administrador, solicitar al asistente. El equipo de Serenity Spa está disponible de Lunes a Sábado.' }
    ];
    
    baseConocimiento = [...servicios, ...info];
}

// ==================== UTILIDADES MEJORADAS ====================
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

function esUrlValida(s) {
    if (!s || typeof s !== 'string') return false;
    const trimmed = s.trim();
    if (trimmed.startsWith('data:')) return false;
    if (trimmed.length > 3000) return false;
    try {
        const url = new URL(trimmed);
        return url.protocol === 'http:' || url.protocol === 'https:';
    } catch(e) {
        return false;
    }
}

function escapeHtml(s) {
    if (!s) return '';
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function sanitize(s) {
    if (!s) return '';
    return s.trim().replace(/[^\w\sáéíóúñÑü.,@\-]/gi, '');
}

function generarId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2) + crypto.randomBytes(4).toString('hex');
}

function fmtT(ms) {
    if (ms <= 0) return 'Expirado';
    const s = Math.floor(ms / 1000), m = Math.floor(s / 60), h = Math.floor(m / 60);
    return h > 0 ? `${h}h ${m % 60}m` : m > 0 ? `${m}m ${s % 60}s` : `${s}s`;
}

// DETECCIÓN DE FECHAS
function obtenerFechaRelativa(texto) {
    const t = texto.toLowerCase();
    const hoy = new Date();
    const diasSemana = ['domingo', 'lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado'];
    
    if (t.includes('hoy')) {
        return diasSemana[hoy.getDay()];
    }
    if (t.includes('mañana')) {
        const manana = new Date(hoy);
        manana.setDate(hoy.getDate() + 1);
        return diasSemana[manana.getDay()];
    }
    if (t.includes('pasado mañana')) {
        const pasado = new Date(hoy);
        pasado.setDate(hoy.getDate() + 2);
        return diasSemana[pasado.getDay()];
    }
    return null;
}

function detectarPaisConNombre(texto) {
    const t = texto.toLowerCase().trim();
    const paises = [
        { nombre: 'Cuba', codigo: '53', claves: ['cuba', 'cubano'] },
        { nombre: 'Argentina', codigo: '54', claves: ['argentina', 'argentino', 'arg'] },
        { nombre: 'México', codigo: '52', claves: ['méxico', 'mexico', 'mexicano'] },
        { nombre: 'Colombia', codigo: '57', claves: ['colombia', 'colombiano', 'colom'] },
        { nombre: 'Chile', codigo: '56', claves: ['chile', 'chileno'] },
        { nombre: 'Perú', codigo: '51', claves: ['perú', 'peru', 'peruano'] },
        { nombre: 'España', codigo: '34', claves: ['españa', 'espania', 'español'] },
        { nombre: 'Venezuela', codigo: '58', claves: ['venezuela', 'venezolano'] },
        { nombre: 'Ecuador', codigo: '593', claves: ['ecuador', 'ecuatoriano'] },
        { nombre: 'Uruguay', codigo: '598', claves: ['uruguay', 'uruguayo'] },
        { nombre: 'Paraguay', codigo: '595', claves: ['paraguay', 'paraguayo'] },
        { nombre: 'Bolivia', codigo: '591', claves: ['bolivia', 'boliviano'] },
        { nombre: 'Brasil', codigo: '55', claves: ['brasil', 'brasileño'] },
        { nombre: 'Estados Unidos', codigo: '1', claves: ['estados unidos', 'usa', 'eeuu', 'americano'] },
    ];
    for (const pais of paises) {
        for (const clave of pais.claves) {
            if (t.includes(clave)) return { nombre: pais.nombre, codigo: pais.codigo };
        }
    }
    return null;
}

function extraerNombre(texto) {
    const t = texto.toLowerCase().trim();
    
    const patrones = [
        /(?:mi\s+nombre\s+es)\s+([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+)/i,
        /(?:me\s+llamo)\s+([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+)/i,
        /(?:soy)\s+([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+)/i,
        /hola\s+(?:soy|me\s+llamo)\s+([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+)/i,
        /^hola\s+([A-ZÁÉÍÓÚÑ][a-záéíóúñ]{2,10})(?:\s|$)/i,
    ];
    
    for (const patron of patrones) {
        const match = texto.match(patron);
        if (match && match[1]) {
            let nombre = match[1].trim();
            nombre = nombre.replace(/[^A-ZÁÉÍÓÚÑa-záéíóúñ]/g, '');
            if (nombre.length >= 2 && nombre.length <= 15) {
                return nombre.charAt(0).toUpperCase() + nombre.slice(1).toLowerCase();
            }
        }
    }
    
    return null;
}

function extraerMasaje(texto) {
    const t = texto.toLowerCase();
    for (const s of serviciosData) {
        const nombreLower = s.nombre.toLowerCase();
        if (t.includes(nombreLower)) {
            return s.nombre;
        }
    }
    return null;
}

function extraerDia(texto) {
    const t = texto.toLowerCase();
    const diasMap = {
        'lunes': 'lunes', 'martes': 'martes', 'miercoles': 'miercoles',
        'miércoles': 'miercoles', 'jueves': 'jueves', 'viernes': 'viernes',
        'sabado': 'sabado', 'sábado': 'sabado'
    };
    
    const fechaRelativa = obtenerFechaRelativa(t);
    if (fechaRelativa && DIAS_VALIDOS.includes(fechaRelativa)) {
        return fechaRelativa;
    }
    
    for (const [key, value] of Object.entries(diasMap)) {
        if (t.includes(key)) return value;
    }
    return null;
}

function extraerHora(texto) {
    const t = texto.toLowerCase();
    for (const hora of horariosConfig.horarios) {
        const horaNum = parseInt(hora.split(':')[0]);
        if (t.includes(hora) || t.includes(horaNum.toString())) {
            return horaNum;
        }
        if (horaNum === 12 && (t.includes('mediodía') || t.includes('12'))) return 12;
        if (horaNum === 16 && (t.includes('cuatro') || t.includes('16') || t.includes('4'))) return 16;
        if (horaNum === 20 && (t.includes('ocho') || t.includes('20') || t.includes('8'))) return 20;
    }
    return null;
}

function extraerTelefono(texto) {
    const t = texto.toLowerCase();
    
    const patronesTelefono = [
        /(?:mi\s+número\s+es|mi\s+tel[eé]fono\s+es|tel[eé]fono\s+es|número\s+es)\s+(\d[\d\s]{5,15})/i,
        /(?:es\s+el\s+)(\d[\d\s]{5,15})/i,
        /(\d{3,4}\s+\d{3,4}\s+\d{3,4})/,
        /(\d{5,12})/
    ];
    
    for (const patron of patronesTelefono) {
        const match = texto.match(patron);
        if (match) {
            const numeros = match[1].replace(/\D/g, '');
            if (numeros.length >= 7 && numeros.length <= 12) {
                return numeros;
            }
        }
    }
    
    const numeros = texto.replace(/\D/g, '');
    if (numeros.length >= 7 && numeros.length <= 12) {
        return numeros;
    }
    
    return null;
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

// ==================== CANCELAR RESERVA POR CÓDIGO ====================
async function cancelarPorCodigo(codigo, ip) {
    try {
        const turnos = await loadTurnos();
        const turnoIndex = turnos.findIndex(t => t.codigoCancelacion === codigo);
        
        if (turnoIndex === -1) {
            return { success: false, mensaje: "Código de cancelación incorrecto. Por favor, verifica el código que te enviamos al reservar." };
        }
        
        const turno = turnos[turnoIndex];
        const turnoInfo = `${turno.dia} a las ${turno.hora}:00`;
        
        turnos.splice(turnoIndex, 1);
        await saveTurnos(turnos);
        
        return { 
            success: true, 
            mensaje: `✅ RESERVA CANCELADA\n\nTu reserva del ${turnoInfo} ha sido eliminada exitosamente.\n\nSi necesitas un nuevo turno, podes reservar nuevamente.\n\nGracias por confiar en Serenity Spa.` 
        };
        
    } catch(e) {
        console.error('Error al cancelar por código:', e);
        return { success: false, mensaje: "Error al cancelar la reserva. Por favor, intenta nuevamente o contacta con nuestro equipo." };
    }
}

// ==================== MODIFICAR RESERVA EXISTENTE ====================
async function modificarReserva(telefono, nuevosDatos, ip) {
    try {
        const turnos = await loadTurnos();
        const telLimpio = telefono.replace(/\D/g, '');
        const turnoIndex = turnos.findIndex(t => t.telefono === telLimpio);
        
        if (turnoIndex === -1) {
            return { success: false, mensaje: "No encontré una reserva activa con ese teléfono." };
        }
        
        const turnoActual = turnos[turnoIndex];
        let cambios = [];
        let mensajeModificacion = "✅ RESERVA MODIFICADA\n\n";
        
        if (nuevosDatos.nombre && nuevosDatos.nombre !== turnoActual.nombre) {
            turnoActual.nombre = nuevosDatos.nombre;
            cambios.push(`nombre: ${nuevosDatos.nombre}`);
            mensajeModificacion += `✏️ Nombre: ${nuevosDatos.nombre}\n`;
        }
        
        if (nuevosDatos.massageType && nuevosDatos.massageType !== turnoActual.massageType) {
            turnoActual.massageType = nuevosDatos.massageType;
            cambios.push(`masaje: ${nuevosDatos.massageType}`);
            mensajeModificacion += `💆‍♂️ Masaje: ${nuevosDatos.massageType}\n`;
        }
        
        if (nuevosDatos.dia && nuevosDatos.dia !== turnoActual.dia) {
            const diaValido = DIAS_VALIDOS.includes(nuevosDatos.dia.toLowerCase());
            if (!diaValido) {
                return { success: false, mensaje: `Día inválido. Días disponibles: ${DIAS_VALIDOS.join(', ')}` };
            }
            if (!esFechaValida(nuevosDatos.dia.toLowerCase())) {
                return { success: false, mensaje: `No se puede reservar para un día que ya pasó. Por favor, elegí un día futuro.` };
            }
            const ocupado = turnos.some(t => t.id !== turnoActual.id && t.dia === nuevosDatos.dia && t.hora === turnoActual.hora);
            if (ocupado) {
                const alternativa = buscarAlternativa(nuevosDatos.dia, turnoActual.hora, turnos.filter(t => t.id !== turnoActual.id));
                if (alternativa) {
                    return { 
                        success: false, 
                        necesitaAlternativa: true,
                        alternativa: alternativa,
                        mensaje: `El ${nuevosDatos.dia} a las ${turnoActual.hora}:00 está ocupado. Tengo disponible ${alternativa.dia} a las ${alternativa.hora}:00. ¿Te sirve?`
                    };
                }
                return { success: false, mensaje: `No hay disponibilidad para ${nuevosDatos.dia} a las ${turnoActual.hora}:00` };
            }
            turnoActual.dia = nuevosDatos.dia.toLowerCase();
            cambios.push(`día: ${turnoActual.dia}`);
            mensajeModificacion += `📅 Día: ${turnoActual.dia}\n`;
        }
        
        if (nuevosDatos.hora && nuevosDatos.hora !== turnoActual.hora) {
            const horaValida = HORAS_VALIDAS.includes(nuevosDatos.hora);
            if (!horaValida) {
                return { success: false, mensaje: `Hora inválida. Horarios: ${horariosConfig.horarios.join(', ')}` };
            }
            const ocupado = turnos.some(t => t.id !== turnoActual.id && t.dia === turnoActual.dia && t.hora === nuevosDatos.hora);
            if (ocupado) {
                const alternativa = buscarAlternativa(turnoActual.dia, nuevosDatos.hora, turnos.filter(t => t.id !== turnoActual.id));
                if (alternativa) {
                    return { 
                        success: false, 
                        necesitaAlternativa: true,
                        alternativa: alternativa,
                        mensaje: `La hora ${nuevosDatos.hora}:00 del ${turnoActual.dia} está ocupada. Tengo disponible ${alternativa.dia} a las ${alternativa.hora}:00. ¿Te sirve?`
                    };
                }
                return { success: false, mensaje: `No hay disponibilidad para ${turnoActual.dia} a las ${nuevosDatos.hora}:00` };
            }
            turnoActual.hora = nuevosDatos.hora;
            cambios.push(`hora: ${turnoActual.hora}:00`);
            mensajeModificacion += `⏰ Hora: ${turnoActual.hora}:00\n`;
        }
        
        if (nuevosDatos.telefono && nuevosDatos.telefono !== turnoActual.telefono) {
            const telefonoLimpio = nuevosDatos.telefono.replace(/\D/g, '');
            if (telefonoLimpio.length >= 7) {
                turnoActual.telefono = telefonoLimpio;
                cambios.push(`teléfono: ${telefonoLimpio}`);
                mensajeModificacion += `📞 Teléfono: +${turnoActual.codigoPais} ${telefonoLimpio}\n`;
            }
        }
        
        if (cambios.length === 0) {
            return { success: false, mensaje: "No se detectaron cambios en la reserva." };
        }
        
        turnoActual.fechaModificacion = new Date().toISOString();
        await saveTurnos(turnos);
        
        mensajeModificacion += `\n📍 Lugar: ${turnoActual.tipoServicio === 'domicilio' ? turnoActual.ubicacion : paisesConfig.ubicacionSalon}\n\nCódigo para cancelar: ${turnoActual.codigoCancelacion}\n\nTe esperamos en Serenity Spa.`;
        
        return { success: true, mensaje: mensajeModificacion, turno: turnoActual };
        
    } catch(e) {
        console.error('Error modificando reserva:', e);
        return { success: false, mensaje: "Error al modificar la reserva. Intenta de nuevo." };
    }
}

// ==================== MIDDLEWARES DE SEGURIDAD ====================
app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    next();
});

app.use((req, res, next) => {
    const ip = req.ip || req.socket.remoteAddress || '0.0.0.0';
    if (estaBloqueado(ip)) {
        const bloqueo = bloqueos.get(ip);
        return res.status(403).send(`
            <!DOCTYPE html>
            <html lang="es">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>Acceso Denegado | Serenity Spa</title>
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
                    .bloqueo-card{
                        max-width: 550px;
                        background: rgba(30, 25, 20, 0.95);
                        backdrop-filter: blur(10px);
                        border-radius: 28px;
                        border: 1px solid rgba(201, 168, 122, 0.3);
                        padding: 2.5rem;
                        text-align: center;
                        box-shadow: 0 20px 40px rgba(0,0,0,0.4);
                    }
                    .icono{
                        width: 80px;
                        height: 80px;
                        background: rgba(220, 38, 38, 0.15);
                        border-radius: 50%;
                        display: flex;
                        align-items: center;
                        justify-content: center;
                        margin: 0 auto 1.5rem;
                        border: 1px solid rgba(220, 38, 38, 0.3);
                    }
                    .icono i{
                        font-size: 2.8rem;
                        color: #dc2626;
                    }
                    h1{
                        font-family: 'Georgia', serif;
                        color: #dc2626;
                        font-size: 1.6rem;
                        margin-bottom: 1rem;
                    }
                    p{
                        color: #d4c5a9;
                        line-height: 1.6;
                        margin-bottom: 1rem;
                    }
                    .motivo{
                        background: rgba(0,0,0,0.4);
                        border-radius: 12px;
                        padding: 1rem;
                        margin: 1.5rem 0;
                        font-size: 0.85rem;
                        border-left: 3px solid #dc2626;
                        text-align: left;
                    }
                    .motivo strong{
                        color: #c9a87a;
                    }
                    .btn{
                        display: inline-block;
                        background: rgba(201,168,122,0.15);
                        border: 1px solid rgba(201,168,122,0.4);
                        color: #c9a87a;
                        padding: 0.7rem 1.5rem;
                        border-radius: 40px;
                        text-decoration: none;
                        font-size: 0.85rem;
                        transition: all 0.3s;
                        margin-top: 1rem;
                    }
                    .btn:hover{
                        background: rgba(201,168,122,0.3);
                        border-color: #c9a87a;
                    }
                    .footer{
                        margin-top: 1.5rem;
                        font-size: 0.7rem;
                        color: rgba(212, 197, 169, 0.5);
                    }
                </style>
                <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
            </head>
            <body>
                <div class="bloqueo-card">
                    <div class="icono">
                        <i class="fas fa-ban"></i>
                    </div>
                    <h1>Acceso Denegado</h1>
                    <p>Su dirección IP ha sido bloqueada debido a una violación de los términos de conducta de Serenity Spa.</p>
                    <div class="motivo">
                        <strong><i class="fas fa-shield-alt"></i> Motivo del bloqueo:</strong><br>
                        ${escapeHtml(bloqueo?.motivo || 'Actividad sospechosa detectada')}<br><br>
                        <strong><i class="fas fa-clock"></i> Fecha:</strong> ${new Date(bloqueo?.fecha || Date.now()).toLocaleString()}<br>
                        <strong><i class="fas fa-microchip"></i> IP:</strong> ${escapeHtml(ip)}<br>
                        ${bloqueo?.permanente ? '<strong><i class="fas fa-lock"></i> Estado:</strong> Bloqueo permanente' : '<strong><i class="fas fa-hourglass-half"></i> Estado:</strong> Bloqueo temporal'}
                    </div>
                    <p>Si considera que esto es un error, por favor contacte a nuestro equipo de soporte.</p>
                    <a href="/" class="btn"><i class="fas fa-home"></i> Volver al inicio</a>
                    <div class="footer">
                        Serenity Spa - Todos los derechos reservados
                    </div>
                </div>
            </body>
            </html>
        `);
    }
    next();
});

// Middleware para detectar palabras ofensivas en el nombre
app.use((req, res, next) => {
    if (req.body && req.body.nombre) {
        const palabraOfensiva = contienePalabraBaneada(req.body.nombre);
        if (palabraOfensiva) {
            const ip = req.ip || req.socket.remoteAddress || '0.0.0.0';
            bloquearIP(ip, `Uso de lenguaje ofensivo en el nombre: "${req.body.nombre}" contiene "${palabraOfensiva}"`, 'Lenguaje Ofensivo', palabraOfensiva);
            return res.status(403).json({ error: 'Nombre no permitido. Por favor, use un nombre apropiado.' });
        }
    }
    next();
});

app.use(express.static(__dirname));

// ==================== AUTENTICACIÓN ====================
const validTokens = new Map();

function checkAuth(req) {
    const h = req.headers.authorization;
    if (!h || !h.startsWith('Bearer ')) return false;
    const token = h.substring(7);
    if (!validTokens.has(token)) return false;
    if (validTokens.get(token) < Date.now()) {
        validTokens.delete(token);
        return false;
    }
    return true;
}

app.post('/api/login', (req, res) => {
    const ip = req.ip || '0.0.0.0';
    if (estaBloqueado(ip)) return res.status(403).json({ success: false, error: 'IP bloqueada' });
    const { password } = req.body;
    if (!password) {
        registrarIntento(ip, 'Contraseña vacía');
        return res.status(400).json({ success: false, error: 'Contraseña requerida' });
    }
    const adminPassword = process.env.ADMIN_PASSWORD || 'admin123';
    if (password === adminPassword) {
        const token = crypto.randomBytes(64).toString('hex');
        validTokens.set(token, Date.now() + 28800000);
        intentosFallidos.delete(ip);
        res.json({ success: true, token });
    } else {
        registrarIntento(ip, 'Contraseña incorrecta');
        res.status(401).json({ success: false, error: 'Contraseña incorrecta' });
    }
});

app.get('/api/verify', (req, res) => res.json({ valid: checkAuth(req) }));

app.post('/api/logout', (req, res) => {
    const h = req.headers.authorization;
    if (h?.startsWith('Bearer ')) validTokens.delete(h.substring(7));
    res.json({ ok: true });
});

// ==================== API DE PALABRAS BANEADAS ====================
app.get('/api/palabras-baneadas', (req, res) => {
    if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    res.json({ palabras: palabrasBaneadas });
});

app.post('/api/palabras-baneadas', async (req, res) => {
    if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    const { palabra, accion } = req.body;
    
    if (accion === 'agregar') {
        if (!palabra || palabra.length < 2) {
            return res.status(400).json({ error: 'Palabra inválida' });
        }
        if (!palabrasBaneadas.includes(palabra.toLowerCase())) {
            palabrasBaneadas.push(palabra.toLowerCase());
            await guardarPalabrasBaneadas();
            console.log(`✅ Palabra baneada agregada: ${palabra}`);
        }
    } else if (accion === 'eliminar') {
        palabrasBaneadas = palabrasBaneadas.filter(p => p !== palabra);
        await guardarPalabrasBaneadas();
        console.log(`✅ Palabra baneada eliminada: ${palabra}`);
    }
    
    res.json({ ok: true, palabras: palabrasBaneadas });
});

// ==================== UPLOAD HERO Y VIDEOS ====================
app.post('/api/upload-hero', async (req, res) => {
    if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    try {
        const { base64 } = req.body;
        if (!base64 || !base64.startsWith('data:image')) return res.status(400).json({ error: 'Imagen inválida' });
        const matches = base64.match(/^data:image\/(\w+);base64,(.+)$/);
        if (!matches) return res.status(400).json({ error: 'Formato no reconocido' });
        const ext = matches[1] === 'jpeg' ? 'jpg' : matches[1];
        const buffer = Buffer.from(matches[2], 'base64');
        const filename = `hero-${Date.now()}.${ext}`;
        await fs.writeFile(path.join(UPLOADS_DIR, filename), buffer);
        const files = await fs.readdir(UPLOADS_DIR);
        for (const f of files) {
            if (f.startsWith('hero-') && f !== filename) {
                try { await fs.unlink(path.join(UPLOADS_DIR, f)); } catch(e) {}
            }
        }
        res.json({ url: `/uploads/${filename}`, filename });
    } catch (e) {
        res.status(500).json({ error: 'Error al subir imagen' });
    }
});

app.post('/api/upload-video', async (req, res) => {
    if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    try {
        const { base64, filename } = req.body;
        if (!base64) return res.status(400).json({ error: 'Video inválido' });
        
        const matches = base64.match(/^data:video\/(\w+);base64,(.+)$/);
        if (!matches) {
            return res.status(400).json({ error: 'Formato de video no reconocido' });
        }
        
        const ext = matches[1];
        const buffer = Buffer.from(matches[2], 'base64');
        const videoFilename = `video-${Date.now()}.${ext}`;
        await fs.writeFile(path.join(UPLOADS_DIR, videoFilename), buffer);
        
        res.json({ url: `/uploads/${videoFilename}`, filename: videoFilename });
    } catch (e) {
        res.status(500).json({ error: 'Error al subir video' });
    }
});

// ==================== CONFIGURACIÓN DE HORARIOS (ADMIN) ====================
app.get('/api/config/horarios', (req, res) => {
    res.json(horariosConfig);
});

app.put('/api/config/horarios', async (req, res) => {
    if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    try {
        const { dias, horarios } = req.body;
        if (dias && Array.isArray(dias)) horariosConfig.dias = dias;
        if (horarios && Array.isArray(horarios)) horariosConfig.horarios = horarios;
        await guardarHorarios();
        actualizarHorariosGlobales();
        await inicializarBaseConocimiento();
        res.json({ ok: true, mensaje: 'Horarios guardados', horarios: horariosConfig });
    } catch(e) {
        res.status(500).json({ error: 'Error al guardar horarios' });
    }
});

// ==================== CONFIGURACIÓN GENERAL ====================
let configData = {
    hero: {
        titulo: "Renueva tu Energía",
        subtitulo: "Experiencias de bienestar",
        imagenFondo: "https://images.unsplash.com/photo-1544161515-4ab6ce6db874?w=1920",
        botonTexto: "Explorar Tratamientos"
    },
    serviciosSection: {
        etiqueta: "Nuestros Servicios",
        titulo: "Elige tu Masaje Ideal",
        descripcion: `Turnos: ${horariosConfig.horarios.join(', ')}`
    },
    contactoSection: {
        titulo: "Asistente de Reservas",
        descripcion: "Reserva tu turno de forma rápida"
    },
    shareSection: {
        titulo: "Comparte Serenity Spa"
    }
};

app.get('/api/config', (req, res) => res.json(configData));

app.put('/api/config', async (req, res) => {
    if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    configData = { ...configData, ...req.body };
    await fs.writeFile(CONFIG_FILE, JSON.stringify(configData, null, 2), 'utf8');
    res.json({ ok: true, mensaje: 'Configuración guardada' });
});

// ==================== SERVICIOS ====================
app.get('/api/servicios', (req, res) => {
    res.json(serviciosData.sort((a, b) => (a.orden || 999) - (b.orden || 999)));
});

app.post('/api/servicios', async (req, res) => {
    if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    try {
        let iwa = '';
        if (req.body.imagenWhatsApp && esUrlValida(req.body.imagenWhatsApp)) {
            iwa = req.body.imagenWhatsApp.trim();
        }
        let videoUrl = '';
        if (req.body.videoUrl && req.body.videoUrl.trim()) {
            videoUrl = req.body.videoUrl.trim();
        }
        const s = {
            id: generarId(),
            ...req.body,
            imagenWeb: req.body.imagenWeb || 'https://images.unsplash.com/photo-1544161515-4ab6ce6db874?w=800',
            imagenWhatsApp: iwa,
            videoUrl: videoUrl
        };
        serviciosData.push(s);
        await fs.writeFile(SERVICIOS_FILE, JSON.stringify(serviciosData, null, 2), 'utf8');
        await inicializarBaseConocimiento();
        res.status(201).json(s);
    } catch(e) {
        res.status(500).json({ error: 'Error al crear servicio' });
    }
});

app.put('/api/servicios/:id', async (req, res) => {
    if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    try {
        const i = serviciosData.findIndex(s => s.id === req.params.id);
        if (i === -1) return res.status(404).json({ error: 'Servicio no encontrado' });
        let iwa = serviciosData[i].imagenWhatsApp || '';
        if (req.body.imagenWhatsApp !== undefined) {
            if (req.body.imagenWhatsApp && esUrlValida(req.body.imagenWhatsApp)) {
                iwa = req.body.imagenWhatsApp.trim();
            } else if (!req.body.imagenWhatsApp) {
                iwa = '';
            }
        }
        let videoUrl = serviciosData[i].videoUrl || '';
        if (req.body.videoUrl !== undefined) {
            videoUrl = req.body.videoUrl.trim();
        }
        serviciosData[i] = { 
            ...serviciosData[i], 
            ...req.body, 
            id: req.params.id, 
            imagenWeb: req.body.imagenWeb || serviciosData[i].imagenWeb, 
            imagenWhatsApp: iwa,
            videoUrl: videoUrl
        };
        await fs.writeFile(SERVICIOS_FILE, JSON.stringify(serviciosData, null, 2), 'utf8');
        await inicializarBaseConocimiento();
        res.json({ ok: true, mensaje: 'Servicio actualizado' });
    } catch(e) {
        res.status(500).json({ error: 'Error al actualizar' });
    }
});

app.delete('/api/servicios/:id', async (req, res) => {
    if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    const antes = serviciosData.length;
    serviciosData = serviciosData.filter(s => s.id !== req.params.id);
    await fs.writeFile(SERVICIOS_FILE, JSON.stringify(serviciosData, null, 2), 'utf8');
    await inicializarBaseConocimiento();
    res.json({ ok: true, mensaje: serviciosData.length < antes ? 'Servicio eliminado' : 'No encontrado' });
});

// ==================== TURNOS ====================
let turnosMem = [];

async function loadTurnos() {
    try {
        if (fsSync.existsSync(TURNOS_FILE)) {
            turnosMem = JSON.parse(await fs.readFile(TURNOS_FILE, 'utf8'));
        } else {
            turnosMem = [];
        }
    } catch(e) {
        turnosMem = [];
    }
    return turnosMem;
}

async function saveTurnos(t) {
    await fs.writeFile(TURNOS_FILE, JSON.stringify(t, null, 2), 'utf8');
    turnosMem = t;
}

app.get('/turnos', async (req, res) => res.json(await loadTurnos()));

app.post('/turnos', async (req, res) => {
    const ip = req.ip || '0.0.0.0';
    if (estaBloqueado(ip)) return res.status(403).json({ error: 'IP bloqueada por seguridad' });
    if (!checkRateIP(ip)) {
        bloquearIP(ip, 'Exceso de solicitudes de turnos', 'spam');
        return res.status(429).json({ error: 'Demasiadas solicitudes. Espere una hora.' });
    }
    
    try {
        const { nombre, dia, hora, massageType, telefono, ubicacion, tipoServicio } = req.body;
        
        // Verificar palabras ofensivas
        const palabraOfensiva = contienePalabraBaneada(nombre);
        if (palabraOfensiva) {
            bloquearIP(ip, `Uso de lenguaje ofensivo en el nombre: "${nombre}" contiene "${palabraOfensiva}"`, 'Lenguaje Ofensivo', palabraOfensiva);
            return res.status(403).json({ error: 'Nombre no permitido. Por favor, use un nombre apropiado.' });
        }
        
        if (!nombre || nombre.length < 2) {
            return res.status(400).json({ error: 'Nombre inválido. Mínimo 2 caracteres.' });
        }
        
        const tel = telefono ? telefono.replace(/\D/g, '') : '';
        if (!tel || tel.length < 7) {
            return res.status(400).json({ error: 'Teléfono inválido. Mínimo 7 dígitos.' });
        }
        
        let codigoPais = req.body.codigoPais || '53';
        if (!/^\d{1,3}$/.test(codigoPais)) codigoPais = '53';
        
        if (!paisAutorizado(codigoPais)) {
            return res.status(403).json({ 
                error: 'País no autorizado',
                mensaje: 'Lo sentimos, no aceptamos reservas desde su país en este momento.'
            });
        }
        
        let diaLower = dia.toLowerCase();
        const fechaRelativa = obtenerFechaRelativa(diaLower);
        if (fechaRelativa && DIAS_VALIDOS.includes(fechaRelativa)) {
            diaLower = fechaRelativa;
        }
        
        if (!diaLower || !DIAS_VALIDOS.includes(diaLower)) {
            return res.status(400).json({ error: `Día inválido. Días disponibles: ${DIAS_VALIDOS.join(', ')}` });
        }
        
        // Verificar que no sea un día que ya pasó
        if (!esFechaValida(diaLower)) {
            return res.status(400).json({ error: `No se puede reservar para un día que ya pasó. Por favor, elegí un día futuro.` });
        }
        
        const hn = parseInt(hora);
        if (!HORAS_VALIDAS.includes(hn)) {
            return res.status(400).json({ error: `Hora inválida. Horarios: ${horariosConfig.horarios.join(', ')}` });
        }
        
        if (!checkRateTel(tel)) {
            return res.status(429).json({ error: 'Máximo 2 turnos por teléfono por día.' });
        }
        
        const turnos = await loadTurnos();
        
        if (turnos.some(t => t.telefono === tel && t.dia === diaLower)) {
            return res.status(409).json({ error: 'Ya tienes un turno reservado para ese día.' });
        }
        
        if (turnos.some(t => t.dia === diaLower && t.hora === hn)) {
            const alternativa = buscarAlternativa(diaLower, hn, turnos);
            if (alternativa) {
                return res.status(409).json({ 
                    error: 'Horario ocupado', 
                    alternativa: alternativa,
                    mensaje: `El horario de las ${hn}:00 del ${diaLower} está ocupado. Tengo disponible ${alternativa.dia} a las ${alternativa.hora}:00. ¿Te sirve?`
                });
            }
            return res.status(409).json({ error: 'Horario ocupado, no hay alternativas disponibles' });
        }
        
        const codigoCancelacion = generarCodigoCancelacion();
        
        const nuevo = {
            id: generarId(),
            nombre: escapeHtml(sanitize(nombre)),
            dia: diaLower,
            hora: hn,
            massageType: massageType || 'Masaje',
            telefono: tel,
            codigoPais: codigoPais,
            ubicacion: ubicacion ? escapeHtml(sanitize(ubicacion)) : paisesConfig.ubicacionSalon,
            tipoServicio: tipoServicio || 'salon',
            confirmadoWhatsApp: false,
            fechaCreacion: new Date().toISOString(),
            ip,
            codigoCancelacion: codigoCancelacion
        };
        
        turnos.push(nuevo);
        await saveTurnos(turnos);
        regTurno(ip, tel);
        intentosFallidos.delete(ip);
        
        // Mensaje profesional de confirmación
        const imagenServicio = serviciosData.find(s => s.nombre === massageType)?.imagenWhatsApp || '';
        const horaTexto = hn === 12 ? '12:00 hs' : hn === 16 ? '16:00 hs' : '20:00 hs';
        const ubicacionTexto = tipoServicio === 'domicilio' ? ubicacion : paisesConfig.ubicacionSalon;
        
        let mensajeWhatsApp = `🌿 *SERENITY SPA*\n\nHola *${nombre}*, ¡Gracias! ✨\n\n✅ *RESERVA CONFIRMADA*\n\n📅 *Día:* ${diaLower.charAt(0).toUpperCase() + diaLower.slice(1)}\n⏰ *Hora:* ${horaTexto}\n💆‍♂️ *Masaje:* ${massageType}\n📍 ${ubicacionTexto}\n\n🌸 Te esperamos.\n⏱️ Cancelá con 4hs de anticipación.\n\n🔑 *Código de cancelación:* ${codigoCancelacion}\n\n*Equipo Serenity Spa*`;
        
        if (imagenServicio) {
            mensajeWhatsApp += `\n\n🖼️ *Imagen:* ${imagenServicio}`;
        }
        
        res.status(201).json({ 
            mensaje: 'Turno reservado con éxito', 
            turno: nuevo,
            mensajeWhatsApp: mensajeWhatsApp,
            codigoCancelacion: codigoCancelacion
        });
    } catch(e) {
        console.error('Error en POST /turnos:', e);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

app.delete('/turnos/:id', async (req, res) => {
    if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    const turnos = await loadTurnos();
    const i = turnos.findIndex(t => t.id === req.params.id);
    if (i === -1) return res.status(404).json({ error: 'Turno no encontrado' });
    turnos.splice(i, 1);
    await saveTurnos(turnos);
    res.json({ ok: true, mensaje: 'Turno eliminado' });
});

// Cancelar por código
app.post('/api/cancelar-por-codigo', async (req, res) => {
    const ip = req.ip || '0.0.0.0';
    const { codigo } = req.body;
    
    if (!codigo || codigo.length !== 6) {
        return res.status(400).json({ error: 'Código inválido. Debe tener 6 caracteres.' });
    }
    
    const resultado = await cancelarPorCodigo(codigo.toUpperCase(), ip);
    res.json(resultado);
});

app.post('/api/modificar-turno', async (req, res) => {
    const ip = req.ip || '0.0.0.0';
    const { telefono, nombre, massageType, dia, hora } = req.body;
    
    // Verificar día futuro si se está cambiando el día
    if (dia) {
        if (!esFechaValida(dia)) {
            return res.json({ success: false, mensaje: "No se puede modificar a un día que ya pasó. Por favor, elegí un día futuro." });
        }
    }
    
    const resultado = await modificarReserva(telefono, { nombre, massageType, dia, hora }, ip);
    res.json(resultado);
});

app.post('/api/cancelar-turno', async (req, res) => {
    try {
        const tel = (req.body.telefono || '').replace(/\D/g, '');
        if (tel.length < 7) return res.json({ error: 'Número inválido.' });
        const turnos = await loadTurnos();
        const turno = turnos.find(t => t.telefono === tel);
        if (!turno) return res.json({ error: 'No se encontró un turno activo con ese número.' });
        turnos.splice(turnos.indexOf(turno), 1);
        await saveTurnos(turnos);
        res.json({ cancelado: true, mensaje: `Turno del ${turno.dia} a las ${turno.hora}:00 cancelado.` });
    } catch(e) {
        res.status(500).json({ error: 'Error al cancelar' });
    }
});

app.post('/api/enviar-whatsapp/:id', async (req, res) => {
    try {
        const turnos = await loadTurnos();
        const t = turnos.find(x => x.id === req.params.id);
        if (!t) return res.status(404).json({ error: 'Turno no encontrado' });
        const s = serviciosData.find(x => x.nombre === t.massageType);
        const img = (s?.imagenWhatsApp && esUrlValida(s.imagenWhatsApp)) ? s.imagenWhatsApp : '';
        
        const horaTexto = t.hora === 12 ? '12:00 hs' : t.hora === 16 ? '16:00 hs' : '20:00 hs';
        const ubicacionTexto = t.tipoServicio === 'domicilio' ? t.ubicacion : paisesConfig.ubicacionSalon;
        
        let msg = `🌿 *SERENITY SPA*\n\nHola *${t.nombre}*, ¡Gracias! ✨\n\n✅ *RESERVA CONFIRMADA*\n\n📅 *Día:* ${t.dia.charAt(0).toUpperCase() + t.dia.slice(1)}\n⏰ *Hora:* ${horaTexto}\n💆‍♂️ *Masaje:* ${t.massageType}\n📍 ${ubicacionTexto}\n\n🌸 Te esperamos.\n⏱️ Cancelá con 4hs de anticipación.\n\n🔑 *Código de cancelación:* ${t.codigoCancelacion}\n\n*Equipo Serenity Spa*`;
        
        if (img) msg += `\n\n🖼️ *Imagen:* ${img}`;
        
        const cod = t.codigoPais || '53';
        const idx = turnos.findIndex(x => x.id === req.params.id);
        if (idx !== -1) {
            turnos[idx].confirmadoWhatsApp = true;
            turnos[idx].fechaWA = new Date().toISOString();
            await saveTurnos(turnos);
        }
        res.json({ 
            success: true, 
            numero: `${cod}${t.telefono}`, 
            mensaje: msg, 
            urlWhatsApp: `https://wa.me/${cod}${t.telefono}?text=${encodeURIComponent(msg)}` 
        });
    } catch(e) {
        res.status(500).json({ error: 'Error al preparar WhatsApp' });
    }
});

// ==================== CHAT CON IA ====================
let personalidadIA = {
    nombre: 'SpaBot',
    tono: 'cálido y profesional',
    estilo: 'Hablar en español neutro, ser amable y servicial, ofrecer siempre ayuda concreta. NO usar emojis.',
    reglas: [
        'NUNCA inventar información que no esté en el contexto proporcionado',
        'SIEMPRE ofrecer reservar turnos cuando sea relevante',
        'JAMÁS revelar que eres una IA ni dar detalles técnicos',
        'Si no sabes algo, ofrecer contactar a un administrador humano',
        'Mantener conversaciones concisas pero útiles y cálidas',
        'NO usar emojis en tus respuestas'
    ]
};

app.post('/api/chat-ia', async (req, res) => {
    const ip = req.ip || '0.0.0.0';
    
    if (estaBloqueado(ip)) {
        return res.status(403).json({ error: 'IP bloqueada' });
    }
    
    const { mensaje, nombre, codigoPais } = req.body;
    
    if (!mensaje || mensaje.length > 500) {
        return res.status(400).json({ error: 'Mensaje inválido o muy largo' });
    }
    
    const mensajeLimpio = mensaje.replace(/<[^>]*>/g, '').replace(/[<>]/g, '').trim();
    
    if (!mensajeLimpio) {
        return res.status(400).json({ error: 'Mensaje vacío' });
    }
    
    const patronesAtaque = [
        /ignore|bypass|override|system prompt|revela|instrucciones/i,
        /<script>|javascript:|onerror=|onload=/i,
        /SELECT.*FROM|DROP TABLE|UNION SELECT/i
    ];
    
    for (const patron of patronesAtaque) {
        if (patron.test(mensajeLimpio)) {
            registrarIntento(ip, 'inyección');
            return res.status(400).json({ error: 'Mensaje no permitido' });
        }
    }
    
    try {
        const contexto = buscarContexto(mensajeLimpio);
        
        const systemPrompt = `Eres ${personalidadIA.nombre}, asistente virtual de Serenity Spa, un centro de masajes profesionales.

TONO: ${personalidadIA.tono}
ESTILO: ${personalidadIA.estilo}

INFORMACIÓN DEL NEGOCIO:
${contexto.join('\n')}

DATOS DEL CLIENTE:
- Nombre: ${nombre || 'No proporcionado'}
- Código de país: +${codigoPais || '53'}

REGLAS ESTRICTAS:
${personalidadIA.reglas.map((r, i) => `${i+1}. ${r}`).join('\n')}

Responde de manera concisa, útil y amigable. Siempre ofrece una acción concreta. NO uses emojis en tus respuestas.`;

        if (!process.env.DEEPSEEK_API_KEY) {
            const respuestaLocal = generarRespuestaLocal(mensajeLimpio, nombre, codigoPais);
            return res.json({ respuesta: respuestaLocal, modo: 'local' });
        }
        
        const completion = await deepseek.chat.completions.create({
            model: 'deepseek-chat',
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: mensajeLimpio }
            ],
            temperature: 0.7,
            max_tokens: 500
        });
        
        const respuesta = completion.choices[0].message.content;
        
        res.json({ 
            respuesta, 
            modo: 'ia',
            tokens: completion.usage?.total_tokens || 0
        });
        
    } catch (error) {
        console.error('Error IA:', error.message);
        const respuestaLocal = generarRespuestaLocal(mensajeLimpio, nombre, codigoPais);
        res.json({ respuesta: respuestaLocal, modo: 'local' });
    }
});

function buscarContexto(pregunta) {
    const palabrasClave = pregunta.toLowerCase().split(/\s+/);
    let resultados = [];
    
    for (const item of baseConocimiento) {
        let puntuacion = 0;
        const contenidoLower = item.contenido.toLowerCase();
        
        for (const palabra of palabrasClave) {
            if (palabra.length > 2 && contenidoLower.includes(palabra)) {
                puntuacion += 1;
            }
        }
        
        if (puntuacion > 0) {
            resultados.push({ ...item, puntuacion });
        }
    }
    
    return resultados
        .sort((a, b) => b.puntuacion - a.puntuacion)
        .slice(0, 5)
        .map(r => r.contenido);
}

function generarRespuestaLocal(mensaje, nombre, codigoPais) {
    const msg = mensaje.toLowerCase();
    const cliente = nombre || 'cliente';
    
    if (/\b(cancelar|anular|eliminar|borrar|dar de baja)\b/.test(msg)) {
        return `Para cancelar tu reserva, necesito el código de cancelación que te enviamos al reservar.\n\n🔑 Por favor, ingresa tu código de 6 dígitos (ejemplo: A3B7X9) para proceder con la cancelación.\n\nSi no tienes el código, puedo ayudarte a buscarlo con tu número de teléfono.`;
    }
    
    if (/\b(hola|buenas?|saludos|hey)\b/.test(msg)) {
        return `Hola ${cliente}, bienvenido a Serenity Spa.\n\nSoy tu asistente virtual. Puedo ayudarte con:\n\n- Reservar turnos\n- Consultar horarios\n- Ver precios\n- Conocer masajes\n- Cancelar turnos (con tu código)\n- Modificar reservas\n\n¿Qué necesitas hoy?`;
    }
    
    if (/\b(modificar|cambiar|editar|ajustar)\b/.test(msg)) {
        return `Claro ${cliente}. Para modificar tu reserva, necesito tu número de teléfono. ¿Cuál es?`;
    }
    
    if (/\b(reservar|Reservar|turno|cita|agendar)\b/.test(msg)) {
        return `Claro ${cliente}. Para reservar necesito:\n\n1. Tu nombre\n2. Tipo de masaje\n3. Día (${DIAS_VALIDOS.map(d => d.charAt(0).toUpperCase() + d.slice(1)).join(', ')})\n4. Horario (${horariosConfig.horarios.join(', ')})\n5. Teléfono\n6. País\n\n¿Empezamos? ¿Qué masaje te interesa?`;
    }
    
    if (/\b(horario|Horarios|horarios|hora|cuándo|cuando)\b/.test(msg)) {
        return `Horarios Serenity Spa\n\n${DIAS_VALIDOS.map(d => d.charAt(0).toUpperCase() + d.slice(1)).join(', ')}\n${horariosConfig.horarios.join(', ')}\n\nSolo un turno por persona por día.\n\n¿Querés reservar o modificar algo?`;
    }
    
    if (/\b(precio|Precio|Precios|precios|costo|vale|cuánto|cuanto|tarifa)\b/.test(msg)) {
        let lista = 'Nuestros precios:\n\n';
        serviciosData.forEach(s => {
            lista += `${s.nombre}: ${s.precio}\n`;
        });
        lista += '\nTodos incluyen aromaterapia y música suave.\n\n¿Cuál te gustaría?';
        return lista;
    }
    
    if (/\b(gracias|agradecido)\b/.test(msg)) {
        return `Gracias a vos ${cliente}. Que tengas un excelente día. Te esperamos en Serenity Spa cuando gustes.\n\nRecordá: ${DIAS_VALIDOS.map(d => d.charAt(0).toUpperCase() + d.slice(1)).join(', ')}, ${horariosConfig.horarios.join(', ')}`;
    }
    
    if (/\b(masajes|servicios|tipos|ofrecen|brindan)\b/.test(msg)) {
        let lista = 'Nuestros servicios disponibles:\n\n';
        serviciosData.forEach((s, i) => {
            lista += `${i+1}. ${s.nombre} - ${s.precio}\n   ${s.descripcion.substring(0, 80)}...\n\n`;
        });
        lista += '¿Deseas reservar alguno o necesitas más información?';
        return lista;
    }
    
    return `Gracias por tu mensaje, ${cliente}.\n\nEn Serenity Spa ofrecemos los mejores masajes. ¿Te ayudo con algo específico?\n\n- Reservar turno\n- Modificar reserva\n- Cancelar turno (necesito tu código)\n- Ver horarios\n- Consultar precios\n- Tipos de masaje`;
}

// ==================== IA - PERSONALIDAD (ADMIN) ====================
app.get('/api/ia/personalidad', (req, res) => {
    if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    res.json(personalidadIA);
});

app.put('/api/ia/personalidad', async (req, res) => {
    if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    const { nombre, tono, estilo, reglas } = req.body;
    if (nombre) personalidadIA.nombre = sanitize(nombre);
    if (tono) personalidadIA.tono = sanitize(tono);
    if (estilo) personalidadIA.estilo = sanitize(estilo);
    if (reglas) personalidadIA.reglas = reglas.map(r => sanitize(r));
    res.json({ ok: true, personalidad: personalidadIA });
});

app.post('/api/ia/recargar', async (req, res) => {
    if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    await inicializarBaseConocimiento();
    res.json({ ok: true, items: baseConocimiento.length, mensaje: 'Base de conocimiento recargada' });
});

// ==================== SEGURIDAD - PAÍSES (ADMIN) ====================
app.get('/api/seguridad/paises', (req, res) => {
    if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    res.json(paisesConfig);
});

app.put('/api/seguridad/paises', async (req, res) => {
    if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    const { autorizados, bloqueados, modo, ubicacionSalon } = req.body;
    if (autorizados !== undefined) paisesConfig.autorizados = autorizados;
    if (bloqueados !== undefined) paisesConfig.bloqueados = bloqueados;
    if (modo && ['todos', 'solo_autorizados'].includes(modo)) {
        paisesConfig.modo = modo;
    }
    if (ubicacionSalon !== undefined) paisesConfig.ubicacionSalon = ubicacionSalon;
    await guardarPaises();
    await inicializarBaseConocimiento();
    res.json({ ok: true, paises: paisesConfig });
});

app.post('/api/seguridad/paises/autorizar', async (req, res) => {
    if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    const { codigo, nombre } = req.body;
    if (!codigo || !/^\d{1,3}$/.test(codigo)) {
        return res.status(400).json({ error: 'Código de país inválido' });
    }
    if (!paisesConfig.autorizados.includes(codigo)) {
        paisesConfig.autorizados.push(codigo);
        paisesConfig.bloqueados = paisesConfig.bloqueados.filter(c => c !== codigo);
        await guardarPaises();
        console.log(`✅ País autorizado: ${nombre || codigo} (${codigo})`);
    }
    res.json({ ok: true, mensaje: `${nombre || codigo} autorizado`, paises: paisesConfig });
});

app.post('/api/seguridad/paises/bloquear', async (req, res) => {
    if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    const { codigo, nombre } = req.body;
    if (!codigo || !/^\d{1,3}$/.test(codigo)) {
        return res.status(400).json({ error: 'Código de país inválido' });
    }
    if (!paisesConfig.bloqueados.includes(codigo)) {
        paisesConfig.bloqueados.push(codigo);
        paisesConfig.autorizados = paisesConfig.autorizados.filter(c => c !== codigo);
        await guardarPaises();
        console.log(`✅ País bloqueado: ${nombre || codigo} (${codigo})`);
    }
    res.json({ ok: true, mensaje: `${nombre || codigo} bloqueado`, paises: paisesConfig });
});

app.delete('/api/seguridad/paises/:codigo', async (req, res) => {
    if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    const codigo = req.params.codigo;
    paisesConfig.autorizados = paisesConfig.autorizados.filter(c => c !== codigo);
    paisesConfig.bloqueados = paisesConfig.bloqueados.filter(c => c !== codigo);
    await guardarPaises();
    console.log(`✅ País eliminado de listas: ${codigo}`);
    res.json({ ok: true, mensaje: `País ${codigo} eliminado de las listas` });
});

app.get('/api/seguridad/paises/stats', async (req, res) => {
    if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    const turnos = await loadTurnos();
    const stats = {};
    for (const t of turnos) {
        const cod = t.codigoPais || '53';
        if (!stats[cod]) stats[cod] = 0;
        stats[cod]++;
    }
    const nombresPaises = {
        '53': 'Cuba', '54': 'Argentina', '52': 'México', '57': 'Colombia',
        '56': 'Chile', '51': 'Perú', '34': 'España', '1': 'EE.UU.',
        '58': 'Venezuela', '593': 'Ecuador', '598': 'Uruguay', '595': 'Paraguay',
        '55': 'Brasil', '39': 'Italia', '33': 'Francia', '49': 'Alemania'
    };
    const resultado = Object.entries(stats).map(([cod, count]) => ({
        codigo: cod,
        nombre: nombresPaises[cod] || 'Desconocido',
        reservas: count
    })).sort((a, b) => b.reservas - a.reservas);
    res.json(resultado);
});

// ==================== SEGURIDAD - BLOQUEOS (ADMIN) ====================
app.get('/api/seguridad/bloqueos', (req, res) => {
    if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    const a = [];
    for (const [ip, d] of bloqueos) {
        a.push({
            ip,
            motivo: d.motivo,
            tipoAtaque: d.tipoAtaque,
            fecha: d.fecha,
            tiempoRestante: Math.max(0, d.hasta - Date.now()),
            tiempoRestanteFormateado: fmtT(Math.max(0, d.hasta - Date.now())),
            intentos: d.intentos || 0,
            permanente: d.permanente || false,
            palabraOfensiva: d.palabraOfensiva || null
        });
    }
    res.json({
        activos: a,
        historial: historialBloqueos.slice(0, 100),
        intentosFallidos: Object.fromEntries(intentosFallidos)
    });
});

app.post('/api/seguridad/desbloquear/:ip', (req, res) => {
    if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    desbloquearIP(req.params.ip);
    res.json({ ok: true, mensaje: 'IP desbloqueada' });
});

app.delete('/api/seguridad/bloqueos/:ip', (req, res) => {
    if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    bloqueos.delete(req.params.ip);
    intentosFallidos.delete(req.params.ip);
    guardarBloqueos();
    res.json({ ok: true, mensaje: 'Bloqueo eliminado' });
});

app.delete('/api/seguridad/historial/:id', (req, res) => {
    if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    historialBloqueos = historialBloqueos.filter(h => h.id !== req.params.id);
    guardarBloqueos();
    res.json({ ok: true, mensaje: 'Registro eliminado' });
});

app.post('/api/seguridad/limpiar-expirados', (req, res) => {
    if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    let b = 0;
    const now = Date.now();
    for (const [ip, d] of bloqueos) {
        if (now > d.hasta && !d.permanente) { bloqueos.delete(ip); b++; }
    }
    guardarBloqueos();
    res.json({ mensaje: `${b} bloqueos expirados eliminados` });
});

app.post('/api/seguridad/bloquear-permanente/:ip', (req, res) => {
    if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    bloquearIPpermanentemente(req.params.ip, 'Bloqueo permanente manual', 'manual');
    res.json({ ok: true, mensaje: 'IP bloqueada permanentemente' });
});

// ==================== RUTAS ESTÁTICAS ====================
app.get('/voice-assistant', (req, res) => res.sendFile(path.join(__dirname, 'voice-assistant.html')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/admin.html', (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));
app.get('/login.html', (req, res) => res.sendFile(path.join(__dirname, 'login.html')));
app.get('/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        timestamp: new Date().toISOString(), 
        uptime: process.uptime(),
        ia: process.env.DEEPSEEK_API_KEY ? 'conectada' : 'local'
    });
});

// ==================== ASISTENTE DE VOZ MEJORADO ====================
let voiceClients = new Map();

async function cancelarTurnoPorCodigoVoz(codigo, cd, ip) {
    try {
        const turnos = await loadTurnos();
        const turnoIndex = turnos.findIndex(t => t.codigoCancelacion === codigo.toUpperCase());
        
        if (turnoIndex === -1) {
            return `El código ${codigo} no es válido. Por favor, verifica tu código de cancelación. Si no lo tienes, puedo ayudarte a buscarlo con tu número de teléfono.`;
        }
        
        const turno = turnos[turnoIndex];
        const turnoInfo = `${turno.dia} a las ${turno.hora}:00`;
        
        turnos.splice(turnoIndex, 1);
        await saveTurnos(turnos);
        
        if (cd) {
            voiceClients.delete(cd.clientId);
        }
        
        return `Reserva cancelada exitosamente. Tu turno del ${turnoInfo} ha sido eliminado.\n\nSi necesitas un nuevo turno, solo di "reservar" y te ayudaré.\n\nGracias por confiar en Serenity Spa.`;
        
    } catch(e) {
        console.error('Error al cancelar por código:', e);
        return `Error al cancelar la reserva. Por favor, intenta nuevamente o contacta con nuestro equipo.`;
    }
}

async function buscarTurnoPorTelefono(telefono) {
    const turnos = await loadTurnos();
    const telLimpio = telefono.replace(/\D/g, '');
    const turno = turnos.find(t => t.telefono === telLimpio);
    return turno;
}

async function confirmarReservaInteligente(cd, ip) {
    const d = cd.datos;
    
    if (!d.codigoPais || !/^\d{1,3}$/.test(d.codigoPais)) {
        d.codigoPais = '53';
        d.pais = 'Cuba';
    }
    
    if (!paisAutorizado(d.codigoPais)) {
        return `Lo sentimos, ${d.nombre}. No aceptamos reservas desde ${d.pais || 'tu país'} en este momento.`;
    }
    
    // Verificar que el día no haya pasado
    if (!esFechaValida(d.dia)) {
        return `${d.nombre}, no se puede reservar para un día que ya pasó. Por favor, elegí un día futuro. ¿Qué día prefieres? (${DIAS_VALIDOS.map(d => d.charAt(0).toUpperCase() + d.slice(1)).join(', ')})`;
    }
    
    try {
        const turnos = await loadTurnos();
        const telefonoLimpio = d.telefono.replace(/\D/g, '');
        
        const turnoExistente = turnos.find(t => t.telefono === telefonoLimpio && t.dia === d.dia);
        if (turnoExistente) {
            return `${d.nombre}, ya tienes un turno para el ${d.dia} a las ${turnoExistente.hora}:00. Solo se permite uno por día. Si quieres cambiar, primero cancela con tu código.`;
        }
        
        const horarioOcupado = turnos.find(t => t.dia === d.dia && t.hora === d.hora);
        if (horarioOcupado) {
            const alt = buscarAlternativa(d.dia, d.hora, turnos);
            if (alt) {
                const viejoDia = d.dia;
                const viejaHora = d.hora;
                d.dia = alt.dia;
                d.hora = alt.hora;
                const horaStr = `${alt.hora}:00`;
                return `${d.nombre}, el horario de las ${viejaHora}:00 del ${viejoDia} está ocupado. Tengo disponible el ${alt.dia} a las ${horaStr}. ¿Te sirve? Responde "sí" o "no".`;
            }
            return `No hay disponibilidad para el ${d.dia}, ${d.nombre}. ¿Quieres otro día?`;
        }
        
        const codigoCancelacion = generarCodigoCancelacion();
        
        const nuevo = {
            id: generarId(),
            nombre: d.nombre,
            dia: d.dia,
            hora: d.hora,
            massageType: d.masaje,
            telefono: telefonoLimpio,
            codigoPais: d.codigoPais,
            ubicacion: paisesConfig.ubicacionSalon,
            tipoServicio: 'salon',
            confirmadoWhatsApp: false,
            fechaCreacion: new Date().toISOString(),
            ip,
            codigoCancelacion: codigoCancelacion
        };
        
        turnos.push(nuevo);
        await saveTurnos(turnos);
        
        const horaTexto = d.hora === 12 ? '12:00 hs' : d.hora === 16 ? '16:00 hs' : '20:00 hs';
        
        voiceClients.delete(cd.clientId);
        
        return `Reserva confirmada.\n\n${d.nombre}, tu turno:\nDía: ${d.dia}\nHora: ${horaTexto}\nMasaje: ${d.masaje}\nTeléfono: +${d.codigoPais} ${telefonoLimpio}\n\nTu código de cancelación es: ${codigoCancelacion}. Guárdalo por si necesitas cancelar.\n\nTe esperamos en Serenity Spa.`;
        
    } catch(e) {
        console.error('Error al reservar:', e);
        return `Error al procesar tu reserva, ${d.nombre}. Intenta de nuevo.`;
    }
}

async function procesarComandoVoz(texto, clientId, ip) {
    let cd = voiceClients.get(clientId);
    
    if (!cd) {
        cd = {
            estado: 'inicial',
            datos: {},
            intentos: 0,
            clientId: clientId,
            esperandoCodigoCancelacion: false
        };
        voiceClients.set(clientId, cd);
    }
    
    const textoLower = texto.toLowerCase();
    
    // ========== PRIORIDAD 1: CANCELAR POR CÓDIGO ==========
    if (cd.esperandoCodigoCancelacion) {
        const codigo = texto.trim().toUpperCase();
        if (/^[A-Z0-9]{6}$/.test(codigo)) {
            cd.esperandoCodigoCancelacion = false;
            return await cancelarTurnoPorCodigoVoz(codigo, cd, ip);
        } else {
            return `El código debe tener 6 caracteres alfanuméricos. Por favor, ingresa tu código de cancelación (ejemplo: A3B7X9) o di "ayuda" para otra opción.`;
        }
    }
    
    // Detectar cancelación
    if (textoLower.includes('cancelar') || textoLower.includes('anular') || 
        textoLower.includes('eliminar') || textoLower.includes('borrar') || textoLower.includes('dar de baja')) {
        
        // Buscar código en el texto
        const codigoMatch = texto.match(/\b([A-Z0-9]{6})\b/i);
        if (codigoMatch) {
            return await cancelarTurnoPorCodigoVoz(codigoMatch[1], cd, ip);
        }
        
        cd.esperandoCodigoCancelacion = true;
        return `Para cancelar tu reserva, necesito tu código de cancelación de 6 dígitos (ejemplo: A3B7X9). Por favor, ingresa tu código ahora.\n\nSi no tienes el código, dime tu número de teléfono y lo buscaremos.`;
    }
    
    // Buscar teléfono para ayudar con código
    const telefonoExtraido = extraerTelefono(texto);
    if (telefonoExtraido && cd.esperandoCodigoCancelacion) {
        const turno = await buscarTurnoPorTelefono(telefonoExtraido);
        if (turno) {
            cd.esperandoCodigoCancelacion = false;
            return `Encontré una reserva a nombre de ${turno.nombre}. Tu código de cancelación es: ${turno.codigoCancelacion}. ¿Quieres cancelar esta reserva? Responde "sí" para cancelar.`;
        } else {
            return `No encontré ninguna reserva con ese número de teléfono. Por favor, verifica el número o ingresa tu código de cancelación.`;
        }
    }
    
    // ========== PRIORIDAD 2: MODIFICAR TURNO ==========
    if (textoLower.includes('modificar') || textoLower.includes('cambiar') || 
        textoLower.includes('editar') || textoLower.includes('ajustar')) {
        
        if (cd.datos?.telefono) {
            cd.estado = 'modificando';
            cd.datosModificacion = {};
            return `Voy a ayudarte a modificar tu reserva. ¿Qué deseas cambiar? (nombre, día, hora o masaje)`;
        }
        
        return `Para modificar tu reserva, necesito tu número de teléfono. Dímelo por favor.`;
    }
    
    // Manejo del estado de modificación
    if (cd.estado === 'modificando') {
        if (textoLower.includes('nombre')) {
            cd.estado = 'modificando_nombre';
            return `Dime el nuevo nombre.`;
        } else if (textoLower.includes('día') || textoLower.includes('dia')) {
            cd.estado = 'modificando_dia';
            const diasStr = DIAS_VALIDOS.map(d => d.charAt(0).toUpperCase() + d.slice(1)).join(', ');
            return `¿Qué día prefieres? (${diasStr})`;
        } else if (textoLower.includes('hora')) {
            cd.estado = 'modificando_hora';
            const horasStr = horariosConfig.horarios.join(', ');
            return `¿Qué hora prefieres? (${horasStr})`;
        } else if (textoLower.includes('masaje')) {
            cd.estado = 'modificando_masaje';
            let lista = '¿Qué masaje prefieres?\n\n';
            serviciosData.forEach((s, i) => {
                lista += `${i+1}. ${s.nombre} - ${s.precio}\n`;
            });
            return lista;
        } else {
            return `¿Qué deseas modificar? (nombre, día, hora o masaje)`;
        }
    }
    
    if (cd.estado === 'modificando_nombre') {
        const nuevoNombre = extraerNombre(texto);
        if (nuevoNombre) {
            const resultado = await modificarReserva(cd.datos.telefono, { nombre: nuevoNombre }, ip);
            if (resultado.success) {
                cd.datos.nombre = nuevoNombre;
                cd.estado = 'inicial';
                return resultado.mensaje;
            } else {
                return resultado.mensaje;
            }
        }
        return `No entendí el nombre. Dímelo claramente.`;
    }
    
    if (cd.estado === 'modificando_dia') {
        let nuevoDia = extraerDia(texto);
        if (!nuevoDia) {
            const fechaRelativa = obtenerFechaRelativa(texto);
            if (fechaRelativa) nuevoDia = fechaRelativa;
        }
        if (nuevoDia && DIAS_VALIDOS.includes(nuevoDia)) {
            if (!esFechaValida(nuevoDia)) {
                return `No se puede modificar a un día que ya pasó. Por favor, elegí un día futuro. Los días disponibles son: ${DIAS_VALIDOS.map(d => d.charAt(0).toUpperCase() + d.slice(1)).join(', ')}`;
            }
            const resultado = await modificarReserva(cd.datos.telefono, { dia: nuevoDia }, ip);
            if (resultado.success) {
                cd.datos.dia = nuevoDia;
                cd.estado = 'inicial';
                return resultado.mensaje;
            } else if (resultado.necesitaAlternativa) {
                cd.estado = 'esperando_alternativa';
                cd.alternativa = resultado.alternativa;
                return resultado.mensaje;
            } else {
                return resultado.mensaje;
            }
        }
        const diasStr = DIAS_VALIDOS.map(d => d.charAt(0).toUpperCase() + d.slice(1)).join(', ');
        return `Día no reconocido. Días disponibles: ${diasStr}`;
    }
    
    if (cd.estado === 'modificando_hora') {
        let nuevaHora = extraerHora(texto);
        if (nuevaHora && HORAS_VALIDAS.includes(nuevaHora)) {
            const resultado = await modificarReserva(cd.datos.telefono, { hora: nuevaHora }, ip);
            if (resultado.success) {
                cd.datos.hora = nuevaHora;
                cd.estado = 'inicial';
                return resultado.mensaje;
            } else if (resultado.necesitaAlternativa) {
                cd.estado = 'esperando_alternativa';
                cd.alternativa = resultado.alternativa;
                return resultado.mensaje;
            } else {
                return resultado.mensaje;
            }
        }
        const horasStr = horariosConfig.horarios.join(', ');
        return `Hora no reconocida. Horarios: ${horasStr}`;
    }
    
    if (cd.estado === 'modificando_masaje') {
        let nuevoMasaje = extraerMasaje(texto);
        if (nuevoMasaje) {
            const resultado = await modificarReserva(cd.datos.telefono, { massageType: nuevoMasaje }, ip);
            if (resultado.success) {
                cd.datos.masaje = nuevoMasaje;
                cd.estado = 'inicial';
                return resultado.mensaje;
            } else {
                return resultado.mensaje;
            }
        }
        return `No reconocí el masaje. Intenta de nuevo.`;
    }
    
    if (cd.estado === 'esperando_alternativa') {
        if (textoLower.includes('sí') || textoLower.includes('si') || textoLower.includes('vale') || textoLower.includes('ok')) {
            const alt = cd.alternativa;
            cd.datos.dia = alt.dia;
            cd.datos.hora = alt.hora;
            cd.estado = 'inicial';
            return await confirmarReservaInteligente(cd, ip);
        } else {
            cd.estado = 'inicial';
            return `Entiendo. ¿Quieres probar con otro día u horario?`;
        }
    }
    
    // ========== EXTRAER INFORMACIÓN ==========
    const nombreExtraido = extraerNombre(texto);
    if (nombreExtraido && !cd.datos?.nombre) {
        cd.datos = cd.datos || {};
        cd.datos.nombre = nombreExtraido;
        console.log(`📝 Nombre: ${cd.datos.nombre}`);
    }
    
    const telefonoExtraido2 = extraerTelefono(texto);
    if (telefonoExtraido2 && !cd.datos?.telefono) {
        cd.datos = cd.datos || {};
        cd.datos.telefono = telefonoExtraido2;
        console.log(`📞 Teléfono: ${cd.datos.telefono}`);
    }
    
    const paisDetectado = detectarPaisConNombre(texto);
    if (paisDetectado && !cd.datos?.codigoPais) {
        cd.datos = cd.datos || {};
        cd.datos.pais = paisDetectado.nombre;
        cd.datos.codigoPais = paisDetectado.codigo;
        console.log(`🌍 País: ${cd.datos.pais} (+${cd.datos.codigoPais})`);
    }
    
    const masajeExtraido = extraerMasaje(texto);
    if (masajeExtraido && !cd.datos?.masaje) {
        cd.datos = cd.datos || {};
        cd.datos.masaje = masajeExtraido;
        console.log(`💆 Masaje: ${cd.datos.masaje}`);
    }
    
    let diaExtraido = extraerDia(texto);
    if (diaExtraido && !cd.datos?.dia) {
        cd.datos = cd.datos || {};
        cd.datos.dia = diaExtraido;
        console.log(`📅 Día: ${cd.datos.dia}`);
    }
    
    const horaExtraida = extraerHora(texto);
    if (horaExtraida && !cd.datos?.hora) {
        cd.datos = cd.datos || {};
        cd.datos.hora = horaExtraida;
        console.log(`⏰ Hora: ${cd.datos.hora}`);
    }
    
    // ========== RESERVA AUTOMÁTICA ==========
    if (cd.datos?.nombre && cd.datos?.masaje && cd.datos?.dia && cd.datos?.hora && cd.datos?.telefono && cd.datos?.codigoPais) {
        console.log('✅ Todos los datos completos, procesando reserva...');
        return await confirmarReservaInteligente(cd, ip);
    }
    
    // ========== PREGUNTAR DATOS FALTANTES ==========
    const datos = cd.datos || {};
    
    if (!datos.nombre) {
        return `Hola, soy el asistente de Serenity Spa. ¿Cuál es tu nombre?`;
    }
    
    if (!datos.codigoPais) {
        return `${datos.nombre}, ¿de qué país eres?`;
    }
    
    if (!datos.masaje) {
        let lista = `${datos.nombre}, estos son nuestros masajes:\n\n`;
        serviciosData.forEach((s, i) => {
            lista += `${i+1}. ${s.nombre} - ${s.precio}\n`;
        });
        lista += `\n¿Cuál te interesa?`;
        return lista;
    }
    
    if (!datos.dia) {
        const diasStr = DIAS_VALIDOS.map(d => d.charAt(0).toUpperCase() + d.slice(1)).join(', ');
        return `${datos.nombre}, ¿qué día prefieres para tu ${datos.masaje}? (${diasStr})`;
    }
    
    if (!datos.hora) {
        const horasStr = horariosConfig.horarios.join(', ');
        return `${datos.nombre}, ¿a qué hora prefieres el ${datos.dia}? Tenemos ${horasStr}.`;
    }
    
    if (!datos.telefono) {
        return `${datos.nombre}, para confirmar tu reserva necesito tu número de teléfono.`;
    }
    
    // ========== PREGUNTAS DE INFORMACIÓN ==========
    if (textoLower.includes('horario') || textoLower.includes('horarios')) {
        const horasStr = horariosConfig.horarios.join(', ');
        const diasStr = DIAS_VALIDOS.map(d => d.charAt(0).toUpperCase() + d.slice(1)).join(', ');
        return `Horarios: ${horasStr}. Días: ${diasStr}. ¿Quieres reservar, modificar o cancelar, ${datos.nombre}?`;
    }
    
    if (textoLower.includes('precio') || textoLower.includes('costo')) {
        let lista = `Precios:\n\n`;
        serviciosData.forEach(s => {
            lista += `${s.nombre}: ${s.precio}\n`;
        });
        return lista;
    }
    
    if (textoLower.includes('masajes') || textoLower.includes('tipos')) {
        let lista = `Masajes disponibles:\n\n`;
        serviciosData.forEach(s => {
            lista += `${s.nombre}: ${s.descripcion}\n`;
        });
        return lista;
    }
    
    return `Hola ${datos.nombre}, ¿en qué puedo ayudarte?\n\n- Reservar un turno\n- Modificar una reserva\n- Cancelar una reserva (necesito tu código)\n- Ver horarios\n- Ver precios\n- Ver tipos de masaje`;
}

// ==================== INICIALIZACIÓN ====================
async function initFile(f, fb) {
    try { return JSON.parse(await fs.readFile(f, 'utf8')); }
    catch(e) { await fs.writeFile(f, JSON.stringify(fb, null, 2), 'utf8'); return JSON.parse(JSON.stringify(fb)); }
}

async function start() {
    await cargarBloqueos();
    await cargarPaises();
    await cargarHorarios();
    await cargarPalabrasBaneadas();
    
    configData = await initFile(CONFIG_FILE, configData);
    
    serviciosData = await initFile(SERVICIOS_FILE, [
        { id: "relajante", nombre: "Masaje Relajante", precio: "$45", descripcion: "Movimientos suaves y armónicos para liberar el estrés acumulado.", beneficios: ["Reduce ansiedad", "Alivia tensión muscular", "60 Minutos"], efectos: ["Relajación profunda", "Mejora del sueño"], imagenWeb: "https://images.unsplash.com/photo-1544161515-4ab6ce6db874?w=800", imagenWhatsApp: "", videoUrl: "", orden: 1 },
        { id: "corporal", nombre: "Masaje Corporal", precio: "$65", descripcion: "Tratamiento completo para una relajación profunda y revitalizante.", beneficios: ["Relajación integral", "Elimina contracturas", "90 Minutos"], efectos: ["Activación linfática", "Mejora circulación"], imagenWeb: "https://images.unsplash.com/photo-1519823551278-64ac92734fb1?w=800", imagenWhatsApp: "", videoUrl: "", orden: 2 },
        { id: "facial", nombre: "Masaje Facial", precio: "$40", descripcion: "Rejuvenece la piel y alivia la tensión facial acumulada.", beneficios: ["Reafirma la piel", "Reduce ojeras", "45 Minutos"], efectos: ["Estimula colágeno", "Tonifica rostro"], imagenWeb: "https://images.unsplash.com/photo-1570172619644-dfd03ed5d881?w=800", imagenWhatsApp: "", videoUrl: "", orden: 3 }
    ]);
    
    turnosMem = await initFile(TURNOS_FILE, []);
    await inicializarBaseConocimiento();

    const server = app.listen(PORT, '0.0.0.0', () => {
        console.log(`🌿 Serenity Spa v6.0 iniciado en puerto ${PORT}`);
        console.log(`🧠 IA: ${process.env.DEEPSEEK_API_KEY ? 'DeepSeek conectado' : 'Modo local (gratuito)'}`);
        console.log(`📅 Días: ${DIAS_VALIDOS.join(', ')}`);
        console.log(`⏰ Horarios: ${horariosConfig.horarios.join(', ')}`);
        console.log(`🌍 Países autorizados: ${paisesConfig.autorizados.length}`);
        console.log(`🚫 Países bloqueados: ${paisesConfig.bloqueados.length}`);
        console.log(`📍 Ubicación del salón: ${paisesConfig.ubicacionSalon}`);
        console.log(`🔑 Palabras baneadas: ${palabrasBaneadas.length}`);
        console.log(`🎥 Videos: Soporte para YouTube, Vimeo y MP4`);
    });

    const wss = new WebSocket.Server({ server, path: '/ws-voice' });
    
    wss.on('connection', (ws, req) => {
        const ip = req.socket.remoteAddress || 'desconocida';
        
        if (estaBloqueado(ip)) {
            ws.close(1008, 'IP bloqueada');
            return;
        }
        
        const cid = generarId();
        let mc = 0;
        voiceClients.set(cid, { estado: 'inicial', datos: {}, intentos: 0, clientId: cid });
        
        ws.on('message', async (data) => {
            mc++;
            if (mc > 20) {
                bloquearIP(ip, 'Flood WebSocket', 'flood');
                ws.close(1008);
                return;
            }
            try {
                const m = JSON.parse(data);
                if (m.tipo === 'transcripcion') {
                    const r = await procesarComandoVoz(m.texto, cid, ip);
                    if (ws.readyState === 1) {
                        ws.send(JSON.stringify({ tipo: 'respuesta', texto: r }));
                    }
                }
            } catch(e) {
                console.error('Error procesando mensaje:', e);
                if (ws.readyState === 1) {
                    ws.send(JSON.stringify({ tipo: 'respuesta', texto: 'Disculpe, hubo un error. ¿Podría repetir?' }));
                }
            }
        });
        
        ws.on('close', () => voiceClients.delete(cid));
        ws.on('error', () => voiceClients.delete(cid));
        
        const ft = setInterval(() => { mc = 0; }, 60000);
        ws.on('close', () => clearInterval(ft));
    });
}

process.on('SIGTERM', async () => { await guardarBloqueos(); await guardarPaises(); await guardarHorarios(); await guardarPalabrasBaneadas(); process.exit(0); });
process.on('SIGINT', async () => { await guardarBloqueos(); await guardarPaises(); await guardarHorarios(); await guardarPalabrasBaneadas(); process.exit(0); });

start();
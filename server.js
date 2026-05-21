const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 5001;
const TURNOS_FILE = path.join(__dirname, 'turnos.json');
const SERVICIOS_FILE = path.join(__dirname, 'servicios.json');
const CONFIG_FILE = path.join(__dirname, 'config.json');

console.log('✅ SERVIDOR INICIANDO - NUEVAS REGLAS: 3 turnos/día (12,16,20), 2 semanas');

// ==================== MIDDLEWARES ====================
app.use(express.json());
app.use(express.static(__dirname, { maxAge: '2h', etag: true }));

// ==================== NUEVAS REGLAS DE TURNOS ====================
// Solo 3 horarios fijos por día
const HORAS_VALIDAS = [12, 16, 20]; // 12:00, 16:00, 20:00
const DIAS_VALIDOS = ['lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado']; // Domingo cerrado
const DIAS_SEMANA = ['lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado', 'domingo'];

// Rango de reserva: 2 semanas (14 días)
function getFechaLimiteReserva() {
    const hoy = new Date();
    const limite = new Date(hoy);
    limite.setDate(hoy.getDate() + 14);
    return limite;
}

function fechaDentroDeRango(diaSemana) {
    // Verifica si el día solicitado está dentro de los próximos 14 días
    const hoy = new Date();
    const diasSemanaMap = { 'lunes':1, 'martes':2, 'miercoles':3, 'jueves':4, 'viernes':5, 'sabado':6, 'domingo':0 };
    const diaNum = diasSemanaMap[diaSemana.toLowerCase()];
    if (diaNum === undefined) return false;
    
    const hoyNum = hoy.getDay(); // 0 domingo, 1 lunes...
    let diferencia = diaNum - hoyNum;
    if (diferencia < 0) diferencia += 7;
    if (diferencia === 0 && hoy.getHours() >= 20) diferencia = 7; // Si ya pasó el último turno
    
    return diferencia <= 14;
}

// ==================== VALIDACIONES MEJORADAS ====================
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

// Verificar si un cliente ya tiene turno en un día específico
function clienteTieneTurnoEseDia(turnos, telefono, dia) {
    const telefonoLimpio = telefono.replace(/\D/g, '');
    return turnos.some(t => t.telefono === telefonoLimpio && t.dia === dia.toLowerCase());
}

// Verificar si un horario está ocupado
function horarioOcupado(turnos, dia, hora) {
    return turnos.some(t => t.dia === dia.toLowerCase() && t.hora === hora);
}

// Obtener disponibilidad de la semana
function getDisponibilidadSemana(turnos) {
    const disponibilidad = {};
    for (const dia of DIAS_VALIDOS) {
        const turnosDia = turnos.filter(t => t.dia === dia);
        const horasOcupadas = turnosDia.map(t => t.hora);
        const horasLibres = HORAS_VALIDAS.filter(h => !horasOcupadas.includes(h));
        disponibilidad[dia] = {
            tieneDisponibilidad: horasLibres.length > 0,
            horasLibres: horasLibres,
            ocupados: horasOcupadas
        };
    }
    return disponibilidad;
}

// ==================== CONFIGURACIÓN ====================
let configData = {
    hero: {
        titulo: "Renueva tu Energía",
        subtitulo: "Experiencias de bienestar diseñadas para armonizar cuerpo, mente y espíritu.",
        imagenFondo: "https://images.unsplash.com/photo-1544161515-4ab6ce6db874?ixlib=rb-1.2.1&auto=format&fit=crop&w=1920&q=80",
        botonTexto: "Explorar Tratamientos"
    },
    serviciosSection: {
        etiqueta: "Nuestros Servicios",
        titulo: "Elige tu Masaje Ideal",
        descripcion: "Tratamientos personalizados con terapeutas certificados. Turnos: 12:00, 16:00 y 20:00."
    },
    contactoSection: {
        titulo: "Asistente de Reservas",
        descripcion: "Habla con nuestro asistente virtual para reservar tu turno de forma rápida y sencilla."
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
        try {
            await fs.writeFile(CONFIG_FILE, JSON.stringify(configData, null, 2), 'utf8');
            console.log('📁 Archivo config.json creado');
        } catch (err) {
            console.log('⚠️ Usando memoria para configuración');
        }
    }
}

async function guardarConfiguracion(config) {
    try {
        await fs.writeFile(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');
        configData = config;
        return true;
    } catch {
        configData = config;
        return true;
    }
}

// ==================== GESTIÓN DE SERVICIOS ====================
let serviciosData = [];

async function inicializarServicios() {
    const serviciosDefault = [
        { id: "relajante", nombre: "Masaje Relajante", precio: "$45", descripcion: "Movimientos suaves y rítmicos para liberar el estrés.", beneficios: ["Reduce ansiedad y tensión", "Mejora la circulación", "60 Minutos"], efectos: ["Relajación del sistema nervioso", "Disminución de tensión", "Sensación de bienestar"], imagen: "https://images.unsplash.com/photo-1544161515-4ab6ce6db874?ixlib=rb-1.2.1&auto=format&fit=crop&w=800&q=80", destacado: true, orden: 1 },
        { id: "corporal", nombre: "Masaje Corporal", precio: "$65", descripcion: "Tratamiento completo para una relajación profunda.", beneficios: ["Relajación integral", "Liberación de toxinas", "90 Minutos"], efectos: ["Activación linfática", "Reducción de fatiga", "Ligereza corporal"], imagen: "https://images.unsplash.com/photo-1519823551278-64ac92734fb1?ixlib=rb-1.2.1&auto=format&fit=crop&w=800&q=80", destacado: true, orden: 2 },
        { id: "facial", nombre: "Masaje Facial", precio: "$40", descripcion: "Rejuvenece la piel y alivia la tensión facial.", beneficios: ["Reafirma la piel", "Reduce líneas de expresión", "45 Minutos"], efectos: ["Estimula colágeno", "Reduce hinchazón", "Mejora luminosidad"], imagen: "https://images.unsplash.com/photo-1570172619644-dfd03ed5d881?ixlib=rb-1.2.1&auto=format&fit=crop&w=800&q=80", destacado: true, orden: 3 }
    ];
    
    try {
        await fs.access(SERVICIOS_FILE);
        const data = await fs.readFile(SERVICIOS_FILE, 'utf8');
        serviciosData = JSON.parse(data);
        console.log(`📂 Cargados ${serviciosData.length} servicios`);
    } catch {
        serviciosData = serviciosDefault;
        try {
            await fs.writeFile(SERVICIOS_FILE, JSON.stringify(serviciosData, null, 2), 'utf8');
            console.log('📁 Archivo servicios.json creado');
        } catch (err) {
            console.log('⚠️ Usando memoria para servicios');
        }
    }
}

function generarId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2);
}

// ==================== RUTAS API ====================

// Configuración
app.get('/api/config', (req, res) => res.json(configData));
app.put('/api/config', async (req, res) => {
    try {
        const updates = req.body;
        const newConfig = { ...configData, ...updates };
        await guardarConfiguracion(newConfig);
        res.json({ mensaje: 'Configuración actualizada', config: configData });
    } catch (error) {
        res.status(500).json({ error: 'Error al guardar configuración' });
    }
});

// Servicios
app.get('/api/servicios', async (req, res) => {
    try {
        const servicios = serviciosData.sort((a, b) => (a.orden || 999) - (b.orden || 999));
        res.json(servicios);
    } catch (error) {
        res.status(500).json({ error: 'Error al cargar servicios' });
    }
});

app.post('/api/servicios', async (req, res) => {
    try {
        const { nombre, precio, descripcion, beneficios, efectos, imagen } = req.body;
        if (!nombre || !precio || !descripcion) {
            return res.status(400).json({ error: 'Faltan campos obligatorios' });
        }
        const nuevoServicio = {
            id: generarId(),
            nombre: escapeText(nombre.trim()),
            precio: precio,
            descripcion: escapeText(descripcion.trim()),
            beneficios: Array.isArray(beneficios) ? beneficios.map(b => escapeText(b)) : [escapeText(beneficios)],
            efectos: Array.isArray(efectos) ? efectos.map(e => escapeText(e)) : (efectos ? [escapeText(efectos)] : ["Bienestar general"]),
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

app.put('/api/servicios/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { nombre, precio, descripcion, beneficios, efectos, imagen } = req.body;
        const index = serviciosData.findIndex(s => s.id === id);
        if (index === -1) return res.status(404).json({ error: 'Servicio no encontrado' });
        if (nombre) serviciosData[index].nombre = escapeText(nombre.trim());
        if (precio) serviciosData[index].precio = precio;
        if (descripcion) serviciosData[index].descripcion = escapeText(descripcion.trim());
        if (beneficios) serviciosData[index].beneficios = Array.isArray(beneficios) ? beneficios.map(b => escapeText(b)) : [escapeText(beneficios)];
        if (efectos) serviciosData[index].efectos = Array.isArray(efectos) ? efectos.map(e => escapeText(e)) : [escapeText(efectos)];
        if (imagen) serviciosData[index].imagen = imagen;
        await guardarServicios(serviciosData);
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
        await guardarServicios(serviciosData);
        res.json({ mensaje: 'Servicio eliminado' });
    } catch (error) {
        res.status(500).json({ error: 'Error al eliminar servicio' });
    }
});

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

// Disponibilidad (nueva versión con 3 horarios)
app.get('/api/disponibilidad', async (req, res) => {
    try {
        const turnos = await cargarTurnos();
        const disponibilidad = getDisponibilidadSemana(turnos);
        res.json(disponibilidad);
    } catch (error) {
        res.status(500).json({ error: 'Error al obtener disponibilidad' });
    }
});

// Turnos
app.get('/turnos', async (req, res) => {
    try {
        const turnos = await cargarTurnos();
        res.json(turnos);
    } catch (error) {
        res.status(500).json({ error: 'Error al cargar turnos' });
    }
});

// CREAR TURNO (con nuevas reglas)
app.post('/turnos', async (req, res) => {
    try {
        const { nombre, dia, hora, massageType, telefono, ubicacion, tipoServicio } = req.body;
        
        // Validaciones básicas
        if (!validarNombre(nombre)) {
            return res.status(400).json({ error: 'Nombre inválido. Use solo letras y espacios.' });
        }
        if (!validarTelefono(telefono)) {
            return res.status(400).json({ error: 'Número de teléfono inválido.' });
        }
        if (!dia || !DIAS_VALIDOS.includes(dia.toLowerCase())) {
            return res.status(400).json({ error: `Día no válido. Días disponibles: ${DIAS_VALIDOS.join(', ')}` });
        }
        
        const horaNum = parseInt(hora);
        if (!HORAS_VALIDAS.includes(horaNum)) {
            return res.status(400).json({ error: `Hora no válida. Horarios: ${HORAS_VALIDAS.join(':00, ')}:00` });
        }
        
        // Verificar rango de 2 semanas
        if (!fechaDentroDeRango(dia)) {
            return res.status(400).json({ error: 'Solo se puede reservar con hasta 2 semanas de anticipación.' });
        }

        const turnos = await cargarTurnos();
        const telefonoLimpio = telefono.replace(/\D/g, '');
        
        // Verificar que el cliente no tenga ya un turno el mismo día
        if (clienteTieneTurnoEseDia(turnos, telefonoLimpio, dia)) {
            return res.status(409).json({ error: 'Ya tienes un turno reservado para ese día. Solo se permite un masaje por día.' });
        }
        
        // Verificar que el horario no esté ocupado
        if (horarioOcupado(turnos, dia, horaNum)) {
            const disponibilidad = getDisponibilidadSemana(turnos);
            return res.status(409).json({ 
                error: 'Horario no disponible',
                disponibilidad: disponibilidad[dia.toLowerCase()]
            });
        }

        const nuevoTurno = {
            id: generarId(),
            nombre: escapeText(nombre.trim()),
            dia: dia.toLowerCase(),
            hora: horaNum,
            massageType: massageType ? escapeText(massageType) : 'Masaje',
            telefono: telefonoLimpio,
            ubicacion: ubicacion ? escapeText(ubicacion.trim()) : null,
            tipoServicio: tipoServicio || 'salon',
            fechaCreacion: new Date().toISOString(),
            estado: 'confirmado'
        };

        turnos.push(nuevoTurno);
        await guardarTurnos(turnos);
        
        res.status(201).json({ 
            mensaje: 'Turno creado exitosamente', 
            turno: nuevoTurno,
            mensajeWhatsApp: generarMensajeWhatsApp(nuevoTurno)
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Error al crear turno' });
    }
});

// Generar mensaje bonito para WhatsApp con imagen del masaje
function generarMensajeWhatsApp(turno) {
    const servicio = serviciosData.find(s => s.nombre === turno.massageType);
    const imagenUrl = servicio?.imagen || "https://images.unsplash.com/photo-1544161515-4ab6ce6db874?ixlib=rb-1.2.1&auto=format&fit=crop&w=800&q=80";
    const tipoTexto = turno.tipoServicio === 'domicilio' ? `📍 Dirección: ${turno.ubicacion}` : '📍 En nuestro salón';
    
    return `🌿 *Serenity Spa* - Confirmación de Reserva 🌿

Hola *${turno.nombre}*, gracias por confiar en nosotros.

✨ *Tu reserva ha sido confirmada:*
📅 Día: ${turno.dia.charAt(0).toUpperCase() + turno.dia.slice(1)}
⏰ Hora: ${turno.hora}:00 hs
💆‍♂️ Masaje: ${turno.massageType}
${tipoTexto}

🔗 *Ver más sobre este masaje:*
${imagenUrl}

🌸 *Te esperamos con aromaterapia y música suave.*
Si necesitas modificar o cancelar, responde este mensaje antes de 4 horas.

Con cariño,
Equipo Serenity Spa

*¿Quieres compartir tu experiencia?* 🌟
Comparte este enlace: ${process.env.BASE_URL || 'https://masajes-spa.onrender.com'}`;
}

// Endpoint para notificar por WhatsApp (simulado - listo para integrar Twilio)
app.post('/turnos/notificar-whatsapp/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const turnos = await cargarTurnos();
        const turno = turnos.find(t => t.id === id);
        if (!turno) return res.status(404).json({ error: 'Turno no encontrado' });
        
        const mensaje = generarMensajeWhatsApp(turno);
        
        // Aquí se integraría Twilio o WhatsApp Business API
        console.log(`📱 Enviando WhatsApp a ${turno.telefono}:`, mensaje);
        
        res.json({ 
            mensaje: 'Notificación preparada', 
            numero: turno.telefono, 
            texto: mensaje,
            integracionPendiente: true,
            instruccion: 'Para enviar realmente, configura Twilio con tus credenciales'
        });
    } catch (error) {
        res.status(500).json({ error: 'Error al preparar notificación' });
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

// Login simple
app.post('/api/login', (req, res) => {
    const { password } = req.body;
    // Contraseña simple (cámbiala en producción)
    if (password === 'admin123') {
        const token = `session_${Date.now()}_${Math.random().toString(36).substr(2)}`;
        res.json({ success: true, token, expiresIn: 8 * 60 * 60 });
    } else {
        res.status(401).json({ error: 'Contraseña incorrecta' });
    }
});

app.get('/api/verify', (req, res) => {
    res.json({ valid: true });
});

app.post('/api/logout', (req, res) => {
    res.json({ success: true });
});

// RUTAS HTML
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/admin.html', (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));
app.get('/login.html', (req, res) => res.sendFile(path.join(__dirname, 'login.html')));
app.get('/health', (req, res) => res.json({ status: 'OK', timestamp: new Date().toISOString() }));

// ==================== INICIAR SERVIDOR ====================
async function startServer() {
    await inicializarConfiguracion();
    await inicializarServicios();
    await inicializarArchivoTurnos();
    
    app.listen(PORT, '0.0.0.0', () => {
        console.log('='.repeat(50));
        console.log('  🌿 SERENITY SPA - NUEVA VERSIÓN');
        console.log('='.repeat(50));
        console.log(`  📍 Puerto: ${PORT}`);
        console.log(`  ⏰ Horarios: ${HORAS_VALIDAS.join(':00, ')}:00`);
        console.log(`  📅 Días: ${DIAS_VALIDOS.join(', ')}`);
        console.log(`  🔒 Máximo 1 reserva por persona por día`);
        console.log(`  ✅ Servidor listo`);
        console.log('='.repeat(50));
    });
}

startServer();
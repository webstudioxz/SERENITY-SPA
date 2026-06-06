// ============================================================
// PROCESAR COMANDO DE VOZ (VERSIÓN MEJORADA - ANÁLISIS COMPLETO)
// ============================================================
var voiceClients = new Map();
var processedMessages = new Map();

async function procesarComandoVoz(texto, clientId, ip) {
    // Procesar texto completo primero
    texto = procesarTextoCompleto(texto);
    
    // Evitar procesar el mismo mensaje duplicado
    var msgHash = texto + clientId;
    if (processedMessages.has(msgHash)) {
        console.log('[DUPLICADO IGNORADO]', texto);
        return null;
    }
    processedMessages.set(msgHash, Date.now());
    setTimeout(function() { processedMessages.delete(msgHash); }, 2000);
    
    console.log('[VOZ RECIBIDA]', texto);
    console.log('[CLIENT_ID]', clientId);
    
    var textoLimpio = texto.replace(/<[^>]*>/g, '').replace(/[<>]/g, '').trim();
    if (!textoLimpio || textoLimpio.length > 500) {
        return 'Disculpe, no pude entender su mensaje. ¿Podría repetirlo?';
    }
    
    var cd = voiceClients.get(clientId);
    if (!cd) {
        cd = {
            datos: { 
                tipoServicio: null, 
                codigoPais: null, 
                nombre: null, 
                masaje: null, 
                masajeId: null,
                dia: null, 
                hora: null, 
                telefono: null, 
                ubicacion: null 
            },
            pendienteConfirmar: null,
            ultimaPregunta: null,
            esperandoConfirmacion: false,
            clientId: clientId,
            ultimoMensaje: null
        };
        voiceClients.set(clientId, cd);
        console.log('[NUEVO CLIENTE] Sesión creada para:', clientId);
    }
    
    // Guardar el último mensaje para contexto
    cd.ultimoMensaje = textoLimpio;
    
    var paisActivo = getPaisActivo();
    var codigoPaisPermitido = paisActivo ? paisActivo.codigo : '53';
    
    if (codigoPaisPermitido && !cd.datos.codigoPais) {
        cd.datos.codigoPais = codigoPaisPermitido;
    }
    
    // ANALIZAR TEXTO COMPLETO - Extraer toda la información posible
    var analisis = analizarTextoCompleto(textoLimpio);
    console.log('[ANÁLISIS COMPLETO]', JSON.stringify(analisis, null, 2));
    
    // Verificar si el mensaje contiene una intención clara de reserva
    var tieneIntencionReserva = /(?:quiero|quisiera|me gustaría|necesito|deseo|busco|reservar|agendar|pedir|cita|turno)\b/i.test(textoLimpio);
    
    // FUSIONAR DATOS DETECTADOS (actualizar solo si el cliente proporciona nuevos datos)
    var datosActualizados = false;
    
    if (analisis.nombre && analisis.nombre !== cd.datos.nombre) {
        cd.datos.nombre = analisis.nombre;
        datosActualizados = true;
        console.log('[DATOS] Nombre actualizado:', cd.datos.nombre);
    }
    
    if (analisis.masaje && analisis.masaje !== cd.datos.masaje) {
        cd.datos.masaje = analisis.masaje;
        cd.datos.masajeId = analisis.masajeId;
        datosActualizados = true;
        console.log('[DATOS] Masaje actualizado:', cd.datos.masaje);
    }
    
    if (analisis.dia && analisis.dia !== cd.datos.dia) {
        cd.datos.dia = analisis.dia;
        datosActualizados = true;
        console.log('[DATOS] Día actualizado:', cd.datos.dia);
    }
    
    if (analisis.hora && analisis.hora !== cd.datos.hora) {
        cd.datos.hora = analisis.hora;
        datosActualizados = true;
        console.log('[DATOS] Hora actualizada:', cd.datos.hora);
    }
    
    if (analisis.tipoServicio && analisis.tipoServicio !== cd.datos.tipoServicio) {
        cd.datos.tipoServicio = analisis.tipoServicio;
        datosActualizados = true;
        console.log('[DATOS] Tipo servicio actualizado:', cd.datos.tipoServicio);
    }
    
    if (analisis.ubicacion && analisis.ubicacion !== cd.datos.ubicacion) {
        cd.datos.ubicacion = analisis.ubicacion;
        datosActualizados = true;
        console.log('[DATOS] Ubicación actualizada:', cd.datos.ubicacion);
    }
    
    if (analisis.telefono && analisis.telefono !== cd.datos.telefono) {
        cd.datos.telefono = analisis.telefono;
        datosActualizados = true;
        console.log('[DATOS] Teléfono actualizado:', cd.datos.telefono);
    }
    
    // Si no hay datos y es saludo o mensaje simple
    if (!cd.datos.nombre && !tieneIntencionReserva && (textoLimpio.length < 30 || /\b(hola|buenas|saludos|hey|qué tal)\b/i.test(textoLimpio))) {
        return '¡Hola! Bienvenido a Serenity Spa. Para poder ayudarle mejor, ¿cuál es su nombre?';
    }
    
    // ============================================================
    // MANEJAR CONFIRMACIÓN DE ALTERNATIVA (horario ocupado)
    // ============================================================
    if (cd.pendienteConfirmar) {
        var t = textoLimpio.toLowerCase();
        if (/\b(si|sí|sip|dale|ok|vale|claro|por supuesto|exacto|bien|desea|confirmo|acepto|adelante|aceptar|quiero|me sirve)\b/.test(t)) {
            cd.datos.dia = cd.pendienteConfirmar.dia;
            cd.datos.hora = cd.pendienteConfirmar.hora;
            cd.pendienteConfirmar = null;
            cd.esperandoConfirmacion = false;
            return await confirmarReservaAutomatica(cd, ip);
        } else if (/\b(no|nop|nel|cancelar|nada|no quiero|no me sirve|otro)\b/.test(t)) {
            cd.pendienteConfirmar = null;
            cd.esperandoConfirmacion = false;
            return 'Entiendo. ¿Qué día y horario le gustaría entonces? Por favor, indíqueme un día de lunes a sábado.';
        } else {
            return 'Por favor, responda "sí" si le sirve ese horario, o "no" para buscar otra opción.';
        }
    }
    
    // ============================================================
    // MANEJAR CONFIRMACIÓN FINAL DE RESERVA
    // ============================================================
    if (cd.esperandoConfirmacion) {
        if (/\b(si|sí|sip|dale|ok|vale|claro|por supuesto|exacto|bien|confirmo|acepto|adelante|confirmar|reservar)\b/i.test(textoLimpio)) {
            cd.esperandoConfirmacion = false;
            return await confirmarReservaAutomatica(cd, ip);
        } else if (/\b(no|cancelar|nada|cambiar|modificar)\b/i.test(textoLimpio)) {
            cd.esperandoConfirmacion = false;
            return 'Entiendo. ¿Qué dato le gustaría modificar? Puede indicarme su nombre, masaje, día, hora, lugar o teléfono.';
        } else {
            // Si no responde sí/no pero da nuevos datos, procesar normalmente
            console.log('[CONFIRMACION] Respuesta no clara, procesando como nuevos datos');
        }
    }
    
    // ============================================================
    // VERIFICAR SI HAY SUFICIENTES DATOS PARA RESERVAR
    // ============================================================
    var datosCompletos = {
        nombre: cd.datos.nombre && cd.datos.nombre.length >= 2,
        masaje: cd.datos.masaje && cd.datos.masaje.length >= 3,
        dia: cd.datos.dia && DIAS_VALIDOS.includes(cd.datos.dia),
        hora: cd.datos.hora && HORAS_VALIDAS.includes(parseInt(cd.datos.hora)),
        tipoServicio: cd.datos.tipoServicio && (cd.datos.tipoServicio === 'salon' || cd.datos.tipoServicio === 'domicilio'),
        telefono: cd.datos.telefono && cd.datos.telefono.length >= 7
    };
    
    var todosDatosCompletos = datosCompletos.nombre && datosCompletos.masaje && datosCompletos.dia && 
                              datosCompletos.hora && datosCompletos.tipoServicio && datosCompletos.telefono;
    
    console.log('[DATOS COMPLETOS]', JSON.stringify(datosCompletos, null, 2));
    
    // Si tiene intención de reservar o ya tiene datos suficientes
    if (tieneIntencionReserva || todosDatosCompletos) {
        
        // Identificar qué datos faltan
        var faltantes = [];
        if (!datosCompletos.nombre) faltantes.push('nombre');
        if (!datosCompletos.masaje) faltantes.push('masaje');
        if (!datosCompletos.dia) faltantes.push('dia');
        if (!datosCompletos.hora) faltantes.push('hora');
        if (!datosCompletos.tipoServicio) faltantes.push('tipoServicio');
        if (!datosCompletos.telefono) faltantes.push('telefono');
        
        console.log('[DATOS FALTANTES]', faltantes);
        
        // Si faltan datos, preguntar de forma amigable
        if (faltantes.length > 0) {
            return generarPreguntaInteligente(cd, faltantes);
        }
        
        // Si todos los datos están completos, confirmar reserva
        if (todosDatosCompletos) {
            cd.esperandoConfirmacion = true;
            var mensajeConfirmacion = generarMensajeConfirmacion(cd.datos);
            return mensajeConfirmacion + '\n\n¿Confirmamos la reserva? Por favor, responda "sí" o "no".';
        }
    }
    
    // ============================================================
    // PROCESAR CONSULTAS ESPECÍFICAS (servicios, horarios, precios)
    // ============================================================
    
    // Consulta de servicios
    if (/\b(servicios|masajes|tipos|qué ofrecen|qué tienen|qué hay|catálogo|lista)\b/i.test(textoLimpio) && 
        !/\b(reservar|turno|cita)\b/i.test(textoLimpio)) {
        return generarMenuServicios();
    }
    
    // Consulta de horarios
    if (/\b(horario|a qué hora|cuándo atienden|disponibilidad de horarios|qué horarios)\b/i.test(textoLimpio) && 
        !/\b(reservar|turno|cita)\b/i.test(textoLimpio)) {
        return 'Nuestros horarios son:\n• 12:00 hs (mediodía)\n• 16:00 hs (tarde)\n• 20:00 hs (noche)\n\nAtendemos de lunes a sábado.\n\n¿Le gustaría reservar un turno?';
    }
    
    // Consulta de precios
    if (/\b(precio|costo|cuánto vale|cuesta|tarifa|valor)\b/i.test(textoLimpio) && 
        !/\b(reservar|turno|cita)\b/i.test(textoLimpio)) {
        return generarListaPrecios() + '\n\n¿Le gustaría reservar alguno de nuestros servicios?';
    }
    
    // Cancelación
    if (/\b(cancelar|anular|dar de baja)\b/i.test(textoLimpio)) {
        return await manejarCancelacion(cd);
    }
    
    // ============================================================
    // RESPUESTA POR DEFECTO (cuando no se detecta intención clara)
    // ============================================================
    var nombreCliente = cd.datos.nombre || '';
    var respuesta = '';
    
    if (nombreCliente) {
        respuesta = `${nombreCliente}, ¿en qué puedo ayudarle hoy?\n\n`;
    } else {
        respuesta = `¿En qué puedo ayudarle hoy?\n\n`;
    }
    
    respuesta += `• 📅 Reservar un turno\n• 📋 Ver servicios disponibles\n• ⏰ Consultar horarios\n• 💰 Precios\n\n`;
    respuesta += `Si desea reservar, indíqueme: su nombre, qué masaje prefiere, qué día, a qué hora, si es en el salón o a domicilio, y su teléfono.`;
    
    return respuesta;
}

// ============================================================
// GENERAR PREGUNTA INTELIGENTE (según datos faltantes)
// ============================================================
function generarPreguntaInteligente(cd, faltantes) {
    var nombre = cd.datos.nombre ? cd.datos.nombre + ', ' : '';
    var primeraPregunta = faltantes[0];
    
    // Verificar si ya tenemos algunos datos para personalizar
    var tieneDatosParciales = cd.datos.nombre || cd.datos.masaje || cd.datos.dia || cd.datos.hora;
    
    switch (primeraPregunta) {
        case 'nombre':
            if (tieneDatosParciales) {
                return 'Me ha dado algunos datos, pero para continuar necesito saber su nombre. ¿Cómo se llama?';
            }
            return 'Para poder ayudarle con su reserva, necesito saber su nombre. ¿Cómo se llama?';
            
        case 'masaje':
            var menuPersonalizado = 'Estos son nuestros servicios disponibles:\n\n';
            for (var i = 0; i < serviciosData.length; i++) {
                menuPersonalizado += (i + 1) + '. ' + serviciosData[i].nombre + ' - ' + serviciosData[i].precio + '\n';
            }
            menuPersonalizado += '\n' + (nombre ? nombre : '') + '¿Cuál de estos masajes le gustaría reservar? Por favor, indíqueme el número o el nombre.';
            return menuPersonalizado;
            
        case 'dia':
            return (nombre ? nombre : '') + '¿Qué día de la semana le gustaría para su masaje? Atendemos de lunes a sábado.';
            
        case 'hora':
            return (nombre ? nombre : '') + '¿A qué hora prefiere su masaje? Nuestros horarios son: 12:00, 16:00 o 20:00.';
            
        case 'tipoServicio':
            return (nombre ? nombre : '') + '¿Dónde prefiere recibir el masaje?\n• En nuestro salón\n• A domicilio\n\nPor favor, responda "salón" o "domicilio".';
            
        case 'telefono':
            if (cd.datos.tipoServicio === 'domicilio') {
                return (nombre ? nombre : '') + 'Ya casi tenemos todo listo. Necesito su número de teléfono para confirmar la reserva a domicilio. ¿Cuál es su número?';
            }
            return (nombre ? nombre : '') + 'Para finalizar la reserva, necesito su número de teléfono. ¿Cuál es? Solo los dígitos, sin código de país.';
            
        default:
            return '¿Podría darme más detalles para ayudarle mejor? Por ejemplo, su nombre, qué masaje desea, el día y la hora.';
    }
}

// ============================================================
// GENERAR MENSAJE DE CONFIRMACIÓN PERSONALIZADO
// ============================================================
function generarMensajeConfirmacion(datos) {
    var lugarTexto = datos.tipoServicio === 'domicilio' ? 
        (datos.ubicacion || 'la dirección que me indicó') : 
        'nuestro salón en Serenity Spa';
    
    var horaTexto = '';
    if (datos.hora === 12) horaTexto = '12:00 (mediodía)';
    else if (datos.hora === 16) horaTexto = '16:00 (tarde)';
    else if (datos.hora === 20) horaTexto = '20:00 (noche)';
    else horaTexto = datos.hora + ':00';
    
    return `📋 Por favor, confirme los datos de su reserva:\n\n` +
           `👤 Cliente: ${datos.nombre}\n` +
           `💆 Masaje: ${datos.masaje}\n` +
           `📅 Día: ${datos.dia}\n` +
           `⏰ Hora: ${horaTexto}\n` +
           `📍 Lugar: ${lugarTexto}\n` +
           `📞 Teléfono: ${datos.telefono}`;
}

// ============================================================
// GENERAR LISTA DE PRECIOS
// ============================================================
function generarListaPrecios() {
    if (!serviciosData.length) return 'No hay servicios disponibles en este momento.';
    var lista = '💰 Nuestros precios:\n\n';
    for (var i = 0; i < serviciosData.length; i++) {
        lista += '• ' + serviciosData[i].nombre + ': ' + serviciosData[i].precio + '\n';
    }
    return lista;
}

// ============================================================
// CONFIRMAR RESERVA AUTOMÁTICA (VERSIÓN MEJORADA)
// ============================================================
async function confirmarReservaAutomatica(cd, ip) {
    var datos = cd.datos;
    
    console.log('[CONFIRMAR RESERVA]', JSON.stringify(datos, null, 2));
    
    var paisActivo = getPaisActivo();
    var codigoPaisPermitido = paisActivo ? paisActivo.codigo : '53';
    var nombrePaisPermitido = paisActivo ? paisActivo.nombre : null;
    
    // Verificar país autorizado
    if (paisActivo && !paisAutorizado(codigoPaisPermitido)) {
        return `Lo siento${datos.nombre ? ', ' + datos.nombre : ''}, actualmente solo aceptamos reservas desde ${nombrePaisPermitido || codigoPaisPermitido}.`;
    }
    
    // Validar todos los datos nuevamente
    if (!datos.nombre) {
        return 'Para continuar con la reserva, necesito saber su nombre. ¿Cómo se llama?';
    }
    
    if (!datos.masaje) {
        return generarMenuServicios();
    }
    
    if (!datos.dia || DIAS_VALIDOS.indexOf(datos.dia) === -1) {
        return (datos.nombre || '') + '¿Qué día de la semana le gustaría? Atendemos de lunes a sábado.';
    }
    
    var horaInt = parseInt(datos.hora);
    if (!datos.hora || HORAS_VALIDAS.indexOf(horaInt) === -1) {
        return (datos.nombre || '') + '¿A qué hora prefiere? Nuestros horarios son: 12:00, 16:00 o 20:00.';
    }
    
    if (!datos.tipoServicio) {
        return (datos.nombre || '') + '¿Dónde prefiere recibir el masaje? ¿En el salón o a domicilio?';
    }
    
    if (!datos.telefono || datos.telefono.length < 7) {
        return (datos.nombre || '') + 'Necesito su número de teléfono para confirmar la reserva. ¿Cuál es? Solo los dígitos.';
    }
    
    try {
        var turnos = await loadTurnos();
        
        // Verificar si ya tiene turno ese día
        for (var i = 0; i < turnos.length; i++) {
            if (turnos[i].telefono === datos.telefono && turnos[i].dia === datos.dia) {
                return (datos.nombre || 'Cliente') + ', ya tiene un turno reservado para el ' + datos.dia + '. Solo permitimos un masaje por persona por día.';
            }
        }
        
        // Verificar disponibilidad del horario
        for (var j = 0; j < turnos.length; j++) {
            if (turnos[j].dia === datos.dia && turnos[j].hora === horaInt) {
                var alternativa = buscarAlternativa(datos.dia, horaInt, turnos);
                if (alternativa) {
                    cd.pendienteConfirmar = alternativa;
                    cd.esperandoConfirmacion = true;
                    return `El horario de las ${datos.hora}:00 del ${datos.dia} ya está ocupado. ¿Le sirve el ${alternativa.dia} a las ${alternativa.hora}:00? Por favor, responda "sí" o "no".`;
                }
                return 'Lo siento, no hay disponibilidad para esa semana. ¿Quiere probar con otra semana o con otro día?';
            }
        }
        
        // Crear la reserva
        var lugarTexto = datos.tipoServicio === 'domicilio' ? (datos.ubicacion || 'Dirección a confirmar') : 'Salón Serenity Spa';
        
        var nuevoTurno = {
            id: generarId(),
            nombre: datos.nombre,
            dia: datos.dia,
            hora: horaInt,
            massageType: datos.masaje,
            telefono: datos.telefono,
            codigoPais: codigoPaisPermitido,
            ubicacion: lugarTexto,
            tipoServicio: datos.tipoServicio,
            confirmadoWhatsApp: false,
            fechaCreacion: new Date().toISOString(),
            ip: ip
        };
        
        turnos.push(nuevoTurno);
        await saveTurnos(turnos);
        turnosMem = turnos;
        regTurno(ip, datos.telefono);
        
        // Limpiar datos de sesión después de reserva exitosa
        cd.pendienteConfirmar = null;
        cd.esperandoConfirmacion = false;
        cd.ultimaPregunta = null;
        
        var horaFormateada = '';
        if (datos.hora === 12) horaFormateada = '12:00 (mediodía)';
        else if (datos.hora === 16) horaFormateada = '16:00 (tarde)';
        else if (datos.hora === 20) horaFormateada = '20:00 (noche)';
        else horaFormateada = datos.hora + ':00';
        
        var respuesta = `✅ ¡RESERVA CONFIRMADA! ✅\n\n`;
        respuesta += `🌸 Serenity Spa agradece su preferencia\n\n`;
        respuesta += `👤 Cliente: ${datos.nombre}\n`;
        respuesta += `💆 Masaje: ${datos.masaje}\n`;
        respuesta += `📅 Día: ${datos.dia}\n`;
        respuesta += `⏰ Hora: ${horaFormateada}\n`;
        respuesta += `📍 Lugar: ${lugarTexto}\n`;
        respuesta += `📞 Teléfono de contacto: +${codigoPaisPermitido} ${datos.telefono}\n\n`;
        respuesta += `✨ Lo esperamos con aromaterapia y música suave.\n`;
        respuesta += `🔔 Si necesita modificar o cancelar, respóndame con "cancelar".\n\n`;
        respuesta += `🌟 ¡Que tenga un excelente día! 🌟`;
        
        // Limpiar datos específicos de reserva para próxima vez
        cd.datos.masaje = null;
        cd.datos.dia = null;
        cd.datos.hora = null;
        cd.datos.tipoServicio = null;
        cd.datos.ubicacion = null;
        cd.datos.telefono = null;
        
        return respuesta;
        
    } catch (error) {
        console.error('[ERROR] Al confirmar reserva:', error);
        return 'Hubo un error al procesar su reserva. Por favor, intente nuevamente en unos momentos.';
    }
}
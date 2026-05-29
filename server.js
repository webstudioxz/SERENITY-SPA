const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// Configuración de Supabase
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://tusuperproyecto.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'tu-service-key-aqui';
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// Configuración de multer (usando memory storage para procesar archivos)
const upload = multer({ 
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 }, // 5MB máximo
    fileFilter: (req, file, cb) => {
        const allowedTypes = /jpeg|jpg|png|webp|gif/;
        const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
        const mimetype = allowedTypes.test(file.mimetype);
        if (mimetype && extname) {
            return cb(null, true);
        } else {
            cb(new Error('Solo se permiten imágenes'));
        }
    }
});

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static('public'));

// Almacenamiento en memoria (para desarrollo)
let servicios = [];
let turnos = [];
let configuracion = {
    hero: {
        titulo: 'Renueva tu Energía',
        subtitulo: 'Experiencias de bienestar que transforman tu día',
        imagenFondo: '',
        botonTexto: 'Explorar Tratamientos'
    },
    serviciosSection: {
        etiqueta: 'Nuestros Servicios',
        titulo: 'Elige tu Masaje Ideal',
        descripcion: 'Descubrí tratamientos personalizados para tu bienestar'
    },
    contactoSection: {
        titulo: '¿Tienes dudas?',
        descripcion: 'Nuestro equipo está listo para ayudarte',
        whatsappUrl: ''
    },
    shareSection: {
        titulo: 'Comparte Serenity Spa'
    }
};

let nextId = 1;
let nextTurnoId = 1;

// ============ MIDDLEWARE DE AUTENTICACIÓN ============
const validarToken = (req, res, next) => {
    const token = req.headers.authorization?.split(' ')[1];
    
    // Token demo (en producción deberías verificar con Supabase Auth)
    const DEMO_TOKEN = 'admin-token-secreto-2024';
    
    if (!token || token !== DEMO_TOKEN) {
        return res.status(401).json({ error: 'No autorizado' });
    }
    next();
};

// ============ FUNCIÓN PARA SUBIR IMAGEN A SUPABASE ============
async function subirImagenSupabase(file, carpeta) {
    try {
        // Generar nombre único para la imagen
        const extension = path.extname(file.originalname);
        const nombreArchivo = `${Date.now()}-${Math.random().toString(36).substring(7)}${extension}`;
        const ruta = `${carpeta}/${nombreArchivo}`;
        
        // Subir a Supabase Storage
        const { data, error } = await supabase.storage
            .from('imagenes-spa')
            .upload(ruta, file.buffer, {
                contentType: file.mimetype,
                cacheControl: '3600'
            });
        
        if (error) {
            console.error('Error al subir a Supabase:', error);
            throw new Error('Error al subir la imagen');
        }
        
        // Obtener URL pública
        const { data: urlData } = supabase.storage
            .from('imagenes-spa')
            .getPublicUrl(ruta);
        
        return urlData.publicUrl;
    } catch (error) {
        console.error('Error en subirImagenSupabase:', error);
        throw error;
    }
}

// ============ ENDPOINTS DE CONFIGURACIÓN ============
app.get('/api/config', (req, res) => {
    res.json(configuracion);
});

app.put('/api/config', validarToken, (req, res) => {
    configuracion = { ...configuracion, ...req.body };
    res.json({ message: 'Configuración actualizada', configuracion });
});

// ============ ENDPOINTS DE SERVICIOS ============
app.get('/api/servicios', (req, res) => {
    res.json(servicios);
});

app.post('/api/servicios', validarToken, async (req, res) => {
    try {
        const { nombre, precio, descripcion, beneficios, efectos, imagen, whatsappImage } = req.body;
        
        const nuevoServicio = {
            id: String(nextId++),
            nombre,
            precio,
            descripcion,
            beneficios: beneficios || [],
            efectos: efectos || [],
            imagen: imagen || '',
            whatsappImage: whatsappImage || null,
            createdAt: new Date().toISOString()
        };
        
        servicios.push(nuevoServicio);
        res.status(201).json(nuevoServicio);
    } catch (error) {
        console.error('Error al crear servicio:', error);
        res.status(500).json({ error: 'Error al crear el servicio' });
    }
});

app.put('/api/servicios/:id', validarToken, async (req, res) => {
    try {
        const { id } = req.params;
        const index = servicios.findIndex(s => s.id === id);
        
        if (index === -1) {
            return res.status(404).json({ error: 'Servicio no encontrado' });
        }
        
        servicios[index] = { ...servicios[index], ...req.body, updatedAt: new Date().toISOString() };
        res.json(servicios[index]);
    } catch (error) {
        console.error('Error al actualizar servicio:', error);
        res.status(500).json({ error: 'Error al actualizar el servicio' });
    }
});

app.delete('/api/servicios/:id', validarToken, (req, res) => {
    const { id } = req.params;
    servicios = servicios.filter(s => s.id !== id);
    res.json({ message: 'Servicio eliminado' });
});

// ============ ENDPOINT PARA SUBIR IMÁGENES ============
app.post('/api/upload', validarToken, upload.single('imagen'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No se recibió ninguna imagen' });
        }
        
        const tipo = req.body.tipo || 'servicios';
        const carpeta = `admin/${tipo}`;
        
        const urlPublica = await subirImagenSupabase(req.file, carpeta);
        
        res.json({ 
            success: true, 
            url: urlPublica,
            message: 'Imagen subida correctamente'
        });
    } catch (error) {
        console.error('Error en upload:', error);
        res.status(500).json({ error: 'Error al subir la imagen: ' + error.message });
    }
});

// ============ ENDPOINTS DE TURNOS ============
app.get('/turnos', validarToken, (req, res) => {
    res.json(turnos);
});

app.post('/turnos', (req, res) => {
    const nuevoTurno = {
        id: String(nextTurnoId++),
        ...req.body,
        createdAt: new Date().toISOString()
    };
    turnos.push(nuevoTurno);
    res.status(201).json(nuevoTurno);
});

app.delete('/turnos/:index', validarToken, (req, res) => {
    const index = parseInt(req.params.index);
    if (index >= 0 && index < turnos.length) {
        turnos.splice(index, 1);
        res.json({ message: 'Turno eliminado' });
    } else {
        res.status(404).json({ error: 'Turno no encontrado' });
    }
});

// ============ ENDPOINT DE LOGIN ============
app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    
    // Credenciales demo (en producción usar Supabase Auth)
    if (username === 'admin' && password === 'admin123') {
        res.json({ 
            success: true, 
            token: 'admin-token-secreto-2024',
            message: 'Login exitoso'
        });
    } else {
        res.status(401).json({ 
            success: false, 
            error: 'Credenciales inválidas' 
        });
    }
});

// ============ INICIAR SERVIDOR ============
app.listen(PORT, () => {
    console.log(`Servidor corriendo en http://localhost:${PORT}`);
});
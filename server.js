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
const UPLOADS_DIR = path.join(__dirname, 'uploads');

// Asegurar que exista la carpeta de uploads
if (!fsSync.existsSync(UPLOADS_DIR)) fsSync.mkdirSync(UPLOADS_DIR, { recursive: true });

// Inicialización de OpenAI (si tienes la key)
const deepseek = new OpenAI({ baseURL: 'https://api.deepseek.com/v1', apiKey: process.env.DEEPSEEK_API_KEY || '' });

app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// Servir archivos estáticos y uploads
app.use('/uploads', express.static(UPLOADS_DIR));

// Datos iniciales por defecto si faltan archivos
let turnosMem = [];
let serviciosData = [];
let configData = {};

const HORAS_VALIDAS = [12, 16, 20];
const DIAS_VALIDOS = ['lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado'];
const DIAS_NOMBRE = { 
    'lunes':'Lunes', 'martes':'Martes', 'miercoles':'Miércoles', 
    'jueves':'Jueves', 'viernes':'Viernes', 'sabado':'Sábado' 
};
const HORA_TEXTO = { 
    12:'12 del mediodía', 16:'4 de la tarde', 20:'8 de la noche' 
};

// ============================================================
// LÓGICA DE SEGURIDAD Y BLOQUEOS
// ============================================================
var bloqueos = new Map(), historialBloqueos = [], intentosFallidos = new Map();
var turnosRecientesIP = new Map(), turnosRecientesTel = new Map();

async function cargarBloqueos() {
    try {
        if (fsSync.existsSync(BLOQUEOS_FILE)) {
            var d = JSON.parse(await fs.readFile(BLOQUEOS_FILE, 'utf8'));
            bloqueos = new Map(Object.entries(d.bloqueos || {}));
            historialBloqueos = d.historial || [];
            var ahora = Date.now();
            for (var e of bloqueos) { 
                if (ahora > e[1].hasta) bloqueos.delete(e[0]); 
            }
            await guardarBloqueos();
        }
    } catch (e) { 
        await fs.writeFile(BLOQUEOS_FILE, JSON.stringify({ bloqueos: {}, historial: [] }, null, 2), 'utf8'); 
    }
}

async function guardarBloqueos() { 
    try { 
        await fs.writeFile(BLOQUEOS_FILE, JSON.stringify({ 
            bloqueos: Object.fromEntries(bloqueos), 
            historial: historialBloqueos.slice(0, 500) 
        }, null, 2), 'utf8'); 
    } catch(e) {} 
}

function estaBloqueado(ip) { 
    if (bloqueos.has(ip)) { 
        if (Date.now() < bloqueos.get(ip).hasta) return true; 
        bloqueos.delete(ip); 
        guardarBloqueos(); 
    } 
    return false; 
}

function bloquearIP(ip, motivo, tipo) {
    bloqueos.set(ip, { 
        hasta: Date.now()+3600000, // 1 hora
        motivo: motivo, 
        tipoAtaque: tipo||'?', 
        fecha: new Date().toISOString(), 
        ip:ip, 
        intentos: (intentosFallidos.get(ip)||{}).count||0, 
        permanente: false 
    });
    historialBloqueos.unshift(Object.assign({}, bloqueos.get(ip), { id: generarId() }));
    guardarBloqueos();
}

function desbloquearIP(ip) { 
    bloqueos.delete(ip); 
    intentosFallidos.delete(ip); 
    guardarBloqueos(); 
}

function limpiarViejos(m, v) { 
    var a = Date.now(); 
    for (var e of m) { 
        m.set(e[0], e[1].filter(function(t) { return a - t < v; })); 
        if (!m.get(e[0]).length) m.delete(e[0]); 
    } 
}

function registrarIntento(ip, tipo) {
    var a = Date.now();
    if (!intentosFallidos.has(ip)) { 
        intentosFallidos.set(ip, { count: 1, first: a }); 
        return false; 
    }
    var d = intentosFallidos.get(ip);
    if (a - d.first > 600000) { // 10 minutos
        intentosFallidos.set(ip, { count: 1, first: a }); 
        return false; 
    }
    d.count++;
    if (d.count >= 5) { 
        bloquearIP(ip, '5+ intentos: ' + tipo, tipo); 
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
    var a = Date.now(); 
    if (!turnosRecientesIP.has(ip)) turnosRecientesIP.set(ip, []); 
    turnosRecientesIP.get(ip).push(a); 
    
    if (!turnosRecientesTel.has(tel)) turnosRecientesTel.set(tel, []); 
    turnosRecientesTel.get(tel).push(a); 
}

// ============================================================
// CONFIGURACIÓN DE PAÍSES
// ============================================================
var paisesConfig = { autorizados: [], bloqueados: [], modo: 'todos' };

var PAISES_DATOS = [
    { nombre:'Argentina', codigo:'54', claves:['argentina','argentino'] },
    { nombre:'México', codigo:'52', claves:['méxico','mexico','mexicano'] },
    { nombre:'Colombia', codigo:'57', claves:['colombia','colombiano'] },
    { nombre:'Chile', codigo:'56', claves:['chile','chileno'] },
    { nombre:'Perú', codigo:'51', claves:['perú','peru','peruano'] },
    { nombre:'España', codigo:'34', claves:['españa','español'] },
    { nombre:'Cuba', codigo:'53', claves:['cuba','cubano'] },
    { nombre:'Uruguay', codigo:'598', claves:['uruguay','uruguayo'] },
    { nombre:'Paraguay', codigo:'595', claves:['paraguay','paraguayo'] },
    { nombre:'Bolivia', codigo:'591', claves:['bolivia','boliviano'] },
    { nombre:'Venezuela', codigo:'58', claves:['venezuela','venezolano'] },
    { nombre:'Ecuador', codigo:'593', claves:['ecuador','ecuatoriano'] },
    { nombre:'Costa Rica', codigo:'506', claves:['costa rica'] },
    { nombre:'Panamá', codigo:'507', claves:['panamá','panama'] },
    { nombre:'Estados Unidos', codigo:'1', claves:['estados unidos','usa','eeuu'] },
    { nombre:'Brasil', codigo:'55', claves:['brasil','brasileño'] },
];

async function cargarPaises() {
    try { 
        if (fsSync.existsSync(PAISES_FILE)) paisesConfig = JSON.parse(await fs.readFile(PAISES_FILE, 'utf8')); 
        else await guardarPaises(); 
    }
    catch(e) { await guardarPaises(); }
}

async function guardarPaises() { 
    await fs.writeFile(PAISES_FILE, JSON.stringify(paisesConfig, null, 2), 'utf8'); 
}

function paisAutorizado(c) {
    if (paisesConfig.modo === 'todos') return !paisesConfig.bloqueados.includes(c);
    return paisesConfig.autorizados.includes(c);
}

function getPaisActivo() {
    if (paisesConfig.modo !== 'solo_autorizados' || paisesConfig.autorizados.length === 0) return null;
    var codigo = paisesConfig.autorizados[0];
    if (!codigo) return null;
    var pais = PAISES_DATOS.find(function(p) { return p.codigo === codigo; });
    return pais ? { codigo: codigo, nombre: pais.nombre } : null;
}

function detectarPais(texto) {
    var t = texto.toLowerCase().trim();
    for (var i = 0; i < PAISES_DATOS.length; i++) {
        for (var j = 0; j < PAISES_DATOS[i].claves.length; j++) {
            if (t.indexOf(PAISES_DATOS[i].claves[j]) !== -1) { 
                return { nombre: PAISES_DATOS[i].nombre, codigo: PAISES_DATOS[i].codigo }; 
            }
        }
    }
    return null;
}

// ============================================================
// UTILIDADES
// ============================================================
function esUrlValida(s) {
    if (!s || typeof s !== 'string') return false;
    var t = s.trim();
    if (t.indexOf('data:') === 0 || t.length > 3000) return false;
    try { var u = new URL(t); return u.protocol === 'http:' || u.protocol === 'https:'; } catch(e) { return false; }
}

function escapeHtml(s) { return s ? s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;') : ''; }

function sanitize(s) { return s ? s.trim().replace(/[^\w\sáéíóúñÑü.,@\-]/gi, '') : ''; }

function generarId() { return Date.now().toString(36)+Math.random().toString(36).substr(2)+crypto.randomBytes(4).toString('hex'); }

// ============================================================
// EXTRAER TELÉFONO (Mejorado)
// ============================================================
function extraerTelefono(texto, codigoPaisAdmin) {
    // Patrón explícito
    var exp = texto.match(/(?:tel[eé]fono|n[uú]mero|celular|cel|m[oó]vil|whatsapp)\s*[:.]?\s*([\d\s\-]{7,20})/i);
    if (exp) {
        var n = exp[1].replace(/\D/g, '');
        if (codigoPaisAdmin && n.indexOf(codigoPaisAdmin) === 0 && n.length > codigoPaisAdmin.length + 5) {
            n = n.substring(codigoPaisAdmin.length);
        }
        if (n.length >= 7) return n;
    }

    // Limpiar
    var limpio = texto
        .replace(/\$?\d{1,4}\s*(pesos|dlls|usd|eur|cop|mxn|ars|cup|usd)/gi, ' ')
        .replace(/\b\d{1,2}:\d{2}\b/g, ' ');

    // Buscar secuencia
    var trailing = limpio.trim().match(/([\d]{7,15})\s*$/);
    if (trailing) {
        var n = trailing[1];
        if (codigoPaisAdmin && n.indexOf(codigoPaisAdmin) === 0 && n.length > codigoPaisAdmin.length + 5) {
            n = n.substring(codigoPaisAdmin.length);
        }
        if (n.length >= 7) return n;
    }

    var allNums = limpio.match(/([\d]{7,15})/g);
    if (allNums && allNums.length > 0) {
        var best = null;
        for (var i = 0; i < allNums.length; i++) {
            var n = allNums[i];
            if (codigoPaisAdmin && n.indexOf(codigoPaisAdmin) === 0 && n.length > codigoPaisAdmin.length + 5) {
                n = n.substring(codigoPaisAdmin.length);
            }
            if (n.length >= 7) { best = n; break; }
        }
        if (best) return best;
    }

    return null;
}

// ============================================================
// MIDDLEWARES SEGURIDAD
// ============================================================
app.use(function(req, res, next) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-options', 'DENY');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    next();
});

app.use(function(req, res, next) {
    var ip = req.ip || req.connection.remoteAddress || '0.0.0.0';
    // Ajuste para proxies tipo Render/Heroku
    if (req.headers['x-forwarded-for']) {
        ip = req.headers['x-forwarded-for'].split(',')[0].trim();
    }
    
    if (estaBloqueado(ip)) return res.status(403).json({ error: 'Bloqueada' });
    next();
});

// Rutas estáticas
app.get('/', function(req, res){ res.sendFile(path.join(__dirname,'index.html')); });
app.get('/admin.html', function(req, res){ res.sendFile(path.join(__dirname,'admin.html')); });
app.get('/login.html', function(req, res){ res.sendFile(path.join(__dirname,'login.html')); });

// ============================================================
// API DE CONFIGURACIÓN
// ============================================================
var validTokens = new Map();

function checkAuth(req) {
    var h = req.headers.authorization;
    if (!h || h.indexOf('Bearer ') !== 0) return false;
    var t = h.substring(7);
    if (!validTokens.has(t)) return false;
    if (validTokens.get(t) < Date.now()) { validTokens.delete(t); return false; }
    return true;
}

app.get('/api/config', function(req, res) { 
    // Cargar desde archivo para asegurar frescura
    try {
        if(fsSync.existsSync(CONFIG_FILE)) {
            const data = JSON.parse(fsSync.readFileSync(CONFIG_FILE, 'utf8'));
            return res.json(data);
        }
    } catch(e){}
    res.json(configData); 
});

app.put('/api/config', async function(req, res) {
    if (!checkAuth(req)) return res.status(401).json({ error:'No autorizado' });
    try {
        // Merge con los datos existentes
        if(!configData) configData = {};
        const newData = req.body;
        
        // Guardar campos específicos
        if(newData.hero) configData.hero = newData.hero;
        if(newData.contactoSection) configData.contactoSection = newData.contactoSection;
        if(newData.serviciosSection) configData.serviciosSection = newData.serviciosSection;
        if(newData.shareSection) configData.shareSection = newData.shareSection;
        
        // Nuevos campos para IA
        if(newData.activeCountry !== undefined) configData.activeCountry = newData.activeCountry;
        if(newData.voiceMode !== undefined) configData.voiceMode = newData.voiceMode;

        await fs.writeFile(CONFIG_FILE, JSON.stringify(configData, null, 2), 'utf8');
        res.json({ ok:true });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'Error al guardar' });
    }
});

// ============================================================
// API DE SERVICIOS
// ============================================================
app.get('/api/servicios', function(req, res) { 
    res.json(serviciosData.sort(function(a,b){return(a.orden||999)-(b.orden||999);})); 
});

app.post('/api/servicios', async function(req, res) {
    if (!checkAuth(req)) return res.status(401).json({ error:'No autorizado' });
    try {
        var s = Object.assign({ 
            id:generarId(), 
            orden: 999 
        }, req.body, {
            imagenWeb: req.body.imagenWeb || 'https://images.unsplash.com/photo-1544161515-4ab6ce6db874?w=800',
            imagenWhatsApp: req.body.imagenWhatsApp || ''
        });
        serviciosData.push(s);
        await fs.writeFile(SERVICIOS_FILE, JSON.stringify(serviciosData, null, 2), 'utf8');
        res.status(201).json(s);
    } catch(e) { res.status(500).json({ error:'Error' }); }
});

app.put('/api/servicios/:id', async function(req, res) {
    if (!checkAuth(req)) return res.status(401).json({ error:'No autorizado' });
    try {
        var idx=-1;
        for(var i=0;i<serviciosData.length;i++){
            if(serviciosData[i].id===req.params.id){idx=i;break;}
        }
        if(idx===-1) return res.status(404).json({error:'No encontrado'});
        
        serviciosData[idx]=Object.assign({},serviciosData[idx],req.body,{id:req.params.id});
        await fs.writeFile(SERVICIOS_FILE,JSON.stringify(serviciosData,null,2),'utf8');
        res.json({ok:true});
    } catch(e){res.status(500).json({error:'Error'});}
});

app.delete('/api/servicios/:id', async function(req,res){
    if(!checkAuth(req))return res.status(401).json({error:'No autorizado'});
    var initialLen = serviciosData.length;
    serviciosData=serviciosData.filter(function(s){return s.id!==req.params.id;});
    if(serviciosData.length < initialLen) {
        await fs.writeFile(SERVICIOS_FILE,JSON.stringify(serviciosData,null,2),'utf8');
        res.json({ok:true,eliminado:true});
    } else {
        res.status(404).json({error:'No encontrado'});
    }
});

// ============================================================
// API DE TURNOS
// ============================================================
app.get('/turnos', async function(req,res){
    try {
        if(fsSync.existsSync(TURNOS_FILE)) {
            turnosMem = JSON.parse(await fs.readFile(TURNOS_FILE, 'utf8'));
        }
    } catch(e){}
    res.json(turnosMem);
});

app.post('/turnos',async function(req,res){
    var ip = req.ip || '0.0.0.0';
    // Ajuste IP Proxy
    if (req.headers['x-forwarded-for']) ip = req.headers['x-forwarded-for'].split(',')[0].trim();

    if(estaBloqueado(ip))return res.status(403).json({error:'Bloqueada'});
    if(!checkRateIP(ip)){
        bloquearIP(ip,'Spam turnos','spam'); 
        return res.status(429).json({error:'Demasiadas solicitudes'});
    }
    try{
        var nombre=req.body.nombre, dia=req.body.dia, hora=req.body.hora, 
            mt=req.body.massageType, tel=req.body.telefono, ub=req.body.ubicacion, 
            ts=req.body.tipoServicio;
        
        if(!nombre||nombre.length<2)return res.status(400).json({error:'Nombre inválido'});
        var tel=(tel||'').replace(/\D/g,'');
        if(!tel||tel.length<7)return res.status(400).json({error:'Teléfono inválido'});
        
        var cp=req.body.codigoPais||'53';
        if(!/^\d{1,3}$/.test(cp))cp='53';
        
        if(!paisAutorizado(cp))return res.status(403).json({error:'País no autorizado'});
        
        if(DIAS_VALIDOS.indexOf((dia||'').toLowerCase())===-1)return res.status(400).json({error:'Día inválido'});
        var hn=parseInt(hora);
        if(HORAS_VALIDAS.indexOf(hn)===-1)return res.status(400).json({error:'Hora inválida'});
        
        if(!checkRateTel(tel))return res.status(429).json({error:'Máximo 2 turnos por día'});
        
        // Recargar turnos actuales para verificación
        try { turnosMem = JSON.parse(await fs.readFile(TURNOS_FILE, 'utf8')); } catch(e){ turnosMem = []; }

        for(var i=0;i<turnosMem.length;i++){
            if(turnosMem[i].telefono===tel && turnosMem[i].dia===(dia||'').toLowerCase())
                return res.status(409).json({error:'Ya tiene turno ese día'});
        }
        
        for(var j=0;j<turnosMem.length;j++){
            if(turnosMem[j].dia===(dia||'').toLowerCase() && turnosMem[j].hora===hn){
                return res.status(409).json({error:'Ocupado'});
            }
        }

        var nuevo={
            id:generarId(),
            nombre:escapeHtml(sanitize(nombre)),
            dia:(dia||'').toLowerCase(),
            hora:hn,
            massageType:mt||'Masaje',
            telefono:tel,
            codigoPais:cp,
            ubicacion:ub?escapeHtml(sanitize(ub)):'Salón Serenity Spa',
            tipoServicio:ts||'salon',
            confirmadoWhatsApp:false,
            fechaCreacion:new Date().toISOString(),
            ip:ip
        };

        turnosMem.push(nuevo);
        await fs.writeFile(TURNOS_FILE,JSON.stringify(turnosMem,null,2),'utf8');
        regTurno(ip,tel);
        intentosFallidos.delete(ip);
        
        res.status(201).json({mensaje:'Reservado',turno:nuevo});
    }catch(e){ console.error(e); res.status(500).json({error:'Error'});}
});

app.delete('/turnos/:id',async function(req,res){
    if(!checkAuth(req))return res.status(401).json({error:'No autorizado'});
    try {
        // Recargar primero
        turnosMem = JSON.parse(await fs.readFile(TURNOS_FILE, 'utf8'));
        var idx=-1;
        for(var i=0;i<turnosMem.length;i++){
            if(turnosMem[i].id===req.params.id){idx=i;break;}
        }
        if(idx===-1)return res.status(404).json({error:'No encontrado'});
        
        turnosMem.splice(idx,1);
        await fs.writeFile(TURNOS_FILE,JSON.stringify(turnosMem,null,2),'utf8');
        res.json({ok:true});
    } catch(e) { res.status(500).json({error:'Error'}); }
});

app.post('/api/enviar-whatsapp/:id',async function(req,res){
    try{
        var turnos = turnosMem;
        // Recargar si está vacío
        if(!turnos.length) turnos = JSON.parse(await fs.readFile(TURNOS_FILE, 'utf8'));

        var r=null;
        for(var i=0;i<turnos.length;i++){
            if(turnos[i].id===req.params.id){r=turnos[i];break;}
        }
        if(!r)return res.status(404).json({error:'No encontrado'});
        
        var msg='SERENITY SPA\n\nHola '+r.nombre+', tu reserva:\n\nDía: '+r.dia+'\nHora: '+r.hora+':00'+'\nMasaje: '+r.massageType+'\nLugar: '+(r.tipoServicio==='domicilio'?r.ubicacion:'Salón Serenity Spa')+'\n\nEquipo Serenity Spa';
        var c=r.codigoPais||'53';
        
        // Marcar como confirmado
        for(var j=0;j<turnos.length;j++){
            if(turnos[j].id===req.params.id){
                turnos[j].confirmadoWhatsApp=true;
                turnos[j].fechaWA=new Date().toISOString();
                break;
            }
        }
        await fs.writeFile(TURNOS_FILE,JSON.stringify(turnos,null,2),'utf8');
        
        res.json({
            success:true,
            numero:c+r.telefono,
            mensaje:msg,
            urlWhatsApp:'https://wa.me/'+c+r.telefono+'?text='+encodeURIComponent(msg)
        });
    }catch(e){res.status(500).json({error:'Error'});}
});

// ============================================================
// API DE UPLOAD HERO
// ============================================================
app.post('/api/upload-hero', async function(req, res) {
    if (!checkAuth(req)) return res.status(401).json({ error: 'No autorizado' });
    try {
        var b = req.body.base64;
        if (!b || b.indexOf('data:image') !== 0) return res.status(400).json({ error: 'Imagen inválida' });
        var m = b.match(/^data:image\/(\w+);base64,(.+)$/);
        if (!m) return res.status(400).json({ error: 'Formato' });
        var ext = m[1]==='jpeg'?'jpg':m[1];
        var buf = Buffer.from(m[2],'base64');
        var fn = 'hero-'+Date.now()+'.'+ext;
        
        await fs.writeFile(path.join(UPLOADS_DIR, fn), buf);
        
        // Limpiar viejas hero images
        try {
            var files = await fs.readdir(UPLOADS_DIR);
            for (var i=0; i<files.length; i++) { 
                if(files[i].indexOf('hero-')===0 && files[i]!==fn){
                    try{await fs.unlink(path.join(UPLOADS_DIR,files[i]));}catch(e){}
                }
            }
        } catch(e){}

        res.json({ url:'/uploads/'+fn });
    } catch(e) { console.error(e); res.status(500).json({ error: 'Error' }); }
});

// ============================================================
// API AUTH
// ============================================================
app.post('/api/login', function(req, res) {
    var ip = req.ip || '0.0.0.0';
    if (req.headers['x-forwarded-for']) ip = req.headers['x-forwarded-for'].split(',')[0].trim();

    if (estaBloqueado(ip)) return res.status(403).json({ success:false });
    var pw = req.body.password;
    if (!pw) { 
        registrarIntento(ip,'Vacía'); 
        return res.status(400).json({ success:false, error:'Requerida' }); 
    }
    
    // Contraseña Hardcoded o variable de entorno
    var ADMIN_PASS = process.env.ADMIN_PASSWORD || 'admin123'; 
    
    if (pw === ADMIN_PASS) {
        var tk = crypto.randomBytes(64).toString('hex');
        validTokens.set(tk, Date.now()+28800000); // 8 horas
        intentosFallidos.delete(ip);
        res.json({ success:true, token:tk });
    } else {
        registrarIntento(ip,'Incorrecta'); 
        res.status(401).json({ success:false, error:'Incorrecta' });
    }
});

app.get('/api/verify', function(req, res) { 
    res.json({ valid: checkAuth(req) }); 
});

app.post('/api/logout', function(req, res) {
    var h = req.headers.authorization;
    if (h && h.indexOf('Bearer ') === 0) validTokens.delete(h.substring(7));
    res.json({ ok:true });
});

// ============================================================
// WEBSOCKET (VOICE ASSISTANT)
// ============================================================
var voiceClients = new Map();
var wsRatePerSec = new Map();
var voiceAttackPatterns = [
    /ignore|bypass|override|system prompt|revela|instrucciones/i,
    /<script>|javascript:|onerror=/i,
    /SELECT.*FROM|DROP TABLE|UNION SELECT/i
];

async function startServer() {
    await cargarBloqueos();
    await cargarPaises();

    // Cargar Configuración Inicial
    try { 
        configData = JSON.parse(await fs.readFile(CONFIG_FILE,'utf8')); 
    } catch(e) { 
        configData = {
            hero: {},
            contactoSection: {},
            serviciosSection: {},
            shareSection: {},
            activeCountry: 'CU',
            voiceMode: 'human'
        };
        await fs.writeFile(CONFIG_FILE, JSON.stringify(configData,null,2),'utf8'); 
    }

    // Cargar Servicios Iniciales
    try { 
        serviciosData = JSON.parse(await fs.readFile(SERVICIOS_FILE,'utf8')); 
    } catch(e) {
        serviciosData = [
            {id:"relajante",nombre:"Masaje Relajante",precio:"$45",descripcion:"Movimientos suaves para liberar estrés.",beneficios:["Reduce ansiedad","60 Minutos"],orden:1,imagenWeb:"https://images.unsplash.com/photo-1544161515-4ab6ce6db874?w=800"},
            {id:"facial",nombre:"Masaje Facial",precio:"$40",descripcion:"Rejuvenece la piel.",beneficios:["Reafirma piel","45 Minutos"],orden:2,imagenWeb:"https://images.unsplash.com/photo-157017261964-dfd03ed5d881?w=800"}
        ];
        await fs.writeFile(SERVICIOS_FILE, JSON.stringify(serviciosData,null,2),'utf8');
    }

    try { 
        turnosMem = JSON.parse(await fs.readFile(TURNOS_FILE,'utf8')); 
    } catch(e) { 
        turnosMem = []; 
        await fs.writeFile(TURNOS_FILE,'[]','utf8'); 
    }

    var server = app.listen(PORT, '0.0.0.0', function() {
        console.log('Serenity Spa Server v2.0 - Puerto ' + PORT);
        console.log('País activo: ' + (getPaisActivo() ? getPaisActivo().nombre : 'Todos'));
    });

    var wss = new WebSocket.Server({ server:server, path:'/ws-voice' });

    wss.on('connection', function(ws, req) {
        var ip = req.socket.remoteAddress || req.headers['x-forwarded-for']?.split(',')[0].trim() || '?';
        if (estaBloqueado(ip)) { ws.close(1008,'Bloqueado'); return; }

        var cid = generarId();
        voiceClients.set(cid, { datos:{}, clientId:cid });

        ws.on('message', async function(data) {
            if (data.length > 10000) { ws.close(1008); return; }

            try {
                var m = JSON.parse(data);
                if (!m || m.tipo !== 'transcripcion') return;

                var texto = m.texto;
                if (!texto || texto.length > 500) return;

                // Seguridad
                var seguro = true;
                for (var p = 0; p < voiceAttackPatterns.length; p++) {
                    if (voiceAttackPatterns[p].test(texto)) { seguro = false; break; }
                }
                if (!seguro) { 
                    registrarIntento(ip,'Sospechoso'); 
                    if(ws.readyState===1) ws.send(JSON.stringify({tipo:'respuesta',texto:'No pude procesar eso.'})); 
                    return; 
                }

                // Lógica de procesamiento de voz (Simplificada para el ejemplo)
                // Aquí deberías integrar la lógica NLP completa que tienes en tu backend original
                var respuesta = procesarComandoVozSimple(texto, cid, ip);
                
                if (respuesta && ws.readyState === 1) ws.send(JSON.stringify({ tipo:'respuesta', texto:respuesta }));
            } catch(e) {
                console.error('WS:', e.message);
            }
        });

        ws.on('close', function() { voiceClients.delete(cid); });
    });

    process.on('SIGTERM', async function() { await guardarBloqueos(); process.exit(0); });
}

// Función placeholder para la lógica de voz compleja
function procesarComandoVozSimple(texto, clientId, ip) {
    var t = texto.toLowerCase();
    
    // Verificar país configurado en Admin
    var activeCountryCode = configData.activeCountry || 'ALL';
    if (activeCountryCode !== 'ALL') {
        var pais = detectarPais(t);
        if (pais && pais.codigo !== activeCountryCode) {
            return "Lo siento, nuestro sistema solo acepta reservas para " + (getPaisActivo() ? getPaisActivo().nombre : 'este país') + ".";
        }
    }

    if (t.includes('reserv') || t.includes('turno')) return "Para reservar por favor ve a la sección de contacto.";
    if (t.includes('hora') || t.includes('abierto')) return "Estamos abiertos de Lunes a Sábado de 12:00 a 20:00.";
    return "Entiendo. Estoy procesando tu solicitud.";
}

// Iniciar
startServer();
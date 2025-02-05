/* 
  wasocket.js
  ------------
  Túnel TCP/HTTP/HTTPS a través de WhatsApp usando WhiskeySockets/Baileys.
  
  Funcionalidades:
    - Modo CLIENTE:
         • Levanta un servidor TCP local (por defecto en el puerto 9000) para recibir conexiones de aplicaciones (navegador, curl, etc.).
         • Detecta si la petición es CONNECT (para HTTPS) o HTTP normal:
             - Para CONNECT: responde inmediatamente con "HTTP/1.1 200 Connection Established\r\n\r\n" y envía un mensaje JSON tipo "CONNECT" con host y puerto destino; luego transmite cada dato raw (sin compresión) en mensajes de tipo "DATA".
             - Para HTTP: acumula datos en un buffer y, cuando se alcanza al menos 20,000 bytes o pasan 2 segundos, envía un mensaje JSON tipo "REQ". Si el mensaje supera el límite, se fragmenta y se envía como archivos (sin caption).
    - Modo SERVIDOR:
         • Se conecta a WhatsApp y espera mensajes.
         • Si recibe un mensaje "CONNECT", abre una conexión TCP al destino y responde con "CONNECT_RESPONSE". En modo raw, los datos se intercambian en mensajes "DATA" sin compresión.
         • Para peticiones HTTP normales (tipo "REQ"), se conecta a un proxy configurado (por ejemplo, Squid) para reenviar la petición; la respuesta se agrupa (usando un mecanismo de caché), se comprime y se envía como "RES".
  
  Cada mensaje se marca con "protocol": "WA_TUNNEL" para filtrar solo el tráfico de nuestro túnel y se descartan mensajes antiguos (más de 30 segundos).
  
  Se utilizan parámetros de línea de comandos (yargs):
      --mode (-m): "client" o "server" (default "client")
      --local-port (-p): puerto local para el servidor TCP (default: 9000)
      --server-wa-num (-s): número de WhatsApp del servidor (sin @s.whatsapp.net) (para modo CLIENTE)
      --disable-files (-d): boolean para deshabilitar envío de archivos (opcional)
  
  Uso:
      node wasocket.js --mode=client --local-port=9000 --server-wa-num=595994672771
      node wasocket.js --mode=server
  
  NOTA: Para HTTPS se recomienda usar un proxy externo (por ejemplo, Squid) que se encargue del handshake TLS.
*/

const { default: makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const net = require('net');
const fs = require('fs');
const zlib = require('zlib');
const { promisify } = require('util');
const compress = promisify(zlib.brotliCompress);
const decompress = promisify(zlib.brotliDecompress);
const { v4: uuidv4 } = require('uuid');
const inquirer = require('inquirer');
const chalk = require('chalk');
const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');

// ───────────────────────────────────────────────
// CONSTANTES
// ───────────────────────────────────────────────

const MAX_TEXT_LENGTH = 20000;       // Máximo caracteres para mensaje de texto
const MAX_FILE_LENGTH = 80000;       // Límite para enviar como archivo (si se excede, se fragmenta)
const CHUNKSIZE = MAX_TEXT_LENGTH;   // Tamaño de fragmentos para mensajes largos
const MIN_BUFFER_SIZE = 20000;       // Mínimo de datos acumulados en buffer (HTTP)
const MAX_BUFFER_WAIT = 2000;        // Tiempo máximo (ms) para esperar a acumular datos
const PROTOCOL_ID = "WA_TUNNEL";     // Identificador de nuestro protocolo
const IGNORE_OLD_THRESHOLD = 30;     // Ignorar mensajes con timestamp >30 s de antigüedad
const RESPONSE_FLUSH_TIMEOUT = 300;  // Tiempo (ms) para agrupar respuestas del proxy
const DELIMITER = "|||";             // Delimitador (si se usa para separar fragmentos en caché)

// ───────────────────────────────────────────────
// PARÁMETROS DE LÍNEA DE COMANDOS (yargs)
// ───────────────────────────────────────────────

const argv = yargs(hideBin(process.argv))
  .option('mode', {
    alias: 'm',
    choices: ['client', 'server'],
    default: 'client',
    describe: 'Modo de operación: client o server'
  })
  .option('local-port', {
    alias: 'p',
    type: 'number',
    default: 9000,
    describe: 'Puerto local para el servidor TCP'
  })
  .option('server-wa-num', {
    alias: 's',
    type: 'string',
    describe: 'Número de WhatsApp del servidor (sin @s.whatsapp.net) (modo CLIENTE)'
  })
  .option('disable-files', {
    alias: 'd',
    type: 'boolean',
    default: false,
    describe: 'Deshabilitar envío de archivos (para reducir mensajes)'
  })
  .help()
  .argv;

let currentMode = argv.mode;

// Configuración general
let config = {
  client: {
    localTcpPort: argv['local-port'],
    serverWhatsAppId: ""  // Se asigna en modo CLIENTE
  },
  server: {
    // Aquí se configura el proxy que se usará para el flujo HTTP normal (por ejemplo, Squid)
    proxyHost: '127.0.0.1',
    proxyPort: 3128,  // Por ejemplo, Squid suele usar 3128 (ajusta según tu configuración)
  },
  whatsapp: {
    authFolder: ""  // Se asigna según el modo
  }
};

if (currentMode === "client") {
  config.whatsapp.authFolder = './auth_client';
} else {
  config.whatsapp.authFolder = './auth_server';
}

// Si en modo CLIENTE se pasa el número del servidor por línea de comandos, lo usamos
if (currentMode === "client" && argv.serverWaNum) {
  config.client.serverWhatsAppId = `${argv.serverWaNum}@s.whatsapp.net`;
}

// ───────────────────────────────────────────────
// VARIABLES GLOBALES
// ───────────────────────────────────────────────

let globalSock = null;       // Instancia actual de WhatsApp
let pendingSessions = {};    // CLIENTE: sessionId -> { socket, buffer, isRaw, lastFlushTime, flushTimer }
let rawSessions = {};        // SERVIDOR (raw HTTPS): sessionId -> socket TCP

// Caché de respuestas en SERVIDOR (HTTP)
const responseCache = {};       // sessionId -> array de Buffer
const responseCacheTimers = {}; // sessionId -> timer

// ───────────────────────────────────────────────
// FUNCIONES AUXILIARES
// ───────────────────────────────────────────────

function splitIntoChunks(str, size) {
  let chunks = [];
  for (let i = 0; i < str.length; i += size) {
    chunks.push(str.substring(i, i + size));
  }
  return chunks;
}

async function compressData(data) {
  return await compress(Buffer.from(data));
}

async function decompressData(data) {
  return await decompress(data);
}

// ───────────────────────────────────────────────
// ENVÍO DE MENSAJES VIA WHATSAPP
// (Para datos HTTP se comprime; para modo raw HTTPS no se comprime)
// ───────────────────────────────────────────────

async function sendTunnelMessage(sock, to, messageObj) {
  messageObj.protocol = PROTOCOL_ID;
  let msgStr = JSON.stringify(messageObj);
  if (msgStr.length <= MAX_TEXT_LENGTH) {
    console.log(chalk.green(`[SEND] ${messageObj.type} - Sesión: ${messageObj.sessionId}`));
    try {
      await sock.sendMessage(to, { text: msgStr });
    } catch (err) {
      console.error(chalk.red("[SEND] Error:"), err);
    }
  } else {
    console.log(chalk.green("[SEND] Mensaje grande; fragmentando en archivos sin caption."));
    let parts = splitIntoChunks(msgStr, CHUNKSIZE);
    for (let i = 0; i < parts.length; i++) {
      let partObj = {
        ...messageObj,
        partIndex: i + 1,
        totalParts: parts.length,
        payload: parts[i]
      };
      let filename = `tunnel_${messageObj.sessionId}_part${i+1}.txt`;
      fs.writeFileSync(filename, parts[i]);
      console.log(chalk.green(`[SEND] Enviando parte ${i+1} de ${parts.length} - Sesión: ${messageObj.sessionId}`));
      try {
        await sock.sendMessage(to, { 
          document: fs.readFileSync(filename), 
          fileName: filename 
        });
      } catch (err) {
        console.error(chalk.red("[SEND] Error en parte:"), err);
      }
      fs.unlinkSync(filename);
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }
}

// ───────────────────────────────────────────────
// CREAR SESIÓN EN CLIENTE (Buffering para peticiones HTTP)
// ───────────────────────────────────────────────

function createClientSession(socket) {
  const sessionId = uuidv4();
  const session = {
    socket: socket,
    buffer: [],
    isRaw: false,
    lastFlushTime: Date.now(),
    flushTimer: setInterval(async () => {
      if (session.buffer.length > 0 && !session.isRaw) {
        const now = Date.now();
        const combined = Buffer.concat(session.buffer);
        if (combined.length < MIN_BUFFER_SIZE && (now - session.lastFlushTime) < MAX_BUFFER_WAIT) {
          return;
        }
        session.buffer = [];
        session.lastFlushTime = now;
        console.log(chalk.magenta(`[CLIENT] Enviando buffer para sesión ${sessionId} (${combined.length} bytes)`));
        try {
          const compressedData = await compressData(combined);
          const payloadBase64 = compressedData.toString('base64');
          const messageObj = {
            type: "REQ",
            sessionId: sessionId,
            payload: payloadBase64
          };
          await sendTunnelMessage(globalSock, config.client.serverWhatsAppId, messageObj);
        } catch (e) {
          console.error(chalk.red("[CLIENT] Error al comprimir buffer:"), e);
        }
      }
    }, 500)
  };
  pendingSessions[sessionId] = session;
  socket.on('end', () => {
    console.log(chalk.yellow(`[CLIENT] Conexión terminada para sesión ${sessionId}`));
    clearInterval(session.flushTimer);
    delete pendingSessions[sessionId];
  });
  socket.on('error', (err) => {
    console.error(chalk.red("[CLIENT] Error en socket TCP:"), err);
    clearInterval(session.flushTimer);
    delete pendingSessions[sessionId];
  });
  return sessionId;
}

// ───────────────────────────────────────────────
// FUNCIONES PARA SOPORTAR HTTPS (Modo Raw con CONNECT)
// ───────────────────────────────────────────────

async function handleConnectMessage(msgObj, sock, from) {
  const targetHost = msgObj.host;
  const targetPort = msgObj.port;
  console.log(chalk.blue(`[SERVER][CONNECT] Recibido CONNECT para sesión ${msgObj.sessionId} a ${targetHost}:${targetPort}`));
  let targetSocket = net.connect({ host: targetHost, port: targetPort }, () => {
    console.log(chalk.cyan(`[SERVER][CONNECT] Conectado a ${targetHost}:${targetPort} para sesión ${msgObj.sessionId}`));
    let responseObj = {
       type: "CONNECT_RESPONSE",
       sessionId: msgObj.sessionId
    };
    sendTunnelMessage(sock, from, responseObj);
  });
  // En modo raw, enviamos los datos sin compresión
  targetSocket.on('data', async (data) => {
    let rawMsg = {
       type: "DATA",
       sessionId: msgObj.sessionId,
       payload: data.toString('base64')
    };
    await sendTunnelMessage(sock, from, rawMsg);
  });
  targetSocket.on('end', () => {
    console.log(chalk.cyan(`[SERVER][CONNECT] Conexión terminada a ${targetHost}:${targetPort} para sesión ${msgObj.sessionId}`));
  });
  targetSocket.on('error', (err) => {
    console.error(chalk.red(`[SERVER][CONNECT] Error en conexión a ${targetHost}:${targetPort} para sesión ${msgObj.sessionId}:`), err);
  });
  rawSessions[msgObj.sessionId] = targetSocket;
}

async function handleDataMessage(msgObj, sock, from) {
  if (!rawSessions[msgObj.sessionId]) {
    console.error(chalk.red(`[SERVER][DATA] No se encontró sesión raw para ${msgObj.sessionId}`));
    return;
  }
  // En modo raw, decodificar sin descomprimir
  let data = Buffer.from(msgObj.payload, 'base64');
  rawSessions[msgObj.sessionId].write(data);
}

// ───────────────────────────────────────────────
// MÉTODO DE CACHE PARA RESPUESTAS EN SERVIDOR (HTTP)
// ───────────────────────────────────────────────

function flushResponseCache(sessionId, sock, from) {
  if (!responseCache[sessionId] || responseCache[sessionId].length === 0) return;
  const buffers = responseCache[sessionId];
  delete responseCache[sessionId];
  if (responseCacheTimers[sessionId]) {
    clearTimeout(responseCacheTimers[sessionId]);
    delete responseCacheTimers[sessionId];
  }
  const combined = Buffer.concat(buffers);
  compressData(combined)
    .then((compressedData) => {
      const payloadBase64 = compressedData.toString('base64');
      const messageObj = {
        type: "RES",
        sessionId: sessionId,
        payload: payloadBase64
      };
      sendTunnelMessage(sock, from, messageObj);
    })
    .catch((err) => {
      console.error(chalk.red("[SERVER][HTTP] Error al comprimir datos cacheados:"), err);
    });
}

function cacheProxyData(sessionId, chunk, sock, from) {
  if (!responseCache[sessionId]) {
    responseCache[sessionId] = [];
  }
  responseCache[sessionId].push(chunk);
  if (responseCacheTimers[sessionId]) clearTimeout(responseCacheTimers[sessionId]);
  responseCacheTimers[sessionId] = setTimeout(() => {
    flushResponseCache(sessionId, sock, from);
  }, RESPONSE_FLUSH_TIMEOUT);
}

// ───────────────────────────────────────────────
// Manejo de peticiones HTTP en el SERVIDOR (usando un proxy externo)
// ───────────────────────────────────────────────

function handleProxyRequest(data, sock, from, sessionId) {
  let proxyClient = net.connect({ host: config.server.proxyHost, port: config.server.proxyPort }, () => {
    console.log(chalk.cyan(`[SERVER][HTTP] Conectado al proxy para sesión ${sessionId}`));
    proxyClient.write(data);
  });
  
  proxyClient.on('data', (chunk) => {
    cacheProxyData(sessionId, chunk, sock, from);
  });
  
  proxyClient.on('end', () => {
    console.log(chalk.cyan(`[SERVER][HTTP] Fin de datos del proxy para sesión ${sessionId}`));
    flushResponseCache(sessionId, sock, from);
  });
  
  proxyClient.on('error', (err) => {
    console.error(chalk.red("[SERVER][HTTP] Error en conexión con el proxy:"), err);
  });
}

// ───────────────────────────────────────────────
// Procesamiento de mensajes entrantes
// ───────────────────────────────────────────────

async function processTunnelMessage(message, sock, mode) {
  const now = Date.now() / 1000;
  if (message.messageTimestamp && message.messageTimestamp < now - IGNORE_OLD_THRESHOLD) return;
  
  if (!message || !message.message) return;
  let content = null;
  if (message.message.conversation) {
    content = message.message.conversation;
  } else if (message.message.extendedTextMessage && message.message.extendedTextMessage.text) {
    content = message.message.extendedTextMessage.text;
  } else if (message.message.documentMessage && message.message.documentMessage.caption) {
    content = message.message.documentMessage.caption;
  } else {
    return;
  }
  if (!content.startsWith("{")) return;
  let msgObj;
  try {
    msgObj = JSON.parse(content);
  } catch (e) {
    console.error(chalk.red("[RECV] Error al parsear JSON:"), e);
    return;
  }
  if (msgObj.protocol !== PROTOCOL_ID) return;
  if (!msgObj.sessionId || !msgObj.type || !msgObj.payload) {
    msgObj.type = msgObj.type || "REQ";
  }
  // Manejo de fragmentación para mensajes divididos en partes
  if (msgObj.totalParts && msgObj.totalParts > 1) {
    if (!globalThis.messageBuffer) globalThis.messageBuffer = {};
    if (!globalThis.messageBuffer[msgObj.sessionId]) {
      globalThis.messageBuffer[msgObj.sessionId] = { parts: {}, totalParts: msgObj.totalParts };
    }
    globalThis.messageBuffer[msgObj.sessionId].parts[msgObj.partIndex] = msgObj.payload;
    if (Object.keys(globalThis.messageBuffer[msgObj.sessionId].parts).length === msgObj.totalParts) {
      let fullPayload = "";
      for (let i = 1; i <= msgObj.totalParts; i++) {
        fullPayload += globalThis.messageBuffer[msgObj.sessionId].parts[i];
      }
      msgObj.payload = fullPayload;
      delete globalThis.messageBuffer[msgObj.sessionId];
      await handleTunnelPayload(msgObj, sock, mode, message.key.remoteJid);
    }
  } else {
    await handleTunnelPayload(msgObj, sock, mode, message.key.remoteJid);
  }
}

async function handleTunnelPayload(msgObj, sock, mode, from) {
  if (msgObj.type === "CONNECT") {
    if (mode === "server") {
      await handleConnectMessage(msgObj, sock, from);
    }
    return;
  }
  if (msgObj.type === "CONNECT_RESPONSE") {
    if (mode === "client") {
      console.log(chalk.blue(`[CLIENT][CONNECT] Recibido CONNECT_RESPONSE para sesión ${msgObj.sessionId}`));
      if (pendingSessions[msgObj.sessionId]) {
         pendingSessions[msgObj.sessionId].isRaw = true;
         pendingSessions[msgObj.sessionId].socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      }
    }
    return;
  }
  if (msgObj.type === "DATA") {
    if (mode === "server") {
      await handleDataMessage(msgObj, sock, from);
    } else if (mode === "client") {
      // En modo raw, decodificar sin descomprimir
      let data = Buffer.from(msgObj.payload, 'base64');
      if (pendingSessions[msgObj.sessionId] && pendingSessions[msgObj.sessionId].socket) {
         pendingSessions[msgObj.sessionId].socket.write(data);
      }
    }
    return;
  }
  // Flujo normal HTTP
  if (msgObj.type === "REQ" && mode === "server") {
    let compressedData = Buffer.from(msgObj.payload, 'base64');
    let originalData;
    try {
       originalData = (await decompressData(compressedData)).toString();
    } catch (e) {
       console.error(chalk.red("[SERVER][REQ] Error al descomprimir:"), e);
       return;
    }
    handleProxyRequest(originalData, sock, from, msgObj.sessionId);
  } else if (msgObj.type === "RES" && mode === "client") {
    let compressedData = Buffer.from(msgObj.payload, 'base64');
    let originalData;
    try {
       originalData = (await decompressData(compressedData)).toString();
    } catch (e) {
       console.error(chalk.red("[CLIENT][RES] Error al descomprimir:"), e);
       return;
    }
    if (pendingSessions[msgObj.sessionId] && pendingSessions[msgObj.sessionId].socket) {
      pendingSessions[msgObj.sessionId].socket.write(originalData);
    }
  } else {
    console.log(chalk.gray("[RECV] Mensaje ignorado o tipo desconocido:"), msgObj.type);
  }
}

// ───────────────────────────────────────────────
// MODO SERVIDOR: Manejo de peticiones HTTP (Proxy con caché de respuesta)
// ───────────────────────────────────────────────

function handleProxyRequest(data, sock, from, sessionId) {
  let proxyClient = net.connect({ host: config.server.proxyHost, port: config.server.proxyPort }, () => {
    console.log(chalk.cyan(`[SERVER][HTTP] Conectado al proxy para sesión ${sessionId}`));
    proxyClient.write(data);
  });
  
  proxyClient.on('data', (chunk) => {
    cacheProxyData(sessionId, chunk, sock, from);
  });
  
  proxyClient.on('end', () => {
    console.log(chalk.cyan(`[SERVER][HTTP] Fin de datos del proxy para sesión ${sessionId}`));
    flushResponseCache(sessionId, sock, from);
  });
  
  proxyClient.on('error', (err) => {
    console.error(chalk.red("[SERVER][HTTP] Error en conexión con el proxy:"), err);
  });
}

// ───────────────────────────────────────────────
// CONEXIÓN CON WHATSAPP Y MANEJO DE RECONEXIÓN
// ───────────────────────────────────────────────

async function initWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState(config.whatsapp.authFolder);
  const { version, isLatest } = await fetchLatestBaileysVersion();
  console.log(chalk.green(`Usando WhiskeySockets/Baileys v${version} (isLatest: ${isLatest})`));
  
  const sock = makeWASocket({
    version,
    printQRInTerminal: true,
    auth: state,
  });
  globalSock = sock;
  sock.ev.on('creds.update', saveCreds);
  
  sock.ev.on('messages.upsert', async m => {
    const messages = m.messages;
    if (!messages) return;
    for (let msg of messages) {
      const now = Date.now() / 1000;
      if (msg.messageTimestamp && msg.messageTimestamp < now - IGNORE_OLD_THRESHOLD) continue;
      if (msg.key && msg.key.fromMe) continue;
      try {
        await processTunnelMessage(msg, sock, currentMode);
      } catch (e) {
        if (e.message && e.message.indexOf("Bad MAC") !== -1) {
          console.warn(chalk.yellow("[RECV] Advertencia de cifrado (Bad MAC)."));
        } else {
          console.error(chalk.red("[RECV] Error en processTunnelMessage:"), e);
        }
      }
    }
  });
  
  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect } = update;
    console.log(chalk.blue("Estado de conexión:"), connection);
    if (connection === 'close') {
      const reason = lastDisconnect.error ? lastDisconnect.error.output?.statusCode : null;
      console.log(chalk.red("Conexión cerrada. Razón:"), reason);
      if (reason === 428) {
        console.log(chalk.yellow("La conexión se cerró por inactividad. Reconectando en 5 segundos..."));
        setTimeout(async () => {
          console.log(chalk.yellow("Reconectando..."));
          await initWhatsApp();
        }, 5000);
      } else {
        process.exit(0);
      }
    }
  });
  
  return sock;
}

// ───────────────────────────────────────────────
// MODO CLIENTE: Servidor TCP para recibir conexiones (HTTP y CONNECT)
// ───────────────────────────────────────────────

async function startClient() {
  let serverWaNum;
  if (argv.serverWaNum) {
    serverWaNum = `${argv.serverWaNum}@s.whatsapp.net`;
  } else {
    const answers = await inquirer.prompt([{
      type: 'input',
      name: 'serverNumber',
      message: 'Ingrese el número de WhatsApp del SERVIDOR (formato: 1234567890@s.whatsapp.net):'
    }]);
    serverWaNum = answers.serverNumber.includes('@')
      ? answers.serverNumber
      : `${answers.serverNumber}@s.whatsapp.net`;
  }
  config.client.serverWhatsAppId = serverWaNum;
  
  await initWhatsApp();
  
  const tcpServer = net.createServer((socket) => {
    socket.once('data', (data) => {
      const firstLine = data.toString().split("\r\n")[0];
      if (firstLine.startsWith("CONNECT")) {
        console.log(chalk.magenta("[CLIENT] Petición CONNECT recibida."));
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        const parts = firstLine.split(" ")[1].split(":");
        const targetHost = parts[0];
        const targetPort = parseInt(parts[1], 10);
        const sessionId = uuidv4();
        pendingSessions[sessionId] = { socket: socket, buffer: [], isRaw: true };
        const connectMsg = {
          type: "CONNECT",
          sessionId: sessionId,
          host: targetHost,
          port: targetPort
        };
        sendTunnelMessage(globalSock, config.client.serverWhatsAppId, connectMsg);
        // En modo raw, enviar cada dato sin compresión
        socket.on('data', async (chunk) => {
          let rawMsg = {
            type: "DATA",
            sessionId: sessionId,
            payload: chunk.toString('base64')
          };
          await sendTunnelMessage(globalSock, config.client.serverWhatsAppId, rawMsg);
        });
      } else {
        console.log(chalk.magenta("[CLIENT] Petición HTTP normal recibida."));
        const sessionId = createClientSession(socket);
        for (let id in pendingSessions) {
          if (pendingSessions[id].socket === socket && !pendingSessions[id].isRaw) {
            pendingSessions[id].buffer.push(data);
          }
        }
        socket.on('data', (chunk) => {
          for (let id in pendingSessions) {
            if (pendingSessions[id].socket === socket && !pendingSessions[id].isRaw) {
              pendingSessions[id].buffer.push(chunk);
            }
          }
        });
      }
    });
    console.log(chalk.magenta("[CLIENT] Cliente TCP conectado."));
  });
  
  tcpServer.listen(config.client.localTcpPort, () => {
    console.log(chalk.green(`Servidor TCP local (cliente) escuchando en el puerto ${config.client.localTcpPort}`));
  });
}

// ───────────────────────────────────────────────
// MODO SERVIDOR: Espera mensajes de túnel y reenvía (HTTP y CONNECT)
// ───────────────────────────────────────────────

async function startServer() {
  await initWhatsApp();
  console.log(chalk.green("Modo SERVIDOR iniciado. Esperando mensajes de túnel..."));
}

// ───────────────────────────────────────────────
// PROGRAMA PRINCIPAL
// ───────────────────────────────────────────────

(async () => {
  if (currentMode === "client") {
    console.log(chalk.green("Iniciando en modo CLIENTE..."));
    await startClient();
  } else if (currentMode === "server") {
    console.log(chalk.green("Iniciando en modo SERVIDOR..."));
    await startServer();
  }
})();

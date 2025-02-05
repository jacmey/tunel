/* 
  wasocket.js
  ------------
  Túnel TCP/HTTP/HTTPS a través de WhatsApp usando WhiskeySockets/Baileys.
  
  Soporta dos modos:
    • Modo CLIENTE: 
         - Levanta un servidor TCP en el puerto (por defecto 9000) para recibir conexiones (por ejemplo, de un navegador o curl).
         - Detecta si la conexión es una petición CONNECT (para HTTPS) o una petición HTTP normal.
           - En CONNECT: responde inmediatamente con "HTTP/1.1 200 Connection Established" y envía un mensaje JSON tipo "CONNECT" con host y puerto.
           - En HTTP normal: acumula datos en un buffer y, cuando se alcanza al menos 20 000 bytes o han pasado 2 segundos, se envía un mensaje JSON tipo "REQ".
         - En modo raw (HTTPS), los datos se transmiten en mensajes de tipo "DATA".
    • Modo SERVIDOR:
         - Se conecta a WhatsApp y espera mensajes.
         - Si recibe un mensaje "CONNECT", abre una conexión TCP al destino y responde con "CONNECT_RESPONSE".
         - Los mensajes "DATA" se reenvían directamente.
         - Las peticiones HTTP normales (tipo "REQ") se envían a un proxy configurado (por ejemplo, en el VPS) y la respuesta se agrupa y se envía como "RES".
  
  Para evitar enviar mensajes demasiado cortos (lo que puede generar baneo) y para no agotar el tiempo de espera, se usan los siguientes límites:
    • Mensajes de texto: ≤ 20,000 caracteres.
    • Si se supera ese límite, se envía como archivo; si supera 80,000 se fragmenta.
  
  Cada mensaje incluye el campo "ephemeralExpiration" para que se borre automáticamente después de 24 horas.
  
  Además, se filtran mensajes antiguos (más de 30 segundos de antigüedad) y se marca cada mensaje con "protocol": "WA_TUNNEL".
  
  Uso:
      node wasocket.js client   -> Modo CLIENTE.
      node wasocket.js server   -> Modo SERVIDOR.
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

// ───────────────────────────────────────────────
// CONSTANTES DE CONFIGURACIÓN
// ───────────────────────────────────────────────

const MAX_TEXT_LENGTH = 20000;       // Tamaño máximo para enviar como mensaje de texto
const MAX_FILE_LENGTH = 80000;       // Tamaño máximo para enviar como archivo (antes de fragmentar)
const CHUNKSIZE = MAX_TEXT_LENGTH;   // Utilizamos el mismo valor para fragmentar
const MIN_BUFFER_SIZE = 20000;       // Mínimo de bytes a acumular en buffer para enviar (HTTP)
const MAX_BUFFER_WAIT = 2000;        // Tiempo máximo (ms) para esperar a acumular datos
const PROTOCOL_ID = "WA_TUNNEL";     // Identificador del protocolo
const IGNORE_OLD_THRESHOLD = 30;     // Ignorar mensajes con timestamp (en segundos) de más de 30 segundos de antigüedad

// ───────────────────────────────────────────────
// CONFIGURACIÓN GENERAL
// ───────────────────────────────────────────────

let config = {
  client: {
    localTcpPort: 9000,
    serverWhatsAppId: "",  // Se solicitará en modo CLIENTE (ejemplo: "595994672771@s.whatsapp.net")
  },
  server: {
    proxyHost: '127.0.0.1',
    proxyPort: 1080,
  },
  whatsapp: {
    authFolder: "",  // Se asignará según el modo
  }
};

let currentMode = process.argv[2] || "client";
if (currentMode !== "client" && currentMode !== "server") {
  console.error(chalk.red("Modo inválido. Usa 'client' o 'server'."));
  process.exit(1);
}
if (currentMode === "client") {
  config.whatsapp.authFolder = './auth_client';
} else {
  config.whatsapp.authFolder = './auth_server';
}

// ───────────────────────────────────────────────
// VARIABLES GLOBALES
// ───────────────────────────────────────────────

let globalSock = null;       // Instancia actual de WhatsApp
let pendingSessions = {};    // En CLIENTE: sessionId -> { socket, buffer, isRaw, lastFlushTime, flushTimer }
let rawSessions = {};        // En SERVIDOR (raw HTTPS): sessionId -> socket TCP

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
// ENVÍO DE MENSAJES VIA WHATSAPP (con soporte de expiración)
// ───────────────────────────────────────────────

async function sendTunnelMessage(sock, to, messageObj) {
  // Aseguramos que el mensaje contenga nuestro identificador y sea efímero
  messageObj.protocol = PROTOCOL_ID;
  messageObj.ephemeralExpiration = 86400; // 24 horas en segundos
  let msgStr = JSON.stringify(messageObj);
  if (msgStr.length <= MAX_TEXT_LENGTH) {
    console.log(chalk.green(`[SEND] Tipo: ${messageObj.type}, Sesión: ${messageObj.sessionId}`));
    try {
      await sock.sendMessage(to, { text: msgStr });
    } catch (err) {
      console.error(chalk.red("[SEND] Error al enviar mensaje:"), err);
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
      console.log(chalk.green(`[SEND] Enviando parte ${i+1} de ${parts.length} para la sesión ${messageObj.sessionId}`));
      try {
        await sock.sendMessage(to, { 
          document: fs.readFileSync(filename), 
          fileName: filename 
        });
      } catch (err) {
        console.error(chalk.red("[SEND] Error al enviar parte:"), err);
      }
      fs.unlinkSync(filename);
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }
}

// ───────────────────────────────────────────────
// CREAR SESIÓN EN CLIENTE (buffering para peticiones HTTP)
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
          return; // Espera a acumular más datos o que expire el tiempo máximo
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
            payload: payloadBase64,
            ephemeralExpiration: 86400
          };
          await sendTunnelMessage(globalSock, config.client.serverWhatsAppId, messageObj);
        } catch (e) {
          console.error(chalk.red("[CLIENT] Error al comprimir datos del buffer:"), e);
        }
      }
    }, 500)
  };
  pendingSessions[sessionId] = session;
  socket.on('end', () => {
    console.log(chalk.yellow(`[CLIENT] Conexión TCP terminada para la sesión ${sessionId}`));
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
// FUNCIONES PARA SOPORTAR HTTPS (MODO RAW CON CONNECT)
// ───────────────────────────────────────────────

async function handleConnectMessage(msgObj, sock, from) {
  const targetHost = msgObj.host;
  const targetPort = msgObj.port;
  console.log(chalk.blue(`[SERVER][CONNECT] Recibido CONNECT para la sesión ${msgObj.sessionId} a ${targetHost}:${targetPort}`));
  let targetSocket = net.connect({ host: targetHost, port: targetPort }, () => {
      console.log(chalk.cyan(`[SERVER][CONNECT] Conectado a ${targetHost}:${targetPort} para la sesión ${msgObj.sessionId}`));
      let responseObj = {
         type: "CONNECT_RESPONSE",
         sessionId: msgObj.sessionId,
         ephemeralExpiration: 86400
      };
      sendTunnelMessage(sock, from, responseObj);
  });
  targetSocket.on('data', async (data) => {
      let rawMsg = {
         type: "DATA",
         sessionId: msgObj.sessionId,
         payload: (await compressData(data)).toString('base64'),
         ephemeralExpiration: 86400
      };
      await sendTunnelMessage(sock, from, rawMsg);
  });
  targetSocket.on('end', () => {
      console.log(chalk.cyan(`[SERVER][CONNECT] Conexión terminada a ${targetHost}:${targetPort} para la sesión ${msgObj.sessionId}`));
  });
  targetSocket.on('error', (err) => {
      console.error(chalk.red(`[SERVER][CONNECT] Error en conexión a ${targetHost}:${targetPort} para la sesión ${msgObj.sessionId}:`), err);
  });
  rawSessions[msgObj.sessionId] = targetSocket;
}

async function handleDataMessage(msgObj, sock, from) {
  if (!rawSessions[msgObj.sessionId]) {
    console.error(chalk.red(`[SERVER][DATA] No se encontró sesión raw para la sesión ${msgObj.sessionId}`));
    return;
  }
  let compressedData = Buffer.from(msgObj.payload, 'base64');
  let data;
  try {
    data = await decompressData(compressedData);
  } catch (e) {
    console.error(chalk.red("[SERVER][DATA] Error al descomprimir datos:"), e);
    return;
  }
  rawSessions[msgObj.sessionId].write(data);
}

// ───────────────────────────────────────────────
// PROCESAMIENTO DE MENSAJES ENTRANTES
// ───────────────────────────────────────────────

async function processTunnelMessage(message, sock, mode) {
  // Filtrar mensajes antiguos (más de 30 segundos de antigüedad)
  const now = Date.now() / 1000;
  if (message.messageTimestamp && message.messageTimestamp < now - IGNORE_OLD_THRESHOLD) {
    return;
  }
  
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
  // Manejo de fragmentación (concatenación de partes)
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
      console.log(chalk.blue(`[CLIENT][CONNECT] Recibido CONNECT_RESPONSE para la sesión ${msgObj.sessionId}`));
      if (pendingSessions[msgObj.sessionId]) {
         pendingSessions[msgObj.sessionId].isRaw = true;
         // En modo raw, enviar respuesta inmediata al navegador (si no se hizo ya)
         pendingSessions[msgObj.sessionId].socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      }
    }
    return;
  }
  if (msgObj.type === "DATA") {
    if (mode === "server") {
      await handleDataMessage(msgObj, sock, from);
    } else if (mode === "client") {
      let compressedData = Buffer.from(msgObj.payload, 'base64');
      let data;
      try {
         data = await decompressData(compressedData);
      } catch(e) {
         console.error(chalk.red("[CLIENT][DATA] Error al descomprimir:"), e);
         return;
      }
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
// Manejo de peticiones HTTP normales en el servidor (usando un proxy)
// ───────────────────────────────────────────────

function handleProxyRequest(data, sock, from, sessionId) {
  let proxyClient = net.connect({ host: config.server.proxyHost, port: config.server.proxyPort }, () => {
    console.log(chalk.cyan(`[SERVER][HTTP] Conectado al proxy para la sesión ${sessionId}`));
    proxyClient.write(data);
  });
  let responseBuffer = "";
  proxyClient.on('data', (chunk) => {
    responseBuffer += chunk.toString();
  });
  proxyClient.on('end', async () => {
    console.log(chalk.cyan(`[SERVER][HTTP] Fin de datos del proxy para la sesión ${sessionId}`));
    try {
      const compressedResponse = await compressData(responseBuffer);
      const payloadBase64 = compressedResponse.toString('base64');
      const messageObj = {
        type: "RES",
        sessionId: sessionId,
        payload: payloadBase64,
        ephemeralExpiration: 86400
      };
      await sendTunnelMessage(sock, from, messageObj);
    } catch (e) {
      console.error(chalk.red("[SERVER][HTTP] Error al comprimir respuesta del proxy:"), e);
    }
  });
  proxyClient.on('error', (err) => {
    console.error(chalk.red("[SERVER][HTTP] Error en conexión con el proxy:"), err);
  });
}

// ───────────────────────────────────────────────
// Conexión con WhatsApp y manejo de reconexión
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
      // Filtrar mensajes enviados por nosotros o demasiado antiguos.
      const now = Date.now() / 1000;
      if (msg.messageTimestamp && msg.messageTimestamp < now - 30) continue;
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
// MODO CLIENTE: Servidor TCP para recibir conexiones (soporta HTTP y CONNECT)
// ───────────────────────────────────────────────

async function startClient() {
  const answers = await inquirer.prompt([{
    type: 'input',
    name: 'serverNumber',
    message: 'Ingrese el número de WhatsApp del SERVIDOR (formato: 1234567890@s.whatsapp.net):'
  }]);
  if (!answers.serverNumber.includes('@')) {
    answers.serverNumber = answers.serverNumber + '@s.whatsapp.net';
  }
  config.client.serverWhatsAppId = answers.serverNumber;
  
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
          port: targetPort,
          ephemeralExpiration: 86400
        };
        sendTunnelMessage(globalSock, config.client.serverWhatsAppId, connectMsg);
        socket.on('data', async (chunk) => {
          let rawMsg = {
            type: "DATA",
            sessionId: sessionId,
            payload: (await compressData(chunk)).toString('base64'),
            ephemeralExpiration: 86400
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
// MODO SERVIDOR: Espera mensajes de túnel y reenvía (soporta HTTP y CONNECT)
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

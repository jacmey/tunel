/* 
  wasocket.js
  ------------
  Túnel TCP/HTTP/HTTPS a través de WhatsApp usando WhiskeySockets/Baileys
  
  Modo CLIENTE:
    - Levanta un servidor TCP local (por defecto puerto 9000) para recibir conexiones de aplicaciones (por ejemplo, un navegador o curl).
    - Detecta si la conexión es una petición CONNECT (para HTTPS) o una petición HTTP normal.
      • Para CONNECT: responde inmediatamente con “HTTP/1.1 200 Connection Established” y envía un mensaje JSON tipo "CONNECT" (con host y puerto destino).
      • Para HTTP: utiliza un buffer con flush dinámico para agrupar datos hasta alcanzar al menos 20,000 caracteres (o esperar 2 segundos como máximo) antes de enviar un mensaje JSON tipo "REQ".
    - En modo raw (HTTPS), los datos se envían y reciben como mensajes de tipo "DATA".
  
  Modo SERVIDOR:
    - Se conecta a WhatsApp y espera mensajes.
    - Si recibe un mensaje "CONNECT", abre una conexión TCP directa al destino (host:port) y envía una respuesta "CONNECT_RESPONSE".
    - En modo raw, reenvía los mensajes de tipo "DATA" directamente entre la conexión TCP y el túnel.
    - Para peticiones HTTP normales (tipo "REQ"), se conecta a un proxy (configurado en proxyHost:proxyPort) y luego envía la respuesta (tipo "RES").
  
  Para evitar enviar demasiados mensajes (y el riesgo de baneo), se agrupan los datos:
    • Mensajes de texto se envían únicamente si la longitud del JSON es mayor a 20,000 caracteres se envían como archivo (y si excede 80,000 se fragmenta).
    • Las respuestas del socket TCP se agrupan en un buffer hasta alcanzar el mínimo o un tiempo máximo de espera.
  
  Cada modo utiliza una carpeta de autenticación separada:
    - Cliente: "./auth_client"
    - Servidor: "./auth_server"
  
  Se utiliza inquirer para solicitar el número del servidor en modo CLIENTE y chalk para formatear los logs.
  
  Uso:
      node wasocket.js client   -> Inicia el modo CLIENTE.
      node wasocket.js server   -> Inicia el modo SERVIDOR.
      
  NOTA: Esta solución experimental para HTTPS usa el método CONNECT y transmite datos raw; la latencia puede afectar el handshake TLS.
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
// CONSTANTES Y CONFIGURACIÓN
// ───────────────────────────────────────────────

const MAX_TEXT_LENGTH = 20000; // Límite para enviar como mensaje de texto
const MAX_FILE_LENGTH = 80000; // Si excede, se fragmenta y se envía como archivo
const MIN_BUFFER_SIZE = 20000; // No se envía si el buffer es menor a este valor, a menos que se alcance el tiempo máximo
const MAX_BUFFER_WAIT = 2000;  // Tiempo máximo en ms para esperar a acumular datos
const PROTOCOL_ID = "WA_TUNNEL";

let config = {
  client: {
    localTcpPort: 9000,   // Puerto para el servidor TCP en modo CLIENTE
    serverWhatsAppId: "", // Se solicitará al inicio (ej.: 595994672771@s.whatsapp.net)
  },
  server: {
    // Proxy para peticiones HTTP normales
    proxyHost: '127.0.0.1',
    proxyPort: 1080,
  },
  whatsapp: {
    authFolder: "", // Se asigna según el modo
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

let globalSock = null;      // Instancia actual de WhatsApp
let pendingSessions = {};   // Para el modo CLIENTE: sessionId -> { socket, buffer, lastFlushTime, flushTimer, isRaw }
let rawSessions = {};       // Para el modo SERVIDOR (raw HTTPS): sessionId -> socket TCP abierta

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
// ───────────────────────────────────────────────

async function sendTunnelMessage(sock, to, messageObj) {
  messageObj.protocol = PROTOCOL_ID; // Aseguramos que el mensaje pertenezca a nuestro protocolo
  let msgStr = JSON.stringify(messageObj);
  if (msgStr.length <= MAX_TEXT_LENGTH) {
    console.log(chalk.green(`[SEND] Tipo: ${messageObj.type}, Sesión: ${messageObj.sessionId}`));
    try {
      await sock.sendMessage(to, { text: msgStr });
    } catch (err) {
      console.error(chalk.red("[SEND] Error al enviar mensaje:"), err);
    }
  } else {
    console.log(chalk.green("[SEND] Mensaje grande; enviando en partes (archivo sin caption)."));
    let parts = splitIntoChunks(msgStr, MAX_FILE_LENGTH);
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
// CREAR SESIÓN EN EL LADO CLIENTE (BUFFERING PARA PETICIONES HTTP)
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
        // Si el tamaño es menor que el mínimo y no ha pasado el tiempo máximo, espera.
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
// FUNCIONES PARA SOPORTAR HTTPS (MODO RAW)
// ───────────────────────────────────────────────

async function handleConnectMessage(msgObj, sock, from) {
  let targetHost = msgObj.host;
  let targetPort = msgObj.port;
  console.log(chalk.blue(`[SERVER][CONNECT] Recibido CONNECT para la sesión ${msgObj.sessionId} a ${targetHost}:${targetPort}`));
  let targetSocket = net.connect({ host: targetHost, port: targetPort }, () => {
      console.log(chalk.cyan(`[SERVER][CONNECT] Conectado a ${targetHost}:${targetPort} para la sesión ${msgObj.sessionId}`));
      let responseObj = {
         type: "CONNECT_RESPONSE",
         sessionId: msgObj.sessionId
      };
      sendTunnelMessage(sock, from, responseObj);
  });
  targetSocket.on('data', async (data) => {
      let rawMsg = {
         type: "DATA",
         sessionId: msgObj.sessionId,
         payload: (await compressData(data)).toString('base64')
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
// Procesamiento de mensajes entrantes
// ───────────────────────────────────────────────

async function processTunnelMessage(message, sock, mode) {
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
  // Manejo de fragmentación
  if (msgObj.totalParts && msgObj.totalParts > 1) {
    if (!messageBuffer[msgObj.sessionId]) {
      messageBuffer[msgObj.sessionId] = { parts: {}, totalParts: msgObj.totalParts };
    }
    messageBuffer[msgObj.sessionId].parts[msgObj.partIndex] = msgObj.payload;
    if (Object.keys(messageBuffer[msgObj.sessionId].parts).length === msgObj.totalParts) {
      let fullPayload = "";
      for (let i = 1; i <= msgObj.totalParts; i++) {
        fullPayload += messageBuffer[msgObj.sessionId].parts[i];
      }
      msgObj.payload = fullPayload;
      delete messageBuffer[msgObj.sessionId];
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
         // En modo raw, se envía la respuesta inmediata al navegador
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
    console.log(chalk.gray("[RECV] Mensaje de túnel ignorado o tipo desconocido:"), msgObj.type);
  }
}

// ───────────────────────────────────────────────
// Función para manejar peticiones HTTP normales en el servidor
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
        payload: payloadBase64
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
// Conexión con WhatsApp y manejo básico de reconexión
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
      // Revisar la primera línea para determinar si es CONNECT o petición HTTP normal.
      const firstLine = data.toString().split("\r\n")[0];
      if (firstLine.startsWith("CONNECT")) {
        console.log(chalk.magenta("[CLIENT] Petición CONNECT recibida."));
        // Responder inmediatamente al navegador
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        // Extraer host y puerto
        const parts = firstLine.split(" ")[1].split(":");
        const targetHost = parts[0];
        const targetPort = parseInt(parts[1], 10);
        const sessionId = uuidv4();
        pendingSessions[sessionId] = { socket: socket, buffer: [], isRaw: true };
        // Enviar mensaje CONNECT al servidor
        const connectMsg = {
          type: "CONNECT",
          sessionId: sessionId,
          host: targetHost,
          port: targetPort
        };
        sendTunnelMessage(globalSock, config.client.serverWhatsAppId, connectMsg);
        // En modo raw, enviar cada dato recibido inmediatamente como DATA
        socket.on('data', async (chunk) => {
          let rawMsg = {
            type: "DATA",
            sessionId: sessionId,
            payload: (await compressData(chunk)).toString('base64')
          };
          await sendTunnelMessage(globalSock, config.client.serverWhatsAppId, rawMsg);
        });
      } else {
        // Si es petición HTTP normal, crea una sesión con buffering.
        console.log(chalk.magenta("[CLIENT] Petición HTTP normal recibida."));
        const sessionId = createClientSession(socket);
        // Agregar los datos iniciales al buffer.
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
// Programa Principal
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

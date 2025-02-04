/* 
  wasocket.js
  ------------
  Proyecto educativo: Túnel TCP a través de WhatsApp usando WhiskeySockets/Baileys
  con soporte experimental para HTTPS mediante el método CONNECT y modo raw.

  Flujo:
    - MODO CLIENTE:
         • Levanta un servidor TCP local (por defecto en el puerto 9000) que espera conexiones.
         • Al recibir una nueva conexión, se lee la primera línea:
             - Si es una petición CONNECT (por ejemplo, "CONNECT www.google.com:443 HTTP/1.1"),
               se responde inmediatamente con "HTTP/1.1 200 Connection Established\r\n\r\n"
               y se envía un mensaje JSON de tipo "CONNECT" (con host y puerto) para establecer
               la conexión raw. Luego, cualquier dato recibido se envía inmediatamente como mensajes
               de tipo "DATA".
             - Si es una petición normal (por ejemplo, GET /index.html), se utiliza un buffer con
               un flush timer (cada 500 ms) para enviar la petición como un mensaje JSON de tipo "REQ".
    - MODO SERVIDOR:
         • Se conecta a WhatsApp y espera mensajes.
         • Si recibe un mensaje JSON con tipo "CONNECT", se abre una conexión TCP a (host:port)
           indicado y se envía un mensaje "CONNECT_RESPONSE" de vuelta.
         • Si recibe mensajes de tipo "DATA", se reenvían al socket TCP abierto para la sesión raw.
         • Si recibe mensajes de tipo "REQ", se procesa como una petición HTTP normal conectándose a
           un proxy (por ejemplo, el script proxy.js).
         • Se responde con mensajes de tipo "RES" para el flujo normal HTTP.

  Cada modo usa una carpeta de autenticación separada:
      • Cliente: "./auth_client"
      • Servidor: "./auth_server"

  Se usa inquirer para solicitar el número de WhatsApp del servidor en el modo CLIENTE
  y chalk para embellecer los logs.

  Uso:
      node wasocket.js client   -> Inicia en modo CLIENTE.
      node wasocket.js server   -> Inicia en modo SERVIDOR.
      
  Nota: Este túnel **NO** soporta HTTPS de forma nativa en el sentido de reencriptar datos; se
  establece un túnel raw a través del que se espera que la negociación TLS se haga directamente
  entre el navegador y el destino. La latencia y el reensamblaje de mensajes a través de WhatsApp
  pueden afectar el handshake TLS.
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
// CONFIGURACIÓN Y CONSTANTES
// ───────────────────────────────────────────────

const MAX_TEXT_LENGTH = 20000;      // Límite para enviar mensaje como texto
const MAX_FILE_LENGTH = 80000;      // Límite para enviar como archivo (se fragmenta si es mayor)
const PROTOCOL_ID = "WA_TUNNEL";    // Identificador de nuestro protocolo

// Configuración general
let config = {
  client: {
    localTcpPort: 9000, // Puerto donde el cliente TCP escuchará
    serverWhatsAppId: "", // Se solicitará al inicio
  },
  server: {
    // Proxy para peticiones HTTP normales
    proxyHost: '127.0.0.1',
    proxyPort: 1080,
  },
  whatsapp: {
    authFolder: '',
  }
};

// ───────────────────────────────────────────────
// Selección del modo y asignación de carpeta de autenticación
// ───────────────────────────────────────────────

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
// Variables globales
// ───────────────────────────────────────────────

let globalSock = null;  // Instancia actual de WhatsApp
let pendingSessions = {}; // Mapea sessionId -> { socket, isRaw, buffer, flushTimer }
let rawSessions = {};     // En modo servidor, mapea sessionId -> TCP socket (conexión raw)

// ───────────────────────────────────────────────
// Funciones auxiliares
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
// Función para enviar mensajes vía WhatsApp
// ───────────────────────────────────────────────

async function sendTunnelMessage(sock, to, messageObj) {
  // Aseguramos que el mensaje incluya nuestro identificador
  messageObj.protocol = PROTOCOL_ID;
  let msgStr = JSON.stringify(messageObj);
  if (msgStr.length <= MAX_TEXT_LENGTH) {
    console.log(chalk.green(`[SEND] Tipo: ${messageObj.type || "N/A"}, Sesión: ${messageObj.sessionId}`));
    try {
      await sock.sendMessage(to, { text: msgStr });
    } catch (err) {
      console.error(chalk.red("[SEND] Error al enviar mensaje:"), err);
    }
  } else {
    console.log(chalk.green("[SEND] Mensaje grande; enviando en partes sin caption."));
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
    // Para peticiones normales, si no se especifica el tipo, se asume "REQ"
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
      console.log(chalk.blue(`Cliente: Recibido CONNECT_RESPONSE para la sesión ${msgObj.sessionId}`));
      if (pendingSessions[msgObj.sessionId]) {
         pendingSessions[msgObj.sessionId].isRaw = true;
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
  // Para flujo normal HTTP (REQ y RES)
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
// Funciones para el modo raw (CONNECT para HTTPS)
// ───────────────────────────────────────────────

async function handleConnectMessage(msgObj, sock, from) {
  let targetHost = msgObj.host;
  let targetPort = msgObj.port;
  console.log(chalk.blue(`Servidor: Recibido CONNECT para la sesión ${msgObj.sessionId} a ${targetHost}:${targetPort}`));
  let targetSocket = net.connect({ host: targetHost, port: targetPort }, () => {
      console.log(chalk.cyan(`Servidor: Conectado a ${targetHost}:${targetPort} para la sesión ${msgObj.sessionId}`));
      let responseObj = {
         type: "CONNECT_RESPONSE",
         sessionId: msgObj.sessionId,
         protocol: PROTOCOL_ID
      };
      sendTunnelMessage(sock, from, responseObj);
  });
  targetSocket.on('data', async (data) => {
      let rawMsg = {
         type: "DATA",
         sessionId: msgObj.sessionId,
         payload: (await compressData(data)).toString('base64'),
         protocol: PROTOCOL_ID
      };
      await sendTunnelMessage(sock, from, rawMsg);
  });
  targetSocket.on('end', () => {
      console.log(chalk.cyan(`Servidor: Conexión terminada a ${targetHost}:${targetPort} para la sesión ${msgObj.sessionId}`));
  });
  targetSocket.on('error', (err) => {
      console.error(chalk.red(`Error en conexión a ${targetHost}:${targetPort} para la sesión ${msgObj.sessionId}:`), err);
  });
  rawSessions[msgObj.sessionId] = targetSocket;
}

async function handleDataMessage(msgObj, sock, from) {
  if (!rawSessions[msgObj.sessionId]) {
    console.error(chalk.red(`No se encontró sesión raw para la sesión ${msgObj.sessionId}`));
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
// Función para manejar peticiones HTTP normales en el servidor
// ───────────────────────────────────────────────

function handleProxyRequest(data, sock, from, sessionId) {
  let proxyClient = net.connect({ host: config.server.proxyHost, port: config.server.proxyPort }, () => {
    console.log(chalk.cyan(`Servidor (HTTP): Conectado al proxy para la sesión ${sessionId}`));
    proxyClient.write(data);
  });
  let responseBuffer = "";
  proxyClient.on('data', (chunk) => {
    responseBuffer += chunk.toString();
  });
  proxyClient.on('end', async () => {
    console.log(chalk.cyan(`Servidor (HTTP): Fin de datos del proxy para la sesión ${sessionId}`));
    try {
      const compressedResponse = await compressData(responseBuffer);
      const payloadBase64 = compressedResponse.toString('base64');
      const messageObj = {
        type: "RES",
        sessionId: sessionId,
        payload: payloadBase64,
        protocol: PROTOCOL_ID
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
// Conexión con WhatsApp (modo reconexión básica)
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
    console.log(chalk.magenta("Cliente TCP conectado."));
    handleNewClientSocket(socket);
  });
  tcpServer.listen(config.client.localTcpPort, () => {
    console.log(chalk.green(`Servidor TCP local (cliente) escuchando en el puerto ${config.client.localTcpPort}`));
  });
}

// ───────────────────────────────────────────────
// MODO SERVIDOR: Espera mensajes de túnel y reenvía (para HTTP y CONNECT)
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

/* 
  wasocket.js
  ------------
  Proyecto educativo: Túnel TCP a través de WhatsApp usando WhiskeySockets/Baileys

  Flujo:
    - MODO CLIENTE:
        • Se levanta un servidor TCP local (por ejemplo, en el puerto 9000) que recibe peticiones (ej. desde Firefox).
        • Cada conexión genera un sessionId y se acumulan datos en un buffer. Cada 500 ms se envía lo acumulado.
        • Los datos se comprimen y se envían vía WhatsApp (cuenta CLIENTE) al número del servidor.
        • Al recibir la respuesta vía WhatsApp, se descomprime y se reenvía al socket TCP.
    - MODO SERVIDOR:
        • Se conecta a WhatsApp (cuenta SERVIDOR) y espera mensajes de túnel.
        • Al recibir un mensaje “REQ”, se conecta al proxy configurado, reenvía la petición y, al recibir la respuesta, la comprime y la envía de vuelta vía WhatsApp.

  Cada modo usa su propia carpeta de autenticación:
      • Cliente: "./auth_client"
      • Servidor: "./auth_server"

  Se utiliza inquirer para preguntar el número del servidor (se corrige si es necesario) y chalk para embellecer los logs.
  
  Uso:
      node wasocket.js client   -> Inicia en modo CLIENTE.
      node wasocket.js server   -> Inicia en modo SERVIDOR.
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
const MESSAGE_PREFIX = "WA_TUNNEL"; // (Opcional) Prefijo para identificar mensajes

// Configuración general
let config = {
  client: {
    localTcpPort: 9000, // Puerto en el que el cliente TCP recibirá peticiones (ej. desde Firefox)
    // Se pedirá al inicio el número de WhatsApp del servidor (formato completo esperado)
    serverWhatsAppId: "",
  },
  server: {
    // Datos del proxy al que se conectará el servidor para reenviar peticiones HTTP
    proxyHost: '127.0.0.1',
    proxyPort: 1080,
  },
  whatsapp: {
    // La carpeta de autenticación se asignará según el modo
    authFolder: '',
  }
};

// ───────────────────────────────────────────────
// Selección del modo y asignación de la carpeta de autenticación
// ───────────────────────────────────────────────

let currentMode = process.argv[2] || "client";
if (currentMode !== "client" && currentMode !== "server") {
  console.error(chalk.red("Modo inválido. Usa 'client' o 'server'."));
  process.exit(1);
}

if (currentMode === "client") {
  config.whatsapp.authFolder = './auth_client';
} else if (currentMode === "server") {
  config.whatsapp.authFolder = './auth_server';
}

// ───────────────────────────────────────────────
// Variables Globales
// ───────────────────────────────────────────────

let globalSock = null;  // Instancia actual de WhatsApp

// ───────────────────────────────────────────────
// Funciones Auxiliares
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

/*
  Nuestro protocolo de túnel es un objeto JSON con esta estructura:
  {
    direction: "REQ" o "RES",   // "REQ" para solicitudes; "RES" para respuestas.
    sessionId: "<id único>",      // Identificador de la sesión.
    // (Opcional) Datos de fragmentación:
    partIndex: <número de parte>,
    totalParts: <número total de partes>,
    payload: "<cadena>"         // Datos comprimidos en base64.
  }
*/

// ───────────────────────────────────────────────
// Envío de mensajes vía WhatsApp (con fragmentación y retraso para evitar spam)
// ───────────────────────────────────────────────

async function sendTunnelMessage(sock, to, messageObj) {
  let msgStr = JSON.stringify(messageObj);
  if (msgStr.length <= MAX_TEXT_LENGTH) {
    console.log(chalk.green("Enviando mensaje de túnel como texto."));
    try {
      await sock.sendMessage(to, { text: msgStr });
    } catch (err) {
      console.error(chalk.red("Error al enviar mensaje:"), err);
    }
  } else {
    console.log(chalk.green("Mensaje excede límite; enviando como archivo fragmentado."));
    let parts = splitIntoChunks(msgStr, MAX_FILE_LENGTH);
    for (let i = 0; i < parts.length; i++) {
      let partObj = {
        ...messageObj,
        partIndex: i + 1,
        totalParts: parts.length,
        payload: parts[i]
      };
      let caption = JSON.stringify(partObj);
      let filename = `tunnel_${messageObj.sessionId}_part${i+1}.txt`;
      fs.writeFileSync(filename, parts[i]);
      console.log(chalk.green(`Enviando parte ${i+1} de ${parts.length} como archivo.`));
      try {
        await sock.sendMessage(to, { 
          document: fs.readFileSync(filename), 
          fileName: filename, 
          caption: caption 
        });
      } catch (err) {
        console.error(chalk.red("Error al enviar parte del mensaje:"), err);
      }
      fs.unlinkSync(filename);
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }
}

// ───────────────────────────────────────────────
// Ensamblado y procesamiento de mensajes de túnel
// ───────────────────────────────────────────────

let messageBuffer = {};

async function processTunnelMessage(message, sock, mode) {
  // Si no existe message.message, se ignora
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
  if (!content.startsWith("{")) return; // No es un mensaje de túnel

  let msgObj;
  try {
    msgObj = JSON.parse(content);
  } catch (e) {
    console.error(chalk.red("Error al parsear JSON:"), e);
    return;
  }
  if (!msgObj.sessionId || !msgObj.direction || !msgObj.payload) return;

  // Manejo de fragmentación
  if (msgObj.totalParts && msgObj.totalParts > 1) {
    if (!messageBuffer[msgObj.sessionId]) {
      messageBuffer[msgObj.sessionId] = { parts: {}, totalParts: msgObj.totalParts, timestamp: Date.now(), direction: msgObj.direction };
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

// ───────────────────────────────────────────────
// Manejo del payload del túnel
// ───────────────────────────────────────────────

async function handleTunnelPayload(msgObj, sock, mode, from) {
  let compressedData = Buffer.from(msgObj.payload, 'base64');
  let data;
  try {
    data = await decompressData(compressedData);
  } catch (e) {
    console.error(chalk.red("Error al descomprimir datos:"), e);
    return;
  }
  let originalData = data.toString();

  if (msgObj.direction === "REQ" && mode === "server") {
    console.log(chalk.blue(`Servidor: Recibido REQ para la sesión ${msgObj.sessionId}`));
    handleProxyRequest(originalData, sock, from, msgObj.sessionId);
  } else if (msgObj.direction === "RES" && mode === "client") {
    console.log(chalk.blue(`Cliente: Recibida RES para la sesión ${msgObj.sessionId}`));
    if (pendingSessions[msgObj.sessionId] && pendingSessions[msgObj.sessionId].socket) {
      pendingSessions[msgObj.sessionId].socket.write(originalData);
    }
  } else {
    console.log(chalk.gray("Mensaje de túnel ignorado o no coincide con el modo actual."));
  }
}

// ───────────────────────────────────────────────
// Gestión de sesiones en el lado CLIENTE (con buffering)
// ───────────────────────────────────────────────

let pendingSessions = {};

function createClientSession(socket) {
  const sessionId = uuidv4();
  const session = {
    socket: socket,
    buffer: [],
    flushTimer: setInterval(async () => {
      if (session.buffer.length > 0) {
        const combined = Buffer.concat(session.buffer);
        session.buffer = [];
        console.log(chalk.magenta(`Cliente: Enviando buffer para sesión ${sessionId} (${combined.length} bytes)`));
        try {
          const compressedData = await compressData(combined);
          const payloadBase64 = compressedData.toString('base64');
          const messageObj = {
            direction: "REQ",
            sessionId: sessionId,
            payload: payloadBase64
          };
          if (globalSock) {
            await sendTunnelMessage(globalSock, config.client.serverWhatsAppId, messageObj);
          } else {
            console.error(chalk.red("Cliente: No hay conexión WhatsApp disponible."));
          }
        } catch (e) {
          console.error(chalk.red("Error al comprimir datos del buffer:"), e);
        }
      }
    }, 500)
  };
  pendingSessions[sessionId] = session;
  socket.on('end', () => {
    console.log(chalk.yellow(`Cliente: Conexión TCP terminada para la sesión ${sessionId}`));
    clearInterval(session.flushTimer);
    delete pendingSessions[sessionId];
  });
  socket.on('error', (err) => {
    console.error(chalk.red("Error en socket TCP:"), err);
    clearInterval(session.flushTimer);
    delete pendingSessions[sessionId];
  });
  return sessionId;
}

// ───────────────────────────────────────────────
// MODO SERVIDOR: Conexión al proxy
// ───────────────────────────────────────────────

function handleProxyRequest(data, sock, from, sessionId) {
  let proxyClient = net.connect({ host: config.server.proxyHost, port: config.server.proxyPort }, () => {
    console.log(chalk.cyan(`Servidor: Conectado al proxy para la sesión ${sessionId}`));
    proxyClient.write(data);
  });

  let responseBuffer = "";
  proxyClient.on('data', async (chunk) => {
    responseBuffer += chunk.toString();
  });
  proxyClient.on('end', async () => {
    console.log(chalk.cyan(`Servidor: Fin de datos del proxy para la sesión ${sessionId}`));
    try {
      const compressedResponse = await compressData(responseBuffer);
      const payloadBase64 = compressedResponse.toString('base64');
      const messageObj = {
        direction: "RES",
        sessionId: sessionId,
        payload: payloadBase64
      };
      await sendTunnelMessage(sock, from, messageObj);
    } catch (e) {
      console.error(chalk.red("Error al comprimir respuesta del proxy:"), e);
    }
  });
  proxyClient.on('error', (err) => {
    console.error(chalk.red("Error en conexión con el proxy:"), err);
  });
}

// ───────────────────────────────────────────────
// Conexión con WhatsApp usando WhiskeySockets/Baileys y reconexión básica
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
        console.error(chalk.red("Error en processTunnelMessage:"), e);
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
// MODO CLIENTE: Servidor TCP local para recibir peticiones (ej. de Firefox)
// ───────────────────────────────────────────────

async function startClient() {
  // Se pregunta el número de WhatsApp del servidor
  const answers = await inquirer.prompt([{
    type: 'input',
    name: 'serverNumber',
    message: 'Ingrese el número de WhatsApp del SERVIDOR (formato: 1234567890@s.whatsapp.net):'
  }]);
  // Si el usuario no incluye "@", se agrega automáticamente el sufijo
  if (!answers.serverNumber.includes('@')) {
    answers.serverNumber = answers.serverNumber + '@s.whatsapp.net';
  }
  config.client.serverWhatsAppId = answers.serverNumber;
  
  await initWhatsApp();
  const tcpServer = net.createServer((socket) => {
    console.log(chalk.magenta("Cliente TCP conectado."));
    createClientSession(socket);
    socket.on('data', (data) => {
      for (let id in pendingSessions) {
        if (pendingSessions[id].socket === socket) {
          pendingSessions[id].buffer.push(data);
        }
      }
    });
  });

  tcpServer.listen(config.client.localTcpPort, () => {
    console.log(chalk.green(`Servidor TCP local (cliente) escuchando en el puerto ${config.client.localTcpPort}`));
  });
}

// ───────────────────────────────────────────────
// MODO SERVIDOR: Espera mensajes de túnel y reenvía al proxy
// ───────────────────────────────────────────────

async function startServer() {
  await initWhatsApp();
  console.log(chalk.green("Modo SERVIDOR iniciado. Esperando mensajes de túnel..."));
}

// ───────────────────────────────────────────────
// Programa Principal: Selección del modo
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

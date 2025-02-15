const P = require('pino');
const { delay, DisconnectReason, downloadMediaMessage, useMultiFileAuthState } = require('baileys');
const zlib = require('node:zlib');
const { encode, decode } = require('uint8-to-base64');
const makeWASocket = require('baileys').default;

const { logger } = require('./utils/logger');
const { splitBuffer, chunkString } = require('./utils/string-utils');
const { STATUS_CODES, LOGGER_TYPES, CHUNKSIZE, DELIMITER } = require('./constants');

const buffer = {};
const socksNumber = {};
const lastBufferNum = {};
const messagesBuffer = {};

class Message {
  constructor(statusCode, socksMessageNumber, socketNumber, dataPayload) {
    this.statusCode = statusCode;
    this.dataPayload = dataPayload;
    this.socketNumber = socketNumber;
    this.socksMessageNumber = socksMessageNumber;
  }
}

const sendData = async (waSock, data, socketNumber, remoteNum, filesDisabled) => {
  if (!socksNumber[socketNumber]) {
    socksNumber[socketNumber] = 0;
  }

  const compressedData = encode(data);

  await waSock.presenceSubscribe(remoteNum);

  if (compressedData.length > CHUNKSIZE && !filesDisabled) {
    logger(
      `SENDING FILE [${socksNumber[socketNumber]}][${compressedData.length}] -> ${socketNumber}`
    );

    socksNumber[socketNumber] += 1;

    await waSock.sendMessage(remoteNum, {
      document: zlib.brotliCompressSync(data),
      mimetype: 'application/octet-stream',
      fileName: `f-${socksNumber[socketNumber]}-${socketNumber}`
    });
  } else {
    let statusCode;
    const chunks = chunkString(compressedData, CHUNKSIZE);

    for (const [index, chunk] of chunks.entries()) {
      logger(
        `SENDING [${socksNumber[socketNumber]}][${index + 1}/${chunks.length}][${
          chunk.length
        }] -> ${socketNumber}`
      );

      if (chunks.length > 1 && index < chunks.length - 1) {
        statusCode = STATUS_CODES.CACHE;
      } else if (chunks.length > 1) {
        statusCode = STATUS_CODES.END;
      } else {
        statusCode = STATUS_CODES.FULL;
      }
      socksNumber[socketNumber] += 1;

      await waSock.sendMessage(remoteNum, {
        text: `${statusCode}-${socksNumber[socketNumber]}-${socketNumber}-${chunk}`
      });
    }
  }
  await delay(200);
};

const processMessage = (message, callback) => {
  const { socketNumber, statusCode, dataPayload, socksMessageNumber } = message;

  logger(`PROCESSING [${socksMessageNumber}] -> ${socketNumber}`);

  if (statusCode === STATUS_CODES.CACHE) {
    logger(`BUFFERING [${socksMessageNumber}] -> ${socketNumber}`);
    buffer[socketNumber] = (buffer[socketNumber] || '') + dataPayload;
  } else {
    let multi, decryptedText;
    if (statusCode === STATUS_CODES.END) {
      logger(`CLEARING BUFFER [${socksMessageNumber}] -> ${socketNumber}`);
      decryptedText = decode(buffer[socketNumber] + dataPayload);
      delete buffer[socketNumber];
      multi = true;
    }
    if (statusCode === STATUS_CODES.FULL) {
      if (Buffer.isBuffer(dataPayload)) {
        decryptedText = zlib.brotliDecompressSync(dataPayload);
        multi = false;
      } else {
        decryptedText = decode(dataPayload);
        multi = true;
      }
    }

    const messages = splitBuffer(decryptedText, DELIMITER, multi);
    logger(`RECEIVING [${messages.length}] MESSAGES -> ${socketNumber}`);

    for (const messageItem of messages) {
      callback(socketNumber, messageItem);
    }
  }

  lastBufferNum[socketNumber] = socksMessageNumber;
  const sockBuffer = messagesBuffer[socketNumber];

  logger(`CHECKING BUFFER [${socksMessageNumber}] -> ${socketNumber}`);

  if (sockBuffer && sockBuffer.length > 0) {
    logger(
      `MESSAGES IN BUFFER [${sockBuffer.length}][${socksMessageNumber}] -> ${socketNumber}`
    );
    if (sockBuffer.length > 1) {
      sockBuffer.sort((a, b) => a.socksMessageNumber - b.socksMessageNumber);
    }
    if (sockBuffer[0].socksMessageNumber === lastBufferNum[socketNumber] + 1) {
      const messageBuffed = sockBuffer.shift();
      processMessage(messageBuffed, callback);
    }
  }
};

const startSock = async (remoteNum, callback, client) => {
  // Usamos useMultiFileAuthState en lugar de la antigua función
  const { state, saveCreds } = await useMultiFileAuthState(`${client}-auth`);
  const waSock = makeWASocket({
    logger: P({ level: 'silent' }),
    printQRInTerminal: true,
    auth: state
  });

  waSock.ev.on('messages.upsert', async (m) => {
    const msg = m.messages[0];
    if (!msg.key.fromMe && m.type === 'notify') {
      if (msg.key.remoteJid === remoteNum) {
        if (msg.message) {
          await waSock.readMessages([msg.key]);

          let textThings, statusCode, dataPayload, socketNumber, socksMessageNumber;
          if (msg.message.documentMessage) {
            dataPayload = await downloadMediaMessage(msg, 'buffer');
            textThings = msg.message.documentMessage.fileName.split('-');
            statusCode = textThings[0];
            socketNumber = textThings[2];
            socksMessageNumber = parseInt(textThings[1]);
          } else {
            if (msg.message.extendedTextMessage) {
              const text = msg.message.extendedTextMessage.text;
              textThings = text.split('-');
            } else {
              const text = msg.message.conversation;
              textThings = text.split('-');
            }
            statusCode = textThings[0];
            socksMessageNumber = parseInt(textThings[1]);
            socketNumber = textThings[2];
            dataPayload = textThings[3];
          }

          const message = new Message(statusCode, socksMessageNumber, socketNumber, dataPayload);
          logger(`RECIEVING [${socksMessageNumber}] -> ${socketNumber}`);

          const lastSockMessageNumber = lastBufferNum[socketNumber];
          if (
            (lastSockMessageNumber && socksMessageNumber > lastSockMessageNumber + 1) ||
            (!lastSockMessageNumber && socksMessageNumber !== 1)
          ) {
            logger(`BUFFERING MESSAGE [${socksMessageNumber}] -> ${socketNumber}`);
            if (!messagesBuffer[socketNumber]) {
              messagesBuffer[socketNumber] = [];
            }
            messagesBuffer[socketNumber].push(message);
          } else {
            processMessage(message, callback);
          }
        }
      }
    }
  });

  waSock.ev.on('creds.update', saveCreds);

  waSock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect } = update;
    if (connection === 'close') {
      const shouldReconnect =
        (lastDisconnect.error?.output?.statusCode) !== DisconnectReason.loggedOut;
      logger(`connection closed: ${lastDisconnect.error ? lastDisconnect.error : ''}`, LOGGER_TYPES.ERROR);
      if (shouldReconnect) {
        startSock(remoteNum, callback, client);
      }
    }
    logger(`connection update ${JSON.stringify(update)}`);
  });
  return waSock;
};

exports.startSock = startSock;
exports.sendData = sendData;

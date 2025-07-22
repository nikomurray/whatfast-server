import pkg from '@whiskeysockets/baileys';
const { default: makeWASocket, DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion } = pkg;
import { Boom } from '@hapi/boom';
import QRCode from "qrcode";
import dotenv from "dotenv";
import { createServer } from "node:http";
import { Server } from "socket.io";
import path from "path";
import { promises as fs } from 'fs';
import pino from 'pino';

dotenv.config();

class WhatsAppServer {
  constructor() {
    this.PORT = process.env.PORT || 4321;
    this.INTERVAL = 3;	// Interval in seconds  
    this.clients = new Map(); // Map para almacenar clientes por socketId

    this.initializeServer();
  }

  initializeServer() {
    this.server = createServer();
    this.io = new Server(this.server, {
      cors: {
        origin: "*",
        methods: ["GET", "POST"],
        allowedHeaders: ["Content-Type"],
        credentials: true,
      },
    });

    this.setupSocketEvents();
  }

  setupSocketEvents() {
    this.io.on("connection", (socket) => {
      console.log(`Usuario conectado: ${socket.id}`);

      // Inicializar un nuevo cliente de WhatsApp para este socket
      this.initializeWhatsAppClient(socket.id);

      socket.on("messageData", (data) => {
        const clientData = this.clients.get(socket.id);
        if (clientData && clientData.ready) {
          this.sendWppMessages(socket, data.numbers, data.message);
        } else {
          socket.emit("error", "Cliente de WhatsApp no está listo. Por favor escanea el código QR primero.");
        }
      });

      socket.on("stop", () => {
        const clientData = this.clients.get(socket.id);
        if (clientData) {
          clientData.stopSendingMessages = true;
        }
      });

      socket.on("disconnect", () => {
        // console.log(`Usuario desconectado: ${socket.id}`);
        this.io.to(socket.id).emit("login", false);
        this.destroyWhatsAppClient(socket.id);
      });
    });
  }

  async initializeWhatsAppClient(socketId) {
    try {
      // Crear directorio para la sesión si no existe
      const authDir = path.join(process.cwd(), ".wwebjs_auth", socketId);
      await fs.mkdir(authDir, { recursive: true });

      // Configurar autenticación
      const { state, saveCreds } = await useMultiFileAuthState(authDir);

      // Obtener versión más reciente de Baileys
      const { version } = await fetchLatestBaileysVersion();

      // Crear socket de WhatsApp
      const sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false,
        browser: ['WhatsApp Server', 'Chrome', '120.0.0'],
        logger: pino({ level: 'silent' }),
        markOnlineOnConnect: true,
        generateHighQualityLinkPreview: false,
        syncFullHistory: false,
      });

      this.clients.set(socketId, {
        sock,
        qrCodeSent: false,
        qrCode: null,
        lastQrCode: null,
        qrTimeout: null,
        stopSendingMessages: false,
        ready: false,
        isDestroying: false,
        saveCreds,
      });

      // Configurar event handlers
      this.setupBaileysEvents(socketId, sock);

    } catch (error) {
      console.error(`Error al inicializar cliente ${socketId}:`, error);
      this.io.to(socketId).emit("error", "Error al inicializar WhatsApp. Por favor recarga la página.");
      this.clients.delete(socketId);
    }
  }

  setupBaileysEvents(socketId, sock) {
    const clientData = this.clients.get(socketId);
    if (!clientData) return;

    // Handle WebSocket errors
    sock.ws?.on('error', (error) => {
      console.error(`WebSocket error for ${socketId}:`, error);
      // Don't emit error events here, let the connection.update handler deal with it
    });

    // Manejar actualizaciones de conexión
    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        await this.handleQRCode(socketId, qr);
      }

      if (connection === 'close') {
        const shouldReconnect = (lastDisconnect?.error instanceof Boom)
          ? lastDisconnect.error.output?.statusCode !== DisconnectReason.loggedOut
          : true;

        console.log(`Conexión cerrada para ${socketId}, ¿reconectar?`, shouldReconnect);

        if (shouldReconnect && !clientData.isDestroying) {
          setTimeout(() => {
            if (this.io.sockets.sockets.has(socketId) && !clientData.isDestroying) {
              this.initializeWhatsAppClient(socketId);
            }
          }, 2000);
        } else {
          this.handleClientDisconnect(socketId, 'LOGOUT');
        }
      } else if (connection === 'open') {
        this.handleClientReady(socketId);
      }
    });

    // Manejar actualizaciones de credenciales
    sock.ev.on('creds.update', clientData.saveCreds);

    // Manejar mensajes (opcional, para debugging)
    sock.ev.on('messages.upsert', async (m) => {
      // console.log('Mensaje recibido:', JSON.stringify(m, undefined, 2));
    });

    // Handle socket errors to prevent unhandled error events
    sock.ev.on('error', (error) => {
      console.error(`Baileys socket error for ${socketId}:`, error);
    });
  }

  async destroyWhatsAppClient(socketId) {
    const clientData = this.clients.get(socketId);
    if (clientData && !clientData.isDestroying) {
      clientData.isDestroying = true;
      this.io.to(socketId).emit("login", false);

      try {
        // Clear any pending QR timeout
        if (clientData.qrTimeout) {
          clearTimeout(clientData.qrTimeout);
        }

        // Stop sending messages if in progress
        clientData.stopSendingMessages = true;

        // Give the client time to finish any pending operations
        await new Promise(resolve => setTimeout(resolve, 500));

        // Cerrar conexión de Baileys
        if (clientData.sock) {
          try {
            // Check if the socket is still connected before attempting logout
            if (clientData.sock.ws && clientData.sock.ws.readyState === clientData.sock.ws.OPEN) {
              await clientData.sock.logout();
            } else {
              // If WebSocket is not open, just close it directly
              console.log(`WebSocket for ${socketId} is not open, skipping logout`);
              if (clientData.sock.ws && clientData.sock.ws.readyState !== clientData.sock.ws.CLOSED) {
                clientData.sock.ws.close();
              }
            }
          } catch (logoutError) {
            console.error(`Error durante logout del cliente ${socketId}:`, logoutError);
            // Intentar cerrar la conexión websocket directamente
            try {
              if (clientData.sock.ws && clientData.sock.ws.readyState !== clientData.sock.ws.CLOSED) {
                clientData.sock.ws.close();
              }
            } catch (wsError) {
              console.error(`Error cerrando websocket para ${socketId}:`, wsError);
            }
          }
        }

      } catch (error) {
        console.error(`Error al destruir cliente ${socketId}:`, error);
      } finally {
        this.clients.delete(socketId);
      }
    }
  }

  async handleQRCode(socketId, qr) {
    console.log(`QR recibido para usuario: ${socketId}`);
    const clientData = this.clients.get(socketId);

    if (!clientData || clientData.isDestroying) return;

    try {
      const newQrCode = await this.qrToUrl(qr);

      // Only emit if it's a different QR code than the last one sent
      if (newQrCode && newQrCode !== clientData.lastQrCode) {
        this.io.to(socketId).emit("qr", newQrCode);
        console.log(`QR enviado al cliente: ${socketId}`);
        clientData.lastQrCode = newQrCode;
        clientData.qrCodeSent = true;
      }
    } catch (error) {
      console.error(`Error al manejar código QR para ${socketId}:`, error);
    }
  }

  handleClientReady(socketId) {
    console.log(`Cliente listo para usuario: ${socketId}`);
    const clientData = this.clients.get(socketId);

    if (clientData && !clientData.isDestroying) {
      clientData.ready = true;
      clientData.qrCodeSent = false;
      clientData.lastQrCode = null;
      this.io.to(socketId).emit("login", true);
    }
  }

  async handleClientDisconnect(socketId, reason) {
    console.log(`Cliente WhatsApp desconectado para usuario: ${socketId}. Razón: ${reason}`);
    const clientData = this.clients.get(socketId);

    if (clientData && !clientData.isDestroying) {
      clientData.ready = false;
      this.io.to(socketId).emit("login", false);

      // Only reinitialize if the socket is still connected and not a logout
      if (this.io.sockets.sockets.has(socketId) && reason !== 'LOGOUT') {
        await this.destroyWhatsAppClient(socketId);
        // Small delay before reinitializing
        setTimeout(() => {
          if (this.io.sockets.sockets.has(socketId)) {
            this.initializeWhatsAppClient(socketId);
          }
        }, 2000);
      }
    }
  }

  async qrToUrl(qr) {
    try {
      return await QRCode.toDataURL(qr);
    } catch (err) {
      console.error("Error al convertir QR a URL:", err);
      return null;
    }
  }

  async sendWppMessages(socket, numbers, message, interval = this.INTERVAL) {
    const socketId = socket.id;
    const clientData = this.clients.get(socketId);

    if (!clientData || !clientData.ready || clientData.isDestroying) {
      socket.emit("error", "Cliente de WhatsApp no está listo");
      socket.emit("finish");
      return;
    }

    if (!Array.isArray(numbers) || numbers.length === 0) {
      console.error("No se proporcionaron números de teléfono.");
      socket.emit("finish");
      return;
    }

    console.log(`Iniciando envío de mensajes para ${socketId} con intervalo de ${interval} segundos...`);
    console.log(`Total de números a procesar: ${numbers.length}`);

    let wasAbortedPorErrorCritico = false;
    let processedCount = 0;

    for (const number of numbers) {
      processedCount++;
      console.log(`Procesando número ${processedCount}/${numbers.length}: ${number}`);

      if (clientData.stopSendingMessages || clientData.isDestroying) {
        console.log(`Detención de envío de mensajes para ${socketId}.`);
        break;
      }

      if (!this.isValidNumber(number)) {
        console.warn(`Número inválido omitido: ${number}`);
        this.sendMessageReport(socket, number, false);
        continue;
      }

      try {
        await this.sendSingleMessage(clientData.sock, number, message);
        console.log(`✅ Mensaje enviado a ${number} por ${socketId}`);
        this.sendMessageReport(socket, number, true);
      } catch (error) {
        console.error(`❌ Error al enviar mensaje a ${number} por ${socketId}: ${error.message}`);
        this.sendMessageReport(socket, number, false);

        if (
          error.message.includes("Target closed") ||
          error.message.includes("Protocol error") ||
          error.message.includes("Conexión perdida") ||
          error.message.includes("Connection Closed") ||
          error.message.includes("WebSocket")
        ) {
          console.error(`🛑 Cliente WhatsApp desconectado. Abortando envío para ${socketId}`);
          socket.emit("error", "WhatsApp se desconectó. Por favor recarga la página.");
          wasAbortedPorErrorCritico = true;
          break;
        }
      }

      // Solo esperar si no es el último número
      if (processedCount < numbers.length) {
        await new Promise((resolve) => setTimeout(resolve, interval * 1000));
      }
    }

    if (!wasAbortedPorErrorCritico) {
      console.log(`📬 Finalizado envío de mensajes para ${socketId}. Procesados: ${processedCount}/${numbers.length}`);
      socket.emit("finish");
    }

    if (clientData) {
      clientData.stopSendingMessages = false;
    }
  }

  async sendSingleMessage(sock, number, message) {
    try {
      const cleanedNumber = number.replace(/\D/g, "");

      // Para números argentinos, ajustar formato
      let formattedNumber = cleanedNumber;

      // Si el número empieza con 0, quitarlo
      if (formattedNumber.startsWith('0')) {
        formattedNumber = formattedNumber.substring(1);
      }

      // Si es un número argentino sin código de país, agregarlo
      if (formattedNumber.length === 10 && (formattedNumber.startsWith('11') || formattedNumber.startsWith('2') || formattedNumber.startsWith('3'))) {
        formattedNumber = '54' + formattedNumber;
      } else if (formattedNumber.length === 11 && formattedNumber.startsWith('15')) {
        // Números con 15 (quitarlo y agregar 549)
        formattedNumber = '549' + formattedNumber.substring(2);
      }

      // Si ya tiene 549, está bien
      // Si tiene 54 pero no 9, agregarlo para celulares
      if (formattedNumber.startsWith('54') && !formattedNumber.startsWith('549') && formattedNumber.length === 12) {
        const areaCode = formattedNumber.substring(2, 4);
        if (areaCode === '11' || parseInt(areaCode) >= 22) { // Es celular
          formattedNumber = '549' + formattedNumber.substring(2);
        }
      }

      const jid = `${formattedNumber}@s.whatsapp.net`;

      // Verificar que el número esté registrado en WhatsApp
      const [result] = await sock.onWhatsApp(formattedNumber);

      if (!result || !result.exists) {
        throw new Error(`El número ${number} no está registrado en WhatsApp`);
      }

      // Enviar el mensaje con reintentos
      let attempts = 0;
      const maxAttempts = 3;

      while (attempts < maxAttempts) {
        try {
          const sentMsg = await sock.sendMessage(jid, { text: message });
          return sentMsg;
        } catch (sendError) {
          attempts++;

          if (attempts === maxAttempts) {
            throw sendError;
          }

          // Esperar antes del siguiente intento
          await new Promise(resolve => setTimeout(resolve, 2000));
        }
      }

    } catch (error) {
      // Mejorar el mensaje de error
      if (error.message.includes('Connection Closed') || error.message.includes('WebSocket')) {
        throw new Error(`Conexión perdida con WhatsApp`);
      } else if (error.message.includes('rate-overlimit')) {
        throw new Error(`Límite de tasa excedido. Espera un momento antes de continuar.`);
      }

      throw new Error(`Error enviando mensaje: ${error.message}`);
    }
  }

  isValidNumber(number) {
    const cleaned = number.replace(/\D/g, "");
    // Aceptar números de 8 a 15 dígitos para mayor flexibilidad
    return /^\d{8,15}$/.test(cleaned);
  }

  sendMessageReport(socket, number = "", status = false) {
    try {
      const now = new Date();
      const report = {
        date: now.toLocaleDateString("es-AR", {
          day: "2-digit",
          month: "2-digit",
          year: "numeric",
        }),
        number,
        status,
      };

      socket.emit("report", report);
    } catch (error) {
      console.error("Error enviando reporte:", error);
    }
  }

  start() {
    this.server.listen(this.PORT, () => {
      console.log(`Servidor ejecutándose en el puerto ${this.PORT}`);
    });

    // Graceful shutdown
    process.on('SIGINT', async () => {
      console.log('Cerrando servidor...');

      // Destroy all clients
      for (const [socketId, clientData] of this.clients) {
        await this.destroyWhatsAppClient(socketId);
      }

      this.server.close(() => {
        console.log('Servidor cerrado');
        process.exit(0);
      });
    });
  }
}

// Inicializar y arrancar el servidor
const server = new WhatsAppServer();
server.start();

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
        console.log(`Usuario desconectado: ${socket.id}`);
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
        markOnlineOnConnect: false, // Cambiado a false para evitar problemas
        generateHighQualityLinkPreview: false,
        syncFullHistory: false,
        getMessage: async (key) => {
          return { conversation: '' }; // Manejar mensajes requeridos
        },
        // Añadir configuraciones para mejorar estabilidad
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: 60000,
        keepAliveIntervalMs: 10000,
        retryRequestDelayMs: 250,
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
        connectionState: 'disconnected', // Añadir estado de conexión
        isSendingMessages: false, // Flag para saber si está enviando
        reconnecting: false, // Flag para reconexión
        messageQueue: [], // Cola de mensajes pendientes
        currentMessageIndex: 0, // Índice actual en el envío
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
      // Marcar conexión como perdida
      if (clientData) {
        clientData.connectionState = 'error';
      }
    });

    // Manejar actualizaciones de conexión
    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        await this.handleQRCode(socketId, qr);
      }

      if (connection === 'close') {
        clientData.connectionState = 'closed';
        
        const shouldReconnect = (lastDisconnect?.error instanceof Boom)
          ? lastDisconnect.error.output?.statusCode !== DisconnectReason.loggedOut
          : true;

        console.log(`Conexión cerrada para ${socketId}, ¿reconectar?`, shouldReconnect, 
                   lastDisconnect?.error?.output?.statusCode);

        // Si estamos enviando mensajes, pausar y intentar reconectar
        if (clientData.isSendingMessages && shouldReconnect && !clientData.isDestroying) {
          console.log(`🔄 Reconectando durante envío de mensajes para ${socketId}...`);
          clientData.ready = false;
          clientData.reconnecting = true;
          
          // Limpiar el cliente actual antes de reconectar
          await this.cleanupClient(socketId, false);
          
          // Reconectar más rápido durante envío
          setTimeout(async () => {
            if (this.io.sockets.sockets.has(socketId) && !clientData.isDestroying) {
              await this.initializeWhatsAppClient(socketId);
            }
          }, 1500);
        } else if (shouldReconnect && !clientData.isDestroying) {
          // Limpiar el cliente actual antes de reconectar
          await this.cleanupClient(socketId, false);
          
          setTimeout(() => {
            if (this.io.sockets.sockets.has(socketId) && !clientData.isDestroying) {
              this.initializeWhatsAppClient(socketId);
            }
          }, 3000);
        } else {
          this.handleClientDisconnect(socketId, 'LOGOUT');
        }
      } else if (connection === 'open') {
        clientData.connectionState = 'open';
        
        // Si estábamos reconectando durante envío, reanudar
        if (clientData.reconnecting) {
          console.log(`✅ Reconexión exitosa para ${socketId}, reanudando envío...`);
          clientData.reconnecting = false;
        }
        
        this.handleClientReady(socketId);
      } else if (connection === 'connecting') {
        clientData.connectionState = 'connecting';
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
      if (clientData) {
        clientData.connectionState = 'error';
      }
    });
  }

  async cleanupClient(socketId, removeFromMap = true) {
    const clientData = this.clients.get(socketId);
    if (!clientData) return;

    try {
      // Clear any pending QR timeout
      if (clientData.qrTimeout) {
        clearTimeout(clientData.qrTimeout);
        clientData.qrTimeout = null;
      }

      // Stop sending messages if in progress
      clientData.stopSendingMessages = true;

      // Cerrar WebSocket directamente si existe
      if (clientData.sock?.ws) {
        try {
          if (clientData.sock.ws.readyState === clientData.sock.ws.OPEN) {
            clientData.sock.ws.close();
          }
        } catch (wsError) {
          console.error(`Error cerrando websocket para ${socketId}:`, wsError);
        }
      }

      // Limpiar event listeners
      if (clientData.sock?.ev) {
        try {
          clientData.sock.ev.removeAllListeners();
        } catch (error) {
          console.error(`Error removiendo listeners para ${socketId}:`, error);
        }
      }

    } catch (error) {
      console.error(`Error en cleanup del cliente ${socketId}:`, error);
    }

    if (removeFromMap) {
      this.clients.delete(socketId);
    }
  }

  async destroyWhatsAppClient(socketId) {
    const clientData = this.clients.get(socketId);
    if (clientData && !clientData.isDestroying) {
      clientData.isDestroying = true;
      this.io.to(socketId).emit("login", false);

      try {
        // Solo intentar logout si la conexión está activa
        if (clientData.sock && clientData.connectionState === 'open') {
          try {
            // Verificar estado del WebSocket antes de logout
            if (clientData.sock.ws && clientData.sock.ws.readyState === clientData.sock.ws.OPEN) {
              await Promise.race([
                clientData.sock.logout(),
                new Promise((_, reject) => setTimeout(() => reject(new Error('Logout timeout')), 3000))
              ]);
            } else {
              console.log(`WebSocket para ${socketId} no está abierto, omitiendo logout`);
            }
          } catch (logoutError) {
            console.error(`Error durante logout del cliente ${socketId}:`, logoutError.message);
            // No relanzar el error, solo loggearlo
          }
        } else {
          console.log(`Cliente ${socketId} no está conectado, omitiendo logout`);
        }

        // Limpiar cliente
        await this.cleanupClient(socketId, false);

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
        await this.cleanupClient(socketId, false);
        // Small delay before reinitializing
        setTimeout(() => {
          if (this.io.sockets.sockets.has(socketId)) {
            this.initializeWhatsAppClient(socketId);
          }
        }, 3000);
      } else {
        await this.cleanupClient(socketId, true);
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

    // Configurar estado de envío
    clientData.isSendingMessages = true;
    clientData.messageQueue = numbers;
    clientData.currentMessageIndex = 0;
    clientData.stopSendingMessages = false;

    let wasAbortedPorErrorCritico = false;
    
    try {
      await this.processMessageQueue(socket, message, interval);
    } catch (error) {
      console.error(`Error en el proceso de envío para ${socketId}:`, error);
      wasAbortedPorErrorCritico = true;
      socket.emit("error", "Error durante el envío de mensajes");
    }

    // Limpiar estado de envío
    if (clientData) {
      clientData.isSendingMessages = false;
      clientData.stopSendingMessages = false;
      clientData.messageQueue = [];
      clientData.currentMessageIndex = 0;
    }

    if (!wasAbortedPorErrorCritico) {
      console.log(`📬 Finalizado envío de mensajes para ${socketId}.`);
      socket.emit("finish");
    }
  }

  async processMessageQueue(socket, message, interval) {
    const socketId = socket.id;
    const clientData = this.clients.get(socketId);

    while (clientData.currentMessageIndex < clientData.messageQueue.length) {
      // Verificar si se debe detener
      if (clientData.stopSendingMessages || clientData.isDestroying) {
        console.log(`Detención solicitada para ${socketId}`);
        break;
      }

      const number = clientData.messageQueue[clientData.currentMessageIndex];
      const currentIndex = clientData.currentMessageIndex + 1;
      const total = clientData.messageQueue.length;

      console.log(`Procesando número ${currentIndex}/${total}: ${number}`);

      // Esperar a que la conexión esté lista
      if (!await this.waitForConnection(socketId, 30000)) {
        console.error(`❌ Timeout esperando conexión para ${socketId}`);
        socket.emit("error", "Timeout de conexión. Por favor recarga la página.");
        throw new Error("Connection timeout");
      }

      if (!this.isValidNumber(number)) {
        console.warn(`Número inválido omitido: ${number}`);
        this.sendMessageReport(socket, number, false);
        clientData.currentMessageIndex++;
        continue;
      }

      try {
        await this.sendSingleMessage(clientData.sock, number, message);
        console.log(`✅ Mensaje enviado a ${number} por ${socketId}`);
        this.sendMessageReport(socket, number, true);
        
      } catch (error) {
        console.error(`❌ Error al enviar mensaje a ${number} por ${socketId}: ${error.message}`);
        this.sendMessageReport(socket, number, false);

        // Si es un error crítico, no continuar
        if (this.isCriticalConnectionError(error)) {
          console.error(`🛑 Error crítico de conexión. Abortando envío para ${socketId}`);
          socket.emit("error", "Error crítico de conexión. Por favor recarga la página.");
          throw error;
        }
      }

      clientData.currentMessageIndex++;

      // Esperar antes del siguiente mensaje si no es el último
      if (clientData.currentMessageIndex < clientData.messageQueue.length) {
        await new Promise((resolve) => setTimeout(resolve, interval * 1000));
      }
    }
  }

  async waitForConnection(socketId, timeoutMs = 30000) {
    const clientData = this.clients.get(socketId);
    if (!clientData) return false;

    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
      // Si está listo y conectado, continuar
      if (clientData.ready && clientData.connectionState === 'open') {
        return true;
      }

      // Si está reconectando, esperar
      if (clientData.reconnecting || clientData.connectionState === 'connecting') {
        console.log(`⏳ Esperando reconexión para ${socketId}...`);
        await new Promise(resolve => setTimeout(resolve, 1000));
        continue;
      }

      // Si la conexión está cerrada y no está reconectando, hay un problema
      if (clientData.connectionState === 'closed' && !clientData.reconnecting) {
        console.log(`⚠️ Conexión cerrada sin reconexión para ${socketId}`);
        return false;
      }

      // Si se debe detener, salir
      if (clientData.stopSendingMessages || clientData.isDestroying) {
        return false;
      }

      await new Promise(resolve => setTimeout(resolve, 500));
    }

    return false;
  }

  isCriticalConnectionError(error) {
    const criticalErrors = [
      "Target closed",
      "Protocol error", 
      "Connection terminated",
      "Socket is closed",
      "Rate limit exceeded",
      "Connection timeout"
    ];
    
    // No considerar "Conexión perdida", "Connection Closed", o "WebSocket" como críticos
    // ya que podemos recuperarnos de estos con reconexión
    return criticalErrors.some(criticalError => 
      error.message.includes(criticalError)
    );
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

      // Verificar que el número esté registrado en WhatsApp con timeout
      const onWhatsAppResult = await Promise.race([
        sock.onWhatsApp(formattedNumber),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Timeout verificando número')), 10000)
        )
      ]);

      const [result] = onWhatsAppResult;

      if (!result || !result.exists) {
        throw new Error(`El número ${number} no está registrado en WhatsApp`);
      }

      // Enviar el mensaje con reintentos y timeout
      let attempts = 0;
      const maxAttempts = 2; // Reducir intentos para evitar problemas

      while (attempts < maxAttempts) {
        try {
          const sentMsg = await Promise.race([
            sock.sendMessage(jid, { text: message }),
            new Promise((_, reject) => 
              setTimeout(() => reject(new Error('Timeout enviando mensaje')), 15000)
            )
          ]);
          return sentMsg;
        } catch (sendError) {
          attempts++;

          if (attempts === maxAttempts) {
            throw sendError;
          }

          // Esperar antes del siguiente intento
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      }

    } catch (error) {
      // Mejorar el mensaje de error
      if (error.message.includes('Connection Closed') || error.message.includes('WebSocket')) {
        throw new Error(`Conexión perdida con WhatsApp`);
      } else if (error.message.includes('rate-overlimit')) {
        throw new Error(`Límite de tasa excedido. Espera un momento antes de continuar.`);
      } else if (error.message.includes('Timeout')) {
        throw new Error(`Timeout al procesar número ${number}`);
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
      const clientPromises = [];
      for (const [socketId] of this.clients) {
        clientPromises.push(this.destroyWhatsAppClient(socketId));
      }
      
      await Promise.allSettled(clientPromises);

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
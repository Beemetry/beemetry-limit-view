import net from "net";

const MODBUS_PROTOCOL_VERSION = 1;
const DEFAULT_MODBUS_HOST = "0.0.0.0";
const DEFAULT_MODBUS_PORT = 1502;
const DEFAULT_MODBUS_UNIT_ID = 1;
const DEFAULT_MAX_EVENTS = 200;
const DEFAULT_MAX_PEAKS = 10;
const DEFAULT_EVENT_START_REGISTER = 200;
const DEFAULT_THRESHOLD_NAME_REGISTERS = 16; // 32 ASCII chars
const MAX_HOLDING_REGISTERS = 65535;
const HEARTBEAT_MS = 1000;

const HEADER_PROTOCOL_VERSION = 0;
const HEADER_SERVER_ONLINE = 1;
const HEADER_HEARTBEAT_HI = 2;
const HEADER_HEARTBEAT_LO = 3;
const HEADER_LAST_SEQUENCE_HI = 4;
const HEADER_LAST_SEQUENCE_LO = 5;
const HEADER_LAST_SLOT_INDEX = 6;
const HEADER_EVENT_COUNT = 7;
const HEADER_MAX_EVENTS = 8;
const HEADER_MAX_PEAKS = 9;
const HEADER_EVENT_REGISTERS = 10;
const HEADER_TOTAL_REGISTERS = 11;
const HEADER_UNIT_ID = 12;
const HEADER_CONNECTED_CLIENTS = 13;
const HEADER_COUNT = 16;

const EVENT_SEQ_OFFSET = 0; // uint32
const EVENT_YEAR_OFFSET = 2;
const EVENT_MONTH_OFFSET = 3;
const EVENT_DAY_OFFSET = 4;
const EVENT_HOUR_OFFSET = 5;
const EVENT_MINUTE_OFFSET = 6;
const EVENT_SECOND_OFFSET = 7;
const EVENT_CHANNEL_OFFSET = 8;
const EVENT_TYPE_OFFSET = 9;
const EVENT_PEAK_COUNT_OFFSET = 10;
const EVENT_RESERVED_OFFSET = 11;
const EVENT_FIXED_REGISTERS = 12;

const TYPE_CODE_MAP = {
  str: 1,
  tem: 2,
};

const parseBooleanEnv = (value, fallback = false) => {
  if (value == null) {
    return fallback;
  }
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return fallback;
};

const parseIntegerEnv = (value, fallback, min, max) => {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, parsed));
};

const clampUInt16 = (value) =>
  Math.min(0xffff, Math.max(0, Number.isFinite(value) ? Math.round(value) : 0));

const clampUInt32 = (value) =>
  Math.min(0xffffffff, Math.max(0, Number.isFinite(value) ? Math.round(value) : 0));

const writeUInt32Registers = (registers, startIndex, value) => {
  const normalized = clampUInt32(value);
  registers[startIndex] = (normalized >>> 16) & 0xffff;
  registers[startIndex + 1] = normalized & 0xffff;
};

const encodeAsciiPairRegisters = (registers, startIndex, text, registerCount) => {
  const source = String(text || "");
  const maxChars = registerCount * 2;
  const trimmed = source.slice(0, maxChars);

  for (let index = 0; index < registerCount; index += 1) {
    const charA = trimmed.charCodeAt(index * 2) || 0;
    const charB = trimmed.charCodeAt(index * 2 + 1) || 0;
    registers[startIndex + index] = ((charA & 0x7f) << 8) | (charB & 0x7f);
  }
};

const buildConfigFromEnv = () => {
  const enabled = parseBooleanEnv(process.env.MODBUS_ENABLED, false);
  const host = process.env.MODBUS_HOST || DEFAULT_MODBUS_HOST;
  const port = parseIntegerEnv(
    process.env.MODBUS_PORT,
    DEFAULT_MODBUS_PORT,
    1,
    65535
  );
  const unitId = parseIntegerEnv(
    process.env.MODBUS_UNIT_ID,
    DEFAULT_MODBUS_UNIT_ID,
    1,
    247
  );
  const maxPeaks = parseIntegerEnv(
    process.env.MODBUS_MAX_PEAKS,
    DEFAULT_MAX_PEAKS,
    1,
    120
  );
  const thresholdNameRegisters = parseIntegerEnv(
    process.env.MODBUS_THRESHOLD_NAME_REGISTERS,
    DEFAULT_THRESHOLD_NAME_REGISTERS,
    8,
    64
  );
  const eventStartRegister = parseIntegerEnv(
    process.env.MODBUS_EVENT_START_REGISTER,
    DEFAULT_EVENT_START_REGISTER,
    HEADER_COUNT,
    64000
  );

  const eventRegisters =
    EVENT_FIXED_REGISTERS + thresholdNameRegisters + maxPeaks * 2;
  const maxEventSlotsByAddress = Math.max(
    1,
    Math.floor((MAX_HOLDING_REGISTERS - eventStartRegister) / eventRegisters)
  );
  const maxEvents = parseIntegerEnv(
    process.env.MODBUS_MAX_EVENTS,
    DEFAULT_MAX_EVENTS,
    1,
    maxEventSlotsByAddress
  );
  const totalRegisters = eventStartRegister + maxEvents * eventRegisters;

  return {
    enabled,
    host,
    port,
    unitId,
    maxEvents,
    maxPeaks,
    thresholdNameRegisters,
    eventStartRegister,
    eventRegisters,
    totalRegisters,
  };
};

const state = {
  config: buildConfigFromEnv(),
  started: false,
  online: false,
  startInProgress: false,
  server: null,
  heartbeatTimer: null,
  holdingRegisters: new Uint16Array(HEADER_COUNT),
  pendingSockets: new Set(),
  connectedClients: 0,
  heartbeat: 0,
  sequence: 0,
  eventCount: 0,
  nextSlotIndex: 0,
  lastSlotIndex: -1,
  lastError: null,
};

const resetRegisterMap = (config) => {
  state.holdingRegisters = new Uint16Array(config.totalRegisters);
};

const updateHeaderRegisters = () => {
  const { config } = state;
  const registers = state.holdingRegisters;
  if (registers.length < HEADER_COUNT) {
    return;
  }

  registers[HEADER_PROTOCOL_VERSION] = MODBUS_PROTOCOL_VERSION;
  registers[HEADER_SERVER_ONLINE] = state.online ? 1 : 0;
  writeUInt32Registers(registers, HEADER_HEARTBEAT_HI, state.heartbeat);
  writeUInt32Registers(registers, HEADER_LAST_SEQUENCE_HI, state.sequence);
  registers[HEADER_LAST_SLOT_INDEX] =
    state.lastSlotIndex >= 0 ? clampUInt16(state.lastSlotIndex) : 0xffff;
  registers[HEADER_EVENT_COUNT] = clampUInt16(state.eventCount);
  registers[HEADER_MAX_EVENTS] = clampUInt16(config.maxEvents);
  registers[HEADER_MAX_PEAKS] = clampUInt16(config.maxPeaks);
  registers[HEADER_EVENT_REGISTERS] = clampUInt16(config.eventRegisters);
  registers[HEADER_TOTAL_REGISTERS] = clampUInt16(config.totalRegisters);
  registers[HEADER_UNIT_ID] = clampUInt16(config.unitId);
  registers[HEADER_CONNECTED_CLIENTS] = clampUInt16(state.connectedClients);
};

const getTypeCode = (type) => TYPE_CODE_MAP[String(type || "").toLowerCase()] || 0;

const getEventDate = (createdAt) => {
  const parsed = new Date(createdAt || Date.now());
  if (Number.isNaN(parsed.getTime())) {
    return new Date();
  }
  return parsed;
};

const normalizePeakDistances = (event, maxPeaks) => {
  const fromArray = Array.isArray(event?.peakDistances)
    ? event.peakDistances
    : Number.isFinite(event?.distance)
      ? [event.distance]
      : [];

  const unique = new Set();
  const normalized = [];
  fromArray.forEach((value) => {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) {
      return;
    }
    const rounded = Number(numeric.toFixed(3));
    const key = rounded.toFixed(3);
    if (unique.has(key)) {
      return;
    }
    unique.add(key);
    normalized.push(rounded);
  });

  return normalized.slice(0, maxPeaks);
};

const writeEventIntoRegisters = ({ event, sequence, slotIndex }) => {
  const { config } = state;
  const registers = state.holdingRegisters;
  const base =
    config.eventStartRegister + slotIndex * config.eventRegisters;
  const end = base + config.eventRegisters;
  registers.fill(0, base, end);

  const eventDate = getEventDate(event?.createdAt);
  const typeCode = getTypeCode(event?.type);
  const channelNumber = clampUInt16(Number(event?.channel));
  const peaks = normalizePeakDistances(event, config.maxPeaks);
  const thresholdName =
    typeof event?.thresholdName === "string" && event.thresholdName.trim()
      ? event.thresholdName.trim()
      : "umbral";

  writeUInt32Registers(registers, base + EVENT_SEQ_OFFSET, sequence);
  registers[base + EVENT_YEAR_OFFSET] = clampUInt16(eventDate.getFullYear());
  registers[base + EVENT_MONTH_OFFSET] = clampUInt16(eventDate.getMonth() + 1);
  registers[base + EVENT_DAY_OFFSET] = clampUInt16(eventDate.getDate());
  registers[base + EVENT_HOUR_OFFSET] = clampUInt16(eventDate.getHours());
  registers[base + EVENT_MINUTE_OFFSET] = clampUInt16(eventDate.getMinutes());
  registers[base + EVENT_SECOND_OFFSET] = clampUInt16(eventDate.getSeconds());
  registers[base + EVENT_CHANNEL_OFFSET] = channelNumber;
  registers[base + EVENT_TYPE_OFFSET] = typeCode;
  registers[base + EVENT_PEAK_COUNT_OFFSET] = clampUInt16(peaks.length);
  registers[base + EVENT_RESERVED_OFFSET] = 0;

  encodeAsciiPairRegisters(
    registers,
    base + EVENT_FIXED_REGISTERS,
    thresholdName,
    config.thresholdNameRegisters
  );

  const peaksStart = base + EVENT_FIXED_REGISTERS + config.thresholdNameRegisters;
  peaks.forEach((distanceMeters, index) => {
    const scaled = clampUInt32(Math.round(distanceMeters * 1000));
    writeUInt32Registers(registers, peaksStart + index * 2, scaled);
  });
};

const sendResponseFrame = ({ socket, transactionId, unitId, pdu }) => {
  const response = Buffer.alloc(7 + pdu.length);
  response.writeUInt16BE(transactionId, 0);
  response.writeUInt16BE(0, 2); // protocol id
  response.writeUInt16BE(1 + pdu.length, 4); // length includes unit id
  response.writeUInt8(unitId, 6);
  pdu.copy(response, 7);
  socket.write(response);
};

const sendException = ({
  socket,
  transactionId,
  unitId,
  functionCode,
  exceptionCode,
}) => {
  const pdu = Buffer.from([(functionCode | 0x80) & 0xff, exceptionCode & 0xff]);
  sendResponseFrame({
    socket,
    transactionId,
    unitId,
    pdu,
  });
};

const handleReadRegisters = ({
  socket,
  transactionId,
  unitId,
  functionCode,
  pdu,
}) => {
  if (pdu.length < 5) {
    sendException({
      socket,
      transactionId,
      unitId,
      functionCode,
      exceptionCode: 0x03,
    });
    return;
  }

  const startAddress = pdu.readUInt16BE(1);
  const quantity = pdu.readUInt16BE(3);
  if (quantity < 1 || quantity > 125) {
    sendException({
      socket,
      transactionId,
      unitId,
      functionCode,
      exceptionCode: 0x03,
    });
    return;
  }

  if (startAddress + quantity > state.holdingRegisters.length) {
    sendException({
      socket,
      transactionId,
      unitId,
      functionCode,
      exceptionCode: 0x02,
    });
    return;
  }

  const byteCount = quantity * 2;
  const responsePdu = Buffer.alloc(2 + byteCount);
  responsePdu.writeUInt8(functionCode, 0);
  responsePdu.writeUInt8(byteCount, 1);

  for (let index = 0; index < quantity; index += 1) {
    responsePdu.writeUInt16BE(
      state.holdingRegisters[startAddress + index],
      2 + index * 2
    );
  }

  sendResponseFrame({
    socket,
    transactionId,
    unitId,
    pdu: responsePdu,
  });
};

const handleRequestFrame = (socket, frame) => {
  if (frame.length < 8) {
    return;
  }

  const transactionId = frame.readUInt16BE(0);
  const protocolId = frame.readUInt16BE(2);
  const unitId = frame.readUInt8(6);
  const pdu = frame.subarray(7);
  const functionCode = pdu[0];

  if (protocolId !== 0 || !functionCode) {
    return;
  }

  if (unitId !== state.config.unitId) {
    sendException({
      socket,
      transactionId,
      unitId,
      functionCode,
      exceptionCode: 0x0b,
    });
    return;
  }

  if (functionCode === 0x03 || functionCode === 0x04) {
    handleReadRegisters({
      socket,
      transactionId,
      unitId,
      functionCode,
      pdu,
    });
    return;
  }

  sendException({
    socket,
    transactionId,
    unitId,
    functionCode,
    exceptionCode: 0x01,
  });
};

const attachSocketHandlers = (socket) => {
  state.connectedClients += 1;
  updateHeaderRegisters();
  state.pendingSockets.add(socket);

  let pending = Buffer.alloc(0);
  socket.on("data", (chunk) => {
    pending = Buffer.concat([pending, chunk]);
    while (pending.length >= 7) {
      const bodyLength = pending.readUInt16BE(4);
      const frameLength = 6 + bodyLength;
      if (frameLength <= 0 || pending.length < frameLength) {
        break;
      }
      const frame = pending.subarray(0, frameLength);
      pending = pending.subarray(frameLength);
      handleRequestFrame(socket, frame);
    }
  });

  socket.on("error", () => {
    // Ignore per-connection transport errors; status is tracked on server-level.
  });

  socket.on("close", () => {
    state.pendingSockets.delete(socket);
    state.connectedClients = Math.max(0, state.connectedClients - 1);
    updateHeaderRegisters();
  });
};

const startHeartbeat = () => {
  if (state.heartbeatTimer) {
    clearInterval(state.heartbeatTimer);
  }

  state.heartbeatTimer = setInterval(() => {
    state.heartbeat = (state.heartbeat + 1) >>> 0;
    updateHeaderRegisters();
  }, HEARTBEAT_MS);
};

const stopHeartbeat = () => {
  if (!state.heartbeatTimer) {
    return;
  }
  clearInterval(state.heartbeatTimer);
  state.heartbeatTimer = null;
};

const closeServer = () =>
  new Promise((resolve) => {
    if (!state.server) {
      resolve();
      return;
    }
    state.server.close(() => {
      resolve();
    });
  });

export const getModbusPublisherStatus = () => ({
  enabled: state.config.enabled,
  started: state.started,
  online: state.online,
  host: state.config.host,
  port: state.config.port,
  unitId: state.config.unitId,
  maxEvents: state.config.maxEvents,
  maxPeaks: state.config.maxPeaks,
  eventRegisters: state.config.eventRegisters,
  eventStartRegister: state.config.eventStartRegister,
  totalRegisters: state.config.totalRegisters,
  eventCount: state.eventCount,
  sequence: state.sequence,
  lastSlotIndex: state.lastSlotIndex,
  connectedClients: state.connectedClients,
  lastError: state.lastError,
});

export const startModbusEventPublisherFromEnv = async () => {
  state.config = buildConfigFromEnv();
  if (!state.config.enabled) {
    state.started = false;
    state.online = false;
    state.lastError = null;
    resetRegisterMap(state.config);
    updateHeaderRegisters();
    return getModbusPublisherStatus();
  }

  if (state.startInProgress || state.online) {
    return getModbusPublisherStatus();
  }

  state.startInProgress = true;
  state.lastError = null;
  resetRegisterMap(state.config);
  updateHeaderRegisters();

  const server = net.createServer((socket) => {
    attachSocketHandlers(socket);
  });
  state.server = server;

  server.on("error", (error) => {
    state.lastError = error?.message || String(error);
    state.online = false;
    updateHeaderRegisters();
  });

  await new Promise((resolve) => {
    server.listen(state.config.port, state.config.host, () => {
      state.online = true;
      state.started = true;
      startHeartbeat();
      updateHeaderRegisters();
      resolve();
    });
    server.once("error", () => {
      resolve();
    });
  });

  state.startInProgress = false;
  return getModbusPublisherStatus();
};

export const stopModbusEventPublisher = async () => {
  state.startInProgress = false;
  state.started = false;
  stopHeartbeat();

  state.pendingSockets.forEach((socket) => {
    try {
      socket.destroy();
    } catch {
      // ignore close errors
    }
  });
  state.pendingSockets.clear();
  state.connectedClients = 0;
  state.online = false;

  await closeServer();
  state.server = null;
  updateHeaderRegisters();
  return getModbusPublisherStatus();
};

export const publishModbusPeakEvent = (event) => {
  if (!state.config.enabled || !state.online) {
    return false;
  }

  let nextSequence = (state.sequence + 1) >>> 0;
  if (nextSequence === 0) {
    nextSequence = 1;
  }

  const slotIndex = state.nextSlotIndex;
  writeEventIntoRegisters({
    event,
    sequence: nextSequence,
    slotIndex,
  });

  state.sequence = nextSequence;
  state.lastSlotIndex = slotIndex;
  state.nextSlotIndex = (slotIndex + 1) % state.config.maxEvents;
  state.eventCount = Math.min(state.eventCount + 1, state.config.maxEvents);
  updateHeaderRegisters();
  return true;
};

import net from "net";

const DEFAULT_MODBUS_HOST = "0.0.0.0";
const DEFAULT_MODBUS_PORT = 1502;
const DEFAULT_MODBUS_UNIT_ID = 1;
const DEFAULT_MAX_PENDING_BATCHES = 200;
const DEFAULT_FIBER_LENGTH_DM = 10000;
const DEFAULT_SPATIAL_RES_DM = 1;
const DEFAULT_TOTAL_POINTS = 10000;

// 40001..40240 => 240 holding registers (0-based index = address - 40001)
const HOLDING_REGISTER_COUNT = 240;
const BLOCK_STATUS_START = 0; // 40001
const BLOCK_CONTROL_START = 10; // 40011
const BLOCK_SUMMARY_START = 20; // 40021 (reserved in this implementation)
const BLOCK_ALARM_START = 30; // 40031

const IDX_SYSTEM_STATUS = BLOCK_STATUS_START + 0;
const IDX_FIBER_LENGTH_DM = BLOCK_STATUS_START + 1;
const IDX_SPATIAL_RES_DM = BLOCK_STATUS_START + 2;
const IDX_TOTAL_POINTS = BLOCK_STATUS_START + 3;
const IDX_LAST_SCAN_YEAR = BLOCK_STATUS_START + 4;
const IDX_LAST_SCAN_MONTH = BLOCK_STATUS_START + 5;
const IDX_LAST_SCAN_DAY = BLOCK_STATUS_START + 6;
const IDX_LAST_SCAN_HOUR = BLOCK_STATUS_START + 7;
const IDX_LAST_SCAN_MINUTE = BLOCK_STATUS_START + 8;
const IDX_LAST_SCAN_SECOND = BLOCK_STATUS_START + 9;

const IDX_NEW_DATA_READY = BLOCK_CONTROL_START + 0;
const IDX_CLEAR_ALL_CMD = BLOCK_CONTROL_START + 1;
const IDX_BUFFER_STATE = BLOCK_CONTROL_START + 2;
const IDX_BUFFER_SEQUENCE = BLOCK_CONTROL_START + 3;
const IDX_TOTAL_ACTIVE_ALARMS = BLOCK_CONTROL_START + 4;
const IDX_TOTAL_TEMP_HIGH = BLOCK_CONTROL_START + 5;
const IDX_TOTAL_TEMP_LOW = BLOCK_CONTROL_START + 6;
const IDX_TOTAL_STRAIN_HIGH = BLOCK_CONTROL_START + 7;
const IDX_TOTAL_STRAIN_LOW = BLOCK_CONTROL_START + 8;
const IDX_RESERVED_40020 = BLOCK_CONTROL_START + 9;

const ALARM_SLOT_COUNT = 10;
const ALARM_SLOT_SIZE = 21;

const ALARM_STATUS_OFFSET = 0;
const ALARM_ID_OFFSET = 1;
const ALARM_TYPE_OFFSET = 2;
const ALARM_START_DM_OFFSET = 3;
const ALARM_END_DM_OFFSET = 4;
const ALARM_TEMP_MAX_X10_OFFSET = 5;
const ALARM_TEMP_MIN_X10_OFFSET = 6;
const ALARM_STRAIN_MAX_X10_OFFSET = 7;
const ALARM_STRAIN_MIN_X10_OFFSET = 8;
const ALARM_START_TS_OFFSET = 9;
const ALARM_UPDATE_TS_OFFSET = 15;

const SYSTEM_STATUS_NO_DATA = 0;
const SYSTEM_STATUS_NORMAL = 1;
const SYSTEM_STATUS_ALARMS_ACTIVE = 2;
const SYSTEM_STATUS_FAULT = 3;

const BUFFER_STATE_EMPTY = 0;
const BUFFER_STATE_LOADED = 1;

const ALARM_STATUS_EMPTY = 0;
const ALARM_STATUS_ACTIVE = 1;

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

const encodeSignedScaledX10 = (value) => {
  const scaled = Number.isFinite(value) ? Math.round(value * 10) : 0;
  const clamped = Math.max(-32768, Math.min(32767, scaled));
  return clamped < 0 ? 0x10000 + clamped : clamped;
};

const toAlarmTypeCode = (value) => {
  const numeric = Number(value);
  if ([1, 2, 3, 4].includes(numeric)) {
    return numeric;
  }
  return 0;
};

const parseDateLike = (value) => {
  const parsed = new Date(value || Date.now());
  if (Number.isNaN(parsed.getTime())) {
    return new Date();
  }
  return parsed;
};

const writeTimestampRegisters = (registers, startIndex, dateLike) => {
  const dateValue = parseDateLike(dateLike);
  registers[startIndex + 0] = clampUInt16(dateValue.getFullYear());
  registers[startIndex + 1] = clampUInt16(dateValue.getMonth() + 1);
  registers[startIndex + 2] = clampUInt16(dateValue.getDate());
  registers[startIndex + 3] = clampUInt16(dateValue.getHours());
  registers[startIndex + 4] = clampUInt16(dateValue.getMinutes());
  registers[startIndex + 5] = clampUInt16(dateValue.getSeconds());
};

const buildConfigFromEnv = () => ({
  enabled: parseBooleanEnv(process.env.MODBUS_ENABLED, false),
  host: process.env.MODBUS_HOST || DEFAULT_MODBUS_HOST,
  port: parseIntegerEnv(process.env.MODBUS_PORT, DEFAULT_MODBUS_PORT, 1, 65535),
  unitId: parseIntegerEnv(process.env.MODBUS_UNIT_ID, DEFAULT_MODBUS_UNIT_ID, 1, 247),
  maxPendingBatches: parseIntegerEnv(
    process.env.MODBUS_MAX_PENDING_BATCHES,
    DEFAULT_MAX_PENDING_BATCHES,
    1,
    5000
  ),
  fiberLengthDm: parseIntegerEnv(
    process.env.FIBER_LENGTH_DM,
    DEFAULT_FIBER_LENGTH_DM,
    1,
    200000
  ),
  spatialResDm: parseIntegerEnv(
    process.env.FIBER_SPATIAL_RES_DM,
    DEFAULT_SPATIAL_RES_DM,
    1,
    1000
  ),
  totalPoints: parseIntegerEnv(
    process.env.FIBER_TOTAL_POINTS,
    DEFAULT_TOTAL_POINTS,
    1,
    1000000
  ),
});

const state = {
  config: buildConfigFromEnv(),
  started: false,
  online: false,
  startInProgress: false,
  server: null,
  holdingRegisters: new Uint16Array(HOLDING_REGISTER_COUNT),
  pendingSockets: new Set(),
  connectedClients: 0,
  bufferSequence: 0,
  pendingBatches: [],
  lastError: null,
};

const getAlarmSlotBaseIndex = (slotIndex) =>
  BLOCK_ALARM_START + slotIndex * ALARM_SLOT_SIZE;

const clearAlarmTableRegisters = () => {
  state.holdingRegisters.fill(0, BLOCK_ALARM_START, HOLDING_REGISTER_COUNT);
};

const applyStaticRegisters = () => {
  const registers = state.holdingRegisters;
  registers[IDX_FIBER_LENGTH_DM] = clampUInt16(state.config.fiberLengthDm);
  registers[IDX_SPATIAL_RES_DM] = clampUInt16(state.config.spatialResDm);
  registers[IDX_TOTAL_POINTS] = clampUInt16(state.config.totalPoints);
  registers[IDX_RESERVED_40020] = 0;
  registers.fill(0, BLOCK_SUMMARY_START, BLOCK_ALARM_START);
};

const resetRegisterMap = () => {
  state.holdingRegisters = new Uint16Array(HOLDING_REGISTER_COUNT);
  clearAlarmTableRegisters();
  applyStaticRegisters();
  state.holdingRegisters[IDX_SYSTEM_STATUS] = SYSTEM_STATUS_NO_DATA;
  state.holdingRegisters[IDX_NEW_DATA_READY] = 0;
  state.holdingRegisters[IDX_CLEAR_ALL_CMD] = 0;
  state.holdingRegisters[IDX_BUFFER_STATE] = BUFFER_STATE_EMPTY;
  state.holdingRegisters[IDX_BUFFER_SEQUENCE] = clampUInt16(state.bufferSequence);
  state.holdingRegisters[IDX_TOTAL_ACTIVE_ALARMS] = 0;
  state.holdingRegisters[IDX_TOTAL_TEMP_HIGH] = 0;
  state.holdingRegisters[IDX_TOTAL_TEMP_LOW] = 0;
  state.holdingRegisters[IDX_TOTAL_STRAIN_HIGH] = 0;
  state.holdingRegisters[IDX_TOTAL_STRAIN_LOW] = 0;
};

const normalizeAlarmRecord = (alarm) => {
  const startDmRaw = Number(alarm?.startDm);
  const endDmRaw = Number(alarm?.endDm);
  const hasStart = Number.isFinite(startDmRaw);
  const hasEnd = Number.isFinite(endDmRaw);
  const normalizedStart = hasStart
    ? hasEnd
      ? Math.min(startDmRaw, endDmRaw)
      : startDmRaw
    : 0;
  const normalizedEnd = hasEnd
    ? hasStart
      ? Math.max(startDmRaw, endDmRaw)
      : endDmRaw
    : normalizedStart;
  const startDm = clampUInt16(
    normalizedStart
  );
  const endDm = clampUInt16(normalizedEnd);

  return {
    alarmType: toAlarmTypeCode(alarm?.alarmType),
    startDm,
    endDm,
    tempMax: Number(alarm?.tempMax),
    tempMin: Number(alarm?.tempMin),
    strainMax: Number(alarm?.strainMax),
    strainMin: Number(alarm?.strainMin),
    startAt: alarm?.startAt,
    updatedAt: alarm?.updatedAt,
  };
};

const writeAlarmSlot = ({
  slotIndex,
  alarmId,
  alarmType,
  startDm,
  endDm,
  tempMax,
  tempMin,
  strainMax,
  strainMin,
  startAt,
  updatedAt,
}) => {
  if (slotIndex < 0 || slotIndex >= ALARM_SLOT_COUNT) {
    return;
  }
  const registers = state.holdingRegisters;
  const base = getAlarmSlotBaseIndex(slotIndex);
  registers.fill(0, base, base + ALARM_SLOT_SIZE);

  registers[base + ALARM_STATUS_OFFSET] = ALARM_STATUS_ACTIVE;
  registers[base + ALARM_ID_OFFSET] = clampUInt16(alarmId);
  registers[base + ALARM_TYPE_OFFSET] = clampUInt16(alarmType);
  registers[base + ALARM_START_DM_OFFSET] = clampUInt16(startDm);
  registers[base + ALARM_END_DM_OFFSET] = clampUInt16(endDm);
  registers[base + ALARM_TEMP_MAX_X10_OFFSET] = encodeSignedScaledX10(tempMax);
  registers[base + ALARM_TEMP_MIN_X10_OFFSET] = encodeSignedScaledX10(tempMin);
  registers[base + ALARM_STRAIN_MAX_X10_OFFSET] = encodeSignedScaledX10(strainMax);
  registers[base + ALARM_STRAIN_MIN_X10_OFFSET] = encodeSignedScaledX10(strainMin);
  writeTimestampRegisters(registers, base + ALARM_START_TS_OFFSET, startAt);
  writeTimestampRegisters(registers, base + ALARM_UPDATE_TS_OFFSET, updatedAt);
};

const clearHandshakeRegisters = ({ keepSequence = true } = {}) => {
  const registers = state.holdingRegisters;
  registers[IDX_NEW_DATA_READY] = 0;
  registers[IDX_CLEAR_ALL_CMD] = 0;
  registers[IDX_BUFFER_STATE] = BUFFER_STATE_EMPTY;
  registers[IDX_TOTAL_ACTIVE_ALARMS] = 0;
  registers[IDX_TOTAL_TEMP_HIGH] = 0;
  registers[IDX_TOTAL_TEMP_LOW] = 0;
  registers[IDX_TOTAL_STRAIN_HIGH] = 0;
  registers[IDX_TOTAL_STRAIN_LOW] = 0;
  if (!keepSequence) {
    state.bufferSequence = 0;
  }
  registers[IDX_BUFFER_SEQUENCE] = clampUInt16(state.bufferSequence);
};

const isTableFrozen = () =>
  state.holdingRegisters[IDX_NEW_DATA_READY] === 1 &&
  state.holdingRegisters[IDX_BUFFER_STATE] === BUFFER_STATE_LOADED;

const loadAlarmBatchInternal = (batch) => {
  const alarms = Array.isArray(batch?.alarms) ? batch.alarms : [];
  if (alarms.length === 0) {
    return {
      accepted: false,
      queued: false,
      reason: "empty",
      queueSize: state.pendingBatches.length,
    };
  }

  const normalized = alarms
    .map(normalizeAlarmRecord)
    .filter((alarm) => alarm.alarmType > 0)
    .slice(0, ALARM_SLOT_COUNT);

  if (normalized.length === 0) {
    return {
      accepted: false,
      queued: false,
      reason: "invalid",
      queueSize: state.pendingBatches.length,
    };
  }

  const scanAt = parseDateLike(batch?.scanAt);
  const timestamp = scanAt.toISOString();

  clearAlarmTableRegisters();
  writeTimestampRegisters(state.holdingRegisters, IDX_LAST_SCAN_YEAR, timestamp);

  let tempHigh = 0;
  let tempLow = 0;
  let strainHigh = 0;
  let strainLow = 0;

  normalized.forEach((alarm, slotIndex) => {
    if (alarm.alarmType === 1) tempHigh += 1;
    if (alarm.alarmType === 2) tempLow += 1;
    if (alarm.alarmType === 3) strainHigh += 1;
    if (alarm.alarmType === 4) strainLow += 1;

    writeAlarmSlot({
      slotIndex,
      alarmId: slotIndex + 1,
      alarmType: alarm.alarmType,
      startDm: alarm.startDm,
      endDm: alarm.endDm,
      tempMax: alarm.tempMax,
      tempMin: alarm.tempMin,
      strainMax: alarm.strainMax,
      strainMin: alarm.strainMin,
      startAt: alarm.startAt || timestamp,
      updatedAt: alarm.updatedAt || timestamp,
    });
  });

  state.bufferSequence = (state.bufferSequence + 1) & 0xffff;
  if (state.bufferSequence === 0) {
    state.bufferSequence = 1;
  }

  state.holdingRegisters[IDX_SYSTEM_STATUS] = SYSTEM_STATUS_ALARMS_ACTIVE;
  state.holdingRegisters[IDX_NEW_DATA_READY] = 1;
  state.holdingRegisters[IDX_CLEAR_ALL_CMD] = 0;
  state.holdingRegisters[IDX_BUFFER_STATE] = BUFFER_STATE_LOADED;
  state.holdingRegisters[IDX_BUFFER_SEQUENCE] = clampUInt16(state.bufferSequence);
  state.holdingRegisters[IDX_TOTAL_ACTIVE_ALARMS] = clampUInt16(normalized.length);
  state.holdingRegisters[IDX_TOTAL_TEMP_HIGH] = clampUInt16(tempHigh);
  state.holdingRegisters[IDX_TOTAL_TEMP_LOW] = clampUInt16(tempLow);
  state.holdingRegisters[IDX_TOTAL_STRAIN_HIGH] = clampUInt16(strainHigh);
  state.holdingRegisters[IDX_TOTAL_STRAIN_LOW] = clampUInt16(strainLow);

  return {
    accepted: true,
    queued: false,
    reason: null,
    queueSize: state.pendingBatches.length,
    loadedCount: normalized.length,
  };
};

const dequeueAndLoadIfAvailable = () => {
  if (isTableFrozen()) {
    return;
  }
  const nextBatch = state.pendingBatches.shift();
  if (!nextBatch) {
    return;
  }
  const outcome = loadAlarmBatchInternal(nextBatch);
  if (!outcome.accepted) {
    state.lastError = `queued batch rejected: ${outcome.reason || "unknown"}`;
  }
};

const clearLoadedAlarmData = () => {
  clearAlarmTableRegisters();
  clearHandshakeRegisters({ keepSequence: true });
  state.holdingRegisters[IDX_SYSTEM_STATUS] = SYSTEM_STATUS_NORMAL;
};

const enqueueBatch = (batch) => {
  if (state.pendingBatches.length >= state.config.maxPendingBatches) {
    state.pendingBatches.shift();
  }
  state.pendingBatches.push(batch);
};

const applyWriteCommand = ({ startAddress, values }) => {
  if (startAddress !== IDX_CLEAR_ALL_CMD || values.length !== 1) {
    return { ok: false, exceptionCode: 0x02 };
  }

  const writeValue = clampUInt16(values[0]);
  if (writeValue === 1) {
    state.holdingRegisters[IDX_CLEAR_ALL_CMD] = 1;
    clearLoadedAlarmData();
    state.holdingRegisters[IDX_CLEAR_ALL_CMD] = 0;
    dequeueAndLoadIfAvailable();
    return { ok: true };
  }

  // Accept write 0 as no-op reset.
  state.holdingRegisters[IDX_CLEAR_ALL_CMD] = 0;
  return { ok: true };
};

const sendResponseFrame = ({ socket, transactionId, unitId, pdu }) => {
  const response = Buffer.alloc(7 + pdu.length);
  response.writeUInt16BE(transactionId, 0);
  response.writeUInt16BE(0, 2);
  response.writeUInt16BE(1 + pdu.length, 4);
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
  sendResponseFrame({ socket, transactionId, unitId, pdu });
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
  sendResponseFrame({ socket, transactionId, unitId, pdu: responsePdu });
};

const handleWriteSingleRegister = ({
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

  const address = pdu.readUInt16BE(1);
  const value = pdu.readUInt16BE(3);
  const result = applyWriteCommand({
    startAddress: address,
    values: [value],
  });
  if (!result.ok) {
    sendException({
      socket,
      transactionId,
      unitId,
      functionCode,
      exceptionCode: result.exceptionCode || 0x04,
    });
    return;
  }

  const responsePdu = Buffer.from(pdu.subarray(0, 5));
  sendResponseFrame({ socket, transactionId, unitId, pdu: responsePdu });
};

const handleWriteMultipleRegisters = ({
  socket,
  transactionId,
  unitId,
  functionCode,
  pdu,
}) => {
  if (pdu.length < 6) {
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
  const byteCount = pdu.readUInt8(5);
  if (quantity < 1 || quantity > 123 || byteCount !== quantity * 2) {
    sendException({
      socket,
      transactionId,
      unitId,
      functionCode,
      exceptionCode: 0x03,
    });
    return;
  }

  if (pdu.length < 6 + byteCount) {
    sendException({
      socket,
      transactionId,
      unitId,
      functionCode,
      exceptionCode: 0x03,
    });
    return;
  }

  const values = [];
  for (let index = 0; index < quantity; index += 1) {
    values.push(pdu.readUInt16BE(6 + index * 2));
  }

  const result = applyWriteCommand({
    startAddress,
    values,
  });
  if (!result.ok) {
    sendException({
      socket,
      transactionId,
      unitId,
      functionCode,
      exceptionCode: result.exceptionCode || 0x04,
    });
    return;
  }

  const responsePdu = Buffer.alloc(5);
  responsePdu.writeUInt8(functionCode, 0);
  responsePdu.writeUInt16BE(startAddress, 1);
  responsePdu.writeUInt16BE(quantity, 3);
  sendResponseFrame({ socket, transactionId, unitId, pdu: responsePdu });
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
  if (functionCode === 0x06) {
    handleWriteSingleRegister({
      socket,
      transactionId,
      unitId,
      functionCode,
      pdu,
    });
    return;
  }
  if (functionCode === 0x10) {
    handleWriteMultipleRegisters({
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
    // ignore per-connection errors
  });

  socket.on("close", () => {
    state.pendingSockets.delete(socket);
    state.connectedClients = Math.max(0, state.connectedClients - 1);
  });
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
  mapStart: 40001,
  mapEnd: 40240,
  totalRegisters: HOLDING_REGISTER_COUNT,
  alarmSlotCount: ALARM_SLOT_COUNT,
  alarmSlotSize: ALARM_SLOT_SIZE,
  systemStatus: state.holdingRegisters[IDX_SYSTEM_STATUS],
  newDataReady: state.holdingRegisters[IDX_NEW_DATA_READY],
  bufferState: state.holdingRegisters[IDX_BUFFER_STATE],
  bufferSequence: state.holdingRegisters[IDX_BUFFER_SEQUENCE],
  totalActiveAlarms: state.holdingRegisters[IDX_TOTAL_ACTIVE_ALARMS],
  pendingBatches: state.pendingBatches.length,
  maxPendingBatches: state.config.maxPendingBatches,
  connectedClients: state.connectedClients,
  lastError: state.lastError,
});

export const startModbusEventPublisherFromEnv = async () => {
  state.config = buildConfigFromEnv();
  if (!state.config.enabled) {
    state.started = false;
    state.online = false;
    state.lastError = null;
    state.bufferSequence = 0;
    state.pendingBatches = [];
    resetRegisterMap();
    return getModbusPublisherStatus();
  }

  if (state.startInProgress || state.online) {
    return getModbusPublisherStatus();
  }

  state.startInProgress = true;
  state.lastError = null;
  state.pendingBatches = [];
  state.bufferSequence = 0;
  resetRegisterMap();

  const server = net.createServer((socket) => {
    attachSocketHandlers(socket);
  });
  state.server = server;

  server.on("error", (error) => {
    state.lastError = error?.message || String(error);
    state.online = false;
    state.holdingRegisters[IDX_SYSTEM_STATUS] = SYSTEM_STATUS_FAULT;
  });

  await new Promise((resolve) => {
    server.listen(state.config.port, state.config.host, () => {
      state.online = true;
      state.started = true;
      if (state.holdingRegisters[IDX_SYSTEM_STATUS] === SYSTEM_STATUS_NO_DATA) {
        state.holdingRegisters[IDX_SYSTEM_STATUS] = SYSTEM_STATUS_NORMAL;
      }
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

  state.pendingSockets.forEach((socket) => {
    try {
      socket.destroy();
    } catch {
      // ignore
    }
  });
  state.pendingSockets.clear();
  state.connectedClients = 0;
  state.online = false;
  state.pendingBatches = [];

  await closeServer();
  state.server = null;
  return getModbusPublisherStatus();
};

export const loadModbusAlarmBatch = (batch) => {
  if (!state.config.enabled || !state.online) {
    return {
      accepted: false,
      queued: false,
      reason: "offline",
      queueSize: state.pendingBatches.length,
    };
  }

  if (isTableFrozen()) {
    enqueueBatch(batch);
    return {
      accepted: false,
      queued: true,
      reason: "frozen",
      queueSize: state.pendingBatches.length,
    };
  }

  return loadAlarmBatchInternal(batch);
};

// Backward compatibility while callers migrate.
export const publishModbusPeakEvent = (event) => {
  const variableType = String(event?.type || "").toLowerCase();
  const alarmType = variableType === "str" ? 3 : 1;
  const fallbackDistance = Number(event?.distance);
  const rangeSource = Array.isArray(event?.peakRanges)
    ? event.peakRanges
    : Array.isArray(event?.peakDistances)
      ? event.peakDistances.map((distance) => ({
          startDistance: Number(distance),
          endDistance: Number(distance),
        }))
      : Number.isFinite(fallbackDistance)
        ? [{ startDistance: fallbackDistance, endDistance: fallbackDistance }]
        : [];

  const alarms = rangeSource
    .map((range) => ({
      alarmType,
      startDm: Math.round(Number(range?.startDistance) * 10),
      endDm: Math.round(Number(range?.endDistance) * 10),
      tempMax: variableType === "tem" ? Number(event?.measuredValue) : 0,
      tempMin: variableType === "tem" ? Number(event?.thresholdValue) : 0,
      strainMax: variableType === "str" ? Number(event?.measuredValue) : 0,
      strainMin: variableType === "str" ? Number(event?.thresholdValue) : 0,
      startAt: event?.createdAt,
      updatedAt: event?.createdAt,
    }))
    .filter(
      (alarm) => Number.isFinite(alarm.startDm) && Number.isFinite(alarm.endDm)
    );

  return loadModbusAlarmBatch({
    scanAt: event?.createdAt,
    alarms,
  }).accepted;
};

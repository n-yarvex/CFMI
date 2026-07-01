import { connect as cloudflareConnect } from 'cloudflare:sockets';
const PEER_UUID = 'ca6a7a70-4d44-433f-b727-1ed22ae7bf23';
const FALLBACK_HOST = 'ProxyIP.US.CMLiussss.net';
const TUNNEL_CFG = {
  READ_BUFFER_SIZE: 128 * 1024,
  DOWN_BATCH_SIZE: 64 * 1024,
  DOWN_TAIL_THRESHOLD: 256,
  DOWN_FLUSH_DELAY: 1,
  UP_BATCH_SIZE: 32 * 1024,
  UP_QUEUE_LIMIT: 128 * 1024,
  CONNECTION_RACE_COUNT: 3,
};
function base64UrlToBytes(header) {
  if (!header) return null;
  try {
    const raw = atob(header.replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from(raw, c => c.charCodeAt(0));
  } catch (_) {
    return null;
  }
}
function createCoalescingQueue(maxBatchSize, maxQueueBytes = maxBatchSize, maxItems = Math.max(1, maxQueueBytes >> 8)) {
  let items = [];
  let head = 0;
  let totalBytes = 0;
  let batchBuffer = null;
  function trim() {
    if (head > 32 && head * 2 >= items.length) {
      items = items.slice(head);
      head = 0;
    }
  }
  function pop() {
    if (head >= items.length) return null;
    const chunk = items[head];
    items[head++] = undefined;
    totalBytes -= chunk.byteLength;
    trim();
    return chunk;
  }
  return {
    get byteCount() {
      return totalBytes;
    },
    get length() {
      return items.length - head;
    },
    get isEmpty() {
      return head >= items.length;
    },
    reset() {
      items = [];
      head = 0;
      totalBytes = 0;
    },
    push(chunk) {
      const size = chunk?.byteLength || 0;
      if (!size) return 1;
      if (totalBytes + size > maxQueueBytes || (items.length - head) >= maxItems) return 0;
      items.push(chunk);
      totalBytes += size;
      return 1;
    },
    pop,
    batch(firstChunk) {
      if (firstChunk === undefined) firstChunk = pop();
      if (!firstChunk || head >= items.length || firstChunk.byteLength >= maxBatchSize) {
        return [firstChunk, 0];
      }
      let combinedSize = firstChunk.byteLength;
      let end = head;
      while (end < items.length) {
        const next = items[end];
        const nextSize = combinedSize + next.byteLength;
        if (nextSize > maxBatchSize) break;
        combinedSize = nextSize;
        end++;
      }
      if (end === head) return [firstChunk, 0];
      const buffer = batchBuffer ||= new Uint8Array(maxBatchSize);
      buffer.set(firstChunk);
      let offset = firstChunk.byteLength;
      while (head < end) {
        const next = items[head];
        items[head++] = undefined;
        totalBytes -= next.byteLength;
        buffer.set(next, offset);
        offset += next.byteLength;
      }
      trim();
      return [buffer.subarray(0, combinedSize), 1];
    },
  };
}
function createDownstreamBuffer(webSocket) {
  const batchSize = TUNNEL_CFG.DOWN_BATCH_SIZE;
  const tailThreshold = TUNNEL_CFG.DOWN_TAIL_THRESHOLD;
  const flushThreshold = Math.max(4096, tailThreshold << 3);
  let buffer = new Uint8Array(batchSize);
  let pos = 0;
  let flushTimer = 0;
  let microtaskScheduled = 0;
  let addCounter = 0;
  let addSnapshot = 0;
  let retryCount = 0;
  function flush() {
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = 0;
    microtaskScheduled = 0;
    if (!pos) return;
    webSocket.send(buffer.subarray(0, pos));
    buffer = new Uint8Array(batchSize);
    pos = 0;
    retryCount = 0;
  }
  function scheduleFlush() {
    if (flushTimer || microtaskScheduled) return;
    microtaskScheduled = 1;
    addSnapshot = addCounter;
    queueMicrotask(() => {
      microtaskScheduled = 0;
      if (!pos || flushTimer) return;
      if (batchSize - pos < tailThreshold) return flush();
      flushTimer = setTimeout(() => {
        flushTimer = 0;
        if (!pos) return;
        if (batchSize - pos < tailThreshold) return flush();
        if (retryCount < 2 && (addCounter !== addSnapshot || pos < flushThreshold)) {
          retryCount++;
          addSnapshot = addCounter;
          return scheduleFlush();
        }
        flush();
      }, Math.max(TUNNEL_CFG.DOWN_FLUSH_DELAY, 1));
    });
  }
  return {
    add(chunk) {
      let offset = 0;
      const len = chunk?.byteLength || 0;
      if (!len) return;
      while (offset < len) {
        if (!pos && len - offset >= batchSize) {
          const partSize = Math.min(batchSize, len - offset);
          webSocket.send(offset || partSize !== len ? chunk.subarray(offset, offset + partSize) : chunk);
          offset += partSize;
          continue;
        }
        const partSize = Math.min(batchSize - pos, len - offset);
        buffer.set(chunk.subarray(offset, offset + partSize), pos);
        pos += partSize;
        offset += partSize;
        addCounter++;
        if (pos === batchSize || batchSize - pos < tailThreshold) {
          flush();
        } else {
          scheduleFlush();
        }
      }
    },
    flush,
  };
}
async function pipeSocketToWebSocket(readable, webSocket) {
  const reader = readable.getReader({ mode: 'byob' });
  const downstream = createDownstreamBuffer(webSocket);
  let buf = new ArrayBuffer(TUNNEL_CFG.READ_BUFFER_SIZE);
  try {
    for (;;) {
      const { done, value } = await reader.read(new Uint8Array(buf, 0, TUNNEL_CFG.READ_BUFFER_SIZE));
      if (done) break;
      if (!value?.byteLength) continue;
      if (value.byteLength >= (TUNNEL_CFG.READ_BUFFER_SIZE >> 1)) {
        downstream.flush();
        webSocket.send(value);
        buf = new ArrayBuffer(TUNNEL_CFG.READ_BUFFER_SIZE);
      } else {
        downstream.add(value.slice());
        buf = value.buffer;
      }
    }
    downstream.flush();
  } catch (_) {
    downstream.flush();
  } finally {
    try { reader.releaseLock(); } catch (_) {}
  }
}
function parseInitialMessage(packet) {
  if (packet.length < 19) throw new Error('Invalid packet');
  const uuidHex = [...packet.slice(1, 17)]
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
  if (uuidHex !== PEER_UUID.replace(/-/g, '')) throw new Error('UUID mismatch');
  const addressLength = packet[17];
  let offset = 18 + addressLength + 1;
  const port = (packet[offset] << 8) | packet[offset + 1];
  offset += 2;
  const addrType = packet[offset++];
  let hostname = '';
  if (addrType === 1) {
    hostname = [...packet.slice(offset, offset + 4)].join('.');
    offset += 4;
  } else if (addrType === 2) {
    const len = packet[offset++];
    hostname = new TextDecoder().decode(packet.slice(offset, offset + len));
    offset += len;
  } else if (addrType === 3) {
    const raw = packet.slice(offset, offset + 16);
    hostname = [...Array(8)]
      .map((_, idx) => ((raw[idx * 2] << 8) | raw[idx * 2 + 1]).toString(16))
      .join(':');
    offset += 16;
  } else {
    throw new Error('Unknown address type');
  }
  const payload = packet.slice(offset);
  return { hostname, port, payload };
}
function createConnection(hostname, port, initialData) {
  const socket = cloudflareConnect({ hostname, port });
  return new Promise((resolve, reject) => {
    socket.opened.then(() => {
      if (initialData?.byteLength) {
        const writer = socket.writable.getWriter();
        writer.write(initialData).then(() => {
          writer.releaseLock();
          resolve(socket);
        }).catch(reject);
      } else {
        resolve(socket);
      }
    }).catch(reject);
  });
}
function raceConnections(hostname, port, initialData) {
  const raceCount = TUNNEL_CFG.CONNECTION_RACE_COUNT;
  if (raceCount <= 1) return createConnection(hostname, port, initialData);
  const attempts = Array(raceCount).fill().map(() => createConnection(hostname, port, initialData));
  return Promise.any(attempts).then(winner => {
    attempts.forEach(p => p.then(s => { if (s !== winner) s.close(); }).catch(() => {}));
    return winner;
  });
}
export default {
  async fetch(request) {
    const upgrade = (request.headers.get('upgrade') || '').toLowerCase();
    if (upgrade !== 'websocket') {
      return new Response('', { status: 200 });
    }
    return upgradeHandler(request);
  },
};
async function upgradeHandler(request) {
  const [clientWS, serverWS] = Object.values(new WebSocketPair());
  serverWS.accept({ allowHalfOpen: true });
  serverWS.binaryType = 'arraybuffer';
  const earlyPayload = base64UrlToBytes(request.headers.get('sec-websocket-protocol') || '');
  const state = { socket: null, writer: null, closed: false };
  const upstreamQueue = createCoalescingQueue(TUNNEL_CFG.UP_BATCH_SIZE, TUNNEL_CFG.UP_QUEUE_LIMIT);
  let processing = false;
  function teardown() {
    if (state.closed) return;
    state.closed = true;
    upstreamQueue.reset();
    try { state.writer?.releaseLock(); } catch (_) {}
    try { state.socket?.close(); } catch (_) {}
    try { serverWS.close(); } catch (_) {}
  }
  function asUint8Array(data) {
    if (data instanceof Uint8Array) return data;
    if (ArrayBuffer.isView(data)) {
      return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    }
    return new Uint8Array(data);
  }
  function enqueue(data) {
    const chunk = asUint8Array(data);
    if (!chunk.byteLength) return 1;
    if (upstreamQueue.push(chunk)) return 1;
    teardown();
    return 0;
  }
  async function drainQueue() {
    if (processing || state.closed) return;
    processing = true;
    try {
      for (;;) {
        if (state.closed) break;
        if (!state.socket) {
          const firstChunk = upstreamQueue.pop();
          if (!firstChunk) break;
          let parsed;
          try {
            parsed = parseInitialMessage(firstChunk);
          } catch (_) {
            teardown();
            break;
          }
          const { hostname, port, payload } = parsed;
          let sock;
          try {
            sock = await raceConnections(hostname, port, payload);
          } catch (_) {
            try {
              sock = await createConnection(FALLBACK_HOST, port, payload);
            } catch (__) {
              teardown();
              break;
            }
          }
          state.socket = sock;
          state.writer = sock.writable.getWriter();
          serverWS.send(new Uint8Array([0, 0]));
          pipeSocketToWebSocket(sock.readable, serverWS).finally(() => {
            if (!state.closed) teardown();
          });
          continue;
        }
        const [batch] = upstreamQueue.batch();
        if (!batch) break;
        await state.writer.write(batch);
      }
    } catch (_) {
      teardown();
    } finally {
      processing = false;
      if (!upstreamQueue.isEmpty && !state.closed) {
        queueMicrotask(drainQueue);
      }
    }
  }
  if (earlyPayload) enqueue(earlyPayload);
  drainQueue();
  serverWS.addEventListener('message', (e) => {
    if (state.closed) return;
    if (enqueue(e.data)) drainQueue();
  });
  serverWS.addEventListener('close', () => teardown());
  serverWS.addEventListener('error', () => teardown());
  return new Response(null, {
    status: 101,
    webSocket: clientWS,
    headers: { 'Sec-WebSocket-Extensions': '' },
  });
      }

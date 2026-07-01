const CUSTOM_TARGET_DOMAINS = '';
const CUSTOM_RACE_COUNT = 0;
const CUSTOM_TIMEOUT_MS = 0;
const CUSTOM_MAX_RETRIES = 0;
const REALITY_SERVER_NAME = 'www.dest.com';
const ALLOW_INSECURE = true;
let realityServerName = REALITY_SERVER_NAME;
let allowInsecure = ALLOW_INSECURE;
export default {
  async fetch(request, env, ctx) {
    if (CUSTOM_TARGET_DOMAINS) env.TARGET_DOMAINS = CUSTOM_TARGET_DOMAINS;
    if (CUSTOM_RACE_COUNT) env.RACE_COUNT = String(CUSTOM_RACE_COUNT);
    if (CUSTOM_TIMEOUT_MS) env.TIMEOUT_MS = String(CUSTOM_TIMEOUT_MS);
    if (CUSTOM_MAX_RETRIES) env.MAX_RETRIES = String(CUSTOM_MAX_RETRIES);
    const BASES = (env.TARGET_DOMAINS || '')
      .split(',')
      .map(s => s.trim().replace(/\/$/, ''))
      .filter(Boolean);
    const RACE_COUNT = Math.max(1, parseInt(env.RACE_COUNT || '5', 10));
    const TIMEOUT_MS = Math.max(2000, parseInt(env.TIMEOUT_MS || '8000', 10));
    const MAX_RETRIES = Math.max(0, parseInt(env.MAX_RETRIES || '1', 10));
    if (BASES.length === 0) {
      return new Response('TARGET_DOMAINS not set', { status: 500 });
    }
    const url = new URL(request.url);
    const method = request.method;
    const path = url.pathname + url.search;
    const isHead = method === 'HEAD';
    let clientIp = null;
    for (const [key, value] of request.headers) {
      const lk = key.toLowerCase();
      if (lk === 'x-real-ip') { clientIp = value; break; }
      if (lk === 'x-forwarded-for') { clientIp = value; break; }
    }
    let bodyBytes = null;
    if (method !== 'GET' && method !== 'HEAD' && request.body) {
      bodyBytes = await request.arrayBuffer().then(ab => new Uint8Array(ab));
    }
    const stripHeaders = new Set([
      'host', 'connection', 'keep-alive',
      'proxy-authenticate', 'proxy-authorization',
      'te', 'trailer', 'transfer-encoding', 'upgrade',
      'forwarded',
      'x-forwarded-host', 'x-forwarded-proto', 'x-forwarded-port',
      'cf-connecting-ip', 'cf-ipcountry', 'cf-ray', 'cf-visitor',
    ]);
    let baseHeadersStr = '';
    for (const [key, value] of request.headers) {
      const lk = key.toLowerCase();
      if (stripHeaders.has(lk)) continue;
      if (lk === 'x-real-ip' || lk === 'x-forwarded-for') continue;
      baseHeadersStr += `${key}: ${value}\r\n`;
    }
    if (clientIp) {
      baseHeadersStr += `X-Forwarded-For: ${clientIp}\r\n`;
    }
    const buildRequestBuffer = (base) => {
      const { hostname } = new URL(base);
      let rawHeaders = `${method} ${path} HTTP/1.1\r\n`;
      rawHeaders += `Host: ${hostname}\r\n`;
      rawHeaders += baseHeadersStr;
      rawHeaders += '\r\n';
      if (bodyBytes && !rawHeaders.toLowerCase().includes('content-length')) {
        rawHeaders = rawHeaders.slice(0, -2) + `Content-Length: ${bodyBytes.length}\r\n\r\n`;
      }
      return new TextEncoder().encode(rawHeaders);
    };
    const raceBase = async (base) => {
      const { hostname, port } = new URL(base);
      const secure = base.startsWith('https://');
      const targetPort = port || (secure ? 443 : 80);
      const headerBytes = buildRequestBuffer(base);
      const sockets = Array.from({ length: RACE_COUNT }, () =>
        connectAndSend(hostname, targetPort, secure, headerBytes, bodyBytes, TIMEOUT_MS)
      );
      const winner = await Promise.any(sockets);
      sockets.forEach(p => p.then(s => { if (s !== winner) s.close(); }).catch(() => {}));
      return winner;
    };
    const raceAll = async () => {
      const promises = BASES.map(raceBase);
      return await Promise.any(promises);
    };
    let lastError;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const socket = await raceAll();
        return buildResponseFromSocket(socket, isHead);
      } catch (err) {
        lastError = err;
        if (attempt === MAX_RETRIES) break;
      }
    }
    console.error('all races failed:', lastError?.message || lastError);
    return new Response('Bad Gateway: All backends unreachable', { status: 502 });
  }
};
async function connectAndSend(hostname, port, secure, headerBytes, bodyBytes, timeoutMs) {
  const socket = connect({
    hostname,
    port,
    secureTransport: secure ? 'on' : 'off',
    ...(realityServerName ? { serverName: realityServerName } : {}),
    allowInsecure: allowInsecure
  });
  const timer = setTimeout(() => {
    try { socket.close(); } catch {}
  }, timeoutMs);
  try {
    await socket.opened;
    clearTimeout(timer);
    const writer = socket.writable.getWriter();
    await writer.write(headerBytes);
    if (bodyBytes && bodyBytes.length > 0) {
      await writer.write(bodyBytes);
    }
    writer.releaseLock();
    const { statusCode, headers } = await readHeaders(socket, timeoutMs);
    socket._status = statusCode;
    socket._resHeaders = headers;
    return socket;
  } catch (e) {
    clearTimeout(timer);
    try { socket.close(); } catch {}
    throw e;
  }
}
function readHeaders(socket, timeoutMs) {
  return new Promise((resolve, reject) => {
    const reader = socket.readable.getReader();
    let buffer = new Uint8Array(0);
    const start = Date.now();
    const checkTimeout = () => {
      if (Date.now() - start > timeoutMs) {
        reader.releaseLock();
        reject(new Error('Header timeout'));
        return true;
      }
      return false;
    };
    const pump = async () => {
      try {
        while (true) {
          if (checkTimeout()) return;
          const { value, done } = await reader.read();
          if (done) {
            reject(new Error('Connection closed before headers'));
            return;
          }
          const tmp = new Uint8Array(buffer.length + value.length);
          tmp.set(buffer);
          tmp.set(value, buffer.length);
          buffer = tmp;
          const idx = indexOfCRLFCRLF(buffer);
          if (idx !== -1) {
            const headerEnd = idx + 4;
            const headerBytes = buffer.subarray(0, headerEnd);
            const headerText = new TextDecoder().decode(headerBytes);
            const lines = headerText.split('\r\n');
            const statusLine = lines[0];
            const statusCode = parseInt(statusLine.split(' ')[1], 10) || 200;
            const headers = new Headers();
            for (let i = 1; i < lines.length; i++) {
              const line = lines[i];
              if (!line) continue;
              const colonIdx = line.indexOf(':');
              if (colonIdx > 0) {
                headers.set(line.substring(0, colonIdx).trim(), line.substring(colonIdx + 1).trim());
              }
            }
            const remaining = buffer.subarray(headerEnd);
            reader.releaseLock();
            const combinedStream = new ReadableStream({
              start(controller) {
                if (remaining.length > 0) controller.enqueue(remaining);
                const newReader = socket.readable.getReader();
                const forward = async () => {
                  try {
                    while (true) {
                      const { value, done } = await newReader.read();
                      if (done) { controller.close(); break; }
                      controller.enqueue(value);
                    }
                  } catch (e) {
                    controller.error(e);
                  }
                };
                forward();
              }
            });
            socket._readable = combinedStream;
            resolve({ statusCode, headers });
            return;
          }
        }
      } catch (e) {
        reject(e);
      }
    };
    pump();
  });
}
async function buildResponseFromSocket(socket, isHead) {
  const status = socket._status || 200;
  const headers = socket._resHeaders;
  const readable = socket._readable || socket.readable;
  if (isHead) {
    readable.cancel();
    return new Response(null, { status, headers });
  }
  return new Response(readable, { status, headers });
}
function indexOfCRLFCRLF(buffer) {
  const CR = 0x0D, LF = 0x0A;
  for (let i = 0; i < buffer.length - 3; i++) {
    if (buffer[i] === CR && buffer[i+1] === LF && buffer[i+2] === CR && buffer[i+3] === LF) {
      return i;
    }
  }
  return -1;
  }

const http = require('http');
const net = require('net');
const { URL } = require('url');

const PORT = Number(process.env.PORT || 8080);
const REDIS_URL = process.env.REDIS_URL || 'redis://redis:6379';
const BROKERS = (process.env.BROKERS || 'broker-a,broker-b,broker-c')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const redisUrl = new URL(REDIS_URL);
const REDIS_HOST = redisUrl.hostname;
const REDIS_PORT = Number(redisUrl.port || 6379);

function encodeRemainingLength(length) {
  const bytes = [];
  do {
    let digit = length % 128;
    length = Math.floor(length / 128);
    if (length > 0) digit |= 0x80;
    bytes.push(digit);
  } while (length > 0);
  return Buffer.from(bytes);
}

function mqttString(value) {
  const buf = Buffer.from(value, 'utf8');
  const len = Buffer.alloc(2);
  len.writeUInt16BE(buf.length, 0);
  return Buffer.concat([len, buf]);
}

function buildConnectPacket(clientId) {
  const protocol = Buffer.from([0x00, 0x04, 0x4d, 0x51, 0x54, 0x54, 0x04, 0x02, 0x00, 0x3c]);
  const payload = mqttString(clientId);
  const remaining = encodeRemainingLength(protocol.length + payload.length);
  return Buffer.concat([Buffer.from([0x10]), remaining, protocol, payload]);
}

function buildPublishPacket(topic, payload) {
  const topicBuf = mqttString(topic);
  const payloadBuf = Buffer.from(payload, 'utf8');
  const remaining = encodeRemainingLength(topicBuf.length + payloadBuf.length);
  return Buffer.concat([Buffer.from([0x30]), remaining, topicBuf, payloadBuf]);
}

function mqttPublish(broker, topic, message) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: broker, port: 1883 });
    const clientId = `demo-${broker}-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
    let settled = false;
    let connected = false;

    const done = (err) => {
      if (settled) return;
      settled = true;
      try { socket.end(); } catch (_) {}
      try { socket.destroy(); } catch (_) {}
      if (err) reject(err); else resolve();
    };

    socket.setTimeout(4000, () => done(new Error(`Timeout publishing to ${broker}`)));
    socket.on('error', done);
    socket.on('connect', () => {
      socket.write(buildConnectPacket(clientId));
    });
    socket.on('data', (chunk) => {
      if (!connected) {
        if (chunk.length < 4 || chunk[0] !== 0x20 || chunk[1] !== 0x02 || chunk[3] !== 0x00) {
          return done(new Error(`MQTT CONNACK failed for ${broker}`));
        }
        connected = true;
        socket.write(buildPublishPacket(topic, message), (err) => {
          if (err) return done(err);
          setTimeout(() => done(), 25);
        });
      }
    });
  });
}

function redisCommand(args) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: REDIS_HOST, port: REDIS_PORT });
    let settled = false;
    let data = '';

    const done = (err, value) => {
      if (settled) return;
      settled = true;
      try { socket.end(); } catch (_) {}
      try { socket.destroy(); } catch (_) {}
      if (err) reject(err); else resolve(value);
    };

    socket.setTimeout(3000, () => done(new Error('Redis command timed out')));
    socket.on('error', (err) => done(err));
    socket.on('data', (chunk) => {
      data += chunk.toString('utf8');
      if (!data.endsWith('\r\n')) return;
      const prefix = data[0];
      if (prefix === ':') return done(null, Number(data.slice(1).trim()));
      if (prefix === '+') return done(null, data.slice(1).trim());
      if (prefix === '-') return done(new Error(data.slice(1).trim()));
      if (prefix === '$') {
        const parts = data.split('\r\n');
        return done(null, parts[1] || '');
      }
      done(null, data.trim());
    });
    socket.on('connect', () => {
      const payload = `*${args.length}\r\n` + args.map((arg) => `$${Buffer.byteLength(String(arg))}\r\n${arg}\r\n`).join('');
      socket.write(payload);
    });
  });
}

async function getQueueCount(name) {
  return Number(await redisCommand(['LLEN', `queue:${name}`]));
}

async function purgeQueue(name) {
  await redisCommand(['DEL', `queue:${name}`]);
}

async function pushQueueMessage(name, payload) {
  await redisCommand(['RPUSH', `queue:${name}`, payload]);
}

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk.toString('utf8');
      if (body.length > 1024 * 1024) {
        reject(new Error('Request body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function parseTargets(mode, broker, count) {
  const total = Math.max(1, Math.min(500, Number(count || 1)));
  const targetMode = String(mode || 'single');
  if (targetMode === 'all') {
    return BROKERS.flatMap((name) => Array.from({ length: total }, (_, i) => ({ broker: name, index: i + 1 })));
  }
  if (targetMode === 'round-robin') {
    return Array.from({ length: total }, (_, i) => ({ broker: BROKERS[i % BROKERS.length], index: i + 1 }));
  }
  if (!BROKERS.includes(broker)) {
    throw new Error('Unknown broker');
  }
  return Array.from({ length: total }, (_, i) => ({ broker, index: i + 1 }));
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    if (req.method === 'GET' && url.pathname === '/healthz') {
      return json(res, 200, { status: 'ok' });
    }

    if (req.method === 'GET' && url.pathname === '/readyz') {
      return json(res, 200, { status: 'ready' });
    }

    if (req.method === 'GET' && url.pathname === '/brokers') {
      const brokers = await Promise.all(
        BROKERS.map(async (name) => ({
          name,
          service: `${name}:1883`,
          queueCount: await getQueueCount(name),
          replicas: 'KEDA-managed',
        }))
      );
      return json(res, 200, { brokers });
    }

    if (req.method === 'POST' && url.pathname === '/send') {
      const body = await readJson(req);
      const broker = body.broker;
      const count = Math.max(1, Math.min(500, Number(body.count || 1)));
      const message = String(body.message || 'Hello from OpenShift');
      const mode = String(body.mode || 'single');
      const jobs = parseTargets(mode, broker, count);
      const sentByBroker = Object.fromEntries(BROKERS.map((name) => [name, 0]));

      for (const job of jobs) {
        const payload = `${message} #${job.index}`;
        await mqttPublish(job.broker, `demo/${job.broker}`, payload);
        await pushQueueMessage(job.broker, payload);
        sentByBroker[job.broker] += 1;
      }

      return json(res, 200, {
        ok: true,
        mode,
        requestedCount: count,
        totalMessagesSent: jobs.length,
        sentByBroker,
      });
    }

    if (req.method === 'DELETE' && /^\/brokers\/[^/]+\/messages$/.test(url.pathname)) {
      const broker = decodeURIComponent(url.pathname.split('/')[2]);
      if (!BROKERS.includes(broker)) {
        return json(res, 400, { error: 'Unknown broker' });
      }
      await purgeQueue(broker);
      return json(res, 200, { ok: true, broker });
    }

    return json(res, 404, { error: 'Not found' });
  } catch (error) {
    console.error(error);
    return json(res, 500, { error: error.message || 'Internal server error' });
  }
});

server.listen(PORT, () => {
  console.log(`API listening on ${PORT}`);
});

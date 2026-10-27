import { createServer } from 'node:http';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { connect as netConnect } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
const STORE_FILE = path.join(DATA_DIR, 'store.json');
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const CUSTOMER_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_JSON_BYTES = 1_000_000;
const MAX_UPLOAD_BYTES = 6_000_000;
const sessions = new Map();
const customerSessions = new Map();
const loginAttempts = new Map();
const paypalTokens = { value: '', expiresAt: 0 };
const passwordResetTokens = new Map();
let paypalCaptureQueue = Promise.resolve();

await loadEnvironment();
await mkdir(UPLOADS_DIR, { recursive: true });
const PORT = Number(process.env.PORT || 3000);
const adminPassword = process.env.ADMIN_PASSWORD;
if (!adminPassword || adminPassword.length < 12 || adminPassword === 'change-this-to-a-long-unique-password' || adminPassword === 'defina-uma-senha-exclusiva-com-12-caracteres') {
  console.error('Configure ADMIN_PASSWORD with a unique password of at least 12 characters in .env.');
  process.exit(1);
}
const freeShippingMin = Math.max(0, Number(process.env.FREE_SHIPPING_MIN || 249));
const passwordDigest = scryptSync(adminPassword, 'camada-3d-admin', 32);
let store = await loadStore();

async function loadEnvironment() {
  try {
    const contents = await readFile(path.join(ROOT, '.env'), 'utf8');
    for (const line of contents.split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (match && process.env[match[1]] === undefined) {
        process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
      }
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

function initialStore() {
  return {
    products: [
      { id: 'suporte-fone', name: 'Suporte para fones', description: 'Design minimalista para manter sua mesa organizada. Impresso sob demanda em PLA resistente.', price: 59.9, stock: 18, category: 'Organização', emoji: '🎧', color: '#d9e6ff', image: '', active: true },
      { id: 'vaso-aurora', name: 'Vaso Aurora', description: 'Vaso decorativo com textura geométrica. Ideal para plantas pequenas e decoração contemporânea.', price: 74.9, stock: 12, category: 'Decoração', emoji: '🪴', color: '#f8dfd5', image: '', active: true },
      { id: 'articulado-dragao', name: 'Dragão articulado', description: 'Peça articulada impressa em uma única montagem. Presente criativo para colecionadores.', price: 89.9, stock: 9, category: 'Miniaturas', emoji: '🐉', color: '#e3dbf7', image: '', active: true },
      { id: 'luminaria-orbita', name: 'Luminária Órbita', description: 'Cúpula vazada com efeito de luz suave. Compatível com soquete LED compacto (não incluso).', price: 129.9, stock: 7, category: 'Decoração', emoji: '💡', color: '#f6edc9', image: '', active: true },
      { id: 'organizador-modular', name: 'Organizador modular', description: 'Módulo empilhável para organizar acessórios, ferramentas e itens de escritório.', price: 42.9, stock: 24, category: 'Organização', emoji: '🧩', color: '#d9eee7', image: '', active: true },
      { id: 'chaveiro-personalizado', name: 'Chaveiro personalizado', description: 'Leve e resistente, disponível em várias cores. Escreva para nós para personalizar seu modelo.', price: 19.9, stock: 30, category: 'Acessórios', emoji: '🔑', color: '#f7ddeb', image: '', active: true }
    ],
    orders: [],
    customers: []
  };
}

async function loadStore() {
  try {
    const saved = JSON.parse(await readFile(STORE_FILE, 'utf8'));
    return {
      products: (Array.isArray(saved.products) ? saved.products : []).map((product) => ({ image: '', ...product })),
      orders: Array.isArray(saved.orders) ? saved.orders : [],
      customers: Array.isArray(saved.customers) ? saved.customers : []
    };
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const fresh = initialStore();
    await writeFile(STORE_FILE, JSON.stringify(fresh, null, 2), 'utf8');
    return fresh;
  }
}

async function saveStore() {
  const temporaryFile = `${STORE_FILE}.tmp`;
  await writeFile(temporaryFile, JSON.stringify(store, null, 2), 'utf8');
  await rename(temporaryFile, STORE_FILE);
}

function sendJson(response, status, body, headers = {}) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers
  });
  response.end(JSON.stringify(body));
}

function httpError(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

function parseCookies(request) {
  return Object.fromEntries((request.headers.cookie || '').split(';').map((part) => {
    const separator = part.indexOf('=');
    return separator < 0 ? ['', ''] : [part.slice(0, separator).trim(), decodeURIComponent(part.slice(separator + 1).trim())];
  }).filter(([key]) => key));
}

function isAdmin(request) {
  const session = sessions.get(parseCookies(request).admin_session);
  if (!session || session.expiresAt < Date.now()) return false;
  session.expiresAt = Date.now() + SESSION_TTL_MS;
  return true;
}

function currentCustomer(request) {
  const sessionId = parseCookies(request).customer_session;
  const session = sessionId ? customerSessions.get(sessionId) : null;
  if (!session || session.expiresAt < Date.now()) return null;
  const customer = store.customers.find((entry) => entry.id === session.customerId);
  if (!customer) {
    customerSessions.delete(sessionId);
    return null;
  }
  session.expiresAt = Date.now() + CUSTOMER_SESSION_TTL_MS;
  return customer;
}

function publicCustomer(customer) {
  return { id: customer.id, name: customer.name, email: customer.email, phone: customer.phone || '', createdAt: customer.createdAt };
}

function customerCookie(sessionId, maxAgeSeconds) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  return `customer_session=${sessionId}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAgeSeconds}${secure}`;
}

function isSameOrigin(request) {
  const origin = request.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === request.headers.host;
  } catch {
    return false;
  }
}

async function readJson(request, limit = MAX_JSON_BYTES) {
  let body = '';
  for await (const chunk of request) {
    body += chunk;
    if (body.length > limit) throw httpError('A solicitação excede o limite permitido.', 413);
  }
  try {
    return JSON.parse(body || '{}');
  } catch {
    throw httpError('O corpo da solicitação não é um JSON válido.', 400);
  }
}

function round(value) {
  return Math.round(Number(value) * 100) / 100;
}

function normalizeProduct(input, existing = {}) {
  const name = String(input.name ?? existing.name ?? '').trim();
  const description = String(input.description ?? existing.description ?? '').trim();
  const price = Number(input.price ?? existing.price);
  const stock = Number(input.stock ?? existing.stock);
  const category = String(input.category ?? existing.category ?? '').trim();
  const emoji = String(input.emoji ?? existing.emoji ?? '🧊').trim();
  const color = String(input.color ?? existing.color ?? '#d9e6ff').trim();
  const image = String(input.image ?? existing.image ?? '').trim();
  if (!name || name.length > 100 || !description || description.length > 500 || !category || category.length > 50) {
    throw httpError('Informe nome, descrição e categoria válidos.');
  }
  if (!Number.isFinite(price) || price < 0.01 || price > 100000 || !Number.isInteger(stock) || stock < 0 || stock > 100000) {
    throw httpError('Preço ou estoque inválido.');
  }
  if (emoji.length > 8 || !/^#[0-9a-f]{6}$/i.test(color)) {
    throw httpError('Emoji ou cor inválidos.');
  }
  if (image && !/^\/uploads\/[A-Za-z0-9._-]+$/.test(image)) {
    throw httpError('Imagem do produto inválida.');
  }
  return {
    name,
    description,
    price: round(price),
    stock,
    category,
    emoji,
    color,
    image,
    active: input.active === undefined ? existing.active !== false : input.active === true
  };
}

function normalizeCustomer(input) {
  const customer = {
    name: String(input.name || '').trim(),
    email: String(input.email || '').trim().toLowerCase(),
    address: String(input.address || '').trim(),
    city: String(input.city || '').trim(),
    state: String(input.state || '').trim().toUpperCase(),
    postalCode: String(input.postalCode || '').replace(/\D/g, '')
  };
  if (customer.name.length < 2 || customer.name.length > 100 ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customer.email) ||
      customer.address.length < 5 || customer.address.length > 200 ||
      customer.city.length < 2 || customer.city.length > 80 ||
      customer.state.length !== 2 || customer.postalCode.length !== 8) {
    throw httpError('Confira nome, e-mail e endereço de entrega. O CEP deve ter 8 dígitos.');
  }
  return customer;
}

function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const digest = scryptSync(password, salt, 64).toString('hex');
  return `scrypt$${salt}$${digest}`;
}

function verifyPassword(password, stored) {
  const [scheme, salt, digest] = String(stored || '').split('$');
  if (scheme !== 'scrypt' || !salt || !digest) return false;
  const expected = Buffer.from(digest, 'hex');
  const supplied = scryptSync(password, salt, expected.length);
  return expected.length === supplied.length && timingSafeEqual(expected, supplied);
}

function checkRateLimit(key, limit, windowMs) {
  const now = Date.now();
  const entry = loginAttempts.get(key) || { count: 0, blockedUntil: 0 };
  if (entry.blockedUntil > now) throw httpError('Muitas tentativas. Aguarde alguns minutos e tente novamente.', 429);
  return {
    fail() {
      entry.count += 1;
      if (entry.count >= limit) {
        entry.count = 0;
        entry.blockedUntil = now + windowMs;
      }
      loginAttempts.set(key, entry);
    },
    reset() {
      loginAttempts.delete(key);
    }
  };
}

/* ------------------------------------------------------------------ */
/* Frete                                                               */
/* ------------------------------------------------------------------ */

const SHIPPING_ZONES = [
  { range: [1, 19], region: 'São Paulo', pac: 19.9, sedex: 32.9, days: 2 },
  { range: [20, 29], region: 'Rio de Janeiro e Espírito Santo', pac: 24.9, sedex: 37.9, days: 3 },
  { range: [30, 39], region: 'Minas Gerais', pac: 24.9, sedex: 37.9, days: 3 },
  { range: [40, 49], region: 'Bahia e Sergipe', pac: 32.9, sedex: 47.9, days: 4 },
  { range: [50, 59], region: 'Pernambuco, Alagoas, Paraíba e Rio Grande do Norte', pac: 34.9, sedex: 49.9, days: 5 },
  { range: [60, 69], region: 'Ceará, Norte e Nordeste', pac: 39.9, sedex: 56.9, days: 6 },
  { range: [70, 79], region: 'Distrito Federal e Centro-Oeste', pac: 27.9, sedex: 41.9, days: 3 },
  { range: [80, 89], region: 'Paraná e Santa Catarina', pac: 22.9, sedex: 35.9, days: 3 },
  { range: [90, 99], region: 'Rio Grande do Sul', pac: 24.9, sedex: 37.9, days: 4 }
];

function shippingQuote(postalCode, subtotal) {
  const digits = String(postalCode || '').replace(/\D/g, '');
  if (digits.length !== 8) throw httpError('Informe um CEP válido com 8 dígitos.');
  const prefix = Number(digits.slice(0, 2));
  const zone = SHIPPING_ZONES.find((entry) => prefix >= entry.range[0] && prefix <= entry.range[1]) || SHIPPING_ZONES[0];
  const free = freeShippingMin > 0 && subtotal >= freeShippingMin;
  return {
    postalCode: digits,
    region: zone.region,
    freeShippingMin,
    options: [
      {
        code: 'pac',
        label: free ? 'Frete grátis' : 'Envio econômico',
        carrier: 'PAC',
        price: free ? 0 : zone.pac,
        days: `${zone.days + 1} a ${zone.days + 3} dias úteis`,
        free
      },
      {
        code: 'sedex',
        label: 'Envio expresso',
        carrier: 'SEDEX',
        price: zone.sedex,
        days: `${Math.max(1, zone.days - 1)} a ${zone.days + 1} dias úteis`,
        free: false
      }
    ]
  };
}

function findShippingOption(code, postalCode, subtotal) {
  const quote = shippingQuote(postalCode, subtotal);
  const option = quote.options.find((entry) => entry.code === code);
  if (!option) throw httpError('Escolha uma opção de frete válida.');
  return option;
}

/* ------------------------------------------------------------------ */
/* E-mail                                                              */
/* ------------------------------------------------------------------ */

class SmtpClient {
  constructor(socket) {
    this.socket = socket;
    this.buffer = '';
    this.waiters = [];
    this.closed = false;
    socket.setEncoding('utf8');
    socket.setTimeout(20_000);
    socket.on('data', (chunk) => {
      this.buffer += chunk;
      this.pump();
    });
    socket.on('error', (error) => this.fail(error));
    socket.on('close', () => this.fail(new Error('Conexão SMTP encerrada.')));
    socket.on('timeout', () => socket.destroy(new Error('Tempo esgotado na conexão SMTP.')));
  }

  pump() {
    if (!this.waiters.length) return;
    const match = /^\d{3} [^\r\n]*\r\n/m.exec(this.buffer);
    if (!match) return;
    const raw = this.buffer.slice(0, match.index + match[0].length);
    this.buffer = this.buffer.slice(match.index + match[0].length);
    const waiter = this.waiters.shift();
    clearTimeout(waiter.timer);
    waiter.resolve({ code: Number(match[0].slice(0, 3)), text: raw });
    this.pump();
  }

  fail(error) {
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  }

  read() {
    return new Promise((resolve, reject) => {
      const waiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          reject(new Error('O servidor de e-mail demorou para responder.'));
        }, 20_000)
      };
      this.waiters.push(waiter);
      this.pump();
    });
  }

  async command(line, allowed = []) {
    if (this.closed) throw new Error('Conexão SMTP indisponível.');
    this.socket.write(`${line}\r\n`);
    const reply = await this.read();
    if (allowed.length && !allowed.includes(reply.code)) {
      throw new Error(`SMTP ${reply.code}: ${reply.text.slice(0, 200)}`);
    }
    return reply;
  }

  detach() {
    this.closed = true;
    this.socket.removeAllListeners('data');
    this.socket.removeAllListeners('error');
    this.socket.removeAllListeners('close');
    this.socket.removeAllListeners('timeout');
  }

  close() {
    try {
      this.socket.end('QUIT\r\n');
    } catch {
      /* ignore */
    }
    setTimeout(() => this.socket.destroy(), 200).unref?.();
  }
}

function smtpConnect(host, port, secure) {
  return new Promise((resolve, reject) => {
    const socket = secure
      ? tlsConnect({ host, port, servername: host, rejectUnauthorized: true }, () => resolve(socket))
      : netConnect({ host, port }, () => resolve(socket));
    socket.once('error', reject);
  });
}

function smtpStartTls(socket, host) {
  return new Promise((resolve, reject) => {
    const secureSocket = tlsConnect({ socket, servername: host, rejectUnauthorized: true }, () => resolve(secureSocket));
    secureSocket.once('error', reject);
  });
}

function encodeSubject(value) {
  return `=?UTF-8?B?${Buffer.from(String(value), 'utf8').toString('base64')}?=`;
}

function base64Lines(value) {
  return Buffer.from(String(value), 'utf8').toString('base64').replace(/(.{76})/g, '$1\r\n');
}

function buildMimeMessage({ from, to, subject, text, html }) {
  const boundary = `camada3d-${randomBytes(12).toString('hex')}`;
  return [
    `From: ${from}`,
    `To: ${to.join(', ')}`,
    `Subject: ${encodeSubject(subject)}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${randomBytes(12).toString('hex')}@camada3d.local>`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    base64Lines(text),
    `--${boundary}`,
    'Content-Type: text/html; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    base64Lines(html),
    `--${boundary}--`,
    ''
  ].join('\r\n');
}

function isMailConfigured() {
  if (process.env.RESEND_API_KEY) return true;
  return Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

async function sendMail({ to, subject, text, html }) {
  const from = process.env.EMAIL_FROM || process.env.SMTP_USER || 'Camada 3D <nao-responda@camada3d.local>';
  const recipients = [...new Set(to.filter(Boolean))];
  if (!recipients.length) throw new Error('Nenhum destinatário de e-mail configurado.');
  if (process.env.RESEND_API_KEY) {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to: recipients, subject, html, text }),
      signal: AbortSignal.timeout(20_000)
    });
    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`Resend recusou o envio (${response.status}): ${detail.slice(0, 200)}`);
    }
    return;
  }

  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT || 587);
  const implicitTls = process.env.SMTP_SECURE === 'true' || port === 465;
  let socket = await smtpConnect(host, port, implicitTls);
  let client = new SmtpClient(socket);
  try {
    const greeting = await client.read();
    if (greeting.code !== 220) throw new Error(`SMTP ${greeting.code}: ${greeting.text.slice(0, 200)}`);
    let caps = await client.command('EHLO camada3d.local', [250]);
    if (!implicitTls && /STARTTLS/i.test(caps.text)) {
      await client.command('STARTTLS', [220]);
      client.detach();
      socket = await smtpStartTls(socket, host);
      client = new SmtpClient(socket);
      caps = await client.command('EHLO camada3d.local', [250]);
    }
    await client.command('AUTH LOGIN', [334]);
    await client.command(Buffer.from(process.env.SMTP_USER, 'utf8').toString('base64'), [334]);
    await client.command(Buffer.from(process.env.SMTP_PASS, 'utf8').toString('base64'), [235]);
    await client.command(`MAIL FROM:<${(process.env.SMTP_USER || '').trim()}>`, [250]);
    for (const recipient of recipients) await client.command(`RCPT TO:<${recipient}>`, [250, 251]);
    await client.command('DATA', [354]);
    await client.command(`${buildMimeMessage({ from, to: recipients, subject, text, html })}\r\n.`, [250]);
    client.close();
  } catch (error) {
    try {
      socket.destroy();
    } catch {
      /* ignore */
    }
    throw error;
  }
}

function orderNotificationEmail(order, audience = 'store') {
  const storeUrl = (process.env.STORE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
  const isCustomer = audience === 'customer';
  const statusLabels = { pending: 'Aguardando pagamento', paid: 'Pago', preparing: 'Em preparo', shipped: 'Enviado', delivered: 'Entregue', cancelled: 'Cancelado' };
  const statusLabel = statusLabels[order.status] || order.status;
  const money = (value) => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(value);
  const rows = order.items.map((item) => `
    <tr>
      <td style="padding:10px 0;border-bottom:1px solid #1e2a38;color:#dbe6f3">${escapeHtml(item.name)}</td>
      <td style="padding:10px 0;border-bottom:1px solid #1e2a38;color:#8b9aad;text-align:center">${item.quantity}</td>
      <td style="padding:10px 0;border-bottom:1px solid #1e2a38;color:#dbe6f3;text-align:right">${money(item.unitPrice * item.quantity)}</td>
    </tr>`).join('');
  const html = `<!doctype html>
<html lang="pt-BR"><body style="margin:0;background:#06080c;font-family:Arial,Helvetica,sans-serif;color:#e8eef7">
  <div style="max-width:640px;margin:0 auto;padding:28px 20px">
    <div style="font-size:12px;letter-spacing:.28em;color:#3ee0ff;text-transform:uppercase">Camada 3D · ${isCustomer ? 'pedido recebido' : 'novo pedido'}</div>
    <h1 style="font-size:26px;margin:10px 0 4px;color:#fff">${isCustomer ? 'Pedido recebido' : 'Pedido'} #${escapeHtml(order.id.slice(0, 8).toUpperCase())}</h1>
    <p style="color:#8b9aad;margin:0 0 20px;font-size:14px">${escapeHtml(new Date(order.createdAt).toLocaleString('pt-BR'))}</p>
    <div style="background:#0d131c;border:1px solid #1e2a38;border-radius:14px;padding:20px;margin-bottom:18px">
      <table style="width:100%;border-collapse:collapse;font-size:14px">${rows}
        <tr><td style="padding:12px 0 4px;color:#8b9aad">Subtotal</td><td></td><td style="padding:12px 0 4px;text-align:right;color:#dbe6f3">${money(order.subtotal)}</td></tr>
        <tr><td style="padding:4px 0;color:#8b9aad">Frete (${escapeHtml(order.shipping.carrier)} · ${escapeHtml(order.shipping.days)})</td><td></td><td style="padding:4px 0;text-align:right;color:#dbe6f3">${money(order.shippingPrice)}</td></tr>
        <tr><td style="padding:12px 0 0;color:#fff;font-weight:bold;font-size:16px">Total</td><td></td><td style="padding:12px 0 0;text-align:right;color:#3ee0ff;font-weight:bold;font-size:16px">${money(order.total)}</td></tr>
      </table>
    </div>
    <div style="background:#0d131c;border:1px solid #1e2a38;border-radius:14px;padding:20px;font-size:14px;line-height:1.7;margin-bottom:18px">
      <div style="font-size:11px;letter-spacing:.2em;color:#8b9aad;margin-bottom:8px">CLIENTE</div>
      <strong>${escapeHtml(order.customer.name)}</strong><br>
      ${escapeHtml(order.customer.email)}<br>
      ${escapeHtml(order.customer.address)}<br>
      ${escapeHtml(order.customer.city)} / ${escapeHtml(order.customer.state)} · CEP ${escapeHtml(order.customer.postalCode)}
      ${order.note ? `<br><br><span style="color:#8b9aad">Observação:</span> ${escapeHtml(order.note)}` : ''}
    </div>
    <p style="color:#8b9aad;font-size:13px;margin:0 0 18px">Pagamento: ${escapeHtml(order.paymentProvider)} · Status: ${escapeHtml(statusLabel)}</p>
    <a href="${storeUrl}${isCustomer ? '/account.html' : '/admin.html'}" style="display:inline-block;background:#3ee0ff;color:#04121a;text-decoration:none;font-weight:bold;padding:12px 20px;border-radius:10px;font-size:14px">${isCustomer ? 'Acompanhar meu pedido' : 'Abrir painel de pedidos'}</a>
    <p style="color:#4b5b6e;font-size:11px;margin-top:26px">${isCustomer ? 'Obrigado por comprar na Camada 3D. Este é um aviso automático.' : 'Notificação automática da loja Camada 3D.'}</p>
  </div>
</body></html>`;
  const text = [
    `Camada 3D — ${isCustomer ? 'pedido recebido' : 'novo pedido'} #${order.id.slice(0, 8).toUpperCase()}`,
    `Data: ${new Date(order.createdAt).toLocaleString('pt-BR')}`,
    '',
    ...order.items.map((item) => `${item.quantity}x ${item.name} — ${money(item.unitPrice * item.quantity)}`),
    '',
    `Subtotal: ${money(order.subtotal)}`,
    `Frete (${order.shipping.carrier} · ${order.shipping.days}): ${money(order.shippingPrice)}`,
    `Total: ${money(order.total)}`,
    '',
    `Cliente: ${order.customer.name} <${order.customer.email}>`,
    `${order.customer.address}`,
    `${order.customer.city}/${order.customer.state} — CEP ${order.customer.postalCode}`,
    order.note ? `Observação: ${order.note}` : '',
    '',
    `Pagamento: ${order.paymentProvider} · Status: ${statusLabel}`,
    isCustomer ? `Acompanhe em ${storeUrl}/account.html` : `Painel: ${storeUrl}/admin.html`
  ].filter(Boolean).join('\n');
  return { html, text };
}

async function notifyNewOrder(order) {
  const storeEmail = process.env.ORDER_EMAIL || process.env.SMTP_USER || '';
  const customerEmail = process.env.EMAIL_CUSTOMER_CONFIRMATION !== 'false' ? order.customer.email : '';
  if ((!storeEmail && !customerEmail) || !isMailConfigured()) {
    order.emailStatus = 'skipped';
    return false;
  }
  const code = order.id.slice(0, 8).toUpperCase();
  let attempted = 0;
  let failures = 0;
  if (storeEmail) {
    attempted += 1;
    const { html, text } = orderNotificationEmail(order, 'store');
    try {
      await sendMail({ to: [storeEmail], subject: `Novo pedido #${code} · Camada 3D`, html, text });
    } catch (error) {
      failures += 1;
      console.error('Store order e-mail could not be sent:', error.message);
      order.emailError = error.message.slice(0, 200);
    }
  }
  if (customerEmail) {
    attempted += 1;
    const { html, text } = orderNotificationEmail(order, 'customer');
    try {
      await sendMail({ to: [customerEmail], subject: `Pedido #${code} recebido · Camada 3D`, html, text });
    } catch (error) {
      failures += 1;
      console.error('Customer order e-mail could not be sent:', error.message);
      order.emailError = error.message.slice(0, 200);
    }
  }
  if (!failures) {
    order.emailStatus = 'sent';
    delete order.emailError;
    return true;
  }
  order.emailStatus = failures === attempted ? 'failed' : 'partial';
  return false;
}

/* ------------------------------------------------------------------ */
/* PayPal                                                              */
/* ------------------------------------------------------------------ */

async function paypalRequest(endpoint, options = {}) {
  const clientId = process.env.PAYPAL_CLIENT_ID;
  const clientSecret = process.env.PAYPAL_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw httpError('PayPal ainda não configurado. Adicione PAYPAL_CLIENT_ID e PAYPAL_CLIENT_SECRET ao arquivo .env.', 503);
  }
  const baseUrl = process.env.PAYPAL_ENV === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';
  if (!paypalTokens.value || paypalTokens.expiresAt < Date.now() + 60_000) {
    const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    const tokenResponse = await fetch(`${baseUrl}/v1/oauth2/token`, {
      method: 'POST',
      headers: { Authorization: `Basic ${credentials}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=client_credentials',
      signal: AbortSignal.timeout(15_000)
    });
    const tokenBody = await tokenResponse.json();
    if (!tokenResponse.ok) throw httpError('Não foi possível autenticar com o PayPal. Verifique as credenciais configuradas.', 502);
    paypalTokens.value = tokenBody.access_token;
    paypalTokens.expiresAt = Date.now() + Number(tokenBody.expires_in || 300) * 1000;
  }
  const result = await fetch(`${baseUrl}${endpoint}`, {
    ...options,
    headers: { Authorization: `Bearer ${paypalTokens.value}`, 'Content-Type': 'application/json', ...(options.headers || {}) },
    signal: AbortSignal.timeout(20_000)
  });
  const body = await result.json();
  if (!result.ok) {
    console.error('PayPal API rejected a request:', result.status, body.name || body.error || 'unknown error');
    throw httpError('O PayPal não conseguiu processar a solicitação. Tente novamente.', 502);
  }
  return body;
}

/* ------------------------------------------------------------------ */
/* Pedidos                                                             */
/* ------------------------------------------------------------------ */

function prepareOrder(body, request) {
  const customer = normalizeCustomer(body.customer || {});
  const account = currentCustomer(request);
  if (account) {
    customer.email = account.email;
  }
  if (!Array.isArray(body.items) || !body.items.length || body.items.length > 50) {
    throw httpError('O carrinho está vazio ou contém itens demais.');
  }
  const quantities = new Map();
  for (const item of body.items) {
    const quantity = Number(item.quantity);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 99) throw httpError('Quantidade de produto inválida.');
    quantities.set(String(item.id), (quantities.get(String(item.id)) || 0) + quantity);
  }
  const items = [];
  for (const [id, quantity] of quantities) {
    const product = store.products.find((entry) => entry.id === id && entry.active);
    if (!product || product.stock < quantity) throw httpError('Um produto ficou indisponível ou não tem estoque suficiente. Atualize seu carrinho.');
    items.push({
      id: product.id,
      name: product.name,
      quantity,
      unitPrice: product.price,
      image: product.image || '',
      emoji: product.emoji,
      color: product.color
    });
  }
  const subtotal = round(items.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0));
  const shipping = findShippingOption(String(body.shippingCode || 'pac'), customer.postalCode, subtotal);
  const total = round(subtotal + shipping.price);
  return { customer, account, items, subtotal, shipping, total, note: String(body.note || '').slice(0, 500) };
}

function createOrderRecord(prepared, { paymentProvider, paymentMethod, reserveStock }) {
  const order = {
    id: randomBytes(12).toString('hex'),
    status: 'pending',
    paymentProvider,
    paymentMethod,
    currency: 'BRL',
    subtotal: prepared.subtotal,
    shippingPrice: prepared.shipping.price,
    total: prepared.total,
    shipping: {
      code: prepared.shipping.code,
      label: prepared.shipping.label,
      carrier: prepared.shipping.carrier,
      days: prepared.shipping.days
    },
    items: prepared.items,
    customer: prepared.customer,
    note: prepared.note,
    createdAt: new Date().toISOString()
  };
  if (prepared.account) order.customerId = prepared.account.id;
  if (reserveStock) {
    for (const item of order.items) {
      const product = store.products.find((entry) => entry.id === item.id);
      product.stock -= item.quantity;
    }
    order.stockReserved = true;
  }
  return order;
}

/* ------------------------------------------------------------------ */
/* Uploads                                                             */
/* ------------------------------------------------------------------ */

async function handleUpload(request, response) {
  const body = await readJson(request, MAX_UPLOAD_BYTES);
  const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=\s]+)$/.exec(String(body.dataUrl || ''));
  if (!match) throw httpError('Envie uma imagem PNG, JPEG ou WebP válida.');
  const buffer = Buffer.from(match[2].replace(/\s/g, ''), 'base64');
  if (!buffer.length || buffer.length > MAX_UPLOAD_BYTES) throw httpError('A imagem deve ter no máximo 5 MB.');
  const extension = match[1] === 'jpeg' ? 'jpg' : match[1];
  const fileName = `${Date.now()}-${randomBytes(8).toString('hex')}.${extension}`;
  await writeFile(path.join(UPLOADS_DIR, fileName), buffer);
  return sendJson(response, 201, { url: `/uploads/${fileName}` });
}

/* ------------------------------------------------------------------ */
/* API                                                                 */
/* ------------------------------------------------------------------ */

async function handleApi(request, response, url) {
  const { pathname } = url;
  if (request.method !== 'GET' && !isSameOrigin(request)) {
    return sendJson(response, 403, { error: 'Origem da solicitação não permitida.' });
  }

  if (pathname === '/api/config' && request.method === 'GET') {
    return sendJson(response, 200, {
      paypalClientId: process.env.PAYPAL_CLIENT_ID || '',
      currency: 'BRL',
      paypalConfigured: Boolean(process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET),
      emailConfigured: isMailConfigured(),
      freeShippingMin,
      storeName: 'Camada 3D'
    });
  }

  if (pathname === '/api/products' && request.method === 'GET') {
    return sendJson(response, 200, store.products.filter((product) => product.active));
  }

  if (pathname === '/api/shipping/quote' && request.method === 'POST') {
    const body = await readJson(request);
    const subtotal = Math.max(0, Number(body.subtotal) || 0);
    return sendJson(response, 200, shippingQuote(body.postalCode, subtotal));
  }

  /* ----- clientes ----- */

  if (pathname === '/api/auth/register' && request.method === 'POST') {
    const ip = request.socket.remoteAddress || 'unknown';
    const limiter = checkRateLimit(`auth:${ip}`, 10, 10 * 60 * 1000);
    const body = await readJson(request);
    const name = String(body.name || '').trim();
    const email = String(body.email || '').trim().toLowerCase();
    const password = String(body.password || '');
    const phone = String(body.phone || '').trim();
    if (name.length < 2 || name.length > 100) return sendJson(response, 400, { error: 'Informe seu nome completo.' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return sendJson(response, 400, { error: 'Informe um e-mail válido.' });
    if (password.length < 8 || password.length > 200) return sendJson(response, 400, { error: 'A senha precisa ter pelo menos 8 caracteres.' });
    if (phone && !/^[\d\s()+-]{8,20}$/.test(phone)) return sendJson(response, 400, { error: 'Telefone inválido.' });
    if (store.customers.some((entry) => entry.email === email)) {
      limiter.fail();
      return sendJson(response, 409, { error: 'Já existe uma conta com este e-mail. Faça login.' });
    }
    const customer = {
      id: randomBytes(10).toString('hex'),
      name,
      email,
      phone,
      password: hashPassword(password),
      createdAt: new Date().toISOString()
    };
    store.customers.push(customer);
    await saveStore();
    limiter.reset();
    const sessionId = randomBytes(32).toString('hex');
    customerSessions.set(sessionId, { customerId: customer.id, expiresAt: Date.now() + CUSTOMER_SESSION_TTL_MS });
    return sendJson(response, 201, { customer: publicCustomer(customer) }, {
      'Set-Cookie': customerCookie(sessionId, CUSTOMER_SESSION_TTL_MS / 1000)
    });
  }

  if (pathname === '/api/auth/login' && request.method === 'POST') {
    const ip = request.socket.remoteAddress || 'unknown';
    const limiter = checkRateLimit(`auth:${ip}`, 10, 10 * 60 * 1000);
    const body = await readJson(request);
    const email = String(body.email || '').trim().toLowerCase();
    const password = String(body.password || '');
    const customer = store.customers.find((entry) => entry.email === email);
    if (!customer || !verifyPassword(password, customer.password)) {
      limiter.fail();
      return sendJson(response, 401, { error: 'E-mail ou senha incorretos.' });
    }
    limiter.reset();
    const sessionId = randomBytes(32).toString('hex');
    customerSessions.set(sessionId, { customerId: customer.id, expiresAt: Date.now() + CUSTOMER_SESSION_TTL_MS });
    return sendJson(response, 200, { customer: publicCustomer(customer) }, {
      'Set-Cookie': customerCookie(sessionId, CUSTOMER_SESSION_TTL_MS / 1000)
    });
  }

  if (pathname === '/api/auth/logout' && request.method === 'POST') {
    const sessionId = parseCookies(request).customer_session;
    if (sessionId) customerSessions.delete(sessionId);
    return sendJson(response, 200, { ok: true }, { 'Set-Cookie': customerCookie('', 0) });
  }

  if (pathname === '/api/auth/me' && request.method === 'GET') {
    const customer = currentCustomer(request);
    return customer ? sendJson(response, 200, { customer: publicCustomer(customer) }) : sendJson(response, 401, { error: 'Nenhuma sessão ativa.' });
  }

  if (pathname === '/api/auth/forgot' && request.method === 'POST') {
    const ip = request.socket.remoteAddress || 'unknown';
    const limiter = checkRateLimit(`forgot:${ip}`, 3, 15 * 60 * 1000);
    const body = await readJson(request);
    const email = String(body.email || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return sendJson(response, 400, { error: 'Informe um e-mail válido.' });
    const customer = store.customers.find((entry) => entry.email === email);
    if (!isMailConfigured()) {
      return sendJson(response, 503, { error: 'O envio de e-mail ainda não está configurado na loja. Fale conosco para redefinir sua senha.' });
    }
    if (!customer) {
      limiter.fail();
      return sendJson(response, 200, { ok: true });
    }
    const token = randomBytes(24).toString('hex');
    passwordResetTokens.set(token, { customerId: customer.id, expiresAt: Date.now() + 60 * 60 * 1000 });
    for (const [key, value] of passwordResetTokens) {
      if (value.expiresAt < Date.now()) passwordResetTokens.delete(key);
    }
    const storeUrl = (process.env.STORE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
    const resetUrl = `${storeUrl}/account.html?reset=${token}`;
    const html = `<!doctype html>
<html lang="pt-BR"><body style="margin:0;background:#06080c;font-family:Arial,Helvetica,sans-serif;color:#e8eef7">
  <div style="max-width:640px;margin:0 auto;padding:28px 20px">
    <div style="font-size:12px;letter-spacing:.28em;color:#3ee0ff;text-transform:uppercase">Camada 3D · recuperação de acesso</div>
    <h1 style="font-size:26px;margin:10px 0 6px;color:#fff">Redefinir senha</h1>
    <p style="color:#8b9aad;margin:0 0 18px;font-size:14px">Recebemos uma solicitação para redefinir a senha da sua conta. Use o botão abaixo para definir uma nova senha.</p>
    <div style="background:#0d131c;border:1px solid #1e2a38;border-radius:14px;padding:20px;margin-bottom:18px">
      <p style="color:#8b9aad;font-size:13px;margin:0 0 12px">O link é válido por <strong style="color:#3ee0ff">1 hora</strong> e funciona uma única vez. Se você não solicitou, ignore este e-mail.</p>
      <a href="${resetUrl}" style="display:inline-block;background:#3ee0ff;color:#04121a;font-weight:bold;text-decoration:none;padding:12px 22px;border-radius:10px">Definir nova senha</a>
      <p style="color:#4b5b6e;font-size:11px;margin:14px 0 0;word-break:break-all">${resetUrl}</p>
    </div>
    <p style="color:#4b5b6e;font-size:11px;margin:0">Por segurança, a senha nova é definida por você. Nunca compartilhe este link.</p>
  </div>
</body></html>`;
    try {
      await sendMail({ to: [customer.email], subject: 'Redefinir sua senha · Camada 3D', html, text: `Redefinir sua senha · Camada 3D\n\nUse o link abaixo (válido por 1 hora, uma única vez):\n${resetUrl}\n\nSe você não solicitou, ignore este e-mail.` });
    } catch (error) {
      passwordResetTokens.delete(token);
      console.error('Reset e-mail could not be sent:', error.message);
      return sendJson(response, 502, { error: 'Não conseguimos enviar o e-mail agora. Tente novamente em instantes.' });
    }
    limiter.reset();
    return sendJson(response, 200, { ok: true });
  }

  if (pathname === '/api/auth/reset' && request.method === 'POST') {
    const ip = request.socket.remoteAddress || 'unknown';
    const limiter = checkRateLimit(`reset:${ip}`, 10, 15 * 60 * 1000);
    const body = await readJson(request);
    const token = String(body.token || '').trim();
    const password = String(body.password || '');
    const entry = passwordResetTokens.get(token);
    if (!entry || entry.expiresAt < Date.now()) {
      limiter.fail();
      return sendJson(response, 400, { error: 'Este link é inválido ou expirou. Solicite um novo.' });
    }
    if (password.length < 8 || password.length > 200) {
      return sendJson(response, 400, { error: 'A senha precisa ter pelo menos 8 caracteres.' });
    }
    const customer = store.customers.find((found) => found.id === entry.customerId);
    if (!customer) {
      passwordResetTokens.delete(token);
      return sendJson(response, 404, { error: 'Conta não encontrada.' });
    }
    customer.password = hashPassword(password);
    await saveStore();
    passwordResetTokens.delete(token);
    for (const [key, value] of customerSessions) {
      if (value.customerId === customer.id) customerSessions.delete(key);
    }
    limiter.reset();
    const sessionId = randomBytes(32).toString('hex');
    customerSessions.set(sessionId, { customerId: customer.id, expiresAt: Date.now() + CUSTOMER_SESSION_TTL_MS });
    return sendJson(response, 200, { ok: true, customer: publicCustomer(customer) }, {
      'Set-Cookie': customerCookie(sessionId, CUSTOMER_SESSION_TTL_MS / 1000)
    });
  }

  if (pathname === '/api/account/orders' && request.method === 'GET') {
    const customer = currentCustomer(request);
    if (!customer) return sendJson(response, 401, { error: 'Faça login para ver seus pedidos.' });
    const orders = store.orders
      .filter((order) => order.customerId === customer.id || order.customer?.email === customer.email)
      .slice(0, 50);
    return sendJson(response, 200, orders);
  }

  /* ----- pedido com pagamento combinado / por e-mail ----- */

  if (pathname === '/api/orders' && request.method === 'POST') {
    const body = await readJson(request);
    const prepared = prepareOrder(body, request);
    const order = createOrderRecord(prepared, {
      paymentProvider: 'Pagamento combinado',
      paymentMethod: 'invoice',
      reserveStock: true
    });
    store.orders.unshift(order);
    await saveStore();
    const emailSent = await notifyNewOrder(order);
    await saveStore();
    return sendJson(response, 201, {
      orderId: order.id,
      code: order.id.slice(0, 8).toUpperCase(),
      total: order.total,
      shipping: order.shipping,
      emailSent,
      emailConfigured: isMailConfigured()
    });
  }

  /* ----- administração ----- */

  if (pathname === '/api/admin/login' && request.method === 'POST') {
    const ip = request.socket.remoteAddress || 'unknown';
    const limiter = checkRateLimit(`admin:${ip}`, 5, 5 * 60 * 1000);
    const body = await readJson(request);
    const suppliedDigest = scryptSync(String(body.password || ''), 'camada-3d-admin', 32);
    if (!timingSafeEqual(passwordDigest, suppliedDigest)) {
      limiter.fail();
      return sendJson(response, 401, { error: 'Senha incorreta.' });
    }
    limiter.reset();
    const sessionId = randomBytes(32).toString('hex');
    sessions.set(sessionId, { expiresAt: Date.now() + SESSION_TTL_MS });
    const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
    return sendJson(response, 200, { ok: true }, {
      'Set-Cookie': `admin_session=${sessionId}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_MS / 1000}${secure}`
    });
  }

  if (pathname === '/api/admin/logout' && request.method === 'POST') {
    const sessionId = parseCookies(request).admin_session;
    if (sessionId) sessions.delete(sessionId);
    return sendJson(response, 200, { ok: true }, { 'Set-Cookie': 'admin_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' });
  }

  if (pathname === '/api/admin/me' && request.method === 'GET') {
    return isAdmin(request) ? sendJson(response, 200, { authenticated: true }) : sendJson(response, 401, { error: 'Faça login para continuar.' });
  }

  if (pathname.startsWith('/api/admin/')) {
    if (!isAdmin(request)) return sendJson(response, 401, { error: 'Faça login para continuar.' });
    if (pathname === '/api/admin/uploads' && request.method === 'POST') return handleUpload(request, response);
    if (pathname === '/api/admin/orders' && request.method === 'GET') return sendJson(response, 200, store.orders);
    if (pathname === '/api/admin/customers' && request.method === 'GET') {
      return sendJson(response, 200, store.customers.map(publicCustomer));
    }
    if (pathname === '/api/admin/products' && request.method === 'GET') return sendJson(response, 200, store.products);
    if (pathname === '/api/admin/products' && request.method === 'POST') {
      const body = await readJson(request);
      const product = { id: randomBytes(8).toString('hex'), ...normalizeProduct(body) };
      store.products.unshift(product);
      await saveStore();
      return sendJson(response, 201, product);
    }
    const productMatch = pathname.match(/^\/api\/admin\/products\/([a-zA-Z0-9-]+)$/);
    if (productMatch && request.method === 'PATCH') {
      const product = store.products.find((entry) => entry.id === productMatch[1]);
      if (!product) return sendJson(response, 404, { error: 'Produto não encontrado.' });
      Object.assign(product, normalizeProduct(await readJson(request), product));
      await saveStore();
      return sendJson(response, 200, product);
    }
    if (productMatch && request.method === 'DELETE') {
      const index = store.products.findIndex((entry) => entry.id === productMatch[1]);
      if (index < 0) return sendJson(response, 404, { error: 'Produto não encontrado.' });
      store.products[index].active = false;
      await saveStore();
      return sendJson(response, 200, { ok: true });
    }
    const orderMatch = pathname.match(/^\/api\/admin\/orders\/([a-zA-Z0-9-]+)$/);
    if (orderMatch && request.method === 'PATCH') {
      const order = store.orders.find((entry) => entry.id === orderMatch[1]);
      const body = await readJson(request);
      const nextStatuses = {
        pending: ['paid', 'cancelled'],
        paid: ['preparing', 'shipped', 'delivered', 'cancelled'],
        preparing: ['shipped', 'delivered', 'cancelled'],
        shipped: ['delivered'],
        delivered: [],
        cancelled: []
      };
      if (!order) return sendJson(response, 404, { error: 'Pedido não encontrado.' });
      if (!nextStatuses[order.status]?.includes(body.status)) {
        return sendJson(response, 400, { error: 'Status de pedido inválido.' });
      }
      if (body.status === 'cancelled' && order.stockReserved) {
        for (const item of order.items) {
          const product = store.products.find((entry) => entry.id === item.id);
          if (product) product.stock += item.quantity;
        }
        order.stockReserved = false;
      }
      if (body.status === 'paid' && !order.paidAt) order.paidAt = new Date().toISOString();
      order.status = body.status;
      order.updatedAt = new Date().toISOString();
      await saveStore();
      return sendJson(response, 200, order);
    }
    return sendJson(response, 404, { error: 'Rota administrativa não encontrada.' });
  }

  /* ----- PayPal ----- */

  if (pathname === '/api/paypal/create-order' && request.method === 'POST') {
    const prepared = prepareOrder(await readJson(request), request);
    const order = createOrderRecord(prepared, {
      paymentProvider: 'PayPal',
      paymentMethod: 'paypal',
      reserveStock: false
    });
    const paypalOrder = await paypalRequest('/v2/checkout/orders', {
      method: 'POST',
      body: JSON.stringify({
        intent: 'CAPTURE',
        purchase_units: [{
          reference_id: order.id,
          custom_id: order.id,
          invoice_id: `C3D-${order.id}`,
          amount: {
            currency_code: 'BRL',
            value: order.total.toFixed(2),
            breakdown: {
              item_total: { currency_code: 'BRL', value: order.subtotal.toFixed(2) },
              shipping: { currency_code: 'BRL', value: order.shippingPrice.toFixed(2) }
            }
          },
          items: order.items.map((item) => ({
            name: item.name.slice(0, 127),
            quantity: String(item.quantity),
            unit_amount: { currency_code: 'BRL', value: item.unitPrice.toFixed(2) },
            category: 'PHYSICAL_GOODS'
          })),
          shipping: {
            name: { full_name: order.customer.name },
            address: {
              address_line_1: order.customer.address,
              admin_area_2: order.customer.city,
              admin_area_1: order.customer.state,
              postal_code: order.customer.postalCode,
              country_code: 'BR'
            }
          }
        }],
        application_context: { user_action: 'PAY_NOW', shipping_preference: 'SET_PROVIDED_ADDRESS' }
      })
    });
    order.paypalOrderId = paypalOrder.id;
    store.orders.unshift(order);
    await saveStore();
    return sendJson(response, 201, { paypalOrderId: paypalOrder.id, orderId: order.id, total: order.total });
  }

  if (pathname === '/api/paypal/capture' && request.method === 'POST') {
    const body = await readJson(request);
    const paypalOrderId = String(body.paypalOrderId || '');
    const captureOperation = paypalCaptureQueue.then(async () => {
      const order = store.orders.find((entry) => entry.paypalOrderId === paypalOrderId);
      if (!order) throw httpError('Pedido PayPal não encontrado.', 404);
      if (order.status !== 'pending') throw httpError('Este pedido já foi processado.', 409);
      const inventoryAvailable = order.items.every((item) => {
        const product = store.products.find((entry) => entry.id === item.id);
        return product && product.stock >= item.quantity;
      });
      if (!inventoryAvailable) throw httpError('Estoque insuficiente para concluir este pedido. Entre em contato com a loja.', 409);
      const captured = await paypalRequest(`/v2/checkout/orders/${encodeURIComponent(paypalOrderId)}/capture`, {
        method: 'POST',
        body: JSON.stringify({})
      });
      const capture = captured.purchase_units?.[0]?.payments?.captures?.[0];
      if (captured.status !== 'COMPLETED' || capture?.status !== 'COMPLETED' ||
          capture.amount?.currency_code !== order.currency || round(capture.amount?.value) !== order.total) {
        console.error('PayPal capture did not match the expected order:', paypalOrderId, captured.status);
        throw httpError('Não foi possível confirmar o pagamento. Entre em contato antes de tentar novamente.', 502);
      }
      for (const item of order.items) {
        const product = store.products.find((entry) => entry.id === item.id);
        product.stock -= item.quantity;
      }
      order.status = 'paid';
      order.stockReserved = false;
      order.paypalCaptureId = capture.id;
      order.paidAt = new Date().toISOString();
      const emailSent = await notifyNewOrder(order);
      await saveStore();
      return { ok: true, orderId: order.id, code: order.id.slice(0, 8).toUpperCase(), status: order.status, total: order.total, shipping: order.shipping, emailSent };
    });
    paypalCaptureQueue = captureOperation.then(() => undefined, () => undefined);
    try {
      return sendJson(response, 200, await captureOperation);
    } catch (error) {
      if (error.status) return sendJson(response, error.status, { error: error.message });
      throw error;
    }
  }

  return sendJson(response, 404, { error: 'Rota não encontrada.' });
}

/* ------------------------------------------------------------------ */
/* Arquivos estáticos                                                  */
/* ------------------------------------------------------------------ */

const contentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon'
};

const securityHeaders = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'self'; script-src 'self' https://www.paypal.com https://www.paypalobjects.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: https://*.paypal.com https://*.paypalobjects.com; frame-src https://*.paypal.com; connect-src 'self' https://*.paypal.com https://*.paypalobjects.com; base-uri 'self'; form-action 'self' https://*.paypal.com; frame-ancestors 'none'; object-src 'none'"
};

async function serveFile(response, filePath, cache = 'no-cache') {
  const content = await readFile(filePath);
  response.writeHead(200, {
    'Content-Type': contentTypes[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
    'Cache-Control': cache,
    ...securityHeaders
  });
  response.end(content);
}

async function serveStatic(request, response, pathname) {
  if (pathname.startsWith('/uploads/')) {
    const fileName = decodeURIComponent(pathname.slice('/uploads/'.length));
    if (!/^[A-Za-z0-9._-]+$/.test(fileName)) {
      response.writeHead(403);
      return response.end('Forbidden');
    }
    try {
      return await serveFile(response, path.join(UPLOADS_DIR, fileName), 'public, max-age=31536000, immutable');
    } catch (error) {
      if (error.code === 'ENOENT') {
        response.writeHead(404);
        return response.end('Not found');
      }
      throw error;
    }
  }

  const requestedPath = pathname === '/' ? 'index.html' : decodeURIComponent(pathname.slice(1));
  const normalizedPath = path.normalize(requestedPath);
  let filePath = path.resolve(PUBLIC_DIR, normalizedPath);
  if (!filePath.startsWith(`${PUBLIC_DIR}${path.sep}`) && filePath !== PUBLIC_DIR) {
    response.writeHead(403);
    return response.end('Forbidden');
  }
  try {
    return await serveFile(response, filePath);
  } catch (error) {
    if (error.code === 'ENOENT' && !path.extname(filePath)) {
      try {
        return await serveFile(response, `${filePath}.html`);
      } catch (nested) {
        if (nested.code !== 'ENOENT') throw nested;
      }
    }
    if (error.code === 'ENOENT') {
      response.writeHead(404);
      return response.end('Not found');
    }
    throw error;
  }
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
    if (url.pathname.startsWith('/api/')) await handleApi(request, response, url);
    else await serveStatic(request, response, url.pathname);
  } catch (error) {
    if (response.headersSent) {
      response.destroy(error);
      return;
    }
    if (!error.status || error.status >= 500) console.error('Request failed:', error);
    sendJson(response, error.status || 500, { error: error.status ? error.message : 'Erro interno do servidor.' });
  }
});

server.listen(PORT, () => {
  console.log(`Camada 3D disponível em http://localhost:${PORT}`);
  console.log(`PayPal: ${process.env.PAYPAL_ENV === 'live' ? 'produção' : 'sandbox'}`);
  console.log(`E-mail de pedidos: ${isMailConfigured() ? 'configurado' : 'não configurado'}`);
});

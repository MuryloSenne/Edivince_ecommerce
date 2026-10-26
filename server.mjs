import { createServer } from 'node:http';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const STORE_FILE = path.join(DATA_DIR, 'store.json');
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const sessions = new Map();
const loginAttempts = new Map();
const paypalTokens = { value: '', expiresAt: 0 };
let paypalCaptureQueue = Promise.resolve();

await loadEnvironment();
const PORT = Number(process.env.PORT || 3000);
const adminPassword = process.env.ADMIN_PASSWORD;
if (!adminPassword || adminPassword.length < 12 || adminPassword === 'change-this-to-a-long-unique-password') {
  console.error('Configure ADMIN_PASSWORD with a unique password of at least 12 characters in .env.');
  process.exit(1);
}

const passwordDigest = scryptSync(adminPassword, 'camada-3d-admin', 32);
await mkdir(DATA_DIR, { recursive: true });
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
      { id: 'suporte-fone', name: 'Suporte para fones', description: 'Design minimalista para manter sua mesa organizada. Impresso sob demanda em PLA resistente.', price: 59.9, stock: 18, category: 'Organização', emoji: '🎧', color: '#d9e6ff', active: true },
      { id: 'vaso-aurora', name: 'Vaso Aurora', description: 'Vaso decorativo com textura geométrica. Ideal para plantas pequenas e decoração contemporânea.', price: 74.9, stock: 12, category: 'Decoração', emoji: '🪴', color: '#f8dfd5', active: true },
      { id: 'articulado-dragao', name: 'Dragão articulado', description: 'Peça articulada impressa em uma única montagem. Presente criativo para colecionadores.', price: 89.9, stock: 9, category: 'Miniaturas', emoji: '🐉', color: '#e3dbf7', active: true },
      { id: 'luminaria-orbita', name: 'Luminária Órbita', description: 'Cúpula vazada com efeito de luz suave. Compatível com soquete LED compacto (não incluso).', price: 129.9, stock: 7, category: 'Decoração', emoji: '💡', color: '#f6edc9', active: true },
      { id: 'organizador-modular', name: 'Organizador modular', description: 'Módulo empilhável para organizar acessórios, ferramentas e itens de escritório.', price: 42.9, stock: 24, category: 'Organização', emoji: '🧩', color: '#d9eee7', active: true },
      { id: 'chaveiro-personalizado', name: 'Chaveiro personalizado', description: 'Leve e resistente, disponível em várias cores. Escreva para nós para personalizar seu modelo.', price: 19.9, stock: 30, category: 'Acessórios', emoji: '🔑', color: '#f7ddeb', active: true }
    ],
    orders: []
  };
}

async function loadStore() {
  try {
    const saved = JSON.parse(await readFile(STORE_FILE, 'utf8'));
    return {
      products: Array.isArray(saved.products) ? saved.products : [],
      orders: Array.isArray(saved.orders) ? saved.orders : []
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
  const { rename } = await import('node:fs/promises');
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

function isSameOrigin(request) {
  const origin = request.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === request.headers.host;
  } catch {
    return false;
  }
}

async function readJson(request) {
  let body = '';
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 1_000_000) throw Object.assign(new Error('A solicitação excede o limite permitido.'), { status: 413 });
  }
  try {
    return JSON.parse(body || '{}');
  } catch {
    throw Object.assign(new Error('O corpo da solicitação não é um JSON válido.'), { status: 400 });
  }
}

function normalizeProduct(input, existing = {}) {
  const name = String(input.name ?? existing.name ?? '').trim();
  const description = String(input.description ?? existing.description ?? '').trim();
  const price = Number(input.price ?? existing.price);
  const stock = Number(input.stock ?? existing.stock);
  const category = String(input.category ?? existing.category ?? '').trim();
  const emoji = String(input.emoji ?? existing.emoji ?? '🧊').trim();
  const color = String(input.color ?? existing.color ?? '#d9e6ff').trim();
  if (!name || name.length > 100 || !description || description.length > 500 || !category || category.length > 50) {
    throw Object.assign(new Error('Informe nome, descrição e categoria válidos.'), { status: 400 });
  }
  if (!Number.isFinite(price) || price < 0.01 || price > 100000 || !Number.isInteger(stock) || stock < 0 || stock > 100000) {
    throw Object.assign(new Error('Preço ou estoque inválido.'), { status: 400 });
  }
  if (emoji.length > 8 || !/^#[0-9a-f]{6}$/i.test(color)) {
    throw Object.assign(new Error('Emoji ou cor inválidos.'), { status: 400 });
  }
  return { name, description, price: Math.round(price * 100) / 100, stock, category, emoji, color, active: input.active === undefined ? existing.active !== false : input.active === true };
}

function normalizeCustomer(input) {
  const customer = {
    name: String(input.name || '').trim(),
    email: String(input.email || '').trim(),
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
    throw Object.assign(new Error('Confira nome, e-mail e endereço de entrega. O CEP deve ter 8 dígitos.'), { status: 400 });
  }
  return customer;
}

async function paypalRequest(endpoint, options = {}) {
  const clientId = process.env.PAYPAL_CLIENT_ID;
  const clientSecret = process.env.PAYPAL_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw Object.assign(new Error('PayPal ainda não configurado. Adicione PAYPAL_CLIENT_ID e PAYPAL_CLIENT_SECRET ao arquivo .env.'), { status: 503 });
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
    if (!tokenResponse.ok) throw Object.assign(new Error('Não foi possível autenticar com o PayPal. Verifique as credenciais configuradas.'), { status: 502 });
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
    throw Object.assign(new Error('O PayPal não conseguiu processar a solicitação. Tente novamente.'), { status: 502 });
  }
  return body;
}

async function handleApi(request, response, url) {
  const { pathname } = url;
  if (request.method !== 'GET' && !isSameOrigin(request)) {
    return sendJson(response, 403, { error: 'Origem da solicitação não permitida.' });
  }

  if (pathname === '/api/config' && request.method === 'GET') {
    return sendJson(response, 200, {
      paypalClientId: process.env.PAYPAL_CLIENT_ID || '',
      currency: 'BRL',
      paypalConfigured: Boolean(process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET)
    });
  }

  if (pathname === '/api/products' && request.method === 'GET') {
    return sendJson(response, 200, store.products.filter((product) => product.active));
  }

  if (pathname === '/api/admin/login' && request.method === 'POST') {
    const ip = request.socket.remoteAddress || 'unknown';
    const attempt = loginAttempts.get(ip) || { count: 0, blockedUntil: 0 };
    if (attempt.blockedUntil > Date.now()) return sendJson(response, 429, { error: 'Muitas tentativas. Aguarde alguns minutos e tente novamente.' });
    const body = await readJson(request);
    const suppliedDigest = scryptSync(String(body.password || ''), 'camada-3d-admin', 32);
    if (!timingSafeEqual(passwordDigest, suppliedDigest)) {
      attempt.count += 1;
      if (attempt.count >= 5) {
        attempt.count = 0;
        attempt.blockedUntil = Date.now() + 5 * 60 * 1000;
      }
      loginAttempts.set(ip, attempt);
      return sendJson(response, 401, { error: 'Senha incorreta.' });
    }
    loginAttempts.delete(ip);
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
    if (pathname === '/api/admin/orders' && request.method === 'GET') return sendJson(response, 200, store.orders);
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
        paid: ['preparing', 'shipped', 'delivered'],
        preparing: ['shipped', 'delivered'],
        shipped: ['delivered'],
        delivered: [],
        cancelled: []
      };
      if (!order) return sendJson(response, 404, { error: 'Pedido não encontrado.' });
      if (!nextStatuses[order.status]?.includes(body.status)) {
        return sendJson(response, 400, { error: 'Status de pedido inválido.' });
      }
      order.status = body.status;
      order.updatedAt = new Date().toISOString();
      await saveStore();
      return sendJson(response, 200, order);
    }
    return sendJson(response, 404, { error: 'Rota administrativa não encontrada.' });
  }

  if (pathname === '/api/paypal/create-order' && request.method === 'POST') {
    const body = await readJson(request);
    const customer = normalizeCustomer(body.customer || {});
    if (!Array.isArray(body.items) || !body.items.length || body.items.length > 50) {
      return sendJson(response, 400, { error: 'O carrinho está vazio ou contém itens demais.' });
    }
    const quantities = new Map();
    for (const item of body.items) {
      const quantity = Number(item.quantity);
      if (!Number.isInteger(quantity) || quantity < 1 || quantity > 99) return sendJson(response, 400, { error: 'Quantidade de produto inválida.' });
      quantities.set(String(item.id), (quantities.get(String(item.id)) || 0) + quantity);
    }
    const items = [];
    for (const [id, quantity] of quantities) {
      const product = store.products.find((entry) => entry.id === id && entry.active);
      if (!product || product.stock < quantity) return sendJson(response, 400, { error: 'Um produto ficou indisponível ou não tem estoque suficiente. Atualize seu carrinho.' });
      items.push({ id: product.id, name: product.name, quantity, unitPrice: product.price });
    }
    const total = Math.round(items.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0) * 100) / 100;
    const internalOrderId = randomBytes(12).toString('hex');
    const order = {
      id: internalOrderId,
      status: 'pending',
      paymentProvider: 'PayPal',
      currency: 'BRL',
      total,
      items,
      customer,
      createdAt: new Date().toISOString()
    };
    const paypalOrder = await paypalRequest('/v2/checkout/orders', {
      method: 'POST',
      body: JSON.stringify({
        intent: 'CAPTURE',
        purchase_units: [{
          reference_id: internalOrderId,
          custom_id: internalOrderId,
          invoice_id: `C3D-${internalOrderId}`,
          amount: { currency_code: 'BRL', value: total.toFixed(2) },
          items: items.map((item) => ({
            name: item.name.slice(0, 127),
            quantity: String(item.quantity),
            unit_amount: { currency_code: 'BRL', value: item.unitPrice.toFixed(2) },
            category: 'PHYSICAL_GOODS'
          })),
          shipping: {
            name: { full_name: customer.name },
            address: {
              address_line_1: customer.address,
              admin_area_2: customer.city,
              admin_area_1: customer.state,
              postal_code: customer.postalCode,
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
    return sendJson(response, 201, { paypalOrderId: paypalOrder.id });
  }

  if (pathname === '/api/paypal/capture' && request.method === 'POST') {
    const body = await readJson(request);
    const paypalOrderId = String(body.paypalOrderId || '');
    const captureOperation = paypalCaptureQueue.then(async () => {
      const order = store.orders.find((entry) => entry.paypalOrderId === paypalOrderId);
      if (!order) throw Object.assign(new Error('Pedido PayPal não encontrado.'), { status: 404 });
      if (order.status !== 'pending') throw Object.assign(new Error('Este pedido já foi processado.'), { status: 409 });
      const inventoryAvailable = order.items.every((item) => {
        const product = store.products.find((entry) => entry.id === item.id);
        return product && product.stock >= item.quantity;
      });
      if (!inventoryAvailable) throw Object.assign(new Error('Estoque insuficiente para concluir este pedido. Entre em contato com a loja.'), { status: 409 });
      const captured = await paypalRequest(`/v2/checkout/orders/${encodeURIComponent(paypalOrderId)}/capture`, {
        method: 'POST',
        body: JSON.stringify({})
      });
      const capture = captured.purchase_units?.[0]?.payments?.captures?.[0];
      if (captured.status !== 'COMPLETED' || capture?.status !== 'COMPLETED' ||
          capture.amount?.currency_code !== order.currency || Number(capture.amount?.value) !== order.total) {
        console.error('PayPal capture did not match the expected order:', paypalOrderId, captured.status);
        throw Object.assign(new Error('Não foi possível confirmar o pagamento. Entre em contato antes de tentar novamente.'), { status: 502 });
      }
      for (const item of order.items) {
        const product = store.products.find((entry) => entry.id === item.id);
        product.stock -= item.quantity;
      }
      order.status = 'paid';
      order.paypalCaptureId = capture.id;
      order.paidAt = new Date().toISOString();
      await saveStore();
      return { ok: true, orderId: order.id, status: order.status };
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

const contentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml'
};

async function serveStatic(request, response, pathname) {
  const requestedPath = pathname === '/' ? 'index.html' : decodeURIComponent(pathname.slice(1));
  const normalizedPath = path.normalize(requestedPath);
  const filePath = path.resolve(PUBLIC_DIR, normalizedPath);
  if (!filePath.startsWith(`${PUBLIC_DIR}${path.sep}`) && filePath !== PUBLIC_DIR) {
    response.writeHead(403);
    return response.end('Forbidden');
  }
  try {
    const content = await readFile(filePath);
    response.writeHead(200, {
      'Content-Type': contentTypes[path.extname(filePath)] || 'application/octet-stream',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'X-Frame-Options': 'DENY',
      'Content-Security-Policy': "default-src 'self'; script-src 'self' https://www.paypal.com https://www.paypalobjects.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: https://*.paypal.com https://*.paypalobjects.com; frame-src https://*.paypal.com; connect-src 'self' https://*.paypal.com https://*.paypalobjects.com; base-uri 'self'; form-action 'self' https://*.paypal.com; frame-ancestors 'none'; object-src 'none'"
    });
    response.end(content);
  } catch (error) {
    if (error.code === 'ENOENT') {
      response.writeHead(404);
      return response.end('Not found');
    }
    throw error;
  }
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
    console.error('Request failed:', error);
    sendJson(response, error.status || 500, { error: error.status ? error.message : 'Erro interno do servidor.' });
  }
});

server.listen(PORT, () => {
  console.log(`Camada 3D disponível em http://localhost:${PORT}`);
  console.log(`PayPal: ${process.env.PAYPAL_ENV === 'live' ? 'produção' : 'sandbox'}`);
});

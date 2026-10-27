import { api, escapeHtml, money } from './shared.js';

const loginPanel = document.querySelector('#login-panel');
const dashboard = document.querySelector('#dashboard');
const loginForm = document.querySelector('#login-form');
const loginNotice = document.querySelector('#login-notice');
const productModal = document.querySelector('#product-modal');
const productForm = document.querySelector('#product-form');
const productNotice = document.querySelector('#product-notice');
const imageInput = document.querySelector('#image-input');
const imagePreview = document.querySelector('#image-preview');
const imageStatus = document.querySelector('#image-status');

const STATUS_LABELS = { paid: 'Pago', preparing: 'Em preparo', shipped: 'Enviado', delivered: 'Entregue', cancelled: 'Cancelado', pending: 'Aguardando' };
const NEXT_STATUSES = {
  pending: ['paid', 'cancelled'],
  paid: ['preparing', 'shipped', 'delivered', 'cancelled'],
  preparing: ['shipped', 'delivered', 'cancelled'],
  shipped: ['delivered'],
  delivered: [],
  cancelled: []
};

let orders = [];
let products = [];
let customers = [];
let pendingImage = '';

function date(value) {
  return new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(value));
}

function showDashboard() {
  loginPanel.hidden = true;
  dashboard.hidden = false;
}

function renderStats() {
  const confirmed = orders.filter((order) => ['paid', 'preparing', 'shipped', 'delivered'].includes(order.status));
  const revenue = confirmed.reduce((sum, order) => sum + order.total, 0);
  const average = confirmed.length ? revenue / confirmed.length : 0;
  document.querySelector('#stats-grid').innerHTML = [
    ['Pedidos', orders.length],
    ['Vendas confirmadas', confirmed.length],
    ['Receita bruta', money(revenue)],
    ['Ticket médio', money(average)],
    ['Clientes', customers.length]
  ].map(([label, value]) => `<div class="stat-card"><span>${label}</span><strong>${value}</strong></div>`).join('');
}

function renderOrders() {
  const body = document.querySelector('#orders-table');
  if (!orders.length) {
    body.innerHTML = '<tr><td colspan="7" class="table-empty">Ainda não há pedidos. Suas vendas aparecerão aqui.</td></tr>';
    return;
  }
  body.innerHTML = orders.map((order) => {
    const options = NEXT_STATUSES[order.status] || [];
    const select = options.length
      ? `<select class="status-select" data-order="${escapeHtml(order.id)}"><option value="">Alterar status</option>${options.map((status) => `<option value="${status}">${STATUS_LABELS[status]}</option>`).join('')}</select>`
      : '<span class="muted-cell">Finalizado</span>';
    return `<tr>
      <td class="order-code">#${escapeHtml(order.id.slice(0, 8).toUpperCase())}</td>
      <td>${escapeHtml(order.customer.name)}<br><span class="muted-cell">${escapeHtml(order.customer.email)}</span></td>
      <td>${escapeHtml(date(order.createdAt))}</td>
      <td>${money(order.total)}</td>
      <td><span class="muted-cell">${escapeHtml(order.shipping?.carrier || '—')} · ${money(order.shippingPrice ?? 0)}</span><br><span class="muted-cell">${escapeHtml(order.paymentProvider || '—')}</span></td>
      <td><span class="status-pill ${escapeHtml(order.status)}">${escapeHtml(STATUS_LABELS[order.status] || order.status)}</span></td>
      <td>${select}</td>
    </tr>`;
  }).join('');
  body.querySelectorAll('[data-order]').forEach((select) => select.addEventListener('change', () => updateOrder(select.dataset.order, select.value)));
}

function renderProducts() {
  const body = document.querySelector('#products-table');
  if (!products.length) {
    body.innerHTML = '<tr><td colspan="6" class="table-empty">Nenhum produto cadastrado.</td></tr>';
    return;
  }
  body.innerHTML = products.map((product) => {
    const thumb = product.image
      ? `<img class="admin-thumb" src="${escapeHtml(product.image)}" alt="">`
      : `<span class="admin-thumb fallback" style="--card-tint:${escapeHtml(product.color)}">${escapeHtml(product.emoji)}</span>`;
    return `<tr>
      <td><div class="admin-product">${thumb}<div><strong>${escapeHtml(product.name)}</strong><span class="muted-cell">${escapeHtml(product.id.slice(0, 10))}</span></div></div></td>
      <td>${escapeHtml(product.category)}</td>
      <td>${money(product.price)}</td>
      <td>${product.stock}</td>
      <td><span class="status-pill ${product.active ? 'paid' : 'cancelled'}">${product.active ? 'Visível' : 'Oculto'}</span></td>
      <td><button class="row-action" data-edit="${escapeHtml(product.id)}">Editar</button> · <button class="row-action" data-toggle="${escapeHtml(product.id)}">${product.active ? 'Ocultar' : 'Reativar'}</button></td>
    </tr>`;
  }).join('');
  body.querySelectorAll('[data-edit]').forEach((button) => button.addEventListener('click', () => openProductModal(products.find((item) => item.id === button.dataset.edit))));
  body.querySelectorAll('[data-toggle]').forEach((button) => button.addEventListener('click', () => toggleProduct(button.dataset.toggle)));
}

function renderCustomers() {
  const body = document.querySelector('#customers-table');
  if (!customers.length) {
    body.innerHTML = '<tr><td colspan="5" class="table-empty">Nenhum cliente cadastrado ainda.</td></tr>';
    return;
  }
  body.innerHTML = customers.map((customer) => {
    const count = orders.filter((order) => order.customerId === customer.id || order.customer?.email === customer.email).length;
    return `<tr>
      <td><strong>${escapeHtml(customer.name)}</strong></td>
      <td>${escapeHtml(customer.email)}</td>
      <td>${escapeHtml(customer.phone || '—')}</td>
      <td>${escapeHtml(new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short' }).format(new Date(customer.createdAt)))}</td>
      <td>${count}</td>
    </tr>`;
  }).join('');
}

async function loadDashboard() {
  [orders, products, customers] = await Promise.all([
    api('/api/admin/orders'),
    api('/api/admin/products'),
    api('/api/admin/customers')
  ]);
  renderStats();
  renderOrders();
  renderProducts();
  renderCustomers();
}

async function updateOrder(id, status) {
  if (!status) return;
  try {
    await api(`/api/admin/orders/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ status }) });
    await loadDashboard();
  } catch (error) {
    alert(error.message);
    await loadDashboard().catch(() => {});
  }
}

async function toggleProduct(id) {
  const product = products.find((item) => item.id === id);
  if (!product) return;
  try {
    if (product.active) {
      await api(`/api/admin/products/${encodeURIComponent(id)}`, { method: 'DELETE' });
    } else {
      await api(`/api/admin/products/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ active: true }) });
    }
    await loadDashboard();
  } catch (error) {
    alert(error.message);
  }
}

function paintImage(url) {
  if (url) {
    imagePreview.innerHTML = `<img src="${escapeHtml(url)}" alt="Prévia da foto do produto">`;
    imagePreview.classList.add('has-image');
  } else {
    imagePreview.innerHTML = '<span>Enviar foto real do produto</span><small>PNG, JPG ou WebP · até 5 MB</small>';
    imagePreview.classList.remove('has-image');
  }
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('Não foi possível ler o arquivo.'));
    reader.readAsDataURL(file);
  });
}

async function resizeImage(file) {
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) throw new Error('Use uma imagem PNG, JPG ou WebP.');
  if (file.size > 8 * 1024 * 1024) throw new Error('A imagem é muito grande (máximo 8 MB).');
  const dataUrl = await readFileAsDataUrl(file);
  const image = new Image();
  await new Promise((resolve, reject) => {
    image.onload = resolve;
    image.onerror = () => reject(new Error('Arquivo de imagem inválido.'));
    image.src = dataUrl;
  });
  const maxSide = 1400;
  const scale = Math.min(1, maxSide / Math.max(image.width, image.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(image.width * scale));
  canvas.height = Math.max(1, Math.round(image.height * scale));
  const context = canvas.getContext('2d');
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/webp', 0.88);
}

imageInput.addEventListener('change', async () => {
  const file = imageInput.files?.[0];
  if (!file) return;
  imageStatus.textContent = 'Preparando imagem...';
  try {
    pendingImage = await resizeImage(file);
    paintImage(pendingImage);
    imageStatus.textContent = 'Foto pronta para envio ao salvar.';
  } catch (error) {
    pendingImage = '';
    imageInput.value = '';
    imageStatus.textContent = error.message;
  }
});

document.querySelector('#remove-image').addEventListener('click', () => {
  pendingImage = '';
  imageInput.value = '';
  productForm.elements.image.value = '';
  paintImage('');
  imageStatus.textContent = 'O produto voltará a usar o emoji e a cor de destaque.';
});

function openProductModal(product) {
  productForm.reset();
  pendingImage = '';
  imageInput.value = '';
  productForm.elements.id.value = product?.id || '';
  productForm.elements.image.value = product?.image || '';
  productForm.elements.name.value = product?.name || '';
  productForm.elements.description.value = product?.description || '';
  productForm.elements.price.value = product?.price ?? '';
  productForm.elements.stock.value = product?.stock ?? '';
  productForm.elements.category.value = product?.category || '';
  productForm.elements.emoji.value = product?.emoji || '🧊';
  productForm.elements.color.value = product?.color || '#1a2432';
  productForm.elements.active.checked = product?.active ?? true;
  paintImage(product?.image || '');
  imageStatus.textContent = product?.image ? 'Foto atual carregada.' : 'A imagem aparece na loja no lugar do emoji.';
  document.querySelector('#modal-title').textContent = product ? 'Editar produto' : 'Novo produto';
  productNotice.textContent = '';
  productModal.hidden = false;
  productForm.elements.name.focus();
}

loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  loginNotice.textContent = '';
  try {
    await api('/api/admin/login', { method: 'POST', body: JSON.stringify({ password: document.querySelector('#admin-password').value }) });
    showDashboard();
    await loadDashboard();
  } catch (error) {
    loginNotice.textContent = error.message;
  }
});

productForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  productNotice.textContent = '';
  const form = new FormData(productForm);
  const body = Object.fromEntries(form.entries());
  body.price = Number(body.price);
  body.stock = Number(body.stock);
  body.active = form.has('active');
  const id = body.id;
  delete body.id;
  const submitButton = productForm.querySelector('button[type="submit"]');
  submitButton.disabled = true;
  try {
    if (pendingImage) {
      imageStatus.textContent = 'Enviando foto...';
      const uploaded = await api('/api/admin/uploads', { method: 'POST', body: JSON.stringify({ dataUrl: pendingImage }) });
      body.image = uploaded.url;
      pendingImage = '';
      productForm.elements.image.value = uploaded.url;
      imageStatus.textContent = 'Foto enviada.';
    }
    await api(id ? `/api/admin/products/${encodeURIComponent(id)}` : '/api/admin/products', {
      method: id ? 'PATCH' : 'POST',
      body: JSON.stringify(body)
    });
    productModal.hidden = true;
    await loadDashboard();
  } catch (error) {
    productNotice.textContent = error.message;
  } finally {
    submitButton.disabled = false;
  }
});

document.querySelector('#add-product-button').addEventListener('click', () => openProductModal());
document.querySelector('#modal-close').addEventListener('click', () => { productModal.hidden = true; });
productModal.addEventListener('click', (event) => { if (event.target === productModal) productModal.hidden = true; });
document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && !productModal.hidden) productModal.hidden = true; });
document.querySelector('#refresh-button').addEventListener('click', () => loadDashboard().catch((error) => alert(error.message)));
document.querySelector('#logout-button').addEventListener('click', async () => {
  try {
    await api('/api/admin/logout', { method: 'POST', body: '{}' });
  } finally {
    dashboard.hidden = true;
    loginPanel.hidden = false;
  }
});
document.querySelectorAll('.admin-tab').forEach((tab) => tab.addEventListener('click', () => {
  document.querySelectorAll('.admin-tab').forEach((item) => item.classList.toggle('active', item === tab));
  document.querySelector('#orders-section').hidden = tab.dataset.tab !== 'orders';
  document.querySelector('#products-section').hidden = tab.dataset.tab !== 'products';
  document.querySelector('#customers-section').hidden = tab.dataset.tab !== 'customers';
}));

api('/api/config').then((config) => {
  const state = document.querySelector('#mail-state');
  state.textContent = config.emailConfigured ? 'E-mail: ativo' : 'E-mail: configurar .env';
  state.classList.toggle('is-off', !config.emailConfigured);
  document.querySelector('#email-banner').hidden = config.emailConfigured;
}).catch(() => {});

api('/api/admin/me').then(() => {
  showDashboard();
  return loadDashboard();
}).catch((error) => {
  if (error.message !== 'Faça login para continuar.') loginNotice.textContent = error.message;
});

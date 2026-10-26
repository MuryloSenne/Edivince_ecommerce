const loginPanel = document.querySelector('#login-panel');
const dashboard = document.querySelector('#dashboard');
const loginForm = document.querySelector('#login-form');
const loginNotice = document.querySelector('#login-notice');
const productModal = document.querySelector('#product-modal');
const productForm = document.querySelector('#product-form');
const productNotice = document.querySelector('#product-notice');
const productStatuses = { paid: 'Pago', preparing: 'Em preparo', shipped: 'Enviado', delivered: 'Entregue', cancelled: 'Cancelado', pending: 'Aguardando' };
let orders = [];
let products = [];

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

function money(value) {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(value);
}

function date(value) {
  return new Intl.DateTimeFormat('pt-BR', { dateStyle: 'medium' }).format(new Date(value));
}

async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { 'Content-Type': 'application/json', ...(options.headers || {}) } });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Não foi possível concluir a solicitação.');
  return result;
}

function displayDashboard() {
  loginPanel.hidden = true;
  dashboard.hidden = false;
}

function renderStats() {
  const paidOrders = orders.filter((order) => ['paid', 'preparing', 'shipped', 'delivered'].includes(order.status));
  const revenue = paidOrders.reduce((sum, order) => sum + order.total, 0);
  document.querySelector('#stats-grid').innerHTML = [
    ['Pedidos', orders.length],
    ['Vendas confirmadas', paidOrders.length],
    ['Receita bruta', money(revenue)],
    ['Produtos ativos', products.filter((product) => product.active).length]
  ].map(([label, value]) => `<div class="stat-card"><span>${label}</span><strong>${value}</strong></div>`).join('');
}

function renderOrders() {
  const body = document.querySelector('#orders-table');
  if (!orders.length) {
    body.innerHTML = '<tr><td colspan="6" class="table-empty">Ainda não há pedidos. Suas vendas aparecerão aqui.</td></tr>';
    return;
  }
  body.innerHTML = orders.map((order) => `<tr>
    <td class="order-code">#${escapeHtml(order.id.slice(0, 8).toUpperCase())}</td>
    <td>${escapeHtml(order.customer.name)}<br><span class="muted-cell">${escapeHtml(order.customer.email)}</span></td>
    <td>${date(order.createdAt)}</td><td>${money(order.total)}</td>
    <td><span class="status-pill ${escapeHtml(order.status)}">${productStatuses[order.status] || escapeHtml(order.status)}</span></td>
    <td>${order.status === 'pending' ? '<span class="muted-cell">Aguardando pagamento</span>' : `<select class="status-select" data-order="${escapeHtml(order.id)}"><option value="">Alterar status</option>${['preparing', 'shipped', 'delivered', 'cancelled'].map((status) => `<option value="${status}">${productStatuses[status]}</option>`).join('')}</select>`}</td>
  </tr>`).join('');
  body.querySelectorAll('[data-order]').forEach((select) => select.addEventListener('change', () => updateOrder(select.dataset.order, select.value)));
}

function renderProducts() {
  const body = document.querySelector('#products-table');
  if (!products.length) {
    body.innerHTML = '<tr><td colspan="6" class="table-empty">Nenhum produto cadastrado.</td></tr>';
    return;
  }
  body.innerHTML = products.map((product) => `<tr>
    <td class="order-code">${escapeHtml(product.emoji)} ${escapeHtml(product.name)}</td>
    <td>${escapeHtml(product.category)}</td><td>${money(product.price)}</td><td>${product.stock}</td>
    <td><span class="status-pill ${product.active ? 'paid' : 'cancelled'}">${product.active ? 'Visível' : 'Oculto'}</span></td>
    <td><button class="row-action" data-edit="${escapeHtml(product.id)}">Editar</button> · <button class="row-action" data-toggle="${escapeHtml(product.id)}">${product.active ? 'Ocultar' : 'Reativar'}</button></td>
  </tr>`).join('');
  body.querySelectorAll('[data-edit]').forEach((button) => button.addEventListener('click', () => openProductModal(products.find((item) => item.id === button.dataset.edit))));
  body.querySelectorAll('[data-toggle]').forEach((button) => button.addEventListener('click', () => toggleProduct(button.dataset.toggle)));
}

async function loadDashboard() {
  [orders, products] = await Promise.all([api('/api/admin/orders'), api('/api/admin/products')]);
  renderStats();
  renderOrders();
  renderProducts();
}

async function updateOrder(id, status) {
  if (!status) return;
  try {
    await api(`/api/admin/orders/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ status }) });
    await loadDashboard();
  } catch (error) {
    alert(error.message);
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

function openProductModal(product) {
  productForm.reset();
  productForm.elements.id.value = product?.id || '';
  productForm.elements.name.value = product?.name || '';
  productForm.elements.description.value = product?.description || '';
  productForm.elements.price.value = product?.price ?? '';
  productForm.elements.stock.value = product?.stock ?? '';
  productForm.elements.category.value = product?.category || '';
  productForm.elements.emoji.value = product?.emoji || '🧊';
  productForm.elements.color.value = product?.color || '#d9e6ff';
  productForm.elements.active.checked = product?.active ?? true;
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
    displayDashboard();
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
  try {
    await api(id ? `/api/admin/products/${encodeURIComponent(id)}` : '/api/admin/products', {
      method: id ? 'PATCH' : 'POST',
      body: JSON.stringify(body)
    });
    productModal.hidden = true;
    await loadDashboard();
  } catch (error) {
    productNotice.textContent = error.message;
  }
});

document.querySelector('#add-product-button').addEventListener('click', () => openProductModal());
document.querySelector('#modal-close').addEventListener('click', () => { productModal.hidden = true; });
productModal.addEventListener('click', (event) => { if (event.target === productModal) productModal.hidden = true; });
document.querySelector('#refresh-button').addEventListener('click', () => loadDashboard().catch((error) => alert(error.message)));
document.querySelector('#logout-button').addEventListener('click', async () => {
  await api('/api/admin/logout', { method: 'POST', body: '{}' });
  dashboard.hidden = true;
  loginPanel.hidden = false;
});
document.querySelectorAll('.admin-tab').forEach((tab) => tab.addEventListener('click', () => {
  document.querySelectorAll('.admin-tab').forEach((item) => item.classList.toggle('active', item === tab));
  document.querySelector('#orders-section').hidden = tab.dataset.tab !== 'orders';
  document.querySelector('#products-section').hidden = tab.dataset.tab !== 'products';
}));

api('/api/admin/me').then(() => {
  displayDashboard();
  return loadDashboard();
}).catch((error) => {
  if (error.message !== 'Faça login para continuar.') loginNotice.textContent = error.message;
});

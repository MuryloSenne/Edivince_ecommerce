import { api, escapeHtml, loadCart, money, saveCart, toast } from './shared.js';

const authArea = document.querySelector('#auth-area');
const ordersArea = document.querySelector('#orders-area');
const loginForm = document.querySelector('#login-form');
const registerForm = document.querySelector('#register-form');
const forgotForm = document.querySelector('#forgot-form');
const resetForm = document.querySelector('#reset-form');
const loginNotice = document.querySelector('#login-notice');
const registerNotice = document.querySelector('#register-notice');
const forgotNotice = document.querySelector('#forgot-notice');
const resetNotice = document.querySelector('#reset-notice');
const orderList = document.querySelector('#order-list');
const ordersNotice = document.querySelector('#orders-notice');

const STATUS_LABELS = {
  pending: 'Aguardando',
  paid: 'Pago',
  preparing: 'Em preparo',
  shipped: 'Enviado',
  delivered: 'Entregue',
  cancelled: 'Cancelado'
};

let customer = null;
let shopProducts = new Map();

function switchTab(tab) {
  document.querySelectorAll('.auth-tab').forEach((button) => button.classList.toggle('active', button.dataset.authTab === tab));
  loginForm.hidden = tab !== 'login';
  registerForm.hidden = tab !== 'register';
  forgotForm.hidden = true;
  resetForm.hidden = true;
  loginNotice.textContent = '';
  registerNotice.textContent = '';
  forgotNotice.textContent = '';
  resetNotice.textContent = '';
}

function showForgot() {
  loginForm.hidden = true;
  registerForm.hidden = true;
  forgotForm.hidden = false;
  resetForm.hidden = true;
  loginNotice.textContent = '';
  registerNotice.textContent = '';
}

function showReset() {
  loginForm.hidden = true;
  registerForm.hidden = true;
  forgotForm.hidden = true;
  resetForm.hidden = false;
  document.querySelector('.auth-tabs').hidden = true;
  document.querySelector('#reset-password').focus();
}

function showAuthForms() {
  const tabs = document.querySelector('.auth-tabs');
  if (tabs) tabs.hidden = false;
  forgotForm.hidden = true;
  resetForm.hidden = true;
}

function showAuth() {
  customer = null;
  showAuthForms();
  authArea.hidden = false;
  ordersArea.hidden = true;
  const resetToken = new URLSearchParams(window.location.search).get('reset');
  if (resetToken) {
    resetForm.dataset.token = resetToken;
    showReset();
  }
}

function nextTarget() {
  const next = new URLSearchParams(window.location.search).get('next') || '';
  return next.startsWith('/') && !next.startsWith('//') ? next : '';
}

function redirectNext() {
  const target = nextTarget();
  if (!target) return;
  setTimeout(() => {
    window.location.href = target;
  }, 450);
}

function showAccount(profile) {
  customer = profile;
  authArea.hidden = true;
  ordersArea.hidden = false;
  document.querySelector('#account-name').textContent = profile.name;
  document.querySelector('#account-email').textContent = profile.email;
  document.querySelector('#account-avatar').textContent = profile.name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0].toUpperCase())
    .join('');
  const subtitle = document.querySelector('.page-title p');
  if (subtitle) subtitle.textContent = 'Acompanhe seus pedidos, repetir compras e manter seus dados de entrega salvos.';
}

function formatDate(value) {
  return new Intl.DateTimeFormat('pt-BR', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}

async function renderOrders() {
  orderList.innerHTML = '<div class="loading-state"><span class="loader"></span> Carregando pedidos...</div>';
  try {
    const orders = await api('/api/account/orders');
    if (!orders.length) {
      orderList.innerHTML = `<div class="empty-state" style="min-height:140px">
        <div>
          <p style="margin-bottom:10px">Você ainda não fez pedidos.</p>
          <a class="button button-primary" href="/#colecao">Explorar coleção</a>
        </div>
      </div>`;
      return;
    }
    orderList.innerHTML = orders.map((order) => `
      <article class="order-row">
        <div class="order-row-head">
          <strong>#${escapeHtml(order.id.slice(0, 8).toUpperCase())}</strong>
          <span class="status-pill ${escapeHtml(order.status)}">${escapeHtml(STATUS_LABELS[order.status] || order.status)}</span>
          <time datetime="${escapeHtml(order.createdAt)}">${escapeHtml(formatDate(order.createdAt))}</time>
        </div>
        <div class="order-row-items">
          ${order.items.map((item) => `<span>${item.quantity}× ${escapeHtml(item.name)}</span>`).join('')}
        </div>
        <div class="order-row-foot">
          <span>${escapeHtml(order.shipping?.carrier || 'Envio')} · ${escapeHtml(order.shipping?.days || '')}</span>
          <strong>${money(order.total)}</strong>
          <button class="link-inline" type="button" data-reorder="${escapeHtml(order.id)}">Comprar novamente →</button>
        </div>
      </article>`).join('');
    orderList.querySelectorAll('[data-reorder]').forEach((button) => {
      const order = orders.find((entry) => entry.id === button.dataset.reorder);
      button.addEventListener('click', () => reorder(order));
    });
  } catch (error) {
    orderList.innerHTML = '';
    if (error.status === 401) {
      showAuth();
      loginNotice.textContent = 'Sua sessão expirou. Entre novamente.';
      return;
    }
    ordersNotice.textContent = error.message;
  }
}

async function reorder(order) {
  if (!shopProducts.size) {
    const list = await api('/api/products');
    shopProducts = new Map(list.map((product) => [product.id, product]));
  }
  const cart = loadCart();
  let added = 0;
  for (const item of order.items) {
    const product = shopProducts.get(item.id);
    if (!product || product.stock < 1) continue;
    const existing = cart.find((entry) => entry.id === item.id);
    const limit = Math.min(item.quantity, product.stock);
    if (existing) {
      existing.quantity = Math.min(product.stock, existing.quantity + limit);
    } else {
      cart.push({ id: item.id, quantity: limit });
    }
    added += 1;
  }
  if (!added) {
    toast('Estas peças não estão disponíveis no momento.');
    return;
  }
  saveCart(cart);
  toast('Peças adicionadas à sacola. Redirecionando...');
  setTimeout(() => { window.location.href = '/checkout.html'; }, 700);
}

async function authenticate(path, formData) {
  return api(path, { method: 'POST', body: JSON.stringify(formData) });
}

document.querySelectorAll('.auth-tab').forEach((button) => button.addEventListener('click', () => switchTab(button.dataset.authTab)));

document.querySelector('#forgot-link').addEventListener('click', showForgot);
document.querySelector('#forgot-back').addEventListener('click', () => { showAuthForms(); switchTab('login'); });

forgotForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  forgotNotice.textContent = '';
  const email = String(new FormData(forgotForm).get('email') || '').trim();
  const submitButton = forgotForm.querySelector('button[type="submit"]');
  submitButton.disabled = true;
  try {
    await api('/api/auth/forgot', { method: 'POST', body: JSON.stringify({ email }) });
    forgotNotice.className = 'notice ok';
    forgotNotice.textContent = 'Se este e-mail tiver conta, você receberá um link para definir a nova senha em poucos minutos.';
    forgotForm.reset();
  } catch (error) {
    forgotNotice.textContent = error.message;
  } finally {
    submitButton.disabled = false;
  }
});

resetForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  resetNotice.textContent = '';
  const password = resetForm.elements.password.value;
  const confirm = resetForm.elements.passwordConfirm.value;
  if (password !== confirm) {
    resetNotice.textContent = 'As senhas não conferem. Tente novamente.';
    return;
  }
  const token = resetForm.dataset.token || '';
  const submitButton = resetForm.querySelector('button[type="submit"]');
  submitButton.disabled = true;
  try {
    await api('/api/auth/reset', { method: 'POST', body: JSON.stringify({ token, password }) });
    resetNotice.className = 'notice ok';
    resetNotice.textContent = 'Senha atualizada. Entrando na sua conta...';
    window.history.replaceState({}, '', '/account.html');
    setTimeout(() => window.location.reload(), 900);
  } catch (error) {
    resetNotice.textContent = error.message;
    submitButton.disabled = false;
  }
});

loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  loginNotice.textContent = '';
  const body = Object.fromEntries(new FormData(loginForm).entries());
  try {
    const result = await authenticate('/api/auth/login', body);
    showAccount(result.customer);
    await renderOrders();
    toast(`Bem-vindo de volta, ${result.customer.name.split(' ')[0]}!`);
    redirectNext();
  } catch (error) {
    loginNotice.textContent = error.message;
  }
});

registerForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  registerNotice.textContent = '';
  const body = Object.fromEntries(new FormData(registerForm).entries());
  try {
    const result = await authenticate('/api/auth/register', body);
    showAccount(result.customer);
    await renderOrders();
    toast('Conta criada com sucesso.');
    redirectNext();
  } catch (error) {
    registerNotice.textContent = error.message;
  }
});

document.querySelector('#logout-button').addEventListener('click', async () => {
  try {
    await api('/api/auth/logout', { method: 'POST', body: '{}' });
  } finally {
    showAuth();
    switchTab('login');
    toast('Sessão encerrada.');
  }
});

document.querySelector('#refresh-orders').addEventListener('click', () => renderOrders().catch((error) => toast(error.message)));

async function init() {
  const params = new URLSearchParams(window.location.search);
  if (params.get('tab') === 'register') switchTab('register');
  try {
    const result = await api('/api/auth/me');
    showAccount(result.customer);
    await renderOrders();
    if (nextTarget()) redirectNext();
  } catch {
    showAuth();
  }
}

init();

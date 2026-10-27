export const CART_KEY = 'camada3d-cart';

export function money(value) {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(Number(value) || 0);
}

export function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

export function formatCep(value) {
  const digits = String(value || '').replace(/\D/g, '').slice(0, 8);
  return digits.length > 5 ? `${digits.slice(0, 5)}-${digits.slice(5)}` : digits;
}

export async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }
  });
  let result = {};
  try {
    result = await response.json();
  } catch {
    /* resposta sem JSON */
  }
  if (!response.ok) {
    const error = new Error(result.error || 'Não foi possível concluir a solicitação.');
    error.status = response.status;
    throw error;
  }
  return result;
}

export function loadCart() {
  try {
    const saved = JSON.parse(localStorage.getItem(CART_KEY) || '[]');
    return Array.isArray(saved)
      ? saved.filter((item) => typeof item.id === 'string' && Number.isInteger(item.quantity) && item.quantity > 0)
      : [];
  } catch {
    return [];
  }
}

export function saveCart(cart) {
  localStorage.setItem(CART_KEY, JSON.stringify(cart));
}

export function cartQuantity(cart) {
  return cart.reduce((sum, item) => sum + item.quantity, 0);
}

export function toast(message, tone = 'default') {
  let element = document.querySelector('#toast');
  if (!element) {
    element = document.createElement('div');
    element.id = 'toast';
    element.className = 'toast';
    element.setAttribute('role', 'status');
    document.body.append(element);
  }
  element.textContent = message;
  element.dataset.tone = tone;
  element.classList.add('show');
  clearTimeout(toast.timeout);
  toast.timeout = setTimeout(() => element.classList.remove('show'), 3200);
}

export function productVisual(product, size = 'normal') {
  const alt = escapeHtml(product.name);
  if (product.image) {
    return `<img class="product-photo${size === 'thumb' ? ' is-thumb' : ''}" src="${escapeHtml(product.image)}" alt="${alt}" loading="lazy" decoding="async">`;
  }
  return `<span class="product-fallback" aria-hidden="true">${escapeHtml(product.emoji || '◆')}</span>`;
}

export async function currentCustomer() {
  try {
    const result = await api('/api/auth/me');
    return result.customer;
  } catch {
    return null;
  }
}

export async function paintAccountLink(next = '') {
  const link = document.querySelector('[data-account-link]');
  if (!link) return null;
  const customer = await currentCustomer();
  const target = `/account.html${next ? `?next=${encodeURIComponent(next)}` : ''}`;
  link.href = customer ? '/account.html' : target;
  if (customer) {
    link.textContent = customer.name.split(' ')[0];
    link.classList.add('is-signed');
  } else {
    link.textContent = 'Entrar';
    link.classList.remove('is-signed');
  }
  return customer;
}

const productGrid = document.querySelector('#product-grid');
const filters = document.querySelector('#category-filters');
const cartDrawer = document.querySelector('#cart-drawer');
const cartBackdrop = document.querySelector('#cart-backdrop');
const cartForm = document.querySelector('#checkout-form');
const notice = document.querySelector('#checkout-notice');
const products = new Map();
let selectedCategory = 'Todos';
let cart = loadCart();
let paypalButtonRendered = false;

function loadCart() {
  try {
    const saved = JSON.parse(localStorage.getItem('camada3d-cart') || '[]');
    return Array.isArray(saved) ? saved.filter((item) => typeof item.id === 'string' && Number.isInteger(item.quantity) && item.quantity > 0) : [];
  } catch {
    return [];
  }
}

function money(value) {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(value);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

function showToast(message) {
  const toast = document.querySelector('#toast');
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(showToast.timeout);
  showToast.timeout = setTimeout(() => toast.classList.remove('show'), 2400);
}

async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { 'Content-Type': 'application/json', ...(options.headers || {}) } });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Não foi possível concluir a solicitação.');
  return result;
}

function renderFilters() {
  const categories = ['Todos', ...new Set([...products.values()].map((product) => product.category))];
  filters.innerHTML = categories.map((category) => `<button class="filter-chip${category === selectedCategory ? ' active' : ''}" data-category="${escapeHtml(category)}">${escapeHtml(category)}</button>`).join('');
  filters.querySelectorAll('button').forEach((button) => button.addEventListener('click', () => {
    selectedCategory = button.dataset.category;
    renderFilters();
    renderProducts();
  }));
}

function renderProducts() {
  const visible = [...products.values()].filter((product) => selectedCategory === 'Todos' || product.category === selectedCategory);
  if (!visible.length) {
    productGrid.innerHTML = '<div class="empty-state">Nenhum produto nesta categoria por enquanto.</div>';
    return;
  }
  productGrid.innerHTML = visible.map((product, index) => `
    <article class="product-card">
      <div class="product-image" style="background:${escapeHtml(product.color)}">
        ${index === 0 ? '<span class="product-badge">feito em 3D</span>' : ''}
        <span class="product-art" aria-hidden="true">${escapeHtml(product.emoji)}</span>
      </div>
      <div class="product-meta"><div><h3>${escapeHtml(product.name)}</h3><div class="product-category">${escapeHtml(product.category)}</div></div><div class="product-price">${money(product.price)}</div></div>
      <p class="product-description">${escapeHtml(product.description)}</p>
      <button class="add-button" data-add="${escapeHtml(product.id)}" ${product.stock < 1 ? 'disabled' : ''}>${product.stock < 1 ? 'Indisponível' : 'Adicionar à sacola  +'}</button>
    </article>`).join('');
  productGrid.querySelectorAll('[data-add]').forEach((button) => button.addEventListener('click', () => addToCart(button.dataset.add)));
}

function persistCart() {
  localStorage.setItem('camada3d-cart', JSON.stringify(cart));
  renderCart();
}

function addToCart(id) {
  const product = products.get(id);
  if (!product) return;
  const item = cart.find((entry) => entry.id === id);
  if (item) {
    if (item.quantity >= product.stock) return showToast('Você atingiu o limite disponível em estoque.');
    item.quantity += 1;
  } else {
    cart.push({ id, quantity: 1 });
  }
  persistCart();
  showToast(`${product.name} adicionado à sacola`);
  openCart();
}

function renderCart() {
  cart = cart.filter((item) => products.has(item.id));
  const quantity = cart.reduce((sum, item) => sum + item.quantity, 0);
  document.querySelector('#cart-count').textContent = quantity;
  document.querySelector('#drawer-count').textContent = `(${quantity})`;
  const cartItems = document.querySelector('#cart-items');
  if (!cart.length) {
    cartItems.innerHTML = '<div class="cart-empty">Sua sacola está esperando por boas ideias.</div>';
    document.querySelector('#cart-total').textContent = money(0);
    document.querySelector('#paypal-button-container').innerHTML = '';
    paypalButtonRendered = false;
    return;
  }
  cartItems.innerHTML = cart.map((item) => {
    const product = products.get(item.id);
    return `<div class="cart-line"><div class="cart-thumb" style="background:${escapeHtml(product.color)}">${escapeHtml(product.emoji)}</div><div><h3>${escapeHtml(product.name)}</h3><p>${money(product.price)} cada</p><div class="quantity-control"><button data-quantity="${escapeHtml(item.id)}" data-delta="-1" aria-label="Remover uma unidade">−</button><span>${item.quantity}</span><button data-quantity="${escapeHtml(item.id)}" data-delta="1" aria-label="Adicionar uma unidade" ${item.quantity >= product.stock ? 'disabled' : ''}>+</button></div></div><div class="cart-line-total">${money(item.quantity * product.price)}</div></div>`;
  }).join('');
  const total = cart.reduce((sum, item) => sum + products.get(item.id).price * item.quantity, 0);
  document.querySelector('#cart-total').textContent = money(total);
  cartItems.querySelectorAll('[data-quantity]').forEach((button) => button.addEventListener('click', () => {
    const item = cart.find((entry) => entry.id === button.dataset.quantity);
    if (!item) return;
    item.quantity += Number(button.dataset.delta);
    if (item.quantity < 1) cart = cart.filter((entry) => entry !== item);
    persistCart();
  }));
  renderPaypalButton();
}

function openCart() {
  cartDrawer.classList.add('open');
  cartBackdrop.classList.add('visible');
  cartDrawer.setAttribute('aria-hidden', 'false');
}

function closeCart() {
  cartDrawer.classList.remove('open');
  cartBackdrop.classList.remove('visible');
  cartDrawer.setAttribute('aria-hidden', 'true');
}

function customerDetails() {
  const formData = new FormData(cartForm);
  return Object.fromEntries(formData.entries());
}

async function renderPaypalButton() {
  if (!window.paypal || !cart.length || paypalButtonRendered) return;
  paypalButtonRendered = true;
  window.paypal.Buttons({
    style: { layout: 'vertical', shape: 'rect', label: 'pay', color: 'gold', height: 42 },
    onClick(data, actions) {
      notice.textContent = '';
      if (!cartForm.reportValidity()) return actions.reject();
      return actions.resolve();
    },
    async createOrder() {
      const result = await api('/api/paypal/create-order', {
        method: 'POST',
        body: JSON.stringify({ items: cart, customer: customerDetails() })
      });
      return result.paypalOrderId;
    },
    async onApprove(data) {
      notice.textContent = 'Confirmando seu pagamento com segurança...';
      try {
        const result = await api('/api/paypal/capture', {
          method: 'POST',
          body: JSON.stringify({ paypalOrderId: data.orderID })
        });
        cart = [];
        persistCart();
        notice.textContent = '';
        closeCart();
        showToast(`Pagamento aprovado! Pedido ${result.orderId.slice(0, 8).toUpperCase()}`);
        await loadProducts();
      } catch (error) {
        notice.textContent = error.message;
      }
    },
    onCancel() {
      notice.textContent = 'Pagamento cancelado. Sua sacola continua salva.';
    },
    onError(error) {
      console.error('PayPal checkout failed:', error);
      notice.textContent = 'O checkout não foi concluído. Confira seus dados e tente novamente.';
      paypalButtonRendered = false;
    }
  }).render('#paypal-button-container').catch((error) => {
    console.error('PayPal button could not be rendered:', error);
    notice.textContent = 'Não foi possível carregar o PayPal agora.';
    paypalButtonRendered = false;
  });
}

async function loadProducts() {
  const list = await api('/api/products');
  products.clear();
  for (const product of list) products.set(product.id, product);
  renderFilters();
  renderProducts();
  renderCart();
}

async function initializePayPal() {
  const config = await api('/api/config');
  if (!config.paypalConfigured) {
    document.querySelector('#payment-note').textContent = 'PayPal não configurado: adicione as credenciais ao arquivo .env para ativar o checkout.';
    return;
  }
  const script = document.createElement('script');
  script.src = `https://www.paypal.com/sdk/js?client-id=${encodeURIComponent(config.paypalClientId)}&currency=${config.currency}&intent=capture`;
  script.onload = renderPaypalButton;
  script.onerror = () => {
    document.querySelector('#payment-note').textContent = 'Não foi possível conectar ao PayPal. Tente novamente em instantes.';
  };
  document.head.append(script);
}

document.querySelector('#cart-toggle').addEventListener('click', openCart);
document.querySelector('#cart-close').addEventListener('click', closeCart);
cartBackdrop.addEventListener('click', closeCart);
document.addEventListener('keydown', (event) => { if (event.key === 'Escape') closeCart(); });
cartForm.addEventListener('input', () => { notice.textContent = ''; });
document.querySelector('#year').textContent = new Date().getFullYear();

loadProducts().then(initializePayPal).catch((error) => {
  console.error('Store could not load:', error);
  productGrid.innerHTML = '<div class="empty-state">Não foi possível carregar a loja. Atualize a página para tentar novamente.</div>';
});

import { api, cartQuantity, escapeHtml, loadCart, money, paintAccountLink, productVisual, saveCart, toast } from './shared.js';

const productGrid = document.querySelector('#product-grid');
const filters = document.querySelector('#category-filters');
const cartDrawer = document.querySelector('#cart-drawer');
const cartBackdrop = document.querySelector('#cart-backdrop');
const cartItems = document.querySelector('#cart-items');
const cartTotal = document.querySelector('#cart-total');
const cartCount = document.querySelector('#cart-count');
const drawerCount = document.querySelector('#drawer-count');
const shipProgress = document.querySelector('#ship-progress');
const shipProgressText = document.querySelector('#ship-progress-text');
const shipProgressBar = document.querySelector('#ship-progress-bar');
const goCheckout = document.querySelector('#go-checkout');

const products = new Map();
let selectedCategory = 'Todos';
let cart = loadCart();
let freeShippingMin = 249;

function renderFilters() {
  const categories = ['Todos', ...new Set([...products.values()].map((product) => product.category))];
  filters.innerHTML = categories.map((category) => {
    const count = category === 'Todos'
      ? products.size
      : [...products.values()].filter((product) => product.category === category).length;
    return `<button class="filter-chip${category === selectedCategory ? ' active' : ''}" data-category="${escapeHtml(category)}">
      ${escapeHtml(category)}<span>${String(count).padStart(2, '0')}</span>
    </button>`;
  }).join('');
  filters.querySelectorAll('button').forEach((button) => button.addEventListener('click', () => {
    selectedCategory = button.dataset.category;
    renderFilters();
    renderProducts();
  }));
}

function renderProducts() {
  const visible = [...products.values()].filter((product) => selectedCategory === 'Todos' || product.category === selectedCategory);
  if (!visible.length) {
    productGrid.innerHTML = '<div class="empty-state">Nenhuma peça nesta categoria por enquanto.</div>';
    return;
  }
  productGrid.innerHTML = visible.map((product) => `
    <article class="product-card reveal" data-tag="${product.stock > 0 ? 'em-estoque' : 'sob-encomenda'}">
      <div class="product-media${product.image ? '' : ' no-photo'}" style="--card-tint:${escapeHtml(product.color)}">
        <span class="product-tag">${product.stock > 0 ? 'EM ESTOQUE' : 'SOB ENCOMENDA'}</span>
        ${productVisual(product)}
        <span class="product-scan"></span>
        <span class="product-code">SPEC // ${escapeHtml(product.category.slice(0, 3).toUpperCase())}-${escapeHtml(product.id.slice(0, 4).toUpperCase())}</span>
      </div>
      <div class="product-body">
        <div class="product-kicker">${escapeHtml(product.category)}</div>
        <h3>${escapeHtml(product.name)}</h3>
        <p class="product-description">${escapeHtml(product.description)}</p>
        <div class="product-footer">
          <div class="product-price"><strong>${money(product.price)}</strong><span>à vista</span></div>
          <button class="add-button" data-add="${escapeHtml(product.id)}" ${product.stock < 1 ? 'disabled' : ''}>
            ${product.stock < 1 ? 'Esgotado' : 'Adicionar'} <span aria-hidden="true">+</span>
          </button>
        </div>
      </div>
    </article>`).join('');
  productGrid.querySelectorAll('[data-add]').forEach((button) => button.addEventListener('click', () => addToCart(button.dataset.add)));
  observeReveals();
}

function observeReveals() {
  const items = productGrid.querySelectorAll('.reveal:not(.visible)');
  if (!('IntersectionObserver' in window)) {
    items.forEach((item) => item.classList.add('visible'));
    return;
  }
  const observer = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        entry.target.classList.add('visible');
        observer.unobserve(entry.target);
      }
    });
  }, { threshold: 0.12 });
  items.forEach((item, index) => {
    item.style.transitionDelay = `${Math.min(index * 55, 330)}ms`;
    observer.observe(item);
  });
}

function persistCart() {
  saveCart(cart);
  renderCart();
  bumpCart();
}

function bumpCart() {
  cartCount.classList.remove('bump');
  void cartCount.offsetWidth;
  cartCount.classList.add('bump');
}

function addToCart(id) {
  const product = products.get(id);
  if (!product) return;
  const item = cart.find((entry) => entry.id === id);
  if (item) {
    if (item.quantity >= product.stock) return toast('Limite de estoque atingido para esta peça.', 'error');
    item.quantity += 1;
  } else {
    cart.push({ id, quantity: 1 });
  }
  persistCart();
  toast(`${product.name} adicionado à sacola`, 'ok');
  openCart();
}

function renderCart() {
  cart = cart.filter((item) => products.has(item.id));
  const quantity = cartQuantity(cart);
  cartCount.textContent = quantity;
  drawerCount.textContent = `(${quantity})`;

  const subtotal = cart.reduce((sum, item) => sum + products.get(item.id).price * item.quantity, 0);
  cartTotal.textContent = money(subtotal);
  goCheckout.classList.toggle('is-disabled', !cart.length);
  goCheckout.setAttribute('aria-disabled', String(!cart.length));

  if (freeShippingMin > 0) {
    const missing = freeShippingMin - subtotal;
    shipProgress.hidden = false;
    if (missing > 0) {
      shipProgressText.innerHTML = `Faltam <strong>${money(missing)}</strong> para frete grátis no envio econômico.`;
      shipProgressBar.style.width = `${Math.min(100, (subtotal / freeShippingMin) * 100)}%`;
    } else {
      shipProgressText.innerHTML = 'Você liberou <strong>frete grátis</strong> no envio econômico.';
      shipProgressBar.style.width = '100%';
    }
  } else {
    shipProgress.hidden = true;
  }

  if (!cart.length) {
    cartItems.innerHTML = `<div class="cart-empty">
      <span class="cart-empty-icon" aria-hidden="true">◇</span>
      <p>Sua sacola está vazia.</p>
      <span>Explore a coleção e escolha sua próxima peça.</span>
    </div>`;
    return;
  }

  cartItems.innerHTML = cart.map((item) => {
    const product = products.get(item.id);
    return `<div class="cart-line">
      <div class="cart-thumb" style="--card-tint:${escapeHtml(product.color)}">${productVisual(product, 'thumb')}</div>
      <div class="cart-line-info">
        <h3>${escapeHtml(product.name)}</h3>
        <p>${money(product.price)} · ${escapeHtml(product.category)}</p>
        <div class="quantity-control">
          <button data-quantity="${escapeHtml(item.id)}" data-delta="-1" aria-label="Remover uma unidade">−</button>
          <span>${item.quantity}</span>
          <button data-quantity="${escapeHtml(item.id)}" data-delta="1" aria-label="Adicionar uma unidade" ${item.quantity >= product.stock ? 'disabled' : ''}>+</button>
        </div>
      </div>
      <div class="cart-line-side">
        <strong>${money(item.quantity * product.price)}</strong>
        <button class="remove-line" data-remove="${escapeHtml(item.id)}">remover</button>
      </div>
    </div>`;
  }).join('');

  cartItems.querySelectorAll('[data-quantity]').forEach((button) => button.addEventListener('click', () => {
    const item = cart.find((entry) => entry.id === button.dataset.quantity);
    if (!item) return;
    item.quantity += Number(button.dataset.delta);
    if (item.quantity < 1) cart = cart.filter((entry) => entry !== item);
    persistCart();
  }));
  cartItems.querySelectorAll('[data-remove]').forEach((button) => button.addEventListener('click', () => {
    cart = cart.filter((entry) => entry.id !== button.dataset.remove);
    persistCart();
  }));
}

function openCart() {
  cartDrawer.classList.add('open');
  cartBackdrop.classList.add('visible');
  cartDrawer.setAttribute('aria-hidden', 'false');
  document.body.classList.add('drawer-open');
}

function closeCart() {
  cartDrawer.classList.remove('open');
  cartBackdrop.classList.remove('visible');
  cartDrawer.setAttribute('aria-hidden', 'true');
  document.body.classList.remove('drawer-open');
}

async function loadProducts() {
  const list = await api('/api/products');
  products.clear();
  for (const product of list) products.set(product.id, product);
  renderFilters();
  renderProducts();
  renderCart();
}

async function loadConfig() {
  try {
    const config = await api('/api/config');
    if (config.freeShippingMin > 0) {
      freeShippingMin = config.freeShippingMin;
      document.querySelector('#free-shipping-label').textContent = money(config.freeShippingMin);
    } else {
      freeShippingMin = 0;
      document.querySelector('#free-shipping-label').closest('.announcement').innerHTML = '<span class="pulse-dot" aria-hidden="true"></span> IMPRESSÃO SOB DEMANDA <span aria-hidden="true" style="color:var(--dim)">·</span> ENVIO PARA TODO O BRASIL';
    }
  } catch {
    /* mantém os valores padrão */
  }
}

document.querySelector('#cart-toggle').addEventListener('click', openCart);
document.querySelector('#cart-close').addEventListener('click', closeCart);
document.querySelector('#continue-shopping').addEventListener('click', closeCart);
cartBackdrop.addEventListener('click', closeCart);
document.addEventListener('keydown', (event) => { if (event.key === 'Escape') closeCart(); });
document.querySelector('#year').textContent = new Date().getFullYear();

/* hero: a cada 4 giros o objeto muda de forma */
const layerObject = document.querySelector('#layer-object');
if (layerObject) {
  const spinDuration = 26000;
  setInterval(() => {
    layerObject.classList.toggle('alt');
  }, spinDuration * 4);
}

Promise.all([loadConfig(), loadProducts(), paintAccountLink()]).catch((error) => {
  console.error('Store could not load:', error);
  productGrid.innerHTML = '<div class="empty-state">Não foi possível carregar a loja. Atualize a página para tentar novamente.</div>';
});

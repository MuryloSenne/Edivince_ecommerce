import { api, escapeHtml, formatCep, loadCart, money, paintAccountLink, productVisual, saveCart, toast } from './shared.js';

const DRAFT_KEY = 'camada3d-checkout-draft';
const state = {
  step: 1,
  products: new Map(),
  cart: loadCart(),
  customer: null,
  config: null,
  quote: null,
  shipping: null,
  paypalRendered: false,
  busy: false
};

const $ = (selector) => document.querySelector(selector);
const itemsBox = $('#checkout-items');
const summaryItems = $('#summary-items');
const summarySubtotal = $('#summary-subtotal');
const summaryShipping = $('#summary-shipping');
const summaryTotal = $('#summary-total');
const summaryShippingNote = $('#summary-shipping-note');
const shippingStatus = $('#shipping-status');
const shippingOptions = $('#shipping-options');
const cepInput = $('#cep-input');
const shippingRegion = $('#shipping-region');
const addressForm = $('#address-form');
const paymentNote = $('#payment-note');
const manualNote = $('#manual-note');
const manualButton = $('#manual-order');

function subtotal() {
  return state.cart.reduce((sum, item) => {
    const product = state.products.get(item.id);
    return sum + (product ? product.price * item.quantity : 0);
  }, 0);
}

function total() {
  return subtotal() + (state.shipping ? state.shipping.price : 0);
}

function draft() {
  try {
    return JSON.parse(localStorage.getItem(DRAFT_KEY) || '{}');
  } catch {
    return {};
  }
}

function renderItems() {
  state.cart = state.cart.filter((item) => state.products.has(item.id));
  if (!state.cart.length) {
    $('#checkout-app').hidden = true;
    $('#checkout-empty').hidden = false;
    return;
  }
  itemsBox.innerHTML = state.cart.map((item) => {
    const product = state.products.get(item.id);
    return `<article class="checkout-item">
      <div class="checkout-thumb" style="--card-tint:${escapeHtml(product.color)}">${productVisual(product, 'thumb')}</div>
      <div>
        <h3>${escapeHtml(product.name)}</h3>
        <div class="item-meta">${escapeHtml(product.category)} · ${money(product.price)} / un.</div>
        <div class="quantity-control" style="margin-top:8px">
          <button type="button" data-quantity="${escapeHtml(item.id)}" data-delta="-1" aria-label="Remover uma unidade">−</button>
          <span>${item.quantity}</span>
          <button type="button" data-quantity="${escapeHtml(item.id)}" data-delta="1" aria-label="Adicionar uma unidade" ${item.quantity >= product.stock ? 'disabled' : ''}>+</button>
        </div>
      </div>
      <div class="checkout-item-side">
        <strong>${money(product.price * item.quantity)}</strong>
        <button type="button" class="remove-line" data-remove="${escapeHtml(item.id)}">remover</button>
      </div>
    </article>`;
  }).join('');

  itemsBox.querySelectorAll('[data-quantity]').forEach((button) => button.addEventListener('click', () => {
    const item = state.cart.find((entry) => entry.id === button.dataset.quantity);
    if (!item) return;
    item.quantity += Number(button.dataset.delta);
    if (item.quantity < 1) state.cart = state.cart.filter((entry) => entry !== item);
    saveCart(state.cart);
    renderItems();
    renderSummary();
    if (!state.cart.length) {
      $('#checkout-app').hidden = true;
      $('#checkout-empty').hidden = false;
    }
  }));
  itemsBox.querySelectorAll('[data-remove]').forEach((button) => button.addEventListener('click', () => {
    state.cart = state.cart.filter((entry) => entry.id !== button.dataset.remove);
    saveCart(state.cart);
    renderItems();
    renderSummary();
    if (!state.cart.length) {
      $('#checkout-app').hidden = true;
      $('#checkout-empty').hidden = false;
    }
  }));
}

function renderSummary() {
  summaryItems.innerHTML = state.cart.map((item) => {
    const product = state.products.get(item.id);
    if (!product) return '';
    return `<div class="summary-item">
      <div class="summary-thumb" style="--card-tint:${escapeHtml(product.color)}">${productVisual(product, 'thumb')}</div>
      <div class="summary-item-info"><strong>${escapeHtml(product.name)}</strong><span>${item.quantity} × ${money(product.price)}</span></div>
      <span>${money(product.price * item.quantity)}</span>
    </div>`;
  }).join('');
  summarySubtotal.textContent = money(subtotal());
  summaryShipping.textContent = state.shipping ? (state.shipping.price === 0 ? 'Grátis' : money(state.shipping.price)) : 'a calcular';
  summaryTotal.textContent = money(total());
  if (state.shipping) {
    summaryShippingNote.textContent = `${state.shipping.carrier} · ${state.shipping.days} · ${state.shipping.label}`;
  } else if (state.config?.freeShippingMin > 0) {
    const missing = state.config.freeShippingMin - subtotal();
    summaryShippingNote.textContent = missing > 0
      ? `Faltam ${money(missing)} para frete grátis no envio econômico.`
      : 'Frete grátis liberado no envio econômico.';
  }
}

function updateStepper() {
  document.querySelectorAll('.step').forEach((element) => {
    const index = Number(element.dataset.step);
    element.classList.toggle('active', index === state.step);
    element.classList.toggle('done', index < state.step);
    element.querySelector('.step-dot').textContent = index < state.step ? '✓' : String(index);
  });
  document.querySelectorAll('.step-panel').forEach((panel) => {
    panel.classList.toggle('active', Number(panel.dataset.panel) === state.step);
  });
}

function setStep(step) {
  state.step = step;
  updateStepper();
  if (step === 3 && !state.quote) {
    const digits = addressForm.elements.postalCode.value.replace(/\D/g, '');
    if (digits.length === 8) {
      cepInput.value = formatCep(digits);
      calculateShipping();
    }
  }
  if (step === 4) setupPayment();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function customerData() {
  const data = Object.fromEntries(new FormData(addressForm).entries());
  return {
    name: String(data.name || '').trim(),
    email: String(data.email || '').trim(),
    address: String(data.address || '').trim(),
    city: String(data.city || '').trim(),
    state: String(data.state || '').trim().toUpperCase(),
    postalCode: String(data.postalCode || '').replace(/\D/g, '')
  };
}

function validateAddress() {
  const customer = customerData();
  if (!addressForm.reportValidity()) return null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customer.email)) {
    toast('Informe um e-mail válido para receber o pedido.');
    addressForm.elements.email.focus();
    return null;
  }
  if (customer.postalCode.length !== 8) {
    toast('O CEP precisa ter 8 dígitos.');
    addressForm.elements.postalCode.focus();
    return null;
  }
  return customer;
}

async function calculateShipping() {
  const digits = cepInput.value.replace(/\D/g, '');
  shippingStatus.className = 'shipping-status';
  if (digits.length !== 8) {
    shippingStatus.textContent = 'Digite um CEP válido com 8 dígitos.';
    shippingStatus.classList.add('error');
    return;
  }
  addressForm.elements.postalCode.value = formatCep(digits);
  saveDraft();
  shippingStatus.textContent = 'Calculando frete...';
  shippingOptions.innerHTML = '';
  $('#step3-next').disabled = true;
  try {
    const quote = await api('/api/shipping/quote', {
      method: 'POST',
      body: JSON.stringify({ postalCode: digits, subtotal: subtotal() })
    });
    state.quote = quote;
    const previous = state.shipping?.code;
    state.shipping = quote.options.find((option) => option.code === previous) || quote.options.find((option) => option.code === 'pac') || quote.options[0];
    shippingRegion.textContent = quote.region;
    shippingStatus.textContent = `Entrega para ${quote.region}.`;
    renderShippingOptions();
    renderSummary();
    $('#step3-next').disabled = false;
  } catch (error) {
    shippingStatus.textContent = error.message;
    shippingStatus.classList.add('error');
    toast(error.message);
  }
}

function renderShippingOptions() {
  shippingOptions.innerHTML = state.quote.options.map((option) => `
    <label class="shipping-option${state.shipping?.code === option.code ? ' selected' : ''}" data-option="${escapeHtml(option.code)}">
      <input type="radio" name="shipping" value="${escapeHtml(option.code)}" ${state.shipping?.code === option.code ? 'checked' : ''}>
      <span class="ship-radio" aria-hidden="true"></span>
      <span class="ship-info"><strong>${escapeHtml(option.label)} · ${escapeHtml(option.carrier)}</strong><span>${escapeHtml(option.days)}</span></span>
      <span class="ship-price${option.price === 0 ? ' free' : ''}">${option.price === 0 ? 'GRÁTIS' : money(option.price)}</span>
    </label>`).join('');
  shippingOptions.querySelectorAll('.shipping-option').forEach((label) => label.addEventListener('click', () => {
    const code = label.dataset.option;
    state.shipping = state.quote.options.find((option) => option.code === code);
    shippingOptions.querySelectorAll('.shipping-option').forEach((entry) => entry.classList.toggle('selected', entry === label));
    renderSummary();
  }));
}

function saveDraft() {
  if (!$('#save-data').checked) {
    localStorage.removeItem(DRAFT_KEY);
    return;
  }
  const data = Object.fromEntries(new FormData(addressForm).entries());
  delete data.saveData;
  localStorage.setItem(DRAFT_KEY, JSON.stringify(data));
}

async function setupPayment() {
  renderSummary();
  if (!state.config?.paypalConfigured) {
    $('#paypal-card').hidden = true;
    return;
  }
  if (state.paypalRendered || !window.paypal) return;
  state.paypalRendered = true;
  try {
    await window.paypal.Buttons({
      style: { layout: 'vertical', shape: 'rect', label: 'pay', color: 'gold', height: 44 },
      async createOrder() {
        const result = await api('/api/paypal/create-order', {
          method: 'POST',
          body: JSON.stringify({ items: state.cart, customer: customerData(), shippingCode: state.shipping.code, note: $('#note').value })
        });
        return result.paypalOrderId;
      },
      async onApprove(data) {
        paymentNote.textContent = 'Confirmando seu pagamento com segurança...';
        paymentNote.className = 'notice';
        try {
          const result = await api('/api/paypal/capture', {
            method: 'POST',
            body: JSON.stringify({ paypalOrderId: data.orderID })
          });
          finishOrder({ ...result, payment: 'PayPal' });
        } catch (error) {
          paymentNote.textContent = error.message;
          paymentNote.className = 'notice';
          toast(error.message);
        }
      },
      onCancel() {
        paymentNote.textContent = 'Pagamento cancelado. Sua sacola continua salva.';
      },
      onError(error) {
        console.error('PayPal checkout failed:', error);
        paymentNote.textContent = 'O checkout não foi concluído. Tente novamente.';
        state.paypalRendered = false;
      }
    }).render('#paypal-button-container');
  } catch (error) {
    console.error('PayPal button could not be rendered:', error);
    state.paypalRendered = false;
    paymentNote.textContent = 'Não foi possível carregar o PayPal agora. Use a opção de combinar pagamento.';
  }
}

async function submitManualOrder() {
  if (state.busy) return;
  const customer = validateAddress();
  if (!customer) return;
  if (!state.shipping) {
    toast('Calcule o frete antes de concluir o pedido.');
    setStep(3);
    return;
  }
  state.busy = true;
  manualButton.disabled = true;
  manualButton.innerHTML = 'Enviando pedido...';
  manualNote.textContent = '';
  try {
    const result = await api('/api/orders', {
      method: 'POST',
      body: JSON.stringify({ items: state.cart, customer, shippingCode: state.shipping.code, note: $('#note').value })
    });
    finishOrder({ ...result, payment: 'Combinar pagamento' });
  } catch (error) {
    manualNote.textContent = error.message;
    manualNote.className = 'notice';
    toast(error.message);
  } finally {
    state.busy = false;
    manualButton.disabled = false;
    manualButton.innerHTML = 'Enviar pedido por e-mail <span aria-hidden="true">↗</span>';
  }
}

function finishOrder(result) {
  saveCart([]);
  state.cart = [];
  $('#checkout-app').hidden = true;
  const success = $('#checkout-success');
  success.hidden = false;
  $('#success-code').textContent = result.code || String(result.orderId || '').slice(0, 8).toUpperCase();
  const emailConfigured = result.emailConfigured ?? state.config?.emailConfigured;
  if (result.emailSent) {
    $('#success-message').textContent = 'Pedido registrado e detalhes enviados por e-mail. Guarde o código abaixo.';
  } else if (emailConfigured === false) {
    $('#success-message').textContent = 'Pedido registrado. O envio de e-mail ainda não está configurado na loja — guarde o código abaixo.';
  } else {
    $('#success-message').textContent = 'Pedido registrado. Não conseguimos enviar o e-mail agora, mas a loja já recebeu o pedido.';
  }
  $('#success-details').innerHTML = `
    <div><span>Total</span><strong>${money(result.total ?? total())}</strong></div>
    <div><span>Frete</span><strong>${escapeHtml(result.shipping?.carrier || state.shipping?.carrier || '—')} · ${escapeHtml(result.shipping?.days || state.shipping?.days || '')}</strong></div>
    <div><span>Pagamento</span><strong>${escapeHtml(result.payment || '—')}</strong></div>
    <div><span>E-mail</span><strong>${result.emailSent ? 'enviado' : 'registrado'}</strong></div>`;
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function prefill() {
  const saved = draft();
  const customer = state.customer;
  if (customer) {
    addressForm.elements.name.value = customer.name || '';
    addressForm.elements.email.value = customer.email || '';
    addressForm.elements.email.readOnly = true;
    addressForm.elements.email.title = 'E-mail da sua conta';
    $('#account-badge').textContent = 'CONTA ATIVA';
    $('#account-badge').classList.add('manual-tag');
  }
  for (const key of ['phone', 'address', 'city', 'state', 'postalCode', 'note']) {
    if (saved[key]) addressForm.elements[key].value = saved[key];
  }
  if (saved.postalCode) cepInput.value = formatCep(saved.postalCode);
}

function bindEvents() {
  $('#step1-next').addEventListener('click', () => {
    if (!state.cart.length) return toast('Adicione ao menos uma peça à sacola.');
    setStep(2);
  });
  $('#step2-back').addEventListener('click', () => setStep(1));
  $('#step2-next').addEventListener('click', () => {
    if (!validateAddress()) return;
    saveDraft();
    setStep(3);
  });
  addressForm.addEventListener('submit', (event) => {
    event.preventDefault();
    $('#step2-next').click();
  });
  addressForm.addEventListener('input', () => {
    saveDraft();
    state.quote = null;
    state.shipping = null;
    shippingOptions.innerHTML = '';
    $('#step3-next').disabled = true;
    shippingStatus.textContent = '';
    shippingRegion.textContent = '—';
    renderSummary();
  });
  addressForm.elements.postalCode.addEventListener('input', (event) => {
    event.target.value = formatCep(event.target.value);
    cepInput.value = event.target.value;
  });
  addressForm.elements.state.addEventListener('input', (event) => {
    event.target.value = event.target.value.toUpperCase().slice(0, 2);
  });
  $('#step3-back').addEventListener('click', () => setStep(2));
  $('#step3-next').addEventListener('click', () => {
    if (!state.shipping) return toast('Escolha uma opção de frete.');
    setStep(4);
  });
  $('#step4-back').addEventListener('click', () => setStep(3));
  $('#calc-shipping').addEventListener('click', calculateShipping);
  cepInput.addEventListener('input', (event) => {
    event.target.value = formatCep(event.target.value);
    addressForm.elements.postalCode.value = event.target.value;
    saveDraft();
  });
  cepInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      calculateShipping();
    }
  });
  manualButton.addEventListener('click', submitManualOrder);
  document.querySelectorAll('.step').forEach((element) => element.addEventListener('click', () => {
    const index = Number(element.dataset.step);
    if (index < state.step && index > 0) setStep(index);
  }));
}

function loadPaypal(config) {
  if (!config.paypalConfigured) return;
  const script = document.createElement('script');
  script.src = `https://www.paypal.com/sdk/js?client-id=${encodeURIComponent(config.paypalClientId)}&currency=${config.currency}&intent=capture`;
  script.onload = () => {
    if (state.step === 4) setupPayment();
  };
  script.onerror = () => {
    paymentNote.textContent = 'Não foi possível conectar ao PayPal. Tente novamente em instantes.';
  };
  document.head.append(script);
}

async function init() {
  bindEvents();
  try {
    const [productList, config, customer] = await Promise.all([
      api('/api/products'),
      api('/api/config'),
      paintAccountLink('/checkout.html')
    ]);
    state.config = config;
    state.customer = customer;
    for (const product of productList) state.products.set(product.id, product);
    prefill();
    renderItems();
    renderSummary();
    if (!state.cart.length) {
      $('#checkout-app').hidden = true;
      $('#checkout-empty').hidden = false;
    }
    loadPaypal(config);
  } catch (error) {
    console.error('Checkout could not load:', error);
    toast('Não foi possível carregar o checkout. Atualize a página.');
  }
}

init();

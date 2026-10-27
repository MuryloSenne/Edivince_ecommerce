# Camada 3D

Loja virtual responsiva para artigos impressos em 3D, com catálogo com fotos reais, sacola, checkout em etapas na própria página, cálculo de frete por CEP, contas de cliente, painel administrativo e notificação de pedidos por e-mail. Aplicação em Node.js com APIs nativas, sem dependências de runtime.

## Requisitos

- Node.js 20 ou superior
- Conta PayPal Business para receber pagamentos reais (opcional)
- SMTP ou conta Resend para envio dos e-mails de pedido (opcional)

## Configuração

1. Copie `.env.example` para `.env`.
2. Defina `ADMIN_PASSWORD` com uma senha exclusiva de pelo menos 12 caracteres.
3. Para habilitar o checkout, crie um app REST no [PayPal Developer Dashboard](https://developer.paypal.com/dashboard/) e configure `PAYPAL_CLIENT_ID` e `PAYPAL_CLIENT_SECRET`. Comece com `PAYPAL_ENV=sandbox`. Sem essas credenciais, a loja continua funcionando e o pedido é enviado por e-mail para pagamento combinado (PIX/transferência).
4. Execute `npm start` e abra `http://localhost:3000`. A administração fica em `/admin.html`.

### E-mail dos pedidos

O pedido é enviado para `ORDER_EMAIL` (ou para `SMTP_USER` quando vazio). Duas formas de envio:

**SMTP** (Gmail, Hostinger, Zoho, etc.)

```dotenv
ORDER_EMAIL=pedidos@seudominio.com
EMAIL_FROM=Camada 3D <pedidos@seudominio.com>
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=pedidos@seudominio.com
SMTP_PASS=senha-de-app
```

No Gmail, use uma [senha de app](https://myaccount.google.com/apppasswords) e não a senha da conta. `SMTP_SECURE=true` (ou porta 465) usa TLS direto; a porta 587 usa STARTTLS.

**Resend**

```dotenv
RESEND_API_KEY=re_...
EMAIL_FROM=Camada 3D <pedidos@seudominio.com>
ORDER_EMAIL=pedidos@seudominio.com
```

Se `EMAIL_CUSTOMER_CONFIRMATION=false`, o cliente não recebe cópia do pedido — apenas a loja. Enquanto nenhum provedor estiver configurado, o pedido é registrado normalmente e o painel exibe o aviso "E-mail: configurar .env".

### Frete

O cálculo é feito no servidor por região do CEP (primeiros dois dígitos), com duas opções: PAC (econômico) e SEDEX (expresso). O PAC sai de graça a partir de `FREE_SHIPPING_MIN` (padrão: R$ 249). Ajuste a tabela de preços em `SHIPPING_ZONES`, no início da seção de frete de `server.mjs`.

### Credenciais e segurança

As credenciais PayPal e SMTP são lidas apenas pelo servidor. O Client ID público é enviado ao navegador para carregar o SDK oficial; segredos nunca são expostos ao frontend. Os pedidos são recalculados no servidor a partir do catálogo e só passam para pagos após a captura ser confirmada pelo PayPal. Senhas de clientes são armazenadas com `scrypt` e salt aleatório.

Para testes no sandbox, use as contas de comprador e vendedor criadas no painel de desenvolvedor do PayPal. Depois de testar, configure credenciais de produção e defina `PAYPAL_ENV=live`. Não use credenciais de produção para testes.

## Recursos

- Catálogo com categorias, disponibilidade e preços em BRL.
- **Foto real do produto**: envio de imagem no painel (PNG/JPG/WebP até 5 MB), com redimensionamento automático e fallback para emoji/cor.
- Layout técnico em tema escuro, com HUDs, animações de camadas e leitura de especificações.
- **Checkout em 4 etapas** na própria página (`/checkout.html`): sacola → entrega → frete → pagamento. A sacola lateral é apenas um resumo com atalho para o checkout.
- **Calculadora de frete por CEP** com prazo estimado e frete grátis acima do valor configurado.
- **Cadastro e login de clientes** (`/account.html`) com histórico de pedidos e recompra.
- **Pedido enviado por e-mail** para a loja e confirmação para o cliente.
- Pagamento por PayPal ou por combinação (PIX/transferência), com estoque reservado no pedido manual.
- Painel administrativo com pedidos, produtos, clientes e receita.
- Sacola persistida no navegador e rascunho de endereço no checkout.

## Operação

```powershell
npm start
```

Para desenvolvimento com reinício automático:

```powershell
npm run dev
```

Guia completo de publicação (VPS, domínio, HTTPS, PM2, Nginx, backup e Render/Railway): `COMO-COLOCAR-ONLINE.txt`.

Antes de publicar, use HTTPS, defina uma senha administrativa exclusiva, proteja os arquivos de ambiente e configure backups do diretório `data` (incluindo `data/uploads`). O armazenamento JSON atende a uma implantação pequena em uma única instância; para múltiplas instâncias ou volume maior, migre pedidos, clientes e produtos para um banco de dados gerenciado.

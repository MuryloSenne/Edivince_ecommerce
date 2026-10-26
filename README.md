# Camada 3D

Loja virtual responsiva para artigos impressos em 3D, com catálogo, sacola, checkout PayPal e painel de administração. A aplicação usa Node.js e APIs nativas, sem dependências de runtime.

## Requisitos

- Node.js 20 ou superior
- Conta PayPal Business para receber pagamentos reais

## Configuração

1. Copie `.env.example` para `.env`.
2. Defina `ADMIN_PASSWORD` com uma senha exclusiva de pelo menos 12 caracteres.
3. Para habilitar o checkout, crie um app REST no [PayPal Developer Dashboard](https://developer.paypal.com/dashboard/) e configure `PAYPAL_CLIENT_ID` e `PAYPAL_CLIENT_SECRET`. Comece com `PAYPAL_ENV=sandbox`.
4. Execute `npm start` e abra `http://localhost:3000`. A administração fica em `/admin.html`.

As credenciais PayPal são lidas somente pelo servidor. O Client ID público é enviado ao navegador para carregar o SDK oficial; o segredo nunca é exposto ao frontend. Os pedidos são recalculados no servidor a partir do catálogo e só passam para pagos após a captura ser confirmada pelo PayPal.

Para testes no sandbox, use as contas de comprador e vendedor criadas no painel de desenvolvedor do PayPal. Depois de testar, configure credenciais de produção e defina `PAYPAL_ENV=live`. Não use credenciais de produção para testes.

## Recursos incluídos

- Catálogo com categorias, disponibilidade e preços em BRL.
- Sacola persistida no navegador e formulário de entrega.
- Checkout PayPal Orders v2 com criação e captura de pagamento no servidor.
- Painel administrativo protegido por senha e sessão HttpOnly.
- Resumo de pedidos/receita, acompanhamento de status e gestão de produtos/estoque.
- Pedidos e catálogo persistidos em `data/store.json` (não versionado).

O PayPal não exige mensalidade para abrir uma conta padrão, mas cobra tarifas por transação e outros serviços conforme o país, tipo de conta e operação. Consulte as tarifas vigentes do PayPal Brasil antes de vender. O frete nesta versão é combinado após a compra e não é incluído no total PayPal.

## Operação

```powershell
npm start
```

Para desenvolvimento com reinício automático:

```powershell
npm run dev
```

Antes de publicar, use HTTPS, defina uma senha administrativa exclusiva, proteja os arquivos de ambiente e configure backups do diretório `data`. O armazenamento JSON atende a uma implantação pequena em uma única instância; para múltiplas instâncias ou volume maior, migre pedidos e produtos para um banco de dados gerenciado.

# pix-esteira — backend Vercel

Este é o primeiro pacote do Monitor Pix. Ele fica no GitHub/Vercel e contém
somente o backend. A página da esteira será entregue separadamente para a
Hostinger.

## Estrutura

```text
pix-esteira/
├── api/
│   ├── health.js
│   └── pix/
│       ├── ingest.js
│       ├── list.js
│       ├── sync.js
│       └── webhook.js
├── utils/
│   ├── account-report.js
│   ├── firebase.js
│   ├── http.js
│   ├── mercado-pago.js
│   ├── normalize.js
│   ├── pix-store.js
│   └── signature.js
├── tests/
├── .env.example
├── .gitignore
├── package.json
└── vercel.json
```

## 1. Subir para o GitHub

Crie um repositório chamado `pix-esteira` e envie **o conteúdo desta pasta**.
Não envie `.env`, `.env.local` nem tokens.

## 2. Importar no Vercel

No Vercel:

1. clique em **Add New > Project**;
2. selecione o repositório `pix-esteira`;
3. em **Framework Preset**, use `Other`;
4. não defina Build Command nem Output Directory;
5. adicione as variáveis descritas abaixo;
6. faça o deploy.

## 3. Variáveis de ambiente no Vercel

Use `.env.example` apenas como lista. Os valores reais devem ser cadastrados em
**Vercel > Project > Settings > Environment Variables**.

### Mercado Pago

- `MP_ACCESS_TOKEN`: Access Token de produção da conta monitorada.
- `MP_WEBHOOK_SECRET`: assinatura secreta criada ao cadastrar o Webhook.

Gere um Access Token novo. Não reutilize qualquer token que tenha sido colado
em conversa ou exposto.

### Firebase

- `FIREBASE_PROJECT_ID`
- `FIREBASE_CLIENT_EMAIL`
- `FIREBASE_PRIVATE_KEY`

Esses três valores vêm da chave de conta de serviço:

1. Firebase Console;
2. Configurações do projeto;
3. Contas de serviço;
4. Firebase Admin SDK;
5. Gerar nova chave privada.

No Vercel, cole `private_key` completo em `FIREBASE_PRIVATE_KEY`. O código já
converte os caracteres `\n`.

### Segredos internos

- `PANEL_API_TOKEN`: senha longa criada por você. A mesma será colocada no
  arquivo privado `config.php` da Hostinger.
- `CRON_SECRET`: outra senha longa. O Vercel usa esse valor para autorizar o
  Cron de conferência.
- `AUTOMATE_INGEST_TOKEN`: opcional; usado no fallback do Android Automate.
- `PANEL_ORIGIN`: domínio da Hostinger, por exemplo
  `https://pix.seudominio.com.br`.

Cada segredo deve ser diferente.

## 4. Configurar o Mercado Pago

Depois do primeiro deploy, sua URL será semelhante a:

```text
https://pix-esteira.vercel.app
```

Cadastre como URL do Webhook:

```text
https://pix-esteira.vercel.app/api/pix/webhook
```

Ative pelo menos:

- Pagamentos (`payment`);
- Order / Mercado Pago (`order` ou `orders`), se a opção aparecer.

Copie a assinatura secreta criada pelo Mercado Pago para
`MP_WEBHOOK_SECRET` no Vercel e faça um novo deploy.

## 5. Testar

### Saúde do backend

```text
GET https://pix-esteira.vercel.app/api/health
```

O retorno deve conter:

```json
{
  "ok": true,
  "service": "pix-esteira",
  "firebase": true,
  "mercadoPago": true,
  "webhookSecret": true
}
```

### Listagem protegida

```bash
curl "https://pix-esteira.vercel.app/api/pix/list?from=2026-07-01&to=2026-07-31" \
  -H "X-Panel-Token: SEU_PANEL_API_TOKEN"
```

O navegador não usará esse token diretamente. A Hostinger fará uma chamada
servidor-a-servidor, protegida por sessão e senha.

### Conferência manual

```bash
curl -X POST "https://pix-esteira.vercel.app/api/pix/sync?minutes=120" \
  -H "X-Sync-Token: SEU_CRON_SECRET"
```

Na primeira execução, o endpoint também configura e solicita o relatório
oficial **Dinheiro em conta** do Mercado Pago. A criação é assíncrona:

1. a primeira chamada responde com `reportRequested: true`;
2. enquanto o arquivo não estiver pronto, responde com `reportPending: true`;
3. quando estiver pronto, o CSV é baixado, filtrado e salvo no Firestore.

Somente relatórios solicitados por este backend são importados.

## Endpoints

| Endpoint | Proteção | Função |
| --- | --- | --- |
| `GET /api/health` | público | verifica configuração |
| `POST /api/pix/webhook` | assinatura Mercado Pago | recebe pagamentos |
| `GET /api/pix/list` | `X-Panel-Token` | lista a esteira |
| `GET/POST /api/pix/sync` | `CRON_SECRET` | reconcilia pagamentos |
| `POST /api/pix/ingest` | `X-Ingest-Token` | fallback Automate |

## Firestore

As coleções são criadas automaticamente:

- `pix_receipts`: recebimentos;
- `pix_report_jobs`: relatórios solicitados e seu processamento;
- `pix_system`: estado da última conferência.

O ID do pagamento é usado como ID do documento, impedindo que notificações
repetidas criem duplicatas.

## Observação sobre o Cron

O `vercel.json` agenda uma conferência diária dos dois últimos dias, compatível
com o plano Hobby. O Webhook continua sendo o caminho em tempo real. O painel
Hostinger também poderá solicitar uma conferência protegida quando necessário.

## Desenvolvimento

```bash
npm install
npm run check
npm test
```

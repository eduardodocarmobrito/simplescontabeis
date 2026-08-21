# Simples Contábeis

Portal do escritório: solicitações de documentos por cliente (com anexos travados após o envio),
financeiro (honorários), painel de indicadores, relatórios e integração com o Domínio Web.

Mesma stack do `painel-contabil-libra`: Node + TypeScript + Express, SQLite nativo
(`node:sqlite`) para o banco do site, frontend em uma página HTML/JS sem framework, sessão via
cookie. Pensado para rodar no mesmo ambiente Railway + GitHub.

## Rodando localmente

```bash
npm install
cp .env.example .env   # preencha ADMIN_EMAIL / ADMIN_NOME / ADMIN_PASSWORD pelo menos
npm run dev
```

Acesse `http://localhost:3000`. O primeiro administrador é criado automaticamente a partir do
`.env` na primeira vez que o servidor sobe (só funciona enquanto não existir nenhum usuário).

## Estrutura

- `src/server.ts` — servidor único (API + serve o frontend). Todo o schema do SQLite é criado
  automaticamente na primeira execução (arquivo em `DATA_DIR/simplescontabeis.db`).
- `public/app.html` — frontend inteiro (login, todos os módulos).
- `src/dominio-agent.ts` — processo opcional que sincroniza a lista de clientes do Domínio Web
  (Onvio). Veja a seção **Domínio Web / Onvio** abaixo.
- `src/onvio-login-setup.ts` — script de configuração única (`npm run onvio-login`) que abre um
  navegador de verdade para você logar no Onvio (usuário/senha + verificação em duas etapas) e
  salva a sessão em `data/onvio-session.json`, reaproveitada pelo agente depois.
- `src/nfse.ts` — módulo de emissão de NFS-e (assinatura de XML, criptografia de certificado,
  chamadas ao Sistema Nacional NFS-e). Veja a seção **NFS-e** abaixo.

## Módulos

- **Empresas** — cadastro dos clientes do escritório, com `ativo` e "aparece nos relatórios"
  controlados separadamente.
- **Solicitações** — o administrador cria *modelos* (ex.: "Banco do Brasil" com um item OFX e um
  item PDF, cada um só aceitando a extensão certa), atribui a empresas específicas e gera a grade
  (12 meses do ano, um envio anual, ou solicitações avulsas com rótulo livre — ex.: "Extrato de
  Financiamento nº 4521"). O cliente anexa e salva; depois de salvo o slot fica travado (não dá
  para o cliente excluir/editar/reenviar) até o administrador **reabrir** aquele item específico.
  O arquivo antigo nunca é apagado — fica marcado como substituído, mantendo o histórico.
- **Financeiro** — honorário mensal por empresa, geração automática dos lançamentos do mês,
  controle de pago/pendente/atrasado.
- **Painel (Início)** — cards de indicadores que o administrador cadastra manualmente.
- **Relatórios** — Balanço, Balancete, DRE, Relação de Faturamento e Folha, com filtro de cliente.
  Ficam vazios ("aguardando conexão com o Domínio Web") até a sincronização de dados fiscais
  existir — hoje só a *lista de clientes* é sincronizada, não os relatórios em si.
- **Usuários** — Administrador, Colaborador (com permissões visualizar/postar/editar por módulo,
  e opcionalmente restrito a empresas específicas) e Cliente (vinculado a uma única empresa, só
  enxerga "Meus Documentos").
- **Configurações** — importação de clientes do Domínio Web e envio de e-mail corporativo.
- **NFS-e** — emissão de nota fiscal de serviço direto pelo Sistema Nacional NFS-e (ADN). Veja a
  seção **NFS-e** abaixo.

## Domínio Web / Onvio — sincronização de clientes

O agente (`src/dominio-agent.ts`) roda numa máquina com acesso ao Onvio (não precisa ser a
Railway) e mantém a lista de empresas do site sincronizada com o Domínio Web. Existem três modos,
configurados na tela **Configurações › Domínio Web** do site (campo "Forma de acesso" —
`dominio_config` no banco, o agente busca essa configuração sozinho, sem precisar de `.env`):

- **`onvio` (recomendado, é o que está em uso)** — o agente reaproveita uma sessão de navegador já
  autenticada no Onvio. Configuração única, na máquina onde o agente roda:
  ```bash
  npm run onvio-login
  ```
  Abre um navegador de verdade para você logar normalmente (usuário, senha e verificação em duas
  etapas — SMS ou e-mail). Ao terminar, aperte ENTER no terminal; a sessão fica salva em
  `data/onvio-session.json` (caminho customizável via `DOMINIO_ONVIO_SESSION_PATH`). A partir daí
  o agente consulta a API interna do Onvio (`core/v3/companies/{id}/clients/search`) sozinho, sem
  precisar de MFA de novo — só repita o comando se a sessão expirar um dia.
- `DOMINIO_SOURCE=db` — se você tiver acesso direto ao banco (SQL Server ou Oracle, numa rede
  local/VPN, do mesmo jeito que o agente do painellibra fala com o Oracle do Sankhya).
- `DOMINIO_SOURCE=http` — se o Domínio Web/TOTVS oferecer alguma API HTTP para o seu plano.

Também dá pra importar uma lista pontual via CSV (colunas código/nome/CNPJ/status) pela mesma
tela, sem depender do agente.

### Botão "Atualizar Empresas"

Na tela **Empresas**, o botão **↻ Atualizar Empresas** cria um pedido de sincronização sob
demanda: o site enfileira o pedido (`dominio_sync_jobs`), o agente (que precisa estar rodando —
`npm run dominio-agent:dev`) pega esse pedido no próximo ciclo (poll rápido, a cada ~12s), busca
os dados atuais no Onvio e atualiza o cadastro de empresas (novas entram, existentes são
atualizadas — o campo `ativo` só muda se a fonte realmente informar o status, então a
sincronização nunca zera o status de uma empresa sem essa informação). O botão fica desabilitado
mostrando "Atualizando…" e consulta o resultado a cada 2s, com timeout de ~1 minuto se o agente
não estiver rodando.

Use este botão sempre que cadastrar um cliente novo ou alterar dados de um cliente existente no
Domínio/Onvio, para refletir a mudança no site sem esperar o próximo ciclo automático do agente.

## NFS-e — emissão via Sistema Nacional NFS-e (ADN)

Emite nota fiscal de serviço direto pelo webservice oficial da Receita Federal (Ambiente de Dados
Nacional — ADN), sem depender de emissor de terceiros. Baseado na documentação oficial em
[gov.br/nfse](https://www.gov.br/nfse/pt-br/biblioteca/documentacao-tecnica) (Manual dos
Contribuintes e leiaute ANEXO_I-SEFIN_ADN-DPS_NFSe-SNNFSe).

**Autenticação é sempre por certificado digital (mTLS)** — o ADN exige um certificado ICP-Brasil
na própria conexão TLS para toda chamada (emissão, consulta, cancelamento); não existe login por
usuário/senha para as APIs. Por isso:

- `NFSE_CERT_ENCRYPTION_KEY` (no `.env`) — chave AES-256-GCM usada para criptografar todo
  certificado `.pfx` e senha em repouso (arquivo em `data/nfse-certificados/`, senha cifrada no
  banco). Gere uma vez com `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
  e nunca reaproveite entre ambientes.
- **Certificado do escritório** (tela NFS-e › Configuração) — usado via **procuração eletrônica**
  para emitir em nome de empresas-clientes que outorgaram procuração ao CNPJ do escritório no
  e-CAC/gov.br (isso é feito pelo cliente fora deste site — o sistema não automatiza a outorga,
  só assume que ela já existe quando o método "Procuração eletrônica" é escolhido).
- **Certificado próprio por empresa** (tela NFS-e › Empresas) — para clientes que já têm e-CNPJ
  próprio, evita depender da procuração.

Cada empresa precisa ser habilitada individualmente (NFS-e › Empresas), com código do município
(IBGE, 7 dígitos), inscrição municipal e opção pelo Simples Nacional preenchidos antes de emitir.

**Estado atual: só o ambiente de produção restrita (sandbox oficial do governo)** —
`https://adn.producaorestrita.nfse.gov.br`. Nenhuma NFS-e emitida por aqui tem validade fiscal
ainda. A troca para produção real é uma mudança de uma linha (`ambiente` em `POST /api/nfse/emitir`
no `server.ts`), só depois de validar emissões reais no sandbox.

**Limitação importante**: o Swagger do próprio ambiente de testes exige um certificado válido só
para ser visualizado (é mTLS na conexão, não só na autenticação da API) — não foi possível
confirmar 100% os paths exatos de cada endpoint sem um certificado real em mãos. O envio de XML
assinado até o servidor foi testado e chega corretamente (handshake mTLS alcança o ADN de
verdade), mas o primeiro teste com um certificado ICP-Brasil real pode expor ajustes de path ou de
schema — isso é esperado, não é um retrabalho do zero.

Também não implementado ainda (ficou fora da Fase 1, de propósito): cancelamento de NFS-e,
consulta de parâmetros municipais (alíquota/código de serviço são preenchidos manualmente na
emissão), casos de comércio exterior, obra, evento e deduções da base de cálculo.

## E-mail corporativo

Preencha `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM_EMAIL` no `.env` com
os dados do seu provedor de e-mail corporativo (Microsoft 365, Google Workspace, etc. — geralmente
é preciso gerar uma "senha de aplicativo" específica para SMTP, não a senha normal da conta).
Depois disso o envio manual (Configurações › E-mail) já funciona; automatizar o disparo em cada
solicitação nova é o próximo passo (o campo `notificarEmail` do modelo já existe no banco,
faltando só ligar o gatilho).

## Deploy (GitHub + Railway) — passos que só você consegue fazer

Este projeto já está pronto localmente (git iniciado), mas criar o repositório remoto e conectar
o Railway exige acesso à sua conta, que eu não tenho nesta máquina. Faça, do mesmo jeito que já
está configurado no `painel-contabil-libra`:

1. **GitHub**: crie um repositório vazio em github.com (ex.: `simplescontabeis`), depois:
   ```bash
   git remote add origin https://github.com/SEU_USUARIO/simplescontabeis.git
   git push -u origin main
   ```
2. **Railway**: novo projeto → *Deploy from GitHub repo* → selecione `simplescontabeis`.
   - Adicione um **Volume** montado em `/app/data` e defina `DATA_DIR=/app/data` nas variáveis
     de ambiente (sem isso, os anexos e o banco somem a cada deploy — mesmo esquema do
     painellibra).
   - Configure as variáveis de `.env.example` em Railway → Variables (`ADMIN_EMAIL`,
     `ADMIN_NOME`, `ADMIN_PASSWORD`, `DOMINIO_AGENT_TOKEN`, `SMTP_*`).
   - Build command: `npm run build` · Start command: `npm start`.
3. Se for usar o agente do Domínio Web, rode `npm run dominio-agent:dev` numa máquina com acesso
   à fonte de dados (não precisa ser a Railway), com `CLOUD_URL` apontando para a URL pública do
   site e o mesmo `DOMINIO_AGENT_TOKEN` configurado nos dois lados.

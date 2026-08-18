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
- `src/dominio-agent.ts` — processo opcional que sincroniza a lista de clientes ativos do Domínio
  Web. Veja a seção **Domínio Web** abaixo — hoje o caminho que já funciona é a importação manual
  de CSV, direto na tela **Configurações › Domínio Web** do site.

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

## Domínio Web — o que falta decidir

O agente (`src/dominio-agent.ts`) já está preparado para dois modos, mas nenhum foi ligado porque
isso depende de como você acessa o Domínio Web:

- `DOMINIO_SOURCE=db` — se você tiver acesso direto ao banco (SQL Server ou Oracle, numa rede
  local/VPN, do mesmo jeito que o agente do painellibra fala com o Oracle do Sankhya).
- `DOMINIO_SOURCE=http` — se o Domínio Web/TOTVS oferecer alguma API HTTP para o seu plano.

Enquanto isso não está definido, use a importação manual: exporte a lista de clientes em CSV
direto do Domínio Web (colunas código/nome/CNPJ/status) e importe pela tela **Configurações ›
Domínio Web**. Isso já resolve o item de "listar meus clientes ativos e controlar quem aparece
nos relatórios".

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

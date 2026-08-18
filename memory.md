# Regra padrão: tudo que eu salvar tem que dar pra editar depois

Definido em 2026-08-18. Vale para toda tela nova que eu criar neste projeto.

**Por padrão, qualquer coisa que for salva no site tem que poder ser editada depois** (por quem
tiver a permissão `editar` daquele módulo — ver `colaborador_permissoes` em
[src/server.ts](src/server.ts)). Isso quer dizer: ao criar uma tela nova de cadastro/registro, ela
**precisa vir com um jeito de editar o que já foi salvo** (botão "Editar", endpoint `PUT`, etc.) —
não é opcional, é o padrão. Só não ter edição se isso tiver sido pedido explicitamente como parte
do design daquela tela (uma trava proposital), nunca por eu ter esquecido de fazer.

## A única exceção hoje: anexos do cliente em Solicitações

Os arquivos que o cliente anexa em **Solicitações** (`checklist_uploads`) são a exceção
intencional — depois de salvo, o slot **trava de propósito** (o cliente não pode excluir, editar
ou reenviar). Isso não é uma omissão, é o requisito original do módulo: garantir que o que foi
enviado não seja alterado depois sem rastro. A única forma de destravar é o administrador (ou
colaborador com permissão `editar` em `solicitacoes`) clicar em **Reabrir**
(`POST /api/checklist/uploads/:id/reabrir`, ver [src/server.ts](src/server.ts) e a função
`abrirGrade` em [public/app.html](public/app.html)) — e mesmo assim o arquivo antigo não é
apagado, só marcado como `substituido`, mantendo o histórico.

Qualquer outra tela nova que eu pedir para travar depois de salvo tem que ser um pedido explícito
meu, do mesmo jeito que foi com os anexos — não vira padrão sozinho.

## O que já segue a regra (referência rápida)

Todas essas telas têm edição via `PUT`, sem trava:

- **Empresas** — `PUT /api/empresas/:id`, modal `empresaModal` em [public/app.html](public/app.html).
- **Usuários** (dados, perfil, permissões e empresas de acesso) — `PUT /api/users/:id`,
  `PUT /api/users/:id/permissoes`, `PUT /api/users/:id/empresas`, modal `usuarioModal`.
- **Modelos de solicitação** (o modelo em si, não os anexos já enviados) —
  `PUT /api/checklist/templates/:id`, modal `modeloModal`.
- **Financeiro** (honorário por empresa e cada lançamento, inclusive voltar status de "pago") —
  `PUT /api/financeiro/honorarios/:empresaId`, `PUT /api/financeiro/lancamentos/:id`.
- **Cards do painel** — `PUT /api/dashboard/cards/:id`.

Se eu criar uma tela nova de cadastro e ela não aparecer nesta lista com um jeito de editar,
é sinal de que ficou faltando — não assumir que está certo assim.

# Regra padrão: campo de seleção/busca tem que dar pra digitar e filtrar

Definido em 2026-08-18. Vale pra todo campo novo que eu criar pra escolher um item numa lista
(cliente, empresa, usuário, etc.) — nada de `<select>` nativo simples quando a lista pode crescer.

**Todo campo de seleção/busca tem que ter a opção de digitar para filtrar** — o usuário não pode
ficar preso rolando uma lista longa num `<select>` nativo. O padrão do projeto é o combobox com
busca: `comboSelectHtml(id, placeholder)` gera o HTML e `setupComboSelect(id, items, onChange)`
liga o filtro/seleção — ambos em [public/app.html](public/app.html), junto dos outros helpers
(perto de `esc()`). `items` é `[{id, label}]`; `onChange(id|null)` roda a cada seleção ou quando o
campo é limpo. O valor selecionado fica em `#{id} .combo-value` (input hidden) — é isso que o resto
do código lê, não o texto digitado.

Primeiro uso: filtro de **Cliente** em Relatórios (`renderRelTab`/`carregarRelatorio`). Qualquer
campo novo de "escolher uma empresa/usuário/item numa lista" que eu pedir depois deve usar esse
mesmo componente por padrão, mesmo que eu não peça a busca explicitamente de novo — só usar um
`<select>` simples se a lista for claramente curta e fixa (ex.: os 3-4 perfis de usuário, os tipos
de arquivo aceitos).

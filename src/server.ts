import "dotenv/config";
import express from "express";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import cookieParser from "cookie-parser";
import rateLimit from "express-rate-limit";
import multer from "multer";
import nodemailer from "nodemailer";
import archiver from "archiver";
import { DatabaseSync } from "node:sqlite";
import * as nfse from "./nfse";
import * as asaas from "./asaas";
import * as contratos from "./contratos";
import * as danfse from "./danfse";
import * as whatsapp from "./whatsapp";
import * as nfe from "./nfe";
import * as nfePdf from "./nfe-pdf";
import * as onedrive from "./onedrive";
import * as integracontador from "./integracontador";
import * as ocr from "./ocr";
import { buscarViaOnvio } from "./onvio-sync";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import https from "https";
import { createProxyMiddleware } from "http-proxy-middleware";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";

const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;

// ========================= BANCO DO SITE (SQLite, num volume persistente) =========================
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "..", "data");
const UPLOADS_DIR = path.join(DATA_DIR, "uploads");
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const sqlite = new DatabaseSync(path.join(DATA_DIR, "simplescontabeis.db"));
sqlite.exec(`PRAGMA journal_mode = WAL;`);
sqlite.exec(`PRAGMA busy_timeout = 8000;`);
sqlite.exec(`PRAGMA foreign_keys = ON;`);

sqlite.exec(`
  -- ---- Multi-tenant: cada escritório-cliente que contrata este sistema é isolado dos demais ----
  CREATE TABLE IF NOT EXISTS escritorios (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nome TEXT NOT NULL,
    cnpj TEXT,
    email TEXT,
    telefone TEXT,
    empresa_id INTEGER REFERENCES empresas(id), -- a empresa que representa o próprio escritório (prestador de honorários, "Contratada" nos contratos, certificado próprio)
    agent_token TEXT UNIQUE, -- token do agente do Domínio Web deste escritório
    ativo INTEGER NOT NULL DEFAULT 1,
    envio_rollover_ultimo_ano INTEGER, -- último ano em que a virada automática de grade de Envio de Documentos já rodou pra este escritório (ver envioRolloverGerarAno) — evita rodar 2x no mesmo ano
    criado_em TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS empresas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nome TEXT NOT NULL,
    cnpj TEXT,
    codigo_dominio TEXT,
    apelido TEXT, -- apelido curto (vem do Domínio Web quando disponível, ou preenchido na mão) — usado no nome da pasta de exportação de XML (ver dominio-agent.ts): "código-apelido", igual à convenção que o próprio Domínio já usa na pasta de importação dele
    email TEXT,
    telefone TEXT,
    endereco TEXT,
    cidade TEXT,
    uf TEXT,
    cep TEXT,
    ativo INTEGER NOT NULL DEFAULT 1,
    visivel_relatorios INTEGER NOT NULL DEFAULT 1,
    origem TEXT NOT NULL DEFAULT 'manual',
    isento_assinatura INTEGER NOT NULL DEFAULT 0, -- conta cortesia: acesso liberado a NFS-e/Financeiro sem cobrança
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS empresa_contatos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    empresa_id INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
    nome TEXT NOT NULL,
    email TEXT NOT NULL,
    receber_emails INTEGER NOT NULL DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS app_users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nome TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    perfil TEXT NOT NULL, -- 'Administrador' | 'Colaborador' | 'Cliente'
    empresa_id INTEGER REFERENCES empresas(id) ON DELETE CASCADE, -- só para perfil = Cliente
    acesso_todas_empresas INTEGER NOT NULL DEFAULT 1, -- só relevante para Colaborador
    password_hash TEXT NOT NULL,
    ativo INTEGER NOT NULL DEFAULT 1,
    isento_assinatura INTEGER NOT NULL DEFAULT 0, -- Colaborador isento da cobrança por assento (não entra na contagem)
    painel_tv INTEGER NOT NULL DEFAULT 0, -- conta dedicada pro Painel de TV (Início em tela cheia, sem menu) — sessão de vida longa
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
    created_at TEXT DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL
  );

  -- Empresas que um Colaborador com acesso_todas_empresas=0 pode enxergar
  CREATE TABLE IF NOT EXISTS colaborador_empresas (
    user_id INTEGER NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
    empresa_id INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
    PRIMARY KEY (user_id, empresa_id)
  );

  -- Empresas que um usuário perfil Cliente pode operar (pode ter mais de uma — nesse caso ele
  -- escolhe qual está "ativa" na sessão, ver sessions.empresa_ativa_id).
  CREATE TABLE IF NOT EXISTS cliente_empresas (
    user_id INTEGER NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
    empresa_id INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
    PRIMARY KEY (user_id, empresa_id)
  );

  -- Permissão por módulo para Colaboradores (Administrador sempre tem tudo liberado)
  CREATE TABLE IF NOT EXISTS colaborador_permissoes (
    user_id INTEGER NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
    modulo TEXT NOT NULL,
    pode_visualizar INTEGER NOT NULL DEFAULT 0,
    pode_postar INTEGER NOT NULL DEFAULT 0,
    pode_editar INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, modulo)
  );
  -- Controle fino de QUAIS abas dentro de "Configurações" um Colaborador enxerga — o módulo
  -- "configuracoes" já libera a tela toda (ver/postar/editar acima), isso restringe ainda mais,
  -- só pra esse módulo específico (as outras telas não têm sub-abas sensíveis o bastante pra
  -- precisar disso). Sem nenhuma linha aqui pro colaborador = vê todas as abas (comportamento
  -- anterior preservado; a restrição só entra em vigor quando o admin marca algo explicitamente).
  CREATE TABLE IF NOT EXISTS colaborador_config_abas (
    user_id INTEGER NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
    aba TEXT NOT NULL, -- 'dominio' | 'email' | 'whatsapp' | 'nfse-agendamento' | 'assinatura-plataforma'
    PRIMARY KEY (user_id, aba)
  );
  -- Mesma ideia acima, mas pro menu inteiro de um Cliente — controla quais das próprias páginas
  -- dele (NFS-e, Meus Documentos, Solicitar Documentos, Documentos Recebidos, Financeiro,
  -- Assinatura) aparecem no menu. Sem nenhuma linha aqui pro cliente = vê todas (default seguro).
  CREATE TABLE IF NOT EXISTS cliente_paginas_visiveis (
    user_id INTEGER NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
    pagina TEXT NOT NULL, -- 'minha-nfse' | 'meus-documentos' | 'solicitar-documentos' | 'documentos-recebidos' | 'minha-financeiro' | 'minha-assinatura'
    PRIMARY KEY (user_id, pagina)
  );
  -- Controla, POR EMPRESA-CLIENTE (não por usuário/login), o que pode ser pedido no módulo "Solicitar
  -- Documentos" — ex.: uma empresa Lucro Real não tem porque pedir "Recalcular DAS" (isso é coisa de
  -- Simples Nacional). chave é 'recalculo_das' | 'parcelamento_das' (as duas opções fixas do módulo,
  -- que não são registros de envio_templates) ou 'template:<id>' apontando pra um envio_templates
  -- (visivel_cliente=1) do mesmo escritório da empresa. Sem nenhuma linha aqui pra uma empresa = sem
  -- restrição (pode solicitar tudo) — mesmo default seguro de cliente_paginas_visiveis, acima.
  CREATE TABLE IF NOT EXISTS empresa_solicitacao_tipos (
    empresa_id INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
    chave TEXT NOT NULL,
    PRIMARY KEY (empresa_id, chave)
  );

  -- ---- Solicitações de documentos (checklist) ----
  CREATE TABLE IF NOT EXISTS checklist_templates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nome TEXT NOT NULL,
    descricao TEXT,
    periodicidade TEXT NOT NULL DEFAULT 'mensal', -- 'mensal' | 'anual' | 'avulso'
    itens_json TEXT NOT NULL, -- [{chave,label,accept:['ofx','pdf','zip','xml','imagem','qualquer'],obrigatorio}]
    notificar_email INTEGER NOT NULL DEFAULT 0,
    ativo INTEGER NOT NULL DEFAULT 1,
    created_by INTEGER,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS checklist_atribuicoes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    template_id INTEGER NOT NULL REFERENCES checklist_templates(id) ON DELETE CASCADE,
    empresa_id INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
    ativo INTEGER NOT NULL DEFAULT 1,
    created_by INTEGER,
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(template_id, empresa_id)
  );

  CREATE TABLE IF NOT EXISTS checklist_periodos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    atribuicao_id INTEGER NOT NULL REFERENCES checklist_atribuicoes(id) ON DELETE CASCADE,
    ano INTEGER NOT NULL,
    mes INTEGER, -- NULL para periodicidade 'anual' ou 'avulso'
    rotulo TEXT, -- usado em 'avulso', ex.: "Extrato de Financiamento nº 4521"
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(atribuicao_id, ano, mes, rotulo)
  );

  CREATE TABLE IF NOT EXISTS checklist_uploads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    periodo_id INTEGER NOT NULL REFERENCES checklist_periodos(id) ON DELETE CASCADE,
    item_chave TEXT NOT NULL,
    versao INTEGER NOT NULL DEFAULT 1,
    file_name TEXT NOT NULL,
    file_path TEXT NOT NULL,
    mime TEXT,
    size_bytes INTEGER,
    status TEXT NOT NULL DEFAULT 'salvo', -- 'salvo' | 'substituido'
    uploaded_by INTEGER REFERENCES app_users(id),
    uploaded_at TEXT DEFAULT (datetime('now')),
    reaberto_por INTEGER REFERENCES app_users(id),
    reaberto_em TEXT,
    reaberto_motivo TEXT
  );

  -- Fica marcado no período quando o admin reabre uma pendência, liberando novo upload
  CREATE TABLE IF NOT EXISTS checklist_reaberturas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    periodo_id INTEGER NOT NULL REFERENCES checklist_periodos(id) ON DELETE CASCADE,
    item_chave TEXT NOT NULL,
    motivo TEXT,
    reaberto_por INTEGER REFERENCES app_users(id),
    reaberto_em TEXT DEFAULT (datetime('now')),
    resolvido INTEGER NOT NULL DEFAULT 0
  );

  -- ---- Envio de Documentos (sentido contrário de Solicitações: o escritório posta e o cliente recebe) ----
  CREATE TABLE IF NOT EXISTS envio_templates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nome TEXT NOT NULL, -- "DARF PIS", "FGTS", "Retenções de Notas Fiscais"...
    descricao TEXT,
    periodicidade TEXT NOT NULL DEFAULT 'mensal', -- 'mensal' | 'anual' | 'avulso'
    accept_json TEXT NOT NULL DEFAULT '["pdf"]',
    detectar_vencimento INTEGER NOT NULL DEFAULT 1, -- desliga pra tipos sem data de vencimento (DRE, Balancete...)
    considera_mes_atual INTEGER NOT NULL DEFAULT 1, -- pro card "envio_atraso": 1 cobra a competência do mês corrente (ex.: Nota Fiscal, pode ser emitida a qualquer momento do mês) | 0 só cobra depois que o mês fecha, igual DAS (ex.: DRE/Balancete/Razão Contábil, só existem depois do mês acabar)
    visivel_cliente INTEGER NOT NULL DEFAULT 0, -- aparece no menu "Solicitar Documentos" do cliente
    ativo INTEGER NOT NULL DEFAULT 1,
    created_by INTEGER,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS envio_atribuicoes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    template_id INTEGER NOT NULL REFERENCES envio_templates(id) ON DELETE CASCADE,
    empresa_id INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
    ativo INTEGER NOT NULL DEFAULT 1,
    created_by INTEGER,
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(template_id, empresa_id)
  );

  CREATE TABLE IF NOT EXISTS envio_periodos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    atribuicao_id INTEGER NOT NULL REFERENCES envio_atribuicoes(id) ON DELETE CASCADE,
    ano INTEGER NOT NULL,
    mes INTEGER,
    rotulo TEXT,
    solicitado_por INTEGER REFERENCES app_users(id), -- preenchido quando o período nasce de um pedido do cliente (menu "Solicitar Documentos")
    solicitado_em TEXT,
    solicitacao_tipo TEXT, -- 'documento' (pedido normal, "Solicitar Documentos") ou 'recalculo_das' — só pra exibir na lista de Solicitações
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(atribuicao_id, ano, mes, rotulo)
  );

  -- Um documento por período (a guia em si) — sem trava: o administrador pode substituir/excluir
  -- se anexou o arquivo errado (quem precisa ficar travado é o anexo que o CLIENTE manda, não o
  -- que o escritório envia — ver memory.md).
  -- Mais de um documento pode existir no mesmo período (ex.: guia original + guia recalculada
  -- porque o cliente não pagou no prazo) — por isso não há UNIQUE(periodo_id) aqui.
  CREATE TABLE IF NOT EXISTS envio_documentos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    periodo_id INTEGER NOT NULL REFERENCES envio_periodos(id) ON DELETE CASCADE,
    file_name TEXT NOT NULL,
    file_path TEXT NOT NULL,
    mime TEXT,
    size_bytes INTEGER,
    observacao TEXT, -- ex.: "Guia recalculada — juros/multa atualizados"
    vencimento TEXT, -- 'YYYY-MM-DD', detectado automaticamente do conteúdo do arquivo (editável)
    vencimento_origem TEXT, -- 'automatico' | 'manual'
    enviado_por INTEGER REFERENCES app_users(id),
    enviado_em TEXT DEFAULT (datetime('now')),
    email_enviado INTEGER NOT NULL DEFAULT 0,
    email_enviado_em TEXT,
    email_erro TEXT,
    whatsapp_enviado INTEGER NOT NULL DEFAULT 0,
    whatsapp_enviado_em TEXT,
    whatsapp_erro TEXT
  );

  -- ---- Financeiro (honorários) ----
  CREATE TABLE IF NOT EXISTS honorarios (
    empresa_id INTEGER PRIMARY KEY REFERENCES empresas(id) ON DELETE CASCADE,
    valor REAL NOT NULL DEFAULT 0,
    dia_vencimento INTEGER NOT NULL DEFAULT 10,
    ativo INTEGER NOT NULL DEFAULT 1,
    observacao TEXT,
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS honorarios_lancamentos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    empresa_id INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
    competencia TEXT NOT NULL, -- 'YYYY-MM'
    valor REAL NOT NULL,
    vencimento TEXT NOT NULL, -- 'YYYY-MM-DD'
    status TEXT NOT NULL DEFAULT 'pendente', -- 'pendente' | 'pago' | 'atrasado' | 'cancelado'
    data_pagamento TEXT,
    forma_pagamento TEXT,
    observacao TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(empresa_id, competencia)
  );

  -- ---- Financeiro do próprio negócio da empresa-cliente self-service (perfil Cliente) ----
  CREATE TABLE IF NOT EXISTS financeiro_pagar (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    empresa_id INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
    descricao TEXT NOT NULL,
    fornecedor TEXT,
    valor REAL NOT NULL,
    vencimento TEXT NOT NULL, -- 'YYYY-MM-DD'
    status TEXT NOT NULL DEFAULT 'pendente', -- 'pendente' | 'pago' | 'atrasado' | 'cancelado'
    data_pagamento TEXT,
    observacao TEXT,
    conta_id INTEGER REFERENCES financeiro_contas(id) ON DELETE SET NULL,
    criado_por INTEGER REFERENCES app_users(id),
    criado_em TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS financeiro_receber (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    empresa_id INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
    descricao TEXT NOT NULL,
    cliente_nome TEXT,
    valor REAL NOT NULL,
    vencimento TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pendente', -- 'pendente' | 'pago' | 'atrasado' | 'cancelado'
    data_recebimento TEXT,
    observacao TEXT,
    origem TEXT NOT NULL DEFAULT 'manual', -- 'manual' | 'nfse'
    nfse_emissao_id INTEGER REFERENCES nfse_emissoes(id) ON DELETE SET NULL,
    conta_id INTEGER REFERENCES financeiro_contas(id) ON DELETE SET NULL,
    criado_por INTEGER REFERENCES app_users(id),
    criado_em TEXT DEFAULT (datetime('now'))
  );
  -- Conta (banco/caixa) onde o título foi de fato pago/recebido — só pra indicar/organizar, sem
  -- nenhuma integração bancária real (sem saldo calculado, sem extrato importado).
  CREATE TABLE IF NOT EXISTS financeiro_contas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    empresa_id INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
    nome TEXT NOT NULL,
    tipo TEXT NOT NULL DEFAULT 'banco', -- 'banco' | 'caixa' | 'outro'
    ativo INTEGER NOT NULL DEFAULT 1,
    criado_em TEXT DEFAULT (datetime('now'))
  );

  -- ---- Catálogo de módulos vendáveis (self-service) e contratação por empresa-cliente ----
  CREATE TABLE IF NOT EXISTS modulos_catalogo (
    chave TEXT PRIMARY KEY, -- 'nfse' | 'financeiro' | outros, nascem no código junto com o módulo
    nome TEXT NOT NULL,
    valor_mensal REAL NOT NULL DEFAULT 0,
    ativo INTEGER NOT NULL DEFAULT 1, -- posso tirar um módulo de venda sem apagar o histórico
    updated_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS empresa_modulos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    empresa_id INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
    modulo_chave TEXT NOT NULL REFERENCES modulos_catalogo(chave),
    trial_inicio TEXT NOT NULL,
    trial_fim TEXT NOT NULL,
    trial_prorrogado INTEGER NOT NULL DEFAULT 0,
    assinatura_ativa_ate TEXT, -- NULL até o 1º pagamento confirmado
    criado_em TEXT DEFAULT (datetime('now')),
    UNIQUE(empresa_id, modulo_chave)
  );
  -- ---- Cobrança combinada (Pix/cartão via Asaas) de um ou mais módulos de uma vez ----
  CREATE TABLE IF NOT EXISTS financeiro_licenca_cobrancas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    empresa_id INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
    valor_total REAL NOT NULL,
    vencimento TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pendente', -- espelha o status do Asaas: pendente|confirmado|recebido|vencido|cancelado
    asaas_payment_id TEXT,
    invoice_url TEXT,
    pix_qrcode TEXT, -- payload copia-e-cola
    pix_qrcode_imagem TEXT, -- base64 do QR code (cacheado, evita rebaixar do Asaas toda hora)
    criado_em TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS financeiro_licenca_cobranca_itens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cobranca_id INTEGER NOT NULL REFERENCES financeiro_licenca_cobrancas(id) ON DELETE CASCADE,
    modulo_chave TEXT NOT NULL,
    valor REAL NOT NULL
  );

  -- ---- Mesma lógica acima (catálogo + teste grátis + assinatura via Asaas), só que pro
  -- escritório-cliente da plataforma contratar (não a empresa-cliente dele) — ex.: rotina
  -- automática de NFS-e, envio automático por e-mail, envio automático por WhatsApp. ----
  CREATE TABLE IF NOT EXISTS modulos_escritorio_catalogo (
    chave TEXT PRIMARY KEY,
    nome TEXT NOT NULL,
    valor_mensal REAL NOT NULL DEFAULT 0,
    ativo INTEGER NOT NULL DEFAULT 1,
    updated_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS escritorio_modulos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    escritorio_id INTEGER NOT NULL REFERENCES escritorios(id) ON DELETE CASCADE,
    modulo_chave TEXT NOT NULL REFERENCES modulos_escritorio_catalogo(chave),
    trial_inicio TEXT NOT NULL,
    trial_fim TEXT NOT NULL,
    trial_prorrogado INTEGER NOT NULL DEFAULT 0,
    assinatura_ativa_ate TEXT,
    criado_em TEXT DEFAULT (datetime('now')),
    UNIQUE(escritorio_id, modulo_chave)
  );
  CREATE TABLE IF NOT EXISTS escritorio_licenca_cobrancas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    escritorio_id INTEGER NOT NULL REFERENCES escritorios(id) ON DELETE CASCADE,
    valor_total REAL NOT NULL,
    vencimento TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pendente',
    asaas_payment_id TEXT,
    invoice_url TEXT,
    pix_qrcode TEXT,
    pix_qrcode_imagem TEXT,
    criado_em TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS escritorio_licenca_cobranca_itens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cobranca_id INTEGER NOT NULL REFERENCES escritorio_licenca_cobrancas(id) ON DELETE CASCADE,
    modulo_chave TEXT NOT NULL,
    valor REAL NOT NULL,
    quantidade INTEGER NOT NULL DEFAULT 1 -- só relevante pro item 'assento_colaborador' (valor já é o total, quantidade fica pra auditoria/histórico)
  );

  -- ---- Contratos (gestão dos contratos e aditivos do escritório com as empresas-cliente) ----
  CREATE TABLE IF NOT EXISTS contratos_modelos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nome TEXT NOT NULL,
    conteudo_html TEXT NOT NULL, -- corpo do contrato com placeholders {{chave}}
    campos TEXT NOT NULL DEFAULT '[]', -- JSON [{chave, rotulo, tipo, autoPreencherDe}]
    ativo INTEGER NOT NULL DEFAULT 1,
    criado_em TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS contratos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    modelo_id INTEGER REFERENCES contratos_modelos(id) ON DELETE SET NULL,
    empresa_id INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
    tipo TEXT NOT NULL DEFAULT 'contrato', -- 'contrato' | 'aditivo' | 'distrato'
    contrato_pai_id INTEGER REFERENCES contratos(id) ON DELETE SET NULL, -- só em aditivos/distratos
    titulo TEXT NOT NULL,
    conteudo_html TEXT NOT NULL, -- cópia independente, editável, já com os dados aplicados
    dados_preenchidos TEXT NOT NULL DEFAULT '{}', -- JSON dos valores usados no preenchimento
    status TEXT NOT NULL DEFAULT 'rascunho', -- 'rascunho' | 'ativo' | 'encerrado'
    numero_sequencial INTEGER, -- só em tipo='contrato' — reinicia em 1 a cada ano, nunca se repete dentro do mesmo ano
    numero_sequencial_ano INTEGER, -- ano em que numero_sequencial foi atribuído (Brasília)
    ultimo_pdf_path TEXT, -- cache do PDF gerado; limpo a cada edição salva
    criado_por INTEGER REFERENCES app_users(id),
    criado_em TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );
  -- Cláusula e assinaturas padrão usadas em todo distrato gerado — configuradas uma única vez na
  -- aba Modelos e reaproveitadas em qualquer contrato (o cabeçalho/timbrado vem do contrato
  -- original sendo distratado, igual já acontece com o aditivo).
  CREATE TABLE IF NOT EXISTS contratos_distrato_config (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    clausula_padrao TEXT,
    assinaturas_padrao TEXT,
    updated_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS contratos_envios (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    contrato_id INTEGER NOT NULL REFERENCES contratos(id) ON DELETE CASCADE,
    email_destino TEXT NOT NULL,
    sucesso INTEGER NOT NULL,
    erro TEXT,
    enviado_por INTEGER REFERENCES app_users(id),
    enviado_em TEXT DEFAULT (datetime('now'))
  );

  -- ---- Painel (cards de indicadores configuráveis) ----
  CREATE TABLE IF NOT EXISTS dashboard_cards (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    titulo TEXT NOT NULL,
    valor TEXT NOT NULL,
    subtitulo TEXT,
    cor TEXT DEFAULT 'brass',
    ordem INTEGER NOT NULL DEFAULT 0,
    created_by INTEGER,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  -- Piso de competência pros cards "computados" de pendência (DAS em Atraso, Documentos Pendentes
  -- de Envio, Solicitações de Documentos, Documentos Pendentes) — sem linha aqui, cada card usa o
  -- período mais antigo já gerado na grade (comportamento de sempre). Com uma linha, nenhum desses
  -- cards flagra competência anterior à configurada, mesmo que a grade tenha períodos mais antigos
  -- sem documento — útil pra "zerar o histórico" quando o controle começou a valer só a partir de
  -- um certo mês (o que veio antes foi resolvido por fora do sistema).
  CREATE TABLE IF NOT EXISTS painel_monitoramento_config (
    escritorio_id INTEGER PRIMARY KEY,
    competencia_inicio_ano INTEGER,
    competencia_inicio_mes INTEGER,
    updated_at TEXT DEFAULT (datetime('now'))
  );

  -- ---- Relatórios: cache alimentado pela sincronização com o Domínio Web (ainda não conectado) ----
  CREATE TABLE IF NOT EXISTS dominio_dados (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    empresa_id INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
    tipo TEXT NOT NULL, -- 'balanco' | 'balancete' | 'dre' | 'faturamento' | 'folha'
    competencia TEXT,
    dados_json TEXT NOT NULL,
    sincronizado_em TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS dominio_sync_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    executado_em TEXT DEFAULT (datetime('now')),
    origem TEXT NOT NULL, -- 'importacao-csv' | 'agente' | 'nuvem'
    empresas_novas INTEGER DEFAULT 0,
    empresas_atualizadas INTEGER DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'ok',
    detalhe TEXT
  );

  -- Controle/auditoria da importação de PDFs de Balanço/DRE/Balancete de uma pasta do OneDrive (ver
  -- dominioRelatoriosSincronizar) — não é o documento final (esse vira envio_documentos de verdade,
  -- sob um dos 4 templates protegidos "Balanço"/"Balancete"/"DRE Mensal"/"DRE Anual"), só o registro
  -- de QUAL arquivo do OneDrive já foi processado (dedupe por onedrive_item_id, que não é sequencial
  -- como o cursor usado na exportação de XML) e o que aconteceu com ele (sucesso ou motivo da falha).
  CREATE TABLE IF NOT EXISTS dominio_relatorios_importados (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    escritorio_id INTEGER NOT NULL REFERENCES escritorios(id) ON DELETE CASCADE,
    onedrive_item_id TEXT NOT NULL,
    nome_arquivo TEXT NOT NULL,
    tipo_detectado TEXT, -- 'balanco' | 'balancete' | 'dre_mensal' | 'dre_anual' | NULL
    periodo_inicio TEXT, -- 'AAAA-MM-DD'
    periodo_fim TEXT,
    cnpj_detectado TEXT,
    codigo_dominio_arquivo TEXT, -- pista extraída do NOME do arquivo — só sugestão, nunca confirma empresa sozinha
    empresa_id INTEGER REFERENCES empresas(id),
    envio_documento_id INTEGER REFERENCES envio_documentos(id),
    status TEXT NOT NULL, -- 'ok' | 'sem_cnpj' | 'empresa_nao_encontrada' | 'tipo_nao_identificado' | 'erro'
    erro TEXT,
    arquivo_pendente_path TEXT, -- só quando status != 'ok': PDF salvo em disco pra resolução manual sem rebaixar do OneDrive
    texto_preview TEXT, -- ~2000 primeiros caracteres extraídos, pra auditoria/depuração sem reabrir o PDF
    importado_em TEXT DEFAULT (datetime('now')),
    UNIQUE(escritorio_id, onedrive_item_id)
  );

  -- Configuração de acesso IMAP a uma caixa de e-mail (ex.: simplescontabeis@gmail.com) pra
  -- importar automaticamente extratos bancários e outros documentos financeiros que os clientes
  -- mandam por e-mail (ver emailExtratosSincronizar) — mesma ideia da importação de relatórios do
  -- OneDrive, só que a fonte é uma caixa de e-mail em vez de uma pasta. Senha de app (não a senha
  -- normal da conta) cifrada em repouso, mesmo padrão AES-256-GCM já usado pra certificado/OneDrive.
  CREATE TABLE IF NOT EXISTS email_extratos_config (
    escritorio_id INTEGER PRIMARY KEY REFERENCES escritorios(id),
    email TEXT,
    senha_app_cifrada TEXT,
    ativo INTEGER NOT NULL DEFAULT 0,
    ultimo_uid_processado INTEGER NOT NULL DEFAULT 0, -- cursor IMAP (UID é sequencial dentro da caixa)
    ultima_varredura_em TEXT,
    ultimo_erro TEXT,
    updated_at TEXT DEFAULT (datetime('now'))
  );
  -- Controle/auditoria por ANEXO (não por e-mail — uma mensagem pode ter vários extratos + outros
  -- documentos, cada um vira uma linha) — mesma função da dominio_relatorios_importados acima, só
  -- que a chave de dedupe é (message_id, nome_arquivo) em vez de onedrive_item_id.
  CREATE TABLE IF NOT EXISTS email_extratos_importados (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    escritorio_id INTEGER NOT NULL REFERENCES escritorios(id) ON DELETE CASCADE,
    message_id TEXT NOT NULL,
    email_assunto TEXT,
    email_remetente TEXT,
    email_recebido_em TEXT,
    nome_arquivo TEXT NOT NULL,
    tipo_detectado TEXT, -- 'extrato' | 'outro'
    banco_detectado TEXT, -- só quando tipo_detectado='extrato'
    cnpj_detectado TEXT,
    empresa_id INTEGER REFERENCES empresas(id),
    envio_documento_id INTEGER REFERENCES envio_documentos(id),
    status TEXT NOT NULL, -- 'ok' | 'empresa_nao_encontrada' | 'erro'
    erro TEXT,
    arquivo_pendente_path TEXT,
    importado_em TEXT DEFAULT (datetime('now')),
    UNIQUE(escritorio_id, message_id, nome_arquivo)
  );

  CREATE TABLE IF NOT EXISTS agent_heartbeat (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    last_seen_at TEXT,
    version TEXT
  );

  -- Configuração de acesso do agente do Domínio Web, editável pela tela Configurações (o agente
  -- busca isso na nuvem a cada ciclo — não precisa mais editar o .env dele na mão).
  CREATE TABLE IF NOT EXISTS dominio_config (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    source TEXT NOT NULL DEFAULT '', -- 'db' | 'http' | ''
    db_driver TEXT,        -- 'mssql' | 'oracle'
    db_host TEXT,
    db_port INTEGER,
    db_name TEXT,
    db_user TEXT,
    db_password TEXT,
    db_connect_string TEXT, -- usado no modo oracle (easy connect: host:porta/servico)
    query_clientes TEXT,
    col_codigo TEXT DEFAULT 'CODIGO',
    col_nome TEXT DEFAULT 'NOME',
    col_cnpj TEXT DEFAULT 'CNPJ',
    col_status TEXT DEFAULT 'STATUS',
    api_url TEXT,
    api_token TEXT,
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS dominio_test_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    status TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'ok' | 'erro'
    resultado_json TEXT,
    erro TEXT,
    criado_por INTEGER REFERENCES app_users(id),
    criado_em TEXT DEFAULT (datetime('now')),
    resolvido_em TEXT
  );

  -- ---- E-mail corporativo (editável pela tela, sem mexer no .env) ----
  CREATE TABLE IF NOT EXISTS email_config (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    smtp_host TEXT,
    smtp_port INTEGER DEFAULT 587,
    smtp_secure INTEGER DEFAULT 0,
    smtp_user TEXT,
    smtp_password TEXT,
    from_name TEXT,
    from_email TEXT,
    nfse_email_texto TEXT,
    updated_at TEXT DEFAULT (datetime('now'))
  );

  -- ---- WhatsApp Business Platform (Cloud API da Meta) — por escritório, criada já no formato novo
  -- (as outras 5 configs viraram assim só na Fase 2 da conversão multi-tenant; esta já nasce certa).
  CREATE TABLE IF NOT EXISTS whatsapp_config (
    escritorio_id INTEGER PRIMARY KEY REFERENCES escritorios(id),
    phone_number_id TEXT,
    business_account_id TEXT,
    access_token_cifrado TEXT,
    numero_exibicao TEXT, -- só pra conferência na tela (o número de telefone que o WhatsApp Business tem cadastrado)
    template_documento TEXT NOT NULL DEFAULT 'documento_disponivel', -- nome do modelo aprovado na Meta
    template_idioma TEXT NOT NULL DEFAULT 'pt_BR',
    ativo INTEGER NOT NULL DEFAULT 0,
    webhook_verify_token TEXT, -- gerado uma vez, colado no campo "Verify Token" do Webhook no Meta for Developers
    app_secret_cifrado TEXT, -- opcional — valida a assinatura (X-Hub-Signature-256) das chamadas do webhook, se preenchido
    updated_at TEXT DEFAULT (datetime('now'))
  );
  -- Status real de entrega de cada mensagem, recebido via webhook do WhatsApp (sem isso, só
  -- sabemos se a Meta ACEITOU o envio, não se entregou de verdade no celular do cliente).
  CREATE TABLE IF NOT EXISTS whatsapp_mensagens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    escritorio_id INTEGER NOT NULL REFERENCES escritorios(id),
    wamid TEXT NOT NULL UNIQUE,
    origem_tabela TEXT NOT NULL, -- 'envio_documentos' | 'nfse_emissoes'
    origem_id INTEGER NOT NULL,
    telefone TEXT,
    status TEXT NOT NULL DEFAULT 'accepted', -- 'accepted' | 'sent' | 'delivered' | 'read' | 'failed'
    erro_codigo TEXT,
    erro_mensagem TEXT,
    criado_em TEXT DEFAULT (datetime('now')),
    atualizado_em TEXT DEFAULT (datetime('now'))
  );

  -- ---- CRM (caixa de entrada de conversas do WhatsApp, cliente iniciando contato) ----
  -- Diferente de whatsapp_mensagens acima (só rastreia ENTREGA de envio nosso), aqui é conversa de
  -- duas mãos de verdade: cliente manda mensagem, cai num menu de departamento, e um colaborador
  -- responsável por aquele departamento assume e responde.
  CREATE TABLE IF NOT EXISTS crm_departamentos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    escritorio_id INTEGER NOT NULL REFERENCES escritorios(id),
    nome TEXT NOT NULL,
    ordem INTEGER NOT NULL DEFAULT 0, -- define o número do menu (1, 2, 3...), na ordem crescente
    ativo INTEGER NOT NULL DEFAULT 1,
    rodizio_ultimo_user_id INTEGER REFERENCES app_users(id) -- só usado no modo_distribuicao='rodizio' (ver crm_config) — quem recebeu a última conversa deste departamento, pra saber quem é o próximo do ciclo
  );
  -- Regras de distribuição do CRM, configuráveis (ver tela "Distribuição" em pageCrm) — 1 linha por
  -- escritório, criada sob demanda (crmObterConfig devolve os defaults abaixo se a linha não existir
  -- ainda). Defaults preservam o comportamento de sempre: fila manual + visibilidade por departamento.
  CREATE TABLE IF NOT EXISTS crm_config (
    escritorio_id INTEGER PRIMARY KEY REFERENCES escritorios(id),
    modo_distribuicao TEXT NOT NULL DEFAULT 'manual', -- 'manual' (fila compartilhada, "atribuir a mim") | 'rodizio' (automático, round-robin por departamento)
    visibilidade TEXT NOT NULL DEFAULT 'departamento' -- 'tudo' | 'departamento' (só meus deptos + fila sem dono) | 'somente_meu' (só o que é meu, nem a fila)
  );
  -- Quem é responsável por cada departamento — espelha colaborador_empresas (mesma ideia, "quais
  -- registros esse colaborador pode ver/atender").
  CREATE TABLE IF NOT EXISTS crm_departamento_colaboradores (
    user_id INTEGER NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
    departamento_id INTEGER NOT NULL REFERENCES crm_departamentos(id) ON DELETE CASCADE,
    PRIMARY KEY (user_id, departamento_id)
  );
  CREATE TABLE IF NOT EXISTS crm_conversas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    escritorio_id INTEGER NOT NULL REFERENCES escritorios(id),
    telefone TEXT NOT NULL, -- normalizado (55+DDD+número, só dígitos) — mesma regra de whatsapp.ts
    contato_nome TEXT, -- profile.name que a Meta manda junto da mensagem (não é cadastro nosso)
    empresa_id INTEGER REFERENCES empresas(id), -- preenchido se achar por telefone, senão fica NULL
    departamento_id INTEGER REFERENCES crm_departamentos(id),
    atribuido_user_id INTEGER REFERENCES app_users(id),
    status TEXT NOT NULL DEFAULT 'menu', -- 'menu' (aguardando escolher depto) | 'aberta' | 'encerrada'
    ultima_mensagem_cliente_em TEXT, -- controla a janela de 24h da Meta pra saber se dá pra responder com texto livre
    ultima_mensagem_em TEXT,
    nao_lida INTEGER NOT NULL DEFAULT 1, -- fila compartilhada: qualquer um do departamento que abrir marca como lida pra todos
    criado_em TEXT DEFAULT (datetime('now')),
    UNIQUE(escritorio_id, telefone)
  );
  CREATE TABLE IF NOT EXISTS crm_mensagens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversa_id INTEGER NOT NULL REFERENCES crm_conversas(id) ON DELETE CASCADE,
    direcao TEXT NOT NULL, -- 'entrada' (cliente) | 'saida' (escritório/bot)
    wamid TEXT,
    tipo TEXT NOT NULL DEFAULT 'texto', -- 'texto' | 'imagem' | 'documento' | 'audio' | 'outro'
    texto TEXT,
    midia_path TEXT,
    midia_mime TEXT,
    midia_nome TEXT,
    autor_user_id INTEGER REFERENCES app_users(id), -- NULL quando é o próprio menu automático
    criado_em TEXT DEFAULT (datetime('now')),
    status TEXT -- só relevante pra direcao='saida': 'accepted'|'sent'|'delivered'|'read'|'failed'
  );
  CREATE TABLE IF NOT EXISTS crm_transferencias (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversa_id INTEGER NOT NULL REFERENCES crm_conversas(id) ON DELETE CASCADE,
    de_departamento_id INTEGER REFERENCES crm_departamentos(id),
    para_departamento_id INTEGER REFERENCES crm_departamentos(id),
    user_id INTEGER REFERENCES app_users(id),
    motivo TEXT,
    criado_em TEXT DEFAULT (datetime('now'))
  );

  -- ---- Rotina automática de emissão de NFS-e (honorários do próprio escritório) ----
  CREATE TABLE IF NOT EXISTS nfse_agendamento_config (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    ativo INTEGER NOT NULL DEFAULT 0,
    empresa_prestador_id INTEGER REFERENCES empresas(id),
    envio_template_id INTEGER REFERENCES envio_templates(id),
    dia_mes INTEGER NOT NULL DEFAULT 1,
    hora INTEGER NOT NULL DEFAULT 8,
    minuto INTEGER NOT NULL DEFAULT 0,
    ultima_execucao_competencia TEXT,
    updated_at TEXT DEFAULT (datetime('now'))
  );
  -- Empresas-cliente no "quadro 2" (membro da rotina) — os serviços/notas de cada uma ficam em
  -- nfse_agendamento_itens (1 empresa pode ter vários serviços = várias notas por competência).
  CREATE TABLE IF NOT EXISTS nfse_agendamento_empresas (
    empresa_id INTEGER PRIMARY KEY REFERENCES empresas(id) ON DELETE CASCADE,
    modelo_id INTEGER REFERENCES nfse_modelos(id),
    descricao_servico TEXT NOT NULL DEFAULT 'Honorários contábeis referente ao Mês {{mes_competencia}}',
    valor_servico REAL,
    ativo INTEGER NOT NULL DEFAULT 1,
    updated_at TEXT DEFAULT (datetime('now'))
  );
  -- Um item = um serviço = uma NFS-e emitida por competência. Uma empresa pode ter vários itens
  -- (ex.: "honorários contábeis" + "licença do módulo NFS-e" como duas notas separadas).
  CREATE TABLE IF NOT EXISTS nfse_agendamento_itens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    empresa_id INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
    modelo_id INTEGER REFERENCES nfse_modelos(id),
    descricao_servico TEXT NOT NULL DEFAULT 'Honorários contábeis referente ao Mês {{mes_competencia}}',
    valor_servico REAL,
    ativo INTEGER NOT NULL DEFAULT 1,
    updated_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS nfse_agendamento_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    empresa_id INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
    item_id INTEGER REFERENCES nfse_agendamento_itens(id),
    competencia TEXT NOT NULL,
    sucesso INTEGER NOT NULL,
    emissao_id INTEGER REFERENCES nfse_emissoes(id),
    mensagem TEXT,
    executado_em TEXT DEFAULT (datetime('now'))
  );

  -- Pedido de sincronização imediata de empresas (botão "Atualizar Empresas") — o agente local
  -- atende isso no ciclo rápido, sem esperar a sincronia automática de 60 em 60 minutos.
  CREATE TABLE IF NOT EXISTS dominio_sync_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    status TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'ok' | 'erro'
    novas INTEGER,
    atualizadas INTEGER,
    erro TEXT,
    criado_por INTEGER REFERENCES app_users(id),
    criado_em TEXT DEFAULT (datetime('now')),
    resolvido_em TEXT
  );

  -- ---- E-mail corporativo ----
  -- Documentos (CNPJ/CPF) usados para identificar automaticamente qual cliente é dono de um
  -- arquivo (PDF/OFX/XML) enviado — um cliente pode ter mais de um (ex.: CNPJ da empresa + CPF
  -- de um sócio que aparece em algum extrato).
  CREATE TABLE IF NOT EXISTS empresa_documentos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    empresa_id INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
    documento TEXT NOT NULL, -- só dígitos
    tipo TEXT NOT NULL, -- 'cnpj' | 'cpf'
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(documento)
  );

  -- Anexos do cadastro da empresa (abas Constituição/Licenças do modal de Editar Empresa) — arquivo
  -- de verdade (contrato social, cartão CNPJ, alvará, licenças) diferente de empresa_documentos
  -- acima, que só guarda CNPJ/CPF pra identificar remetente de e-mail. "categoria" separa a aba,
  -- "tipo" o rótulo específico dentro dela — livre o bastante pra crescer sem migração de schema.
  -- "vencimento" só se aplica a licenças (com data de validade) — lido automaticamente do PDF quando
  -- dá (ver extrairVencimentoDeAnexo), sempre corrigível na mão depois.
  CREATE TABLE IF NOT EXISTS empresa_anexos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    empresa_id INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
    categoria TEXT NOT NULL, -- 'constituicao' | 'licenca'
    tipo TEXT NOT NULL, -- ex.: 'contrato_social', 'cartao_cnpj', 'alvara', 'vigilancia_sanitaria', 'corpo_bombeiros', 'ambiental_semma'
    ano INTEGER, -- exercício/competência da licença (só categoria='licenca') — organiza o histórico por ano na aba Licenças
    nome_arquivo TEXT NOT NULL,
    arquivo_path TEXT NOT NULL,
    mime TEXT,
    size_bytes INTEGER,
    vencimento TEXT, -- ISO (AAAA-MM-DD), só quando categoria='licenca'
    vencimento_origem TEXT, -- 'automatico' | 'manual'
    criado_por INTEGER REFERENCES app_users(id),
    criado_em TEXT DEFAULT (datetime('now'))
  );
  -- Anos disponíveis na aba Licenças — compartilhado pelo escritório inteiro (o layout de
  -- ano/tipo é o mesmo pra toda empresa), não por empresa. Adicionar um ano novo (ex.: 2027) libera
  -- ele pra TODAS as empresas de uma vez, em vez de precisar repetir empresa por empresa.
  CREATE TABLE IF NOT EXISTS empresa_licenca_anos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    escritorio_id INTEGER NOT NULL REFERENCES escritorios(id),
    ano INTEGER NOT NULL,
    criado_em TEXT DEFAULT (datetime('now')),
    UNIQUE(escritorio_id, ano)
  );

  -- Tipos de licença adicionais, além dos 4 fixos (Alvará, Vigilância Sanitária, Corpo de Bombeiros,
  -- Ambiental-SEMMA). "chave" é o slug estável gravado em empresa_anexos.tipo; sempre com prefixo
  -- "lic_" pra nunca colidir com os tipos fixos. A categoria desses é sempre 'licenca'. empresa_id
  -- (ver migração abaixo) escopa o tipo a UMA empresa quando criado pela aba Licenças dela; NULL =
  -- compartilhado pelo escritório inteiro (usado pela carga em lote, que não parte de uma empresa).
  CREATE TABLE IF NOT EXISTS empresa_licenca_tipos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    escritorio_id INTEGER NOT NULL REFERENCES escritorios(id),
    chave TEXT NOT NULL,
    label TEXT NOT NULL,
    criado_em TEXT DEFAULT (datetime('now')),
    UNIQUE(escritorio_id, chave)
  );

  -- Chat ao vivo (balãozinho no canto da tela) — uma conversa por empresa-cliente, compartilhada
  -- entre todos os colaboradores/admin do escritório (caixa de entrada única, tipo suporte) de um
  -- lado, e todos os usuários da empresa-cliente do outro. "lido_pelo_escritorio"/"lido_pelo_cliente"
  -- marcam o lado que ainda não visualizou aquela mensagem — não é por usuário individual.
  CREATE TABLE IF NOT EXISTS chat_mensagens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    escritorio_id INTEGER NOT NULL REFERENCES escritorios(id),
    empresa_id INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
    autor_user_id INTEGER NOT NULL REFERENCES app_users(id),
    autor_nome TEXT NOT NULL, -- snapshot do nome de quem mandou, pra não sumir se o usuário for excluído depois
    autor_lado TEXT NOT NULL, -- 'escritorio' | 'cliente'
    texto TEXT NOT NULL,
    criado_em TEXT DEFAULT (datetime('now')),
    lido_pelo_escritorio INTEGER NOT NULL DEFAULT 0,
    lido_pelo_cliente INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_chat_mensagens_empresa ON chat_mensagens(empresa_id, id);

  -- "Está online" — heartbeat simples (ping a cada X segundos enquanto a aba tá aberta e logada).
  -- Considerado online quem deu ping nos últimos ~40s (ver CHAT_ONLINE_JANELA_SEGUNDOS).
  CREATE TABLE IF NOT EXISTS chat_presenca (
    user_id INTEGER PRIMARY KEY REFERENCES app_users(id) ON DELETE CASCADE,
    ultimo_ping TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Temporizadores do chat/aviso por WhatsApp, personalizáveis por escritório (ver getChatConfig) —
  -- sem linha aqui pra um escritório, valem os defaults (os mesmos valores fixos que o sistema
  -- sempre usou antes disso virar configurável).
  CREATE TABLE IF NOT EXISTS chat_config (
    escritorio_id INTEGER PRIMARY KEY REFERENCES escritorios(id),
    presenca_intervalo_segundos INTEGER NOT NULL DEFAULT 25,
    online_janela_segundos INTEGER NOT NULL DEFAULT 40,
    resumo_intervalo_segundos INTEGER NOT NULL DEFAULT 8,
    mensagens_intervalo_segundos INTEGER NOT NULL DEFAULT 4,
    aviso_whatsapp_atraso_segundos INTEGER NOT NULL DEFAULT 45,
    updated_at TEXT DEFAULT (datetime('now'))
  );

  -- Sala única de avisos internos por escritório — todo Administrador/Colaborador do mesmo
  -- escritório vê e escreve nela. Leitura é por usuário (cada um marca até onde já leu), diferente
  -- da conversa por empresa acima (que é uma caixa de entrada compartilhada só com 2 lados).
  CREATE TABLE IF NOT EXISTS chat_equipe_mensagens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    escritorio_id INTEGER NOT NULL REFERENCES escritorios(id),
    autor_user_id INTEGER NOT NULL REFERENCES app_users(id),
    autor_nome TEXT NOT NULL,
    texto TEXT NOT NULL,
    criado_em TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_chat_equipe_mensagens_escritorio ON chat_equipe_mensagens(escritorio_id, id);
  CREATE TABLE IF NOT EXISTS chat_equipe_leitura (
    escritorio_id INTEGER NOT NULL REFERENCES escritorios(id),
    user_id INTEGER NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
    ultima_msg_lida_id INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (escritorio_id, user_id)
  );

  -- Conversa individual (1 a 1) entre dois colaboradores/administradores do mesmo escritório.
  -- user_a_id/user_b_id sempre guardados com o menor id primeiro, pra ter um par único por dupla
  -- independente de quem escreveu primeiro.
  CREATE TABLE IF NOT EXISTS chat_dm_mensagens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    escritorio_id INTEGER NOT NULL REFERENCES escritorios(id),
    user_a_id INTEGER NOT NULL REFERENCES app_users(id),
    user_b_id INTEGER NOT NULL REFERENCES app_users(id),
    autor_user_id INTEGER NOT NULL REFERENCES app_users(id),
    autor_nome TEXT NOT NULL,
    texto TEXT NOT NULL,
    criado_em TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_chat_dm_mensagens_par ON chat_dm_mensagens(user_a_id, user_b_id, id);
  CREATE TABLE IF NOT EXISTS chat_dm_leitura (
    user_a_id INTEGER NOT NULL,
    user_b_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
    ultima_msg_lida_id INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_a_id, user_b_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS emails_enviados (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    empresa_id INTEGER REFERENCES empresas(id) ON DELETE SET NULL,
    destinatarios TEXT NOT NULL,
    assunto TEXT NOT NULL,
    corpo TEXT,
    anexos_json TEXT,
    enviado_por INTEGER REFERENCES app_users(id),
    enviado_em TEXT DEFAULT (datetime('now')),
    status TEXT NOT NULL DEFAULT 'ok',
    erro TEXT
  );

  CREATE TABLE IF NOT EXISTS kv (
    key_name TEXT PRIMARY KEY,
    value_data TEXT,
    updated_at TEXT DEFAULT (datetime('now'))
  );

  -- ---- NFS-e (emissão via Sistema Nacional NFS-e / ADN) ----
  -- Certificados digitais (.pfx) usados para assinar a DPS. empresa_id NULL = certificado do
  -- escritório (usado via procuração eletrônica para emitir em nome de clientes sem certificado
  -- próprio). O arquivo .pfx e a senha ficam criptografados em repouso (AES-256-GCM, ver nfse.ts) —
  -- nunca gravar o .pfx ou a senha em texto puro no banco ou no disco.
  CREATE TABLE IF NOT EXISTS nfse_certificados (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    empresa_id INTEGER REFERENCES empresas(id) ON DELETE CASCADE,
    arquivo_path TEXT NOT NULL, -- caminho do .pfx criptografado em disco (data/nfse-certificados/)
    senha_cifrada TEXT NOT NULL, -- senha do .pfx, criptografada (iv:authTag:ciphertext em hex)
    titular TEXT, -- Common Name extraído do certificado, só pra exibição/conferência
    cnpj_certificado TEXT, -- CNPJ extraído do certificado (quando identificável), só conferência
    validade_ate TEXT, -- data de expiração do certificado, extraída no upload
    criado_por INTEGER REFERENCES app_users(id),
    criado_em TEXT DEFAULT (datetime('now')),
    UNIQUE(empresa_id)
  );

  -- ---- Busca automática de NF-e/NFC-e (webservice nacional NFeDistribuicaoDFe da Sefaz) ----
  -- Certificado próprio de CADA empresa-cliente (diferente de nfse_certificados, que é do
  -- escritório/procuração — aqui o certificado tem que ser o da própria empresa dona das notas,
  -- a Sefaz só distribui pra quem é destinatário/emitente/interessado no documento).
  CREATE TABLE IF NOT EXISTS nfe_busca_config (
    empresa_id INTEGER PRIMARY KEY REFERENCES empresas(id) ON DELETE CASCADE,
    escritorio_id INTEGER NOT NULL REFERENCES escritorios(id),
    cnpj TEXT NOT NULL,
    uf_autor TEXT NOT NULL, -- sigla da UF (cUFAutor da consulta) — normalmente a UF do cadastro da empresa
    ambiente TEXT NOT NULL DEFAULT 'producao', -- 'producao' | 'homologacao'
    arquivo_path TEXT NOT NULL, -- .pfx criptografado em disco (data/nfse-certificados/, reaproveitado)
    senha_cifrada TEXT NOT NULL,
    titular TEXT,
    cnpj_certificado TEXT,
    validade_ate TEXT,
    ultimo_nsu TEXT NOT NULL DEFAULT '000000000000000', -- cursor da busca incremental de NF-e/NFC-e (distNSU, Sefaz)
    ativo INTEGER NOT NULL DEFAULT 1,
    ultima_busca_em TEXT,
    ultimo_erro TEXT,
    ultimo_nsu_nfse TEXT NOT NULL DEFAULT '0', -- cursor da busca incremental de NFS-e (Distribuição DF-e do ADN — sequência de NSU independente da de NF-e)
    ultima_busca_nfse_em TEXT,
    ultimo_erro_nfse TEXT,
    criado_por INTEGER REFERENCES app_users(id),
    criado_em TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );
  -- Documentos já recebidos (NF-e/NFC-e da Sefaz ou NFS-e do ADN — mesma tabela, diferenciados por
  -- "fonte", já que cada uma tem sua própria numeração de NSU).
  CREATE TABLE IF NOT EXISTS nfe_documentos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    empresa_id INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
    escritorio_id INTEGER NOT NULL REFERENCES escritorios(id),
    fonte TEXT NOT NULL DEFAULT 'nfe', -- 'nfe' (Sefaz) | 'nfse' (ADN, Sistema Nacional NFS-e)
    nsu TEXT NOT NULL,
    doc_schema TEXT NOT NULL, -- ex.: 'resNFe_v1.01.xsd', 'procNFe_v4.00.xsd', 'resEvento_v1.01.xsd', 'NFSe_v1.00'
    tipo TEXT NOT NULL, -- 'nfe' | 'nfce' | 'cte' | 'evento' | 'nfse' | 'outro'
    chave_acesso TEXT,
    emitente_cnpj TEXT,
    emitente_nome TEXT,
    destinatario_cnpj TEXT,
    destinatario_nome TEXT,
    valor_total REAL,
    data_emissao TEXT,
    xml TEXT NOT NULL, -- documento fiscal do próprio contribuinte, não é segredo — guardado em claro (mesmo padrão de nfse_emissoes.xml_nfse)
    pdf_path TEXT, -- cache em disco do PDF já gerado (DANFSe ou representação simplificada de NF-e/NFC-e), evita rerenderizar
    criado_em TEXT DEFAULT (datetime('now')),
    UNIQUE(empresa_id, fonte, nsu)
  );

  -- Exportação de XML pro OneDrive direto da nuvem (sem depender de nenhum agente local rodando —
  -- diferente da exportação por pasta local do dominio-agent). OAuth2 com a Microsoft (conta
  -- pessoal), client_secret e refresh_token cifrados em repouso (mesmo padrão AES-256-GCM já usado
  -- pra certificado/senha de NFS-e).
  CREATE TABLE IF NOT EXISTS onedrive_config (
    escritorio_id INTEGER PRIMARY KEY REFERENCES escritorios(id),
    client_id TEXT,
    client_secret_cifrado TEXT,
    refresh_token_cifrado TEXT,
    conta_nome TEXT,
    conta_email TEXT,
    pasta_destino TEXT NOT NULL DEFAULT 'Notas Fiscais - Clientes',
    ativo INTEGER NOT NULL DEFAULT 0,
    ultimo_id_exportado INTEGER NOT NULL DEFAULT 0,
    oauth_state_pendente TEXT,
    ultima_exportacao_em TEXT,
    ultimo_erro TEXT,
    updated_at TEXT DEFAULT (datetime('now'))
  );

  -- ---- Integra Contador (Receita Federal + SERPRO) — DAS, Declaração do Simples Nacional,
  -- Situação Fiscal, DCTFWeb. Diferente de nfe_busca_config: aqui é UM certificado só, o e-CNPJ do
  -- PRÓPRIO escritório (não da empresa-cliente) — o acesso a cada cliente vem da autorização que a
  -- empresa-cliente dá pro CNPJ do escritório no e-CAC dela, não de um certificado por empresa. É
  -- também um serviço PAGO (cobrança por uso na Loja SERPRO), diferente das buscas gratuitas de
  -- NF-e/NFS-e — por isso não usa o catálogo de módulos/Asaas, só um interruptor de ativo/inativo.
  CREATE TABLE IF NOT EXISTS integracontador_config (
    escritorio_id INTEGER PRIMARY KEY REFERENCES escritorios(id),
    cnpj TEXT, -- CNPJ do próprio escritório (contratante junto à Loja SERPRO)
    consumer_key TEXT,
    consumer_secret_cifrado TEXT,
    arquivo_certificado_path TEXT, -- .pfx do e-CNPJ do escritório, criptografado (reaproveita a infra de nfse.ts)
    senha_certificado_cifrada TEXT,
    titular_certificado TEXT,
    validade_certificado_ate TEXT,
    ativo INTEGER NOT NULL DEFAULT 0,
    ultimo_erro TEXT,
    updated_at TEXT DEFAULT (datetime('now'))
  );
  -- Habilitação por empresa-cliente — "optante_simples_nacional" restringe DAS/Declaração (SITFIS
  -- vale pra empresa de qualquer regime).
  CREATE TABLE IF NOT EXISTS integracontador_empresa_config (
    empresa_id INTEGER PRIMARY KEY REFERENCES empresas(id) ON DELETE CASCADE,
    escritorio_id INTEGER NOT NULL REFERENCES escritorios(id),
    ativo INTEGER NOT NULL DEFAULT 0,
    optante_simples_nacional INTEGER NOT NULL DEFAULT 0,
    busca_dctfweb INTEGER NOT NULL DEFAULT 0, -- independente de optante_simples_nacional — ver migração abaixo
    ultima_busca_em TEXT,
    ultimo_erro TEXT,
    alerta_declaracao TEXT, -- preenchido quando a declaração/DAS do mês anterior ainda não foi localizada (monitoramento de atraso, não é erro técnico)
    updated_at TEXT DEFAULT (datetime('now'))
  );
  -- Documentos obtidos (DAS, declaração consultada, relatório de situação fiscal, DARF da DCTFWeb).
  -- "detalhes_json" guarda o resto dos campos específicos de cada tipo — não vale a pena normalizar
  -- em colunas próprias pra formatos tão diferentes entre si.
  CREATE TABLE IF NOT EXISTS integracontador_documentos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    empresa_id INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
    escritorio_id INTEGER NOT NULL REFERENCES escritorios(id),
    tipo TEXT NOT NULL, -- 'das' | 'declaracao' | 'situacao_fiscal'
    periodo_apuracao TEXT, -- AAAAMM quando fizer sentido (DAS/declaração); NULL pra situação fiscal
    numero_documento TEXT,
    data_vencimento TEXT,
    detalhes_json TEXT,
    pdf_path TEXT, -- cache em disco do PDF já decodificado (evita rebaixar/redecodificar à toa — cada chamada é paga)
    criado_em TEXT DEFAULT (datetime('now'))
  );
  -- Retrato das mensagens NÃO LIDAS na Caixa Postal do e-CAC de cada empresa (comunicados da
  -- Receita Federal) — apagada e recriada inteira a cada busca automática (ver
  -- integraContadorBuscarEmpresaInterno em server.ts), não é um histórico acumulado: reflete sempre
  -- o estado atual de "não lida" segundo a própria Receita (uma vez lida no e-CAC de verdade, some
  -- daqui sozinha na próxima busca).
  CREATE TABLE IF NOT EXISTS integracontador_caixapostal_mensagens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    empresa_id INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
    numero_controle TEXT,
    assunto TEXT,
    data_envio TEXT,
    relevancia TEXT,
    atualizado_em TEXT DEFAULT (datetime('now'))
  );
  -- Parcelamento de DAS (PARCSN) vinculado por empresa — a adesão em si é feita pelo escritório no
  -- e-CAC (a API não permite simular nem aderir), aqui só guardamos o parcelamento JÁ CONCEDIDO que o
  -- escritório escolheu vincular, pra rotina automática buscar e anexar a guia de cada parcela todo
  -- mês. "ativo=0" quando o escritório encerra manualmente ou a situação lida da Receita indica
  -- quitado/rescindido/excluído — nesse caso a rotina automática para de tentar emitir parcela nova.
  CREATE TABLE IF NOT EXISTS integracontador_parcelamentos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    empresa_id INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
    escritorio_id INTEGER NOT NULL REFERENCES escritorios(id),
    numero_parcelamento INTEGER NOT NULL,
    atribuicao_id INTEGER REFERENCES envio_atribuicoes(id), -- onde a grade de parcelas (uma por mês) vive, reaproveitando Envio de Documentos
    situacao TEXT,
    data_do_pedido TEXT,
    valor_total_consolidado REAL,
    quantidade_parcelas INTEGER,
    valor_primeira_parcela REAL,
    valor_parcela_basica REAL,
    detalhes_json TEXT,
    ativo INTEGER NOT NULL DEFAULT 1,
    vinculado_por INTEGER REFERENCES app_users(id),
    vinculado_em TEXT DEFAULT (datetime('now')),
    ultima_busca_em TEXT,
    ultimo_erro TEXT,
    UNIQUE(empresa_id, numero_parcelamento)
  );

  -- Habilitação e dados fiscais do módulo NFS-e por empresa-cliente.
  CREATE TABLE IF NOT EXISTS nfse_empresa_config (
    empresa_id INTEGER PRIMARY KEY REFERENCES empresas(id) ON DELETE CASCADE,
    habilitado INTEGER NOT NULL DEFAULT 0,
    metodo_assinatura TEXT NOT NULL DEFAULT 'procuracao_escritorio', -- 'procuracao_escritorio' | 'certificado_proprio'
    codigo_municipio TEXT, -- código IBGE de 7 dígitos do município do prestador
    nome_municipio TEXT, -- só pra exibição (nome oficial IBGE do código acima), não vai na DPS
    inscricao_municipal TEXT,
    opcao_simples_nacional INTEGER NOT NULL DEFAULT 1, -- 1=Optante MEI/ME/EPP (regTrib/opSimpNac simplificado — ver nfse.ts)
    regime_especial_trib INTEGER NOT NULL DEFAULT 0, -- 0=Nenhum (regTrib/regEspTrib)
    regime_apuracao_sn TEXT NOT NULL DEFAULT '1', -- regApTribSN: '1' tributos federais+municipal pelo SN | '2' federais pelo SN e ISSQN fora | '3' ambos fora do SN — obrigatório pra optante ME/EPP (testado contra o ambiente real: E0166 sem isso)
    percentual_total_tributos_sn REAL, -- pTotTribSN — % aproximado do total de tributos (Lei 12.741/2012) pela alíquota efetiva do Simples Nacional; obrigatório pra optante ME/EPP, pois indTotTrib=0 é rejeitado nesse caso (E0712)
    updated_at TEXT DEFAULT (datetime('now'))
  );

  -- Modelos de serviço reutilizáveis (ex.: "Serviços Administrativos") — o admin configura uma vez
  -- os códigos/tributação e na emissão só escolhe o modelo + preenche descrição e valor.
  CREATE TABLE IF NOT EXISTS nfse_modelos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    empresa_id INTEGER REFERENCES empresas(id) ON DELETE CASCADE, -- NULL = modelo interno do escritório; com valor = modelo próprio de uma empresa-cliente self-service
    nome TEXT NOT NULL, -- ex.: "Serviços Administrativos"
    codigo_tributacao_nacional TEXT NOT NULL, -- cTribNac, 6 dígitos (ex.: "171001")
    codigo_tributacao_municipal TEXT, -- cTribMun, opcional — nem todo município usa
    codigo_nbs TEXT, -- cNBS, 9 dígitos — o portal oficial do governo trata como obrigatório na prática
    trib_issqn INTEGER NOT NULL DEFAULT 1, -- 1=Operação tributável 2=Imunidade 3=Exportação de serviço 4=Não incidência
    tipo_retencao_issqn INTEGER NOT NULL DEFAULT 1, -- 1=Não retido 2=Retido pelo tomador 3=Retido pelo intermediário
    aliquota_issqn REAL, -- % — opcional, alguns municípios calculam automaticamente
    tipo_retencao_pis_cofins INTEGER, -- 1=Retido 2=Não retido 3=PIS retido/COFINS não 4=PIS não/COFINS retido — NULL=não informar
    -- Tributação Municipal (ISSQN) — exigibilidade suspensa e benefício municipal
    issqn_exigibilidade_suspensa INTEGER NOT NULL DEFAULT 0,
    issqn_motivo_suspensao INTEGER, -- 1=Decisão Judicial 2=Processo Administrativo
    issqn_numero_processo TEXT,
    beneficio_municipal_codigo TEXT, -- nBM
    -- Tributação Federal (PIS/COFINS/IRRF/Contribuições) — percentuais aplicados sobre o valor do
    -- serviço em cada emissão pra calcular os valores retidos automaticamente
    pis_cofins_cst TEXT DEFAULT '00', -- Código de Situação Tributária do PIS/COFINS
    percentual_irrf REAL,
    percentual_csll REAL,
    percentual_cofins_retido REAL,
    percentual_pis_retido REAL,
    percentual_contrib_previdenciaria REAL,
    -- IBS/CBS (Reforma Tributária) — só obrigatório a partir de out/2026 (jan/2027 Simples Nacional)
    ibscbs_preencher INTEGER NOT NULL DEFAULT 0,
    ibscbs_cst TEXT DEFAULT '000', -- Código de Situação Tributária
    ibscbs_cclasstrib TEXT DEFAULT '000001', -- Código de Classificação Tributária
    -- Informações complementares (texto padrão do modelo — pode ser sobrescrito na emissão)
    doc_responsabilidade_tecnica TEXT,
    doc_referencia TEXT,
    informacoes_complementares TEXT,
    ativo INTEGER NOT NULL DEFAULT 1,
    created_by INTEGER REFERENCES app_users(id),
    created_at TEXT DEFAULT (datetime('now'))
  );

  -- Restringe, por empresa, quais modelos do catálogo do escritório ficam disponíveis na hora de
  -- emitir NFS-e pra ela. Empresa sem nenhuma linha aqui = sem restrição (vê todos os modelos do
  -- escritório, comportamento padrão de sempre). Só se aplica a modelos do escritório
  -- (empresa_id IS NULL) — modelos próprios de uma empresa-cliente (self-service) não passam por isso.
  CREATE TABLE IF NOT EXISTS nfse_empresa_modelos (
    empresa_id INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
    modelo_id INTEGER NOT NULL REFERENCES nfse_modelos(id) ON DELETE CASCADE,
    PRIMARY KEY (empresa_id, modelo_id)
  );

  -- Cada tentativa de emissão (DPS enviada) e o resultado — histórico completo, inclusive erros.
  CREATE TABLE IF NOT EXISTS nfse_emissoes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    empresa_id INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
    serie INTEGER NOT NULL DEFAULT 1,
    numero_dps INTEGER NOT NULL, -- rascunhos usam -id (negativo) como placeholder até serem emitidos de verdade
    ambiente TEXT NOT NULL DEFAULT 'producaorestrita', -- 'producaorestrita' | 'producao'
    modelo_id INTEGER REFERENCES nfse_modelos(id) ON DELETE SET NULL,
    modelo_nome TEXT, -- nome do modelo de serviço usado, só pra exibição (sobrevive mesmo se o modelo for excluído depois)
    tomador_documento TEXT NOT NULL,
    tomador_nome TEXT NOT NULL,
    tomador_email TEXT,
    tomador_telefone TEXT,
    tomador_cep TEXT,
    tomador_logradouro TEXT,
    tomador_numero TEXT,
    tomador_complemento TEXT,
    tomador_bairro TEXT,
    tomador_codigo_municipio TEXT,
    codigo_tributacao_nacional TEXT NOT NULL,
    descricao_servico TEXT NOT NULL,
    valor_servico REAL NOT NULL,
    competencia TEXT NOT NULL, -- 'YYYY-MM-DD'
    status TEXT NOT NULL DEFAULT 'pendente', -- 'rascunho' | 'pendente' | 'emitida' | 'rejeitada' | 'erro' | 'cancelada'
    chave_acesso TEXT,
    xml_dps TEXT,
    xml_nfse TEXT,
    numero_nfse TEXT, -- nNFSe (número da NFS-e no município, diferente do número da DPS) — usado no nome dos arquivos baixados
    erro TEXT,
    danfse_path TEXT, -- caminho do PDF do DANFSe em cache local (baixado sob demanda, uma vez só)
    motivo_cancelamento TEXT, -- código TSCodJustCanc: '1' Erro na Emissão | '2' Serviço não Prestado | '9' Outros
    justificativa_cancelamento TEXT,
    cancelado_em TEXT,
    criado_por INTEGER REFERENCES app_users(id),
    criado_em TEXT DEFAULT (datetime('now')),
    UNIQUE(empresa_id, serie, numero_dps)
  );
`);

sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_checklist_periodos_atrib ON checklist_periodos(atribuicao_id);`);
sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_checklist_uploads_periodo ON checklist_uploads(periodo_id, item_chave);`);
sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_envio_periodos_atrib ON envio_periodos(atribuicao_id);`);
sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_honorarios_lanc_competencia ON honorarios_lancamentos(competencia);`);
sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_dominio_dados_empresa ON dominio_dados(empresa_id, tipo, competencia);`);
sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_envio_documentos_periodo ON envio_documentos(periodo_id);`);
sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_dominio_rel_import_status ON dominio_relatorios_importados(escritorio_id, status);`);
sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_email_extratos_status ON email_extratos_importados(escritorio_id, status);`);

// Migração: bancos criados antes de 2026-08-18 têm envio_documentos com UNIQUE(periodo_id) e sem
// a coluna observacao — reconstrói a tabela preservando os documentos já enviados, sem essa trava
// (o fluxo de "guia recalculada" precisa de mais de um documento no mesmo período).
{
  const def = sqlite.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='envio_documentos'`).get() as any;
  if (def && /UNIQUE\s*\(\s*periodo_id\s*\)/i.test(def.sql)) {
    sqlite.exec(`
      CREATE TABLE envio_documentos_novo (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        periodo_id INTEGER NOT NULL REFERENCES envio_periodos(id) ON DELETE CASCADE,
        file_name TEXT NOT NULL,
        file_path TEXT NOT NULL,
        mime TEXT,
        size_bytes INTEGER,
        observacao TEXT,
        vencimento TEXT,
        vencimento_origem TEXT,
        enviado_por INTEGER REFERENCES app_users(id),
        enviado_em TEXT DEFAULT (datetime('now')),
        email_enviado INTEGER NOT NULL DEFAULT 0,
        email_erro TEXT
      );
      INSERT INTO envio_documentos_novo (id, periodo_id, file_name, file_path, mime, size_bytes, vencimento, vencimento_origem, enviado_por, enviado_em, email_enviado, email_erro)
      SELECT id, periodo_id, file_name, file_path, mime, size_bytes, vencimento, vencimento_origem, enviado_por, enviado_em, email_enviado, email_erro FROM envio_documentos;
      DROP TABLE envio_documentos;
      ALTER TABLE envio_documentos_novo RENAME TO envio_documentos;
      CREATE INDEX IF NOT EXISTS idx_envio_documentos_periodo ON envio_documentos(periodo_id);
    `);
    console.log("Migração aplicada: envio_documentos agora aceita mais de um documento por período.");
  }
}

// Migração leve: adiciona detectar_vencimento em bancos criados antes dessa coluna existir.
{
  const cols = sqlite.prepare(`PRAGMA table_info(envio_templates)`).all() as any[];
  if (!cols.some((c) => c.name === "detectar_vencimento")) {
    sqlite.exec(`ALTER TABLE envio_templates ADD COLUMN detectar_vencimento INTEGER NOT NULL DEFAULT 1`);
    // Modelos de relatório (sem data de vencimento) que já existiam ganham a detecção desligada
    // de cara — evita mostrar uma data sem sentido "identificada" num Balancete/DRE.
    sqlite
      .prepare(`UPDATE envio_templates SET detectar_vencimento = 0 WHERE LOWER(nome) IN ('dre', 'balancete', 'balanço', 'balanco')`)
      .run();
    console.log("Migração aplicada: envio_templates.detectar_vencimento (desligado para modelos de relatório já existentes).");
  }
}

// Migração leve: considera_mes_atual — pro card "envio_atraso" saber se cobra a competência do mês
// corrente ou só depois que o mês fecha. Modelos de fechamento contábil que já existiam (não têm
// como existir antes do mês acabar) ganham a flag desligada de cara, igual já acontece com
// detectar_vencimento acima.
{
  const cols = sqlite.prepare(`PRAGMA table_info(envio_templates)`).all() as any[];
  if (!cols.some((c) => c.name === "considera_mes_atual")) {
    sqlite.exec(`ALTER TABLE envio_templates ADD COLUMN considera_mes_atual INTEGER NOT NULL DEFAULT 1`);
    sqlite
      .prepare(`UPDATE envio_templates SET considera_mes_atual = 0 WHERE LOWER(nome) IN ('dre', 'balancete', 'balanço', 'balanco', 'razão contábil', 'razao contabil')`)
      .run();
    console.log("Migração aplicada: envio_templates.considera_mes_atual (desligado para DRE/Balancete/Razão Contábil já existentes).");
  }
  // Achado ao vivo: "DAS - Mensal" e "Consultar Situação Fiscal - RFB" (criados automaticamente
  // pelo Integra Contador, ver integraContadorObterOuCriarAtribuicaoModelo) nasceram com o default
  // da coluna (considera_mes_atual=1) antes desse parâmetro existir na função — mostrava a
  // competência do mês corrente como "em atraso" mesmo o mês ainda nem ter fechado (não existe DAS
  // nem Situação Fiscal do mês corrente, só depois que ele acaba). Idempotente — roda toda vez, só
  // corrige quem ainda estiver com o valor errado.
  sqlite
    .prepare(`UPDATE envio_templates SET considera_mes_atual = 0 WHERE nome IN ('DAS - Mensal', 'Consultar Situação Fiscal - RFB') AND considera_mes_atual = 1`)
    .run();
}

// Migração leve: integracontador_empresa_config.busca_dctfweb — habilita, por empresa, a busca do
// DARF gerado pela DCTFWeb (idServico GERARGUIA31), independente de optante_simples_nacional (ver
// comentário no CREATE TABLE acima). Desligado por padrão pra não sair gerando guia paga sem o
// escritório marcar explicitamente quais empresas precisam.
{
  const cols = sqlite.prepare(`PRAGMA table_info(integracontador_empresa_config)`).all() as any[];
  if (!cols.some((c) => c.name === "busca_dctfweb")) {
    sqlite.exec(`ALTER TABLE integracontador_empresa_config ADD COLUMN busca_dctfweb INTEGER NOT NULL DEFAULT 0`);
    console.log("Migração aplicada: integracontador_empresa_config.busca_dctfweb.");
  }
}

// Migração leve: email_extratos_importados.checklist_upload_id — a importação por e-mail passou a
// gravar em Solicitações de Documentos (checklist_uploads) em vez de Envio de Documentos
// (envio_documentos é o que o escritório manda PRO cliente; um extrato recebido por e-mail do
// cliente é o oposto). A coluna antiga envio_documento_id fica no schema (não usada mais por este
// fluxo, sem necessidade de dropar).
{
  const cols = sqlite.prepare(`PRAGMA table_info(email_extratos_importados)`).all() as any[];
  if (!cols.some((c) => c.name === "checklist_upload_id")) {
    sqlite.exec(`ALTER TABLE email_extratos_importados ADD COLUMN checklist_upload_id INTEGER REFERENCES checklist_uploads(id)`);
    console.log("Migração aplicada: email_extratos_importados.checklist_upload_id.");
  }
}

// Migração leve: anexo de arquivo nas 3 tabelas de mensagem do chat interno (equipe/dm/empresa) —
// até aqui só texto. Mensagem "só arquivo" grava texto='' (a coluna continua NOT NULL).
for (const tabela of ["chat_mensagens", "chat_equipe_mensagens", "chat_dm_mensagens"]) {
  const cols = sqlite.prepare(`PRAGMA table_info(${tabela})`).all() as any[];
  const nomes = new Set(cols.map((c) => c.name));
  if (!nomes.has("anexo_nome")) {
    sqlite.exec(`ALTER TABLE ${tabela} ADD COLUMN anexo_nome TEXT`);
    sqlite.exec(`ALTER TABLE ${tabela} ADD COLUMN anexo_path TEXT`);
    sqlite.exec(`ALTER TABLE ${tabela} ADD COLUMN anexo_mime TEXT`);
    sqlite.exec(`ALTER TABLE ${tabela} ADD COLUMN anexo_size INTEGER`);
    console.log(`Migração aplicada: ${tabela}.anexo_*.`);
  }
}

// Migração leve: telefone do usuário (colaborador/administrador) — usado pra avisar por WhatsApp
// quando chega uma DM no chat interno e o destinatário está offline (ver POST /api/chat/mensagens).
{
  const cols = sqlite.prepare(`PRAGMA table_info(app_users)`).all() as any[];
  if (!cols.some((c) => c.name === "telefone")) {
    sqlite.exec(`ALTER TABLE app_users ADD COLUMN telefone TEXT`);
    console.log("Migração aplicada: app_users.telefone.");
  }
}

// Migração leve: modelo de mensagem (Meta) só-texto, sem anexo — pro aviso de DM não lida do chat
// interno. Diferente de template_documento (exige componente "header" de documento), esse modelo
// precisa ser cadastrado à parte na Meta pelo usuário; vazio = aviso desligado, sem erro nenhum.
{
  const cols = sqlite.prepare(`PRAGMA table_info(whatsapp_config)`).all() as any[];
  if (!cols.some((c) => c.name === "template_texto_notificacao")) {
    sqlite.exec(`ALTER TABLE whatsapp_config ADD COLUMN template_texto_notificacao TEXT`);
    console.log("Migração aplicada: whatsapp_config.template_texto_notificacao.");
  }
}

// Migração leve: dominio_relatorios_importados.onedrive_modificado_em — achado ao vivo: o dedupe por
// onedrive_item_id sozinho nunca detectava quando o Domínio Web sobrescrevia o MESMO arquivo (mesmo
// item_id) com uma versão corrigida/mais nova — o sync via pra sempre pulando ele por já ter
// status='ok'. Guarda o lastModifiedDateTime visto na última importação pra comparar depois.
{
  const cols = sqlite.prepare(`PRAGMA table_info(dominio_relatorios_importados)`).all() as any[];
  if (!cols.some((c) => c.name === "onedrive_modificado_em")) {
    sqlite.exec(`ALTER TABLE dominio_relatorios_importados ADD COLUMN onedrive_modificado_em TEXT`);
    console.log("Migração aplicada: dominio_relatorios_importados.onedrive_modificado_em.");
  }
}

// Migração leve: onedrive_config ganha os campos da importação de relatórios (Balanço/DRE/Balancete)
// — pasta de ORIGEM separada da pasta de DESTINO já usada pela exportação de XML, mas reaproveitando
// a mesma conexão OAuth (client_id/client_secret/refresh_token) já salva nessa mesma linha.
{
  const cols = sqlite.prepare(`PRAGMA table_info(onedrive_config)`).all() as any[];
  const nomes = new Set(cols.map((c) => c.name));
  if (!nomes.has("relatorios_pasta_origem")) sqlite.exec(`ALTER TABLE onedrive_config ADD COLUMN relatorios_pasta_origem TEXT NOT NULL DEFAULT 'Relatorios_Dominio'`);
  if (!nomes.has("relatorios_ativo")) sqlite.exec(`ALTER TABLE onedrive_config ADD COLUMN relatorios_ativo INTEGER NOT NULL DEFAULT 0`);
  if (!nomes.has("relatorios_ultima_importacao_em")) sqlite.exec(`ALTER TABLE onedrive_config ADD COLUMN relatorios_ultima_importacao_em TEXT`);
  if (!nomes.has("relatorios_ultimo_erro")) sqlite.exec(`ALTER TABLE onedrive_config ADD COLUMN relatorios_ultimo_erro TEXT`);
}

// Migração leve: menu "Solicitar Documentos" do cliente — modelos ganham a opção de aparecer lá,
// e os períodos passam a registrar quem pediu e quando (quando nascem de um pedido do cliente).
{
  const colsTemplates = sqlite.prepare(`PRAGMA table_info(envio_templates)`).all() as any[];
  if (!colsTemplates.some((c) => c.name === "visivel_cliente")) {
    sqlite.exec(`ALTER TABLE envio_templates ADD COLUMN visivel_cliente INTEGER NOT NULL DEFAULT 0`);
    console.log("Migração aplicada: envio_templates.visivel_cliente.");
  }
  const colsPeriodos = sqlite.prepare(`PRAGMA table_info(envio_periodos)`).all() as any[];
  if (!colsPeriodos.some((c) => c.name === "solicitado_por")) {
    sqlite.exec(`ALTER TABLE envio_periodos ADD COLUMN solicitado_por INTEGER REFERENCES app_users(id)`);
    sqlite.exec(`ALTER TABLE envio_periodos ADD COLUMN solicitado_em TEXT`);
    console.log("Migração aplicada: envio_periodos.solicitado_por / solicitado_em.");
  }
  if (!colsPeriodos.some((c) => c.name === "solicitacao_tipo")) {
    sqlite.exec(`ALTER TABLE envio_periodos ADD COLUMN solicitacao_tipo TEXT`);
    // Backfill das solicitações já existentes: um período com algum documento com observação "DAS
    // recalculado..." só pode ter vindo do fluxo de recálculo; o resto (que já tinha solicitado_em
    // preenchido) era do fluxo normal "Solicitar Documentos", o único que existia antes desta coluna.
    sqlite.exec(`
      UPDATE envio_periodos SET solicitacao_tipo = 'recalculo_das'
      WHERE solicitado_em IS NOT NULL AND EXISTS (
        SELECT 1 FROM envio_documentos d WHERE d.periodo_id = envio_periodos.id AND d.observacao LIKE 'DAS recalculado%'
      )
    `);
    sqlite.exec(`UPDATE envio_periodos SET solicitacao_tipo = 'documento' WHERE solicitado_em IS NOT NULL AND solicitacao_tipo IS NULL`);
    console.log("Migração aplicada: envio_periodos.solicitacao_tipo (com backfill dos registros existentes).");
  }
}

// Migração leve: suspenso_desde — modelo que vai deixar de existir numa data conhecida (ex.: DARF
// PIS/COFINS extintos pela reforma tributária, substituídos pela CBS a partir de 01/2027). Guarda a
// 1ª competência (formato "AAAA-MM") em que o modelo já NÃO deve mais gerar pendência — competências
// anteriores a essa data continuam cobradas normalmente; a partir dela, cardEnvioAtraso para de
// flagar falta de envio. Não mexe em nada já gerado na grade, só no cálculo de pendência daqui pra
// frente (ver cardEnvioAtraso).
{
  const cols = sqlite.prepare(`PRAGMA table_info(envio_templates)`).all() as any[];
  if (!cols.some((c) => c.name === "suspenso_desde")) {
    sqlite.exec(`ALTER TABLE envio_templates ADD COLUMN suspenso_desde TEXT`);
    console.log("Migração aplicada: envio_templates.suspenso_desde.");
  }
}

// Migração leve: auto_regime_tributario — modelo que nasce sozinho pra empresa quando ela é
// classificada num regime tributário específico (ex.: DARF IRPJ/CSLL trimestral só se aplica a
// Lucro Real — marcar a empresa como Lucro Real já cria a atribuição, sem precisar lembrar de
// atribuir na mão). Ver envioAutoAtribuirPorRegime, chamado ao salvar o regime da empresa.
{
  const cols = sqlite.prepare(`PRAGMA table_info(envio_templates)`).all() as any[];
  if (!cols.some((c) => c.name === "auto_regime_tributario")) {
    sqlite.exec(`ALTER TABLE envio_templates ADD COLUMN auto_regime_tributario TEXT`);
    console.log("Migração aplicada: envio_templates.auto_regime_tributario.");
  }
}

// Migração leve: envio_periodos ganha (1) "sem_movimento" — marca que não houve imposto a recolher
// naquela competência, sem precisar anexar nenhum arquivo, só pra sumir a pendência do card — e (2)
// o parcelamento em quotas (ex.: IRPJ/CSLL Lucro Real trimestral pago em até 3 quotas mensais): ao
// postar a 1ª quota já marcando "3 quotas", o sistema cria sozinho os 2 períodos seguintes
// (parcela_periodo_id aponta pra 1ª quota, pra saber que são a mesma obrigação parcelada).
{
  const cols = sqlite.prepare(`PRAGMA table_info(envio_periodos)`).all() as any[];
  const nomes = new Set(cols.map((c) => c.name));
  for (const [coluna, ddl] of [
    ["sem_movimento", "sem_movimento INTEGER NOT NULL DEFAULT 0"],
    ["sem_movimento_observacao", "sem_movimento_observacao TEXT"],
    ["sem_movimento_por", "sem_movimento_por INTEGER REFERENCES app_users(id)"],
    ["sem_movimento_em", "sem_movimento_em TEXT"],
    ["parcela_numero", "parcela_numero INTEGER"],
    ["parcela_total", "parcela_total INTEGER"],
    ["parcela_periodo_id", "parcela_periodo_id INTEGER REFERENCES envio_periodos(id)"],
  ] as const) {
    if (!nomes.has(coluna)) {
      sqlite.exec(`ALTER TABLE envio_periodos ADD COLUMN ${ddl}`);
      console.log(`Migração aplicada: envio_periodos.${coluna}.`);
    }
  }
}

// Migração leve: escritorios.envio_rollover_ultimo_ano — trava da virada automática de ano da grade
// de Envio de Documentos (ver envioRolloverGerarAno). Escritório já existente é inicializado com o
// ano atual (não com NULL): sem isso, no 1º tick depois de instalada a migração, TODO escritório
// pareceria "atrasado" e a rotina rodaria fora de hora (ex.: em setembro), gerando a grade de 2026
// de novo pra quem já tinha. Só passa a valer de verdade quando o ano civil realmente virar.
{
  const cols = sqlite.prepare(`PRAGMA table_info(escritorios)`).all() as any[];
  if (!cols.some((c) => c.name === "envio_rollover_ultimo_ano")) {
    sqlite.exec(`ALTER TABLE escritorios ADD COLUMN envio_rollover_ultimo_ano INTEGER`);
    sqlite.prepare(`UPDATE escritorios SET envio_rollover_ultimo_ano = ? WHERE envio_rollover_ultimo_ano IS NULL`).run(agoraBrasilia().ano);
    console.log("Migração aplicada: escritorios.envio_rollover_ultimo_ano.");
  }
}

// Migração leve: cadastro de empresa ganhou os campos que o Domínio Web também tem
// (e-mail, telefone, endereço) — adiciona nos bancos criados antes dessas colunas existirem.
{
  const cols = sqlite.prepare(`PRAGMA table_info(empresas)`).all() as any[];
  const nomes = new Set(cols.map((c) => c.name));
  for (const [coluna, ddl] of [
    ["email", "email TEXT"],
    ["telefone", "telefone TEXT"],
    ["endereco", "endereco TEXT"],
    ["cidade", "cidade TEXT"],
    ["uf", "uf TEXT"],
    ["cep", "cep TEXT"],
    ["inscricao_municipal", "inscricao_municipal TEXT"],
    ["inscricao_estadual", "inscricao_estadual TEXT"],
    ["nome_representante_legal", "nome_representante_legal TEXT"],
    ["cpf_representante_legal", "cpf_representante_legal TEXT"],
    ["codigo_municipio_ibge", "codigo_municipio_ibge TEXT"], // código IBGE (7 dígitos) do município — usado na emissão de NFS-e (DPS exige a Tabela do IBGE), centralizado aqui pra não pedir de novo por módulo
    ["nome_municipio_ibge", "nome_municipio_ibge TEXT"], // só exibição do código acima
    ["regime_tributario", "regime_tributario TEXT NOT NULL DEFAULT 'simples_nacional'"], // 'simples_nacional' | 'lucro_presumido' | 'lucro_real' — mutuamente exclusivos; opcao_simples_nacional (nfse_empresa_config) é sempre derivado deste campo, nunca editado à parte
    ["apelido", "apelido TEXT"], // apelido curto do Domínio Web — usado no nome da pasta de exportação de XML ("código-apelido")
  ]) {
    if (!nomes.has(coluna)) sqlite.exec(`ALTER TABLE empresas ADD COLUMN ${ddl}`);
  }
}

// Migração leve: contato da empresa ganhou telefone/WhatsApp — até aqui só tinha e-mail.
{
  const cols = sqlite.prepare(`PRAGMA table_info(empresa_contatos)`).all() as any[];
  const nomes = new Set(cols.map((c) => c.name));
  if (!nomes.has("telefone")) sqlite.exec(`ALTER TABLE empresa_contatos ADD COLUMN telefone TEXT`);
  if (!nomes.has("receber_whatsapp")) sqlite.exec(`ALTER TABLE empresa_contatos ADD COLUMN receber_whatsapp INTEGER NOT NULL DEFAULT 0`);
}
// Migração leve: envio_documentos ganhou o mesmo controle de status que já tinha pra e-mail, agora
// pro WhatsApp também.
{
  const cols = sqlite.prepare(`PRAGMA table_info(envio_documentos)`).all() as any[];
  const nomes = new Set(cols.map((c) => c.name));
  if (!nomes.has("whatsapp_enviado")) sqlite.exec(`ALTER TABLE envio_documentos ADD COLUMN whatsapp_enviado INTEGER NOT NULL DEFAULT 0`);
  if (!nomes.has("whatsapp_erro")) sqlite.exec(`ALTER TABLE envio_documentos ADD COLUMN whatsapp_erro TEXT`);
  if (!nomes.has("email_enviado_em")) sqlite.exec(`ALTER TABLE envio_documentos ADD COLUMN email_enviado_em TEXT`);
  if (!nomes.has("whatsapp_enviado_em")) sqlite.exec(`ALTER TABLE envio_documentos ADD COLUMN whatsapp_enviado_em TEXT`);
  // chave_estavel: coluna de uma tentativa anterior de detectar retificação automaticamente
  // (revertida em 2026-09-22 — gerava falso positivo, ver comentário de envioJaTemDocumento). Não é
  // mais escrita nem lida por nada; mantida sem migração de remoção porque não atrapalha ninguém e
  // apagar coluna é mais risco do que vale.
  if (!nomes.has("chave_estavel")) sqlite.exec(`ALTER TABLE envio_documentos ADD COLUMN chave_estavel TEXT`);
}
// Migração leve: crm_departamentos ganha o ponteiro do rodízio (feature de distribuição
// configurável do CRM) — tabela já existia em produção sem essa coluna.
{
  const cols = sqlite.prepare(`PRAGMA table_info(crm_departamentos)`).all() as any[];
  if (!cols.some((c) => c.name === "rodizio_ultimo_user_id")) {
    sqlite.exec(`ALTER TABLE crm_departamentos ADD COLUMN rodizio_ultimo_user_id INTEGER REFERENCES app_users(id)`);
  }
}
// Migração leve: app_users ganha o id espelhado no Supabase Auth do deskcomm (ponte de login
// único — ver deskcommObterOuCriarUsuarioEspelhado) — evita relookup por e-mail a cada acesso.
{
  const cols = sqlite.prepare(`PRAGMA table_info(app_users)`).all() as any[];
  if (!cols.some((c) => c.name === "deskcomm_user_id")) {
    sqlite.exec(`ALTER TABLE app_users ADD COLUMN deskcomm_user_id TEXT`);
  }
}
// Migração leve: mesmo controle de status do WhatsApp, agora direto na NFS-e emitida (não precisa
// passar por Envio de Documentos pra mandar a nota pro cliente).
{
  const cols = sqlite.prepare(`PRAGMA table_info(nfse_emissoes)`).all() as any[];
  const nomes = new Set(cols.map((c) => c.name));
  if (!nomes.has("whatsapp_enviado")) sqlite.exec(`ALTER TABLE nfse_emissoes ADD COLUMN whatsapp_enviado INTEGER NOT NULL DEFAULT 0`);
  if (!nomes.has("whatsapp_erro")) sqlite.exec(`ALTER TABLE nfse_emissoes ADD COLUMN whatsapp_erro TEXT`);
  // Achado ao vivo: "Enviar WhatsApp" mandava pros contatos da empresa PRESTADORA (o próprio
  // escritório), nunca pro tomador — não existia telefone do tomador nenhum pra usar. O e-mail já
  // tinha esse campo (tomador_email); o telefone só não tinha sido adicionado junto.
  if (!nomes.has("tomador_telefone")) sqlite.exec(`ALTER TABLE nfse_emissoes ADD COLUMN tomador_telefone TEXT`);
}
// Migração leve: alerta de declaração/DAS do mês anterior não localizada (monitoramento de atraso
// por empresa optante do Simples).
{
  const cols = sqlite.prepare(`PRAGMA table_info(integracontador_empresa_config)`).all() as any[];
  const nomes = new Set(cols.map((c) => c.name));
  if (!nomes.has("alerta_declaracao")) sqlite.exec(`ALTER TABLE integracontador_empresa_config ADD COLUMN alerta_declaracao TEXT`);
}
// Migração leve: webhook do WhatsApp (status real de entrega, em vez de só saber se a Meta aceitou
// o envio).
{
  const cols = sqlite.prepare(`PRAGMA table_info(whatsapp_config)`).all() as any[];
  const nomes = new Set(cols.map((c) => c.name));
  if (!nomes.has("webhook_verify_token")) sqlite.exec(`ALTER TABLE whatsapp_config ADD COLUMN webhook_verify_token TEXT`);
  if (!nomes.has("app_secret_cifrado")) sqlite.exec(`ALTER TABLE whatsapp_config ADD COLUMN app_secret_cifrado TEXT`);
}
// Migração leve: nfe_busca_config ganhou um cursor de NSU próprio pra busca de NFS-e (Distribuição
// DF-e do ADN) — sequência independente da de NF-e/NFC-e, que já usava a coluna ultimo_nsu.
{
  const cols = sqlite.prepare(`PRAGMA table_info(nfe_busca_config)`).all() as any[];
  const nomes = new Set(cols.map((c) => c.name));
  if (!nomes.has("ultimo_nsu_nfse")) sqlite.exec(`ALTER TABLE nfe_busca_config ADD COLUMN ultimo_nsu_nfse TEXT NOT NULL DEFAULT '0'`);
  if (!nomes.has("ultima_busca_nfse_em")) sqlite.exec(`ALTER TABLE nfe_busca_config ADD COLUMN ultima_busca_nfse_em TEXT`);
  if (!nomes.has("ultimo_erro_nfse")) sqlite.exec(`ALTER TABLE nfe_busca_config ADD COLUMN ultimo_erro_nfse TEXT`);
}
// Migração: nfe_documentos ganhou a coluna "fonte" (nfe | nfse) — cada uma tem sua própria
// numeração de NSU, então precisa entrar na chave de unicidade junto com o NSU (antes só
// UNIQUE(empresa_id, nsu), que colidiria se um NF-e e uma NFS-e da mesma empresa caíssem no mesmo
// número de NSU, já que são contadores diferentes). SQLite não permite alterar UNIQUE via ALTER
// TABLE — reconstrução completa, com todo dado existente migrado como fonte='nfe' (única fonte que
// existia até aqui).
{
  const cols = sqlite.prepare(`PRAGMA table_info(nfe_documentos)`).all() as any[];
  if (cols.length && !cols.some((c) => c.name === "fonte")) {
    sqlite.exec(`
      CREATE TABLE nfe_documentos_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        empresa_id INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
        escritorio_id INTEGER NOT NULL REFERENCES escritorios(id),
        fonte TEXT NOT NULL DEFAULT 'nfe',
        nsu TEXT NOT NULL,
        doc_schema TEXT NOT NULL,
        tipo TEXT NOT NULL,
        chave_acesso TEXT,
        emitente_cnpj TEXT,
        emitente_nome TEXT,
        destinatario_cnpj TEXT,
        destinatario_nome TEXT,
        valor_total REAL,
        data_emissao TEXT,
        xml TEXT NOT NULL,
        criado_em TEXT DEFAULT (datetime('now')),
        UNIQUE(empresa_id, fonte, nsu)
      )
    `);
    sqlite.exec(`
      INSERT INTO nfe_documentos_new (id, empresa_id, escritorio_id, fonte, nsu, doc_schema, tipo, chave_acesso, emitente_cnpj, emitente_nome, destinatario_cnpj, destinatario_nome, valor_total, data_emissao, xml, criado_em)
      SELECT id, empresa_id, escritorio_id, 'nfe', nsu, doc_schema, tipo, chave_acesso, emitente_cnpj, emitente_nome, destinatario_cnpj, destinatario_nome, valor_total, data_emissao, xml, criado_em FROM nfe_documentos
    `);
    sqlite.exec(`DROP TABLE nfe_documentos`);
    sqlite.exec(`ALTER TABLE nfe_documentos_new RENAME TO nfe_documentos`);
    console.log("Migração aplicada: nfe_documentos ganhou a coluna 'fonte' (NF-e vs NFS-e).");
  }
}
// Migração leve: cache do PDF simplificado/DANFSe gerado pra cada documento buscado (evita
// renderizar de novo no Chromium toda vez que baixarem o mesmo documento outra vez).
{
  const cols = sqlite.prepare(`PRAGMA table_info(nfe_documentos)`).all() as any[];
  if (!cols.some((c) => c.name === "pdf_path")) sqlite.exec(`ALTER TABLE nfe_documentos ADD COLUMN pdf_path TEXT`);
}
// Migração leve: descrição do evento (xEvento) — só preenchida pra tipo='evento'. Usada pra filtrar
// a listagem (a Distribuição DFe devolve MUITO evento de logística de transporte sem relevância
// contábil nenhuma — "Registro de Passagem", "MDF-e Autorizado" etc. — só cancelamento importa) e
// pra marcar a NF-e/NFC-e original como cancelada quando o evento de cancelamento dela aparecer.
{
  const cols = sqlite.prepare(`PRAGMA table_info(nfe_documentos)`).all() as any[];
  if (!cols.some((c) => c.name === "evento_descricao")) sqlite.exec(`ALTER TABLE nfe_documentos ADD COLUMN evento_descricao TEXT`);
}

// Migração leve: NFS-e ganhou o nome do município (só exibição) ao lado do código IBGE.
{
  const cols = sqlite.prepare(`PRAGMA table_info(nfse_empresa_config)`).all() as any[];
  if (!cols.some((c) => c.name === "nome_municipio")) {
    sqlite.exec(`ALTER TABLE nfse_empresa_config ADD COLUMN nome_municipio TEXT`);
  }
}
// Migração leve: regApTribSN (regime de apuração dos tributos do Simples Nacional) é obrigatório
// pra optante ME/EPP — descoberto com E0166 num teste real, não estava no leiaute original.
{
  const cols = sqlite.prepare(`PRAGMA table_info(nfse_empresa_config)`).all() as any[];
  if (!cols.some((c) => c.name === "regime_apuracao_sn")) {
    sqlite.exec(`ALTER TABLE nfse_empresa_config ADD COLUMN regime_apuracao_sn TEXT NOT NULL DEFAULT '1'`);
  }
}
// Migração leve: pTotTribSN (% aproximado do total de tributos pela alíquota do Simples Nacional)
// é obrigatório pra optante ME/EPP — descoberto com E0712 num teste real (indTotTrib=0, que era o
// que sempre mandávamos, é rejeitado pra ME/EPP).
{
  const cols = sqlite.prepare(`PRAGMA table_info(nfse_empresa_config)`).all() as any[];
  if (!cols.some((c) => c.name === "percentual_total_tributos_sn")) {
    sqlite.exec(`ALTER TABLE nfse_empresa_config ADD COLUMN percentual_total_tributos_sn REAL`);
  }
}
// Migração leve: NFS-e self-service pra empresa-cliente (perfil Cliente) — cada empresa precisa
// dos próprios modelos de serviço, não mais só o conjunto único do escritório.
{
  const cols = sqlite.prepare(`PRAGMA table_info(nfse_modelos)`).all() as any[];
  if (!cols.some((c) => c.name === "empresa_id")) {
    sqlite.exec(`ALTER TABLE nfse_modelos ADD COLUMN empresa_id INTEGER REFERENCES empresas(id) ON DELETE CASCADE`);
  }
}
// Migração leve: NFS-e ganhou os modelos de serviço reutilizáveis — a emissão passa a guardar
// qual modelo foi usado, só pra exibição no histórico.
{
  const cols = sqlite.prepare(`PRAGMA table_info(nfse_emissoes)`).all() as any[];
  if (!cols.some((c) => c.name === "modelo_nome")) {
    sqlite.exec(`ALTER TABLE nfse_emissoes ADD COLUMN modelo_nome TEXT`);
  }
}
// Migração leve: modelo de serviço ganhou o código NBS (conferido em XML real — o portal do
// governo trata como obrigatório na prática, mesmo o leiaute oficial marcando como opcional).
{
  const cols = sqlite.prepare(`PRAGMA table_info(nfse_modelos)`).all() as any[];
  if (!cols.some((c) => c.name === "codigo_nbs")) {
    sqlite.exec(`ALTER TABLE nfse_modelos ADD COLUMN codigo_nbs TEXT`);
  }
}
// Migração leve: modelo de serviço ganhou todos os campos de tributação avançada (exigibilidade
// suspensa/benefício municipal do ISSQN, retenções federais com percentual, IBS/CBS, informações
// complementares) — cobrindo os mesmos campos do formulário oficial do governo.
{
  const cols = sqlite.prepare(`PRAGMA table_info(nfse_modelos)`).all() as any[];
  const nomes = new Set(cols.map((c) => c.name));
  for (const [coluna, ddl] of [
    ["issqn_exigibilidade_suspensa", "issqn_exigibilidade_suspensa INTEGER NOT NULL DEFAULT 0"],
    ["issqn_motivo_suspensao", "issqn_motivo_suspensao INTEGER"],
    ["issqn_numero_processo", "issqn_numero_processo TEXT"],
    ["beneficio_municipal_codigo", "beneficio_municipal_codigo TEXT"],
    ["pis_cofins_cst", "pis_cofins_cst TEXT DEFAULT '00'"],
    ["percentual_irrf", "percentual_irrf REAL"],
    ["percentual_csll", "percentual_csll REAL"],
    ["percentual_cofins_retido", "percentual_cofins_retido REAL"],
    ["percentual_pis_retido", "percentual_pis_retido REAL"],
    ["percentual_contrib_previdenciaria", "percentual_contrib_previdenciaria REAL"],
    ["ibscbs_preencher", "ibscbs_preencher INTEGER NOT NULL DEFAULT 0"],
    ["ibscbs_cst", "ibscbs_cst TEXT DEFAULT '000'"],
    ["ibscbs_cclasstrib", "ibscbs_cclasstrib TEXT DEFAULT '000001'"],
    ["doc_responsabilidade_tecnica", "doc_responsabilidade_tecnica TEXT"],
    ["doc_referencia", "doc_referencia TEXT"],
    ["informacoes_complementares", "informacoes_complementares TEXT"],
  ]) {
    if (!nomes.has(coluna)) sqlite.exec(`ALTER TABLE nfse_modelos ADD COLUMN ${ddl}`);
  }
}
// Migração leve: emissão de NFS-e ganhou rascunhos (salvar sem transmitir) e duplicar — precisa
// guardar o endereço completo do tomador e o id do modelo usado pra poder pré-preencher de novo.
{
  const cols = sqlite.prepare(`PRAGMA table_info(nfse_emissoes)`).all() as any[];
  const nomes = new Set(cols.map((c) => c.name));
  for (const [coluna, ddl] of [
    ["modelo_id", "modelo_id INTEGER REFERENCES nfse_modelos(id) ON DELETE SET NULL"],
    ["tomador_cep", "tomador_cep TEXT"],
    ["tomador_logradouro", "tomador_logradouro TEXT"],
    ["tomador_numero", "tomador_numero TEXT"],
    ["tomador_complemento", "tomador_complemento TEXT"],
    ["tomador_bairro", "tomador_bairro TEXT"],
    ["tomador_codigo_municipio", "tomador_codigo_municipio TEXT"],
    ["danfse_path", "danfse_path TEXT"],
    ["motivo_cancelamento", "motivo_cancelamento TEXT"],
    ["justificativa_cancelamento", "justificativa_cancelamento TEXT"],
    ["cancelado_em", "cancelado_em TEXT"],
    ["numero_nfse", "numero_nfse TEXT"],
  ]) {
    if (!nomes.has(coluna)) sqlite.exec(`ALTER TABLE nfse_emissoes ADD COLUMN ${ddl}`);
  }
  // Backfill único: emissões já feitas antes do numero_nfse existir já têm o XML salvo — só extrair.
  const semNumero = sqlite.prepare(`SELECT id, xml_nfse FROM nfse_emissoes WHERE status='emitida' AND numero_nfse IS NULL AND xml_nfse IS NOT NULL`).all() as any[];
  for (const r of semNumero) {
    const m = String(r.xml_nfse).match(/<nNFSe>([^<]+)<\/nNFSe>/);
    if (m) sqlite.prepare(`UPDATE nfse_emissoes SET numero_nfse = ? WHERE id = ?`).run(m[1], r.id);
  }
}
// Migração leve: as tabelas antigas de "licença única por empresa" (nfse_licenca/
// nfse_licenca_cobrancas) foram substituídas pelo catálogo de módulos abaixo — nunca tiveram uso
// real (só dados de teste, já limpos), então é seguro descartar sem migrar dado nenhum.
sqlite.exec(`DROP TABLE IF EXISTS nfse_licenca_cobrancas`);
sqlite.exec(`DROP TABLE IF EXISTS nfse_licenca`);
// Migração leve: cobrança da licença via Asaas reaproveita um customerId por empresa entre módulos.
{
  const cols = sqlite.prepare(`PRAGMA table_info(empresas)`).all() as any[];
  if (!cols.some((c) => c.name === "asaas_customer_id")) {
    sqlite.exec(`ALTER TABLE empresas ADD COLUMN asaas_customer_id TEXT`);
  }
}
// Seed do catálogo de módulos vendáveis — preço 0 até eu configurar em Configurações > Módulos.
sqlite.exec(`INSERT OR IGNORE INTO modulos_catalogo (chave, nome, valor_mensal) VALUES ('nfse', 'NFS-e', 0)`);
sqlite.exec(`INSERT OR IGNORE INTO modulos_catalogo (chave, nome, valor_mensal) VALUES ('financeiro', 'Financeiro', 0)`);
// Migração leve: cobrança da licença de escritório via Asaas reaproveita um customerId entre módulos.
{
  const cols = sqlite.prepare(`PRAGMA table_info(escritorios)`).all() as any[];
  if (!cols.some((c) => c.name === "asaas_customer_id")) {
    sqlite.exec(`ALTER TABLE escritorios ADD COLUMN asaas_customer_id TEXT`);
  }
}
// Seed do catálogo de módulos vendáveis pro escritório-cliente da plataforma (não confundir com o
// catálogo acima, que é vendido pelo escritório PRA empresa-cliente dele). Preço 0 até o SuperAdmin
// configurar em Escritórios > Módulos da plataforma.
sqlite.exec(`INSERT OR IGNORE INTO modulos_escritorio_catalogo (chave, nome, valor_mensal) VALUES ('nfse_automatico', 'Emissão automática de NFS-e', 0)`);
sqlite.exec(`INSERT OR IGNORE INTO modulos_escritorio_catalogo (chave, nome, valor_mensal) VALUES ('envio_email_automatico', 'Envio automático por e-mail', 0)`);
sqlite.exec(`INSERT OR IGNORE INTO modulos_escritorio_catalogo (chave, nome, valor_mensal) VALUES ('envio_whatsapp', 'Envio automático por WhatsApp', 0)`);
sqlite.exec(`INSERT OR IGNORE INTO modulos_escritorio_catalogo (chave, nome, valor_mensal) VALUES ('busca_xml_nfe', 'Busca automática de XML (NF-e/NFC-e/NFS-e)', 0)`);
// Valor "por assento" — diferente dos outros módulos (fixo, contratado ou não), o valor final desse
// item na fatura é o preço unitário aqui multiplicado pela quantidade de colaboradores ativos e não
// isentos (ver contarAssentosColaborador). Preço 0 até o SuperAdmin configurar em Escritórios >
// Módulos da plataforma — mesma tela que já edita os outros módulos desse catálogo.
sqlite.exec(`INSERT OR IGNORE INTO modulos_escritorio_catalogo (chave, nome, valor_mensal) VALUES ('assento_colaborador', 'Assento por colaborador (cobrado por usuário)', 0)`);
sqlite.exec(`UPDATE modulos_escritorio_catalogo SET nome = 'Busca automática de XML (NF-e/NFC-e/NFS-e)' WHERE chave = 'busca_xml_nfe' AND nome = 'Busca automática de NF-e/NFC-e'`);
// Migração de compatibilidade: empresas que JÁ usam NFS-e ou Financeiro de verdade (antes de existir
// o controle de teste/assinatura) ganham acesso permanente automático — nunca bloqueia quem já era
// cliente real antes desta mudança. Só roda quando a tabela está zerada (1ª vez que essa feature
// sobe): sem essa trava, ela rodava em TODO restart do processo, recriando acesso permanente até
// pra empresa que o admin removeu manualmente do teste/assinatura de propósito.
if ((sqlite.prepare(`SELECT COUNT(*) as c FROM empresa_modulos`).get() as any).c === 0) {
  const jaUsaNfse = sqlite
    .prepare(
      `SELECT DISTINCT empresa_id FROM nfse_empresa_config WHERE habilitado = 1
       UNION SELECT DISTINCT empresa_id FROM nfse_emissoes`
    )
    .all() as any[];
  for (const r of jaUsaNfse) {
    sqlite
      .prepare(
        `INSERT OR IGNORE INTO empresa_modulos (empresa_id, modulo_chave, trial_inicio, trial_fim, assinatura_ativa_ate)
         VALUES (?, 'nfse', datetime('now'), datetime('now'), datetime('now','+100 years'))`
      )
      .run(r.empresa_id);
  }
  const jaUsaFinanceiro = sqlite
    .prepare(
      `SELECT DISTINCT empresa_id FROM financeiro_pagar
       UNION SELECT DISTINCT empresa_id FROM financeiro_receber`
    )
    .all() as any[];
  for (const r of jaUsaFinanceiro) {
    sqlite
      .prepare(
        `INSERT OR IGNORE INTO empresa_modulos (empresa_id, modulo_chave, trial_inicio, trial_fim, assinatura_ativa_ate)
         VALUES (?, 'financeiro', datetime('now'), datetime('now'), datetime('now','+100 years'))`
      )
      .run(r.empresa_id);
  }
}
// Migração leve: conta bancária/caixa opcional em cada título do Financeiro, pra indicar onde o
// pagamento/recebimento caiu.
{
  const colsPagar = sqlite.prepare(`PRAGMA table_info(financeiro_pagar)`).all() as any[];
  if (!colsPagar.some((c) => c.name === "conta_id")) {
    sqlite.exec(`ALTER TABLE financeiro_pagar ADD COLUMN conta_id INTEGER REFERENCES financeiro_contas(id) ON DELETE SET NULL`);
  }
  const colsReceber = sqlite.prepare(`PRAGMA table_info(financeiro_receber)`).all() as any[];
  if (!colsReceber.some((c) => c.name === "conta_id")) {
    sqlite.exec(`ALTER TABLE financeiro_receber ADD COLUMN conta_id INTEGER REFERENCES financeiro_contas(id) ON DELETE SET NULL`);
  }
}
// Migração leve: empresa_anexos.ano (organiza a aba Licenças por exercício/competência).
{
  const colsAnexos = sqlite.prepare(`PRAGMA table_info(empresa_anexos)`).all() as any[];
  if (!colsAnexos.some((c) => c.name === "ano")) {
    sqlite.exec(`ALTER TABLE empresa_anexos ADD COLUMN ano INTEGER`);
  }
}
// Migração leve: isenção de cobrança por assento (app_users) e quantidade no item de fatura do
// escritório (escritorio_licenca_cobranca_itens).
{
  const colsUsers = sqlite.prepare(`PRAGMA table_info(app_users)`).all() as any[];
  if (!colsUsers.some((c) => c.name === "isento_assinatura")) {
    sqlite.exec(`ALTER TABLE app_users ADD COLUMN isento_assinatura INTEGER NOT NULL DEFAULT 0`);
  }
  // Conta dedicada pro "Painel de TV" (Início em tela cheia, ciclando os cards do dashboard, pensado
  // pra ficar ligado o dia todo numa TV do escritório) — login normal, mas ao entrar pula direto pro
  // painel, sem menu nenhum. Sessão de vida bem mais longa (ver createSession) já que fica logado por
  // meses sem ninguém digitar senha de novo.
  if (!colsUsers.some((c) => c.name === "painel_tv")) {
    sqlite.exec(`ALTER TABLE app_users ADD COLUMN painel_tv INTEGER NOT NULL DEFAULT 0`);
  }
  const colsItens = sqlite.prepare(`PRAGMA table_info(escritorio_licenca_cobranca_itens)`).all() as any[];
  if (!colsItens.some((c) => c.name === "quantidade")) {
    sqlite.exec(`ALTER TABLE escritorio_licenca_cobranca_itens ADD COLUMN quantidade INTEGER NOT NULL DEFAULT 1`);
  }
}
// Migração leve: conta cortesia — empresa-cliente isenta de cobrança de NFS-e/Financeiro (acesso
// liberado sem precisar de teste grátis nem assinatura paga via Asaas).
{
  const colsEmpresas = sqlite.prepare(`PRAGMA table_info(empresas)`).all() as any[];
  if (!colsEmpresas.some((c) => c.name === "isento_assinatura")) {
    sqlite.exec(`ALTER TABLE empresas ADD COLUMN isento_assinatura INTEGER NOT NULL DEFAULT 0`);
  }
}
// Migração leve: opt-in por empresa pra busca automática da Guia FGTS Digital (nem toda empresa tem
// FGTS, ex. MEI sem funcionário) + rastro da última busca em lote (ver fgts-automacao.ts).
{
  const colsEmpresas = sqlite.prepare(`PRAGMA table_info(empresas)`).all() as any[];
  if (!colsEmpresas.some((c) => c.name === "busca_fgts")) {
    sqlite.exec(`ALTER TABLE empresas ADD COLUMN busca_fgts INTEGER NOT NULL DEFAULT 0`);
  }
  if (!colsEmpresas.some((c) => c.name === "fgts_ultima_busca_em")) {
    sqlite.exec(`ALTER TABLE empresas ADD COLUMN fgts_ultima_busca_em TEXT`);
  }
  if (!colsEmpresas.some((c) => c.name === "fgts_ultimo_erro")) {
    sqlite.exec(`ALTER TABLE empresas ADD COLUMN fgts_ultimo_erro TEXT`);
  }
}
// Limpeza: fgts_sync_jobs foi criada numa primeira versão que salvava a sessão do FGTS Digital no
// servidor pra reaproveitar depois — testando ao vivo, confirmamos que essa sessão não sobrevive
// fora do navegador que fez o login (o próprio site trata como "Erro de Login"), então a busca
// passou a rodar inteira em fgts-login-setup.ts (local) e essa tabela ficou sem uso.
sqlite.exec(`DROP TABLE IF EXISTS fgts_sync_jobs`);
// Migração leve: cards do Painel podem virar "computados" (tipo preenchido) em vez de só texto
// digitado à mão — o valor passa a ser calculado na hora em GET /api/dashboard/cards.
{
  const colsCards = sqlite.prepare(`PRAGMA table_info(dashboard_cards)`).all() as any[];
  if (!colsCards.some((c) => c.name === "tipo")) {
    sqlite.exec(`ALTER TABLE dashboard_cards ADD COLUMN tipo TEXT`);
  }
  // "parametro" guarda um valor extra que alguns tipos de card computado precisam além do tipo em
  // si — hoje só o "envio_atraso" usa (o id do envio_templates que esse card específico valida),
  // mas fica genérico o bastante pra outro tipo futuro reaproveitar sem nova migração.
  if (!colsCards.some((c) => c.name === "parametro")) {
    sqlite.exec(`ALTER TABLE dashboard_cards ADD COLUMN parametro TEXT`);
  }
}
// Migração leve: prazo (dia do mês) de um modelo de Solicitação de Documentos — usado pelo card
// "Documentos pendentes" pra saber quando um item obrigatório já venceu sem upload.
{
  const colsChecklist = sqlite.prepare(`PRAGMA table_info(checklist_templates)`).all() as any[];
  if (!colsChecklist.some((c) => c.name === "prazo_dia")) {
    sqlite.exec(`ALTER TABLE checklist_templates ADD COLUMN prazo_dia INTEGER`);
  }
}
// Migração leve: Cliente passa a poder ter mais de uma empresa atribuída — a sessão guarda qual
// está "ativa" no momento (troca pela barra lateral quando o usuário tem mais de uma).
{
  const cols = sqlite.prepare(`PRAGMA table_info(sessions)`).all() as any[];
  if (!cols.some((c) => c.name === "empresa_ativa_id")) {
    sqlite.exec(`ALTER TABLE sessions ADD COLUMN empresa_ativa_id INTEGER REFERENCES empresas(id)`);
  }
}
// Backfill único: quem já tinha uma única empresa em app_users.empresa_id (o único jeito que
// existia até aqui) ganha essa mesma empresa em cliente_empresas — ninguém perde acesso.
{
  const clientesComEmpresa = sqlite.prepare(`SELECT id, empresa_id FROM app_users WHERE perfil = 'Cliente' AND empresa_id IS NOT NULL`).all() as any[];
  for (const c of clientesComEmpresa) {
    sqlite.prepare(`INSERT OR IGNORE INTO cliente_empresas (user_id, empresa_id) VALUES (?, ?)`).run(c.id, c.empresa_id);
  }
}
// Migração leve: texto padrão de e-mail pra envio automático de NFS-e.
{
  const cols = sqlite.prepare(`PRAGMA table_info(email_config)`).all() as any[];
  if (!cols.some((c) => c.name === "nfse_email_texto")) {
    sqlite.exec(`ALTER TABLE email_config ADD COLUMN nfse_email_texto TEXT`);
  }
}
// Migração: uma empresa na rotina automática de NFS-e pode ter mais de um serviço configurado
// (ex.: "honorários contábeis" + "licença do módulo NFS-e" viram duas notas separadas por mês) —
// o que antes era 1 linha por empresa em nfse_agendamento_empresas vira N linhas em
// nfse_agendamento_itens. Backfill único: quem já tinha modelo configurado vira o primeiro item,
// sem perder nada que o usuário já configurou de verdade (ex.: MSM AGROPECUARIA já cadastrada).
{
  const jaTemItens = sqlite.prepare(`SELECT COUNT(*) as n FROM nfse_agendamento_itens`).get() as any;
  if (jaTemItens.n === 0) {
    const antigas = sqlite.prepare(`SELECT * FROM nfse_agendamento_empresas WHERE modelo_id IS NOT NULL`).all() as any[];
    for (const a of antigas) {
      sqlite
        .prepare(`INSERT INTO nfse_agendamento_itens (empresa_id, modelo_id, descricao_servico, valor_servico, ativo) VALUES (?, ?, ?, ?, ?)`)
        .run(a.empresa_id, a.modelo_id, a.descricao_servico, a.valor_servico, a.ativo);
    }
  }
  const colsEmissoes = sqlite.prepare(`PRAGMA table_info(nfse_emissoes)`).all() as any[];
  if (!colsEmissoes.some((c) => c.name === "agendamento_item_id")) {
    sqlite.exec(`ALTER TABLE nfse_emissoes ADD COLUMN agendamento_item_id INTEGER REFERENCES nfse_agendamento_itens(id)`);
  }
  const colsLog = sqlite.prepare(`PRAGMA table_info(nfse_agendamento_log)`).all() as any[];
  if (!colsLog.some((c) => c.name === "item_id")) {
    sqlite.exec(`ALTER TABLE nfse_agendamento_log ADD COLUMN item_id INTEGER REFERENCES nfse_agendamento_itens(id)`);
  }
}
// Migração: {{n_contrato_sequencial}} — número sequencial do contrato, reinicia em 1 a cada ano,
// nunca se repete dentro do mesmo ano. Backfill único: contratos já existentes (sem número) ganham
// um número em ordem de criação, agrupados pelo ano de criado_em, pra numeração seguir sem colidir
// com o que já existe — sem isso o primeiro contrato novo pegaria "1" de novo.
{
  const colsContratos = sqlite.prepare(`PRAGMA table_info(contratos)`).all() as any[];
  if (!colsContratos.some((c) => c.name === "numero_sequencial")) {
    sqlite.exec(`ALTER TABLE contratos ADD COLUMN numero_sequencial INTEGER`);
    sqlite.exec(`ALTER TABLE contratos ADD COLUMN numero_sequencial_ano INTEGER`);
    const antigos = sqlite
      .prepare(`SELECT id, strftime('%Y', criado_em) as ano FROM contratos WHERE tipo = 'contrato' ORDER BY id`)
      .all() as any[];
    const contadorPorAno: Record<string, number> = {};
    for (const c of antigos) {
      contadorPorAno[c.ano] = (contadorPorAno[c.ano] || 0) + 1;
      sqlite.prepare(`UPDATE contratos SET numero_sequencial = ?, numero_sequencial_ano = ? WHERE id = ?`).run(contadorPorAno[c.ano], Number(c.ano), c.id);
    }
  }
}

// Migração: multi-tenant — cada escritório-cliente que contratar este sistema fica isolado dos
// demais (própria base de empresas, usuários, certificados, contratos, financeiro). O escritório
// real já existente (esta instância, hoje único dono de tudo) vira o escritório id=1 automaticamente
// — ninguém perde acesso a nada que já estava cadastrado.
{
  const jaTemEscritorio = sqlite.prepare(`SELECT COUNT(*) as n FROM escritorios`).get() as any;
  if (jaTemEscritorio.n === 0) {
    sqlite.prepare(`INSERT INTO escritorios (id, nome, ativo, envio_rollover_ultimo_ano) VALUES (1, 'Simples Contábeis', 1, ?)`).run(agoraBrasilia().ano);
  }
  const colsEmpresas = sqlite.prepare(`PRAGMA table_info(empresas)`).all() as any[];
  if (!colsEmpresas.some((c) => c.name === "escritorio_id")) {
    sqlite.exec(`ALTER TABLE empresas ADD COLUMN escritorio_id INTEGER NOT NULL DEFAULT 1`);
  }
  const colsUsers = sqlite.prepare(`PRAGMA table_info(app_users)`).all() as any[];
  if (!colsUsers.some((c) => c.name === "escritorio_id")) {
    // NULL é o valor real de "não pertence a nenhum escritório" (perfil SuperAdmin) — quem já
    // existe (Administrador/Colaborador/Cliente do escritório 1) fica com 1 explicitamente, nunca NULL.
    sqlite.exec(`ALTER TABLE app_users ADD COLUMN escritorio_id INTEGER`);
    sqlite.prepare(`UPDATE app_users SET escritorio_id = 1 WHERE escritorio_id IS NULL`).run();
  }
  // escritorios.empresa_id (a empresa que representa o próprio escritório — prestador de
  // honorários, "Contratada" nos contratos) herda o que já estava configurado como prestador da
  // rotina de NFS-e, se houver, sem precisar o admin configurar de novo.
  const escritorio1 = sqlite.prepare(`SELECT empresa_id FROM escritorios WHERE id = 1`).get() as any;
  if (escritorio1 && !escritorio1.empresa_id) {
    const agConfig = sqlite.prepare(`SELECT empresa_prestador_id FROM nfse_agendamento_config WHERE id = 1`).get() as any;
    if (agConfig?.empresa_prestador_id) {
      sqlite.prepare(`UPDATE escritorios SET empresa_id = ? WHERE id = 1`).run(agConfig.empresa_prestador_id);
    }
  }
}

// Migração: multi-tenant Fase 2 — as 5 tabelas de configuração que antes eram singletons forçados
// (uma linha só pra todo o sistema, id INTEGER PRIMARY KEY CHECK (id=1)) viram uma linha por
// escritório (escritorio_id INTEGER PRIMARY KEY). SQLite não permite trocar a PRIMARY KEY de uma
// tabela existente via ALTER TABLE, então cada uma é reconstruída (tabela nova + copia a linha do
// escritório 1 + descarta a antiga) — mesmo dado, só a chave muda de "id fixo em 1" pra
// "escritorio_id = 1" (e, no futuro, escritorio_id = 2, 3...).
function migrarSingletonParaEscritorio(tabela: string, colunasExtras: string) {
  const cols = sqlite.prepare(`PRAGMA table_info(${tabela})`).all() as any[];
  if (cols.some((c) => c.name === "escritorio_id")) return; // já migrada
  if (!cols.length) {
    // Banco novo — a tabela nem existe ainda, cria direto no formato final, sem nada pra migrar.
    sqlite.exec(`CREATE TABLE ${tabela} (escritorio_id INTEGER PRIMARY KEY REFERENCES escritorios(id), ${colunasExtras});`);
    return;
  }
  const nomesAntigos = new Set(cols.map((c) => c.name));
  // Só migra colunas que já existiam na tabela antiga — colunas adicionadas ao schema novo depois
  // da migração original (ex.: xml_export_ativo) ficam de fora do INSERT e assumem o DEFAULT da
  // tabela nova, em vez de quebrar por coluna inexistente na origem.
  const nomesColunasExtras = colunasExtras
    .split(",")
    .map((c) => c.trim().split(/\s+/)[0])
    .filter((nome) => nomesAntigos.has(nome))
    .join(", ");
  sqlite.exec(`
    CREATE TABLE ${tabela}_new (
      escritorio_id INTEGER PRIMARY KEY REFERENCES escritorios(id),
      ${colunasExtras}
    );
    INSERT INTO ${tabela}_new (escritorio_id, ${nomesColunasExtras})
      SELECT 1, ${nomesColunasExtras} FROM ${tabela} WHERE id = 1;
    DROP TABLE ${tabela};
    ALTER TABLE ${tabela}_new RENAME TO ${tabela};
  `);
}
migrarSingletonParaEscritorio(
  "contratos_distrato_config",
  `clausula_padrao TEXT, assinaturas_padrao TEXT, updated_at TEXT DEFAULT (datetime('now'))`
);
migrarSingletonParaEscritorio("agent_heartbeat", `last_seen_at TEXT, version TEXT`);
migrarSingletonParaEscritorio(
  "dominio_config",
  `source TEXT NOT NULL DEFAULT '', db_driver TEXT, db_host TEXT, db_port INTEGER, db_name TEXT, db_user TEXT,
   db_password TEXT, db_connect_string TEXT, query_clientes TEXT, col_codigo TEXT DEFAULT 'CODIGO',
   col_nome TEXT DEFAULT 'NOME', col_cnpj TEXT DEFAULT 'CNPJ', col_status TEXT DEFAULT 'STATUS',
   api_url TEXT, api_token TEXT, xml_export_ativo INTEGER NOT NULL DEFAULT 0, xml_export_dir TEXT,
   updated_at TEXT DEFAULT (datetime('now'))`
);
// Migração leve: dominio_config ganhou os campos de exportação automática de XML pro Domínio Web
// (pasta local que o agent mantém sincronizada com os documentos buscados via NF-e/NFS-e).
{
  const cols = sqlite.prepare(`PRAGMA table_info(dominio_config)`).all() as any[];
  const nomes = new Set(cols.map((c) => c.name));
  if (!nomes.has("xml_export_ativo")) sqlite.exec(`ALTER TABLE dominio_config ADD COLUMN xml_export_ativo INTEGER NOT NULL DEFAULT 0`);
  if (!nomes.has("xml_export_dir")) sqlite.exec(`ALTER TABLE dominio_config ADD COLUMN xml_export_dir TEXT`);
}
// Migração leve: tipo de licença personalizado ganha empresa_id (nullable) — achado ao vivo: um tipo
// criado dentro de uma empresa específica ("+ Outra licença") aparecia em TODAS as empresas do
// escritório, porque o tipo era compartilhado só por escritorio_id. NULL continua = compartilhado
// (tipos já existentes antes desta migração não mudam de comportamento); um valor aqui = só aparece
// na empresa que criou.
{
  const cols = sqlite.prepare(`PRAGMA table_info(empresa_licenca_tipos)`).all() as any[];
  if (!cols.some((c) => c.name === "empresa_id")) {
    sqlite.exec(`ALTER TABLE empresa_licenca_tipos ADD COLUMN empresa_id INTEGER REFERENCES empresas(id)`);
    console.log("Migração aplicada: empresa_licenca_tipos.empresa_id (tipos já existentes seguem compartilhados, sem empresa_id).");
  }
}
migrarSingletonParaEscritorio(
  "email_config",
  `smtp_host TEXT, smtp_port INTEGER DEFAULT 587, smtp_secure INTEGER DEFAULT 0, smtp_user TEXT, smtp_password TEXT,
   from_name TEXT, from_email TEXT, nfse_email_texto TEXT, updated_at TEXT DEFAULT (datetime('now'))`
);
migrarSingletonParaEscritorio(
  "nfse_agendamento_config",
  `ativo INTEGER NOT NULL DEFAULT 0, empresa_prestador_id INTEGER REFERENCES empresas(id),
   envio_template_id INTEGER REFERENCES envio_templates(id), dia_mes INTEGER NOT NULL DEFAULT 1,
   hora INTEGER NOT NULL DEFAULT 8, minuto INTEGER NOT NULL DEFAULT 0, ultima_execucao_competencia TEXT,
   updated_at TEXT DEFAULT (datetime('now'))`
);
// Cada escritório novo (criado via /api/super/escritorios) precisa de uma linha própria nessas 5
// tabelas desde já — senão as rotas que fazem UPSERT em cima de "a linha do meu escritório" (ex.:
// PUT /api/email/config) quebram no primeiro escritório sem linha nenhuma ainda.
function garantirLinhasDeConfig(escritorioId: number) {
  sqlite.prepare(`INSERT OR IGNORE INTO contratos_distrato_config (escritorio_id) VALUES (?)`).run(escritorioId);
  sqlite.prepare(`INSERT OR IGNORE INTO agent_heartbeat (escritorio_id) VALUES (?)`).run(escritorioId);
  sqlite.prepare(`INSERT OR IGNORE INTO dominio_config (escritorio_id) VALUES (?)`).run(escritorioId);
  sqlite.prepare(`INSERT OR IGNORE INTO email_config (escritorio_id) VALUES (?)`).run(escritorioId);
  sqlite.prepare(`INSERT OR IGNORE INTO nfse_agendamento_config (escritorio_id) VALUES (?)`).run(escritorioId);
  sqlite.prepare(`INSERT OR IGNORE INTO whatsapp_config (escritorio_id) VALUES (?)`).run(escritorioId);
}
garantirLinhasDeConfig(1);
// Escritórios criados antes da tabela whatsapp_config existir (ou de garantirLinhasDeConfig ganhar
// essa linha) também precisam da própria linha — não só o escritório 1.
sqlite.exec(`INSERT OR IGNORE INTO whatsapp_config (escritorio_id) SELECT id FROM escritorios`);

// Migração: multi-tenant Fase 3 — nfse_certificados e nfse_modelos usam `empresa_id IS NULL` como
// sentinela de "pertence ao próprio escritório" (não a uma empresa-cliente específica). Sem uma
// coluna própria de escritório, essa linha "do escritório" era uma só pra toda a base — um segundo
// escritório real colidiria com o certificado/modelo da Simples Contábeis. `escritorio_id` aqui
// nunca é o dono exclusivo (diferente das tabelas da Fase 2): pra linhas com empresa_id preenchido
// ele só espelha o escritório da empresa (redundante, mas evita um JOIN em toda consulta); pra
// linhas com empresa_id NULL ele é a única forma de saber de quem é.
{
  const colsCert = sqlite.prepare(`PRAGMA table_info(nfse_certificados)`).all() as any[];
  if (!colsCert.some((c) => c.name === "escritorio_id")) {
    sqlite.exec(`ALTER TABLE nfse_certificados ADD COLUMN escritorio_id INTEGER`);
    sqlite.exec(
      `UPDATE nfse_certificados SET escritorio_id = (SELECT escritorio_id FROM empresas WHERE empresas.id = nfse_certificados.empresa_id) WHERE empresa_id IS NOT NULL`
    );
    sqlite.exec(`UPDATE nfse_certificados SET escritorio_id = 1 WHERE empresa_id IS NULL AND escritorio_id IS NULL`);
  }
  const colsModelos = sqlite.prepare(`PRAGMA table_info(nfse_modelos)`).all() as any[];
  if (!colsModelos.some((c) => c.name === "escritorio_id")) {
    sqlite.exec(`ALTER TABLE nfse_modelos ADD COLUMN escritorio_id INTEGER`);
    sqlite.exec(
      `UPDATE nfse_modelos SET escritorio_id = (SELECT escritorio_id FROM empresas WHERE empresas.id = nfse_modelos.empresa_id) WHERE empresa_id IS NOT NULL`
    );
    sqlite.exec(`UPDATE nfse_modelos SET escritorio_id = 1 WHERE empresa_id IS NULL AND escritorio_id IS NULL`);
  }
  // Catálogos até então globais (compartilhados por toda a base) — cada um vira propriedade de um
  // escritório específico. Todo o conteúdo já cadastrado (o do escritório 1) é preservado, só ganha
  // o dono explícito.
  for (const tabela of ["checklist_templates", "envio_templates", "contratos_modelos", "dashboard_cards"]) {
    const cols = sqlite.prepare(`PRAGMA table_info(${tabela})`).all() as any[];
    if (!cols.some((c) => c.name === "escritorio_id")) {
      sqlite.exec(`ALTER TABLE ${tabela} ADD COLUMN escritorio_id INTEGER NOT NULL DEFAULT 1`);
    }
  }
}

const MODULOS = ["dashboard", "empresas", "solicitacoes", "envio", "nfse", "nfe-busca", "integracontador", "licencas", "financeiro", "contratos", "relatorios", "crm", "usuarios", "configuracoes"] as const;
type Modulo = (typeof MODULOS)[number];

// ========================= LOGIN (senha com hash + sessão via cookie) =========================
function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}
function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = String(stored || "").split(":");
  if (!salt || !hash) return false;
  const check = crypto.scryptSync(password, salt, 64).toString("hex");
  const a = Buffer.from(hash, "hex");
  const b = Buffer.from(check, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const SESSION_DAYS = 7;
// Conta de Painel de TV: fica logada meses a fio, ninguém vai digitar senha de novo — sessão nasce
// com validade bem mais longa (ver createSession) e além disso é renovada a cada request válido (ver
// getSessionUser), então na prática nunca expira sozinha enquanto a TV continuar recarregando a
// página periodicamente.
const SESSION_DAYS_PAINEL_TV = 730;
function createSession(userId: number, painelTv = false): string {
  const token = crypto.randomBytes(32).toString("hex");
  const dias = painelTv ? SESSION_DAYS_PAINEL_TV : SESSION_DAYS;
  const expiresAt = new Date(Date.now() + dias * 24 * 60 * 60 * 1000).toISOString();
  sqlite.prepare(`INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)`).run(token, userId, expiresAt);
  return token;
}
// Empresas atribuídas a um usuário Cliente, ordenadas por nome — pode ser mais de uma.
function clienteEmpresasDoUsuario(userId: number): { id: number; nome: string }[] {
  return sqlite
    .prepare(
      `SELECT e.id, e.nome FROM cliente_empresas ce JOIN empresas e ON e.id = ce.empresa_id
       WHERE ce.user_id = ? AND e.ativo = 1 ORDER BY e.nome`
    )
    .all(userId) as any[];
}
// Resolve qual empresa está "ativa" pra essa sessão de Cliente (pode ter várias atribuídas — só
// uma fica em uso por vez, trocável pela barra lateral). Estabiliza a escolha de volta na sessão
// pra não recalcular a cada request.
function resolverEmpresaAtivaCliente(token: string, userId: number, empresaAtivaAtual: number | null): number | null {
  const atribuidas = clienteEmpresasDoUsuario(userId);
  if (!atribuidas.length) return null;
  if (empresaAtivaAtual && atribuidas.some((e) => e.id === empresaAtivaAtual)) return empresaAtivaAtual;
  const primeira = atribuidas[0].id;
  sqlite.prepare(`UPDATE sessions SET empresa_ativa_id = ? WHERE token = ?`).run(primeira, token);
  return primeira;
}
function getSessionUser(token: string | undefined) {
  if (!token) return null;
  const row = sqlite
    .prepare(
      `SELECT s.expires_at as expiresAt, s.empresa_ativa_id as empresaAtivaId, u.id, u.nome, u.email, u.perfil,
              u.acesso_todas_empresas as acessoTodasEmpresas, u.ativo, u.escritorio_id as escritorioId, u.painel_tv as painelTv
       FROM sessions s JOIN app_users u ON u.id = s.user_id
       WHERE s.token = ?`
    )
    .get(token) as any;
  if (!row) return null;
  if (new Date(row.expiresAt) < new Date() || !row.ativo) {
    sqlite.prepare(`DELETE FROM sessions WHERE token = ?`).run(token);
    return null;
  }
  // Conta de Painel de TV: empurra a validade da sessão pra sempre bem lá na frente a cada request
  // válido — na prática não expira sozinha enquanto a TV continuar recarregando periodicamente (o
  // painel recarrega a página a cada 30min, bem menos que os 2 anos de folga).
  if (row.painelTv) {
    const novaExpiracao = new Date(Date.now() + SESSION_DAYS_PAINEL_TV * 24 * 60 * 60 * 1000).toISOString();
    sqlite.prepare(`UPDATE sessions SET expires_at = ? WHERE token = ?`).run(novaExpiracao, token);
  }
  const empresaId = row.perfil === "Cliente" ? resolverEmpresaAtivaCliente(token, row.id, row.empresaAtivaId) : null;
  return {
    id: row.id,
    nome: row.nome,
    email: row.email,
    perfil: row.perfil as "Administrador" | "Colaborador" | "Cliente" | "SuperAdmin",
    empresaId,
    acessoTodasEmpresas: !!row.acessoTodasEmpresas,
    escritorioId: row.escritorioId as number | null,
    painelTv: !!row.painelTv,
  };
}
function requireAuth(req: express.Request, res: express.Response, next: express.NextFunction) {
  const user = getSessionUser(req.cookies?.sid);
  if (!user) return res.status(401).json({ error: "Sessão expirada. Faça login novamente." });
  (req as any).user = user;
  next();
}
function requireAdmin(req: express.Request, res: express.Response, next: express.NextFunction) {
  if ((req as any).user?.perfil !== "Administrador") {
    return res.status(403).json({ error: "Só administradores podem fazer isso." });
  }
  next();
}
// Dono do SaaS — gerencia os escritórios-cliente, não pertence a nenhum escritório.
function requireSuperAdmin(req: express.Request, res: express.Response, next: express.NextFunction) {
  if ((req as any).user?.perfil !== "SuperAdmin") {
    return res.status(403).json({ error: "Só o dono do sistema pode fazer isso." });
  }
  next();
}
// Bloqueia clientes de qualquer rota interna do escritório
function blockCliente(req: express.Request, res: express.Response, next: express.NextFunction) {
  if ((req as any).user?.perfil === "Cliente") return res.status(403).json({ error: "Acesso não permitido para este perfil." });
  next();
}
function hasPermissao(user: any, modulo: Modulo, acao: "visualizar" | "postar" | "editar"): boolean {
  if (user.perfil === "Administrador") return true;
  if (user.perfil === "Cliente") return false;
  const row = sqlite
    .prepare(`SELECT pode_visualizar, pode_postar, pode_editar FROM colaborador_permissoes WHERE user_id = ? AND modulo = ?`)
    .get(user.id, modulo) as any;
  if (!row) return false;
  if (acao === "visualizar") return !!row.pode_visualizar;
  if (acao === "postar") return !!row.pode_postar;
  return !!row.pode_editar;
}
function requirePermissao(modulo: Modulo, acao: "visualizar" | "postar" | "editar") {
  return (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const user = (req as any).user;
    if (!hasPermissao(user, modulo, acao)) {
      return res.status(403).json({ error: "Você não tem permissão para fazer isso." });
    }
    next();
  };
}
// Pra rota que serve DOIS fluxos com permissão própria (ex.: a lista de anos de licença é usada
// tanto pela aba Licenças de dentro de Empresas quanto pelo módulo Licenças em lote) — basta ter
// UMA das duas pra passar, sem forçar quem só usa um dos dois fluxos a pedir a outra permissão.
function requirePermissaoOr(moduloA: Modulo, moduloB: Modulo, acao: "visualizar" | "postar" | "editar") {
  return (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const user = (req as any).user;
    if (!hasPermissao(user, moduloA, acao) && !hasPermissao(user, moduloB, acao)) {
      return res.status(403).json({ error: "Você não tem permissão para fazer isso." });
    }
    next();
  };
}
// IDs de empresa que este usuário pode enxergar (null = todas as do próprio escritório)
function empresasVisiveis(user: any): number[] {
  // SuperAdmin não pertence a nenhum escritório — nunca enxerga empresa de cliente nenhuma,
  // mesmo que acesso_todas_empresas esteja setado (default da coluna é 1).
  if (user.perfil === "SuperAdmin") return [];
  if (user.perfil === "Cliente") return user.empresaId ? [user.empresaId] : [];
  // Administrador enxerga todas as empresas — mas só as do PRÓPRIO escritório, nunca de outro
  // (antes do multi-tenant isso retornava `null` = sem filtro nenhum na base inteira).
  if (user.perfil === "Administrador" || user.acessoTodasEmpresas) {
    const rows = sqlite.prepare(`SELECT id FROM empresas WHERE escritorio_id = ?`).all(user.escritorioId) as any[];
    return rows.map((r) => r.id);
  }
  const rows = sqlite
    .prepare(
      `SELECT ce.empresa_id FROM colaborador_empresas ce
       JOIN empresas e ON e.id = ce.empresa_id
       WHERE ce.user_id = ? AND e.escritorio_id = ?`
    )
    .all(user.id, user.escritorioId) as any[];
  return rows.map((r) => r.empresa_id);
}
function podeAcessarEmpresa(user: any, empresaId: number): boolean {
  const ids = empresasVisiveis(user);
  return ids === null || ids.includes(empresaId);
}

// Usado pra bloquear exclusão de empresa/atribuição que já tem histórico real de documentos —
// nesse caso o caminho é inativar (não apaga nada), não excluir.
function atribuicaoTemAnexos(atribuicaoId: number): boolean {
  const row = sqlite
    .prepare(
      `SELECT EXISTS(
         SELECT 1 FROM checklist_uploads u JOIN checklist_periodos p ON p.id = u.periodo_id
         WHERE p.atribuicao_id = ?
       ) as tem`
    )
    .get(atribuicaoId) as any;
  return !!row.tem;
}
function empresaTemAnexos(empresaId: number): boolean {
  const row = sqlite
    .prepare(
      `SELECT EXISTS(
         SELECT 1 FROM checklist_uploads u
         JOIN checklist_periodos p ON p.id = u.periodo_id
         JOIN checklist_atribuicoes a ON a.id = p.atribuicao_id
         WHERE a.empresa_id = ?
       ) as tem`
    )
    .get(empresaId) as any;
  if (row.tem) return true;
  return empresaTemDocumentosEnviados(empresaId);
}
function envioAtribuicaoTemDocumentos(atribuicaoId: number): boolean {
  const row = sqlite
    .prepare(
      `SELECT EXISTS(
         SELECT 1 FROM envio_documentos d JOIN envio_periodos p ON p.id = d.periodo_id
         WHERE p.atribuicao_id = ?
       ) as tem`
    )
    .get(atribuicaoId) as any;
  return !!row.tem;
}
// Pedidos feitos pelo cliente (menu "Solicitar Documentos") que ainda não foram atendidos —
// usado pra destacar a atribuição na lista do escritório ("caixa de entrada" de pedidos).
function envioAtribuicaoPendentesCliente(atribuicaoId: number): number {
  const row = sqlite
    .prepare(
      `SELECT COUNT(*) as c FROM envio_periodos p
       WHERE p.atribuicao_id = ? AND p.solicitado_em IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM envio_documentos d WHERE d.periodo_id = p.id)`
    )
    .get(atribuicaoId) as any;
  return Number(row.c) || 0;
}
function empresaTemDocumentosEnviados(empresaId: number): boolean {
  const row = sqlite
    .prepare(
      `SELECT EXISTS(
         SELECT 1 FROM envio_documentos d
         JOIN envio_periodos p ON p.id = d.periodo_id
         JOIN envio_atribuicoes a ON a.id = p.atribuicao_id
         WHERE a.empresa_id = ?
       ) as tem`
    )
    .get(empresaId) as any;
  return !!row.tem;
}

function passwordPolicyError(password: string): string | null {
  const p = String(password || "");
  if (p.length < 10) return "A senha precisa ter pelo menos 10 caracteres.";
  if (!/[a-zA-Z]/.test(p) || !/[0-9]/.test(p)) return "A senha precisa ter letras e números.";
  return null;
}
const loginRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Muitas tentativas de login. Aguarde alguns minutos e tente de novo." },
});

// Bootstrap opcional do primeiro administrador via .env (só roda se não houver nenhum usuário ainda)
function bootstrapAdmin() {
  const count = (sqlite.prepare(`SELECT COUNT(*) as c FROM app_users`).get() as any).c;
  if (count > 0) return;
  const email = process.env.ADMIN_EMAIL, nome = process.env.ADMIN_NOME, password = process.env.ADMIN_PASSWORD;
  if (!email || !nome || !password) {
    console.warn("Nenhum usuário cadastrado ainda. Defina ADMIN_EMAIL, ADMIN_NOME e ADMIN_PASSWORD no .env para criar o primeiro administrador automaticamente.");
    return;
  }
  sqlite
    .prepare(`INSERT INTO app_users (nome, email, perfil, password_hash, acesso_todas_empresas, escritorio_id) VALUES (?, ?, 'Administrador', ?, 1, 1)`)
    .run(nome, String(email).trim().toLowerCase(), hashPassword(password));
  console.log(`Administrador inicial criado: ${email}`);
}
bootstrapAdmin();

// Bootstrap opcional do dono do SaaS via .env (só roda se ainda não existir nenhum SuperAdmin)
function bootstrapSuperAdmin() {
  const count = (sqlite.prepare(`SELECT COUNT(*) as c FROM app_users WHERE perfil = 'SuperAdmin'`).get() as any).c;
  if (count > 0) return;
  const email = process.env.SUPERADMIN_EMAIL, nome = process.env.SUPERADMIN_NOME, password = process.env.SUPERADMIN_PASSWORD;
  if (!email || !nome || !password) return;
  sqlite
    .prepare(`INSERT INTO app_users (nome, email, perfil, password_hash, acesso_todas_empresas, escritorio_id) VALUES (?, ?, 'SuperAdmin', ?, 0, NULL)`)
    .run(nome, String(email).trim().toLowerCase(), hashPassword(password));
  console.log(`SuperAdmin inicial criado: ${email}`);
}
bootstrapSuperAdmin();

// ========================= ANEXOS (tipos aceitos por slot do checklist) =========================
const ACCEPT_EXT: Record<string, string[]> = {
  ofx: [".ofx"],
  pdf: [".pdf"],
  zip: [".zip", ".rar", ".7z"],
  xml: [".xml"],
  imagem: [".png", ".jpg", ".jpeg"],
  qualquer: [], // sem restrição
};
function extensaoPermitida(accept: string[], fileName: string): boolean {
  if (!accept || !accept.length || accept.includes("qualquer")) return true;
  const ext = path.extname(fileName).toLowerCase();
  return accept.some((tipo) => (ACCEPT_EXT[tipo] || []).includes(ext));
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 60 * 1024 * 1024 }, // 60MB por arquivo — extratos/PDFs de bancos não passam disso
});
// O multipart via multer/busboy decodifica o nome do arquivo como latin1 por padrão — quando o
// navegador manda o nome em UTF-8 puro (acento, cedilha), ele chega corrompido (ex.:
// "FiscalizaÃ§Ã£o.pdf" em vez de "Fiscalização.pdf"). Reinterpretar como UTF-8 corrige isso sem
// afetar nomes só com caracteres ASCII.
function corrigirNomeArquivo(nome: string): string {
  try {
    return Buffer.from(nome, "latin1").toString("utf8");
  } catch {
    return nome;
  }
}

function empresaSlotDir(empresaId: number, periodoId: number) {
  return path.join(UPLOADS_DIR, String(empresaId), String(periodoId));
}

// ========================= E-MAIL CORPORATIVO =========================
// Configurável pela tela (tabela email_config) — as variáveis SMTP_* no .env continuam servindo de
// valor padrão/fallback pra quem preferir configurar assim, mas o que estiver salvo no banco tem
// prioridade.
// Nota: fallback pras variáveis SMTP_* do .env só faz sentido pro escritório 1 (a própria instância
// original) — um escritório novo sem nada configurado na tela simplesmente não tem e-mail até
// configurar, não herda a credencial de e-mail de outro escritório via .env.
function getEmailConfig(escritorioId: number): any {
  return sqlite.prepare(`SELECT * FROM email_config WHERE escritorio_id = ?`).get(escritorioId) || {};
}
function emailConfigurado(escritorioId: number): boolean {
  const c = getEmailConfig(escritorioId);
  const fallback = escritorioId === 1;
  return !!(
    (c.smtp_host || (fallback && process.env.SMTP_HOST)) &&
    (c.smtp_user || (fallback && process.env.SMTP_USER)) &&
    (c.smtp_password || (fallback && process.env.SMTP_PASSWORD))
  );
}
// Sem cache de transporter — a config pode mudar a qualquer momento pela tela, e criar o objeto do
// nodemailer não abre conexão nenhuma sozinho (só na hora de mandar), então não tem custo real.
function getTransporter(escritorioId: number) {
  if (!emailConfigurado(escritorioId)) return null;
  const c = getEmailConfig(escritorioId);
  const fallback = escritorioId === 1;
  return nodemailer.createTransport({
    host: c.smtp_host || (fallback && process.env.SMTP_HOST),
    port: Number(c.smtp_port || (fallback && process.env.SMTP_PORT) || 587),
    secure: c.smtp_secure != null ? !!c.smtp_secure : fallback && process.env.SMTP_SECURE === "true",
    auth: { user: c.smtp_user || (fallback && process.env.SMTP_USER), pass: c.smtp_password || (fallback && process.env.SMTP_PASSWORD) },
  });
}
async function enviarEmail(escritorioId: number, opts: { to: string[]; subject: string; text: string; attachments?: { filename: string; content: Buffer }[] }) {
  const t = getTransporter(escritorioId);
  if (!t) throw new Error("E-mail corporativo não configurado — configure em Configurações > E-mail corporativo.");
  const c = getEmailConfig(escritorioId);
  const fallback = escritorioId === 1;
  const fromName = c.from_name || (fallback && process.env.SMTP_FROM_NAME) || "Simples Contábeis";
  const fromEmail = c.from_email || (fallback && process.env.SMTP_FROM_EMAIL) || c.smtp_user || (fallback && process.env.SMTP_USER);
  await t.sendMail({
    from: `"${fromName}" <${fromEmail}>`,
    to: opts.to.join(", "),
    subject: opts.subject,
    text: opts.text,
    attachments: opts.attachments,
  });
}

// ========================= APP =========================
const app = express();
app.set("trust proxy", 1);
// verify: guarda o corpo cru (antes do parse) em req.rawBody — necessário pra conferir a assinatura
// HMAC (X-Hub-Signature-256) do webhook do WhatsApp, que é calculada sobre os bytes exatos que a
// Meta mandou, não sobre o JSON re-serializado (que pode diferir em espaço/ordem das chaves).
app.use(express.json({ limit: "20mb", verify: (req: any, _res, buf) => { req.rawBody = buf; } }));
app.use(cookieParser());
// cacheControl:false — o site é uma página só, ainda em ajuste frequente; sem isso o navegador
// segura uma cópia velha do app.html em cache e mudanças de UI não aparecem sem hard refresh.
app.use(express.static(path.join(__dirname, "..", "public"), { cacheControl: false }));

app.get("/", (_req, res) => {
  res.set("Cache-Control", "no-store");
  res.sendFile(path.join(__dirname, "..", "public", "app.html"));
});
app.get("/api/health", (_req, res) => res.json({ ok: true }));

// ---------- Ponte com o deskcomm (CRM de terceiros, rodando numa VPS separada) ----------
// O proxy deixa o deskcomm acessível dentro do mesmo domínio (`/deskcomm/*`), protegido pela MESMA
// sessão `sid` de sempre — ninguém sem login aqui alcança o que está atrás dele. O login único
// funciona gerando um magic-link do Supabase Auth do deskcomm (API Admin, com a service-role key) e
// mandando o navegador pro `/auth/confirm` de lá — como essa chamada passa PELO PROXY (mesma
// origem), o cookie de sessão do deskcomm (`sb-deskcomm-auth`) fica gravado neste mesmo domínio, sem
// precisar sair pra `srv1998403.hstgr.cloud`. O deskcomm em si já foi reconstruído com
// `basePath: "/deskcomm"`, então os caminhos batem sem nenhuma reescrita aqui.
const DESKCOMM_URL = "https://srv1998403.hstgr.cloud";
// .trim(): variáveis de ambiente coladas por um painel web (Railway etc.) vêm sujeitas a espaço/quebra
// de linha grudado sem querer — medido ao vivo com DESKCOMM_ORG_ID assim, e "invalid input syntax for
// type uuid" não deixa óbvio que o problema é um espaço, não o valor em si.
const DESKCOMM_SUPABASE_URL = (process.env.DESKCOMM_SUPABASE_URL || "").trim();
const DESKCOMM_SUPABASE_SERVICE_ROLE_KEY = (process.env.DESKCOMM_SUPABASE_SERVICE_ROLE_KEY || "").trim();
const DESKCOMM_ORG_ID = (process.env.DESKCOMM_ORG_ID || "").trim();
const deskcommAdmin =
  DESKCOMM_SUPABASE_URL && DESKCOMM_SUPABASE_SERVICE_ROLE_KEY
    ? createSupabaseClient(DESKCOMM_SUPABASE_URL, DESKCOMM_SUPABASE_SERVICE_ROLE_KEY, { auth: { autoRefreshToken: false, persistSession: false } })
    : null;
// `express.json()` (registrado lá em cima, global) já CONSOME o corpo da requisição antes de chegar
// aqui — sem isso, todo PUT/POST/PATCH proxeado chegava vazio no deskcomm (medido ao vivo: salvar
// membros de Roteador dava "Failed to load response data" no DevTools, sem status nenhum — o corpo
// nunca saía). Reescreve o corpo já parseado (`req.body`) de volta na requisição de saída antes do
// proxy encaminhar.
function reescreverCorpoNoProxy(proxyReq: any, req: express.Request) {
  // x-forwarded-host precisa ser o domínio que o NAVEGADOR vê (este site), não o da VPS —
  // changeOrigin:true (necessário: sem ele o TLS quebra com EPROTO na negociação com o Caddy da VPS,
  // testado ao vivo) reescreve o Host pro domínio de destino, mas o Next.js do deskcomm tem uma
  // proteção de CSRF pras Server Actions que exige x-forwarded-host bater com o Origin que o
  // navegador manda — sem essa linha, toda Server Action (ex.: "Duplicar" agente) morria com
  // "Invalid Server Actions request" (confirmado ao vivo nos logs do deskcomm). req.headers.host é
  // sempre o domínio original de quem chamou este servidor, então é o valor certo aqui.
  if (req.headers.host) proxyReq.setHeader("x-forwarded-host", req.headers.host);
  if (!req.body || !Object.keys(req.body).length) return;
  const corpo = Buffer.from(JSON.stringify(req.body));
  proxyReq.setHeader("Content-Type", "application/json");
  proxyReq.setHeader("Content-Length", corpo.length);
  proxyReq.write(corpo);
}
// keepAlive: reaproveita a conexão TLS já aberta pra VPS entre requisições, em vez de renegociar TLS
// do zero a cada chamada (achado investigando lentidão intermitente salvando dados do deskcomm — cada
// handshake novo soma algumas centenas de ms, e o cliente dele desiste sozinho depois de pouco tempo).
// timeout/proxyTimeout generosos: o padrão do Node é curto demais pra uma cadeia
// navegador→Railway→VPS→Supabase, e um proxy que corta cedo demais é pior que um lento — melhor
// deixar quem sabe o orçamento certo (o próprio cliente do deskcomm) decidir quando desistir.
const deskcommHttpsAgent = new https.Agent({ keepAlive: true, maxSockets: 50 });
// requireAuth/blockCliente devolvem JSON (certo pra /api/*, chamado por fetch) — mas /deskcomm serve
// NAVEGAÇÃO DE PÁGINA (o navegador carrega isto direto, com F5/atualizar incluso). Sessão vencida
// nessa rota mostrando `{"error":"Sessão expirada..."}` cru na tela é uma péssima experiência —
// medido ao vivo — o certo é voltar pra tela inicial do site, de onde o login normal assume.
function requireAuthPagina(req: express.Request, res: express.Response, next: express.NextFunction) {
  const user = getSessionUser(req.cookies?.sid);
  if (!user) return res.redirect("/");
  if (user.perfil === "Cliente") return res.redirect("/");
  (req as any).user = user;
  next();
}
app.use(
  "/deskcomm",
  requireAuthPagina,
  createProxyMiddleware({
    target: DESKCOMM_URL,
    // changeOrigin:true é obrigatório aqui — testado ao vivo sem ele: o TLS quebra com EPROTO na
    // negociação com o Caddy da VPS (o SNI acompanha essa opção). O ajuste do x-forwarded-host pra
    // Server Actions (ver reescreverCorpoNoProxy) resolve o problema de origem sem precisar desligar
    // isto.
    changeOrigin: true,
    ws: false,
    agent: deskcommHttpsAgent,
    proxyTimeout: 45_000,
    timeout: 45_000,
    onProxyReq: reescreverCorpoNoProxy,
  })
);
// O front-end do deskcomm chama a própria API sempre por caminho absoluto (ex.: fetch("/api/v1/...")),
// sem levar o basePath em conta — fetch() cru não é reescrito pelo Next como a navegação é. Medido ao
// vivo: com só o proxy acima, toda tela que busca dado (Conexões, Inbox etc.) dava "não foi possível
// carregar" (a chamada ia pra cá, num caminho que não existe neste servidor, 404). Como o deskcomm em
// si usa exclusivamente o prefixo "/api/v1" (conferido: nenhuma rota própria deste site usa esse
// prefixo, então não colide com nada), proxear esse prefixo direto resolve pra TODA chamada de uma
// vez, sem precisar caçar cada `fetch(...)` espalhado pelo código dele nem reconstruir a imagem.
app.use(
  "/api/v1",
  requireAuth,
  blockCliente,
  createProxyMiddleware({
    target: DESKCOMM_URL,
    changeOrigin: true, // ver comentário do proxy /deskcomm acima — obrigatório pro TLS não quebrar
    ws: false,
    agent: deskcommHttpsAgent,
    proxyTimeout: 45_000,
    timeout: 45_000,
    pathRewrite: { "^/api/v1": "/deskcomm/api/v1" },
    onProxyReq: reescreverCorpoNoProxy,
  })
);
app.get("/deskcomm-login", requireAuth, blockCliente, async (req, res) => {
  const user = (req as any).user;
  if (!deskcommAdmin || !DESKCOMM_ORG_ID) {
    return res.status(503).send("Integração com o deskcomm não configurada (faltam variáveis de ambiente no servidor).");
  }
  try {
    let deskcommUserId: string | null = (sqlite.prepare(`SELECT deskcomm_user_id FROM app_users WHERE id = ?`).get(user.id) as any)?.deskcomm_user_id || null;
    if (!deskcommUserId) {
      // Busca por e-mail antes de criar — createUser falha se o e-mail já existir por lá (ex.:
      // usuário provisionado manualmente antes desta ponte existir).
      const { data: existentes, error: erroListar } = await deskcommAdmin.auth.admin.listUsers({ page: 1, perPage: 1000 });
      if (erroListar) throw new Error(erroListar.message);
      const existente = existentes.users.find((u) => (u.email || "").toLowerCase() === user.email.toLowerCase());
      if (existente) {
        deskcommUserId = existente.id;
      } else {
        const { data: criado, error: erroCriar } = await deskcommAdmin.auth.admin.createUser({
          email: user.email,
          email_confirm: true,
          user_metadata: { nome: user.nome, origem: "simplescontabeis" },
        });
        if (erroCriar || !criado.user) throw new Error(erroCriar?.message || "Falha ao criar usuário espelhado no deskcomm.");
        deskcommUserId = criado.user.id;
      }
      sqlite.prepare(`UPDATE app_users SET deskcomm_user_id = ? WHERE id = ?`).run(deskcommUserId, user.id);
    }
    const role = user.perfil === "Administrador" ? "admin" : "agent";
    const { error: erroOrg } = await deskcommAdmin
      .from("user_organizations")
      .upsert({ organization_id: DESKCOMM_ORG_ID, user_id: deskcommUserId, role, accepted_at: new Date().toISOString() }, { onConflict: "organization_id,user_id" });
    if (erroOrg) throw new Error(erroOrg.message);
    const { data: linkData, error: erroLink } = await deskcommAdmin.auth.admin.generateLink({ type: "magiclink", email: user.email });
    const tokenHash = (linkData as any)?.properties?.hashed_token;
    if (erroLink || !tokenHash) throw new Error(erroLink?.message || "O Supabase não devolveu o token de acesso.");
    const qs = new URLSearchParams({ token_hash: tokenHash, type: "magiclink", next: "/app/inbox" });
    res.redirect(`/deskcomm/auth/confirm?${qs.toString()}`);
  } catch (e: any) {
    console.error("[deskcomm] falha na ponte de login:", e.message);
    res.status(502).send(`Não foi possível entrar no deskcomm agora: ${e.message}`);
  }
});

// ---------- Autenticação ----------
app.post("/api/auth/login", loginRateLimiter, (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: "Informe e-mail e senha." });
  const row = sqlite.prepare(`SELECT * FROM app_users WHERE email = ?`).get(String(email).trim().toLowerCase()) as any;
  if (!row || !row.ativo || !verifyPassword(password, row.password_hash)) {
    return res.status(401).json({ error: "E-mail ou senha inválidos." });
  }
  const token = createSession(row.id, !!row.painel_tv);
  const diasCookie = row.painel_tv ? SESSION_DAYS_PAINEL_TV : SESSION_DAYS;
  res.cookie("sid", token, { httpOnly: true, sameSite: "lax", secure: req.secure, maxAge: diasCookie * 24 * 60 * 60 * 1000 });
  const user = getSessionUser(token);
  res.json({ ok: true, user: { id: user!.id, nome: user!.nome, email: user!.email, perfil: user!.perfil, empresaId: user!.empresaId, painelTv: user!.painelTv } });
});
app.post("/api/auth/logout", (req, res) => {
  const token = req.cookies?.sid;
  if (token) sqlite.prepare(`DELETE FROM sessions WHERE token = ?`).run(token);
  res.clearCookie("sid");
  res.json({ ok: true });
});
app.get("/api/auth/me", (req, res) => {
  const user = getSessionUser(req.cookies?.sid);
  if (!user) return res.status(401).json({ error: "Não autenticado." });
  let permissoes: Record<string, { visualizar: boolean; postar: boolean; editar: boolean }> = {};
  let configAbas: string[] | null = null; // null = sem restrição (vê todas)
  let paginasCliente: string[] | null = null; // null = sem restrição (cliente vê todas as próprias páginas)
  if (user.perfil === "Administrador") {
    for (const m of MODULOS) permissoes[m] = { visualizar: true, postar: true, editar: true };
  } else if (user.perfil === "Colaborador") {
    const rows = sqlite.prepare(`SELECT * FROM colaborador_permissoes WHERE user_id = ?`).all(user.id) as any[];
    for (const m of MODULOS) permissoes[m] = { visualizar: false, postar: false, editar: false };
    for (const r of rows) permissoes[r.modulo] = { visualizar: !!r.pode_visualizar, postar: !!r.pode_postar, editar: !!r.pode_editar };
    const abas = sqlite.prepare(`SELECT aba FROM colaborador_config_abas WHERE user_id = ?`).all(user.id) as any[];
    if (abas.length) configAbas = abas.map((a) => a.aba);
  } else if (user.perfil === "Cliente") {
    const paginas = sqlite.prepare(`SELECT pagina FROM cliente_paginas_visiveis WHERE user_id = ?`).all(user.id) as any[];
    if (paginas.length) paginasCliente = paginas.map((p) => p.pagina);
  }
  res.json({ user, permissoes, configAbas, paginasCliente });
});
app.get("/api/auth/minhas-empresas", requireAuth, (req, res) => {
  const user = (req as any).user;
  if (user.perfil !== "Cliente") return res.json({ items: [], empresaAtivaId: null });
  res.json({ items: clienteEmpresasDoUsuario(user.id), empresaAtivaId: user.empresaId });
});
app.post("/api/auth/empresa-ativa", requireAuth, (req, res) => {
  const user = (req as any).user;
  if (user.perfil !== "Cliente") return res.status(403).json({ error: "Só disponível para o perfil Cliente." });
  const empresaId = Number(req.body?.empresaId);
  const atribuidas = clienteEmpresasDoUsuario(user.id);
  if (!atribuidas.some((e) => e.id === empresaId)) return res.status(403).json({ error: "Você não tem acesso a essa empresa." });
  sqlite.prepare(`UPDATE sessions SET empresa_ativa_id = ? WHERE token = ?`).run(empresaId, req.cookies?.sid);
  res.json({ ok: true });
});
app.post("/api/auth/change-password", requireAuth, (req, res) => {
  const { senhaAtual, novaSenha } = req.body || {};
  const uid = (req as any).user.id;
  const row = sqlite.prepare(`SELECT * FROM app_users WHERE id = ?`).get(uid) as any;
  if (!row || !verifyPassword(senhaAtual || "", row.password_hash)) {
    return res.status(401).json({ error: "Senha atual incorreta." });
  }
  const pwError = passwordPolicyError(novaSenha);
  if (pwError) return res.status(400).json({ error: pwError });
  sqlite.prepare(`UPDATE app_users SET password_hash = ? WHERE id = ?`).run(hashPassword(novaSenha), uid);
  res.json({ ok: true });
});

app.use("/api", (req, res, next) => {
  if (req.path.startsWith("/auth/") || req.path === "/health" || req.path.startsWith("/dominio-agent/") || req.path === "/asaas/webhook" || req.path === "/whatsapp/webhook") return next();
  requireAuth(req, res, next);
});

// ---------- SuperAdmin: cadastro dos escritórios-cliente (dono do SaaS) ----------
app.get("/api/super/escritorios", requireSuperAdmin, (_req, res) => {
  const rows = sqlite
    .prepare(
      `SELECT id, nome, cnpj, email, telefone, empresa_id as empresaId, ativo, criado_em as criadoEm,
              (SELECT COUNT(*) FROM empresas e WHERE e.escritorio_id = escritorios.id) as totalEmpresas,
              (SELECT COUNT(*) FROM app_users u WHERE u.escritorio_id = escritorios.id) as totalUsuarios
       FROM escritorios ORDER BY nome`
    )
    .all() as any[];
  res.json({ items: rows.map((r) => ({ ...r, ativo: !!r.ativo })) });
});
app.post("/api/super/escritorios", requireSuperAdmin, (req, res) => {
  const { nome, cnpj, email, telefone } = req.body || {};
  if (!nome) return res.status(400).json({ error: "Informe o nome do escritório." });
  const agentToken = crypto.randomBytes(24).toString("hex");
  const info = sqlite
    .prepare(`INSERT INTO escritorios (nome, cnpj, email, telefone, agent_token, envio_rollover_ultimo_ano) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(nome, cnpj || null, email || null, telefone || null, agentToken, agoraBrasilia().ano);
  const escritorioId = Number(info.lastInsertRowid);
  // Empresa que representa o próprio escritório — "Contratada" nos contratos, prestador nas NFS-e.
  const empresaInfo = sqlite
    .prepare(`INSERT INTO empresas (nome, cnpj, email, telefone, origem, escritorio_id) VALUES (?, ?, ?, ?, 'manual', ?)`)
    .run(nome, cnpj || null, email || null, telefone || null, escritorioId);
  const empresaId = Number(empresaInfo.lastInsertRowid);
  sqlite.prepare(`UPDATE escritorios SET empresa_id = ? WHERE id = ?`).run(empresaId, escritorioId);
  garantirLinhasDeConfig(escritorioId);
  sqlite.prepare(`UPDATE nfse_agendamento_config SET empresa_prestador_id = ? WHERE escritorio_id = ?`).run(empresaId, escritorioId);
  res.json({ id: escritorioId });
});
app.put("/api/super/escritorios/:id/ativo", requireSuperAdmin, (req, res) => {
  const id = Number(req.params.id);
  const { ativo } = req.body || {};
  sqlite.prepare(`UPDATE escritorios SET ativo = ?, updated_at = datetime('now') WHERE id = ?`).run(ativo ? 1 : 0, id);
  res.json({ ok: true });
});
app.put("/api/super/escritorios/:id", requireSuperAdmin, (req, res) => {
  const id = Number(req.params.id);
  const existente = sqlite.prepare(`SELECT * FROM escritorios WHERE id = ?`).get(id) as any;
  if (!existente) return res.status(404).json({ error: "Escritório não encontrado." });
  const { nome, cnpj, email, telefone } = req.body || {};
  if (!nome) return res.status(400).json({ error: "Informe o nome do escritório." });
  sqlite
    .prepare(`UPDATE escritorios SET nome=?, cnpj=?, email=?, telefone=?, updated_at=datetime('now') WHERE id=?`)
    .run(nome, cnpj || null, email || null, telefone || null, id);
  // A empresa "Contratada" vinculada (prestador nas NFS-e, parte nos contratos) reflete os mesmos
  // dados — evita ficar com nome/CNPJ desatualizado lá depois de uma edição feita aqui.
  if (existente.empresa_id) {
    sqlite
      .prepare(`UPDATE empresas SET nome=?, cnpj=?, email=?, telefone=? WHERE id=?`)
      .run(nome, cnpj || null, email || null, telefone || null, existente.empresa_id);
  }
  res.json({ ok: true });
});
// Bootstrap do primeiro usuário de um escritório novo — sem isso, ninguém consegue logar nele pra
// criar os demais usuários pela tela normal de Usuários (que exige já ser Administrador do
// escritório). Só o SuperAdmin tem esse poder, e só entrega o essencial (Administrador full).
app.post("/api/super/escritorios/:id/administrador", requireSuperAdmin, (req, res) => {
  const escritorioId = Number(req.params.id);
  const escritorio = sqlite.prepare(`SELECT id FROM escritorios WHERE id = ?`).get(escritorioId);
  if (!escritorio) return res.status(404).json({ error: "Escritório não encontrado." });
  const { nome, email, password } = req.body || {};
  if (!nome || !email || !password) return res.status(400).json({ error: "Preencha nome, e-mail e senha." });
  const pwError = passwordPolicyError(password);
  if (pwError) return res.status(400).json({ error: pwError });
  try {
    const info = sqlite
      .prepare(`INSERT INTO app_users (nome, email, perfil, acesso_todas_empresas, password_hash, escritorio_id) VALUES (?, ?, 'Administrador', 1, ?, ?)`)
      .run(nome, String(email).trim().toLowerCase(), hashPassword(password), escritorioId);
    res.json({ id: Number(info.lastInsertRowid) });
  } catch (e: any) {
    if (String(e.message).includes("UNIQUE")) return res.status(409).json({ error: "Já existe um usuário com esse e-mail." });
    res.status(500).json({ error: e.message });
  }
});

// ---------- Usuários (Administrador cadastra Colaboradores e Clientes) ----------
app.get("/api/users", requireAdmin, (req, res) => {
  const user = (req as any).user;
  const rows = sqlite
    .prepare(
      `SELECT u.id, u.nome, u.email, u.perfil, u.empresa_id as empresaId, e.nome as empresaNome, u.telefone,
              u.acesso_todas_empresas as acessoTodasEmpresas, u.ativo, u.isento_assinatura as isentoAssinatura, u.painel_tv as painelTv, u.created_at as createdAt,
              (SELECT COUNT(*) FROM cliente_empresas ce WHERE ce.user_id = u.id) as totalEmpresas
       FROM app_users u LEFT JOIN empresas e ON e.id = u.empresa_id
       WHERE u.escritorio_id = ?
       ORDER BY u.perfil, u.nome`
    )
    .all(user.escritorioId);
  res.json({ items: rows });
});
app.post("/api/users", requireAdmin, (req, res) => {
  const user = (req as any).user;
  const { nome, email, perfil, password, acessoTodasEmpresas, painelTv, telefone } = req.body || {};
  if (!nome || !email || !perfil || !password) return res.status(400).json({ error: "Preencha nome, e-mail, perfil e senha." });
  if (!["Administrador", "Colaborador", "Cliente"].includes(perfil)) return res.status(400).json({ error: "Perfil inválido." });
  const pwError = passwordPolicyError(password);
  if (pwError) return res.status(400).json({ error: pwError });
  try {
    const info = sqlite
      .prepare(`INSERT INTO app_users (nome, email, perfil, acesso_todas_empresas, password_hash, escritorio_id, painel_tv, telefone) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        nome,
        String(email).trim().toLowerCase(),
        perfil,
        perfil === "Colaborador" ? (acessoTodasEmpresas === false ? 0 : 1) : 1,
        hashPassword(password),
        user.escritorioId,
        perfil === "Colaborador" && painelTv ? 1 : 0, // só faz sentido pra Colaborador — dono do Painel de TV não deve ser Administrador nem Cliente
        telefone ? String(telefone).trim() : null
      );
    const userId = Number(info.lastInsertRowid);
    if (perfil === "Colaborador") {
      for (const m of MODULOS) {
        sqlite
          .prepare(`INSERT INTO colaborador_permissoes (user_id, modulo, pode_visualizar, pode_postar, pode_editar) VALUES (?, ?, 0, 0, 0)`)
          .run(userId, m);
      }
    }
    res.json({ id: userId });
  } catch (e: any) {
    if (String(e.message).includes("UNIQUE")) return res.status(409).json({ error: "Já existe um usuário com esse e-mail." });
    res.status(500).json({ error: e.message });
  }
});
app.put("/api/users/:id", requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const existing = sqlite.prepare(`SELECT * FROM app_users WHERE id = ?`).get(id) as any;
  if (!existing || existing.escritorio_id !== (req as any).user.escritorioId) return res.status(404).json({ error: "Usuário não encontrado." });
  const { nome, email, password, ativo, acessoTodasEmpresas, isentoAssinatura, painelTv, telefone } = req.body || {};
  if (password) {
    const pwError = passwordPolicyError(password);
    if (pwError) return res.status(400).json({ error: pwError });
  }
  const newHash = password ? hashPassword(password) : existing.password_hash;
  // Só faz sentido pra Colaborador — perfil não muda aqui, então basta olhar o que já está gravado.
  const novoPainelTv = existing.perfil === "Colaborador" && painelTv !== undefined ? (painelTv ? 1 : 0) : existing.painel_tv;
  try {
    sqlite
      .prepare(`UPDATE app_users SET nome=?, email=?, password_hash=?, ativo=?, acesso_todas_empresas=?, isento_assinatura=?, painel_tv=?, telefone=? WHERE id=?`)
      .run(
        nome ?? existing.nome,
        email ? String(email).trim().toLowerCase() : existing.email,
        newHash,
        ativo === undefined ? existing.ativo : ativo ? 1 : 0,
        acessoTodasEmpresas !== undefined ? (acessoTodasEmpresas ? 1 : 0) : existing.acesso_todas_empresas,
        isentoAssinatura !== undefined ? (isentoAssinatura ? 1 : 0) : existing.isento_assinatura,
        novoPainelTv,
        telefone !== undefined ? (telefone ? String(telefone).trim() : null) : existing.telefone,
        id
      );
    // Painel de TV usa sessão de vida longa — se acabou de virar (ou deixar de ser) painel_tv, ou se
    // ficou inativo, derruba a sessão atual pra ela ser recriada com a duração certa no próximo login.
    if (ativo === false || novoPainelTv !== existing.painel_tv) sqlite.prepare(`DELETE FROM sessions WHERE user_id = ?`).run(id);
    res.json({ ok: true });
  } catch (e: any) {
    if (String(e.message).includes("UNIQUE")) return res.status(409).json({ error: "Já existe um usuário com esse e-mail." });
    res.status(500).json({ error: e.message });
  }
});
app.delete("/api/users/:id", requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const existing = sqlite.prepare(`SELECT escritorio_id FROM app_users WHERE id = ?`).get(id) as any;
  if (!existing || existing.escritorio_id !== (req as any).user.escritorioId) return res.status(404).json({ error: "Usuário não encontrado." });
  sqlite.prepare(`DELETE FROM sessions WHERE user_id = ?`).run(id);
  sqlite.prepare(`DELETE FROM app_users WHERE id = ?`).run(id);
  res.json({ id });
});
function pertenceAoEscritorio(req: express.Request, userId: number): boolean {
  const row = sqlite.prepare(`SELECT escritorio_id FROM app_users WHERE id = ?`).get(userId) as any;
  return !!row && row.escritorio_id === (req as any).user.escritorioId;
}
app.get("/api/users/:id/permissoes", requireAdmin, (req, res) => {
  if (!pertenceAoEscritorio(req, Number(req.params.id))) return res.status(404).json({ error: "Usuário não encontrado." });
  const rows = sqlite.prepare(`SELECT * FROM colaborador_permissoes WHERE user_id = ?`).all(Number(req.params.id));
  res.json({ items: rows });
});
app.put("/api/users/:id/permissoes", requireAdmin, (req, res) => {
  const userId = Number(req.params.id);
  if (!pertenceAoEscritorio(req, userId)) return res.status(404).json({ error: "Usuário não encontrado." });
  const permissoes = req.body?.permissoes || {};
  const stmt = sqlite.prepare(
    `INSERT INTO colaborador_permissoes (user_id, modulo, pode_visualizar, pode_postar, pode_editar) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(user_id, modulo) DO UPDATE SET pode_visualizar=excluded.pode_visualizar, pode_postar=excluded.pode_postar, pode_editar=excluded.pode_editar`
  );
  for (const m of MODULOS) {
    const p = permissoes[m] || {};
    stmt.run(userId, m, p.visualizar ? 1 : 0, p.postar ? 1 : 0, p.editar ? 1 : 0);
  }
  res.json({ ok: true });
});
const CONFIG_ABAS_VALIDAS = ["dominio", "email", "whatsapp", "fgts-digital", "nfse-agendamento", "assinatura-plataforma"];
app.get("/api/users/:id/config-abas", requireAdmin, (req, res) => {
  if (!pertenceAoEscritorio(req, Number(req.params.id))) return res.status(404).json({ error: "Usuário não encontrado." });
  const rows = sqlite.prepare(`SELECT aba FROM colaborador_config_abas WHERE user_id = ?`).all(Number(req.params.id)) as any[];
  res.json({ abas: rows.map((r) => r.aba) });
});
// Body { abas: [...] } vazio ou omitido = sem restrição (colaborador vê todas as abas de
// Configurações) — só grava linhas quando o admin explicitamente restringe a algumas.
app.put("/api/users/:id/config-abas", requireAdmin, (req, res) => {
  const userId = Number(req.params.id);
  if (!pertenceAoEscritorio(req, userId)) return res.status(404).json({ error: "Usuário não encontrado." });
  const abas: string[] = Array.isArray(req.body?.abas) ? req.body.abas.filter((a: string) => CONFIG_ABAS_VALIDAS.includes(a)) : [];
  sqlite.prepare(`DELETE FROM colaborador_config_abas WHERE user_id = ?`).run(userId);
  const stmt = sqlite.prepare(`INSERT INTO colaborador_config_abas (user_id, aba) VALUES (?, ?)`);
  for (const aba of abas) stmt.run(userId, aba);
  res.json({ ok: true });
});
const PAGINAS_CLIENTE_VALIDAS = ["minha-nfse", "meus-documentos", "solicitar-documentos", "documentos-recebidos", "minha-financeiro", "minha-assinatura", "notas-entrada"];
app.get("/api/users/:id/paginas-cliente", requireAdmin, (req, res) => {
  if (!pertenceAoEscritorio(req, Number(req.params.id))) return res.status(404).json({ error: "Usuário não encontrado." });
  const rows = sqlite.prepare(`SELECT pagina FROM cliente_paginas_visiveis WHERE user_id = ?`).all(Number(req.params.id)) as any[];
  res.json({ paginas: rows.map((r) => r.pagina) });
});
// Body { paginas: [...] } vazio ou omitido = sem restrição (cliente vê todas as próprias páginas)
// — só grava linhas quando o admin explicitamente restringe a algumas.
app.put("/api/users/:id/paginas-cliente", requireAdmin, (req, res) => {
  const userId = Number(req.params.id);
  if (!pertenceAoEscritorio(req, userId)) return res.status(404).json({ error: "Usuário não encontrado." });
  const paginas: string[] = Array.isArray(req.body?.paginas) ? req.body.paginas.filter((p: string) => PAGINAS_CLIENTE_VALIDAS.includes(p)) : [];
  sqlite.prepare(`DELETE FROM cliente_paginas_visiveis WHERE user_id = ?`).run(userId);
  const stmt = sqlite.prepare(`INSERT INTO cliente_paginas_visiveis (user_id, pagina) VALUES (?, ?)`);
  for (const pagina of paginas) stmt.run(userId, pagina);
  res.json({ ok: true });
});
// Empresas vinculadas a um usuário — pra Colaborador é a lista de acesso restrito (só relevante
// quando acesso_todas_empresas=0); pra Cliente é a lista de empresas que ele pode operar (pode ter
// mais de uma, trocando qual está ativa pela barra lateral — ver /api/auth/empresa-ativa).
app.get("/api/users/:id/empresas", requireAdmin, (req, res) => {
  const userId = Number(req.params.id);
  const user = sqlite.prepare(`SELECT perfil, escritorio_id FROM app_users WHERE id = ?`).get(userId) as any;
  if (!user || user.escritorio_id !== (req as any).user.escritorioId) return res.status(404).json({ error: "Usuário não encontrado." });
  const tabela = user.perfil === "Cliente" ? "cliente_empresas" : "colaborador_empresas";
  const rows = sqlite.prepare(`SELECT empresa_id as empresaId FROM ${tabela} WHERE user_id = ?`).all(userId) as any[];
  res.json({ empresaIds: rows.map((r) => r.empresaId) });
});
app.put("/api/users/:id/empresas", requireAdmin, (req, res) => {
  const userId = Number(req.params.id);
  const user = sqlite.prepare(`SELECT perfil, escritorio_id FROM app_users WHERE id = ?`).get(userId) as any;
  if (!user || user.escritorio_id !== (req as any).user.escritorioId) return res.status(404).json({ error: "Usuário não encontrado." });
  const tabela = user.perfil === "Cliente" ? "cliente_empresas" : "colaborador_empresas";
  const pedidos: number[] = Array.isArray(req.body?.empresaIds) ? req.body.empresaIds.map(Number) : [];
  const doEscritorio = new Set(
    (sqlite.prepare(`SELECT id FROM empresas WHERE escritorio_id = ?`).all((req as any).user.escritorioId) as any[]).map((r) => r.id)
  );
  const empresaIds = pedidos.filter((eid) => doEscritorio.has(eid));
  sqlite.prepare(`DELETE FROM ${tabela} WHERE user_id = ?`).run(userId);
  const stmt = sqlite.prepare(`INSERT INTO ${tabela} (user_id, empresa_id) VALUES (?, ?)`);
  for (const eid of empresaIds) stmt.run(userId, eid);
  if (user.perfil === "Cliente") {
    // empresa_id na própria app_users vira só um valor de exibição legado (a fonte da verdade é
    // cliente_empresas) — mantém a primeira escolhida, ou null se a lista ficou vazia.
    sqlite.prepare(`UPDATE app_users SET empresa_id = ? WHERE id = ?`).run(empresaIds[0] ?? null, userId);
  }
  res.json({ ok: true });
});

// ---------- Empresas (clientes do escritório) ----------
app.get("/api/empresas", blockCliente, requirePermissao("empresas", "visualizar"), (req, res) => {
  const user = (req as any).user;
  const visiveis = empresasVisiveis(user);
  let rows = sqlite
    .prepare(
      `SELECT e.*, c.opcao_simples_nacional as opcao_simples_nacional_nfse, c.regime_apuracao_sn as regime_apuracao_sn_nfse, c.percentual_total_tributos_sn as percentual_total_tributos_sn_nfse
       FROM empresas e LEFT JOIN nfse_empresa_config c ON c.empresa_id = e.id ORDER BY e.nome`
    )
    .all() as any[];
  if (visiveis !== null) rows = rows.filter((r) => visiveis.includes(r.id));
  res.json({
    items: rows.map((r) => ({
      id: r.id,
      nome: r.nome,
      cnpj: r.cnpj,
      codigoDominio: r.codigo_dominio,
      apelido: r.apelido,
      email: r.email,
      telefone: r.telefone,
      endereco: r.endereco,
      cidade: r.cidade,
      uf: r.uf,
      cep: r.cep,
      inscricaoMunicipal: r.inscricao_municipal,
      inscricaoEstadual: r.inscricao_estadual,
      nomeRepresentanteLegal: r.nome_representante_legal,
      cpfRepresentanteLegal: r.cpf_representante_legal,
      codigoMunicipioIbge: r.codigo_municipio_ibge,
      nomeMunicipioIbge: r.nome_municipio_ibge,
      regimeTributario: r.regime_tributario || "simples_nacional",
      regimeApuracaoSn: r.regime_apuracao_sn_nfse || "1",
      percentualTotalTributosSn: r.percentual_total_tributos_sn_nfse,
      ativo: !!r.ativo,
      visivelRelatorios: !!r.visivel_relatorios,
      isentoAssinatura: !!r.isento_assinatura,
      buscaFgts: !!r.busca_fgts,
      fgtsUltimaBuscaEm: r.fgts_ultima_busca_em,
      fgtsUltimoErro: r.fgts_ultimo_erro,
      origem: r.origem,
      createdAt: r.created_at,
      temAnexos: empresaTemAnexos(r.id),
    })),
  });
});
// Preenche o formulário de cadastro/edição de empresa a partir do CNPJ digitado — mesma consulta
// pública (BrasilAPI/Receita Federal) já usada na emissão de NFS-e, só que sob o módulo "empresas"
// (o de NFS-e exige a permissão de NFS-e, que nem todo Colaborador que cadastra empresa tem).
app.get("/api/empresas/cnpj/:cnpj", blockCliente, requirePermissao("empresas", "visualizar"), async (req, res) => {
  const cnpj = String(req.params.cnpj).replace(/\D/g, "");
  if (cnpj.length !== 14) return res.status(400).json({ error: "CNPJ inválido — precisa ter 14 dígitos." });
  try {
    const dados = await consultarCnpjBrasilApi(cnpj);
    if (dados.notFound) return res.status(404).json({ error: "CNPJ não encontrado na Receita Federal." });
    res.json(dados);
  } catch (e: any) {
    res.status(502).json({ error: `Não consegui consultar o CNPJ: ${e.message}` });
  }
});
const REGIMES_TRIBUTARIOS = ["simples_nacional", "lucro_presumido", "lucro_real"] as const;
// Modelo de Envio de Documentos com "auto_regime_tributario" configurado (ex.: DARF IRPJ/CSLL só
// se aplica a Lucro Real) ganha atribuição sozinho assim que a empresa é classificada nesse regime
// — chamado toda vez que o regime é salvo (cadastro novo ou edição), idempotente via UNIQUE(template_id,
// empresa_id) do INSERT OR IGNORE, então não recria nem duplica se já existir.
function envioAutoAtribuirPorRegime(empresaId: number, escritorioId: number, regimeTributario: string) {
  const templates = sqlite.prepare(`SELECT id FROM envio_templates WHERE escritorio_id = ? AND auto_regime_tributario = ?`).all(escritorioId, regimeTributario) as any[];
  for (const t of templates) {
    sqlite.prepare(`INSERT OR IGNORE INTO envio_atribuicoes (template_id, empresa_id) VALUES (?, ?)`).run(t.id, empresaId);
  }
}
app.post("/api/empresas", blockCliente, requirePermissao("empresas", "postar"), (req, res) => {
  const user = (req as any).user;
  const { nome, cnpj, codigoDominio, apelido, email, telefone, endereco, cidade, uf, cep, inscricaoMunicipal, inscricaoEstadual, nomeRepresentanteLegal, cpfRepresentanteLegal, codigoMunicipioIbge, nomeMunicipioIbge, regimeTributario } = req.body || {};
  if (!nome) return res.status(400).json({ error: "Informe o nome da empresa." });
  const info = sqlite
    .prepare(
      `INSERT INTO empresas (nome, cnpj, codigo_dominio, apelido, email, telefone, endereco, cidade, uf, cep, inscricao_municipal, inscricao_estadual, nome_representante_legal, cpf_representante_legal, codigo_municipio_ibge, nome_municipio_ibge, regime_tributario, origem, escritorio_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'manual', ?)`
    )
    .run(
      nome,
      cnpj || null,
      codigoDominio || null,
      apelido || null,
      email || null,
      telefone || null,
      endereco || null,
      cidade || null,
      uf || null,
      cep || null,
      inscricaoMunicipal || null,
      inscricaoEstadual || null,
      nomeRepresentanteLegal || null,
      cpfRepresentanteLegal || null,
      codigoMunicipioIbge || null,
      nomeMunicipioIbge || null,
      (REGIMES_TRIBUTARIOS as readonly string[]).includes(regimeTributario) ? regimeTributario : "simples_nacional",
      user.escritorioId
    );
  const novaEmpresaId = Number(info.lastInsertRowid);
  envioAutoAtribuirPorRegime(novaEmpresaId, user.escritorioId, (REGIMES_TRIBUTARIOS as readonly string[]).includes(regimeTributario) ? regimeTributario : "simples_nacional");
  res.json({ id: novaEmpresaId });
});
// Regime de apuração / % total de tributos são fiscais mas vivem na aba Configurações do cadastro
// de empresa (junto do resto), não no módulo NFS-e — evita pedir a mesma informação em dois
// lugares. opcaoSimplesNacional nunca é editado à parte — é sempre derivado do regime_tributario
// que acabou de ser salvo em `empresas` (Simples Nacional/Lucro Presumido/Lucro Real são
// mutuamente exclusivos, então não faz sentido guardar os dois fatos separados e arriscar
// divergência). Upsert parcial: nunca mexe em habilitado/metodo_assinatura (que continuam só na
// config do NFS-e), então funciona tanto pra empresa que já tem linha em nfse_empresa_config
// quanto pra uma que nunca configurou NFS-e ainda (fica com os defaults da tabela até habilitar
// por lá).
function empresaSalvarDadosFiscaisNfse(empresaId: number, opcaoSimplesNacional: boolean, body: any) {
  const { regimeApuracaoSn, percentualTotalTributosSn } = body || {};
  sqlite
    .prepare(
      `INSERT INTO nfse_empresa_config (empresa_id, opcao_simples_nacional, regime_apuracao_sn, percentual_total_tributos_sn, updated_at)
       VALUES (?, ?, ?, ?, datetime('now'))
       ON CONFLICT(empresa_id) DO UPDATE SET opcao_simples_nacional=excluded.opcao_simples_nacional,
         regime_apuracao_sn=excluded.regime_apuracao_sn, percentual_total_tributos_sn=excluded.percentual_total_tributos_sn, updated_at=datetime('now')`
    )
    .run(
      empresaId,
      opcaoSimplesNacional ? 1 : 0,
      ["1", "2", "3"].includes(regimeApuracaoSn) ? regimeApuracaoSn : "1",
      percentualTotalTributosSn != null && percentualTotalTributosSn !== "" ? Number(percentualTotalTributosSn) : null
    );
}
app.put("/api/empresas/:id", blockCliente, requirePermissao("empresas", "editar"), (req, res) => {
  const id = Number(req.params.id);
  const existing = sqlite.prepare(`SELECT * FROM empresas WHERE id = ?`).get(id) as any;
  if (!existing || !podeAcessarEmpresa((req as any).user, id)) return res.status(404).json({ error: "Empresa não encontrada." });
  const { nome, cnpj, codigoDominio, apelido, email, telefone, endereco, cidade, uf, cep, inscricaoMunicipal, inscricaoEstadual, nomeRepresentanteLegal, cpfRepresentanteLegal, codigoMunicipioIbge, nomeMunicipioIbge, regimeTributario, ativo, visivelRelatorios, isentoAssinatura, buscaFgts } = req.body || {};
  const regimeTributarioFinal =
    regimeTributario !== undefined
      ? ((REGIMES_TRIBUTARIOS as readonly string[]).includes(regimeTributario) ? regimeTributario : "simples_nacional")
      : existing.regime_tributario;
  sqlite
    .prepare(
      `UPDATE empresas SET nome=?, cnpj=?, codigo_dominio=?, apelido=?, email=?, telefone=?, endereco=?, cidade=?, uf=?, cep=?, inscricao_municipal=?, inscricao_estadual=?,
         nome_representante_legal=?, cpf_representante_legal=?, codigo_municipio_ibge=?, nome_municipio_ibge=?, regime_tributario=?, ativo=?, visivel_relatorios=?, isento_assinatura=?, busca_fgts=?, updated_at=datetime('now') WHERE id=?`
    )
    .run(
      nome ?? existing.nome,
      cnpj !== undefined ? cnpj : existing.cnpj,
      codigoDominio !== undefined ? codigoDominio : existing.codigo_dominio,
      apelido !== undefined ? apelido : existing.apelido,
      email !== undefined ? email : existing.email,
      telefone !== undefined ? telefone : existing.telefone,
      endereco !== undefined ? endereco : existing.endereco,
      cidade !== undefined ? cidade : existing.cidade,
      uf !== undefined ? uf : existing.uf,
      cep !== undefined ? cep : existing.cep,
      inscricaoMunicipal !== undefined ? inscricaoMunicipal : existing.inscricao_municipal,
      inscricaoEstadual !== undefined ? inscricaoEstadual : existing.inscricao_estadual,
      nomeRepresentanteLegal !== undefined ? nomeRepresentanteLegal : existing.nome_representante_legal,
      cpfRepresentanteLegal !== undefined ? cpfRepresentanteLegal : existing.cpf_representante_legal,
      codigoMunicipioIbge !== undefined ? codigoMunicipioIbge : existing.codigo_municipio_ibge,
      nomeMunicipioIbge !== undefined ? nomeMunicipioIbge : existing.nome_municipio_ibge,
      regimeTributarioFinal,
      ativo === undefined ? existing.ativo : ativo ? 1 : 0,
      visivelRelatorios === undefined ? existing.visivel_relatorios : visivelRelatorios ? 1 : 0,
      isentoAssinatura === undefined ? existing.isento_assinatura : isentoAssinatura ? 1 : 0,
      buscaFgts === undefined ? existing.busca_fgts : buscaFgts ? 1 : 0,
      id
    );
  if (regimeTributario !== undefined || req.body.regimeApuracaoSn !== undefined || req.body.percentualTotalTributosSn !== undefined) {
    empresaSalvarDadosFiscaisNfse(id, regimeTributarioFinal === "simples_nacional", req.body);
  }
  if (regimeTributario !== undefined) envioAutoAtribuirPorRegime(id, (req as any).user.escritorioId, regimeTributarioFinal);
  res.json({ ok: true });
});
app.delete("/api/empresas/:id", requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  if (!podeAcessarEmpresa((req as any).user, id)) return res.status(404).json({ error: "Empresa não encontrada." });
  if (empresaTemAnexos(id)) {
    return res.status(409).json({ error: "Esta empresa já tem documentos anexados e não pode ser excluída. Use \"Inativar\" em vez disso." });
  }
  sqlite.prepare(`DELETE FROM empresas WHERE id = ?`).run(id);
  res.json({ id });
});
app.get("/api/empresas/:id/contatos", blockCliente, requirePermissao("empresas", "visualizar"), (req, res) => {
  if (!podeAcessarEmpresa((req as any).user, Number(req.params.id))) return res.status(404).json({ error: "Empresa não encontrada." });
  const rows = sqlite.prepare(`SELECT * FROM empresa_contatos WHERE empresa_id = ? ORDER BY nome`).all(Number(req.params.id));
  res.json({ items: rows });
});
app.post("/api/empresas/:id/contatos", blockCliente, requirePermissao("empresas", "editar"), (req, res) => {
  const empresaId = Number(req.params.id);
  if (!podeAcessarEmpresa((req as any).user, empresaId)) return res.status(404).json({ error: "Empresa não encontrada." });
  const { nome, email, receberEmails, telefone, receberWhatsapp } = req.body || {};
  if (!nome || !email) return res.status(400).json({ error: "Informe nome e e-mail do contato." });
  const info = sqlite
    .prepare(`INSERT INTO empresa_contatos (empresa_id, nome, email, receber_emails, telefone, receber_whatsapp) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(empresaId, nome, email, receberEmails === false ? 0 : 1, telefone || null, receberWhatsapp ? 1 : 0);
  res.json({ id: Number(info.lastInsertRowid) });
});
app.put("/api/empresas/contatos/:contatoId", blockCliente, requirePermissao("empresas", "editar"), (req, res) => {
  const contato = sqlite.prepare(`SELECT empresa_id FROM empresa_contatos WHERE id = ?`).get(Number(req.params.contatoId)) as any;
  if (!contato || !podeAcessarEmpresa((req as any).user, contato.empresa_id)) return res.status(404).json({ error: "Contato não encontrado." });
  const { nome, email, receberEmails, telefone, receberWhatsapp } = req.body || {};
  if (!nome || !email) return res.status(400).json({ error: "Informe nome e e-mail do contato." });
  sqlite
    .prepare(`UPDATE empresa_contatos SET nome=?, email=?, receber_emails=?, telefone=?, receber_whatsapp=? WHERE id=?`)
    .run(nome, email, receberEmails === false ? 0 : 1, telefone || null, receberWhatsapp ? 1 : 0, Number(req.params.contatoId));
  res.json({ ok: true });
});
app.delete("/api/empresas/contatos/:contatoId", blockCliente, requirePermissao("empresas", "editar"), (req, res) => {
  const contato = sqlite.prepare(`SELECT empresa_id FROM empresa_contatos WHERE id = ?`).get(Number(req.params.contatoId)) as any;
  if (!contato || !podeAcessarEmpresa((req as any).user, contato.empresa_id)) return res.status(404).json({ error: "Contato não encontrado." });
  sqlite.prepare(`DELETE FROM empresa_contatos WHERE id = ?`).run(Number(req.params.contatoId));
  res.json({ ok: true });
});
// Lista os IDs de empresa que já têm pelo menos 1 contato cadastrado (e-mail ou WhatsApp) — usado
// pela tela "Contatos e documentos por cliente" pra separar em abas "Configuradas" x "Faltam
// configurar" sem precisar de 1 chamada por empresa (uma única consulta agregada).
app.get("/api/empresas/contatos-resumo", blockCliente, requirePermissao("empresas", "visualizar"), (req, res) => {
  const user = (req as any).user;
  const visiveis = empresasVisiveis(user);
  let ids = (sqlite.prepare(`SELECT DISTINCT empresa_id FROM empresa_contatos`).all() as any[]).map((r) => r.empresa_id);
  if (visiveis !== null) ids = ids.filter((id) => visiveis.includes(id));
  res.json({ comContato: ids });
});

// ---- O que cada empresa pode pedir em "Solicitar Documentos" ----
const EMPRESA_SOLICITACAO_TIPOS_FIXOS = ["recalculo_das", "parcelamento_das", "retencoes"];
// Sem NENHUMA linha pra essa empresa = sem restrição (pode solicitar tudo) — mesmo default seguro de
// cliente_paginas_visiveis. Só passa a restringir quando o admin marca algo de propósito.
function empresaPodeSolicitar(empresaId: number, chave: string): boolean {
  const alguma = sqlite.prepare(`SELECT 1 FROM empresa_solicitacao_tipos WHERE empresa_id = ? LIMIT 1`).get(empresaId);
  if (!alguma) return true;
  const marcado = sqlite.prepare(`SELECT 1 FROM empresa_solicitacao_tipos WHERE empresa_id = ? AND chave = ?`).get(empresaId, chave);
  return !!marcado;
}
app.get("/api/empresas/:id/solicitacao-tipos", blockCliente, requirePermissao("empresas", "visualizar"), (req, res) => {
  const empresaId = Number(req.params.id);
  if (!podeAcessarEmpresa((req as any).user, empresaId)) return res.status(404).json({ error: "Empresa não encontrada." });
  const rows = sqlite.prepare(`SELECT chave FROM empresa_solicitacao_tipos WHERE empresa_id = ?`).all(empresaId) as any[];
  res.json({ chaves: rows.map((r) => r.chave) });
});
// Body { chaves: [...] } vazio/omitido = sem restrição. 'recalculo_das'/'parcelamento_das' são sempre
// válidos; 'template:<id>' só é aceito se apontar pra um envio_templates ATIVO, VISÍVEL AO CLIENTE e
// DO MESMO ESCRITÓRIO da empresa — nunca aceita template de outro escritório.
app.put("/api/empresas/:id/solicitacao-tipos", blockCliente, requirePermissao("empresas", "editar"), (req, res) => {
  const empresaId = Number(req.params.id);
  const user = (req as any).user;
  const empresa = sqlite.prepare(`SELECT id, escritorio_id FROM empresas WHERE id = ?`).get(empresaId) as any;
  if (!empresa || !podeAcessarEmpresa(user, empresaId)) return res.status(404).json({ error: "Empresa não encontrada." });
  const recebidas: string[] = Array.isArray(req.body?.chaves) ? req.body.chaves : [];
  const chavesValidas = recebidas.filter((chave) => {
    if (EMPRESA_SOLICITACAO_TIPOS_FIXOS.includes(chave)) return true;
    const m = /^template:(\d+)$/.exec(chave);
    if (!m) return false;
    return !!sqlite.prepare(`SELECT 1 FROM envio_templates WHERE id = ? AND escritorio_id = ? AND ativo = 1 AND visivel_cliente = 1`).get(Number(m[1]), empresa.escritorio_id);
  });
  sqlite.prepare(`DELETE FROM empresa_solicitacao_tipos WHERE empresa_id = ?`).run(empresaId);
  const stmt = sqlite.prepare(`INSERT INTO empresa_solicitacao_tipos (empresa_id, chave) VALUES (?, ?)`);
  for (const chave of chavesValidas) stmt.run(empresaId, chave);
  res.json({ ok: true });
});

// ---- Anexos do cadastro (Constituição/Licenças) ----
const EMPRESA_ANEXO_TIPOS: Record<string, { categoria: string; label: string }> = {
  contrato_social: { categoria: "constituicao", label: "Contrato Social / Alteração" },
  cartao_cnpj: { categoria: "constituicao", label: "Cartão CNPJ" },
  outros_documentos: { categoria: "constituicao", label: "Outros Documentos" },
  alvara: { categoria: "licenca", label: "Licença de Alvará" },
  vigilancia_sanitaria: { categoria: "licenca", label: "Licença Vigilância Sanitária" },
  corpo_bombeiros: { categoria: "licenca", label: "Licença Corpo de Bombeiros" },
  ambiental_semma: { categoria: "licenca", label: "Licença Ambiental - SEMMA" },
};
// Tipos de licença cadastrados à mão (tabela empresa_licenca_tipos), além dos fixos acima. Sempre
// categoria 'licenca'. Com empresaId: só os compartilhados (empresa_id NULL) + os dessa empresa
// específica — é o que a aba Licenças de UMA empresa deve enxergar. Sem empresaId: todos do
// escritório (usado pela carga em lote, que precisa ver tipo de qualquer empresa pra classificar
// os PDFs antes de saber a quem pertencem).
function licencaTiposCustom(escritorioId: number, empresaId?: number | null): { chave: string; label: string }[] {
  if (empresaId != null) {
    return sqlite
      .prepare(`SELECT chave, label FROM empresa_licenca_tipos WHERE escritorio_id = ? AND (empresa_id IS NULL OR empresa_id = ?) ORDER BY label COLLATE NOCASE`)
      .all(escritorioId, empresaId) as any[];
  }
  return sqlite
    .prepare(`SELECT chave, label FROM empresa_licenca_tipos WHERE escritorio_id = ? ORDER BY label COLLATE NOCASE`)
    .all(escritorioId) as any[];
}
// Resolve um tipo de anexo (fixo ou licença custom do escritório) — mesma forma de EMPRESA_ANEXO_TIPOS,
// devolve null quando não existe.
function resolverTipoAnexo(escritorioId: number, tipo: string): { categoria: string; label: string } | null {
  if (EMPRESA_ANEXO_TIPOS[tipo]) return EMPRESA_ANEXO_TIPOS[tipo];
  const custom = sqlite.prepare(`SELECT label FROM empresa_licenca_tipos WHERE escritorio_id = ? AND chave = ?`).get(escritorioId, tipo) as any;
  return custom ? { categoria: "licenca", label: custom.label } : null;
}
function rotuloTipoAnexo(escritorioId: number, tipo: string): string {
  return resolverTipoAnexo(escritorioId, tipo)?.label || tipo;
}
// Tenta achar a data de validade dentro do PDF (só funciona pra licença — contrato social/cartão
// CNPJ não têm vencimento). Heurística, não mágica: procura um padrão de data (DD/MM/AAAA) perto de
// uma palavra-chave típica de licença ("validade", "vencimento", "válido até" etc.). Sempre fica
// editável na hora — se errar ou não achar, o usuário corrige na mão, nunca trava o upload por
// causa disso.
// Texto de um PDF: tenta a camada de texto embutida primeiro (rápido, cobre a grande maioria dos
// casos — PDFs gerados digitalmente por prefeitura/corpo de bombeiros/vigilância sanitária etc.).
// Quando não tem texto nenhum (PDF escaneado num scanner de mesa, sem camada de texto — visto na
// prática com licenças da SEMMA), cai pro OCR (ver src/ocr.ts) como fallback antes de desistir.
async function obterTextoDoPdf(buf: Buffer): Promise<string> {
  try {
    const pdfParseLib = require("pdf-parse");
    const data = await pdfParseLib(new Uint8Array(buf));
    const texto: string = data.text || "";
    if (texto.trim().length >= 20) return texto;
  } catch {
    // segue pro fallback de OCR
  }
  try {
    return await ocr.ocrPrimeiraPagina(buf);
  } catch {
    return "";
  }
}
function extrairVencimentoDoTexto(texto: string): string | null {
  const regexPalavraChave = /(validade|vencimento|v[aá]lid[ao]\s+at[eé]|vence\s+em|data\s+de\s+validade)/gi;
  const regexData = /(\d{2})[\/\-.](\d{2})[\/\-.](\d{4})/g;
  const JANELA = 60;
  let m: RegExpExecArray | null;
  while ((m = regexPalavraChave.exec(texto))) {
    // A ordem do texto extraído do PDF (ou do OCR) segue o fluxo interno do arquivo, não
    // necessariamente a posição visual — em vários modelos (ex.: Alvará Digital de prefeitura) a
    // data sai ANTES do rótulo "VALIDADE", não depois. Por isso a janela olha os dois lados e fica
    // com a data mais próxima da palavra-chave, em vez de só procurar pra frente.
    const inicioJanela = Math.max(0, m.index - JANELA);
    const fimJanela = m.index + m[0].length + JANELA;
    const trecho = texto.slice(inicioJanela, fimJanela);
    regexData.lastIndex = 0;
    let dm: RegExpExecArray | null;
    let melhor: { iso: string; distancia: number } | null = null;
    while ((dm = regexData.exec(trecho))) {
      const [, dia, mes, ano] = dm;
      const diaN = Number(dia), mesN = Number(mes), anoN = Number(ano);
      if (diaN >= 1 && diaN <= 31 && mesN >= 1 && mesN <= 12 && anoN >= 2000 && anoN <= 2100) {
        const posAbsoluta = inicioJanela + dm.index;
        const distancia = Math.abs(posAbsoluta - m.index);
        if (!melhor || distancia < melhor.distancia) melhor = { iso: `${ano}-${mes}-${dia}`, distancia };
      }
    }
    if (melhor) return melhor.iso;
  }
  return null;
}
async function extrairVencimentoDeAnexo(buf: Buffer, mime: string | undefined): Promise<string | null> {
  if (mime !== "application/pdf") return null;
  const texto = await obterTextoDoPdf(buf);
  return extrairVencimentoDoTexto(texto);
}
// Anos disponíveis na aba Licenças — um só lugar, compartilhado por todas as empresas do escritório
// (o layout ano→tipo é o mesmo pra qualquer uma), não precisa cadastrar ano por empresa.
app.get("/api/empresas/licenca-anos", blockCliente, requirePermissaoOr("empresas", "licencas", "visualizar"), (req, res) => {
  const user = (req as any).user;
  const rows = sqlite.prepare(`SELECT ano FROM empresa_licenca_anos WHERE escritorio_id = ? ORDER BY ano DESC`).all(user.escritorioId) as any[];
  res.json({ anos: rows.map((r) => r.ano) });
});
app.post("/api/empresas/licenca-anos", blockCliente, requirePermissaoOr("empresas", "licencas", "editar"), (req, res) => {
  const user = (req as any).user;
  const ano = Number(req.body?.ano);
  if (!Number.isInteger(ano) || ano < 2000 || ano > 2100) return res.status(400).json({ error: "Ano inválido." });
  sqlite.prepare(`INSERT OR IGNORE INTO empresa_licenca_anos (escritorio_id, ano) VALUES (?, ?)`).run(user.escritorioId, ano);
  res.json({ ok: true });
});

// Tipos de licença da aba Licenças — os 4 fixos + os que o escritório cadastrar aqui. Mesma ideia
// de licenca-anos: cadastrou uma vez, vale pra todas as empresas.
const LICENCA_TIPOS_FIXOS = Object.entries(EMPRESA_ANEXO_TIPOS)
  .filter(([, info]) => info.categoria === "licenca")
  .map(([chave, info]) => ({ chave, label: info.label, fixo: true }));
// ?empresaId=: só os tipos que ESSA empresa enxerga (compartilhados + dela). Sem empresaId: todos do
// escritório (carga em lote — ver licencaTiposCustom).
app.get("/api/empresas/licenca-tipos", blockCliente, requirePermissaoOr("empresas", "licencas", "visualizar"), (req, res) => {
  const user = (req as any).user;
  const empresaId = req.query.empresaId ? Number(req.query.empresaId) : null;
  if (empresaId != null && !podeAcessarEmpresa(user, empresaId)) return res.status(403).json({ error: "Sem acesso a esta empresa." });
  const custom = licencaTiposCustom(user.escritorioId, empresaId).map((t) => ({ ...t, fixo: false }));
  res.json({ tipos: [...LICENCA_TIPOS_FIXOS, ...custom] });
});
// Criado sempre a partir da aba Licenças de UMA empresa (a carga em lote não cria tipo, só usa os
// que já existem) — por isso empresaId é obrigatório, e o tipo nasce escopado só a ela (achado ao
// vivo: antes nascia compartilhado com o escritório inteiro sem a pessoa pedir isso, e um tipo criado
// pra uma empresa específica aparecia em todas as outras).
app.post("/api/empresas/licenca-tipos", blockCliente, requirePermissaoOr("empresas", "licencas", "editar"), (req, res) => {
  const user = (req as any).user;
  const empresaId = Number(req.body?.empresaId);
  if (!empresaId || !podeAcessarEmpresa(user, empresaId)) return res.status(403).json({ error: "Sem acesso a esta empresa." });
  const label = String(req.body?.label || "").trim().replace(/\s+/g, " ");
  if (label.length < 2 || label.length > 60) return res.status(400).json({ error: "Informe um nome de 2 a 60 caracteres." });
  const slug = label
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40) || "licenca";
  // "lic_" na frente garante que nunca bate com um tipo fixo (alvara, corpo_bombeiros, etc.)
  const jaExistentes = new Set(
    (sqlite.prepare(`SELECT chave FROM empresa_licenca_tipos WHERE escritorio_id = ?`).all(user.escritorioId) as any[]).map((r) => r.chave)
  );
  let chave = `lic_${slug}`;
  let n = 2;
  while (jaExistentes.has(chave)) chave = `lic_${slug}_${n++}`;
  // Rótulo repetido — só entre o que ESSA empresa enxerga (fixo + compartilhado + dela mesma); duas
  // empresas diferentes podem ter cada uma o seu próprio tipo com o mesmo nome (ex.: "IBAMA").
  const rotulosAtuais = [
    ...LICENCA_TIPOS_FIXOS.map((t) => t.label),
    ...licencaTiposCustom(user.escritorioId, empresaId).map((t) => t.label),
  ].map((l) => l.toLowerCase());
  if (rotulosAtuais.includes(label.toLowerCase())) return res.status(400).json({ error: "Já existe uma licença com esse nome." });
  sqlite.prepare(`INSERT INTO empresa_licenca_tipos (escritorio_id, chave, label, empresa_id) VALUES (?, ?, ?, ?)`).run(user.escritorioId, chave, label, empresaId);
  res.json({ chave, label });
});
app.delete("/api/empresas/licenca-tipos/:chave", blockCliente, requirePermissaoOr("empresas", "licencas", "editar"), (req, res) => {
  const user = (req as any).user;
  const chave = String(req.params.chave);
  const row = sqlite.prepare(`SELECT id, empresa_id FROM empresa_licenca_tipos WHERE escritorio_id = ? AND chave = ?`).get(user.escritorioId, chave) as any;
  if (!row) return res.status(404).json({ error: "Tipo de licença não encontrado." });
  // Tipo escopado a uma empresa específica: só quem tem acesso a ela pode excluir.
  if (row.empresa_id != null && !podeAcessarEmpresa(user, row.empresa_id)) return res.status(403).json({ error: "Sem acesso a esta empresa." });
  const emUso = sqlite
    .prepare(`SELECT COUNT(*) n FROM empresa_anexos a JOIN empresas e ON e.id = a.empresa_id WHERE e.escritorio_id = ? AND a.tipo = ?`)
    .get(user.escritorioId, chave) as any;
  if (emUso.n > 0) return res.status(400).json({ error: `Não dá pra excluir: ${emUso.n} anexo(s) usam esse tipo. Remova os anexos antes.` });
  sqlite.prepare(`DELETE FROM empresa_licenca_tipos WHERE id = ?`).run(row.id);
  res.json({ ok: true });
});

// ---------- Chat ao vivo (balãozinho) — uma conversa por empresa-cliente, caixa de entrada única
// compartilhada por todos os colaboradores/admin do escritório de um lado, todos os usuários da
// empresa-cliente do outro. Disponível pra qualquer Colaborador/Administrador/Cliente autenticado,
// sem gate de permissão de módulo — é um utilitário de comunicação preso ao shell, não uma página.
// Defaults usados quando o escritório nunca personalizou (sem linha em chat_config) — os mesmos
// valores fixos que o sistema sempre usou antes disso virar configurável (ver Configurações ›
// WhatsApp › Temporizadores).
const CHAT_CONFIG_DEFAULTS = {
  presenca_intervalo_segundos: 25,
  online_janela_segundos: 40,
  resumo_intervalo_segundos: 8,
  mensagens_intervalo_segundos: 4,
  aviso_whatsapp_atraso_segundos: 45,
};
function getChatConfig(escritorioId: number): typeof CHAT_CONFIG_DEFAULTS {
  const row = sqlite.prepare(`SELECT * FROM chat_config WHERE escritorio_id = ?`).get(escritorioId) as any;
  if (!row) return CHAT_CONFIG_DEFAULTS;
  return {
    presenca_intervalo_segundos: row.presenca_intervalo_segundos,
    online_janela_segundos: row.online_janela_segundos,
    resumo_intervalo_segundos: row.resumo_intervalo_segundos,
    mensagens_intervalo_segundos: row.mensagens_intervalo_segundos,
    aviso_whatsapp_atraso_segundos: row.aviso_whatsapp_atraso_segundos,
  };
}
function chatEscritorioOnline(escritorioId: number): boolean {
  const janela = getChatConfig(escritorioId).online_janela_segundos;
  const row = sqlite
    .prepare(
      `SELECT 1 FROM chat_presenca p JOIN app_users u ON u.id = p.user_id
       WHERE u.escritorio_id = ? AND u.perfil IN ('Administrador','Colaborador')
         AND p.ultimo_ping >= datetime('now', '-' || ? || ' seconds')`
    )
    .get(escritorioId, janela);
  return !!row;
}
function chatEmpresaOnline(empresaId: number, escritorioId: number): boolean {
  const janela = getChatConfig(escritorioId).online_janela_segundos;
  const row = sqlite
    .prepare(
      `SELECT 1 FROM chat_presenca p JOIN cliente_empresas ce ON ce.user_id = p.user_id
       WHERE ce.empresa_id = ? AND p.ultimo_ping >= datetime('now', '-' || ? || ' seconds')`
    )
    .get(empresaId, janela);
  return !!row;
}
function chatUserOnline(userId: number, escritorioId: number): boolean {
  const janela = getChatConfig(escritorioId).online_janela_segundos;
  const row = sqlite
    .prepare(`SELECT 1 FROM chat_presenca WHERE user_id = ? AND ultimo_ping >= datetime('now', '-' || ? || ' seconds')`)
    .get(userId, janela);
  return !!row;
}
// user_a_id sempre o menor id — mesma dupla dá sempre o mesmo par, não importa quem escreveu 1º.
function chatDmPar(x: number, y: number): [number, number] {
  return x < y ? [x, y] : [y, x];
}
// Só os 3 intervalos que o FRONT usa pra decidir a frequência do próprio polling — qualquer
// usuário autenticado (inclusive Cliente) precisa disso pra configurar os próprios timers do chat.
// A janela de "online" e o atraso do aviso de WhatsApp são só do backend, não vão aqui.
app.get("/api/chat/config", (req, res) => {
  const user = (req as any).user;
  if (!user || user.perfil === "SuperAdmin") return res.status(403).json({ error: "Sem acesso." });
  const c = getChatConfig(user.escritorioId);
  res.json({
    presencaSegundos: c.presenca_intervalo_segundos,
    resumoSegundos: c.resumo_intervalo_segundos,
    mensagensSegundos: c.mensagens_intervalo_segundos,
  });
});
// Configuração completa (os 3 acima + janela de "online" e atraso do aviso de WhatsApp) — só pra
// tela de administração, em Configurações › WhatsApp › Temporizadores.
app.get("/api/chat/config/completo", blockCliente, requirePermissao("configuracoes", "visualizar"), (req, res) => {
  const c = getChatConfig((req as any).user.escritorioId);
  res.json({
    presencaSegundos: c.presenca_intervalo_segundos,
    onlineJanelaSegundos: c.online_janela_segundos,
    resumoSegundos: c.resumo_intervalo_segundos,
    mensagensSegundos: c.mensagens_intervalo_segundos,
    avisoWhatsappAtrasoSegundos: c.aviso_whatsapp_atraso_segundos,
  });
});
// Limites sensatos pra cada temporizador — evita um valor digitado errado (ex.: "0" ou "1") virar
// um polling agressivo martelando o servidor, ou uma janela de "online" menor que o próprio
// heartbeat (a pessoa nunca apareceria online, mesmo com a aba aberta).
const CHAT_CONFIG_LIMITES = {
  presencaSegundos: { min: 10, max: 120 },
  onlineJanelaSegundos: { min: 15, max: 300 },
  resumoSegundos: { min: 3, max: 60 },
  mensagensSegundos: { min: 2, max: 30 },
  avisoWhatsappAtrasoSegundos: { min: 10, max: 600 },
};
app.put("/api/chat/config/completo", blockCliente, requirePermissao("configuracoes", "editar"), (req, res) => {
  const escritorioId = (req as any).user.escritorioId;
  const b = req.body || {};
  const atual = getChatConfig(escritorioId);
  const campos = {
    presenca_intervalo_segundos: [b.presencaSegundos, "presencaSegundos", atual.presenca_intervalo_segundos],
    online_janela_segundos: [b.onlineJanelaSegundos, "onlineJanelaSegundos", atual.online_janela_segundos],
    resumo_intervalo_segundos: [b.resumoSegundos, "resumoSegundos", atual.resumo_intervalo_segundos],
    mensagens_intervalo_segundos: [b.mensagensSegundos, "mensagensSegundos", atual.mensagens_intervalo_segundos],
    aviso_whatsapp_atraso_segundos: [b.avisoWhatsappAtrasoSegundos, "avisoWhatsappAtrasoSegundos", atual.aviso_whatsapp_atraso_segundos],
  } as const;
  const valores: Record<string, number> = {};
  for (const [coluna, [valor, chaveLimite, atualValor]] of Object.entries(campos)) {
    if (valor === undefined) {
      valores[coluna] = atualValor;
      continue;
    }
    const n = Number(valor);
    const limite = CHAT_CONFIG_LIMITES[chaveLimite as keyof typeof CHAT_CONFIG_LIMITES];
    if (!Number.isInteger(n) || n < limite.min || n > limite.max) {
      return res.status(400).json({ error: `${chaveLimite}: informe um valor entre ${limite.min} e ${limite.max} segundos.` });
    }
    valores[coluna] = n;
  }
  if (valores.online_janela_segundos < valores.presenca_intervalo_segundos) {
    return res.status(400).json({ error: "A janela de \"online\" precisa ser maior ou igual ao intervalo de presença — senão a pessoa nunca aparece online." });
  }
  sqlite
    .prepare(
      `INSERT INTO chat_config (escritorio_id, presenca_intervalo_segundos, online_janela_segundos, resumo_intervalo_segundos, mensagens_intervalo_segundos, aviso_whatsapp_atraso_segundos, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(escritorio_id) DO UPDATE SET presenca_intervalo_segundos=excluded.presenca_intervalo_segundos, online_janela_segundos=excluded.online_janela_segundos,
         resumo_intervalo_segundos=excluded.resumo_intervalo_segundos, mensagens_intervalo_segundos=excluded.mensagens_intervalo_segundos,
         aviso_whatsapp_atraso_segundos=excluded.aviso_whatsapp_atraso_segundos, updated_at=datetime('now')`
    )
    .run(
      escritorioId,
      valores.presenca_intervalo_segundos,
      valores.online_janela_segundos,
      valores.resumo_intervalo_segundos,
      valores.mensagens_intervalo_segundos,
      valores.aviso_whatsapp_atraso_segundos
    );
  res.json({ ok: true });
});
// Aviso por WhatsApp de uma DM não lida — dispara com atraso (não na hora, ver
// chat_config.aviso_whatsapp_atraso_segundos) pra não incomodar quem só teve um intervalo curto sem
// pingar (heartbeat de presença + janela de "online", mesma tabela de config). Ao disparar, confere
// de novo se continua offline E se ainda não leu (pode ter aberto o chat por outro motivo nesse meio
// tempo) antes de gastar um envio de WhatsApp. Sem telefone cadastrado ou sem o modelo de texto
// configurado, nem agenda — evita timer fadado a falhar (e log de erro) em toda DM enquanto o
// recurso não estiver configurado.
function agendarAvisoWhatsappChatDm(escritorioId: number, colegaId: number, colegaTelefone: string | null, userAId: number, userBId: number, mensagemId: number, remetenteNome: string): void {
  if (!colegaTelefone) return;
  const c = getWhatsappConfig(escritorioId);
  if (!c.ativo || !c.phone_number_id || !c.access_token_cifrado || !c.template_texto_notificacao) return;
  const atrasoSegundos = getChatConfig(escritorioId).aviso_whatsapp_atraso_segundos;
  setTimeout(() => {
    (async () => {
      if (chatUserOnline(colegaId, escritorioId)) return;
      const leitura = sqlite.prepare(`SELECT ultima_msg_lida_id FROM chat_dm_leitura WHERE user_a_id = ? AND user_b_id = ? AND user_id = ?`).get(userAId, userBId, colegaId) as any;
      if (leitura && leitura.ultima_msg_lida_id >= mensagemId) return;
      await whatsappEnviarTexto(escritorioId, colegaTelefone, [{ nome: "remetente", valor: remetenteNome }], { tabela: "chat_dm_mensagens", id: mensagemId });
    })().catch((e: any) => console.error(`[Chat] aviso de WhatsApp pra usuário ${colegaId} falhou:`, e.message));
  }, atrasoSegundos * 1000);
}
// Lista de colaboradores/admin do mesmo escritório pra abrir uma conversa individual nova — inclui
// quem nunca trocou mensagem ainda (diferente da lista de "conversas recentes" de /chat/resumo).
app.get("/api/chat/colegas", (req, res) => {
  const user = (req as any).user;
  if (!user || (user.perfil !== "Administrador" && user.perfil !== "Colaborador")) return res.status(403).json({ error: "Sem acesso." });
  const rows = sqlite
    .prepare(`SELECT id, nome FROM app_users WHERE escritorio_id = ? AND id != ? AND perfil IN ('Administrador','Colaborador') ORDER BY nome`)
    .all(user.escritorioId, user.id) as any[];
  res.json({ items: rows.map((r) => ({ id: r.id, nome: r.nome, online: chatUserOnline(r.id, user.escritorioId) })) });
});
app.post("/api/chat/presenca", (req, res) => {
  const user = (req as any).user;
  if (!user || user.perfil === "SuperAdmin") return res.json({ ok: true });
  sqlite
    .prepare(
      `INSERT INTO chat_presenca (user_id, ultimo_ping) VALUES (?, datetime('now'))
       ON CONFLICT(user_id) DO UPDATE SET ultimo_ping = datetime('now')`
    )
    .run(user.id);
  res.json({ ok: true });
});
// Poll leve (a cada poucos segundos) — cobre tanto o número de não lidas pro balãozinho piscar
// quanto, pro lado do escritório, a lista de conversas recentes (evita duas rotas/dois pollings).
app.get("/api/chat/resumo", (req, res) => {
  const user = (req as any).user;
  if (!user || user.perfil === "SuperAdmin") return res.json({ naoLidas: 0 });
  if (user.perfil === "Cliente") {
    if (!user.empresaId) return res.json({ naoLidas: 0, online: false });
    const row = sqlite
      .prepare(`SELECT COUNT(*) as qtd FROM chat_mensagens WHERE empresa_id = ? AND autor_lado = 'escritorio' AND lido_pelo_cliente = 0`)
      .get(user.empresaId) as any;
    return res.json({ naoLidas: row.qtd, online: chatEscritorioOnline(user.escritorioId) });
  }
  const empresaIds = empresasVisiveis(user);
  const empresaRows = empresaIds.length
    ? (sqlite
        .prepare(
          `SELECT e.id as empresaId, e.nome as empresaNome,
              (SELECT COUNT(*) FROM chat_mensagens m WHERE m.empresa_id = e.id AND m.autor_lado='cliente' AND m.lido_pelo_escritorio=0) as naoLidas,
              (SELECT texto FROM chat_mensagens m WHERE m.empresa_id = e.id ORDER BY m.id DESC LIMIT 1) as ultimaMensagem,
              (SELECT criado_em FROM chat_mensagens m WHERE m.empresa_id = e.id ORDER BY m.id DESC LIMIT 1) as ultimaMensagemEm
           FROM empresas e WHERE e.id IN (${empresaIds.map(() => "?").join(",")}) AND e.ativo = 1`
        )
        .all(...empresaIds) as any[])
    : [];
  const comMensagem = empresaRows.filter((r) => r.ultimaMensagemEm);
  comMensagem.sort((a, b) => (a.ultimaMensagemEm < b.ultimaMensagemEm ? 1 : -1));
  const empresaNaoLidas = empresaRows.reduce((s, r) => s + r.naoLidas, 0);
  const conversas = comMensagem.map((r) => ({ ...r, online: chatEmpresaOnline(r.empresaId, user.escritorioId) }));

  const equipeLeitura = sqlite.prepare(`SELECT ultima_msg_lida_id FROM chat_equipe_leitura WHERE escritorio_id = ? AND user_id = ?`).get(user.escritorioId, user.id) as any;
  const ultimaLidaEquipe = equipeLeitura ? equipeLeitura.ultima_msg_lida_id : 0;
  const equipeNaoLidas = (sqlite.prepare(`SELECT COUNT(*) as qtd FROM chat_equipe_mensagens WHERE escritorio_id = ? AND id > ? AND autor_user_id != ?`).get(user.escritorioId, ultimaLidaEquipe, user.id) as any).qtd;
  const equipeUltima = sqlite.prepare(`SELECT texto, criado_em as em FROM chat_equipe_mensagens WHERE escritorio_id = ? ORDER BY id DESC LIMIT 1`).get(user.escritorioId) as any;

  const dmPares = sqlite
    .prepare(
      `SELECT CASE WHEN user_a_id = ? THEN user_b_id ELSE user_a_id END as colegaId, MAX(id) as ultimoId
       FROM chat_dm_mensagens WHERE user_a_id = ? OR user_b_id = ? GROUP BY colegaId`
    )
    .all(user.id, user.id, user.id) as any[];
  const dms = dmPares
    .map((r) => {
      const [a, b] = chatDmPar(user.id, r.colegaId);
      const leitura = sqlite.prepare(`SELECT ultima_msg_lida_id FROM chat_dm_leitura WHERE user_a_id = ? AND user_b_id = ? AND user_id = ?`).get(a, b, user.id) as any;
      const ultimaLida = leitura ? leitura.ultima_msg_lida_id : 0;
      const naoLidas = (sqlite.prepare(`SELECT COUNT(*) as qtd FROM chat_dm_mensagens WHERE user_a_id = ? AND user_b_id = ? AND id > ? AND autor_user_id != ?`).get(a, b, ultimaLida, user.id) as any).qtd;
      const ultima = sqlite.prepare(`SELECT texto, criado_em as em FROM chat_dm_mensagens WHERE user_a_id = ? AND user_b_id = ? ORDER BY id DESC LIMIT 1`).get(a, b) as any;
      const colega = sqlite.prepare(`SELECT nome FROM app_users WHERE id = ?`).get(r.colegaId) as any;
      return {
        userId: r.colegaId,
        nome: colega ? colega.nome : "?",
        naoLidas,
        ultimaMensagem: ultima ? ultima.texto : null,
        ultimaMensagemEm: ultima ? ultima.em : null,
        online: chatUserOnline(r.colegaId, user.escritorioId),
      };
    })
    .sort((a, b) => (a.ultimaMensagemEm < b.ultimaMensagemEm ? 1 : -1));
  const dmNaoLidas = dms.reduce((s, r) => s + r.naoLidas, 0);

  res.json({
    naoLidas: empresaNaoLidas + equipeNaoLidas + dmNaoLidas,
    conversas,
    equipe: { naoLidas: equipeNaoLidas, ultimaMensagem: equipeUltima ? equipeUltima.texto : null, ultimaMensagemEm: equipeUltima ? equipeUltima.em : null },
    dms,
  });
});
app.get("/api/chat/mensagens", (req, res) => {
  const user = (req as any).user;
  if (!user || user.perfil === "SuperAdmin") return res.status(403).json({ error: "Sem acesso." });
  const tipo = user.perfil === "Cliente" ? "empresa" : typeof req.query.tipo === "string" ? req.query.tipo : "empresa";

  if (tipo === "equipe") {
    const rows = sqlite
      .prepare(
        `SELECT id, autor_nome as autorNome, autor_user_id as autorUserId, texto, criado_em as criadoEm, anexo_nome as anexoNome, anexo_size as anexoSize
         FROM chat_equipe_mensagens WHERE escritorio_id = ? ORDER BY id ASC LIMIT 300`
      )
      .all(user.escritorioId) as any[];
    const maxId = rows.length ? Math.max(...rows.map((r) => r.id)) : 0;
    sqlite
      .prepare(
        `INSERT INTO chat_equipe_leitura (escritorio_id, user_id, ultima_msg_lida_id) VALUES (?, ?, ?)
         ON CONFLICT(escritorio_id, user_id) DO UPDATE SET ultima_msg_lida_id = MAX(ultima_msg_lida_id, excluded.ultima_msg_lida_id)`
      )
      .run(user.escritorioId, user.id, maxId);
    return res.json({ items: rows.map((r) => ({ ...r, mine: r.autorUserId === user.id })) });
  }
  if (tipo === "dm") {
    const colegaId = Number(req.query.userId);
    const colega = sqlite.prepare(`SELECT id, nome FROM app_users WHERE id = ? AND escritorio_id = ? AND perfil IN ('Administrador','Colaborador')`).get(colegaId, user.escritorioId) as any;
    if (!colega) return res.status(404).json({ error: "Colaborador não encontrado." });
    const [a, b] = chatDmPar(user.id, colegaId);
    const rows = sqlite
      .prepare(
        `SELECT id, autor_nome as autorNome, autor_user_id as autorUserId, texto, criado_em as criadoEm, anexo_nome as anexoNome, anexo_size as anexoSize
         FROM chat_dm_mensagens WHERE user_a_id = ? AND user_b_id = ? ORDER BY id ASC LIMIT 300`
      )
      .all(a, b) as any[];
    const maxId = rows.length ? Math.max(...rows.map((r) => r.id)) : 0;
    sqlite
      .prepare(
        `INSERT INTO chat_dm_leitura (user_a_id, user_b_id, user_id, ultima_msg_lida_id) VALUES (?, ?, ?, ?)
         ON CONFLICT(user_a_id, user_b_id, user_id) DO UPDATE SET ultima_msg_lida_id = MAX(ultima_msg_lida_id, excluded.ultima_msg_lida_id)`
      )
      .run(a, b, user.id, maxId);
    return res.json({ items: rows.map((r) => ({ ...r, mine: r.autorUserId === user.id })), colegaNome: colega.nome, colegaOnline: chatUserOnline(colegaId, user.escritorioId) });
  }

  let empresaId: number;
  if (user.perfil === "Cliente") {
    if (!user.empresaId) return res.status(400).json({ error: "Nenhuma empresa vinculada." });
    empresaId = user.empresaId;
  } else {
    empresaId = Number(req.query.empresaId);
    if (!empresaId || !podeAcessarEmpresa(user, empresaId)) return res.status(404).json({ error: "Empresa não encontrada." });
  }
  const rows = sqlite
    .prepare(
      `SELECT id, autor_nome as autorNome, autor_lado as autorLado, texto, criado_em as criadoEm, anexo_nome as anexoNome, anexo_size as anexoSize
       FROM chat_mensagens WHERE empresa_id = ? ORDER BY id ASC LIMIT 300`
    )
    .all(empresaId) as any[];
  if (user.perfil === "Cliente") {
    sqlite.prepare(`UPDATE chat_mensagens SET lido_pelo_cliente = 1 WHERE empresa_id = ? AND autor_lado = 'escritorio' AND lido_pelo_cliente = 0`).run(empresaId);
  } else {
    sqlite.prepare(`UPDATE chat_mensagens SET lido_pelo_escritorio = 1 WHERE empresa_id = ? AND autor_lado = 'cliente' AND lido_pelo_escritorio = 0`).run(empresaId);
  }
  const mineLado = user.perfil === "Cliente" ? "cliente" : "escritorio";
  res.json({
    items: rows.map((r) => ({ ...r, mine: r.autorLado === mineLado })),
    empresaId,
    empresaOnline: user.perfil === "Cliente" ? undefined : chatEmpresaOnline(empresaId, user.escritorioId),
  });
});
app.post("/api/chat/mensagens", upload.single("arquivo"), (req, res) => {
  const user = (req as any).user;
  if (!user || user.perfil === "SuperAdmin") return res.status(403).json({ error: "Sem acesso." });
  const texto = String(req.body?.texto || "").trim();
  if (!texto && !req.file) return res.status(400).json({ error: "Mensagem vazia." });
  if (texto.length > 2000) return res.status(400).json({ error: "Mensagem muito longa (máximo 2000 caracteres)." });
  const tipo = user.perfil === "Cliente" ? "empresa" : typeof req.body?.tipo === "string" ? req.body.tipo : "empresa";

  // Anexo é opcional e vale pros 3 tipos — salva uma vez aqui, cada branch só grava os 4 campos.
  let anexoNome: string | null = null,
    anexoPath: string | null = null,
    anexoMime: string | null = null,
    anexoSize: number | null = null;
  if (req.file) {
    anexoNome = corrigirNomeArquivo(req.file.originalname);
    const dir = path.join(UPLOADS_DIR, "chat-anexos");
    fs.mkdirSync(dir, { recursive: true });
    anexoPath = path.join(dir, `${Date.now()}-${anexoNome}`);
    fs.writeFileSync(anexoPath, req.file.buffer);
    anexoMime = req.file.mimetype;
    anexoSize = req.file.size;
  }

  if (tipo === "equipe") {
    const info = sqlite
      .prepare(`INSERT INTO chat_equipe_mensagens (escritorio_id, autor_user_id, autor_nome, texto, anexo_nome, anexo_path, anexo_mime, anexo_size) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(user.escritorioId, user.id, user.nome, texto, anexoNome, anexoPath, anexoMime, anexoSize);
    sqlite
      .prepare(
        `INSERT INTO chat_equipe_leitura (escritorio_id, user_id, ultima_msg_lida_id) VALUES (?, ?, ?)
         ON CONFLICT(escritorio_id, user_id) DO UPDATE SET ultima_msg_lida_id = excluded.ultima_msg_lida_id`
      )
      .run(user.escritorioId, user.id, Number(info.lastInsertRowid));
    return res.json({ id: Number(info.lastInsertRowid) });
  }
  if (tipo === "dm") {
    const colegaId = Number(req.body?.userId);
    const colega = sqlite.prepare(`SELECT id, telefone FROM app_users WHERE id = ? AND escritorio_id = ? AND perfil IN ('Administrador','Colaborador')`).get(colegaId, user.escritorioId) as any;
    if (!colega) return res.status(404).json({ error: "Colaborador não encontrado." });
    const [a, b] = chatDmPar(user.id, colegaId);
    const info = sqlite
      .prepare(`INSERT INTO chat_dm_mensagens (escritorio_id, user_a_id, user_b_id, autor_user_id, autor_nome, texto, anexo_nome, anexo_path, anexo_mime, anexo_size) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(user.escritorioId, a, b, user.id, user.nome, texto, anexoNome, anexoPath, anexoMime, anexoSize);
    const mensagemId = Number(info.lastInsertRowid);
    sqlite
      .prepare(
        `INSERT INTO chat_dm_leitura (user_a_id, user_b_id, user_id, ultima_msg_lida_id) VALUES (?, ?, ?, ?)
         ON CONFLICT(user_a_id, user_b_id, user_id) DO UPDATE SET ultima_msg_lida_id = excluded.ultima_msg_lida_id`
      )
      .run(a, b, user.id, mensagemId);
    agendarAvisoWhatsappChatDm(user.escritorioId, colegaId, colega.telefone, a, b, mensagemId, user.nome);
    return res.json({ id: mensagemId });
  }

  let empresaId: number;
  let escritorioId: number;
  let autorLado: "escritorio" | "cliente";
  if (user.perfil === "Cliente") {
    if (!user.empresaId) return res.status(400).json({ error: "Nenhuma empresa vinculada." });
    empresaId = user.empresaId;
    autorLado = "cliente";
    const empresa = sqlite.prepare(`SELECT escritorio_id FROM empresas WHERE id = ?`).get(empresaId) as any;
    if (!empresa) return res.status(404).json({ error: "Empresa não encontrada." });
    escritorioId = empresa.escritorio_id;
  } else {
    empresaId = Number(req.body?.empresaId);
    if (!empresaId || !podeAcessarEmpresa(user, empresaId)) return res.status(404).json({ error: "Empresa não encontrada." });
    autorLado = "escritorio";
    escritorioId = user.escritorioId;
  }
  const info = sqlite
    .prepare(
      `INSERT INTO chat_mensagens (escritorio_id, empresa_id, autor_user_id, autor_nome, autor_lado, texto, lido_pelo_escritorio, lido_pelo_cliente, anexo_nome, anexo_path, anexo_mime, anexo_size)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(escritorioId, empresaId, user.id, user.nome, autorLado, texto, autorLado === "escritorio" ? 1 : 0, autorLado === "cliente" ? 1 : 0, anexoNome, anexoPath, anexoMime, anexoSize);
  res.json({ id: Number(info.lastInsertRowid) });
});
// Baixa o anexo de uma mensagem do chat (qualquer um dos 3 tipos) — mesma checagem de acesso da
// leitura de mensagens (Cliente só da própria empresa; equipe/dm só pra staff do escritório).
app.get("/api/chat/mensagens/:tipo/:id/anexo", (req, res) => {
  const user = (req as any).user;
  if (!user || user.perfil === "SuperAdmin") return res.status(404).json({ error: "Arquivo não encontrado." });
  const tipo = req.params.tipo;
  const id = Number(req.params.id);
  let row: any;
  if (tipo === "equipe") {
    if (user.perfil === "Cliente") return res.status(404).json({ error: "Arquivo não encontrado." });
    row = sqlite.prepare(`SELECT anexo_nome, anexo_path, anexo_mime FROM chat_equipe_mensagens WHERE id = ? AND escritorio_id = ?`).get(id, user.escritorioId);
  } else if (tipo === "dm") {
    if (user.perfil === "Cliente") return res.status(404).json({ error: "Arquivo não encontrado." });
    row = sqlite
      .prepare(`SELECT anexo_nome, anexo_path, anexo_mime FROM chat_dm_mensagens WHERE id = ? AND escritorio_id = ? AND (user_a_id = ? OR user_b_id = ?)`)
      .get(id, user.escritorioId, user.id, user.id);
  } else if (tipo === "empresa") {
    const msg = sqlite.prepare(`SELECT anexo_nome, anexo_path, anexo_mime, empresa_id FROM chat_mensagens WHERE id = ?`).get(id) as any;
    if (msg && (user.perfil === "Cliente" ? user.empresaId === msg.empresa_id : podeAcessarEmpresa(user, msg.empresa_id))) row = msg;
  }
  if (!row || !row.anexo_path || !fs.existsSync(row.anexo_path)) return res.status(404).json({ error: "Arquivo não encontrado." });
  res.download(row.anexo_path, row.anexo_nome);
});
app.get("/api/empresas/:id/anexos", blockCliente, requirePermissao("empresas", "visualizar"), (req, res) => {
  const empresaId = Number(req.params.id);
  if (!podeAcessarEmpresa((req as any).user, empresaId)) return res.status(404).json({ error: "Empresa não encontrada." });
  const categoria = typeof req.query.categoria === "string" ? req.query.categoria : null;
  let sql = `SELECT a.id, a.categoria, a.tipo, a.ano, a.nome_arquivo as nomeArquivo, a.mime, a.size_bytes as sizeBytes,
             a.vencimento, a.vencimento_origem as vencimentoOrigem, a.criado_em as criadoEm, u.nome as criadoPorNome
             FROM empresa_anexos a LEFT JOIN app_users u ON u.id = a.criado_por WHERE a.empresa_id = ?`;
  const params: any[] = [empresaId];
  if (categoria) {
    sql += ` AND a.categoria = ?`;
    params.push(categoria);
  }
  sql += ` ORDER BY a.criado_em DESC`;
  const rows = sqlite.prepare(sql).all(...params);
  res.json({ items: rows });
});
app.post("/api/empresas/:id/anexos", blockCliente, requirePermissao("empresas", "editar"), upload.single("arquivo"), async (req, res) => {
  const user = (req as any).user;
  const empresaId = Number(req.params.id);
  if (!podeAcessarEmpresa(user, empresaId)) return res.status(404).json({ error: "Empresa não encontrada." });
  if (!req.file) return res.status(400).json({ error: "Selecione o arquivo." });
  const tipo = String(req.body?.tipo || "");
  const info = resolverTipoAnexo(user.escritorioId, tipo);
  if (!info) return res.status(400).json({ error: "Tipo de anexo inválido." });
  let ano: number | null = null;
  if (info.categoria === "licenca") {
    ano = Number(req.body?.ano);
    if (!Number.isInteger(ano) || ano < 2000 || ano > 2100) return res.status(400).json({ error: "Informe o ano da licença." });
  }
  req.file.originalname = corrigirNomeArquivo(req.file.originalname);
  const dir = path.join(UPLOADS_DIR, "empresa-anexos", String(empresaId));
  fs.mkdirSync(dir, { recursive: true });
  const destino = path.join(dir, `${Date.now()}-${req.file.originalname}`);
  fs.writeFileSync(destino, req.file.buffer);
  let vencimento: string | null = null;
  let vencimentoOrigem: string | null = null;
  const vencimentoManual = req.body?.vencimento ? String(req.body.vencimento).trim() : "";
  if (info.categoria === "licenca") {
    if (vencimentoManual) {
      vencimento = vencimentoManual;
      vencimentoOrigem = "manual";
    } else {
      vencimento = await extrairVencimentoDeAnexo(req.file.buffer, req.file.mimetype);
      if (vencimento) vencimentoOrigem = "automatico";
    }
  }
  const result = sqlite
    .prepare(
      `INSERT INTO empresa_anexos (empresa_id, categoria, tipo, ano, nome_arquivo, arquivo_path, mime, size_bytes, vencimento, vencimento_origem, criado_por)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(empresaId, info.categoria, tipo, ano, req.file.originalname, destino, req.file.mimetype, req.file.buffer.length, vencimento, vencimentoOrigem, user.id);
  res.json({ id: Number(result.lastInsertRowid), ano, vencimento, vencimentoOrigem });
});
// Carrega uma pasta inteira de licenças de uma vez (o navegador junta os PDFs da pasta escolhida e
// manda tudo num só POST) — lê o CNPJ/CPF de dentro de CADA PDF pra descobrir sozinho de qual
// empresa é cada arquivo, sem precisar escolher empresa por empresa. Tenta ler o vencimento também
// (mesma heurística do upload individual); quando não acha, salva assim mesmo — o CNPJ já basta
// pra identificar a licença certa, e o vencimento fica pro relatório de "sem data" que o front
// monta com a resposta daqui, pra preencher rápido depois.
const REGEX_CNPJ_BUSCA = /\b\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}\b/g;
const REGEX_CPF_BUSCA = /\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/g;
app.post("/api/empresas/anexos/licencas-bulk", blockCliente, requirePermissao("licencas", "postar"), upload.array("arquivos", 300), async (req, res) => {
  const user = (req as any).user;
  const tipo = String(req.body?.tipo || "");
  const info = resolverTipoAnexo(user.escritorioId, tipo);
  if (!info || info.categoria !== "licenca") return res.status(400).json({ error: "Tipo de licença inválido." });
  const ano = Number(req.body?.ano);
  if (!Number.isInteger(ano) || ano < 2000 || ano > 2100) return res.status(400).json({ error: "Informe o ano da licença." });
  const arquivos = (req.files as Express.Multer.File[]) || [];
  if (!arquivos.length) return res.status(400).json({ error: "Selecione a pasta com os PDFs das licenças." });

  const visiveis = empresasVisiveis(user);
  const empresasDoEscritorio = sqlite.prepare(`SELECT id, nome, cnpj FROM empresas WHERE escritorio_id = ?`).all(user.escritorioId) as any[];
  const porDocumento = new Map<string, any>();
  for (const e of empresasDoEscritorio) {
    if (!e.cnpj) continue;
    const digitos = String(e.cnpj).replace(/\D/g, "");
    if (digitos.length === 11 || digitos.length === 14) porDocumento.set(digitos, e);
  }

  const identificados: any[] = [];
  const semVencimento: any[] = [];
  const naoIdentificados: any[] = [];

  for (const file of arquivos) {
    file.originalname = corrigirNomeArquivo(file.originalname);
    if (file.mimetype !== "application/pdf") {
      naoIdentificados.push({ nomeArquivo: file.originalname, motivo: "Não é um PDF." });
      continue;
    }
    // obterTextoDoPdf já cai pro OCR sozinho quando o PDF não tem camada de texto (scan de mesa) —
    // reaproveita o mesmo texto abaixo pro CNPJ e pro vencimento, sem rodar OCR duas vezes.
    const texto = await obterTextoDoPdf(file.buffer);
    if (!texto.trim()) {
      naoIdentificados.push({ nomeArquivo: file.originalname, motivo: "Não consegui ler o PDF (protegido, corrompido ou sem texto legível nem por OCR)." });
      continue;
    }
    // PDFs em layout de "caixinhas"/tabela (ex.: Alvará Digital de prefeitura) costumam vir sem
    // espaço nenhum entre colunas depois do pdf-parse — a inscrição municipal, o CNPJ e a data de
    // abertura saem grudados num único bloco de dígitos (ex.: "32584603.868.448/0001-1026/05/2000").
    // Um regex com \b não acha fronteira de palavra no meio desse bloco (dígito colado em dígito),
    // então casar direto contra o CNPJ/CPF já cadastrado da empresa (sem exigir \b) é o que
    // realmente funciona aqui — em vez de extrair um "candidato" solto do texto, procura se o
    // documento de alguma empresa conhecida aparece em algum lugar do fluxo de dígitos do PDF.
    const fluxoDigitos = texto.replace(/\D/g, "");
    let empresa: any = null;
    for (const [digitos, emp] of porDocumento) {
      if (fluxoDigitos.includes(digitos)) {
        empresa = emp;
        break;
      }
    }
    if (!empresa) {
      const candidatosCnpj = [...texto.matchAll(REGEX_CNPJ_BUSCA)].map((m) => m[0].replace(/\D/g, ""));
      const candidatosCpf = [...texto.matchAll(REGEX_CPF_BUSCA)].map((m) => m[0].replace(/\D/g, ""));
      const achado = candidatosCnpj[0] || candidatosCpf[0];
      naoIdentificados.push({
        nomeArquivo: file.originalname,
        motivo: achado ? `CNPJ/CPF encontrado (${achado}) não bate com nenhuma empresa cadastrada.` : "Não encontrei CNPJ/CPF no texto do PDF.",
      });
      continue;
    }
    if (visiveis !== null && !visiveis.includes(empresa.id)) {
      naoIdentificados.push({ nomeArquivo: file.originalname, motivo: `Empresa identificada (${empresa.nome}), mas você não tem acesso a ela.` });
      continue;
    }
    const dir = path.join(UPLOADS_DIR, "empresa-anexos", String(empresa.id));
    fs.mkdirSync(dir, { recursive: true });
    const destino = path.join(dir, `${Date.now()}-${file.originalname}`);
    fs.writeFileSync(destino, file.buffer);
    const vencimento = extrairVencimentoDoTexto(texto);
    const vencimentoOrigem = vencimento ? "automatico" : null;
    const result = sqlite
      .prepare(
        `INSERT INTO empresa_anexos (empresa_id, categoria, tipo, ano, nome_arquivo, arquivo_path, mime, size_bytes, vencimento, vencimento_origem, criado_por)
         VALUES (?, 'licenca', ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(empresa.id, tipo, ano, file.originalname, destino, file.mimetype, file.buffer.length, vencimento, vencimentoOrigem, user.id);
    const item = { anexoId: Number(result.lastInsertRowid), empresaId: empresa.id, empresaNome: empresa.nome, nomeArquivo: file.originalname, vencimento };
    if (vencimento) identificados.push(item);
    else semVencimento.push(item);
  }

  res.json({ total: arquivos.length, identificados, semVencimento, naoIdentificados });
});
app.put("/api/empresas/anexos/:anexoId/vencimento", blockCliente, requirePermissaoOr("empresas", "licencas", "editar"), (req, res) => {
  const anexo = sqlite.prepare(`SELECT empresa_id, categoria FROM empresa_anexos WHERE id = ?`).get(Number(req.params.anexoId)) as any;
  if (!anexo || !podeAcessarEmpresa((req as any).user, anexo.empresa_id)) return res.status(404).json({ error: "Anexo não encontrado." });
  if (anexo.categoria !== "licenca") return res.status(400).json({ error: "Só licenças têm data de vencimento." });
  const vencimento = String(req.body?.vencimento || "").trim() || null;
  sqlite.prepare(`UPDATE empresa_anexos SET vencimento = ?, vencimento_origem = 'manual' WHERE id = ?`).run(vencimento, Number(req.params.anexoId));
  res.json({ ok: true });
});
app.get("/api/empresas/anexos/:anexoId/arquivo", blockCliente, requirePermissao("empresas", "visualizar"), (req, res) => {
  const anexo = sqlite.prepare(`SELECT * FROM empresa_anexos WHERE id = ?`).get(Number(req.params.anexoId)) as any;
  if (!anexo || !podeAcessarEmpresa((req as any).user, anexo.empresa_id) || !fs.existsSync(anexo.arquivo_path)) {
    return res.status(404).json({ error: "Arquivo não encontrado." });
  }
  res.setHeader("Content-Type", anexo.mime || "application/octet-stream");
  res.setHeader("Content-Disposition", `inline; filename="${encodeURIComponent(anexo.nome_arquivo)}"`);
  res.send(fs.readFileSync(anexo.arquivo_path));
});
app.delete("/api/empresas/anexos/:anexoId", blockCliente, requirePermissao("empresas", "editar"), (req, res) => {
  const anexo = sqlite.prepare(`SELECT * FROM empresa_anexos WHERE id = ?`).get(Number(req.params.anexoId)) as any;
  if (!anexo || !podeAcessarEmpresa((req as any).user, anexo.empresa_id)) return res.status(404).json({ error: "Anexo não encontrado." });
  try {
    fs.unlinkSync(anexo.arquivo_path);
  } catch {}
  sqlite.prepare(`DELETE FROM empresa_anexos WHERE id = ?`).run(anexo.id);
  res.json({ ok: true });
});

// CNPJ/CPF cadastrados por empresa — usados para identificar automaticamente o dono de um arquivo enviado
app.get("/api/empresas/:id/documentos", blockCliente, requirePermissao("empresas", "visualizar"), (req, res) => {
  if (!podeAcessarEmpresa((req as any).user, Number(req.params.id))) return res.status(404).json({ error: "Empresa não encontrada." });
  const rows = sqlite.prepare(`SELECT * FROM empresa_documentos WHERE empresa_id = ? ORDER BY tipo, documento`).all(Number(req.params.id));
  res.json({ items: rows });
});
app.post("/api/empresas/:id/documentos", blockCliente, requirePermissao("empresas", "editar"), (req, res) => {
  const empresaId = Number(req.params.id);
  if (!podeAcessarEmpresa((req as any).user, empresaId)) return res.status(404).json({ error: "Empresa não encontrada." });
  const digitos = String(req.body?.documento || "").replace(/\D/g, "");
  if (digitos.length !== 11 && digitos.length !== 14) return res.status(400).json({ error: "Informe um CNPJ (14 dígitos) ou CPF (11 dígitos) válido." });
  const tipo = digitos.length === 14 ? "cnpj" : "cpf";
  try {
    const info = sqlite.prepare(`INSERT INTO empresa_documentos (empresa_id, documento, tipo) VALUES (?, ?, ?)`).run(empresaId, digitos, tipo);
    res.json({ id: Number(info.lastInsertRowid), documento: digitos, tipo });
  } catch (e: any) {
    if (String(e.message).includes("UNIQUE")) return res.status(409).json({ error: "Este documento já está cadastrado em outra empresa." });
    res.status(500).json({ error: e.message });
  }
});
app.delete("/api/empresas/documentos/:docId", blockCliente, requirePermissao("empresas", "editar"), (req, res) => {
  const doc = sqlite.prepare(`SELECT empresa_id FROM empresa_documentos WHERE id = ?`).get(Number(req.params.docId)) as any;
  if (!doc || !podeAcessarEmpresa((req as any).user, doc.empresa_id)) return res.status(404).json({ error: "Documento não encontrado." });
  sqlite.prepare(`DELETE FROM empresa_documentos WHERE id = ?`).run(Number(req.params.docId));
  res.json({ ok: true });
});

// Importação da lista de clientes exportada do Domínio Web (CSV: codigo;nome;cnpj;status)
app.post("/api/dominio/importar-clientes", blockCliente, requirePermissao("configuracoes", "postar"), upload.single("arquivo"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Envie o arquivo CSV exportado do Domínio Web." });
  const texto = req.file.buffer.toString("utf8").replace(/\r/g, "");
  const linhas = texto.split("\n").map((l) => l.trim()).filter(Boolean);
  if (!linhas.length) return res.status(400).json({ error: "Arquivo vazio." });
  const sep = linhas[0].includes(";") ? ";" : ",";
  const header = linhas[0].toLowerCase().split(sep).map((h) => h.trim());
  const idxCodigo = header.findIndex((h) => h.includes("codigo") || h.includes("código"));
  const idxNome = header.findIndex((h) => h.includes("nome") || h.includes("razao") || h.includes("razão"));
  const idxCnpj = header.findIndex((h) => h.includes("cnpj"));
  // Clientes pessoa física (ex.: produtor rural) não têm CNPJ — o CSV do Domínio Web costuma trazer
  // uma coluna de CPF separada nesses casos. Usa CNPJ quando tiver; senão cai pro CPF, do mesmo jeito
  // que a sincronização via Onvio já faz (ver extrairDocumento em onvio-sync.ts).
  const idxCpf = header.findIndex((h) => h.includes("cpf"));
  const idxIe = header.findIndex((h) => h.includes("inscricao estadual") || h.includes("inscrição estadual") || h === "ie" || h.includes(" ie") || h.startsWith("ie "));
  const idxStatus = header.findIndex((h) => h.includes("status") || h.includes("situacao") || h.includes("situação") || h.includes("ativo"));
  // "Apelido" (ou "Nome fantasia"/"Nickname", dependendo de como o Domínio Web nomeia a coluna no
  // export) — usado no nome da pasta de exportação de XML (ver dominio-agent.ts), pra ficar igual à
  // convenção que o próprio Domínio já usa ("código-apelido") na pasta de importação dele.
  const idxApelido = header.findIndex((h) => h.includes("apelido") || h.includes("fantasia") || h.includes("nickname"));
  if (idxNome === -1) return res.status(400).json({ error: "Não encontrei a coluna de nome/razão social no CSV." });

  let novas = 0, atualizadas = 0;
  const escritorioId = (req as any).user.escritorioId;
  const getByCodigo = sqlite.prepare(`SELECT id FROM empresas WHERE codigo_dominio = ? AND escritorio_id = ?`);
  const getByNome = sqlite.prepare(`SELECT id FROM empresas WHERE LOWER(nome) = LOWER(?) AND escritorio_id = ?`);
  const insert = sqlite.prepare(`INSERT INTO empresas (nome, cnpj, codigo_dominio, apelido, inscricao_estadual, ativo, origem, escritorio_id) VALUES (?, ?, ?, ?, ?, ?, 'dominio', ?)`);
  const update = sqlite.prepare(
    `UPDATE empresas SET nome=?, cnpj=COALESCE(?, cnpj), codigo_dominio=COALESCE(?, codigo_dominio), apelido=COALESCE(?, apelido), inscricao_estadual=COALESCE(?, inscricao_estadual), ativo=?, updated_at=datetime('now') WHERE id=?`
  );

  for (let i = 1; i < linhas.length; i++) {
    const cols = linhas[i].split(sep).map((c) => c.trim());
    const nome = idxNome >= 0 ? cols[idxNome] : "";
    if (!nome) continue;
    const codigo = idxCodigo >= 0 ? cols[idxCodigo] : null;
    const cnpj = (idxCnpj >= 0 && cols[idxCnpj]) || (idxCpf >= 0 && cols[idxCpf]) || null;
    const apelido = idxApelido >= 0 ? cols[idxApelido] : null;
    const inscricaoEstadual = idxIe >= 0 ? cols[idxIe] : null;
    const statusTxt = (idxStatus >= 0 ? cols[idxStatus] : "").toLowerCase();
    const ativo = statusTxt ? (statusTxt.includes("inativ") || statusTxt.includes("encerrad") || statusTxt === "0" || statusTxt === "n" ? 0 : 1) : 1;

    const existente = (codigo ? getByCodigo.get(codigo, escritorioId) : undefined) || getByNome.get(nome, escritorioId);
    if (existente) {
      update.run(nome, cnpj || null, codigo || null, apelido || null, inscricaoEstadual || null, ativo, (existente as any).id);
      atualizadas++;
    } else {
      insert.run(nome, cnpj || null, codigo || null, apelido || null, inscricaoEstadual || null, ativo, escritorioId);
      novas++;
    }
  }
  sqlite
    .prepare(`INSERT INTO dominio_sync_log (origem, empresas_novas, empresas_atualizadas, status) VALUES ('importacao-csv', ?, ?, 'ok')`)
    .run(novas, atualizadas);
  res.json({ ok: true, novas, atualizadas });
});
app.get("/api/dominio/sync-log", blockCliente, requirePermissao("configuracoes", "visualizar"), (req, res) => {
  // dominio_sync_log ainda não é escopado por escritório (o agente do Domínio Web continua com
  // token único/global — ver requireDominioAgent) — fica pra quando um segundo agente real existir.
  const rows = sqlite.prepare(`SELECT * FROM dominio_sync_log ORDER BY id DESC LIMIT 30`).all();
  const heartbeat = sqlite.prepare(`SELECT last_seen_at as lastSeenAt, version FROM agent_heartbeat WHERE escritorio_id = ?`).get((req as any).user.escritorioId) as any;
  res.json({ items: rows, agente: heartbeat || null, saudeOnvio: calcularSaudeOnvio() });
});

// ---------- Configuração de acesso do src/dominio-agent.ts (editável pela tela, sem mexer no .env) ----------
function getDominioConfig(escritorioId: number): any {
  return sqlite.prepare(`SELECT * FROM dominio_config WHERE escritorio_id = ?`).get(escritorioId) || {};
}
// ---- Sincronização de clientes via Onvio direto no servidor (sem depender de nenhum agente local
// ligado) — o container do Railway já roda Playwright/Chromium (ver Dockerfile, usado hoje pra
// gerar PDF de DANFSe/NF-e/contratos), então basta ter a sessão do Onvio salva aqui pra sincronizar
// sozinho. A sessão em si (data/onvio-session.json) ainda precisa ser gerada localmente por um
// humano (npm run onvio-login exige verificação em duas etapas), mas depois de gerada uma vez, é
// só enviar o arquivo pela tela (ver POST /api/dominio/onvio-sessao) — o dia a dia deixa de
// depender de qualquer computador ficar ligado.
function onvioSessionPath(escritorioId: number): string {
  const dir = path.join(__dirname, "..", "data");
  // escritório 1 mantém o caminho antigo (compatível com o arquivo já usado pelo agente local via
  // DOMINIO_ONVIO_SESSION_PATH) — outros escritórios ganham um arquivo próprio.
  return escritorioId === 1 ? path.join(dir, "onvio-session.json") : path.join(dir, `onvio-session-${escritorioId}.json`);
}
interface SaudeOnvio {
  nuncaConfigurado: boolean;
  quebrado: boolean;
  falhasConsecutivas: number;
  quebradoDesde: string | null;
  horasQuebrado: number | null;
  ultimoErro: string | null;
}
// Calcula se a sincronização automática com o Onvio está quebrada há tempo suficiente pra avisar —
// olha só origem='nuvem' (só essa função grava esse valor; sucesso/erro em executarSincronizacaoOnvio
// abaixo), contando quantas falhas seguidas tem no topo do log (sem nenhum sucesso no meio) e desde
// quando a mais antiga dessa sequência aconteceu. 3+ falhas seguidas E 3h+ de quebra evita alarme por
// um blip isolado, mas pega rápido um problema real (achado ao vivo: uma sessão morreu ~1h depois de
// enviada e ficou 36h falhando de hora em hora sem ninguém notar). Sem nenhuma linha ainda
// (nuncaConfigurado), nunca é "quebrado" — não é a mesma coisa que "nunca configurado".
function calcularSaudeOnvio(): SaudeOnvio {
  const rows = sqlite
    .prepare(`SELECT status, executado_em, detalhe FROM dominio_sync_log WHERE origem = 'nuvem' ORDER BY id DESC LIMIT 50`)
    .all() as { status: string; executado_em: string; detalhe: string | null }[];
  if (rows.length === 0) {
    return { nuncaConfigurado: true, quebrado: false, falhasConsecutivas: 0, quebradoDesde: null, horasQuebrado: null, ultimoErro: null };
  }
  let falhasConsecutivas = 0;
  let quebradoDesde: string | null = null;
  let ultimoErro: string | null = null;
  for (const r of rows) {
    if (r.status !== "erro") break;
    falhasConsecutivas++;
    quebradoDesde = r.executado_em; // sobrescrito a cada volta — termina com a falha mais antiga do streak
    if (ultimoErro === null) ultimoErro = r.detalhe;
  }
  // executado_em vem de datetime('now') do SQLite — "AAAA-MM-DD HH:MM:SS" em UTC, sem "Z". Mesma
  // conversão já usada no front (fmtDate/fmtDateHora, app.html).
  const horasQuebrado = quebradoDesde ? (Date.now() - new Date(quebradoDesde.replace(" ", "T") + "Z").getTime()) / 3600000 : null;
  return {
    nuncaConfigurado: false,
    quebrado: falhasConsecutivas >= 3 && horasQuebrado !== null && horasQuebrado >= 3,
    falhasConsecutivas,
    quebradoDesde,
    horasQuebrado: horasQuebrado !== null ? Math.floor(horasQuebrado) : null,
    ultimoErro,
  };
}
async function executarSincronizacaoOnvio(escritorioId: number, jobId?: number): Promise<void> {
  try {
    const items = (await buscarViaOnvio(onvioSessionPath(escritorioId))).filter((it) => it.codigo && it.nome);
    let novas = 0, atualizadas = 0;
    const getByCodigo = sqlite.prepare(`SELECT id FROM empresas WHERE codigo_dominio = ? AND escritorio_id = ?`);
    const insert = sqlite.prepare(
      `INSERT INTO empresas (nome, cnpj, codigo_dominio, apelido, email, telefone, endereco, cidade, uf, cep, inscricao_municipal, inscricao_estadual, nome_representante_legal, cpf_representante_legal, origem, escritorio_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'dominio', ?)`
    );
    const update = sqlite.prepare(
      `UPDATE empresas SET nome=?, cnpj=COALESCE(?, cnpj), apelido=COALESCE(?, apelido), email=COALESCE(?, email), telefone=COALESCE(?, telefone),
         endereco=COALESCE(?, endereco), cidade=COALESCE(?, cidade), uf=COALESCE(?, uf), cep=COALESCE(?, cep),
         inscricao_municipal=COALESCE(?, inscricao_municipal), inscricao_estadual=COALESCE(?, inscricao_estadual),
         nome_representante_legal=COALESCE(?, nome_representante_legal), cpf_representante_legal=COALESCE(?, cpf_representante_legal),
         updated_at=datetime('now') WHERE id=?`
    );
    // situação (ativo/inativo) não vem na API do Onvio — não mexe nesse campo pra não
    // reativar/desativar uma empresa por engano (mesma regra do agente local).
    for (const it of items) {
      const existente = getByCodigo.get(String(it.codigo), escritorioId) as any;
      if (existente) {
        update.run(
          it.nome, it.cnpj || null, it.apelido || null, it.email || null, it.telefone || null, it.endereco || null,
          it.cidade || null, it.uf || null, it.cep || null, it.inscricaoMunicipal || null,
          it.inscricaoEstadual || null, it.nomeRepresentanteLegal || null, it.cpfRepresentanteLegal || null,
          existente.id
        );
        atualizadas++;
      } else {
        insert.run(
          it.nome, it.cnpj || null, String(it.codigo), it.apelido || null, it.email || null, it.telefone || null,
          it.endereco || null, it.cidade || null, it.uf || null, it.cep || null,
          it.inscricaoMunicipal || null, it.inscricaoEstadual || null, it.nomeRepresentanteLegal || null,
          it.cpfRepresentanteLegal || null, escritorioId
        );
        novas++;
      }
    }
    sqlite.prepare(`INSERT INTO dominio_sync_log (origem, empresas_novas, empresas_atualizadas, status) VALUES ('nuvem', ?, ?, 'ok')`).run(novas, atualizadas);
    if (jobId) sqlite.prepare(`UPDATE dominio_sync_jobs SET status='ok', novas=?, atualizadas=?, resolvido_em=datetime('now') WHERE id=?`).run(novas, atualizadas, jobId);
  } catch (e: any) {
    sqlite.prepare(`INSERT INTO dominio_sync_log (origem, empresas_novas, empresas_atualizadas, status, detalhe) VALUES ('nuvem', 0, 0, 'erro', ?)`).run(e.message);
    if (jobId) sqlite.prepare(`UPDATE dominio_sync_jobs SET status='erro', erro=?, resolvido_em=datetime('now') WHERE id=?`).run(e.message, jobId);
    else console.error("Falha na sincronização automática de clientes via Onvio:", e.message);
  }
}
app.get("/api/dominio/onvio-sessao", blockCliente, requirePermissao("configuracoes", "visualizar"), (req, res) => {
  const p = onvioSessionPath((req as any).user.escritorioId);
  const existe = fs.existsSync(p);
  res.json({ existe, atualizadaEm: existe ? fs.statSync(p).mtime.toISOString() : null });
});
app.post("/api/dominio/onvio-sessao", blockCliente, requirePermissao("configuracoes", "editar"), upload.single("arquivo"), (req, res) => {
  const file = (req as any).file;
  if (!file) return res.status(400).json({ error: 'Envie o arquivo "onvio-session.json" gerado por "npm run onvio-login".' });
  let parsed: any;
  try {
    parsed = JSON.parse(file.buffer.toString("utf8"));
  } catch {
    return res.status(400).json({ error: 'Arquivo inválido — precisa ser o "onvio-session.json" gerado pelo login (JSON), não outro tipo de arquivo.' });
  }
  if (!parsed || !Array.isArray(parsed.cookies)) {
    return res.status(400).json({ error: 'O arquivo enviado não parece ser uma sessão salva pelo Playwright (esperava a chave "cookies").' });
  }
  const p = onvioSessionPath((req as any).user.escritorioId);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, file.buffer);
  res.json({ ok: true });
});
// Sincronização via Onvio: SÓ manual, por pedido explícito do usuário (2026-09-23) — a automática de
// hora em hora (setInterval, removida) ficava tentando sozinha mesmo com a sessão já morta, empilhando
// falha atrás de falha sem ninguém perceber na hora (o comentário de calcularSaudeOnvio documenta um
// caso real: sessão morreu ~1h depois de enviada e ficou 36h falhando de hora em hora). Sem
// sincronização automática nenhuma agora — só o botão "Atualizar Empresas"
// (POST /api/dominio/sincronizar-empresas, acima) chama executarSincronizacaoOnvio, na hora que o
// usuário souber que a sessão está fresca.

// ---- FGTS Digital: busca da Guia (GFD) ----
// Confirmado em teste real que a sessão autenticada do FGTS Digital NÃO sobrevive fora do
// navegador/conexão que fez o login (mesmo reapresentando o mesmo certificado depois, o próprio
// site detecta "Erro de Login" e devolve a tela pública) — proteção do próprio gov.br contra sessão
// "vazada" pra outro processo, não um bug daqui. Por isso, diferente do padrão da Onvio, o servidor
// NUNCA roda o Playwright do FGTS Digital sozinho: quem faz login E busca as guias, numa tacada só,
// é o próprio usuário rodando `npm run fgts-login` no computador dele (ver fgts-login-setup.ts) — o
// servidor só entra depois, recebendo cada guia já pronta via POST /api/fgts/guia.
// Mesma regra definitiva do DAS/DARF DCTF-Web (ver envioJaTemDocumento): a primeira vez que acha a
// guia de uma competência, anexa e envia; nas buscas seguintes ("npm run fgts-login" de novo), só
// confirma que já foi enviada e não reenvia sozinha — sem tentar detectar "atualização" comparando
// conteúdo (foi exatamente isso que gerou reenvio falso em produção no DAS/DARF). Devolve null quando
// não enviou nada (já tinha sido enviada antes), ou o id do documento quando enviou.
function fgtsAnexarGuiaEmEnvio(escritorioId: number, empresaId: number, ano: number, mes: number, pdfBase64: string): number | null {
  const atribuicaoId = integraContadorObterOuCriarAtribuicaoModelo(
    escritorioId,
    empresaId,
    "Guia FGTS Digital",
    "Guia do FGTS (GFD) gerada automaticamente a partir do FGTS Digital"
  );
  const periodo = sqlite.prepare(`SELECT id FROM envio_periodos WHERE atribuicao_id = ? AND ano = ? AND mes = ?`).get(atribuicaoId, ano, mes) as any;
  if (periodo && envioJaTemDocumento(periodo.id)) return null; // já enviada uma vez — não reenvia sozinha
  const nomeArquivo = `Guia FGTS ${MESES_PT_EXTENSO[mes - 1]} ${ano}.pdf`;
  const rotulo = `${String(mes).padStart(2, "0")}/${ano}`;
  const docId = integraContadorAnexarPdfEmEnvio(
    atribuicaoId, empresaId, ano, mes, nomeArquivo, pdfBase64,
    `Guia FGTS Digital referente a ${rotulo}, gerada automaticamente.`,
    null
  );
  void envioEnviarDocumentoAutomatico({
    escritorioId, empresaId, docId,
    fileName: nomeArquivo,
    pdf: Buffer.from(pdfBase64, "base64"),
    assunto: `Guia FGTS — ${rotulo}`,
    corpoEmail: `Segue em anexo a guia do FGTS (GFD) referente a ${rotulo}.`,
    descricaoWhatsapp: `Guia do FGTS — ${rotulo}`,
  }).catch((e) => console.error(`[FGTS Digital] envio automático da guia (empresa ${empresaId}) falhou:`, e.message));
  return docId;
}
// Lida por fgts-login-setup.ts logo depois de logar, pra saber quais empresas buscar.
app.get("/api/fgts/empresas-marcadas", blockCliente, requirePermissao("empresas", "visualizar"), (req, res) => {
  const rows = sqlite
    .prepare(`SELECT id as empresaId, cnpj, nome FROM empresas WHERE escritorio_id = ? AND ativo = 1 AND busca_fgts = 1 ORDER BY nome`)
    .all((req as any).user.escritorioId) as any[];
  res.json({ items: rows });
});
// Recebe o resultado de UMA empresa, enviado por fgts-login-setup.ts ao vivo, logo depois de buscar
// a guia dela no mesmo navegador logado (ver buscarGuiaFgtsEmpresa em fgts-automacao.ts).
app.post("/api/fgts/guia", blockCliente, requirePermissao("empresas", "postar"), (req, res) => {
  const user = (req as any).user;
  const { empresaId, ano, mes, ok, guiaGerada, pdfBase64, erro } = req.body || {};
  const idNum = Number(empresaId);
  if (!idNum || !podeAcessarEmpresa(user, idNum)) return res.status(404).json({ error: "Empresa não encontrada." });
  let erroFinal: string | null = ok ? null : String(erro || "Falha desconhecida.");
  if (ok && guiaGerada && pdfBase64) {
    try {
      fgtsAnexarGuiaEmEnvio(user.escritorioId, idNum, Number(ano), Number(mes), pdfBase64);
    } catch (e: any) {
      erroFinal = `Guia gerada, mas falhou ao anexar em Envio de Documentos: ${e.message}`;
    }
  }
  sqlite.prepare(`UPDATE empresas SET fgts_ultima_busca_em = datetime('now'), fgts_ultimo_erro = ? WHERE id = ?`).run(erroFinal, idNum);
  res.json({ ok: true });
});

app.get("/api/dominio/config", blockCliente, requirePermissao("configuracoes", "visualizar"), (req, res) => {
  const c = getDominioConfig((req as any).user.escritorioId);
  res.json({
    source: c.source || "",
    dbDriver: c.db_driver || "",
    dbHost: c.db_host || "",
    dbPort: c.db_port || "",
    dbName: c.db_name || "",
    dbUser: c.db_user || "",
    temSenhaBanco: !!c.db_password,
    dbConnectString: c.db_connect_string || "",
    queryClientes: c.query_clientes || "",
    colCodigo: c.col_codigo || "CODIGO",
    colNome: c.col_nome || "NOME",
    colCnpj: c.col_cnpj || "CNPJ",
    colStatus: c.col_status || "STATUS",
    apiUrl: c.api_url || "",
    temTokenApi: !!c.api_token,
    xmlExportAtivo: !!c.xml_export_ativo,
    xmlExportDir: c.xml_export_dir || "",
    updatedAt: c.updated_at || null,
  });
});
app.put("/api/dominio/config", blockCliente, requirePermissao("configuracoes", "editar"), (req, res) => {
  const escritorioId = (req as any).user.escritorioId;
  const b = req.body || {};
  const atual = getDominioConfig(escritorioId);
  sqlite
    .prepare(
      `INSERT INTO dominio_config (escritorio_id, source, db_driver, db_host, db_port, db_name, db_user, db_password, db_connect_string, query_clientes, col_codigo, col_nome, col_cnpj, col_status, api_url, api_token, xml_export_ativo, xml_export_dir, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(escritorio_id) DO UPDATE SET source=excluded.source, db_driver=excluded.db_driver, db_host=excluded.db_host,
         db_port=excluded.db_port, db_name=excluded.db_name, db_user=excluded.db_user,
         db_password=excluded.db_password, db_connect_string=excluded.db_connect_string,
         query_clientes=excluded.query_clientes, col_codigo=excluded.col_codigo, col_nome=excluded.col_nome,
         col_cnpj=excluded.col_cnpj, col_status=excluded.col_status, api_url=excluded.api_url,
         api_token=excluded.api_token, xml_export_ativo=excluded.xml_export_ativo, xml_export_dir=excluded.xml_export_dir,
         updated_at=datetime('now')`
    )
    .run(
      escritorioId,
      b.source || "",
      b.dbDriver || null,
      b.dbHost || null,
      b.dbPort ? Number(b.dbPort) : null,
      b.dbName || null,
      b.dbUser || null,
      b.dbPassword ? String(b.dbPassword) : atual.db_password || null, // vazio = mantém a senha já salva
      b.dbConnectString || null,
      b.queryClientes || null,
      b.colCodigo || "CODIGO",
      b.colNome || "NOME",
      b.colCnpj || "CNPJ",
      b.colStatus || "STATUS",
      b.apiUrl || null,
      b.apiToken ? String(b.apiToken) : atual.api_token || null,
      b.xmlExportAtivo ? 1 : 0,
      b.xmlExportDir || null
    );
  res.json({ ok: true });
});
// Pede pro agente testar a conexão agora (o teste roda na máquina do agente, não na nuvem —
// ela é quem tem acesso à rede do Domínio Web). O front faz polling neste id até status != pending.
app.post("/api/dominio/testar-conexao", blockCliente, requirePermissao("configuracoes", "visualizar"), (req, res) => {
  const user = (req as any).user;
  const info = sqlite.prepare(`INSERT INTO dominio_test_jobs (status, criado_por) VALUES ('pending', ?)`).run(user.id);
  res.json({ id: Number(info.lastInsertRowid) });
});
app.get("/api/dominio/testar-conexao/:id", blockCliente, requirePermissao("configuracoes", "visualizar"), (req, res) => {
  const row = sqlite.prepare(`SELECT * FROM dominio_test_jobs WHERE id = ?`).get(Number(req.params.id)) as any;
  if (!row) return res.status(404).json({ error: "Teste não encontrado." });
  res.json({ status: row.status, resultado: row.resultado_json ? JSON.parse(row.resultado_json) : null, erro: row.erro });
});

// Botão "Atualizar Empresas" — pede uma sincronização imediata. No modo "onvio" com a sessão já
// salva na nuvem, o próprio servidor resolve na hora (sem depender de nenhum agente local ligado);
// nos outros modos (banco de dados/API HTTP, que exigem rede local do escritório), o job fica
// pendente e o agente local atende no ciclo rápido, de ~12 em 12s.
app.post("/api/dominio/sincronizar-empresas", blockCliente, requirePermissao("empresas", "postar"), (req, res) => {
  const user = (req as any).user;
  const info = sqlite.prepare(`INSERT INTO dominio_sync_jobs (status, criado_por) VALUES ('pending', ?)`).run(user.id);
  const jobId = Number(info.lastInsertRowid);
  const cfg = getDominioConfig(user.escritorioId);
  if (cfg.source === "onvio" && fs.existsSync(onvioSessionPath(user.escritorioId))) {
    executarSincronizacaoOnvio(user.escritorioId, jobId);
  }
  res.json({ id: jobId });
});
app.get("/api/dominio/sincronizar-empresas/:id", blockCliente, requirePermissao("empresas", "visualizar"), (req, res) => {
  const row = sqlite.prepare(`SELECT * FROM dominio_sync_jobs WHERE id = ?`).get(Number(req.params.id)) as any;
  if (!row) return res.status(404).json({ error: "Sincronização não encontrada." });
  res.json({ status: row.status, novas: row.novas, atualizadas: row.atualizadas, erro: row.erro });
});

// ---------- Checklist / Solicitações ----------
app.get("/api/checklist/templates", blockCliente, requirePermissao("solicitacoes", "visualizar"), (req, res) => {
  const rows = sqlite.prepare(`SELECT * FROM checklist_templates WHERE escritorio_id = ? ORDER BY nome`).all((req as any).user.escritorioId) as any[];
  res.json({ items: rows.map((r) => ({ ...r, itens: JSON.parse(r.itens_json) })) });
});
app.post("/api/checklist/templates", blockCliente, requirePermissao("solicitacoes", "postar"), (req, res) => {
  const user = (req as any).user;
  const { nome, descricao, periodicidade, itens, notificarEmail, prazoDia } = req.body || {};
  if (!nome || !Array.isArray(itens) || !itens.length) return res.status(400).json({ error: "Informe o nome e ao menos um item para anexar." });
  const itensNormalizados = itens.map((it: any, i: number) => ({
    chave: it.chave || `item${i + 1}`,
    label: it.label || `Item ${i + 1}`,
    accept: Array.isArray(it.accept) && it.accept.length ? it.accept : ["qualquer"],
    obrigatorio: it.obrigatorio !== false,
  }));
  const prazoDiaNum = prazoDia ? Math.min(28, Math.max(1, Number(prazoDia))) : null;
  const info = sqlite
    .prepare(`INSERT INTO checklist_templates (nome, descricao, periodicidade, itens_json, notificar_email, prazo_dia, created_by, escritorio_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(nome, descricao || null, periodicidade || "mensal", JSON.stringify(itensNormalizados), notificarEmail ? 1 : 0, prazoDiaNum, user.id, user.escritorioId);
  res.json({ id: Number(info.lastInsertRowid) });
});
app.put("/api/checklist/templates/:id", blockCliente, requirePermissao("solicitacoes", "editar"), (req, res) => {
  const id = Number(req.params.id);
  const existing = sqlite.prepare(`SELECT * FROM checklist_templates WHERE id = ? AND escritorio_id = ?`).get(id, (req as any).user.escritorioId) as any;
  if (!existing) return res.status(404).json({ error: "Modelo não encontrado." });
  const { nome, descricao, itens, notificarEmail, ativo, prazoDia } = req.body || {};
  const itensJson = Array.isArray(itens) ? JSON.stringify(itens) : existing.itens_json;
  const prazoDiaNum = prazoDia === undefined ? existing.prazo_dia : prazoDia ? Math.min(28, Math.max(1, Number(prazoDia))) : null;
  sqlite
    .prepare(`UPDATE checklist_templates SET nome=?, descricao=?, itens_json=?, notificar_email=?, ativo=?, prazo_dia=? WHERE id=?`)
    .run(
      nome ?? existing.nome,
      descricao !== undefined ? descricao : existing.descricao,
      itensJson,
      notificarEmail === undefined ? existing.notificar_email : notificarEmail ? 1 : 0,
      ativo === undefined ? existing.ativo : ativo ? 1 : 0,
      prazoDiaNum,
      id
    );
  res.json({ ok: true });
});
app.delete("/api/checklist/templates/:id", requireAdmin, (req, res) => {
  sqlite.prepare(`DELETE FROM checklist_templates WHERE id = ? AND escritorio_id = ?`).run(Number(req.params.id), (req as any).user.escritorioId);
  res.json({ ok: true });
});

app.get("/api/checklist/atribuicoes", blockCliente, requirePermissao("solicitacoes", "visualizar"), (req, res) => {
  const user = (req as any).user;
  const empresaId = req.query.empresaId ? Number(req.query.empresaId) : null;
  if (empresaId && !podeAcessarEmpresa(user, empresaId)) return res.status(403).json({ error: "Sem acesso a esta empresa." });
  let sql = `SELECT a.*, t.nome as templateNome, t.periodicidade, t.itens_json as itensJson, e.nome as empresaNome
             FROM checklist_atribuicoes a
             JOIN checklist_templates t ON t.id = a.template_id
             JOIN empresas e ON e.id = a.empresa_id
             WHERE e.ativo = 1`;
  const params: any[] = [];
  if (empresaId) {
    sql += ` AND a.empresa_id = ?`;
    params.push(empresaId);
  }
  sql += ` ORDER BY e.nome, t.nome`;
  let rows = sqlite.prepare(sql).all(...params) as any[];
  const visiveis = empresasVisiveis(user);
  if (visiveis !== null) rows = rows.filter((r) => visiveis.includes(r.empresa_id));
  res.json({ items: rows.map((r) => ({ ...r, itens: JSON.parse(r.itensJson), temAnexos: atribuicaoTemAnexos(r.id) })) });
});
// Cliente: lista só as próprias atribuições (a rota acima é bloqueada para este perfil)
app.get("/api/checklist/minhas-atribuicoes", (req, res) => {
  const user = (req as any).user;
  if (user.perfil !== "Cliente") return res.status(403).json({ error: "Rota exclusiva para clientes." });
  if (!user.empresaId) return res.json({ items: [] });
  const rows = sqlite
    .prepare(
      `SELECT a.*, t.nome as templateNome, t.periodicidade, t.itens_json as itensJson, e.nome as empresaNome
       FROM checklist_atribuicoes a
       JOIN checklist_templates t ON t.id = a.template_id
       JOIN empresas e ON e.id = a.empresa_id
       WHERE a.empresa_id = ? AND a.ativo = 1 ORDER BY t.nome`
    )
    .all(user.empresaId) as any[];
  res.json({ items: rows.map((r) => ({ ...r, itens: JSON.parse(r.itensJson) })) });
});

app.post("/api/checklist/atribuicoes", blockCliente, requirePermissao("solicitacoes", "postar"), (req, res) => {
  const user = (req as any).user;
  const { templateId, empresaId } = req.body || {};
  if (!templateId || !empresaId) return res.status(400).json({ error: "Selecione o modelo e a empresa." });
  if (!podeAcessarEmpresa(user, Number(empresaId))) return res.status(403).json({ error: "Sem acesso a esta empresa." });
  const template = sqlite.prepare(`SELECT id FROM checklist_templates WHERE id = ? AND escritorio_id = ?`).get(Number(templateId), user.escritorioId);
  if (!template) return res.status(404).json({ error: "Modelo não encontrado." });
  try {
    const info = sqlite
      .prepare(`INSERT INTO checklist_atribuicoes (template_id, empresa_id, created_by) VALUES (?, ?, ?)`)
      .run(Number(templateId), Number(empresaId), user.id);
    res.json({ id: Number(info.lastInsertRowid) });
  } catch (e: any) {
    if (String(e.message).includes("UNIQUE")) return res.status(409).json({ error: "Este modelo já está atribuído a esta empresa." });
    res.status(500).json({ error: e.message });
  }
});
app.delete("/api/checklist/atribuicoes/:id", blockCliente, requirePermissao("solicitacoes", "editar"), (req, res) => {
  const id = Number(req.params.id);
  const atrib = sqlite.prepare(`SELECT empresa_id FROM checklist_atribuicoes WHERE id = ?`).get(id) as any;
  if (!atrib || !podeAcessarEmpresa((req as any).user, atrib.empresa_id)) return res.status(404).json({ error: "Atribuição não encontrada." });
  if (atribuicaoTemAnexos(id)) {
    return res.status(409).json({ error: "Já existe documento anexado nesta solicitação — não é possível excluir." });
  }
  sqlite.prepare(`DELETE FROM checklist_atribuicoes WHERE id = ?`).run(id);
  res.json({ ok: true });
});

// Gera os períodos de um ano (12 meses, 1 anual, ou 1 avulso com rótulo customizado)
app.post("/api/checklist/periodos/gerar", blockCliente, requirePermissao("solicitacoes", "postar"), (req, res) => {
  const { atribuicaoId, ano, rotulo } = req.body || {};
  const atrib = sqlite.prepare(`SELECT a.*, t.periodicidade FROM checklist_atribuicoes a JOIN checklist_templates t ON t.id = a.template_id WHERE a.id = ?`).get(Number(atribuicaoId)) as any;
  if (!atrib || !podeAcessarEmpresa((req as any).user, atrib.empresa_id)) return res.status(404).json({ error: "Atribuição não encontrada." });
  const insert = sqlite.prepare(`INSERT OR IGNORE INTO checklist_periodos (atribuicao_id, ano, mes, rotulo) VALUES (?, ?, ?, ?)`);
  let criados = 0;
  if (atrib.periodicidade === "mensal") {
    for (let mes = 1; mes <= 12; mes++) {
      const info = insert.run(atrib.id, Number(ano), mes, null);
      if (info.changes) criados++;
    }
  } else if (atrib.periodicidade === "anual") {
    const info = insert.run(atrib.id, Number(ano), null, null);
    if (info.changes) criados++;
  } else {
    // avulso: cada chamada cria uma solicitação pontual nova com rótulo próprio (ex.: "Extrato de Financiamento nº 4521")
    const info = insert.run(atrib.id, Number(ano) || new Date().getFullYear(), null, rotulo || `Solicitação avulsa ${Date.now()}`);
    if (info.changes) criados++;
  }
  res.json({ ok: true, criados });
});

// Grade completa (períodos + status de upload de cada item) de uma atribuição — usada tanto pelo admin quanto pelo cliente
app.get("/api/checklist/grade/:atribuicaoId", (req, res) => {
  const user = (req as any).user;
  const atribuicaoId = Number(req.params.atribuicaoId);
  const atrib = sqlite
    .prepare(
      `SELECT a.*, t.nome as templateNome, t.periodicidade, t.itens_json as itensJson, e.nome as empresaNome
       FROM checklist_atribuicoes a JOIN checklist_templates t ON t.id = a.template_id JOIN empresas e ON e.id = a.empresa_id WHERE a.id = ?`
    )
    .get(atribuicaoId) as any;
  if (!atrib) return res.status(404).json({ error: "Atribuição não encontrada." });
  if (user.perfil === "Cliente" && user.empresaId !== atrib.empresa_id) return res.status(403).json({ error: "Sem acesso." });
  if (user.perfil === "Colaborador" && !hasPermissao(user, "solicitacoes", "visualizar")) return res.status(403).json({ error: "Sem permissão." });
  if (user.perfil !== "Cliente" && !podeAcessarEmpresa(user, atrib.empresa_id)) return res.status(403).json({ error: "Sem acesso a esta empresa." });

  const periodos = sqlite.prepare(`SELECT * FROM checklist_periodos WHERE atribuicao_id = ? ORDER BY ano DESC, mes ASC`).all(atribuicaoId) as any[];
  const periodoIds = periodos.map((p) => p.id);
  // Traz salvo + substituído junto (não só 'salvo' como antes) — precisa dos dois: 'salvo' vira a
  // lista de anexos ativos do slot (pode ter mais de um agora, ver "adicional" no POST de upload
  // abaixo) e o 'substituído' mais recente vira só a legenda "Anterior: ... (substituído)" de
  // referência quando o admin reabre o item.
  const uploads = periodoIds.length
    ? (sqlite.prepare(`SELECT * FROM checklist_uploads WHERE periodo_id IN (${periodoIds.map(() => "?").join(",")}) ORDER BY id DESC`).all(...periodoIds) as any[])
    : [];
  const reaberturasAbertas = periodoIds.length
    ? (sqlite
        .prepare(`SELECT * FROM checklist_reaberturas WHERE periodo_id IN (${periodoIds.map(() => "?").join(",")}) AND resolvido = 0`)
        .all(...periodoIds) as any[])
    : [];

  const uploadsPorSlot = new Map<string, any[]>();
  for (const u of uploads) {
    const key = `${u.periodo_id}:${u.item_chave}`;
    if (!uploadsPorSlot.has(key)) uploadsPorSlot.set(key, []);
    uploadsPorSlot.get(key)!.push(u); // ORDER BY id DESC já garante mais recente primeiro
  }
  const reaberturaPorSlot = new Map<string, any>();
  for (const r of reaberturasAbertas) reaberturaPorSlot.set(`${r.periodo_id}:${r.item_chave}`, r);

  const itens = JSON.parse(atrib.itensJson);
  const grade = periodos.map((p) => ({
    periodoId: p.id,
    ano: p.ano,
    mes: p.mes,
    rotulo: p.rotulo,
    slots: itens.map((it: any) => {
      const key = `${p.id}:${it.chave}`;
      const todosDoSlot = uploadsPorSlot.get(key) || [];
      const salvos = todosDoSlot.filter((u) => u.status === "salvo");
      const ultimoSubstituido = todosDoSlot.find((u) => u.status === "substituido") || null;
      const reaberto = reaberturaPorSlot.get(key);
      return {
        chave: it.chave,
        label: it.label,
        accept: it.accept,
        obrigatorio: it.obrigatorio,
        travado: salvos.length > 0 && !reaberto,
        reaberto: !!reaberto,
        motivoReabertura: reaberto?.motivo || null,
        uploads: salvos.map((u) => ({ id: u.id, fileName: u.file_name, sizeBytes: u.size_bytes, uploadedAt: u.uploaded_at })),
        ultimoSubstituido: ultimoSubstituido ? { fileName: ultimoSubstituido.file_name } : null,
      };
    }),
  }));

  res.json({
    atribuicao: { id: atrib.id, templateNome: atrib.templateNome, periodicidade: atrib.periodicidade, empresaNome: atrib.empresaNome, empresaId: atrib.empresa_id },
    grade,
  });
});

// Cliente (ou colaborador com permissão) anexa e salva um arquivo num slot — trava automaticamente após salvar
app.post("/api/checklist/periodos/:periodoId/upload", upload.single("arquivo"), (req, res) => {
  const user = (req as any).user;
  const periodoId = Number(req.params.periodoId);
  const itemChave = String(req.body?.itemChave || "");
  if (!req.file || !itemChave) return res.status(400).json({ error: "Selecione o arquivo e o item correspondente." });
  req.file.originalname = corrigirNomeArquivo(req.file.originalname);

  const periodo = sqlite
    .prepare(`SELECT p.*, a.empresa_id as empresaId, t.itens_json as itensJson FROM checklist_periodos p
               JOIN checklist_atribuicoes a ON a.id = p.atribuicao_id JOIN checklist_templates t ON t.id = a.template_id WHERE p.id = ?`)
    .get(periodoId) as any;
  if (!periodo) return res.status(404).json({ error: "Período não encontrado." });

  if (user.perfil === "Cliente") {
    // Cliente sempre pode postar na própria empresa — não passa pelo requirePermissao de colaborador.
    if (user.empresaId !== periodo.empresaId) return res.status(403).json({ error: "Sem acesso a esta empresa." });
  } else if (user.perfil === "Colaborador") {
    if (!hasPermissao(user, "solicitacoes", "postar")) return res.status(403).json({ error: "Sem permissão para anexar." });
    if (!podeAcessarEmpresa(user, periodo.empresaId)) return res.status(403).json({ error: "Sem acesso a esta empresa." });
  }

  const itens = JSON.parse(periodo.itensJson);
  const item = itens.find((it: any) => it.chave === itemChave);
  if (!item) return res.status(400).json({ error: "Item inválido." });
  if (!extensaoPermitida(item.accept, req.file.originalname)) {
    return res.status(400).json({ error: `Tipo de arquivo não permitido para "${item.label}". Aceito: ${item.accept.join(", ")}.` });
  }

  const jaSalvo = sqlite
    .prepare(`SELECT * FROM checklist_uploads WHERE periodo_id = ? AND item_chave = ? AND status = 'salvo' ORDER BY id DESC LIMIT 1`)
    .get(periodoId, itemChave) as any;
  const reabertura = sqlite
    .prepare(`SELECT * FROM checklist_reaberturas WHERE periodo_id = ? AND item_chave = ? AND resolvido = 0 ORDER BY id DESC LIMIT 1`)
    .get(periodoId, itemChave) as any;
  // "adicional" deixa o escritório anexar MAIS um documento no mesmo item sem precisar reabrir
  // (ex.: extrato da conta corrente + extrato de aplicação no mesmo mês) — só pra quem já tem
  // permissão de postar aqui (Colaborador/Administrador); o Cliente continua sempre travado até
  // o escritório reabrir explicitamente, pra não perder o controle de auditoria do que ele mandou.
  const adicional = String(req.body?.adicional) === "true" && user.perfil !== "Cliente";
  if (jaSalvo && !reabertura && !adicional) {
    return res.status(409).json({ error: "Este documento já foi enviado e está travado. Peça ao administrador para reabrir a solicitação." });
  }

  const versao = jaSalvo ? jaSalvo.versao + 1 : 1;
  const dir = empresaSlotDir(periodo.empresaId, periodoId);
  fs.mkdirSync(dir, { recursive: true });
  const nomeSeguro = `${itemChave}_v${versao}_${Date.now()}${path.extname(req.file.originalname)}`;
  const destino = path.join(dir, nomeSeguro);
  fs.writeFileSync(destino, req.file.buffer);

  // Só marca o anterior como substituído numa troca de verdade (primeiro upload, ou reabertura) —
  // um "adicional" soma ao lado do que já existe, não troca nada.
  if (jaSalvo && !adicional) sqlite.prepare(`UPDATE checklist_uploads SET status = 'substituido' WHERE id = ?`).run(jaSalvo.id);
  const info = sqlite
    .prepare(
      `INSERT INTO checklist_uploads (periodo_id, item_chave, versao, file_name, file_path, mime, size_bytes, status, uploaded_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'salvo', ?)`
    )
    .run(periodoId, itemChave, versao, req.file.originalname, destino, req.file.mimetype, req.file.size, user.id);
  // Idem: um "adicional" não resolve uma reabertura aberta — ela continua pedindo a substituição
  // de verdade, independente de outro documento ter sido incluído do lado.
  if (reabertura && !adicional) sqlite.prepare(`UPDATE checklist_reaberturas SET resolvido = 1 WHERE id = ?`).run(reabertura.id);

  res.json({ id: Number(info.lastInsertRowid), ok: true });
});

// Reabertura (só administrador ou colaborador com permissão de editar): destrava o slot sem apagar o histórico
app.post("/api/checklist/uploads/:uploadId/reabrir", blockCliente, requirePermissao("solicitacoes", "editar"), (req, res) => {
  const user = (req as any).user;
  const uploadId = Number(req.params.uploadId);
  const { motivo } = req.body || {};
  const uploadRow = sqlite
    .prepare(
      `SELECT u.*, a.empresa_id as empresaId FROM checklist_uploads u
       JOIN checklist_periodos p ON p.id = u.periodo_id
       JOIN checklist_atribuicoes a ON a.id = p.atribuicao_id
       WHERE u.id = ?`
    )
    .get(uploadId) as any;
  if (!uploadRow || !podeAcessarEmpresa(user, uploadRow.empresaId)) return res.status(404).json({ error: "Anexo não encontrado." });
  sqlite
    .prepare(`UPDATE checklist_uploads SET reaberto_por = ?, reaberto_em = datetime('now'), reaberto_motivo = ? WHERE id = ?`)
    .run(user.id, motivo || null, uploadId);
  sqlite
    .prepare(`INSERT INTO checklist_reaberturas (periodo_id, item_chave, motivo, reaberto_por) VALUES (?, ?, ?, ?)`)
    .run(uploadRow.periodo_id, uploadRow.item_chave, motivo || null, user.id);
  res.json({ ok: true });
});

// Download (admin/colaborador com permissão) — cliente não tem endpoint de download por design (só o que ele mesmo já vê na tela)
app.get("/api/checklist/uploads/:uploadId/download", blockCliente, requirePermissao("solicitacoes", "visualizar"), (req, res) => {
  const uploadRow = sqlite
    .prepare(
      `SELECT u.*, a.empresa_id as empresaId FROM checklist_uploads u
       JOIN checklist_periodos p ON p.id = u.periodo_id
       JOIN checklist_atribuicoes a ON a.id = p.atribuicao_id
       WHERE u.id = ?`
    )
    .get(Number(req.params.uploadId)) as any;
  if (!uploadRow || !podeAcessarEmpresa((req as any).user, uploadRow.empresaId) || !fs.existsSync(uploadRow.file_path)) {
    return res.status(404).json({ error: "Arquivo não encontrado." });
  }
  res.download(uploadRow.file_path, uploadRow.file_name);
});

// ---------- Envio de Documentos (o escritório posta e o cliente recebe — sentido contrário de Solicitações) ----------
// Modelos de Envio de Documentos criados/reaproveitados automaticamente pelo Integra Contador
// (integraContadorObterOuCriarAtribuicaoModelo busca por esse nome exato) — excluir ou renomear
// qualquer um deles quebra silenciosamente o anexo automático de DAS/Situação Fiscal (a próxima
// busca automática cria um modelo NOVO em vez de reaproveitar, perdendo a ligação com o histórico
// já entregue ao cliente).
const ENVIO_TEMPLATES_PROTEGIDOS = [
  "DAS - Mensal",
  "Consultar Situação Fiscal - RFB",
  "DARF - DCTF-Web",
  "Balanço",
  "Balancete",
  "DRE Mensal",
  "DRE Anual",
  "Relação de Faturamento",
  "Retenções de Impostos",
  "Razão",
  "Guia FGTS Digital",
];
app.get("/api/envio/templates", blockCliente, requirePermissao("envio", "visualizar"), (req, res) => {
  const rows = sqlite.prepare(`SELECT * FROM envio_templates WHERE escritorio_id = ? ORDER BY nome`).all((req as any).user.escritorioId) as any[];
  res.json({
    items: rows.map((r) => ({
      ...r,
      accept: JSON.parse(r.accept_json),
      detectarVencimento: !!r.detectar_vencimento,
      considerarMesAtual: !!r.considera_mes_atual,
      visivelCliente: !!r.visivel_cliente,
      suspensoDesde: r.suspenso_desde,
      autoRegimeTributario: r.auto_regime_tributario,
      protegido: ENVIO_TEMPLATES_PROTEGIDOS.includes(r.nome),
    })),
  });
});
const ENVIO_PERIODICIDADES = ["mensal", "trimestral", "anual", "avulso"];
app.post("/api/envio/templates", blockCliente, requirePermissao("envio", "postar"), (req, res) => {
  const user = (req as any).user;
  const { nome, descricao, periodicidade, accept, detectarVencimento, considerarMesAtual, visivelCliente, suspensoDesde, autoRegimeTributario } = req.body || {};
  if (!nome) return res.status(400).json({ error: "Informe o nome (ex.: \"DARF PIS\")." });
  if (suspensoDesde && !/^\d{4}-\d{2}$/.test(suspensoDesde)) return res.status(400).json({ error: "Competência de suspensão inválida." });
  if (autoRegimeTributario && !(REGIMES_TRIBUTARIOS as readonly string[]).includes(autoRegimeTributario)) return res.status(400).json({ error: "Regime tributário inválido." });
  const acceptFinal = Array.isArray(accept) && accept.length ? accept : ["pdf"];
  const info = sqlite
    .prepare(`INSERT INTO envio_templates (nome, descricao, periodicidade, accept_json, detectar_vencimento, considera_mes_atual, visivel_cliente, suspenso_desde, auto_regime_tributario, created_by, escritorio_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(nome, descricao || null, ENVIO_PERIODICIDADES.includes(periodicidade) ? periodicidade : "mensal", JSON.stringify(acceptFinal), detectarVencimento === false ? 0 : 1, considerarMesAtual === false ? 0 : 1, visivelCliente ? 1 : 0, suspensoDesde || null, autoRegimeTributario || null, user.id, user.escritorioId);
  res.json({ id: Number(info.lastInsertRowid) });
});
app.put("/api/envio/templates/:id", blockCliente, requirePermissao("envio", "editar"), (req, res) => {
  const id = Number(req.params.id);
  const existing = sqlite.prepare(`SELECT * FROM envio_templates WHERE id = ? AND escritorio_id = ?`).get(id, (req as any).user.escritorioId) as any;
  if (!existing) return res.status(404).json({ error: "Modelo não encontrado." });
  const protegido = ENVIO_TEMPLATES_PROTEGIDOS.includes(existing.nome);
  const { nome, descricao, periodicidade, accept, ativo, detectarVencimento, considerarMesAtual, visivelCliente, suspensoDesde, autoRegimeTributario } = req.body || {};
  if (protegido && nome !== undefined && nome !== existing.nome) {
    return res.status(409).json({ error: `"${existing.nome}" é usado automaticamente pelo Integra Contador — renomear quebraria o anexo automático de DAS/Situação Fiscal.` });
  }
  if (periodicidade !== undefined && !ENVIO_PERIODICIDADES.includes(periodicidade)) {
    return res.status(400).json({ error: "Periodicidade inválida." });
  }
  if (suspensoDesde && !/^\d{4}-\d{2}$/.test(suspensoDesde)) return res.status(400).json({ error: "Competência de suspensão inválida." });
  if (autoRegimeTributario && !(REGIMES_TRIBUTARIOS as readonly string[]).includes(autoRegimeTributario)) return res.status(400).json({ error: "Regime tributário inválido." });
  // Trocar a periodicidade não migra os períodos já gerados (ficam como estavam, com o formato
  // antigo) — só passa a valer pra próxima vez que "Gerar ano na grade" (ou "+ Nova solicitação
  // avulsa") for usado em cada atribuição desse modelo.
  sqlite
    .prepare(`UPDATE envio_templates SET nome=?, descricao=?, periodicidade=?, accept_json=?, detectar_vencimento=?, considera_mes_atual=?, visivel_cliente=?, ativo=?, suspenso_desde=?, auto_regime_tributario=? WHERE id=?`)
    .run(
      nome ?? existing.nome,
      descricao !== undefined ? descricao : existing.descricao,
      periodicidade ?? existing.periodicidade,
      Array.isArray(accept) && accept.length ? JSON.stringify(accept) : existing.accept_json,
      detectarVencimento === undefined ? existing.detectar_vencimento : detectarVencimento ? 1 : 0,
      considerarMesAtual === undefined ? existing.considera_mes_atual : considerarMesAtual ? 1 : 0,
      visivelCliente === undefined ? existing.visivel_cliente : visivelCliente ? 1 : 0,
      ativo === undefined ? existing.ativo : ativo ? 1 : 0,
      suspensoDesde === undefined ? existing.suspenso_desde : suspensoDesde || null,
      autoRegimeTributario === undefined ? existing.auto_regime_tributario : autoRegimeTributario || null,
      id
    );
  res.json({ ok: true });
});
app.delete("/api/envio/templates/:id", requireAdmin, (req, res) => {
  const existing = sqlite.prepare(`SELECT nome FROM envio_templates WHERE id = ? AND escritorio_id = ?`).get(Number(req.params.id), (req as any).user.escritorioId) as any;
  if (!existing) return res.status(404).json({ error: "Modelo não encontrado." });
  if (ENVIO_TEMPLATES_PROTEGIDOS.includes(existing.nome)) {
    return res.status(409).json({ error: `"${existing.nome}" é usado automaticamente pelo Integra Contador e não pode ser excluído.` });
  }
  sqlite.prepare(`DELETE FROM envio_templates WHERE id = ? AND escritorio_id = ?`).run(Number(req.params.id), (req as any).user.escritorioId);
  // Limpa referências órfãs em empresa_solicitacao_tipos (chave 'template:<id>' desse modelo excluído).
  sqlite.prepare(`DELETE FROM empresa_solicitacao_tipos WHERE chave = ?`).run("template:" + req.params.id);
  res.json({ ok: true });
});

app.get("/api/envio/atribuicoes", blockCliente, requirePermissao("envio", "visualizar"), (req, res) => {
  const user = (req as any).user;
  const empresaId = req.query.empresaId ? Number(req.query.empresaId) : null;
  if (empresaId && !podeAcessarEmpresa(user, empresaId)) return res.status(403).json({ error: "Sem acesso a esta empresa." });
  let sql = `SELECT a.*, t.nome as templateNome, t.periodicidade, t.accept_json as acceptJson, e.nome as empresaNome
             FROM envio_atribuicoes a JOIN envio_templates t ON t.id = a.template_id JOIN empresas e ON e.id = a.empresa_id
             WHERE e.ativo = 1`;
  const params: any[] = [];
  if (empresaId) {
    sql += ` AND a.empresa_id = ?`;
    params.push(empresaId);
  }
  sql += ` ORDER BY e.nome, t.nome`;
  let rows = sqlite.prepare(sql).all(...params) as any[];
  const visiveis = empresasVisiveis(user);
  if (visiveis !== null) rows = rows.filter((r) => visiveis.includes(r.empresa_id));
  res.json({
    items: rows.map((r) => ({
      ...r,
      accept: JSON.parse(r.acceptJson),
      temDocumentos: envioAtribuicaoTemDocumentos(r.id),
      pendentesCliente: envioAtribuicaoPendentesCliente(r.id),
    })),
  });
});
// Histórico de todo pedido feito por qualquer cliente — tanto pela tela "Solicitar Documentos"
// (modelos com visivel_cliente) quanto pelo "Recalcular DAS" — os dois usam o mesmo campo
// envio_periodos.solicitado_em, então essa lista já cobre tudo junto, sem precisar de tabela nova.
// Diferente de cardSolicitacoesPendentes() (só as que ainda faltam atender), aqui mostra as duas
// situações com uma coluna de status — é o registro histórico completo, não só a fila de pendências.
app.get("/api/envio/solicitacoes", blockCliente, requirePermissao("envio", "visualizar"), (req, res) => {
  const user = (req as any).user;
  const empresaId = req.query.empresaId ? Number(req.query.empresaId) : null;
  if (empresaId && !podeAcessarEmpresa(user, empresaId)) return res.status(403).json({ error: "Sem acesso a esta empresa." });
  let sql = `SELECT p.id as periodoId, p.ano, p.mes, p.rotulo, p.solicitado_em as solicitadoEm, p.solicitacao_tipo as tipo,
              t.nome as templateNome, a.id as atribuicaoId, a.empresa_id as empresaId, e.nome as empresaNome,
              u.nome as solicitadoPorNome, u.perfil as solicitadoPorPerfil,
              EXISTS(SELECT 1 FROM envio_documentos d WHERE d.periodo_id = p.id) as concluida,
              (SELECT MAX(d.enviado_em) FROM envio_documentos d WHERE d.periodo_id = p.id) as retornoClienteEm
             FROM envio_periodos p
             JOIN envio_atribuicoes a ON a.id = p.atribuicao_id
             JOIN envio_templates t ON t.id = a.template_id AND t.escritorio_id = ?
             JOIN empresas e ON e.id = a.empresa_id
             LEFT JOIN app_users u ON u.id = p.solicitado_por
             WHERE p.solicitado_em IS NOT NULL`;
  const params: any[] = [user.escritorioId];
  if (empresaId) {
    sql += ` AND a.empresa_id = ?`;
    params.push(empresaId);
  }
  sql += ` ORDER BY p.solicitado_em DESC LIMIT 300`;
  let rows = sqlite.prepare(sql).all(...params) as any[];
  const visiveis = empresasVisiveis(user);
  if (visiveis !== null) rows = rows.filter((r) => visiveis.includes(r.empresaId));
  res.json({ items: rows.map((r) => ({ ...r, concluida: !!r.concluida })) });
});
app.get("/api/envio/minhas-atribuicoes", (req, res) => {
  const user = (req as any).user;
  if (user.perfil !== "Cliente") return res.status(403).json({ error: "Rota exclusiva para clientes." });
  if (!user.empresaId) return res.json({ items: [] });
  const rows = sqlite
    .prepare(
      `SELECT a.*, t.nome as templateNome, t.periodicidade, t.descricao, e.nome as empresaNome
       FROM envio_atribuicoes a JOIN envio_templates t ON t.id = a.template_id JOIN empresas e ON e.id = a.empresa_id
       WHERE a.empresa_id = ? AND a.ativo = 1 ORDER BY t.nome`
    )
    .all(user.empresaId) as any[];
  res.json({ items: rows });
});

// ---- Solicitar Documentos (cliente pede, sem depender do escritório já ter atribuído o modelo) ----
app.get("/api/envio/templates-disponiveis", (req, res) => {
  const user = (req as any).user;
  if (user.perfil !== "Cliente") return res.status(403).json({ error: "Rota exclusiva para clientes." });
  const rows = sqlite
    .prepare(`SELECT id, nome, descricao, periodicidade FROM envio_templates WHERE ativo = 1 AND visivel_cliente = 1 AND escritorio_id = ? ORDER BY nome`)
    .all(user.escritorioId) as any[];
  // Filtra pelo que essa empresa específica pode solicitar (ver empresaPodeSolicitar) — sem nenhuma
  // linha configurada pra ela, não filtra nada (mesmo catálogo de sempre).
  const items = (user.empresaId ? rows.filter((t) => empresaPodeSolicitar(user.empresaId, "template:" + t.id)) : rows).map((t) => ({
    ...t,
    somenteDisponiveis: TEMPLATES_RELATORIOS_DOMINIO.has(t.nome),
  }));
  res.json({
    items,
    recalculoDasDisponivel: user.empresaId ? empresaPodeSolicitar(user.empresaId, "recalculo_das") : true,
    parcelamentoDasDisponivel: user.empresaId ? empresaPodeSolicitar(user.empresaId, "parcelamento_das") : true,
    retencoesDisponivel: user.empresaId ? empresaPodeSolicitar(user.empresaId, "retencoes") : true,
  });
});
app.post("/api/envio/solicitar", (req, res) => {
  const user = (req as any).user;
  if (user.perfil !== "Cliente") return res.status(403).json({ error: "Rota exclusiva para clientes." });
  if (!user.empresaId) return res.status(400).json({ error: "Seu usuário não está vinculado a uma empresa." });
  const { templateId, ano, mes, rotulo } = req.body || {};
  const template = sqlite
    .prepare(`SELECT * FROM envio_templates WHERE id = ? AND ativo = 1 AND visivel_cliente = 1 AND escritorio_id = ?`)
    .get(Number(templateId), user.escritorioId) as any;
  // Mesma mensagem de "não existe" pros dois casos — não vaza pro cliente que o template existe mas
  // essa empresa dele não está liberada a pedir.
  if (!template || !empresaPodeSolicitar(user.empresaId, "template:" + template.id)) {
    return res.status(404).json({ error: "Documento não disponível para solicitação." });
  }

  let anoFinal: number, mesFinal: number | null, rotuloFinal: string | null;
  if (template.periodicidade === "mensal") {
    mesFinal = Number(mes);
    anoFinal = Number(ano);
    if (!anoFinal || !mesFinal || mesFinal < 1 || mesFinal > 12) return res.status(400).json({ error: "Informe o mês e o ano." });
    rotuloFinal = null;
  } else if (template.periodicidade === "anual") {
    anoFinal = Number(ano);
    if (!anoFinal) return res.status(400).json({ error: "Informe o ano." });
    mesFinal = null;
    rotuloFinal = null;
  } else {
    rotuloFinal = rotulo ? String(rotulo).trim() : "";
    if (!rotuloFinal) return res.status(400).json({ error: 'Descreva o que você está solicitando (ex.: "Relação de Faturamento — Jan a Jul/2026").' });
    anoFinal = Number(ano) || new Date().getFullYear();
    mesFinal = null;
  }

  let atrib = sqlite.prepare(`SELECT * FROM envio_atribuicoes WHERE template_id = ? AND empresa_id = ?`).get(template.id, user.empresaId) as any;
  if (!atrib) {
    const info = sqlite.prepare(`INSERT INTO envio_atribuicoes (template_id, empresa_id, created_by) VALUES (?, ?, ?)`).run(template.id, user.empresaId, user.id);
    atrib = { id: Number(info.lastInsertRowid) };
  } else if (!atrib.ativo) {
    sqlite.prepare(`UPDATE envio_atribuicoes SET ativo = 1 WHERE id = ?`).run(atrib.id);
  }

  // Checa existência por fora em vez de confiar em UNIQUE(atribuicao_id,ano,mes,rotulo) + INSERT OR
  // IGNORE: SQLite trata NULL como diferente de NULL num UNIQUE, e todo período mensal/anual tem
  // rotulo=NULL (mesmo problema já corrigido em envioGerarPeriodosAno, server.ts:4260) — sem isso,
  // um período já existente (ex.: criado pela importação automática de relatórios antes do cliente
  // pedir) não é encontrado e um período duplicado nasce a cada solicitação.
  let periodoId: number;
  let jaExistia = false;
  // Quando o cliente já tinha pedido esse período antes, verifica se o arquivo no servidor é mais
  // novo do que quando ele pediu da última vez — ex.: a importação do OneDrive substituiu o
  // documento por uma versão corrigida depois desse pedido. Se for mais novo, marca como
  // "atualizado" (bumping solicitado_em) pro cliente ver que tem versão nova; se for exatamente o
  // mesmo arquivo de antes (mesma data/hora), não mexe em nada.
  let atualizado = false;
  const existente = sqlite
    .prepare(`SELECT * FROM envio_periodos WHERE atribuicao_id = ? AND ano = ? AND mes IS ? AND rotulo IS ?`)
    .get(atrib.id, anoFinal, mesFinal, rotuloFinal) as any;
  if (existente) {
    periodoId = existente.id;
    jaExistia = true;
    if (!existente.solicitado_em) {
      sqlite.prepare(`UPDATE envio_periodos SET solicitado_por = ?, solicitado_em = datetime('now'), solicitacao_tipo = 'documento' WHERE id = ?`).run(user.id, periodoId);
    } else {
      const maisRecente = sqlite.prepare(`SELECT enviado_em FROM envio_documentos WHERE periodo_id = ? ORDER BY enviado_em DESC LIMIT 1`).get(periodoId) as any;
      if (maisRecente && maisRecente.enviado_em > existente.solicitado_em) {
        atualizado = true;
        sqlite.prepare(`UPDATE envio_periodos SET solicitado_em = datetime('now') WHERE id = ?`).run(periodoId);
      }
    }
  } else {
    const info = sqlite
      .prepare(`INSERT INTO envio_periodos (atribuicao_id, ano, mes, rotulo, solicitado_por, solicitado_em, solicitacao_tipo) VALUES (?, ?, ?, ?, ?, datetime('now'), 'documento')`)
      .run(atrib.id, anoFinal, mesFinal, rotuloFinal, user.id);
    periodoId = Number(info.lastInsertRowid);
  }
  const jaConcluido = !!sqlite.prepare(`SELECT 1 FROM envio_documentos WHERE periodo_id = ?`).get(periodoId);
  res.json({ ok: true, atribuicaoId: atrib.id, periodoId, jaExistia, jaConcluido, atualizado });
});
// Só pros templates alimentados pela importação automática do OneDrive (Balanço/Balancete/DRE/
// Relação de Faturamento — ver TEMPLATES_RELATORIOS_DOMINIO): em vez de deixar o cliente digitar
// qualquer mês/ano em "Solicitar Documentos" (não existe ninguém pra gerar aquilo sob demanda), a
// tela usa esta rota pra listar só os períodos que JÁ têm documento importado pra empresa dele —
// pedir um desses sempre volta jaConcluido:true na hora.
app.get("/api/envio/periodos-disponiveis", (req, res) => {
  const user = (req as any).user;
  if (user.perfil !== "Cliente") return res.status(403).json({ error: "Rota exclusiva para clientes." });
  if (!user.empresaId) return res.json({ items: [] });
  const template = sqlite
    .prepare(`SELECT * FROM envio_templates WHERE id = ? AND ativo = 1 AND visivel_cliente = 1 AND escritorio_id = ?`)
    .get(Number(req.query.templateId), user.escritorioId) as any;
  if (!template || !empresaPodeSolicitar(user.empresaId, "template:" + template.id)) {
    return res.status(404).json({ error: "Documento não disponível para solicitação." });
  }
  const items = sqlite
    .prepare(
      `SELECT DISTINCT p.ano, p.mes, p.rotulo
       FROM envio_periodos p
       JOIN envio_atribuicoes a ON a.id = p.atribuicao_id
       JOIN envio_documentos d ON d.periodo_id = p.id
       WHERE a.template_id = ? AND a.empresa_id = ?
       ORDER BY p.ano DESC, p.mes DESC`
    )
    .all(template.id, user.empresaId);
  res.json({ items });
});
app.get("/api/envio/minhas-solicitacoes", (req, res) => {
  const user = (req as any).user;
  if (user.perfil !== "Cliente") return res.status(403).json({ error: "Rota exclusiva para clientes." });
  if (!user.empresaId) return res.json({ items: [] });
  const rows = sqlite
    .prepare(
      `SELECT p.id as periodoId, p.ano, p.mes, p.rotulo, p.solicitado_em as solicitadoEm,
              t.nome as templateNome, t.periodicidade, a.id as atribuicaoId
       FROM envio_periodos p
       JOIN envio_atribuicoes a ON a.id = p.atribuicao_id
       JOIN envio_templates t ON t.id = a.template_id
       WHERE a.empresa_id = ? AND p.solicitado_em IS NOT NULL
       ORDER BY p.solicitado_em DESC`
    )
    .all(user.empresaId) as any[];
  const periodoIds = rows.map((r) => r.periodoId);
  const docs = periodoIds.length
    ? (sqlite
        .prepare(`SELECT * FROM envio_documentos WHERE periodo_id IN (${periodoIds.map(() => "?").join(",")}) ORDER BY enviado_em ASC, id ASC`)
        .all(...periodoIds) as any[])
    : [];
  const docsPorPeriodo = new Map<number, any[]>();
  for (const d of docs) {
    if (!docsPorPeriodo.has(d.periodo_id)) docsPorPeriodo.set(d.periodo_id, []);
    docsPorPeriodo.get(d.periodo_id)!.push({ id: d.id, fileName: d.file_name, enviadoEm: d.enviado_em });
  }
  res.json({ items: rows.map((r) => ({ ...r, documentos: docsPorPeriodo.get(r.periodoId) || [] })) });
});

app.post("/api/envio/atribuicoes", blockCliente, requirePermissao("envio", "postar"), (req, res) => {
  const user = (req as any).user;
  const { templateId, empresaId } = req.body || {};
  if (!templateId || !empresaId) return res.status(400).json({ error: "Selecione o modelo e a empresa." });
  if (!podeAcessarEmpresa(user, Number(empresaId))) return res.status(403).json({ error: "Sem acesso a esta empresa." });
  const template = sqlite.prepare(`SELECT id FROM envio_templates WHERE id = ? AND escritorio_id = ?`).get(Number(templateId), user.escritorioId);
  if (!template) return res.status(404).json({ error: "Modelo não encontrado." });
  try {
    const info = sqlite
      .prepare(`INSERT INTO envio_atribuicoes (template_id, empresa_id, created_by) VALUES (?, ?, ?)`)
      .run(Number(templateId), Number(empresaId), user.id);
    res.json({ id: Number(info.lastInsertRowid) });
  } catch (e: any) {
    if (String(e.message).includes("UNIQUE")) return res.status(409).json({ error: "Este modelo já está atribuído a esta empresa." });
    res.status(500).json({ error: e.message });
  }
});
app.delete("/api/envio/atribuicoes/:id", blockCliente, requirePermissao("envio", "editar"), (req, res) => {
  const id = Number(req.params.id);
  const atrib = sqlite.prepare(`SELECT empresa_id FROM envio_atribuicoes WHERE id = ?`).get(id) as any;
  if (!atrib || !podeAcessarEmpresa((req as any).user, atrib.empresa_id)) return res.status(404).json({ error: "Atribuição não encontrada." });
  if (envioAtribuicaoTemDocumentos(id)) {
    return res.status(409).json({ error: "Já existe documento enviado nesta atribuição — não é possível excluir." });
  }
  sqlite.prepare(`DELETE FROM envio_atribuicoes WHERE id = ?`).run(id);
  res.json({ ok: true });
});

// Compartilhada entre o botão manual "Gerar ano na grade" e a virada automática de ano
// (envioRolloverGerarAno) — mesma lógica de sempre, só extraída pra não duplicar os 4 ramos.
// Checa existência por fora (não confia no UNIQUE(atribuicao_id,ano,mes,rotulo) + INSERT OR IGNORE
// pra evitar duplicata): achado ao vivo que o SQLite trata NULL como diferente de NULL num UNIQUE,
// então "Gerar ano" chamado 2x pro mesmo ano/atribuição criaria período repetido pro mesmo mês (todo
// período mensal/trimestral/anual tem rotulo=NULL) — clicar o botão 2x sem querer, ou a virada
// automática coincidir com um "Gerar ano" manual, duplicava silenciosamente.
function envioGerarPeriodosAno(atribuicaoId: number, periodicidade: string, ano: number, rotulo?: string | null): number {
  const existe = sqlite.prepare(`SELECT 1 FROM envio_periodos WHERE atribuicao_id = ? AND ano = ? AND mes IS ?`);
  const insert = sqlite.prepare(`INSERT INTO envio_periodos (atribuicao_id, ano, mes, rotulo) VALUES (?, ?, ?, ?)`);
  let criados = 0;
  const inserirSeNovo = (mes: number | null) => {
    if (existe.get(atribuicaoId, ano, mes)) return;
    insert.run(atribuicaoId, ano, mes, null);
    criados++;
  };
  if (periodicidade === "mensal") {
    for (let mes = 1; mes <= 12; mes++) inserirSeNovo(mes);
  } else if (periodicidade === "trimestral") {
    // Um período por trimestre, representado pelo mês de fechamento (Mar/Jun/Set/Dez) — é o padrão
    // de apuração trimestral do IRPJ/CSLL no Lucro Real (o DARF vence no mês seguinte ao fechamento).
    for (const mes of [3, 6, 9, 12]) inserirSeNovo(mes);
  } else if (periodicidade === "anual") {
    inserirSeNovo(null);
  } else {
    // Avulso sempre cria um novo (é literalmente "+ Novo envio avulso") — o rótulo (com timestamp)
    // já garante unicidade na prática, sem precisar checar existência antes.
    insert.run(atribuicaoId, ano || new Date().getFullYear(), null, rotulo || `Envio avulso ${Date.now()}`);
    criados++;
  }
  return criados;
}
app.post("/api/envio/periodos/gerar", blockCliente, requirePermissao("envio", "postar"), (req, res) => {
  const { atribuicaoId, ano, rotulo } = req.body || {};
  const atrib = sqlite
    .prepare(`SELECT a.*, t.periodicidade FROM envio_atribuicoes a JOIN envio_templates t ON t.id = a.template_id WHERE a.id = ?`)
    .get(Number(atribuicaoId)) as any;
  if (!atrib || !podeAcessarEmpresa((req as any).user, atrib.empresa_id)) return res.status(404).json({ error: "Atribuição não encontrada." });
  const criados = envioGerarPeriodosAno(atrib.id, atrib.periodicidade, Number(ano), rotulo);
  res.json({ ok: true, criados });
});
// Virada de ano automática: toda 1ª de janeiro (checado 1x por dia, ver setInterval abaixo), gera
// sozinha a grade do ano novo pra toda atribuição mensal/trimestral/anual que JÁ tinha grade no ano
// anterior — não recria do zero quem nunca usou, só renova quem já vinha usando (decisão explícita:
// atribuição nova/recém-criada sem nada no ano anterior fica de fora até alguém gerar na mão pela
// 1ª vez). "escritorios.envio_rollover_ultimo_ano" é a trava que evita rodar 2x no mesmo ano e
// sobrevive a reinício do processo (fica no banco, não em memória).
function envioRolloverGerarAno(escritorioId: number, ano: number): { atribuicoesRenovadas: number; periodosCriados: number } {
  const anoAnterior = ano - 1;
  const atribs = sqlite
    .prepare(
      `SELECT a.id as atribuicaoId, t.periodicidade
       FROM envio_atribuicoes a
       JOIN envio_templates t ON t.id = a.template_id AND t.escritorio_id = ? AND t.periodicidade IN ('mensal','trimestral','anual')
       JOIN empresas e ON e.id = a.empresa_id AND e.escritorio_id = ? AND e.ativo = 1
       WHERE a.ativo = 1 AND EXISTS (SELECT 1 FROM envio_periodos p WHERE p.atribuicao_id = a.id AND p.ano = ?)`
    )
    .all(escritorioId, escritorioId, anoAnterior) as any[];
  let periodosCriados = 0;
  for (const a of atribs) periodosCriados += envioGerarPeriodosAno(a.atribuicaoId, a.periodicidade, ano);
  return { atribuicoesRenovadas: atribs.length, periodosCriados };
}
setInterval(() => {
  const agora = agoraBrasilia();
  if (agora.hora !== 3 || agora.minuto !== 10) return;
  const escritorios = sqlite.prepare(`SELECT id FROM escritorios WHERE ativo = 1 AND (envio_rollover_ultimo_ano IS NULL OR envio_rollover_ultimo_ano < ?)`).all(agora.ano) as any[];
  for (const e of escritorios) {
    try {
      const r = envioRolloverGerarAno(e.id, agora.ano);
      sqlite.prepare(`UPDATE escritorios SET envio_rollover_ultimo_ano = ? WHERE id = ?`).run(agora.ano, e.id);
      console.log(`Virada de ano da grade de Envio de Documentos — escritório ${e.id}: ${r.atribuicoesRenovadas} atribuição(ões) renovada(s), ${r.periodosCriados} período(s) criado(s) pra ${agora.ano}.`);
    } catch (err: any) {
      console.error(`Falha na virada de ano da grade de Envio de Documentos (escritório ${e.id}):`, err.message);
    }
  }
}, 60_000);
// Botão manual em Configurações — dispara a mesma rotina na hora, sem esperar 1º de janeiro às
// 3h10. Útil tanto de "escape hatch" (se o servidor ficou fora do ar bem naquela hora) quanto pra
// testar o comportamento sem esperar o ano virar de verdade. De propósito NÃO mexe em
// envio_rollover_ultimo_ano (a trava da rotina automática) — só gera; se o admin usar isso pra
// "adiantar" um ano bem à frente por engano, isso não pode fazer a virada automática pular anos
// intermediários depois.
app.post("/api/envio/rollover-ano", requireAdmin, (req, res) => {
  const user = (req as any).user;
  const ano = Number(req.body?.ano) || agoraBrasilia().ano;
  const r = envioRolloverGerarAno(user.escritorioId, ano);
  res.json({ ok: true, ano, ...r });
});

// Só pra período avulso (rótulo próprio, ex.: "CND - Receita Federal") e só quando não tem nenhum
// documento anexado ainda — mensal/anual nunca entra aqui (fazem parte do calendário fixo da grade,
// não faz sentido "excluir" um mês) e um avulso já com documento também não, pra não sumir com
// histórico de algo já enviado (aí o jeito é excluir os documentos um a um, como já existe). Também
// nunca deixa excluir um pedido feito pelo próprio cliente — sumiria com o pedido sem responder;
// esse caso só sai da grade sendo atendido (ex.: vincular parcelamento apaga o pedido de propósito,
// por uma rota dedicada, não por aqui) ou, se for pra descartar mesmo, pela tela de Solicitações.
app.delete("/api/envio/periodos/:id", blockCliente, requirePermissao("envio", "editar"), (req, res) => {
  const periodo = sqlite
    .prepare(
      `SELECT p.*, a.empresa_id as empresaId, t.periodicidade, u.perfil as solicitadoPorPerfil
       FROM envio_periodos p JOIN envio_atribuicoes a ON a.id = p.atribuicao_id JOIN envio_templates t ON t.id = a.template_id
       LEFT JOIN app_users u ON u.id = p.solicitado_por
       WHERE p.id = ?`
    )
    .get(Number(req.params.id)) as any;
  if (!periodo || !podeAcessarEmpresa((req as any).user, periodo.empresaId)) return res.status(404).json({ error: "Período não encontrado." });
  if (periodo.periodicidade !== "avulso") return res.status(400).json({ error: "Só é possível excluir um período avulso." });
  if (periodo.solicitado_em && periodo.solicitadoPorPerfil === "Cliente") {
    return res.status(400).json({ error: "Este período foi solicitado pelo cliente — não pode ser excluído direto na grade." });
  }
  const temDocumento = sqlite.prepare(`SELECT 1 FROM envio_documentos WHERE periodo_id = ?`).get(periodo.id);
  if (temDocumento) return res.status(400).json({ error: "Este período já tem documento anexado — exclua o(s) documento(s) primeiro." });
  sqlite.prepare(`DELETE FROM envio_periodos WHERE id = ?`).run(periodo.id);
  res.json({ ok: true });
});
app.get("/api/envio/grade/:atribuicaoId", (req, res) => {
  const user = (req as any).user;
  const atribuicaoId = Number(req.params.atribuicaoId);
  const atrib = sqlite
    .prepare(
      `SELECT a.*, t.nome as templateNome, t.periodicidade, t.accept_json as acceptJson, t.detectar_vencimento as detectarVencimento, e.nome as empresaNome
       FROM envio_atribuicoes a JOIN envio_templates t ON t.id = a.template_id JOIN empresas e ON e.id = a.empresa_id WHERE a.id = ?`
    )
    .get(atribuicaoId) as any;
  if (!atrib) return res.status(404).json({ error: "Atribuição não encontrada." });
  if (user.perfil === "Cliente" && user.empresaId !== atrib.empresa_id) return res.status(403).json({ error: "Sem acesso." });
  if (user.perfil === "Colaborador" && !hasPermissao(user, "envio", "visualizar")) return res.status(403).json({ error: "Sem permissão." });
  if (user.perfil !== "Cliente" && !podeAcessarEmpresa(user, atrib.empresa_id)) return res.status(403).json({ error: "Sem acesso a esta empresa." });

  const periodos = sqlite.prepare(`SELECT * FROM envio_periodos WHERE atribuicao_id = ? ORDER BY ano DESC, mes ASC`).all(atribuicaoId) as any[];
  const periodoIds = periodos.map((p) => p.id);
  const docs = periodoIds.length
    ? (sqlite
        .prepare(`SELECT * FROM envio_documentos WHERE periodo_id IN (${periodoIds.map(() => "?").join(",")}) ORDER BY enviado_em ASC, id ASC`)
        .all(...periodoIds) as any[])
    : [];
  const statusWhatsappPorDoc = statusWhatsappPorOrigem("envio_documentos", docs.map((d) => d.id));
  const docsPorPeriodo = new Map<number, any[]>();
  for (const d of docs) {
    if (!docsPorPeriodo.has(d.periodo_id)) docsPorPeriodo.set(d.periodo_id, []);
    const statusWhatsapp = statusWhatsappPorDoc.get(d.id);
    docsPorPeriodo.get(d.periodo_id)!.push({
      id: d.id,
      fileName: d.file_name,
      sizeBytes: d.size_bytes,
      observacao: d.observacao,
      vencimento: d.vencimento,
      vencimentoOrigem: d.vencimento_origem,
      enviadoEm: d.enviado_em,
      emailEnviado: !!d.email_enviado,
      emailEnviadoEm: d.email_enviado_em,
      emailErro: d.email_erro,
      whatsappEnviado: !!d.whatsapp_enviado,
      whatsappEnviadoEm: d.whatsapp_enviado_em,
      whatsappErro: d.whatsapp_erro,
      whatsappStatus: statusWhatsapp?.status || (d.whatsapp_enviado ? "enviado" : null),
      whatsappStatusEm: statusWhatsapp?.em || null,
    });
  }

  const grade = periodos.map((p) => ({
    periodoId: p.id,
    ano: p.ano,
    mes: p.mes,
    rotulo: p.rotulo,
    solicitadoEm: p.solicitado_em,
    documentos: docsPorPeriodo.get(p.id) || [],
    semMovimento: !!p.sem_movimento,
    semMovimentoObservacao: p.sem_movimento_observacao,
    parcelaNumero: p.parcela_numero,
    parcelaTotal: p.parcela_total,
  }));

  res.json({
    atribuicao: {
      id: atrib.id,
      templateNome: atrib.templateNome,
      periodicidade: atrib.periodicidade,
      empresaNome: atrib.empresaNome,
      empresaId: atrib.empresa_id,
      accept: JSON.parse(atrib.acceptJson),
      detectarVencimento: !!atrib.detectarVencimento,
    },
    grade,
  });
});

// Cliente pede recálculo do DAS de uma competência (ex.: esqueceu de pagar no prazo e precisa da
// guia com juros/multa atualizados). Dispara uma chamada nova e PAGA à Receita (a mesma usada na
// busca automática), então trava em 1x por dia por competência — evita clique duplicado/acidental
// gerando custo em dobro sem necessidade real; ainda dá pra recalcular de novo no dia seguinte se o
// atraso continuar. Compartilhada pelas duas rotas que disparam isso: o botão na grade de Envio de
// Documentos (já sabe o periodoId) e o pedido em Solicitar Documentos (resolve o periodoId pela
// competência antes de chamar aqui).
async function executarRecalculoDas(periodoId: number, user: any): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  const periodo = sqlite
    .prepare(
      `SELECT p.*, a.empresa_id as empresaId, t.nome as templateNome
       FROM envio_periodos p JOIN envio_atribuicoes a ON a.id = p.atribuicao_id JOIN envio_templates t ON t.id = a.template_id
       WHERE p.id = ?`
    )
    .get(periodoId) as any;
  if (!periodo) return { ok: false, status: 404, error: "Período não encontrado." };
  // Cliente só recalcula o DAS da própria empresa; escritório (Colaborador/Administrador) segue a
  // mesma regra de acesso do resto da grade de Envio de Documentos.
  if (user.perfil === "Cliente") {
    if (periodo.empresaId !== user.empresaId) return { ok: false, status: 404, error: "Período não encontrado." };
  } else if (!podeAcessarEmpresa(user, periodo.empresaId)) {
    return { ok: false, status: 403, error: "Sem acesso a esta empresa." };
  }
  if (periodo.templateNome !== "DAS - Mensal") return { ok: false, status: 400, error: "Esse período não é de DAS." };
  const temDocumento = sqlite.prepare(`SELECT 1 FROM envio_documentos WHERE periodo_id = ?`).get(periodoId);
  if (!temDocumento) return { ok: false, status: 409, error: "O DAS original dessa competência ainda não foi disponibilizado — aguarde a rotina mensal antes de pedir recálculo." };
  const jaPediuHoje = sqlite
    .prepare(`SELECT 1 FROM envio_documentos WHERE periodo_id = ? AND observacao LIKE 'DAS recalculado%' AND date(enviado_em) = date('now')`)
    .get(periodoId);
  if (jaPediuHoje) return { ok: false, status: 429, error: "Só é possível pedir um recálculo por dia pra essa competência — tente de novo amanhã." };
  const empConfig = getIntegraContadorEmpresaConfig(periodo.empresaId);
  const cfg = getIntegraContadorConfig(empConfig.escritorio_id);
  if (!cfg.ativo || !empConfig.ativo) return { ok: false, status: 400, error: "O Integra Contador não está ativo pra essa empresa — fale com o escritório." };
  const empresa = sqlite.prepare(`SELECT cnpj FROM empresas WHERE id = ?`).get(periodo.empresaId) as any;
  const periodoApuracao = `${periodo.ano}${String(periodo.mes).padStart(2, "0")}`;
  try {
    const token = await obterTokenIntegraContador(cfg);
    const das = await integracontador.gerarDas(token, cfg.cnpj, empresa.cnpj, periodoApuracao);
    if (!das.pdfBase64) return { ok: false, status: 502, error: "A Receita não devolveu o DAS recalculado — tente de novo mais tarde." };
    const quem = user.perfil === "Cliente" ? "pelo cliente" : `pelo escritório (${user.nome})`;
    const observacao = `DAS recalculado — solicitado ${quem} em ${new Date().toLocaleDateString("pt-BR")}.`;
    integraContadorAnexarDasEmEnvio(empConfig.escritorio_id, periodo.empresaId, das, das.periodoApuracao || periodoApuracao, observacao, true);
    // Registra a solicitação de verdade (mesmo campo que "Solicitar Documentos" já usa pros modelos
    // normais) — sem isso o pedido de recálculo não ficava registrado em lugar nenhum: nem na lista
    // "Solicitar Documentos" do próprio cliente, nem em nenhum histórico do escritório. DAS - Mensal
    // não é visivel_cliente, então esse campo nunca é preenchido por outro caminho.
    sqlite.prepare(`UPDATE envio_periodos SET solicitado_em = datetime('now'), solicitado_por = ?, solicitacao_tipo = 'recalculo_das' WHERE id = ?`).run(user.id, periodoId);
    sqlite
      .prepare(
        `INSERT INTO integracontador_documentos (empresa_id, escritorio_id, tipo, periodo_apuracao, numero_documento, data_vencimento, detalhes_json) VALUES (?, ?, 'das', ?, ?, ?, ?)`
      )
      .run(periodo.empresaId, empConfig.escritorio_id, das.periodoApuracao || periodoApuracao, das.numeroDocumento, das.dataVencimento, JSON.stringify(das.valores || {}));
    return { ok: true };
  } catch (e: any) {
    return { ok: false, status: 502, error: e.message };
  }
}
app.post("/api/envio/periodos/:periodoId/solicitar-recalculo-das", async (req, res) => {
  const user = (req as any).user;
  // Botão compartilhado pela grade do cliente (Documentos Recebidos) e a do escritório (Envio de
  // Documentos) — Cliente sempre pode pedir o próprio; Colaborador precisa da permissão de postar
  // em "envio" (mesma exigida pra anexar documento nessa grade); Administrador sempre pode.
  if (user.perfil === "Colaborador" && !hasPermissao(user, "envio", "postar")) {
    return res.status(403).json({ error: "Sem permissão para recalcular DAS." });
  }
  const r = await executarRecalculoDas(Number(req.params.periodoId), user);
  if (!r.ok) return res.status(r.status).json({ error: r.error });
  res.json({ ok: true });
});
// Mesmo recurso, mas disparado a partir de Solicitar Documentos — o cliente escolhe a competência
// (mês/ano) em vez de já estar na grade de Envio de Documentos com o periodoId em mãos.
app.post("/api/envio/solicitar-recalculo-das", requireCliente, async (req, res) => {
  const user = (req as any).user;
  if (!empresaPodeSolicitar(user.empresaId, "recalculo_das")) {
    return res.status(403).json({ error: "Sua empresa não está habilitada a solicitar recálculo de DAS." });
  }
  const mes = Number(req.body?.mes);
  const ano = Number(req.body?.ano);
  if (!mes || !ano) return res.status(400).json({ error: "Informe o mês e o ano da competência." });
  const periodo = sqlite
    .prepare(
      `SELECT p.id FROM envio_periodos p JOIN envio_atribuicoes a ON a.id = p.atribuicao_id JOIN envio_templates t ON t.id = a.template_id
       WHERE a.empresa_id = ? AND t.nome = 'DAS - Mensal' AND p.mes = ? AND p.ano = ?`
    )
    .get(user.empresaId, mes, ano) as any;
  if (!periodo) return res.status(404).json({ error: "O DAS dessa competência ainda não foi disponibilizado — aguarde a rotina mensal antes de pedir recálculo." });
  const r = await executarRecalculoDas(periodo.id, user);
  if (!r.ok) return res.status(r.status).json({ error: r.error });
  res.json({ ok: true });
});
// Cliente pede parcelamento do DAS em atraso — diferente do recálculo, aqui não tem nada pra buscar
// na hora: a Receita não expõe simulação nem adesão a parcelamento novo por API (só consulta de um
// parcelamento que já existe), então esse pedido só avisa o escritório, que negocia no e-CAC como já
// faz hoje e depois vincula o parcelamento concedido (ver POST /api/integracontador/parcelamentos).
app.post("/api/envio/solicitar-parcelamento-das", requireCliente, (req, res) => {
  const user = (req as any).user;
  if (!user.empresaId) return res.status(400).json({ error: "Seu usuário não está vinculado a uma empresa." });
  if (!empresaPodeSolicitar(user.empresaId, "parcelamento_das")) {
    return res.status(403).json({ error: "Sua empresa não está habilitada a solicitar parcelamento de DAS." });
  }
  const atribuicaoId = integraContadorObterOuCriarAtribuicaoModelo(
    user.escritorioId,
    user.empresaId,
    "Solicitação de Parcelamento de DAS",
    "Pedido do cliente pra negociar parcelamento do DAS em atraso — o escritório trata no e-CAC e vincula aqui depois.",
    "avulso",
    false
  );
  const pendente = sqlite
    .prepare(
      `SELECT p.id FROM envio_periodos p
       WHERE p.atribuicao_id = ? AND p.solicitacao_tipo = 'parcelamento_das' AND NOT EXISTS (SELECT 1 FROM envio_documentos d WHERE d.periodo_id = p.id)
       ORDER BY p.id DESC LIMIT 1`
    )
    .get(atribuicaoId) as any;
  if (pendente) return res.json({ ok: true, jaExistia: true });
  const agora = new Date();
  const rotulo = `Pedido de parcelamento — ${agora.toLocaleDateString("pt-BR")} ${agora.toLocaleTimeString("pt-BR")}`;
  sqlite
    .prepare(`INSERT INTO envio_periodos (atribuicao_id, ano, rotulo, solicitado_por, solicitado_em, solicitacao_tipo) VALUES (?, ?, ?, ?, datetime('now'), 'parcelamento_das')`)
    .run(atribuicaoId, agora.getFullYear(), rotulo, user.id);
  res.json({ ok: true, jaExistia: false });
});
app.post("/api/envio/periodos/:periodoId/enviar", blockCliente, requirePermissao("envio", "postar"), upload.single("arquivo"), async (req, res) => {
  const user = (req as any).user;
  const periodoId = Number(req.params.periodoId);
  if (!req.file) return res.status(400).json({ error: "Selecione o arquivo." });
  req.file.originalname = corrigirNomeArquivo(req.file.originalname);

  const periodo = sqlite
    .prepare(
      `SELECT p.*, a.empresa_id as empresaId, t.accept_json as acceptJson, t.nome as templateNome, t.detectar_vencimento as detectarVencimento, t.periodicidade as templatePeriodicidade
       FROM envio_periodos p JOIN envio_atribuicoes a ON a.id = p.atribuicao_id JOIN envio_templates t ON t.id = a.template_id WHERE p.id = ?`
    )
    .get(periodoId) as any;
  if (!periodo) return res.status(404).json({ error: "Período não encontrado." });
  if (!podeAcessarEmpresa(user, periodo.empresaId)) return res.status(403).json({ error: "Sem acesso a esta empresa." });

  const accept = JSON.parse(periodo.acceptJson);
  if (!extensaoPermitida(accept, req.file.originalname)) {
    return res.status(400).json({ error: `Tipo de arquivo não permitido. Aceito: ${accept.join(", ")}.` });
  }

  const dir = path.join(UPLOADS_DIR, "envio", String(periodo.empresaId), String(periodoId));
  fs.mkdirSync(dir, { recursive: true });
  const nomeSeguro = `doc_${Date.now()}${path.extname(req.file.originalname)}`;
  const destino = path.join(dir, nomeSeguro);
  fs.writeFileSync(destino, req.file.buffer);

  // Alguns tipos (DRE, Balancete, relatórios em geral) não têm data de vencimento — o modelo
  // controla se vale a pena nem tentar detectar (ver detectar_vencimento em envio_templates).
  let vencimento: string | null = periodo.detectarVencimento && req.body?.vencimento ? String(req.body.vencimento) : null;
  let vencimentoOrigem: string | null = vencimento ? "manual" : null;
  if (periodo.detectarVencimento && !vencimento) {
    try {
      const texto = await extrairTextoArquivo(req.file);
      const detectado = extrairVencimento(texto);
      if (detectado) {
        vencimento = detectado;
        vencimentoOrigem = "automatico";
      }
    } catch {
      // não é crítico — a data pode ser preenchida/corrigida manualmente depois
    }
  }

  // Não substitui documentos já enviados nesse período — soma (ex.: guia recalculada porque o
  // cliente não pagou no prazo). O histórico das guias anteriores fica visível na grade.
  const observacao = req.body?.observacao ? String(req.body.observacao).trim() : null;
  const info = sqlite
    .prepare(
      `INSERT INTO envio_documentos (periodo_id, file_name, file_path, mime, size_bytes, observacao, vencimento, vencimento_origem, enviado_por)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(periodoId, req.file.originalname, destino, req.file.mimetype, req.file.size, observacao, vencimento, vencimentoOrigem, user.id);
  const docId = Number(info.lastInsertRowid);

  const rotulo = periodo.mes ? `${periodo.mes}/${periodo.ano}` : periodo.rotulo || String(periodo.ano);
  const contatos = sqlite.prepare(`SELECT email FROM empresa_contatos WHERE empresa_id = ? AND receber_emails = 1`).all(periodo.empresaId) as any[];
  let emailEnviado = false;
  let emailErro: string | null = null;
  if (!contatos.length) {
    emailErro = "Empresa sem contatos de e-mail cadastrados.";
  } else {
    const assunto = `${periodo.templateNome} — ${rotulo}`;
    const corpo = `Segue em anexo: ${periodo.templateNome} (${rotulo}).${vencimento ? `\n\nVencimento: ${vencimento.split("-").reverse().join("/")}` : ""}`;
    try {
      await enviarEmail(user.escritorioId, { to: contatos.map((c) => c.email), subject: assunto, text: corpo, attachments: [{ filename: req.file.originalname, content: req.file.buffer }] });
      emailEnviado = true;
      sqlite
        .prepare(`INSERT INTO emails_enviados (empresa_id, destinatarios, assunto, corpo, anexos_json, enviado_por, status) VALUES (?, ?, ?, ?, ?, ?, 'ok')`)
        .run(periodo.empresaId, contatos.map((c) => c.email).join(", "), assunto, corpo, JSON.stringify([req.file.originalname]), user.id);
    } catch (e: any) {
      emailErro = e.message;
      sqlite
        .prepare(`INSERT INTO emails_enviados (empresa_id, destinatarios, assunto, corpo, enviado_por, status, erro) VALUES (?, ?, ?, ?, ?, 'erro', ?)`)
        .run(periodo.empresaId, contatos.map((c) => c.email).join(", "), assunto, corpo, user.id, e.message);
    }
  }
  sqlite
    .prepare(`UPDATE envio_documentos SET email_enviado = ?, email_enviado_em = ?, email_erro = ? WHERE id = ?`)
    .run(emailEnviado ? 1 : 0, emailEnviado ? new Date().toISOString().replace("T", " ").slice(0, 19) : null, emailErro, docId);

  // Imposto pago em 3 quotas (ex.: IRPJ/CSLL do Lucro Real trimestral) — ao postar a 1ª quota já
  // marcando "parcelas=3", cria sozinho os 2 períodos seguintes (mês+1, mês+2) já vinculados a essa
  // guia (parcela_periodo_id), pra aparecerem na grade e entrarem na pendência dos meses certos sem
  // precisar "Gerar ano" de novo nem lembrar manualmente. Restrito a modelo trimestral: no SQLite,
  // NULL não colide com NULL num UNIQUE — um modelo mensal já tem período em TODOS os meses (rotulo
  // sempre NULL), então o INSERT do mês seguinte não seria ignorado por conflito e criaria um período
  // DUPLICADO pro mesmo mês. No trimestral, os meses "+1"/"+2" nunca são meses de fechamento (só
  // Mar/Jun/Set/Dez existem na grade normal), então nunca colidem de verdade — mas ainda checa a
  // existência antes de inserir, por segurança.
  let parcelasGeradas = 0;
  if (Number(req.body?.parcelas) === 3 && periodo.mes && !periodo.parcela_numero && periodo.templatePeriodicidade === "trimestral") {
    sqlite.prepare(`UPDATE envio_periodos SET parcela_numero = 1, parcela_total = 3 WHERE id = ?`).run(periodoId);
    let anoQuota = periodo.ano, mesQuota = periodo.mes;
    for (const numero of [2, 3]) {
      mesQuota++;
      if (mesQuota > 12) {
        mesQuota = 1;
        anoQuota++;
      }
      const jaExiste = sqlite.prepare(`SELECT 1 FROM envio_periodos WHERE atribuicao_id = ? AND ano = ? AND mes = ?`).get(periodo.atribuicao_id, anoQuota, mesQuota);
      if (jaExiste) continue;
      const infoQuota = sqlite
        .prepare(`INSERT INTO envio_periodos (atribuicao_id, ano, mes, parcela_numero, parcela_total, parcela_periodo_id) VALUES (?, ?, ?, ?, ?, ?)`)
        .run(periodo.atribuicao_id, anoQuota, mesQuota, numero, 3, periodoId);
      if (infoQuota.changes) parcelasGeradas++;
    }
  }

  res.json({ id: docId, vencimento, vencimentoOrigem, emailEnviado, emailErro, parcelasGeradas });
});

// "Sem imposto devido" — pra competência (mensal/trimestral) em que não houve imposto a recolher
// (ex.: IRPJ/CSLL trimestral com prejuízo fiscal no período), não existe guia nenhuma pra anexar,
// mas a pendência do card "Modelo de Envio em Atraso" continuaria acesa pra sempre sem isso. Marca
// o período como satisfeito sem precisar de documento — desmarcável (por engano) enquanto não tiver
// nenhum documento anexado de verdade.
app.post("/api/envio/periodos/:periodoId/sem-movimento", blockCliente, requirePermissao("envio", "postar"), (req, res) => {
  const user = (req as any).user;
  const periodoId = Number(req.params.periodoId);
  const semMovimento = !!req.body?.semMovimento;
  const observacao = req.body?.observacao ? String(req.body.observacao).trim() : null;
  const periodo = sqlite
    .prepare(`SELECT p.*, a.empresa_id as empresaId FROM envio_periodos p JOIN envio_atribuicoes a ON a.id = p.atribuicao_id WHERE p.id = ?`)
    .get(periodoId) as any;
  if (!periodo) return res.status(404).json({ error: "Período não encontrado." });
  if (!podeAcessarEmpresa(user, periodo.empresaId)) return res.status(403).json({ error: "Sem acesso a esta empresa." });
  const temDocumento = sqlite.prepare(`SELECT 1 FROM envio_documentos WHERE periodo_id = ?`).get(periodoId);
  if (semMovimento && temDocumento) return res.status(409).json({ error: "Este período já tem documento anexado." });
  sqlite
    .prepare(`UPDATE envio_periodos SET sem_movimento = ?, sem_movimento_observacao = ?, sem_movimento_por = ?, sem_movimento_em = ? WHERE id = ?`)
    .run(semMovimento ? 1 : 0, semMovimento ? observacao : null, semMovimento ? user.id : null, semMovimento ? new Date().toISOString().replace("T", " ").slice(0, 19) : null, periodoId);
  res.json({ ok: true });
});
function envioDocumentoEmpresaId(docId: number): number | null {
  const row = sqlite
    .prepare(
      `SELECT a.empresa_id as empresaId FROM envio_documentos d
       JOIN envio_periodos p ON p.id = d.periodo_id
       JOIN envio_atribuicoes a ON a.id = p.atribuicao_id
       WHERE d.id = ?`
    )
    .get(docId) as any;
  return row ? row.empresaId : null;
}
app.put("/api/envio/documentos/:id/vencimento", blockCliente, requirePermissao("envio", "editar"), (req, res) => {
  const { vencimento } = req.body || {};
  if (!vencimento) return res.status(400).json({ error: "Informe a data de vencimento." });
  const docId = Number(req.params.id);
  const empresaId = envioDocumentoEmpresaId(docId);
  if (empresaId === null || !podeAcessarEmpresa((req as any).user, empresaId)) return res.status(404).json({ error: "Documento não encontrado." });
  sqlite.prepare(`UPDATE envio_documentos SET vencimento = ?, vencimento_origem = 'manual' WHERE id = ?`).run(vencimento, docId);
  res.json({ ok: true });
});
app.delete("/api/envio/documentos/:id", blockCliente, requirePermissao("envio", "editar"), (req, res) => {
  const doc = sqlite.prepare(`SELECT * FROM envio_documentos WHERE id = ?`).get(Number(req.params.id)) as any;
  if (!doc) return res.status(404).json({ error: "Documento não encontrado." });
  const empresaId = envioDocumentoEmpresaId(doc.id);
  if (empresaId === null || !podeAcessarEmpresa((req as any).user, empresaId)) return res.status(404).json({ error: "Documento não encontrado." });
  try {
    fs.unlinkSync(doc.file_path);
  } catch {}
  sqlite.prepare(`DELETE FROM envio_documentos WHERE id = ?`).run(doc.id);
  res.json({ ok: true });
});
app.post("/api/envio/documentos/:id/reenviar-email", blockCliente, requirePermissao("envio", "postar"), async (req, res) => {
  const user = (req as any).user;
  const doc = sqlite
    .prepare(
      `SELECT d.*, p.atribuicao_id as atribuicaoId, p.ano, p.mes, p.rotulo FROM envio_documentos d JOIN envio_periodos p ON p.id = d.periodo_id WHERE d.id = ?`
    )
    .get(Number(req.params.id)) as any;
  if (!doc) return res.status(404).json({ error: "Documento não encontrado." });
  const atrib = sqlite
    .prepare(`SELECT a.empresa_id as empresaId, a.template_id as templateId, t.nome as templateNome FROM envio_atribuicoes a JOIN envio_templates t ON t.id = a.template_id WHERE a.id = ?`)
    .get(doc.atribuicaoId) as any;
  if (!atrib || !podeAcessarEmpresa(user, atrib.empresaId)) return res.status(404).json({ error: "Documento não encontrado." });
  const contatos = sqlite.prepare(`SELECT email FROM empresa_contatos WHERE empresa_id = ? AND receber_emails = 1`).all(atrib.empresaId) as any[];
  if (!contatos.length) return res.status(400).json({ error: "Esta empresa não tem contatos de e-mail cadastrados." });
  if (!fs.existsSync(doc.file_path)) return res.status(404).json({ error: "Arquivo não encontrado no servidor." });
  const rotulo = doc.mes ? `${doc.mes}/${doc.ano}` : doc.rotulo || String(doc.ano);
  const assunto = `${atrib.templateNome} — ${rotulo}`;
  // Reenvio manual é genérico (serve pra qualquer modelo de Envio de Documentos) — mas quando o
  // documento é do modelo configurado pra NFS-e (nfse_agendamento_config.envio_template_id), usa o
  // mesmo texto padrão configurado em E-mail corporativo > Texto padrão para NFS-e, em vez do texto
  // genérico "Segue em anexo: ..." — senão o reenvio nunca respeitava o texto que o admin definiu.
  const nfseConfig = sqlite.prepare(`SELECT envio_template_id FROM nfse_agendamento_config WHERE escritorio_id = ?`).get(user.escritorioId) as any;
  let corpo: string;
  if (nfseConfig?.envio_template_id && atrib.templateId === nfseConfig.envio_template_id) {
    const emailConfig = sqlite.prepare(`SELECT nfse_email_texto FROM email_config WHERE escritorio_id = ?`).get(user.escritorioId) as any;
    corpo = emailConfig?.nfse_email_texto || `Segue em anexo a Nota Fiscal de Serviço referente a ${rotulo}.`;
  } else {
    corpo = `Segue em anexo: ${atrib.templateNome} (${rotulo}).${doc.vencimento ? `\n\nVencimento: ${String(doc.vencimento).split("-").reverse().join("/")}` : ""}`;
  }
  try {
    await enviarEmail(user.escritorioId, { to: contatos.map((c) => c.email), subject: assunto, text: corpo, attachments: [{ filename: doc.file_name, content: fs.readFileSync(doc.file_path) }] });
    sqlite.prepare(`UPDATE envio_documentos SET email_enviado = 1, email_enviado_em = datetime('now'), email_erro = NULL WHERE id = ?`).run(doc.id);
    sqlite
      .prepare(`INSERT INTO emails_enviados (empresa_id, destinatarios, assunto, corpo, anexos_json, enviado_por, status) VALUES (?, ?, ?, ?, ?, ?, 'ok')`)
      .run(atrib.empresaId, contatos.map((c) => c.email).join(", "), assunto, corpo, JSON.stringify([doc.file_name]), user.id);
    res.json({ ok: true });
  } catch (e: any) {
    sqlite.prepare(`UPDATE envio_documentos SET email_erro = ? WHERE id = ?`).run(e.message, doc.id);
    res.status(500).json({ error: e.message });
  }
});
// Mesma lógica de conteúdo do reenvio por e-mail acima, só que manda por WhatsApp — pra todo
// contato da empresa marcado como "receber WhatsApp" que tenha telefone cadastrado.
app.post("/api/envio/documentos/:id/enviar-whatsapp", blockCliente, requirePermissao("envio", "postar"), async (req, res) => {
  const user = (req as any).user;
  const doc = sqlite
    .prepare(
      `SELECT d.*, p.atribuicao_id as atribuicaoId, p.ano, p.mes, p.rotulo FROM envio_documentos d JOIN envio_periodos p ON p.id = d.periodo_id WHERE d.id = ?`
    )
    .get(Number(req.params.id)) as any;
  if (!doc) return res.status(404).json({ error: "Documento não encontrado." });
  const atrib = sqlite
    .prepare(`SELECT a.empresa_id as empresaId, t.nome as templateNome FROM envio_atribuicoes a JOIN envio_templates t ON t.id = a.template_id WHERE a.id = ?`)
    .get(doc.atribuicaoId) as any;
  if (!atrib || !podeAcessarEmpresa(user, atrib.empresaId)) return res.status(404).json({ error: "Documento não encontrado." });
  const empresa = sqlite.prepare(`SELECT nome FROM empresas WHERE id = ?`).get(atrib.empresaId) as any;
  const contatos = sqlite
    .prepare(`SELECT telefone FROM empresa_contatos WHERE empresa_id = ? AND receber_whatsapp = 1 AND telefone IS NOT NULL AND telefone != ''`)
    .all(atrib.empresaId) as any[];
  if (!contatos.length) return res.status(400).json({ error: "Esta empresa não tem contato de WhatsApp cadastrado (marque \"Receber WhatsApp\" no contato)." });
  if (!fs.existsSync(doc.file_path)) return res.status(404).json({ error: "Arquivo não encontrado no servidor." });
  const rotulo = doc.mes ? `${doc.mes}/${doc.ano}` : doc.rotulo || String(doc.ano);
  const descricao = `${atrib.templateNome} — ${rotulo}`;
  const arquivo = { nome: doc.file_name, tipo: doc.mime || "application/pdf", buffer: fs.readFileSync(doc.file_path) };
  let enviados = 0;
  const erros: string[] = [];
  for (const c of contatos) {
    try {
      await whatsappEnviarArquivo(
        user.escritorioId,
        c.telefone,
        [
          { nome: "empresa_nome", valor: empresa?.nome || "" },
          { nome: "descricao", valor: descricao },
        ],
        arquivo,
        { tabela: "envio_documentos", id: doc.id }
      );
      enviados++;
    } catch (e: any) {
      erros.push(e.message);
    }
  }
  if (enviados > 0) sqlite.prepare(`UPDATE envio_documentos SET whatsapp_enviado = 1, whatsapp_enviado_em = datetime('now'), whatsapp_erro = NULL WHERE id = ?`).run(doc.id);
  else sqlite.prepare(`UPDATE envio_documentos SET whatsapp_erro = ? WHERE id = ?`).run(erros[0] || "Falha desconhecida.", doc.id);
  if (!enviados) return res.status(502).json({ error: erros[0] || "Não consegui enviar por WhatsApp." });
  res.json({ ok: true, enviados, falhas: erros.length });
});
app.get("/api/envio/documentos/:id/download", (req, res) => {
  const user = (req as any).user;
  const doc = sqlite
    .prepare(`SELECT d.*, p.atribuicao_id as atribuicaoId FROM envio_documentos d JOIN envio_periodos p ON p.id = d.periodo_id WHERE d.id = ?`)
    .get(Number(req.params.id)) as any;
  if (!doc) return res.status(404).json({ error: "Documento não encontrado." });
  const atrib = sqlite.prepare(`SELECT empresa_id as empresaId FROM envio_atribuicoes WHERE id = ?`).get(doc.atribuicaoId) as any;
  if (user.perfil === "Cliente") {
    if (user.empresaId !== atrib.empresaId) return res.status(403).json({ error: "Sem acesso." });
  } else {
    if (!hasPermissao(user, "envio", "visualizar")) return res.status(403).json({ error: "Sem permissão." });
    if (!podeAcessarEmpresa(user, atrib.empresaId)) return res.status(403).json({ error: "Sem acesso a esta empresa." });
  }
  if (!fs.existsSync(doc.file_path)) return res.status(404).json({ error: "Arquivo não encontrado." });
  res.download(doc.file_path, doc.file_name);
});

// ---------- NFS-e (emissão via Sistema Nacional NFS-e / ADN) ----------
// Certificados ficam sempre criptografados em repouso — só decifrados em memória, no momento de
// assinar/enviar (ver src/nfse.ts). O acesso a certificados é restrito ao Administrador: é a
// chave de assinatura de documentos fiscais, mais sensível que qualquer outro dado do sistema.
function nfseCarregarCertificado(row: any): nfse.CertificadoInfo {
  const pfxBuf = nfse.lerCertificadoCifradoDoDisco(row.arquivo_path);
  const senha = nfse.decifrarTexto(row.senha_cifrada);
  return nfse.lerCertificadoPfx(pfxBuf, senha);
}
// Resolve qual certificado usar para emitir em nome de uma empresa: o dela própria (se o método
// for 'certificado_proprio') ou o do escritório (via procuração eletrônica, outorgada fora do
// sistema no e-CAC/gov.br — aqui só assumimos que a outorga já foi feita).
function nfseCertificadoParaEmpresa(empresaId: number, metodo: string): { cert: nfse.CertificadoInfo; cnpjPrestador: string } {
  const empresa = sqlite.prepare(`SELECT cnpj, escritorio_id FROM empresas WHERE id = ?`).get(empresaId) as any;
  if (metodo === "certificado_proprio") {
    // Certificado próprio agora é o mesmo já cadastrado em Empresas › Configurações (nfe_busca_config,
    // reaproveitado — evita pedir o mesmo .pfx duas vezes pro admin); nfse_certificados fica só como
    // fallback pro autoatendimento do Cliente (que não tem acesso à Busca de XML pra configurar lá).
    const rowBusca = sqlite.prepare(`SELECT * FROM nfe_busca_config WHERE empresa_id = ?`).get(empresaId) as any;
    if (rowBusca) return { cert: nfseCarregarCertificado(rowBusca), cnpjPrestador: (empresa?.cnpj || "").replace(/\D/g, "") };
    const row = sqlite.prepare(`SELECT * FROM nfse_certificados WHERE empresa_id = ?`).get(empresaId) as any;
    if (!row) throw new Error("Esta empresa está configurada para usar certificado próprio, mas nenhum certificado foi enviado ainda — envie em Empresas › Configurações.");
    return { cert: nfseCarregarCertificado(row), cnpjPrestador: (empresa?.cnpj || "").replace(/\D/g, "") };
  }
  const row = sqlite.prepare(`SELECT * FROM nfse_certificados WHERE empresa_id IS NULL AND escritorio_id = ?`).get(empresa?.escritorio_id) as any;
  if (!row) throw new Error('Nenhum certificado do escritório configurado ainda — envie em "NFS-e › Configuração".');
  return { cert: nfseCarregarCertificado(row), cnpjPrestador: (empresa?.cnpj || "").replace(/\D/g, "") };
}

app.get("/api/nfse/certificados", blockCliente, requireAdmin, (req, res) => {
  const rows = sqlite
    .prepare(
      `SELECT c.id, c.empresa_id as empresaId, e.nome as empresaNome, c.titular, c.cnpj_certificado as cnpjCertificado,
              c.validade_ate as validadeAte, c.criado_em as criadoEm
       FROM nfse_certificados c LEFT JOIN empresas e ON e.id = c.empresa_id
       WHERE c.escritorio_id = ? AND (c.empresa_id IS NULL OR e.ativo = 1)
       ORDER BY (c.empresa_id IS NOT NULL), e.nome`
    )
    .all((req as any).user.escritorioId);
  res.json({ items: rows });
});
app.post("/api/nfse/certificados", blockCliente, requireAdmin, upload.single("arquivo"), (req, res) => {
  const user = (req as any).user;
  if (!req.file) return res.status(400).json({ error: "Selecione o arquivo .pfx." });
  const { senha, empresaId } = req.body || {};
  if (!senha) return res.status(400).json({ error: "Informe a senha do certificado." });
  const empId = empresaId ? Number(empresaId) : null;
  if (empId && !podeAcessarEmpresa(user, empId)) return res.status(404).json({ error: "Empresa não encontrada." });
  let info: nfse.CertificadoInfo;
  try {
    info = nfse.lerCertificadoPfx(req.file.buffer, senha);
  } catch (e: any) {
    return res.status(400).json({ error: e.message });
  }
  const existente = sqlite.prepare(`SELECT * FROM nfse_certificados WHERE empresa_id IS ? AND escritorio_id = ?`).get(empId, user.escritorioId) as any;
  const arquivoPath = nfse.salvarCertificadoCifrado(req.file.buffer, req.file.originalname);
  const senhaCifrada = nfse.cifrarTexto(senha);
  const validadeIso = info.validadeAte ? info.validadeAte.toISOString() : null;
  if (existente) {
    nfse.excluirCertificadoDoDisco(existente.arquivo_path);
    sqlite
      .prepare(`UPDATE nfse_certificados SET arquivo_path=?, senha_cifrada=?, titular=?, cnpj_certificado=?, validade_ate=?, criado_por=?, criado_em=datetime('now') WHERE id=?`)
      .run(arquivoPath, senhaCifrada, info.titular, info.cnpjCertificado, validadeIso, user.id, existente.id);
  } else {
    sqlite
      .prepare(`INSERT INTO nfse_certificados (empresa_id, arquivo_path, senha_cifrada, titular, cnpj_certificado, validade_ate, criado_por, escritorio_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(empId, arquivoPath, senhaCifrada, info.titular, info.cnpjCertificado, validadeIso, user.id, user.escritorioId);
  }
  res.json({ ok: true, titular: info.titular, cnpjCertificado: info.cnpjCertificado, validadeAte: validadeIso });
});
app.delete("/api/nfse/certificados/:id", blockCliente, requireAdmin, (req, res) => {
  const row = sqlite.prepare(`SELECT * FROM nfse_certificados WHERE id = ?`).get(Number(req.params.id)) as any;
  if (!row || row.escritorio_id !== (req as any).user.escritorioId) return res.status(404).json({ error: "Certificado não encontrado." });
  nfse.excluirCertificadoDoDisco(row.arquivo_path);
  sqlite.prepare(`DELETE FROM nfse_certificados WHERE id = ?`).run(row.id);
  res.json({ ok: true });
});

// ---------- Busca automática de NF-e/NFC-e (Distribuição DFe da Sefaz) ----------
// Módulo comprável pelo escritório ("busca_xml_nfe"), igual aos outros três — ver
// escritorioTemModulo(). Cada empresa-cliente que participa precisa do próprio certificado (a
// Sefaz só distribui documentos pra quem é parte interessada neles).
function nfeCarregarCertificado(row: any): nfse.CertificadoInfo {
  const pfxBuf = nfse.lerCertificadoCifradoDoDisco(row.arquivo_path);
  const senha = nfse.decifrarTexto(row.senha_cifrada);
  return nfse.lerCertificadoPfx(pfxBuf, senha);
}
app.get("/api/nfe/config", blockCliente, requirePermissao("nfe-busca", "visualizar"), (req, res) => {
  const rows = sqlite
    .prepare(
      `SELECT c.empresa_id as empresaId, e.nome as empresaNome, c.cnpj, c.uf_autor as ufAutor, c.ambiente,
              c.titular, c.cnpj_certificado as cnpjCertificado, c.validade_ate as validadeAte, c.ativo,
              c.ultimo_nsu as ultimoNsu, c.ultima_busca_em as ultimaBuscaEm, c.ultimo_erro as ultimoErro,
              c.ultimo_nsu_nfse as ultimoNsuNfse, c.ultima_busca_nfse_em as ultimaBuscaNfseEm, c.ultimo_erro_nfse as ultimoErroNfse
       FROM nfe_busca_config c JOIN empresas e ON e.id = c.empresa_id
       WHERE c.escritorio_id = ? AND e.ativo = 1 ORDER BY e.nome`
    )
    .all((req as any).user.escritorioId);
  res.json({ items: rows, moduloAtivo: escritorioTemModulo((req as any).user.escritorioId, "busca_xml_nfe") });
});
app.post("/api/nfe/config", blockCliente, requirePermissao("nfe-busca", "postar"), upload.single("arquivo"), async (req, res) => {
  const user = (req as any).user;
  if (!req.file) return res.status(400).json({ error: "Selecione o arquivo .pfx." });
  const { senha, empresaId, ufAutor, ambiente } = req.body || {};
  if (!senha) return res.status(400).json({ error: "Informe a senha do certificado." });
  const empId = Number(empresaId);
  if (!empId || !podeAcessarEmpresa(user, empId)) return res.status(404).json({ error: "Empresa não encontrada." });
  const empresa = sqlite.prepare(`SELECT cnpj, uf FROM empresas WHERE id = ?`).get(empId) as any;
  const uf = String(ufAutor || empresa?.uf || "").toUpperCase().trim();
  if (!nfe.UF_CODIGO_IBGE[uf]) return res.status(400).json({ error: "UF inválida — informe a sigla da UF da empresa (ex.: SP)." });
  let info: nfse.CertificadoInfo;
  try {
    info = nfse.lerCertificadoPfx(req.file.buffer, senha);
  } catch (e: any) {
    return res.status(400).json({ error: e.message });
  }
  const existente = sqlite.prepare(`SELECT * FROM nfe_busca_config WHERE empresa_id = ?`).get(empId) as any;
  const arquivoPath = nfse.salvarCertificadoCifrado(req.file.buffer, req.file.originalname);
  const senhaCifrada = nfse.cifrarTexto(senha);
  const validadeIso = info.validadeAte ? info.validadeAte.toISOString() : null;
  const amb = ambiente === "homologacao" ? "homologacao" : "producao";
  if (existente) {
    nfse.excluirCertificadoDoDisco(existente.arquivo_path);
    sqlite
      .prepare(
        `UPDATE nfe_busca_config SET cnpj=?, uf_autor=?, ambiente=?, arquivo_path=?, senha_cifrada=?, titular=?, cnpj_certificado=?, validade_ate=?, criado_por=?, updated_at=datetime('now'), ultimo_erro=NULL WHERE empresa_id=?`
      )
      .run(empresa?.cnpj || "", uf, amb, arquivoPath, senhaCifrada, info.titular, info.cnpjCertificado, validadeIso, user.id, empId);
  } else {
    sqlite
      .prepare(
        `INSERT INTO nfe_busca_config (empresa_id, escritorio_id, cnpj, uf_autor, ambiente, arquivo_path, senha_cifrada, titular, cnpj_certificado, validade_ate, criado_por) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(empId, user.escritorioId, empresa?.cnpj || "", uf, amb, arquivoPath, senhaCifrada, info.titular, info.cnpjCertificado, validadeIso, user.id);
  }
  // Já sincroniza o histórico completo na hora, se o escritório tiver o módulo contratado — o
  // usuário não deveria precisar cadastrar o certificado E DEPOIS lembrar de clicar em "Buscar
  // agora" separadamente. Cada busca é independente (uma falhando não trava a outra), igual à rota
  // manual /buscar.
  let resultadoSync = { novosNfe: 0, novosNfse: 0, erroNfe: null as string | null, erroNfse: null as string | null };
  if (escritorioTemModulo(user.escritorioId, "busca_xml_nfe") && !nfeBuscasEmAndamento.has(empId)) {
    const cfgAtualizado = sqlite.prepare(`SELECT * FROM nfe_busca_config WHERE empresa_id = ?`).get(empId) as any;
    nfeBuscasEmAndamento.add(empId);
    try {
      resultadoSync = await nfeENfseBuscarTudo(empId, cfgAtualizado, info);
    } finally {
      nfeBuscasEmAndamento.delete(empId);
    }
  }
  res.json({ ok: true, titular: info.titular, cnpjCertificado: info.cnpjCertificado, validadeAte: validadeIso, sync: resultadoSync });
});
// Reativar a busca de uma empresa que estava desligada também já sincroniza na hora, pelo mesmo
// motivo do upload de certificado — senão ela só voltaria a ser buscada até 65min depois (rotina
// automática) ou quando alguém lembrasse de clicar "Buscar agora".
app.put("/api/nfe/config/:empresaId/ativo", blockCliente, requirePermissao("nfe-busca", "editar"), async (req, res) => {
  const user = (req as any).user;
  const empId = Number(req.params.empresaId);
  const row = sqlite.prepare(`SELECT * FROM nfe_busca_config WHERE empresa_id = ?`).get(empId) as any;
  if (!row || row.escritorio_id !== user.escritorioId) return res.status(404).json({ error: "Configuração não encontrada." });
  const ativando = !!req.body?.ativo && !row.ativo;
  sqlite.prepare(`UPDATE nfe_busca_config SET ativo = ?, updated_at = datetime('now') WHERE empresa_id = ?`).run(req.body?.ativo ? 1 : 0, empId);
  let sync = { novosNfe: 0, novosNfse: 0, erroNfe: null as string | null, erroNfse: null as string | null };
  if (ativando && escritorioTemModulo(user.escritorioId, "busca_xml_nfe") && !nfeBuscasEmAndamento.has(empId)) {
    nfeBuscasEmAndamento.add(empId);
    try {
      const cert = nfeCarregarCertificado(row);
      sync = await nfeENfseBuscarTudo(empId, row, cert);
    } catch (e: any) {
      sync.erroNfe = e.message;
    } finally {
      nfeBuscasEmAndamento.delete(empId);
    }
  }
  res.json({ ok: true, sync });
});
app.delete("/api/nfe/config/:empresaId", blockCliente, requirePermissao("nfe-busca", "editar"), (req, res) => {
  const empId = Number(req.params.empresaId);
  const row = sqlite.prepare(`SELECT * FROM nfe_busca_config WHERE empresa_id = ?`).get(empId) as any;
  if (!row || row.escritorio_id !== (req as any).user.escritorioId) return res.status(404).json({ error: "Configuração não encontrada." });
  nfse.excluirCertificadoDoDisco(row.arquivo_path);
  sqlite.prepare(`DELETE FROM nfe_busca_config WHERE empresa_id = ?`).run(empId);
  res.json({ ok: true });
});

// Busca manual ("buscar agora") — pagina via ultNSU até acabar (maxNSU alcançado) ou até um teto
// de segurança, salva os documentos novos e atualiza o cursor. Mesma função é reaproveitada pela
// rotina automática futura (nfeExecutarBuscaAutomatica), assim como nfseAnexarEEnviarDocumento hoje.
const nfeInserirDocumento = sqlite.prepare(
  `INSERT OR IGNORE INTO nfe_documentos (empresa_id, escritorio_id, fonte, nsu, doc_schema, tipo, chave_acesso, emitente_cnpj, emitente_nome, destinatario_cnpj, destinatario_nome, valor_total, data_emissao, xml, evento_descricao)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
);
// Achado ao vivo (LUCELIO MARTINS DE OLIVEIRA): nfe_busca_config.cnpj é uma cópia de empresas.cnpj
// tirada só no momento em que o certificado é cadastrado — se o CPF/CNPJ da empresa ainda estava em
// branco naquela hora (comum pra pessoa física recém-cadastrada), a cópia ficou vazia pra sempre,
// mesmo depois do cadastro da empresa ser completado. Um <CNPJ></CNPJ> vazio no pedido pra Sefaz é
// rejeitado direto na validação de schema (cStat 215 "Falha no esquema xml") — o tratamento de CPF
// vs CNPJ (ver consultarNovosDocumentos) nem chega a entrar em ação, porque o documento chega vazio.
// Resolve isso na hora do uso (não só no cadastro) e já corrige o registro, pra não repetir a
// consulta toda vez.
function nfeResolverCnpjBusca(cfg: any, empresaId: number): string {
  if (cfg.cnpj && String(cfg.cnpj).replace(/\D/g, "").length) return cfg.cnpj;
  const empresa = sqlite.prepare(`SELECT cnpj FROM empresas WHERE id = ?`).get(empresaId) as any;
  const cnpjEmpresa = empresa?.cnpj || "";
  if (cnpjEmpresa.replace(/\D/g, "").length) {
    sqlite.prepare(`UPDATE nfe_busca_config SET cnpj = ? WHERE empresa_id = ?`).run(cnpjEmpresa, empresaId);
  }
  return cnpjEmpresa;
}
// Captura de nota emitida por um CLIENTE via tag autXML (investigação registrada em memory.md):
// quando o cliente configura o CNPJ do escritório como "autorizado a acessar o XML" no software
// emissor dele, a Distribuição DFe passa a devolver essa nota também pra quem está consultando com
// ESSE CNPJ (tipicamente o próprio escritório, buscando pela sua própria empresa) — mesmo sem ser
// nem emitente nem destinatário. Sem isso, a nota cairia dentro de nfe_documentos atribuída à
// empresa que fez a busca (o escritório), misturada com os documentos dele mesmo, em vez de
// aparecer pro cliente de verdade que a emitiu. Acha a empresa-cliente certa pelo CNPJ do emitente
// (mesmo escritório, cadastrada) e devolve ela; se não achar (emitente não é cliente cadastrado, ou
// é a própria empresa buscada), devolve a empresa original — comportamento de sempre.
function nfeResolverEmpresaDestino(escritorioId: number, empresaBuscada: number, cnpjBusca: string, emitenteCnpj: string | null): number {
  if (!emitenteCnpj) return empresaBuscada;
  const emitenteLimpo = emitenteCnpj.replace(/\D/g, "");
  const cnpjBuscaLimpo = String(cnpjBusca || "").replace(/\D/g, "");
  if (!emitenteLimpo || emitenteLimpo === cnpjBuscaLimpo) return empresaBuscada;
  const outraEmpresa = sqlite
    .prepare(
      `SELECT id FROM empresas WHERE escritorio_id = ? AND id != ? AND REPLACE(REPLACE(REPLACE(cnpj,'.',''),'/',''),'-','') = ?`
    )
    .get(escritorioId, empresaBuscada, emitenteLimpo) as any;
  return outraEmpresa ? outraEmpresa.id : empresaBuscada;
}
async function nfeBuscarDocumentosNovos(empresaId: number, cfg: any, cert: nfse.CertificadoInfo): Promise<{ novos: number }> {
  let novos = 0;
  let ultNsu = cfg.ultimo_nsu;
  const cnpjBusca = nfeResolverCnpjBusca(cfg, empresaId);
  try {
    // Teto de 20 páginas (até 1000 documentos) por chamada manual/automática — evita loop longo
    // demais numa única requisição; se sobrar mais, a próxima busca continua do NSU salvo.
    for (let pagina = 0; pagina < 20; pagina++) {
      const resp = await nfe.consultarNovosDocumentos({
        ambiente: cfg.ambiente as nfe.AmbienteNfe,
        cnpj: cnpjBusca,
        cUFAutor: nfe.UF_CODIGO_IBGE[cfg.uf_autor],
        cert,
        ultimoNsuConhecido: ultNsu,
      });
      for (const doc of resp.documentos) {
        const info = nfe.identificarDocumento(doc.xml, doc.schema);
        const empresaDestino = nfeResolverEmpresaDestino(cfg.escritorio_id, empresaId, cnpjBusca, info.emitenteCnpj);
        // O NSU só é sequencial/único dentro do fluxo do CNPJ que fez a busca — reatribuir pra outra
        // empresa (autXML) usa um NSU "emprestado" que pode coincidir com um NSU real da própria
        // busca dessa outra empresa (cada CNPJ tem sua sequência independente). Namespacing evita
        // colidir com o UNIQUE(empresa_id, fonte, nsu); pelo mesmo motivo, também confere por chave
        // de acesso antes de inserir (a chave é globalmente única, o NSU emprestado não é).
        let nsuArmazenado = doc.nsu;
        if (empresaDestino !== empresaId) {
          if (info.chaveAcesso) {
            const jaTem = sqlite.prepare(`SELECT 1 FROM nfe_documentos WHERE empresa_id = ? AND chave_acesso = ?`).get(empresaDestino, info.chaveAcesso);
            if (jaTem) continue;
          }
          nsuArmazenado = `autxml_${cnpjBusca.replace(/\D/g, "")}_${doc.nsu}`;
        }
        const r = nfeInserirDocumento.run(
          empresaDestino,
          cfg.escritorio_id,
          "nfe",
          nsuArmazenado,
          doc.schema,
          info.tipo,
          info.chaveAcesso,
          info.emitenteCnpj,
          info.emitenteNome,
          info.destinatarioCnpj,
          info.destinatarioNome,
          info.valorTotal,
          info.dataEmissao,
          doc.xml,
          info.eventoDescricao
        );
        if (r.changes > 0) novos++;
      }
      ultNsu = resp.ultNSU || ultNsu;
      sqlite.prepare(`UPDATE nfe_busca_config SET ultimo_nsu = ?, ultima_busca_em = datetime('now'), ultimo_erro = NULL WHERE empresa_id = ?`).run(ultNsu, empresaId);
      if (!resp.maxNSU || !resp.ultNSU || Number(resp.maxNSU) <= Number(resp.ultNSU) || resp.documentos.length === 0) break;
    }
  } catch (e: any) {
    sqlite.prepare(`UPDATE nfe_busca_config SET ultima_busca_em = datetime('now'), ultimo_erro = ? WHERE empresa_id = ?`).run(e.message || String(e), empresaId);
    throw e;
  }
  return { novos };
}
// Mesma ideia, mas pra NFS-e via Distribuição DF-e do ADN (Sistema Nacional NFS-e) — sequência de
// NSU própria, host diferente (adn.nfse.gov.br), reaproveita o mesmo certificado da empresa.
async function nfseBuscarDocumentosNovos(empresaId: number, cfg: any, cert: nfse.CertificadoInfo): Promise<{ novos: number }> {
  let novos = 0;
  let ultNsu = cfg.ultimo_nsu_nfse || "0";
  const cnpjBusca = nfeResolverCnpjBusca(cfg, empresaId);
  try {
    for (let pagina = 0; pagina < 20; pagina++) {
      const resp = await nfse.consultarDistribuicaoNfse(cfg.ambiente as nfse.AmbienteNfse, ultNsu, cnpjBusca, cert);
      for (const doc of resp.documentos) {
        const info = nfse.identificarNfseDistribuida(doc.xml);
        const r = nfeInserirDocumento.run(
          empresaId,
          cfg.escritorio_id,
          "nfse",
          doc.nsu,
          "NFSe_v1.00",
          "nfse",
          info.chaveAcesso || doc.chaveAcesso,
          info.emitenteDocumento,
          info.emitenteNome,
          info.tomadorDocumento,
          info.tomadorNome,
          info.valorTotal,
          info.dataEmissao,
          doc.xml,
          null
        );
        if (r.changes > 0) novos++;
      }
      const avancou = resp.ultimoNsu && resp.ultimoNsu !== ultNsu;
      ultNsu = resp.ultimoNsu || ultNsu;
      sqlite.prepare(`UPDATE nfe_busca_config SET ultimo_nsu_nfse = ?, ultima_busca_nfse_em = datetime('now'), ultimo_erro_nfse = NULL WHERE empresa_id = ?`).run(ultNsu, empresaId);
      if (!avancou || Number(resp.maiorNsu || ultNsu) <= Number(ultNsu) || resp.documentos.length === 0) break;
    }
  } catch (e: any) {
    sqlite.prepare(`UPDATE nfe_busca_config SET ultima_busca_nfse_em = datetime('now'), ultimo_erro_nfse = ? WHERE empresa_id = ?`).run(e.message || String(e), empresaId);
    throw e;
  }
  return { novos };
}
// Empresas com uma busca em andamento agora (manual, automática, ou disparada ao cadastrar o
// certificado) — evita duas buscas rodando ao mesmo tempo pra mesma empresa (ex.: a rotina
// automática pegando bem na hora que alguém clica "Buscar agora"), o que faria requisição em
// duplicidade pra Sefaz/ADN e escrita concorrente no mesmo registro de nfe_busca_config.
const nfeBuscasEmAndamento = new Set<number>();
// Roda as duas fontes (NF-e/NFC-e e NFS-e) — usado pelo clique manual, pelo cadastro de certificado
// e pela rotina automática, sempre do mesmo jeito (falha numa fonte não trava a outra).
async function nfeENfseBuscarTudo(empresaId: number, cfg: any, cert: nfse.CertificadoInfo) {
  const resultado = { novosNfe: 0, novosNfse: 0, erroNfe: null as string | null, erroNfse: null as string | null };
  try {
    resultado.novosNfe = (await nfeBuscarDocumentosNovos(empresaId, cfg, cert)).novos;
  } catch (e: any) {
    resultado.erroNfe = e.message || "Falha ao consultar a Sefaz (NF-e/NFC-e).";
  }
  try {
    resultado.novosNfse = (await nfseBuscarDocumentosNovos(empresaId, cfg, cert)).novos;
  } catch (e: any) {
    resultado.erroNfse = e.message || "Falha ao consultar o ADN (NFS-e).";
  }
  return resultado;
}
// Busca "completa" (o que o usuário pediu: "um buscar por completo igual ao SIEG") — roda NF-e/NFC-e
// e NFS-e no mesmo clique, com falhas independentes (uma fonte fora do ar não trava a outra).
app.post("/api/nfe/config/:empresaId/buscar", blockCliente, requirePermissao("nfe-busca", "postar"), async (req, res) => {
  const user = (req as any).user;
  const empId = Number(req.params.empresaId);
  if (!podeAcessarEmpresa(user, empId)) return res.status(404).json({ error: "Empresa não encontrada." });
  if (!escritorioTemModulo(user.escritorioId, "busca_xml_nfe")) {
    return res.status(403).json({ error: "Módulo de busca de XML não contratado para este escritório." });
  }
  if (nfeBuscasEmAndamento.has(empId)) {
    return res.status(409).json({ error: "Já tem uma busca em andamento pra esta empresa (pode ser a rotina automática) — aguarde terminar e tente de novo." });
  }
  const cfg = sqlite.prepare(`SELECT * FROM nfe_busca_config WHERE empresa_id = ?`).get(empId) as any;
  if (!cfg) return res.status(400).json({ error: "Nenhum certificado configurado para esta empresa." });
  if (!cfg.ativo) return res.status(400).json({ error: "A busca automática está desativada para esta empresa." });
  nfeBuscasEmAndamento.add(empId);
  try {
    const cert = nfeCarregarCertificado(cfg);
    const resultado = await nfeENfseBuscarTudo(empId, cfg, cert);
    if (resultado.erroNfe && resultado.erroNfse) {
      return res.status(400).json({ error: `NF-e/NFC-e: ${resultado.erroNfe} | NFS-e: ${resultado.erroNfse}` });
    }
    res.json({ ok: true, ...resultado, novos: resultado.novosNfe + resultado.novosNfse });
  } finally {
    nfeBuscasEmAndamento.delete(empId);
  }
});
// Rotina automática — roda sozinha a cada ~65min (a própria Sefaz pede pra esperar 1h entre
// consultas de NF-e quando dá "Consumo Indevido", então não faz sentido rodar mais rápido que isso).
// Processa uma empresa de cada vez, com uma pausa entre elas — o limite de requisição da Sefaz
// parece valer por IP do servidor, não só por CNPJ consultado (confirmado batendo em duas empresas
// diferentes em sequência e tomando o mesmo bloqueio), então uma rajada de muitas empresas seguidas
// arrisca travar todo mundo de uma vez. Pula empresa que já está sendo buscada manualmente agora, e
// pula quem buscou há menos de ~1h (evita insistir numa empresa que acabou de tomar "Consumo
// Indevido" — só volta a tentar depois que o prazo que a própria Sefaz pediu já passou).
const NFE_AUTO_INTERVALO_MS = 65 * 60 * 1000;
const NFE_AUTO_PAUSA_ENTRE_EMPRESAS_MS = 8000;
async function nfeExecutarBuscaAutomatica() {
  const configs = sqlite.prepare(`SELECT * FROM nfe_busca_config WHERE ativo = 1`).all() as any[];
  for (const cfg of configs) {
    if (nfeBuscasEmAndamento.has(cfg.empresa_id)) continue;
    if (!escritorioTemModulo(cfg.escritorio_id, "busca_xml_nfe")) continue;
    const ultimaBuscaMs = cfg.ultima_busca_em ? new Date(String(cfg.ultima_busca_em).replace(" ", "T") + "Z").getTime() : 0;
    if (ultimaBuscaMs && Date.now() - ultimaBuscaMs < 55 * 60 * 1000) continue;
    nfeBuscasEmAndamento.add(cfg.empresa_id);
    try {
      const cert = nfeCarregarCertificado(cfg);
      const r = await nfeENfseBuscarTudo(cfg.empresa_id, cfg, cert);
      if (r.novosNfe || r.novosNfse) {
        console.log(`[busca automática de XML] empresa ${cfg.empresa_id}: ${r.novosNfe} NF-e/NFC-e, ${r.novosNfse} NFS-e novos.`);
      }
    } catch (e: any) {
      console.error(`[busca automática de XML] empresa ${cfg.empresa_id} falhou:`, e.message);
    } finally {
      nfeBuscasEmAndamento.delete(cfg.empresa_id);
    }
    await new Promise((resolve) => setTimeout(resolve, NFE_AUTO_PAUSA_ENTRE_EMPRESAS_MS));
  }
}
setInterval(() => {
  nfeExecutarBuscaAutomatica().catch((e) => console.error("Erro na busca automática de XML:", e.message));
}, NFE_AUTO_INTERVALO_MS);
app.get("/api/nfe/documentos", blockCliente, requirePermissao("nfe-busca", "visualizar"), (req, res) => {
  const user = (req as any).user;
  const empresaId = req.query.empresaId ? Number(req.query.empresaId) : null;
  if (empresaId && !podeAcessarEmpresa(user, empresaId)) return res.status(404).json({ error: "Empresa não encontrada." });
  const empresasIds = empresaId ? [empresaId] : empresasVisiveis(user);
  if (empresasIds.length === 0) return res.json({ items: [] });
  const placeholders = empresasIds.map(() => "?").join(",");
  const tipo = typeof req.query.tipo === "string" && req.query.tipo ? req.query.tipo : null;
  const direcao = typeof req.query.direcao === "string" && ["emitida", "recebida"].includes(req.query.direcao) ? req.query.direcao : null;
  const busca = typeof req.query.busca === "string" ? req.query.busca.trim() : "";
  const dataDe = typeof req.query.dataDe === "string" && req.query.dataDe ? req.query.dataDe : null;
  const dataAte = typeof req.query.dataAte === "string" && req.query.dataAte ? req.query.dataAte : null;
  // "Emitida" = o CNPJ da própria empresa (dona do certificado) é o emitente do documento; senão é
  // "recebida" — cobre tanto NF-e de compra (destinatário é a empresa) quanto casos em que a
  // Distribuição DFe devolve o documento sem o destinatário preenchido (comum no schema resumido).
  const direcaoExpr = `(CASE WHEN d.emitente_cnpj = REPLACE(REPLACE(REPLACE(e.cnpj,'.',''),'/',''),'-','') THEN 'emitida' ELSE 'recebida' END)`;
  // A Distribuição DFe devolve muito evento de logística de transporte sem relevância contábil
  // nenhuma pro escritório (achado ao vivo: "Registro de Passagem", "MDF-e Autorizado" etc. — mais
  // de 3900 eventos capturados, nenhum era cancelamento de verdade) — só evento com "Cancelamento"
  // na descrição (xEvento) tem valor de ficar na listagem; o resto fica só escondido, sem apagar.
  const condicoes: string[] = [`d.escritorio_id = ?`, `d.empresa_id IN (${placeholders})`, `(d.tipo != 'evento' OR d.evento_descricao LIKE '%ancela%')`];
  const params: any[] = [user.escritorioId, ...empresasIds];
  if (tipo) {
    condicoes.push(`d.tipo = ?`);
    params.push(tipo);
  }
  if (direcao) {
    condicoes.push(`${direcaoExpr} = ?`);
    params.push(direcao);
  }
  if (dataDe) {
    condicoes.push(`substr(d.data_emissao,1,10) >= ?`);
    params.push(dataDe);
  }
  if (dataAte) {
    condicoes.push(`substr(d.data_emissao,1,10) <= ?`);
    params.push(dataAte);
  }
  if (busca) {
    const digits = busca.replace(/\D/g, "");
    const valorNorm = busca.replace(",", ".");
    condicoes.push(
      `(d.emitente_nome LIKE ? OR d.destinatario_nome LIKE ? OR d.chave_acesso LIKE ? OR d.emitente_cnpj LIKE ? OR d.destinatario_cnpj LIKE ? OR CAST(d.valor_total AS TEXT) LIKE ?)`
    );
    const likeTexto = `%${busca}%`;
    const likeDigits = `%${digits || busca}%`;
    params.push(likeTexto, likeTexto, likeTexto, likeDigits, likeDigits, `%${valorNorm}%`);
  }
  // "Cancelada de verdade" (pra riscar/destacar em vermelho na tela) é só o evento de cancelamento
  // da PRÓPRIA NF-e/NFC-e — exclui explicitamente "Cancelamento de CT-e"/"Cancelamento de MDF-e"
  // (ambos têm "Cancelamento" na descrição mas são sobre o transporte, não sobre a nota em si).
  const notaCanceladaExpr = `EXISTS (
    SELECT 1 FROM nfe_documentos ev
    WHERE ev.escritorio_id = d.escritorio_id AND ev.tipo = 'evento' AND ev.chave_acesso = d.chave_acesso
      AND ev.evento_descricao LIKE '%ancela%' AND ev.evento_descricao NOT LIKE '%CT-e%' AND ev.evento_descricao NOT LIKE '%MDF-e%'
  )`;
  const rows = sqlite
    .prepare(
      `SELECT d.id, d.empresa_id as empresaId, e.nome as empresaNome, d.tipo, d.chave_acesso as chaveAcesso,
              d.emitente_cnpj as emitenteCnpj, d.emitente_nome as emitenteNome, d.destinatario_cnpj as destinatarioCnpj,
              d.destinatario_nome as destinatarioNome, d.valor_total as valorTotal, d.data_emissao as dataEmissao, d.criado_em as criadoEm,
              ${direcaoExpr} as direcao, (CASE WHEN d.tipo = 'evento' THEN 0 ELSE ${notaCanceladaExpr} END) as notaCancelada
       FROM nfe_documentos d JOIN empresas e ON e.id = d.empresa_id
       WHERE ${condicoes.join(" AND ")}
       ORDER BY d.data_emissao DESC, d.id DESC LIMIT 500`
    )
    .all(...params) as any[];
  res.json({ items: rows.map((r) => ({ ...r, notaCancelada: !!r.notaCancelada })) });
});
// Contagem de verdade por empresa, sem o LIMIT 500 da listagem acima — a listagem só serve pra
// mostrar as últimas notas na tela de detalhe, não é confiável pra somar quantos documentos cada
// empresa tem (com volume grande, os 500 mais recentes do escritório inteiro ficam concentrados em
// poucas empresas e a soma por empresa fica errada pras outras).
app.get("/api/nfe/documentos/contagem", blockCliente, requirePermissao("nfe-busca", "visualizar"), (req, res) => {
  const user = (req as any).user;
  const empresasIds = empresasVisiveis(user);
  if (empresasIds.length === 0) return res.json({ items: [] });
  const placeholders = empresasIds.map(() => "?").join(",");
  const rows = sqlite
    .prepare(
      `SELECT empresa_id as empresaId, COUNT(*) as qtd
       FROM nfe_documentos
       WHERE escritorio_id = ? AND empresa_id IN (${placeholders})
       GROUP BY empresa_id`
    )
    .all(user.escritorioId, ...empresasIds);
  res.json({ items: rows });
});
app.get("/api/nfe/documentos/:id/xml", blockCliente, requirePermissao("nfe-busca", "visualizar"), (req, res) => {
  const user = (req as any).user;
  const row = sqlite.prepare(`SELECT * FROM nfe_documentos WHERE id = ?`).get(Number(req.params.id)) as any;
  if (!row || row.escritorio_id !== user.escritorioId || !podeAcessarEmpresa(user, row.empresa_id)) {
    return res.status(404).json({ error: "Documento não encontrado." });
  }
  res.setHeader("Content-Type", "application/xml; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${row.chave_acesso || row.nsu}.xml"`);
  res.send(row.xml);
});
function nfeDocNomeArquivo(row: any, extensao: string): string {
  const quem = row.emitente_nome || row.destinatario_nome || String(row.tipo).toUpperCase();
  const base = `${quem} - ${String(row.tipo).toUpperCase()} ${row.chave_acesso || row.nsu}`.replace(/[\\/:*?"<>|]/g, "").trim();
  return `${base}.${extensao}`;
}
// PDF de um documento buscado — NFS-e reaproveita o gerador de DANFSe já existente (local, a partir
// do XML, sem depender de nenhuma API do governo); NF-e/NFC-e usa uma representação simplificada
// própria (não é o DANFE oficial certificado — layout mais simples, mas com os mesmos dados do XML).
// Eventos não têm representação em PDF. Cache em disco (nfe_documentos.pdf_path) — só renderiza uma vez.
async function nfeDocumentoObterPdf(row: any): Promise<{ pdf: Buffer | null; erro: string | null }> {
  if (row.pdf_path && fs.existsSync(row.pdf_path)) return { pdf: fs.readFileSync(row.pdf_path), erro: null };
  if (row.tipo === "evento") return { pdf: null, erro: "Eventos não têm representação em PDF — baixe o XML." };
  if (row.tipo === "cte") return { pdf: null, erro: "Representação em PDF do CT-e (DACTE) ainda não implementada — baixe o XML." };
  try {
    const pdf = row.fonte === "nfse" ? await danfse.gerarDanfsePdf(row.xml) : await nfePdf.gerarPdfSimplificadoNfe(row.xml);
    const caminho = nfePdf.salvarPdfEmCache(row.chave_acesso || `doc-${row.id}`, pdf);
    sqlite.prepare(`UPDATE nfe_documentos SET pdf_path = ? WHERE id = ?`).run(caminho, row.id);
    return { pdf, erro: null };
  } catch (e: any) {
    return { pdf: null, erro: `Não consegui gerar o PDF: ${e.message}` };
  }
}
app.get("/api/nfe/documentos/:id/pdf", blockCliente, requirePermissao("nfe-busca", "visualizar"), async (req, res) => {
  const user = (req as any).user;
  const row = sqlite.prepare(`SELECT * FROM nfe_documentos WHERE id = ?`).get(Number(req.params.id)) as any;
  if (!row || row.escritorio_id !== user.escritorioId || !podeAcessarEmpresa(user, row.empresa_id)) {
    return res.status(404).json({ error: "Documento não encontrado." });
  }
  const { pdf, erro } = await nfeDocumentoObterPdf(row);
  if (!pdf) return res.status(502).json({ error: erro });
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", nfseContentDisposition("inline", nfeDocNomeArquivo(row, "pdf")));
  res.send(pdf);
});
// ---- Notas de Entrada (cliente vê só as notas recebidas da PRÓPRIA empresa, somente leitura) ----
// Aba opcional (ver PAGINAS_CLIENTE_VALIDAS/cliente_paginas_visiveis) — o admin decide, por usuário
// cliente, se ela aparece no menu dele. Sem "Buscar agora"/certificado aqui — é só consulta do que
// a busca automática do escritório (módulo busca_xml_nfe) já capturou.
app.get("/api/nfe/minha-empresa/documentos", requireCliente, (req, res) => {
  const user = (req as any).user;
  if (!user.empresaId) return res.json({ items: [], moduloAtivo: false });
  const moduloAtivo = escritorioTemModulo(user.escritorioId, "busca_xml_nfe");
  if (!moduloAtivo) return res.json({ items: [], moduloAtivo: false });
  const busca = typeof req.query.busca === "string" ? req.query.busca.trim() : "";
  const dataDe = typeof req.query.dataDe === "string" && req.query.dataDe ? req.query.dataDe : null;
  const dataAte = typeof req.query.dataAte === "string" && req.query.dataAte ? req.query.dataAte : null;
  // Mesmo critério de "emitida"/"recebida" de /api/nfe/documentos, mas aqui só interessa "recebida"
  // (a empresa é a destinatária) — é pra isso que este acesso do cliente foi pensado.
  const direcaoExpr = `(CASE WHEN d.emitente_cnpj = REPLACE(REPLACE(REPLACE(e.cnpj,'.',''),'/',''),'-','') THEN 'emitida' ELSE 'recebida' END)`;
  const condicoes: string[] = [
    `d.escritorio_id = ?`,
    `d.empresa_id = ?`,
    `(d.tipo != 'evento' OR d.evento_descricao LIKE '%ancela%')`,
    `${direcaoExpr} = 'recebida'`,
  ];
  const params: any[] = [user.escritorioId, user.empresaId];
  if (dataDe) {
    condicoes.push(`substr(d.data_emissao,1,10) >= ?`);
    params.push(dataDe);
  }
  if (dataAte) {
    condicoes.push(`substr(d.data_emissao,1,10) <= ?`);
    params.push(dataAte);
  }
  if (busca) {
    const digits = busca.replace(/\D/g, "");
    const valorNorm = busca.replace(",", ".");
    condicoes.push(`(d.emitente_nome LIKE ? OR d.chave_acesso LIKE ? OR d.emitente_cnpj LIKE ? OR CAST(d.valor_total AS TEXT) LIKE ?)`);
    const likeTexto = `%${busca}%`;
    const likeDigits = `%${digits || busca}%`;
    params.push(likeTexto, likeTexto, likeDigits, `%${valorNorm}%`);
  }
  const notaCanceladaExpr = `EXISTS (
    SELECT 1 FROM nfe_documentos ev
    WHERE ev.escritorio_id = d.escritorio_id AND ev.tipo = 'evento' AND ev.chave_acesso = d.chave_acesso
      AND ev.evento_descricao LIKE '%ancela%' AND ev.evento_descricao NOT LIKE '%CT-e%' AND ev.evento_descricao NOT LIKE '%MDF-e%'
  )`;
  const rows = sqlite
    .prepare(
      `SELECT d.id, d.tipo, d.chave_acesso as chaveAcesso, d.emitente_cnpj as emitenteCnpj, d.emitente_nome as emitenteNome,
              d.valor_total as valorTotal, d.data_emissao as dataEmissao,
              (CASE WHEN d.tipo = 'evento' THEN 0 ELSE ${notaCanceladaExpr} END) as notaCancelada
       FROM nfe_documentos d JOIN empresas e ON e.id = d.empresa_id
       WHERE ${condicoes.join(" AND ")}
       ORDER BY d.data_emissao DESC, d.id DESC LIMIT 500`
    )
    .all(...params) as any[];
  res.json({ items: rows.map((r) => ({ ...r, notaCancelada: !!r.notaCancelada })), moduloAtivo: true });
});
app.get("/api/nfe/minha-empresa/documentos/:id/xml", requireCliente, (req, res) => {
  const user = (req as any).user;
  const row = sqlite.prepare(`SELECT * FROM nfe_documentos WHERE id = ?`).get(Number(req.params.id)) as any;
  if (!row || row.escritorio_id !== user.escritorioId || row.empresa_id !== user.empresaId) {
    return res.status(404).json({ error: "Documento não encontrado." });
  }
  res.setHeader("Content-Type", "application/xml; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${row.chave_acesso || row.nsu}.xml"`);
  res.send(row.xml);
});
app.get("/api/nfe/minha-empresa/documentos/:id/pdf", requireCliente, async (req, res) => {
  const user = (req as any).user;
  const row = sqlite.prepare(`SELECT * FROM nfe_documentos WHERE id = ?`).get(Number(req.params.id)) as any;
  if (!row || row.escritorio_id !== user.escritorioId || row.empresa_id !== user.empresaId) {
    return res.status(404).json({ error: "Documento não encontrado." });
  }
  const { pdf, erro } = await nfeDocumentoObterPdf(row);
  if (!pdf) return res.status(502).json({ error: erro });
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", nfseContentDisposition("inline", nfeDocNomeArquivo(row, "pdf")));
  res.send(pdf);
});
// Download em lote — zip com XML e/ou PDF de vários documentos buscados de uma vez (mesmo padrão de
// /api/nfse/emissoes/baixar-lote).
app.get("/api/nfe/documentos/baixar-lote", blockCliente, requirePermissao("nfe-busca", "visualizar"), async (req, res) => {
  const user = (req as any).user;
  const ids = String(req.query.ids || "")
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);
  if (!ids.length) return res.status(400).json({ error: "Selecione ao menos um documento." });
  const formato = req.query.formato === "pdf" ? "pdf" : req.query.formato === "ambos" ? "ambos" : "xml";
  const placeholders = ids.map(() => "?").join(",");
  const rows = sqlite.prepare(`SELECT * FROM nfe_documentos WHERE id IN (${placeholders})`).all(...ids) as any[];
  const permitidas = rows.filter((r) => r.escritorio_id === user.escritorioId && podeAcessarEmpresa(user, r.empresa_id));
  if (!permitidas.length) return res.status(403).json({ error: "Sem acesso aos documentos selecionados." });

  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", `attachment; filename="documentos-fiscais-${new Date().toISOString().slice(0, 10)}.zip"`);
  const zip = archiver("zip", { zlib: { level: 9 } });
  zip.on("error", (e) => { if (!res.headersSent) res.status(500); res.end(); console.error("Erro ao gerar zip de documentos fiscais:", e); });
  zip.pipe(res);
  const usados = new Set<string>();
  const nomeUnico = (nome: string) => {
    let final = nome, i = 2;
    while (usados.has(final)) final = nome.replace(/(\.[^.]+)$/, ` (${i++})$1`);
    usados.add(final);
    return final;
  };
  for (const row of permitidas) {
    if (formato === "xml" || formato === "ambos") zip.append(row.xml, { name: nomeUnico(nfeDocNomeArquivo(row, "xml")) });
    if ((formato === "pdf" || formato === "ambos") && row.tipo !== "evento" && row.tipo !== "cte") {
      try {
        const { pdf } = await nfeDocumentoObterPdf(row);
        if (pdf) zip.append(pdf, { name: nomeUnico(nfeDocNomeArquivo(row, "pdf")) });
      } catch {
        // PDF de um documento específico falhou — segue pros outros, não aborta o lote inteiro.
      }
    }
  }
  await zip.finalize();
});

// ---------- Exportação de XML pro OneDrive (direto da nuvem, sem agente local) ----------
function getOnedriveConfig(escritorioId: number): any {
  return sqlite.prepare(`SELECT * FROM onedrive_config WHERE escritorio_id = ?`).get(escritorioId) || {};
}
app.get("/api/onedrive/config", blockCliente, requirePermissao("configuracoes", "visualizar"), (req, res) => {
  const c = getOnedriveConfig((req as any).user.escritorioId);
  res.json({
    clientId: c.client_id || "",
    temClientSecret: !!c.client_secret_cifrado,
    conectado: !!c.refresh_token_cifrado,
    contaNome: c.conta_nome || null,
    contaEmail: c.conta_email || null,
    pastaDestino: c.pasta_destino || "Notas Fiscais - Clientes",
    ativo: !!c.ativo,
    ultimaExportacaoEm: c.ultima_exportacao_em || null,
    ultimoErro: c.ultimo_erro || null,
    relatoriosPastaOrigem: c.relatorios_pasta_origem || "Relatorios_Dominio",
    relatoriosAtivo: !!c.relatorios_ativo,
    relatoriosUltimaImportacaoEm: c.relatorios_ultima_importacao_em || null,
    relatoriosUltimoErro: c.relatorios_ultimo_erro || null,
  });
});
app.put("/api/onedrive/config", blockCliente, requirePermissao("configuracoes", "editar"), (req, res) => {
  const escritorioId = (req as any).user.escritorioId;
  const b = req.body || {};
  const atual = getOnedriveConfig(escritorioId);
  sqlite
    .prepare(
      `INSERT INTO onedrive_config (escritorio_id, client_id, client_secret_cifrado, pasta_destino, ativo, relatorios_pasta_origem, relatorios_ativo, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(escritorio_id) DO UPDATE SET client_id=excluded.client_id, client_secret_cifrado=excluded.client_secret_cifrado,
         pasta_destino=excluded.pasta_destino, ativo=excluded.ativo,
         relatorios_pasta_origem=excluded.relatorios_pasta_origem, relatorios_ativo=excluded.relatorios_ativo, updated_at=datetime('now')`
    )
    .run(
      escritorioId,
      b.clientId || null,
      b.clientSecret ? nfse.cifrarTexto(String(b.clientSecret)) : atual.client_secret_cifrado || null,
      b.pastaDestino || "Notas Fiscais - Clientes",
      b.ativo ? 1 : 0,
      b.relatoriosPastaOrigem || atual.relatorios_pasta_origem || "Relatorios_Dominio",
      b.relatoriosAtivo ? 1 : 0
    );
  res.json({ ok: true });
});
app.post("/api/onedrive/desconectar", blockCliente, requirePermissao("configuracoes", "editar"), (req, res) => {
  sqlite
    .prepare(`UPDATE onedrive_config SET refresh_token_cifrado = NULL, conta_nome = NULL, conta_email = NULL WHERE escritorio_id = ?`)
    .run((req as any).user.escritorioId);
  res.json({ ok: true });
});
function onedriveRedirectUri(req: express.Request): string {
  return `${req.protocol}://${req.get("host")}/api/onedrive/callback`;
}
app.get("/api/onedrive/conectar", requirePermissao("configuracoes", "editar"), (req, res) => {
  const escritorioId = (req as any).user.escritorioId;
  const cfg = getOnedriveConfig(escritorioId);
  if (!cfg.client_id || !cfg.client_secret_cifrado) {
    return res.status(400).send("Configure o Client ID e o Client Secret antes de conectar (Configurações › Domínio Web).");
  }
  const state = crypto.randomBytes(16).toString("hex");
  sqlite.prepare(`UPDATE onedrive_config SET oauth_state_pendente = ? WHERE escritorio_id = ?`).run(state, escritorioId);
  res.redirect(onedrive.montarUrlAutorizacao(cfg.client_id, onedriveRedirectUri(req), state));
});
app.get("/api/onedrive/callback", requirePermissao("configuracoes", "editar"), async (req, res) => {
  const escritorioId = (req as any).user.escritorioId;
  const cfg = getOnedriveConfig(escritorioId);
  const { code, state, error, error_description } = req.query as any;
  if (error) return res.status(400).send(`Autorização recusada pela Microsoft: ${error_description || error}`);
  if (!code || !state || state !== cfg.oauth_state_pendente) return res.status(400).send("Autorização inválida ou expirada — tente conectar de novo.");
  try {
    const clientSecret = nfse.decifrarTexto(cfg.client_secret_cifrado);
    const token = await onedrive.trocarCodePorToken(cfg.client_id, clientSecret, code, onedriveRedirectUri(req));
    if (!token.refreshToken) throw new Error("A Microsoft não devolveu um refresh_token — confira se o escopo offline_access foi concedido.");
    // Só pra exibição ("conectado como fulano@...") — se falhar (ex.: escopo User.Read faltando em
    // contas já autorizadas antes dessa correção), não pode travar a conexão em si, que já está OK.
    let perfil: { nome: string | null; email: string | null } = { nome: null, email: null };
    try {
      perfil = await onedrive.obterPerfil(token.accessToken);
    } catch {
      /* segue sem nome/e-mail — a conexão já está válida pelo refresh_token */
    }
    sqlite
      .prepare(`UPDATE onedrive_config SET refresh_token_cifrado = ?, conta_nome = ?, conta_email = ?, oauth_state_pendente = NULL, ultimo_erro = NULL WHERE escritorio_id = ?`)
      .run(nfse.cifrarTexto(token.refreshToken), perfil.nome, perfil.email, escritorioId);
    res.send(`<html><body style="font-family:sans-serif; padding:40px; text-align:center;"><h2>OneDrive conectado!</h2><p>Conta: ${perfil.nome || perfil.email || ""}</p><p>Pode fechar esta aba e voltar pro Simples Contábeis.</p></body></html>`);
  } catch (e: any) {
    sqlite.prepare(`UPDATE onedrive_config SET oauth_state_pendente = NULL, ultimo_erro = ? WHERE escritorio_id = ?`).run(e.message, escritorioId);
    res.status(400).send(`Falha ao conectar com o OneDrive: ${e.message}`);
  }
});
// Sobe pro OneDrive os documentos buscados (nfe_documentos) ainda não exportados — cursor por id,
// mesmo princípio do cursor local do dominio-agent, só que rodando no próprio servidor (por isso não
// depende de nenhuma máquina/agente ligado). Renova o access_token a cada chamada (mais simples que
// cachear com controle de expiração, e o custo de um POST a mais é desprezível pra esse volume).
async function onedriveExportarDocumentosNovos(escritorioId: number): Promise<{ novos: number }> {
  const cfg = getOnedriveConfig(escritorioId);
  if (!cfg.ativo || !cfg.refresh_token_cifrado || !cfg.client_id || !cfg.client_secret_cifrado) return { novos: 0 };
  let novos = 0;
  try {
    const clientSecret = nfse.decifrarTexto(cfg.client_secret_cifrado);
    const refreshToken = nfse.decifrarTexto(cfg.refresh_token_cifrado);
    const token = await onedrive.renovarAccessToken(cfg.client_id, clientSecret, refreshToken);
    // A Microsoft pode devolver um refresh_token novo a cada renovação — o antigo deixa de valer,
    // então salva o novo já de cara (senão a próxima renovação falha com o token descartado).
    if (token.refreshToken) sqlite.prepare(`UPDATE onedrive_config SET refresh_token_cifrado = ? WHERE escritorio_id = ?`).run(nfse.cifrarTexto(token.refreshToken), escritorioId);
    let ultimoId = cfg.ultimo_id_exportado || 0;
    for (;;) {
      const rows = sqlite
        .prepare(
          `SELECT d.id, d.xml, d.chave_acesso as chaveAcesso, d.nsu, d.data_emissao as dataEmissao, e.nome as empresaNome, e.codigo_dominio as empresaCodigo, e.apelido as empresaApelido
           FROM nfe_documentos d JOIN empresas e ON e.id = d.empresa_id
           WHERE d.escritorio_id = ? AND d.id > ? ORDER BY d.id ASC LIMIT 200`
        )
        .all(escritorioId, ultimoId) as any[];
      if (!rows.length) break;
      for (const doc of rows) {
        const competencia = doc.dataEmissao ? String(doc.dataEmissao).slice(0, 7) : "sem-data";
        // Mesma convenção da pasta de importação do próprio Domínio ("125-AGR" — código do cliente
        // + apelido curto) — cai pro nome completo quando código ou apelido ainda não cadastrados.
        const pastaEmpresa = (
          doc.empresaCodigo && doc.empresaApelido ? `${doc.empresaCodigo}-${doc.empresaApelido}` : String(doc.empresaNome || "Sem empresa")
        ).replace(/[\\:*?"<>|]/g, "_");
        const nomeArquivo = String(doc.chaveAcesso || `doc-${doc.id}`).replace(/[\\:*?"<>|]/g, "_") + ".xml";
        const caminho = `${cfg.pasta_destino || "Notas Fiscais - Clientes"}/${pastaEmpresa}/${competencia}/${nomeArquivo}`;
        await onedrive.enviarArquivo(token.accessToken, caminho, Buffer.from(doc.xml, "utf8"));
        ultimoId = doc.id;
        novos++;
      }
      sqlite.prepare(`UPDATE onedrive_config SET ultimo_id_exportado = ?, ultima_exportacao_em = datetime('now'), ultimo_erro = NULL WHERE escritorio_id = ?`).run(ultimoId, escritorioId);
      if (rows.length < 200) break;
    }
  } catch (e: any) {
    sqlite.prepare(`UPDATE onedrive_config SET ultima_exportacao_em = datetime('now'), ultimo_erro = ? WHERE escritorio_id = ?`).run(e.message || String(e), escritorioId);
    throw e;
  }
  return { novos };
}
app.post("/api/onedrive/exportar-agora", blockCliente, requirePermissao("configuracoes", "postar"), async (req, res) => {
  try {
    const r = await onedriveExportarDocumentosNovos((req as any).user.escritorioId);
    res.json({ ok: true, novos: r.novos });
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});
// Confere a cada 5 minutos se algum escritório com exportação pro OneDrive ativa tem documento novo
// — roda no próprio servidor, então funciona mesmo sem nenhuma máquina/agente local ligada.
setInterval(() => {
  const configs = sqlite.prepare(`SELECT escritorio_id FROM onedrive_config WHERE ativo = 1 AND refresh_token_cifrado IS NOT NULL`).all() as any[];
  for (const c of configs) {
    onedriveExportarDocumentosNovos(c.escritorio_id).catch((e) => console.error("Erro na exportação automática pro OneDrive:", e.message));
  }
}, 5 * 60 * 1000);

// ---------- Importação de Balanço/DRE/Balancete de uma pasta do OneDrive ----------
// Direção CONTRÁRIA da exportação de XML acima: aqui o servidor LÊ periodicamente uma pasta do
// mesmo OneDrive já conectado (uma rotina externa do Domínio Web deposita os PDFs lá). Os PDFs viram
// envio_documentos DE VERDADE, sob 4 templates protegidos dedicados ("Balanço"/"Balancete"/
// "DRE Mensal"/"DRE Anual"), reaproveitando o mesmo mecanismo que o Integra Contador já usa pra
// anexar DAS/Situação Fiscal sozinho (integraContadorObterOuCriarAtribuicaoModelo +
// integraContadorAnexarPdfEmEnvio, acima). Isso já dá de graça: aparecer na grade normal de Envio de
// Documentos; "Solicitar Documentos" já funcionar (o template nasce visivel_cliente=1); e o
// atendimento automático de solicitação — POST /api/envio/solicitar já calcula "jaConcluido" olhando
// se o período já tem documento, sem filtrar por quem pediu, então importando ANTES de qualquer
// solicitação (esta rotina é proativa/agendada), o pedido do cliente já chega atendido sem nenhum
// código extra de "atendimento automático".
type DomRelTipo = "balanco" | "balancete" | "dre" | "faturamento" | "razao";
const DOM_REL_TEMPLATE_NOME: Record<string, string> = {
  balanco: "Balanço",
  balancete: "Balancete",
  dre_mensal: "DRE Mensal",
  dre_anual: "DRE Anual",
  faturamento: "Relação de Faturamento",
  razao: "Razão",
};
// Nomes dos templates alimentados pela importação automática do OneDrive — pra esses, "Solicitar
// Documentos" não deixa o cliente digitar qualquer mês/ano (não existe ninguém pra gerar sob
// demanda): só pode escolher entre os períodos que JÁ têm documento importado (ver
// GET /api/envio/periodos-disponiveis). Os outros templates (DAS, Situação Fiscal etc.) continuam
// deixando digitar livre, porque o escritório gera aquilo quando o cliente pede.
const TEMPLATES_RELATORIOS_DOMINIO = new Set(Object.values(DOM_REL_TEMPLATE_NOME));
// Acha os tipos que o texto do PDF menciona — pode achar mais de um (ex.: um PDF que já vem com
// Balanço + DRE juntos); nesse caso o pipeline anexa em CADA template que bateu.
function domRelClassificarTipos(texto: string): DomRelTipo[] {
  const tipos: DomRelTipo[] = [];
  if (/balan[çc]o\s+patrimonial/i.test(texto)) tipos.push("balanco");
  if (/balancete/i.test(texto)) tipos.push("balancete");
  if (/demonstra[çc][ãa]o\s+do\s+resultado|\bdre\b/i.test(texto)) tipos.push("dre");
  if (/relat[óo]rio\s+de\s+faturamento|rela[çc][ãa]o\s+de\s+faturamento/i.test(texto)) tipos.push("faturamento");
  // Negative lookahead exclui "Razão Social" (campo padrão de cabeçalho em praticamente todo
  // relatório do Domínio) — o Razão de verdade tem "RAZÃO" sozinho como título, seguido de
  // "Período:"/"C.N.P.J.:", nunca da palavra "social" logo depois.
  if (/raz[ãa]o(?!\s*social)/i.test(texto)) tipos.push("razao");
  return tipos;
}
// Achado ao vivo (dry-run contra a pasta real): o TEXTO do PDF varia de layout conforme a empresa —
// algumas trazem uma linha "Período: dd/mm/aaaa - dd/mm/aaaa" explícita, outras (a maioria, no teste
// real) só mostram "...EM dd/mm/aaaa" no título (só a data final, sem a inicial, sem a palavra
// "período" em lugar nenhum). O NOME do arquivo, por outro lado, já traz o período de forma 100%
// consistente em todos os arquivos testados: "TIPO_CODIGO_ddmmaaaa a ddmmaaaa.pdf". Por isso tenta o
// nome do arquivo PRIMEIRO (mais confiável aqui), e só cai pro texto se o nome não bater com o padrão
// esperado (ex.: alguém subiu um PDF renomeado na mão).
function domRelExtrairPeriodo(texto: string, nomeArquivo: string): { inicio: string; fim: string } | null {
  const doNome = /(\d{2})(\d{2})(\d{4})\s*a\s*(\d{2})(\d{2})(\d{4})/i.exec(nomeArquivo);
  if (doNome) {
    const [, d1, m1, a1, d2, m2, a2] = doNome;
    return { inicio: `${a1}-${m1}-${d1}`, fim: `${a2}-${m2}-${d2}` };
  }
  const regexPalavra = /per[ií]odo/gi;
  const regexData = /(\d{2})[\/\-.](\d{2})[\/\-.](\d{4})/g;
  const JANELA = 80;
  let m: RegExpExecArray | null;
  while ((m = regexPalavra.exec(texto))) {
    const inicioJanela = Math.max(0, m.index - JANELA);
    const fimJanela = m.index + m[0].length + JANELA;
    const trecho = texto.slice(inicioJanela, fimJanela);
    regexData.lastIndex = 0;
    const datas: string[] = [];
    let dm: RegExpExecArray | null;
    while ((dm = regexData.exec(trecho))) {
      const [, dia, mes, ano] = dm;
      const diaN = Number(dia), mesN = Number(mes), anoN = Number(ano);
      if (diaN >= 1 && diaN <= 31 && mesN >= 1 && mesN <= 12 && anoN >= 2000 && anoN <= 2100) {
        datas.push(`${ano}-${mes}-${dia}`);
      }
    }
    if (datas.length >= 2) {
      const ordenadas = datas.sort();
      return { inicio: ordenadas[0], fim: ordenadas[ordenadas.length - 1] };
    }
  }
  return null;
}
function domRelEhAnual(inicio: string, fim: string): boolean {
  const dias = (new Date(fim + "T00:00:00").getTime() - new Date(inicio + "T00:00:00").getTime()) / 86400000;
  return dias > 300; // período de ~1 ano inteiro (365/366 dias) — folga pra pequenas variações
}
// Mapa cnpj (só dígitos) → empresa, pra achar quem é o dono do relatório dentro do texto do PDF —
// mesma técnica já usada e comprovada em /api/empresas/anexos/licencas-bulk (ver acima, "fluxoDigitos
// sem \b"): PDF em layout de "caixinhas"/tabela (exatamente o formato de Balanço/DRE/Balancete)
// costuma colar os dígitos sem espaço depois do pdf-parse — um regex com \b não acha nada nesse caso.
// Inclui empresa_documentos (não só empresas.cnpj) pra cobrir empresa com mais de uma inscrição.
function domRelMapaDocumentos(escritorioId: number): Map<string, any> {
  const mapa = new Map<string, any>();
  const empresas = sqlite.prepare(`SELECT id, nome, cnpj FROM empresas WHERE escritorio_id = ?`).all(escritorioId) as any[];
  for (const e of empresas) {
    if (!e.cnpj) continue;
    const digitos = String(e.cnpj).replace(/\D/g, "");
    if (digitos.length === 14) mapa.set(digitos, e);
  }
  const docs = sqlite
    .prepare(`SELECT ed.documento, e.id, e.nome FROM empresa_documentos ed JOIN empresas e ON e.id = ed.empresa_id WHERE e.escritorio_id = ? AND ed.tipo = 'cnpj'`)
    .all(escritorioId) as any[];
  for (const d of docs) {
    if (!mapa.has(d.documento)) mapa.set(d.documento, { id: d.id, nome: d.nome });
  }
  return mapa;
}
function domRelIdentificarEmpresa(mapaDocumentos: Map<string, any>, texto: string, nomeArquivo: string): { empresa: any | null; cnpjDetectado: string | null; codigoArquivo: string | null } {
  const fluxoDigitos = texto.replace(/\D/g, "");
  let empresa: any = null;
  let cnpjDetectado: string | null = null;
  for (const [digitos, emp] of mapaDocumentos) {
    if (fluxoDigitos.includes(digitos)) {
      empresa = emp;
      cnpjDetectado = digitos;
      break;
    }
  }
  if (!cnpjDetectado) {
    const candidatos = [...texto.matchAll(REGEX_CNPJ_BUSCA)].map((m) => m[0].replace(/\D/g, ""));
    cnpjDetectado = candidatos.find((d) => d.length === 14) || null;
  }
  // Só pista de desempate pro admin resolver "não identificados" na mão — nunca confirma sozinha.
  // Padrão visto nos nomes de arquivo reais: "Balancete_125_01082026 a 31082026.pdf" → "125".
  const codigoArquivo = /_([0-9]+)_/.exec(nomeArquivo)?.[1] || null;
  return { empresa, cnpjDetectado, codigoArquivo };
}
function domRelSalvarPendente(escritorioId: number, buf: Buffer, nomeArquivo: string): string {
  const dir = path.join(UPLOADS_DIR, "dominio-relatorios-pendentes", String(escritorioId));
  fs.mkdirSync(dir, { recursive: true });
  const destino = path.join(dir, `${Date.now()}-${nomeArquivo.replace(/[\\/:*?"<>|]/g, "_")}`);
  fs.writeFileSync(destino, buf);
  return destino;
}
function domRelGravarControle(row: {
  escritorioId: number;
  itemId: string;
  nomeArquivo: string;
  tipoDetectado: string | null;
  periodoInicio: string | null;
  periodoFim: string | null;
  cnpjDetectado: string | null;
  codigoArquivo: string | null;
  empresaId: number | null;
  envioDocumentoId: number | null;
  status: string;
  erro: string | null;
  arquivoPendentePath: string | null;
  textoPreview: string | null;
  modificadoEm: string | null;
}): void {
  sqlite
    .prepare(
      `INSERT INTO dominio_relatorios_importados
         (escritorio_id, onedrive_item_id, nome_arquivo, tipo_detectado, periodo_inicio, periodo_fim, cnpj_detectado, codigo_dominio_arquivo, empresa_id, envio_documento_id, status, erro, arquivo_pendente_path, texto_preview, onedrive_modificado_em)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(escritorio_id, onedrive_item_id) DO UPDATE SET
         nome_arquivo=excluded.nome_arquivo, tipo_detectado=excluded.tipo_detectado, periodo_inicio=excluded.periodo_inicio,
         periodo_fim=excluded.periodo_fim, cnpj_detectado=excluded.cnpj_detectado, codigo_dominio_arquivo=excluded.codigo_dominio_arquivo,
         empresa_id=excluded.empresa_id, envio_documento_id=excluded.envio_documento_id, status=excluded.status, erro=excluded.erro,
         arquivo_pendente_path=excluded.arquivo_pendente_path, texto_preview=excluded.texto_preview, onedrive_modificado_em=excluded.onedrive_modificado_em,
         importado_em=datetime('now')`
    )
    .run(
      row.escritorioId,
      row.itemId,
      row.nomeArquivo,
      row.tipoDetectado,
      row.periodoInicio,
      row.periodoFim,
      row.cnpjDetectado,
      row.codigoArquivo,
      row.empresaId,
      row.envioDocumentoId,
      row.status,
      row.erro,
      row.arquivoPendentePath,
      row.textoPreview,
      row.modificadoEm
    );
}
async function dominioRelatoriosSincronizar(
  escritorioId: number,
  opts: { dryRun: boolean; limite?: number }
): Promise<{ processados: number; ok: number; pendentes: number; erros: number; previews?: any[] }> {
  const cfg = getOnedriveConfig(escritorioId);
  if (!cfg.client_id || !cfg.client_secret_cifrado || !cfg.refresh_token_cifrado) {
    throw new Error("Conecte o OneDrive antes (mesma conexão usada pra exportar XML, em Configurações › Domínio Web).");
  }
  const pasta = cfg.relatorios_pasta_origem || "Relatorios_Dominio";
  const clientSecret = nfse.decifrarTexto(cfg.client_secret_cifrado);
  const refreshToken = nfse.decifrarTexto(cfg.refresh_token_cifrado);
  const token = await onedrive.renovarAccessToken(cfg.client_id, clientSecret, refreshToken);
  if (token.refreshToken) sqlite.prepare(`UPDATE onedrive_config SET refresh_token_cifrado = ? WHERE escritorio_id = ?`).run(nfse.cifrarTexto(token.refreshToken), escritorioId);

  let itens = (await onedrive.listarArquivosPasta(token.accessToken, pasta)).filter((it) => !it.ehPasta && it.nome.toLowerCase().endsWith(".pdf"));
  if (opts.dryRun && opts.limite) itens = itens.slice(0, opts.limite);

  const mapaDocumentos = domRelMapaDocumentos(escritorioId);
  let ok = 0,
    pendentes = 0,
    erros = 0,
    processados = 0;
  const previews: any[] = [];

  for (const item of itens) {
    if (!opts.dryRun) {
      // Não reprocessa o que já deu certo OU já falhou com um motivo conhecido — só tenta de novo o
      // que deu erro técnico ('erro', ex.: falha de rede), nunca foi visto, OU o arquivo no OneDrive
      // foi modificado desde a última vez (mesmo onedrive_item_id — o Domínio Web sobrescreve o
      // arquivo em vez de criar um novo quando reexporta um relatório corrigido; achado ao vivo:
      // sem isso, uma versão corrigida do mesmo relatório nunca era pega, ficava pra sempre com a
      // primeira versão importada). Linha sem onedrive_modificado_em salvo ainda (de antes dessa
      // checagem existir) também reprocessa uma vez, só pra preencher a data — repescagem única e
      // barata (só download + leitura de PDF, sem API paga envolvida).
      const existente = sqlite.prepare(`SELECT status, onedrive_modificado_em FROM dominio_relatorios_importados WHERE escritorio_id = ? AND onedrive_item_id = ?`).get(escritorioId, item.id) as any;
      if (
        existente &&
        existente.status !== "erro" &&
        existente.onedrive_modificado_em &&
        item.modificadoEm &&
        item.modificadoEm <= existente.onedrive_modificado_em
      )
        continue;
    }
    processados++;
    try {
      const buf = await onedrive.baixarConteudoArquivo(token.accessToken, item.id);
      const texto = await obterTextoDoPdf(buf);
      const tipos = domRelClassificarTipos(texto);
      const periodo = domRelExtrairPeriodo(texto, item.nome);
      const { empresa, cnpjDetectado, codigoArquivo } = domRelIdentificarEmpresa(mapaDocumentos, texto, item.nome);

      if (opts.dryRun) {
        previews.push({
          nomeArquivo: item.nome,
          tiposDetectados: tipos,
          periodoInicio: periodo?.inicio || null,
          periodoFim: periodo?.fim || null,
          cnpjDetectado,
          codigoArquivoDominio: codigoArquivo,
          empresaEncontrada: empresa ? { id: empresa.id, nome: empresa.nome } : null,
          textoPreview: texto.slice(0, 2000),
        });
        continue;
      }

      const base = {
        escritorioId,
        itemId: item.id,
        nomeArquivo: item.nome,
        periodoInicio: periodo?.inicio || null,
        periodoFim: periodo?.fim || null,
        cnpjDetectado,
        codigoArquivo,
        textoPreview: texto.slice(0, 2000),
        modificadoEm: item.modificadoEm,
      };
      if (!periodo || !tipos.length || !empresa) {
        const status = !periodo || !tipos.length ? "tipo_nao_identificado" : cnpjDetectado ? "empresa_nao_encontrada" : "sem_cnpj";
        const erro = !periodo
          ? 'Não achei o período ("período: dd/mm/aaaa a dd/mm/aaaa") no texto do PDF.'
          : !tipos.length
            ? "Não identifiquei o tipo (Balanço/Balancete/DRE) no texto do PDF."
            : cnpjDetectado
              ? `CNPJ ${cnpjDetectado} não bate com nenhuma empresa cadastrada.`
              : "Não encontrei CNPJ no texto do PDF.";
        domRelGravarControle({
          ...base,
          tipoDetectado: tipos.join(",") || null,
          empresaId: empresa?.id || null,
          envioDocumentoId: null,
          status,
          erro,
          arquivoPendentePath: domRelSalvarPendente(escritorioId, buf, item.nome),
        });
        pendentes++;
        continue;
      }

      let primeiroDocId: number | null = null;
      const anual = domRelEhAnual(periodo.inicio, periodo.fim);
      for (const tipo of tipos) {
        const chaveTemplate = tipo === "dre" ? (anual ? "dre_anual" : "dre_mensal") : tipo;
        const nomeTemplate = DOM_REL_TEMPLATE_NOME[chaveTemplate];
        const periodicidade: "mensal" | "anual" = chaveTemplate === "balanco" || chaveTemplate === "dre_anual" ? "anual" : "mensal";
        const fimData = new Date(periodo.fim + "T00:00:00");
        const ano = fimData.getFullYear();
        const mes = periodicidade === "anual" ? null : fimData.getMonth() + 1;
        const atribuicaoId = integraContadorObterOuCriarAtribuicaoModelo(
          escritorioId,
          empresa.id,
          nomeTemplate,
          `${nomeTemplate} gerado pelo Domínio Web, importado automaticamente de uma pasta do OneDrive`,
          periodicidade,
          true
        );
        const observacao = `Importado automaticamente da pasta "${pasta}" do OneDrive em ${new Date().toLocaleDateString("pt-BR")}.`;
        const docId = integraContadorAnexarPdfEmEnvio(atribuicaoId, empresa.id, ano, mes, item.nome, buf.toString("base64"), observacao, null, true);
        if (primeiroDocId === null) primeiroDocId = docId;
      }
      domRelGravarControle({ ...base, tipoDetectado: tipos.join(","), empresaId: empresa.id, envioDocumentoId: primeiroDocId, status: "ok", erro: null, arquivoPendentePath: null });
      ok++;
    } catch (e: any) {
      erros++;
      if (!opts.dryRun) {
        domRelGravarControle({
          escritorioId,
          itemId: item.id,
          nomeArquivo: item.nome,
          tipoDetectado: null,
          periodoInicio: null,
          periodoFim: null,
          cnpjDetectado: null,
          codigoArquivo: null,
          empresaId: null,
          envioDocumentoId: null,
          status: "erro",
          erro: e.message || String(e),
          arquivoPendentePath: null,
          textoPreview: null,
          modificadoEm: item.modificadoEm,
        });
      }
    }
  }

  if (!opts.dryRun) {
    sqlite.prepare(`UPDATE onedrive_config SET relatorios_ultima_importacao_em = datetime('now'), relatorios_ultimo_erro = NULL WHERE escritorio_id = ?`).run(escritorioId);
  }
  return opts.dryRun ? { processados, ok, pendentes, erros, previews } : { processados, ok, pendentes, erros };
}
app.get("/api/onedrive/relatorios/pendentes", blockCliente, requirePermissao("configuracoes", "visualizar"), (req, res) => {
  const rows = sqlite
    .prepare(
      `SELECT id, nome_arquivo as nomeArquivo, tipo_detectado as tipoDetectado, periodo_inicio as periodoInicio, periodo_fim as periodoFim,
              cnpj_detectado as cnpjDetectado, codigo_dominio_arquivo as codigoDominioArquivo, status, erro, importado_em as importadoEm
       FROM dominio_relatorios_importados WHERE escritorio_id = ? AND status != 'ok' ORDER BY importado_em DESC`
    )
    .all((req as any).user.escritorioId);
  res.json({ items: rows });
});
// Roda a classificação sem gravar NADA (nem envio_documentos, nem a tabela de controle) — usada pra
// validar a leitura contra os PDFs reais da pasta antes de confiar no pipeline de verdade.
app.post("/api/onedrive/relatorios/dry-run", blockCliente, requirePermissao("configuracoes", "postar"), async (req, res) => {
  try {
    const r = await dominioRelatoriosSincronizar((req as any).user.escritorioId, { dryRun: true, limite: Number(req.body?.limite) || 10 });
    res.json(r);
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});
app.post("/api/onedrive/relatorios/importar-agora", blockCliente, requirePermissao("configuracoes", "postar"), async (req, res) => {
  try {
    const r = await dominioRelatoriosSincronizar((req as any).user.escritorioId, { dryRun: false });
    res.json(r);
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});
// Resolve um "não identificado" na mão — o admin escolhe a empresa/tipo/período certos, sem precisar
// baixar o arquivo de novo do OneDrive (já está salvo em arquivo_pendente_path).
app.post("/api/onedrive/relatorios/pendentes/:id/atribuir", blockCliente, requirePermissao("configuracoes", "editar"), (req, res) => {
  const escritorioId = (req as any).user.escritorioId;
  const row = sqlite.prepare(`SELECT * FROM dominio_relatorios_importados WHERE id = ? AND escritorio_id = ?`).get(Number(req.params.id), escritorioId) as any;
  if (!row) return res.status(404).json({ error: "Registro não encontrado." });
  if (!row.arquivo_pendente_path || !fs.existsSync(row.arquivo_pendente_path)) {
    return res.status(400).json({ error: "O PDF original não está mais disponível — rode a importação de novo." });
  }
  const { empresaId, tipo, ano, mes } = req.body || {};
  const empresa = sqlite.prepare(`SELECT id, nome FROM empresas WHERE id = ? AND escritorio_id = ?`).get(Number(empresaId), escritorioId) as any;
  if (!empresa) return res.status(400).json({ error: "Selecione uma empresa válida." });
  if (!DOM_REL_TEMPLATE_NOME[tipo]) return res.status(400).json({ error: "Tipo de relatório inválido." });
  if (!Number.isInteger(Number(ano))) return res.status(400).json({ error: "Informe o ano." });
  const periodicidade: "mensal" | "anual" = tipo === "balanco" || tipo === "dre_anual" ? "anual" : "mensal";
  const mesFinal = periodicidade === "anual" ? null : Number(mes) || null;
  if (periodicidade === "mensal" && !mesFinal) return res.status(400).json({ error: "Informe o mês." });
  const buf = fs.readFileSync(row.arquivo_pendente_path);
  const nomeTemplate = DOM_REL_TEMPLATE_NOME[tipo];
  const atribuicaoId = integraContadorObterOuCriarAtribuicaoModelo(
    escritorioId,
    empresa.id,
    nomeTemplate,
    `${nomeTemplate} gerado pelo Domínio Web, importado automaticamente de uma pasta do OneDrive`,
    periodicidade,
    true
  );
  const observacao = `Atribuído manualmente a partir de um relatório não identificado automaticamente (${row.nome_arquivo}).`;
  const docId = integraContadorAnexarPdfEmEnvio(atribuicaoId, empresa.id, Number(ano), mesFinal, row.nome_arquivo, buf.toString("base64"), observacao, null, true);
  sqlite.prepare(`UPDATE dominio_relatorios_importados SET status='ok', erro=NULL, empresa_id=?, tipo_detectado=?, envio_documento_id=?, arquivo_pendente_path=NULL WHERE id=?`).run(empresa.id, tipo, docId, row.id);
  try {
    fs.unlinkSync(row.arquivo_pendente_path);
  } catch {
    /* segue mesmo se não conseguir apagar o arquivo temporário */
  }
  res.json({ ok: true, docId });
});
// Confere a cada 5 minutos se algum escritório com importação de relatórios ativa tem PDF novo —
// setInterval SEPARADO do de exportação de XML acima (direção contrária: aqui é leitura).
setInterval(() => {
  const configs = sqlite.prepare(`SELECT escritorio_id FROM onedrive_config WHERE relatorios_ativo = 1 AND refresh_token_cifrado IS NOT NULL`).all() as any[];
  for (const c of configs) {
    dominioRelatoriosSincronizar(c.escritorio_id, { dryRun: false }).catch((e) => console.error("Erro na importação automática de relatórios do OneDrive:", e.message));
  }
}, 5 * 60 * 1000);

// ---------- Importar extratos bancários (e outros documentos financeiros) de uma caixa de e-mail
// (ex.: simplescontabeis@gmail.com, via IMAP + senha de app do Gmail) — o escritório recebe todo mês
// um e-mail por cliente tipo "FECHAMENTO MENSAL 08/2026 DA RAIZES AGRO" com vários anexos (extratos
// em PDF/OFX, um por banco, + outros arquivos financeiros do próprio cliente). Mesma estratégia já
// usada e comprovada na importação de relatórios do OneDrive: os anexos viram envio_documentos de
// verdade (integraContadorObterOuCriarAtribuicaoModelo + integraContadorAnexarPdfEmEnvio), com uma
// tabela de controle só pra auditoria/dedupe/pendências. ----------
function getEmailExtratosConfig(escritorioId: number): any {
  return sqlite.prepare(`SELECT * FROM email_extratos_config WHERE escritorio_id = ?`).get(escritorioId) || {};
}
function emailNormalizaTxt(s: string): string {
  return String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").trim();
}
// Tira sufixo de razão social (LTDA, ME, S/A etc.) antes de comparar — o assunto do e-mail
// ("...DA RAIZES AGRO") nunca traz o sufixo, só o nome "comercial".
function emailNomeEmpresaSemSufixo(nome: string): string {
  return emailNormalizaTxt(nome)
    .replace(/\b(ltda|me|epp|eireli|s\/?a|sa|mei)\b\.?/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
// Fallback quando o CNPJ não aparece no texto do anexo (ex.: anexo "outro", sem extração de
// conteúdo) — usa o nome da empresa mencionado no ASSUNTO do e-mail. Prioriza o nome mais longo que
// bater, pra não confundir uma empresa cujo nome é prefixo de outra (ex.: "Raízes Agro" vs "Raízes
// Agro Transportes"). Exige pelo menos 5 caracteres pra não deixar um nome curto demais (ex. "AB")
// gerar falso-positivo contra qualquer assunto. Achado ao vivo: matriz + filiais costumam ter o
// MESMO nome cadastrado (ex. 4 empresas "RAIZES AGRO LTDA", uma por CNPJ de filial) — nesse caso o
// nome sozinho nunca desempata quem é quem, então EMPATE entre empresas diferentes no mesmo tamanho
// de match devolve null (pendência pra resolver na mão) em vez de chutar uma delas.
function emailIdentificarEmpresaPorAssunto(escritorioId: number, assunto: string): any | null {
  const assuntoNorm = emailNormalizaTxt(assunto);
  if (!assuntoNorm) return null;
  const empresas = sqlite.prepare(`SELECT id, nome, apelido FROM empresas WHERE escritorio_id = ? AND ativo = 1`).all(escritorioId) as any[];
  let melhorTamanho = 0;
  let candidatas: any[] = [];
  for (const e of empresas) {
    for (const candidato of [e.nome, e.apelido]) {
      if (!candidato) continue;
      const semSufixo = emailNomeEmpresaSemSufixo(candidato);
      if (semSufixo.length < 5 || !assuntoNorm.includes(semSufixo)) continue;
      if (semSufixo.length > melhorTamanho) {
        melhorTamanho = semSufixo.length;
        candidatas = [e];
      } else if (semSufixo.length === melhorTamanho && !candidatas.some((c) => c.id === e.id)) {
        candidatas.push(e);
      }
    }
  }
  return candidatas.length === 1 ? candidatas[0] : null;
}
// Bancos comuns — checa primeiro o NOME DO ARQUIVO (mais confiável, mesma lição já aprendida com
// período do Balancete/DRE), só depois o texto do anexo.
const EMAIL_BANCOS_CONHECIDOS: [RegExp, string][] = [
  [/banco\s+do\s+brasil/i, "Banco do Brasil"],
  [/ita[úu]/i, "Itaú"],
  [/santander/i, "Santander"],
  [/bradesco/i, "Bradesco"],
  [/caixa\s+econ[ôo]mica|caixa\s+federal/i, "Caixa Econômica Federal"],
  [/sicoob/i, "Sicoob"],
  [/sicredi/i, "Sicredi"],
  [/banco\s+inter\b/i, "Banco Inter"],
  [/nubank|nu\s+pagamentos/i, "Nubank"],
  [/banrisul/i, "Banrisul"],
  [/\bsafra\b/i, "Safra"],
  [/btg/i, "BTG Pactual"],
];
function emailIdentificarBanco(nomeArquivo: string, texto: string): string | null {
  for (const [re, nome] of EMAIL_BANCOS_CONHECIDOS) if (re.test(nomeArquivo)) return nome;
  for (const [re, nome] of EMAIL_BANCOS_CONHECIDOS) if (re.test(texto)) return nome;
  return null; // ainda assim é extrato — cai no template genérico "Extrato Bancário"
}
// OFX é sempre extrato bancário, por definição do formato. PDF só conta como extrato se o próprio
// nome do arquivo disser isso — qualquer outro PDF (ou xlsx, doc etc.) vai pro balaio genérico.
function emailEhExtrato(nomeArquivo: string, ext: string): boolean {
  if (ext === "ofx") return true;
  return ext === "pdf" && /extrato/i.test(nomeArquivo);
}
// Itens fixos do checklist_templates "Outros Documentos Financeiros" — checklist_templates.itens
// precisa ser uma lista pequena e fixa (colunas da grade em Solicitações de Documentos), diferente
// de envio_documentos (sem conceito de item, qualquer nome de arquivo cabe solto no período). Achado
// ao vivo, com o e-mail real de teste: os "outros" documentos seguem só 2 padrões de nome (Fluxo de
// Caixa, Razão Financeira) — qualquer coisa fora disso cai no "Outros" genérico.
const CHECKLIST_OUTROS_ITENS = [
  { chave: "fluxo_caixa", label: "Fluxo de Caixa", accept: ["qualquer"], obrigatorio: false },
  { chave: "razao_financeira", label: "Razão Financeira", accept: ["qualquer"], obrigatorio: false },
  { chave: "outros", label: "Outros", accept: ["qualquer"], obrigatorio: false },
];
function emailClassificarItemOutro(nomeArquivo: string): { chave: string; label: string } {
  if (/fluxo\s*de\s*caixa/i.test(nomeArquivo)) return CHECKLIST_OUTROS_ITENS[0];
  if (/raz[ãa]o\s*financeir[ao]/i.test(nomeArquivo)) return CHECKLIST_OUTROS_ITENS[1];
  return CHECKLIST_OUTROS_ITENS[2];
}
// Extensões aceitas no balaio "Outros Documentos Financeiros" — formatos de documento/planilha
// comuns; ignora imagem/zip/executável etc., que não costuma ser um documento financeiro de verdade.
const EMAIL_EXTENSOES_OUTROS = new Set(["pdf", "xlsx", "xls", "csv", "doc", "docx"]);
function emailExtrairCompetencia(assunto: string, dataRecebimento: Date): { ano: number; mes: number } {
  const m = /(\d{2})\s*\/\s*(\d{4})/.exec(assunto || "");
  if (m) {
    const mes = Number(m[1]);
    const ano = Number(m[2]);
    if (mes >= 1 && mes <= 12 && ano >= 2000 && ano <= 2100) return { ano, mes };
  }
  return { ano: dataRecebimento.getFullYear(), mes: dataRecebimento.getMonth() + 1 };
}
// Achado ao vivo: um cliente manda, num e-mail só, um atrasado de vários meses ("...Itau-Março.pdf",
// "...Itau-Julho.pdf" etc.) — aplicar a competência do ASSUNTO (ex. "08/2026") pra todos esses
// anexos os arquiva todos errado, no mesmo mês. Por isso cada anexo tenta primeiro achar um NOME DE
// MÊS no próprio nome do arquivo antes de cair pro assunto/data de recebimento.
const MESES_PT_REGEX: [RegExp, number][] = [
  [/janeiro/i, 1],
  [/fevereiro/i, 2],
  [/mar[çc]o/i, 3],
  [/abril/i, 4],
  [/\bmaio\b/i, 5],
  [/junho/i, 6],
  [/julho/i, 7],
  [/agosto/i, 8],
  [/setembro/i, 9],
  [/outubro/i, 10],
  [/novembro/i, 11],
  [/dezembro/i, 12],
];
function emailExtrairMesPorNomeArquivo(nomeArquivo: string): number | null {
  for (const [re, mes] of MESES_PT_REGEX) if (re.test(nomeArquivo)) return mes;
  return null;
}
// Nome de arquivo nunca traz o ANO, só o mês — usa o ano da data de recebimento do e-mail, exceto
// quando o mês do arquivo é "no futuro" em relação a essa data (ex.: e-mail recebido em agosto/2026
// com um anexo "...Dezembro.pdf" só pode ser dezembro/2025, nunca um dezembro que ainda não chegou).
function emailCompetenciaDoAnexo(nomeArquivo: string, assunto: string, dataRecebimento: Date): { ano: number; mes: number } {
  const mesArquivo = emailExtrairMesPorNomeArquivo(nomeArquivo);
  if (mesArquivo) {
    const mesRecebimento = dataRecebimento.getMonth() + 1;
    const anoRecebimento = dataRecebimento.getFullYear();
    return { ano: mesArquivo > mesRecebimento ? anoRecebimento - 1 : anoRecebimento, mes: mesArquivo };
  }
  return emailExtrairCompetencia(assunto, dataRecebimento);
}
function emailSalvarPendente(escritorioId: number, buf: Buffer, nomeArquivo: string): string {
  const dir = path.join(UPLOADS_DIR, "email-extratos-pendentes", String(escritorioId));
  fs.mkdirSync(dir, { recursive: true });
  const destino = path.join(dir, `${Date.now()}-${nomeArquivo.replace(/[\\/:*?"<>|]/g, "_")}`);
  fs.writeFileSync(destino, buf);
  return destino;
}
function emailGravarControle(row: {
  escritorioId: number;
  messageId: string;
  emailAssunto: string | null;
  emailRemetente: string | null;
  emailRecebidoEm: string | null;
  nomeArquivo: string;
  tipoDetectado: string | null;
  bancoDetectado: string | null;
  cnpjDetectado: string | null;
  empresaId: number | null;
  checklistUploadId: number | null;
  status: string;
  erro: string | null;
  arquivoPendentePath: string | null;
}): void {
  sqlite
    .prepare(
      `INSERT INTO email_extratos_importados
         (escritorio_id, message_id, email_assunto, email_remetente, email_recebido_em, nome_arquivo, tipo_detectado, banco_detectado, cnpj_detectado, empresa_id, checklist_upload_id, status, erro, arquivo_pendente_path)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(escritorio_id, message_id, nome_arquivo) DO UPDATE SET
         email_assunto=excluded.email_assunto, email_remetente=excluded.email_remetente, email_recebido_em=excluded.email_recebido_em,
         tipo_detectado=excluded.tipo_detectado, banco_detectado=excluded.banco_detectado, cnpj_detectado=excluded.cnpj_detectado,
         empresa_id=excluded.empresa_id, checklist_upload_id=excluded.checklist_upload_id, status=excluded.status, erro=excluded.erro,
         arquivo_pendente_path=excluded.arquivo_pendente_path, importado_em=datetime('now')`
    )
    .run(
      row.escritorioId,
      row.messageId,
      row.emailAssunto,
      row.emailRemetente,
      row.emailRecebidoEm,
      row.nomeArquivo,
      row.tipoDetectado,
      row.bancoDetectado,
      row.cnpjDetectado,
      row.empresaId,
      row.checklistUploadId,
      row.status,
      row.erro,
      row.arquivoPendentePath
    );
}
async function emailExtratosSincronizar(
  escritorioId: number,
  opts: { dryRun: boolean; limite?: number }
): Promise<{ processados: number; ok: number; pendentes: number; erros: number; previews?: any[] }> {
  const cfg = getEmailExtratosConfig(escritorioId);
  if (!cfg.email || !cfg.senha_app_cifrada) {
    throw new Error('Configure o e-mail e a senha de app em Configurações › E-mail corporativo antes de importar.');
  }
  const senha = nfse.decifrarTexto(cfg.senha_app_cifrada);
  const client = new ImapFlow({ host: "imap.gmail.com", port: 993, secure: true, auth: { user: cfg.email, pass: senha }, logger: false });
  let processados = 0,
    ok = 0,
    pendentes = 0,
    erros = 0;
  const previews: any[] = [];
  const mapaDocumentos = domRelMapaDocumentos(escritorioId);
  try {
    await client.connect();
    const lock = await client.getMailboxLock("INBOX");
    try {
      const limiteMsgs = opts.limite || 30;
      const desde = Number(cfg.ultimo_uid_processado) || 0;
      // Primeira execução (cursor=0): não varre o histórico inteiro da caixa — começa só de hoje em
      // diante. Depois disso, sempre incremental por UID (que é sequencial dentro da caixa).
      const criterio: any = desde > 0 ? { uid: `${desde + 1}:*` } : { since: new Date() };
      const uids = ((await client.search(criterio, { uid: true })) || []) as number[];
      const uidsOrdenados = [...uids].sort((a, b) => a - b).slice(0, limiteMsgs);
      for (const uid of uidsOrdenados) {
        processados++;
        try {
          const msg = await client.fetchOne(String(uid), { source: true }, { uid: true });
          if (!msg || !msg.source) {
            if (!opts.dryRun) sqlite.prepare(`UPDATE email_extratos_config SET ultimo_uid_processado = ? WHERE escritorio_id = ?`).run(uid, escritorioId);
            continue;
          }
          const parsed = await simpleParser(msg.source);
          const assunto = parsed.subject || "";
          const remetente = parsed.from?.text || "";
          const dataRecebimento = parsed.date || new Date();
          const messageId = parsed.messageId || `uid-${escritorioId}-${uid}`;
          const empresaPorAssunto = emailIdentificarEmpresaPorAssunto(escritorioId, assunto);
          const anexos = (parsed.attachments || []).filter((a) => {
            if (!a.content || !a.filename || a.related) return false;
            const ext = (a.filename.split(".").pop() || "").toLowerCase();
            return ext === "ofx" || EMAIL_EXTENSOES_OUTROS.has(ext);
          });
          for (const anexo of anexos) {
            const nomeArquivo = anexo.filename as string;
            const ext = (nomeArquivo.split(".").pop() || "").toLowerCase();
            const buf = anexo.content as Buffer;
            const { ano, mes } = emailCompetenciaDoAnexo(nomeArquivo, assunto, dataRecebimento);
            const ehExtrato = emailEhExtrato(nomeArquivo, ext);
            let texto = "";
            if (ext === "pdf") texto = await obterTextoDoPdf(buf);
            else if (ext === "ofx") texto = buf.toString("utf8");
            const { empresa: empresaPorCnpj, cnpjDetectado } = domRelIdentificarEmpresa(mapaDocumentos, texto, nomeArquivo);
            const empresa = empresaPorCnpj || empresaPorAssunto;
            const banco = ehExtrato ? emailIdentificarBanco(nomeArquivo, texto) : null;
            if (opts.dryRun) {
              previews.push({
                emailAssunto: assunto,
                nomeArquivo,
                tipoDetectado: ehExtrato ? "extrato" : "outro",
                bancoDetectado: banco,
                cnpjDetectado,
                ano,
                mes,
                empresaEncontrada: empresa ? { id: empresa.id, nome: empresa.nome } : null,
              });
              continue;
            }
            const base = {
              escritorioId,
              messageId,
              emailAssunto: assunto,
              emailRemetente: remetente,
              emailRecebidoEm: dataRecebimento.toISOString(),
              nomeArquivo,
              tipoDetectado: ehExtrato ? "extrato" : "outro",
              bancoDetectado: banco,
              cnpjDetectado,
            };
            if (!empresa) {
              emailGravarControle({
                ...base,
                empresaId: null,
                checklistUploadId: null,
                status: "empresa_nao_encontrada",
                erro: "Não identifiquei a empresa (nem pelo CNPJ no anexo, nem pelo nome no assunto do e-mail).",
                arquivoPendentePath: emailSalvarPendente(escritorioId, buf, nomeArquivo),
              });
              pendentes++;
              continue;
            }
            const nomeTemplate = ehExtrato ? `Extrato ${banco || "Bancário"}` : "Outros Documentos Financeiros";
            const itens = ehExtrato ? [{ chave: "arquivo", label: nomeTemplate, accept: ["pdf", "ofx"], obrigatorio: false }] : CHECKLIST_OUTROS_ITENS;
            const atribuicaoId = checklistObterOuCriarAtribuicaoModelo(
              escritorioId,
              empresa.id,
              nomeTemplate,
              `${nomeTemplate} — importado automaticamente do e-mail.`,
              itens
            );
            const periodoId = checklistObterOuCriarPeriodo(atribuicaoId, ano, mes);
            const itemChave = ehExtrato ? "arquivo" : emailClassificarItemOutro(nomeArquivo).chave;
            const uploadId = checklistSalvarUpload(periodoId, empresa.id, itemChave, nomeArquivo, buf, anexo.contentType || null);
            emailGravarControle({ ...base, empresaId: empresa.id, checklistUploadId: uploadId, status: "ok", erro: null, arquivoPendentePath: null });
            ok++;
          }
          if (!opts.dryRun) {
            sqlite
              .prepare(`UPDATE email_extratos_config SET ultimo_uid_processado = ?, ultima_varredura_em = datetime('now'), ultimo_erro = NULL WHERE escritorio_id = ?`)
              .run(uid, escritorioId);
          }
        } catch (e: any) {
          erros++;
          console.error(`[E-mail Extratos] falha processando mensagem UID ${uid} (escritório ${escritorioId}):`, e.message);
          // Avança o cursor mesmo em erro — uma mensagem malformada travaria a fila pra sempre se
          // ficasse tentando de novo a cada ciclo.
          if (!opts.dryRun) sqlite.prepare(`UPDATE email_extratos_config SET ultimo_uid_processado = ? WHERE escritorio_id = ?`).run(uid, escritorioId);
        }
      }
    } finally {
      lock.release();
    }
  } catch (e: any) {
    if (!opts.dryRun) sqlite.prepare(`UPDATE email_extratos_config SET ultimo_erro = ?, ultima_varredura_em = datetime('now') WHERE escritorio_id = ?`).run(e.message, escritorioId);
    throw e;
  } finally {
    await client.logout().catch(() => {});
  }
  return { processados, ok, pendentes, erros, ...(opts.dryRun ? { previews } : {}) };
}
app.get("/api/email-extratos/config", blockCliente, requirePermissao("configuracoes", "visualizar"), (req, res) => {
  const cfg = getEmailExtratosConfig((req as any).user.escritorioId);
  res.json({
    email: cfg.email || "",
    temSenha: !!cfg.senha_app_cifrada,
    ativo: !!cfg.ativo,
    ultimaVarreduraEm: cfg.ultima_varredura_em || null,
    ultimoErro: cfg.ultimo_erro || null,
  });
});
app.put("/api/email-extratos/config", blockCliente, requirePermissao("configuracoes", "editar"), (req, res) => {
  const escritorioId = (req as any).user.escritorioId;
  const email = String(req.body?.email || "").trim();
  const senhaApp = String(req.body?.senhaApp || "").trim();
  const ativo = req.body?.ativo ? 1 : 0;
  if (!email) return res.status(400).json({ error: "Informe o e-mail." });
  const existente = getEmailExtratosConfig(escritorioId);
  const senhaCifrada = senhaApp ? nfse.cifrarTexto(senhaApp) : existente.senha_app_cifrada || null;
  sqlite
    .prepare(
      `INSERT INTO email_extratos_config (escritorio_id, email, senha_app_cifrada, ativo, updated_at) VALUES (?, ?, ?, ?, datetime('now'))
       ON CONFLICT(escritorio_id) DO UPDATE SET email=excluded.email, senha_app_cifrada=excluded.senha_app_cifrada, ativo=excluded.ativo, updated_at=datetime('now')`
    )
    .run(escritorioId, email, senhaCifrada, ativo);
  res.json({ ok: true });
});
app.post("/api/email-extratos/dry-run", blockCliente, requirePermissao("configuracoes", "postar"), async (req, res) => {
  try {
    const r = await emailExtratosSincronizar((req as any).user.escritorioId, { dryRun: true, limite: Number(req.body?.limite) || 10 });
    res.json(r);
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});
app.post("/api/email-extratos/importar-agora", blockCliente, requirePermissao("configuracoes", "postar"), async (req, res) => {
  try {
    const r = await emailExtratosSincronizar((req as any).user.escritorioId, { dryRun: false, limite: Number(req.body?.limite) || undefined });
    res.json(r);
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});
app.get("/api/email-extratos/pendentes", blockCliente, requirePermissao("configuracoes", "visualizar"), (req, res) => {
  const rows = sqlite
    .prepare(`SELECT * FROM email_extratos_importados WHERE escritorio_id = ? AND status != 'ok' ORDER BY id DESC`)
    .all((req as any).user.escritorioId) as any[];
  res.json({
    items: rows.map((r) => ({
      id: r.id,
      emailAssunto: r.email_assunto,
      emailRemetente: r.email_remetente,
      nomeArquivo: r.nome_arquivo,
      tipoDetectado: r.tipo_detectado,
      bancoDetectado: r.banco_detectado,
      cnpjDetectado: r.cnpj_detectado,
      erro: r.erro,
      importadoEm: r.importado_em,
    })),
  });
});
// Resolve um "não identificado" na mão — o admin escolhe a empresa (e o banco, se for extrato) certos,
// sem precisar baixar o anexo de novo do e-mail (já está salvo em arquivo_pendente_path).
app.post("/api/email-extratos/pendentes/:id/atribuir", blockCliente, requirePermissao("configuracoes", "editar"), (req, res) => {
  const escritorioId = (req as any).user.escritorioId;
  const row = sqlite.prepare(`SELECT * FROM email_extratos_importados WHERE id = ? AND escritorio_id = ?`).get(Number(req.params.id), escritorioId) as any;
  if (!row) return res.status(404).json({ error: "Registro não encontrado." });
  if (!row.arquivo_pendente_path || !fs.existsSync(row.arquivo_pendente_path)) {
    return res.status(400).json({ error: "O arquivo original não está mais disponível — rode a importação de novo." });
  }
  const { empresaId, tipo, banco, item, ano, mes } = req.body || {};
  const empresa = sqlite.prepare(`SELECT id, nome FROM empresas WHERE id = ? AND escritorio_id = ?`).get(Number(empresaId), escritorioId) as any;
  if (!empresa) return res.status(400).json({ error: "Selecione uma empresa válida." });
  if (!Number.isInteger(Number(ano)) || !Number.isInteger(Number(mes))) return res.status(400).json({ error: "Informe o mês e o ano." });
  const buf = fs.readFileSync(row.arquivo_pendente_path);
  const ehExtrato = tipo === "extrato";
  const nomeTemplate = ehExtrato ? `Extrato ${String(banco || "Bancário").trim() || "Bancário"}` : "Outros Documentos Financeiros";
  const itens = ehExtrato ? [{ chave: "arquivo", label: nomeTemplate, accept: ["pdf", "ofx"], obrigatorio: false }] : CHECKLIST_OUTROS_ITENS;
  const atribuicaoId = checklistObterOuCriarAtribuicaoModelo(
    escritorioId,
    empresa.id,
    nomeTemplate,
    `${nomeTemplate} — atribuído manualmente a partir de um anexo de e-mail não identificado automaticamente (${row.nome_arquivo}).`,
    itens
  );
  const periodoId = checklistObterOuCriarPeriodo(atribuicaoId, Number(ano), Number(mes));
  const itemChave = ehExtrato ? "arquivo" : CHECKLIST_OUTROS_ITENS.some((it) => it.chave === item) ? item : emailClassificarItemOutro(row.nome_arquivo).chave;
  const uploadId = checklistSalvarUpload(periodoId, empresa.id, itemChave, row.nome_arquivo, buf, null);
  sqlite
    .prepare(`UPDATE email_extratos_importados SET status='ok', erro=NULL, empresa_id=?, tipo_detectado=?, banco_detectado=?, checklist_upload_id=?, arquivo_pendente_path=NULL WHERE id=?`)
    .run(empresa.id, tipo, ehExtrato ? banco || null : null, uploadId, row.id);
  try {
    fs.unlinkSync(row.arquivo_pendente_path);
  } catch {
    /* segue mesmo se não conseguir apagar o arquivo temporário */
  }
  res.json({ ok: true, uploadId });
});
// Varredura automática de 15 em 15 minutos — só escritórios com a importação ligada e senha salva.
setInterval(() => {
  const configs = sqlite.prepare(`SELECT escritorio_id FROM email_extratos_config WHERE ativo = 1 AND senha_app_cifrada IS NOT NULL`).all() as any[];
  for (const c of configs) {
    emailExtratosSincronizar(c.escritorio_id, { dryRun: false }).catch((e) => console.error("Erro na importação automática de extratos por e-mail:", e.message));
  }
}, 15 * 60 * 1000);

// ---------- Integra Contador (Receita Federal + SERPRO) — DAS, Declaração, Situação Fiscal ----------
function getIntegraContadorConfig(escritorioId: number): any {
  return sqlite.prepare(`SELECT * FROM integracontador_config WHERE escritorio_id = ?`).get(escritorioId) || {};
}
// Cache de token em memória por escritório — evita reautenticar (mTLS + Basic auth) a cada chamada;
// o token dura ~30min, é desperdício pedir um novo pra cada operação de uma mesma sessão de busca.
const integraContadorTokens = new Map<number, integracontador.TokenIntegraContador>();
async function obterTokenIntegraContador(cfg: any): Promise<integracontador.TokenIntegraContador> {
  const existente = integraContadorTokens.get(cfg.escritorio_id);
  if (integracontador.tokenValido(existente || null)) return existente!;
  const pfxBuf = nfse.lerCertificadoCifradoDoDisco(cfg.arquivo_certificado_path);
  const senha = nfse.decifrarTexto(cfg.senha_certificado_cifrada);
  const cert = nfse.lerCertificadoPfx(pfxBuf, senha);
  const consumerSecret = nfse.decifrarTexto(cfg.consumer_secret_cifrado);
  const token = await integracontador.autenticar(cert, cfg.consumer_key, consumerSecret);
  integraContadorTokens.set(cfg.escritorio_id, token);
  return token;
}
app.get("/api/integracontador/config", blockCliente, requirePermissao("integracontador", "visualizar"), (req, res) => {
  const c = getIntegraContadorConfig((req as any).user.escritorioId);
  res.json({
    cnpj: c.cnpj || "",
    consumerKey: c.consumer_key || "",
    temConsumerSecret: !!c.consumer_secret_cifrado,
    temCertificado: !!c.arquivo_certificado_path,
    titularCertificado: c.titular_certificado || null,
    validadeCertificadoAte: c.validade_certificado_ate || null,
    ativo: !!c.ativo,
    ultimoErro: c.ultimo_erro || null,
  });
});
app.put("/api/integracontador/config", blockCliente, requirePermissao("integracontador", "editar"), upload.single("certificado"), (req, res) => {
  const escritorioId = (req as any).user.escritorioId;
  const b = req.body || {};
  const atual = getIntegraContadorConfig(escritorioId);
  let arquivoPath = atual.arquivo_certificado_path || null;
  let senhaCifrada = atual.senha_certificado_cifrada || null;
  let titular = atual.titular_certificado || null;
  let validadeIso = atual.validade_certificado_ate || null;
  if (req.file) {
    if (!b.senhaCertificado) return res.status(400).json({ error: "Informe a senha do certificado enviado." });
    let info: nfse.CertificadoInfo;
    try {
      info = nfse.lerCertificadoPfx(req.file.buffer, b.senhaCertificado);
    } catch (e: any) {
      return res.status(400).json({ error: e.message });
    }
    if (atual.arquivo_certificado_path) nfse.excluirCertificadoDoDisco(atual.arquivo_certificado_path);
    arquivoPath = nfse.salvarCertificadoCifrado(req.file.buffer, req.file.originalname);
    senhaCifrada = nfse.cifrarTexto(b.senhaCertificado);
    titular = info.titular;
    validadeIso = info.validadeAte ? info.validadeAte.toISOString() : null;
  }
  sqlite
    .prepare(
      `INSERT INTO integracontador_config (escritorio_id, cnpj, consumer_key, consumer_secret_cifrado, arquivo_certificado_path, senha_certificado_cifrada, titular_certificado, validade_certificado_ate, ativo, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(escritorio_id) DO UPDATE SET cnpj=excluded.cnpj, consumer_key=excluded.consumer_key, consumer_secret_cifrado=excluded.consumer_secret_cifrado,
         arquivo_certificado_path=excluded.arquivo_certificado_path, senha_certificado_cifrada=excluded.senha_certificado_cifrada,
         titular_certificado=excluded.titular_certificado, validade_certificado_ate=excluded.validade_certificado_ate,
         ativo=excluded.ativo, updated_at=datetime('now')`
    )
    .run(
      escritorioId,
      b.cnpj || atual.cnpj || null,
      b.consumerKey || atual.consumer_key || null,
      b.consumerSecret ? nfse.cifrarTexto(String(b.consumerSecret)) : atual.consumer_secret_cifrado || null,
      arquivoPath,
      senhaCifrada,
      titular,
      validadeIso,
      b.ativo === "true" || b.ativo === true ? 1 : atual.ativo ? 1 : 0
    );
  integraContadorTokens.delete(escritorioId); // credenciais podem ter mudado — descarta token em cache
  res.json({ ok: true });
});
app.post("/api/integracontador/config/testar", blockCliente, requirePermissao("integracontador", "postar"), async (req, res) => {
  const escritorioId = (req as any).user.escritorioId;
  const cfg = getIntegraContadorConfig(escritorioId);
  if (!cfg.consumer_key || !cfg.consumer_secret_cifrado || !cfg.arquivo_certificado_path) {
    return res.status(400).json({ error: "Preencha o Consumer Key/Secret e envie o certificado antes de testar." });
  }
  try {
    integraContadorTokens.delete(escritorioId);
    await obterTokenIntegraContador(cfg);
    sqlite.prepare(`UPDATE integracontador_config SET ultimo_erro = NULL WHERE escritorio_id = ?`).run(escritorioId);
    res.json({ ok: true });
  } catch (e: any) {
    sqlite.prepare(`UPDATE integracontador_config SET ultimo_erro = ? WHERE escritorio_id = ?`).run(e.message, escritorioId);
    res.status(400).json({ error: e.message });
  }
});
function getIntegraContadorEmpresaConfig(empresaId: number): any {
  return sqlite.prepare(`SELECT * FROM integracontador_empresa_config WHERE empresa_id = ?`).get(empresaId) || {};
}
app.get("/api/integracontador/empresas", blockCliente, requirePermissao("integracontador", "visualizar"), (req, res) => {
  const user = (req as any).user;
  const ids = empresasVisiveis(user);
  if (!ids.length) return res.json({ items: [] });
  const placeholders = ids.map(() => "?").join(",");
  const rows = sqlite
    .prepare(
      `SELECT e.id, e.nome, e.cnpj, c.ativo, c.optante_simples_nacional as optanteSimplesNacional, c.busca_dctfweb as buscaDctfweb, c.ultima_busca_em as ultimaBuscaEm, c.ultimo_erro as ultimoErro,
              c.alerta_declaracao as alertaDeclaracao,
              (SELECT COUNT(*) FROM integracontador_documentos d WHERE d.empresa_id = e.id) as qtdDocumentos,
              (SELECT COUNT(*) FROM integracontador_caixapostal_mensagens m WHERE m.empresa_id = e.id) as qtdCaixaPostal
       FROM empresas e LEFT JOIN integracontador_empresa_config c ON c.empresa_id = e.id
       WHERE e.id IN (${placeholders}) AND e.ativo = 1 ORDER BY e.nome`
    )
    .all(...ids);
  res.json({ items: rows });
});
app.get("/api/integracontador/empresas/:id/caixa-postal", blockCliente, requirePermissao("integracontador", "visualizar"), (req, res) => {
  const empresaId = Number(req.params.id);
  if (!podeAcessarEmpresa((req as any).user, empresaId)) return res.status(404).json({ error: "Empresa não encontrada." });
  const rows = sqlite
    .prepare(`SELECT assunto, data_envio as dataEnvio FROM integracontador_caixapostal_mensagens WHERE empresa_id = ? ORDER BY data_envio DESC`)
    .all(empresaId);
  res.json({ items: rows });
});
// Mesma ideia de integraContadorObterOuCriarAtribuicaoModelo (logo abaixo), mas gravando em
// checklist_* (Solicitações de Documentos — o que o CLIENTE manda PRO escritório) em vez de
// envio_* (o que o escritório manda PRO cliente). Usado pela importação de extratos por e-mail:
// um extrato/documento financeiro que chega do cliente por e-mail é conceitualmente um documento
// RECEBIDO, não um documento enviado — mesmo que o escritório é quem opera o anexo (o cliente não
// precisa fazer nada, o e-mail já chegou). Diferente de envio_templates, checklist_templates tem
// uma lista de "itens" fixa (colunas da grade) — por isso recebe "itens" pronto em vez de inferir
// um "accept" único.
function checklistObterOuCriarAtribuicaoModelo(
  escritorioId: number,
  empresaId: number,
  nomeTemplate: string,
  descricaoTemplate: string,
  itens: { chave: string; label: string; accept: string[]; obrigatorio: boolean }[],
  periodicidade: "mensal" | "anual" | "avulso" = "mensal"
): number {
  let template = sqlite.prepare(`SELECT id FROM checklist_templates WHERE escritorio_id = ? AND nome = ?`).get(escritorioId, nomeTemplate) as any;
  if (!template) {
    const info = sqlite
      .prepare(`INSERT INTO checklist_templates (nome, descricao, periodicidade, itens_json, notificar_email, escritorio_id) VALUES (?, ?, ?, ?, 0, ?)`)
      .run(nomeTemplate, descricaoTemplate, periodicidade, JSON.stringify(itens), escritorioId);
    template = { id: Number(info.lastInsertRowid) };
  }
  let atribuicao = sqlite.prepare(`SELECT id FROM checklist_atribuicoes WHERE template_id = ? AND empresa_id = ?`).get(template.id, empresaId) as any;
  if (!atribuicao) {
    const info = sqlite.prepare(`INSERT INTO checklist_atribuicoes (template_id, empresa_id, ativo) VALUES (?, ?, 1)`).run(template.id, empresaId);
    atribuicao = { id: Number(info.lastInsertRowid) };
  } else {
    sqlite.prepare(`UPDATE checklist_atribuicoes SET ativo = 1 WHERE id = ?`).run(atribuicao.id);
  }
  return atribuicao.id;
}
// "mes IS ?" (não "="), mesmo motivo já documentado em integraContadorAnexarPdfEmEnvio — em SQLite
// "coluna = NULL" nunca é verdadeiro, precisaria pra periodicidade 'anual'.
function checklistObterOuCriarPeriodo(atribuicaoId: number, ano: number, mes: number | null): number {
  let periodo = sqlite.prepare(`SELECT id FROM checklist_periodos WHERE atribuicao_id = ? AND ano = ? AND mes IS ?`).get(atribuicaoId, ano, mes) as any;
  if (!periodo) {
    const info = sqlite.prepare(`INSERT INTO checklist_periodos (atribuicao_id, ano, mes) VALUES (?, ?, ?)`).run(atribuicaoId, ano, mes);
    periodo = { id: Number(info.lastInsertRowid) };
  }
  return periodo.id;
}
// Só substitui um upload 'salvo' já existente nesse item se for o MESMO nome de arquivo (reenvio de
// verdade — igual substituirApenasMesmoNome do lado envio); nome diferente insere do lado, sem
// mexer no que já tinha, mesmo efeito do botão "Incluir outro documento" (ver slotInner/
// blocosUploads em app.html, que já rendeirza múltiplos uploads 'salvo' por item). uploaded_by fica
// NULL — não é um humano que enviou, é a importação automática.
function checklistSalvarUpload(periodoId: number, empresaId: number, itemChave: string, nomeArquivo: string, buf: Buffer, mime: string | null): number {
  const jaSalvo = sqlite
    .prepare(`SELECT * FROM checklist_uploads WHERE periodo_id = ? AND item_chave = ? AND status = 'salvo' AND file_name = ? ORDER BY id DESC LIMIT 1`)
    .get(periodoId, itemChave, nomeArquivo) as any;
  const versao = jaSalvo ? jaSalvo.versao + 1 : 1;
  const dir = empresaSlotDir(empresaId, periodoId);
  fs.mkdirSync(dir, { recursive: true });
  const nomeSeguro = `${itemChave}_v${versao}_${Date.now()}${path.extname(nomeArquivo)}`;
  const destino = path.join(dir, nomeSeguro);
  fs.writeFileSync(destino, buf);
  if (jaSalvo) sqlite.prepare(`UPDATE checklist_uploads SET status = 'substituido' WHERE id = ?`).run(jaSalvo.id);
  const info = sqlite
    .prepare(`INSERT INTO checklist_uploads (periodo_id, item_chave, versao, file_name, file_path, mime, size_bytes, status, uploaded_by) VALUES (?, ?, ?, ?, ?, ?, ?, 'salvo', NULL)`)
    .run(periodoId, itemChave, versao, nomeArquivo, destino, mime, buf.length);
  return Number(info.lastInsertRowid);
}
// Template "DAS - Mensal" (cria uma vez por escritório, reaproveita depois) e a atribuição pra
// empresa — assim toda empresa que tiver DAS habilitado no Integra Contador já ganha, sozinha, o
// mesmo mecanismo de Envio de Documentos que qualquer outro modelo usa, e o cliente já enxerga o
// DAS em "Meus Documentos" no login dele, sem o escritório precisar anexar nada na mão.
function integraContadorObterOuCriarAtribuicaoModelo(
  escritorioId: number,
  empresaId: number,
  nomeTemplate: string,
  descricaoTemplate: string,
  periodicidade: "mensal" | "anual" | "avulso" = "mensal",
  visivelCliente = true
): number {
  let template = sqlite.prepare(`SELECT id FROM envio_templates WHERE escritorio_id = ? AND nome = ?`).get(escritorioId, nomeTemplate) as any;
  if (!template) {
    // considera_mes_atual=0: todo modelo criado por aqui (DAS - Mensal, Situação Fiscal,
    // Parcelamento de DAS) só existe DEPOIS que o mês fecha (é resultado de uma declaração/consulta
    // que só faz sentido pro mês anterior já encerrado) — o mês corrente nunca pode estar "em
    // atraso" nesses modelos, diferente de Nota Fiscal (que pode ser emitida a qualquer momento do
    // mês corrente, aí sim considera_mes_atual=1 faz sentido).
    const info = sqlite
      .prepare(
        `INSERT INTO envio_templates (nome, descricao, periodicidade, accept_json, detectar_vencimento, visivel_cliente, escritorio_id, considera_mes_atual)
         VALUES (?, ?, ?, '["pdf"]', 0, ?, ?, 0)`
      )
      .run(nomeTemplate, descricaoTemplate, periodicidade, visivelCliente ? 1 : 0, escritorioId);
    template = { id: Number(info.lastInsertRowid) };
  }
  let atribuicao = sqlite.prepare(`SELECT id FROM envio_atribuicoes WHERE template_id = ? AND empresa_id = ?`).get(template.id, empresaId) as any;
  if (!atribuicao) {
    const info = sqlite.prepare(`INSERT INTO envio_atribuicoes (template_id, empresa_id, ativo) VALUES (?, ?, 1)`).run(template.id, empresaId);
    atribuicao = { id: Number(info.lastInsertRowid) };
  } else {
    sqlite.prepare(`UPDATE envio_atribuicoes SET ativo = 1 WHERE id = ?`).run(atribuicao.id);
  }
  return atribuicao.id;
}
function integraContadorFormatarVencimento(vencAAAAMMDD: string | null): string | null {
  if (!vencAAAAMMDD || vencAAAAMMDD.length !== 8) return null;
  return `${vencAAAAMMDD.slice(0, 4)}-${vencAAAAMMDD.slice(4, 6)}-${vencAAAAMMDD.slice(6, 8)}`;
}
// Cria o período (se ainda não existir) e insere o documento em Envio de Documentos — usado tanto
// pelo DAS/Situação Fiscal quanto pela importação de Balanço/DRE/Balancete do OneDrive. Por padrão
// cada chamada INSERE um documento novo, nunca substitui um já existente, pra manter o histórico
// completo (ex.: DAS original + cada recálculo). Com substituirExistente=true (usado só pela
// importação de relatórios do OneDrive, a pedido do usuário: um relatório reenviado pro mesmo
// período deve TROCAR o anterior, não empilhar os dois), qualquer documento já anexado nesse período
// é apagado (registro + arquivo em disco) antes de inserir o novo.
// Devolve o id do envio_documentos criado, pra quem quiser disparar o envio automático pro cliente.
function integraContadorAnexarPdfEmEnvio(
  atribuicaoId: number,
  empresaId: number,
  ano: number,
  mes: number | null,
  nomeArquivo: string,
  pdfBase64: string,
  observacao: string,
  vencimentoIso: string | null,
  substituirExistente = false,
  // Por padrão o substituirExistente apaga TODOS os documentos do período (1 arquivo por
  // template/período — correto pra Balanço/Balancete/DRE/Razão/Extrato por banco, sempre 1 arquivo
  // canônico por mês). Com true, só substitui um documento de MESMO nome de arquivo, preservando os
  // demais — necessário pro balaio genérico "Outros Documentos Financeiros" do e-mail, onde vários
  // arquivos DIFERENTES (Fluxo de Caixa, Razão Financeira de bancos distintos etc.) coexistem no
  // mesmo período (achado ao vivo: o 2º arquivo "outro" do mesmo e-mail estava apagando o 1º).
  substituirApenasMesmoNome = false
): number {
  // "mes IS ?" (não "mes = ?"): pra template ANUAL, mes vem null — em SQLite "coluna = NULL" nunca é
  // verdadeiro, então com "=" isso nunca acharia o período já existente e duplicaria envio_periodos a
  // cada chamada (achado ao vivo, antes de acontecer de verdade — nenhum chamador desta função tinha
  // usado mes=null até a importação de Balanço/DRE Anual). Mesmo padrão já usado em
  // POST /api/envio/solicitar ("mes IS ? AND rotulo IS ?").
  let periodo = sqlite.prepare(`SELECT id FROM envio_periodos WHERE atribuicao_id = ? AND ano = ? AND mes IS ?`).get(atribuicaoId, ano, mes) as any;
  if (!periodo) {
    const info = sqlite.prepare(`INSERT INTO envio_periodos (atribuicao_id, ano, mes) VALUES (?, ?, ?)`).run(atribuicaoId, ano, mes);
    periodo = { id: Number(info.lastInsertRowid) };
  } else if (substituirExistente) {
    const antigos = (
      substituirApenasMesmoNome
        ? sqlite.prepare(`SELECT id, file_path FROM envio_documentos WHERE periodo_id = ? AND file_name = ?`).all(periodo.id, nomeArquivo)
        : sqlite.prepare(`SELECT id, file_path FROM envio_documentos WHERE periodo_id = ?`).all(periodo.id)
    ) as any[];
    if (antigos.length) {
      const idsAntigos = antigos.map((d) => d.id);
      sqlite
        .prepare(`UPDATE dominio_relatorios_importados SET envio_documento_id = NULL WHERE envio_documento_id IN (${idsAntigos.map(() => "?").join(",")})`)
        .run(...idsAntigos);
      sqlite
        .prepare(`UPDATE email_extratos_importados SET envio_documento_id = NULL WHERE envio_documento_id IN (${idsAntigos.map(() => "?").join(",")})`)
        .run(...idsAntigos);
      sqlite
        .prepare(`DELETE FROM envio_documentos WHERE id IN (${idsAntigos.map(() => "?").join(",")})`)
        .run(...idsAntigos);
      for (const antigo of antigos) {
        try {
          fs.unlinkSync(antigo.file_path);
        } catch {
          /* segue mesmo se o arquivo antigo já não existir em disco */
        }
      }
    }
  }
  const dir = path.join(UPLOADS_DIR, "envio", String(empresaId), String(periodo.id));
  fs.mkdirSync(dir, { recursive: true });
  const destino = path.join(dir, `${Date.now()}-${nomeArquivo}`);
  const buf = Buffer.from(pdfBase64, "base64");
  fs.writeFileSync(destino, buf);
  const info = sqlite
    .prepare(
      `INSERT INTO envio_documentos (periodo_id, file_name, file_path, mime, size_bytes, observacao, vencimento, vencimento_origem) VALUES (?, ?, ?, 'application/pdf', ?, ?, ?, 'automatico')`
    )
    .run(periodo.id, nomeArquivo, destino, buf.length, observacao, vencimentoIso);
  return Number(info.lastInsertRowid);
}
// Envia pro cliente (e-mail + WhatsApp) um documento recém-anexado em Envio de Documentos, com o
// mesmo gating de módulo e os mesmos contatos que o botão manual usa. Best-effort: nunca lança —
// grava o resultado (ok/erro) na própria linha do envio_documentos, igual à rotina de NFS-e.
// Hoje só os documentos que a busca do Integra Contador anexa sozinha usam isto (DAS e guia de
// parcela do parcelamento); a Situação Fiscal fica de fora de propósito.
async function envioEnviarDocumentoAutomatico(opts: {
  escritorioId: number;
  empresaId: number;
  docId: number;
  fileName: string;
  pdf: Buffer;
  assunto: string;
  corpoEmail: string;
  descricaoWhatsapp: string;
}): Promise<void> {
  const { escritorioId, empresaId, docId, fileName, pdf, assunto, corpoEmail, descricaoWhatsapp } = opts;
  if (escritorioTemModulo(escritorioId, "envio_email_automatico")) {
    const contatos = sqlite.prepare(`SELECT email FROM empresa_contatos WHERE empresa_id = ? AND receber_emails = 1`).all(empresaId) as any[];
    if (contatos.length) {
      const lista = contatos.map((c) => c.email);
      try {
        await enviarEmail(escritorioId, { to: lista, subject: assunto, text: corpoEmail, attachments: [{ filename: fileName, content: pdf }] });
        sqlite.prepare(`UPDATE envio_documentos SET email_enviado = 1, email_enviado_em = datetime('now'), email_erro = NULL WHERE id = ?`).run(docId);
        sqlite
          .prepare(`INSERT INTO emails_enviados (empresa_id, destinatarios, assunto, corpo, anexos_json, status) VALUES (?, ?, ?, ?, ?, 'ok')`)
          .run(empresaId, lista.join(", "), assunto, corpoEmail, JSON.stringify([fileName]));
      } catch (e: any) {
        sqlite.prepare(`UPDATE envio_documentos SET email_enviado = 0, email_erro = ? WHERE id = ?`).run(e.message, docId);
        sqlite
          .prepare(`INSERT INTO emails_enviados (empresa_id, destinatarios, assunto, corpo, status, erro) VALUES (?, ?, ?, ?, 'erro', ?)`)
          .run(empresaId, lista.join(", "), assunto, corpoEmail, e.message);
      }
    }
  }
  if (escritorioTemModulo(escritorioId, "envio_whatsapp")) {
    const contatos = sqlite
      .prepare(`SELECT telefone FROM empresa_contatos WHERE empresa_id = ? AND receber_whatsapp = 1 AND telefone IS NOT NULL AND telefone != ''`)
      .all(empresaId) as any[];
    if (contatos.length) {
      const empresaNome = (sqlite.prepare(`SELECT nome FROM empresas WHERE id = ?`).get(empresaId) as any)?.nome || "";
      let algum = false;
      let ultimoErro = "";
      for (const c of contatos) {
        try {
          await whatsappEnviarArquivo(
            escritorioId,
            c.telefone,
            [
              { nome: "empresa_nome", valor: empresaNome },
              { nome: "descricao", valor: descricaoWhatsapp },
            ],
            { nome: fileName, tipo: "application/pdf", buffer: pdf },
            { tabela: "envio_documentos", id: docId }
          );
          algum = true;
        } catch (e: any) {
          ultimoErro = e.message;
        }
      }
      if (algum) sqlite.prepare(`UPDATE envio_documentos SET whatsapp_enviado = 1, whatsapp_enviado_em = datetime('now'), whatsapp_erro = NULL WHERE id = ?`).run(docId);
      else sqlite.prepare(`UPDATE envio_documentos SET whatsapp_erro = ? WHERE id = ?`).run(ultimoErro || "Falha desconhecida.", docId);
    }
  }
}
// forcarNovoDocumento: só vem true no fluxo de recálculo explicitamente solicitado (usuário clicou
// em "Solicitar recálculo do DAS") — nesse caso insere e envia incondicionalmente, preservando o
// histórico completo (DAS original + cada recálculo pedido, sem substituir nada). A busca automática
// (1x/dia) e o botão manual "Buscar" reprocessam a mesma competência todo dia até a próxima declarar
// — nesse caminho (forcarNovoDocumento=false), só anexa/envia na PRIMEIRA vez; dali em diante só
// confirma que já foi enviado e não reenvia sozinha (ver envioJaTemDocumento — regra definitiva,
// sem tentar detectar retificação automaticamente).
function integraContadorAnexarDasEmEnvio(
  escritorioId: number,
  empresaId: number,
  das: integracontador.DasEmitido,
  periodoApuracao: string,
  observacao: string,
  forcarNovoDocumento = false
): void {
  if (!das.pdfBase64) return;
  const atribuicaoId = integraContadorObterOuCriarAtribuicaoModelo(
    escritorioId,
    empresaId,
    "DAS - Mensal",
    "Guia de recolhimento do Simples Nacional (DAS), gerada automaticamente pelo Integra Contador"
  );
  const ano = Number(periodoApuracao.slice(0, 4));
  const mes = Number(periodoApuracao.slice(4, 6));
  const periodo = sqlite.prepare(`SELECT id FROM envio_periodos WHERE atribuicao_id = ? AND ano = ? AND mes = ?`).get(atribuicaoId, ano, mes) as any;
  if (!forcarNovoDocumento && periodo && envioJaTemDocumento(periodo.id)) return; // já enviado uma vez — só reenvia com "Solicitar recálculo"
  // "Recalculado" na mensagem só quando é de fato o recálculo manual pedido — nunca no primeiro envio
  // automático, que não é uma correção de nada.
  const retificado = forcarNovoDocumento;
  const nomeArquivo = `DAS ${MESES_PT_EXTENSO[mes - 1]} ${ano}${das.numeroDocumento ? " - " + das.numeroDocumento : ""}.pdf`;
  const vencIso = integraContadorFormatarVencimento(das.dataVencimento);
  const docId = integraContadorAnexarPdfEmEnvio(
    atribuicaoId, empresaId, ano, mes, nomeArquivo, das.pdfBase64,
    retificado ? `${observacao} DAS recalculado — substitui a guia anterior.` : observacao,
    vencIso
  );
  const rotulo = `${String(mes).padStart(2, "0")}/${ano}`;
  const vencTxt = vencIso ? `\n\nVencimento: ${vencIso.split("-").reverse().join("/")}` : "";
  void envioEnviarDocumentoAutomatico({
    escritorioId,
    empresaId,
    docId,
    fileName: nomeArquivo,
    pdf: Buffer.from(das.pdfBase64, "base64"),
    assunto: retificado ? `DAS recalculado — ${rotulo}` : `DAS — ${rotulo}`,
    corpoEmail: retificado
      ? `O DAS referente a ${rotulo} foi recalculado — segue em anexo a versão atualizada, que substitui a anterior.${vencTxt}`
      : `Segue em anexo a guia do DAS (Simples Nacional) referente a ${rotulo}.${vencTxt}`,
    descricaoWhatsapp: retificado ? `DAS recalculado — ${rotulo}` : `Guia do DAS — ${rotulo}`,
  }).catch((e) => console.error(`[Integra Contador] envio automático do DAS (empresa ${empresaId}) falhou:`, e.message));
}
// Regra definitiva (2026-09-22, pedido explícito do usuário depois de um incidente real em
// produção): a busca automática de DAS/DARF DCTF-Web/Guia FGTS manda o documento na PRIMEIRA vez que
// acha a competência, e a partir daí NUNCA reenvia sozinha — só confirma que já foi enviado e para.
// Um reenvio de verdade só acontece por pedido explícito ("Solicitar recálculo", forcarNovoDocumento
// = true), que não passa por esta checagem.
//
// Existiu aqui uma tentativa de detectar retificação de verdade comparando o conteúdo (hash do PDF,
// depois uma "chave estável" por campo) pra reenviar sozinho quando o valor realmente mudasse — as
// duas versões geraram falso positivo em produção: o hash pegava o "Número do Documento"/código de
// barras, que a Receita reemite a cada reimpressão mesmo sem retificação nenhuma; e a chave estável
// do DAS usava os valores (principal/multa/juros), que crescem sozinhos pra guia VENCIDA só pelo
// tempo passando — nenhum dos dois é retificação, e os dois mandavam guia de novo pro cliente à toa,
// no mesmo dia, mais de uma vez. Detectar retificação automaticamente exigiria um sinal que SÓ muda
// numa retificação de verdade e que a API do Integra Contador não expõe pronto — então a regra virou
// a de cima: sem detecção automática nenhuma, só o gatilho manual.
function envioJaTemDocumento(periodoId: number): boolean {
  return !!sqlite.prepare(`SELECT 1 FROM envio_documentos WHERE periodo_id = ? LIMIT 1`).get(periodoId);
}
// Achado o DARF (DCTFWeb/GERARGUIA31) uma vez e enviado ao cliente, a busca automática (1x/dia) segue
// gerando a guia de novo todo dia — mas só anexa/envia na primeira vez; dali em diante só confirma
// que já foi enviado (ver envioJaTemDocumento).
function integraContadorAnexarDarfDctfwebEmEnvio(
  escritorioId: number,
  empresaId: number,
  guia: integracontador.GuiaDctfWeb,
  observacao: string,
  forcarNovoDocumento = false
): void {
  if (!guia.pdfBase64) return;
  const atribuicaoId = integraContadorObterOuCriarAtribuicaoModelo(
    escritorioId,
    empresaId,
    "DARF - DCTF-Web",
    "Guia de arrecadação (DARF) gerada automaticamente a partir da declaração DCTFWeb já transmitida"
  );
  const ano = Number(guia.periodoApuracao.slice(0, 4));
  const mes = Number(guia.periodoApuracao.slice(4, 6));
  const periodo = sqlite.prepare(`SELECT id FROM envio_periodos WHERE atribuicao_id = ? AND ano = ? AND mes = ?`).get(atribuicaoId, ano, mes) as any;
  const jaTem = !!periodo && envioJaTemDocumento(periodo.id);
  if (!forcarNovoDocumento && jaTem) return; // já enviado uma vez — só reenvia com "Solicitar recálculo"
  const retificado = jaTem; // havia guia anterior sendo substituída (só possível via recálculo manual)
  const nomeArquivo = `DARF DCTF-Web ${MESES_PT_EXTENSO[mes - 1]} ${ano}.pdf`;
  // substituirExistente só quando é retificação de verdade: troca a guia errada pela corrigida, pra
  // o cliente nunca ver/pagar duas versões (diferente do "recálculo de DAS", que acumula histórico —
  // aqui a guia anterior à retificação deixa de valer).
  const docId = integraContadorAnexarPdfEmEnvio(
    atribuicaoId, empresaId, ano, mes, nomeArquivo, guia.pdfBase64,
    retificado ? `${observacao} DARF retificado — substitui a guia anterior.` : observacao,
    null, retificado
  );
  const rotulo = `${String(mes).padStart(2, "0")}/${ano}`;
  void envioEnviarDocumentoAutomatico({
    escritorioId,
    empresaId,
    docId,
    fileName: nomeArquivo,
    pdf: Buffer.from(guia.pdfBase64, "base64"),
    assunto: retificado ? `DARF DCTF-Web retificado — ${rotulo}` : `DARF DCTF-Web — ${rotulo}`,
    corpoEmail: retificado
      ? `A guia do DARF (DCTF-Web) referente a ${rotulo} foi retificada — segue em anexo a versão atualizada, que substitui a anterior.`
      : `Segue em anexo a guia do DARF (DCTF-Web) referente a ${rotulo}.`,
    descricaoWhatsapp: retificado ? `DARF DCTF-Web retificado — ${rotulo}` : `Guia do DARF DCTF-Web — ${rotulo}`,
  }).catch((e) => console.error(`[Integra Contador] envio automático do DARF DCTF-Web (empresa ${empresaId}) falhou:`, e.message));
}
// Mesmo mecanismo do DAS, mas pra Situação Fiscal — não tem "competência" de verdade (é uma foto do
// momento, não atrelada a um período de apuração), então usa o mês/ano de quando a consulta rodou
// como período na grade. Reaproveita a mesma pasta/documento a cada busca (semanal ou manual),
// então o cliente sempre vê a mais atual, com o histórico de meses anteriores preservado.
function integraContadorAnexarSitfisEmEnvio(escritorioId: number, empresaId: number, pdfBase64: string): void {
  const atribuicaoId = integraContadorObterOuCriarAtribuicaoModelo(
    escritorioId,
    empresaId,
    "Consultar Situação Fiscal - RFB",
    "Relatório de situação fiscal da empresa junto à Receita Federal, gerado automaticamente pelo Integra Contador"
  );
  const hoje = new Date();
  const ano = hoje.getFullYear();
  const mes = hoje.getMonth() + 1;
  const nomeArquivo = `Situação Fiscal - ${MESES_PT_EXTENSO[mes - 1]} ${ano}.pdf`;
  const observacao = `Relatório de Situação Fiscal — gerado automaticamente pela busca do Integra Contador em ${hoje.toLocaleDateString("pt-BR")}.`;
  integraContadorAnexarPdfEmEnvio(atribuicaoId, empresaId, ano, mes, nomeArquivo, pdfBase64, observacao, null);
}
// Mesma trava de duplicata do DAS normal — a rotina roda todo dia, e sem essa checagem reanexaria a
// mesma guia de parcela todo dia até o mês virar (o serviço de emissão do PARCSN não tem "recálculo"
// como o do DAS normal, então nunca precisa forçar um documento novo pro mesmo mês).
function integraContadorAnexarParcelaEmEnvio(atribuicaoId: number, empresaId: number, ano: number, mes: number, pdfBase64: string): boolean {
  const periodo = sqlite.prepare(`SELECT id FROM envio_periodos WHERE atribuicao_id = ? AND ano = ? AND mes = ?`).get(atribuicaoId, ano, mes) as any;
  if (periodo && sqlite.prepare(`SELECT 1 FROM envio_documentos WHERE periodo_id = ? LIMIT 1`).get(periodo.id)) return false;
  const nomeArquivo = `Parcelamento DAS - parcela ${MESES_PT_EXTENSO[mes - 1]} ${ano}.pdf`;
  const observacao = `Guia da parcela — gerada automaticamente pela busca do Integra Contador em ${new Date().toLocaleDateString("pt-BR")}.`;
  const docId = integraContadorAnexarPdfEmEnvio(atribuicaoId, empresaId, ano, mes, nomeArquivo, pdfBase64, observacao, null);
  const rotulo = `${String(mes).padStart(2, "0")}/${ano}`;
  const escritorioId = (sqlite.prepare(`SELECT escritorio_id FROM empresas WHERE id = ?`).get(empresaId) as any)?.escritorio_id;
  if (escritorioId) {
    void envioEnviarDocumentoAutomatico({
      escritorioId,
      empresaId,
      docId,
      fileName: nomeArquivo,
      pdf: Buffer.from(pdfBase64, "base64"),
      assunto: `Parcelamento do DAS — parcela ${rotulo}`,
      corpoEmail: `Segue em anexo a guia da parcela do parcelamento do DAS (Simples Nacional) referente a ${rotulo}.`,
      descricaoWhatsapp: `Guia do parcelamento do DAS — parcela ${rotulo}`,
    }).catch((e) => console.error(`[Integra Contador] envio automático da parcela (empresa ${empresaId}) falhou:`, e.message));
  }
  return true;
}
// Teto de tempo pra busca inteira — sem isso, uma chamada à Receita/SERPRO que trava (sem dar
// timeout HTTP limpo, ex.: handshake mTLS pendurado) deixa a trava "integraContadorBuscasEmAndamento"
// presa pra sempre (só um restart do processo destrava), já que o .finally() que libera a trava só
// roda quando a promise da busca finalmente resolve. Achado ao vivo: a busca da GO COLOR ficou
// travada de um dia pro outro e bloqueou toda tentativa nova até eu reiniciar manualmente.
// 5 minutos (não 3): o SITFIS tem dois polls de até 10 tentativas cada, de verdade assíncronos do
// lado da Receita — em dia ruim, esperar mais é melhor que cortar uma busca que ia dar certo.
const INTEGRACONTADOR_TIMEOUT_BUSCA_MS = 5 * 60 * 1000;
async function integraContadorBuscarEmpresa(empresaId: number, empresaCnpj: string, optante: boolean, buscaDctfweb: boolean): Promise<{ novos: number; erro: string | null }> {
  return Promise.race([
    integraContadorBuscarEmpresaInterno(empresaId, empresaCnpj, optante, buscaDctfweb),
    new Promise<{ novos: number; erro: string | null }>((resolve) =>
      setTimeout(() => {
        const msg = "A busca não respondeu em 5 minutos (Receita/SERPRO travado ou muito lento) — tente de novo mais tarde.";
        sqlite.prepare(`UPDATE integracontador_empresa_config SET ultima_busca_em = datetime('now'), ultimo_erro = ? WHERE empresa_id = ?`).run(msg, empresaId);
        resolve({ novos: 0, erro: msg });
      }, INTEGRACONTADOR_TIMEOUT_BUSCA_MS)
    ),
  ]);
}
async function integraContadorBuscarEmpresaInterno(
  empresaId: number,
  empresaCnpj: string,
  optante: boolean,
  buscaDctfweb: boolean,
  tentandoComTokenNovo = false
): Promise<{ novos: number; erro: string | null }> {
  const empConfig = getIntegraContadorEmpresaConfig(empresaId);
  const cfg = getIntegraContadorConfig(empConfig.escritorio_id);
  let novos = 0;
  const falhas: string[] = [];
  try {
    const token = await obterTokenIntegraContador(cfg);
    const cnpjEscritorio = cfg.cnpj;
    // Situação Fiscal — vale pra qualquer empresa, independente do regime tributário.
    try {
      const pdfBase64 = await integracontador.obterRelatorioSitfisCompleto(token, cnpjEscritorio, empresaCnpj);
      const caminho = salvarPdfBase64EmCache(`sitfis_${empresaId}_${Date.now()}`, pdfBase64);
      sqlite
        .prepare(`INSERT INTO integracontador_documentos (empresa_id, escritorio_id, tipo, pdf_path) VALUES (?, ?, 'situacao_fiscal', ?)`)
        .run(empresaId, empConfig.escritorio_id, caminho);
      integraContadorAnexarSitfisEmEnvio(empConfig.escritorio_id, empresaId, pdfBase64);
      novos++;
    } catch (e: any) {
      console.error(`[Integra Contador] situação fiscal da empresa ${empresaId} falhou:`, e.message);
      falhas.push(`Situação Fiscal: ${e.message}`);
    }
    // Caixa Postal do e-CAC (mensagens não lidas da Receita Federal) — vale pra qualquer empresa,
    // igual Situação Fiscal, sem opt-in. Apaga e recria o retrato inteiro a cada busca: reflete
    // sempre o estado atual de "não lida" segundo a Receita (não é um alerta que a gente "resolve"
    // aqui — uma vez lida de verdade no e-CAC, some sozinha na próxima busca).
    try {
      const mensagens = await integracontador.consultarMensagensCaixaPostalNaoLidas(token, cnpjEscritorio, empresaCnpj);
      sqlite.prepare(`DELETE FROM integracontador_caixapostal_mensagens WHERE empresa_id = ?`).run(empresaId);
      const inserirMsg = sqlite.prepare(
        `INSERT INTO integracontador_caixapostal_mensagens (empresa_id, numero_controle, assunto, data_envio, relevancia) VALUES (?, ?, ?, ?, ?)`
      );
      for (const m of mensagens) inserirMsg.run(empresaId, m.numeroControle, m.assunto, m.dataEnvio, m.relevancia);
    } catch (e: any) {
      console.error(`[Integra Contador] caixa postal da empresa ${empresaId} falhou:`, e.message);
      falhas.push(`Caixa Postal: ${e.message}`);
    }
    // DAS + Declaração — só pra quem é optante do Simples Nacional.
    // "alertaDeclaracao" fica undefined se a consulta de declarações falhar (não sabemos de verdade
    // se falta ou não, então não sobrescreve o alerta anterior) — só vira null/mensagem quando a
    // consulta realmente funcionou.
    let alertaDeclaracao: string | null | undefined;
    if (optante) {
      const anoAtual = new Date().getFullYear();
      let ultimoPeriodoDeclarado: string | null = null;
      try {
        const declaracoes = await integracontador.consultarDeclaracoesPorAno(token, cnpjEscritorio, empresaCnpj, String(anoAtual));
        const inserirDecl = sqlite.prepare(
          `INSERT INTO integracontador_documentos (empresa_id, escritorio_id, tipo, periodo_apuracao, numero_documento, detalhes_json) VALUES (?, ?, 'declaracao', ?, ?, ?)`
        );
        for (const d of declaracoes) {
          inserirDecl.run(empresaId, empConfig.escritorio_id, d.periodoApuracao, d.numeroDeclaracao, JSON.stringify(d));
          novos++;
          if (!ultimoPeriodoDeclarado || d.periodoApuracao > ultimoPeriodoDeclarado) ultimoPeriodoDeclarado = d.periodoApuracao;
        }
        // Monitoramento de atraso: a competência do mês anterior já devia estar declarada a essa
        // altura (PGDAS-D vence dia 20 do mês seguinte) — se não achou nada pra ela (nem período
        // mais recente que ela), acende o alerta pra você conferir se o cliente esqueceu de mandar.
        const hoje = new Date();
        const mesAnterior = new Date(hoje.getFullYear(), hoje.getMonth() - 1, 1);
        const competenciaEsperada = `${mesAnterior.getFullYear()}${String(mesAnterior.getMonth() + 1).padStart(2, "0")}`;
        if (!ultimoPeriodoDeclarado || ultimoPeriodoDeclarado < competenciaEsperada) {
          const rotulo = `${competenciaEsperada.slice(4, 6)}/${competenciaEsperada.slice(0, 4)}`;
          alertaDeclaracao = `Declaração/DAS de ${rotulo} ainda não localizada — verifique se foi transmitida.`;
        } else {
          alertaDeclaracao = null;
        }
      } catch (e: any) {
        console.error(`[Integra Contador] declarações da empresa ${empresaId} falharam:`, e.message);
        falhas.push(`Declaração: ${e.message}`);
      }
      // DAS — da competência mais recente que já tem declaração transmitida (o mês corrente ainda
      // não tem declaração pra gerar DAS a partir dela). Rodar de novo pro mesmo período recalcula
      // o DAS (útil se a declaração foi retificada depois da última busca).
      if (ultimoPeriodoDeclarado) {
        try {
          const das = await integracontador.gerarDas(token, cnpjEscritorio, empresaCnpj, ultimoPeriodoDeclarado);
          if (das.pdfBase64) {
            const caminho = salvarPdfBase64EmCache(`das_${empresaId}_${ultimoPeriodoDeclarado}_${Date.now()}`, das.pdfBase64);
            sqlite
              .prepare(
                `INSERT INTO integracontador_documentos (empresa_id, escritorio_id, tipo, periodo_apuracao, numero_documento, data_vencimento, pdf_path, detalhes_json) VALUES (?, ?, 'das', ?, ?, ?, ?, ?)`
              )
              .run(empresaId, empConfig.escritorio_id, das.periodoApuracao || ultimoPeriodoDeclarado, das.numeroDocumento, das.dataVencimento, caminho, JSON.stringify(das.valores || {}));
            integraContadorAnexarDasEmEnvio(
              empConfig.escritorio_id,
              empresaId,
              das,
              das.periodoApuracao || ultimoPeriodoDeclarado,
              "DAS original — gerado automaticamente pela busca do Integra Contador."
            );
            novos++;
          }
        } catch (e: any) {
          console.error(`[Integra Contador] DAS da empresa ${empresaId} falhou:`, e.message);
          falhas.push(`DAS: ${e.message}`);
        }
      }
    }
    // DARF da DCTFWeb — só pra quem foi marcado explicitamente (independente de optante do Simples,
    // ver checkbox "Precisa de DARF da DCTF-Web"). Sempre a competência do mês anterior (igual DAS
    // e o ajuste recente do Darf Pis/Cofins no card "envio_atraso" — não existe guia do mês corrente
    // antes dele fechar). Sem passo de "consultar declaração" antes de gerar (diferente do DAS
    // acima): se a declaração daquele período ainda não foi transmitida, a Receita só devolve erro,
    // tratado como falha não-fatal abaixo — mesmo comportamento de gerarDas quando não há nada pra
    // gerar ainda.
    if (buscaDctfweb) {
      const hoje = new Date();
      const mesAnterior = new Date(hoje.getFullYear(), hoje.getMonth() - 1, 1);
      const anoPA = String(mesAnterior.getFullYear());
      const mesPA = String(mesAnterior.getMonth() + 1).padStart(2, "0");
      try {
        const guia = await integracontador.gerarGuiaDctfWeb(token, cnpjEscritorio, empresaCnpj, anoPA, mesPA);
        if (guia.pdfBase64) {
          const caminho = salvarPdfBase64EmCache(`darf_dctfweb_${empresaId}_${anoPA}${mesPA}_${Date.now()}`, guia.pdfBase64);
          sqlite
            .prepare(`INSERT INTO integracontador_documentos (empresa_id, escritorio_id, tipo, periodo_apuracao, pdf_path) VALUES (?, ?, 'darf_dctfweb', ?, ?)`)
            .run(empresaId, empConfig.escritorio_id, guia.periodoApuracao, caminho);
          integraContadorAnexarDarfDctfwebEmEnvio(empConfig.escritorio_id, empresaId, guia, "DARF (DCTF-Web) — gerado automaticamente pela busca do Integra Contador.");
          novos++;
        }
      } catch (e: any) {
        console.error(`[Integra Contador] DARF DCTF-Web da empresa ${empresaId} falhou:`, e.message);
        falhas.push(`DARF DCTF-Web: ${e.message}`);
      }
    }
    // Parcelamento de DAS (PARCSN) — só entra aqui depois que o escritório já vinculou um
    // parcelamento concedido (ver POST /api/integracontador/parcelamentos); tenta emitir a guia da
    // parcela do mês corrente, igual já faz pro DAS normal. Uma empresa raramente tem mais de um
    // parcelamento ativo ao mesmo tempo, mas o loop cobre esse caso sem problema.
    const parcelamentosAtivos = sqlite
      .prepare(`SELECT id, numero_parcelamento as numero, atribuicao_id as atribuicaoId FROM integracontador_parcelamentos WHERE empresa_id = ? AND ativo = 1`)
      .all(empresaId) as any[];
    for (const parc of parcelamentosAtivos) {
      if (!parc.atribuicaoId) continue;
      try {
        const hoje = new Date();
        const anoMes = hoje.getFullYear() * 100 + (hoje.getMonth() + 1);
        const { pdfBase64, aviso } = await integracontador.emitirParcelaParcelamento(token, cnpjEscritorio, empresaCnpj, anoMes);
        if (pdfBase64) {
          const anexou = integraContadorAnexarParcelaEmEnvio(parc.atribuicaoId, empresaId, hoje.getFullYear(), hoje.getMonth() + 1, pdfBase64);
          if (anexou) novos++;
        }
        // "aviso" não é um erro técnico (ex.: "aguardando confirmação do pagamento da 1ª parcela") —
        // mesmo assim grava em ultimo_erro pra aparecer no painel, já que também é motivo de nada ter
        // sido anexado.
        sqlite.prepare(`UPDATE integracontador_parcelamentos SET ultima_busca_em = datetime('now'), ultimo_erro = ? WHERE id = ?`).run(aviso, parc.id);
      } catch (e: any) {
        console.error(`[Integra Contador] parcela do parcelamento ${parc.numero} (empresa ${empresaId}) falhou:`, e.message);
        sqlite.prepare(`UPDATE integracontador_parcelamentos SET ultima_busca_em = datetime('now'), ultimo_erro = ? WHERE id = ?`).run(e.message, parc.id);
      }
    }
    // Achado ao vivo: um token com validade "ainda dentro do prazo" localmente (ver tokenValido) às
    // vezes já não é mais aceito pelo SERPRO — cada chamada com ele responde 401 (convertido em
    // "TOKEN_EXPIRADO" por chamarServico). O comentário original de obterTokenIntegraContador já
    // previa que "quem chama deve reautenticar e tentar de novo uma vez", mas isso nunca tinha sido
    // implementado — a busca inteira falhava direto. Descarta o token em cache e tenta a busca
    // inteira de novo, uma única vez (tentandoComTokenNovo evita loop infinito se a reautenticação
    // também falhar).
    if (!tentandoComTokenNovo && falhas.some((f) => f.includes("TOKEN_EXPIRADO"))) {
      integraContadorTokens.delete(empConfig.escritorio_id);
      return integraContadorBuscarEmpresaInterno(empresaId, empresaCnpj, optante, buscaDctfweb, true);
    }
    const erroResumo = falhas.length ? falhas.join(" | ") : null;
    sqlite.prepare(`UPDATE integracontador_empresa_config SET ultima_busca_em = datetime('now'), ultimo_erro = ? WHERE empresa_id = ?`).run(erroResumo, empresaId);
    if (alertaDeclaracao !== undefined) {
      sqlite.prepare(`UPDATE integracontador_empresa_config SET alerta_declaracao = ? WHERE empresa_id = ?`).run(alertaDeclaracao, empresaId);
    }
    return { novos, erro: erroResumo };
  } catch (e: any) {
    sqlite.prepare(`UPDATE integracontador_empresa_config SET ultima_busca_em = datetime('now'), ultimo_erro = ? WHERE empresa_id = ?`).run(e.message, empresaId);
    return { novos, erro: e.message };
  }
}
function salvarPdfBase64EmCache(nome: string, base64: string): string {
  const destino = path.join(DATA_DIR, "integracontador-pdfs", `${nome.replace(/[^a-zA-Z0-9._-]/g, "_")}.pdf`);
  fs.mkdirSync(path.dirname(destino), { recursive: true });
  fs.writeFileSync(destino, Buffer.from(base64, "base64"));
  return destino;
}
// Trava por empresa — evita que a busca manual e a rotina automática semanal rodem ao mesmo tempo
// pra mesma empresa (cada chamada ao SERPRO é paga, não vale a pena arriscar duplicar).
const integraContadorBuscasEmAndamento = new Set<number>();
app.put("/api/integracontador/empresas/:id", blockCliente, requirePermissao("integracontador", "editar"), async (req, res) => {
  const user = (req as any).user;
  const empId = Number(req.params.id);
  if (!podeAcessarEmpresa(user, empId)) return res.status(404).json({ error: "Empresa não encontrada." });
  const empresa = sqlite.prepare(`SELECT cnpj FROM empresas WHERE id = ?`).get(empId) as any;
  const b = req.body || {};
  const atual = getIntegraContadorEmpresaConfig(empId);
  const ativando = !!b.ativo && !atual.ativo;
  sqlite
    .prepare(
      `INSERT INTO integracontador_empresa_config (empresa_id, escritorio_id, ativo, optante_simples_nacional, busca_dctfweb, updated_at)
       VALUES (?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(empresa_id) DO UPDATE SET ativo=excluded.ativo, optante_simples_nacional=excluded.optante_simples_nacional, busca_dctfweb=excluded.busca_dctfweb, updated_at=datetime('now')`
    )
    .run(empId, user.escritorioId, b.ativo ? 1 : 0, b.optanteSimplesNacional ? 1 : 0, b.buscaDctfweb ? 1 : 0);
  const cfg = getIntegraContadorConfig(user.escritorioId);
  let buscaIniciada = false;
  if (ativando && cfg.ativo && !integraContadorBuscasEmAndamento.has(empId)) {
    buscaIniciada = true;
    integraContadorBuscasEmAndamento.add(empId);
    // Não espera terminar — a Situação Fiscal sozinha já pode passar de 1 minuto (poll da própria
    // Receita), tempo suficiente pro proxy do Railway devolver 502 pro navegador mesmo com a busca
    // tendo dado certo do lado do servidor. Roda em segundo plano; a tela confere o resultado
    // reconsultando a lista (ultimaBuscaEm muda quando termina).
    integraContadorBuscarEmpresa(empId, empresa?.cnpj || "", !!b.optanteSimplesNacional, !!b.buscaDctfweb).finally(() => {
      integraContadorBuscasEmAndamento.delete(empId);
    });
  }
  res.json({ ok: true, buscaIniciada });
});
app.post("/api/integracontador/empresas/:id/buscar", blockCliente, requirePermissao("integracontador", "postar"), async (req, res) => {
  const user = (req as any).user;
  const empId = Number(req.params.id);
  if (!podeAcessarEmpresa(user, empId)) return res.status(404).json({ error: "Empresa não encontrada." });
  const cfg = getIntegraContadorConfig(user.escritorioId);
  if (!cfg.ativo) return res.status(400).json({ error: "Configure e ative o Integra Contador em Configurações antes de buscar." });
  const empConfig = getIntegraContadorEmpresaConfig(empId);
  if (!empConfig.ativo) return res.status(400).json({ error: "Habilite esta empresa antes de buscar." });
  if (integraContadorBuscasEmAndamento.has(empId)) return res.status(409).json({ error: "Já existe uma busca em andamento pra esta empresa." });
  integraContadorBuscasEmAndamento.add(empId);
  const empresa = sqlite.prepare(`SELECT cnpj FROM empresas WHERE id = ?`).get(empId) as any;
  // Mesma lógica do PUT acima: dispara e não espera, pra não bater no timeout do proxy numa busca
  // de Situação Fiscal que demora — o front confere o resultado consultando de novo em alguns segundos.
  integraContadorBuscarEmpresa(empId, empresa?.cnpj || "", !!empConfig.optante_simples_nacional, !!empConfig.busca_dctfweb).finally(() => {
    integraContadorBuscasEmAndamento.delete(empId);
  });
  res.json({ ok: true, buscaIniciada: true });
});
// ---- Parcelamento de DAS (PARCSN) — vincular um parcelamento JÁ CONCEDIDO (a adesão em si é feita
// pelo escritório no e-CAC, fora do sistema — a API não permite simular nem aderir, só consultar) ----
app.get("/api/integracontador/parcelamentos/pedidos", blockCliente, requirePermissao("integracontador", "postar"), async (req, res) => {
  const user = (req as any).user;
  const empId = Number(req.query.empresaId);
  if (!empId || !podeAcessarEmpresa(user, empId)) return res.status(404).json({ error: "Empresa não encontrada." });
  const cfg = getIntegraContadorConfig(user.escritorioId);
  if (!cfg.ativo) return res.status(400).json({ error: "Configure e ative o Integra Contador em Configurações antes de consultar." });
  const empresa = sqlite.prepare(`SELECT cnpj FROM empresas WHERE id = ?`).get(empId) as any;
  if (!empresa?.cnpj) return res.status(400).json({ error: "Empresa sem CNPJ cadastrado." });
  try {
    const token = await obterTokenIntegraContador(cfg);
    const pedidos = await integracontador.consultarPedidosParcelamento(token, cfg.cnpj, empresa.cnpj);
    res.json({ items: pedidos });
  } catch (e: any) {
    res.status(502).json({ error: e.message });
  }
});
app.post("/api/integracontador/parcelamentos", blockCliente, requirePermissao("integracontador", "postar"), async (req, res) => {
  const user = (req as any).user;
  const empId = Number(req.body?.empresaId);
  const numeroParcelamento = Number(req.body?.numeroParcelamento);
  const periodoSolicitacaoId = req.body?.periodoSolicitacaoId ? Number(req.body.periodoSolicitacaoId) : null;
  if (!empId || !podeAcessarEmpresa(user, empId)) return res.status(404).json({ error: "Empresa não encontrada." });
  if (!numeroParcelamento) return res.status(400).json({ error: "Informe o número do parcelamento." });
  const cfg = getIntegraContadorConfig(user.escritorioId);
  if (!cfg.ativo) return res.status(400).json({ error: "Configure e ative o Integra Contador em Configurações antes de vincular." });
  const empresa = sqlite.prepare(`SELECT cnpj FROM empresas WHERE id = ?`).get(empId) as any;
  if (!empresa?.cnpj) return res.status(400).json({ error: "Empresa sem CNPJ cadastrado." });
  try {
    const token = await obterTokenIntegraContador(cfg);
    const detalhe = await integracontador.consultarParcelamentoEspecifico(token, cfg.cnpj, empresa.cnpj, numeroParcelamento);
    const atribuicaoId = integraContadorObterOuCriarAtribuicaoModelo(
      user.escritorioId,
      empId,
      "Parcelamento de DAS",
      "Guias das parcelas do parcelamento do Simples Nacional, geradas automaticamente pelo Integra Contador"
    );
    sqlite
      .prepare(
        `INSERT INTO integracontador_parcelamentos
           (empresa_id, escritorio_id, numero_parcelamento, atribuicao_id, situacao, data_do_pedido, valor_total_consolidado, quantidade_parcelas, valor_primeira_parcela, valor_parcela_basica, detalhes_json, ativo, vinculado_por, vinculado_em, ultima_busca_em)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, datetime('now'), datetime('now'))
         ON CONFLICT(empresa_id, numero_parcelamento) DO UPDATE SET
           atribuicao_id = excluded.atribuicao_id, situacao = excluded.situacao, data_do_pedido = excluded.data_do_pedido,
           valor_total_consolidado = excluded.valor_total_consolidado, quantidade_parcelas = excluded.quantidade_parcelas,
           valor_primeira_parcela = excluded.valor_primeira_parcela, valor_parcela_basica = excluded.valor_parcela_basica,
           detalhes_json = excluded.detalhes_json, ativo = 1, vinculado_por = excluded.vinculado_por, vinculado_em = datetime('now'), ultima_busca_em = datetime('now')`
      )
      .run(
        empId,
        user.escritorioId,
        numeroParcelamento,
        atribuicaoId,
        detalhe.situacao,
        detalhe.dataDoPedido,
        detalhe.valorTotalConsolidado,
        detalhe.quantidadeParcelas,
        detalhe.valorPrimeiraParcela,
        detalhe.valorParcelaBasica,
        JSON.stringify(detalhe.detalhesJson || {}),
        user.id
      );
    // "Gerar a parcela de entrada" — tenta emitir a guia do mês corrente na hora, pra já deixar
    // disponível pro cliente assim que vincula (a rotina automática cuida dos meses seguintes).
    // Achado ao vivo: logo depois de vincular um parcelamento recém-concedido, a Receita costuma
    // recusar QUALQUER emissão (mesmo a da entrada) até confirmar o pagamento da 1ª parcela do lado
    // deles — isso não é erro técnico, então guarda o aviso em vez de só logar.
    let entradaGerada = false;
    let avisoEntrada: string | null = null;
    try {
      const hoje = new Date();
      const anoMes = hoje.getFullYear() * 100 + (hoje.getMonth() + 1);
      const { pdfBase64, aviso } = await integracontador.emitirParcelaParcelamento(token, cfg.cnpj, empresa.cnpj, anoMes);
      if (pdfBase64) entradaGerada = integraContadorAnexarParcelaEmEnvio(atribuicaoId, empId, hoje.getFullYear(), hoje.getMonth() + 1, pdfBase64);
      avisoEntrada = aviso;
    } catch (e: any) {
      console.error(`[Integra Contador] guia de entrada do parcelamento ${numeroParcelamento} (empresa ${empId}) falhou:`, e.message);
      avisoEntrada = e.message;
    }
    sqlite.prepare(`UPDATE integracontador_parcelamentos SET ultimo_erro = ? WHERE empresa_id = ? AND numero_parcelamento = ?`).run(avisoEntrada, empId, numeroParcelamento);
    // Baixa a solicitação original do cliente (se veio de uma) — só se ainda não tiver documento
    // nenhum anexado nela, mesma regra do DELETE manual de período avulso.
    if (periodoSolicitacaoId) {
      const temDoc = sqlite.prepare(`SELECT 1 FROM envio_documentos WHERE periodo_id = ?`).get(periodoSolicitacaoId);
      if (!temDoc) sqlite.prepare(`DELETE FROM envio_periodos WHERE id = ? AND solicitacao_tipo = 'parcelamento_das'`).run(periodoSolicitacaoId);
    }
    res.json({ ok: true, entradaGerada, avisoEntrada, resumo: detalhe });
  } catch (e: any) {
    res.status(502).json({ error: e.message });
  }
});
app.get("/api/integracontador/parcelamentos", blockCliente, requirePermissao("integracontador", "visualizar"), (req, res) => {
  const user = (req as any).user;
  const empresaId = req.query.empresaId ? Number(req.query.empresaId) : null;
  if (empresaId && !podeAcessarEmpresa(user, empresaId)) return res.status(404).json({ error: "Empresa não encontrada." });
  const ids = empresaId ? [empresaId] : empresasVisiveis(user);
  if (ids !== null && !ids.length) return res.json({ items: [] });
  let sql = `SELECT p.id, p.empresa_id as empresaId, e.nome as empresaNome, p.numero_parcelamento as numero, p.situacao,
             p.data_do_pedido as dataDoPedido, p.valor_total_consolidado as valorTotalConsolidado, p.quantidade_parcelas as quantidadeParcelas,
             p.valor_primeira_parcela as valorPrimeiraParcela, p.valor_parcela_basica as valorParcelaBasica, p.ativo,
             p.atribuicao_id as atribuicaoId, p.vinculado_em as vinculadoEm, p.ultima_busca_em as ultimaBuscaEm, p.ultimo_erro as ultimoErro
             FROM integracontador_parcelamentos p JOIN empresas e ON e.id = p.empresa_id
             WHERE p.escritorio_id = ?`;
  const params: any[] = [user.escritorioId];
  if (empresaId) {
    sql += ` AND p.empresa_id = ?`;
    params.push(empresaId);
  }
  sql += ` ORDER BY p.vinculado_em DESC`;
  let rows = sqlite.prepare(sql).all(...params) as any[];
  if (ids !== null) rows = rows.filter((r) => ids.includes(r.empresaId));
  res.json({ items: rows });
});
app.put("/api/integracontador/parcelamentos/:id/ativo", blockCliente, requirePermissao("integracontador", "editar"), (req, res) => {
  const user = (req as any).user;
  const row = sqlite.prepare(`SELECT * FROM integracontador_parcelamentos WHERE id = ?`).get(Number(req.params.id)) as any;
  if (!row || row.escritorio_id !== user.escritorioId || !podeAcessarEmpresa(user, row.empresa_id)) return res.status(404).json({ error: "Parcelamento não encontrado." });
  sqlite.prepare(`UPDATE integracontador_parcelamentos SET ativo = ? WHERE id = ?`).run(req.body?.ativo ? 1 : 0, row.id);
  res.json({ ok: true });
});
app.get("/api/integracontador/documentos", blockCliente, requirePermissao("integracontador", "visualizar"), (req, res) => {
  const user = (req as any).user;
  const empresaId = req.query.empresaId ? Number(req.query.empresaId) : null;
  if (empresaId && !podeAcessarEmpresa(user, empresaId)) return res.status(404).json({ error: "Empresa não encontrada." });
  const ids = empresaId ? [empresaId] : empresasVisiveis(user);
  if (!ids.length) return res.json({ items: [] });
  const placeholders = ids.map(() => "?").join(",");
  const rows = sqlite
    .prepare(
      `SELECT d.id, d.empresa_id as empresaId, e.nome as empresaNome, d.tipo, d.periodo_apuracao as periodoApuracao,
              d.numero_documento as numeroDocumento, d.data_vencimento as dataVencimento, d.detalhes_json as detalhesJson, d.criado_em as criadoEm,
              (d.pdf_path IS NOT NULL) as temPdf
       FROM integracontador_documentos d JOIN empresas e ON e.id = d.empresa_id
       WHERE d.escritorio_id = ? AND d.empresa_id IN (${placeholders}) ORDER BY d.criado_em DESC LIMIT 300`
    )
    .all(user.escritorioId, ...ids);
  res.json({ items: rows.map((r: any) => ({ ...r, detalhesJson: undefined, detalhes: r.detalhesJson ? JSON.parse(r.detalhesJson) : null, temPdf: !!r.temPdf })) });
});
// Só blockCliente (não requireAdmin) — o link "Baixar Situação Fiscal" já aparece pra qualquer
// Colaborador que enxergue o card no Início (card só exige "dashboard: visualizar"), então exigir
// Administrador aqui só travava o download sem servir pra nada além de confundir; podeAcessarEmpresa
// abaixo já garante que só baixa PDF de empresa que esse usuário realmente pode ver.
app.get("/api/integracontador/documentos/:id/pdf", blockCliente, (req, res) => {
  const user = (req as any).user;
  const row = sqlite.prepare(`SELECT * FROM integracontador_documentos WHERE id = ?`).get(Number(req.params.id)) as any;
  if (!row || row.escritorio_id !== user.escritorioId || !podeAcessarEmpresa(user, row.empresa_id) || !row.pdf_path) {
    return res.status(404).json({ error: "PDF não encontrado." });
  }
  res.setHeader("Content-Type", "application/pdf");
  res.send(fs.readFileSync(row.pdf_path));
});

// Rotina automática 1x ao dia, às 12h (horário de Brasília) — decisão explícita do usuário (antes
// era 2x/dia, 8h e 12h; antes disso, 1x por semana). Cada chamada ao Integra Contador é paga, então
// menos execuções = mais barato — troca-se dado um pouco menos fresco por menos custo. Roda pra
// toda empresa ativa, uma de cada vez, com uma pausa entre elas.
const INTEGRACONTADOR_AUTO_PAUSA_ENTRE_EMPRESAS_MS = 5000;
async function integraContadorExecutarBuscaAutomatica() {
  const configs = sqlite
    .prepare(
      `SELECT c.empresa_id as empresaId, c.optante_simples_nacional as optante, c.busca_dctfweb as buscaDctfweb, e.cnpj as cnpj
       FROM integracontador_empresa_config c
       JOIN empresas e ON e.id = c.empresa_id
       JOIN integracontador_config ic ON ic.escritorio_id = c.escritorio_id
       WHERE c.ativo = 1 AND ic.ativo = 1 AND e.ativo = 1`
    )
    .all() as any[];
  for (const cfg of configs) {
    if (integraContadorBuscasEmAndamento.has(cfg.empresaId)) continue;
    integraContadorBuscasEmAndamento.add(cfg.empresaId);
    try {
      const r = await integraContadorBuscarEmpresa(cfg.empresaId, cfg.cnpj || "", !!cfg.optante, !!cfg.buscaDctfweb);
      if (r.erro) console.error(`[Integra Contador] busca automática da empresa ${cfg.empresaId} falhou:`, r.erro);
    } catch (e: any) {
      console.error(`[Integra Contador] busca automática da empresa ${cfg.empresaId} falhou:`, e.message);
    } finally {
      integraContadorBuscasEmAndamento.delete(cfg.empresaId);
    }
    await new Promise((resolve) => setTimeout(resolve, INTEGRACONTADOR_AUTO_PAUSA_ENTRE_EMPRESAS_MS));
  }
}
// Confere a cada minuto se bateu 8h00 ou 12h00 (só no minuto exato, pra não disparar de novo a cada
// tick dentro da mesma hora) — mesmo padrão de setInterval de 60 em 60s já usado na rotina do NFS-e.
setInterval(() => {
  const agora = agoraBrasilia();
  if (agora.minuto !== 0 || agora.hora !== 12) return;
  integraContadorExecutarBuscaAutomatica().catch((e) => console.error("Erro na rotina automática do Integra Contador:", e.message));
}, 60_000);

// Modelos de serviço reutilizáveis — configurados uma vez (código de tributação, ISSQN, retenções)
// e escolhidos na hora da emissão, que só pede descrição e valor.
// Tabelas oficiais de referência (código de tributação nacional e NBS) — carregadas uma vez do
// disco (extraídas do portal gov.br/nfse e do ANEXO_VIII do governo), usadas pelos comboboxes de
// busca na tela de Modelos, igual ao que o próprio portal oficial do governo oferece.
const nfseTabelaCTribNac = JSON.parse(fs.readFileSync(path.join(__dirname, "nfse-tabelas", "ctribnac.json"), "utf8")) as { codigo: string; descricao: string }[];
const nfseTabelaNbs = JSON.parse(fs.readFileSync(path.join(__dirname, "nfse-tabelas", "nbs.json"), "utf8")) as { codigo: string; descricao: string }[];
const nfseTabelaCClassTrib = JSON.parse(fs.readFileSync(path.join(__dirname, "nfse-tabelas", "cclasstrib.json"), "utf8")) as { codigo: string; descricao: string }[];
app.get("/api/nfse/ctribnac", blockCliente, requirePermissao("nfse", "visualizar"), (_req, res) => {
  res.json({ items: nfseTabelaCTribNac.map((i) => ({ id: i.codigo, label: `${i.codigo} - ${i.descricao}` })) });
});
app.get("/api/nfse/nbs", blockCliente, requirePermissao("nfse", "visualizar"), (_req, res) => {
  res.json({ items: nfseTabelaNbs.map((i) => ({ id: i.codigo, label: `${i.codigo} - ${i.descricao}` })) });
});
app.get("/api/nfse/cclasstrib", blockCliente, requirePermissao("nfse", "visualizar"), (_req, res) => {
  res.json({ items: nfseTabelaCClassTrib.map((i) => ({ id: i.codigo, label: `${i.codigo} - ${i.descricao}` })) });
});

function nfseModeloParaJson(r: any) {
  return {
    id: r.id,
    nome: r.nome,
    codigoTributacaoNacional: r.codigo_tributacao_nacional,
    codigoTributacaoMunicipal: r.codigo_tributacao_municipal,
    codigoNbs: r.codigo_nbs,
    tribIssqn: r.trib_issqn,
    tipoRetencaoIssqn: r.tipo_retencao_issqn,
    aliquotaIssqn: r.aliquota_issqn,
    tipoRetencaoPisCofins: r.tipo_retencao_pis_cofins,
    issqnExigibilidadeSuspensa: !!r.issqn_exigibilidade_suspensa,
    issqnMotivoSuspensao: r.issqn_motivo_suspensao,
    issqnNumeroProcesso: r.issqn_numero_processo,
    beneficioMunicipalCodigo: r.beneficio_municipal_codigo,
    pisCofinsCst: r.pis_cofins_cst,
    percentualIrrf: r.percentual_irrf,
    percentualCsll: r.percentual_csll,
    percentualCofinsRetido: r.percentual_cofins_retido,
    percentualPisRetido: r.percentual_pis_retido,
    percentualContribPrevidenciaria: r.percentual_contrib_previdenciaria,
    ibscbsPreencher: !!r.ibscbs_preencher,
    ibscbsCst: r.ibscbs_cst,
    ibscbsCclasstrib: r.ibscbs_cclasstrib,
    docResponsabilidadeTecnica: r.doc_responsabilidade_tecnica,
    docReferencia: r.doc_referencia,
    informacoesComplementares: r.informacoes_complementares,
    ativo: !!r.ativo,
  };
}
// Lê o corpo da requisição de modelo (POST/PUT) e devolve os valores já normalizados pro banco,
// usando `existing` (quando editando) pra manter o valor atual em campos não enviados.
function nfseModeloDoBody(body: any, existing: any | null) {
  const pegar = (chave: string, coluna: string) => (body[chave] !== undefined ? body[chave] : existing ? existing[coluna] : undefined);
  const numOuNull = (v: any) => (v != null && v !== "" ? Number(v) : null);
  return {
    nome: body.nome !== undefined ? String(body.nome).trim() : existing?.nome,
    codigoTributacaoNacional:
      body.codigoTributacaoNacional !== undefined ? String(body.codigoTributacaoNacional).replace(/\D/g, "") : existing?.codigo_tributacao_nacional,
    codigoTributacaoMunicipal:
      body.codigoTributacaoMunicipal !== undefined ? (body.codigoTributacaoMunicipal ? String(body.codigoTributacaoMunicipal).trim() : null) : existing?.codigo_tributacao_municipal ?? null,
    codigoNbs: body.codigoNbs !== undefined ? (body.codigoNbs ? String(body.codigoNbs).replace(/\D/g, "") : null) : existing?.codigo_nbs ?? null,
    tribIssqn: body.tribIssqn !== undefined ? Number(body.tribIssqn) || 1 : existing?.trib_issqn ?? 1,
    tipoRetencaoIssqn: body.tipoRetencaoIssqn !== undefined ? Number(body.tipoRetencaoIssqn) || 1 : existing?.tipo_retencao_issqn ?? 1,
    aliquotaIssqn: body.aliquotaIssqn !== undefined ? numOuNull(body.aliquotaIssqn) : existing?.aliquota_issqn ?? null,
    tipoRetencaoPisCofins: body.tipoRetencaoPisCofins !== undefined ? numOuNull(body.tipoRetencaoPisCofins) : existing?.tipo_retencao_pis_cofins ?? null,
    issqnExigibilidadeSuspensa: body.issqnExigibilidadeSuspensa !== undefined ? (body.issqnExigibilidadeSuspensa ? 1 : 0) : existing?.issqn_exigibilidade_suspensa ?? 0,
    issqnMotivoSuspensao: body.issqnMotivoSuspensao !== undefined ? numOuNull(body.issqnMotivoSuspensao) : existing?.issqn_motivo_suspensao ?? null,
    issqnNumeroProcesso: pegar("issqnNumeroProcesso", "issqn_numero_processo") || null,
    beneficioMunicipalCodigo: pegar("beneficioMunicipalCodigo", "beneficio_municipal_codigo") || null,
    pisCofinsCst: body.pisCofinsCst !== undefined ? String(body.pisCofinsCst || "00") : existing?.pis_cofins_cst ?? "00",
    percentualIrrf: body.percentualIrrf !== undefined ? numOuNull(body.percentualIrrf) : existing?.percentual_irrf ?? null,
    percentualCsll: body.percentualCsll !== undefined ? numOuNull(body.percentualCsll) : existing?.percentual_csll ?? null,
    percentualCofinsRetido: body.percentualCofinsRetido !== undefined ? numOuNull(body.percentualCofinsRetido) : existing?.percentual_cofins_retido ?? null,
    percentualPisRetido: body.percentualPisRetido !== undefined ? numOuNull(body.percentualPisRetido) : existing?.percentual_pis_retido ?? null,
    percentualContribPrevidenciaria:
      body.percentualContribPrevidenciaria !== undefined ? numOuNull(body.percentualContribPrevidenciaria) : existing?.percentual_contrib_previdenciaria ?? null,
    ibscbsPreencher: body.ibscbsPreencher !== undefined ? (body.ibscbsPreencher ? 1 : 0) : existing?.ibscbs_preencher ?? 0,
    ibscbsCst: body.ibscbsCst !== undefined ? String(body.ibscbsCst || "000") : existing?.ibscbs_cst ?? "000",
    ibscbsCclasstrib: body.ibscbsCclasstrib !== undefined ? String(body.ibscbsCclasstrib || "000001") : existing?.ibscbs_cclasstrib ?? "000001",
    docResponsabilidadeTecnica: pegar("docResponsabilidadeTecnica", "doc_responsabilidade_tecnica") || null,
    docReferencia: pegar("docReferencia", "doc_referencia") || null,
    informacoesComplementares: pegar("informacoesComplementares", "informacoes_complementares") || null,
    ativo: body.ativo !== undefined ? (body.ativo ? 1 : 0) : existing?.ativo ?? 1,
  };
}
app.get("/api/nfse/modelos", blockCliente, requirePermissao("nfse", "visualizar"), (req, res) => {
  const user = (req as any).user;
  const empresaId = req.query.empresaId ? Number(req.query.empresaId) : null;
  // Se a empresa tiver uma lista de modelos liberados configurada (nfse_empresa_modelos não-vazia
  // pra ela), o dropdown de emissão só mostra esses — senão, mostra todo o catálogo do escritório
  // (comportamento padrão de sempre, sem restrição nenhuma).
  if (empresaId) {
    if (!podeAcessarEmpresa(user, empresaId)) return res.status(403).json({ error: "Sem acesso a esta empresa." });
    const restritos = sqlite.prepare(`SELECT modelo_id FROM nfse_empresa_modelos WHERE empresa_id = ?`).all(empresaId) as any[];
    if (restritos.length) {
      const ids = restritos.map((r) => r.modelo_id);
      const placeholders = ids.map(() => "?").join(",");
      const rows = sqlite
        .prepare(`SELECT * FROM nfse_modelos WHERE empresa_id IS NULL AND escritorio_id = ? AND id IN (${placeholders}) ORDER BY nome`)
        .all(user.escritorioId, ...ids) as any[];
      return res.json({ items: rows.map(nfseModeloParaJson) });
    }
  }
  const rows = sqlite
    .prepare(`SELECT * FROM nfse_modelos WHERE empresa_id IS NULL AND escritorio_id = ? ORDER BY nome`)
    .all(user.escritorioId) as any[];
  res.json({ items: rows.map(nfseModeloParaJson) });
});
// Lista os modelos do escritório com uma flag "atribuido" indicando se estão na lista de liberados
// dessa empresa — usado pela tela do admin de configuração da empresa pra montar o checklist de
// seleção. Lista vazia (nenhum atribuido=true) tem o mesmo efeito de "sem restrição" na emissão.
app.get("/api/nfse/empresas/:empresaId/modelos", blockCliente, requirePermissao("nfse", "visualizar"), (req, res) => {
  const user = (req as any).user;
  const empresaId = Number(req.params.empresaId);
  if (!podeAcessarEmpresa(user, empresaId)) return res.status(403).json({ error: "Sem acesso a esta empresa." });
  const rows = sqlite
    .prepare(`SELECT * FROM nfse_modelos WHERE empresa_id IS NULL AND escritorio_id = ? ORDER BY nome`)
    .all(user.escritorioId) as any[];
  const atribuidos = new Set(
    (sqlite.prepare(`SELECT modelo_id FROM nfse_empresa_modelos WHERE empresa_id = ?`).all(empresaId) as any[]).map((r) => r.modelo_id)
  );
  res.json({ items: rows.map((r) => ({ ...nfseModeloParaJson(r), atribuido: atribuidos.has(r.id) })) });
});
// Substitui a lista inteira de modelos liberados pra essa empresa. body.modeloIds = [] remove a
// restrição (empresa volta a ver todo o catálogo do escritório na emissão).
app.put("/api/nfse/empresas/:empresaId/modelos", blockCliente, requirePermissao("nfse", "editar"), (req, res) => {
  const user = (req as any).user;
  const empresaId = Number(req.params.empresaId);
  if (!podeAcessarEmpresa(user, empresaId)) return res.status(403).json({ error: "Sem acesso a esta empresa." });
  const modeloIds: number[] = Array.isArray(req.body?.modeloIds) ? req.body.modeloIds.map(Number).filter((n: number) => Number.isFinite(n)) : [];
  const permitidos = modeloIds.length
    ? (sqlite
        .prepare(`SELECT id FROM nfse_modelos WHERE empresa_id IS NULL AND escritorio_id = ? AND id IN (${modeloIds.map(() => "?").join(",")})`)
        .all(user.escritorioId, ...modeloIds) as any[])
    : [];
  sqlite.prepare(`DELETE FROM nfse_empresa_modelos WHERE empresa_id = ?`).run(empresaId);
  const inserir = sqlite.prepare(`INSERT INTO nfse_empresa_modelos (empresa_id, modelo_id) VALUES (?, ?)`);
  for (const m of permitidos) inserir.run(empresaId, m.id);
  res.json({ ok: true });
});
// Reaproveitado tanto pelas rotas admin (empresaId=null, modelo interno do escritório) quanto
// pelas rotas de empresa-cliente self-service (empresaId = user.empresaId, modelo privado dela).
function nfseInserirModelo(empresaId: number | null, escritorioId: number | null, v: ReturnType<typeof nfseModeloDoBody>, criadoPor: number) {
  return sqlite
    .prepare(
      `INSERT INTO nfse_modelos (
         empresa_id, escritorio_id, nome, codigo_tributacao_nacional, codigo_tributacao_municipal, codigo_nbs, trib_issqn, tipo_retencao_issqn, aliquota_issqn, tipo_retencao_pis_cofins,
         issqn_exigibilidade_suspensa, issqn_motivo_suspensao, issqn_numero_processo, beneficio_municipal_codigo,
         pis_cofins_cst, percentual_irrf, percentual_csll, percentual_cofins_retido, percentual_pis_retido, percentual_contrib_previdenciaria,
         ibscbs_preencher, ibscbs_cst, ibscbs_cclasstrib, doc_responsabilidade_tecnica, doc_referencia, informacoes_complementares, created_by
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      empresaId,
      escritorioId,
      v.nome,
      v.codigoTributacaoNacional,
      v.codigoTributacaoMunicipal,
      v.codigoNbs,
      v.tribIssqn,
      v.tipoRetencaoIssqn,
      v.aliquotaIssqn,
      v.tipoRetencaoPisCofins,
      v.issqnExigibilidadeSuspensa,
      v.issqnMotivoSuspensao,
      v.issqnNumeroProcesso,
      v.beneficioMunicipalCodigo,
      v.pisCofinsCst,
      v.percentualIrrf,
      v.percentualCsll,
      v.percentualCofinsRetido,
      v.percentualPisRetido,
      v.percentualContribPrevidenciaria,
      v.ibscbsPreencher,
      v.ibscbsCst,
      v.ibscbsCclasstrib,
      v.docResponsabilidadeTecnica,
      v.docReferencia,
      v.informacoesComplementares,
      criadoPor
    );
}
app.post("/api/nfse/modelos", blockCliente, requirePermissao("nfse", "postar"), (req, res) => {
  const user = (req as any).user;
  const v = nfseModeloDoBody(req.body || {}, null);
  if (!v.nome || !v.codigoTributacaoNacional) return res.status(400).json({ error: "Informe o nome e o código de tributação nacional." });
  const info = nfseInserirModelo(null, user.escritorioId, v, user.id);
  res.json({ id: Number(info.lastInsertRowid) });
});
function nfseAtualizarModelo(id: number, v: ReturnType<typeof nfseModeloDoBody>) {
  sqlite
    .prepare(
      `UPDATE nfse_modelos SET
         nome=?, codigo_tributacao_nacional=?, codigo_tributacao_municipal=?, codigo_nbs=?, trib_issqn=?, tipo_retencao_issqn=?, aliquota_issqn=?, tipo_retencao_pis_cofins=?,
         issqn_exigibilidade_suspensa=?, issqn_motivo_suspensao=?, issqn_numero_processo=?, beneficio_municipal_codigo=?,
         pis_cofins_cst=?, percentual_irrf=?, percentual_csll=?, percentual_cofins_retido=?, percentual_pis_retido=?, percentual_contrib_previdenciaria=?,
         ibscbs_preencher=?, ibscbs_cst=?, ibscbs_cclasstrib=?, doc_responsabilidade_tecnica=?, doc_referencia=?, informacoes_complementares=?, ativo=?
       WHERE id=?`
    )
    .run(
      v.nome,
      v.codigoTributacaoNacional,
      v.codigoTributacaoMunicipal,
      v.codigoNbs,
      v.tribIssqn,
      v.tipoRetencaoIssqn,
      v.aliquotaIssqn,
      v.tipoRetencaoPisCofins,
      v.issqnExigibilidadeSuspensa,
      v.issqnMotivoSuspensao,
      v.issqnNumeroProcesso,
      v.beneficioMunicipalCodigo,
      v.pisCofinsCst,
      v.percentualIrrf,
      v.percentualCsll,
      v.percentualCofinsRetido,
      v.percentualPisRetido,
      v.percentualContribPrevidenciaria,
      v.ibscbsPreencher,
      v.ibscbsCst,
      v.ibscbsCclasstrib,
      v.docResponsabilidadeTecnica,
      v.docReferencia,
      v.informacoesComplementares,
      v.ativo,
      id
    );
}
app.put("/api/nfse/modelos/:id", blockCliente, requirePermissao("nfse", "editar"), (req, res) => {
  const id = Number(req.params.id);
  const existing = sqlite.prepare(`SELECT * FROM nfse_modelos WHERE id = ? AND empresa_id IS NULL AND escritorio_id = ?`).get(id, (req as any).user.escritorioId) as any;
  if (!existing) return res.status(404).json({ error: "Modelo não encontrado." });
  const v = nfseModeloDoBody(req.body || {}, existing);
  nfseAtualizarModelo(id, v);
  res.json({ ok: true });
});
app.delete("/api/nfse/modelos/:id", blockCliente, requireAdmin, (req, res) => {
  sqlite.prepare(`DELETE FROM nfse_modelos WHERE id = ? AND empresa_id IS NULL AND escritorio_id = ?`).run(Number(req.params.id), (req as any).user.escritorioId);
  res.json({ ok: true });
});

app.get("/api/nfse/empresas", blockCliente, requirePermissao("nfse", "visualizar"), (_req, res) => {
  const rows = sqlite
    .prepare(
      `SELECT e.id, e.nome, e.cnpj, e.cidade, e.uf,
              c.habilitado, c.metodo_assinatura as metodoAssinatura,
              COALESCE(c.codigo_municipio, e.codigo_municipio_ibge) as codigoMunicipio,
              COALESCE(c.nome_municipio, e.nome_municipio_ibge) as nomeMunicipio,
              COALESCE(c.inscricao_municipal, e.inscricao_municipal) as inscricaoMunicipal,
              c.opcao_simples_nacional as opcaoSimplesNacional,
              c.regime_especial_trib as regimeEspecialTrib, c.regime_apuracao_sn as regimeApuracaoSn,
              c.percentual_total_tributos_sn as percentualTotalTributosSn,
              ((SELECT 1 FROM nfe_busca_config nb WHERE nb.empresa_id = e.id) IS NOT NULL
                OR (SELECT 1 FROM nfse_certificados nc WHERE nc.empresa_id = e.id) IS NOT NULL) as temCertificadoProprio
       FROM empresas e LEFT JOIN nfse_empresa_config c ON c.empresa_id = e.id
       WHERE e.ativo = 1 ORDER BY e.nome`
    )
    .all() as any[];
  res.json({ items: rows.map((r) => ({ ...r, habilitado: !!r.habilitado, opcaoSimplesNacional: !!r.opcaoSimplesNacional, temCertificadoProprio: !!r.temCertificadoProprio })) });
});
// Código do município (IBGE) — o próprio leiaute oficial da DPS referencia "Tabela do IBGE" pra
// esse campo, então é a fonte certa (mesma origem que o Sistema Nacional NFS-e usa). Cache em
// memória por UF pra não repetir a chamada à API pública do IBGE a cada empresa.
const nfseCacheMunicipiosPorUf = new Map<string, { id: number; nome: string }[]>();
function nfseNormalizaCidade(s: string): string {
  return String(s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();
}
async function nfseMunicipiosDaUf(uf: string): Promise<{ id: number; nome: string }[]> {
  let municipios = nfseCacheMunicipiosPorUf.get(uf);
  if (!municipios) {
    const resp = await fetch(`https://servicodados.ibge.gov.br/api/v1/localidades/estados/${uf}/municipios`);
    if (!resp.ok) throw new Error(`API do IBGE retornou HTTP ${resp.status}.`);
    const json = (await resp.json()) as any[];
    municipios = json.map((m) => ({ id: m.id, nome: m.nome }));
    nfseCacheMunicipiosPorUf.set(uf, municipios);
  }
  return municipios;
}
// Busca de CEP (BrasilAPI) já resolvendo o código IBGE do município junto — usado pra
// pré-preencher o endereço do tomador na emissão de NFS-e mesmo quando ele é pessoa física (CPF
// não tem consulta pública de CNPJ, então até agora só CNPJ ganhava esse preenchimento automático;
// sem código de município preenchido, o servidor caía no padrão do prestador, que não bate com o
// CEP real do tomador quando ele é de outra cidade — rejeição real da Receita, achado ao vivo).
async function nfseResolverCep(cep: string): Promise<{
  logradouro: string | null;
  bairro: string | null;
  cidade: string | null;
  uf: string | null;
  codigoMunicipio: string | null;
}> {
  const resp = await fetch(`https://brasilapi.com.br/api/cep/v2/${cep}`, { headers: { "User-Agent": "SimplesContabeis/1.0" } });
  if (resp.status === 404) throw new Error("CEP não encontrado.");
  if (!resp.ok) throw new Error(`API retornou HTTP ${resp.status}.`);
  const j = (await resp.json()) as any;
  const cidade: string | null = j.city || null;
  const uf: string | null = j.state || null;
  let codigoMunicipio: string | null = null;
  if (cidade && uf) {
    try {
      const municipios = await nfseMunicipiosDaUf(uf);
      const alvo = nfseNormalizaCidade(cidade);
      const achado = municipios.find((m) => nfseNormalizaCidade(m.nome) === alvo);
      if (achado) codigoMunicipio = String(achado.id);
    } catch {
      /* segue sem o código IBGE — quem chama decide se bloqueia a emissão sem ele ou não */
    }
  }
  return { logradouro: j.street || null, bairro: j.neighborhood || null, cidade, uf, codigoMunicipio };
}
// Lista completa de municípios de uma UF — usado pelo combobox de busca manual (o admin digita
// pra filtrar, ver setupComboSelect no frontend).
// Compartilhado com a aba Empresa (código do município agora é preenchido no cadastro, não só na
// config de NFS-e) — requirePermissaoOr em vez de exigir a permissão de NFS-e de quem só cadastra empresa.
app.get("/api/nfse/municipios-ibge", blockCliente, requirePermissaoOr("empresas", "nfse", "visualizar"), async (req, res) => {
  const uf = String(req.query.uf || "").toUpperCase().trim();
  if (!uf) return res.status(400).json({ error: "Informe a UF." });
  try {
    const municipios = await nfseMunicipiosDaUf(uf);
    res.json({ items: municipios.map((m) => ({ id: String(m.id), label: m.nome })) });
  } catch (e: any) {
    res.status(502).json({ error: `Não consegui consultar a API do IBGE: ${e.message}` });
  }
});
// Busca exata por cidade+UF (usado no auto-preenchimento a partir do cadastro da empresa).
app.get("/api/nfse/municipio-ibge", blockCliente, requirePermissaoOr("empresas", "nfse", "visualizar"), async (req, res) => {
  const uf = String(req.query.uf || "").toUpperCase().trim();
  const cidade = String(req.query.cidade || "").trim();
  if (!uf || !cidade) return res.status(400).json({ error: "Informe cidade e UF." });
  try {
    const municipios = await nfseMunicipiosDaUf(uf);
    const alvo = nfseNormalizaCidade(cidade);
    const achado = municipios.find((m) => nfseNormalizaCidade(m.nome) === alvo);
    if (!achado) return res.status(404).json({ error: `Não encontrei "${cidade}" na lista de municípios de ${uf}.` });
    res.json({ codigoMunicipio: String(achado.id), nomeOficial: achado.nome });
  } catch (e: any) {
    res.status(502).json({ error: `Não consegui consultar a API do IBGE: ${e.message}` });
  }
});
// Consulta de CNPJ (dados públicos da Receita Federal) — usado pra pré-preencher formulários com
// CNPJ (tomador do serviço na emissão de NFS-e, cadastro de empresa etc.). BrasilAPI é um espelho
// gratuito e sem autenticação dos mesmos dados públicos do CNPJ; não expõe nenhum dado sigiloso.
async function consultarCnpjBrasilApi(cnpj: string) {
  // BrasilAPI bloqueia (403) requisições sem User-Agent — o fetch nativo do Node não manda um por padrão.
  const resp = await fetch(`https://brasilapi.com.br/api/cnpj/v1/${cnpj}`, { headers: { "User-Agent": "SimplesContabeis/1.0" } });
  if (resp.status === 404) return { notFound: true as const };
  if (!resp.ok) throw new Error(`API retornou HTTP ${resp.status}.`);
  const j = (await resp.json()) as any;
  return {
    notFound: false as const,
    razaoSocial: j.razao_social || null,
    nomeFantasia: j.nome_fantasia || null,
    email: j.email || null,
    logradouro: j.logradouro || null,
    numero: j.numero || null,
    complemento: j.complemento || null,
    bairro: j.bairro || null,
    cep: j.cep || null,
    municipio: j.municipio || null,
    uf: j.uf || null,
  };
}
app.get("/api/nfse/cnpj/:cnpj", blockCliente, requirePermissao("nfse", "visualizar"), async (req, res) => {
  const cnpj = String(req.params.cnpj).replace(/\D/g, "");
  if (cnpj.length !== 14) return res.status(400).json({ error: "CNPJ inválido — precisa ter 14 dígitos." });
  try {
    const dados = await consultarCnpjBrasilApi(cnpj);
    if (dados.notFound) return res.status(404).json({ error: "CNPJ não encontrado na Receita Federal." });
    res.json(dados);
  } catch (e: any) {
    res.status(502).json({ error: `Não consegui consultar o CNPJ: ${e.message}` });
  }
});
app.get("/api/nfse/cep/:cep", blockCliente, requirePermissao("nfse", "visualizar"), async (req, res) => {
  const cep = String(req.params.cep).replace(/\D/g, "");
  if (cep.length !== 8) return res.status(400).json({ error: "CEP inválido — precisa ter 8 dígitos." });
  try {
    res.json(await nfseResolverCep(cep));
  } catch (e: any) {
    res.status(502).json({ error: `Não consegui consultar o CEP: ${e.message}` });
  }
});
// Código do município/inscrição municipal (agora só no cadastro da empresa) e Optante Simples
// Nacional/regime/% tributos (agora na aba Configurações do cadastro, ver empresaSalvarDadosFiscaisNfse)
// não são mais escritos por aqui — o upsert parcial preserva o que já estiver salvo nessas colunas.
app.put("/api/nfse/empresas/:id", blockCliente, requirePermissao("nfse", "editar"), (req, res) => {
  const empresaId = Number(req.params.id);
  if (!podeAcessarEmpresa((req as any).user, empresaId)) return res.status(404).json({ error: "Empresa não encontrada." });
  const { habilitado, metodoAssinatura } = req.body || {};
  sqlite
    .prepare(
      `INSERT INTO nfse_empresa_config (empresa_id, habilitado, metodo_assinatura, updated_at)
       VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT(empresa_id) DO UPDATE SET habilitado=excluded.habilitado, metodo_assinatura=excluded.metodo_assinatura, updated_at=datetime('now')`
    )
    .run(empresaId, habilitado ? 1 : 0, metodoAssinatura === "certificado_proprio" ? "certificado_proprio" : "procuracao_escritorio");
  res.json({ ok: true });
});

// ---------- Módulos vendáveis: catálogo (preço) e estado de contratação por empresa (admin) ----------
app.get("/api/nfse/empresas/:id/modulos", blockCliente, requirePermissao("nfse", "editar"), (req, res) => {
  const empresaId = Number(req.params.id);
  if (!podeAcessarEmpresa((req as any).user, empresaId)) return res.status(404).json({ error: "Empresa não encontrada." });
  res.json({ items: nfseModulosDaEmpresa(empresaId) });
});
app.post("/api/nfse/empresas/:id/modulos/:chave/prorrogar", blockCliente, requirePermissao("nfse", "editar"), (req, res) => {
  const empresaId = Number(req.params.id);
  if (!podeAcessarEmpresa((req as any).user, empresaId)) return res.status(404).json({ error: "Empresa não encontrada." });
  const chave = String(req.params.chave);
  const contratado = sqlite.prepare(`SELECT * FROM empresa_modulos WHERE empresa_id = ? AND modulo_chave = ?`).get(empresaId, chave) as any;
  const agora = new Date().toISOString().replace("T", " ").slice(0, 19);
  if (!contratado) return res.status(404).json({ error: "Esta empresa ainda não iniciou o teste desse módulo." });
  if (contratado.assinatura_ativa_ate) return res.status(409).json({ error: "Esta empresa já tem assinatura paga desse módulo." });
  if (contratado.trial_prorrogado) return res.status(409).json({ error: "O teste desse módulo já foi prorrogado antes." });
  if (contratado.trial_fim < agora) return res.status(409).json({ error: "O teste desse módulo já venceu — oriente o cliente a contratar." });
  sqlite
    .prepare(`UPDATE empresa_modulos SET trial_fim = datetime(trial_fim, '+3 days'), trial_prorrogado = 1 WHERE empresa_id = ? AND modulo_chave = ?`)
    .run(empresaId, chave);
  res.json({ ok: true, items: nfseModulosDaEmpresa(empresaId) });
});
// Catálogo de módulos vendáveis pras EMPRESAS-CLIENTE (Financeiro, NFS-e) — compartilhado entre
// todos os escritórios da plataforma, por isso só o SuperAdmin edita (não o Administrador de um
// escritório específico). Ver também /api/super/modulos-catalogo, que é o catálogo irmão vendido
// pra ESCRITÓRIOS (WhatsApp, Busca de XML etc.) — catálogos e tabelas diferentes.
app.get("/api/super/modulos-clientes", requireSuperAdmin, (_req, res) => {
  const rows = sqlite.prepare(`SELECT chave, nome, valor_mensal as valorMensal, ativo FROM modulos_catalogo ORDER BY chave`).all() as any[];
  res.json({ items: rows.map((r) => ({ ...r, ativo: !!r.ativo })) });
});
app.put("/api/super/modulos-clientes/:chave", requireSuperAdmin, (req, res) => {
  const chave = String(req.params.chave);
  const existente = sqlite.prepare(`SELECT chave FROM modulos_catalogo WHERE chave = ?`).get(chave);
  if (!existente) return res.status(404).json({ error: "Módulo não encontrado." });
  const { nome, valorMensal, ativo } = req.body || {};
  sqlite
    .prepare(`UPDATE modulos_catalogo SET nome = COALESCE(?, nome), valor_mensal = COALESCE(?, valor_mensal), ativo = COALESCE(?, ativo), updated_at = datetime('now') WHERE chave = ?`)
    .run(nome ?? null, valorMensal != null ? Number(valorMensal) : null, ativo != null ? (ativo ? 1 : 0) : null, chave);
  res.json({ ok: true });
});

app.get("/api/nfse/emissoes", blockCliente, requirePermissao("nfse", "visualizar"), (req, res) => {
  const user = (req as any).user;
  const empresaId = req.query.empresaId ? Number(req.query.empresaId) : null;
  if (empresaId && !podeAcessarEmpresa(user, empresaId)) return res.status(403).json({ error: "Sem acesso a esta empresa." });
  const dataDe = typeof req.query.dataDe === "string" && req.query.dataDe ? req.query.dataDe : null;
  const dataAte = typeof req.query.dataAte === "string" && req.query.dataAte ? req.query.dataAte : null;
  let sql = `SELECT n.id, n.empresa_id as empresaId, e.nome as empresaNome, n.serie, n.numero_dps as numeroDps, n.ambiente,
                    n.modelo_id as modeloId, n.modelo_nome as modeloNome,
                    n.tomador_documento as tomadorDocumento, n.tomador_nome as tomadorNome, n.tomador_email as tomadorEmail, n.tomador_telefone as tomadorTelefone,
                    n.tomador_cep as tomadorCep, n.tomador_logradouro as tomadorLogradouro, n.tomador_numero as tomadorNumero,
                    n.tomador_complemento as tomadorComplemento, n.tomador_bairro as tomadorBairro, n.tomador_codigo_municipio as tomadorCodigoMunicipio,
                    n.descricao_servico as descricaoServico, n.valor_servico as valorServico, n.competencia,
                    n.status, n.chave_acesso as chaveAcesso, n.numero_nfse as numeroNfse, n.erro, n.criado_em as criadoEm,
                    n.whatsapp_enviado as whatsappEnviado, n.whatsapp_erro as whatsappErro
             FROM nfse_emissoes n JOIN empresas e ON e.id = n.empresa_id`;
  const condicoes: string[] = [];
  const params: any[] = [];
  if (empresaId) {
    condicoes.push(`n.empresa_id = ?`);
    params.push(empresaId);
  }
  if (dataDe) {
    condicoes.push(`date(n.criado_em) >= date(?)`);
    params.push(dataDe);
  }
  if (dataAte) {
    condicoes.push(`date(n.criado_em) <= date(?)`);
    params.push(dataAte);
  }
  if (condicoes.length) sql += ` WHERE ` + condicoes.join(" AND ");
  sql += ` ORDER BY n.criado_em DESC, n.id DESC`;
  let rows = sqlite.prepare(sql).all(...params) as any[];
  const visiveis = empresasVisiveis(user);
  if (visiveis !== null) rows = rows.filter((r) => visiveis.includes(r.empresaId));
  const statusWhatsappPorNfse = statusWhatsappPorOrigem("nfse_emissoes", rows.map((r) => r.id));
  res.json({
    items: rows.map((r) => {
      const statusWhatsapp = statusWhatsappPorNfse.get(r.id);
      return { ...r, whatsappStatus: statusWhatsapp?.status || (r.whatsappEnviado ? "enviado" : null), whatsappStatusEm: statusWhatsapp?.em || null };
    }),
  });
});
// Nome de exibição pro arquivo baixado: "Tomador - NFS-e Nº <número>" — usa o número da NFS-e (do
// município) quando já emitida, senão o id interno como fallback (rascunho/rejeitada).
function nfseNomeArquivo(row: any, extensao: string): string {
  const base = `${row.tomador_nome || "NFSe"} - NFS-e ${row.numero_nfse || row.id}`.replace(/[\\/:*?"<>|]/g, "").trim();
  return `${base}.${extensao}`;
}
function nfseContentDisposition(tipo: "attachment" | "inline", nomeArquivo: string): string {
  const asciiFallback = nomeArquivo.replace(/[^\x20-\x7E]/g, "_");
  return `${tipo}; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(nomeArquivo)}`;
}
// Empresas-cliente cadastradas com este CNPJ/CPF. Pode ser MAIS DE UMA: produtor rural costuma ter
// várias inscrições (uma por fazenda) no mesmo CPF, cada uma como uma "empresa" separada aqui — e os
// contatos de WhatsApp/e-mail podem estar cadastrados só em algumas delas. Achado ao vivo: o "Enviar
// WhatsApp" da NFS-e resolvia o tomador com .get() (pegava só a primeira), e quando essa primeira não
// tinha contato marcado, dava "tomador não tem contato" mesmo com o telefone cadastrado numa das
// outras. Por isso agora sempre olha TODAS.
function empresasClientePorDocumento(documento: string | null | undefined): any[] {
  const limpo = String(documento || "").replace(/\D/g, "");
  if (!limpo) return [];
  return sqlite.prepare(`SELECT * FROM empresas WHERE REPLACE(REPLACE(REPLACE(cnpj,'.',''),'/',''),'-','') = ?`).all(limpo) as any[];
}
// Junta os telefones de WhatsApp (contatos "Receber WhatsApp") de todas as empresas passadas,
// deduplicando por dígitos. Ignora valores obviamente inválidos (menos de 10 dígitos).
function whatsappContatosDeEmpresas(empresaIds: number[]): { telefone: string }[] {
  const porDigitos = new Map<string, string>();
  for (const id of empresaIds) {
    const rows = sqlite
      .prepare(`SELECT telefone FROM empresa_contatos WHERE empresa_id = ? AND receber_whatsapp = 1 AND telefone IS NOT NULL AND telefone != ''`)
      .all(id) as any[];
    for (const r of rows) {
      const digs = String(r.telefone).replace(/\D/g, "");
      if (digs.length >= 10 && !porDigitos.has(digs)) porDigitos.set(digs, r.telefone);
    }
  }
  return [...porDigitos.values()].map((telefone) => ({ telefone }));
}
// Idem pros e-mails ("Receber e-mails"), deduplicando (case-insensitive).
function emailContatosDeEmpresas(empresaIds: number[]): string[] {
  const vistos = new Map<string, string>();
  for (const id of empresaIds) {
    const rows = sqlite.prepare(`SELECT email FROM empresa_contatos WHERE empresa_id = ? AND receber_emails = 1 AND email IS NOT NULL AND email != ''`).all(id) as any[];
    for (const r of rows) {
      const chave = String(r.email).trim().toLowerCase();
      if (chave && !vistos.has(chave)) vistos.set(chave, String(r.email).trim());
    }
  }
  return [...vistos.values()];
}
app.get("/api/nfse/emissoes/:id/xml", blockCliente, requirePermissao("nfse", "visualizar"), (req, res) => {
  const row = sqlite.prepare(`SELECT * FROM nfse_emissoes WHERE id = ?`).get(Number(req.params.id)) as any;
  if (!row) return res.status(404).json({ error: "Emissão não encontrada." });
  const user = (req as any).user;
  if (!podeAcessarEmpresa(user, row.empresa_id)) return res.status(403).json({ error: "Sem acesso a esta empresa." });
  const xml = row.xml_nfse || row.xml_dps;
  if (!xml) return res.status(404).json({ error: "Nenhum XML disponível para esta emissão." });
  res.setHeader("Content-Type", "application/xml");
  res.setHeader("Content-Disposition", nfseContentDisposition("attachment", nfseNomeArquivo(row, "xml")));
  res.send(xml);
});
// Busca o PDF do DANFSe pro registro — cache local (data/nfse-danfse/) se já tiver sido baixado
// antes; senão busca no ADN, guarda em cache. Usado tanto pelo download único quanto pelo lote.
// Gera o DANFSe 2.0 localmente a partir do XML já armazenado da própria emissão — a API do governo
// que fazia isso (adn.nfse.gov.br/danfse) foi desativada em 03/08/2026 (ver Nota Técnica SE/CGNFS-e
// nº 008/2026 v1.02), então deixou de ser uma opção. O cache em disco (danfse_path) é invalidado
// sempre que o status muda (ex.: cancelamento) — ver UPDATE em nfse_emissoes logo abaixo e nas
// rotas de cancelamento — pra nunca servir um PDF desatualizado (ex.: sem a marca d'água CANCELADA).
async function nfseObterDanfsePdf(row: any): Promise<{ pdf: Buffer | null; erro: string | null }> {
  if (!row.chave_acesso) return { pdf: null, erro: "Esta emissão ainda não tem chave de acesso — só é possível gerar o DANFSe de uma NFS-e emitida." };
  if (row.danfse_path && fs.existsSync(row.danfse_path)) return { pdf: fs.readFileSync(row.danfse_path), erro: null };
  if (!row.xml_nfse) return { pdf: null, erro: "Esta emissão não tem o XML da NFS-e salvo — não é possível gerar o DANFSe." };
  try {
    const pdf = await danfse.gerarDanfsePdf(row.xml_nfse, { marcaDagua: row.status === "cancelada" ? "CANCELADA" : undefined });
    const caminho = nfse.salvarDanfsePdfEmCache(row.chave_acesso, pdf);
    sqlite.prepare(`UPDATE nfse_emissoes SET danfse_path = ? WHERE id = ?`).run(caminho, row.id);
    return { pdf, erro: null };
  } catch (e: any) {
    return { pdf: null, erro: `Não consegui gerar o DANFSe: ${e.message}` };
  }
}
// DANFSe (PDF) — serve do cache local (data/nfse-danfse/) se já tiver sido baixado antes; senão
// busca no ADN, guarda em cache e serve. Assim não reconsulta o governo toda vez que alguém pede
// o mesmo PDF de novo.
app.get("/api/nfse/emissoes/:id/danfse", blockCliente, requirePermissao("nfse", "visualizar"), async (req, res) => {
  const row = sqlite.prepare(`SELECT * FROM nfse_emissoes WHERE id = ?`).get(Number(req.params.id)) as any;
  if (!row) return res.status(404).json({ error: "Emissão não encontrada." });
  const user = (req as any).user;
  if (!podeAcessarEmpresa(user, row.empresa_id)) return res.status(403).json({ error: "Sem acesso a esta empresa." });
  try {
    const { pdf, erro } = await nfseObterDanfsePdf(row);
    if (!pdf) return res.status(502).json({ error: erro });
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", nfseContentDisposition("inline", nfseNomeArquivo(row, "pdf")));
    res.send(pdf);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});
// Manda o DANFSe já emitido direto pro(s) contato(s) de WhatsApp da empresa — mesmo caminho da
// Envio de Documentos, só que direto da tela de NFS-e, sem precisar anexar o PDF manualmente lá.
app.post("/api/nfse/emissoes/:id/enviar-whatsapp", blockCliente, requirePermissao("nfse", "editar"), async (req, res) => {
  const row = sqlite.prepare(`SELECT * FROM nfse_emissoes WHERE id = ?`).get(Number(req.params.id)) as any;
  if (!row) return res.status(404).json({ error: "Emissão não encontrada." });
  const user = (req as any).user;
  if (!podeAcessarEmpresa(user, row.empresa_id)) return res.status(403).json({ error: "Sem acesso a esta empresa." });
  if (row.status !== "emitida") return res.status(400).json({ error: "Só é possível enviar uma NFS-e já emitida." });
  // Antes mandava sempre pros contatos do PRÓPRIO escritório (nunca pro tomador) — decisão de uma
  // sessão anterior. Revertido a pedido do usuário: descobriu ao vivo que o botão mandava pro
  // contato interno do escritório (ex.: "Load") em vez do cliente de verdade (ex.: Zatta), e pediu
  // pra sempre puxar do cadastro de contatos DA EMPRESA TOMADORA — mesmo cadastro de "Contatos e
  // documentos por cliente" em Configurações › E-mail corporativo. Junta os contatos de TODAS as
  // empresas com esse CNPJ/CPF (produtor rural tem uma inscrição por fazenda, mesmo CPF — o telefone
  // pode estar cadastrado só em uma delas). Sem nenhuma empresa-cliente com esse documento, cai pro
  // telefone avulso digitado na hora da emissão (tomador_telefone).
  const tomadorEmpresas = empresasClientePorDocumento(row.tomador_documento);
  let contatos = whatsappContatosDeEmpresas(tomadorEmpresas.map((e) => e.id));
  if (!contatos.length && row.tomador_telefone) contatos = [{ telefone: row.tomador_telefone }];
  if (!contatos.length) {
    return res.status(400).json({ error: 'O tomador desta nota não tem contato de WhatsApp cadastrado (marque "Receber WhatsApp" no contato dele, em Configurações › E-mail corporativo, ou cadastre a empresa em Empresas).' });
  }
  const { pdf, erro: erroPdf } = await nfseObterDanfsePdf(row);
  if (!pdf) return res.status(502).json({ error: erroPdf });
  const arquivo = { nome: nfseNomeArquivo(row, "pdf"), tipo: "application/pdf", buffer: pdf };
  const descricao = `NFS-e ${row.numero_nfse || row.numero_dps} — competência ${row.competencia?.slice(0, 7) || ""}`;
  let enviados = 0;
  const erros: string[] = [];
  for (const c of contatos) {
    try {
      await whatsappEnviarArquivo(
        user.escritorioId,
        c.telefone,
        [
          { nome: "empresa_nome", valor: row.tomador_nome || "" },
          { nome: "descricao", valor: descricao },
        ],
        arquivo,
        { tabela: "nfse_emissoes", id: row.id }
      );
      enviados++;
    } catch (e: any) {
      erros.push(e.message);
    }
  }
  if (enviados > 0) sqlite.prepare(`UPDATE nfse_emissoes SET whatsapp_enviado = 1, whatsapp_erro = NULL WHERE id = ?`).run(row.id);
  else sqlite.prepare(`UPDATE nfse_emissoes SET whatsapp_erro = ? WHERE id = ?`).run(erros[0] || "Falha desconhecida.", row.id);
  if (!enviados) {
    res.status(502).json({ error: erros[0] || "Não consegui enviar por WhatsApp." });
  } else {
    res.json({ ok: true, enviados, falhas: erros.length });
  }
});
// Download em lote — zip com XML e/ou PDF de várias emissões de uma vez (selecionadas na tela).
app.get("/api/nfse/emissoes/baixar-lote", blockCliente, requirePermissao("nfse", "visualizar"), async (req, res) => {
  const user = (req as any).user;
  const ids = String(req.query.ids || "")
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);
  if (!ids.length) return res.status(400).json({ error: "Selecione ao menos uma emissão." });
  const formato = req.query.formato === "pdf" ? "pdf" : req.query.formato === "ambos" ? "ambos" : "xml";
  const placeholders = ids.map(() => "?").join(",");
  const rows = sqlite.prepare(`SELECT * FROM nfse_emissoes WHERE id IN (${placeholders})`).all(...ids) as any[];
  const visiveis = empresasVisiveis(user);
  const permitidas = rows.filter((r) => podeAcessarEmpresa(user, r.empresa_id) && (visiveis === null || visiveis.includes(r.empresa_id)));
  if (!permitidas.length) return res.status(403).json({ error: "Sem acesso às emissões selecionadas." });

  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", `attachment; filename="nfse-lote-${new Date().toISOString().slice(0, 10)}.zip"`);
  const zip = archiver("zip", { zlib: { level: 9 } });
  zip.on("error", (e) => { if (!res.headersSent) res.status(500); res.end(); console.error("Erro ao gerar zip de NFS-e:", e); });
  zip.pipe(res);
  const usados = new Set<string>();
  const nomeUnico = (nome: string) => {
    let final = nome, i = 2;
    while (usados.has(final)) final = nome.replace(/(\.[^.]+)$/, ` (${i++})$1`);
    usados.add(final);
    return final;
  };
  for (const row of permitidas) {
    if (formato === "xml" || formato === "ambos") {
      const xml = row.xml_nfse || row.xml_dps;
      if (xml) zip.append(xml, { name: nomeUnico(nfseNomeArquivo(row, "xml")) });
    }
    if (formato === "pdf" || formato === "ambos") {
      try {
        const { pdf } = await nfseObterDanfsePdf(row);
        if (pdf) zip.append(pdf, { name: nomeUnico(nfseNomeArquivo(row, "pdf")) });
      } catch {
        // PDF de uma nota específica falhou — segue pras outras, não aborta o lote inteiro.
      }
    }
  }
  await zip.finalize();
});
const NFSE_MOTIVO_CANCELAMENTO_LABEL: Record<string, string> = { "1": "Erro na emissão", "2": "Serviço não prestado", "9": "Outros" };
// Depois de cancelar de verdade no Sistema Nacional NFS-e: anexa um aviso de cancelamento em Envio
// de Documentos, na MESMA competência da nota original — some ao lado dela, nunca a substitui, só
// pra manter rastreável que aquela nota existiu e foi cancelada depois — e avisa o cliente por
// e-mail. Não gera o DANFSe cancelado oficial (a API do governo que fazia isso foi desativada em
// 03/08/2026 — ver comentário em nfse.baixarDanfsePdf): isso aqui é um aviso interno simples, só com
// os dados do cancelamento, gerado localmente (mesmo motor de PDF já usado em Contratos).
async function nfseNotificarCancelamento(emissaoId: number) {
  const row = sqlite.prepare(`SELECT * FROM nfse_emissoes WHERE id = ?`).get(emissaoId) as any;
  if (!row) return;
  const prestador = sqlite.prepare(`SELECT nome, escritorio_id FROM empresas WHERE id = ?`).get(row.empresa_id) as any;
  const escritorioId = prestador?.escritorio_id ?? 1;
  // Acha a empresa-cliente (tomador) cadastrada internamente pelo CNPJ, pra saber onde anexar o
  // aviso e pra quem mandar o e-mail — nem toda NFS-e emitida tem isso (o tomador pode não ser uma
  // empresa-cliente cadastrada no sistema).
  const tomadorEmpresas = empresasClientePorDocumento(row.tomador_documento);
  // "tomadorEmpresa" (singular) só pra onde precisa de UMA: anexar o DANFSe cancelado na grade e
  // registrar o empresa_id no log de e-mail. Contatos (e-mail/WhatsApp) vêm de TODAS (ver helpers).
  const tomadorEmpresa = tomadorEmpresas[0] || null;

  const numero = row.numero_nfse || row.id;
  const dataCancelamento = row.cancelado_em ? String(row.cancelado_em).replace("T", " ").slice(0, 16) : "";
  const motivoLabel = NFSE_MOTIVO_CANCELAMENTO_LABEL[row.motivo_cancelamento] || row.motivo_cancelamento || "";
  // Anexa o próprio DANFSe (agora com a marca d'água "CANCELADA") em vez de um aviso à parte — é o
  // documento oficial de verdade, gerado localmente a partir do XML da emissão (ver src/danfse.ts).
  let pdf: Buffer | null = null;
  try {
    const r = await nfseObterDanfsePdf(row);
    pdf = r.pdf;
    if (!pdf) console.error("Não consegui gerar o DANFSe cancelado:", r.erro);
  } catch (e: any) {
    console.error("Não consegui gerar o DANFSe cancelado:", e.message);
  }
  const nomeArquivo = `NFS-e ${numero} CANCELADA.pdf`;

  if (tomadorEmpresas.length && pdf) {
    try {
      const config = sqlite.prepare(`SELECT envio_template_id FROM nfse_agendamento_config WHERE escritorio_id = ?`).get(escritorioId) as any;
      // Com o mesmo CPF em várias empresas (fazendas), anexa na primeira que tiver a atribuição
      // ativa do modelo de NFS-e — normalmente só uma delas está na rotina de Envio de Documentos.
      const alvo = config?.envio_template_id
        ? tomadorEmpresas
            .map((emp) => ({
              emp,
              atribuicao: sqlite.prepare(`SELECT * FROM envio_atribuicoes WHERE template_id = ? AND empresa_id = ? AND ativo = 1`).get(config.envio_template_id, emp.id) as any,
            }))
            .find((x) => x.atribuicao)
        : null;
      if (alvo) {
        const [anoStr, mesStr] = String(row.competencia).split("-");
        const ano = Number(anoStr);
        const mes = Number(mesStr);
        let periodo = sqlite.prepare(`SELECT * FROM envio_periodos WHERE atribuicao_id = ? AND ano = ? AND mes = ?`).get(alvo.atribuicao.id, ano, mes) as any;
        if (!periodo) {
          const info = sqlite.prepare(`INSERT INTO envio_periodos (atribuicao_id, ano, mes) VALUES (?, ?, ?)`).run(alvo.atribuicao.id, ano, mes);
          periodo = { id: Number(info.lastInsertRowid) };
        }
        const dir = path.join(UPLOADS_DIR, "envio", String(alvo.emp.id), String(periodo.id));
        fs.mkdirSync(dir, { recursive: true });
        const destino = path.join(dir, `${Date.now()}-${nomeArquivo}`);
        fs.writeFileSync(destino, pdf);
        sqlite
          .prepare(`INSERT INTO envio_documentos (periodo_id, file_name, file_path, mime, size_bytes, observacao) VALUES (?, ?, ?, 'application/pdf', ?, ?)`)
          .run(periodo.id, nomeArquivo, destino, pdf.length, `NFS-e nº ${numero} CANCELADA em ${dataCancelamento} — anexado só pra manter o histórico, a nota original acima continua sendo a válida até a data do cancelamento.`);
      }
    } catch (e: any) {
      console.error("Não consegui anexar o DANFSe cancelado em Envio de Documentos:", e.message);
    }
  }

  let destinatarios = emailContatosDeEmpresas(tomadorEmpresas.map((e) => e.id));
  if (!destinatarios.length && row.tomador_email) destinatarios = [row.tomador_email];
  if (destinatarios.length) {
    const assunto = `NFS-e nº ${numero} CANCELADA`;
    const corpo = `A Nota Fiscal de Serviço nº ${numero}, referente a "${row.descricao_servico || ""}", foi cancelada em ${dataCancelamento}.\n\nMotivo: ${motivoLabel}\nJustificativa: ${row.justificativa_cancelamento || ""}`;
    try {
      await enviarEmail(escritorioId, { to: destinatarios, subject: assunto, text: corpo, attachments: pdf ? [{ filename: nomeArquivo, content: pdf }] : [] });
      sqlite
        .prepare(`INSERT INTO emails_enviados (empresa_id, destinatarios, assunto, corpo, status) VALUES (?, ?, ?, ?, 'ok')`)
        .run(tomadorEmpresa?.id ?? null, destinatarios.join(", "), assunto, corpo);
    } catch (e: any) {
      sqlite
        .prepare(`INSERT INTO emails_enviados (empresa_id, destinatarios, assunto, corpo, status, erro) VALUES (?, ?, ?, ?, 'erro', ?)`)
        .run(tomadorEmpresa?.id ?? null, destinatarios.join(", "), assunto, corpo, e.message);
    }
  }

  // Achado ao vivo: cancelamento só mandava e-mail — WhatsApp nunca foi implementado aqui (só na
  // emissão normal, ver /api/nfse/emissoes/:id/enviar-whatsapp). Mesmo público do e-mail acima (o
  // tomador de verdade, não o escritório) — desde que o botão de "Enviar WhatsApp" da emissão normal
  // também passou a mandar pro tomador (mudança pedida pelo usuário, antes ia sempre pro escritório).
  if (pdf) {
    const contatosWhatsapp = whatsappContatosDeEmpresas(tomadorEmpresas.map((e) => e.id));
    const arquivo = { nome: nomeArquivo, tipo: "application/pdf", buffer: pdf };
    for (const c of contatosWhatsapp) {
      try {
        await whatsappEnviarArquivo(
          escritorioId,
          c.telefone,
          [
            { nome: "empresa_nome", valor: row.tomador_nome || "" },
            { nome: "descricao", valor: `NFS-e nº ${numero} CANCELADA` },
          ],
          arquivo,
          { tabela: "nfse_emissoes", id: row.id }
        );
      } catch (e: any) {
        console.error(`Não consegui avisar o cancelamento da NFS-e ${row.id} por WhatsApp (${c.telefone}):`, e.message);
      }
    }
  }
}
// Cancelamento — evento e101101, só é possível pra NFS-e já emitida (status 'emitida'). É uma ação
// real e definitiva no Sistema Nacional NFS-e, sem "desfazer" depois.
app.post("/api/nfse/emissoes/:id/cancelar", blockCliente, requirePermissao("nfse", "postar"), async (req, res) => {
  const row = sqlite.prepare(`SELECT * FROM nfse_emissoes WHERE id = ?`).get(Number(req.params.id)) as any;
  if (!row) return res.status(404).json({ error: "Emissão não encontrada." });
  const user = (req as any).user;
  if (!podeAcessarEmpresa(user, row.empresa_id)) return res.status(403).json({ error: "Sem acesso a esta empresa." });
  if (row.status !== "emitida") return res.status(409).json({ error: "Só é possível cancelar uma NFS-e que já foi emitida." });
  if (!row.chave_acesso) return res.status(400).json({ error: "Esta emissão não tem chave de acesso." });
  const { motivo, justificativa } = req.body || {};
  if (!["1", "2", "9"].includes(motivo)) return res.status(400).json({ error: "Selecione o motivo do cancelamento." });
  if (!justificativa || String(justificativa).trim().length < 15) return res.status(400).json({ error: "A justificativa precisa ter pelo menos 15 caracteres." });

  const empresa = sqlite.prepare(`SELECT cnpj FROM empresas WHERE id = ?`).get(row.empresa_id) as any;
  const config = sqlite.prepare(`SELECT metodo_assinatura FROM nfse_empresa_config WHERE empresa_id = ?`).get(row.empresa_id) as any;
  let cert: nfse.CertificadoInfo;
  try {
    ({ cert } = nfseCertificadoParaEmpresa(row.empresa_id, config?.metodo_assinatura));
  } catch (e: any) {
    return res.status(400).json({ error: e.message });
  }
  try {
    const r = await nfse.cancelarNfse(
      { ambiente: row.ambiente, chaveAcesso: row.chave_acesso, cnpjAutor: (empresa?.cnpj || "").replace(/\D/g, ""), motivo, xMotivo: String(justificativa).trim() },
      cert
    );
    if (!r.resposta.ok) return res.status(422).json({ error: `O Sistema Nacional NFS-e rejeitou o cancelamento: ${r.mensagemErro}` });
    sqlite
      .prepare(`UPDATE nfse_emissoes SET status='cancelada', motivo_cancelamento=?, justificativa_cancelamento=?, cancelado_em=datetime('now'), danfse_path=NULL WHERE id=?`)
      .run(motivo, String(justificativa).trim(), row.id);
    // O recebível gerado por essa nota fica marcado como cancelado, não é apagado — quem vê o
    // Financeiro continua tendo o histórico completo, só que sinalizado como não mais válido.
    sqlite.prepare(`UPDATE financeiro_receber SET status='cancelado' WHERE nfse_emissao_id = ?`).run(row.id);
    await nfseNotificarCancelamento(row.id);
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});
// Reenvia o aviso de cancelamento (e-mail + WhatsApp) sem cancelar de novo — útil pra quando o aviso
// não chegou na hora (ex.: bug corrigido depois do fato, contato cadastrado depois) ou o usuário só
// quer garantir que o cliente foi avisado. Só faz sentido pra quem já está cancelada de verdade.
app.post("/api/nfse/emissoes/:id/reenviar-cancelamento", blockCliente, requirePermissao("nfse", "editar"), async (req, res) => {
  const row = sqlite.prepare(`SELECT * FROM nfse_emissoes WHERE id = ?`).get(Number(req.params.id)) as any;
  if (!row) return res.status(404).json({ error: "Emissão não encontrada." });
  const user = (req as any).user;
  if (!podeAcessarEmpresa(user, row.empresa_id)) return res.status(403).json({ error: "Sem acesso a esta empresa." });
  if (row.status !== "cancelada") return res.status(400).json({ error: "Só é possível reenviar o aviso de uma NFS-e já cancelada." });
  try {
    await nfseNotificarCancelamento(row.id);
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// Faixa 80.000-89.999 é reservada ao Emissor Web do próprio governo (confirmado no manual oficial,
// guia-emissorpubliconacionalweb); quem emite via API/webservice com certificado próprio (nosso
// caso) precisa usar uma série fora dessa faixa — testado contra o ambiente real (E0010 corrigido).
const NFSE_SERIE = 1;

// Monta os dados de serviço da DPS a partir do modelo — os valores de retenção federal (IRRF,
// CSLL, PIS, COFINS, contribuição previdenciária) são calculados aplicando o percentual
// configurado no modelo sobre o valor do serviço desta emissão específica.
function nfseServicoDoModelo(modelo: any, descricao: string, valor: number, competencia: string): nfse.DadosServico {
  const calc = (pct: number | null) => (pct != null ? Number(((valor * pct) / 100).toFixed(2)) : null);
  return {
    codigoTributacaoNacional: modelo.codigo_tributacao_nacional,
    codigoTributacaoMunicipal: modelo.codigo_tributacao_municipal || null,
    codigoNbs: modelo.codigo_nbs || null,
    descricao,
    valor,
    competencia,
    tribIssqn: modelo.trib_issqn,
    tipoRetencaoIssqn: modelo.tipo_retencao_issqn,
    aliquotaIssqn: modelo.aliquota_issqn != null ? Number(modelo.aliquota_issqn) : null,
    tipoRetencaoPisCofins: modelo.tipo_retencao_pis_cofins != null ? Number(modelo.tipo_retencao_pis_cofins) : null,
    issqnExigibilidadeSuspensa: !!modelo.issqn_exigibilidade_suspensa,
    issqnMotivoSuspensao: modelo.issqn_motivo_suspensao,
    issqnNumeroProcesso: modelo.issqn_numero_processo || null,
    beneficioMunicipalCodigo: modelo.beneficio_municipal_codigo || null,
    pisCofinsCst: modelo.pis_cofins_cst || "00",
    valorIrrf: calc(modelo.percentual_irrf),
    valorCsll: calc(modelo.percentual_csll),
    valorCofinsRetido: calc(modelo.percentual_cofins_retido),
    valorPisRetido: calc(modelo.percentual_pis_retido),
    valorContribPrevidenciaria: calc(modelo.percentual_contrib_previdenciaria),
    ibscbsPreencher: !!modelo.ibscbs_preencher,
    ibscbsCst: modelo.ibscbs_cst || "000",
    ibscbsCclasstrib: modelo.ibscbs_cclasstrib || "000001",
    docResponsabilidadeTecnica: modelo.doc_responsabilidade_tecnica || null,
    docReferencia: modelo.doc_referencia || null,
    informacoesComplementares: modelo.informacoes_complementares || null,
  };
}
// Valida o corpo comum de emissão/rascunho (empresa, modelo, tomador, serviço) e devolve tudo já
// carregado do banco — usado tanto por /emitir quanto por /rascunhos.
function nfseValidarEntrada(user: any, body: any): { erro: string; status?: number } | { empresaId: number; modelo: any; tomador: any; servico: any } {
  const { empresaId, modeloId, tomador, servico } = body || {};
  if (!empresaId) return { erro: "Selecione a empresa." };
  if (!podeAcessarEmpresa(user, Number(empresaId))) return { erro: "Sem acesso a esta empresa.", status: 403 };
  if (!modeloId) return { erro: "Selecione o modelo de serviço." };
  if (!tomador?.documento || !tomador?.nome) return { erro: "Informe o documento (CPF/CNPJ) e o nome do tomador do serviço." };
  if (!servico?.descricao || !servico?.valor || !servico?.competencia) {
    return { erro: "Preencha a descrição, o valor e a competência do serviço." };
  }
  // empresa_id IS NULL cobre os modelos internos do escritório (usáveis por qualquer empresa da
  // carteira dele, mas só do MESMO escritório — senão um admin de outro escritório poderia usar o
  // modelo/tributação interna de outro); um valor precisa bater com a própria empresa — impede que
  // uma empresa-cliente self-service force o modeloId de outra empresa (ou vice-versa) na requisição.
  const modelo = sqlite
    .prepare(`SELECT * FROM nfse_modelos WHERE id = ? AND ativo = 1 AND ((empresa_id IS NULL AND escritorio_id = ?) OR empresa_id = ?)`)
    .get(Number(modeloId), user.escritorioId, Number(empresaId)) as any;
  if (!modelo) return { erro: "Modelo de serviço não encontrado ou inativo.", status: 404 };
  // Modelo interno do escritório: se essa empresa tiver uma lista de modelos liberados configurada
  // (nfse_empresa_modelos não-vazia), só pode emitir com um modelo dessa lista — reforça no servidor
  // a mesma restrição que o dropdown já aplica, pra não bastar montar a requisição na mão pra
  // contornar. Lista vazia = sem restrição, todo modelo do escritório disponível (padrão de sempre).
  // Não se aplica a modelo próprio da empresa-cliente self-service (empresa_id preenchido).
  if (modelo.empresa_id === null) {
    const restritos = sqlite.prepare(`SELECT 1 FROM nfse_empresa_modelos WHERE empresa_id = ?`).all(Number(empresaId)) as any[];
    if (restritos.length) {
      const permitido = sqlite
        .prepare(`SELECT 1 FROM nfse_empresa_modelos WHERE empresa_id = ? AND modelo_id = ?`)
        .get(Number(empresaId), modelo.id);
      if (!permitido) return { erro: "Este modelo de serviço não está liberado para esta empresa.", status: 403 };
    }
  }
  return { empresaId: Number(empresaId), modelo, tomador, servico };
}
// Insere a linha em nfse_emissoes (rascunho ou pendente-pra-emitir-na-hora) e devolve o id.
// numero_dps recebe um placeholder negativo (menor que qualquer numero_dps já usado pra essa
// empresa/série) calculado na própria inserção — nunca colide com outro rascunho/pendente
// pendurado nem com um número de DPS real, que é sempre positivo.
function nfseInserirEmissao(user: any, empresaId: number, modelo: any, tomador: any, servico: any, status: "rascunho" | "pendente"): number {
  const info = sqlite
    .prepare(
      `INSERT INTO nfse_emissoes (empresa_id, serie, numero_dps, ambiente, modelo_id, modelo_nome,
         tomador_documento, tomador_nome, tomador_email, tomador_telefone, tomador_cep, tomador_logradouro, tomador_numero, tomador_complemento, tomador_bairro, tomador_codigo_municipio,
         codigo_tributacao_nacional, descricao_servico, valor_servico, competencia, status, criado_por)
       VALUES (?, ${NFSE_SERIE}, (SELECT COALESCE(MIN(numero_dps), 0) - 1 FROM nfse_emissoes WHERE empresa_id = ? AND serie = ${NFSE_SERIE}), 'producao', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      empresaId,
      empresaId,
      modelo.id,
      modelo.nome,
      String(tomador.documento).replace(/\D/g, ""),
      String(tomador.nome).trim(),
      tomador.email || null,
      tomador.telefone ? String(tomador.telefone).replace(/\D/g, "") : null,
      tomador.cep || null,
      tomador.logradouro || null,
      tomador.numero || null,
      tomador.complemento || null,
      tomador.bairro || null,
      tomador.codigoMunicipio || null,
      modelo.codigo_tributacao_nacional,
      String(servico.descricao).trim(),
      Number(servico.valor),
      String(servico.competencia),
      status,
      user.id
    );
  return Number(info.lastInsertRowid);
}
// Transmite de verdade uma linha já existente (rascunho ou recém-criada) — assina e envia ao ADN,
// atualizando a linha com o resultado. Usado tanto pela emissão direta quanto por "Emitir" a
// partir de um rascunho salvo.
async function nfseTransmitirEmissao(emissaoId: number, empresaId: number, modelo: any, tomador: any, servico: any, res: any) {
  // Falhas de validação (antes de tentar transmitir) também marcam a linha como 'erro' — assim ela
  // não fica presa em 'pendente' pra sempre e continua editável/reemitível como um rascunho normal.
  const falhaValidacao = (msg: string) => {
    sqlite.prepare(`UPDATE nfse_emissoes SET status='erro', erro=? WHERE id=?`).run(msg, emissaoId);
    return res.status(400).json({ error: msg, emissaoId });
  };
  // Código do município e inscrição municipal vêm preferencialmente do próprio cadastro da empresa
  // (código_municipio_ibge/inscricao_municipal em `empresas`) — nfse_empresa_config só ainda tem
  // valor próprio pra empresa que configurou via autoatendimento (perfil Cliente, minha-empresa).
  const config = sqlite
    .prepare(
      `SELECT c.*, e.codigo_municipio_ibge as emp_codigo_municipio, e.nome_municipio_ibge as emp_nome_municipio, e.inscricao_municipal as emp_inscricao_municipal
       FROM nfse_empresa_config c JOIN empresas e ON e.id = c.empresa_id WHERE c.empresa_id = ?`
    )
    .get(empresaId) as any;
  if (!config || !config.habilitado) return falhaValidacao("Módulo NFS-e não está habilitado para esta empresa.");
  const codigoMunicipioPrestador = config.codigo_municipio || config.emp_codigo_municipio;
  const inscricaoMunicipalPrestador = config.inscricao_municipal || config.emp_inscricao_municipal;
  if (!codigoMunicipioPrestador) return falhaValidacao("Preencha o código do município (IBGE) da empresa antes de emitir.");
  if (config.opcao_simples_nacional && config.percentual_total_tributos_sn == null) {
    return falhaValidacao('Preencha o "% total de tributos (Simples Nacional)" da empresa em Empresas › Configurações antes de emitir — obrigatório pra optante ME/EPP.');
  }

  let cert: nfse.CertificadoInfo, cnpjPrestador: string;
  try {
    ({ cert, cnpjPrestador } = nfseCertificadoParaEmpresa(empresaId, config.metodo_assinatura));
  } catch (e: any) {
    return falhaValidacao(e.message);
  }
  if (!cnpjPrestador) return falhaValidacao("Esta empresa não tem CNPJ cadastrado — preencha em Empresas antes de emitir.");
  const empresaContato = sqlite.prepare(`SELECT telefone, email FROM empresas WHERE id = ?`).get(empresaId) as any;

  const documentoTomador = String(tomador.documento).replace(/\D/g, "");
  // Produção real — cada emissão a partir daqui gera uma NFS-e com efeito fiscal de verdade.
  // Confirmado com o convênio oficial (adn.nfse.gov.br/parametrizacao) que os municípios da
  // carteira do escritório aderiram ao Emissor Nacional em produção (mesmo quando o ambiente de
  // testes ainda não reflete isso).
  const ambiente: nfse.AmbienteNfse = "producao";
  const serie = NFSE_SERIE;
  const ultimo = sqlite.prepare(`SELECT MAX(numero_dps) as m FROM nfse_emissoes WHERE empresa_id = ? AND serie = ? AND numero_dps > 0`).get(empresaId, serie) as any;
  const numeroDps = (ultimo?.m || 0) + 1;
  sqlite.prepare(`UPDATE nfse_emissoes SET numero_dps = ?, ambiente = ?, status = 'pendente' WHERE id = ?`).run(numeroDps, ambiente, emissaoId);

  try {
    const { xmlAssinado, resposta, chaveAcesso, xmlNfse, mensagemErro } = await nfse.emitirDps(
      {
        ambiente,
        serie,
        numeroDps,
        prestador: {
          cnpj: cnpjPrestador,
          inscricaoMunicipal: inscricaoMunicipalPrestador || null,
          codigoMunicipio: codigoMunicipioPrestador,
          opcaoSimplesNacional: !!config.opcao_simples_nacional,
          regimeEspecialTrib: config.regime_especial_trib || 0,
          regimeApuracaoSn: config.regime_apuracao_sn || "1",
          percentualTotalTributosSn: config.percentual_total_tributos_sn != null ? Number(config.percentual_total_tributos_sn) : null,
          telefone: empresaContato?.telefone || null,
          email: empresaContato?.email || null,
        },
        tomador: {
          documento: documentoTomador,
          nome: String(tomador.nome).trim(),
          email: tomador.email || null,
          cep: tomador.cep || null,
          logradouro: tomador.logradouro || null,
          numero: tomador.numero || null,
          complemento: tomador.complemento || null,
          bairro: tomador.bairro || null,
          codigoMunicipio: tomador.codigoMunicipio || null,
        },
        servico: nfseServicoDoModelo(modelo, String(servico.descricao).trim(), Number(servico.valor), String(servico.competencia)),
      },
      cert
    );
    const status = resposta.ok ? "emitida" : "rejeitada";
    const numeroNfse = xmlNfse ? (xmlNfse.match(/<nNFSe>([^<]+)<\/nNFSe>/)?.[1] ?? null) : null;
    sqlite
      .prepare(`UPDATE nfse_emissoes SET status=?, xml_dps=?, xml_nfse=?, chave_acesso=?, numero_nfse=?, erro=? WHERE id=?`)
      .run(status, xmlAssinado, xmlNfse, chaveAcesso, numeroNfse, resposta.ok ? null : (mensagemErro || "").slice(0, 4000), emissaoId);
    if (!resposta.ok) return res.status(422).json({ error: `O Sistema Nacional NFS-e rejeitou a emissão: ${mensagemErro}`, detalhe: mensagemErro, emissaoId });
    res.json({ ok: true, emissaoId, chaveAcesso });
  } catch (e: any) {
    sqlite.prepare(`UPDATE nfse_emissoes SET status='erro', erro=? WHERE id=?`).run(e.message, emissaoId);
    res.status(500).json({ error: e.message, emissaoId });
  }
}
app.post("/api/nfse/emitir", blockCliente, requirePermissao("nfse", "postar"), async (req, res) => {
  const user = (req as any).user;
  const v = nfseValidarEntrada(user, req.body);
  if ("erro" in v) return res.status(v.status || 400).json({ error: v.erro });
  const emissaoId = nfseInserirEmissao(user, v.empresaId, v.modelo, v.tomador, v.servico, "pendente");
  await nfseTransmitirEmissao(emissaoId, v.empresaId, v.modelo, v.tomador, v.servico, res);
});
// Rascunhos — salva os dados preenchidos sem transmitir ao governo. O usuário pode continuar
// depois ("Emitir" a partir do rascunho) ou usar como base pra "Duplicar" outra emissão.
app.post("/api/nfse/rascunhos", blockCliente, requirePermissao("nfse", "postar"), (req, res) => {
  const user = (req as any).user;
  const v = nfseValidarEntrada(user, req.body);
  if ("erro" in v) return res.status(v.status || 400).json({ error: v.erro });
  const emissaoId = nfseInserirEmissao(user, v.empresaId, v.modelo, v.tomador, v.servico, "rascunho");
  res.json({ id: emissaoId });
});
app.put("/api/nfse/rascunhos/:id", blockCliente, requirePermissao("nfse", "postar"), (req, res) => {
  const user = (req as any).user;
  const existente = sqlite.prepare(`SELECT * FROM nfse_emissoes WHERE id = ?`).get(Number(req.params.id)) as any;
  if (!existente) return res.status(404).json({ error: "Rascunho não encontrado." });
  if (!["rascunho", "rejeitada", "erro"].includes(existente.status)) return res.status(409).json({ error: "Esta emissão já foi transmitida e não pode ser editada." });
  if (!podeAcessarEmpresa(user, existente.empresa_id)) return res.status(403).json({ error: "Sem acesso a esta empresa." });
  const v = nfseValidarEntrada(user, req.body);
  if ("erro" in v) return res.status(v.status || 400).json({ error: v.erro });
  sqlite
    .prepare(
      `UPDATE nfse_emissoes SET modelo_id=?, modelo_nome=?, tomador_documento=?, tomador_nome=?, tomador_email=?, tomador_telefone=?, tomador_cep=?, tomador_logradouro=?, tomador_numero=?, tomador_complemento=?, tomador_bairro=?, tomador_codigo_municipio=?, codigo_tributacao_nacional=?, descricao_servico=?, valor_servico=?, competencia=?, status='rascunho', erro=NULL WHERE id=?`
    )
    .run(
      v.modelo.id,
      v.modelo.nome,
      String(v.tomador.documento).replace(/\D/g, ""),
      String(v.tomador.nome).trim(),
      v.tomador.email || null,
      v.tomador.telefone ? String(v.tomador.telefone).replace(/\D/g, "") : null,
      v.tomador.cep || null,
      v.tomador.logradouro || null,
      v.tomador.numero || null,
      v.tomador.complemento || null,
      v.tomador.bairro || null,
      v.tomador.codigoMunicipio || null,
      v.modelo.codigo_tributacao_nacional,
      String(v.servico.descricao).trim(),
      Number(v.servico.valor),
      String(v.servico.competencia),
      existente.id
    );
  res.json({ ok: true });
});
app.post("/api/nfse/rascunhos/:id/emitir", blockCliente, requirePermissao("nfse", "postar"), async (req, res) => {
  const user = (req as any).user;
  const existente = sqlite.prepare(`SELECT * FROM nfse_emissoes WHERE id = ?`).get(Number(req.params.id)) as any;
  if (!existente) return res.status(404).json({ error: "Rascunho não encontrado." });
  if (!["rascunho", "rejeitada", "erro"].includes(existente.status)) return res.status(409).json({ error: "Esta emissão já foi transmitida." });
  if (!podeAcessarEmpresa(user, existente.empresa_id)) return res.status(403).json({ error: "Sem acesso a esta empresa." });
  if (!existente.modelo_id) return res.status(400).json({ error: "Este rascunho não tem um modelo de serviço válido — edite antes de emitir." });
  const modelo = sqlite.prepare(`SELECT * FROM nfse_modelos WHERE id = ? AND ativo = 1`).get(existente.modelo_id) as any;
  if (!modelo) return res.status(404).json({ error: "O modelo de serviço deste rascunho não existe mais ou está inativo." });
  const tomador = {
    documento: existente.tomador_documento,
    nome: existente.tomador_nome,
    email: existente.tomador_email,
    telefone: existente.tomador_telefone,
    cep: existente.tomador_cep,
    logradouro: existente.tomador_logradouro,
    numero: existente.tomador_numero,
    complemento: existente.tomador_complemento,
    bairro: existente.tomador_bairro,
    codigoMunicipio: existente.tomador_codigo_municipio,
  };
  const servico = { descricao: existente.descricao_servico, valor: existente.valor_servico, competencia: existente.competencia };
  await nfseTransmitirEmissao(existente.id, existente.empresa_id, modelo, tomador, servico, res);
});
app.delete("/api/nfse/emissoes/:id", blockCliente, requirePermissao("nfse", "editar"), (req, res) => {
  const user = (req as any).user;
  const row = sqlite.prepare(`SELECT * FROM nfse_emissoes WHERE id = ?`).get(Number(req.params.id)) as any;
  if (!row) return res.status(404).json({ error: "Registro não encontrado." });
  if (!podeAcessarEmpresa(user, row.empresa_id)) return res.status(403).json({ error: "Sem acesso a esta empresa." });
  if (row.status !== "rascunho") return res.status(409).json({ error: "Só é possível excluir rascunhos — emissões já transmitidas ficam no histórico." });
  sqlite.prepare(`DELETE FROM nfse_emissoes WHERE id = ?`).run(row.id);
  res.json({ ok: true });
});

// ---------- NFS-e self-service (perfil Cliente — empresa emite pra si mesma) ----------
// Todas as rotas abaixo são escritas do zero (não reaproveitam blockCliente/requirePermissao) e
// usam exclusivamente user.empresaId (nunca um empresaId vindo do corpo/query) — é a garantia de
// isolamento entre empresas-cliente diferentes. Reaproveitam as funções puras já existentes
// (nfseValidarEntrada, nfseInserirEmissao, nfseTransmitirEmissao, nfseObterDanfsePdf etc.), só
// mudando a camada de autorização.
function requireCliente(req: express.Request, res: express.Response, next: express.NextFunction) {
  const user = (req as any).user;
  if (user?.perfil !== "Cliente" || !user.empresaId) return res.status(403).json({ error: "Rota exclusiva para empresas-cliente." });
  next();
}
// Teste grátis de 3 dias (prorrogável manualmente pelo admin) ou assinatura paga em dia — sem
// nenhum dos dois, a empresa-cliente não acessa aquele módulo específico (as demais telas do
// Cliente, como Meus Documentos, não passam por aqui — só NFS-e e Financeiro, que são pagos).
function empresaTemAcessoModulo(empresaId: number, chave: string): boolean {
  const empresa = sqlite.prepare(`SELECT isento_assinatura FROM empresas WHERE id = ?`).get(empresaId) as any;
  if (empresa?.isento_assinatura) return true;
  const row = sqlite.prepare(`SELECT assinatura_ativa_ate, trial_fim FROM empresa_modulos WHERE empresa_id = ? AND modulo_chave = ?`).get(empresaId, chave) as any;
  if (!row) return false;
  const agora = new Date().toISOString().replace("T", " ").slice(0, 19);
  if (row.assinatura_ativa_ate && agora <= row.assinatura_ativa_ate) return true;
  return agora <= row.trial_fim;
}
function requireModuloAtivo(chave: string) {
  return (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const user = (req as any).user;
    if (!empresaTemAcessoModulo(user.empresaId, chave)) {
      return res.status(402).json({ error: "Módulo não contratado ou período de teste/assinatura vencido.", bloqueado: true, modulo: chave });
    }
    next();
  };
}
app.get("/api/nfse/minha-empresa", requireCliente, requireModuloAtivo('nfse'), (req, res) => {
  const empresaId = (req as any).user.empresaId;
  const row = sqlite
    .prepare(
      `SELECT c.habilitado, c.metodo_assinatura as metodoAssinatura, c.codigo_municipio as codigoMunicipio, c.nome_municipio as nomeMunicipio,
              c.inscricao_municipal as inscricaoMunicipal, c.opcao_simples_nacional as opcaoSimplesNacional,
              c.regime_especial_trib as regimeEspecialTrib, c.regime_apuracao_sn as regimeApuracaoSn, c.percentual_total_tributos_sn as percentualTotalTributosSn,
              ((SELECT 1 FROM nfe_busca_config nb WHERE nb.empresa_id = e.id) IS NOT NULL
                OR (SELECT 1 FROM nfse_certificados nc WHERE nc.empresa_id = e.id) IS NOT NULL) as temCertificadoProprio,
              e.nome as empresaNome, e.cnpj
       FROM empresas e LEFT JOIN nfse_empresa_config c ON c.empresa_id = e.id WHERE e.id = ?`
    )
    .get(empresaId) as any;
  if (!row) return res.status(404).json({ error: "Empresa não encontrada." });
  res.json({ ...row, habilitado: !!row.habilitado, opcaoSimplesNacional: !!row.opcaoSimplesNacional, temCertificadoProprio: !!row.temCertificadoProprio });
});
app.put("/api/nfse/minha-empresa", requireCliente, requireModuloAtivo('nfse'), (req, res) => {
  const empresaId = (req as any).user.empresaId;
  const atual = sqlite.prepare(`SELECT habilitado FROM nfse_empresa_config WHERE empresa_id = ?`).get(empresaId) as any;
  if (!atual || !atual.habilitado) return res.status(403).json({ error: "Seu acesso ao módulo NFS-e ainda não foi liberado — entre em contato com o suporte." });
  const { codigoMunicipio, nomeMunicipio, inscricaoMunicipal, opcaoSimplesNacional, regimeEspecialTrib, regimeApuracaoSn, percentualTotalTributosSn } = req.body || {};
  sqlite
    .prepare(
      `UPDATE nfse_empresa_config SET metodo_assinatura='certificado_proprio', codigo_municipio=?, nome_municipio=?, inscricao_municipal=?,
         opcao_simples_nacional=?, regime_especial_trib=?, regime_apuracao_sn=?, percentual_total_tributos_sn=?, updated_at=datetime('now')
       WHERE empresa_id=?`
    )
    .run(
      codigoMunicipio || null,
      nomeMunicipio || null,
      inscricaoMunicipal || null,
      opcaoSimplesNacional === false ? 0 : 1,
      Number(regimeEspecialTrib) || 0,
      ["1", "2", "3"].includes(regimeApuracaoSn) ? regimeApuracaoSn : "1",
      percentualTotalTributosSn != null && percentualTotalTributosSn !== "" ? Number(percentualTotalTributosSn) : null,
      empresaId
    );
  res.json({ ok: true });
});
app.post("/api/nfse/minha-empresa/certificado", requireCliente, requireModuloAtivo('nfse'), upload.single("arquivo"), (req, res) => {
  const user = (req as any).user;
  const empresaId = user.empresaId;
  if (!req.file) return res.status(400).json({ error: "Selecione o arquivo .pfx." });
  const { senha } = req.body || {};
  if (!senha) return res.status(400).json({ error: "Informe a senha do certificado." });
  let info: nfse.CertificadoInfo;
  try {
    info = nfse.lerCertificadoPfx(req.file.buffer, senha);
  } catch (e: any) {
    return res.status(400).json({ error: e.message });
  }
  const existente = sqlite.prepare(`SELECT * FROM nfse_certificados WHERE empresa_id = ?`).get(empresaId) as any;
  const arquivoPath = nfse.salvarCertificadoCifrado(req.file.buffer, req.file.originalname);
  const senhaCifrada = nfse.cifrarTexto(senha);
  const validadeIso = info.validadeAte ? info.validadeAte.toISOString() : null;
  if (existente) {
    nfse.excluirCertificadoDoDisco(existente.arquivo_path);
    sqlite
      .prepare(`UPDATE nfse_certificados SET arquivo_path=?, senha_cifrada=?, titular=?, cnpj_certificado=?, validade_ate=?, criado_por=?, criado_em=datetime('now') WHERE id=?`)
      .run(arquivoPath, senhaCifrada, info.titular, info.cnpjCertificado, validadeIso, user.id, existente.id);
  } else {
    const empresaEscritorio = sqlite.prepare(`SELECT escritorio_id FROM empresas WHERE id = ?`).get(empresaId) as any;
    sqlite
      .prepare(`INSERT INTO nfse_certificados (empresa_id, arquivo_path, senha_cifrada, titular, cnpj_certificado, validade_ate, criado_por, escritorio_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(empresaId, arquivoPath, senhaCifrada, info.titular, info.cnpjCertificado, validadeIso, user.id, empresaEscritorio?.escritorio_id ?? null);
  }
  res.json({ ok: true, titular: info.titular, cnpjCertificado: info.cnpjCertificado, validadeAte: validadeIso });
});
app.get("/api/nfse/minha-empresa/modelos", requireCliente, requireModuloAtivo('nfse'), (req, res) => {
  const empresaId = (req as any).user.empresaId;
  const rows = sqlite.prepare(`SELECT * FROM nfse_modelos WHERE empresa_id = ? ORDER BY nome`).all(empresaId) as any[];
  res.json({ items: rows.map(nfseModeloParaJson) });
});
app.post("/api/nfse/minha-empresa/modelos", requireCliente, requireModuloAtivo('nfse'), (req, res) => {
  const user = (req as any).user;
  const v = nfseModeloDoBody(req.body || {}, null);
  if (!v.nome || !v.codigoTributacaoNacional) return res.status(400).json({ error: "Informe o nome e o código de tributação nacional." });
  const empresaEscritorio = sqlite.prepare(`SELECT escritorio_id FROM empresas WHERE id = ?`).get(user.empresaId) as any;
  const info = nfseInserirModelo(user.empresaId, empresaEscritorio?.escritorio_id ?? null, v, user.id);
  res.json({ id: Number(info.lastInsertRowid) });
});
app.put("/api/nfse/minha-empresa/modelos/:id", requireCliente, requireModuloAtivo('nfse'), (req, res) => {
  const user = (req as any).user;
  const id = Number(req.params.id);
  const existing = sqlite.prepare(`SELECT * FROM nfse_modelos WHERE id = ? AND empresa_id = ?`).get(id, user.empresaId) as any;
  if (!existing) return res.status(404).json({ error: "Modelo não encontrado." });
  const v = nfseModeloDoBody(req.body || {}, existing);
  nfseAtualizarModelo(id, v);
  res.json({ ok: true });
});
app.delete("/api/nfse/minha-empresa/modelos/:id", requireCliente, requireModuloAtivo('nfse'), (req, res) => {
  const user = (req as any).user;
  sqlite.prepare(`DELETE FROM nfse_modelos WHERE id = ? AND empresa_id = ?`).run(Number(req.params.id), user.empresaId);
  res.json({ ok: true });
});
app.get("/api/nfse/minha-empresa/emissoes", requireCliente, requireModuloAtivo('nfse'), (req, res) => {
  const empresaId = (req as any).user.empresaId;
  const dataDe = typeof req.query.dataDe === "string" && req.query.dataDe ? req.query.dataDe : null;
  const dataAte = typeof req.query.dataAte === "string" && req.query.dataAte ? req.query.dataAte : null;
  let sql = `SELECT n.id, n.empresa_id as empresaId, n.serie, n.numero_dps as numeroDps, n.ambiente,
                    n.modelo_id as modeloId, n.modelo_nome as modeloNome,
                    n.tomador_documento as tomadorDocumento, n.tomador_nome as tomadorNome, n.tomador_email as tomadorEmail,
                    n.tomador_cep as tomadorCep, n.tomador_logradouro as tomadorLogradouro, n.tomador_numero as tomadorNumero,
                    n.tomador_complemento as tomadorComplemento, n.tomador_bairro as tomadorBairro, n.tomador_codigo_municipio as tomadorCodigoMunicipio,
                    n.descricao_servico as descricaoServico, n.valor_servico as valorServico, n.competencia,
                    n.status, n.chave_acesso as chaveAcesso, n.numero_nfse as numeroNfse, n.erro, n.criado_em as criadoEm
             FROM nfse_emissoes n WHERE n.empresa_id = ?`;
  const params: any[] = [empresaId];
  if (dataDe) { sql += ` AND date(n.criado_em) >= date(?)`; params.push(dataDe); }
  if (dataAte) { sql += ` AND date(n.criado_em) <= date(?)`; params.push(dataAte); }
  sql += ` ORDER BY n.criado_em DESC, n.id DESC`;
  res.json({ items: sqlite.prepare(sql).all(...params) });
});
app.get("/api/nfse/minha-empresa/emissoes/:id/xml", requireCliente, requireModuloAtivo('nfse'), (req, res) => {
  const user = (req as any).user;
  const row = sqlite.prepare(`SELECT * FROM nfse_emissoes WHERE id = ? AND empresa_id = ?`).get(Number(req.params.id), user.empresaId) as any;
  if (!row) return res.status(404).json({ error: "Emissão não encontrada." });
  const xml = row.xml_nfse || row.xml_dps;
  if (!xml) return res.status(404).json({ error: "Nenhum XML disponível para esta emissão." });
  res.setHeader("Content-Type", "application/xml");
  res.setHeader("Content-Disposition", nfseContentDisposition("attachment", nfseNomeArquivo(row, "xml")));
  res.send(xml);
});
app.get("/api/nfse/minha-empresa/emissoes/:id/danfse", requireCliente, requireModuloAtivo('nfse'), async (req, res) => {
  const user = (req as any).user;
  const row = sqlite.prepare(`SELECT * FROM nfse_emissoes WHERE id = ? AND empresa_id = ?`).get(Number(req.params.id), user.empresaId) as any;
  if (!row) return res.status(404).json({ error: "Emissão não encontrada." });
  try {
    const { pdf, erro } = await nfseObterDanfsePdf(row);
    if (!pdf) return res.status(502).json({ error: erro });
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", nfseContentDisposition("inline", nfseNomeArquivo(row, "pdf")));
    res.send(pdf);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});
app.get("/api/nfse/minha-empresa/baixar-lote", requireCliente, requireModuloAtivo('nfse'), async (req, res) => {
  const empresaId = (req as any).user.empresaId;
  const ids = String(req.query.ids || "")
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);
  if (!ids.length) return res.status(400).json({ error: "Selecione ao menos uma emissão." });
  const formato = req.query.formato === "pdf" ? "pdf" : req.query.formato === "ambos" ? "ambos" : "xml";
  const placeholders = ids.map(() => "?").join(",");
  const rows = sqlite.prepare(`SELECT * FROM nfse_emissoes WHERE id IN (${placeholders}) AND empresa_id = ?`).all(...ids, empresaId) as any[];
  if (!rows.length) return res.status(404).json({ error: "Nenhuma emissão encontrada." });

  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", `attachment; filename="nfse-lote-${new Date().toISOString().slice(0, 10)}.zip"`);
  const zip = archiver("zip", { zlib: { level: 9 } });
  zip.on("error", (e) => { if (!res.headersSent) res.status(500); res.end(); console.error("Erro ao gerar zip de NFS-e:", e); });
  zip.pipe(res);
  const usados = new Set<string>();
  const nomeUnico = (nome: string) => {
    let final = nome, i = 2;
    while (usados.has(final)) final = nome.replace(/(\.[^.]+)$/, ` (${i++})$1`);
    usados.add(final);
    return final;
  };
  for (const row of rows) {
    if (formato === "xml" || formato === "ambos") {
      const xml = row.xml_nfse || row.xml_dps;
      if (xml) zip.append(xml, { name: nomeUnico(nfseNomeArquivo(row, "xml")) });
    }
    if (formato === "pdf" || formato === "ambos") {
      try {
        const { pdf } = await nfseObterDanfsePdf(row);
        if (pdf) zip.append(pdf, { name: nomeUnico(nfseNomeArquivo(row, "pdf")) });
      } catch {
        // segue pras outras — uma falha de PDF não deve derrubar o lote inteiro
      }
    }
  }
  await zip.finalize();
});
// Depois que uma emissão do cliente self-service é transmitida com sucesso, gera automaticamente
// a conta a receber correspondente — só pro fluxo self-service (não mexe em nada do admin, que
// não usa esse financeiro). Chamado sempre DEPOIS que nfseTransmitirEmissao já respondeu a
// requisição, então só faz trabalho de banco em segundo plano, sem afetar a resposta HTTP.
function nfseGerarRecebivelSeEmitida(emissaoId: number) {
  const linha = sqlite.prepare(`SELECT * FROM nfse_emissoes WHERE id = ?`).get(emissaoId) as any;
  if (!linha || linha.status !== "emitida") return;
  const jaExiste = sqlite.prepare(`SELECT 1 FROM financeiro_receber WHERE nfse_emissao_id = ?`).get(emissaoId);
  if (jaExiste) return;
  sqlite
    .prepare(
      `INSERT INTO financeiro_receber (empresa_id, descricao, cliente_nome, valor, vencimento, origem, nfse_emissao_id)
       VALUES (?, ?, ?, ?, ?, 'nfse', ?)`
    )
    .run(linha.empresa_id, `NFS-e nº ${linha.numero_nfse || linha.id} — ${linha.descricao_servico}`, linha.tomador_nome, linha.valor_servico, linha.competencia, emissaoId);
}

// ---------- Rotina automática de emissão de NFS-e (honorários do próprio escritório) ----------
const MESES_PT_EXTENSO = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];
// Mesmo truque de src/nfse.ts (dataHoraBrasilia) — Brasil não observa mais horário de verão desde
// 2019, então UTC-3 fixo é seguro pra saber "que dia/hora é agora" em Brasília.
function agoraBrasilia(): { dia: number; hora: number; minuto: number; ano: number; mes: number } {
  const d = new Date(Date.now() - 3 * 60 * 60 * 1000);
  return { dia: d.getUTCDate(), hora: d.getUTCHours(), minuto: d.getUTCMinutes(), ano: d.getUTCFullYear(), mes: d.getUTCMonth() + 1 };
}
// Objeto "res" falso só pra capturar o resultado de nfseTransmitirEmissao (que escreve a resposta
// num res do Express) sem precisar mexer nela — ela já foi validada em produção real, não vale o
// risco de duplicar/alterar essa lógica só pra rodar fora de uma requisição HTTP.
function resFalso() {
  const estado: { codigo: number; corpo: any } = { codigo: 200, corpo: null };
  return {
    _estado: estado,
    status(codigo: number) {
      estado.codigo = codigo;
      return this;
    },
    json(corpo: any) {
      estado.corpo = corpo;
    },
  };
}
// Achado ao vivo (LIBRA AGROINDUSTRIAL): empresas.email veio cadastrado com 2 endereços separados
// por vírgula ("compras@x.com,contabilidade@x.com") — provavelmente de uma importação do Domínio
// Web ou digitação manual. O Sistema Nacional NFS-e só aceita UM endereço no campo de e-mail do
// tomador e rejeita a nota inteira com "E0247: Email inválido" quando recebe os dois juntos — a
// rotina automática falhava (e ia continuar falhando) todo mês por causa disso. Usa só o primeiro
// que parecer um e-mail válido, em vez do campo cru.
function primeiroEmailValido(valor: string | null | undefined): string | null {
  if (!valor) return null;
  const partes = String(valor)
    .split(/[,;]/)
    .map((p) => p.trim());
  return partes.find((p) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(p)) || null;
}
type ResumoExecucaoAgendamento = { processados: number; sucesso: number; falha: number; motivo?: string };
// empresaIdsFiltro (opcional): restringe a rodada só a essas empresas — usado pelo botão "Executar
// só as que falharam", pra não reprocessar (nem re-logar como "pulado") quem já emitiu certo nesta
// competência.
async function nfseExecutarAgendamentoAutomatico(
  forcarMesmoSeJaExecutou = false,
  escritorioIdFiltro?: number,
  empresaIdsFiltro?: number[]
): Promise<ResumoExecucaoAgendamento> {
  const config = escritorioIdFiltro
    ? (sqlite.prepare(`SELECT * FROM nfse_agendamento_config WHERE escritorio_id = ?`).get(escritorioIdFiltro) as any)
    : null;
  if (escritorioIdFiltro && (!config || !config.empresa_prestador_id)) {
    return { processados: 0, sucesso: 0, falha: 0, motivo: "Configure a empresa prestador antes de executar." };
  }
  // A rotina automática de NFS-e é, ela mesma, um módulo que o escritório-cliente da plataforma
  // precisa ter contratado (teste grátis ou assinatura ativa) — sem isso, nem "Executar agora" roda.
  if (escritorioIdFiltro && !escritorioTemModulo(escritorioIdFiltro, "nfse_automatico")) {
    return { processados: 0, sucesso: 0, falha: 0, motivo: "Módulo de emissão automática de NFS-e não contratado — veja em Configurações > Assinatura da plataforma." };
  }
  const agora = agoraBrasilia();
  const competenciaAtual = `${agora.ano}-${String(agora.mes).padStart(2, "0")}`;
  // "Executar agora" (forcarMesmoSeJaExecutou) é um disparo manual explícito do admin, sempre com
  // escritorioIdFiltro — roda mesmo com a rotina desativada ou já executada este mês, mas só desse
  // escritório. Sem escritorioIdFiltro (disparo automático do setInterval) roda pra todos os
  // escritórios que já bateram o horário configurado, sem essas duas travas em jogo aqui — quem já
  // filtrou "ativo" e "ainda não executou nesta competência" foi a query que gerou a lista de configs.
  if (!forcarMesmoSeJaExecutou && config) {
    if (!config.ativo) return { processados: 0, sucesso: 0, falha: 0, motivo: "Rotina desativada." };
    if (config.ultima_execucao_competencia === competenciaAtual) return { processados: 0, sucesso: 0, falha: 0, motivo: "Já executou nesta competência." };
  }
  const configs = config
    ? [config]
    : (sqlite.prepare(`SELECT * FROM nfse_agendamento_config WHERE empresa_prestador_id IS NOT NULL`).all() as any[]).filter((c: any) =>
        escritorioTemModulo(c.escritorio_id, "nfse_automatico")
      );

  let processadosTotal = 0, sucessoTotal = 0, falhaTotal = 0;
  for (const config of configs) {
  const usuarioSistema = { id: null as number | null, perfil: "Administrador" as const, empresaId: null, escritorioId: config.escritorio_id };
  // Um item = um serviço = uma NFS-e. Uma empresa com 2 itens ativos gera 2 notas separadas na
  // mesma rodada (ex.: "honorários contábeis" + "licença do módulo NFS-e"). Escopado por escritório
  // via JOIN empresas — cada escritório só processa os itens das próprias empresas-cliente.
  const itens = sqlite
    .prepare(
      `SELECT i.* FROM nfse_agendamento_itens i
       JOIN nfse_agendamento_empresas ae ON ae.empresa_id = i.empresa_id
       JOIN empresas e ON e.id = i.empresa_id
       WHERE i.ativo = 1 AND ae.ativo = 1 AND e.ativo = 1 AND e.escritorio_id = ?
       ${empresaIdsFiltro && empresaIdsFiltro.length ? `AND i.empresa_id IN (${empresaIdsFiltro.map(() => "?").join(",")})` : ""}`
    )
    .all(config.escritorio_id, ...(empresaIdsFiltro && empresaIdsFiltro.length ? empresaIdsFiltro : [])) as any[];
  let sucesso = 0;
  let falha = 0;
  for (const item of itens) {
    const empresa = sqlite.prepare(`SELECT * FROM empresas WHERE id = ?`).get(item.empresa_id) as any;
    const registrarLog = (ok: boolean, mensagem: string, emissaoId?: number) => {
      ok ? sucesso++ : falha++;
      sqlite
        .prepare(`INSERT INTO nfse_agendamento_log (empresa_id, item_id, competencia, sucesso, emissao_id, mensagem) VALUES (?, ?, ?, ?, ?, ?)`)
        .run(item.empresa_id, item.id, competenciaAtual, ok ? 1 : 0, emissaoId ?? null, mensagem);
    };
    try {
      if (!empresa) {
        registrarLog(false, "Empresa não encontrada (pode ter sido excluída).");
        continue;
      }
      if (!item.modelo_id || !item.valor_servico) {
        registrarLog(false, "Falta configurar o modelo ou o valor deste serviço.");
        continue;
      }
      const cnpjTomador = String(empresa.cnpj || "").replace(/\D/g, "");
      if (!cnpjTomador) {
        registrarLog(false, "Empresa sem CNPJ cadastrado.");
        continue;
      }
      // Trava por ITEM (não mais por empresa) — permite duas notas diferentes pro mesmo cliente
      // na mesma competência (ex.: honorários + licença), mas nunca deixa o MESMO item duplicar.
      // Vale também no "Executar agora" manual, que só ignora a trava de "já rodou este mês
      // inteiro", não essa aqui.
      const jaEmitida = sqlite
        .prepare(`SELECT 1 FROM nfse_emissoes WHERE agendamento_item_id = ? AND competencia LIKE ? AND status = 'emitida'`)
        .get(item.id, `${competenciaAtual}%`);
      if (jaEmitida) {
        registrarLog(false, "Este serviço já foi emitido pra esse cliente nesta competência — pulado.");
        continue;
      }
      const descricao = item.descricao_servico.replace(/\{\{mes_competencia\}\}/g, `${MESES_PT_EXTENSO[agora.mes - 1]}/${agora.ano}`);
      const v = nfseValidarEntrada(usuarioSistema, {
        empresaId: config.empresa_prestador_id,
        modeloId: item.modelo_id,
        tomador: { documento: cnpjTomador, nome: empresa.nome, email: primeiroEmailValido(empresa.email), cep: empresa.cep || null },
        servico: { descricao, valor: Number(item.valor_servico), competencia: `${competenciaAtual}-01` },
      });
      if ("erro" in v) {
        registrarLog(false, v.erro);
        continue;
      }
      const emissaoId = nfseInserirEmissao(usuarioSistema, v.empresaId, v.modelo, v.tomador, v.servico, "pendente");
      sqlite.prepare(`UPDATE nfse_emissoes SET agendamento_item_id = ? WHERE id = ?`).run(item.id, emissaoId);
      const res = resFalso();
      await nfseTransmitirEmissao(emissaoId, v.empresaId, v.modelo, v.tomador, v.servico, res);
      if (res._estado.codigo >= 400) {
        registrarLog(false, res._estado.corpo?.error || "Falha desconhecida na emissão.", emissaoId);
        continue;
      }
      nfseGerarRecebivelSeEmitida(emissaoId);
      let mensagemLog = "NFS-e emitida com sucesso.";
      if (config.envio_template_id) {
        try {
          mensagemLog += " " + (await nfseAnexarEEnviarDocumento(config.escritorio_id, emissaoId, item.empresa_id, config.envio_template_id, agora));
        } catch (e: any) {
          mensagemLog += ` (não consegui anexar/enviar em Envio de Documentos: ${e.message})`;
        }
      }
      registrarLog(true, mensagemLog, emissaoId);
    } catch (e: any) {
      registrarLog(false, `Erro inesperado: ${e.message}`);
    }
  }
  sqlite.prepare(`UPDATE nfse_agendamento_config SET ultima_execucao_competencia = ? WHERE escritorio_id = ?`).run(competenciaAtual, config.escritorio_id);
  processadosTotal += itens.length;
  sucessoTotal += sucesso;
  falhaTotal += falha;
  }
  return {
    processados: processadosTotal,
    sucesso: sucessoTotal,
    falha: falhaTotal,
    motivo: processadosTotal === 0 ? "Nenhum serviço ativo configurado nas empresas da rotina." : undefined,
  };
}
// Depois de emitir, anexa o DANFSe no período do mês em Envio de Documentos (se a empresa tiver
// esse modelo atribuído) e manda por e-mail — mesmo padrão de POST /api/envio/periodos/:id/enviar.
async function nfseAnexarEEnviarDocumento(escritorioId: number, emissaoId: number, empresaId: number, envioTemplateId: number, agora: { ano: number; mes: number }): Promise<string> {
  const atribuicao = sqlite
    .prepare(`SELECT * FROM envio_atribuicoes WHERE template_id = ? AND empresa_id = ? AND ativo = 1`)
    .get(envioTemplateId, empresaId) as any;
  if (!atribuicao) return "Empresa não tem o modelo de Envio de Documentos atribuído — nota só ficou disponível em NFS-e.";
  const emissao = sqlite.prepare(`SELECT * FROM nfse_emissoes WHERE id = ?`).get(emissaoId) as any;
  const { pdf, erro } = await nfseObterDanfsePdf(emissao);
  if (!pdf) throw new Error(erro || "DANFSe indisponível");

  let periodo = sqlite.prepare(`SELECT * FROM envio_periodos WHERE atribuicao_id = ? AND ano = ? AND mes = ?`).get(atribuicao.id, agora.ano, agora.mes) as any;
  if (!periodo) {
    const info = sqlite.prepare(`INSERT INTO envio_periodos (atribuicao_id, ano, mes) VALUES (?, ?, ?)`).run(atribuicao.id, agora.ano, agora.mes);
    periodo = { id: Number(info.lastInsertRowid) };
  }
  // Nome, observação e assunto trazem a descrição do serviço — sem isso, duas notas do mesmo
  // cliente na mesma competência (ex.: honorários + licença) apareceriam idênticas em Envio de
  // Documentos e na caixa de entrada do cliente, sem como diferenciar uma da outra. A descrição
  // pode ter "/" (ex.: "...agosto/2026", vindo de {{mes_competencia}}) — trocado por "-" só no nome
  // do arquivo, já que aqui vira um segmento de caminho no disco.
  const descricaoParaArquivo = String(emissao.descricao_servico).replace(/[/\\]/g, "-");
  const nomeArquivo = `NFS-e ${emissao.numero_nfse || emissao.id} - ${descricaoParaArquivo} - ${MESES_PT_EXTENSO[agora.mes - 1]} ${agora.ano}.pdf`;
  const dir = path.join(UPLOADS_DIR, "envio", String(empresaId), String(periodo.id));
  fs.mkdirSync(dir, { recursive: true });
  const destino = path.join(dir, `${Date.now()}-${nomeArquivo}`);
  fs.writeFileSync(destino, pdf);
  const observacao = `Emitida automaticamente pela rotina de NFS-e — ${emissao.descricao_servico}`;
  const info = sqlite
    .prepare(`INSERT INTO envio_documentos (periodo_id, file_name, file_path, mime, size_bytes, observacao) VALUES (?, ?, ?, 'application/pdf', ?, ?)`)
    .run(periodo.id, nomeArquivo, destino, pdf.length, observacao);
  const docId = Number(info.lastInsertRowid);

  const contatos = sqlite.prepare(`SELECT email FROM empresa_contatos WHERE empresa_id = ? AND receber_emails = 1`).all(empresaId) as any[];
  let msgEmail: string;
  // Envio automático por e-mail é um módulo à parte que o escritório precisa ter contratado — sem
  // ele, a nota é emitida e anexada em Envio de Documentos, mas o e-mail não sai sozinho (o
  // escritório manda manualmente pelo botão "Reenviar e-mail" se quiser).
  if (!escritorioTemModulo(escritorioId, "envio_email_automatico")) {
    msgEmail = "módulo de envio automático por e-mail não contratado — nota disponível em Envio de Documentos pra envio manual.";
  } else if (!contatos.length) {
    msgEmail = "empresa sem contatos de e-mail cadastrados pra enviar.";
  } else {
    const emailConfig = sqlite.prepare(`SELECT nfse_email_texto FROM email_config WHERE escritorio_id = ?`).get(escritorioId) as any;
    const corpoBase = emailConfig?.nfse_email_texto || `Segue em anexo a Nota Fiscal de Serviço referente a ${MESES_PT_EXTENSO[agora.mes - 1]}/${agora.ano}.`;
    const corpo = `${corpoBase}\n\nServiço: ${emissao.descricao_servico}`;
    const assunto = `Nota Fiscal de Serviço — ${emissao.descricao_servico}`;
    try {
      await enviarEmail(escritorioId, { to: contatos.map((c) => c.email), subject: assunto, text: corpo, attachments: [{ filename: nomeArquivo, content: pdf }] });
      sqlite.prepare(`UPDATE envio_documentos SET email_enviado = 1, email_enviado_em = datetime('now') WHERE id = ?`).run(docId);
      sqlite
        .prepare(`INSERT INTO emails_enviados (empresa_id, destinatarios, assunto, corpo, anexos_json, status) VALUES (?, ?, ?, ?, ?, 'ok')`)
        .run(empresaId, contatos.map((c) => c.email).join(", "), assunto, corpo, JSON.stringify([nomeArquivo]));
      msgEmail = "enviado por e-mail.";
    } catch (e: any) {
      sqlite.prepare(`UPDATE envio_documentos SET email_enviado = 0, email_erro = ? WHERE id = ?`).run(e.message, docId);
      sqlite
        .prepare(`INSERT INTO emails_enviados (empresa_id, destinatarios, assunto, corpo, status, erro) VALUES (?, ?, ?, ?, 'erro', ?)`)
        .run(empresaId, contatos.map((c) => c.email).join(", "), assunto, corpo, e.message);
      msgEmail = `o e-mail falhou: ${e.message}`;
    }
  }

  // WhatsApp segue independente do e-mail (uma falha não bloqueia a outra) — só tenta se o
  // escritório tiver a integração ativa e a empresa tiver ao menos um contato marcado pra receber.
  let msgWhatsapp: string | null = null;
  const contatosWhatsapp = escritorioTemModulo(escritorioId, "envio_whatsapp")
    ? (sqlite
        .prepare(`SELECT telefone FROM empresa_contatos WHERE empresa_id = ? AND receber_whatsapp = 1 AND telefone IS NOT NULL AND telefone != ''`)
        .all(empresaId) as any[])
    : [];
  if (contatosWhatsapp.length) {
    const empresaNome = (sqlite.prepare(`SELECT nome FROM empresas WHERE id = ?`).get(empresaId) as any)?.nome || "";
    let algumEnviado = false;
    let ultimoErro = "";
    for (const c of contatosWhatsapp) {
      try {
        await whatsappEnviarArquivo(
          escritorioId,
          c.telefone,
          [
            { nome: "empresa_nome", valor: empresaNome },
            { nome: "descricao", valor: `Nota Fiscal de Serviço — ${emissao.descricao_servico}` },
          ],
          { nome: nomeArquivo, tipo: "application/pdf", buffer: pdf },
          { tabela: "envio_documentos", id: docId }
        );
        algumEnviado = true;
      } catch (e: any) {
        ultimoErro = e.message;
      }
    }
    if (algumEnviado) {
      sqlite.prepare(`UPDATE envio_documentos SET whatsapp_enviado = 1, whatsapp_enviado_em = datetime('now'), whatsapp_erro = NULL WHERE id = ?`).run(docId);
      msgWhatsapp = "enviado por WhatsApp.";
    } else {
      sqlite.prepare(`UPDATE envio_documentos SET whatsapp_erro = ? WHERE id = ?`).run(ultimoErro, docId);
      msgWhatsapp = `o WhatsApp falhou: ${ultimoErro}`;
    }
  }

  return `Anexado em Envio de Documentos; ${msgEmail}${msgWhatsapp ? ` E ${msgWhatsapp}` : ""}`;
}
// Confere a cada minuto se é hora de rodar a rotina — sobrevive a reinício porque a trava real
// (ultima_execucao_competencia) fica no banco, não em memória.
setInterval(() => {
  const agora = agoraBrasilia();
  const configs = sqlite
    .prepare(`SELECT escritorio_id FROM nfse_agendamento_config WHERE dia_mes = ? AND hora = ? AND minuto = ?`)
    .all(agora.dia, agora.hora, agora.minuto) as any[];
  for (const c of configs) {
    nfseExecutarAgendamentoAutomatico(false, c.escritorio_id).catch((e) => console.error("Erro na rotina automática de NFS-e:", e.message));
  }
}, 60_000);

// ---------- Configuração da rotina automática (admin — efeito fiscal direto, requireAdmin) ----------
app.get("/api/nfse/agendamento/config", blockCliente, requirePermissao("configuracoes", "visualizar"), (req, res) => {
  const c = sqlite.prepare(`SELECT * FROM nfse_agendamento_config WHERE escritorio_id = ?`).get((req as any).user.escritorioId) as any;
  res.json({
    ativo: !!c?.ativo,
    empresaPrestadorId: c?.empresa_prestador_id ?? null,
    envioTemplateId: c?.envio_template_id ?? null,
    diaMes: c?.dia_mes ?? 1,
    hora: c?.hora ?? 8,
    minuto: c?.minuto ?? 0,
    ultimaExecucaoCompetencia: c?.ultima_execucao_competencia ?? null,
  });
});
app.put("/api/nfse/agendamento/config", blockCliente, requirePermissao("configuracoes", "editar"), (req, res) => {
  const user = (req as any).user;
  const b = req.body || {};
  const diaMes = Math.min(28, Math.max(1, Number(b.diaMes) || 1));
  const hora = Math.min(23, Math.max(0, Number(b.hora) || 0));
  const minuto = Math.min(59, Math.max(0, Number(b.minuto) || 0));
  if (b.empresaPrestadorId && !podeAcessarEmpresa(user, Number(b.empresaPrestadorId))) {
    return res.status(403).json({ error: "Sem acesso a esta empresa." });
  }
  sqlite
    .prepare(
      `INSERT INTO nfse_agendamento_config (escritorio_id, ativo, empresa_prestador_id, envio_template_id, dia_mes, hora, minuto, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(escritorio_id) DO UPDATE SET ativo=excluded.ativo, empresa_prestador_id=excluded.empresa_prestador_id,
         envio_template_id=excluded.envio_template_id, dia_mes=excluded.dia_mes, hora=excluded.hora, minuto=excluded.minuto, updated_at=datetime('now')`
    )
    .run(user.escritorioId, b.ativo ? 1 : 0, b.empresaPrestadorId ? Number(b.empresaPrestadorId) : null, b.envioTemplateId ? Number(b.envioTemplateId) : null, diaMes, hora, minuto);
  res.json({ ok: true });
});
app.get("/api/nfse/agendamento/empresas-disponiveis", blockCliente, requirePermissao("configuracoes", "visualizar"), (req, res) => {
  const termo = typeof req.query.q === "string" ? req.query.q.trim() : "";
  let sql = `SELECT id, nome, cnpj, inscricao_estadual as inscricaoEstadual FROM empresas WHERE ativo = 1 AND escritorio_id = ? AND id NOT IN (SELECT empresa_id FROM nfse_agendamento_empresas)`;
  const params: any[] = [(req as any).user.escritorioId];
  if (termo) {
    sql += ` AND nome LIKE ?`;
    params.push(`%${termo}%`);
  }
  sql += ` ORDER BY nome LIMIT 200`;
  res.json({ items: sqlite.prepare(sql).all(...params) });
});
app.get("/api/nfse/agendamento/empresas", blockCliente, requirePermissao("configuracoes", "visualizar"), (req, res) => {
  const rows = sqlite
    .prepare(
      `SELECT ae.empresa_id as empresaId, e.nome, e.cnpj, ae.ativo,
              (SELECT COUNT(*) FROM nfse_agendamento_itens i WHERE i.empresa_id = ae.empresa_id) as totalItens,
              (SELECT COUNT(*) FROM nfse_agendamento_itens i WHERE i.empresa_id = ae.empresa_id AND i.ativo = 1 AND (i.modelo_id IS NULL OR i.valor_servico IS NULL)) as itensIncompletos
       FROM nfse_agendamento_empresas ae JOIN empresas e ON e.id = ae.empresa_id
       WHERE e.escritorio_id = ? AND e.ativo = 1 ORDER BY e.nome`
    )
    .all((req as any).user.escritorioId) as any[];
  res.json({ items: rows.map((r) => ({ ...r, ativo: !!r.ativo })) });
});
app.post("/api/nfse/agendamento/empresas/:empresaId", blockCliente, requirePermissao("configuracoes", "postar"), (req, res) => {
  const empresaId = Number(req.params.empresaId);
  if (!podeAcessarEmpresa((req as any).user, empresaId)) return res.status(404).json({ error: "Empresa não encontrada." });
  const empresa = sqlite.prepare(`SELECT id, email FROM empresas WHERE id = ?`).get(empresaId) as any;
  if (!empresa) return res.status(404).json({ error: "Empresa não encontrada." });
  sqlite.prepare(`INSERT OR IGNORE INTO nfse_agendamento_empresas (empresa_id) VALUES (?)`).run(empresaId);
  // Já entra com um primeiro serviço em branco pra configurar — o admin pode adicionar mais depois.
  const jaTemItem = sqlite.prepare(`SELECT 1 FROM nfse_agendamento_itens WHERE empresa_id = ?`).get(empresaId);
  if (!jaTemItem) sqlite.prepare(`INSERT INTO nfse_agendamento_itens (empresa_id) VALUES (?)`).run(empresaId);
  // Ao entrar na rotina automática, já liga sozinho as duas pontas que antes precisavam ser
  // configuradas à parte (e que, esquecidas, faziam a nota emitir mas nunca chegar no cliente):
  // 1) a atribuição do modelo de Envio de Documentos configurado pra NFS-e nessa empresa;
  const config = sqlite.prepare(`SELECT envio_template_id FROM nfse_agendamento_config WHERE escritorio_id = ?`).get((req as any).user.escritorioId) as any;
  if (config?.envio_template_id) {
    sqlite.prepare(`INSERT OR IGNORE INTO envio_atribuicoes (template_id, empresa_id, ativo) VALUES (?, ?, 1)`).run(config.envio_template_id, empresaId);
  }
  // 2) um contato de e-mail com base no e-mail já cadastrado da empresa — só quando ela ainda não
  // tem nenhum contato registrado, pra nunca sobrescrever quem o admin já configurou manualmente.
  const jaTemContato = sqlite.prepare(`SELECT 1 FROM empresa_contatos WHERE empresa_id = ?`).get(empresaId);
  if (!jaTemContato && empresa.email) {
    sqlite.prepare(`INSERT INTO empresa_contatos (empresa_id, nome, email, receber_emails) VALUES (?, 'Financeiro', ?, 1)`).run(empresaId, empresa.email);
  }
  res.json({ ok: true });
});
app.delete("/api/nfse/agendamento/empresas/:empresaId", blockCliente, requirePermissao("configuracoes", "editar"), (req, res) => {
  const empresaId = Number(req.params.empresaId);
  if (!podeAcessarEmpresa((req as any).user, empresaId)) return res.status(404).json({ error: "Empresa não encontrada." });
  sqlite.prepare(`DELETE FROM nfse_agendamento_itens WHERE empresa_id = ?`).run(empresaId);
  sqlite.prepare(`DELETE FROM nfse_agendamento_empresas WHERE empresa_id = ?`).run(empresaId);
  res.json({ ok: true });
});
// Pausa/ativa a empresa inteira de uma vez (todos os itens juntos), sem mexer na configuração de cada um.
app.put("/api/nfse/agendamento/empresas/:empresaId", blockCliente, requirePermissao("configuracoes", "editar"), (req, res) => {
  const empresaId = Number(req.params.empresaId);
  if (!podeAcessarEmpresa((req as any).user, empresaId)) return res.status(404).json({ error: "Empresa não encontrada." });
  const existente = sqlite.prepare(`SELECT * FROM nfse_agendamento_empresas WHERE empresa_id = ?`).get(empresaId) as any;
  if (!existente) return res.status(404).json({ error: "Esta empresa ainda não foi transferida pro quadro de rotina automática." });
  const b = req.body || {};
  sqlite
    .prepare(`UPDATE nfse_agendamento_empresas SET ativo=?, updated_at=datetime('now') WHERE empresa_id=?`)
    .run(b.ativo !== undefined ? (b.ativo ? 1 : 0) : existente.ativo, empresaId);
  res.json({ ok: true });
});
// ---- Itens (serviços/notas) de cada empresa — uma empresa pode ter mais de um, ex.: "honorários
// contábeis" + "licença do módulo NFS-e" como duas notas separadas na mesma competência.
app.get("/api/nfse/agendamento/empresas/:empresaId/itens", blockCliente, requirePermissao("configuracoes", "visualizar"), (req, res) => {
  if (!podeAcessarEmpresa((req as any).user, Number(req.params.empresaId))) return res.status(404).json({ error: "Empresa não encontrada." });
  const rows = sqlite
    .prepare(
      `SELECT id, empresa_id as empresaId, modelo_id as modeloId, descricao_servico as descricaoServico, valor_servico as valorServico, ativo
       FROM nfse_agendamento_itens WHERE empresa_id = ? ORDER BY id`
    )
    .all(Number(req.params.empresaId)) as any[];
  res.json({ items: rows.map((r) => ({ ...r, ativo: !!r.ativo })) });
});
app.post("/api/nfse/agendamento/empresas/:empresaId/itens", blockCliente, requirePermissao("configuracoes", "postar"), (req, res) => {
  const empresaId = Number(req.params.empresaId);
  if (!podeAcessarEmpresa((req as any).user, empresaId)) return res.status(404).json({ error: "Empresa não encontrada." });
  const existente = sqlite.prepare(`SELECT 1 FROM nfse_agendamento_empresas WHERE empresa_id = ?`).get(empresaId);
  if (!existente) return res.status(404).json({ error: "Esta empresa ainda não foi transferida pro quadro de rotina automática." });
  const info = sqlite.prepare(`INSERT INTO nfse_agendamento_itens (empresa_id) VALUES (?)`).run(empresaId);
  res.json({ ok: true, id: Number(info.lastInsertRowid) });
});
app.put("/api/nfse/agendamento/itens/:itemId", blockCliente, requirePermissao("configuracoes", "editar"), (req, res) => {
  const itemId = Number(req.params.itemId);
  const existente = sqlite.prepare(`SELECT * FROM nfse_agendamento_itens WHERE id = ?`).get(itemId) as any;
  if (!existente || !podeAcessarEmpresa((req as any).user, existente.empresa_id)) return res.status(404).json({ error: "Serviço não encontrado." });
  const b = req.body || {};
  sqlite
    .prepare(`UPDATE nfse_agendamento_itens SET modelo_id=?, descricao_servico=?, valor_servico=?, ativo=?, updated_at=datetime('now') WHERE id=?`)
    .run(
      b.modeloId ? Number(b.modeloId) : existente.modelo_id,
      b.descricaoServico !== undefined ? String(b.descricaoServico).trim() : existente.descricao_servico,
      b.valorServico !== undefined ? Number(b.valorServico) : existente.valor_servico,
      b.ativo !== undefined ? (b.ativo ? 1 : 0) : existente.ativo,
      itemId
    );
  res.json({ ok: true });
});
app.delete("/api/nfse/agendamento/itens/:itemId", blockCliente, requirePermissao("configuracoes", "editar"), (req, res) => {
  const itemId = Number(req.params.itemId);
  const existente = sqlite.prepare(`SELECT empresa_id FROM nfse_agendamento_itens WHERE id = ?`).get(itemId) as any;
  if (!existente || !podeAcessarEmpresa((req as any).user, existente.empresa_id)) return res.status(404).json({ error: "Serviço não encontrado." });
  sqlite.prepare(`DELETE FROM nfse_agendamento_itens WHERE id = ?`).run(itemId);
  res.json({ ok: true });
});
app.get("/api/nfse/agendamento/log", blockCliente, requirePermissao("configuracoes", "visualizar"), (req, res) => {
  const rows = sqlite
    .prepare(
      `SELECT l.id, l.empresa_id as empresaId, e.nome as empresaNome, l.competencia, l.sucesso, l.emissao_id as emissaoId, l.mensagem, l.executado_em as executadoEm
       FROM nfse_agendamento_log l LEFT JOIN empresas e ON e.id = l.empresa_id
       WHERE e.escritorio_id = ? ORDER BY l.id DESC LIMIT 200`
    )
    .all((req as any).user.escritorioId) as any[];
  res.json({ items: rows.map((r) => ({ ...r, sucesso: !!r.sucesso })) });
});
app.post("/api/nfse/agendamento/executar-agora", blockCliente, requirePermissao("configuracoes", "postar"), async (req, res) => {
  try {
    const resumo = await nfseExecutarAgendamentoAutomatico(true, (req as any).user.escritorioId);
    res.json({ ok: true, ...resumo });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});
// Reprocessa só as empresas cuja última execução da competência atual falhou — evita bater de novo
// nas que já emitiram certo (o que "Executar agora" já pula pela trava de item duplicado, mas ainda
// gastaria tempo/consultas à toa percorrendo todo mundo de novo).
app.post("/api/nfse/agendamento/executar-falhas", blockCliente, requirePermissao("configuracoes", "postar"), async (req, res) => {
  try {
    const escritorioId = (req as any).user.escritorioId;
    const agora = agoraBrasilia();
    const competenciaAtual = `${agora.ano}-${String(agora.mes).padStart(2, "0")}`;
    const falhas = sqlite
      .prepare(
        `SELECT l.empresa_id as empresaId
         FROM nfse_agendamento_log l
         JOIN empresas e ON e.id = l.empresa_id
         WHERE e.escritorio_id = ? AND l.competencia = ? AND l.sucesso = 0
           AND l.id = (SELECT MAX(id) FROM nfse_agendamento_log WHERE empresa_id = l.empresa_id AND competencia = l.competencia)`
      )
      .all(escritorioId, competenciaAtual) as any[];
    if (!falhas.length) return res.json({ ok: true, processados: 0, sucesso: 0, falha: 0, motivo: "Nenhuma execução com falha nesta competência." });
    const resumo = await nfseExecutarAgendamentoAutomatico(
      true,
      escritorioId,
      falhas.map((f) => f.empresaId)
    );
    res.json({ ok: true, ...resumo });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});
// Retry isolado do passo "anexar em Envio de Documentos + enviar e-mail" pra uma emissão específica
// que já saiu (nota real, não repete a transmissão) mas cujo anexo/e-mail falhou na hora — o motivo
// mais comum é uma instabilidade momentânea do Sistema Nacional NFS-e ao baixar o DANFSe (erro 503).
// Não usa "agora" (a data de hoje) pro período — usa a competência real da própria emissão, senão um
// retry feito num mês seguinte cairia no período errado.
app.post("/api/nfse/agendamento/emissoes/:id/reenviar-documento", blockCliente, requirePermissao("configuracoes", "postar"), async (req, res) => {
  const emissaoId = Number(req.params.id);
  const emissao = sqlite.prepare(`SELECT * FROM nfse_emissoes WHERE id = ?`).get(emissaoId) as any;
  if (!emissao || !podeAcessarEmpresa((req as any).user, emissao.empresa_id)) return res.status(404).json({ error: "Emissão não encontrada." });
  if (emissao.status !== "emitida") return res.status(400).json({ error: "Só é possível anexar/enviar uma NFS-e já emitida." });
  if (!emissao.agendamento_item_id) return res.status(400).json({ error: "Esta emissão não veio da rotina automática de NFS-e." });
  // emissao.empresa_id é o PRESTADOR (o escritório) — o cliente (tomador) que precisa receber o
  // documento em Envio de Documentos só é rastreável de volta via o item da rotina que a gerou.
  const item = sqlite.prepare(`SELECT empresa_id FROM nfse_agendamento_itens WHERE id = ?`).get(emissao.agendamento_item_id) as any;
  if (!item) return res.status(404).json({ error: "O serviço da rotina que gerou essa emissão não existe mais." });
  const config = sqlite.prepare(`SELECT envio_template_id FROM nfse_agendamento_config WHERE escritorio_id = ?`).get((req as any).user.escritorioId) as any;
  if (!config?.envio_template_id) return res.status(400).json({ error: "Nenhum modelo de Envio de Documentos configurado na rotina." });
  const [anoStr, mesStr] = String(emissao.competencia).split("-");
  const competenciaLog = `${anoStr}-${mesStr}`;
  // Grava o resultado do retry como uma NOVA linha no histórico — nunca reescreve a linha antiga
  // (ela continua sendo o registro real de que, naquele momento, o anexo/e-mail falhou); assim o
  // histórico mostra as duas coisas: falhou ali, foi reenviado com sucesso aqui, sem mensagem de
  // erro velha ficando presa pra sempre ao lado do botão "Tentar novamente".
  try {
    const mensagem = await nfseAnexarEEnviarDocumento((req as any).user.escritorioId, emissaoId, item.empresa_id, config.envio_template_id, { ano: Number(anoStr), mes: Number(mesStr) });
    sqlite
      .prepare(`INSERT INTO nfse_agendamento_log (empresa_id, item_id, competencia, sucesso, emissao_id, mensagem) VALUES (?, ?, ?, 1, ?, ?)`)
      .run(item.empresa_id, emissao.agendamento_item_id, competenciaLog, emissaoId, `Reenvio manual: ${mensagem}`);
    res.json({ ok: true, mensagem });
  } catch (e: any) {
    sqlite
      .prepare(`INSERT INTO nfse_agendamento_log (empresa_id, item_id, competencia, sucesso, emissao_id, mensagem) VALUES (?, ?, ?, 0, ?, ?)`)
      .run(item.empresa_id, emissao.agendamento_item_id, competenciaLog, emissaoId, `Reenvio manual falhou: ${e.message}`);
    res.status(502).json({ error: e.message });
  }
});

app.post("/api/nfse/minha-empresa/emitir", requireCliente, requireModuloAtivo('nfse'), async (req, res) => {
  const user = (req as any).user;
  const v = nfseValidarEntrada(user, { ...req.body, empresaId: user.empresaId });
  if ("erro" in v) return res.status(v.status || 400).json({ error: v.erro });
  const emissaoId = nfseInserirEmissao(user, v.empresaId, v.modelo, v.tomador, v.servico, "pendente");
  await nfseTransmitirEmissao(emissaoId, v.empresaId, v.modelo, v.tomador, v.servico, res);
  nfseGerarRecebivelSeEmitida(emissaoId);
});
app.post("/api/nfse/minha-empresa/rascunhos", requireCliente, requireModuloAtivo('nfse'), (req, res) => {
  const user = (req as any).user;
  const v = nfseValidarEntrada(user, { ...req.body, empresaId: user.empresaId });
  if ("erro" in v) return res.status(v.status || 400).json({ error: v.erro });
  const emissaoId = nfseInserirEmissao(user, v.empresaId, v.modelo, v.tomador, v.servico, "rascunho");
  res.json({ id: emissaoId });
});
app.put("/api/nfse/minha-empresa/rascunhos/:id", requireCliente, requireModuloAtivo('nfse'), (req, res) => {
  const user = (req as any).user;
  const existente = sqlite.prepare(`SELECT * FROM nfse_emissoes WHERE id = ? AND empresa_id = ?`).get(Number(req.params.id), user.empresaId) as any;
  if (!existente) return res.status(404).json({ error: "Rascunho não encontrado." });
  if (!["rascunho", "rejeitada", "erro"].includes(existente.status)) return res.status(409).json({ error: "Esta emissão já foi transmitida e não pode ser editada." });
  const v = nfseValidarEntrada(user, { ...req.body, empresaId: user.empresaId });
  if ("erro" in v) return res.status(v.status || 400).json({ error: v.erro });
  sqlite
    .prepare(
      `UPDATE nfse_emissoes SET modelo_id=?, modelo_nome=?, tomador_documento=?, tomador_nome=?, tomador_email=?, tomador_telefone=?, tomador_cep=?, tomador_logradouro=?, tomador_numero=?, tomador_complemento=?, tomador_bairro=?, tomador_codigo_municipio=?, codigo_tributacao_nacional=?, descricao_servico=?, valor_servico=?, competencia=?, status='rascunho', erro=NULL WHERE id=?`
    )
    .run(
      v.modelo.id,
      v.modelo.nome,
      String(v.tomador.documento).replace(/\D/g, ""),
      String(v.tomador.nome).trim(),
      v.tomador.email || null,
      v.tomador.telefone ? String(v.tomador.telefone).replace(/\D/g, "") : null,
      v.tomador.cep || null,
      v.tomador.logradouro || null,
      v.tomador.numero || null,
      v.tomador.complemento || null,
      v.tomador.bairro || null,
      v.tomador.codigoMunicipio || null,
      v.modelo.codigo_tributacao_nacional,
      String(v.servico.descricao).trim(),
      Number(v.servico.valor),
      String(v.servico.competencia),
      existente.id
    );
  res.json({ ok: true });
});
app.post("/api/nfse/minha-empresa/rascunhos/:id/emitir", requireCliente, requireModuloAtivo('nfse'), async (req, res) => {
  const user = (req as any).user;
  const existente = sqlite.prepare(`SELECT * FROM nfse_emissoes WHERE id = ? AND empresa_id = ?`).get(Number(req.params.id), user.empresaId) as any;
  if (!existente) return res.status(404).json({ error: "Rascunho não encontrado." });
  if (!["rascunho", "rejeitada", "erro"].includes(existente.status)) return res.status(409).json({ error: "Esta emissão já foi transmitida." });
  if (!existente.modelo_id) return res.status(400).json({ error: "Este rascunho não tem um modelo de serviço válido — edite antes de emitir." });
  const modelo = sqlite.prepare(`SELECT * FROM nfse_modelos WHERE id = ? AND ativo = 1 AND empresa_id = ?`).get(existente.modelo_id, user.empresaId) as any;
  if (!modelo) return res.status(404).json({ error: "O modelo de serviço deste rascunho não existe mais ou está inativo." });
  const tomador = {
    documento: existente.tomador_documento,
    nome: existente.tomador_nome,
    email: existente.tomador_email,
    telefone: existente.tomador_telefone,
    cep: existente.tomador_cep,
    logradouro: existente.tomador_logradouro,
    numero: existente.tomador_numero,
    complemento: existente.tomador_complemento,
    bairro: existente.tomador_bairro,
    codigoMunicipio: existente.tomador_codigo_municipio,
  };
  const servico = { descricao: existente.descricao_servico, valor: existente.valor_servico, competencia: existente.competencia };
  await nfseTransmitirEmissao(existente.id, existente.empresa_id, modelo, tomador, servico, res);
  nfseGerarRecebivelSeEmitida(existente.id);
});
app.delete("/api/nfse/minha-empresa/emissoes/:id", requireCliente, requireModuloAtivo('nfse'), (req, res) => {
  const user = (req as any).user;
  const row = sqlite.prepare(`SELECT * FROM nfse_emissoes WHERE id = ? AND empresa_id = ?`).get(Number(req.params.id), user.empresaId) as any;
  if (!row) return res.status(404).json({ error: "Registro não encontrado." });
  if (row.status !== "rascunho") return res.status(409).json({ error: "Só é possível excluir rascunhos — emissões já transmitidas ficam no histórico." });
  sqlite.prepare(`DELETE FROM nfse_emissoes WHERE id = ?`).run(row.id);
  res.json({ ok: true });
});
app.post("/api/nfse/minha-empresa/emissoes/:id/cancelar", requireCliente, requireModuloAtivo('nfse'), async (req, res) => {
  const user = (req as any).user;
  const row = sqlite.prepare(`SELECT * FROM nfse_emissoes WHERE id = ? AND empresa_id = ?`).get(Number(req.params.id), user.empresaId) as any;
  if (!row) return res.status(404).json({ error: "Emissão não encontrada." });
  if (row.status !== "emitida") return res.status(409).json({ error: "Só é possível cancelar uma NFS-e que já foi emitida." });
  if (!row.chave_acesso) return res.status(400).json({ error: "Esta emissão não tem chave de acesso." });
  const { motivo, justificativa } = req.body || {};
  if (!["1", "2", "9"].includes(motivo)) return res.status(400).json({ error: "Selecione o motivo do cancelamento." });
  if (!justificativa || String(justificativa).trim().length < 15) return res.status(400).json({ error: "A justificativa precisa ter pelo menos 15 caracteres." });

  const empresa = sqlite.prepare(`SELECT cnpj FROM empresas WHERE id = ?`).get(row.empresa_id) as any;
  const config = sqlite.prepare(`SELECT metodo_assinatura FROM nfse_empresa_config WHERE empresa_id = ?`).get(row.empresa_id) as any;
  let cert: nfse.CertificadoInfo;
  try {
    ({ cert } = nfseCertificadoParaEmpresa(row.empresa_id, config?.metodo_assinatura));
  } catch (e: any) {
    return res.status(400).json({ error: e.message });
  }
  try {
    const r = await nfse.cancelarNfse(
      { ambiente: row.ambiente, chaveAcesso: row.chave_acesso, cnpjAutor: (empresa?.cnpj || "").replace(/\D/g, ""), motivo, xMotivo: String(justificativa).trim() },
      cert
    );
    if (!r.resposta.ok) return res.status(422).json({ error: `O Sistema Nacional NFS-e rejeitou o cancelamento: ${r.mensagemErro}` });
    sqlite
      .prepare(`UPDATE nfse_emissoes SET status='cancelada', motivo_cancelamento=?, justificativa_cancelamento=?, cancelado_em=datetime('now'), danfse_path=NULL WHERE id=?`)
      .run(motivo, String(justificativa).trim(), row.id);
    // O recebível gerado por essa nota fica marcado como cancelado, não é apagado — quem vê o
    // Financeiro continua tendo o histórico completo, só que sinalizado como não mais válido.
    sqlite.prepare(`UPDATE financeiro_receber SET status='cancelado' WHERE nfse_emissao_id = ?`).run(row.id);
    await nfseNotificarCancelamento(row.id);
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});
// Tabelas de referência (cTribNac/NBS/cClassTrib) e busca de município/CNPJ são só leitura de
// dados públicos — reexpõe iguais às versões admin, mesmo formato de resposta (id = código real,
// não índice, pra bater com o valor gravado no modelo).
app.get("/api/nfse/minha-empresa/ctribnac", requireCliente, requireModuloAtivo('nfse'), (_req, res) => {
  res.json({ items: nfseTabelaCTribNac.map((i) => ({ id: i.codigo, label: `${i.codigo} - ${i.descricao}` })) });
});
app.get("/api/nfse/minha-empresa/nbs", requireCliente, requireModuloAtivo('nfse'), (_req, res) => {
  res.json({ items: nfseTabelaNbs.map((i) => ({ id: i.codigo, label: `${i.codigo} - ${i.descricao}` })) });
});
app.get("/api/nfse/minha-empresa/cclasstrib", requireCliente, requireModuloAtivo('nfse'), (_req, res) => {
  res.json({ items: nfseTabelaCClassTrib.map((i) => ({ id: i.codigo, label: `${i.codigo} - ${i.descricao}` })) });
});
app.get("/api/nfse/minha-empresa/municipios-ibge", requireCliente, requireModuloAtivo('nfse'), async (req, res) => {
  const uf = String(req.query.uf || "").toUpperCase().trim();
  if (!uf) return res.status(400).json({ error: "Informe a UF." });
  try {
    const municipios = await nfseMunicipiosDaUf(uf);
    res.json({ items: municipios.map((m) => ({ id: String(m.id), label: m.nome })) });
  } catch (e: any) {
    res.status(502).json({ error: `Não consegui consultar a API do IBGE: ${e.message}` });
  }
});
app.get("/api/nfse/minha-empresa/municipio-ibge", requireCliente, requireModuloAtivo('nfse'), async (req, res) => {
  const uf = String(req.query.uf || "").toUpperCase().trim();
  const cidade = String(req.query.cidade || "").trim();
  if (!uf || !cidade) return res.status(400).json({ error: "Informe cidade e UF." });
  try {
    const municipios = await nfseMunicipiosDaUf(uf);
    const alvo = nfseNormalizaCidade(cidade);
    const achado = municipios.find((m) => nfseNormalizaCidade(m.nome) === alvo);
    if (!achado) return res.status(404).json({ error: `Não encontrei "${cidade}" na lista de municípios de ${uf}.` });
    res.json({ codigoMunicipio: String(achado.id), nomeOficial: achado.nome });
  } catch (e: any) {
    res.status(502).json({ error: `Não consegui consultar a API do IBGE: ${e.message}` });
  }
});
app.get("/api/nfse/minha-empresa/cnpj/:cnpj", requireCliente, requireModuloAtivo('nfse'), async (req, res) => {
  const cnpj = String(req.params.cnpj).replace(/\D/g, "");
  if (cnpj.length !== 14) return res.status(400).json({ error: "CNPJ inválido — precisa ter 14 dígitos." });
  try {
    const dados = await consultarCnpjBrasilApi(cnpj);
    if (dados.notFound) return res.status(404).json({ error: "CNPJ não encontrado na Receita Federal." });
    res.json(dados);
  } catch (e: any) {
    res.status(502).json({ error: `Não consegui consultar o CNPJ: ${e.message}` });
  }
});
app.get("/api/nfse/minha-empresa/cep/:cep", requireCliente, requireModuloAtivo('nfse'), async (req, res) => {
  const cep = String(req.params.cep).replace(/\D/g, "");
  if (cep.length !== 8) return res.status(400).json({ error: "CEP inválido — precisa ter 8 dígitos." });
  try {
    res.json(await nfseResolverCep(cep));
  } catch (e: any) {
    res.status(502).json({ error: `Não consegui consultar o CEP: ${e.message}` });
  }
});

// ---------- Financeiro do próprio negócio da empresa-cliente self-service (perfil Cliente) ----------
// Contas (banco/caixa) — só organizam/indicam onde cada título foi pago ou recebido, sem nenhuma
// integração bancária real (sem saldo calculado, sem extrato importado).
app.get("/api/financeiro/minha-empresa/contas", requireCliente, requireModuloAtivo('financeiro'), (req, res) => {
  const empresaId = (req as any).user.empresaId;
  const items = sqlite
    .prepare(`SELECT id, nome, tipo, ativo FROM financeiro_contas WHERE empresa_id = ? ORDER BY ativo DESC, nome`)
    .all(empresaId) as any[];
  res.json({ items: items.map((r) => ({ ...r, ativo: !!r.ativo })) });
});
app.post("/api/financeiro/minha-empresa/contas", requireCliente, requireModuloAtivo('financeiro'), (req, res) => {
  const user = (req as any).user;
  const { nome, tipo } = req.body || {};
  if (!nome || !String(nome).trim()) return res.status(400).json({ error: "Informe o nome da conta." });
  const tipoValido = ["banco", "caixa", "outro"].includes(tipo) ? tipo : "banco";
  const info = sqlite
    .prepare(`INSERT INTO financeiro_contas (empresa_id, nome, tipo) VALUES (?, ?, ?)`)
    .run(user.empresaId, String(nome).trim(), tipoValido);
  res.json({ id: Number(info.lastInsertRowid) });
});
app.put("/api/financeiro/minha-empresa/contas/:id", requireCliente, requireModuloAtivo('financeiro'), (req, res) => {
  const user = (req as any).user;
  const existente = sqlite.prepare(`SELECT * FROM financeiro_contas WHERE id = ? AND empresa_id = ?`).get(Number(req.params.id), user.empresaId) as any;
  if (!existente) return res.status(404).json({ error: "Conta não encontrada." });
  const { nome, tipo, ativo } = req.body || {};
  const tipoValido = ["banco", "caixa", "outro"].includes(tipo) ? tipo : existente.tipo;
  sqlite
    .prepare(`UPDATE financeiro_contas SET nome=?, tipo=?, ativo=? WHERE id=?`)
    .run(nome != null ? String(nome).trim() : existente.nome, tipoValido, ativo != null ? (ativo ? 1 : 0) : existente.ativo, existente.id);
  res.json({ ok: true });
});
app.delete("/api/financeiro/minha-empresa/contas/:id", requireCliente, requireModuloAtivo('financeiro'), (req, res) => {
  const user = (req as any).user;
  const existente = sqlite.prepare(`SELECT id FROM financeiro_contas WHERE id = ? AND empresa_id = ?`).get(Number(req.params.id), user.empresaId);
  if (!existente) return res.status(404).json({ error: "Conta não encontrada." });
  const emUso = sqlite
    .prepare(`SELECT (SELECT COUNT(*) FROM financeiro_pagar WHERE conta_id = ?) + (SELECT COUNT(*) FROM financeiro_receber WHERE conta_id = ?) as c`)
    .get(Number(req.params.id), Number(req.params.id)) as any;
  if (emUso.c > 0) return res.status(409).json({ error: "Esta conta já está usada em algum título — desative em vez de excluir." });
  sqlite.prepare(`DELETE FROM financeiro_contas WHERE id = ?`).run(Number(req.params.id));
  res.json({ ok: true });
});
app.get("/api/financeiro/minha-empresa/pagar", requireCliente, requireModuloAtivo('financeiro'), (req, res) => {
  const empresaId = (req as any).user.empresaId;
  const dataDe = typeof req.query.dataDe === "string" && req.query.dataDe ? req.query.dataDe : null;
  const dataAte = typeof req.query.dataAte === "string" && req.query.dataAte ? req.query.dataAte : null;
  let sql = `SELECT p.id, p.descricao, p.fornecedor, p.valor, p.vencimento, p.status, p.data_pagamento as dataPagamento, p.observacao,
                    p.conta_id as contaId, c.nome as contaNome, p.criado_em as criadoEm
             FROM financeiro_pagar p LEFT JOIN financeiro_contas c ON c.id = p.conta_id WHERE p.empresa_id = ?`;
  const params: any[] = [empresaId];
  if (dataDe) { sql += ` AND date(vencimento) >= date(?)`; params.push(dataDe); }
  if (dataAte) { sql += ` AND date(vencimento) <= date(?)`; params.push(dataAte); }
  sql += ` ORDER BY p.vencimento DESC, p.id DESC`;
  res.json({ items: sqlite.prepare(sql).all(...params) });
});
app.post("/api/financeiro/minha-empresa/pagar", requireCliente, requireModuloAtivo('financeiro'), (req, res) => {
  const user = (req as any).user;
  const { descricao, fornecedor, valor, vencimento, observacao, contaId } = req.body || {};
  if (!descricao || !valor || !vencimento) return res.status(400).json({ error: "Preencha a descrição, o valor e o vencimento." });
  const info = sqlite
    .prepare(`INSERT INTO financeiro_pagar (empresa_id, descricao, fornecedor, valor, vencimento, observacao, conta_id, criado_por) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(user.empresaId, String(descricao).trim(), fornecedor || null, Number(valor), String(vencimento), observacao || null, contaId ? Number(contaId) : null, user.id);
  res.json({ id: Number(info.lastInsertRowid) });
});
app.put("/api/financeiro/minha-empresa/pagar/:id", requireCliente, requireModuloAtivo('financeiro'), (req, res) => {
  const user = (req as any).user;
  const existente = sqlite.prepare(`SELECT * FROM financeiro_pagar WHERE id = ? AND empresa_id = ?`).get(Number(req.params.id), user.empresaId) as any;
  if (!existente) return res.status(404).json({ error: "Lançamento não encontrado." });
  const { descricao, fornecedor, valor, vencimento, status, observacao, contaId } = req.body || {};
  const statusValido = ["pendente", "pago", "atrasado", "cancelado"].includes(status) ? status : existente.status;
  sqlite
    .prepare(
      `UPDATE financeiro_pagar SET descricao=?, fornecedor=?, valor=?, vencimento=?, status=?, data_pagamento=?, observacao=?, conta_id=? WHERE id=?`
    )
    .run(
      descricao != null ? String(descricao).trim() : existente.descricao,
      fornecedor !== undefined ? fornecedor || null : existente.fornecedor,
      valor != null ? Number(valor) : existente.valor,
      vencimento || existente.vencimento,
      statusValido,
      statusValido === "pago" ? new Date().toISOString().slice(0, 10) : statusValido === existente.status ? existente.data_pagamento : null,
      observacao !== undefined ? observacao || null : existente.observacao,
      contaId !== undefined ? (contaId ? Number(contaId) : null) : existente.conta_id,
      existente.id
    );
  res.json({ ok: true });
});
app.delete("/api/financeiro/minha-empresa/pagar/:id", requireCliente, requireModuloAtivo('financeiro'), (req, res) => {
  const user = (req as any).user;
  sqlite.prepare(`DELETE FROM financeiro_pagar WHERE id = ? AND empresa_id = ?`).run(Number(req.params.id), user.empresaId);
  res.json({ ok: true });
});
app.get("/api/financeiro/minha-empresa/receber", requireCliente, requireModuloAtivo('financeiro'), (req, res) => {
  const empresaId = (req as any).user.empresaId;
  const dataDe = typeof req.query.dataDe === "string" && req.query.dataDe ? req.query.dataDe : null;
  const dataAte = typeof req.query.dataAte === "string" && req.query.dataAte ? req.query.dataAte : null;
  let sql = `SELECT r.id, r.descricao, r.cliente_nome as clienteNome, r.valor, r.vencimento, r.status, r.data_recebimento as dataRecebimento, r.observacao,
                    r.origem, r.nfse_emissao_id as nfseEmissaoId, r.conta_id as contaId, c.nome as contaNome, r.criado_em as criadoEm
             FROM financeiro_receber r LEFT JOIN financeiro_contas c ON c.id = r.conta_id WHERE r.empresa_id = ?`;
  const params: any[] = [empresaId];
  if (dataDe) { sql += ` AND date(vencimento) >= date(?)`; params.push(dataDe); }
  if (dataAte) { sql += ` AND date(vencimento) <= date(?)`; params.push(dataAte); }
  sql += ` ORDER BY r.vencimento DESC, r.id DESC`;
  res.json({ items: sqlite.prepare(sql).all(...params) });
});
app.post("/api/financeiro/minha-empresa/receber", requireCliente, requireModuloAtivo('financeiro'), (req, res) => {
  const user = (req as any).user;
  const { descricao, clienteNome, valor, vencimento, observacao, contaId } = req.body || {};
  if (!descricao || !valor || !vencimento) return res.status(400).json({ error: "Preencha a descrição, o valor e o vencimento." });
  const info = sqlite
    .prepare(`INSERT INTO financeiro_receber (empresa_id, descricao, cliente_nome, valor, vencimento, observacao, origem, conta_id, criado_por) VALUES (?, ?, ?, ?, ?, ?, 'manual', ?, ?)`)
    .run(user.empresaId, String(descricao).trim(), clienteNome || null, Number(valor), String(vencimento), observacao || null, contaId ? Number(contaId) : null, user.id);
  res.json({ id: Number(info.lastInsertRowid) });
});
app.put("/api/financeiro/minha-empresa/receber/:id", requireCliente, requireModuloAtivo('financeiro'), (req, res) => {
  const user = (req as any).user;
  const existente = sqlite.prepare(`SELECT * FROM financeiro_receber WHERE id = ? AND empresa_id = ?`).get(Number(req.params.id), user.empresaId) as any;
  if (!existente) return res.status(404).json({ error: "Lançamento não encontrado." });
  const { descricao, clienteNome, valor, vencimento, status, observacao, contaId } = req.body || {};
  const statusValido = ["pendente", "pago", "atrasado", "cancelado"].includes(status) ? status : existente.status;
  // Lançamentos gerados pela NFS-e (origem='nfse') têm descrição/valor travados — só vencimento,
  // status, conta e observação são editáveis, pra não desalinhar do valor real da nota emitida.
  const travadoPelaNfse = existente.origem === "nfse";
  sqlite
    .prepare(
      `UPDATE financeiro_receber SET descricao=?, cliente_nome=?, valor=?, vencimento=?, status=?, data_recebimento=?, observacao=?, conta_id=? WHERE id=?`
    )
    .run(
      travadoPelaNfse ? existente.descricao : descricao != null ? String(descricao).trim() : existente.descricao,
      travadoPelaNfse ? existente.cliente_nome : clienteNome !== undefined ? clienteNome || null : existente.cliente_nome,
      travadoPelaNfse ? existente.valor : valor != null ? Number(valor) : existente.valor,
      vencimento || existente.vencimento,
      statusValido,
      statusValido === "pago" ? new Date().toISOString().slice(0, 10) : statusValido === existente.status ? existente.data_recebimento : null,
      observacao !== undefined ? observacao || null : existente.observacao,
      contaId !== undefined ? (contaId ? Number(contaId) : null) : existente.conta_id,
      existente.id
    );
  res.json({ ok: true });
});
app.delete("/api/financeiro/minha-empresa/receber/:id", requireCliente, requireModuloAtivo('financeiro'), (req, res) => {
  const user = (req as any).user;
  const existente = sqlite.prepare(`SELECT origem FROM financeiro_receber WHERE id = ? AND empresa_id = ?`).get(Number(req.params.id), user.empresaId) as any;
  if (!existente) return res.status(404).json({ error: "Lançamento não encontrado." });
  if (existente.origem === "nfse") return res.status(409).json({ error: "Este recebível veio de uma NFS-e emitida — cancele a nota se não for mais válido, em vez de excluir aqui." });
  sqlite.prepare(`DELETE FROM financeiro_receber WHERE id = ?`).run(Number(req.params.id));
  res.json({ ok: true });
});

// ---------- Catálogo de módulos, teste grátis de 3 dias e contratação self-service (Asaas) ----------
function moduloStatusParaEmpresa(catalogo: any, contratado: any) {
  const agora = new Date().toISOString().replace("T", " ").slice(0, 19);
  if (!contratado) return { status: "nao_contratado", acesso: false };
  if (contratado.assinatura_ativa_ate && agora <= contratado.assinatura_ativa_ate) return { status: "ativo", acesso: true };
  if (agora <= contratado.trial_fim) return { status: "teste", acesso: true };
  if (contratado.assinatura_ativa_ate) return { status: "vencido", acesso: false };
  return { status: "teste_vencido", acesso: false };
}
function nfseModulosDaEmpresa(empresaId: number) {
  const empresa = sqlite.prepare(`SELECT isento_assinatura FROM empresas WHERE id = ?`).get(empresaId) as any;
  const isento = !!empresa?.isento_assinatura;
  const catalogo = sqlite.prepare(`SELECT * FROM modulos_catalogo ORDER BY chave`).all() as any[];
  const contratados = sqlite.prepare(`SELECT * FROM empresa_modulos WHERE empresa_id = ?`).all(empresaId) as any[];
  const porChave = new Map(contratados.map((c) => [c.modulo_chave, c]));
  return catalogo.map((m) => {
    const contratado = porChave.get(m.chave);
    const { status, acesso } = isento ? { status: "isento", acesso: true } : moduloStatusParaEmpresa(m, contratado);
    return {
      chave: m.chave,
      nome: m.nome,
      valorMensal: m.valor_mensal,
      ativo: !!m.ativo,
      status,
      acesso,
      trialFim: contratado?.trial_fim || null,
      trialProrrogado: !!contratado?.trial_prorrogado,
      assinaturaAtivaAte: contratado?.assinatura_ativa_ate || null,
    };
  });
}
app.get("/api/financeiro/minha-empresa/modulos", requireCliente, (req, res) => {
  res.json({ items: nfseModulosDaEmpresa((req as any).user.empresaId) });
});
app.post("/api/financeiro/minha-empresa/modulos/:chave/iniciar-teste", requireCliente, (req, res) => {
  const empresaId = (req as any).user.empresaId;
  const chave = String(req.params.chave);
  const modulo = sqlite.prepare(`SELECT * FROM modulos_catalogo WHERE chave = ? AND ativo = 1`).get(chave) as any;
  if (!modulo) return res.status(404).json({ error: "Módulo não encontrado." });
  const existente = sqlite.prepare(`SELECT 1 FROM empresa_modulos WHERE empresa_id = ? AND modulo_chave = ?`).get(empresaId, chave);
  if (existente) return res.status(409).json({ error: "O teste desse módulo já foi iniciado antes." });
  sqlite
    .prepare(`INSERT INTO empresa_modulos (empresa_id, modulo_chave, trial_inicio, trial_fim) VALUES (?, ?, datetime('now'), datetime('now','+3 days'))`)
    .run(empresaId, chave);
  res.json({ ok: true, items: nfseModulosDaEmpresa(empresaId) });
});
app.post("/api/financeiro/minha-empresa/modulos/pagar", requireCliente, async (req, res) => {
  const empresaId = (req as any).user.empresaId;
  const chaves: string[] = Array.isArray(req.body?.modulos) ? req.body.modulos : [];
  if (!chaves.length) return res.status(400).json({ error: "Selecione ao menos um módulo." });
  const catalogo = sqlite
    .prepare(`SELECT chave, nome, valor_mensal FROM modulos_catalogo WHERE ativo = 1 AND chave IN (${chaves.map(() => "?").join(",")})`)
    .all(...chaves) as any[];
  if (!catalogo.length) return res.status(400).json({ error: "Nenhum dos módulos selecionados está disponível." });
  const valorTotal = catalogo.reduce((soma, m) => soma + Number(m.valor_mensal), 0);
  if (!valorTotal) return res.status(400).json({ error: "O valor desses módulos ainda não foi configurado — entre em contato com o suporte." });
  const empresa = sqlite.prepare(`SELECT nome, cnpj, email, telefone, asaas_customer_id FROM empresas WHERE id = ?`).get(empresaId) as any;
  // Reaproveita uma cobrança pendente já gerada com exatamente o mesmo conjunto de módulos, pra não
  // duplicar cobrança no Asaas se o cliente clicar "Pagar" mais de uma vez.
  const pendentes = sqlite.prepare(`SELECT * FROM financeiro_licenca_cobrancas WHERE empresa_id = ? AND status = 'pendente' ORDER BY id DESC`).all(empresaId) as any[];
  let cobranca = pendentes.find((c) => {
    const itens = sqlite.prepare(`SELECT modulo_chave FROM financeiro_licenca_cobranca_itens WHERE cobranca_id = ?`).all(c.id) as any[];
    const chavesCobranca = itens.map((i) => i.modulo_chave).sort().join(",");
    return chavesCobranca === [...chaves].sort().join(",");
  });
  try {
    let customerId = empresa.asaas_customer_id;
    if (!customerId) {
      customerId = await asaas.obterOuCriarCliente({ cpfCnpj: empresa.cnpj, nome: empresa.nome, email: empresa.email, telefone: empresa.telefone });
      sqlite.prepare(`UPDATE empresas SET asaas_customer_id = ? WHERE id = ?`).run(customerId, empresaId);
    }
    if (!cobranca) {
      const vencimento = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      const descricao = `Assinatura — ${catalogo.map((m) => m.nome).join(", ")}`;
      const gerada = await asaas.criarCobranca({ customerId, valor: valorTotal, vencimento, descricao });
      const info = sqlite
        .prepare(`INSERT INTO financeiro_licenca_cobrancas (empresa_id, valor_total, vencimento, status, asaas_payment_id, invoice_url) VALUES (?, ?, ?, 'pendente', ?, ?)`)
        .run(empresaId, valorTotal, vencimento, gerada.id, gerada.invoiceUrl);
      const cobrancaId = Number(info.lastInsertRowid);
      for (const m of catalogo) {
        sqlite.prepare(`INSERT INTO financeiro_licenca_cobranca_itens (cobranca_id, modulo_chave, valor) VALUES (?, ?, ?)`).run(cobrancaId, m.chave, m.valor_mensal);
      }
      cobranca = sqlite.prepare(`SELECT * FROM financeiro_licenca_cobrancas WHERE id = ?`).get(cobrancaId);
    }
    // O QR code Pix não fica pronto no exato instante em que a cobrança é criada no Asaas — se a
    // primeira tentativa falhar, espera um pouco e tenta de novo antes de desistir e seguir só com
    // o link da fatura (confirmado num teste real: falha na hora, funciona ~1s depois).
    let pix: asaas.PixQrCode | null = null;
    for (let tentativa = 0; tentativa < 3 && !pix; tentativa++) {
      try {
        pix = await asaas.obterQrCodePix(cobranca.asaas_payment_id);
      } catch {
        if (tentativa < 2) await new Promise((r) => setTimeout(r, 1200));
      }
    }
    if (pix) {
      sqlite.prepare(`UPDATE financeiro_licenca_cobrancas SET pix_qrcode = ?, pix_qrcode_imagem = ? WHERE id = ?`).run(pix.payload, pix.imagemBase64, cobranca.id);
    }
    res.json({ invoiceUrl: cobranca.invoice_url, pixPayload: pix?.payload || null, pixImagemBase64: pix?.imagemBase64 || null, valorTotal });
  } catch (e: any) {
    res.status(502).json({ error: e.message });
  }
});

// ---------- Módulos da plataforma que o próprio escritório-cliente contrata (não confundir com o
// catálogo acima, que o escritório vende PRA empresa-cliente dele) ----------
// SuperAdmin: gerencia preço/nome/ativo do catálogo (rota administrativa da plataforma).
app.get("/api/super/modulos-catalogo", requireSuperAdmin, (_req, res) => {
  const rows = sqlite.prepare(`SELECT chave, nome, valor_mensal as valorMensal, ativo FROM modulos_escritorio_catalogo ORDER BY chave`).all() as any[];
  res.json({ items: rows.map((r) => ({ ...r, ativo: !!r.ativo })) });
});
app.put("/api/super/modulos-catalogo/:chave", requireSuperAdmin, (req, res) => {
  const chave = String(req.params.chave);
  const existente = sqlite.prepare(`SELECT chave FROM modulos_escritorio_catalogo WHERE chave = ?`).get(chave);
  if (!existente) return res.status(404).json({ error: "Módulo não encontrado." });
  const { nome, valorMensal, ativo } = req.body || {};
  sqlite
    .prepare(`UPDATE modulos_escritorio_catalogo SET nome = COALESCE(?, nome), valor_mensal = COALESCE(?, valor_mensal), ativo = COALESCE(?, ativo), updated_at = datetime('now') WHERE chave = ?`)
    .run(nome ?? null, valorMensal != null ? Number(valorMensal) : null, ativo != null ? (ativo ? 1 : 0) : null, chave);
  res.json({ ok: true });
});
function moduloStatusParaEscritorio(catalogo: any, contratado: any) {
  const agora = new Date().toISOString().replace("T", " ").slice(0, 19);
  if (!contratado) return { status: "nao_contratado", acesso: false };
  if (contratado.assinatura_ativa_ate && agora <= contratado.assinatura_ativa_ate) return { status: "ativo", acesso: true };
  if (agora <= contratado.trial_fim) return { status: "teste", acesso: true };
  if (contratado.assinatura_ativa_ate) return { status: "vencido", acesso: false };
  return { status: "teste_vencido", acesso: false };
}
// Colaboradores ativos e não isentos — é essa contagem que multiplica o valor unitário do módulo
// 'assento_colaborador' na fatura do escritório.
function contarAssentosColaborador(escritorioId: number): number {
  const r = sqlite
    .prepare(`SELECT COUNT(*) as c FROM app_users WHERE escritorio_id = ? AND perfil = 'Colaborador' AND ativo = 1 AND isento_assinatura = 0`)
    .get(escritorioId) as any;
  return r.c;
}
// Usado tanto pela tela de assinatura (Administrador do escritório) quanto pelos pontos do código
// que precisam saber se um escritório tem direito a rodar a rotina automática de NFS-e / mandar por
// e-mail ou WhatsApp automaticamente.
function modulosDoEscritorio(escritorioId: number) {
  const catalogo = sqlite.prepare(`SELECT * FROM modulos_escritorio_catalogo ORDER BY chave`).all() as any[];
  const contratados = sqlite.prepare(`SELECT * FROM escritorio_modulos WHERE escritorio_id = ?`).all(escritorioId) as any[];
  const porChave = new Map(contratados.map((c) => [c.modulo_chave, c]));
  const assentos = contarAssentosColaborador(escritorioId);
  return catalogo.map((m) => {
    const contratado = porChave.get(m.chave);
    const { status, acesso } = moduloStatusParaEscritorio(m, contratado);
    const porAssento = m.chave === "assento_colaborador";
    return {
      chave: m.chave,
      nome: m.nome,
      valorMensal: porAssento ? m.valor_mensal * assentos : m.valor_mensal,
      valorUnitario: porAssento ? m.valor_mensal : null,
      quantidade: porAssento ? assentos : null,
      ativo: !!m.ativo,
      status,
      acesso,
      trialFim: contratado?.trial_fim || null,
      trialProrrogado: !!contratado?.trial_prorrogado,
      assinaturaAtivaAte: contratado?.assinatura_ativa_ate || null,
    };
  });
}
// Confere se um escritório tem acesso ativo (teste ou pago) a um módulo específico — usado pelos
// pontos do código que gatilham comportamento automático (rotina de NFS-e, envio automático).
function escritorioTemModulo(escritorioId: number, chave: string): boolean {
  const m = sqlite.prepare(`SELECT * FROM modulos_escritorio_catalogo WHERE chave = ?`).get(chave) as any;
  if (!m) return false;
  const contratado = sqlite.prepare(`SELECT * FROM escritorio_modulos WHERE escritorio_id = ? AND modulo_chave = ?`).get(escritorioId, chave) as any;
  return moduloStatusParaEscritorio(m, contratado).acesso;
}
// Dados de faturamento do próprio escritório (CNPJ/e-mail/telefone) — precisa estar preenchido
// antes de gerar qualquer cobrança via Asaas (é o CPF/CNPJ que identifica o cliente lá).
app.get("/api/escritorio/dados-faturamento", blockCliente, requirePermissao("configuracoes", "visualizar"), (req, res) => {
  const row = sqlite.prepare(`SELECT nome, cnpj, email, telefone FROM escritorios WHERE id = ?`).get((req as any).user.escritorioId) as any;
  res.json(row || {});
});
app.put("/api/escritorio/dados-faturamento", blockCliente, requirePermissao("configuracoes", "editar"), (req, res) => {
  const { nome, cnpj, email, telefone } = req.body || {};
  if (!nome || !String(nome).trim()) return res.status(400).json({ error: "Informe o nome do escritório." });
  const cnpjLimpo = cnpj ? String(cnpj).replace(/\D/g, "") : "";
  if (!cnpjLimpo || cnpjLimpo.length !== 14) return res.status(400).json({ error: "Informe um CNPJ válido (14 dígitos)." });
  sqlite
    .prepare(`UPDATE escritorios SET nome = ?, cnpj = ?, email = ?, telefone = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(String(nome).trim(), cnpjLimpo, email ? String(email).trim() : null, telefone ? String(telefone).replace(/\D/g, "") : null, (req as any).user.escritorioId);
  res.json({ ok: true });
});
app.get("/api/escritorio/modulos", blockCliente, requirePermissao("configuracoes", "visualizar"), (req, res) => {
  res.json({ items: modulosDoEscritorio((req as any).user.escritorioId) });
});
// Status individual do Colaborador logado — quem paga de verdade é o escritório (cobrança agregada
// em /api/escritorio/modulos/pagar), essa tela é só informativa: mostra se esse assento específico
// está isento, incluído no teste/assinatura ativa do escritório, ou fora (assinatura vencida).
app.get("/api/colaborador/minha-assinatura", (req, res) => {
  const user = (req as any).user;
  if (user.perfil !== "Colaborador") return res.status(403).json({ error: "Essa tela é só para o perfil Colaborador." });
  const isento = sqlite.prepare(`SELECT isento_assinatura FROM app_users WHERE id = ?`).get(user.id) as any;
  const m = sqlite.prepare(`SELECT * FROM modulos_escritorio_catalogo WHERE chave = 'assento_colaborador'`).get() as any;
  const contratado = sqlite.prepare(`SELECT * FROM escritorio_modulos WHERE escritorio_id = ? AND modulo_chave = 'assento_colaborador'`).get(user.escritorioId) as any;
  const { status, acesso } = moduloStatusParaEscritorio(m, contratado);
  res.json({
    isento: !!isento?.isento_assinatura,
    valorUnitario: m?.valor_mensal ?? 0,
    status,
    acesso,
    trialFim: contratado?.trial_fim || null,
    assinaturaAtivaAte: contratado?.assinatura_ativa_ate || null,
  });
});
app.post("/api/escritorio/modulos/:chave/iniciar-teste", blockCliente, requirePermissao("configuracoes", "postar"), (req, res) => {
  const escritorioId = (req as any).user.escritorioId;
  const chave = String(req.params.chave);
  const modulo = sqlite.prepare(`SELECT * FROM modulos_escritorio_catalogo WHERE chave = ? AND ativo = 1`).get(chave) as any;
  if (!modulo) return res.status(404).json({ error: "Módulo não encontrado." });
  const existente = sqlite.prepare(`SELECT 1 FROM escritorio_modulos WHERE escritorio_id = ? AND modulo_chave = ?`).get(escritorioId, chave);
  if (existente) return res.status(409).json({ error: "O teste desse módulo já foi iniciado antes." });
  sqlite
    .prepare(`INSERT INTO escritorio_modulos (escritorio_id, modulo_chave, trial_inicio, trial_fim) VALUES (?, ?, datetime('now'), datetime('now','+3 days'))`)
    .run(escritorioId, chave);
  res.json({ ok: true, items: modulosDoEscritorio(escritorioId) });
});
app.post("/api/escritorio/modulos/pagar", blockCliente, requirePermissao("configuracoes", "postar"), async (req, res) => {
  const user = (req as any).user;
  const escritorioId = user.escritorioId;
  const chaves: string[] = Array.isArray(req.body?.modulos) ? req.body.modulos : [];
  if (!chaves.length) return res.status(400).json({ error: "Selecione ao menos um módulo." });
  const catalogo = sqlite
    .prepare(`SELECT chave, nome, valor_mensal FROM modulos_escritorio_catalogo WHERE ativo = 1 AND chave IN (${chaves.map(() => "?").join(",")})`)
    .all(...chaves) as any[];
  if (!catalogo.length) return res.status(400).json({ error: "Nenhum dos módulos selecionados está disponível." });
  const assentos = contarAssentosColaborador(escritorioId);
  // 'assento_colaborador' não é preço fixo — o item cobra o valor unitário do catálogo multiplicado
  // pela quantidade de colaboradores ativos e não isentos no momento da cobrança.
  const itensCalculados = catalogo.map((m) => ({
    chave: m.chave,
    nome: m.chave === "assento_colaborador" ? `${m.nome} (${assentos}x)` : m.nome,
    quantidade: m.chave === "assento_colaborador" ? assentos : 1,
    valor: m.chave === "assento_colaborador" ? Number(m.valor_mensal) * assentos : Number(m.valor_mensal),
  }));
  const valorTotal = itensCalculados.reduce((soma, m) => soma + m.valor, 0);
  if (!valorTotal) return res.status(400).json({ error: "O valor desses módulos ainda não foi configurado — entre em contato com o suporte." });
  const escritorio = sqlite.prepare(`SELECT nome, cnpj, email, telefone, asaas_customer_id FROM escritorios WHERE id = ?`).get(escritorioId) as any;
  const pendentes = sqlite.prepare(`SELECT * FROM escritorio_licenca_cobrancas WHERE escritorio_id = ? AND status = 'pendente' ORDER BY id DESC`).all(escritorioId) as any[];
  let cobranca = pendentes.find((c) => {
    const itens = sqlite.prepare(`SELECT modulo_chave, quantidade FROM escritorio_licenca_cobranca_itens WHERE cobranca_id = ?`).all(c.id) as any[];
    const chavesCobranca = itens.map((i) => i.modulo_chave).sort().join(",");
    if (chavesCobranca !== [...chaves].sort().join(",")) return false;
    // Se a quantidade de assentos mudou desde a última cobrança pendente gerada, não reaproveita —
    // gera uma nova, senão o cliente pagaria um valor desatualizado.
    const itemAssento = itens.find((i) => i.modulo_chave === "assento_colaborador");
    return !itemAssento || itemAssento.quantidade === assentos;
  });
  try {
    let customerId = escritorio.asaas_customer_id;
    if (!customerId) {
      customerId = await asaas.obterOuCriarCliente({ cpfCnpj: escritorio.cnpj, nome: escritorio.nome, email: escritorio.email, telefone: escritorio.telefone });
      sqlite.prepare(`UPDATE escritorios SET asaas_customer_id = ? WHERE id = ?`).run(customerId, escritorioId);
    }
    if (!cobranca) {
      const vencimento = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      const descricao = `Assinatura — ${itensCalculados.map((m) => m.nome).join(", ")}`;
      const gerada = await asaas.criarCobranca({ customerId, valor: valorTotal, vencimento, descricao });
      const info = sqlite
        .prepare(`INSERT INTO escritorio_licenca_cobrancas (escritorio_id, valor_total, vencimento, status, asaas_payment_id, invoice_url) VALUES (?, ?, ?, 'pendente', ?, ?)`)
        .run(escritorioId, valorTotal, vencimento, gerada.id, gerada.invoiceUrl);
      const cobrancaId = Number(info.lastInsertRowid);
      for (const m of itensCalculados) {
        sqlite.prepare(`INSERT INTO escritorio_licenca_cobranca_itens (cobranca_id, modulo_chave, valor, quantidade) VALUES (?, ?, ?, ?)`).run(cobrancaId, m.chave, m.valor, m.quantidade);
      }
      cobranca = sqlite.prepare(`SELECT * FROM escritorio_licenca_cobrancas WHERE id = ?`).get(cobrancaId);
    }
    let pix: asaas.PixQrCode | null = null;
    for (let tentativa = 0; tentativa < 3 && !pix; tentativa++) {
      try {
        pix = await asaas.obterQrCodePix(cobranca.asaas_payment_id);
      } catch {
        if (tentativa < 2) await new Promise((r) => setTimeout(r, 1200));
      }
    }
    if (pix) {
      sqlite.prepare(`UPDATE escritorio_licenca_cobrancas SET pix_qrcode = ?, pix_qrcode_imagem = ? WHERE id = ?`).run(pix.payload, pix.imagemBase64, cobranca.id);
    }
    res.json({ invoiceUrl: cobranca.invoice_url, pixPayload: pix?.payload || null, pixImagemBase64: pix?.imagemBase64 || null, valorTotal });
  } catch (e: any) {
    res.status(502).json({ error: e.message });
  }
});

// Webhook público do Asaas — validado por um token simples configurado no painel deles (query
// string ?token=... apontando pro mesmo valor de ASAAS_WEBHOOK_TOKEN no .env), já que não tem
// sessão de usuário nessa chamada (o Asaas quem chama, não o navegador de ninguém).
app.post("/api/asaas/webhook", (req, res) => {
  const tokenEsperado = process.env.ASAAS_WEBHOOK_TOKEN;
  if (tokenEsperado && req.query.token !== tokenEsperado) return res.status(403).json({ error: "Token inválido." });
  const { event, payment } = req.body || {};
  if (!payment?.id) return res.status(400).json({ error: "Corpo inválido." });
  const statusMap: Record<string, string> = {
    PAYMENT_CONFIRMED: "confirmado",
    PAYMENT_RECEIVED: "recebido",
    PAYMENT_OVERDUE: "vencido",
    PAYMENT_DELETED: "cancelado",
  };
  const novoStatus = statusMap[event];
  if (!novoStatus) return res.json({ ok: true });
  const agora = new Date().toISOString().replace("T", " ").slice(0, 19);

  // Uma cobrança do Asaas com esse payment_id pertence OU a uma empresa-cliente (módulos que o
  // escritório vende pra ela) OU a um escritório-cliente da plataforma (módulos da plataforma) —
  // nunca as duas, mas o webhook não sabe de antemão qual foi, então confere as duas tabelas.
  const cobrancaEmpresa = sqlite.prepare(`SELECT * FROM financeiro_licenca_cobrancas WHERE asaas_payment_id = ?`).get(payment.id) as any;
  if (cobrancaEmpresa) {
    sqlite.prepare(`UPDATE financeiro_licenca_cobrancas SET status = ? WHERE id = ?`).run(novoStatus, cobrancaEmpresa.id);
    if (novoStatus === "confirmado" || novoStatus === "recebido") {
      const itens = sqlite.prepare(`SELECT modulo_chave FROM financeiro_licenca_cobranca_itens WHERE cobranca_id = ?`).all(cobrancaEmpresa.id) as any[];
      for (const item of itens) {
        const atual = sqlite.prepare(`SELECT assinatura_ativa_ate FROM empresa_modulos WHERE empresa_id = ? AND modulo_chave = ?`).get(cobrancaEmpresa.empresa_id, item.modulo_chave) as any;
        if (atual) {
          const base = atual.assinatura_ativa_ate && atual.assinatura_ativa_ate > agora ? atual.assinatura_ativa_ate : agora;
          sqlite
            .prepare(`UPDATE empresa_modulos SET assinatura_ativa_ate = datetime(?, '+1 month') WHERE empresa_id = ? AND modulo_chave = ?`)
            .run(base, cobrancaEmpresa.empresa_id, item.modulo_chave);
        } else {
          sqlite
            .prepare(
              `INSERT INTO empresa_modulos (empresa_id, modulo_chave, trial_inicio, trial_fim, assinatura_ativa_ate) VALUES (?, ?, datetime('now'), datetime('now'), datetime('now','+1 month'))`
            )
            .run(cobrancaEmpresa.empresa_id, item.modulo_chave);
        }
      }
    }
    return res.json({ ok: true });
  }
  const cobrancaEscritorio = sqlite.prepare(`SELECT * FROM escritorio_licenca_cobrancas WHERE asaas_payment_id = ?`).get(payment.id) as any;
  if (cobrancaEscritorio) {
    sqlite.prepare(`UPDATE escritorio_licenca_cobrancas SET status = ? WHERE id = ?`).run(novoStatus, cobrancaEscritorio.id);
    if (novoStatus === "confirmado" || novoStatus === "recebido") {
      const itens = sqlite.prepare(`SELECT modulo_chave FROM escritorio_licenca_cobranca_itens WHERE cobranca_id = ?`).all(cobrancaEscritorio.id) as any[];
      for (const item of itens) {
        const atual = sqlite.prepare(`SELECT assinatura_ativa_ate FROM escritorio_modulos WHERE escritorio_id = ? AND modulo_chave = ?`).get(cobrancaEscritorio.escritorio_id, item.modulo_chave) as any;
        if (atual) {
          const base = atual.assinatura_ativa_ate && atual.assinatura_ativa_ate > agora ? atual.assinatura_ativa_ate : agora;
          sqlite
            .prepare(`UPDATE escritorio_modulos SET assinatura_ativa_ate = datetime(?, '+1 month') WHERE escritorio_id = ? AND modulo_chave = ?`)
            .run(base, cobrancaEscritorio.escritorio_id, item.modulo_chave);
        } else {
          sqlite
            .prepare(
              `INSERT INTO escritorio_modulos (escritorio_id, modulo_chave, trial_inicio, trial_fim, assinatura_ativa_ate) VALUES (?, ?, datetime('now'), datetime('now'), datetime('now','+1 month'))`
            )
            .run(cobrancaEscritorio.escritorio_id, item.modulo_chave);
        }
      }
    }
  }
  res.json({ ok: true });
});

// ---------- Financeiro (honorários) ----------
app.get("/api/financeiro/honorarios", blockCliente, requirePermissao("financeiro", "visualizar"), (req, res) => {
  const user = (req as any).user;
  let rows = sqlite
    .prepare(`SELECT h.*, e.nome as empresaNome FROM honorarios h JOIN empresas e ON e.id = h.empresa_id WHERE e.ativo = 1 ORDER BY e.nome`)
    .all() as any[];
  const visiveis = empresasVisiveis(user);
  if (visiveis !== null) rows = rows.filter((r) => visiveis.includes(r.empresa_id));
  res.json({ items: rows });
});
app.put("/api/financeiro/honorarios/:empresaId", blockCliente, requirePermissao("financeiro", "editar"), (req, res) => {
  const empresaId = Number(req.params.empresaId);
  if (!podeAcessarEmpresa((req as any).user, empresaId)) return res.status(404).json({ error: "Empresa não encontrada." });
  const { valor, diaVencimento, ativo, observacao } = req.body || {};
  sqlite
    .prepare(
      `INSERT INTO honorarios (empresa_id, valor, dia_vencimento, ativo, observacao, updated_at) VALUES (?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(empresa_id) DO UPDATE SET valor=excluded.valor, dia_vencimento=excluded.dia_vencimento, ativo=excluded.ativo, observacao=excluded.observacao, updated_at=datetime('now')`
    )
    .run(empresaId, Number(valor) || 0, Number(diaVencimento) || 10, ativo === false ? 0 : 1, observacao || null);
  res.json({ ok: true });
});

app.get("/api/financeiro/lancamentos", blockCliente, requirePermissao("financeiro", "visualizar"), (req, res) => {
  const user = (req as any).user;
  const competencia = req.query.competencia ? String(req.query.competencia) : null;
  let sql = `SELECT l.*, e.nome as empresaNome FROM honorarios_lancamentos l JOIN empresas e ON e.id = l.empresa_id`;
  const params: any[] = [];
  if (competencia) {
    sql += ` WHERE l.competencia = ?`;
    params.push(competencia);
  }
  sql += ` ORDER BY e.nome`;
  let rows = sqlite.prepare(sql).all(...params) as any[];
  const visiveis = empresasVisiveis(user);
  if (visiveis !== null) rows = rows.filter((r) => visiveis.includes(r.empresa_id));
  res.json({ items: rows });
});
// Gera os lançamentos do mês a partir dos honorários ativos (não duplica: UNIQUE empresa+competência)
app.post("/api/financeiro/lancamentos/gerar", blockCliente, requirePermissao("financeiro", "postar"), (req, res) => {
  const { competencia } = req.body || {}; // 'YYYY-MM'
  if (!/^\d{4}-\d{2}$/.test(competencia || "")) return res.status(400).json({ error: "Informe a competência no formato AAAA-MM." });
  const honorariosAtivos = sqlite
    .prepare(`SELECT h.* FROM honorarios h JOIN empresas e ON e.id = h.empresa_id WHERE h.ativo = 1 AND e.ativo = 1 AND e.escritorio_id = ?`)
    .all((req as any).user.escritorioId) as any[];
  const insert = sqlite.prepare(
    `INSERT OR IGNORE INTO honorarios_lancamentos (empresa_id, competencia, valor, vencimento, status) VALUES (?, ?, ?, ?, 'pendente')`
  );
  let criados = 0;
  const [ano, mes] = competencia.split("-").map(Number);
  for (const h of honorariosAtivos) {
    const ultimoDia = new Date(ano, mes, 0).getDate();
    const dia = Math.min(h.dia_vencimento, ultimoDia);
    const vencimento = `${competencia}-${String(dia).padStart(2, "0")}`;
    const info = insert.run(h.empresa_id, competencia, h.valor, vencimento);
    if (info.changes) criados++;
  }
  res.json({ ok: true, criados });
});
app.put("/api/financeiro/lancamentos/:id", blockCliente, requirePermissao("financeiro", "editar"), (req, res) => {
  const id = Number(req.params.id);
  const { status, dataPagamento, formaPagamento, observacao, valor } = req.body || {};
  const existing = sqlite.prepare(`SELECT * FROM honorarios_lancamentos WHERE id = ?`).get(id) as any;
  if (!existing || !podeAcessarEmpresa((req as any).user, existing.empresa_id)) return res.status(404).json({ error: "Lançamento não encontrado." });
  sqlite
    .prepare(`UPDATE honorarios_lancamentos SET status=?, data_pagamento=?, forma_pagamento=?, observacao=?, valor=? WHERE id=?`)
    .run(
      status ?? existing.status,
      dataPagamento !== undefined ? dataPagamento : existing.data_pagamento,
      formaPagamento !== undefined ? formaPagamento : existing.forma_pagamento,
      observacao !== undefined ? observacao : existing.observacao,
      valor !== undefined ? Number(valor) : existing.valor,
      id
    );
  res.json({ ok: true });
});
app.get("/api/financeiro/resumo", blockCliente, requirePermissao("financeiro", "visualizar"), (req, res) => {
  const competencia = req.query.competencia ? String(req.query.competencia) : new Date().toISOString().slice(0, 7);
  const rows = sqlite
    .prepare(
      `SELECT l.status, SUM(l.valor) as total, COUNT(*) as qtd FROM honorarios_lancamentos l
       JOIN empresas e ON e.id = l.empresa_id
       WHERE l.competencia = ? AND e.escritorio_id = ? GROUP BY l.status`
    )
    .all(competencia, (req as any).user.escritorioId) as any[];
  const resumo: Record<string, { total: number; qtd: number }> = { pendente: { total: 0, qtd: 0 }, pago: { total: 0, qtd: 0 }, atrasado: { total: 0, qtd: 0 }, cancelado: { total: 0, qtd: 0 } };
  for (const r of rows) resumo[r.status] = { total: r.total || 0, qtd: r.qtd };
  res.json({ competencia, resumo });
});

// ---------- Painel (cards de indicadores) ----------
// Cards "computados": em vez de um valor digitado à mão, mostram uma contagem calculada na hora a
// partir de dados reais — e ao clicar, abrem a lista detalhada por trás daquela contagem. Cada
// função abaixo devolve a lista (o card mostra só items.length); todas já filtram pelas empresas
// que o usuário logado pode ver (empresasVisiveis), pro caso de um Colaborador restrito abrir o
// Painel.
const CARD_TIPOS: string[] = ["certificados_vencer", "das_atraso", "situacao_fiscal", "caixapostal_nao_lida", "checklist_atraso", "solicitacoes_pendentes", "envio_atraso", "solicitacao_atraso", "licencas_vencer"];

// Piso de competência (aaaamm, ex.: 202607) configurado em painel_monitoramento_config — null
// quando não há corte definido (comportamento de sempre: cada card usa o período mais antigo já
// gerado na grade). Usado por todo card "computado" de pendência que varre um calendário mês a mês.
function painelMonitoramentoCorte(escritorioId: number): number | null {
  const row = sqlite
    .prepare(`SELECT competencia_inicio_ano as ano, competencia_inicio_mes as mes FROM painel_monitoramento_config WHERE escritorio_id = ?`)
    .get(escritorioId) as any;
  if (!row || !row.ano || !row.mes) return null;
  return row.ano * 100 + row.mes;
}

// Unifica os 3 lugares onde uma data de validade de certificado é guardada hoje (emissão de NFS-e,
// Busca de XML, e-CNPJ do Integra Contador) numa lista só — o card não sabe (nem precisa saber) de
// onde cada item veio, só que "vence em breve".
function cardCertificadosAVencer(user: any, diasLimite = 30): any[] {
  const escritorioId = user.escritorioId;
  const visiveis = new Set(empresasVisiveis(user));
  const limite = new Date(Date.now() + diasLimite * 86400000).toISOString();
  const itens: any[] = [];
  const nfse = sqlite
    .prepare(
      `SELECT c.empresa_id as empresaId, e.nome as empresaNome, e.ativo as empresaAtivo, c.validade_ate as validadeAte
       FROM nfse_certificados c LEFT JOIN empresas e ON e.id = c.empresa_id
       WHERE c.escritorio_id = ? AND c.validade_ate IS NOT NULL AND c.validade_ate <= ?`
    )
    .all(escritorioId, limite) as any[];
  for (const r of nfse) {
    if (r.empresaId && (!visiveis.has(r.empresaId) || !r.empresaAtivo)) continue;
    itens.push({ tipo: "NFS-e (emissão)", empresaId: r.empresaId, empresaNome: r.empresaNome || "Escritório (procuração)", validadeAte: r.validadeAte });
  }
  const nfe = sqlite
    .prepare(
      `SELECT c.empresa_id as empresaId, e.nome as empresaNome, c.validade_ate as validadeAte
       FROM nfe_busca_config c JOIN empresas e ON e.id = c.empresa_id
       WHERE c.escritorio_id = ? AND e.ativo = 1 AND c.validade_ate IS NOT NULL AND c.validade_ate <= ?`
    )
    .all(escritorioId, limite) as any[];
  for (const r of nfe) {
    if (!visiveis.has(r.empresaId)) continue;
    itens.push({ tipo: "Busca de XML", empresaId: r.empresaId, empresaNome: r.empresaNome, validadeAte: r.validadeAte });
  }
  const ic = sqlite
    .prepare(
      `SELECT validade_certificado_ate as validadeAte FROM integracontador_config WHERE escritorio_id = ? AND validade_certificado_ate IS NOT NULL AND validade_certificado_ate <= ?`
    )
    .get(escritorioId, limite) as any;
  if (ic) itens.push({ tipo: "Integra Contador", empresaId: null, empresaNome: "Escritório", validadeAte: ic.validadeAte });
  itens.sort((a, b) => (a.validadeAte < b.validadeAte ? -1 : 1));
  return itens;
}

// Licenças (Alvará, Vigilância Sanitária, Corpo de Bombeiros, Ambiental-SEMMA) vencidas ou
// vencendo nos próximos 30 dias — só considera o anexo mais recente de cada empresa+tipo (maior
// ano, e dentro do mesmo ano o mais recente enviado). Assim que uma licença renovada é anexada
// (ex.: 2027, substituindo a de 2026), ela vira a "mais recente" daquele empresa+tipo sozinha, e a
// pendência da anterior some do card automaticamente — nunca é preciso apagar nem marcar nada à
// mão, o histórico antigo continua guardado, só não conta mais pro card.
function cardLicencasAVencer(user: any, diasLimite = 30): any[] {
  const escritorioId = user.escritorioId;
  const visiveis = new Set(empresasVisiveis(user));
  const limite = new Date(Date.now() + diasLimite * 86400000).toISOString().slice(0, 10);
  const rows = sqlite
    .prepare(
      `SELECT a.empresa_id as empresaId, e.nome as empresaNome, e.ativo as empresaAtivo, a.tipo, a.ano, a.vencimento
       FROM empresa_anexos a JOIN empresas e ON e.id = a.empresa_id
       WHERE a.categoria = 'licenca' AND e.escritorio_id = ?
       ORDER BY a.ano DESC, a.criado_em DESC`
    )
    .all(escritorioId) as any[];
  const maisRecentePorChave = new Map<string, any>();
  for (const r of rows) {
    const chave = `${r.empresaId}:${r.tipo}`;
    if (!maisRecentePorChave.has(chave)) maisRecentePorChave.set(chave, r);
  }
  const itens: any[] = [];
  for (const r of maisRecentePorChave.values()) {
    if (!visiveis.has(r.empresaId) || !r.empresaAtivo) continue;
    if (!r.vencimento || r.vencimento > limite) continue;
    itens.push({
      empresaId: r.empresaId,
      empresaNome: r.empresaNome,
      tipo: rotuloTipoAnexo(escritorioId, r.tipo),
      ano: r.ano,
      vencimento: r.vencimento,
    });
  }
  itens.sort((a, b) => (a.vencimento < b.vencimento ? -1 : 1));
  return itens;
}

// Empresas com o DAS (template protegido "DAS - Mensal") de uma competência passada ainda sem
// nenhum documento anexado em Envio de Documentos — inclui qualquer mês em aberto, não só o
// anterior (uma empresa pode acumular mais de um).
function cardDasEmAtraso(user: any): any[] {
  const escritorioId = user.escritorioId;
  const visiveis = new Set(empresasVisiveis(user));
  const agora = agoraBrasilia();
  const corte = painelMonitoramentoCorte(escritorioId);
  const atribuicoes = sqlite
    .prepare(
      `SELECT a.id as atribuicaoId, a.empresa_id as empresaId, e.nome as empresaNome
       FROM envio_atribuicoes a
       JOIN envio_templates t ON t.id = a.template_id AND t.nome = 'DAS - Mensal' AND t.escritorio_id = ?
       JOIN empresas e ON e.id = a.empresa_id AND e.escritorio_id = ? AND e.ativo = 1
       WHERE a.ativo = 1`
    )
    .all(escritorioId, escritorioId) as any[];
  // Achado ao vivo (AMIL COMERCIO DE PEÇAS, FERNANDO CARVALHO DA SILVA): a atribuição "DAS - Mensal"
  // só nasce quando um DAS ou Situação Fiscal é gerado com sucesso ao menos uma vez (ver
  // integraContadorAnexarDasEmEnvio/integraContadorAnexarSitfisEmEnvio) — uma empresa optante do
  // Simples que nunca teve nenhum PDF gerado (mesmo com declaração transmitida e alerta de pendência
  // real em integracontador_empresa_config.alerta_declaracao) nunca tinha atribuição nenhuma, então
  // nem entrava na query acima. Acrescenta essas "órfãs" — mesma checagem por declaração já usada
  // abaixo pro caso de atribuição sem período nenhum, só que aqui não existe nem atribuicaoId real
  // (fica null; o resto da lógica já sabe lidar com isso, já que só usa atribuicaoId pra achar
  // período, e sem atribuição não tem período mesmo).
  const idsComAtribuicao = new Set(atribuicoes.map((a) => a.empresaId));
  const orfas = sqlite
    .prepare(
      `SELECT c.empresa_id as empresaId, e.nome as empresaNome
       FROM integracontador_empresa_config c JOIN empresas e ON e.id = c.empresa_id
       WHERE c.escritorio_id = ? AND c.ativo = 1 AND c.optante_simples_nacional = 1 AND e.ativo = 1 AND e.escritorio_id = ?`
    )
    .all(escritorioId, escritorioId) as any[];
  for (const o of orfas) {
    if (!idsComAtribuicao.has(o.empresaId)) atribuicoes.push({ atribuicaoId: null, empresaId: o.empresaId, empresaNome: o.empresaNome });
  }
  const porEmpresa = new Map<number, any>();
  for (const atrib of atribuicoes) {
    if (!visiveis.has(atrib.empresaId)) continue;
    // Achado ao vivo (DU CALLO): "Gerar ano na grade" é manual — se ninguém clicar de novo depois
    // que o ano vira, os meses seguintes nunca ganham uma linha em envio_periodos. A versão antiga
    // deste card só sabia flagar um período que JÁ EXISTIA sem documento — um mês que nunca chegou
    // a existir na grade (caso do DU CALLO em 08/2026) passava batido, mesmo continuando sem nada
    // entregue. Agora monta o calendário completo (do período mais antigo já gerado até o mês
    // passado) e trata tanto "existe mas sem documento" quanto "nem chegou a ser gerado" como
    // pendente — só usa o período mais antigo como início porque não existe outro jeito de saber
    // desde quando a empresa devia entregar; sem nenhum período gerado ainda, não dá pra inferir
    // nada, então pula (evita marcar uma atribuição recém-criada como atrasada desde sempre).
    const periodos = sqlite.prepare(`SELECT p.id, p.ano, p.mes FROM envio_periodos p WHERE p.atribuicao_id = ? AND p.mes IS NOT NULL`).all(atrib.atribuicaoId) as any[];
    const porCompetencia = new Map<string, any>(periodos.map((p) => [`${p.ano}${String(p.mes).padStart(2, "0")}`, p]));
    let anoMesInicio: number;
    if (periodos.length) {
      const maisAntigo = periodos.reduce((min, p) => (p.ano * 100 + p.mes < min.ano * 100 + min.mes ? p : min));
      anoMesInicio = maisAntigo.ano * 100 + maisAntigo.mes;
    } else {
      // Nunca teve período gerado na grade (nem "Gerar ano na grade" nem um DAS automático que tenha
      // dado certo). Antes disso pulava direto — achado ao vivo: SIMPLES SERVICOS DE CONTABILIDADE
      // (empresa do próprio escritório) tem 7 competências com declaração do Simples já transmitida,
      // mas a geração do DAS sempre falhou, então nunca existiu período nenhum na grade e a empresa
      // ficava invisível neste card mesmo estando claramente em atraso. Se já existe alguma
      // declaração transmitida, usa a mais antiga como início do calendário; sem nenhuma declaração
      // também, aí sim não tem base nenhuma pra inferir desde quando cobrar — pula.
      const decl = sqlite.prepare(`SELECT MIN(periodo_apuracao) as minPeriodo FROM integracontador_documentos WHERE empresa_id = ? AND tipo = 'declaracao'`).get(atrib.empresaId) as any;
      if (!decl || !decl.minPeriodo) continue;
      anoMesInicio = Number(decl.minPeriodo);
    }
    // Corte configurado em painel_monitoramento_config (opcional): não deixa o calendário começar
    // antes da competência escolhida, mesmo que exista período mais antigo sem documento na grade.
    if (corte && corte > anoMesInicio) anoMesInicio = corte;
    let declaradas: Set<string> | null = null;
    const competenciasFaltando: string[] = [];
    let ano = Math.floor(anoMesInicio / 100), mes = anoMesInicio % 100, iteracoes = 0;
    while ((ano < agora.ano || (ano === agora.ano && mes < agora.mes)) && iteracoes < 60) {
      iteracoes++;
      const chave = `${ano}${String(mes).padStart(2, "0")}`;
      const periodo = porCompetencia.get(chave);
      const temDocumento = periodo ? sqlite.prepare(`SELECT 1 FROM envio_documentos WHERE periodo_id = ?`).get(periodo.id) : null;
      if (!temDocumento) {
        // Uma competência sem PDF (ou sem período gerado) ainda conta como "resolvida" se já existe
        // a declaração do Simples Nacional transmitida pra ela (Integra Contador) — o Integra
        // Contador só gera o PDF do DAS pra competência mais recente já declarada, não
        // retroativamente pras anteriores, e meses anteriores à automação podem ter sido entregues
        // por fora (e-mail, WhatsApp) sem passar por aqui. Declaração transmitida é sinal forte o
        // bastante de que o mês já foi tratado.
        if (declaradas === null) {
          const decls = sqlite.prepare(`SELECT periodo_apuracao FROM integracontador_documentos WHERE empresa_id = ? AND tipo = 'declaracao'`).all(atrib.empresaId) as any[];
          declaradas = new Set(decls.map((d) => d.periodo_apuracao));
        }
        if (!declaradas.has(chave)) competenciasFaltando.push(`${String(mes).padStart(2, "0")}/${ano}`);
      }
      mes++;
      if (mes > 12) {
        mes = 1;
        ano++;
      }
    }
    if (competenciasFaltando.length) porEmpresa.set(atrib.empresaId, { empresaId: atrib.empresaId, empresaNome: atrib.empresaNome, competencias: competenciasFaltando });
  }
  return [...porEmpresa.values()];
}

// Versão genérica do card acima ("DAS em Atraso" é o caso fixo/embutido) — qualquer modelo de
// Envio de Documentos mensal (Balancete, DRE, Razão Contábil, Nota Fiscal do mês anterior, etc.)
// pode virar um card do Painel escolhendo o modelo aqui. Mesma lógica de calendário (do período
// mais antigo já gerado na grade até o mês passado, tratando período sem documento OU nunca gerado
// como pendente) — só não tem a exceção de "resolvido pela declaração do Simples Nacional", que é
// específica do DAS e não faz sentido pra Balancete/DRE/Nota Fiscal.
// Aceita tanto o formato antigo (um id só, ex.: "12") quanto o novo (lista em JSON, ex.: "[12,6,5]")
// — cards "envio_atraso" criados antes de virar multi-seleção continuam funcionando sem migração.
function parseParametroIds(parametro: string | null | undefined): number[] {
  if (!parametro) return [];
  try {
    const parsed = JSON.parse(parametro);
    if (Array.isArray(parsed)) return parsed.map(Number).filter((n) => Number.isFinite(n) && n > 0);
  } catch {
    // não era JSON — cai no formato antigo abaixo
  }
  const n = Number(parametro);
  return Number.isFinite(n) && n > 0 ? [n] : [];
}
function cardEnvioAtraso(user: any, templateIds: number[]): any[] {
  const escritorioId = user.escritorioId;
  const visiveis = new Set(empresasVisiveis(user));
  const agora = agoraBrasilia();
  const corte = painelMonitoramentoCorte(escritorioId);
  const placeholders = templateIds.map(() => "?").join(",");
  const atribuicoes = sqlite
    .prepare(
      `SELECT a.id as atribuicaoId, a.empresa_id as empresaId, e.nome as empresaNome, t.id as templateId, t.nome as templateNome, t.considera_mes_atual as considerarMesAtual, t.suspenso_desde as suspensoDesde, t.periodicidade as periodicidade
       FROM envio_atribuicoes a
       JOIN envio_templates t ON t.id = a.template_id AND t.id IN (${placeholders}) AND t.escritorio_id = ?
       JOIN empresas e ON e.id = a.empresa_id AND e.escritorio_id = ? AND e.ativo = 1
       WHERE a.ativo = 1`
    )
    .all(...templateIds, escritorioId, escritorioId) as any[];
  // Chave por empresa+modelo (não só empresa) — uma empresa pode estar atrasada em mais de um
  // modelo ao mesmo tempo (ex.: Nota Fiscal E DRE), e cada linha do card precisa dizer qual é qual.
  const resultado: any[] = [];
  for (const atrib of atribuicoes) {
    if (!visiveis.has(atrib.empresaId)) continue;
    const todosPeriodos = sqlite
      .prepare(`SELECT p.id, p.ano, p.mes, p.sem_movimento as semMovimento, p.parcela_numero as parcelaNumero, p.parcela_total as parcelaTotal FROM envio_periodos p WHERE p.atribuicao_id = ? AND p.mes IS NOT NULL`)
      .all(atrib.atribuicaoId) as any[];
    if (!todosPeriodos.length) continue;
    // 2ª/3ª quota de um parcelamento (ver POST /envio/periodos/:id/enviar, campo "parcelas") não faz
    // parte do calendário normal do modelo (mensal ou trimestral) — vive num mês avulso, criado só
    // porque a 1ª quota foi postada como parcelada. Entra no calendário principal (porCompetencia)
    // só a "âncora" (1ª quota ou período sem parcelamento nenhum); as extras são checadas à parte.
    const periodosAncora = todosPeriodos.filter((p) => !p.parcelaNumero || p.parcelaNumero === 1);
    const periodosQuota = todosPeriodos.filter((p) => p.parcelaNumero && p.parcelaNumero >= 2);
    if (!periodosAncora.length) continue;
    const porCompetencia = new Map<string, any>(periodosAncora.map((p) => [`${p.ano}${String(p.mes).padStart(2, "0")}`, p]));
    const maisAntigo = periodosAncora.reduce((min, p) => (p.ano * 100 + p.mes < min.ano * 100 + min.mes ? p : min));
    let anoMesInicio = maisAntigo.ano * 100 + maisAntigo.mes;
    if (corte && corte > anoMesInicio) anoMesInicio = corte;
    // Trimestral anda de 3 em 3 meses (Mar/Jun/Set/Dez, ver "Gerar ano na grade") — mensal, mês a mês.
    const passoMes = atrib.periodicidade === "trimestral" ? 3 : 1;
    // O "corte" (monitoramento a partir de tal competência, configurável à parte) é pensado pro caso
    // mensal, onde qualquer mês é uma competência válida — pra trimestral pode cair num mês que nunca
    // é fechamento de trimestre (ex.: corte em Jul/2026), o que faria o laço abaixo "cobrar" uma
    // competência que nunca existiu (07/2026) e pular a de verdade (09/2026). Avança pro próximo
    // Mar/Jun/Set/Dez nesse caso — achado ao vivo testando com um corte real de Jul/2026.
    if (passoMes === 3) {
      let anoSnap = Math.floor(anoMesInicio / 100), mesSnap = anoMesInicio % 100;
      while (![3, 6, 9, 12].includes(mesSnap)) {
        mesSnap++;
        if (mesSnap > 12) {
          mesSnap = 1;
          anoSnap++;
        }
      }
      anoMesInicio = anoSnap * 100 + mesSnap;
    }
    // Modelo extinto numa data conhecida (ex.: DARF PIS/COFINS substituídos pela CBS a partir de
    // 01/2027, ver suspenso_desde) — a partir dessa competência (inclusive) o card para de cobrar,
    // mesmo que a empresa nunca tenha enviado o mês anterior.
    const suspensoAnoMes = atrib.suspensoDesde ? Number(atrib.suspensoDesde.slice(0, 4)) * 100 + Number(atrib.suspensoDesde.slice(5, 7)) : null;
    const competenciasFaltando: string[] = [];
    let ano = Math.floor(anoMesInicio / 100), mes = anoMesInicio % 100, iteracoes = 0;
    // Por modelo: Nota Fiscal (considera_mes_atual=1) cobra até o mês corrente, porque pode ser
    // emitida a qualquer momento do mês — já DRE/Balancete/Razão Contábil (considera_mes_atual=0)
    // só existem depois que o mês fecha, então param no mês anterior, igual DAS e Solicitações.
    const incluirMesAtual = !!atrib.considerarMesAtual;
    while ((ano < agora.ano || (ano === agora.ano && (incluirMesAtual ? mes <= agora.mes : mes < agora.mes))) && iteracoes < 60) {
      iteracoes++;
      if (suspensoAnoMes !== null && ano * 100 + mes >= suspensoAnoMes) break;
      const chave = `${ano}${String(mes).padStart(2, "0")}`;
      const periodo = porCompetencia.get(chave);
      const temDocumento = periodo ? sqlite.prepare(`SELECT 1 FROM envio_documentos WHERE periodo_id = ?`).get(periodo.id) : null;
      if (!temDocumento && !(periodo && periodo.semMovimento)) competenciasFaltando.push(`${String(mes).padStart(2, "0")}/${ano}`);
      mes += passoMes;
      while (mes > 12) {
        mes -= 12;
        ano++;
      }
    }
    // Quotas 2/3 checadas fora do calendário principal, com o mesmo critério de "já passou do mês" —
    // sempre exige o mês fechado (nunca cobra a quota no mês corrente, ela tipicamente só é gerada
    // pela busca automática do mês seguinte, ver Fase 2/SICALC).
    for (const pq of periodosQuota) {
      if (pq.ano > agora.ano || (pq.ano === agora.ano && pq.mes >= agora.mes)) continue;
      if (suspensoAnoMes !== null && pq.ano * 100 + pq.mes >= suspensoAnoMes) continue;
      const temDocumento = sqlite.prepare(`SELECT 1 FROM envio_documentos WHERE periodo_id = ?`).get(pq.id);
      if (!temDocumento && !pq.semMovimento) competenciasFaltando.push(`${String(pq.mes).padStart(2, "0")}/${pq.ano} (${pq.parcelaNumero}ª de ${pq.parcelaTotal} quotas)`);
    }
    if (competenciasFaltando.length) resultado.push({ empresaId: atrib.empresaId, empresaNome: atrib.empresaNome, templateNome: atrib.templateNome, competencias: competenciasFaltando });
  }
  return resultado;
}

// Proxy disponível hoje pra "pendência fiscal": o relatório de Situação Fiscal (SITFIS) é um PDF
// opaco (não lido pelo sistema) — o único sinal estruturado que já existe é o alerta de
// DAS/Declaração do Simples Nacional ainda não localizado.
// O relatório de Situação Fiscal (SITFIS) "limpo" nunca contém esses três cabeçalhos — eles só
// aparecem no PDF quando existe conteúdo real embaixo (parcelamento em andamento, débito
// pendente, ou débito com exigibilidade suspensa). Confirmado comparando um relatório com
// pendência real (GO COLOR, débitos em negociação de parcelamento) contra um limpo (MSM
// AGROPECUARIA, só a frase "Não foram detectadas pendências...").
// Achado ao vivo (LUCELIO MARTINS DE OLIVEIRA): a seção "Pendência - Inscrição (SIDA)" — dívida já
// inscrita em Dívida Ativa da União na Procuradoria-Geral da Fazenda Nacional, cobrança "ATIVA A SER
// COBRADA" — não batia em nenhum dos três marcadores existentes (eles cobrem pendência/parcelamento
// do lado da Receita Federal via SIEF, essa é do lado da PGFN via SIDA, cabeçalho diferente) e por
// isso passava batido pelo card, mesmo sendo uma pendência real e mais grave que a de SIEF (dívida
// ativa pode virar penhora/protesto/execução fiscal).
const SITFIS_MARCADORES_PENDENCIA: { chave: string; regex: RegExp }[] = [
  { chave: "Parcelamento em andamento", regex: /Parcelamento com Exigibilidade Suspensa/i },
  { chave: "Débito pendente", regex: /Pend[êe]ncia\s*-\s*D[ée]bito/i },
  { chave: "Débito com exigibilidade suspensa", regex: /D[ée]bito com Exigibilidade Suspensa/i },
  { chave: "Débito inscrito em Dívida Ativa (PGFN)", regex: /Pend[êe]ncia\s*-\s*Inscri[çc][ãa]o/i },
];
async function sitfisAnalisar(pdfPath: string): Promise<{ temPendencia: boolean; resumo: string | null }> {
  const pdfParseLib = require("pdf-parse");
  const buf = fs.readFileSync(pdfPath);
  // Mesmo cuidado de extrairTextoArquivo: pdf-parse lê o ArrayBuffer inteiro quando recebe um
  // Buffer de verdade (ignora byteOffset/length) — um Uint8Array "puro" evita esse bug.
  const data = await pdfParseLib(new Uint8Array(buf));
  const texto: string = data.text || "";
  const achados = SITFIS_MARCADORES_PENDENCIA.filter((m) => m.regex.test(texto)).map((m) => m.chave);
  // "Omissão de X" (X = DITR, DIRPF, GFIP, DCTF etc.) é outra seção que só aparece no relatório
  // quando existe declaração de verdade faltando — diferente das pendências acima (débito/dívida
  // ativa), aqui o problema é papelada não entregue pro Fisco, mas ainda assim urgente (gera multa
  // por atraso, pode até gerar cobrança de ofício depois). Extrai qual declaração falta em vez de só
  // marcar "tem omissão", pra o alerta já dizer o quê.
  const omissoes = [...new Set([...texto.matchAll(/Omiss[ãa]o de\s+([A-ZÀ-Ú0-9][A-ZÀ-Ú0-9\-\/]*)/gi)].map((m) => `Omissão de ${m[1].toUpperCase()}`))];
  achados.push(...omissoes);
  // Achado ao vivo: "Parcelamento em andamento" e "Débito com exigibilidade suspensa" sozinhos não
  // significam pendência de verdade (parcelamento em dia, ou débito com a cobrança suspensa por
  // decisão judicial/processo administrativo, não é algo pra correr atrás) — "Débito pendente",
  // "Débito inscrito em Dívida Ativa" e qualquer "Omissão de declaração" são urgentes o bastante pra
  // acender o card. Continua mostrando os outros marcadores no resumo quando aparecem junto, só não
  // usa eles sozinhos pra disparar o card.
  const temDebitoPendente = achados.includes("Débito pendente") || achados.includes("Débito inscrito em Dívida Ativa (PGFN)") || omissoes.length > 0;
  return { temPendencia: temDebitoPendente, resumo: achados.length ? achados.join(", ") : null };
}
async function cardSituacaoFiscal(user: any): Promise<any[]> {
  const escritorioId = user.escritorioId;
  const visiveis = new Set(empresasVisiveis(user));
  const rows = sqlite
    .prepare(
      `SELECT c.empresa_id as empresaId, e.nome as empresaNome
       FROM integracontador_empresa_config c JOIN empresas e ON e.id = c.empresa_id
       WHERE c.escritorio_id = ? AND c.ativo = 1 AND e.ativo = 1
       ORDER BY e.nome`
    )
    .all(escritorioId) as any[];
  const resultado: any[] = [];
  for (const r of rows) {
    if (!visiveis.has(r.empresaId)) continue;
    // Achado ao vivo: "Declaração/DAS ainda não localizada" (alerta_declaracao) saiu daqui — não é
    // informação de Situação Fiscal (SITFIS), é sobre a declaração do Simples não ter sido
    // localizada/transmitida, um assunto diferente que estava poluindo este card.
    // Achado ao vivo: "Falha na última busca" (sem relatório nenhum pra conferir) também saiu — o
    // usuário quer só empresa com pendência REAL, com o PDF pra baixar; falha técnica de busca sem
    // documento nenhum não é uma pendência confirmada, só ruído. Esse status de falha continua
    // disponível na tela Integra Contador (coluna por empresa), só não aparece mais aqui.
    const doc = sqlite
      .prepare(`SELECT id as docId, pdf_path as pdfPath FROM integracontador_documentos WHERE empresa_id = ? AND tipo = 'situacao_fiscal' ORDER BY criado_em DESC LIMIT 1`)
      .get(r.empresaId) as any;
    if (!doc?.pdfPath || !fs.existsSync(doc.pdfPath)) continue;
    try {
      const analise = await sitfisAnalisar(doc.pdfPath);
      if (analise.temPendencia) {
        resultado.push({
          empresaId: r.empresaId,
          empresaNome: r.empresaNome,
          alerta: `Atenção: precisa de atenção pois consta pendência no âmbito da Receita Federal (${analise.resumo}).`,
          docId: doc.docId,
        });
      }
    } catch (e: any) {
      console.error(`[Situação Fiscal] falha ao ler o relatório da empresa ${r.empresaId}:`, e.message);
    }
  }
  return resultado;
}
// Mesmo molde do card de Situação Fiscal acima, mas pra mensagens não lidas na Caixa Postal do
// e-CAC (tabela integracontador_caixapostal_mensagens, populada pela busca automática — ver
// integraContadorBuscarEmpresaInterno). "mensagens" vem limitado às mais recentes só pra não deixar
// o card pesado se alguma empresa acumular muitas não lidas.
async function cardCaixaPostalNaoLida(user: any): Promise<any[]> {
  const escritorioId = user.escritorioId;
  const visiveis = new Set(empresasVisiveis(user));
  const rows = sqlite
    .prepare(
      `SELECT c.empresa_id as empresaId, e.nome as empresaNome
       FROM integracontador_empresa_config c JOIN empresas e ON e.id = c.empresa_id
       WHERE c.escritorio_id = ? AND c.ativo = 1 AND e.ativo = 1
       ORDER BY e.nome`
    )
    .all(escritorioId) as any[];
  const resultado: any[] = [];
  for (const r of rows) {
    if (!visiveis.has(r.empresaId)) continue;
    const mensagens = sqlite
      .prepare(`SELECT assunto, data_envio as dataEnvio FROM integracontador_caixapostal_mensagens WHERE empresa_id = ? ORDER BY data_envio DESC LIMIT 5`)
      .all(r.empresaId) as any[];
    if (!mensagens.length) continue;
    const quantidade = (sqlite.prepare(`SELECT COUNT(*) as n FROM integracontador_caixapostal_mensagens WHERE empresa_id = ?`).get(r.empresaId) as any).n;
    resultado.push({ empresaId: r.empresaId, empresaNome: r.empresaNome, quantidade, mensagens });
  }
  return resultado;
}

// Empresas que já passaram do prazo (dia do mês) de um modelo de Solicitação de Documentos e ainda
// têm ao menos um item obrigatório sem upload salvo na competência ANTERIOR (ex.: hoje é 08/2026 e
// o prazo é dia 2 — depois do dia 2 de agosto, verifica se a competência de julho/2026 já foi
// entregue; a competência do mês corrente nunca é cobrada, porque ainda está em curso).
function cardChecklistAtraso(user: any): any[] {
  const escritorioId = user.escritorioId;
  const visiveis = new Set(empresasVisiveis(user));
  const agora = agoraBrasilia();
  const mesRef = agora.mes === 1 ? 12 : agora.mes - 1;
  const anoRef = agora.mes === 1 ? agora.ano - 1 : agora.ano;
  // Corte configurado: a competência do mês anterior ainda não chegou no piso escolhido — nada a
  // checar (evita flagrar meses de antes do corte, já que aqui só existe "a competência anterior",
  // sem backlog acumulado pra clampar dentro de um range como no DAS/Envio).
  const corte = painelMonitoramentoCorte(escritorioId);
  if (corte && anoRef * 100 + mesRef < corte) return [];
  const templates = sqlite
    .prepare(`SELECT id, nome, itens_json as itensJson, prazo_dia as prazoDia FROM checklist_templates WHERE escritorio_id = ? AND ativo = 1 AND prazo_dia IS NOT NULL`)
    .all(escritorioId) as any[];
  const resultado: any[] = [];
  for (const t of templates) {
    if (agora.dia <= t.prazoDia) continue; // prazo desse mês (pra entregar a competência anterior) ainda não venceu
    const itensObrigatorios = (JSON.parse(t.itensJson) as any[]).filter((it) => it.obrigatorio);
    if (!itensObrigatorios.length) continue;
    const atribuicoes = sqlite
      .prepare(`SELECT a.id, a.empresa_id as empresaId, e.nome as empresaNome FROM checklist_atribuicoes a JOIN empresas e ON e.id = a.empresa_id WHERE a.template_id = ? AND a.ativo = 1 AND e.ativo = 1`)
      .all(t.id) as any[];
    for (const a of atribuicoes) {
      if (!visiveis.has(a.empresaId)) continue;
      const periodo = sqlite.prepare(`SELECT id FROM checklist_periodos WHERE atribuicao_id = ? AND ano = ? AND mes = ?`).get(a.id, anoRef, mesRef) as any;
      let faltando: string[];
      if (!periodo) {
        faltando = itensObrigatorios.map((it) => it.label);
      } else {
        const enviados = new Set(
          (sqlite.prepare(`SELECT item_chave FROM checklist_uploads WHERE periodo_id = ? AND status = 'salvo'`).all(periodo.id) as any[]).map((u) => u.item_chave)
        );
        // Reabrir um item (pra o cliente reenviar) não apaga o upload antigo, só destrava — sem
        // essa checagem, o item continuaria contando como "enviado" mesmo depois de reaberto.
        const reabertos = new Set(
          (sqlite.prepare(`SELECT item_chave FROM checklist_reaberturas WHERE periodo_id = ? AND resolvido = 0`).all(periodo.id) as any[]).map((r) => r.item_chave)
        );
        faltando = itensObrigatorios.filter((it) => !enviados.has(it.chave) || reabertos.has(it.chave)).map((it) => it.label);
      }
      if (faltando.length)
        resultado.push({
          empresaId: a.empresaId,
          empresaNome: a.empresaNome,
          templateNome: t.nome,
          competencia: `${String(mesRef).padStart(2, "0")}/${anoRef}`,
          prazoDia: t.prazoDia,
          itensFaltando: faltando,
        });
    }
  }
  return resultado;
}

// Versão de cardChecklistAtraso() pra um ou mais modelos específicos de Solicitação de Documentos,
// em vez de somar todos junto — permite um card por modelo (ex.: "Extratos Bancários em Atraso",
// "Extratos de Parcelamento em Atraso") ou por um grupo deles, cada um com seu próprio prazo. Mesma
// regra: só olha a competência do mês anterior (essas solicitações são renovadas todo mês, sem
// backlog acumulado como o DAS). Mesmo padrão de cardEnvioAtraso — uma empresa pode estar atrasada
// em mais de um modelo ao mesmo tempo, cada linha do resultado diz qual.
function cardSolicitacaoAtraso(user: any, templateIds: number[]): any[] {
  const escritorioId = user.escritorioId;
  const visiveis = new Set(empresasVisiveis(user));
  const agora = agoraBrasilia();
  const mesRef = agora.mes === 1 ? 12 : agora.mes - 1;
  const anoRef = agora.mes === 1 ? agora.ano - 1 : agora.ano;
  const corte = painelMonitoramentoCorte(escritorioId);
  if (corte && anoRef * 100 + mesRef < corte) return [];
  const resultado: any[] = [];
  for (const templateId of templateIds) {
    const t = sqlite
      .prepare(`SELECT id, nome, itens_json as itensJson, prazo_dia as prazoDia FROM checklist_templates WHERE id = ? AND escritorio_id = ? AND ativo = 1 AND prazo_dia IS NOT NULL`)
      .get(templateId, escritorioId) as any;
    if (!t) continue;
    if (agora.dia <= t.prazoDia) continue; // prazo desse mês (pra entregar a competência anterior) ainda não venceu
    const itensObrigatorios = (JSON.parse(t.itensJson) as any[]).filter((it) => it.obrigatorio);
    if (!itensObrigatorios.length) continue;
    const atribuicoes = sqlite
      .prepare(`SELECT a.id, a.empresa_id as empresaId, e.nome as empresaNome FROM checklist_atribuicoes a JOIN empresas e ON e.id = a.empresa_id WHERE a.template_id = ? AND a.ativo = 1 AND e.ativo = 1`)
      .all(t.id) as any[];
    for (const a of atribuicoes) {
      if (!visiveis.has(a.empresaId)) continue;
      const periodo = sqlite.prepare(`SELECT id FROM checklist_periodos WHERE atribuicao_id = ? AND ano = ? AND mes = ?`).get(a.id, anoRef, mesRef) as any;
      let faltando: string[];
      if (!periodo) {
        faltando = itensObrigatorios.map((it) => it.label);
      } else {
        const enviados = new Set(
          (sqlite.prepare(`SELECT item_chave FROM checklist_uploads WHERE periodo_id = ? AND status = 'salvo'`).all(periodo.id) as any[]).map((u) => u.item_chave)
        );
        const reabertos = new Set(
          (sqlite.prepare(`SELECT item_chave FROM checklist_reaberturas WHERE periodo_id = ? AND resolvido = 0`).all(periodo.id) as any[]).map((r) => r.item_chave)
        );
        faltando = itensObrigatorios.filter((it) => !enviados.has(it.chave) || reabertos.has(it.chave)).map((it) => it.label);
      }
      if (faltando.length)
        resultado.push({
          empresaId: a.empresaId,
          empresaNome: a.empresaNome,
          templateNome: t.nome,
          competencia: `${String(mesRef).padStart(2, "0")}/${anoRef}`,
          prazoDia: t.prazoDia,
          itensFaltando: faltando,
        });
    }
  }
  return resultado;
}

// Pedidos que o cliente já fez pela tela "Solicitar Documentos" (envio_periodos.solicitado_em
// preenchido) e que o escritório ainda não respondeu (nenhum documento anexado naquele período).
function cardSolicitacoesPendentes(user: any): any[] {
  const escritorioId = user.escritorioId;
  const visiveis = new Set(empresasVisiveis(user));
  const rows = sqlite
    .prepare(
      `SELECT p.id as periodoId, a.id as atribuicaoId, a.empresa_id as empresaId, e.nome as empresaNome, t.nome as templateNome, p.ano, p.mes, p.rotulo, p.solicitado_em as solicitadoEm
       FROM envio_periodos p
       JOIN envio_atribuicoes a ON a.id = p.atribuicao_id
       JOIN envio_templates t ON t.id = a.template_id AND t.escritorio_id = ?
       JOIN empresas e ON e.id = a.empresa_id AND e.ativo = 1
       WHERE p.solicitado_em IS NOT NULL AND NOT EXISTS (SELECT 1 FROM envio_documentos d WHERE d.periodo_id = p.id)
       ORDER BY p.solicitado_em ASC`
    )
    .all(escritorioId) as any[];
  return rows.filter((r) => visiveis.has(r.empresaId));
}

async function calcularCardComputado(tipo: string, user: any, parametro?: string | null): Promise<any[]> {
  if (tipo === "certificados_vencer") return cardCertificadosAVencer(user);
  if (tipo === "licencas_vencer") return cardLicencasAVencer(user);
  if (tipo === "das_atraso") return cardDasEmAtraso(user);
  if (tipo === "situacao_fiscal") return cardSituacaoFiscal(user);
  if (tipo === "caixapostal_nao_lida") return cardCaixaPostalNaoLida(user);
  if (tipo === "checklist_atraso") return cardChecklistAtraso(user);
  if (tipo === "solicitacoes_pendentes") return cardSolicitacoesPendentes(user);
  if (tipo === "envio_atraso") {
    const templateIds = parseParametroIds(parametro);
    if (!templateIds.length) return [];
    return cardEnvioAtraso(user, templateIds);
  }
  if (tipo === "solicitacao_atraso") {
    const templateIds = parseParametroIds(parametro);
    if (!templateIds.length) return [];
    return cardSolicitacaoAtraso(user, templateIds);
  }
  return [];
}

app.get("/api/dashboard/monitoramento-config", requirePermissao("dashboard", "visualizar"), (req, res) => {
  const user = (req as any).user;
  const row = sqlite
    .prepare(`SELECT competencia_inicio_ano as ano, competencia_inicio_mes as mes FROM painel_monitoramento_config WHERE escritorio_id = ?`)
    .get(user.escritorioId) as any;
  res.json({ competenciaInicio: row && row.ano && row.mes ? { ano: row.ano, mes: row.mes } : null });
});
app.put("/api/dashboard/monitoramento-config", blockCliente, requirePermissao("dashboard", "editar"), (req, res) => {
  const user = (req as any).user;
  const { ano, mes } = req.body || {};
  if (ano === null || mes === null) {
    sqlite.prepare(`DELETE FROM painel_monitoramento_config WHERE escritorio_id = ?`).run(user.escritorioId);
    return res.json({ ok: true });
  }
  const anoNum = Number(ano), mesNum = Number(mes);
  if (!Number.isInteger(anoNum) || anoNum < 2000 || anoNum > 2100 || !Number.isInteger(mesNum) || mesNum < 1 || mesNum > 12) {
    return res.status(400).json({ error: "Informe um mês (1-12) e um ano válidos." });
  }
  sqlite
    .prepare(
      `INSERT INTO painel_monitoramento_config (escritorio_id, competencia_inicio_ano, competencia_inicio_mes, updated_at) VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT(escritorio_id) DO UPDATE SET competencia_inicio_ano = excluded.competencia_inicio_ano, competencia_inicio_mes = excluded.competencia_inicio_mes, updated_at = datetime('now')`
    )
    .run(user.escritorioId, anoNum, mesNum);
  res.json({ ok: true });
});
app.get("/api/dashboard/cards", requirePermissao("dashboard", "visualizar"), async (req, res) => {
  const user = (req as any).user;
  const rows = sqlite.prepare(`SELECT * FROM dashboard_cards WHERE escritorio_id = ? ORDER BY ordem, id`).all(user.escritorioId) as any[];
  const items = await Promise.all(
    rows.map(async (r) => {
      if (!r.tipo) return r;
      try {
        return { ...r, valor: String((await calcularCardComputado(r.tipo, user, r.parametro)).length) };
      } catch {
        return { ...r, valor: "—" };
      }
    })
  );
  res.json({ items });
});
// Alerta do Início quando a sincronização automática de empresas com o Onvio está quebrada há
// tempo — mesmo cálculo usado em GET /api/dominio/sync-log, exposto aqui sem exigir a permissão
// granular de "configuracoes" (um Colaborador pode não ter acesso a Configurações mas ainda deve
// ver esse alerta no Início). Sem blockCliente de propósito: requirePermissao já nega Cliente
// incondicionalmente (hasPermissao retorna false pra esse perfil antes de checar qualquer coisa),
// mesmo padrão de GET /api/dashboard/cards acima.
app.get("/api/dashboard/onvio-saude", requirePermissao("dashboard", "visualizar"), (req, res) => {
  res.json(calcularSaudeOnvio());
});
app.get("/api/dashboard/cards/:id/detalhe", requirePermissao("dashboard", "visualizar"), async (req, res) => {
  const user = (req as any).user;
  const card = sqlite.prepare(`SELECT * FROM dashboard_cards WHERE id = ? AND escritorio_id = ?`).get(Number(req.params.id), user.escritorioId) as any;
  if (!card) return res.status(404).json({ error: "Card não encontrado." });
  if (!card.tipo) return res.status(400).json({ error: "Este card não tem detalhamento — é um valor digitado manualmente." });
  res.json({ tipo: card.tipo, items: await calcularCardComputado(card.tipo, user, card.parametro) });
});
// "envio_atraso" precisa de um envio_templates válido (do mesmo escritório, mensal, ativo) como
// parâmetro — sem isso o card ficaria "computado" mas sem saber o que calcular. "solicitacao_atraso"
// segue a mesma ideia, só que apontando pra um checklist_templates com prazo configurado.
function dashboardCardParametroErro(tipo: string | null, parametro: string | null | undefined, escritorioId: number): string | null {
  if (tipo === "envio_atraso") {
    const templateIds = parseParametroIds(parametro);
    if (!templateIds.length) return "Selecione ao menos um modelo de Envio de Documentos que este card vai validar.";
    const placeholders = templateIds.map(() => "?").join(",");
    const validos = sqlite
      .prepare(`SELECT id FROM envio_templates WHERE escritorio_id = ? AND periodicidade IN ('mensal','trimestral') AND ativo = 1 AND id IN (${placeholders})`)
      .all(escritorioId, ...templateIds) as any[];
    if (validos.length !== templateIds.length) return "Modelo de envio inválido — todos precisam ser modelos mensais ou trimestrais ativos.";
    return null;
  }
  if (tipo === "solicitacao_atraso") {
    const templateIds = parseParametroIds(parametro);
    if (!templateIds.length) return "Selecione ao menos um modelo de Solicitação de Documentos que este card vai validar.";
    const placeholders = templateIds.map(() => "?").join(",");
    const validos = sqlite
      .prepare(`SELECT id FROM checklist_templates WHERE escritorio_id = ? AND ativo = 1 AND prazo_dia IS NOT NULL AND id IN (${placeholders})`)
      .all(escritorioId, ...templateIds) as any[];
    if (validos.length !== templateIds.length) return "Modelo de solicitação inválido — todos precisam ser modelos ativos com prazo configurado.";
    return null;
  }
  return null;
}
app.post("/api/dashboard/cards", blockCliente, requirePermissao("dashboard", "editar"), (req, res) => {
  const user = (req as any).user;
  const { titulo, valor, subtitulo, cor, ordem, tipo, parametro } = req.body || {};
  if (tipo && !CARD_TIPOS.includes(tipo)) return res.status(400).json({ error: "Tipo de card inválido." });
  if (!titulo || (!tipo && valor === undefined)) return res.status(400).json({ error: "Informe título e valor do card." });
  const erroParametro = dashboardCardParametroErro(tipo || null, parametro, user.escritorioId);
  if (erroParametro) return res.status(400).json({ error: erroParametro });
  const info = sqlite
    .prepare(`INSERT INTO dashboard_cards (titulo, valor, subtitulo, cor, ordem, created_by, escritorio_id, tipo, parametro) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(titulo, tipo ? "0" : String(valor), subtitulo || null, cor || "brass", Number(ordem) || 0, user.id, user.escritorioId, tipo || null, tipo ? parametro || null : null);
  res.json({ id: Number(info.lastInsertRowid) });
});
app.put("/api/dashboard/cards/:id", blockCliente, requirePermissao("dashboard", "editar"), (req, res) => {
  const id = Number(req.params.id);
  const user = (req as any).user;
  const existing = sqlite.prepare(`SELECT * FROM dashboard_cards WHERE id = ? AND escritorio_id = ?`).get(id, user.escritorioId) as any;
  if (!existing) return res.status(404).json({ error: "Card não encontrado." });
  const { titulo, valor, subtitulo, cor, ordem, tipo, parametro } = req.body || {};
  if (tipo !== undefined && tipo !== null && tipo !== "" && !CARD_TIPOS.includes(tipo)) return res.status(400).json({ error: "Tipo de card inválido." });
  const novoTipo = tipo !== undefined ? tipo || null : existing.tipo;
  // Bug real: antes só dava pra trocar o parametro reenviando o tipo junto no mesmo PUT — mandar só
  // {parametro} sozinho (ex.: reconfigurar quais modelos um card "envio_atraso" já existente valida)
  // silenciosamente não fazia nada, mesmo respondendo {ok:true}. Agora parametro é independente do
  // tipo ter mudado ou não: se veio no body, usa; senão, mantém o que já tinha (e se o tipo virou
  // "Manual", zera junto, já que manual não tem parametro).
  const novoParametro = !novoTipo ? null : parametro !== undefined ? parametro || null : existing.parametro;
  const erroParametro = dashboardCardParametroErro(novoTipo, novoParametro, user.escritorioId);
  if (erroParametro) return res.status(400).json({ error: erroParametro });
  sqlite
    .prepare(`UPDATE dashboard_cards SET titulo=?, valor=?, subtitulo=?, cor=?, ordem=?, tipo=?, parametro=?, updated_at=datetime('now') WHERE id=?`)
    .run(
      titulo ?? existing.titulo,
      novoTipo ? "0" : valor !== undefined ? String(valor) : existing.valor,
      subtitulo !== undefined ? subtitulo : existing.subtitulo,
      cor ?? existing.cor,
      ordem !== undefined ? Number(ordem) : existing.ordem,
      novoTipo,
      novoParametro,
      id
    );
  res.json({ ok: true });
});
app.delete("/api/dashboard/cards/:id", blockCliente, requirePermissao("dashboard", "editar"), (req, res) => {
  sqlite.prepare(`DELETE FROM dashboard_cards WHERE id = ? AND escritorio_id = ?`).run(Number(req.params.id), (req as any).user.escritorioId);
  res.json({ ok: true });
});

// ---------- Contratos (gestão dos contratos e aditivos do escritório com as empresas-cliente) ----------
const CONTRATO_EMPRESA_CAMPO_SQL: Record<string, string> = {
  nome: "nome",
  cnpj: "cnpj",
  endereco: "endereco",
  cidade: "cidade",
  uf: "uf",
  cep: "cep",
  email: "email",
  inscricaoMunicipal: "inscricao_municipal",
  nomeRepresentanteLegal: "nome_representante_legal",
  cpfRepresentanteLegal: "cpf_representante_legal",
};
app.get("/api/contratos/modelos", blockCliente, requirePermissao("contratos", "visualizar"), (req, res) => {
  const rows = sqlite
    .prepare(`SELECT id, nome, conteudo_html as conteudoHtml, campos, ativo, criado_em as criadoEm FROM contratos_modelos WHERE escritorio_id = ? ORDER BY nome`)
    .all((req as any).user.escritorioId) as any[];
  res.json({ items: rows.map((r) => ({ ...r, campos: JSON.parse(r.campos || "[]"), ativo: !!r.ativo })) });
});
app.post("/api/contratos/modelos/importar-docx", blockCliente, requirePermissao("contratos", "postar"), upload.single("arquivo"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Envie um arquivo .docx." });
  if (!req.file.originalname.toLowerCase().endsWith(".docx")) return res.status(400).json({ error: "Só é aceito arquivo .docx (Word) — o .doc antigo não é suportado." });
  try {
    const html = await contratos.converterDocxParaHtml(req.file.buffer);
    res.json({ html });
  } catch (e: any) {
    res.status(502).json({ error: `Não consegui ler esse arquivo: ${e.message}` });
  }
});
app.post("/api/contratos/modelos", blockCliente, requirePermissao("contratos", "postar"), (req, res) => {
  const { nome, conteudoHtml, campos } = req.body || {};
  if (!nome || !conteudoHtml) return res.status(400).json({ error: "Informe o nome e o conteúdo do modelo." });
  const info = sqlite
    .prepare(`INSERT INTO contratos_modelos (nome, conteudo_html, campos, escritorio_id) VALUES (?, ?, ?, ?)`)
    .run(String(nome).trim(), String(conteudoHtml), JSON.stringify(Array.isArray(campos) ? campos : []), (req as any).user.escritorioId);
  res.json({ id: Number(info.lastInsertRowid) });
});
app.put("/api/contratos/modelos/:id", blockCliente, requirePermissao("contratos", "editar"), (req, res) => {
  const id = Number(req.params.id);
  const existente = sqlite.prepare(`SELECT * FROM contratos_modelos WHERE id = ? AND escritorio_id = ?`).get(id, (req as any).user.escritorioId) as any;
  if (!existente) return res.status(404).json({ error: "Modelo não encontrado." });
  const { nome, conteudoHtml, campos, ativo } = req.body || {};
  sqlite
    .prepare(`UPDATE contratos_modelos SET nome=?, conteudo_html=?, campos=?, ativo=?, updated_at=datetime('now') WHERE id=?`)
    .run(
      nome !== undefined ? String(nome).trim() : existente.nome,
      conteudoHtml !== undefined ? String(conteudoHtml) : existente.conteudo_html,
      campos !== undefined ? JSON.stringify(campos) : existente.campos,
      ativo !== undefined ? (ativo ? 1 : 0) : existente.ativo,
      id
    );
  res.json({ ok: true });
});
app.delete("/api/contratos/modelos/:id", blockCliente, requirePermissao("contratos", "editar"), (req, res) => {
  const id = Number(req.params.id);
  const existente = sqlite.prepare(`SELECT id FROM contratos_modelos WHERE id = ? AND escritorio_id = ?`).get(id, (req as any).user.escritorioId);
  if (!existente) return res.status(404).json({ error: "Modelo não encontrado." });
  const emUso = sqlite.prepare(`SELECT COUNT(*) as n FROM contratos WHERE modelo_id = ?`).get(id) as any;
  if (emUso.n > 0) return res.status(409).json({ error: "Este modelo já foi usado em contratos — desative-o em vez de excluir." });
  sqlite.prepare(`DELETE FROM contratos_modelos WHERE id = ?`).run(id);
  res.json({ ok: true });
});

app.get("/api/contratos", blockCliente, requirePermissao("contratos", "visualizar"), (req, res) => {
  const user = (req as any).user;
  const empresaId = req.query.empresaId ? Number(req.query.empresaId) : null;
  if (empresaId && !podeAcessarEmpresa(user, empresaId)) return res.status(403).json({ error: "Sem acesso a esta empresa." });
  const status = typeof req.query.status === "string" && req.query.status ? req.query.status : null;
  const tipo = typeof req.query.tipo === "string" && req.query.tipo ? req.query.tipo : null;
  let sql = `SELECT c.id, c.empresa_id as empresaId, e.nome as empresaNome, c.tipo, c.contrato_pai_id as contratoPaiId,
                    c.titulo, c.status, c.numero_sequencial as numeroSequencial, c.numero_sequencial_ano as numeroSequencialAno,
                    c.criado_em as criadoEm, c.updated_at as updatedAt
             FROM contratos c JOIN empresas e ON e.id = c.empresa_id WHERE e.escritorio_id = ?`;
  const params: any[] = [user.escritorioId];
  if (empresaId) { sql += ` AND c.empresa_id = ?`; params.push(empresaId); }
  if (status) { sql += ` AND c.status = ?`; params.push(status); }
  if (tipo) { sql += ` AND c.tipo = ?`; params.push(tipo); }
  sql += ` ORDER BY c.updated_at DESC`;
  res.json({ items: sqlite.prepare(sql).all(...params) });
});
app.post("/api/contratos", blockCliente, requirePermissao("contratos", "postar"), (req, res) => {
  const user = (req as any).user;
  const { modeloId, empresaId, dados } = req.body || {};
  const modelo = sqlite.prepare(`SELECT * FROM contratos_modelos WHERE id = ? AND ativo = 1 AND escritorio_id = ?`).get(Number(modeloId), user.escritorioId) as any;
  if (!modelo) return res.status(404).json({ error: "Modelo não encontrado ou inativo." });
  if (!podeAcessarEmpresa(user, Number(empresaId))) return res.status(403).json({ error: "Sem acesso a esta empresa." });
  const empresa = sqlite.prepare(`SELECT * FROM empresas WHERE id = ?`).get(Number(empresaId)) as any;
  if (!empresa) return res.status(404).json({ error: "Empresa não encontrada." });
  const camposModelo = JSON.parse(modelo.campos || "[]") as any[];
  const dadosFinal: Record<string, any> = { ...(dados || {}) };
  // {{dia}}/{{mes}}/{{ano}} são tokens reservados — sempre a data de hoje, sem precisar declarar
  // "campo" nem escolher auto-preencher pra isso; funciona em qualquer modelo que use esses nomes.
  const agoraContrato = agoraBrasilia();
  if (dadosFinal["dia"] === undefined || dadosFinal["dia"] === "") dadosFinal["dia"] = String(agoraContrato.dia);
  if (dadosFinal["mes"] === undefined || dadosFinal["mes"] === "") dadosFinal["mes"] = MESES_PT_EXTENSO[agoraContrato.mes - 1];
  if (dadosFinal["ano"] === undefined || dadosFinal["ano"] === "") dadosFinal["ano"] = String(agoraContrato.ano);
  // {{n_contrato_sequencial}} — reinicia em 1 a cada ano, nunca se repete dentro do mesmo ano, por escritório.
  const maxNumero = sqlite
    .prepare(
      `SELECT MAX(c.numero_sequencial) as maxNum FROM contratos c JOIN empresas e ON e.id = c.empresa_id
       WHERE c.tipo = 'contrato' AND c.numero_sequencial_ano = ? AND e.escritorio_id = ?`
    )
    .get(agoraContrato.ano, user.escritorioId) as any;
  const numeroSequencial = (maxNumero?.maxNum || 0) + 1;
  dadosFinal["n_contrato_sequencial"] = String(numeroSequencial);
  for (const campo of camposModelo) {
    if (campo.autoPreencherDe && CONTRATO_EMPRESA_CAMPO_SQL[campo.autoPreencherDe] && (dadosFinal[campo.chave] === undefined || dadosFinal[campo.chave] === "")) {
      dadosFinal[campo.chave] = empresa[CONTRATO_EMPRESA_CAMPO_SQL[campo.autoPreencherDe]] ?? "";
    }
  }
  const conteudoHtml = contratos.aplicarCamposNoModelo(modelo.conteudo_html, dadosFinal);
  const info = sqlite
    .prepare(
      `INSERT INTO contratos (modelo_id, empresa_id, titulo, conteudo_html, dados_preenchidos, numero_sequencial, numero_sequencial_ano, criado_por)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(modelo.id, empresa.id, `${modelo.nome} — ${empresa.nome}`, conteudoHtml, JSON.stringify(dadosFinal), numeroSequencial, agoraContrato.ano, user.id);
  res.json({ id: Number(info.lastInsertRowid) });
});
app.get("/api/contratos/distrato-config", blockCliente, requirePermissao("contratos", "visualizar"), (req, res) => {
  const c = sqlite.prepare(`SELECT * FROM contratos_distrato_config WHERE escritorio_id = ?`).get((req as any).user.escritorioId) as any;
  res.json({ clausulaPadrao: c?.clausula_padrao || "", assinaturasPadrao: c?.assinaturas_padrao || "" });
});
app.put("/api/contratos/distrato-config", blockCliente, requirePermissao("contratos", "editar"), (req, res) => {
  const escritorioId = (req as any).user.escritorioId;
  const { clausulaPadrao, assinaturasPadrao } = req.body || {};
  sqlite
    .prepare(
      `INSERT INTO contratos_distrato_config (escritorio_id, clausula_padrao, assinaturas_padrao, updated_at) VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT(escritorio_id) DO UPDATE SET clausula_padrao=excluded.clausula_padrao, assinaturas_padrao=excluded.assinaturas_padrao, updated_at=datetime('now')`
    )
    .run(escritorioId, clausulaPadrao ?? "", assinaturasPadrao ?? "");
  res.json({ ok: true });
});
// Usado pela tela ao aplicar os campos no documento — {{vlr_extenso}} não tem como ser calculado na
// criação do contrato porque o valor só é digitado depois, no painel "Dados do contrato". O campo é
// texto livre, então aceita tanto "1500.75" quanto "1.500,75" (só o segundo formato tem vírgula, que
// é o sinal de que é separador decimal brasileiro — sem vírgula, o ponto já é decimal padrão).
app.post("/api/contratos/valor-extenso", blockCliente, requirePermissao("contratos", "visualizar"), (req, res) => {
  const txt = String(req.body?.valor ?? "").trim();
  const valor = txt.includes(",") ? Number(txt.replace(/\./g, "").replace(",", ".")) : Number(txt);
  if (!Number.isFinite(valor)) return res.status(400).json({ error: "Valor inválido." });
  res.json({ extenso: contratos.valorPorExtenso(valor) });
});
app.get("/api/contratos/:id", blockCliente, requirePermissao("contratos", "visualizar"), (req, res) => {
  const row = sqlite
    .prepare(
      `SELECT c.*, e.nome as empresaNome, e.email as empresaEmail, m.nome as modeloNome, m.campos as modeloCampos, pai.titulo as contratoPaiTitulo
       FROM contratos c JOIN empresas e ON e.id = c.empresa_id
       LEFT JOIN contratos_modelos m ON m.id = c.modelo_id
       LEFT JOIN contratos pai ON pai.id = c.contrato_pai_id
       WHERE c.id = ?`
    )
    .get(Number(req.params.id)) as any;
  if (!row || !podeAcessarEmpresa((req as any).user, row.empresa_id)) return res.status(404).json({ error: "Contrato não encontrado." });
  res.json({
    id: row.id,
    empresaId: row.empresa_id,
    empresaNome: row.empresaNome,
    empresaEmail: row.empresaEmail,
    modeloId: row.modelo_id,
    modeloNome: row.modeloNome,
    modeloCampos: row.modeloCampos ? JSON.parse(row.modeloCampos) : [],
    tipo: row.tipo,
    contratoPaiId: row.contrato_pai_id,
    contratoPaiTitulo: row.contratoPaiTitulo,
    titulo: row.titulo,
    conteudoHtml: row.conteudo_html,
    dadosPreenchidos: JSON.parse(row.dados_preenchidos || "{}"),
    status: row.status,
    numeroSequencial: row.numero_sequencial,
    numeroSequencialAno: row.numero_sequencial_ano,
    criadoEm: row.criado_em,
    updatedAt: row.updated_at,
  });
});
app.put("/api/contratos/:id", blockCliente, requirePermissao("contratos", "editar"), (req, res) => {
  const id = Number(req.params.id);
  const existente = sqlite.prepare(`SELECT * FROM contratos WHERE id = ?`).get(id) as any;
  if (!existente || !podeAcessarEmpresa((req as any).user, existente.empresa_id)) return res.status(404).json({ error: "Contrato não encontrado." });
  const { titulo, conteudoHtml, status } = req.body || {};
  const statusValido = ["rascunho", "ativo", "encerrado"].includes(status) ? status : existente.status;
  sqlite
    .prepare(`UPDATE contratos SET titulo=?, conteudo_html=?, status=?, ultimo_pdf_path=NULL, updated_at=datetime('now') WHERE id=?`)
    .run(titulo !== undefined ? String(titulo).trim() : existente.titulo, conteudoHtml !== undefined ? String(conteudoHtml) : existente.conteudo_html, statusValido, id);
  if (existente.ultimo_pdf_path && fs.existsSync(existente.ultimo_pdf_path)) fs.unlinkSync(existente.ultimo_pdf_path);
  res.json({ ok: true });
});
app.post("/api/contratos/:id/aditivo", blockCliente, requirePermissao("contratos", "postar"), (req, res) => {
  const user = (req as any).user;
  const original = sqlite.prepare(`SELECT * FROM contratos WHERE id = ?`).get(Number(req.params.id)) as any;
  if (!original || !podeAcessarEmpresa(user, original.empresa_id)) return res.status(404).json({ error: "Contrato não encontrado." });
  if (original.tipo !== "contrato") return res.status(400).json({ error: "Só é possível criar aditivo a partir de um contrato original." });
  const empresa = sqlite.prepare(`SELECT nome FROM empresas WHERE id = ?`).get(original.empresa_id) as any;
  const dadosAlterados = typeof req.body?.dadosAlterados === "string" ? req.body.dadosAlterados.trim() : "";
  // Nasce com o mesmo timbrado do contrato original (se tiver) — o aditivo é um documento formal
  // como o contrato, tem que sair igual quando impresso/baixado em PDF. O número sequencial também
  // é herdado do contrato original (aditivo não gera um número novo — ele referencia o contrato).
  const cabecalho = contratos.extrairTrechoCabecalho(original.conteudo_html) || "";
  const numeroRef = original.numero_sequencial ? ` (nº ${original.numero_sequencial}/${original.numero_sequencial_ano})` : "";
  const conteudoInicial = contratos.aplicarCamposNoModelo(
    cabecalho +
      `<h1>Aditivo Contratual</h1><p>Aditivo ao contrato "${original.titulo}"${numeroRef}, firmado entre o escritório e ${empresa?.nome || ""}.</p>` +
      `<p>As partes acordam alterar/complementar o contrato original nos seguintes termos:</p>` +
      (dadosAlterados ? `<p>${contratos.escaparEQuebrarLinhas(dadosAlterados)}</p>` : `<p></p>`),
    { n_contrato_sequencial: original.numero_sequencial != null ? String(original.numero_sequencial) : "" }
  );
  const info = sqlite
    .prepare(
      `INSERT INTO contratos (modelo_id, empresa_id, tipo, contrato_pai_id, titulo, conteudo_html, numero_sequencial, numero_sequencial_ano, criado_por)
       VALUES (?, ?, 'aditivo', ?, ?, ?, ?, ?, ?)`
    )
    .run(original.modelo_id, original.empresa_id, original.id, `Aditivo ao Contrato — ${original.titulo}`, conteudoInicial, original.numero_sequencial, original.numero_sequencial_ano, user.id);
  res.json({ id: Number(info.lastInsertRowid) });
});
// Distrato: nasce com o mesmo timbrado do contrato original (igual ao aditivo) + a cláusula e as
// assinaturas padrão configuradas uma única vez na aba Modelos — o admin não digita nada na hora,
// só revisa/ajusta antes de salvar.
app.post("/api/contratos/:id/distrato", blockCliente, requirePermissao("contratos", "postar"), (req, res) => {
  const user = (req as any).user;
  const original = sqlite.prepare(`SELECT * FROM contratos WHERE id = ?`).get(Number(req.params.id)) as any;
  if (!original || !podeAcessarEmpresa(user, original.empresa_id)) return res.status(404).json({ error: "Contrato não encontrado." });
  if (original.tipo !== "contrato") return res.status(400).json({ error: "Só é possível criar distrato a partir de um contrato original." });
  const empresa = sqlite.prepare(`SELECT nome FROM empresas WHERE id = ?`).get(original.empresa_id) as any;
  const padrao = sqlite.prepare(`SELECT * FROM contratos_distrato_config WHERE escritorio_id = ?`).get(user.escritorioId) as any;
  // O escritório (Contratada) é sempre a mesma empresa em todo distrato — reaproveita a mesma
  // referência já configurada pelo admin em NFS-e > Configuração (empresa prestador), em vez de ter
  // uma segunda config paralela só pra isso.
  const agConfig = sqlite.prepare(`SELECT empresa_prestador_id FROM nfse_agendamento_config WHERE escritorio_id = ?`).get(user.escritorioId) as any;
  const escritorio = agConfig?.empresa_prestador_id ? (sqlite.prepare(`SELECT nome FROM empresas WHERE id = ?`).get(agConfig.empresa_prestador_id) as any) : null;
  // Número sequencial herdado do contrato original — o distrato não gera um número novo, ele
  // referencia o contrato que está sendo encerrado.
  const tokens = {
    empresa_nome: empresa?.nome || "",
    escritorio_nome: escritorio?.nome || "",
    contrato_titulo: original.titulo,
    data: new Date().toLocaleDateString("pt-BR"),
    n_contrato_sequencial: original.numero_sequencial != null ? String(original.numero_sequencial) : "",
  };
  const cabecalho = contratos.extrairTrechoCabecalho(original.conteudo_html) || "";
  const numeroRef = original.numero_sequencial ? ` (nº ${original.numero_sequencial}/${original.numero_sequencial_ano})` : "";
  const clausula = padrao?.clausula_padrao ? contratos.aplicarCamposNoModelo(padrao.clausula_padrao, tokens) : "<p>Defina a cláusula padrão de distrato na aba Modelos.</p>";
  const assinaturas = padrao?.assinaturas_padrao ? contratos.aplicarCamposNoModelo(padrao.assinaturas_padrao, tokens) : "";
  const conteudoInicial =
    cabecalho +
    `<h1>Distrato Contratual</h1><p>Distrato do contrato "${original.titulo}"${numeroRef}, firmado entre o escritório e ${empresa?.nome || ""}.</p>` +
    clausula +
    assinaturas;
  const info = sqlite
    .prepare(
      `INSERT INTO contratos (modelo_id, empresa_id, tipo, contrato_pai_id, titulo, conteudo_html, numero_sequencial, numero_sequencial_ano, criado_por)
       VALUES (?, ?, 'distrato', ?, ?, ?, ?, ?, ?)`
    )
    .run(original.modelo_id, original.empresa_id, original.id, `Distrato do Contrato — ${original.titulo}`, conteudoInicial, original.numero_sequencial, original.numero_sequencial_ano, user.id);
  res.json({ id: Number(info.lastInsertRowid) });
});
app.delete("/api/contratos/:id", blockCliente, requirePermissao("contratos", "editar"), (req, res) => {
  const existente = sqlite.prepare(`SELECT status, ultimo_pdf_path, empresa_id FROM contratos WHERE id = ?`).get(Number(req.params.id)) as any;
  if (!existente || !podeAcessarEmpresa((req as any).user, existente.empresa_id)) return res.status(404).json({ error: "Contrato não encontrado." });
  if (existente.status !== "rascunho") return res.status(409).json({ error: "Só é possível excluir contratos em rascunho — encerre em vez de excluir um contrato já ativo." });
  if (existente.ultimo_pdf_path && fs.existsSync(existente.ultimo_pdf_path)) fs.unlinkSync(existente.ultimo_pdf_path);
  sqlite.prepare(`DELETE FROM contratos WHERE id = ?`).run(Number(req.params.id));
  res.json({ ok: true });
});
async function contratoObterPdf(row: any): Promise<Buffer> {
  if (row.ultimo_pdf_path && fs.existsSync(row.ultimo_pdf_path)) return fs.readFileSync(row.ultimo_pdf_path);
  const pdf = await contratos.gerarPdfDeHtml(row.conteudo_html, row.titulo);
  const destino = contratos.caminhoPdfContrato(row.id);
  fs.writeFileSync(destino, pdf);
  sqlite.prepare(`UPDATE contratos SET ultimo_pdf_path = ? WHERE id = ?`).run(destino, row.id);
  return pdf;
}
app.get("/api/contratos/:id/pdf", blockCliente, requirePermissao("contratos", "visualizar"), async (req, res) => {
  const row = sqlite.prepare(`SELECT * FROM contratos WHERE id = ?`).get(Number(req.params.id)) as any;
  if (!row || !podeAcessarEmpresa((req as any).user, row.empresa_id)) return res.status(404).json({ error: "Contrato não encontrado." });
  try {
    const pdf = await contratoObterPdf(row);
    res.set("Content-Type", "application/pdf");
    res.set("Content-Disposition", `attachment; filename="${row.titulo.replace(/[^\w\-. ]/g, "")}.pdf"`);
    res.send(pdf);
  } catch (e: any) {
    res.status(502).json({ error: `Não consegui gerar o PDF: ${e.message}` });
  }
});
app.post("/api/contratos/:id/enviar-email", blockCliente, requirePermissao("contratos", "editar"), async (req, res) => {
  const user = (req as any).user;
  const row = sqlite.prepare(`SELECT c.*, e.email as empresaEmail FROM contratos c JOIN empresas e ON e.id = c.empresa_id WHERE c.id = ?`).get(Number(req.params.id)) as any;
  if (!row || !podeAcessarEmpresa(user, row.empresa_id)) return res.status(404).json({ error: "Contrato não encontrado." });
  const destino = (req.body?.email && String(req.body.email).trim()) || row.empresaEmail;
  if (!destino) return res.status(400).json({ error: "Esta empresa não tem e-mail cadastrado — digite um e-mail pra enviar." });
  try {
    const pdf = await contratoObterPdf(row);
    await enviarEmail(user.escritorioId, {
      to: [destino],
      subject: row.titulo,
      text: `Segue em anexo o documento "${row.titulo}".`,
      attachments: [{ filename: `${row.titulo.replace(/[^\w\-. ]/g, "")}.pdf`, content: pdf }],
    });
    sqlite.prepare(`INSERT INTO contratos_envios (contrato_id, email_destino, sucesso, enviado_por) VALUES (?, ?, 1, ?)`).run(row.id, destino, user.id);
    res.json({ ok: true });
  } catch (e: any) {
    sqlite.prepare(`INSERT INTO contratos_envios (contrato_id, email_destino, sucesso, erro, enviado_por) VALUES (?, ?, 0, ?, ?)`).run(row.id, destino, e.message, user.id);
    res.status(502).json({ error: e.message });
  }
});

// ---------- Relatórios ----------
// Lista de empresas para o filtro de cliente nos relatórios (só as marcadas como visíveis em relatórios)
app.get("/api/relatorios/empresas", blockCliente, requirePermissao("relatorios", "visualizar"), (req, res) => {
  const user = (req as any).user;
  let rows = sqlite.prepare(`SELECT id, nome, cnpj FROM empresas WHERE ativo = 1 AND visivel_relatorios = 1 ORDER BY nome`).all() as any[];
  const visiveis = empresasVisiveis(user);
  if (visiveis !== null) rows = rows.filter((r) => visiveis.includes(r.id));
  res.json({ items: rows });
});
const TIPOS_RELATORIO = ["balanco", "balancete", "dre", "faturamento", "folha"];
// ---------- Relatório de Retenções de Impostos (a partir da Busca de XML, não do Domínio Web) ----------
// Notas de SERVIÇO (NFS-e) em que a empresa é a TOMADORA (quem recebeu o serviço e reteve o
// imposto na fonte, ao pagar o prestador) — igual ao "Acompanhamento de Entradas" que o Domínio Web
// já gera, só que alimentado pelos documentos que este sistema já busca sozinho via Distribuição
// DFe. Retenções federais (INSS/contribuição previdenciária, IRRF, PIS, COFINS, CSLL) contam quando
// o valor retido é > 0; ISS conta pelo indicador tpRetISSQN (2=retido pelo tomador, 3=pelo
// intermediário) — o valor do ISS pode existir mesmo sem ter sido retido, então só o indicador diz
// a verdade.
function escHtmlRelatorio(s: string | null | undefined): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}
interface RetencaoNfseItem {
  docId: number;
  numeroNfse: string | null;
  emitenteNome: string;
  emitenteCnpj: string;
  dataEmissao: string | null;
  valorServico: number;
  inss: number;
  irrf: number;
  pis: number;
  cofins: number;
  csll: number;
  iss: number;
}
// Regra de qualificação + cálculo das colunas, extraída pra ser reaproveitada tanto pelo relatório de
// UMA empresa (calcularRetencoesNfse) quanto pela grade de "quais empresas têm retenção nesse
// período" (listarEmpresasComRetencoes) — mesma lógica, um lugar só.
function retencaoCalcularColunas(ret: danfse.RetencoesNfse): { qualifica: boolean; inss: number; irrf: number; pis: number; cofins: number; csll: number; iss: number } {
  // Filtro: entra no relatório quem tem alguma retenção FEDERAL (IRRF/CSLL/INSS com valor > 0 no
  // XML, PIS/COFINS com retenção indicada) OU o ISS retido pelo tomador/intermediário (tpRetISSQN
  // 2/3) — qualquer um desses já é motivo suficiente pra aparecer.
  // PIS/COFINS: `vPis`/`vCofins` NÃO são retenção — são "Débito Apuração Própria" (o que o próprio
  // prestador recolhe no regime normal, sempre preenchido nas notas dele, retenção ou não). Quem
  // diz se houve retenção é `tpRetPisCofins`. Confirmado empiricamente em >500 notas reais de
  // produção: valores 1 e 3 sempre vêm acompanhados de outra retenção federal (IRRF/CSLL) na mesma
  // nota; valores 0 e 2 nunca vêm — mesmo quando vPis/vCofins estão preenchidos com valor > 0.
  // Mas essa tag é opcional e alguns emissores (ex.: Cambridge) nunca a preenchem, mesmo em notas
  // com retenção federal real (IRRF/CSLL retidos). Pela IN 1234/2012, a retenção federal combinada
  // (DARF 1708) é sempre IRRF+CSLL+PIS+COFINS juntos — não existe retenção "parcial" desses 4. Por
  // isso, além de `tpRetPisCofins`, também consideramos retido quando a nota já tem IRRF ou CSLL
  // retidos (mesmo sem a tag), e só confiamos em "não retido" (tpRetPisCofins 0/2, sem IRRF/CSLL)
  // quando não há nenhum outro indício de retenção federal — foi exatamente esse o caso da nota da
  // ELECTRIA que motivou a correção anterior.
  const temIrrf = ret.vRetIRRF > 0;
  const temCsll = ret.vRetCSLL > 0;
  const pisCofinsRetido = ret.tpRetPisCofins === 1 || ret.tpRetPisCofins === 3 || temIrrf || temCsll;
  const temPis = pisCofinsRetido;
  const temCofins = pisCofinsRetido;
  const temInss = ret.vRetCP > 0;
  const issRetido = ret.tpRetISSQN === 2 || ret.tpRetISSQN === 3;
  // Valor da coluna é RECALCULADO pela alíquota padrão sobre o valor bruto do serviço, não o valor
  // que veio no XML — a pedido do usuário (o emissor pode ter calculado errado; a coluna deve
  // mostrar o que É DEVIDO, não o que o prestador declarou). Só calcula quando o XML já indicava
  // alguma retenção daquele imposto (> 0); senão fica 0, mesmo que a nota tenha entrado no
  // relatório por causa de outro imposto retido. ISS é o único que continua trazendo o valor cru
  // do XML (vISSQN), quando o indicador de retenção está marcado — não tem alíquota fixa única
  // pra recalcular (varia por município).
  return {
    qualifica: temIrrf || temCsll || temPis || temCofins || temInss || issRetido,
    inss: temInss ? ret.valorServico * 0.11 : 0,
    irrf: temIrrf ? ret.valorServico * 0.015 : 0,
    pis: temPis ? ret.valorServico * 0.0065 : 0,
    cofins: temCofins ? ret.valorServico * 0.03 : 0,
    csll: temCsll ? ret.valorServico * 0.01 : 0,
    iss: issRetido ? ret.vISSQN : 0,
  };
}
function calcularRetencoesNfse(user: any, empresaId: number, dataDe: string | null, dataAte: string | null): { empresa: any; itens: RetencaoNfseItem[]; somas: Record<string, number> } {
  const empresa = sqlite.prepare(`SELECT id, nome, cnpj, endereco, cidade, uf, cep FROM empresas WHERE id = ?`).get(empresaId) as any;
  if (!empresa || !podeAcessarEmpresa(user, empresaId)) {
    const err: any = new Error("Empresa não encontrada.");
    err.status = 404;
    throw err;
  }
  const cnpjLimpo = String(empresa.cnpj || "").replace(/\D/g, "");
  let sql = `SELECT id as docId, emitente_nome as emitenteNome, emitente_cnpj as emitenteCnpj, data_emissao as dataEmissao, xml
             FROM nfe_documentos WHERE escritorio_id = ? AND empresa_id = ? AND fonte = 'nfse' AND destinatario_cnpj = ?`;
  const params: any[] = [user.escritorioId, empresaId, cnpjLimpo];
  if (dataDe) {
    sql += ` AND substr(data_emissao,1,10) >= ?`;
    params.push(dataDe);
  }
  if (dataAte) {
    sql += ` AND substr(data_emissao,1,10) <= ?`;
    params.push(dataAte);
  }
  sql += ` ORDER BY data_emissao ASC`;
  const rows = sqlite.prepare(sql).all(...params) as any[];
  const itens: RetencaoNfseItem[] = [];
  for (const r of rows) {
    let ret;
    try {
      ret = danfse.extrairRetencoesNfse(r.xml);
    } catch {
      continue; // XML fora do padrão esperado — pula em vez de derrubar o relatório inteiro
    }
    const calc = retencaoCalcularColunas(ret);
    if (!calc.qualifica) continue;
    itens.push({
      docId: r.docId,
      numeroNfse: ret.numeroNfse,
      emitenteNome: r.emitenteNome,
      emitenteCnpj: r.emitenteCnpj,
      dataEmissao: r.dataEmissao,
      valorServico: ret.valorServico,
      inss: calc.inss,
      irrf: calc.irrf,
      pis: calc.pis,
      cofins: calc.cofins,
      csll: calc.csll,
      iss: calc.iss,
    });
  }
  const somas: Record<string, number> = itens.reduce(
    (acc, it) => {
      acc.valorServico += it.valorServico;
      acc.inss += it.inss;
      acc.irrf += it.irrf;
      acc.pis += it.pis;
      acc.cofins += it.cofins;
      acc.csll += it.csll;
      acc.iss += it.iss;
      return acc;
    },
    { valorServico: 0, inss: 0, irrf: 0, pis: 0, cofins: 0, csll: 0, iss: 0 } as Record<string, number>
  );
  somas.totalGeral = somas.inss + somas.irrf + somas.pis + somas.cofins + somas.csll + somas.iss;
  return { empresa, itens, somas };
}
app.get("/api/relatorios/retencoes", blockCliente, requirePermissao("relatorios", "visualizar"), (req, res) => {
  const empresaId = req.query.empresaId ? Number(req.query.empresaId) : null;
  if (!empresaId) return res.json({ itens: [], somas: null });
  const dataDe = typeof req.query.dataDe === "string" && req.query.dataDe ? req.query.dataDe : null;
  const dataAte = typeof req.query.dataAte === "string" && req.query.dataAte ? req.query.dataAte : null;
  try {
    const { itens, somas } = calcularRetencoesNfse((req as any).user, empresaId, dataDe, dataAte);
    res.json({ itens, somas });
  } catch (e: any) {
    res.status(e.status || 500).json({ error: e.message });
  }
});
// Grade "quais empresas têm nota com retenção nesse período" — mostrada de cara na aba (competência
// anterior por padrão, calculado no frontend), sem precisar escolher um cliente primeiro. Varre os
// documentos de TODAS as empresas visíveis ao usuário de uma vez (uma query só, não uma por
// empresa) e agrupa por empresa quem passa na mesma regra de qualificação do relatório individual.
function listarEmpresasComRetencoes(user: any, dataDe: string, dataAte: string) {
  const visiveis = empresasVisiveis(user);
  if (visiveis !== null && visiveis.length === 0) return [];
  let sql = `SELECT d.empresa_id as empresaId, e.nome as empresaNome, d.xml
             FROM nfe_documentos d JOIN empresas e ON e.id = d.empresa_id
             WHERE d.escritorio_id = ? AND d.fonte = 'nfse' AND e.ativo = 1
               AND substr(d.data_emissao,1,10) >= ? AND substr(d.data_emissao,1,10) <= ?`;
  const params: any[] = [user.escritorioId, dataDe, dataAte];
  if (visiveis !== null) {
    sql += ` AND d.empresa_id IN (${visiveis.map(() => "?").join(",")})`;
    params.push(...visiveis);
  }
  const rows = sqlite.prepare(sql).all(...params) as any[];
  const porEmpresa = new Map<number, { empresaId: number; empresaNome: string; qtdNotas: number; somas: Record<string, number> }>();
  for (const r of rows) {
    let ret;
    try {
      ret = danfse.extrairRetencoesNfse(r.xml);
    } catch {
      continue;
    }
    const calc = retencaoCalcularColunas(ret);
    if (!calc.qualifica) continue;
    let acc = porEmpresa.get(r.empresaId);
    if (!acc) {
      acc = { empresaId: r.empresaId, empresaNome: r.empresaNome, qtdNotas: 0, somas: { valorServico: 0, inss: 0, irrf: 0, pis: 0, cofins: 0, csll: 0, iss: 0, totalGeral: 0 } };
      porEmpresa.set(r.empresaId, acc);
    }
    acc.qtdNotas++;
    acc.somas.valorServico += ret.valorServico;
    acc.somas.inss += calc.inss;
    acc.somas.irrf += calc.irrf;
    acc.somas.pis += calc.pis;
    acc.somas.cofins += calc.cofins;
    acc.somas.csll += calc.csll;
    acc.somas.iss += calc.iss;
    acc.somas.totalGeral += calc.inss + calc.irrf + calc.pis + calc.cofins + calc.csll + calc.iss;
  }
  return [...porEmpresa.values()].sort((a, b) => a.empresaNome.localeCompare(b.empresaNome, "pt-BR"));
}
app.get("/api/relatorios/retencoes/empresas", blockCliente, requirePermissao("relatorios", "visualizar"), (req, res) => {
  const dataDe = typeof req.query.dataDe === "string" && req.query.dataDe ? req.query.dataDe : null;
  const dataAte = typeof req.query.dataAte === "string" && req.query.dataAte ? req.query.dataAte : null;
  if (!dataDe || !dataAte) return res.status(400).json({ error: "Informe o período (de/até)." });
  const items = listarEmpresasComRetencoes((req as any).user, dataDe, dataAte);
  res.json({ items });
});
// ---------- Balanço/DRE/Balancete (alimentados pela importação de PDF do OneDrive, ver
// dominioRelatoriosSincronizar) — os documentos são envio_documentos de verdade, então essas rotas só
// consultam envio_atribuicoes/envio_periodos/envio_documentos pelos templates dedicados.
function domRelTemplateNomesParaTipo(tipo: string): string[] {
  if (tipo === "balanco") return ["Balanço"];
  if (tipo === "balancete") return ["Balancete"];
  if (tipo === "dre") return ["DRE Mensal", "DRE Anual"];
  if (tipo === "faturamento") return ["Relação de Faturamento"];
  if (tipo === "razao") return ["Razão"];
  return [];
}
app.get("/api/relatorios/documentos/empresas", blockCliente, requirePermissao("relatorios", "visualizar"), (req, res) => {
  const user = (req as any).user;
  const nomes = domRelTemplateNomesParaTipo(String(req.query.tipo || ""));
  if (!nomes.length) return res.status(400).json({ error: "Tipo de relatório inválido." });
  const visiveis = empresasVisiveis(user);
  if (visiveis !== null && visiveis.length === 0) return res.json({ items: [] });
  let sql = `SELECT a.empresa_id as empresaId, e.nome as empresaNome, COUNT(d.id) as qtdDocumentos, MAX(d.enviado_em) as ultimoEm
             FROM envio_atribuicoes a
             JOIN envio_templates t ON t.id = a.template_id
             JOIN empresas e ON e.id = a.empresa_id
             JOIN envio_periodos p ON p.atribuicao_id = a.id
             JOIN envio_documentos d ON d.periodo_id = p.id
             WHERE t.escritorio_id = ? AND t.nome IN (${nomes.map(() => "?").join(",")}) AND e.ativo = 1`;
  const params: any[] = [user.escritorioId, ...nomes];
  if (visiveis !== null) {
    sql += ` AND a.empresa_id IN (${visiveis.map(() => "?").join(",")})`;
    params.push(...visiveis);
  }
  sql += ` GROUP BY a.empresa_id ORDER BY e.nome COLLATE NOCASE`;
  res.json({ items: sqlite.prepare(sql).all(...params) });
});
app.get("/api/relatorios/documentos", blockCliente, requirePermissao("relatorios", "visualizar"), (req, res) => {
  const user = (req as any).user;
  const nomes = domRelTemplateNomesParaTipo(String(req.query.tipo || ""));
  if (!nomes.length) return res.status(400).json({ error: "Tipo de relatório inválido." });
  const empresaId = req.query.empresaId ? Number(req.query.empresaId) : null;
  if (!empresaId || !podeAcessarEmpresa(user, empresaId)) return res.status(404).json({ error: "Empresa não encontrada." });
  const atribuicoes = sqlite
    .prepare(
      `SELECT a.id as atribuicaoId, t.nome as templateNome FROM envio_atribuicoes a JOIN envio_templates t ON t.id = a.template_id
       WHERE t.escritorio_id = ? AND a.empresa_id = ? AND t.nome IN (${nomes.map(() => "?").join(",")})`
    )
    .all(user.escritorioId, empresaId, ...nomes) as any[];
  const grupos = atribuicoes
    .map((a) => {
      const periodos = sqlite.prepare(`SELECT id, ano, mes, rotulo FROM envio_periodos WHERE atribuicao_id = ? ORDER BY ano DESC, mes DESC`).all(a.atribuicaoId) as any[];
      const periodoIds = periodos.map((p) => p.id);
      const docs = periodoIds.length
        ? (sqlite
            .prepare(
              `SELECT id, periodo_id as periodoId, file_name as fileName, enviado_em as enviadoEm, observacao,
                      email_enviado as emailEnviado, whatsapp_enviado as whatsappEnviado
               FROM envio_documentos WHERE periodo_id IN (${periodoIds.map(() => "?").join(",")}) ORDER BY enviado_em DESC`
            )
            .all(...periodoIds) as any[])
        : [];
      const docsPorPeriodo = new Map<number, any[]>();
      for (const d of docs) {
        if (!docsPorPeriodo.has(d.periodoId)) docsPorPeriodo.set(d.periodoId, []);
        docsPorPeriodo.get(d.periodoId)!.push({ ...d, emailEnviado: !!d.emailEnviado, whatsappEnviado: !!d.whatsappEnviado });
      }
      return {
        templateNome: a.templateNome,
        periodos: periodos.filter((p) => docsPorPeriodo.has(p.id)).map((p) => ({ ...p, documentos: docsPorPeriodo.get(p.id) || [] })),
      };
    })
    .filter((g) => g.periodos.length);
  res.json({ grupos });
});
function fmtCnpjRelatorio(doc: string | null): string {
  const d = String(doc || "").replace(/\D/g, "");
  if (d.length === 14) return d.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, "$1.$2.$3/$4-$5");
  if (d.length === 11) return d.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, "$1.$2.$3-$4");
  return doc || "-";
}
function fmtMoedaRelatorio(v: number): string {
  return (v || 0).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
// Extraído de GET /api/relatorios/retencoes/pdf (rota do escritório) pra ser reaproveitado também por
// POST /api/envio/solicitar-retencoes (o cliente pede a própria competência em "Solicitar
// Documentos" e recebe o PDF gerado na hora, sem esperar o escritório).
async function gerarPdfRetencoes(user: any, empresaId: number, dataDe: string | null, dataAte: string | null): Promise<{ pdf: Buffer; empresa: any }> {
  const { empresa, itens, somas } = calcularRetencoesNfse(user, empresaId, dataDe, dataAte);
  const enderecoLinha = [empresa.endereco, empresa.cidade, empresa.uf, empresa.cep].filter(Boolean).join(" — ");
    const fmtDataBrRelatorio = (iso: string) => iso.split("-").reverse().join("/");
    const periodoLinha =
      dataDe || dataAte
        ? `Período: ${dataDe ? fmtDataBrRelatorio(dataDe) : "…"} até ${dataAte ? fmtDataBrRelatorio(dataAte) : "…"}`
        : "Período: todas as competências";
    // Não usa Date/toLocaleDateString aqui de propósito: o Chromium do PDF roda em UTC no servidor
    // (achado ao vivo — testando com uma nota real de "22:07 -03:00", o dia virava o seguinte),
    // então reinterpretar a data por um objeto Date troca o dia perto da virada da meia-noite. Os 10
    // primeiros caracteres (AAAA-MM-DD) já são o dia local certo — o próprio timestamp já vem com o
    // fuso -03:00 aplicado, só precisa reformatar o texto, não recalcular.
    const fmtDataEmissaoRelatorio = (iso: string | null) => {
      if (!iso) return "-";
      const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso));
      return m ? `${m[3]}/${m[2]}/${m[1]}` : "-";
    };
    const linhas = itens.length
      ? itens
          .map(
            (it) => `<tr>
        <td>${fmtDataEmissaoRelatorio(it.dataEmissao)}</td>
        <td>${escHtmlRelatorio(it.numeroNfse || "-")}</td>
        <td>${escHtmlRelatorio(it.emitenteNome || "-")}</td>
        <td>${escHtmlRelatorio(fmtCnpjRelatorio(it.emitenteCnpj))}</td>
        <td class="num">${fmtMoedaRelatorio(it.valorServico)}</td>
        <td class="num">${fmtMoedaRelatorio(it.inss)}</td>
        <td class="num">${fmtMoedaRelatorio(it.irrf)}</td>
        <td class="num">${fmtMoedaRelatorio(it.pis)}</td>
        <td class="num">${fmtMoedaRelatorio(it.cofins)}</td>
        <td class="num">${fmtMoedaRelatorio(it.csll)}</td>
        <td class="num">${fmtMoedaRelatorio(it.iss)}</td>
      </tr>`
          )
          .join("")
      : `<tr><td colspan="11" style="text-align:center; padding:16px;">Nenhuma nota com retenção encontrada no período.</td></tr>`;
    const html = `<style>
      body { font-family: 'Helvetica Neue', Arial, sans-serif !important; font-size: 9px; color:#222; }
      h1 { font-size: 15px; text-align:left; margin: 0 0 2px; }
      .cab p { margin: 1px 0; text-align:left; color:#444; font-size: 10px; }
      h2 { font-size: 12px; margin: 14px 0 6px; }
      table.rep { border-collapse: collapse; width: 100%; margin-top: 4px; }
      table.rep th, table.rep td { border: 1px solid #ccc; padding: 3px 5px; }
      table.rep th { background:#f0f0f0; text-align:left; font-size: 8.5px; white-space: nowrap; }
      table.rep td.num, table.rep th.num { text-align:right; }
      /* Data/Número/CNPJ/valores são sempre curtos — nowrap neles evita que a linha inteira fique
         alta só por causa desses, deixando a quebra acontecer só no nome do emitente quando precisar. */
      table.rep td:nth-child(1), table.rep td:nth-child(2), table.rep td:nth-child(4), table.rep td.num { white-space: nowrap; }
      tr.total-row td { font-weight:bold; background:#f5f5f5; }
      .tag-total { display:inline-block; background:#1a7f4b; color:#fff; padding:6px 14px; border-radius:6px; font-weight:bold; font-size:11px; margin-top:12px; }
    </style>
    <div class="cab">
      <h1>${escHtmlRelatorio(empresa.nome)}</h1>
      <p>CNPJ: ${escHtmlRelatorio(fmtCnpjRelatorio(empresa.cnpj))}${enderecoLinha ? " — " + escHtmlRelatorio(enderecoLinha) : ""}</p>
      <p>${escHtmlRelatorio(periodoLinha)}</p>
    </div>
    <h2>Retenções de Impostos</h2>
    <table class="rep">
      <thead><tr><th>Data Emissão</th><th>Número</th><th>Emitente</th><th>CNPJ</th><th class="num">Valor Bruto</th><th class="num">INSS</th><th class="num">IRRF</th><th class="num">PIS</th><th class="num">COFINS</th><th class="num">CSLL</th><th class="num">ISS</th></tr></thead>
      <tbody>
        ${linhas}
        <tr class="total-row">
          <td colspan="4">TOTAL</td>
          <td class="num">${fmtMoedaRelatorio(somas.valorServico)}</td>
          <td class="num">${fmtMoedaRelatorio(somas.inss)}</td>
          <td class="num">${fmtMoedaRelatorio(somas.irrf)}</td>
          <td class="num">${fmtMoedaRelatorio(somas.pis)}</td>
          <td class="num">${fmtMoedaRelatorio(somas.cofins)}</td>
          <td class="num">${fmtMoedaRelatorio(somas.csll)}</td>
          <td class="num">${fmtMoedaRelatorio(somas.iss)}</td>
        </tr>
      </tbody>
    </table>
    <div><span class="tag-total">Total geral de retenções: R$ ${fmtMoedaRelatorio(somas.totalGeral)}</span></div>`;
  const pdf = await contratos.gerarPdfDeHtml(html, `Retenções de Impostos - ${empresa.nome}`, { landscape: true });
  return { pdf, empresa };
}
app.get("/api/relatorios/retencoes/pdf", blockCliente, requirePermissao("relatorios", "visualizar"), async (req, res) => {
  const empresaId = req.query.empresaId ? Number(req.query.empresaId) : null;
  if (!empresaId) return res.status(400).json({ error: "Informe a empresa." });
  const dataDe = typeof req.query.dataDe === "string" && req.query.dataDe ? req.query.dataDe : null;
  const dataAte = typeof req.query.dataAte === "string" && req.query.dataAte ? req.query.dataAte : null;
  try {
    const { pdf, empresa } = await gerarPdfRetencoes((req as any).user, empresaId, dataDe, dataAte);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="Retencoes - ${empresa.nome.replace(/[\\/:*?"<>|]/g, "_")}.pdf"`);
    res.send(pdf);
  } catch (e: any) {
    res.status(e.status || 500).json({ error: e.message });
  }
});
// Cliente pede o relatório de retenções da própria empresa direto em "Solicitar Documentos" — não é
// um envio_template comum (nunca fica "aguardando o escritório"): gera o PDF na hora a partir das
// notas já recebidas e anexa em Envio de Documentos sob um template interno dedicado, igual ao
// recálculo de DAS (ver executarRecalculoDas acima). substituirExistente:true porque, se o cliente
// pedir a mesma competência de novo, o certo é regenerar com as notas mais recentes, não empilhar.
app.post("/api/envio/solicitar-retencoes", requireCliente, async (req, res) => {
  const user = (req as any).user;
  if (!user.empresaId) return res.status(400).json({ error: "Seu usuário não está vinculado a uma empresa." });
  if (!empresaPodeSolicitar(user.empresaId, "retencoes")) {
    return res.status(403).json({ error: "Sua empresa não está habilitada a solicitar o relatório de retenções." });
  }
  const mes = Number(req.body?.mes);
  const ano = Number(req.body?.ano);
  if (!ano || !mes || mes < 1 || mes > 12) return res.status(400).json({ error: "Informe o mês e o ano." });
  try {
    const dataDe = `${ano}-${String(mes).padStart(2, "0")}-01`;
    const ultimoDia = new Date(ano, mes, 0).getDate();
    const dataAte = `${ano}-${String(mes).padStart(2, "0")}-${String(ultimoDia).padStart(2, "0")}`;
    const { pdf } = await gerarPdfRetencoes(user, user.empresaId, dataDe, dataAte);
    const atribuicaoId = integraContadorObterOuCriarAtribuicaoModelo(
      user.escritorioId,
      user.empresaId,
      "Retenções de Impostos",
      "Relatório de retenções de impostos, gerado na hora a partir das notas fiscais recebidas — o cliente pode pedir qualquer competência já lançada.",
      "mensal",
      false
    );
    const observacao = `Gerado na hora a pedido do cliente em ${new Date().toLocaleDateString("pt-BR")}.`;
    const nomeArquivo = `Retencoes ${String(mes).padStart(2, "0")}-${ano}.pdf`;
    const docId = integraContadorAnexarPdfEmEnvio(atribuicaoId, user.empresaId, ano, mes, nomeArquivo, pdf.toString("base64"), observacao, null, true);
    const doc = sqlite.prepare(`SELECT periodo_id FROM envio_documentos WHERE id = ?`).get(docId) as any;
    sqlite.prepare(`UPDATE envio_periodos SET solicitado_em = datetime('now'), solicitado_por = ?, solicitacao_tipo = 'documento' WHERE id = ?`).run(user.id, doc.periodo_id);
    res.json({ ok: true });
  } catch (e: any) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

app.get("/api/relatorios/:tipo", blockCliente, requirePermissao("relatorios", "visualizar"), (req, res) => {
  const tipo = String(req.params.tipo);
  if (!TIPOS_RELATORIO.includes(tipo)) return res.status(400).json({ error: "Relatório inválido." });
  const empresaId = req.query.empresaId ? Number(req.query.empresaId) : null;
  if (!empresaId) return res.json({ conectado: false, items: [] });
  const user = (req as any).user;
  if (!podeAcessarEmpresa(user, empresaId)) return res.status(403).json({ error: "Sem acesso a esta empresa." });
  const rows = sqlite
    .prepare(`SELECT competencia, dados_json as dadosJson, sincronizado_em as sincronizadoEm FROM dominio_dados WHERE empresa_id = ? AND tipo = ? ORDER BY competencia DESC`)
    .all(empresaId, tipo) as any[];
  res.json({
    conectado: rows.length > 0,
    items: rows.map((r) => ({ competencia: r.competencia, dados: JSON.parse(r.dadosJson), sincronizadoEm: r.sincronizadoEm })),
  });
});


// ---------- E-mail corporativo ----------
app.get("/api/email/status", blockCliente, (req, res) => {
  const escritorioId = (req as any).user.escritorioId;
  const c = getEmailConfig(escritorioId);
  const fallback = escritorioId === 1;
  res.json({ configurado: emailConfigurado(escritorioId), from: c.from_email || (fallback && process.env.SMTP_FROM_EMAIL) || c.smtp_user || (fallback && process.env.SMTP_USER) || null });
});
// As credenciais SMTP (host/usuário/senha) ficam restritas ao Administrador — um Colaborador com
// acesso à aba "E-mail corporativo" (ex.: só pra editar o texto padrão do NFS-e ou cadastrar
// contatos de cliente) não deve ver nem conseguir trocar a conta de e-mail do escritório inteiro.
app.get("/api/email/config", blockCliente, requirePermissao("configuracoes", "visualizar"), (req, res) => {
  const user = (req as any).user;
  const isAdmin = user.perfil === "Administrador";
  const c = getEmailConfig(user.escritorioId);
  res.json({
    smtpHost: isAdmin ? c.smtp_host || "" : null,
    smtpPort: isAdmin ? c.smtp_port || 587 : null,
    smtpSecure: isAdmin ? !!c.smtp_secure : null,
    smtpUser: isAdmin ? c.smtp_user || "" : null,
    temSenha: isAdmin ? !!c.smtp_password : null,
    fromName: isAdmin ? c.from_name || "" : null,
    fromEmail: isAdmin ? c.from_email || "" : null,
    nfseEmailTexto: c.nfse_email_texto || "",
    updatedAt: c.updated_at || null,
  });
});
app.put("/api/email/config", blockCliente, requirePermissao("configuracoes", "editar"), (req, res) => {
  const user = (req as any).user;
  const isAdmin = user.perfil === "Administrador";
  const escritorioId = user.escritorioId;
  const b = req.body || {};
  const atual = getEmailConfig(escritorioId);
  sqlite
    .prepare(
      `INSERT INTO email_config (escritorio_id, smtp_host, smtp_port, smtp_secure, smtp_user, smtp_password, from_name, from_email, nfse_email_texto, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(escritorio_id) DO UPDATE SET smtp_host=excluded.smtp_host, smtp_port=excluded.smtp_port, smtp_secure=excluded.smtp_secure,
         smtp_user=excluded.smtp_user, smtp_password=excluded.smtp_password, from_name=excluded.from_name, from_email=excluded.from_email,
         nfse_email_texto=excluded.nfse_email_texto, updated_at=datetime('now')`
    )
    .run(
      escritorioId,
      // Cada campo só é tocado quando vem de fato no corpo da requisição (!== undefined) — a aba
      // "Texto padrão para NFS-e" chama esse mesmo PUT mandando só nfseEmailTexto, então sem essa
      // checagem os campos de SMTP eram apagados (viravam null) toda vez que alguém salvava só o
      // texto padrão (bug real que já derrubou a configuração de e-mail em produção uma vez).
      isAdmin && b.smtpHost !== undefined ? String(b.smtpHost || "").trim() || null : atual.smtp_host || null,
      isAdmin && b.smtpPort !== undefined ? Number(b.smtpPort) || 587 : atual.smtp_port || 587,
      isAdmin && b.smtpSecure !== undefined ? (b.smtpSecure ? 1 : 0) : atual.smtp_secure || 0,
      isAdmin && b.smtpUser !== undefined ? String(b.smtpUser || "").trim() || null : atual.smtp_user || null,
      // Senha de app do Google vem formatada com espaços pra leitura ("abcd efgh ijkl mnop") — se
      // colada assim, o SMTP recusa (BadCredentials), já que a senha de verdade não tem espaço
      // nenhum. Remove todos os espaços aqui pra isso nunca mais quebrar o login por esse motivo.
      isAdmin && b.smtpPassword ? String(b.smtpPassword).replace(/\s+/g, "") : atual.smtp_password || null, // vazio/ausente = mantém a senha já salva
      isAdmin && b.fromName !== undefined ? b.fromName || null : atual.from_name || null,
      isAdmin && b.fromEmail !== undefined ? String(b.fromEmail || "").trim() || null : atual.from_email || null,
      b.nfseEmailTexto !== undefined ? String(b.nfseEmailTexto) : atual.nfse_email_texto || null
    );
  res.json({ ok: true });
});
app.post("/api/email/testar", blockCliente, requirePermissao("configuracoes", "postar"), async (req, res) => {
  if ((req as any).user.perfil !== "Administrador") return res.status(403).json({ error: "Configuração SMTP restrita ao Administrador." });
  const t = getTransporter((req as any).user.escritorioId);
  if (!t) return res.status(400).json({ error: "Preencha e salve host, usuário e senha primeiro." });
  try {
    await t.verify();
    res.json({ ok: true });
  } catch (e: any) {
    res.status(502).json({ error: e.message });
  }
});
app.post("/api/email/enviar", blockCliente, requirePermissao("configuracoes", "postar"), upload.array("anexos", 5), async (req, res) => {
  const user = (req as any).user;
  const { empresaId, assunto, corpo } = req.body || {};
  if (!empresaId || !assunto) return res.status(400).json({ error: "Selecione a empresa e informe o assunto." });
  if (!podeAcessarEmpresa(user, Number(empresaId))) return res.status(403).json({ error: "Sem acesso a esta empresa." });
  const contatos = sqlite
    .prepare(`SELECT email FROM empresa_contatos WHERE empresa_id = ? AND receber_emails = 1`)
    .all(Number(empresaId)) as any[];
  if (!contatos.length) return res.status(400).json({ error: "Esta empresa não tem contatos de e-mail cadastrados." });
  const anexos = ((req.files as Express.Multer.File[]) || []).map((f) => ({ filename: corrigirNomeArquivo(f.originalname), content: f.buffer }));
  try {
    await enviarEmail(user.escritorioId, { to: contatos.map((c) => c.email), subject: assunto, text: corpo || "", attachments: anexos });
    sqlite
      .prepare(`INSERT INTO emails_enviados (empresa_id, destinatarios, assunto, corpo, anexos_json, enviado_por, status) VALUES (?, ?, ?, ?, ?, ?, 'ok')`)
      .run(Number(empresaId), contatos.map((c) => c.email).join(", "), assunto, corpo || "", JSON.stringify(anexos.map((a) => a.filename)), user.id);
    res.json({ ok: true, enviadoPara: contatos.map((c) => c.email) });
  } catch (e: any) {
    sqlite
      .prepare(`INSERT INTO emails_enviados (empresa_id, destinatarios, assunto, corpo, enviado_por, status, erro) VALUES (?, ?, ?, ?, ?, 'erro', ?)`)
      .run(Number(empresaId), contatos.map((c) => c.email).join(", "), assunto, corpo || "", user.id, e.message);
    res.status(500).json({ error: e.message });
  }
});
app.get("/api/email/log", blockCliente, requirePermissao("configuracoes", "visualizar"), (req, res) => {
  const rows = sqlite
    .prepare(
      `SELECT e.*, emp.nome as empresaNome FROM emails_enviados e LEFT JOIN empresas emp ON emp.id = e.empresa_id
       WHERE emp.escritorio_id = ? ORDER BY e.id DESC LIMIT 100`
    )
    .all((req as any).user.escritorioId);
  res.json({ items: rows });
});

// ---------- WhatsApp Business Platform (Cloud API — Meta) ----------
function getWhatsappConfig(escritorioId: number): any {
  return sqlite.prepare(`SELECT * FROM whatsapp_config WHERE escritorio_id = ?`).get(escritorioId) || {};
}
app.get("/api/whatsapp/config", blockCliente, requirePermissao("configuracoes", "visualizar"), (req, res) => {
  const escritorioId = (req as any).user.escritorioId;
  let c = getWhatsappConfig(escritorioId);
  // Gera o verify token na primeira vez que a tela é aberta — precisa existir antes do usuário
  // colar a URL do webhook no Meta for Developers.
  if (!c.webhook_verify_token) {
    const token = crypto.randomBytes(20).toString("hex");
    sqlite
      .prepare(
        `INSERT INTO whatsapp_config (escritorio_id, webhook_verify_token, updated_at) VALUES (?, ?, datetime('now'))
         ON CONFLICT(escritorio_id) DO UPDATE SET webhook_verify_token = excluded.webhook_verify_token`
      )
      .run(escritorioId, token);
    c = getWhatsappConfig(escritorioId);
  }
  res.json({
    phoneNumberId: c.phone_number_id || "",
    businessAccountId: c.business_account_id || "",
    temAccessToken: !!c.access_token_cifrado,
    temAppSecret: !!c.app_secret_cifrado,
    numeroExibicao: c.numero_exibicao || "",
    templateDocumento: c.template_documento || "documento_disponivel",
    templateIdioma: c.template_idioma || "pt_BR",
    templateTextoNotificacao: c.template_texto_notificacao || "",
    ativo: !!c.ativo,
    updatedAt: c.updated_at || null,
    webhookUrl: `${req.protocol}://${req.get("host")}/api/whatsapp/webhook`,
    webhookVerifyToken: c.webhook_verify_token,
  });
});
app.put("/api/whatsapp/config", blockCliente, requirePermissao("configuracoes", "editar"), (req, res) => {
  const escritorioId = (req as any).user.escritorioId;
  const b = req.body || {};
  const atual = getWhatsappConfig(escritorioId);
  sqlite
    .prepare(
      `INSERT INTO whatsapp_config (escritorio_id, phone_number_id, business_account_id, access_token_cifrado, template_documento, template_idioma, template_texto_notificacao, ativo, app_secret_cifrado, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(escritorio_id) DO UPDATE SET phone_number_id=excluded.phone_number_id, business_account_id=excluded.business_account_id,
         access_token_cifrado=excluded.access_token_cifrado, template_documento=excluded.template_documento,
         template_idioma=excluded.template_idioma, template_texto_notificacao=excluded.template_texto_notificacao,
         ativo=excluded.ativo, app_secret_cifrado=excluded.app_secret_cifrado, updated_at=datetime('now')`
    )
    .run(
      escritorioId,
      b.phoneNumberId !== undefined ? (String(b.phoneNumberId).trim() || null) : atual.phone_number_id || null,
      b.businessAccountId !== undefined ? (String(b.businessAccountId).trim() || null) : atual.business_account_id || null,
      b.accessToken ? nfse.cifrarTexto(String(b.accessToken).trim()) : atual.access_token_cifrado || null,
      b.templateDocumento !== undefined ? (String(b.templateDocumento).trim() || "documento_disponivel") : atual.template_documento || "documento_disponivel",
      b.templateIdioma !== undefined ? (String(b.templateIdioma).trim() || "pt_BR") : atual.template_idioma || "pt_BR",
      b.templateTextoNotificacao !== undefined ? (String(b.templateTextoNotificacao).trim() || null) : atual.template_texto_notificacao || null,
      b.ativo !== undefined ? (b.ativo ? 1 : 0) : atual.ativo || 0,
      b.appSecret ? nfse.cifrarTexto(String(b.appSecret).trim()) : atual.app_secret_cifrado || null
    );
  res.json({ ok: true });
});
// ---- CRM: caixa de entrada de conversas do WhatsApp (cliente iniciando contato) ----
function crmSoDigitos(s: any): string {
  return String(s || "").replace(/\D/g, "");
}
function crmNormalizaTxt(s: string): string {
  return String(s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .trim();
}
function crmExtensaoPorMime(mime: string | null): string {
  const mapa: Record<string, string> = {
    "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/gif": ".gif",
    "audio/ogg": ".ogg", "audio/opus": ".ogg", "audio/mpeg": ".mp3", "audio/aac": ".aac", "audio/amr": ".amr",
    "video/mp4": ".mp4", "video/3gpp": ".3gp",
    "application/pdf": ".pdf",
  };
  return (mime && mapa[mime]) || "";
}
// Compara só os últimos 11 dígitos (DDD+número, sem o 55) pra achar uma empresa/contato conhecido
// por telefone — empresas.telefone/empresa_contatos.telefone são texto livre, sem máscara, então
// não dá pra confiar em bater a string inteira.
function crmAcharEmpresaPorTelefone(escritorioId: number, telefoneDigits: string): number | null {
  const sufixo = telefoneDigits.slice(-11);
  if (!sufixo) return null;
  const rows = sqlite
    .prepare(
      `SELECT id, telefone FROM empresas WHERE escritorio_id = ? AND telefone IS NOT NULL AND telefone != ''
       UNION ALL
       SELECT e.id, ec.telefone FROM empresa_contatos ec JOIN empresas e ON e.id = ec.empresa_id WHERE e.escritorio_id = ? AND ec.telefone IS NOT NULL AND ec.telefone != ''`
    )
    .all(escritorioId, escritorioId) as any[];
  for (const r of rows) {
    const digitos = crmSoDigitos(r.telefone);
    if (digitos && digitos.slice(-11) === sufixo) return r.id;
  }
  return null;
}
function crmObterOuCriarConversa(escritorioId: number, telefone: string, contatoNome: string | null): any {
  let conversa = sqlite.prepare(`SELECT * FROM crm_conversas WHERE escritorio_id = ? AND telefone = ?`).get(escritorioId, telefone) as any;
  if (!conversa) {
    const empresaId = crmAcharEmpresaPorTelefone(escritorioId, telefone);
    const info = sqlite
      .prepare(`INSERT INTO crm_conversas (escritorio_id, telefone, contato_nome, empresa_id, status) VALUES (?, ?, ?, ?, 'menu')`)
      .run(escritorioId, telefone, contatoNome, empresaId);
    conversa = sqlite.prepare(`SELECT * FROM crm_conversas WHERE id = ?`).get(Number(info.lastInsertRowid));
  } else if (contatoNome && !conversa.contato_nome) {
    sqlite.prepare(`UPDATE crm_conversas SET contato_nome = ? WHERE id = ?`).run(contatoNome, conversa.id);
  }
  return conversa;
}
function crmExtrairTextoMensagem(m: any): string | null {
  if (m.type === "text") return m.text?.body || null;
  if (m.type === "button") return m.button?.text || null;
  if (m.type === "interactive") return m.interactive?.button_reply?.title || m.interactive?.list_reply?.title || null;
  return m?.[m.type]?.caption || null;
}
// Round-robin do modo_distribuicao='rodizio': escolhe o próximo colaborador do departamento numa
// ordem estável (nome), cíclico a partir de quem recebeu a última conversa
// (crm_departamentos.rodizio_ultimo_user_id). Departamento sem colaborador nenhum devolve null —
// quem chama trata isso caindo no comportamento manual (fila sem dono), sem erro.
function crmProximoRodizio(departamentoId: number): number | null {
  const colaboradores = sqlite
    .prepare(`SELECT dc.user_id FROM crm_departamento_colaboradores dc JOIN app_users u ON u.id = dc.user_id WHERE dc.departamento_id = ? ORDER BY u.nome`)
    .all(departamentoId) as any[];
  if (!colaboradores.length) return null;
  const ids = colaboradores.map((c) => c.user_id);
  const dep = sqlite.prepare(`SELECT rodizio_ultimo_user_id FROM crm_departamentos WHERE id = ?`).get(departamentoId) as any;
  const idxAnterior = dep?.rodizio_ultimo_user_id ? ids.indexOf(dep.rodizio_ultimo_user_id) : -1;
  const proximo = ids[(idxAnterior + 1) % ids.length];
  sqlite.prepare(`UPDATE crm_departamentos SET rodizio_ultimo_user_id = ? WHERE id = ?`).run(proximo, departamentoId);
  return proximo;
}
function crmMontarMenu(departamentos: { nome: string }[]): string {
  const linhas = departamentos.map((d, i) => `${i + 1} - ${d.nome}`).join("\n");
  return `Olá! Em qual departamento você quer falar?\n${linhas}\n\nResponda só com o número da opção.`;
}
// Envia texto livre (não-template) e já grava a mensagem de saída — usado tanto pelo menu
// automático quanto pela resposta manual de um colaborador (POST /api/crm/conversas/:id/mensagens).
async function crmEnviarTextoLivre(cfg: any, paraNumero: string, texto: string, conversaId: number, autorUserId: number | null = null): Promise<void> {
  if (!cfg.ativo || !cfg.phone_number_id || !cfg.access_token_cifrado) throw new Error("WhatsApp não configurado ou desativado — configure em Configurações > WhatsApp.");
  const { wamid } = await whatsapp.enviarTextoLivre(cfg.phone_number_id, nfse.decifrarTexto(cfg.access_token_cifrado), paraNumero, texto);
  sqlite
    .prepare(`INSERT INTO crm_mensagens (conversa_id, direcao, wamid, tipo, texto, autor_user_id, status) VALUES (?, 'saida', ?, 'texto', ?, ?, 'accepted')`)
    .run(conversaId, wamid, texto, autorUserId);
  sqlite.prepare(`UPDATE crm_conversas SET ultima_mensagem_em = datetime('now') WHERE id = ?`).run(conversaId);
}
// A máquina de estados do menu de departamento. 'encerrada' reabre no MESMO departamento sem
// mostrar o menu de novo (só telefone nunca visto passa pelo menu); 'aberta' não mexe em nada, fica
// pro humano responder; só 'menu' de fato processa a escolha.
async function crmProcessarRoteamento(escritorioId: number, cfg: any, conversaId: number, telefone: string, textoRecebido: string | null): Promise<void> {
  const atual = sqlite.prepare(`SELECT * FROM crm_conversas WHERE id = ?`).get(conversaId) as any;
  if (!atual) return;
  if (atual.status === "encerrada") {
    sqlite.prepare(`UPDATE crm_conversas SET status = 'aberta' WHERE id = ?`).run(conversaId);
    return;
  }
  if (atual.status === "aberta") return;
  const departamentos = sqlite.prepare(`SELECT id, nome FROM crm_departamentos WHERE escritorio_id = ? AND ativo = 1 ORDER BY ordem`).all(escritorioId) as any[];
  if (!departamentos.length) return; // nenhum departamento cadastrado ainda — não tem como rotear
  const escolha = crmNormalizaTxt(textoRecebido || "");
  const numero = parseInt(escolha, 10);
  let escolhido: any = null;
  if (!isNaN(numero) && numero >= 1 && numero <= departamentos.length) escolhido = departamentos[numero - 1];
  else escolhido = departamentos.find((d) => crmNormalizaTxt(d.nome) === escolha);
  try {
    if (escolhido) {
      sqlite.prepare(`UPDATE crm_conversas SET departamento_id = ?, status = 'aberta' WHERE id = ?`).run(escolhido.id, conversaId);
      // Modo rodízio: já entra atribuída a alguém do departamento, sem esperar "atribuir a mim"
      // manual — departamento sem colaborador nenhum cai no comportamento de sempre (fila sem dono).
      if (crmObterConfig(escritorioId).modoDistribuicao === "rodizio") {
        const proximo = crmProximoRodizio(escolhido.id);
        if (proximo) sqlite.prepare(`UPDATE crm_conversas SET atribuido_user_id = ? WHERE id = ?`).run(proximo, conversaId);
      }
      await crmEnviarTextoLivre(cfg, telefone, `Você está falando com o setor ${escolhido.nome}. Já vamos te atender — aguarde um momento.`, conversaId);
    } else {
      await crmEnviarTextoLivre(cfg, telefone, crmMontarMenu(departamentos), conversaId);
    }
  } catch (e: any) {
    console.error(`[CRM] falha ao enviar o menu/confirmação (conversa ${conversaId}):`, e.message);
  }
}
async function crmProcessarMensagemRecebida(escritorioId: number, cfg: any, value: any, m: any): Promise<void> {
  const telefone = crmSoDigitos(m.from);
  if (!telefone) return;
  const contatoNome = value?.contacts?.[0]?.profile?.name || null;
  const conversa = crmObterOuCriarConversa(escritorioId, telefone, contatoNome);

  const tiposMidia = ["image", "document", "audio", "video", "sticker"];
  const ehMidia = tiposMidia.includes(m.type);
  const tipo = !ehMidia ? "texto" : m.type === "document" ? "documento" : m.type === "audio" ? "audio" : m.type === "video" ? "outro" : "imagem";
  let midiaPath: string | null = null, midiaMime: string | null = null, midiaNome: string | null = null;
  const midiaObj = ehMidia ? m[m.type] : null;
  if (midiaObj?.id && cfg.phone_number_id && cfg.access_token_cifrado) {
    try {
      const { buffer, mimeType } = await whatsapp.baixarMidiaRecebida(midiaObj.id, cfg.phone_number_id, nfse.decifrarTexto(cfg.access_token_cifrado));
      const dir = path.join(UPLOADS_DIR, "crm", String(conversa.id));
      fs.mkdirSync(dir, { recursive: true });
      midiaMime = mimeType || midiaObj.mime_type || null;
      const nomeArquivo: string = midiaObj.filename || `${m.type}-${Date.now()}${crmExtensaoPorMime(midiaMime)}`;
      midiaNome = nomeArquivo;
      midiaPath = path.join(dir, nomeArquivo);
      fs.writeFileSync(midiaPath, buffer);
    } catch (e: any) {
      console.error(`[CRM] falha ao baixar mídia recebida (conversa ${conversa.id}):`, e.message);
    }
  }
  const texto = crmExtrairTextoMensagem(m);
  sqlite
    .prepare(`INSERT INTO crm_mensagens (conversa_id, direcao, wamid, tipo, texto, midia_path, midia_mime, midia_nome) VALUES (?, 'entrada', ?, ?, ?, ?, ?, ?)`)
    .run(conversa.id, m.id || null, tipo, texto, midiaPath, midiaMime, midiaNome);
  sqlite.prepare(`UPDATE crm_conversas SET ultima_mensagem_cliente_em = datetime('now'), ultima_mensagem_em = datetime('now'), nao_lida = 1 WHERE id = ?`).run(conversa.id);

  await crmProcessarRoteamento(escritorioId, cfg, conversa.id, telefone, texto);
}
function conferirAssinaturaWebhookWhatsapp(rawBody: Buffer, headerAssinatura: string, appSecret: string): boolean {
  const esperado = "sha256=" + crypto.createHmac("sha256", appSecret).update(rawBody).digest("hex");
  const a = Buffer.from(esperado);
  const b = Buffer.from(headerAssinatura);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
// Webhook do WhatsApp — a Meta chama isso direto (sem sessão nossa), por isso fica de fora do
// requireAuth (ver exceção no início do arquivo). GET é a verificação inicial (challenge/response,
// feita uma vez ao salvar o webhook no Meta for Developers); POST é onde chegam os status reais de
// entrega/leitura/falha de cada mensagem — sem isso só sabíamos se a Meta ACEITOU o envio, nunca se
// entregou de verdade no celular do cliente.
app.get("/api/whatsapp/webhook", (req, res) => {
  const modo = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (modo !== "subscribe" || !token) return res.sendStatus(403);
  const bate = sqlite.prepare(`SELECT 1 FROM whatsapp_config WHERE webhook_verify_token = ?`).get(String(token));
  if (!bate) return res.sendStatus(403);
  res.status(200).send(String(challenge ?? ""));
});
app.post("/api/whatsapp/webhook", (req, res) => {
  res.sendStatus(200); // confirma rápido — a Meta reenvia (com backoff) se demorar ou não responder 200
  try {
    for (const entrada of req.body?.entry || []) {
      for (const mudanca of entrada.changes || []) {
        // Descobre de qual escritório é esse número ANTES de confiar em qualquer outro dado do
        // payload — usado tanto pra achar o app_secret certo (assinatura) quanto pro escritorio_id
        // de qualquer coisa nova que a gente gravar (mensagem recebida).
        const phoneNumberId = mudanca.value?.metadata?.phone_number_id;
        const cfg = phoneNumberId ? (sqlite.prepare(`SELECT * FROM whatsapp_config WHERE phone_number_id = ?`).get(phoneNumberId) as any) : null;
        if (cfg?.app_secret_cifrado) {
          const assinatura = req.headers["x-hub-signature-256"];
          const raw = (req as any).rawBody as Buffer | undefined;
          const valida = typeof assinatura === "string" && raw && conferirAssinaturaWebhookWhatsapp(raw, assinatura, nfse.decifrarTexto(cfg.app_secret_cifrado));
          if (!valida) {
            console.error("[WhatsApp webhook] assinatura inválida — payload descartado.");
            continue;
          }
        } else if (phoneNumberId) {
          console.warn(`[WhatsApp webhook] app_secret não configurado pro número ${phoneNumberId} — assinatura não conferida.`);
        }
        for (const s of mudanca.value?.statuses || []) {
          const erroTexto = Array.isArray(s.errors) && s.errors.length ? s.errors.map((e: any) => `${e.code}: ${e.title || e.message || ""}`).join(" | ") : null;
          sqlite
            .prepare(`UPDATE whatsapp_mensagens SET status = ?, erro_codigo = ?, erro_mensagem = ?, atualizado_em = datetime('now') WHERE wamid = ?`)
            .run(s.status || "desconhecido", s.errors?.[0]?.code != null ? String(s.errors[0].code) : null, erroTexto, s.id);
          if (s.status === "failed") {
            const msg = sqlite.prepare(`SELECT origem_tabela, origem_id FROM whatsapp_mensagens WHERE wamid = ?`).get(s.id) as any;
            // Só envio_documentos/nfse_emissoes têm coluna whatsapp_erro pra registrar a falha — o
            // aviso de chat (chat_dm_mensagens) não tem esse campo (a falha só fica no log/tabela
            // whatsapp_mensagens mesmo, já atualizada pelo UPDATE genérico logo acima).
            if (msg && (msg.origem_tabela === "envio_documentos" || msg.origem_tabela === "nfse_emissoes")) {
              sqlite.prepare(`UPDATE ${msg.origem_tabela} SET whatsapp_erro = ? WHERE id = ?`).run(erroTexto || "Falha na entrega — ver detalhes no webhook.", msg.origem_id);
            }
          }
        }
        // Mensagens recebidas de cliente (CRM) — cada uma processada de forma independente
        // (fire-and-forget: a resposta HTTP já foi mandada acima) pra uma falhar não travar as outras.
        if (cfg) {
          for (const m of mudanca.value?.messages || []) {
            crmProcessarMensagemRecebida(cfg.escritorio_id, cfg, mudanca.value, m).catch((e: any) =>
              console.error(`[CRM] falha ao processar mensagem recebida (${m.id || "?"}):`, e.message)
            );
          }
        }
      }
    }
  } catch (e: any) {
    console.error("[WhatsApp webhook] erro processando payload:", e.message);
  }
});

// ---- Rotas do CRM ----
// Regras de distribuição configuráveis (tela "Distribuição" em pageCrm) — 1 linha por escritório,
// criada sob demanda; devolve os defaults de sempre (fila manual + visibilidade por departamento)
// se o escritório nunca configurou.
function crmObterConfig(escritorioId: number): { modoDistribuicao: "manual" | "rodizio"; visibilidade: "tudo" | "departamento" | "somente_meu" } {
  const row = sqlite.prepare(`SELECT modo_distribuicao, visibilidade FROM crm_config WHERE escritorio_id = ?`).get(escritorioId) as any;
  return { modoDistribuicao: row?.modo_distribuicao || "manual", visibilidade: row?.visibilidade || "departamento" };
}
// Mesma convenção de empresasVisiveis: Administrador vê todos os departamentos do escritório;
// colaborador só os que está em crm_departamento_colaboradores — a não ser que a configuração de
// visibilidade esteja em "tudo", aí vale pra qualquer um com acesso ao CRM.
function crmDepartamentosVisiveis(user: any): number[] {
  const todos = (sqlite.prepare(`SELECT id FROM crm_departamentos WHERE escritorio_id = ?`).all(user.escritorioId) as any[]).map((r) => r.id);
  if (user.perfil === "Administrador") return todos;
  if (crmObterConfig(user.escritorioId).visibilidade === "tudo") return todos;
  const rows = sqlite
    .prepare(
      `SELECT dc.departamento_id FROM crm_departamento_colaboradores dc JOIN crm_departamentos d ON d.id = dc.departamento_id WHERE dc.user_id = ? AND d.escritorio_id = ?`
    )
    .all(user.id, user.escritorioId) as any[];
  return rows.map((r) => r.departamento_id);
}
function crmPodeAcessarConversa(user: any, conversaId: number): any {
  const c = sqlite.prepare(`SELECT * FROM crm_conversas WHERE id = ?`).get(conversaId) as any;
  if (!c || c.escritorio_id !== user.escritorioId) return null;
  if (user.perfil === "Administrador") return c;
  // "Só o que é meu": nem a fila de não atribuídas aparece (mesmo conceito do "só os seus" que a
  // tela de Distribuição explica) — só a conversa atribuída a este usuário mesmo.
  if (crmObterConfig(user.escritorioId).visibilidade === "somente_meu") return c.atribuido_user_id === user.id ? c : null;
  // Conversa ainda no menu (sem departamento definido) — qualquer colaborador com acesso ao CRM
  // pode ver enquanto aguarda o cliente escolher; depois de roteada, só quem é do departamento.
  if (c.departamento_id === null) return c;
  return crmDepartamentosVisiveis(user).includes(c.departamento_id) ? c : null;
}
app.get("/api/crm/departamentos", blockCliente, requirePermissao("crm", "visualizar"), (req, res) => {
  const user = (req as any).user;
  const rows = sqlite
    .prepare(
      `SELECT d.*, (SELECT COUNT(*) FROM crm_conversas c WHERE c.departamento_id = d.id AND c.status != 'encerrada') as conversasAbertas
       FROM crm_departamentos d WHERE d.escritorio_id = ? ORDER BY d.ordem`
    )
    .all(user.escritorioId) as any[];
  const visiveis = new Set(crmDepartamentosVisiveis(user));
  res.json({ items: rows.filter((d) => visiveis.has(d.id)).map((d) => ({ id: d.id, nome: d.nome, ordem: d.ordem, ativo: !!d.ativo, conversasAbertas: d.conversasAbertas })) });
});
app.post("/api/crm/departamentos", blockCliente, requirePermissao("crm", "postar"), (req, res) => {
  const user = (req as any).user;
  const nome = String(req.body?.nome || "").trim();
  if (!nome) return res.status(400).json({ error: "Informe o nome do departamento." });
  const maxOrdem = (sqlite.prepare(`SELECT COALESCE(MAX(ordem), 0) as m FROM crm_departamentos WHERE escritorio_id = ?`).get(user.escritorioId) as any).m;
  const info = sqlite.prepare(`INSERT INTO crm_departamentos (escritorio_id, nome, ordem) VALUES (?, ?, ?)`).run(user.escritorioId, nome, maxOrdem + 1);
  res.json({ id: Number(info.lastInsertRowid) });
});
app.put("/api/crm/departamentos/:id", blockCliente, requirePermissao("crm", "editar"), (req, res) => {
  const user = (req as any).user;
  const d = sqlite.prepare(`SELECT * FROM crm_departamentos WHERE id = ? AND escritorio_id = ?`).get(Number(req.params.id), user.escritorioId) as any;
  if (!d) return res.status(404).json({ error: "Departamento não encontrado." });
  const b = req.body || {};
  sqlite
    .prepare(`UPDATE crm_departamentos SET nome = ?, ordem = ?, ativo = ? WHERE id = ?`)
    .run(b.nome !== undefined ? String(b.nome).trim() || d.nome : d.nome, b.ordem !== undefined ? Number(b.ordem) : d.ordem, b.ativo !== undefined ? (b.ativo ? 1 : 0) : d.ativo, d.id);
  res.json({ ok: true });
});
app.delete("/api/crm/departamentos/:id", blockCliente, requirePermissao("crm", "editar"), (req, res) => {
  const user = (req as any).user;
  const d = sqlite.prepare(`SELECT * FROM crm_departamentos WHERE id = ? AND escritorio_id = ?`).get(Number(req.params.id), user.escritorioId) as any;
  if (!d) return res.status(404).json({ error: "Departamento não encontrado." });
  const temConversa = sqlite.prepare(`SELECT 1 FROM crm_conversas WHERE departamento_id = ? LIMIT 1`).get(d.id);
  if (temConversa) return res.status(409).json({ error: "Este departamento já tem conversas — inative em vez de excluir." });
  sqlite.prepare(`DELETE FROM crm_departamentos WHERE id = ?`).run(d.id);
  res.json({ ok: true });
});
app.get("/api/crm/departamentos/:id/colaboradores", blockCliente, requirePermissao("crm", "editar"), (req, res) => {
  const user = (req as any).user;
  const d = sqlite.prepare(`SELECT id FROM crm_departamentos WHERE id = ? AND escritorio_id = ?`).get(Number(req.params.id), user.escritorioId);
  if (!d) return res.status(404).json({ error: "Departamento não encontrado." });
  const rows = sqlite.prepare(`SELECT user_id FROM crm_departamento_colaboradores WHERE departamento_id = ?`).all(Number(req.params.id)) as any[];
  res.json({ userIds: rows.map((r) => r.user_id) });
});
app.put("/api/crm/departamentos/:id/colaboradores", blockCliente, requirePermissao("crm", "editar"), (req, res) => {
  const user = (req as any).user;
  const departamentoId = Number(req.params.id);
  const d = sqlite.prepare(`SELECT id FROM crm_departamentos WHERE id = ? AND escritorio_id = ?`).get(departamentoId, user.escritorioId);
  if (!d) return res.status(404).json({ error: "Departamento não encontrado." });
  const doEscritorio = new Set((sqlite.prepare(`SELECT id FROM app_users WHERE escritorio_id = ?`).all(user.escritorioId) as any[]).map((r) => r.id));
  const userIds: number[] = Array.isArray(req.body?.userIds) ? req.body.userIds.map(Number).filter((id: number) => doEscritorio.has(id)) : [];
  sqlite.prepare(`DELETE FROM crm_departamento_colaboradores WHERE departamento_id = ?`).run(departamentoId);
  const ins = sqlite.prepare(`INSERT INTO crm_departamento_colaboradores (user_id, departamento_id) VALUES (?, ?)`);
  for (const uid of userIds) ins.run(uid, departamentoId);
  res.json({ ok: true });
});
app.get("/api/crm/config", blockCliente, requirePermissao("crm", "visualizar"), (req, res) => {
  const user = (req as any).user;
  const cfg = crmObterConfig(user.escritorioId);
  res.json({ modoDistribuicao: cfg.modoDistribuicao, visibilidade: cfg.visibilidade });
});
app.put("/api/crm/config", blockCliente, requirePermissao("crm", "editar"), (req, res) => {
  const user = (req as any).user;
  const modoDistribuicao = req.body?.modoDistribuicao === "rodizio" ? "rodizio" : "manual";
  const visibilidade = ["tudo", "departamento", "somente_meu"].includes(req.body?.visibilidade) ? req.body.visibilidade : "departamento";
  sqlite
    .prepare(
      `INSERT INTO crm_config (escritorio_id, modo_distribuicao, visibilidade) VALUES (?, ?, ?)
       ON CONFLICT(escritorio_id) DO UPDATE SET modo_distribuicao = excluded.modo_distribuicao, visibilidade = excluded.visibilidade`
    )
    .run(user.escritorioId, modoDistribuicao, visibilidade);
  res.json({ ok: true });
});
// status: por padrão só 'menu'+'aberta' (conversas ativas); status=encerrada pra ver o histórico.
app.get("/api/crm/conversas", blockCliente, requirePermissao("crm", "visualizar"), (req, res) => {
  const user = (req as any).user;
  const visiveis = crmDepartamentosVisiveis(user);
  const departamentoId = req.query.departamentoId ? Number(req.query.departamentoId) : null;
  const status = String(req.query.status || "ativas");
  if (departamentoId && !visiveis.includes(departamentoId)) return res.json({ items: [] });
  // "Só o que é meu": some tanto a fila de não atribuídas quanto as dos colegas, mesmo dentro dos
  // departamentos visíveis — Administrador nunca entra aqui (crmObterConfig só se aplica a ele
  // indiretamente via crmDepartamentosVisiveis, mas o filtro por dono fica só pra não-admin).
  const soMeu = user.perfil !== "Administrador" && crmObterConfig(user.escritorioId).visibilidade === "somente_meu";
  const condStatus = status === "encerrada" ? `c.status = 'encerrada'` : `c.status != 'encerrada'`;
  const condDepto = departamentoId
    ? `c.departamento_id = ${departamentoId}`
    : visiveis.length
      ? `(c.departamento_id IS NULL OR c.departamento_id IN (${visiveis.join(",")}))`
      : `c.departamento_id IS NULL`;
  const condDono = soMeu ? `AND c.atribuido_user_id = ${Number(user.id)}` : "";
  const rows = sqlite
    .prepare(
      `SELECT c.id, c.telefone, c.contato_nome as contatoNome, c.empresa_id as empresaId, e.nome as empresaNome,
              c.departamento_id as departamentoId, d.nome as departamentoNome, c.atribuido_user_id as atribuidoUserId, u.nome as atribuidoNome,
              c.status, c.nao_lida as naoLida, c.ultima_mensagem_em as ultimaMensagemEm,
              (SELECT texto FROM crm_mensagens m WHERE m.conversa_id = c.id ORDER BY m.id DESC LIMIT 1) as ultimaMensagemTexto
       FROM crm_conversas c
       LEFT JOIN empresas e ON e.id = c.empresa_id
       LEFT JOIN crm_departamentos d ON d.id = c.departamento_id
       LEFT JOIN app_users u ON u.id = c.atribuido_user_id
       WHERE c.escritorio_id = ? AND ${condStatus} AND ${condDepto} ${condDono}
       ORDER BY c.ultima_mensagem_em DESC`
    )
    .all(user.escritorioId);
  res.json({ items: rows });
});
app.get("/api/crm/conversas/:id/mensagens", blockCliente, requirePermissao("crm", "visualizar"), (req, res) => {
  const user = (req as any).user;
  const conversa = crmPodeAcessarConversa(user, Number(req.params.id));
  if (!conversa) return res.status(404).json({ error: "Conversa não encontrada." });
  sqlite.prepare(`UPDATE crm_conversas SET nao_lida = 0 WHERE id = ?`).run(conversa.id);
  const rows = sqlite
    .prepare(
      `SELECT m.id, m.direcao, m.tipo, m.texto, m.midia_mime as midiaMime, m.midia_nome as midiaNome, (m.midia_path IS NOT NULL) as temMidia,
              m.autor_user_id as autorUserId, u.nome as autorNome, m.criado_em as criadoEm, m.status
       FROM crm_mensagens m LEFT JOIN app_users u ON u.id = m.autor_user_id
       WHERE m.conversa_id = ? ORDER BY m.id ASC LIMIT 500`
    )
    .all(conversa.id);
  res.json({
    conversa: {
      id: conversa.id, telefone: conversa.telefone, contatoNome: conversa.contato_nome, empresaId: conversa.empresa_id,
      departamentoId: conversa.departamento_id, atribuidoUserId: conversa.atribuido_user_id, status: conversa.status,
      ultimaMensagemClienteEm: conversa.ultima_mensagem_cliente_em,
    },
    items: rows,
  });
});
app.get("/api/crm/conversas/:id/mensagens/:msgId/midia", blockCliente, requirePermissao("crm", "visualizar"), (req, res) => {
  const user = (req as any).user;
  const conversa = crmPodeAcessarConversa(user, Number(req.params.id));
  if (!conversa) return res.status(404).json({ error: "Conversa não encontrada." });
  const msg = sqlite.prepare(`SELECT * FROM crm_mensagens WHERE id = ? AND conversa_id = ?`).get(Number(req.params.msgId), conversa.id) as any;
  if (!msg?.midia_path || !fs.existsSync(msg.midia_path)) return res.status(404).json({ error: "Arquivo não encontrado." });
  res.download(msg.midia_path, msg.midia_nome || "arquivo");
});
// Só texto livre por ora (envio de mídia pelo agente fica pra depois) — confere a janela de 24h
// antes de tentar mandar, pra dar um erro claro em vez do genérico que a Meta devolveria.
app.post("/api/crm/conversas/:id/mensagens", blockCliente, requirePermissao("crm", "postar"), async (req, res) => {
  const user = (req as any).user;
  const conversa = crmPodeAcessarConversa(user, Number(req.params.id));
  if (!conversa) return res.status(404).json({ error: "Conversa não encontrada." });
  const texto = String(req.body?.texto || "").trim();
  if (!texto) return res.status(400).json({ error: "Digite uma mensagem." });
  if (!conversa.ultima_mensagem_cliente_em || Date.now() - new Date(conversa.ultima_mensagem_cliente_em.replace(" ", "T") + "Z").getTime() > 24 * 60 * 60 * 1000) {
    return res.status(400).json({ error: "Já se passaram mais de 24h desde a última mensagem do cliente — o WhatsApp só permite reabrir com um template aprovado, não com texto livre." });
  }
  const cfg = getWhatsappConfig(user.escritorioId);
  try {
    await crmEnviarTextoLivre(cfg, conversa.telefone, texto, conversa.id, user.id);
    res.json({ ok: true });
  } catch (e: any) {
    res.status(502).json({ error: e.message });
  }
});
app.post("/api/crm/conversas/:id/atribuir", blockCliente, requirePermissao("crm", "postar"), (req, res) => {
  const user = (req as any).user;
  const conversa = crmPodeAcessarConversa(user, Number(req.params.id));
  if (!conversa) return res.status(404).json({ error: "Conversa não encontrada." });
  if (!conversa.departamento_id) return res.status(400).json({ error: "Essa conversa ainda não tem departamento definido." });
  // WHERE atribuido_user_id IS NULL: garante o "primeiro que clicar assume" de verdade — sem isso,
  // dois atendentes clicando quase juntos faziam o segundo roubar a conversa do primeiro em
  // silêncio (last-write-wins, sem erro nenhum). 0 linhas alteradas = alguém já pegou antes.
  const resultado = sqlite.prepare(`UPDATE crm_conversas SET atribuido_user_id = ? WHERE id = ? AND atribuido_user_id IS NULL`).run(user.id, conversa.id);
  if (resultado.changes === 0) {
    const atual = sqlite.prepare(`SELECT u.nome FROM crm_conversas c LEFT JOIN app_users u ON u.id = c.atribuido_user_id WHERE c.id = ?`).get(conversa.id) as any;
    return res.status(409).json({ error: atual?.nome ? `Essa conversa já foi atribuída a ${atual.nome}.` : "Essa conversa já foi atribuída a outra pessoa." });
  }
  res.json({ ok: true });
});
app.post("/api/crm/conversas/:id/transferir", blockCliente, requirePermissao("crm", "postar"), (req, res) => {
  const user = (req as any).user;
  const conversa = crmPodeAcessarConversa(user, Number(req.params.id));
  if (!conversa) return res.status(404).json({ error: "Conversa não encontrada." });
  const paraDepartamentoId = Number(req.body?.departamentoId);
  const destino = sqlite.prepare(`SELECT id FROM crm_departamentos WHERE id = ? AND escritorio_id = ?`).get(paraDepartamentoId, user.escritorioId);
  if (!destino) return res.status(400).json({ error: "Departamento de destino inválido." });
  const motivo = String(req.body?.motivo || "").trim() || null;
  sqlite
    .prepare(`INSERT INTO crm_transferencias (conversa_id, de_departamento_id, para_departamento_id, user_id, motivo) VALUES (?, ?, ?, ?, ?)`)
    .run(conversa.id, conversa.departamento_id, paraDepartamentoId, user.id, motivo);
  sqlite.prepare(`UPDATE crm_conversas SET departamento_id = ?, atribuido_user_id = NULL, status = 'aberta' WHERE id = ?`).run(paraDepartamentoId, conversa.id);
  // Modo rodízio: a conversa transferida já sai atribuída a alguém do departamento novo, em vez de
  // cair na fila sem dono — mesma regra de crmProcessarRoteamento na entrada.
  if (crmObterConfig(user.escritorioId).modoDistribuicao === "rodizio") {
    const proximo = crmProximoRodizio(paraDepartamentoId);
    if (proximo) sqlite.prepare(`UPDATE crm_conversas SET atribuido_user_id = ? WHERE id = ?`).run(proximo, conversa.id);
  }
  res.json({ ok: true });
});
app.post("/api/crm/conversas/:id/encerrar", blockCliente, requirePermissao("crm", "postar"), (req, res) => {
  const user = (req as any).user;
  const conversa = crmPodeAcessarConversa(user, Number(req.params.id));
  if (!conversa) return res.status(404).json({ error: "Conversa não encontrada." });
  sqlite.prepare(`UPDATE crm_conversas SET status = 'encerrada' WHERE id = ?`).run(conversa.id);
  res.json({ ok: true });
});

// Um documento pode ter ido pra mais de um contato (ex.: dois telefones do escritório) — cada envio
// tem sua própria linha em whatsapp_mensagens. Aqui agrega isso num status único pra exibir na tela:
// "lido" assim que QUALQUER contato já leu, "falhou" se qualquer um falhou (precisa de atenção),
// "entregue" assim que qualquer um recebeu. Testado ao vivo: exigir que TODOS tenham lido nunca
// mostrava "lido" quando um dos contatos tinha "confirmação de leitura" desativada no WhatsApp
// (configuração de privacidade do próprio destinatário — nesse caso a Meta nunca avisa "read" pra
// aquele número, mesmo a pessoa lendo de verdade), então a regra ficou "qualquer um" em vez de "todos".
function agregarStatusWhatsapp(mensagens: { status: string; atualizado_em: string }[]): { status: "falhou" | "lido" | "entregue" | "enviado"; em: string | null } {
  const falhas = mensagens.filter((m) => m.status === "failed");
  if (falhas.length) {
    const maisRecente = falhas.reduce((max, m) => (m.atualizado_em > max.atualizado_em ? m : max));
    return { status: "falhou", em: maisRecente.atualizado_em };
  }
  const lidas = mensagens.filter((m) => m.status === "read");
  if (lidas.length) {
    const maisRecente = lidas.reduce((max, m) => (m.atualizado_em > max.atualizado_em ? m : max));
    return { status: "lido", em: maisRecente.atualizado_em };
  }
  if (mensagens.some((m) => m.status === "delivered" || m.status === "read")) {
    return { status: "entregue", em: null };
  }
  return { status: "enviado", em: null };
}
// Busca e agrega o status de WhatsApp de vários documentos de uma vez (evita 1 query por linha numa
// lista) — devolve um Map de origem_id pro status agregado.
function statusWhatsappPorOrigem(origemTabela: "envio_documentos" | "nfse_emissoes", origemIds: number[]): Map<number, { status: string; em: string | null }> {
  const resultado = new Map<number, { status: string; em: string | null }>();
  if (!origemIds.length) return resultado;
  const msgs = sqlite
    .prepare(
      `SELECT origem_id, status, atualizado_em FROM whatsapp_mensagens WHERE origem_tabela = ? AND origem_id IN (${origemIds.map(() => "?").join(",")})`
    )
    .all(origemTabela, ...origemIds) as any[];
  const porOrigem = new Map<number, { status: string; atualizado_em: string }[]>();
  for (const m of msgs) {
    if (!porOrigem.has(m.origem_id)) porOrigem.set(m.origem_id, []);
    porOrigem.get(m.origem_id)!.push(m);
  }
  for (const [origemId, lista] of porOrigem) resultado.set(origemId, agregarStatusWhatsapp(lista));
  return resultado;
}
app.post("/api/whatsapp/testar", blockCliente, requirePermissao("configuracoes", "postar"), async (req, res) => {
  const c = getWhatsappConfig((req as any).user.escritorioId);
  if (!c.phone_number_id || !c.access_token_cifrado) return res.status(400).json({ error: "Preencha e salve o Phone Number ID e o Access Token primeiro." });
  try {
    const { numeroExibicao } = await whatsapp.testarConexao(c.phone_number_id, nfse.decifrarTexto(c.access_token_cifrado));
    if (numeroExibicao) {
      sqlite.prepare(`UPDATE whatsapp_config SET numero_exibicao = ? WHERE escritorio_id = ?`).run(numeroExibicao, (req as any).user.escritorioId);
    }
    res.json({ ok: true, numeroExibicao });
  } catch (e: any) {
    res.status(502).json({ error: e.message });
  }
});
// Envia um documento já salvo em disco (PDF de Envio de Documentos, NFS-e, etc.) por WhatsApp pra
// um número específico — usado tanto pelo botão manual quanto pela rotina automática de NFS-e.
async function whatsappEnviarArquivo(
  escritorioId: number,
  paraNumero: string,
  variaveisCorpo: { nome: string; valor: string }[],
  arquivo: { nome: string; tipo: string; buffer: Buffer },
  origem: { tabela: "envio_documentos" | "nfse_emissoes"; id: number }
): Promise<void> {
  const c = getWhatsappConfig(escritorioId);
  if (!c.ativo || !c.phone_number_id || !c.access_token_cifrado) {
    throw new Error("WhatsApp não configurado ou desativado — configure em Configurações > WhatsApp.");
  }
  const { wamid, numeroNormalizado } = await whatsapp.enviarDocumento({
    phoneNumberId: c.phone_number_id,
    accessToken: nfse.decifrarTexto(c.access_token_cifrado),
    templateName: c.template_documento || "documento_disponivel",
    templateIdioma: c.template_idioma || "pt_BR",
    paraNumero,
    variaveisCorpo,
    arquivo,
  });
  // Guarda o wamid pra casar com o status real de entrega que chegar depois pelo webhook — sem
  // isso, "enviado com sucesso" só significa que a Meta aceitou, não que chegou no celular.
  if (wamid) {
    sqlite
      .prepare(`INSERT OR IGNORE INTO whatsapp_mensagens (escritorio_id, wamid, origem_tabela, origem_id, telefone) VALUES (?, ?, ?, ?, ?)`)
      .run(escritorioId, wamid, origem.tabela, origem.id, numeroNormalizado);
  }
}
// Aviso de "você tem uma mensagem nova" (chat interno, DM não lida com o destinatário offline) —
// mesmo mecanismo do whatsappEnviarArquivo acima, mas sem documento nenhum, com o template
// separado template_texto_notificacao (precisa existir e estar aprovado na Meta; vazio = desligado
// de propósito, quem chama trata o erro como best-effort e não deixa nada quebrar por causa disso).
async function whatsappEnviarTexto(
  escritorioId: number,
  paraNumero: string,
  variaveisCorpo: { nome: string; valor: string }[],
  origem: { tabela: "chat_dm_mensagens"; id: number }
): Promise<void> {
  const c = getWhatsappConfig(escritorioId);
  if (!c.ativo || !c.phone_number_id || !c.access_token_cifrado) {
    throw new Error("WhatsApp não configurado ou desativado — configure em Configurações > WhatsApp.");
  }
  if (!c.template_texto_notificacao) {
    throw new Error("Modelo de aviso de mensagem não configurado — cadastre em Configurações > WhatsApp.");
  }
  const { wamid, numeroNormalizado } = await whatsapp.enviarTexto({
    phoneNumberId: c.phone_number_id,
    accessToken: nfse.decifrarTexto(c.access_token_cifrado),
    templateName: c.template_texto_notificacao,
    templateIdioma: c.template_idioma || "pt_BR",
    paraNumero,
    variaveisCorpo,
  });
  if (wamid) {
    sqlite
      .prepare(`INSERT OR IGNORE INTO whatsapp_mensagens (escritorio_id, wamid, origem_tabela, origem_id, telefone) VALUES (?, ?, ?, ?, ?)`)
      .run(escritorioId, wamid, origem.tabela, origem.id, numeroNormalizado);
  }
}

// Identificação automática do cliente a partir de um arquivo (PDF, OFX ou XML): extrai texto,
// procura CNPJ/CPF e confere com o que está cadastrado em cada empresa. É só uma sugestão — quem
// confirma e manda o e-mail continua sendo o administrador, na tela.
async function extrairTextoArquivo(file: Express.Multer.File): Promise<string> {
  const ext = path.extname(file.originalname).toLowerCase();
  if (ext === ".pdf" || file.mimetype === "application/pdf") {
    const pdfParse = require("pdf-parse");
    // pdf-parse trata "instanceof Buffer" como um caso especial e acaba lendo o ArrayBuffer
    // inteiro por baixo (ignorando byteOffset/length) — como o buffer do multer normalmente é uma
    // "view" dentro do pool interno de Buffers do Node, isso lê lixo do pool e quebra a leitura
    // do xref. Um Uint8Array "puro" (não Buffer) evita esse caminho com bug.
    const data = await pdfParse(new Uint8Array(file.buffer));
    return data.text || "";
  }
  // OFX, XML, TXT e a maioria dos extratos exportados são texto puro — dá pra ler direto.
  return file.buffer.toString("utf8");
}
function extrairDocumentos(texto: string): { documento: string; tipo: "cnpj" | "cpf" }[] {
  const encontrados: { documento: string; tipo: "cnpj" | "cpf" }[] = [];
  const vistos = new Set<string>();
  const reCnpj = /\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}/g;
  let sobra = texto;
  for (const m of texto.matchAll(reCnpj)) {
    const digitos = m[0].replace(/\D/g, "");
    if (digitos.length === 14 && !vistos.has(digitos)) {
      vistos.add(digitos);
      encontrados.push({ documento: digitos, tipo: "cnpj" });
    }
    sobra = sobra.replace(m[0], " "); // remove pra não gerar falso-positivo de CPF dentro do CNPJ
  }
  const reCpf = /\d{3}\.?\d{3}\.?\d{3}-?\d{2}/g;
  for (const m of sobra.matchAll(reCpf)) {
    const digitos = m[0].replace(/\D/g, "");
    if (digitos.length === 11 && !vistos.has(digitos)) {
      vistos.add(digitos);
      encontrados.push({ documento: digitos, tipo: "cpf" });
    }
  }
  return encontrados;
}
// Procura a data de vencimento no texto de uma guia (DARF, FGTS etc.) — só perto da palavra
// "vencimento" mesmo. Achado ao vivo: o fallback antigo ("senão, primeira data dd/mm/aaaa do
// documento inteiro") pegava qualquer data que aparecesse primeiro no arquivo — num relatório sem
// vencimento de verdade (ex.: Relatório de Retenções, que só tem "Período: dd/mm/aaaa até
// dd/mm/aaaa" no cabeçalho), isso marcava o início do período como se fosse vencimento. Documento
// sem a palavra "vencimento" por perto agora fica genuinamente "não identificado" — o front cai pro
// rótulo de competência nesse caso (ver competenciaFallbackLabel em app.html).
function extrairVencimento(texto: string): string | null {
  const brParaIso = (d: string) => {
    const [dd, mm, yyyy] = d.split("/");
    return `${yyyy}-${mm}-${dd}`;
  };
  const pertoDaPalavra = texto.match(/venc[a-zçã.]*[^0-9]{0,25}(\d{2}\/\d{2}\/\d{4})/i);
  return pertoDaPalavra ? brParaIso(pertoDaPalavra[1]) : null;
}
app.post("/api/email/identificar", blockCliente, requirePermissao("configuracoes", "visualizar"), upload.single("arquivo"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Envie um arquivo." });
  req.file.originalname = corrigirNomeArquivo(req.file.originalname);
  let texto = "";
  try {
    texto = await extrairTextoArquivo(req.file);
  } catch (e: any) {
    return res.status(400).json({ error: "Não consegui ler o conteúdo do arquivo: " + e.message });
  }
  const documentos = extrairDocumentos(texto);
  if (!documentos.length) return res.json({ documentosEncontrados: [], matches: [] });
  const placeholders = documentos.map(() => "?").join(",");
  const matches = sqlite
    .prepare(
      `SELECT ed.documento, ed.tipo, e.id as empresaId, e.nome as empresaNome
       FROM empresa_documentos ed JOIN empresas e ON e.id = ed.empresa_id WHERE ed.documento IN (${placeholders}) AND e.ativo = 1`
    )
    .all(...documentos.map((d) => d.documento));
  res.json({ documentosEncontrados: documentos, matches });
});

// ---------- API do agente do Domínio Web (autenticada por token — ver src/dominio-agent.ts) ----------
const DOMINIO_AGENT_TOKEN = process.env.DOMINIO_AGENT_TOKEN || "";
function requireDominioAgent(req: express.Request, res: express.Response, next: express.NextFunction) {
  const token = req.headers["x-agent-token"];
  if (!DOMINIO_AGENT_TOKEN || token !== DOMINIO_AGENT_TOKEN) return res.status(401).json({ error: "Token de agente inválido." });
  next();
}
app.post("/api/dominio-agent/heartbeat", requireDominioAgent, (req, res) => {
  const version = typeof req.body?.version === "string" ? req.body.version : null;
  sqlite
    .prepare(
      `INSERT INTO agent_heartbeat (escritorio_id, last_seen_at, version) VALUES (1, datetime('now'), ?)
       ON CONFLICT(escritorio_id) DO UPDATE SET last_seen_at = datetime('now'), version = excluded.version`
    )
    .run(version);
  res.json({ ok: true });
});
app.post("/api/dominio-agent/empresas", requireDominioAgent, (req, res) => {
  const items = Array.isArray(req.body?.items) ? req.body.items : [];
  let novas = 0, atualizadas = 0;
  const getByCodigo = sqlite.prepare(`SELECT id FROM empresas WHERE codigo_dominio = ?`);
  const insert = sqlite.prepare(
    `INSERT INTO empresas (nome, cnpj, codigo_dominio, email, telefone, endereco, cidade, uf, cep, inscricao_municipal, inscricao_estadual, nome_representante_legal, cpf_representante_legal, ativo, origem)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'dominio')`
  );
  const update = sqlite.prepare(
    `UPDATE empresas SET nome=?, cnpj=COALESCE(?, cnpj), email=COALESCE(?, email), telefone=COALESCE(?, telefone),
       endereco=COALESCE(?, endereco), cidade=COALESCE(?, cidade), uf=COALESCE(?, uf), cep=COALESCE(?, cep),
       inscricao_municipal=COALESCE(?, inscricao_municipal), inscricao_estadual=COALESCE(?, inscricao_estadual),
       nome_representante_legal=COALESCE(?, nome_representante_legal), cpf_representante_legal=COALESCE(?, cpf_representante_legal),
       ativo=COALESCE(?, ativo), updated_at=datetime('now') WHERE id=?`
  );
  for (const it of items) {
    if (!it?.codigo || !it?.nome) continue;
    const existente = getByCodigo.get(String(it.codigo)) as any;
    if (existente) {
      // ativo só é alterado se o item trouxer o campo explicitamente — a sincronização via Onvio
      // não sabe a situação real (isso vem só do relatório do Domínio, feito à parte), então não
      // deve reativar/desativar sozinha uma empresa já cadastrada.
      update.run(
        it.nome,
        it.cnpj || null,
        it.email || null,
        it.telefone || null,
        it.endereco || null,
        it.cidade || null,
        it.uf || null,
        it.cep || null,
        it.inscricaoMunicipal || null,
        it.inscricaoEstadual || null,
        it.nomeRepresentanteLegal || null,
        it.cpfRepresentanteLegal || null,
        it.ativo === undefined ? null : it.ativo ? 1 : 0,
        existente.id
      );
      atualizadas++;
    } else {
      insert.run(
        it.nome,
        it.cnpj || null,
        String(it.codigo),
        it.email || null,
        it.telefone || null,
        it.endereco || null,
        it.cidade || null,
        it.uf || null,
        it.cep || null,
        it.inscricaoMunicipal || null,
        it.inscricaoEstadual || null,
        it.nomeRepresentanteLegal || null,
        it.cpfRepresentanteLegal || null,
        it.ativo === false ? 0 : 1
      );
      novas++;
    }
  }
  sqlite.prepare(`INSERT INTO dominio_sync_log (origem, empresas_novas, empresas_atualizadas, status) VALUES ('agente', ?, ?, 'ok')`).run(novas, atualizadas);
  res.json({ ok: true, novas, atualizadas });
});
// Config completa (com senha/token em texto puro) — só o agente autenticado por token acessa isso.
// requireDominioAgent ainda usa um token único/global (DOMINIO_AGENT_TOKEN do .env), então por ora
// só existe o agente do escritório 1 — quando um segundo escritório tiver o próprio agente rodando,
// isso precisa resolver o escritório pelo token de cada um (escritorios.agent_token já existe pra
// isso), não mais um escritório fixo aqui.
app.get("/api/dominio-agent/config", requireDominioAgent, (_req, res) => {
  const c = getDominioConfig(1);
  res.json({
    source: c.source || "",
    dbDriver: c.db_driver || "",
    dbHost: c.db_host || "",
    dbPort: c.db_port || null,
    dbName: c.db_name || "",
    dbUser: c.db_user || "",
    dbPassword: c.db_password || "",
    dbConnectString: c.db_connect_string || "",
    queryClientes: c.query_clientes || "",
    colCodigo: c.col_codigo || "CODIGO",
    colNome: c.col_nome || "NOME",
    colCnpj: c.col_cnpj || "CNPJ",
    colStatus: c.col_status || "STATUS",
    apiUrl: c.api_url || "",
    apiToken: c.api_token || "",
    xmlExportAtivo: !!c.xml_export_ativo,
    xmlExportDir: c.xml_export_dir || "",
  });
});
// Documentos fiscais buscados (NF-e/NFC-e/NFS-e) que o agente ainda não exportou pra pasta local —
// cursor simples por id (o agente guarda localmente o maior id já recebido e manda de volta aqui).
// Mesma limitação de escopo das demais rotas desta seção: escritório 1 fixo, até existir um segundo
// agente real (ver comentário em requireDominioAgent acima).
app.get("/api/dominio-agent/documentos-novos", requireDominioAgent, (req, res) => {
  const desdeId = Number(req.query.desdeId) || 0;
  const limite = Math.min(Number(req.query.limite) || 200, 500);
  const rows = sqlite
    .prepare(
      `SELECT d.id, e.nome as empresaNome, e.codigo_dominio as empresaCodigo, e.apelido as empresaApelido, d.tipo, d.chave_acesso as chaveAcesso, d.data_emissao as dataEmissao, d.xml
       FROM nfe_documentos d JOIN empresas e ON e.id = d.empresa_id
       WHERE d.escritorio_id = 1 AND d.id > ? ORDER BY d.id ASC LIMIT ?`
    )
    .all(desdeId, limite);
  res.json({ items: rows });
});
app.get("/api/dominio-agent/work", requireDominioAgent, (_req, res) => {
  const testJobs = sqlite.prepare(`SELECT id FROM dominio_test_jobs WHERE status = 'pending' ORDER BY id ASC LIMIT 5`).all();
  const syncJobs = sqlite.prepare(`SELECT id FROM dominio_sync_jobs WHERE status = 'pending' ORDER BY id ASC LIMIT 5`).all();
  res.json({ testJobs, syncJobs });
});
app.post("/api/dominio-agent/teste-resultado", requireDominioAgent, (req, res) => {
  const { jobId, ok, resultado, erro } = req.body || {};
  const job = sqlite.prepare(`SELECT * FROM dominio_test_jobs WHERE id = ?`).get(Number(jobId)) as any;
  if (!job) return res.status(404).json({ error: "not found" });
  sqlite
    .prepare(`UPDATE dominio_test_jobs SET status=?, resultado_json=?, erro=?, resolvido_em=datetime('now') WHERE id=?`)
    .run(ok ? "ok" : "erro", resultado ? JSON.stringify(resultado) : null, erro || null, job.id);
  res.json({ ok: true });
});
app.post("/api/dominio-agent/sincronizar-resultado", requireDominioAgent, (req, res) => {
  const { jobId, ok, novas, atualizadas, erro } = req.body || {};
  const job = sqlite.prepare(`SELECT * FROM dominio_sync_jobs WHERE id = ?`).get(Number(jobId)) as any;
  if (!job) return res.status(404).json({ error: "not found" });
  sqlite
    .prepare(`UPDATE dominio_sync_jobs SET status=?, novas=?, atualizadas=?, erro=?, resolvido_em=datetime('now') WHERE id=?`)
    .run(ok ? "ok" : "erro", novas ?? null, atualizadas ?? null, erro || null, job.id);
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`Simples Contábeis no ar na porta ${PORT}`);
  console.log(`Banco do site: ${path.join(DATA_DIR, "simplescontabeis.db")}`);
  console.log(emailConfigurado(1) ? "E-mail corporativo configurado (escritório 1)." : "AVISO: e-mail corporativo não configurado (Configurações > E-mail corporativo).");
  console.log(DOMINIO_AGENT_TOKEN ? "Token do agente do Domínio Web configurado." : "AVISO: DOMINIO_AGENT_TOKEN não definido — o agente do Domínio Web não vai conseguir se conectar.");
});

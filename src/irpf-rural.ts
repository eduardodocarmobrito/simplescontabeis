// Módulo "IRPF · Atividade Rural": caixa de entrada de documentos do produtor rural que vira livro
// caixa, demonstrativo pra ficha Atividade Rural do IRPF e arquivo do LCDPR pro e-CAC.
//
// O fluxo inteiro, de ponta a ponta:
//   1. O documento entra (upload do escritório, portal do cliente, e-mail ou WhatsApp) e é guardado
//      cru, com hash, pra nunca se perder nem duplicar.
//   2. Uma fila processa um documento por vez: lê (XML / OFX / texto do PDF / OCR) e classifica
//      (regra determinística primeiro, IA no que sobra — ver irpf-rural-classificador.ts).
//   3. A classificação vira um lançamento em PRÉVIA, nunca definitivo.
//   4. O contador confere, corrige e aprova. Cada correção vira regra aprendida pro mesmo
//      fornecedor não errar de novo.
//   5. Fechado o ano: demonstrativo pra digitar no IRPF + arquivo do LCDPR pro e-CAC.
//
// Por que a fila é sequencial: o OCR sobe um Chromium por documento (ver ocr.ts). Processar vários
// em paralelo derrubaria o container em um upload de pasta inteira. Um de cada vez é lento mas não
// cai, e o front acompanha por polling.

import type express from "express";
import multer from "multer";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import JSZip from "jszip";
import { parseOfx } from "./ofx";
import {
  classificarNfe,
  classificarPorRegra,
  classificarComIa,
  lerXmlNfe,
  iaDisponivel,
  CONFIANCA_MINIMA,
  type ClassificacaoDocumento,
} from "./irpf-rural-classificador";
import { gerarLcdpr, validarLcdpr, type LcdprParams, type LcdprLancamento, type NaturezaLancamento } from "./lcdpr";

type Deps = {
  sqlite: any;
  blockCliente: express.RequestHandler;
  requirePermissao: (modulo: any, acao: "visualizar" | "postar" | "editar") => express.RequestHandler;
  podeAcessarEmpresa: (user: any, empresaId: number) => boolean;
  uploadsDir: string;
  // Já existe em server.ts e cai pro OCR sozinho quando o PDF não tem camada de texto.
  obterTextoDoPdf: (buf: Buffer) => Promise<string>;
  corrigirNomeArquivo: (nome: string) => string;
};

const NATUREZAS: NaturezaLancamento[] = ["receita", "receita_adiantamento", "custeio", "investimento", "devolucao"];
const soDigitos = (v: unknown) => String(v ?? "").replace(/\D+/g, "");

export function registerIrpfRural(app: express.Express, d: Deps) {
  const { sqlite } = d;

  // ======================= Schema =======================
  sqlite.exec(`
    -- Um "produtor" aqui é a escrituração de UMA empresa-cliente em UM ano-calendário. Produtor
    -- rural costuma ter várias fazendas sob o mesmo CPF: as fazendas são os imóveis (rural_imoveis),
    -- não escriturações separadas — o limite de receita bruta do LCDPR e o resultado da atividade
    -- rural são apurados somando todas as unidades exploradas.
    CREATE TABLE IF NOT EXISTS rural_produtores (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      escritorio_id INTEGER NOT NULL,
      empresa_id INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
      ano INTEGER NOT NULL,
      cpf TEXT,
      nome TEXT,
      endereco TEXT, numero TEXT, complemento TEXT, bairro TEXT, uf TEXT, cod_municipio TEXT, cep TEXT,
      telefone TEXT, email TEXT,
      forma_apuracao INTEGER NOT NULL DEFAULT 1,       -- 1 livro caixa | 2 presunção 20% (art. 5º Lei 8.023/90)
      ind_inicio_periodo INTEGER NOT NULL DEFAULT 0,   -- 0 regular | 1 abertura | 2 início de obrigatoriedade no ano
      situacao_especial INTEGER NOT NULL DEFAULT 0,    -- 0 normal | 1 falecimento | 2 espólio | 3 saída definitiva
      data_situacao_especial TEXT,
      signatario_nome TEXT, signatario_cpf_cnpj TEXT, signatario_crc TEXT, signatario_email TEXT, signatario_telefone TEXT,
      criado_em TEXT DEFAULT (datetime('now')),
      atualizado_em TEXT,
      UNIQUE(empresa_id, ano)
    );

    CREATE TABLE IF NOT EXISTS rural_imoveis (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      produtor_id INTEGER NOT NULL REFERENCES rural_produtores(id) ON DELETE CASCADE,
      cod_imovel INTEGER NOT NULL,
      pais TEXT NOT NULL DEFAULT 'BR',
      moeda TEXT NOT NULL DEFAULT 'BRL',
      cad_itr TEXT, caepf TEXT, inscricao_estadual TEXT,
      nome TEXT NOT NULL,
      endereco TEXT, numero TEXT, complemento TEXT, bairro TEXT, uf TEXT, cod_municipio TEXT, cep TEXT,
      tipo_exploracao INTEGER NOT NULL DEFAULT 1,
      participacao REAL NOT NULL DEFAULT 100,
      UNIQUE(produtor_id, cod_imovel)
    );

    CREATE TABLE IF NOT EXISTS rural_terceiros (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      imovel_id INTEGER NOT NULL REFERENCES rural_imoveis(id) ON DELETE CASCADE,
      tipo_contraparte INTEGER NOT NULL,
      id_contraparte TEXT NOT NULL,
      nome TEXT NOT NULL,
      percentual REAL NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS rural_contas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      produtor_id INTEGER NOT NULL REFERENCES rural_produtores(id) ON DELETE CASCADE,
      cod_conta INTEGER NOT NULL,
      pais TEXT NOT NULL DEFAULT 'BR',
      banco TEXT, nome_banco TEXT NOT NULL, agencia TEXT, numero_conta TEXT,
      UNIQUE(produtor_id, cod_conta)
    );

    -- A caixa de entrada. O arquivo cru fica no disco; aqui mora o que sabemos sobre ele.
    CREATE TABLE IF NOT EXISTS rural_documentos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      produtor_id INTEGER NOT NULL REFERENCES rural_produtores(id) ON DELETE CASCADE,
      nome_arquivo TEXT NOT NULL,
      arquivo_path TEXT NOT NULL,
      mime TEXT, size_bytes INTEGER,
      hash TEXT,                      -- sha256 do conteúdo: barra o mesmo documento subindo 2x
      origem TEXT NOT NULL DEFAULT 'escritorio',  -- escritorio | portal | email | whatsapp
      status TEXT NOT NULL DEFAULT 'processando', -- processando | classificado | conferir | nao_identificado | erro | ignorado
      tipo_detectado TEXT,
      confianca REAL,
      motor TEXT,
      observacao TEXT,
      chave_acesso TEXT,
      texto_extraido TEXT,
      erro TEXT,
      criado_por INTEGER REFERENCES app_users(id),
      criado_em TEXT DEFAULT (datetime('now')),
      processado_em TEXT,
      UNIQUE(produtor_id, hash)
    );
    CREATE INDEX IF NOT EXISTS idx_rural_doc_produtor ON rural_documentos(produtor_id, status);

    -- A prévia do lançamento. Nasce de um documento (ou à mão) e só entra no livro caixa definitivo
    -- quando o contador aprova.
    CREATE TABLE IF NOT EXISTS rural_lancamentos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      produtor_id INTEGER NOT NULL REFERENCES rural_produtores(id) ON DELETE CASCADE,
      documento_id INTEGER REFERENCES rural_documentos(id) ON DELETE SET NULL,
      data TEXT,
      cod_imovel INTEGER,
      cod_conta INTEGER NOT NULL DEFAULT 999,  -- 000 espécie | 999 numerário em trânsito | demais = rural_contas
      num_doc TEXT,
      tipo_doc INTEGER NOT NULL DEFAULT 6,
      historico TEXT,
      participante_doc TEXT,
      participante_nome TEXT,
      natureza TEXT,
      valor REAL,
      status TEXT NOT NULL DEFAULT 'previa',   -- previa | aprovado | descartado
      confianca REAL,
      motor TEXT,
      observacao TEXT,
      criado_em TEXT DEFAULT (datetime('now')),
      aprovado_por INTEGER REFERENCES app_users(id),
      aprovado_em TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_rural_lanc_produtor ON rural_lancamentos(produtor_id, status, data);

    -- Transações lidas de extrato OFX. Não viram lançamento sozinhas: extrato é a contraprova do
    -- livro caixa (e a fonte do saldo em 31/12 pra ficha de bens), não a fonte dos lançamentos.
    CREATE TABLE IF NOT EXISTS rural_extrato_transacoes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      produtor_id INTEGER NOT NULL REFERENCES rural_produtores(id) ON DELETE CASCADE,
      documento_id INTEGER REFERENCES rural_documentos(id) ON DELETE CASCADE,
      cod_conta INTEGER,
      fitid TEXT,
      data TEXT,
      valor REAL,
      descricao TEXT,
      lancamento_id INTEGER REFERENCES rural_lancamentos(id) ON DELETE SET NULL,
      UNIQUE(produtor_id, fitid)
    );

    -- Aprendizado: quando o contador corrige a classificação de um documento, guardamos a correção
    -- pelo CPF/CNPJ da contraparte. O mesmo fornecedor não erra duas vezes. Vale pro escritório
    -- inteiro, não só pra um cliente — quem vende ração pro produtor A vende pro produtor B.
    CREATE TABLE IF NOT EXISTS rural_regras (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      escritorio_id INTEGER NOT NULL,
      participante_doc TEXT NOT NULL,
      tipo TEXT,
      natureza TEXT,
      cod_imovel INTEGER,
      cod_conta INTEGER,
      vezes INTEGER NOT NULL DEFAULT 1,
      atualizado_em TEXT DEFAULT (datetime('now')),
      UNIQUE(escritorio_id, participante_doc)
    );
  `);

  const RURAL_DIR = path.join(d.uploadsDir, "irpf-rural");
  fs.mkdirSync(RURAL_DIR, { recursive: true });

  // ======================= Acesso =======================

  function produtorDoUsuario(user: any, produtorId: number): any | null {
    const p = sqlite.prepare(`SELECT * FROM rural_produtores WHERE id = ?`).get(produtorId) as any;
    if (!p) return null;
    if (p.escritorio_id !== user.escritorioId) return null;
    if (!d.podeAcessarEmpresa(user, p.empresa_id)) return null;
    return p;
  }
  // Todos os CPF/CNPJ que representam este produtor — serve pro classificador saber de que lado da
  // nota ele está. Produtor rural tem o mesmo CPF em várias fazendas e às vezes um CNPJ junto.
  function documentosDoProdutor(p: any): string[] {
    const emp = sqlite.prepare(`SELECT cnpj FROM empresas WHERE id = ?`).get(p.empresa_id) as any;
    return [soDigitos(p.cpf), soDigitos(emp?.cnpj)].filter((x) => x.length === 11 || x.length === 14);
  }

  // ======================= Fila de processamento =======================
  // Sequencial de propósito (ver comentário no topo do arquivo). Um upload de 200 arquivos entra
  // inteiro na fila e vai sendo digerido; o front mostra o quanto falta.
  const fila: number[] = [];
  let processando = false;

  function enfileirar(documentoId: number) {
    fila.push(documentoId);
    if (!processando) void girarFila();
  }

  async function girarFila() {
    if (processando) return;
    processando = true;
    try {
      while (fila.length) {
        const id = fila.shift()!;
        try {
          await processarDocumento(id);
        } catch (e: any) {
          sqlite
            .prepare(`UPDATE rural_documentos SET status = 'erro', erro = ?, processado_em = datetime('now') WHERE id = ?`)
            .run(String(e?.message || e).slice(0, 500), id);
        }
      }
    } finally {
      processando = false;
    }
  }

  async function processarDocumento(documentoId: number) {
    const doc = sqlite.prepare(`SELECT * FROM rural_documentos WHERE id = ?`).get(documentoId) as any;
    if (!doc) return;
    const produtor = sqlite.prepare(`SELECT * FROM rural_produtores WHERE id = ?`).get(doc.produtor_id) as any;
    if (!produtor) return;
    const buf = fs.readFileSync(doc.arquivo_path);
    const nome = String(doc.nome_arquivo || "");
    const ehXml = /\.xml$/i.test(nome) || /^(application|text)\/xml$/i.test(doc.mime || "");
    const ehOfx = /\.(ofx|qfx)$/i.test(nome);

    let classificacao: ClassificacaoDocumento | null = null;
    let texto: string | null = null;

    // ---- 1. XML de NF-e: determinístico ----
    if (ehXml) {
      const resumo = lerXmlNfe(buf.toString("utf8"));
      if (resumo) {
        classificacao = classificarNfe(resumo, documentosDoProdutor(produtor));
      }
    }

    // ---- 2. OFX: vira extrato, não lançamento ----
    if (!classificacao && ehOfx) {
      const extrato = parseOfx(buf.toString("latin1"));
      const codConta = conciliarContaDoExtrato(produtor.id, extrato.contaBanco);
      const ins = sqlite.prepare(
        `INSERT OR IGNORE INTO rural_extrato_transacoes (produtor_id, documento_id, cod_conta, fitid, data, valor, descricao)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      );
      for (const t of extrato.transacoes) ins.run(produtor.id, doc.id, codConta, t.fitid, t.data, t.valor, t.descricao);
      sqlite
        .prepare(
          `UPDATE rural_documentos SET status = 'classificado', tipo_detectado = 'extrato_bancario', motor = 'ofx',
             confianca = 1, observacao = ?, processado_em = datetime('now') WHERE id = ?`
        )
        .run(
          `${extrato.transacoes.length} transações importadas${extrato.contaBanco ? ` (conta ${extrato.contaBanco})` : ""}. ` +
            `O extrato serve pra conferir o livro caixa e pro saldo de 31/12 — não vira lançamento sozinho.`,
          doc.id
        );
      return;
    }

    // ---- 3. Texto + regras ----
    if (!classificacao) {
      try {
        if (/pdf$/i.test(doc.mime || "") || /\.pdf$/i.test(nome)) texto = await d.obterTextoDoPdf(buf);
        else if (/^text\//i.test(doc.mime || "")) texto = buf.toString("utf8");
      } catch {
        texto = null;
      }
      if (texto) classificacao = classificarPorRegra(texto);
    }

    // ---- 4. IA no que sobrou ----
    if (!classificacao || classificacao.confianca < CONFIANCA_MINIMA) {
      const porIa = await classificarComIa({
        texto,
        arquivo: { buffer: buf, mime: String(doc.mime || "") },
        nomeArquivo: nome,
      });
      // Só troca se a IA realmente ficou mais confiante que a regra — regra determinística que
      // acertou não perde pra um palpite.
      if (porIa && (!classificacao || porIa.confianca > classificacao.confianca)) classificacao = porIa;
    }

    if (!classificacao) {
      sqlite
        .prepare(
          `UPDATE rural_documentos SET status = 'nao_identificado', texto_extraido = ?, processado_em = datetime('now'),
             observacao = ? WHERE id = ?`
        )
        .run(
          (texto || "").slice(0, 20000) || null,
          iaDisponivel()
            ? "Não consegui identificar o documento. Classifique à mão — eu aprendo a regra pro próximo igual."
            : "Não consegui identificar o documento pelas regras, e a leitura por IA está desligada (falta a chave ANTHROPIC_API_KEY no servidor).",
          doc.id
        );
      return;
    }

    // ---- Regra aprendida: sobrepõe o palpite quando já corrigimos esse fornecedor antes ----
    if (classificacao.participanteDoc) {
      const regra = sqlite
        .prepare(`SELECT * FROM rural_regras WHERE escritorio_id = ? AND participante_doc = ?`)
        .get(produtor.escritorio_id, classificacao.participanteDoc) as any;
      if (regra) {
        classificacao = {
          ...classificacao,
          tipo: regra.tipo || classificacao.tipo,
          natureza: (regra.natureza as NaturezaLancamento) || classificacao.natureza,
          motor: "regra_aprendida",
          confianca: Math.max(classificacao.confianca, 0.9),
          observacao: classificacao.observacao
            ? `${classificacao.observacao} (classificação ajustada pela regra que você salvou para este fornecedor)`
            : "Classificado pela regra que você salvou antes para este fornecedor.",
        };
      }
    }

    // Tributo: o manual do LCDPR manda usar o CPF/CNPJ do próprio contribuinte como participante.
    let participanteDoc = classificacao.participanteDoc;
    if (classificacao.tipo === "guia_tributo" && !participanteDoc) participanteDoc = soDigitos(produtor.cpf) || null;

    const status = classificacao.natureza === null ? "classificado" : classificacao.confianca >= CONFIANCA_MINIMA ? "classificado" : "conferir";
    sqlite
      .prepare(
        `UPDATE rural_documentos SET status = ?, tipo_detectado = ?, confianca = ?, motor = ?, observacao = ?,
           chave_acesso = ?, texto_extraido = ?, processado_em = datetime('now') WHERE id = ?`
      )
      .run(
        status,
        classificacao.tipo,
        classificacao.confianca,
        classificacao.motor,
        classificacao.observacao,
        classificacao.chaveAcesso || null,
        (texto || "").slice(0, 20000) || null,
        doc.id
      );

    // Documento que não vira lançamento (contrato, extrato) para por aqui.
    if (!classificacao.natureza) return;

    // Imóvel padrão: se o produtor só tem um imóvel, não faz sentido perguntar toda vez.
    const imoveis = sqlite.prepare(`SELECT cod_imovel FROM rural_imoveis WHERE produtor_id = ? ORDER BY cod_imovel`).all(produtor.id) as any[];
    const codImovel = imoveis.length === 1 ? imoveis[0].cod_imovel : null;

    sqlite
      .prepare(
        `INSERT INTO rural_lancamentos (produtor_id, documento_id, data, cod_imovel, cod_conta, num_doc, tipo_doc, historico,
           participante_doc, participante_nome, natureza, valor, status, confianca, motor, observacao)
         VALUES (?, ?, ?, ?, 999, ?, ?, ?, ?, ?, ?, ?, 'previa', ?, ?, ?)`
      )
      .run(
        produtor.id,
        doc.id,
        classificacao.data,
        codImovel,
        classificacao.numDoc,
        classificacao.tipoDoc ?? 6,
        classificacao.historico,
        participanteDoc,
        classificacao.participanteNome,
        classificacao.natureza,
        classificacao.valor,
        classificacao.confianca,
        classificacao.motor,
        classificacao.observacao
      );
  }

  // Tenta casar a conta do OFX com uma conta cadastrada. O OFX traz o número da conta em formatos
  // variados conforme o banco, então compara só os dígitos e aceita o sufixo bater.
  function conciliarContaDoExtrato(produtorId: number, contaBanco: string | null): number | null {
    if (!contaBanco) return null;
    const alvo = soDigitos(contaBanco);
    if (!alvo) return null;
    const contas = sqlite.prepare(`SELECT cod_conta, numero_conta FROM rural_contas WHERE produtor_id = ?`).all(produtorId) as any[];
    for (const c of contas) {
      const n = soDigitos(c.numero_conta);
      if (n && (n === alvo || n.endsWith(alvo) || alvo.endsWith(n))) return c.cod_conta;
    }
    return null;
  }

  // ======================= Apuração =======================

  interface Demonstrativo {
    receitaBruta: number;
    devolucoes: number;
    receitaLiquida: number;
    despesasCusteio: number;
    investimentos: number;
    resultado: number; // receita líquida - custeio - investimentos
    resultadoPresumido: number; // 20% da receita líquida (art. 5º da Lei 8.023/1990)
    porMes: { mes: string; receita: number; devolucao: number; custeio: number; investimento: number }[];
    porImovel: { codImovel: number | null; nome: string; receita: number; devolucao: number; custeio: number; investimento: number }[];
    lancamentos: number;
    pendentes: number;
  }

  function apurar(produtorId: number): Demonstrativo {
    const linhas = sqlite
      .prepare(`SELECT * FROM rural_lancamentos WHERE produtor_id = ? AND status = 'aprovado' ORDER BY data`)
      .all(produtorId) as any[];
    const imoveis = sqlite.prepare(`SELECT cod_imovel, nome FROM rural_imoveis WHERE produtor_id = ?`).all(produtorId) as any[];
    const nomeImovel = new Map<number, string>(imoveis.map((i) => [i.cod_imovel, i.nome]));

    const zero = () => ({ receita: 0, devolucao: 0, custeio: 0, investimento: 0 });
    const meses = new Map<string, ReturnType<typeof zero>>();
    const porImovelMap = new Map<number | null, ReturnType<typeof zero>>();
    const total = zero();

    for (const l of linhas) {
      const v = Math.abs(Number(l.valor) || 0);
      const chave: keyof ReturnType<typeof zero> =
        l.natureza === "receita" || l.natureza === "receita_adiantamento"
          ? "receita"
          : l.natureza === "devolucao"
            ? "devolucao"
            : l.natureza === "investimento"
              ? "investimento"
              : "custeio";
      total[chave] += v;
      const mes = String(l.data || "").slice(0, 7) || "sem-data";
      if (!meses.has(mes)) meses.set(mes, zero());
      meses.get(mes)![chave] += v;
      const ci = l.cod_imovel == null ? null : Number(l.cod_imovel);
      if (!porImovelMap.has(ci)) porImovelMap.set(ci, zero());
      porImovelMap.get(ci)![chave] += v;
    }

    const receitaLiquida = total.receita - total.devolucao;
    const pendentes = (
      sqlite.prepare(`SELECT COUNT(*) AS n FROM rural_lancamentos WHERE produtor_id = ? AND status = 'previa'`).get(produtorId) as any
    ).n as number;

    return {
      receitaBruta: total.receita,
      devolucoes: total.devolucao,
      receitaLiquida,
      despesasCusteio: total.custeio,
      investimentos: total.investimento,
      resultado: receitaLiquida - total.custeio - total.investimento,
      resultadoPresumido: receitaLiquida * 0.2,
      porMes: [...meses.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([mes, v]) => ({ mes, ...v })),
      porImovel: [...porImovelMap.entries()].map(([codImovel, v]) => ({
        codImovel,
        nome: codImovel == null ? "(sem imóvel definido)" : nomeImovel.get(codImovel) || `Imóvel ${codImovel}`,
        ...v,
      })),
      lancamentos: linhas.length,
      pendentes,
    };
  }

  function montarParamsLcdpr(produtor: any): LcdprParams {
    const imoveis = sqlite.prepare(`SELECT * FROM rural_imoveis WHERE produtor_id = ? ORDER BY cod_imovel`).all(produtor.id) as any[];
    const terceiros = sqlite
      .prepare(`SELECT t.* FROM rural_terceiros t JOIN rural_imoveis i ON i.id = t.imovel_id WHERE i.produtor_id = ?`)
      .all(produtor.id) as any[];
    const contas = sqlite.prepare(`SELECT * FROM rural_contas WHERE produtor_id = ? ORDER BY cod_conta`).all(produtor.id) as any[];
    const lancamentos = sqlite
      .prepare(`SELECT * FROM rural_lancamentos WHERE produtor_id = ? AND status = 'aprovado' ORDER BY data, id`)
      .all(produtor.id) as any[];

    const codPorImovelId = new Map<number, number>(imoveis.map((i) => [i.id, i.cod_imovel]));
    return {
      anoCalendario: produtor.ano,
      declarante: {
        cpf: produtor.cpf || "",
        nome: produtor.nome || "",
        endereco: produtor.endereco || "",
        numero: produtor.numero || "",
        complemento: produtor.complemento,
        bairro: produtor.bairro || "",
        uf: produtor.uf || "",
        codMunicipio: produtor.cod_municipio || "",
        cep: produtor.cep || "",
        telefone: produtor.telefone,
        email: produtor.email || "",
      },
      formaApuracao: (produtor.forma_apuracao === 2 ? 2 : 1) as 1 | 2,
      indicadorInicioPeriodo: (produtor.ind_inicio_periodo ?? 0) as 0 | 1 | 2,
      situacaoEspecial: (produtor.situacao_especial ?? 0) as 0 | 1 | 2 | 3,
      dataSituacaoEspecial: produtor.data_situacao_especial,
      dataInicio: `${produtor.ano}-01-01`,
      dataFim: `${produtor.ano}-12-31`,
      imoveis: imoveis.map((i) => ({
        codImovel: i.cod_imovel,
        pais: i.pais || "BR",
        moeda: i.moeda || "BRL",
        cadItr: i.cad_itr,
        caepf: i.caepf,
        inscricaoEstadual: i.inscricao_estadual,
        nome: i.nome,
        endereco: i.endereco || "",
        numero: i.numero,
        complemento: i.complemento,
        bairro: i.bairro || "",
        uf: i.uf || "",
        codMunicipio: i.cod_municipio || "",
        cep: i.cep || "",
        tipoExploracao: i.tipo_exploracao,
        participacao: i.participacao,
      })),
      terceiros: terceiros.map((t) => ({
        codImovel: codPorImovelId.get(t.imovel_id) ?? 0,
        tipoContraparte: t.tipo_contraparte,
        idContraparte: t.id_contraparte,
        nome: t.nome,
        percentual: t.percentual,
      })),
      contas: contas.map((c) => ({
        codConta: c.cod_conta,
        pais: c.pais || "BR",
        banco: c.banco,
        nomeBanco: c.nome_banco,
        agencia: c.agencia || "",
        numeroConta: c.numero_conta || "",
      })),
      lancamentos: lancamentos.map(
        (l): LcdprLancamento => ({
          data: l.data,
          codImovel: l.cod_imovel == null ? 0 : Number(l.cod_imovel),
          codConta: Number(l.cod_conta ?? 999),
          numDoc: l.num_doc,
          tipoDoc: Number(l.tipo_doc ?? 6),
          historico: l.historico || "",
          idParticipante: l.participante_doc || "",
          natureza: l.natureza,
          valor: Math.abs(Number(l.valor) || 0),
        })
      ),
      signatario: {
        nome: produtor.signatario_nome,
        cpfCnpj: produtor.signatario_cpf_cnpj,
        crc: produtor.signatario_crc,
        email: produtor.signatario_email,
        telefone: produtor.signatario_telefone,
      },
    };
  }

  // ======================= Rotas =======================
  // ATENÇÃO: neste projeto toda rota com segmento literal precisa vir ANTES de qualquer :id do mesmo
  // prefixo — senão o Express casa o literal como id e a rota quebra em silêncio.

  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024, files: 200 } });
  const ver = d.requirePermissao("irpf_rural", "visualizar");
  const postar = d.requirePermissao("irpf_rural", "postar");
  const editar = d.requirePermissao("irpf_rural", "editar");

  // ---- Escrituração do ano (cria na primeira visita, puxando o cadastro da empresa) ----
  app.get("/api/rural/escrituracao", d.blockCliente, ver, (req, res) => {
    const user = (req as any).user;
    const empresaId = Number(req.query.empresaId);
    const ano = Number(req.query.ano);
    if (!Number.isInteger(empresaId) || !Number.isInteger(ano) || ano < 2019 || ano > 2100)
      return res.status(400).json({ error: "Informe a empresa e um ano a partir de 2019 (o leiaute 1.3 do LCDPR vale de 2019 em diante)." });
    if (!d.podeAcessarEmpresa(user, empresaId)) return res.status(404).json({ error: "Empresa não encontrada." });

    let p = sqlite.prepare(`SELECT * FROM rural_produtores WHERE empresa_id = ? AND ano = ?`).get(empresaId, ano) as any;
    if (!p) {
      const emp = sqlite.prepare(`SELECT * FROM empresas WHERE id = ?`).get(empresaId) as any;
      if (!emp) return res.status(404).json({ error: "Empresa não encontrada." });
      // Puxa o que o cadastro da empresa já tem, pra o contador não redigitar: o código IBGE do
      // município (campo que o leiaute exige e que o projeto já centraliza por causa da NFS-e) e o
      // CPF. Produtor rural pessoa física tem CPF no lugar do CNPJ, e o cadastro guarda os dois no
      // mesmo campo — daí a checagem de 11 dígitos.
      // Bairro fica em branco de propósito: `empresas.cidade` é o município, não o bairro/distrito
      // que o registro 0030 pede, e preencher um com o outro geraria arquivo com dado errado.
      const doc = soDigitos(emp.cnpj);
      sqlite
        .prepare(
          `INSERT INTO rural_produtores (escritorio_id, empresa_id, ano, cpf, nome, endereco, uf, cod_municipio, cep, telefone, email)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          user.escritorioId,
          empresaId,
          ano,
          doc.length === 11 ? doc : null,
          emp.nome || null,
          emp.endereco || null,
          emp.uf || null,
          soDigitos(emp.codigo_municipio_ibge) || null,
          soDigitos(emp.cep) || null,
          soDigitos(emp.telefone) || null,
          emp.email || null
        );
      p = sqlite.prepare(`SELECT * FROM rural_produtores WHERE empresa_id = ? AND ano = ?`).get(empresaId, ano) as any;
    }
    // O cadastro da empresa já tem CAEPF, inscrição estadual e código IBGE (vindos do Onvio/NFS-e).
    // Vão como sugestão pro formulário do primeiro imóvel, que é onde o leiaute cobra esses campos.
    const emp = sqlite.prepare(`SELECT * FROM empresas WHERE id = ?`).get(empresaId) as any;
    res.json({
      produtor: p,
      iaLigada: iaDisponivel(),
      naFila: fila.length + (processando ? 1 : 0),
      sugestoesImovel: {
        caepf: soDigitos(emp?.caepf) || null,
        inscricaoEstadual: soDigitos(emp?.inscricao_estadual) || null,
        uf: emp?.uf || null,
        codMunicipio: soDigitos(emp?.codigo_municipio_ibge) || null,
        cep: soDigitos(emp?.cep) || null,
      },
    });
  });

  app.put("/api/rural/escrituracao/:id", d.blockCliente, editar, (req, res) => {
    const user = (req as any).user;
    const p = produtorDoUsuario(user, Number(req.params.id));
    if (!p) return res.status(404).json({ error: "Escrituração não encontrada." });
    const b = req.body || {};
    const txt = (v: any, max = 200) => (v == null ? null : String(v).trim().slice(0, max) || null);
    sqlite
      .prepare(
        `UPDATE rural_produtores SET cpf=?, nome=?, endereco=?, numero=?, complemento=?, bairro=?, uf=?, cod_municipio=?, cep=?,
           telefone=?, email=?, forma_apuracao=?, ind_inicio_periodo=?, situacao_especial=?, data_situacao_especial=?,
           signatario_nome=?, signatario_cpf_cnpj=?, signatario_crc=?, signatario_email=?, signatario_telefone=?,
           atualizado_em = datetime('now') WHERE id = ?`
      )
      .run(
        soDigitos(b.cpf) || null,
        txt(b.nome),
        txt(b.endereco),
        txt(b.numero, 6),
        txt(b.complemento, 50),
        txt(b.bairro, 50),
        txt(b.uf, 2)?.toUpperCase() || null,
        soDigitos(b.codMunicipio) || null,
        soDigitos(b.cep) || null,
        soDigitos(b.telefone) || null,
        txt(b.email, 115),
        b.formaApuracao === 2 ? 2 : 1,
        [0, 1, 2].includes(Number(b.indInicioPeriodo)) ? Number(b.indInicioPeriodo) : 0,
        [0, 1, 2, 3].includes(Number(b.situacaoEspecial)) ? Number(b.situacaoEspecial) : 0,
        txt(b.dataSituacaoEspecial, 10),
        txt(b.signatarioNome),
        soDigitos(b.signatarioCpfCnpj) || null,
        txt(b.signatarioCrc, 20),
        txt(b.signatarioEmail, 115),
        soDigitos(b.signatarioTelefone) || null,
        p.id
      );
    res.json({ ok: true, produtor: sqlite.prepare(`SELECT * FROM rural_produtores WHERE id = ?`).get(p.id) });
  });

  // ---- Imóveis ----
  app.get("/api/rural/imoveis", d.blockCliente, ver, (req, res) => {
    const p = produtorDoUsuario((req as any).user, Number(req.query.produtorId));
    if (!p) return res.status(404).json({ error: "Escrituração não encontrada." });
    const imoveis = sqlite.prepare(`SELECT * FROM rural_imoveis WHERE produtor_id = ? ORDER BY cod_imovel`).all(p.id) as any[];
    const terceiros = sqlite
      .prepare(`SELECT t.* FROM rural_terceiros t JOIN rural_imoveis i ON i.id = t.imovel_id WHERE i.produtor_id = ? ORDER BY t.id`)
      .all(p.id) as any[];
    res.json({ imoveis, terceiros });
  });

  app.post("/api/rural/imoveis", d.blockCliente, postar, (req, res) => {
    const p = produtorDoUsuario((req as any).user, Number(req.body?.produtorId));
    if (!p) return res.status(404).json({ error: "Escrituração não encontrada." });
    const b = req.body || {};
    if (!String(b.nome || "").trim()) return res.status(400).json({ error: "Informe o nome do imóvel." });
    // Código sequencial do imóvel: o próprio sistema atribui, porque o Q100 aponta pra ele e um
    // número digitado errado inutiliza o arquivo inteiro.
    const prox = ((sqlite.prepare(`SELECT MAX(cod_imovel) AS m FROM rural_imoveis WHERE produtor_id = ?`).get(p.id) as any)?.m || 0) + 1;
    const r = sqlite
      .prepare(
        `INSERT INTO rural_imoveis (produtor_id, cod_imovel, pais, moeda, cad_itr, caepf, inscricao_estadual, nome, endereco, numero,
           complemento, bairro, uf, cod_municipio, cep, tipo_exploracao, participacao)
         VALUES (?, ?, 'BR', 'BRL', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        p.id,
        prox,
        soDigitos(b.cadItr) || null,
        soDigitos(b.caepf) || null,
        soDigitos(b.inscricaoEstadual) || null,
        String(b.nome).trim().slice(0, 50),
        String(b.endereco || "").trim().slice(0, 150) || null,
        String(b.numero || "").trim().slice(0, 6) || null,
        String(b.complemento || "").trim().slice(0, 50) || null,
        String(b.bairro || "").trim().slice(0, 50) || null,
        String(b.uf || "").trim().toUpperCase().slice(0, 2) || null,
        soDigitos(b.codMunicipio) || null,
        soDigitos(b.cep) || null,
        [1, 2, 3, 4, 5, 6].includes(Number(b.tipoExploracao)) ? Number(b.tipoExploracao) : 1,
        Number(b.participacao) > 0 ? Number(b.participacao) : 100
      );
    res.json({ id: Number(r.lastInsertRowid), codImovel: prox });
  });

  app.put("/api/rural/imoveis/:id", d.blockCliente, editar, (req, res) => {
    const user = (req as any).user;
    const im = sqlite.prepare(`SELECT * FROM rural_imoveis WHERE id = ?`).get(Number(req.params.id)) as any;
    if (!im || !produtorDoUsuario(user, im.produtor_id)) return res.status(404).json({ error: "Imóvel não encontrado." });
    const b = req.body || {};
    sqlite
      .prepare(
        `UPDATE rural_imoveis SET cad_itr=?, caepf=?, inscricao_estadual=?, nome=?, endereco=?, numero=?, complemento=?, bairro=?,
           uf=?, cod_municipio=?, cep=?, tipo_exploracao=?, participacao=? WHERE id = ?`
      )
      .run(
        soDigitos(b.cadItr) || null,
        soDigitos(b.caepf) || null,
        soDigitos(b.inscricaoEstadual) || null,
        String(b.nome || im.nome).trim().slice(0, 50),
        String(b.endereco || "").trim().slice(0, 150) || null,
        String(b.numero || "").trim().slice(0, 6) || null,
        String(b.complemento || "").trim().slice(0, 50) || null,
        String(b.bairro || "").trim().slice(0, 50) || null,
        String(b.uf || "").trim().toUpperCase().slice(0, 2) || null,
        soDigitos(b.codMunicipio) || null,
        soDigitos(b.cep) || null,
        [1, 2, 3, 4, 5, 6].includes(Number(b.tipoExploracao)) ? Number(b.tipoExploracao) : im.tipo_exploracao,
        Number(b.participacao) > 0 ? Number(b.participacao) : im.participacao,
        im.id
      );
    res.json({ ok: true });
  });

  app.delete("/api/rural/imoveis/:id", d.blockCliente, editar, (req, res) => {
    const user = (req as any).user;
    const im = sqlite.prepare(`SELECT * FROM rural_imoveis WHERE id = ?`).get(Number(req.params.id)) as any;
    if (!im || !produtorDoUsuario(user, im.produtor_id)) return res.status(404).json({ error: "Imóvel não encontrado." });
    const emUso = (
      sqlite.prepare(`SELECT COUNT(*) AS n FROM rural_lancamentos WHERE produtor_id = ? AND cod_imovel = ?`).get(im.produtor_id, im.cod_imovel) as any
    ).n as number;
    if (emUso) return res.status(400).json({ error: `Este imóvel tem ${emUso} lançamento(s) apontando pra ele. Mude os lançamentos antes de excluir.` });
    sqlite.prepare(`DELETE FROM rural_imoveis WHERE id = ?`).run(im.id);
    res.json({ ok: true });
  });

  // ---- Terceiros (registro 0045) ----
  app.post("/api/rural/terceiros", d.blockCliente, postar, (req, res) => {
    const user = (req as any).user;
    const im = sqlite.prepare(`SELECT * FROM rural_imoveis WHERE id = ?`).get(Number(req.body?.imovelId)) as any;
    if (!im || !produtorDoUsuario(user, im.produtor_id)) return res.status(404).json({ error: "Imóvel não encontrado." });
    const b = req.body || {};
    const doc = soDigitos(b.idContraparte);
    if (doc.length !== 11 && doc.length !== 14) return res.status(400).json({ error: "CPF (11 dígitos) ou CNPJ (14 dígitos) da contraparte inválido." });
    const r = sqlite
      .prepare(`INSERT INTO rural_terceiros (imovel_id, tipo_contraparte, id_contraparte, nome, percentual) VALUES (?, ?, ?, ?, ?)`)
      .run(
        im.id,
        [1, 2, 3, 4, 5].includes(Number(b.tipoContraparte)) ? Number(b.tipoContraparte) : 5,
        doc,
        String(b.nome || "").trim().slice(0, 50),
        Number(b.percentual) > 0 ? Number(b.percentual) : 0
      );
    res.json({ id: Number(r.lastInsertRowid) });
  });

  app.delete("/api/rural/terceiros/:id", d.blockCliente, editar, (req, res) => {
    const user = (req as any).user;
    const t = sqlite.prepare(`SELECT t.*, i.produtor_id FROM rural_terceiros t JOIN rural_imoveis i ON i.id = t.imovel_id WHERE t.id = ?`).get(Number(req.params.id)) as any;
    if (!t || !produtorDoUsuario(user, t.produtor_id)) return res.status(404).json({ error: "Registro não encontrado." });
    sqlite.prepare(`DELETE FROM rural_terceiros WHERE id = ?`).run(t.id);
    res.json({ ok: true });
  });

  // ---- Contas bancárias ----
  app.get("/api/rural/contas", d.blockCliente, ver, (req, res) => {
    const p = produtorDoUsuario((req as any).user, Number(req.query.produtorId));
    if (!p) return res.status(404).json({ error: "Escrituração não encontrada." });
    res.json({ contas: sqlite.prepare(`SELECT * FROM rural_contas WHERE produtor_id = ? ORDER BY cod_conta`).all(p.id) });
  });

  app.post("/api/rural/contas", d.blockCliente, postar, (req, res) => {
    const p = produtorDoUsuario((req as any).user, Number(req.body?.produtorId));
    if (!p) return res.status(404).json({ error: "Escrituração não encontrada." });
    const b = req.body || {};
    if (!String(b.nomeBanco || "").trim()) return res.status(400).json({ error: "Informe o nome do banco." });
    const prox = ((sqlite.prepare(`SELECT MAX(cod_conta) AS m FROM rural_contas WHERE produtor_id = ?`).get(p.id) as any)?.m || 0) + 1;
    if (prox >= 999) return res.status(400).json({ error: "Limite de contas atingido (o código 999 é reservado pelo leiaute)." });
    const r = sqlite
      .prepare(`INSERT INTO rural_contas (produtor_id, cod_conta, pais, banco, nome_banco, agencia, numero_conta) VALUES (?, ?, 'BR', ?, ?, ?, ?)`)
      .run(p.id, prox, soDigitos(b.banco).slice(0, 3) || null, String(b.nomeBanco).trim().slice(0, 30), soDigitos(b.agencia).slice(0, 4) || null, soDigitos(b.numeroConta).slice(0, 16) || null);
    res.json({ id: Number(r.lastInsertRowid), codConta: prox });
  });

  app.put("/api/rural/contas/:id", d.blockCliente, editar, (req, res) => {
    const user = (req as any).user;
    const c = sqlite.prepare(`SELECT * FROM rural_contas WHERE id = ?`).get(Number(req.params.id)) as any;
    if (!c || !produtorDoUsuario(user, c.produtor_id)) return res.status(404).json({ error: "Conta não encontrada." });
    const b = req.body || {};
    sqlite
      .prepare(`UPDATE rural_contas SET banco=?, nome_banco=?, agencia=?, numero_conta=? WHERE id = ?`)
      .run(soDigitos(b.banco).slice(0, 3) || null, String(b.nomeBanco || c.nome_banco).trim().slice(0, 30), soDigitos(b.agencia).slice(0, 4) || null, soDigitos(b.numeroConta).slice(0, 16) || null, c.id);
    res.json({ ok: true });
  });

  app.delete("/api/rural/contas/:id", d.blockCliente, editar, (req, res) => {
    const user = (req as any).user;
    const c = sqlite.prepare(`SELECT * FROM rural_contas WHERE id = ?`).get(Number(req.params.id)) as any;
    if (!c || !produtorDoUsuario(user, c.produtor_id)) return res.status(404).json({ error: "Conta não encontrada." });
    const emUso = (
      sqlite.prepare(`SELECT COUNT(*) AS n FROM rural_lancamentos WHERE produtor_id = ? AND cod_conta = ?`).get(c.produtor_id, c.cod_conta) as any
    ).n as number;
    if (emUso) return res.status(400).json({ error: `Esta conta tem ${emUso} lançamento(s) apontando pra ela. Mude os lançamentos antes de excluir.` });
    sqlite.prepare(`DELETE FROM rural_contas WHERE id = ?`).run(c.id);
    res.json({ ok: true });
  });

  // ---- Caixa de entrada ----
  app.get("/api/rural/documentos", d.blockCliente, ver, (req, res) => {
    const p = produtorDoUsuario((req as any).user, Number(req.query.produtorId));
    if (!p) return res.status(404).json({ error: "Escrituração não encontrada." });
    const docs = sqlite
      .prepare(
        `SELECT d.id, d.nome_arquivo AS nomeArquivo, d.mime, d.size_bytes AS sizeBytes, d.origem, d.status,
                d.tipo_detectado AS tipoDetectado, d.confianca, d.motor, d.observacao, d.erro, d.criado_em AS criadoEm,
                (SELECT COUNT(*) FROM rural_lancamentos l WHERE l.documento_id = d.id AND l.status <> 'descartado') AS lancamentos
         FROM rural_documentos d WHERE d.produtor_id = ? ORDER BY d.criado_em DESC, d.id DESC`
      )
      .all(p.id) as any[];
    res.json({ documentos: docs, naFila: fila.length + (processando ? 1 : 0), iaLigada: iaDisponivel() });
  });

  app.post("/api/rural/documentos", d.blockCliente, postar, upload.array("arquivos", 200), async (req, res) => {
    const user = (req as any).user;
    const p = produtorDoUsuario(user, Number(req.body?.produtorId));
    if (!p) return res.status(404).json({ error: "Escrituração não encontrada." });
    const arquivos = (req.files as Express.Multer.File[]) || [];
    if (!arquivos.length) return res.status(400).json({ error: "Selecione pelo menos um arquivo." });

    const origem = ["escritorio", "portal", "email", "whatsapp"].includes(String(req.body?.origem)) ? String(req.body.origem) : "escritorio";
    const dir = path.join(RURAL_DIR, String(p.id));
    fs.mkdirSync(dir, { recursive: true });

    // Um ZIP de XMLs é o jeito que a contabilidade recebe nota em lote — abre e trata cada um como
    // se tivesse sido enviado solto.
    const paraSalvar: { nome: string; mime: string; buffer: Buffer }[] = [];
    for (const f of arquivos) {
      const nome = d.corrigirNomeArquivo(f.originalname || "documento");
      if (/\.zip$/i.test(nome)) {
        try {
          const zip = await JSZip.loadAsync(f.buffer);
          for (const entry of Object.values(zip.files)) {
            if (entry.dir) continue;
            const conteudo = Buffer.from(await entry.async("nodebuffer"));
            const nomeInterno = path.basename(entry.name);
            if (!conteudo.length) continue;
            paraSalvar.push({ nome: nomeInterno, mime: /\.xml$/i.test(nomeInterno) ? "application/xml" : /\.pdf$/i.test(nomeInterno) ? "application/pdf" : "application/octet-stream", buffer: conteudo });
          }
          continue;
        } catch {
          // ZIP ilegível: salva como está e o processamento marca como não identificado.
        }
      }
      paraSalvar.push({ nome, mime: f.mimetype || "application/octet-stream", buffer: f.buffer });
    }

    const criados: number[] = [];
    let duplicados = 0;
    for (const a of paraSalvar) {
      const hash = crypto.createHash("sha256").update(a.buffer).digest("hex");
      const jaTem = sqlite.prepare(`SELECT id FROM rural_documentos WHERE produtor_id = ? AND hash = ?`).get(p.id, hash) as any;
      if (jaTem) {
        duplicados++;
        continue;
      }
      const destino = path.join(dir, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${a.nome}`.slice(0, 240));
      fs.writeFileSync(destino, a.buffer);
      const r = sqlite
        .prepare(
          `INSERT INTO rural_documentos (produtor_id, nome_arquivo, arquivo_path, mime, size_bytes, hash, origem, criado_por)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(p.id, a.nome, destino, a.mime, a.buffer.length, hash, origem, user.id);
      criados.push(Number(r.lastInsertRowid));
    }
    for (const id of criados) enfileirar(id);
    res.json({ recebidos: criados.length, duplicados, naFila: fila.length + (processando ? 1 : 0) });
  });

  app.get("/api/rural/documentos/:id/arquivo", d.blockCliente, ver, (req, res) => {
    const user = (req as any).user;
    const doc = sqlite.prepare(`SELECT * FROM rural_documentos WHERE id = ?`).get(Number(req.params.id)) as any;
    if (!doc || !produtorDoUsuario(user, doc.produtor_id)) return res.status(404).json({ error: "Documento não encontrado." });
    if (!fs.existsSync(doc.arquivo_path)) return res.status(404).json({ error: "Arquivo não está mais no servidor." });
    // Só PDF e imagem abrem embutidos; qualquer outro tipo sai como anexo, nunca inline — o
    // Content-Type gravado no upload é dado do usuário e não serve de garantia.
    const inline = /^(application\/pdf|image\/(png|jpe?g|gif|webp))$/i.test(doc.mime || "");
    res.setHeader("Content-Type", inline ? doc.mime : "application/octet-stream");
    res.setHeader("Content-Disposition", `${inline ? "inline" : "attachment"}; filename="${encodeURIComponent(doc.nome_arquivo)}"`);
    res.send(fs.readFileSync(doc.arquivo_path));
  });

  app.post("/api/rural/documentos/:id/reprocessar", d.blockCliente, postar, (req, res) => {
    const user = (req as any).user;
    const doc = sqlite.prepare(`SELECT * FROM rural_documentos WHERE id = ?`).get(Number(req.params.id)) as any;
    if (!doc || !produtorDoUsuario(user, doc.produtor_id)) return res.status(404).json({ error: "Documento não encontrado." });
    sqlite.prepare(`DELETE FROM rural_lancamentos WHERE documento_id = ? AND status = 'previa'`).run(doc.id);
    sqlite.prepare(`UPDATE rural_documentos SET status = 'processando', erro = NULL WHERE id = ?`).run(doc.id);
    enfileirar(doc.id);
    res.json({ ok: true });
  });

  app.delete("/api/rural/documentos/:id", d.blockCliente, editar, (req, res) => {
    const user = (req as any).user;
    const doc = sqlite.prepare(`SELECT * FROM rural_documentos WHERE id = ?`).get(Number(req.params.id)) as any;
    if (!doc || !produtorDoUsuario(user, doc.produtor_id)) return res.status(404).json({ error: "Documento não encontrado." });
    const aprovados = (
      sqlite.prepare(`SELECT COUNT(*) AS n FROM rural_lancamentos WHERE documento_id = ? AND status = 'aprovado'`).get(doc.id) as any
    ).n as number;
    if (aprovados)
      return res.status(400).json({ error: "Este documento já tem lançamento aprovado no livro caixa. Desfaça a aprovação antes de excluir." });
    try {
      if (fs.existsSync(doc.arquivo_path)) fs.unlinkSync(doc.arquivo_path);
    } catch {
      /* arquivo já sumiu do disco: segue e limpa o registro mesmo assim */
    }
    sqlite.prepare(`DELETE FROM rural_documentos WHERE id = ?`).run(doc.id);
    res.json({ ok: true });
  });

  // ---- Lançamentos ----
  app.get("/api/rural/lancamentos", d.blockCliente, ver, (req, res) => {
    const p = produtorDoUsuario((req as any).user, Number(req.query.produtorId));
    if (!p) return res.status(404).json({ error: "Escrituração não encontrada." });
    const status = String(req.query.status || "");
    let sql = `SELECT l.*, doc.nome_arquivo AS documentoNome FROM rural_lancamentos l
               LEFT JOIN rural_documentos doc ON doc.id = l.documento_id WHERE l.produtor_id = ?`;
    const params: any[] = [p.id];
    if (["previa", "aprovado", "descartado"].includes(status)) {
      sql += ` AND l.status = ?`;
      params.push(status);
    }
    sql += ` ORDER BY (l.data IS NULL) DESC, l.data, l.id`;
    res.json({ lancamentos: sqlite.prepare(sql).all(...params) });
  });

  app.post("/api/rural/lancamentos", d.blockCliente, postar, (req, res) => {
    const p = produtorDoUsuario((req as any).user, Number(req.body?.produtorId));
    if (!p) return res.status(404).json({ error: "Escrituração não encontrada." });
    const b = req.body || {};
    if (!NATUREZAS.includes(b.natureza)) return res.status(400).json({ error: "Natureza do lançamento inválida." });
    const r = sqlite
      .prepare(
        `INSERT INTO rural_lancamentos (produtor_id, data, cod_imovel, cod_conta, num_doc, tipo_doc, historico, participante_doc,
           participante_nome, natureza, valor, status, motor, confianca)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'previa', 'manual', 1)`
      )
      .run(
        p.id,
        String(b.data || "").slice(0, 10) || null,
        b.codImovel == null || b.codImovel === "" ? null : Number(b.codImovel),
        Number(b.codConta ?? 999),
        String(b.numDoc || "").slice(0, 60) || null,
        [1, 2, 3, 4, 5, 6].includes(Number(b.tipoDoc)) ? Number(b.tipoDoc) : 6,
        String(b.historico || "").slice(0, 200) || null,
        soDigitos(b.participanteDoc) || null,
        String(b.participanteNome || "").slice(0, 120) || null,
        b.natureza,
        Math.abs(Number(b.valor) || 0) || null
      );
    res.json({ id: Number(r.lastInsertRowid) });
  });

  // Literal antes do :id — ver aviso no começo do bloco de rotas.
  app.post("/api/rural/lancamentos/aprovar", d.blockCliente, editar, (req, res) => {
    const user = (req as any).user;
    const p = produtorDoUsuario(user, Number(req.body?.produtorId));
    if (!p) return res.status(404).json({ error: "Escrituração não encontrada." });
    const ids: number[] = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter(Number.isInteger) : [];
    if (!ids.length) return res.status(400).json({ error: "Nenhum lançamento selecionado." });

    // Só aprova o que está completo — um lançamento sem data, valor, imóvel ou participante quebra
    // o LCDPR depois, e é bem mais barato recusar aqui do que descobrir no e-CAC.
    const prontos: number[] = [];
    const recusados: { id: number; motivo: string }[] = [];
    for (const id of ids) {
      const l = sqlite.prepare(`SELECT * FROM rural_lancamentos WHERE id = ? AND produtor_id = ?`).get(id, p.id) as any;
      if (!l) continue;
      const faltando: string[] = [];
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(l.data || ""))) faltando.push("data");
      else if (String(l.data).slice(0, 4) !== String(p.ano)) faltando.push(`data fora de ${p.ano}`);
      if (!(Math.abs(Number(l.valor) || 0) > 0)) faltando.push("valor");
      if (!String(l.historico || "").trim()) faltando.push("histórico");
      const pd = soDigitos(l.participante_doc);
      if (pd.length !== 11 && pd.length !== 14) faltando.push("CPF/CNPJ do participante");
      if (l.cod_imovel == null) faltando.push("imóvel");
      if (!NATUREZAS.includes(l.natureza)) faltando.push("natureza");
      if (faltando.length) recusados.push({ id, motivo: `falta ${faltando.join(", ")}` });
      else prontos.push(id);
    }
    const upd = sqlite.prepare(`UPDATE rural_lancamentos SET status = 'aprovado', aprovado_por = ?, aprovado_em = datetime('now') WHERE id = ?`);
    for (const id of prontos) upd.run(user.id, id);
    res.json({ aprovados: prontos.length, recusados });
  });

  // Preencher imóvel/conta linha por linha em 200 notas é inviável, e são justamente os dois campos
  // que o classificador não consegue adivinhar (o XML não diz por qual conta o dinheiro passou nem a
  // qual fazenda a despesa pertence). Aqui o contador marca um bloco e define de uma vez.
  app.post("/api/rural/lancamentos/aplicar-em-lote", d.blockCliente, editar, (req, res) => {
    const p = produtorDoUsuario((req as any).user, Number(req.body?.produtorId));
    if (!p) return res.status(404).json({ error: "Escrituração não encontrada." });
    const ids: number[] = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter(Number.isInteger) : [];
    if (!ids.length) return res.status(400).json({ error: "Nenhum lançamento selecionado." });
    const b = req.body || {};

    const sets: string[] = [];
    const valores: any[] = [];
    if (b.codImovel !== undefined && b.codImovel !== "") {
      const ci = Number(b.codImovel);
      // 0 é o "000" do leiaute: despesa de condomínio/parceria que afeta vários imóveis.
      if (ci !== 0 && !(sqlite.prepare(`SELECT 1 FROM rural_imoveis WHERE produtor_id = ? AND cod_imovel = ?`).get(p.id, ci) as any))
        return res.status(400).json({ error: "Imóvel não cadastrado nesta escrituração." });
      sets.push("cod_imovel = ?");
      valores.push(ci);
    }
    if (b.codConta !== undefined && b.codConta !== "") {
      const cc = Number(b.codConta);
      if (cc !== 0 && cc !== 999 && !(sqlite.prepare(`SELECT 1 FROM rural_contas WHERE produtor_id = ? AND cod_conta = ?`).get(p.id, cc) as any))
        return res.status(400).json({ error: "Conta bancária não cadastrada nesta escrituração." });
      sets.push("cod_conta = ?");
      valores.push(cc);
    }
    if (b.natureza !== undefined && b.natureza !== "") {
      if (!NATUREZAS.includes(b.natureza)) return res.status(400).json({ error: "Natureza inválida." });
      sets.push("natureza = ?");
      valores.push(b.natureza);
    }
    if (!sets.length) return res.status(400).json({ error: "Escolha o que aplicar (imóvel, conta ou natureza)." });

    // Só mexe no que ainda é prévia — lançamento aprovado tem que ser reaberto antes, de propósito.
    const marcadores = ids.map(() => "?").join(",");
    const r = sqlite
      .prepare(`UPDATE rural_lancamentos SET ${sets.join(", ")} WHERE produtor_id = ? AND status = 'previa' AND id IN (${marcadores})`)
      .run(...valores, p.id, ...ids);
    res.json({ ok: true, alterados: Number(r.changes || 0) });
  });

  app.post("/api/rural/lancamentos/reabrir", d.blockCliente, editar, (req, res) => {
    const p = produtorDoUsuario((req as any).user, Number(req.body?.produtorId));
    if (!p) return res.status(404).json({ error: "Escrituração não encontrada." });
    const ids: number[] = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter(Number.isInteger) : [];
    const upd = sqlite.prepare(`UPDATE rural_lancamentos SET status = 'previa', aprovado_por = NULL, aprovado_em = NULL WHERE id = ? AND produtor_id = ?`);
    for (const id of ids) upd.run(id, p.id);
    res.json({ ok: true, reabertos: ids.length });
  });

  app.put("/api/rural/lancamentos/:id", d.blockCliente, editar, (req, res) => {
    const user = (req as any).user;
    const l = sqlite.prepare(`SELECT * FROM rural_lancamentos WHERE id = ?`).get(Number(req.params.id)) as any;
    if (!l) return res.status(404).json({ error: "Lançamento não encontrado." });
    const p = produtorDoUsuario(user, l.produtor_id);
    if (!p) return res.status(404).json({ error: "Lançamento não encontrado." });
    const b = req.body || {};
    const natureza = NATUREZAS.includes(b.natureza) ? b.natureza : l.natureza;
    const participanteDoc = b.participanteDoc !== undefined ? soDigitos(b.participanteDoc) || null : l.participante_doc;

    sqlite
      .prepare(
        `UPDATE rural_lancamentos SET data=?, cod_imovel=?, cod_conta=?, num_doc=?, tipo_doc=?, historico=?, participante_doc=?,
           participante_nome=?, natureza=?, valor=? WHERE id = ?`
      )
      .run(
        b.data !== undefined ? String(b.data || "").slice(0, 10) || null : l.data,
        b.codImovel !== undefined ? (b.codImovel === "" || b.codImovel == null ? null : Number(b.codImovel)) : l.cod_imovel,
        b.codConta !== undefined ? Number(b.codConta ?? 999) : l.cod_conta,
        b.numDoc !== undefined ? String(b.numDoc || "").slice(0, 60) || null : l.num_doc,
        b.tipoDoc !== undefined && [1, 2, 3, 4, 5, 6].includes(Number(b.tipoDoc)) ? Number(b.tipoDoc) : l.tipo_doc,
        b.historico !== undefined ? String(b.historico || "").slice(0, 200) || null : l.historico,
        participanteDoc,
        b.participanteNome !== undefined ? String(b.participanteNome || "").slice(0, 120) || null : l.participante_nome,
        natureza,
        b.valor !== undefined ? Math.abs(Number(b.valor) || 0) || null : l.valor,
        l.id
      );

    // Aprendizado: o contador mudou a natureza/tipo de um documento com contraparte conhecida.
    // Guarda a correção pro mesmo fornecedor vir certo da próxima vez (no escritório todo).
    if (participanteDoc && natureza !== l.natureza && l.documento_id) {
      const doc = sqlite.prepare(`SELECT tipo_detectado FROM rural_documentos WHERE id = ?`).get(l.documento_id) as any;
      sqlite
        .prepare(
          `INSERT INTO rural_regras (escritorio_id, participante_doc, tipo, natureza, atualizado_em) VALUES (?, ?, ?, ?, datetime('now'))
           ON CONFLICT(escritorio_id, participante_doc) DO UPDATE SET tipo = excluded.tipo, natureza = excluded.natureza,
             vezes = vezes + 1, atualizado_em = datetime('now')`
        )
        .run(p.escritorio_id, participanteDoc, doc?.tipo_detectado || null, natureza);
    }
    res.json({ ok: true });
  });

  app.delete("/api/rural/lancamentos/:id", d.blockCliente, editar, (req, res) => {
    const user = (req as any).user;
    const l = sqlite.prepare(`SELECT * FROM rural_lancamentos WHERE id = ?`).get(Number(req.params.id)) as any;
    if (!l || !produtorDoUsuario(user, l.produtor_id)) return res.status(404).json({ error: "Lançamento não encontrado." });
    sqlite.prepare(`DELETE FROM rural_lancamentos WHERE id = ?`).run(l.id);
    res.json({ ok: true });
  });

  // ---- Extrato ----
  app.get("/api/rural/extrato", d.blockCliente, ver, (req, res) => {
    const p = produtorDoUsuario((req as any).user, Number(req.query.produtorId));
    if (!p) return res.status(404).json({ error: "Escrituração não encontrada." });
    const transacoes = sqlite
      .prepare(`SELECT * FROM rural_extrato_transacoes WHERE produtor_id = ? ORDER BY data, id`)
      .all(p.id) as any[];
    // Saldo por conta no fim do ano — é o número que vai pra ficha de Bens e Direitos do IRPF.
    const porConta = new Map<number | null, { entradas: number; saidas: number }>();
    for (const t of transacoes) {
      const k = t.cod_conta == null ? null : Number(t.cod_conta);
      if (!porConta.has(k)) porConta.set(k, { entradas: 0, saidas: 0 });
      const acc = porConta.get(k)!;
      if (Number(t.valor) >= 0) acc.entradas += Number(t.valor);
      else acc.saidas += Math.abs(Number(t.valor));
    }
    res.json({
      transacoes,
      resumo: [...porConta.entries()].map(([codConta, v]) => ({ codConta, ...v, movimentoLiquido: v.entradas - v.saidas })),
    });
  });

  // ---- Demonstrativo e fechamento ----
  app.get("/api/rural/demonstrativo", d.blockCliente, ver, (req, res) => {
    const p = produtorDoUsuario((req as any).user, Number(req.query.produtorId));
    if (!p) return res.status(404).json({ error: "Escrituração não encontrada." });
    const demo = apurar(p.id);
    const pendencias = validarLcdpr(montarParamsLcdpr(p));
    res.json({
      demonstrativo: demo,
      pendencias,
      // O LCDPR só é obrigatório acima deste limite (art. 23-A da IN SRF 83/2001, com a redação da
      // IN RFB 1.848/2018) — abaixo dele a entrega é facultativa, e o arquivo continua valendo
      // como escrituração organizada.
      limiteObrigatoriedade: 4800000,
      obrigadoLcdpr: demo.receitaBruta > 4800000,
    });
  });

  app.get("/api/rural/lcdpr", d.blockCliente, ver, (req, res) => {
    const p = produtorDoUsuario((req as any).user, Number(req.query.produtorId));
    if (!p) return res.status(404).json({ error: "Escrituração não encontrada." });
    const params = montarParamsLcdpr(p);
    const pendencias = validarLcdpr(params);
    if (pendencias.some((x) => x.gravidade === "erro"))
      return res.status(400).json({ error: "Há pendências que impedem gerar o arquivo.", pendencias });
    const resultado = gerarLcdpr(params);
    const nome = `LCDPR-${soDigitos(p.cpf) || "produtor"}-${p.ano}.txt`;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${nome}"`);
    res.send(Buffer.from(resultado.conteudo, "utf8"));
  });

  // Mesma geração, mas devolvendo os números em JSON — a tela mostra o que vai no arquivo antes de
  // o contador baixar e assinar.
  app.get("/api/rural/lcdpr/previa", d.blockCliente, ver, (req, res) => {
    const p = produtorDoUsuario((req as any).user, Number(req.query.produtorId));
    if (!p) return res.status(404).json({ error: "Escrituração não encontrada." });
    const params = montarParamsLcdpr(p);
    const pendencias = validarLcdpr(params);
    const temErro = pendencias.some((x) => x.gravidade === "erro");
    const resultado = temErro ? null : gerarLcdpr(params);
    res.json({
      pendencias,
      podeGerar: !temErro,
      resumo: resultado
        ? {
            qtdLinhas: resultado.qtdLinhas,
            totalEntradas: resultado.totalEntradas,
            totalSaidas: resultado.totalSaidas,
            saldoFinal: resultado.saldoFinal,
            resumoMensal: resultado.resumoMensal,
            // Primeiras linhas do arquivo pro contador conferir o cabeçalho antes de baixar.
            amostra: resultado.conteudo.split("\r\n").slice(0, 8),
          }
        : null,
    });
  });
}

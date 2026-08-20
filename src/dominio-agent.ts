import "dotenv/config";
import path from "path";
import fs from "fs";

/**
 * Agente de sincronização com o Domínio Web.
 *
 * A configuração de acesso (banco de dados, API HTTP, ou login web do Onvio) é escolhida na tela
 * **Configurações › Domínio Web** do site — não precisa editar o .env deste agente na mão pra
 * trocar isso. A cada ciclo, este processo busca a configuração salva na nuvem
 * (`GET /api/dominio-agent/config`) e usa ela. Se algum campo não estiver preenchido lá, cai para
 * a variável de ambiente equivalente (útil se você preferir manter segredos só localmente, nunca
 * salvos no banco do site).
 *
 * Modo "onvio" (o que realmente funciona pra puxar clientes do Domínio Web/Onvio, descoberto na
 * prática): usa uma sessão de navegador salva localmente, porque o login do Onvio exige
 * verificação em duas etapas (SMS/e-mail) que este agente não tem como resolver sozinho.
 * Rode `npm run onvio-login` NESTA MÁQUINA uma vez (abre um navegador visível, você loga
 * normalmente incluindo o código) — a sessão fica salva em `data/onvio-session.json` e este
 * agente reaproveita ela. Só precisa repetir esse login se a sessão expirar (o agente avisa no
 * log quando isso acontecer).
 *
 * Rode este processo numa máquina com acesso à fonte de dados do Domínio Web (não precisa ser a
 * mesma do agente do painellibra). Ele só faz leitura e só envia nome/CNPJ/código/status/contato
 * de cada cliente — nenhum dado fiscal/contábil detalhado (isso continua sendo feito manualmente
 * via Envio de Documentos, porque não existe API pra ler relatórios contábeis do Domínio).
 */

const CLOUD_URL = (process.env.CLOUD_URL || "http://localhost:3000").replace(/\/$/, "");
const AGENT_TOKEN = process.env.DOMINIO_AGENT_TOKEN || "";
const SYNC_POLL_MINUTES = process.env.DOMINIO_AGENT_POLL_MINUTES ? Number(process.env.DOMINIO_AGENT_POLL_MINUTES) : 60;
const FAST_POLL_SECONDS = 12; // heartbeat + testes de conexão pedidos pela tela — precisa ser rápido pro botão "Testar" responder logo
const AGENT_VERSION = "dominio-agent-2-2026-08-18";

type Config = {
  source: string;
  dbDriver: string;
  dbHost: string;
  dbPort: number | null;
  dbName: string;
  dbUser: string;
  dbPassword: string;
  dbConnectString: string;
  queryClientes: string;
  colCodigo: string;
  colNome: string;
  colCnpj: string;
  colStatus: string;
  apiUrl: string;
  apiToken: string;
};

// Config vinda da nuvem tem prioridade; campo vazio cai para a variável de ambiente local.
async function carregarConfig(): Promise<Config> {
  let remoto: Partial<Config> = {};
  try {
    remoto = await cloudFetch("/api/dominio-agent/config");
  } catch (e: any) {
    console.error("Não consegui buscar a configuração na nuvem, usando só o .env local:", e.message);
  }
  return {
    source: remoto.source || process.env.DOMINIO_SOURCE || "",
    dbDriver: remoto.dbDriver || process.env.DOMINIO_DB_DRIVER || "",
    dbHost: remoto.dbHost || process.env.DOMINIO_DB_HOST || "",
    dbPort: remoto.dbPort || (process.env.DOMINIO_DB_PORT ? Number(process.env.DOMINIO_DB_PORT) : null),
    dbName: remoto.dbName || process.env.DOMINIO_DB_NAME || "",
    dbUser: remoto.dbUser || process.env.DOMINIO_DB_USER || "",
    dbPassword: remoto.dbPassword || process.env.DOMINIO_DB_PASSWORD || "",
    dbConnectString: remoto.dbConnectString || process.env.DOMINIO_DB_CONNECT_STRING || "",
    queryClientes: remoto.queryClientes || process.env.DOMINIO_QUERY_CLIENTES || "",
    colCodigo: remoto.colCodigo || process.env.DOMINIO_COL_CODIGO || "CODIGO",
    colNome: remoto.colNome || process.env.DOMINIO_COL_NOME || "NOME",
    colCnpj: remoto.colCnpj || process.env.DOMINIO_COL_CNPJ || "CNPJ",
    colStatus: remoto.colStatus || process.env.DOMINIO_COL_STATUS || "STATUS",
    apiUrl: remoto.apiUrl || process.env.DOMINIO_API_URL || "",
    apiToken: remoto.apiToken || process.env.DOMINIO_API_TOKEN || "",
  };
}

type EmpresaNormalizada = {
  codigo: string;
  nome: string;
  cnpj: string | null;
  ativo?: boolean;
  email?: string | null;
  telefone?: string | null;
  endereco?: string | null;
  cidade?: string | null;
  uf?: string | null;
  cep?: string | null;
};

function normalizarLinha(row: Record<string, any>, cfg: Config): EmpresaNormalizada {
  const statusTxt = String(row[cfg.colStatus] ?? "").toLowerCase();
  const temStatus = row[cfg.colStatus] !== undefined && row[cfg.colStatus] !== null && row[cfg.colStatus] !== "";
  return {
    codigo: String(row[cfg.colCodigo] ?? "").trim(),
    nome: String(row[cfg.colNome] ?? "").trim(),
    cnpj: row[cfg.colCnpj] ? String(row[cfg.colCnpj]).trim() : null,
    ativo: temStatus ? !(statusTxt.includes("inativ") || statusTxt.includes("encerrad") || statusTxt === "0" || statusTxt === "n") : undefined,
  };
}

async function cloudFetch(urlPath: string, body?: any) {
  const r = await fetch(CLOUD_URL + urlPath, {
    method: body ? "POST" : "GET",
    headers: { "Content-Type": "application/json", "x-agent-token": AGENT_TOKEN },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) throw new Error(`${urlPath} -> HTTP ${r.status}`);
  return r.json();
}

// ---- Modo "db": banco de dados do Domínio Web acessível diretamente (ex.: rede local do escritório) ----
async function buscarViaBanco(cfg: Config): Promise<Record<string, any>[]> {
  if (!cfg.queryClientes) throw new Error("Defina a consulta SQL de clientes em Configurações › Domínio Web.");

  if (cfg.dbDriver === "mssql") {
    let mssql: any;
    try {
      mssql = require("mssql");
    } catch {
      throw new Error('Driver "mssql" não instalado nesta máquina. Rode: npm install mssql');
    }
    const pool = await mssql.connect({
      server: cfg.dbHost,
      port: cfg.dbPort || 1433,
      database: cfg.dbName,
      user: cfg.dbUser,
      password: cfg.dbPassword,
      options: { trustServerCertificate: true },
    });
    try {
      const result = await pool.request().query(cfg.queryClientes);
      return result.recordset;
    } finally {
      await pool.close();
    }
  }

  if (cfg.dbDriver === "oracle") {
    let oracledb: any;
    try {
      oracledb = require("oracledb");
    } catch {
      throw new Error('Driver "oracledb" não instalado nesta máquina. Rode: npm install oracledb');
    }
    oracledb.fetchAsString = [oracledb.CLOB];
    const conn = await oracledb.getConnection({
      user: cfg.dbUser,
      password: cfg.dbPassword,
      connectString: cfg.dbConnectString,
    });
    try {
      const result = await conn.execute(cfg.queryClientes, [], { outFormat: oracledb.OUT_FORMAT_OBJECT });
      return (result.rows || []) as Record<string, any>[];
    } finally {
      await conn.close();
    }
  }

  throw new Error('Escolha o driver do banco ("mssql" ou "oracle") em Configurações › Domínio Web.');
}

// ---- Modo "http": Domínio Web/TOTVS expõe uma API HTTP com a lista de clientes ----
async function buscarViaHttp(cfg: Config): Promise<Record<string, any>[]> {
  if (!cfg.apiUrl) throw new Error("Preencha a URL da API em Configurações › Domínio Web.");
  const r = await fetch(cfg.apiUrl, {
    headers: cfg.apiToken ? { Authorization: `Bearer ${cfg.apiToken}` } : undefined,
  });
  if (!r.ok) throw new Error(`Domínio Web API -> HTTP ${r.status}`);
  const data = await r.json();
  return Array.isArray(data) ? data : data.items || data.clientes || [];
}

// ---- Modo "onvio": login web do Domínio Web/Onvio (Thomson Reuters) — sem API de leitura
// documentada, então usamos a mesma chamada interna que a própria tela do Onvio usa, com uma
// sessão de navegador já autenticada (ver npm run onvio-login). Precisa do pacote "playwright"
// instalado nesta máquina (só aqui no agente — o servidor na nuvem não precisa dele).
const ONVIO_SESSION_PATH = process.env.DOMINIO_ONVIO_SESSION_PATH || path.join(__dirname, "..", "data", "onvio-session.json");

function extrairContato(item: any) {
  const c = item?.primaryContactExpanded || {};
  const email = (c.emailAddresses || []).find((e: any) => e.isPrimary)?.emailAddress || (c.emailAddresses || [])[0]?.emailAddress || null;
  const telefone = (c.phoneNumbers || []).find((p: any) => p.isPrimary)?.phoneNumber || (c.phoneNumbers || [])[0]?.phoneNumber || null;
  const end = (c.addresses || []).find((a: any) => a.isPrimary) || (c.addresses || [])[0];
  const endereco = end ? [end.addressLine1, end.addressLine3].filter(Boolean).join(", ").trim() || null : null;
  const cidade = end?.city || null;
  const uf = end?.stateProvince?.id ? String(end.stateProvince.id).replace("BR-", "") : null;
  const cep = end?.postalCode || null;
  return { email, telefone, endereco, cidade, uf, cep };
}
function extrairDocumento(item: any): string | null {
  const nats = item?.primaryContactExpanded?.nationalIdentitiesExpanded || [];
  const cnpj = nats.find((n: any) => n.kind?.id === "BR-CNPJ" && n.identity);
  const cpf = nats.find((n: any) => n.kind?.id === "BR-CPF" && n.identity);
  return cnpj?.identity || cpf?.identity || null;
}

async function buscarViaOnvio(): Promise<EmpresaNormalizada[]> {
  if (!fs.existsSync(ONVIO_SESSION_PATH)) {
    throw new Error(`Sessão do Onvio não encontrada em "${ONVIO_SESSION_PATH}". Rode "npm run onvio-login" nesta máquina pra criar.`);
  }
  let chromium: any;
  try {
    ({ chromium } = require("playwright"));
  } catch {
    throw new Error('Pacote "playwright" não instalado nesta máquina. Rode: npm install playwright');
  }

  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ storageState: ONVIO_SESSION_PATH });
    const page = await context.newPage();

    let authHeader: string | null = null;
    let companyId: string | null = null;
    page.on("request", (req: any) => {
      const m = req.url().match(/\/api\/core\/v3\/companies\/([A-Z0-9]+)\/clients\/search/);
      if (m && !companyId) {
        companyId = m[1];
        authHeader = req.headers()["authorization"] || null;
      }
    });

    await page.goto("https://onvio.com.br/br-api-integration/#/enable-clients", { waitUntil: "networkidle", timeout: 30000 });
    await page.waitForTimeout(2500);

    if (/\/login|auth\.thomsonreuters\.com/.test(page.url())) {
      throw new Error('A sessão do Onvio expirou ou foi desconectada. Rode "npm run onvio-login" de novo nesta máquina pra renovar.');
    }
    if (!authHeader || !companyId) {
      throw new Error("Não consegui identificar a empresa/token do Onvio nesta sessão — tente rodar \"npm run onvio-login\" de novo.");
    }

    const resp = await page.request.post(`https://onvio.com.br/api/core/v3/companies/${companyId}/clients/search`, {
      headers: { authorization: authHeader },
      data: {
        pagingDataRequest: { startIndex: 1, pageIndex: 1, itemsPerPage: 500 },
        expand: "primaryContactExpanded,primaryContactExpanded.nationalIdentitiesExpanded",
        filterSearchSort: {},
      },
    });
    if (!resp.ok()) throw new Error(`Onvio API -> HTTP ${resp.status()}`);
    const json = await resp.json();
    const items = (json.items || []) as any[];

    return items
      .filter((it) => it.code && it.code !== "FIRM" && !/^EMPRESA EXEMPLO/i.test(it.name || ""))
      .map((it) => {
        const contato = extrairContato(it);
        return {
          codigo: String(it.code),
          nome: String(it.name || "").trim(),
          cnpj: extrairDocumento(it),
          ...contato,
          // situação (ativo/inativo) não vem nessa API — a sincronização automática não mexe
          // nisso pra não reativar/desativar empresa por engano (ver server.ts, COALESCE(ativo)).
        };
      });
  } finally {
    await browser.close();
  }
}

async function buscarClientes(cfg: Config): Promise<EmpresaNormalizada[]> {
  if (cfg.source === "onvio") return buscarViaOnvio();
  if (cfg.source === "db") return (await buscarViaBanco(cfg)).map((r) => normalizarLinha(r, cfg));
  if (cfg.source === "http") return (await buscarViaHttp(cfg)).map((r) => normalizarLinha(r, cfg));
  throw new Error('Escolha a forma de acesso ("Banco de dados", "API HTTP" ou "Onvio") em Configurações › Domínio Web.');
}

// Testes de conexão pedidos pela tela (botão "Testar") — executa a consulta configurada e devolve
// uma amostra pequena, sem gravar nada em empresas (é só um diagnóstico).
async function processarTestesPendentes(cfg: Config, testJobs: any[]) {
  for (const job of testJobs) {
    try {
      const linhas = await buscarClientes(cfg);
      const colunas = linhas.length ? Object.keys(linhas[0]) : [];
      await cloudFetch("/api/dominio-agent/teste-resultado", {
        jobId: job.id,
        ok: true,
        resultado: { totalLinhas: linhas.length, colunas, amostra: linhas.slice(0, 3) },
      });
      console.log(`[teste de conexão #${job.id}] OK — ${linhas.length} linha(s).`);
    } catch (e: any) {
      await cloudFetch("/api/dominio-agent/teste-resultado", { jobId: job.id, ok: false, erro: e.message });
      console.error(`[teste de conexão #${job.id}] falhou:`, e.message);
    }
  }
}

async function sincronizarClientes(cfg: Config) {
  const linhas = await buscarClientes(cfg);
  const items = linhas.filter((it) => it.codigo && it.nome);
  const resultado = await cloudFetch("/api/dominio-agent/empresas", { items });
  return { ...resultado, lidos: items.length };
}

// Pedidos de sincronização imediata (botão "Atualizar Empresas" na tela de Empresas) — atendido
// no ciclo rápido, sem esperar o ritmo automático de SYNC_POLL_MINUTES.
async function processarSincronizacoesPendentes(cfg: Config, syncJobs: any[]) {
  for (const job of syncJobs) {
    try {
      if (!cfg.source) throw new Error("Forma de acesso ao Domínio Web ainda não configurada (Configurações › Domínio Web).");
      const r = await sincronizarClientes(cfg);
      await cloudFetch("/api/dominio-agent/sincronizar-resultado", { jobId: job.id, ok: true, novas: r.novas, atualizadas: r.atualizadas });
      console.log(`[Atualizar Empresas #${job.id}] ${r.novas} nova(s), ${r.atualizadas} atualizada(s) de ${r.lidos} cliente(s) lido(s).`);
      proximaSincroniaEm = Date.now() + SYNC_POLL_MINUTES * 60 * 1000; // adia o próximo ciclo automático, já que acabou de sincronizar
    } catch (e: any) {
      await cloudFetch("/api/dominio-agent/sincronizar-resultado", { jobId: job.id, ok: false, erro: e.message });
      console.error(`[Atualizar Empresas #${job.id}] falhou:`, e.message);
    }
  }
}

let proximaSincroniaEm = 0; // timestamp — a sincronia completa de clientes só roda a cada SYNC_POLL_MINUTES
async function tick() {
  if (!AGENT_TOKEN) {
    console.error("DOMINIO_AGENT_TOKEN não definido — precisa ser o mesmo token configurado na nuvem (variável DOMINIO_AGENT_TOKEN lá também).");
    return;
  }
  let work: any;
  try {
    work = await cloudFetch("/api/dominio-agent/heartbeat", { version: AGENT_VERSION }).then(() => cloudFetch("/api/dominio-agent/work"));
  } catch (e: any) {
    console.error("Não consegui falar com a nuvem:", e.message);
    return;
  }

  const cfg = await carregarConfig();
  await processarTestesPendentes(cfg, work.testJobs || []); // roda toda vez (rápido) — é o que o botão "Testar" espera
  await processarSincronizacoesPendentes(cfg, work.syncJobs || []); // idem, pro botão "Atualizar Empresas"

  if (!cfg.source) return;
  if (Date.now() < proximaSincroniaEm) return; // sincronia automática só no ritmo configurado (padrão 60min)

  try {
    const r = await sincronizarClientes(cfg);
    console.log(`Sincronizado: ${r.novas} nova(s), ${r.atualizadas} atualizada(s) de ${r.lidos} cliente(s) lido(s).`);
  } catch (e: any) {
    console.error("Falha ao sincronizar clientes do Domínio Web:", e.message);
  } finally {
    proximaSincroniaEm = Date.now() + SYNC_POLL_MINUTES * 60 * 1000;
  }
}

console.log("Agente do Domínio Web iniciado.");
console.log(`Nuvem: ${CLOUD_URL}`);
console.log(`Heartbeat/testes de conexão a cada ${FAST_POLL_SECONDS}s. Sincronia completa de clientes a cada ${SYNC_POLL_MINUTES} minuto(s).`);

let tickEmAndamento = false;
async function agendarProximoTick() {
  if (tickEmAndamento) return;
  tickEmAndamento = true;
  try {
    await tick();
  } catch (e: any) {
    console.error("Erro inesperado no tick:", e.message);
  } finally {
    tickEmAndamento = false;
    setTimeout(agendarProximoTick, FAST_POLL_SECONDS * 1000);
  }
}
agendarProximoTick();

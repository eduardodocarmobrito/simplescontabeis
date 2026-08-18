import "dotenv/config";

/**
 * Agente de sincronização com o Domínio Web.
 *
 * A configuração de acesso (banco de dados ou API) é preenchida na tela **Configurações › Domínio
 * Web** do site — não precisa mais editar o .env deste agente na mão. A cada ciclo, este processo
 * busca a configuração salva na nuvem (`GET /api/dominio-agent/config`) e usa ela. Se algum campo
 * não estiver preenchido lá, cai para a variável de ambiente equivalente (útil se você preferir
 * manter segredos só localmente, nunca salvos no banco do site).
 *
 * Rode este processo numa máquina com acesso à fonte de dados do Domínio Web (não precisa ser a
 * mesma do agente do painellibra). Ele só faz leitura e só envia nome/CNPJ/código/status de cada
 * cliente — nenhum dado fiscal/contábil detalhado ainda (isso é o próximo passo, depois que a
 * sincronização de clientes estiver validada).
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

function normalizarLinha(row: Record<string, any>, cfg: Config) {
  const status = String(row[cfg.colStatus] ?? "").toLowerCase();
  const ativo = !(status.includes("inativ") || status.includes("encerrad") || status === "0" || status === "n");
  return {
    codigo: String(row[cfg.colCodigo] ?? "").trim(),
    nome: String(row[cfg.colNome] ?? "").trim(),
    cnpj: row[cfg.colCnpj] ? String(row[cfg.colCnpj]).trim() : null,
    ativo,
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

async function buscarClientes(cfg: Config): Promise<Record<string, any>[]> {
  if (cfg.source === "db") return buscarViaBanco(cfg);
  if (cfg.source === "http") return buscarViaHttp(cfg);
  throw new Error('Escolha a forma de acesso ("Banco de dados" ou "API HTTP") em Configurações › Domínio Web.');
}

// Testes de conexão pedidos pela tela (botão "Testar") — executa a consulta configurada e devolve
// uma amostra pequena, sem gravar nada em empresas (é só um diagnóstico).
async function processarTestesPendentes(cfg: Config) {
  let work: any;
  try {
    work = await cloudFetch("/api/dominio-agent/work");
  } catch (e: any) {
    console.error("Não consegui buscar testes pendentes:", e.message);
    return;
  }
  for (const job of work.testJobs || []) {
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

let proximaSincroniaEm = 0; // timestamp — a sincronia completa de clientes só roda a cada SYNC_POLL_MINUTES
async function tick() {
  if (!AGENT_TOKEN) {
    console.error("DOMINIO_AGENT_TOKEN não definido — precisa ser o mesmo token configurado na nuvem (variável DOMINIO_AGENT_TOKEN lá também).");
    return;
  }
  try {
    await cloudFetch("/api/dominio-agent/heartbeat", { version: AGENT_VERSION });
  } catch (e: any) {
    console.error("Não consegui falar com a nuvem:", e.message);
    return;
  }

  const cfg = await carregarConfig();
  await processarTestesPendentes(cfg); // roda toda vez (rápido) — é o que o botão "Testar" espera

  if (!cfg.source) return;
  if (Date.now() < proximaSincroniaEm) return; // sincronia completa só no ritmo configurado (padrão 60min)

  try {
    const linhas = await buscarClientes(cfg);
    const items = linhas.map((l) => normalizarLinha(l, cfg)).filter((it) => it.codigo && it.nome);
    const resultado = await cloudFetch("/api/dominio-agent/empresas", { items });
    console.log(`Sincronizado: ${resultado.novas} nova(s), ${resultado.atualizadas} atualizada(s) de ${items.length} cliente(s) lido(s).`);
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

import "dotenv/config";

/**
 * Agente de sincronização com o Domínio Web.
 *
 * Ainda não sei qual é a forma de acesso que você tem ao Domínio Web (banco de dados direto,
 * numa rede local/VPN — como o agente do painellibra fala com o Oracle do Sankhya —, ou uma API
 * HTTP que o Domínio/TOTVS expõe). Por isso este agente é genérico: você escolhe o modo em
 * DOMINIO_SOURCE no .env e preenche só a seção correspondente. Enquanto isso não está definido,
 * o caminho que já funciona hoje é a importação manual de CSV (tela Configurações › Domínio Web
 * no site, endpoint /api/dominio/importar-clientes), exportando a lista de clientes direto do
 * Domínio Web.
 *
 * Rode este processo numa máquina com acesso à fonte de dados do Domínio Web (não precisa ser a
 * mesma do agente do painellibra). Ele só faz leitura e só envia nome/CNPJ/código/status de cada
 * cliente — nenhum dado fiscal/contábil detalhado ainda (isso é o próximo passo, depois que a
 * sincronização de clientes estiver validada).
 */

const CLOUD_URL = (process.env.CLOUD_URL || "http://localhost:3000").replace(/\/$/, "");
const AGENT_TOKEN = process.env.DOMINIO_AGENT_TOKEN || "";
const POLL_MINUTES = process.env.DOMINIO_AGENT_POLL_MINUTES ? Number(process.env.DOMINIO_AGENT_POLL_MINUTES) : 60;
const AGENT_VERSION = "dominio-agent-1-2026-08-17";

const SOURCE = (process.env.DOMINIO_SOURCE || "").toLowerCase(); // 'db' | 'http' | '' (desligado)

// Mapeamento de colunas/campos da fonte do Domínio Web para o formato que o site espera
const COL_CODIGO = process.env.DOMINIO_COL_CODIGO || "CODIGO";
const COL_NOME = process.env.DOMINIO_COL_NOME || "NOME";
const COL_CNPJ = process.env.DOMINIO_COL_CNPJ || "CNPJ";
const COL_STATUS = process.env.DOMINIO_COL_STATUS || "STATUS";

function normalizarLinha(row: Record<string, any>) {
  const status = String(row[COL_STATUS] ?? "").toLowerCase();
  const ativo = !(status.includes("inativ") || status.includes("encerrad") || status === "0" || status === "n");
  return {
    codigo: String(row[COL_CODIGO] ?? "").trim(),
    nome: String(row[COL_NOME] ?? "").trim(),
    cnpj: row[COL_CNPJ] ? String(row[COL_CNPJ]).trim() : null,
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
async function buscarViaBanco(): Promise<Record<string, any>[]> {
  const driver = (process.env.DOMINIO_DB_DRIVER || "").toLowerCase(); // 'mssql' | 'oracle'
  const query = process.env.DOMINIO_QUERY_CLIENTES;
  if (!query) throw new Error("Defina DOMINIO_QUERY_CLIENTES no .env (SELECT que traz código, nome, cnpj e status dos clientes).");

  if (driver === "mssql") {
    let mssql: any;
    try {
      mssql = require("mssql");
    } catch {
      throw new Error('Driver "mssql" não instalado. Rode: npm install mssql');
    }
    const pool = await mssql.connect({
      server: process.env.DOMINIO_DB_HOST || "",
      port: process.env.DOMINIO_DB_PORT ? Number(process.env.DOMINIO_DB_PORT) : 1433,
      database: process.env.DOMINIO_DB_NAME || "",
      user: process.env.DOMINIO_DB_USER || "",
      password: process.env.DOMINIO_DB_PASSWORD || "",
      options: { trustServerCertificate: true },
    });
    try {
      const result = await pool.request().query(query);
      return result.recordset;
    } finally {
      await pool.close();
    }
  }

  if (driver === "oracle") {
    let oracledb: any;
    try {
      oracledb = require("oracledb");
    } catch {
      throw new Error('Driver "oracledb" não instalado. Rode: npm install oracledb');
    }
    oracledb.fetchAsString = [oracledb.CLOB];
    const conn = await oracledb.getConnection({
      user: process.env.DOMINIO_DB_USER || "",
      password: process.env.DOMINIO_DB_PASSWORD || "",
      connectString: process.env.DOMINIO_DB_CONNECT_STRING || "",
    });
    try {
      const result = await conn.execute(query, [], { outFormat: oracledb.OUT_FORMAT_OBJECT });
      return (result.rows || []) as Record<string, any>[];
    } finally {
      await conn.close();
    }
  }

  throw new Error('DOMINIO_DB_DRIVER precisa ser "mssql" ou "oracle".');
}

// ---- Modo "http": Domínio Web/TOTVS expõe uma API HTTP com a lista de clientes ----
async function buscarViaHttp(): Promise<Record<string, any>[]> {
  const url = process.env.DOMINIO_API_URL;
  if (!url) throw new Error("Defina DOMINIO_API_URL no .env.");
  const r = await fetch(url, {
    headers: process.env.DOMINIO_API_TOKEN ? { Authorization: `Bearer ${process.env.DOMINIO_API_TOKEN}` } : undefined,
  });
  if (!r.ok) throw new Error(`Domínio Web API -> HTTP ${r.status}`);
  const data = await r.json();
  return Array.isArray(data) ? data : data.items || data.clientes || [];
}

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

  if (!SOURCE) {
    console.log("DOMINIO_SOURCE não definido — agente só está enviando heartbeat. Use a importação manual de CSV por enquanto (Configurações › Domínio Web no site).");
    return;
  }

  try {
    const linhas = SOURCE === "db" ? await buscarViaBanco() : SOURCE === "http" ? await buscarViaHttp() : [];
    const items = linhas.map(normalizarLinha).filter((it) => it.codigo && it.nome);
    const resultado = await cloudFetch("/api/dominio-agent/empresas", { items });
    console.log(`Sincronizado: ${resultado.novas} nova(s), ${resultado.atualizadas} atualizada(s) de ${items.length} cliente(s) lido(s).`);
  } catch (e: any) {
    console.error("Falha ao sincronizar clientes do Domínio Web:", e.message);
  }
}

console.log("Agente do Domínio Web iniciado.");
console.log(`Nuvem: ${CLOUD_URL}`);
console.log(`Fonte configurada: ${SOURCE || "(nenhuma — só heartbeat)"}`);
console.log(`Verificando a cada ${POLL_MINUTES} minuto(s).`);

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
    setTimeout(agendarProximoTick, POLL_MINUTES * 60 * 1000);
  }
}
agendarProximoTick();

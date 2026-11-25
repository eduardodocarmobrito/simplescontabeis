// Integração com a API de Apuração da CBS / RAD (Recolhimento pelo Adquirente) da Receita Federal.
// Docs: https://docs.receitafederal.gov.br/apuracao-cbs — OAuth2 Client Credentials, Bearer token.
// Só há ambiente de PRODUÇÃO (sem sandbox); emissão plena do RAD a partir de jan/2027. As credenciais
// (URL do token + client_id/secret) vêm do Receita Integra/SERPRO e são configuradas POR ESCRITÓRIO,
// cifradas no banco. Este módulo NÃO foi testado contra a API real (depende das credenciais do titular).
const BASE = "https://api.receitafederal.gov.br/apuracao-cbs/v2";
const soDig = (s: string) => String(s || "").replace(/\D/g, "");
// Os endpoints usam a RAIZ do CNPJ (8 dígitos) do estabelecimento matriz. A doc do /rad é inconsistente
// (cita 14 em um ponto e usa 8 no exemplo); usamos 8 (raiz), conforme o exemplo oficial de /recolhimentos.
export const cnpjRaiz = (cnpj: string) => soDig(cnpj).slice(0, 8);

async function lerJson(res: Response, fallbackKey = "mensagem"): Promise<any> {
  const txt = await res.text();
  try { return { httpStatus: res.status, ...JSON.parse(txt) }; } catch { return { httpStatus: res.status, [fallbackKey]: txt.slice(0, 400) }; }
}

// OAuth2 Client Credentials — Basic auth (client_id:client_secret) + grant_type=client_credentials.
export async function obterToken(tokenUrl: string, clientId: string, clientSecret: string): Promise<{ accessToken: string; expiraEm: string }> {
  if (!tokenUrl) throw new Error("URL do token OAuth2 não configurada.");
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const res = await fetch(tokenUrl, {
    method: "POST",
    headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: "grant_type=client_credentials",
  });
  const txt = await res.text();
  if (!res.ok) throw new Error(`Falha ao obter token (HTTP ${res.status}): ${txt.slice(0, 300)}`);
  let j: any; try { j = JSON.parse(txt); } catch { throw new Error("Resposta do token não é JSON: " + txt.slice(0, 200)); }
  if (!j.access_token) throw new Error("Resposta do token não trouxe access_token.");
  const seg = Number(j.expires_in || 3600);
  return { accessToken: String(j.access_token), expiraEm: new Date(Date.now() + Math.max(60, seg - 60) * 1000).toISOString() };
}

export interface ItemDarf { chaveDFE: string; opcaoPagamento: "PAGAMENTO_TOTAL" | "PAGAMENTO_PARCIAL"; valorDarfParcial?: number }
// Gera o DARF da CBS paga como adquirente (síncrono). Body = array (uma entrada por DF-e).
export async function gerarDarf(accessToken: string, cnpj: string, itens: ItemDarf[]): Promise<any> {
  const res = await fetch(`${BASE}/rad/${cnpjRaiz(cnpj)}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(itens),
  });
  return lerJson(res, "mensagem");
}

// Solicita a consulta assíncrona dos recolhimentos (RAD) — retorna tiqueteSolicitacao.
export async function solicitarRecolhimentos(accessToken: string, cnpj: string, urlRetorno = ""): Promise<any> {
  const res = await fetch(`${BASE}/recolhimentos/${cnpjRaiz(cnpj)}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ urlRetorno }),
  });
  return lerJson(res, "mensagemErro");
}
export async function consultarSituacao(accessToken: string, tiquete: string): Promise<any> {
  const res = await fetch(`${BASE}/situacao/${encodeURIComponent(tiquete)}`, { headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" } });
  return lerJson(res, "mensagemErro");
}
export async function obterDownloadUrl(accessToken: string, tiquete: string): Promise<any> {
  const res = await fetch(`${BASE}/download/${encodeURIComponent(tiquete)}`, { headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" } });
  return lerJson(res, "mensagemErro");
}
// A urlAssinada é consumida por GET SEM Bearer e sem headers extras.
export async function baixarArquivo(urlAssinada: string): Promise<any> {
  const res = await fetch(urlAssinada);
  if (!res.ok) throw new Error(`Download do arquivo de retorno falhou (HTTP ${res.status}).`);
  return await res.json();
}

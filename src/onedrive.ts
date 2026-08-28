import https from "https";

/**
 * Integração com o OneDrive (Microsoft Graph) — sobe os documentos fiscais buscados direto da nuvem
 * pra pasta do OneDrive do usuário, sem depender de nenhum agente rodando localmente na máquina dele.
 *
 * Fluxo OAuth2 Authorization Code (aplicação web confidencial, client_secret) contra o endpoint
 * "consumers" (conta pessoal da Microsoft) — baseado na documentação oficial atual (Microsoft
 * identity platform, learn.microsoft.com/entra/identity-platform/v2-oauth2-auth-code-flow) e na
 * referência oficial do endpoint de upload simples (learn.microsoft.com/graph/api/driveitem-put-content).
 * Escopos: "Files.ReadWrite" (ler/escrever arquivos) + "offline_access" (obrigatório pra ganhar um
 * refresh_token — sem isso a sessão expira em ~1h e precisaria reautorizar toda hora).
 */

const TENANT = "consumers"; // conta pessoal da Microsoft (não é conta corporativa/Entra)
const AUTHORIZE_URL = `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/authorize`;
const TOKEN_URL = `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`;
const GRAPH_BASE = "https://graph.microsoft.com/v1.0";
// User.Read é só pra exibir "conectado como fulano@..." (GET /me) — sem ele o /me dá 401 mesmo com
// o access_token válido pra arquivos (confirmado em teste real: token exchange funcionou, só o /me
// falhava por faltar esse escopo).
export const ESCOPOS = "Files.ReadWrite offline_access User.Read";

export function montarUrlAutorizacao(clientId: string, redirectUri: string, state: string): string {
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: "code",
    redirect_uri: redirectUri,
    response_mode: "query",
    scope: ESCOPOS,
    state,
  });
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

interface RespostaToken {
  accessToken: string;
  refreshToken: string | null;
  expiresIn: number;
}
function chamarTokenEndpoint(corpo: Record<string, string>): Promise<RespostaToken> {
  return new Promise((resolve, reject) => {
    const bodyBuffer = Buffer.from(new URLSearchParams(corpo).toString(), "utf8");
    const url = new URL(TOKEN_URL);
    const req = https.request(
      {
        hostname: url.hostname,
        path: url.pathname,
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": String(bodyBuffer.length) },
        timeout: 20000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const bruto = Buffer.concat(chunks).toString("utf8");
          let json: any;
          try {
            json = JSON.parse(bruto);
          } catch {
            return reject(new Error(`Resposta inesperada da Microsoft (HTTP ${res.statusCode}): ${bruto.slice(0, 300)}`));
          }
          if ((res.statusCode || 0) < 200 || (res.statusCode || 0) >= 300) {
            console.error("onedrive token endpoint erro:", res.statusCode, bruto);
          }
          if ((res.statusCode || 0) >= 200 && (res.statusCode || 0) < 300) {
            resolve({ accessToken: json.access_token, refreshToken: json.refresh_token || null, expiresIn: json.expires_in || 3600 });
          } else {
            reject(new Error(json.error_description || json.error || `HTTP ${res.statusCode}: ${bruto.slice(0, 300)}`));
          }
        });
      }
    );
    req.on("timeout", () => req.destroy(new Error("Tempo esgotado ao conectar na Microsoft.")));
    req.on("error", reject);
    req.write(bodyBuffer);
    req.end();
  });
}
export function trocarCodePorToken(clientId: string, clientSecret: string, code: string, redirectUri: string): Promise<RespostaToken> {
  return chamarTokenEndpoint({ client_id: clientId, client_secret: clientSecret, code, redirect_uri: redirectUri, grant_type: "authorization_code", scope: ESCOPOS });
}
export function renovarAccessToken(clientId: string, clientSecret: string, refreshToken: string): Promise<RespostaToken> {
  return chamarTokenEndpoint({ client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: "refresh_token", scope: ESCOPOS });
}

function chamarGraph(caminho: string, accessToken: string, opts: { metodo?: string; corpo?: Buffer; contentType?: string } = {}): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(GRAPH_BASE + caminho);
    const headers: Record<string, string> = { Authorization: `Bearer ${accessToken}` };
    if (opts.corpo) {
      headers["Content-Type"] = opts.contentType || "application/octet-stream";
      headers["Content-Length"] = String(opts.corpo.length);
    }
    const req = https.request({ hostname: url.hostname, path: url.pathname + url.search, method: opts.metodo || "GET", headers, timeout: 30000 }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const texto = Buffer.concat(chunks).toString("utf8");
        let json: any = null;
        try {
          json = texto ? JSON.parse(texto) : null;
        } catch {
          /* resposta não era JSON */
        }
        resolve({ status: res.statusCode || 0, json });
      });
    });
    req.on("timeout", () => req.destroy(new Error("Tempo esgotado ao conectar no OneDrive.")));
    req.on("error", reject);
    if (opts.corpo) req.write(opts.corpo);
    req.end();
  });
}
export async function obterPerfil(accessToken: string): Promise<{ nome: string | null; email: string | null }> {
  const { status, json } = await chamarGraph("/me", accessToken);
  if (status !== 200) throw new Error(json?.error?.message || `HTTP ${status}`);
  return { nome: json.displayName || null, email: json.mail || json.userPrincipalName || null };
}
// Upload simples (PUT .../root:/{caminho}:/content) — cria pastas intermediárias automaticamente,
// suporta até 250MB (documentado oficialmente; nossos XMLs são poucos KB, bem dentro do limite).
export async function enviarArquivo(accessToken: string, caminhoCompleto: string, conteudo: Buffer): Promise<void> {
  const caminhoCodificado = caminhoCompleto
    .split("/")
    .map((parte) => encodeURIComponent(parte))
    .join("/");
  const { status, json } = await chamarGraph(`/me/drive/root:/${caminhoCodificado}:/content`, accessToken, {
    metodo: "PUT",
    corpo: conteudo,
    contentType: "text/xml",
  });
  if (status !== 200 && status !== 201) {
    throw new Error(json?.error?.message || `HTTP ${status}`);
  }
}

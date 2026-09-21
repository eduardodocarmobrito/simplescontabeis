import https from "https";
import crypto from "crypto";

/**
 * Integração com a WhatsApp Business Platform (Cloud API) da Meta — envio de documentos (NFS-e,
 * guias, relatórios) por WhatsApp, tanto manual quanto pela rotina automática.
 *
 * Construído a partir da documentação pública da Meta (developers.facebook.com/docs/whatsapp),
 * sem uma conta real em mãos pra testar ainda — é bem possível que algum campo precise de ajuste
 * no primeiro envio real, do mesmo jeito que aconteceu com nfse.ts e asaas.ts antes de funcionarem.
 *
 * Mensagem PROATIVA (o escritório manda sem o cliente ter escrito antes, que é o nosso caso) só é
 * permitida usando um modelo de mensagem (template) pré-aprovado pela Meta — não dá pra mandar
 * texto livre + anexo pra quem não iniciou conversa numa janela de 24h. Por isso todo envio aqui
 * passa por um template configurado em Configurações › WhatsApp.
 */

const GRAPH_BASE = "https://graph.facebook.com/v21.0";

interface RespostaWhatsapp {
  status: number;
  ok: boolean;
  corpo: any;
}

function mensagemErro(r: RespostaWhatsapp): string {
  const err = r.corpo?.error;
  if (err) return `${err.message || err.type || "erro"}${err.error_user_msg ? ` — ${err.error_user_msg}` : ""}`;
  return typeof r.corpo === "string" ? r.corpo : `HTTP ${r.status}`;
}

function chamarGraph(
  caminho: string,
  accessToken: string,
  opts: { jsonBody?: object; multipart?: { boundary: string; body: Buffer }; metodo?: "GET" | "POST" }
): Promise<RespostaWhatsapp> {
  return new Promise((resolve, reject) => {
    const url = new URL(GRAPH_BASE + caminho);
    let bodyBuffer: Buffer | undefined;
    const headers: Record<string, string> = { Authorization: `Bearer ${accessToken}` };
    if (opts.jsonBody) {
      bodyBuffer = Buffer.from(JSON.stringify(opts.jsonBody), "utf8");
      headers["Content-Type"] = "application/json";
    } else if (opts.multipart) {
      bodyBuffer = opts.multipart.body;
      headers["Content-Type"] = `multipart/form-data; boundary=${opts.multipart.boundary}`;
    }
    if (bodyBuffer) headers["Content-Length"] = String(bodyBuffer.length);
    const req = https.request(
      { hostname: url.hostname, path: url.pathname + url.search, method: opts.metodo || "POST", headers, timeout: 30000 },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const texto = Buffer.concat(chunks).toString("utf8");
          let json: any = null;
          try {
            json = JSON.parse(texto);
          } catch {
            /* resposta não era JSON */
          }
          resolve({ status: res.statusCode || 0, ok: (res.statusCode || 0) >= 200 && (res.statusCode || 0) < 300, corpo: json ?? texto });
        });
      }
    );
    req.on("timeout", () => req.destroy(new Error("Tempo esgotado ao conectar na Meta (WhatsApp).")));
    req.on("error", (e) => reject(e));
    if (bodyBuffer) req.write(bodyBuffer);
    req.end();
  });
}

function montarMultipart(campos: Record<string, string>, arquivo: { nome: string; tipo: string; buffer: Buffer }): { boundary: string; body: Buffer } {
  const boundary = "----wa" + crypto.randomBytes(16).toString("hex");
  const partes: Buffer[] = [];
  for (const [chave, valor] of Object.entries(campos)) {
    partes.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${chave}"\r\n\r\n${valor}\r\n`, "utf8"));
  }
  partes.push(
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${arquivo.nome}"\r\nContent-Type: ${arquivo.tipo}\r\n\r\n`, "utf8")
  );
  partes.push(arquivo.buffer);
  partes.push(Buffer.from(`\r\n--${boundary}--\r\n`, "utf8"));
  return { boundary, body: Buffer.concat(partes) };
}

// Sobe o arquivo pros servidores da Meta (obrigatório antes de referenciar num template com anexo)
// e devolve o media_id de uso único a ser citado na mensagem.
async function subirMidia(phoneNumberId: string, accessToken: string, arquivo: { nome: string; tipo: string; buffer: Buffer }): Promise<string> {
  const multipart = montarMultipart({ messaging_product: "whatsapp", type: arquivo.tipo }, arquivo);
  const r = await chamarGraph(`/${phoneNumberId}/media`, accessToken, { multipart });
  if (!r.ok) throw new Error(`Não consegui enviar o arquivo pro WhatsApp: ${mensagemErro(r)}`);
  return r.corpo.id;
}

export interface EnvioDocumentoParams {
  phoneNumberId: string;
  accessToken: string;
  templateName: string;
  templateIdioma: string;
  paraNumero: string; // aceita formatação livre (DDD, espaços, parênteses) — normalizado aqui
  // Preenchem as variáveis nomeadas do corpo do modelo (ex.: {{empresa_nome}}) — a Meta passou a
  // exigir parâmetro nomeado em vez de posicional ({{1}}, {{2}}) nos templates novos.
  variaveisCorpo: { nome: string; valor: string }[];
  arquivo: { nome: string; tipo: string; buffer: Buffer };
}
// Envia um documento (PDF) por WhatsApp usando um template aprovado com cabeçalho tipo "documento".
// Uso: rotina automática de NFS-e e o botão manual "Enviar por WhatsApp" em Envio de Documentos.
// Devolve o wamid (id da mensagem) — a Meta só confirma que ACEITOU o envio nessa resposta; o status
// real de entrega (entregue/lido/falhou) só chega depois, via webhook (ver POST /api/whatsapp/webhook
// em server.ts). Sem guardar o wamid não dá pra casar o status que chegar com o documento certo.
export async function enviarDocumento(params: EnvioDocumentoParams): Promise<{ wamid: string | null; numeroNormalizado: string }> {
  const digitos = params.paraNumero.replace(/\D/g, "");
  if (digitos.length < 10) throw new Error("Número de WhatsApp inválido — informe DDD + número.");
  // Números brasileiros sem o código do país (55) na frente — a Cloud API exige o código do país.
  const numero = digitos.length <= 11 ? `55${digitos}` : digitos;
  const mediaId = await subirMidia(params.phoneNumberId, params.accessToken, params.arquivo);
  const r = await chamarGraph(`/${params.phoneNumberId}/messages`, params.accessToken, {
    jsonBody: {
      messaging_product: "whatsapp",
      to: numero,
      type: "template",
      template: {
        name: params.templateName,
        language: { code: params.templateIdioma },
        components: [
          { type: "header", parameters: [{ type: "document", document: { id: mediaId, filename: params.arquivo.nome } }] },
          ...(params.variaveisCorpo.length
            ? [
                {
                  type: "body",
                  parameters: params.variaveisCorpo.map((v) => ({ type: "text", parameter_name: v.nome, text: v.valor })),
                },
              ]
            : []),
        ],
      },
    },
  });
  if (!r.ok) throw new Error(`Não consegui enviar a mensagem no WhatsApp: ${mensagemErro(r)}`);
  const wamid = r.corpo?.messages?.[0]?.id || null;
  return { wamid, numeroNormalizado: numero };
}

export interface EnvioTextoParams {
  phoneNumberId: string;
  accessToken: string;
  templateName: string;
  templateIdioma: string;
  paraNumero: string;
  variaveisCorpo: { nome: string; valor: string }[];
}
// Mesma ideia de enviarDocumento, mas pra um template SEM cabeçalho de documento (só corpo de
// texto) — usado pro aviso de "você tem uma mensagem nova" do chat interno (server.ts,
// whatsappEnviarTexto), onde não faz sentido nenhum anexo nem subirMidia.
export async function enviarTexto(params: EnvioTextoParams): Promise<{ wamid: string | null; numeroNormalizado: string }> {
  const digitos = params.paraNumero.replace(/\D/g, "");
  if (digitos.length < 10) throw new Error("Número de WhatsApp inválido — informe DDD + número.");
  const numero = digitos.length <= 11 ? `55${digitos}` : digitos;
  const r = await chamarGraph(`/${params.phoneNumberId}/messages`, params.accessToken, {
    jsonBody: {
      messaging_product: "whatsapp",
      to: numero,
      type: "template",
      template: {
        name: params.templateName,
        language: { code: params.templateIdioma },
        ...(params.variaveisCorpo.length
          ? { components: [{ type: "body", parameters: params.variaveisCorpo.map((v) => ({ type: "text", parameter_name: v.nome, text: v.valor })) }] }
          : {}),
      },
    },
  });
  if (!r.ok) throw new Error(`Não consegui enviar a mensagem no WhatsApp: ${mensagemErro(r)}`);
  const wamid = r.corpo?.messages?.[0]?.id || null;
  return { wamid, numeroNormalizado: numero };
}

// Testa a conexão/credenciais sem gastar um envio de template real — só confere se o número
// configurado (phone_number_id) responde e o token é válido.
export async function testarConexao(phoneNumberId: string, accessToken: string): Promise<{ numeroExibicao: string | null }> {
  const r = await chamarGraph(`/${phoneNumberId}?fields=display_phone_number,verified_name`, accessToken, { metodo: "GET" });
  if (!r.ok) throw new Error(mensagemErro(r));
  return { numeroExibicao: r.corpo.display_phone_number || null };
}

// Texto LIVRE (não é template) — só é aceito pela Meta dentro da janela de 24h desde a última
// mensagem recebida do cliente (fora disso a API rejeita, e só resta usar um template aprovado).
// Usado pelo CRM: resposta humana a uma conversa em andamento e o menu automático de departamento
// (o próprio cliente ter acabado de escrever é o que abre a janela pra esse envio).
export async function enviarTextoLivre(phoneNumberId: string, accessToken: string, paraNumero: string, texto: string): Promise<{ wamid: string | null; numeroNormalizado: string }> {
  const digitos = paraNumero.replace(/\D/g, "");
  if (digitos.length < 10) throw new Error("Número de WhatsApp inválido.");
  const numero = digitos.length <= 11 ? `55${digitos}` : digitos;
  const r = await chamarGraph(`/${phoneNumberId}/messages`, accessToken, {
    jsonBody: { messaging_product: "whatsapp", to: numero, type: "text", text: { body: texto } },
  });
  if (!r.ok) throw new Error(`Não consegui enviar a mensagem no WhatsApp: ${mensagemErro(r)}`);
  return { wamid: r.corpo?.messages?.[0]?.id || null, numeroNormalizado: numero };
}

// Baixa o conteúdo de uma URL absoluta qualquer (não necessariamente GRAPH_BASE) com o Bearer token
// — não pode passar por chamarGraph, que sempre tenta decodificar a resposta como JSON/UTF-8 e
// corromperia um binário (mesmo cuidado já tomado em onedrive.ts pra baixar arquivo).
function baixarBinario(urlCompleta: string, accessToken: string): Promise<{ status: number; buffer: Buffer }> {
  return new Promise((resolve, reject) => {
    const url = new URL(urlCompleta);
    const req = https.request(
      { hostname: url.hostname, path: url.pathname + url.search, method: "GET", headers: { Authorization: `Bearer ${accessToken}` }, timeout: 30000 },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode || 0, buffer: Buffer.concat(chunks) }));
      }
    );
    req.on("timeout", () => req.destroy(new Error("Tempo esgotado ao baixar mídia do WhatsApp.")));
    req.on("error", reject);
    req.end();
  });
}
// Baixar mídia recebida (foto/áudio/documento que o cliente mandou) é em 2 passos, confirmado
// contra a documentação oficial da Meta: 1) GET /{media-id} devolve uma URL temporária (expira em
// 5 minutos) + o mime_type; 2) GET nessa URL, com o mesmo Bearer token, devolve os bytes do
// arquivo. Sem o token no passo 2 a Meta recusa o download mesmo a URL sendo "secreta".
export async function baixarMidiaRecebida(mediaId: string, phoneNumberId: string, accessToken: string): Promise<{ buffer: Buffer; mimeType: string | null }> {
  const meta = await chamarGraph(`/${mediaId}?phone_number_id=${phoneNumberId}`, accessToken, { metodo: "GET" });
  if (!meta.ok || !meta.corpo?.url) throw new Error(`Não consegui obter a URL da mídia: ${mensagemErro(meta)}`);
  const { status, buffer } = await baixarBinario(meta.corpo.url, accessToken);
  if (status < 200 || status >= 300) throw new Error(`Falha ao baixar mídia do WhatsApp (HTTP ${status}).`);
  return { buffer, mimeType: meta.corpo.mime_type || null };
}

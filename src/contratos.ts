import fs from "fs";
import path from "path";

// Geração de PDF via Playwright (já é dependência real do projeto, usada hoje pelo agente do
// Domínio Web — o Chromium headless já fica baixado no ambiente, então não precisa de nenhuma lib
// nova só pra isso).

const CONTRATOS_PDF_DIR = path.join(process.env.DATA_DIR || path.join(__dirname, "..", "data"), "contratos-pdf");
fs.mkdirSync(CONTRATOS_PDF_DIR, { recursive: true });

export function caminhoPdfContrato(contratoId: number): string {
  return path.join(CONTRATOS_PDF_DIR, `${contratoId}.pdf`);
}

// Troca {{chave}} pelo valor correspondente em `dados`. Um token sem valor correspondente
// continua visível no texto (em vez de virar branco) — assim o admin percebe na hora o que ainda
// falta preencher, em vez de descobrir só quando o cliente reclamar de uma cláusula em branco.
export function aplicarCamposNoModelo(conteudoHtml: string, dados: Record<string, string | number | null | undefined>): string {
  return conteudoHtml.replace(/\{\{(\w+)\}\}/g, (match, chave) => {
    const valor = dados[chave];
    return valor === undefined || valor === null || valor === "" ? match : String(valor);
  });
}

const CONTRATO_PDF_CSS = `
  @page { size: A4; margin: 20mm 18mm; }
  body { font-family: Georgia, 'Times New Roman', serif; font-size: 12.5px; line-height: 1.6; color: #1a1a1a; }
  h1, h2, h3 { font-family: Georgia, 'Times New Roman', serif; }
  h1 { font-size: 16px; text-align: center; margin-bottom: 18px; }
  p { margin: 0 0 10px; text-align: justify; }
  table { border-collapse: collapse; width: 100%; }
  td, th { border: 1px solid #999; padding: 4px 8px; }
`;

export async function gerarPdfDeHtml(conteudoHtml: string, titulo: string): Promise<Buffer> {
  const { chromium } = require("playwright");
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent(
      `<!doctype html><html><head><meta charset="utf-8"><title>${titulo}</title><style>${CONTRATO_PDF_CSS}</style></head><body>${conteudoHtml}</body></html>`,
      { waitUntil: "networkidle" }
    );
    const pdf = await page.pdf({ format: "A4", printBackground: true });
    return pdf as Buffer;
  } finally {
    await browser.close();
  }
}

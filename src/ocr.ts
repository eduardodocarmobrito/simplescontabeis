// OCR de fallback pra PDF sem camada de texto (scan de mesa) — usado só quando o pdf-parse não
// acha texto nenhum no arquivo (ver obterTextoDoPdf em server.ts). Pipeline: renderiza a 1ª página
// do PDF como PNG (pdfjs-dist rodando dentro do Chromium via Playwright — o mesmo Chromium já usado
// pra gerar PDF de contrato/DANFSE neste projeto, então já confirmado que funciona em produção) e
// depois lê o texto da imagem com Tesseract (dado de treino de português já embutido no repo, sem
// depender de baixar nada da internet em tempo de execução).
import * as fs from "fs";
import * as path from "path";
import * as http from "http";

const TESSDATA_DIR = path.join(__dirname, "tessdata");

let pdfMjs: Buffer | null = null;
let pdfWorkerMjs: Buffer | null = null;
function carregarAssetsPdfjs() {
  if (pdfMjs && pdfWorkerMjs) return;
  const base = path.dirname(require.resolve("pdfjs-dist/package.json"));
  pdfMjs = fs.readFileSync(path.join(base, "build", "pdf.mjs"));
  pdfWorkerMjs = fs.readFileSync(path.join(base, "build", "pdf.worker.min.mjs"));
}

// Página mínima que carrega o pdfjs-dist (ES module — precisa vir de um servidor http de verdade,
// carregar via file:// dá erro de CORS no import/worker) e expõe uma função global pra renderizar
// uma página do PDF (recebido em base64) num <canvas>.
const RENDER_HTML = `<!doctype html><html><body><canvas id="c"></canvas>
<script type="module">
  import * as pdfjsLib from '/pdf.mjs';
  pdfjsLib.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs';
  window.__renderPdfPagina = async function(base64, pagina, escala) {
    const bin = atob(base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const pdf = await pdfjsLib.getDocument({ data: bytes }).promise;
    const page = await pdf.getPage(pagina);
    const viewport = page.getViewport({ scale: escala });
    const canvas = document.getElementById('c');
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
    return true;
  };
</script></body></html>`;

let servidorPromise: Promise<{ server: http.Server; port: number }> | null = null;
function garantirServidor(): Promise<{ server: http.Server; port: number }> {
  if (!servidorPromise) {
    carregarAssetsPdfjs();
    servidorPromise = new Promise((resolve) => {
      const server = http.createServer((req, res) => {
        const url = req.url || "";
        if (url === "/pdf.mjs") {
          res.writeHead(200, { "Content-Type": "text/javascript" });
          res.end(pdfMjs!);
          return;
        }
        if (url === "/pdf.worker.min.mjs") {
          res.writeHead(200, { "Content-Type": "text/javascript" });
          res.end(pdfWorkerMjs!);
          return;
        }
        if (url === "/render.html") {
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end(RENDER_HTML);
          return;
        }
        res.writeHead(404);
        res.end();
      });
      server.listen(0, "127.0.0.1", () => resolve({ server, port: (server.address() as any).port }));
    });
  }
  return servidorPromise;
}

async function renderizarPrimeiraPaginaPng(buf: Buffer): Promise<Buffer> {
  const { port } = await garantirServidor();
  const { chromium } = require("playwright");
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${port}/render.html`, { waitUntil: "load" });
    await page.waitForFunction("!!window.__renderPdfPagina");
    await page.evaluate(
      ([b64, pagina, escala]: [string, number, number]) => (window as any).__renderPdfPagina(b64, pagina, escala),
      [buf.toString("base64"), 1, 3]
    );
    return (await page.locator("#c").screenshot()) as Buffer;
  } finally {
    await browser.close();
  }
}

async function lerTextoPorOcr(pngBuf: Buffer): Promise<string> {
  const Tesseract = require("tesseract.js");
  const { data } = await Tesseract.recognize(pngBuf, "por", {
    langPath: TESSDATA_DIR,
    cachePath: TESSDATA_DIR,
    gzip: false,
  });
  return data.text || "";
}

// Só a 1ª página — nas licenças que o escritório recebe (alvará, vigilância sanitária, corpo de
// bombeiros, ambiental) o CNPJ e o vencimento sempre estão na página de rosto.
export async function ocrPrimeiraPagina(buf: Buffer): Promise<string> {
  const png = await renderizarPrimeiraPaginaPng(buf);
  return lerTextoPorOcr(png);
}

# Bibliotecas Node.js / SDKs / APIs para assinatura digital ICP-Brasil

## Quais são os melhores pacotes npm atuais (2023-2026) para assinatura PAdES de PDF em Node.js?

### Takeaway
O ecossistema convergiu para a família `@signpdf/*` (sucessora do antigo `node-signpdf`, hoje deprecated) combinada com `node-forge` para as primitivas de PKCS#12/CMS; nenhuma dessas bibliotecas entrega LTV ou timestamp/TSA prontos — timestamp exige um pacote de terceiro pouco usado (`@dotit/pades`) e LTV não foi encontrado em nenhuma lib JS pesquisada.

### Cited Findings
- `node-signpdf` (pacote antigo no npm) está marcado como deprecated: a própria entrada no registry diz "NPM package is being replaced by @signpdf. See https://github.com/vbuch/node-signpdf", última versão publicada 3.0.0 em 2023-10-09 — [npm registry node-signpdf](https://registry.npmjs.org/node-signpdf)
- O repositório GitHub `vbuch/node-signpdf` (que hoje hospeda a família `@signpdf`) tem 942 stars, 28 issues abertas, e push mais recente em 2026-10-07 — ou seja, ativamente mantido — [GitHub vbuch/node-signpdf](https://github.com/vbuch/node-signpdf)
- O pacote atual `@signpdf/signpdf` teve sua última versão (3.3.0) publicada no npm em 2025-12-29 — [npm registry @signpdf/signpdf](https://registry.npmjs.org/@signpdf/signpdf)
- A arquitetura é modular: `@signpdf/signpdf` entende a estrutura do PDF; `@signpdf/signer-p12` entende arquivos P12 usando `node-forge` por baixo; há helpers de placeholder separados: `@signpdf/placeholder-pdfkit010` (para PDFs gerados com pdfkit) e `@signpdf/placeholder-plain` (genérico, mas descrito pelos próprios mantenedores como "rather fragile, doesn't support streams, and only works on PDF version 1.3 or lower") — [GitHub vbuch/node-signpdf](https://github.com/vbuch/node-signpdf)
- Suporte a PAdES existe e é documentado: para conformidade PAdES o `SubFilter` do dicionário de assinatura ETSI deve ser `ETSI.CAdES.detached` (em vez do valor padrão da Adobe), configurável via opção `subFilter` — [GitHub vbuch/node-signpdf](https://github.com/vbuch/node-signpdf)
- Não há menção de suporte a LTV (Long-Term Validation) na documentação do `@signpdf`.
- Timestamp/TSA: existe um pacote de terceiro, `@dotit/pades`, construído sobre `@signpdf`, que adiciona assinatura PAdES-B-B e PAdES-B-T (com timestamp, via URL de TSA configurável) — mas tem contagem de downloads baixa, tratar como opção nicho/não validada em produção — [socket.dev @dotit/pades](https://socket.dev/npm/package/@dotit/pades)
- Assinatura visível (campo de assinatura visível no PDF): não documentada diretamente no `@signpdf` core nos resultados encontrados; normalmente combinada com `pdf-lib` para desenhar o widget de assinatura antes de aplicar o placeholder/assinatura.
- `node-forge` (usado por `@signpdf/signer-p12` para ler o P12 e assinar) tem 5.337 stars, 466 issues abertas, push mais recente em 2026-09-25, e última versão npm (1.4.0) publicada em 2026-03-24 — ativamente mantido apesar do grande backlog de issues — [GitHub digitalbazaar/forge](https://github.com/digitalbazaar/forge), [npm registry node-forge](https://registry.npmjs.org/node-forge)
- `node-forge` suporta PKCS#12 (import/export, inclusive opção TripleDES para compatibilidade com alguns navegadores), PKCS#7 (enveloped data, signed data com authenticated attributes, assinaturas detached) e X.509 (criação, self-signing, import/export PEM, verificação de cadeia via CA store) — [GitHub digitalbazaar/forge](https://github.com/digitalbazaar/forge)

### Inferences
- Para um backend Express/TS, a combinação recomendável hoje é: `pdf-lib` (que o projeto já usa) para preparar o placeholder de assinatura visível + `@signpdf/signpdf` + `@signpdf/signer-p12` + `node-forge` para assinar com o P12 do cliente, definindo `subFilter` para o valor CAdES-detached exigido pelo PAdES.
- LTV (incorporar CRL/OCSP response + cadeia completa no PDF) provavelmente precisaria ser implementado manualmente por cima do `@signpdf` (não há lib JS pronta encontrada) ou delegado a uma API comercial (ver seção de APIs pagas).

### Gaps
- Não foi possível confirmar se `@signpdf/signpdf` ou algum pacote JS tem suporte nativo a LTV (embutir DSS/VRI no PDF). Nenhuma fonte encontrada trata disso.
- Não encontrei documentação sobre "assinatura visível" nativa no `@signpdf`; a prática usual (combinar com `pdf-lib`) é inferência minha, não citação direta.
- `@dotit/pades` (timestamp/TSA) não foi avaliado em profundidade (stars, última atividade, maturidade do código) — apenas a existência e a feature foram confirmadas via socket.dev.

---

## Existe um pacote npm bem mantido especificamente para ler/parsear certificados ICP-Brasil (extrair CPF/CNPJ pelo OID do SAN)?

### Takeaway
Não foi encontrado nenhum pacote npm dedicado a extrair CPF/CNPJ de certificados ICP-Brasil via OID da Subject Alternative Name; o que existe no npm são apenas validadores/formatadores de CPF/CNPJ (sem relação com certificados) e uma API SaaS de terceiro (nfe.io) que faz esse parsing como serviço hospedado.

### Cited Findings
- Busca por pacotes brasileiros de parsing de certificado ICP-Brasil no npm retornou somente bibliotecas de validação/formatação de CPF/CNPJ como string (`cpf_cnpj` — já deprecated, recomendando migrar para `@fnando/cpf`/`@fnando/cnpj`; `node-cpf-cnpj`; `cnpj` no JSR) — nenhuma lê certificados X.509 — [npm cpf_cnpj](https://npmjs.com/package/cpf_cnpj)
- O serviço `nfe.io` oferece uma API de certificados hospedada que, após o upload do arquivo, extrai e mantém automaticamente campos incluindo o CNPJ extraído do certificado — mas isso é descrito como suportando apenas e-CNPJ e NF-e A1, não e-CPF, e é um serviço SaaS (chamado via API), não uma biblioteca local — [nfe.io docs certificados](https://nfe.io/docs/documentacao/gerenciamento-empresas/api-certificados/)
- `certifi-icpbr` é um pacote Python (PyPI) para âncoras de confiança ICP-Brasil, não uma lib Node e não faz extração de CPF/CNPJ — [PyPI certifi-icpbr](https://pypi.org/project/certifi-icpbr)

### Inferences
- Como não existe biblioteca pronta, a extração de CPF/CNPJ do certificado ICP-Brasil em Node precisará ser feita manualmente: parsear o X.509 (com `node-forge`, `pkijs` ou `@peculiar/x509`) e procurar, dentro da extensão `subjectAltName`, o campo `otherName` com os OIDs específicos da ICP-Brasil (ex.: OID `2.16.76.1.3.1` para PF carrega CPF/nascimento/RG etc., conforme o padrão definido no DOC-ICP-04/05 do ITI — meu conhecimento prévio, não confirmado nesta pesquisa). Isso é plumbing de baixo nível que o projeto provavelmente já precisa ter resolvido para o módulo `nfse.ts` existente (ver nota final).

### Gaps
- Não encontrei nenhuma lib JS, mantida ou não, que implemente especificamente o parsing dos OIDs ICP-Brasil (padrão ITI DOC-ICP-04). Isso é uma lacuna real do ecossistema npm, não apenas falha de busca — múltiplas queries direcionadas (incluindo termos em português) não retornaram nada.
- Não validei os valores exatos de OID citados na seção de Inferences nesta rodada de pesquisa (vieram do meu conhecimento prévio, não de uma fonte buscada agora) — tratar como ponto a confirmar com a documentação oficial do ITI antes de codificar.

---

## Quais primitivas de cripto do Node (`node:crypto`, `node-forge`, `pkijs`, `@peculiar/x509`) servem para carregar PKCS#12, extrair chave privada e gerar CMS/CAdES/PKCS#7, e para assinatura XML (XAdES/NFe)?

### Takeaway
`node-forge` e `pkijs` são as duas opções maduras e ativamente mantidas para PKCS#12 + CMS/PKCS#7 em Node; para XML, `xml-crypto` (muito ativo) cobre XMLDSig genérico, mas o pacote dedicado a XAdES (`xadesjs`) foi arquivado e teve sua funcionalidade migrada para `xmldsigjs` — e o único pacote específico para assinatura de NF-e brasileira (`nfe-signer`) está abandonado desde 2019.

### Cited Findings
- `node-forge`: ativamente mantido (push 2026-09-25, 5.337 stars, release npm 1.4.0 em 2026-03-24); suporta PKCS#12 import/export, PKCS#7 signed/enveloped data com detached signatures, X.509 com verificação de cadeia — [GitHub digitalbazaar/forge](https://github.com/digitalbazaar/forge)
- `pkijs`: 1.400 stars no GitHub, 84 issues abertas, push mais recente em 2026-09-30, última versão npm (3.4.1) publicada em 2026-09-20 — ativamente mantido; exige Node.js 16+ e é construído sobre WebCrypto — [GitHub PeculiarVentures/PKI.js](https://github.com/PeculiarVentures/PKI.js), [npm registry pkijs](https://registry.npmjs.org/pkijs)
- `pkijs` documenta exemplo "Working with PKCS#12 files" (parsing/extração via SafeBags/SafeContents), suporta CMS/PKCS#7 signing ("CMS is the most commonly used data structure for signing data") e tem exemplos de criação/parsing de CRL e manipulação de requisições/respostas OCSP — [GitHub PeculiarVentures/PKI.js](https://github.com/PeculiarVentures/PKI.js)
- `@peculiar/x509`: repositório com 137 stars, push em 2026-09-27, última versão npm (2.1.0) publicada em 2026-09-04 — ativamente mantido, mas os resultados de busca não confirmaram suporte nativo a PKCS#12 neste pacote especificamente (ele foca em estruturas X.509/ASN.1; o pacote irmão `@peculiar/asn1-x509` cobre ASN.1 de X.509, não PKCS#12) — [npm registry @peculiar/x509](https://registry.npmjs.org/@peculiar/x509)
- `node:crypto` nativo: não foi pesquisado em profundidade nesta rodada (ver Gaps) — sabidamente a partir do Node 16+ permite ler certificados X.509 via `X509Certificate`, mas não tem suporte nativo a PKCS#12 nem a construção de CMS/PKCS#7 — por isso o ecossistema depende de `node-forge`/`pkijs` para esse trecho.
- Para XML: `xml-crypto` é um pacote de assinatura/verificação de XMLDSig genérico para Node (canonicalização exclusiva, digests SHA-1/SHA-256), com atividade muito recente — última versão npm (6.3.3) publicada em 2026-10-05 (há poucos dias) — [npm registry xml-crypto](https://registry.npmjs.org/xml-crypto)
- `xadesjs` (implementação de XAdES em TS/JS, construída sobre XMLDSIGjs) está **arquivado no GitHub** (`archived: true`), com último push em 2025-08-12; o próprio README avisa "the functionality has been merged into the xmldsigjs monorepo... For future development and updates, please use xmldsigjs" — apenas o perfil XAdES-BES é totalmente suportado — [GitHub PeculiarVentures/xadesjs](https://github.com/PeculiarVentures/xadesjs)
- `xmldsigjs` (sucessor, não arquivado) teve push em 2026-09-30 — ativamente mantido — [GitHub PeculiarVentures/xmldsigjs](https://github.com/PeculiarVentures/xmldsigjs)
- `nfe-signer` (pacote específico para assinar NF-e brasileira com certificado p12, via xades-epes) está com a última publicação no npm em 2019-07-29 (versão 1.0.3) — **abandonado há mais de 6 anos**, risco alto de incompatibilidade com Node atual — [npm registry nfe-signer](https://registry.npmjs.org/nfe-signer)
- Não há nenhum pacote CAdES dedicado para Node encontrado nas buscas; os únicos resultados para "CAdES" foram pacotes .NET (`SimpleSign.CAdES`, incluindo um `SimpleSign.Brasil` voltado a ICP-Brasil) — fora do alvo Node/TS.

### Inferences
- Para CMS/CAdES em Node, a rota viável é montar a estrutura PKCS#7/CMS manualmente com `node-forge` ou `pkijs` (ambos maduros) — não há um pacote "CAdES" turnkey em JS.
- Para XAdES/NFe, como `xadesjs` está arquivado e `nfe-signer` abandonado, a opção mais defensável hoje é usar `xmldsigjs` (ativo) como base de XMLDSig e implementar manualmente as extensões XAdES/XAdES-EPES exigidas pelo padrão de NF-e, ou usar `xml-crypto` (muito ativo) do mesmo jeito. Ambas exigem trabalho de adaptação ao formato específico de assinatura de NFe/NFSe (canonicalização C14N, Reference URI apontando para o elemento `infNFe`, etc.).
- Dado que o projeto já tem um módulo `nfse.ts` que carrega/decripta `.pfx` para assinar XML de NFe/NFSe, é muito provável que essa plumbing de PKCS#12 + XMLDSig já esteja resolvida ali com `node-forge` (ou similar) — reaproveitável para o novo assinador PAdES/CAdES em vez de reconstruir do zero (ver nota final).

### Gaps
- Não testei nem encontrei confirmação direta de que `@peculiar/x509` suporta leitura de arquivos PKCS#12 — a resposta pode ser "não, use pkijs para isso e @peculiar/x509 só para manipular o X.509 resultante", mas isso não foi confirmado numa fonte primária (README oficial não foi lido diretamente).
- Não pesquisei a fundo as capacidades do `node:crypto` nativo (módulo `crypto` do Node) para esse fluxo — ponto a verificar na documentação oficial do Node antes de decidir a arquitetura final.
- Não encontrei nenhuma lib JS que implemente XAdES-T/XAdES-X-L (com timestamp e validação de longo prazo) — apenas XAdES-BES "completo" foi mencionado (no `xadesjs`, já arquivado).

---

## Existem SDKs Node para checagem OCSP e bibliotecas de download/parsing de CRL? Estão mantidos?

### Takeaway
`easy-ocsp` é a melhor opção atual para OCSP em Node (mantida, release recente em 2026-05), enquanto o pacote `ocsp-hashes` está abandonado; para CRL, não existe um pacote npm dedicado e maduro — a alternativa prática é usar as funções de CRL já presentes em `pkijs`.

### Cited Findings
- `easy-ocsp` (pacote npm, descrito como "An easy-to-use OCSP client for Node.js"): última versão (1.3.2) publicada em 2026-05-24; o repositório correto no GitHub é `timokoessler/easy-ocsp`, com 14 stars e push em 2026-08-12 — mantido, embora pequeno (projeto de mantenedor único) — [npm registry easy-ocsp](https://registry.npmjs.org/easy-ocsp), [GitHub timokoessler/easy-ocsp](https://github.com/timokoessler/easy-ocsp)
- Avaliação independente via Snyk (consultada durante a busca, não re-confirmada diretamente): classificado como "sustainable", com ao menos uma versão nova nos últimos 3 meses, mas poucos usuários (~3.570 downloads/semana) e health score 71/100 — [Snyk Advisor easy-ocsp](https://security.snyk.io/package/npm/easy-ocsp)
- `ocsp-hashes` está classificado pelo Snyk como inativo, sem releases novas há mais de 12 meses, última versão publicada em 2021 — risco de abandono confirmado — [Snyk Advisor ocsp-hashes](https://security.snyk.io/package/npm/ocsp-hashes)
- O pacote genérico `ocsp` (nome exato no npm) não teve dados de manutenção confirmados nas buscas — um resultado da DepScope o descreve apenas como implementação de OCSP Stapling, não como cliente de verificação — tratar como não confirmado/possivelmente irrelevante para o caso de uso (verificação de revogação de certificado de assinatura, não TLS stapling).
- Não foi encontrado nenhum pacote npm dedicado e maduro para download+parsing de CRL. O resultado mais próximo foi um pacote JSR novo (`@kjanat/micro509`) que se descreve como "zero-dependency TypeScript PKI toolkit" com APIs para CRL, OCSP e orquestração de revogação — mas tem downloads muito baixos (~1/semana), sinal de projeto novo e não testado em produção — [JSR @kjanat/micro509](https://jsr.io/@kjanat/micro509/doc/revocation/)
- `pkijs` (já coberto acima, ativamente mantido) inclui exemplos oficiais de criação e parsing de CRL, além de manipulação de requisições/respostas OCSP — é a opção mais robusta e madura disponível para CRL em Node hoje, ainda que não seja um pacote "CRL" dedicado — [GitHub PeculiarVentures/PKI.js](https://github.com/PeculiarVentures/PKI.js)

### Inferences
- Para checagem de revogação em produção, a combinação mais defensável é: `easy-ocsp` para o fluxo OCSP (requisição HTTP ao responder OCSP do AC + parsing da resposta) e `pkijs` para parsing de CRL quando o OCSP não estiver disponível (fallback), em vez de depender de um pacote CRL dedicado — nenhum existe maduro o suficiente.

### Gaps
- Não consegui confirmar se `easy-ocsp` lida corretamente com os ACs ICP-Brasil especificamente (ele é genérico para X.509/OCSP, sem menção a ICP-Brasil nas buscas) — testar com um responder OCSP real de AC brasileira (ex. Serpro, Certisign, Valid) antes de confiar em produção.
- O pacote JSR `@kjanat/micro509` não foi avaliado em profundidade (código, testes, maturidade) — apenas notado como opção emergente e não confirmada.

---

## APIs/SDKs comerciais pagos: Lacuna Software, BRy, Safe2Pay, D4Sign, Clicksign — exigem certificado do usuário final ou o escritório fornece via API? Pricing público?

### Takeaway
Lacuna Software é a única com um SDK Node.js oficial e publicamente documentado no npm (`restpki-client`, além de múltiplos outros clients Node no GitHub da empresa), permitindo o backend assinar com o certificado que o próprio escritório fornece (modelo "BYOC" — bring your own certificate — via API REST); D4Sign e Clicksign são plataformas de assinatura de documentos focadas em fluxo por signatário (não expõem claramente uma rota para "a empresa assina com certificado próprio sem usuário"), nenhuma das cinco tem pricing público e detalhado encontrado — todas exigem contato comercial. BRy não teve documentação de desenvolvedor pública localizada. Safe2Pay não apresentou nenhuma evidência de produto de assinatura digital ICP-Brasil nas buscas.

### Cited Findings

**Lacuna Software**
- Possui SDK Node.js **oficial e publicado no npm**: pacote `restpki-client`, descrito como "Classes to consume Lacuna Software REST PKI", mantido pela própria empresa (maintainer `lacuna-dev`, email `dev-admins@lacunasoftware.com`), última versão (2.3.8) publicada em 2025-12-09 — [npm registry restpki-client](https://registry.npmjs.org/restpki-client)
- O repositório correspondente no GitHub da organização Lacuna é `LacunaSoftware/RestPkiNodeClient`, com push em 2025-12-09 (coerente com a publicação npm) — [GitHub org LacunaSoftware (listagem de repos via API)]
- A organização Lacuna mantém múltiplos outros clients Node, todos relativamente recentes: `RestPkiCoreNodeClient` (produto "REST PKI Core", mais novo, push 2025-07-24), `PkiExpressNode` (push 2025-10-31 — wrapper Node para o PKI Express, ferramenta CLI local), `signerNodeClient` (push 2026-02-24), `cloudhubNodeClient` (push 2026-07-22, o mais recente de todos) — indicando portfólio ativo de produtos com suporte Node — [listagem GitHub API de repos LacunaSoftware]
- Uma proposta comercial pública da Lacuna para o TCE-RN (2020) confirma que a "Lacuna PKI" oferece acesso via chamadas REST e inclui biblioteca cliente para conexão de aplicações, cobrindo: assinatura digital, validação de documentos assinados, emissão de certificados e autenticação de usuários — "Bem como as linguagens de programação: Java, C#, Python, Ruby, PHP e Node.js" — [TCE-RN proposta Lacuna](https://tce.rn.gov.br/Licitacoes/AcessarDocumentoDeLicitacaoTemp/1508/DE_004208_2020_0003)
- Há também um componente **client-side** separado, `web-pki` (npm), descrito como componente JavaScript que permite páginas web interagirem com certificados digitais do usuário final (detecta certificados disponíveis, software ou hardware, assina dados) — ou seja, a Lacuna oferece tanto o modelo server-side (REST PKI com certificado do escritório/API) quanto client-side (Web PKI, usando o certificado do usuário final no navegador) — [npm/libraries.io web-pki](https://libraries.io/npm/web-pki)
- **Pricing:** não encontrado nenhum valor público. Única referência é a proposta comercial ao TCE-RN (sem números de preço) — contato comercial necessário.
- **Modelo de certificado:** confirmado que o REST PKI (server-side) opera com certificado fornecido pela aplicação/escritório via API, enquanto o Web PKI opera no navegador do usuário final com o certificado dele. Não confirmei se o produto "Signer" (cloud signature, `signerNodeClient`) usa certificado em nuvem gerenciado pela Lacuna ou do próprio cliente — gap.

**D4Sign**
- Documentação oficial da API em `docapi.d4sign.com.br/v2.0` (v1.0 EN-US); existe ambiente de produção (`secure.d4sign.com.br/api/v1`, com validade jurídica) e sandbox (`sandbox.d4sign.com.br/api/v1`, sem validade jurídica) — [D4Sign API docs](https://docapi.d4sign.com.br/v2.0)
- A página de endpoints lista uma seção "ICP-Brasil Certificate Endpoints" e rotas como "Add Certificate to Signer" e "List Defined Certificate" — sugerindo que certificados ICP-Brasil são associados a signatários individuais (não confirmado em detalhe pelas descrições completas, que não foram acessadas) — [D4Sign API docs](https://docapi.d4sign.com.br/v2.0)
- Não encontrei nenhum SDK Node.js **oficial** da D4Sign no npm; os únicos SDKs encontrados são wrappers PHP/Laravel não oficiais da comunidade (ex. `carloshaam/d4sign-php-sdk`) — [Packagist carloshaam/d4sign-php-sdk](https://packagist.org/packages/carloshaam/d4sign-php-sdk)
- **Pricing:** não encontrado nenhum valor público; reviews de terceiros (Capterra, Software Advice) mencionam apenas planos de teste e necessidade de upgrade, sem números — [Capterra D4Sign](https://www.capterra.com/p/250791/D4Sign/)

**Clicksign**
- Documentação oficial em `developers.clicksign.com/docs`. Existe recurso de "Assinatura automática" (`"auth": "auto_signature"` no payload do envelope) que permite que um signatário pré-cadastrado (pessoa jurídica, com um "Termo de Assinatura Automática" previamente assinado por um admin e pelo próprio signatário) tenha sua assinatura aplicada automaticamente quando chega sua vez no fluxo, **sem receber convite por e-mail/WhatsApp a cada documento** — mas a documentação não menciona uso de certificado digital nem ICP-Brasil nesse fluxo especificamente — [Clicksign docs - assinatura automática](https://developers.clicksign.com/docs/assinatura-automatica)
- Existe também "Assinatura incorporada (embedded_signature/tokenless)" listada no índice de docs, mas não detalhada nas buscas — [Clicksign docs index](https://developers.clicksign.com/docs)
- A página de marketing da Clicksign lista "Digital Certificate Authentication" como um dos métodos de autenticação de signatário disponíveis (produto, não detalhe de API) — [Clicksign integração](https://clicksign.com/en/integracao)
- Existe um pacote **não oficial** no npm, `clicksign-library`, TypeScript, cobrindo envio de contratos e listagem de documentos — não confirmado se trata de certificados — [npm clicksign-library](https://npmjs.org/package/clicksign-library)
- **Pricing:** planos publicados (Start/Plus) na faixa de R$ 39–119/mês cobrando por documento finalizado (assinado por todos os signatários, não por envio) — mas esses planos não cobrem claramente a "API White Label" com certificado próprio; para esse caso a página direciona para "Fale com vendas" (proposta sob consulta) — [Clicksign preços](https://clicksign.com/en/preco), [Clicksign integração](https://clicksign.com/en/integracao)

**BRy**
- Não foi localizada documentação pública de desenvolvedor (tentativas de busca por "BRy API desenvolvedor" não retornaram o portal oficial, apenas notícias e páginas de produto de terceiros).
- Uma avaliação de terceiro (TrustRadius) lista integração via API, assinatura em lote, solicitação de assinatura multi-parte e serviço de timestamp como recursos do "BRy Signer" — [TrustRadius BRy](https://www.trustradius.com/products/bry/details)
- Um anúncio da própria BRy (2021) menciona uma série de webinars gratuitos para desenvolvedores sobre APIs de assinatura digital, certificados em nuvem e carimbo de tempo — sugerindo que a empresa historicamente expôs essas APIs a desenvolvedores, mas o portal/documentação atual não foi encontrado nesta pesquisa — [Baguete - BRy webinar](https://www.baguete.com.br/public/noticias/bry-lanca-assinador-digital-gratuito)
- Um anúncio de vaga/projeto freela (2026) descreve um padrão de integração típico: uma plataforma cliente gerencia usuários/documentos/planos e chama a API da BRy apenas para a etapa de assinatura e validação jurídica, recebendo eventos via webhook — sugerindo modelo server-side onde o certificado é gerenciado pela BRy (provavelmente certificado em nuvem do signatário final, não confirmado) — [Workana - vaga integração BRy](https://www.workana.com/job/desenvolvimento-de-plataforma-saas-multiempresa-para-assinatura-digital-com-integracao-bry)
- **Pricing:** não encontrado nenhum valor público.
- **SDK Node.js:** não encontrado — nenhuma menção a SDK Node/npm oficial da BRy nas buscas.

**Safe2Pay**
- Nenhuma evidência encontrada de que a Safe2Pay (empresa majoritariamente conhecida como gateway de pagamentos) tenha um produto de assinatura digital ICP-Brasil — as buscas direcionadas não retornaram nenhuma página oficial da empresa sobre o tema, apenas resultados genéricos sobre ICP-Brasil (regulamentação ITI, trabalhos acadêmicos). **Não confirmo nem refuto a existência do produto "Assinatura Digital" da Safe2Pay** — simplesmente não há fonte confiável nos resultados desta pesquisa.

### Inferences
- Lacuna Software é claramente a opção mais "Node-nativa" entre as comerciais: SDK oficial no npm, mantido pela própria empresa, com publicação recente (dezembro/2025) e múltiplos produtos relacionados (REST PKI clássico, REST PKI Core, PKI Express, Signer, CloudHub) todos com clients Node no GitHub da organização — vale investigar diretamente qual desses produtos (REST PKI vs. Signer vs. CloudHub) atende ao caso "escritório assina com certificado próprio via API server-side" vs. "certificado em nuvem gerenciado pela Lacuna".
- D4Sign e Clicksign são, por desenho, plataformas de **fluxo de assinatura por signatário** (iniciado por envio de documento a pessoas), não APIs de assinatura PAdES/CAdES "headless" com certificado do escritório — a funcionalidade mais próxima do caso "escritório assina sem intervenção humana" é a "assinatura automática" da Clicksign, mas ela ainda modela isso como um signatário pré-autorizado, não como "a empresa X assina com o certificado A1 dela".
- Para o caso de uso descrito (escritório de contabilidade com certificado A1 próprio assinando documentos para clientes, sem fluxo de convite a terceiros), a rota mais alinhada entre as comerciais é a Lacuna REST PKI (ou REST PKI Core), não D4Sign/Clicksign.

### Gaps
- Nenhum valor de pricing público e concreto foi encontrado para nenhuma das cinco empresas — todas exigem contato comercial direto. Isso é reportado como fato (ausência de pricing público), não como estimativa.
- Não consegui confirmar os detalhes exatos de "ICP-Brasil Certificate Endpoints" do D4Sign nem da seção "Add Certificate to Signer" (a página de docs só lista títulos, sem corpo, no fetch realizado) — para responder com certeza se o D4Sign permite certificado do escritório vs. exige certificado por signatário, seria necessário acessar a descrição completa de cada endpoint (não acessível via fetch simples nesta sessão).
- BRy: não localizei o portal de desenvolvedor oficial (`bry.com.br/desenvolvedor` mencionado no briefing não foi encontrado/confirmado nas buscas) — recomendo tentativa de acesso direto por outro meio (navegador) em pesquisa futura.
- Safe2Pay: gap total — não há fonte para confirmar ou negar a existência de um produto de assinatura digital ICP-Brasil dessa empresa.
- Não confirmei se o produto "Signer" da Lacuna (cloud signature) usa certificado em nuvem (e-CPF/e-CNPJ em nuvem, modelo ITI) do próprio usuário final ou permite usar o certificado do escritório — ponto a esclarecer diretamente com a documentação do produto (`docs.lacunasoftware.com`, que retornou 404 na tentativa de fetch direto nesta sessão — tentar outra URL/caminho).

---

## Nota sobre o projeto existente (não investigado em profundidade, apenas repassado como indicado no briefing)

### Takeaway
O briefing indica que o projeto já usa `pdf-lib` (merge de PDFs) e Playwright/Chromium (HTML→PDF) e já tem um módulo `nfse.ts` que carrega/decripta `.pfx` para assinatura de XML de NFe/NFSe — isso é um forte indício de que a plumbing de carregamento de certificado (`node-forge` ou equivalente, extração de chave privada com senha) já existe parcialmente no código e pode/deve ser reaproveitada para a nova feature de assinatura PAdES/CAdES, em vez de reimplementada do zero.

### Cited Findings
- Não aplicável — esta seção é repasse de contexto fornecido no briefing da tarefa, não um achado de pesquisa; não inspecionei o código do projeto (fora do escopo desta pesquisa, conforme instrução explícita do briefing).

### Inferences
- Nenhuma inferência de pesquisa adicional aqui; o encaminhamento recomendado é: na etapa de implementação, abrir e revisar `nfse.ts` antes de escolher a biblioteca de PKCS#12/CMS para o novo assinador PAdES, para decidir se reaproveita o carregamento de certificado já existente ou se padroniza em `pkijs`/`node-forge` para ambos os fluxos (XML e PDF).

### Gaps
- Nenhum — esta seção é intencionalmente não investigada, por instrução explícita do briefing ("não tente inspecionar o código real do projeto").

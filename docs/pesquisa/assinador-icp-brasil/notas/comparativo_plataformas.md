# Comparativo: como doc9, Clicksign, D4Sign e o assinador gov.br/ITI dão acesso ao certificado digital do usuário

Pesquisa feita em 2026-10-11 via busca e leitura direta dos sites/documentação de cada plataforma. Metodologia: WebSearch + WebFetch nos sites oficiais, central de ajuda, blog e docs de API de cada plataforma. **Nenhuma informação abaixo foi inventada** — onde a fonte não confirmou um detalhe técnico, isso está marcado explicitamente como lacuna.

---

## 1. doc9 (doc9.com.br / lp.doc9.com.br/whom-doc9)

### O que é o produto
doc9 é uma legal-tech brasileira com um portfólio de produtos, não um único assinador. No site institucional (doc9.com.br) aparecem: **Whom.doc9** (gestão de certificados digitais em nuvem), **Logística Jurídica** (audiências, cálculos, diligências), **Which.doc9** (IA jurídica para advogados autônomos) e **Task.doc9** (automação de tarefas jurídicas). [Fonte: doc9.com.br]

O produto relevante para a pergunta do usuário é o **Whom.doc9**, descrito na própria página como "o primeiro gerenciador de certificados digitais em nuvem do Brasil". [Fonte: doc9.com.br; confirmado também na landing page lp.doc9.com.br/whom-doc9]

**Importante: Whom.doc9 não é uma plataforma de assinatura de documentos (não compete com Clicksign/D4Sign no sentido de "enviar um contrato para assinar").** É uma camada de **governança e controle de acesso** sobre certificados digitais que a empresa/escritório já possui. Ele centraliza, rastreia e libera o uso desses certificados para pessoas autorizadas, substituindo o uso de token físico compartilhado ou de senhas de certificado circulando em planilha. Frase do site: "centraliza, rastreia e libera o uso dos seus certificados com controle total sobre quem acessa, o quê e quando." [Fonte: lp.doc9.com.br/whom-doc9]

### Mercado-alvo
Escritórios de advocacia, departamentos jurídicos corporativos (citando DPOs, CISOs e diretores jurídicos), grupos empresariais com múltiplas empresas, e também escritórios pequenos/contábeis. [Fonte: lp.doc9.com.br/whom-doc9]

### Suporta certificado ICP-Brasil? Mecanismo exato
- A palavra "ICP-Brasil" **não aparece nominalmente** em nenhuma das páginas lidas (doc9.com.br e a landing page whom-doc9).
- A única referência a tipo de certificado encontrada é um item de FAQ sobre "certificados digitais A1" (categoria de certificado ICP-Brasil cuja chave fica em arquivo, mas o site não usa o termo ICP-Brasil para qualificá-lo).
- O site **não explica o mecanismo técnico de assinatura em si** — não há menção a extensão de navegador, aplicativo local, upload de arquivo .pfx/.p12, ou HSM em nuvem próprio. As frases disponíveis tratam apenas de controle de acesso e trilha de auditoria: "sem token físico, sem planilha, sem risco invisível"; "conceder acesso nominal, rastreável e revogável para cada pessoa autorizada". [Fonte: doc9.com.br; lp.doc9.com.br/whom-doc9]
- O produto se posiciona como camada que fica **entre o usuário e o certificado já existente da organização** (ex.: para assinar em +1.500 sistemas, incluindo GovBR e e-CAC, "sem compartilhar credenciais nem token físico"), e não como emissor nem como motor de assinatura próprio. Isso sugere que doc9/Whom.doc9 resolve o problema de **gestão/cofre de certificados corporativos**, deixando a operação real de assinatura (PKI) para os sistemas de destino (GovBR, e-CAC, sistemas judiciais) aos quais ele se conecta. [Fonte: lp.doc9.com.br/whom-doc9]

### Detalhes técnicos/arquitetura publicados
- "100% na nuvem, sem instalação" — não há app local nem token físico necessário do lado do usuário final para *acessar* o cofre.
- Integração nativa com "+1.500 sistemas", citando GovBR, e-CAC e sistemas judiciais.
- Controle de permissões por usuário, papel ou janela de tempo; monitoramento em tempo real de quem acessou cada certificado; renovação de certificado "em poucos cliques".
- Certificações de segurança citadas: ISO/IEC 27001 e ISO/IEC 27701.
- Alinhamento regulatório citado: Portaria CNJ 140/2024.
- Alegações sem detalhamento de suporte: "Zero vazamentos" e "+100 mil usuários ativos" — não verificáveis a partir do material disponível. [Fonte: lp.doc9.com.br/whom-doc9]
- Não foi encontrada documentação técnica pública (API reference, blog técnico, whitepaper) detalhando o mecanismo de "liberação" do certificado — se é um proxy de assinatura, um cofre de senhas com automação RPA, um HSM compartilhado, etc.

### Preço
Não publicado. Não há página de planos/preços acessível nas páginas lidas; modelo parece ser sob consulta comercial (B2B para escritórios/departamentos jurídicos). [Gap]

### Lacunas (doc9)
- Não foi possível confirmar se o Whom.doc9 de fato opera com certificados ICP-Brasil (A1/A3) ou com algum outro tipo de credencial — o site evita o termo ICP-Brasil.
- Não foi possível confirmar o mecanismo exato de "liberação" do certificado para o usuário final (proxy server-side, extensão de navegador, agente local, etc.).
- Não há documentação de API pública localizada para doc9/Whom.doc9.
- Preço não é público.

---

## 2. Clicksign (clicksign.com)

### O que é o produto
Clicksign é uma plataforma SaaS brasileira de assinatura eletrônica de documentos (contratos, propostas, documentos de RH, prontuários médicos, etc.), com integração via API, widget embutido e envio por e-mail/WhatsApp. Afirma ser certificada ISO 27001 e ISO 27701 e ter validade jurídica sob a MP 2.200-2/2001 e a Lei 14.063/2020. [Fonte: clicksign.com/validade-juridica; clicksign.com/en/archive/preco3]

### Mercado-alvo
Empresas de todos os portes — da pequena/MEI até operações de maior volume —, com páginas verticais específicas para contabilidade e para saúde (prontuário/receita médica assinada com certificado ICP-Brasil, por exigência do CFM). [Fonte: clicksign.com/segmento-blog/contabilidade; clicksign.com/lp/icp-saude]

### Suporta certificado ICP-Brasil? Mecanismo exato
- Clicksign **oferece três "níveis" de assinatura**, segundo o material do próprio site: (1) **simples** (assinatura eletrônica básica); (2) **avançada** (verificação por token/selfie/Pix, sem certificado ICP-Brasil); (3) **certificada**, que usa **certificado credenciado ICP-Brasil**. [Fonte: WebSearch sobre clicksign.com/es/assinatura e páginas de preço]
- No plano de entrada ("Start") a própria página de preços lista como recurso explícito: **"Assine com Certificado Digital"**, ao lado de "Documentos assinados por e-mail", "Integre nossa API ao seu sistema" e "5 usuários" — ou seja, a opção de assinatura com certificado digital (ICP-Brasil) está disponível mesmo no plano mais barato, não é algo restrito a grandes contas. [Fonte: clicksign.com/assinaturav2 (conteúdo recuperado via busca)]
- Na página voltada à saúde, Clicksign confirma que aceita **certificado ICP-Brasil "em nuvem ou em token"** para atender exigências do CFM sobre prescrição e laudo médico. Isso indica suporte tanto a certificado A3 em nuvem (ex.: provedores como BirdID/SafeID/VIDaaS) quanto a token físico. [Fonte: clicksign.com/lp/icp-saude]
- **Não foi possível confirmar o mecanismo técnico exato** (se exige extensão de navegador tipo Web PKI/Lacuna, app local, ou se a integração com o provedor de certificado em nuvem é feita 100% server-to-server via API do provedor de nuvem, sem nada instalado no navegador do usuário). As páginas de marketing lidas não descrevem esse fluxo passo a passo, e o blog post específico sobre "o papel das plataformas de assinatura e o ecossistema ICP-Brasil" (clicksign.com/blog/o-papel-das-plataformas-de-assinatura-eletronica-e-o-ecossistema-icp-brasil) só confirma que existe integração com o ecossistema ICP-Brasil, sem detalhar a arquitetura — o corpo completo do artigo não pôde ser lido via fetch (retornou apenas metadados). [Gap]
- A documentação de API (developers.clicksign.com) não pôde ser acessada diretamente (fetch retornou 404 na URL testada); a página de produto "Integração"/API confirma cobrança por documento finalizado e existência de sandbox, mas o texto recuperado não lista os "tipos de qualificação de assinatura" disponíveis via API nem como acionar a assinatura com certificado ICP-Brasil programaticamente. [Gap]

### Contexto jurídico relevante (achado colateral)
- Decisão do STJ (2024) e decisão do TJBA confirmaram que uma assinatura eletrônica feita em plataforma privada **sem certificação ICP-Brasil** pode ter validade, inclusive para representação processual, desde que haja salvaguardas de autenticidade/integridade — isto é, Clicksign não depende de ICP-Brasil para ter validade jurídica na maioria dos usos (apoiando-se na Lei 14.063/2020 e MP 2.200-2/2001). Para uso no PJe (processo judicial eletrônico), a Lei 11.419/2006 pode exigir certificação ICP-Brasil como requisito mais estrito — há conflito entre fontes/decisões sobre esse ponto específico. [Fonte: legjur.com/jurisprudência citada em busca; convergenciadigital.com/governo/stj-dispensa-icp-brasil-para-assinatura-digital]

### Preço
- Não há tabela de preços em R$ publicada e acessível diretamente nas páginas lidas; os planos têm nomes (Start, Plus, Avançado) mas valores ficam atrás de formulário de contato comercial.
- Plano **Start**: envio por e-mail, assinatura com certificado digital, ordem de assinatura definida, integração via API, assinatura em lote, 5 usuários.
- Plano **Plus**: tudo do Start + assinatura por WhatsApp, verificação por biometria/selfie, personalização de marca, 10 usuários.
- Plano **Avançado**: indicado para quem tem demanda acima de 300 documentos/mês.
- Cobrança de API: por documento **finalizado** (todos os signatários assinaram), não por documento enviado; limite de 50 requisições a cada 10 segundos no ambiente integrado; ambiente de sandbox gratuito para testes. [Fonte: clicksign.com/assinaturav2; clicksign.com/integracao]

### Lacunas (Clicksign)
- Mecanismo técnico exato de uso do certificado ICP-Brasil (extensão de navegador vs. 100% server-side via API do provedor cloud) não confirmado.
- Documentação completa de developers.clicksign.com não foi acessível nesta pesquisa (URL testada retornou 404; seria necessário localizar a URL correta de docs, provavelmente sob um subdomínio ou caminho diferente).
- Valores de preço em R$ não publicados.

---

## 3. D4Sign (d4sign.com.br)

### O que é o produto
D4Sign é uma plataforma brasileira de assinatura eletrônica/digital e gestão de documentos/contratos, operada pela D4S Serviços em Tecnologia, parte do Grupo Zucchetti (adquirida por R$ 180 milhões, segundo a Baguete) e baseada em São Paulo. Oferece também "D4Sign.AI" (análise, resumo e rastreamento de contratos por IA), API com SSO/SAML 2.0, sandbox, armazenamento ilimitado em nuvem na AWS, migração de documentos de outras plataformas, certificação ISO 27001 e conformidade com LGPD. [Fonte: d4sign.com.br; baguete.com.br/public/noticias/zucchetti-compra-d4sign-por-r-180-milhoes]

### Mercado-alvo
Do pequeno negócio a grandes operações ("desde pequenos negócios até grandes operações"), com páginas para varejo/franquias, finanças, tecnologia, construção, mídia e educação. Clientes citados: AACD e Cury (via integração com o ERP Sienge). [Fonte: d4sign.com.br]

### Suporta certificado ICP-Brasil? Mecanismo exato
- A página institucional geral **não cita "ICP-Brasil" nominalmente**, mas o site afirma ter "+15 pontos de autenticação, incluindo certificado digital" e tem uma seção de desenvolvedor com um link para **"Web PKI"**, que direciona para uma página de configuração de plugin do Chrome.
- **Achado-chave desta pesquisa**: a extensão "Web PKI" é um produto da Lacuna Software, amplamente usado no mercado de ICP-Brasil para assinatura digital dentro do navegador. Segundo análise de terceiros sobre a extensão (não específica à D4Sign, mas descrevendo o mecanismo genérico do Web PKI): a página web chama a extensão via eventos customizados do navegador, e a extensão repassa o pedido para um **componente nativo instalado no computador do usuário via native messaging**. Esse componente nativo (baixado de websigner.softplan.com.br — "Web Signer", da Softplan, que adquiriu/distribui a tecnologia Lacuna) é necessário para acessar o certificado, seja um arquivo A1 (PFX/P12) importado localmente, seja um token/smartcard A3 via PKCS#11. [Fonte: extensionauditor.com/scan/web-pki-dcngeagmmhegagicpcmpinaoklddcgon; chrome webstore listing]
- A presença desse link "Web PKI" na seção de desenvolvedores do site da D4Sign é **forte indício, mas não confirmação direta e documentada pela própria D4Sign**, de que o mecanismo de assinatura com certificado ICP-Brasil da D4Sign depende de: (a) uma **extensão de navegador** (Web PKI) + (b) um **aplicativo/componente nativo instalado localmente** (Web Signer) para acessar o certificado do usuário (seja A1 em arquivo ou A3 em token/smartcard). Isto é consistente com o padrão de mercado para esse tipo de integração no Brasil (outras plataformas e sistemas de cartório/tribunal usam o mesmo Web PKI/Web Signer da Lacuna/Softplan).
- **Não foi possível confirmar diretamente no site da D4Sign** se eles também suportam certificado A3 em nuvem (BirdID, SafeID, NeoID, VIDaaS) nativamente via API do provedor de nuvem (sem exigir plugin no navegador) — o FAQ da D4Sign não pôde ser acessado (URL testada /perguntas-frequentes retornou 404), então essa confirmação ficou pendente. [Gap]
- A FAQ institucional lista a pergunta "Qual a diferença entre assinatura eletrônica e assinatura digital?" mas o texto da resposta não pôde ser capturado no fetch realizado. [Gap]

### Detalhes técnicos/arquitetura publicados
- API documentada, com sandbox e suporte a SSO/SAML 2.0.
- Armazenamento em nuvem AWS, sem limite.
- Seção de desenvolvedores cita integração "Web PKI" (ver acima).
- Certificação ISO 27001; conformidade LGPD declarada.
- Não há post de blog técnico ou whitepaper de arquitetura localizado nesta pesquisa detalhando o fluxo passo a passo da assinatura com certificado.

### Preço
- Segundo reportagem da Suno Notícias (sem data de publicação clara, portanto pode estar desatualizada): teste gratuito de 30 dias (3 envios); plano **Individual** (5 envios/mês) por R$ 24,90; plano **Profissional** (20 envios/mês) por R$ 49,90; plano **Corporativo** (40 envios/mês) por R$ 99,90; além de planos personalizados sob consulta com apoio de integração. [Fonte: suno.com.br/noticias — "Com assinatura eletrônica, D4Sign quer acabar com papelada e chegar a R$ 30 mi de faturamento"]
- O site oficial atual destaca "teste grátis por 30 dias, sem cartão de crédito" e "usuários ilimitados" como diferencial (ao contrário de cobrar por colaborador), mas não publica tabela de preços em R$ na página inicial; direciona para "Planos e preços" (conteúdo não capturado neste fetch). [Fonte: d4sign.com.br]
- Não ficou claro se a assinatura com certificado digital (ICP-Brasil) tem custo adicional por uso/autenticação — o próprio FAQ da D4Sign pergunta isso ("As autenticações possuem algum custo extra?") mas a resposta não foi capturada. [Gap]

### Lacunas (D4Sign)
- Confirmação direta (da própria D4Sign, não de terceiros) de que o mecanismo é extensão Web PKI + app nativo Web Signer.
- Se D4Sign suporta certificado A3 em nuvem sem exigir instalação local (via integração server-side com provedores como BirdID/SafeID).
- Tabela de preços atual e custo extra por autenticação com certificado digital.
- Texto completo do FAQ (perguntas-frequentes) — URL testada não existe mais nesse caminho.

---

## 4. Assinador gov.br / ITI (assinador.iti.gov.br / gov.br/iti)

### O que é o serviço
É o serviço oficial do governo federal brasileiro, operado pelo **ITI (Instituto Nacional de Tecnologia da Informação)**, para assinatura eletrônica de documentos usando a conta gov.br do cidadão. Faz parte da política de simplificação digital do governo (Decreto 10.543/2020, Lei 14.063/2020). Segundo reportagem da Convergência Digital, o serviço já havia emitido **324 milhões de assinaturas digitais em cinco anos**. [Fonte: convergenciadigital.com.br/governo/iti-emite-15-mil-assinaturas-digitais-por-minuto-no-gov-br]

### Mecanismo: **NÃO é assinatura com certificado ICP-Brasil do próprio usuário** — é um mecanismo distinto, mais simples
Esta é a resposta central da pesquisa, e está bem documentada na página oficial do ITI (gov.br/iti/pt-br/assuntos/assinatura-eletronica-avancada):

- **Requisito de conta**: é necessário ter conta gov.br em nível **prata ou ouro** (nível bronze não tem acesso). Texto oficial: "Para utilizar este serviço, é necessário ter uma conta Gov.br com nível prata ou ouro." [Fonte: gov.br/iti/pt-br/assuntos/assinatura-eletronica-avancada]
- **Certificado emitido automaticamente pelo próprio ITI, não um certificado ICP-Brasil do usuário**: ao assinar, "um certificado digital avançado é emitido automaticamente e de forma gratuita" e fica **armazenado na infraestrutura do próprio ITI** ("Esse certificado é armazenado na infraestrutura do Instituto Nacional de Tecnologia da Informação (ITI)"), com validade de 1 ano e uso ilimitado dentro desse prazo; pode ser revogado via DEPID/SGD. Ou seja, **o usuário não precisa ter — nem usa — um e-CPF/e-CNPJ ICP-Brasil próprio**; o "certificado avançado" é gerado e custodiado pelo próprio governo, vinculado à identidade validada da conta gov.br. [Fonte: gov.br/iti/pt-br/assuntos/assinatura-eletronica-avancada]
- **Chamado de "assinatura eletrônica avançada", não "assinatura digital ICP-Brasil"** — o próprio ITI, em outros materiais de opinião/imprensa, distingue os dois conceitos: assinatura digital ICP-Brasil usa certificado de Autoridade Certificadora credenciada pela ICP-Brasil; a assinatura eletrônica avançada do gov.br é "um mecanismo não criptografado" (segundo resumo de artigo do ITI) baseado na identidade validada da conta gov.br, mais simples e gratuita. [Fonte: achado consolidado de busca sobre gov.br/iti/pt-br/centrais-de-conteudo/opiniao-do-diretor-presidente, não lido na íntegra — tratar com cautela]
- **Fluxo de uso (segundo guias de terceiros — UFRGS, tecnoblog, UFMG — não confirmado linha a linha na página oficial)**: login na conta gov.br → upload do arquivo (DOC, DOCX, ODT, JPG, PNG ou PDF, até 100MB, segundo um guia) → posicionamento da assinatura no documento → confirmação, com código recebido por SMS no telefone cadastrado na conta → download do arquivo assinado. Um guia avisa que imprimir o arquivo assinado invalida a assinatura (a validade existe apenas no arquivo digital). [Fonte: tecnoblog.net/responde/como-fazer-uma-assinatura-digital-usando-o-gov-br; guia UFRGS — fontes de terceiros, não primárias]
- **Sem necessidade de certificado digital próprio**: por isso o serviço é gratuito e não exige token, smartcard, nem instalação de app/plugin — authentication é feita só pela conta gov.br (nível prata/ouro) + confirmação via SMS/app gov.br. [Fonte: consolidação dos achados acima]
- **Uso via API/integração**: a página cita que o serviço também pode ser usado "através do Portal de Assinatura Eletrônica ou de aplicações públicas integradas à plataforma gov.br via uma API do ITI" — ou seja, existe uma API oficial para terceiros (ex.: sistemas de outros órgãos públicos) integrarem esse mecanismo de assinatura eletrônica avançada baseada em login gov.br, não necessariamente para assinatura ICP-Brasil completa. [Fonte: gov.br/iti/pt-br/assuntos/assinatura-eletronica-avancada]

### Existe também assinatura com certificado ICP-Brasil "de verdade" no mesmo ecossistema
Fora do escopo do Assinador/assinatura eletrônica avançada, o ITI também é a raiz da ICP-Brasil (a autoridade certificadora raiz, AC-Raiz) e mantém o serviço de **validação de assinaturas digitais ICP-Brasil** em validar.iti.gov.br (app "Validar"), que verifica assinaturas feitas com certificados e-CPF/e-CNPJ emitidos por qualquer AC credenciada (Serasa, Certisign, Safeweb, Soluti, Valid etc.) — essa é a camada "de verdade" baseada em PKI tradicional, mas a **assinatura em si** com esse tipo de certificado não é feita pelo "Assinador gov.br"; é feita no software/plataforma de cada usuário (Adobe, Word, ou plataformas como D4Sign/Clicksign) e depois pode ser validada no site do ITI. [Fonte: achado de busca geral sobre validar.iti.gov.br; manuais universitários — não primário, mas consistente entre múltiplas fontes de terceiros]

### Detalhes técnicos/arquitetura publicados
- Página oficial confirma: nível de conta exigido, emissão automática e gratuita de certificado avançado custodiado pelo ITI, validade de 1 ano, possibilidade de revogação via DEPID/SGD, existência de API do ITI para integração de terceiros.
- Não há, na página lida, detalhamento de protocolo criptográfico, formato de assinatura (CAdES/PAdES/XAdES) nem arquitetura de backend.
- Tamanho máximo de arquivo (100MB) e tipos de arquivo aceitos (DOC, DOCX, ODT, JPG, PNG, PDF) vêm de guias de terceiros (UFRGS/tecnoblog), não confirmados na própria página do ITI nesta pesquisa. [Gap parcial]

### Preço
Gratuito — não há cobrança ao cidadão para usar o Portal de Assinatura Eletrônica do gov.br. [Fonte: consolidação dos achados — consistente em todas as fontes consultadas]

### Lacunas (gov.br/ITI)
- Confirmação textual direta, na própria página do ITI, do método de confirmação (SMS vs. app gov.br vs. ambos) — fontes de terceiros divergem ligeiramente nesse detalhe.
- Detalhes de protocolo/formato de assinatura (PAdES etc.) não publicados nas páginas acessadas.
- Não foi possível fazer fetch direto de assinador.iti.gov.br nem de "gov.br/iti/pt-br/assuntos/noticias/assinador-gov-br" (404); os achados vêm da página gov.br/iti/pt-br/assuntos/assinatura-eletronica-avancada, que parece ser a página oficial correta e atual sobre este serviço.

---

## Tabela comparativa

| Plataforma | Suporta certificado ICP-Brasil (e-CPF/e-CNPJ real)? | Mecanismo | Suporta assinatura eletrônica simples (clique)? | Cliente-alvo |
|---|---|---|---|---|
| **doc9 (Whom.doc9)** | Não é uma plataforma de assinatura; é um **gestor/cofre de acesso a certificados** já existentes da organização. Não confirma uso de ICP-Brasil nominalmente; menciona apenas "certificado A1". Mecanismo de assinatura em si não descrito. | Acesso controlado/rastreado a certificados via integração com +1.500 sistemas (GovBR, e-CAC, sistemas judiciais); "100% na nuvem, sem instalação" do lado do usuário, mas mecanismo de "liberação" não detalhado publicamente (**gap**) | Não é o foco do produto | Escritórios de advocacia, departamentos jurídicos corporativos, grupos empresariais |
| **Clicksign** | **Sim** — nível "certificada" usa certificado ICP-Brasil (token ou nuvem), confirmado inclusive no plano de entrada ("Start": "Assine com Certificado Digital") | Não confirmado em detalhe técnico (extensão de navegador vs. integração server-side com provedor de certificado em nuvem) — **gap** | **Sim** — é o modo padrão/mais usado (assinatura simples e avançada, com token/selfie/Pix) | PMEs a grandes empresas; verticais de contabilidade e saúde (onde ICP-Brasil é exigido pelo CFM) |
| **D4Sign** | **Sim**, indicado por "+15 pontos de autenticação, incluindo certificado digital" e link "Web PKI" na área de desenvolvedores | Fortes indícios (não confirmados diretamente pela D4Sign) de uso da extensão de navegador **Web PKI** (Lacuna/Softplan) + aplicativo nativo **Web Signer** instalado localmente, padrão de mercado para A1 (arquivo) e A3 (token/smartcard); suporte a A3 em nuvem sem plugin não confirmado — **gap** | **Sim** — também oferece assinatura eletrônica simples sem certificado, com múltiplos métodos de autenticação | Pequenos negócios a grandes operações; varejo, franquias, finanças, construção, educação |
| **gov.br / ITI (Assinador)** | **Não, no sentido estrito.** O "Assinador gov.br" usa uma **assinatura eletrônica avançada** com certificado emitido automaticamente e custodiado pelo próprio ITI (vinculado à conta gov.br nível prata/ouro), **não** o e-CPF/e-CNPJ ICP-Brasil tradicional do cidadão. A validação/uso de certificados ICP-Brasil "de verdade" ocorre em outro fluxo (ex.: validar.iti.gov.br valida assinaturas feitas em outros softwares) | Login gov.br (nível prata/ouro) → upload do arquivo → confirmação via SMS/app → certificado "avançado" próprio do ITI assina automaticamente; **gratuito**, sem app local, sem token, sem extensão de navegador | Sim — na prática esse é o único modo oferecido pelo Assinador gov.br (uma forma de assinatura eletrônica avançada gratuita, não clique-simples sem autenticação, mas também não PKI tradicional) | Qualquer cidadão com conta gov.br nível prata/ouro; uso em serviços públicos e aplicações integradas via API do ITI |

### Síntese da pergunta central do usuário
- **doc9**: foge do enquadramento usual — não é um assinador de documentos, é um gestor de acesso a certificados corporativos já existentes. Não há confirmação pública de que opere com ICP-Brasil nem de como a assinatura é efetivamente realizada.
- **Clicksign**: suporta ICP-Brasil, mas seu modelo de negócio é centrado na assinatura eletrônica simples/avançada (sem certificado) como padrão; o certificado ICP-Brasil é uma opção adicional, inclusive no plano básico.
- **D4Sign**: também suporta ambos os modos, com indícios fortes (não 100% confirmados pela própria empresa) de que o caminho técnico do certificado ICP-Brasil passa pela extensão de navegador Web PKI + aplicativo nativo Web Signer (padrão de mercado da Lacuna/Softplan) — ou seja, SIM, exige componente instalado localmente/no navegador para esse caminho específico.
- **gov.br/ITI**: é o único dos quatro que **não** oferece assinatura com certificado ICP-Brasil tradicional do cidadão dentro do próprio Assinador — oferece uma assinatura eletrônica avançada mais simples e gratuita, baseada na identidade da conta gov.br, com certificado emitido e custodiado pelo próprio governo (distinto do e-CPF/e-CNPJ clássico).

## Limitações gerais desta pesquisa
- Várias páginas-chave retornaram erro 404 no momento da pesquisa (FAQ da D4Sign, página de notícia específica do ITI sobre o assinador, developers.clicksign.com na raiz), o que limitou a confirmação de detalhes técnicos finos.
- Nenhuma das quatro plataformas publica, em conteúdo acessível por busca/fetch simples, um diagrama de arquitetura técnica detalhado (ex.: blog de engenharia) sobre o fluxo exato de assinatura com certificado ICP-Brasil — a evidência mais forte encontrada (D4Sign + Web PKI) vem de inferência a partir de um link na seção de desenvolvedores, cruzado com conhecimento de terceiros sobre o que é a extensão "Web PKI".
- Recomenda-se, para confirmação definitiva, contato direto com o suporte/comercial de cada plataforma ou leitura de sua documentação de API autenticada (ex.: portal de desenvolvedores após login/cadastro), que não foi acessível nesta pesquisa pública.

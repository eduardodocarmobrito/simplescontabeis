# Imagem oficial do Playwright — já vem com o Chromium e todas as bibliotecas do sistema que ele
# precisa pra rodar (libglib, libnss etc.). A build padrão do Railway (Railpack/Nixpacks) não tem
# como instalar essas dependências de sistema, então o Chromium baixava mas não conseguia abrir
# ("error while loading shared libraries: libglib-2.0.so.0") — usado pra gerar PDF (DANFSe, NF-e
# simplificada, contratos). A tag da imagem tem que bater com a versão do pacote "playwright" no
# package.json (ver node_modules/playwright/package.json) — senão o Chromium da imagem não bate com
# a versão que o código espera.
FROM mcr.microsoft.com/playwright:v1.62.1-noble

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . ./
RUN npm run build

EXPOSE 3000
CMD ["npm", "start"]

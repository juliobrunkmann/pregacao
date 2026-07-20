# Guia de Deploy — Gerador de Pregações

Esta versão evoluiu a arquitetura para três objetivos: **chave da API segura no servidor**, **histórico de pregações** e **deploy automático via GitHub**.

## Estrutura do projeto

```
gerador-pregacoes/
├── index.html                    ← app (agora sem chave no navegador)
├── kenyon-context.js             ← base de conhecimento (inalterada)
├── netlify.toml                  ← configuração do Netlify
├── package.json                  ← dependência @netlify/blobs
└── netlify/
    └── functions/
        ├── gerar.js              ← proxy seguro da API (streaming)
        └── historico.js          ← histórico via Netlify Blobs
```

## O que mudou no app

A caixa "🔑 Chave API Anthropic" saiu do app. Agora o navegador chama `/api/gerar`, e a função no Netlify usa a chave guardada em variável de ambiente. A chave nunca mais aparece no código do navegador.

Cada pregação gerada é salva automaticamente no histórico. Um botão **🗂️ Histórico** no topo abre a lista, onde você pode ver ou excluir cada mensagem.

---

## Passo 1 — Subir para o GitHub

1. No GitHub, crie um repositório novo (ex.: `gerador-pregacoes`). Pode ser privado.
2. Envie os arquivos mantendo a estrutura de pastas acima. Duas formas:
   - **Pela web:** em "Add file → Upload files", arraste `index.html`, `kenyon-context.js`, `netlify.toml` e `package.json`. Para as functions, arraste a pasta `netlify` inteira (o GitHub preserva `netlify/functions/...`).
   - **Pelo Git (terminal):**
     ```
     cd gerador-pregacoes
     git init
     git add .
     git commit -m "Gerador de Pregações — chave segura + histórico"
     git branch -M main
     git remote add origin https://github.com/SEU-USUARIO/gerador-pregacoes.git
     git push -u origin main
     ```

## Passo 2 — Conectar o Netlify ao GitHub

1. No Netlify: **Add new site → Import an existing project → GitHub**.
2. Autorize e escolha o repositório `gerador-pregacoes`.
3. Configurações de build (pode deixar praticamente em branco):
   - **Build command:** *(vazio)*
   - **Publish directory:** `.`
   - **Functions directory:** `netlify/functions` *(o `netlify.toml` já define isso)*
4. Clique em **Deploy**.

> Se você já tem um site no Netlify para este projeto (do deploy manual), pode conectá-lo ao GitHub em **Site configuration → Build & deploy → Link repository**, em vez de criar um novo.

## Passo 3 — Configurar a chave da API (variável de ambiente)

1. No painel do site: **Site configuration → Environment variables → Add a variable**.
2. Crie:
   - **Key:** `ANTHROPIC_API_KEY`
   - **Value:** sua chave `sk-ant-...`
3. Salve e faça um **redeploy** (Deploys → Trigger deploy → Deploy site) para a variável valer.

## Passo 4 — Ativar o Netlify Blobs (histórico)

O Netlify Blobs funciona automaticamente com as Functions v2 deste projeto — não há nada para instalar manualmente. Na maioria das contas já vem habilitado. Se o histórico não salvar, confirme em **Site configuration → Blobs** que o recurso está ativo.

---

## Pronto — deploy automático

A partir daqui, qualquer arquivo que você atualizar no GitHub dispara um novo deploy automático no Netlify. Fim do arrasta-e-solta manual.

## Observações

- **Modelo de IA:** a função usa `claude-sonnet-4-6` (o mesmo que seu app já usava). Se algum dia a Anthropic retornar erro de "modelo não encontrado", troque o nome do modelo em `netlify/functions/gerar.js` (linha do `const model = ...`).
- **Testar localmente (opcional):** com o [Netlify CLI](https://docs.netlify.com/cli/get-started/), rode `npm install` e depois `netlify dev` na pasta do projeto. Isso sobe as functions e o Blobs localmente. Defina a chave com `netlify env:set ANTHROPIC_API_KEY sk-ant-...` ou um arquivo `.env`.
- **Custo:** tudo cabe no plano gratuito do Netlify para uso individual.

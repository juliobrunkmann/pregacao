// =====================================================================
// netlify/functions/gerar-iniciar.js
// BACKGROUND FUNCTION — inicia a geração da pregação e roda até o fim
// no servidor, independente do navegador continuar conectado ou não.
//
// Por quê: no celular, trocar de app (ou a tela apagar) faz o navegador
// suspender/derrubar a conexão de streaming em andamento — a geração
// simplesmente parava no meio sem nenhum erro visível. Uma Background
// Function do Netlify roda até 15 minutos DEPOIS de já ter respondido
// ao cliente (resposta 202 imediata), então a chamada à Anthropic
// continua até terminar mesmo que ninguém esteja mais "ouvindo".
//
// O cliente acompanha o progresso via polling em /api/gerar-status
// (lê o que esta function vai escrevendo no Blobs conforme gera), e
// pode retomar esse acompanhamento depois de reabrir a página.
//
// Fluxo:
//   1. Cliente faz POST aqui com { jobId, prompt, max_tokens, meta }
//   2. Esta function responde 202 na hora (comportamento padrão de
//      Background Function) e continua rodando sozinha
//   3. Vai escrevendo o progresso em Blobs (store "pregacoes-jobs",
//      chave = jobId) conforme os pedaços chegam da Anthropic
//   4. Ao terminar, marca status "done" (ou "error") e salva
//      automaticamente no histórico via POST /api/historico — assim a
//      pregação não se perde mesmo que o cliente nunca mais volte.
// =====================================================================

import { getStore } from '@netlify/blobs';

const SITE_URL =
  process.env.URL || process.env.DEPLOY_URL || 'https://friendly-bubblegum-e2dbd3.netlify.app';

export default async (req) => {
  if (req.method !== 'POST') return;

  let body;
  try {
    body = await req.json();
  } catch (e) {
    return;
  }

  const { jobId, prompt, max_tokens, meta } = body || {};
  if (!jobId || !prompt || typeof prompt !== 'string') return;

  const store = getStore({ name: 'pregacoes-jobs', consistency: 'strong' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    await store.setJSON(jobId, {
      status: 'error',
      error: 'Chave da API não configurada no servidor. Defina ANTHROPIC_API_KEY no painel do Netlify.',
      meta: meta || {},
      updatedAt: Date.now(),
    });
    return;
  }

  await store.setJSON(jobId, { status: 'pending', text: '', meta: meta || {}, updatedAt: Date.now() });

  const model = (body && body.model) || 'claude-sonnet-4-6';
  const maxTokens = max_tokens || 9000;

  let anthropicRes;
  try {
    anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        stream: true,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
  } catch (e) {
    await store.setJSON(jobId, {
      status: 'error',
      error: 'Falha ao contatar a API da Anthropic: ' + e.message,
      meta: meta || {},
      updatedAt: Date.now(),
    });
    return;
  }

  if (!anthropicRes.ok) {
    const errText = await anthropicRes.text();
    let msg = 'Erro ' + anthropicRes.status + ' na API da Anthropic.';
    try {
      const parsed = JSON.parse(errText);
      if (parsed?.error?.message) msg = parsed.error.message;
    } catch (e) {}
    await store.setJSON(jobId, { status: 'error', error: msg, meta: meta || {}, updatedAt: Date.now() });
    return;
  }

  const reader = anthropicRes.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let sseBuffer = '';
  let stopReason = null;
  let deltaCount = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      sseBuffer += decoder.decode(value, { stream: true });
      const lines = sseBuffer.split('\n');
      sseBuffer = lines.pop();

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6);
        if (data === '[DONE]') continue;
        try {
          const parsed = JSON.parse(data);
          if (parsed.type === 'content_block_delta' && parsed.delta?.text) {
            text += parsed.delta.text;
            deltaCount++;
            // Não grava no Blobs a cada pedacinho (seriam centenas de
            // escritas) — só de vez em quando, o suficiente pra quem
            // está acompanhando ver o texto crescendo.
            if (deltaCount % 20 === 0) {
              await store.setJSON(jobId, {
                status: 'streaming',
                text,
                meta: meta || {},
                updatedAt: Date.now(),
              });
            }
          } else if (parsed.type === 'message_delta' && parsed.delta?.stop_reason) {
            stopReason = parsed.delta.stop_reason;
          }
        } catch (e) {}
      }
    }
  } catch (e) {
    await store.setJSON(jobId, {
      status: 'error',
      error: 'A conexão com a Anthropic caiu no meio da geração: ' + e.message,
      text,
      meta: meta || {},
      updatedAt: Date.now(),
    });
    return;
  }

  text = limparBlocoCodigo(text);
  const foiCortada = stopReason === 'max_tokens';

  await store.setJSON(jobId, {
    status: 'done',
    text,
    truncated: foiCortada,
    meta: meta || {},
    updatedAt: Date.now(),
  });

  // Salva no histórico automaticamente — independe do cliente ainda estar
  // conectado. Se isso falhar por algum motivo, o texto final já está
  // salvo no job em si (Blobs "pregacoes-jobs"), então nada se perde.
  try {
    const m = meta || {};
    await fetch(SITE_URL + '/api/historico', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tema: m.tema,
        publico: m.publico,
        contexto: m.contexto,
        modo: m.modo,
        tempo: m.tempo,
        ocasiao: m.ocasiao,
        profundidade: m.profundidade,
        conteudo: text,
      }),
    });
  } catch (e) {
    // não trava o job por causa disso
  }
};

// Remove um bloco de código markdown (```html ... ``` ou ``` ... ```) que a
// IA às vezes adiciona por conta própria em volta do HTML gerado.
function limparBlocoCodigo(texto) {
  if (!texto) return texto;
  let t = texto.trim();
  t = t.replace(/^```(?:html)?\s*\n?/i, '');
  t = t.replace(/\n?```\s*$/, '');
  return t;
}

export const config = {
  path: '/api/gerar-iniciar',
  background: true,
};

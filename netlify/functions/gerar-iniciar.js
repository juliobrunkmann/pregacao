// =====================================================================
// netlify/functions/gerar-iniciar.js
// BACKGROUND FUNCTION — inicia a geração da pregação e roda até o fim
// no servidor, independente do navegador continuar conectado ou não.
//
// Por quê: no celular, trocar de app (ou a tela apagar) faz o navegador
// suspender/derrubar a conexão de streaming em andamento — a geração
// simplesmente parava no meio sem nenhum erro visível.
//
// DESCOBERTA IMPORTANTE (testada ao vivo em produção): apesar de a
// documentação da Netlify dizer que Background Functions rodam até 15
// minutos, nesta conta/plano a chamada de saída para a Anthropic estava
// sendo interrompida silenciosamente por volta de ~25-30s (sem erro,
// sem exceção capturável — o texto simplesmente parava de crescer e o
// job ficava travado em "streaming" para sempre). Então, em vez de
// depender de uma única chamada rodar até o fim, esta function se
// AUTO-ENCADEIA: cada execução gera só uma fatia (bem abaixo desse
// limite observado) e, se a pregação ainda não terminou, dispara uma
// nova chamada a si mesma (fire-and-forget, sem esperar resposta) para
// continuar de onde parou — usando a técnica de "prefill": manda o
// texto já gerado como se fosse a última mensagem do assistente, e a
// Anthropic continua a partir dali. Isso se repete até a mensagem
// terminar naturalmente (ou até o limite de segurança de continuações).
//
// O cliente acompanha o progresso via polling em /api/gerar-status
// (lê o que esta function vai escrevendo no Blobs conforme gera), e
// pode retomar esse acompanhamento depois de reabrir a página — nada
// disso depende do cliente estar conectado, porque quem re-dispara a
// próxima fatia é o próprio servidor, não o navegador.
//
// Fluxo:
//   1. Cliente faz POST aqui com { jobId, prompt, max_tokens, meta }
//   2. Esta function responde 202 na hora e continua rodando sozinha
//   3. Gera uma fatia por até TEMPO_MAX_POR_CHAMADA_MS, escrevendo o
//      progresso em Blobs (store "pregacoes-jobs", chave = jobId)
//   4. Se a resposta da Anthropic ainda não terminou quando a fatia
//      acaba, chama a si mesma de novo com o texto acumulado até agora
//      (tentativa + 1) e encerra essa execução
//   5. Quando a resposta termina de verdade, marca status "done" (ou
//      "error") e salva automaticamente no histórico — assim a
//      pregação não se perde mesmo que o cliente nunca mais volte.
// =====================================================================

import { getStore } from '@netlify/blobs';

const SITE_URL =
  process.env.URL || process.env.DEPLOY_URL || 'https://friendly-bubblegum-e2dbd3.netlify.app';

// Margem de segurança bem abaixo do corte de ~25-30s observado ao vivo.
const TEMPO_MAX_POR_CHAMADA_MS = 15000;
// Cada leitura individual do stream é limitada a isso — garante que a
// checagem do tempo total roda com frequência, mesmo que uma leitura
// específica demore (rede lenta, etc.), em vez de arriscar estourar o
// limite da chamada esperando um único read() que não retorna.
const TEMPO_MAX_POR_LEITURA_MS = 5000;
// Trava de segurança: no máximo essa quantidade de continuações
// encadeadas (25 x ~15s ≈ 6 minutos de geração total, bem mais que o
// suficiente para a maior pregação que este app gera).
const MAX_CONTINUACOES = 30;

export default async (req) => {
  if (req.method !== 'POST') return;

  let body;
  try {
    body = await req.json();
  } catch (e) {
    return;
  }

  const { jobId, prompt, max_tokens, meta, textoAcumulado, tentativa } = body || {};
  if (!jobId || !prompt || typeof prompt !== 'string') return;

  const store = getStore({ name: 'pregacoes-jobs', consistency: 'strong' });
  const numTentativa = tentativa || 0;
  const acumulado = textoAcumulado || '';

  if (numTentativa === 0) {
    await store.setJSON(jobId, { status: 'pending', text: '', meta: meta || {}, updatedAt: Date.now() });
  }

  if (numTentativa >= MAX_CONTINUACOES) {
    await store.setJSON(jobId, {
      status: 'error',
      error: 'A geração excedeu o tempo máximo permitido no servidor.',
      text: limparBlocoCodigo(acumulado),
      meta: meta || {},
      updatedAt: Date.now(),
    });
    return;
  }

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

  const model = (body && body.model) || 'claude-sonnet-4-6';
  const maxTokens = max_tokens || 9000;

  // Se já tem texto acumulado de fatias anteriores, manda ele como a última
  // mensagem do "assistant" (prefill) — a Anthropic continua a resposta
  // exatamente de onde parou, em vez de começar tudo de novo.
  const messages = [{ role: 'user', content: prompt }];
  if (acumulado) {
    messages.push({ role: 'assistant', content: acumulado });
  }

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
        messages,
      }),
    });
  } catch (e) {
    await store.setJSON(jobId, {
      status: 'error',
      error: 'Falha ao contatar a API da Anthropic: ' + e.message,
      text: limparBlocoCodigo(acumulado),
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
    await store.setJSON(jobId, {
      status: 'error',
      error: msg,
      text: limparBlocoCodigo(acumulado),
      meta: meta || {},
      updatedAt: Date.now(),
    });
    return;
  }

  const reader = anthropicRes.body.getReader();
  const decoder = new TextDecoder();
  let textoNovo = '';
  let sseBuffer = '';
  let stopReason = null;
  let deltaCount = 0;
  let cortadoPorTempo = false;
  const inicioChamada = Date.now();

  try {
    while (true) {
      const restante = TEMPO_MAX_POR_CHAMADA_MS - (Date.now() - inicioChamada);
      if (restante <= 0) {
        cortadoPorTempo = true;
        try { await reader.cancel(); } catch (e) {}
        break;
      }

      const resultado = await lerComTimeout(reader, Math.min(restante, TEMPO_MAX_POR_LEITURA_MS));
      if (resultado.__timeout) continue; // volta ao topo e reavalia o tempo restante
      const { done, value } = resultado;
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
            textoNovo += parsed.delta.text;
            deltaCount++;
            if (deltaCount % 20 === 0) {
              await store.setJSON(jobId, {
                status: 'streaming',
                text: acumulado + textoNovo,
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
    // Conexão caiu no meio de uma fatia — ainda assim tenta continuar a
    // partir do que já foi gerado até agora, em vez de perder tudo.
    cortadoPorTempo = true;
  }

  const textoTotal = acumulado + textoNovo;

  if (cortadoPorTempo) {
    // Ainda não terminou — grava o progresso e dispara a próxima fatia
    // (fire-and-forget: não espera a resposta, só confirma que foi aceita).
    await store.setJSON(jobId, { status: 'streaming', text: textoTotal, meta: meta || {}, updatedAt: Date.now() });
    try {
      const proxima = await fetch(SITE_URL + '/api/gerar-iniciar', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jobId,
          prompt,
          max_tokens: maxTokens,
          meta,
          textoAcumulado: textoTotal,
          tentativa: numTentativa + 1,
        }),
      });
      if (!proxima.ok) {
        await store.setJSON(jobId, {
          status: 'error',
          error: 'Não foi possível continuar a geração (erro ' + proxima.status + ').',
          text: limparBlocoCodigo(textoTotal),
          meta: meta || {},
          updatedAt: Date.now(),
        });
      }
    } catch (e) {
      await store.setJSON(jobId, {
        status: 'error',
        error: 'Falha ao continuar a geração: ' + e.message,
        text: limparBlocoCodigo(textoTotal),
        meta: meta || {},
        updatedAt: Date.now(),
      });
    }
    return;
  }

  // Terminou de verdade — já vem limpo de bloco ```html antes de marcar
  // como concluído.
  const textoFinal = limparBlocoCodigo(textoTotal);
  const foiCortada = stopReason === 'max_tokens';

  await store.setJSON(jobId, {
    status: 'done',
    text: textoFinal,
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
        conteudo: textoFinal,
      }),
    });
  } catch (e) {
    // não trava o job por causa disso
  }
};

// Lê o próximo pedaço do stream com um limite de tempo — se demorar demais,
// devolve um marcador de timeout em vez de ficar esperando indefinidamente,
// pra quem chamou poder reavaliar quanto tempo ainda resta na fatia atual.
function lerComTimeout(reader, timeoutMs) {
  return Promise.race([
    reader.read(),
    new Promise((resolve) => setTimeout(() => resolve({ __timeout: true }), timeoutMs)),
  ]);
}

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

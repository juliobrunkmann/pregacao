// =====================================================================
// netlify/functions/gerar-iniciar.js
// BACKGROUND FUNCTION — inicia a geração da pregação. Responde 202 na
// hora e roda a 1ª fatia da geração no servidor, independente do
// navegador continuar conectado ou não.
//
// Por quê: no celular, trocar de app (ou a tela apagar) faz o navegador
// suspender/derrubar a conexão de streaming em andamento — a geração
// simplesmente parava no meio sem nenhum erro visível.
//
// HISTÓRICO DAS DESCOBERTAS (testadas ao vivo em produção nesta conta):
//   1ª tentativa — uma única Background Function rodando até o fim:
//     apesar da documentação da Netlify prometer até 15 min de execução,
//     a chamada de saída pra Anthropic estava sendo cortada
//     silenciosamente por volta de ~25-30s (sem exceção, sem log — só
//     parava de escrever progresso e o job ficava travado pra sempre).
//   2ª tentativa — a function se auto-encadeava (chamava a si mesma via
//     fetch a cada ~15s pra continuar): funcionou por algumas fatias,
//     mas a Netlify tem uma proteção anti-loop que BLOQUEIA uma function
//     chamando a si mesma repetidamente — depois de ~9-10 chamadas
//     seguidas, passa a responder 508 "Loop Detected" e a geração trava
//     de novo (confirmado testando com uma pregação de 60min/Profunda).
//   3ª tentativa (a atual) — CRON: em vez de se auto-chamar, esta
//     function processa só a 1ª fatia (gerarUmaFatia, ~15s) e, se ainda
//     não terminou, GRAVA o estado de continuação no Blobs (prompt,
//     tokens, texto acumulado, etc.) e simplesmente retorna. Quem
//     continua a partir daí é o gerar-continuar-cron.js — uma Scheduled
//     Function que a própria Netlify dispara sozinha a cada 1 minuto e
//     processa uma fatia por vez de qualquer job pendente. Como não é
//     a function chamando a si mesma, a proteção anti-loop não entra em
//     ação, e o job continua até terminar de verdade — só que agora em
//     "fatias" de ~1 em 1 minuto em vez de encadeadas na hora.
//
// O cliente acompanha o progresso via polling em /api/gerar-status (lê
// o que vai sendo escrito no Blobs conforme a geração avança), e pode
// retomar esse acompanhamento depois de reabrir a página — nada disso
// depende do cliente estar conectado, porque quem processa as fatias
// seguintes é o cron do servidor, não o navegador.
// =====================================================================

import { getStore } from '@netlify/blobs';
import { gerarUmaFatia, limparBlocoCodigo, adicionarPendente, removerPendente } from './_lib/geracao.js';

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

  const model = (body && body.model) || 'claude-sonnet-4-6';
  const maxTokens = max_tokens || 9000;

  await store.setJSON(jobId, { status: 'pending', text: '', meta: meta || {}, updatedAt: Date.now() });

  const fatia = await gerarUmaFatia({ apiKey, model, maxTokens, prompt, acumulado: '' });

  if (fatia.erro) {
    await store.setJSON(jobId, { status: 'error', error: fatia.erro, meta: meta || {}, updatedAt: Date.now() });
    return;
  }

  const textoTotal = fatia.textoNovo;

  if (fatia.cortadoPorTempo) {
    // Ainda não terminou — grava tudo que o cron precisa pra continuar
    // sozinho a partir daqui (sem depender do cliente nem desta function
    // se auto-chamar), e entra no índice de pendências pra o cron saber
    // que existe algo pra continuar sem precisar vasculhar tudo.
    await store.setJSON(jobId, {
      status: 'streaming',
      text: textoTotal,
      meta: meta || {},
      updatedAt: Date.now(),
      _continuar: true,
      _prompt: prompt,
      _maxTokens: maxTokens,
      _model: model,
      _fatia: 1,
    });
    await adicionarPendente(store, jobId);
    return;
  }

  // Terminou na 1ª fatia (pregações mais curtas, modo Pocket, etc.)
  await finalizarJob({ store, jobId, textoTotal, stopReason: fatia.stopReason, meta });
};

export async function finalizarJob({ store, jobId, textoTotal, stopReason, meta }) {
  const textoFinal = limparBlocoCodigo(textoTotal);
  // Considera "truncado" qualquer finalização que não foi um término
  // natural do modelo (end_turn) — inclui max_tokens e também o caso de
  // segurança em que o cron precisou finalizar por ter batido o limite
  // de fatias (ver gerar-continuar-cron.js), pra sempre entregar algo
  // útil ao usuário em vez de descartar o que já foi gerado.
  const foiCortada = stopReason !== 'end_turn';

  await store.setJSON(jobId, {
    status: 'done',
    text: textoFinal,
    truncated: foiCortada,
    meta: meta || {},
    updatedAt: Date.now(),
  });
  // Pregação concluída = "fechada" — sai do índice de pendências (se
  // estava lá; se terminou já na 1ª fatia, nunca chegou a entrar, e
  // remover algo que não está lá não faz nada).
  await removerPendente(store, jobId);

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
}

export const config = {
  path: '/api/gerar-iniciar',
  background: true,
};

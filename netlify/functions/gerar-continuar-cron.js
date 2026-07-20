// =====================================================================
// netlify/functions/gerar-continuar-cron.js
// SCHEDULED FUNCTION — dispara sozinha a cada 1 minuto (a própria
// Netlify chama, não uma function chamando a si mesma) e continua
// qualquer geração de pregação que ainda esteja pendente, uma fatia
// (~15s) por vez, até terminar.
//
// Por quê existe: ver o comentário no topo de gerar-iniciar.js — em
// resumo, uma única Background Function não roda por mais de ~25-30s
// nesta conta/plano, e fazer a function se auto-chamar pra continuar
// esbarra na proteção anti-loop da Netlify (erro 508 depois de ~9-10
// chamadas seguidas). Uma Scheduled Function disparada pela própria
// plataforma não conta como "auto-chamada", então não trava.
//
// Cada tick processa os jobs pendentes (status "streaming" com a marca
// interna _continuar=true) em ordem, dando a cada um uma fatia de tempo,
// dentro do limite de 30s que a Netlify impõe a Scheduled Functions.
// =====================================================================

import { getStore } from '@netlify/blobs';
import { gerarUmaFatia, MAX_FATIAS } from './_lib/geracao.js';
import { finalizarJob } from './gerar-iniciar.js';

// Deixa uma margem segura abaixo do limite de 30s que a Netlify impõe a
// Scheduled Functions — se não sobrar tempo suficiente pra outro job,
// para por aqui e deixa o resto pro próximo tick (daqui a 1 minuto).
const ORCAMENTO_TOTAL_MS = 24000;

export default async (req) => {
  const store = getStore({ name: 'pregacoes-jobs', consistency: 'strong' });
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return; // sem chave, não tem o que fazer (gerar-iniciar já teria marcado erro)

  const inicio = Date.now();
  let pendentes;
  try {
    const listagem = await store.list();
    pendentes = listagem.blobs || [];
  } catch (e) {
    return;
  }

  for (const item of pendentes) {
    const restanteGeral = ORCAMENTO_TOTAL_MS - (Date.now() - inicio);
    if (restanteGeral < 5000) break; // não sobra nem pra uma fatia mínima seguinte

    let job;
    try {
      job = await store.get(item.key, { type: 'json' });
    } catch (e) {
      continue;
    }
    if (!job || job.status !== 'streaming' || !job._continuar) continue;

    const jobId = item.key;
    const fatiaAtual = (job._fatia || 1) + 1;

    if (fatiaAtual > MAX_FATIAS) {
      await store.setJSON(jobId, {
        status: 'error',
        error: 'A geração excedeu o tempo máximo permitido no servidor.',
        text: job.text || '',
        meta: job.meta || {},
        updatedAt: Date.now(),
      });
      continue;
    }

    const fatia = await gerarUmaFatia({
      apiKey,
      model: job._model,
      maxTokens: job._maxTokens,
      prompt: job._prompt,
      acumulado: job.text || '',
    });

    if (fatia.erro) {
      await store.setJSON(jobId, {
        status: 'error',
        error: fatia.erro,
        text: job.text || '',
        meta: job.meta || {},
        updatedAt: Date.now(),
      });
      continue;
    }

    const textoTotal = (job.text || '') + fatia.textoNovo;

    if (fatia.cortadoPorTempo) {
      await store.setJSON(jobId, {
        status: 'streaming',
        text: textoTotal,
        meta: job.meta || {},
        updatedAt: Date.now(),
        _continuar: true,
        _prompt: job._prompt,
        _maxTokens: job._maxTokens,
        _model: job._model,
        _fatia: fatiaAtual,
      });
      continue;
    }

    // Terminou de verdade nesta fatia.
    await finalizarJob({ store, jobId, textoTotal, stopReason: fatia.stopReason, meta: job.meta });
  }
};

export const config = {
  schedule: '* * * * *',
};

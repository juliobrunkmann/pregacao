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
// ÍNDICE DE PENDÊNCIAS (adicionado depois, ao perceber o problema de
// custo): a Netlify não permite condicionar o disparo do tick — ele
// sempre acontece, a cada 1 minuto, pra sempre, mesmo sem nada pra
// fazer. A versão original desse arquivo lidava com isso vasculhando
// TODO o histórico de pregações já geradas (`store.list()` + 1 leitura
// por item) a cada tick só pra achar as pendentes — um custo que cresce
// sem limite conforme mais pregações vão sendo geradas ao longo dos
// meses (medido: passaria dos 300 créditos/mês do plano gratuito em
// poucos meses de uso normal, só de tick ocioso). Agora o tick lê só o
// índice pequeno (`CHAVE_INDICE_PENDENTES`, ver _lib/geracao.js) — se
// estiver vazio, encerra na hora. O custo do tick ocioso fica baixo e
// constante pra sempre, não importa quantas pregações já foram geradas.
//
// Cada tick processa os jobs do índice (status "streaming" com a marca
// interna _continuar=true) em ordem, dando a cada um uma fatia de tempo,
// dentro do limite de 30s que a Netlify impõe a Scheduled Functions.
// =====================================================================

import { getStore } from '@netlify/blobs';
import { gerarUmaFatia, MAX_FATIAS, obterPendentes, removerPendente } from './_lib/geracao.js';
import { finalizarJob } from './gerar-iniciar.js';

// Deixa uma margem segura abaixo do limite de 30s que a Netlify impõe a
// Scheduled Functions — se não sobrar tempo suficiente pra outro job,
// para por aqui e deixa o resto pro próximo tick (daqui a 1 minuto).
const ORCAMENTO_TOTAL_MS = 24000;

export default async (req) => {
  const store = getStore({ name: 'pregacoes-jobs', consistency: 'strong' });

  // Leitura barata: só o índice, não o histórico inteiro. Se não tem
  // nada pendente, o tick encerra aqui — é isso que mantém o custo do
  // disparo ocioso baixo pra sempre.
  const pendentesIds = await obterPendentes(store);
  if (pendentesIds.length === 0) return;

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return; // sem chave, não tem o que fazer (gerar-iniciar já teria marcado erro)

  const inicio = Date.now();

  for (const jobId of pendentesIds) {
    const restanteGeral = ORCAMENTO_TOTAL_MS - (Date.now() - inicio);
    if (restanteGeral < 5000) break; // não sobra nem pra uma fatia mínima seguinte

    let job;
    try {
      job = await store.get(jobId, { type: 'json' });
    } catch (e) {
      continue;
    }
    if (!job || job.status !== 'streaming' || !job._continuar) {
      // Estado inconsistente (ex.: já foi finalizado por outro caminho,
      // ou o job nem existe mais) — o índice se autocorrige removendo
      // essa entrada, em vez de continuar tentando pra sempre.
      await removerPendente(store, jobId);
      continue;
    }

    const fatiaAtual = (job._fatia || 1) + 1;

    if (fatiaAtual > MAX_FATIAS) {
      // Bateu o limite de segurança de fatias sem terminar naturalmente.
      // Em vez de descartar tudo com um erro, finaliza com o que já foi
      // gerado até aqui (marcado como truncado) — o usuário fica com uma
      // pregação utilizável em vez de nada. finalizarJob() já remove do
      // índice.
      await finalizarJob({
        store,
        jobId,
        textoTotal: job.text || '',
        stopReason: 'limite_de_fatias_atingido',
        meta: job.meta,
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
      await removerPendente(store, jobId);
      continue;
    }

    const textoTotal = (job.text || '') + fatia.textoNovo;

    if (fatia.cortadoPorTempo) {
      // Ainda não terminou — continua no índice, nada a fazer ali.
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

    // Terminou de verdade nesta fatia. finalizarJob() já remove do índice.
    await finalizarJob({ store, jobId, textoTotal, stopReason: fatia.stopReason, meta: job.meta });
  }
};

export const config = {
  schedule: '* * * * *',
};

const env = require('../config/env');
const logger = require('../lib/logger');
const appSettings = require('./app-settings');

function buildFallbackCopy({ profile, campaign, sequenceStep, checkoutUrl, messageType, socialProof, abHook }) {
  const targetLabel = campaign.target_type === 'vip' ? 'seu VIP' : 'esse conteudo';
  const suffix = checkoutUrl ? `\nFinalize aqui: ${checkoutUrl}` : '';
  const fastDecision = profile.intentScore >= 70 ? 'agora' : 'quando quiser';
  const prefix = abHook ? `${abHook.trim()}\n` : '';
  const proof = socialProof ? ` ${socialProof}` : '';

  if (messageType === 'social-proof') {
    return {
      text:
        `${prefix}Vi seu interesse em ${targetLabel}.${proof} Quem decide ${fastDecision} costuma aproveitar mais rapido e sem perder o melhor momento.${suffix}`.trim(),
      reasoning: 'fallback-social-proof'
    };
  }

  if (sequenceStep === 3) {
    return {
      text:
        `${prefix}Seu acesso ainda pode ser liberado. Se a vontade bateu, esse pode ser o melhor momento para se permitir viver isso.${suffix}`.trim(),
      reasoning: 'fallback-desire'
    };
  }

  return {
    text:
      `${prefix}Passei aqui porque seu interesse em ${targetLabel} ficou claro. Quero te conduzir de um jeito envolvente e simples ate a finalizacao.${suffix}`.trim(),
    reasoning: 'fallback-initial'
  };
}

async function callOpenAI(prompt) {
  const response = await fetch(`${env.openaiBaseUrl}/responses`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${env.openaiApiKey}`
    },
    body: JSON.stringify({
      model: env.openaiModel,
      input: prompt,
      text: {
        format: {
          type: 'json_schema',
          name: 'remarketing_message',
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              text: { type: 'string' },
              reasoning: { type: 'string' }
            },
            required: ['text', 'reasoning']
          }
        }
      }
    })
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`OpenAI HTTP ${response.status}: ${body.slice(0, 300)}`);
  }

  const data = await response.json();
  if (!data.output_text) {
    throw new Error('Resposta da OpenAI vazia');
  }

  return JSON.parse(data.output_text);
}

async function generateRemarketingCopy({ profile, campaign, sequenceStep, messageType, checkoutUrl, socialProof, abHook, variantLabel }) {
  const settings = await appSettings.getRemarketingSettings();

  if (!settings.ai_remarketing_enabled || !env.openaiApiKey) {
    return buildFallbackCopy({ profile, campaign, sequenceStep, checkoutUrl, messageType, socialProof, abHook });
  }

  const prompt = [
    'Voce cria mensagens curtas de remarketing para Telegram com foco em conversao.',
    `Tom obrigatorio: ${settings.ai_remarketing_tone || env.aiRemarketingTone}.`,
    'Regras:',
    '- portugues do Brasil',
    '- 2 a 4 frases curtas',
    '- tom humano',
    '- sugestiva e envolvente, mas sem conteudo explicito',
    '- sem promessas falsas',
    '- sem pressao abusiva',
    '- sem mencionar que e IA',
    '- finalizar com CTA natural',
    `Oferta: ${campaign.target_type}`,
    `Alvo: ${campaign.target_code || campaign.product_id || '-'}`,
    `Passo da sequencia: ${sequenceStep}`,
    `Tipo da mensagem: ${messageType}`,
    variantLabel ? `Variante A/B: ${variantLabel}` : 'A/B desabilitado.',
    socialProof ? `Prova social disponivel: ${socialProof}` : 'Sem prova social selecionada.',
    `Score de intencao: ${profile.intentScore}`,
    `Eventos recentes: ${profile.recentEvents.join(', ') || 'nenhum'}`,
    checkoutUrl ? `Link do checkout: ${checkoutUrl}` : 'Sem link de checkout.',
    'Retorne JSON no formato {"text":"...","reasoning":"..."}.'
  ].join('\n');

  try {
    const result = await callOpenAI(prompt);
    if (!result || typeof result.text !== 'string' || !result.text.trim()) {
      throw new Error('Payload invalido da OpenAI');
    }
    return {
      text: `${abHook ? `${abHook.trim()}\n` : ''}${result.text.trim()}`.trim(),
      reasoning: String(result.reasoning || 'openai')
    };
  } catch (error) {
    logger.warn({ err: error, sequenceStep, messageType }, 'Falha ao gerar copy com OpenAI; usando fallback');
    return buildFallbackCopy({ profile, campaign, sequenceStep, checkoutUrl, messageType, socialProof, abHook });
  }
}

module.exports = {
  generateRemarketingCopy
};

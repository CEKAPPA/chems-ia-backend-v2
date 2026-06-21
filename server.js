require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!GEMINI_API_KEY) console.error('[AVISO] GEMINI_API_KEY não definida nas variáveis de ambiente.');
if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) console.error('[AVISO] Configuração do Supabase incompleta.');

const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

const MODELO_IA = 'gemini-2.0-flash';

const INSTRUCAO_SISTEMA = `Tu és a assistente de IA do Chems IA, uma plataforma educacional de Química para estudantes moçambicanos (8ª-12ª classe, currículo do MINEDH).

Regras:
- Responde sempre em português (variante de Moçambique/Portugal, nunca brasileiro).
- Sê clara, didática e encorajadora — o público são adolescentes a aprender Química.
- Usa exemplos do dia a dia quando possível.
- Se a pergunta não for sobre Química, redireciona com simpatia para o tema.
- Mantém respostas focadas e não muito longas (estudantes em telemóvel, não querem parágrafos enormes).
- Nunca inventes fórmulas, números atómicos ou dados científicos — se não tiveres certeza, diz isso.`;

async function autenticarAluno(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ erro: 'Token de autenticação não fornecido.' });

  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data.user) return res.status(401).json({ erro: 'Token inválido ou expirado.' });

  req.alunoId = data.user.id;
  next();
}

app.post('/api/chat', autenticarAluno, async (req, res) => {
  try {
    const { mensagem } = req.body;
    if (!mensagem || typeof mensagem !== 'string') {
      return res.status(400).json({ erro: 'Mensagem inválida.' });
    }

    const model = genAI.getGenerativeModel({
      model: MODELO_IA,
      systemInstruction: INSTRUCAO_SISTEMA
    });

    const result = await model.generateContent(mensagem);
    const resposta = result.response.text();

    res.json({ resposta });
  } catch (err) {
    console.error('[Erro /api/chat]', err.message);
    res.status(500).json({ erro: 'Não foi possível obter resposta da IA. Tenta novamente.' });
  }
});

app.post('/api/resolver-foto', autenticarAluno, async (req, res) => {
  try {
    const { imagemBase64, mimeType } = req.body;
    if (!imagemBase64) return res.status(400).json({ erro: 'Imagem não fornecida.' });

    const { data: perfil, error: erroPerfil } = await supabase
      .from('profiles')
      .select('fotos_usadas_hoje, ultima_data_contagem, premium_ativo, premium_expira_em')
      .eq('id', req.alunoId)
      .single();

    if (erroPerfil) throw erroPerfil;

    const hoje = new Date().toISOString().split('T')[0];
    let fotosUsadas = perfil.fotos_usadas_hoje;

    if (perfil.ultima_data_contagem !== hoje) {
      fotosUsadas = 0;
    }

    const premiumValido = perfil.premium_ativo && perfil.premium_expira_em && new Date(perfil.premium_expira_em) > new Date();

    if (!premiumValido && fotosUsadas >= 10) {
      return res.status(403).json({ erro: 'Limite diário de 10 fotos atingido. Ganha KappaCoins ou activa o Premium para continuar.', limiteAtingido: true });
    }

    const model = genAI.getGenerativeModel({
      model: MODELO_IA,
      systemInstruction: INSTRUCAO_SISTEMA + '\n\nO aluno enviou uma foto de um exercício de Química. Resolve-o passo a passo, explicando o raciocínio.'
    });

    const result = await model.generateContent([
      { inlineData: { data: imagemBase64, mimeType: mimeType || 'image/jpeg' } },
      { text: 'Resolve este exercício de Química passo a passo.' }
    ]);

    const resposta = result.response.text();

    await supabase
      .from('profiles')
      .update({ fotos_usadas_hoje: fotosUsadas + 1, ultima_data_contagem: hoje })
      .eq('id', req.alunoId);

    res.json({ resposta, fotosRestantesHoje: premiumValido ? null : (9 - fotosUsadas) });
  } catch (err) {
    console.error('[Erro /api/resolver-foto]', err.message);
    res.status(500).json({ erro: 'Não foi possível analisar a imagem. Tenta novamente.' });
  }
});

app.post('/api/gerar-quiz', autenticarAluno, async (req, res) => {
  try {
    const { tema } = req.body;

    const { data: perfil, error: erroPerfil } = await supabase
      .from('profiles')
      .select('quizzes_feitos_hoje, ultima_data_contagem')
      .eq('id', req.alunoId)
      .single();

    if (erroPerfil) throw erroPerfil;

    const hoje = new Date().toISOString().split('T')[0];
    let quizzesFeitos = perfil.ultima_data_contagem === hoje ? perfil.quizzes_feitos_hoje : 0;

    if (quizzesFeitos >= 15) {
      return res.status(403).json({ erro: 'Limite diário de 15 quizzes atingido. Volta amanhã!', limiteAtingido: true });
    }

    const promptTema = tema ? `sobre o tema "${tema}"` : 'sobre um tema aleatório do currículo de Química do ensino moçambicano (8ª-12ª classe)';

    const model = genAI.getGenerativeModel({
      model: MODELO_IA,
      systemInstruction: `Gera exactamente 10 perguntas de Química de escolha múltipla ${promptTema}, adequadas ao currículo moçambicano.
Responde APENAS em JSON válido, sem markdown, sem texto antes ou depois, neste formato exacto:
[{"q":"texto da pergunta","opts":["op1","op2","op3","op4"],"correct":0,"exp":"explicação breve da resposta correcta"}]
O campo "correct" é o índice (0-3) da opção correcta.`
    });

    const result = await model.generateContent('Gera o quiz agora.');
    let textoResposta = result.response.text().trim();

    textoResposta = textoResposta.replace(/```json|```/g, '').trim();

    const perguntas = JSON.parse(textoResposta);

    await supabase
      .from('profiles')
      .update({ quizzes_feitos_hoje: quizzesFeitos + 1, ultima_data_contagem: hoje })
      .eq('id', req.alunoId);

    res.json({ perguntas });
  } catch (err) {
    console.error('[Erro /api/gerar-quiz]', err.message);
    res.status(500).json({ erro: 'Não foi possível gerar o quiz. Tenta novamente.' });
  }
});

app.post('/api/concluir-quiz', autenticarAluno, async (req, res) => {
  try {
    const { tema, totalPerguntas, acertos } = req.body;
    const COINS_POR_QUIZ = 25;
    const PONTOS_RANKING_POR_QUIZ = 50;

    const { data: perfil, error: erroPerfil } = await supabase
      .from('profiles')
      .select('kappa_coins, pontos_ranking_geral, pontos_ranking_mensal')
      .eq('id', req.alunoId)
      .single();

    if (erroPerfil) throw erroPerfil;

    await supabase
      .from('profiles')
      .update({
        kappa_coins: perfil.kappa_coins + COINS_POR_QUIZ,
        pontos_ranking_geral: perfil.pontos_ranking_geral + PONTOS_RANKING_POR_QUIZ,
        pontos_ranking_mensal: perfil.pontos_ranking_mensal + PONTOS_RANKING_POR_QUIZ
      })
      .eq('id', req.alunoId);

    await supabase.from('quizzes_historico').insert({
      aluno_id: req.alunoId,
      tema: tema || null,
      total_perguntas: totalPerguntas,
      acertos: acertos,
      coins_ganhos: COINS_POR_QUIZ,
      pontos_ranking_ganhos: PONTOS_RANKING_POR_QUIZ
    });

    await supabase.from('transacoes_coins').insert({
      aluno_id: req.alunoId,
      quantidade: COINS_POR_QUIZ,
      motivo: 'quiz_concluido'
    });

    res.json({ coinsGanhos: COINS_POR_QUIZ, pontosGanhos: PONTOS_RANKING_POR_QUIZ });
  } catch (err) {
    console.error('[Erro /api/concluir-quiz]', err.message);
    res.status(500).json({ erro: 'Não foi possível registar o resultado do quiz.' });
  }
});

app.get('/api/ranking/:tipo', autenticarAluno, async (req, res) => {
  try {
    const { tipo } = req.params;

    if (tipo === 'cidades') {
      const { data, error } = await supabase
        .from('profiles')
        .select('cidade, pontos_ranking_mensal')
        .not('cidade', 'is', null);

      if (error) throw error;

      const porCidade = {};
      data.forEach(p => {
        if (!p.cidade) return;
        porCidade[p.cidade] = (porCidade[p.cidade] || 0) + p.pontos_ranking_mensal;
      });

      const lista = Object.entries(porCidade)
        .map(([cidade, pontos]) => ({ nome: cidade, pontos }))
        .sort((a, b) => b.pontos - a.pontos);

      return res.json({ lista });
    }

    const coluna = tipo === 'mensal' ? 'pontos_ranking_mensal' : 'pontos_ranking_geral';
    const { data, error } = await supabase
      .from('profiles')
      .select(`nome, cidade, ${coluna}`)
      .order(coluna, { ascending: false })
      .limit(50);

    if (error) throw error;

    const lista = data.map(p => ({ nome: p.nome || 'Aluno', cidade: p.cidade, pontos: p[coluna] }));
    res.json({ lista });
  } catch (err) {
    console.error('[Erro /api/ranking]', err.message);
    res.status(500).json({ erro: 'Não foi possível carregar o ranking.' });
  }
});

app.get('/health', (req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

const PORTA = process.env.PORT || 3000;
app.listen(PORTA, () => console.log(`Chems IA backend a correr na porta ${PORTA}`));

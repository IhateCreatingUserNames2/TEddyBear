// server.js
const express = require('express');
const WebSocket = require('ws');
const bodyParser = require('body-parser');
const cors = require('cors');
const dotenv = require('dotenv');
const { Buffer } = require('buffer');

// Configuração de ambiente
dotenv.config();
const app = express();
app.use(cors());
app.use(bodyParser.json({ limit: '50mb' }));

// Porta que o servidor irá escutar
const PORT = process.env.PORT || 3000;

// Configurações da API da OpenAI
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = 'gpt-4o-realtime-preview'; // Usando o modelo real-time mais recente
const OPENAI_VOICE = 'alloy'; // Voz a ser usada nas respostas

// Rota principal para processar áudio
app.post('/process-audio', async (req, res) => {
  try {
    // Extrair dados da requisição
    const { audio, sampleRate = 16000 } = req.body;

    if (!audio) {
      return res.status(400).json({ error: 'Dados de áudio não fornecidos' });
    }

    // Decodificar áudio de Base64
    const audioBuffer = Buffer.from(audio, 'base64');

    // Iniciar uma sessão com a OpenAI Realtime API
    const responseAudio = await processAudioWithOpenAI(audioBuffer, sampleRate);

    // Enviar a resposta de volta
    res.json({ audio: responseAudio });

  } catch (error) {
    console.error('Erro ao processar áudio:', error);
    res.status(500).json({ error: 'Erro ao processar áudio', details: error.message });
  }
});

// Função para processar áudio com a OpenAI Realtime API via WebSocket
async function processAudioWithOpenAI(audioBuffer, sampleRate) {
  return new Promise((resolve, reject) => {
    try {
      // URL da API Realtime da OpenAI
      const url = `wss://api.openai.com/v1/realtime?model=${OPENAI_MODEL}`;
      
      // Configurar WebSocket com cabeçalhos de autenticação
      const ws = new WebSocket(url, {
        headers: {
          'Authorization': `Bearer ${OPENAI_API_KEY}`,
          'OpenAI-Beta': 'realtime=v1'
        }
      });

      // Buffer para armazenar a resposta de áudio
      let responseAudioChunks = [];
      let isSessionCreated = false;
      
      ws.on('open', function open() {
        console.log('Conexão WebSocket estabelecida com OpenAI');
      });

      ws.on('message', function incoming(message) {
        try {
          const event = JSON.parse(message.toString());
          console.log('Evento recebido:', event.type);

          // Quando a sessão for criada, configurar parâmetros
          if (event.type === 'session.created' && !isSessionCreated) {
            isSessionCreated = true;
            
            // Configurar a sessão com a voz desejada
            const sessionUpdateEvent = {
              type: 'session.update',
              session: {
                voice: OPENAI_VOICE,
                instructions: "Você é um ursinho de pelúcia mágico que fala com crianças. Use linguagem simples, amigável e apropriada para crianças. Seja gentil, curioso e educativo. Responda de forma concisa, com no máximo 1-2 frases curtas."
              }
            };
            
            ws.send(JSON.stringify(sessionUpdateEvent));
            
            // Criar um item de conversa com o áudio do usuário
            const base64Audio = audioBuffer.toString('base64');
            const createItemEvent = {
              type: 'conversation.item.create',
              item: {
                type: 'message',
                role: 'user',
                content: [
                  {
                    type: 'input_audio',
                    audio: base64Audio,
                  }
                ]
              }
            };
            
            ws.send(JSON.stringify(createItemEvent));
            
            // Solicitar resposta do modelo
            const responseCreateEvent = {
              type: 'response.create',
              response: {
                modalities: ['audio', 'text']
              }
            };
            
            ws.send(JSON.stringify(responseCreateEvent));
          }
          
          // Capturar chunks de áudio da resposta
          if (event.type === 'response.audio.delta') {
            // Armazenar cada pedaço de áudio recebido
            responseAudioChunks.push(event.delta);
          }
          
          // Quando a resposta estiver concluída, finalizar
          if (event.type === 'response.done') {
            // Combinar todos os chunks de áudio
            const completeAudioBase64 = responseAudioChunks.join('');
            
            // Fechar a conexão WebSocket
            ws.close();
            
            // Resolver a promessa com o áudio da resposta
            resolve(completeAudioBase64);
          }
        } catch (parseError) {
          console.error('Erro ao analisar mensagem do WebSocket:', parseError);
          reject(parseError);
        }
      });

      ws.on('error', function error(err) {
        console.error('Erro na conexão WebSocket:', err);
        reject(err);
      });

      // Timeout para evitar conexões presas
      const timeout = setTimeout(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.close();
          reject(new Error('Timeout na conexão com OpenAI'));
        }
      }, 30000); // 30 segundos de timeout

      ws.on('close', function close() {
        clearTimeout(timeout);
        console.log('Conexão WebSocket fechada');
      });
    } catch (error) {
      reject(error);
    }
  });
}

// Iniciar o servidor
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});

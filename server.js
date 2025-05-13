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
app.use(cors()); // Enable CORS for all routes
app.use(bodyParser.json({ limit: '50mb' })); // Allow large JSON payloads (for base64 audio)

// Porta que o servidor irá escutar
const PORT = process.env.PORT || 3000;

// Configurações da API da OpenAI
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
// Using the specific real-time model from your original code
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-realtime-preview';
const OPENAI_VOICE = process.env.OPENAI_VOICE || 'alloy'; // Voice for the response

// Validate essential configuration
if (!OPENAI_API_KEY) {
  console.error("FATAL ERROR: OPENAI_API_KEY environment variable is not set.");
  process.exit(1); // Exit if API key is missing
}

console.log(`Using OpenAI Model: ${OPENAI_MODEL}`);
console.log(`Using OpenAI Voice: ${OPENAI_VOICE}`);

// Rota principal para processar áudio
app.post('/process-audio', async (req, res) => {
  console.log(`[${new Date().toISOString()}] Received request on /process-audio`);
  try {
    const { audio, sampleRate = 16000 } = req.body; // sampleRate is received but not explicitly passed to this OpenAI API version

    if (!audio) {
      console.warn(`[${new Date().toISOString()}] Bad Request: Audio data not provided.`);
      return res.status(400).json({ error: 'Dados de áudio não fornecidos' });
    }

    console.log(`[${new Date().toISOString()}] Received audio data (length: ${audio.length}), sampleRate: ${sampleRate}`);

    // Decodificar áudio de Base64
    const audioBuffer = Buffer.from(audio, 'base64');
    console.log(`[${new Date().toISOString()}] Decoded audio buffer size: ${audioBuffer.length} bytes`);

    // Iniciar uma sessão com a OpenAI Realtime API
    console.log(`[${new Date().toISOString()}] Processing audio with OpenAI Realtime API...`);
    const responseAudioBase64 = await processAudioWithOpenAI(audioBuffer, sampleRate);
    console.log(`[${new Date().toISOString()}] Received audio response from OpenAI.`);

    res.json({ audio: responseAudioBase64 });

  } catch (error) {
    console.error(`[${new Date().toISOString()}] Error processing audio in /process-audio:`, error.message);
    console.error(error.stack); // Log full stack trace for debugging
    res.status(500).json({ error: 'Erro interno ao processar áudio', details: error.message });
  }
});

/**
 * Processes audio using the OpenAI Realtime API via WebSocket.
 * This function follows the interaction pattern:
 * 1. Establish WebSocket connection.
 * 2. On 'session.created':
 *    - Send 'session.update' to configure voice and instructions.
 *    - Send 'conversation.item.create' with user's input audio.
 *    - Send 'response.create' to request audio/text modalities.
 * 3. On 'response.audio.delta': Collect audio chunks.
 * 4. On 'response.done': Concatenate audio chunks, close WebSocket, and resolve.
 */
async function processAudioWithOpenAI(audioBuffer, sampleRate) {
  // Note: sampleRate is passed but not explicitly used in the messages to this specific OpenAI API endpoint in this version.
  // The API might infer it or have a default.
  return new Promise((resolve, reject) => {
    const url = `wss://api.openai.com/v1/realtime?model=${OPENAI_MODEL}`;
    console.log(`[${new Date().toISOString()}] Connecting to WebSocket: ${url}`);

    const ws = new WebSocket(url, {
      headers: {
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        'OpenAI-Beta': 'realtime=v1' // Specific header for this beta API
      }
    });

    let responseAudioChunks = [];
    let isSessionConfigured = false; // Tracks if initial session setup messages have been sent
    let hasReceivedData = false;

    const connectionTimeout = setTimeout(() => {
      if (ws.readyState === WebSocket.CONNECTING || (ws.readyState === WebSocket.OPEN && !hasReceivedData)) {
        console.error(`[${new Date().toISOString()}] WebSocket connection timeout. Closing connection.`);
        ws.close(1000, 'Connection timeout');
        reject(new Error('Timeout: OpenAI Realtime API connection or initial data timeout'));
      }
    }, 30000); // 30 seconds timeout for connection and initial response

    ws.on('open', function open() {
      clearTimeout(connectionTimeout); // Clear connection-specific timeout if open occurs
      console.log(`[${new Date().toISOString()}] WebSocket connection established with OpenAI.`);
    });

    ws.on('message', function incoming(message) {
      hasReceivedData = true; // Mark that we've received some data
      try {
        const event = JSON.parse(message.toString());
        console.log(`[${new Date().toISOString()}] WebSocket event received: ${event.type}`);

        if (event.type === 'session.created' && !isSessionConfigured) {
          isSessionConfigured = true;
          console.log(`[${new Date().toISOString()}] Session created. Configuring session...`);

          const sessionUpdateEvent = {
            type: 'session.update',
            session: {
              voice: OPENAI_VOICE,
              instructions: "Você é um ursinho de pelúcia mágico que fala com crianças. Use linguagem simples, amigável e apropriada para crianças. Seja gentil, curioso e educativo. Responda de forma concisa, com no máximo 1-2 frases curtas."
            }
          };
          ws.send(JSON.stringify(sessionUpdateEvent));
          console.log(`[${new Date().toISOString()}] Sent: session.update`);

          const base64InputAudio = audioBuffer.toString('base64');
          const createItemEvent = {
            type: 'conversation.item.create',
            item: {
              type: 'message',
              role: 'user',
              content: [{ type: 'input_audio', audio: base64InputAudio }]
            }
          };
          ws.send(JSON.stringify(createItemEvent));
          console.log(`[${new Date().toISOString()}] Sent: conversation.item.create (audio length: ${base64InputAudio.length})`);

          const responseCreateEvent = {
            type: 'response.create',
            response: {
              modalities: ['audio', 'text'] // Requesting both audio and text response
            }
          };
          ws.send(JSON.stringify(responseCreateEvent));
          console.log(`[${new Date().toISOString()}] Sent: response.create`);

        } else if (event.type === 'response.audio.delta') {
          if (event.delta) {
            responseAudioChunks.push(event.delta);
            // console.log(`[${new Date().toISOString()}] Received audio chunk (length: ${event.delta.length})`);
          }
        } else if (event.type === 'response.text.delta') {
            // If you also want to process text deltas (e.g., for subtitles or quicker feedback)
            // console.log(`[${new Date().toISOString()}] Received text chunk: ${event.delta}`);
        } else if (event.type === 'response.done') {
          console.log(`[${new Date().toISOString()}] Response done. Combining audio chunks...`);
          const completeAudioBase64 = responseAudioChunks.join('');
          console.log(`[${new Date().toISOString()}] Total combined audio length: ${completeAudioBase64.length}`);

          if (ws.readyState === WebSocket.OPEN) {
            ws.close(1000, 'Processing complete'); // 1000 for normal closure
          }
          resolve(completeAudioBase64);

        } else if (event.type === 'error' || event.type === 'session.error') {
          console.error(`[${new Date().toISOString()}] OpenAI API Error Event:`, event.message || event.reason || JSON.stringify(event));
          if (ws.readyState === WebSocket.OPEN) {
            ws.close(1011, 'API Error'); // 1011 for internal server error
          }
          reject(new Error(`OpenAI API Error: ${event.message || event.reason || 'Unknown API error'}`));
        }

      } catch (parseError) {
        console.error(`[${new Date().toISOString()}] Error parsing WebSocket message:`, parseError);
        // Depending on severity, you might not want to reject immediately for a single unparseable message
        // but if it's critical, then reject.
        // For now, logging it. If critical parsing errors occur, the flow might break anyway.
      }
    });

    ws.on('error', function error(err) {
      clearTimeout(connectionTimeout);
      console.error(`[${new Date().toISOString()}] WebSocket connection error:`, err);
      reject(err); // Reject the promise on WebSocket error
    });

    ws.on('close', function close(code, reason) {
      clearTimeout(connectionTimeout);
      console.log(`[${new Date().toISOString()}] WebSocket connection closed. Code: ${code}, Reason: ${reason ? reason.toString() : 'N/A'}`);
      // If the promise hasn't been resolved or rejected yet (e.g., unexpected closure),
      // and we haven't successfully gathered data, we should reject.
      // The 'resolve' is handled in 'response.done'.
      // The 'reject' is handled in 'error' or timeout.
      // This 'close' handler is mostly for logging and cleanup.
      // If it closes unexpectedly before 'response.done' without an 'error' event, the promise might hang.
      // We can add a check here, but it might conflict with normal closure after resolve.
      // For now, relying on timeout and explicit error/done events for promise settlement.
    });
  });
}

// Iniciar o servidor
app.listen(PORT, () => {
  console.log(`[${new Date().toISOString()}] Server running on port ${PORT}`);
  console.log(`[${new Date().toISOString()}] Waiting for requests at http://localhost:${PORT}/process-audio`);
});

document.addEventListener('DOMContentLoaded', () => {
    const statusElement = document.getElementById('status');
    const startButton = document.getElementById('startButton');
    const stopButton = document.getElementById('stopButton');

    // --- Configuration ---
    const SERVER_URL = 'https://teddybear-1.onrender.com/process-audio';
    const SAMPLE_RATE = 16000;
    const SILENCE_THRESHOLD = 0.01; // Normalized - adjust this! (0.0 to 1.0)
    const SPEECH_TIMEOUT_MS = 1500; // Time of silence before sending
    const AUDIO_BUFFER_SIZE = 4096; // For ScriptProcessorNode

    // --- State ---
    let audioContext;
    let mediaStream;
    let scriptProcessor; // Or AudioWorkletNode
    let recordingBuffer = []; // Array of Float32Array chunks
    let lastSpeechTime = 0;
    let isListening = false;
    let isSpeaking = false;
    let wakeLock = null;

    // --- UI Update ---
    function updateStatus(message) {
        console.log("Status:", message);
        statusElement.textContent = message;
    }

    // --- Screen Wake Lock ---
    async function requestWakeLock() {
        if ('wakeLock' in navigator) {
            try {
                wakeLock = await navigator.wakeLock.request('screen');
                wakeLock.addEventListener('release', () => {
                    console.log('Screen Wake Lock was released');
                    updateStatus("Bloqueio de tela liberado. A tela pode desligar.");
                });
                console.log('Screen Wake Lock is active');
            } catch (err) {
                console.error(`${err.name}, ${err.message}`);
                updateStatus("Não foi possível ativar o bloqueio de tela.");
            }
        } else {
            updateStatus("API de bloqueio de tela não suportada.");
        }
    }

    async function releaseWakeLock() {
        if (wakeLock !== null) {
            await wakeLock.release();
            wakeLock = null;
        }
    }

    // --- Audio Processing ---
    async function startListening() {
        if (isListening) return;
        updateStatus("Iniciando microfone...");

        try {
            // 1. Get Audio Context
            audioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: SAMPLE_RATE });
            await audioContext.resume(); // Ensure context is active

            // 2. Get User Media (Microphone)
            mediaStream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    sampleRate: SAMPLE_RATE,
                    channelCount: 1,
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl: true
                }
            });

            // 3. Create Audio Nodes
            const source = audioContext.createMediaStreamSource(mediaStream);

            // Using ScriptProcessorNode (deprecated but simpler for this example)
            // For production, consider AudioWorkletNode for better performance
            scriptProcessor = audioContext.createScriptProcessor(AUDIO_BUFFER_SIZE, 1, 1); // bufferSize, inputChannels, outputChannels

            scriptProcessor.onaudioprocess = (audioProcessingEvent) => {
                if (isSpeaking || !isListening) return; // Don't process if bear is speaking or stopped

                const inputBuffer = audioProcessingEvent.inputBuffer;
                const inputData = inputBuffer.getChannelData(0); // Get data from channel 0

                // Simple RMS for amplitude (can be improved)
                let sum = 0;
                for (let i = 0; i < inputData.length; i++) {
                    sum += inputData[i] * inputData[i];
                }
                const rms = Math.sqrt(sum / inputData.length);

                const currentTime = Date.now();

                if (rms > SILENCE_THRESHOLD) {
                    if (recordingBuffer.length === 0) { // Start of new speech segment
                        updateStatus("Capturando fala...");
                    }
                    recordingBuffer.push(new Float32Array(inputData)); // Store a copy
                    lastSpeechTime = currentTime;
                } else {
                    if (recordingBuffer.length > 0 && (currentTime - lastSpeechTime > SPEECH_TIMEOUT_MS)) {
                        // End of speech detected
                        const completeAudio = concatenateFloat32Arrays(recordingBuffer);
                        recordingBuffer = []; // Clear buffer

                        if (completeAudio.length > 0) {
                            sendAudioToServer(completeAudio);
                        } else {
                             updateStatus("Ouvindo...");
                        }
                    }
                }
            };

            source.connect(scriptProcessor);
            scriptProcessor.connect(audioContext.destination); // Connect to output (though we don't play input)

            isListening = true;
            startButton.style.display = 'none';
            stopButton.style.display = 'inline-block';
            updateStatus("Ouvindo...");
            await requestWakeLock();

        } catch (error) {
            console.error("Error starting microphone:", error);
            updateStatus(`Erro ao iniciar microfone: ${error.message}`);
            stopListening(); // Clean up
        }
    }

    function concatenateFloat32Arrays(arrays) {
        let totalLength = 0;
        arrays.forEach(arr => totalLength += arr.length);
        const result = new Float32Array(totalLength);
        let offset = 0;
        arrays.forEach(arr => {
            result.set(arr, offset);
            offset += arr.length;
        });
        return result;
    }

    function float32To16BitPCM(float32Array) {
        const pcm16 = new Int16Array(float32Array.length);
        for (let i = 0; i < float32Array.length; i++) {
            let s = Math.max(-1, Math.min(1, float32Array[i]));
            pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
        }
        return pcm16;
    }

    function pcm16ArrayToBase64(pcm16Array) {
        // Int16Array.buffer is an ArrayBuffer
        // Each Int16 is 2 bytes
        const byteCharacters = new Uint8Array(pcm16Array.buffer);
        let binary = '';
        for (let i = 0; i < byteCharacters.byteLength; i++) {
            binary += String.fromCharCode(byteCharacters[i]);
        }
        return btoa(binary);
    }


    async function sendAudioToServer(float32AudioData) {
        if (isSpeaking) return; // Don't send if already processing/speaking

        updateStatus("Processando...");
        isSpeaking = true; // Prevent new recordings while processing

        try {
            const pcm16AudioData = float32To16BitPCM(float32AudioData);
            const base64Audio = pcm16ArrayToBase64(pcm16AudioData);

            const response = await fetch(SERVER_URL, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    audio: base64Audio,
                    sampleRate: SAMPLE_RATE
                }),
            });

            if (!response.ok) {
                const errorData = await response.json().catch(() => ({ error: "Erro desconhecido do servidor" }));
                throw new Error(`Server error: ${response.status} - ${errorData.error || errorData.details}`);
            }

            const responseData = await response.json();
            if (responseData.audio) {
                playAudioResponse(responseData.audio);
            } else {
                throw new Error("Resposta do servidor não contém áudio.");
            }

        } catch (error) {
            console.error("Error sending/receiving audio:", error);
            updateStatus(`Erro de comunicação: ${error.message}`);
            isSpeaking = false; // Allow listening again
            if (isListening) updateStatus("Ouvindo...");
        }
    }

    async function playAudioResponse(base64Audio) {
        updateStatus("Falando...");
        try {
            const audioBlob = await (await fetch(`data:audio/webm;base64,${base64Audio}`)).blob(); // Assuming backend sends Opus/WebM compatible base64.
                                                                                                // If backend sends raw PCM, this needs to change.
                                                                                                // OpenAI's realtime API typically sends Opus which can be Base64.
            const audioUrl = URL.createObjectURL(audioBlob);
            const audio = new Audio(audioUrl);
            
            // It's crucial that OpenAI returns audio in a format the browser <audio> can play
            // directly from Base64, or you'll need to decode PCM and use Web Audio API for playback.
            // If your backend sends raw PCM base64 encoded, the `playWithAudioTrack` logic from Android (adapted for Web Audio API) is needed.
            // For now, let's assume the server's response is directly playable (e.g., Opus in a WebM container, then base64'd)

            audio.onended = () => {
                isSpeaking = false;
                if (isListening) updateStatus("Ouvindo...");
                URL.revokeObjectURL(audioUrl);
            };
            audio.onerror = (e) => {
                console.error("Error playing audio:", e);
                updateStatus("Erro ao tocar resposta.");
                isSpeaking = false;
                if (isListening) updateStatus("Ouvindo...");
                URL.revokeObjectURL(audioUrl);
            };
            await audio.play();
        } catch (error) {
            console.error("Error playing audio response:", error);
            updateStatus(`Erro na reprodução: ${error.message}`);
            isSpeaking = false;
            if (isListening) updateStatus("Ouvindo...");
        }
    }


    function stopListening() {
        if (!isListening && !mediaStream) return;

        isListening = false;
        if (scriptProcessor) {
            scriptProcessor.disconnect();
            scriptProcessor.onaudioprocess = null; // Remove handler
            scriptProcessor = null;
        }
        if (mediaStream) {
            mediaStream.getTracks().forEach(track => track.stop());
            mediaStream = null;
        }
        if (audioContext && audioContext.state !== 'closed') {
            audioContext.close();
            audioContext = null;
        }
        recordingBuffer = [];
        startButton.style.display = 'inline-block';
        stopButton.style.display = 'none';
        updateStatus("Parado. Clique em Iniciar.");
        releaseWakeLock();
    }

    // --- Event Listeners ---
    startButton.addEventListener('click', startListening);
    stopButton.addEventListener('click', stopListening);

    // Handle page visibility changes
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') {
            if (isListening) {
                // Browsers will likely cut off mic access anyway.
                // You might want to explicitly call stopListening() here or inform the user.
                console.warn("Página ficou oculta, microfone pode ser desativado pelo navegador.");
                // stopListening(); // Optionally stop if strict background operation isn't expected to work
            }
            if (wakeLock !== null) {
                // Wake lock is automatically released when tab is hidden.
                // Our event listener on wakeLock should catch this.
            }
        } else if (document.visibilityState === 'visible') {
            if (isListening && wakeLock === null) { // If was listening and wake lock got released
                requestWakeLock();
            }
            if (audioContext && audioContext.state === 'suspended') {
                audioContext.resume(); // Try to resume audio context if suspended
            }
        }
    });

    // Optional: Warn user before leaving if listening
    window.addEventListener('beforeunload', (event) => {
        if (isListening) {
            event.preventDefault(); // Standard for most browsers
            event.returnValue = ''; // Required for some older browsers
        }
    });
});

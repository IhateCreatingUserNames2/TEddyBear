// Arquivo: MainActivity.kt
package com.example.ursinhotalante

import android.Manifest
import android.content.pm.PackageManager
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaPlayer
import android.media.MediaRecorder
import android.os.Bundle
import android.util.Log
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import kotlinx.coroutines.*
import okhttp3.*
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileOutputStream
import java.io.IOException

class MainActivity : AppCompatActivity() {
    private val TAG = "UrsinhoFalante"
    private val REQUEST_RECORD_AUDIO_PERMISSION = 200
    
    // Configurações de áudio
    private val SAMPLE_RATE = 16000
    private val CHANNEL_CONFIG = AudioFormat.CHANNEL_IN_MONO
    private val AUDIO_FORMAT = AudioFormat.ENCODING_PCM_16BIT
    
    // Tamanho do buffer para gravar áudio
    private var bufferSize = AudioRecord.getMinBufferSize(
        SAMPLE_RATE, CHANNEL_CONFIG, AUDIO_FORMAT
    )
    
    // Objeto para gravação de áudio
    private var audioRecord: AudioRecord? = null
    
    // Cliente HTTP para comunicação com o servidor
    private val client = OkHttpClient()
    
    // URL do seu serviço backend no Render.com
    private val SERVER_URL = "https://seu-app.onrender.com/process-audio"
    
    // Controle de estado
    private var isRecording = false
    private var isSpeaking = false
    private var isProcessing = false
    
    // Detecção de silêncio
    private val SILENCE_THRESHOLD = 700
    private var silenceCounter = 0
    private val SILENCE_DURATION = 20 // Aproximadamente 1 segundo com buffer de 50ms
    
    // Player de mídia para reproduzir respostas
    private var mediaPlayer: MediaPlayer? = null
    
    // Escopo de coroutine para operações assíncronas
    private val coroutineScope = CoroutineScope(Dispatchers.IO)

    override fun onDestroy() {
        super.onDestroy()
        
        // Limpar recursos
        isRecording = false
        coroutineScope.cancel()
        
        // Liberar MediaPlayer se estiver ativo
        mediaPlayer?.release()
        mediaPlayer = null
    }
    
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        
        // Solicitar permissão para gravar áudio
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO)
            != PackageManager.PERMISSION_GRANTED) {
            ActivityCompat.requestPermissions(
                this,
                arrayOf(Manifest.permission.RECORD_AUDIO),
                REQUEST_RECORD_AUDIO_PERMISSION
            )
        } else {
            startListening()
        }
    }
    
    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<String>,
        grantResults: IntArray
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == REQUEST_RECORD_AUDIO_PERMISSION) {
            if (grantResults.isNotEmpty() && grantResults[0] == PackageManager.PERMISSION_GRANTED) {
                startListening()
            } else {
                Log.e(TAG, "Permissão para gravar áudio negada")
                finish()
            }
        }
    }

    private fun startListening() {
        if (isRecording) return
        
        isRecording = true
        
        coroutineScope.launch {
            try {
                // Inicializar gravador de áudio
                audioRecord = AudioRecord(
                    MediaRecorder.AudioSource.MIC,
                    SAMPLE_RATE,
                    CHANNEL_CONFIG,
                    AUDIO_FORMAT,
                    bufferSize
                )
                
                // Verificar se o gravador foi inicializado corretamente
                if (audioRecord?.state != AudioRecord.STATE_INITIALIZED) {
                    Log.e(TAG, "AudioRecord não inicializado corretamente")
                    isRecording = false
                    return@launch
                }
                
                // Iniciar gravação
                audioRecord?.startRecording()
                
                // Buffer para ler dados do microfone
                val audioBuffer = ShortArray(bufferSize / 2)
                
                // Buffer para armazenar o áudio capturado
                val capturedAudio = ByteArrayOutputStream()
                
                Log.d(TAG, "Começou a escutar...")
                
                while (isRecording) {
                    // Ler áudio do microfone
                    val readSize = audioRecord?.read(audioBuffer, 0, audioBuffer.size) ?: 0
                    
                    if (readSize > 0) {
                        // Calcular volume para detecção de fala
                        var sum = 0L
                        for (i in 0 until readSize) {
                            sum += Math.abs(audioBuffer[i].toLong())
                        }
                        val average = sum / readSize
                        
                        // Verificar se há fala
                        if (average > SILENCE_THRESHOLD) {
                            // Resetar contador de silêncio quando detecta som
                            silenceCounter = 0
                            
                            // Se não estiver já processando, começar a armazenar áudio
                            if (!isProcessing) {
                                isProcessing = true
                                Log.d(TAG, "Fala detectada, iniciando captura...")
                            }
                            
                            // Armazenar áudio capturado
                            for (i in 0 until readSize) {
                                val byte1 = (audioBuffer[i].toInt() and 0xFF).toByte()
                                val byte2 = (audioBuffer[i].toInt() shr 8 and 0xFF).toByte()
                                capturedAudio.write(byte1.toInt())
                                capturedAudio.write(byte2.toInt())
                            }
                        } else if (isProcessing) {
                            // Incrementar contador de silêncio quando não detecta som
                            silenceCounter++
                            
                            // Ainda armazenar áudio para não perder o final da fala
                            for (i in 0 until readSize) {
                                val byte1 = (audioBuffer[i].toInt() and 0xFF).toByte()
                                val byte2 = (audioBuffer[i].toInt() shr 8 and 0xFF).toByte()
                                capturedAudio.write(byte1.toInt())
                                capturedAudio.write(byte2.toInt())
                            }
                            
                            // Se silêncio por tempo suficiente, processar o áudio
                            if (silenceCounter > SILENCE_DURATION) {
                                Log.d(TAG, "Silêncio detectado, processando áudio...")
                                
                                // Finalizar gravação
                                val audioData = capturedAudio.toByteArray()
                                capturedAudio.reset()
                                
                                // Processar o áudio capturado
                                processAudio(audioData)
                                
                                // Resetar estado
                                isProcessing = false
                                silenceCounter = 0
                            }
                        }

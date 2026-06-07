import { useState, useEffect, useRef, useCallback } from 'react'
import { usePythonBridge, useSendToPython, PythonMessage } from '../hooks/usePythonBridge'
import { renderMarkdownLite } from '../utils/markdown'

interface TranscriptLine {
  id: number
  speaker: 'mic' | 'speaker'
  text: string
  final: boolean
}

type AppStatus = 'idle' | 'recording' | 'processing'

let lineIdCounter = 0

export default function Overlay() {
  const [recording, setRecording] = useState(false)
  const [status, setStatus] = useState<AppStatus>('idle')
  const [statusText, setStatusText] = useState('Нажмите Ctrl+Shift+R для записи')
  const [transcript, setTranscript] = useState<TranscriptLine[]>([])
  const [reasoning, setReasoning] = useState('')
  const [reasoningOpen, setReasoningOpen] = useState(false)
  const [streamingReasoning, setStreamingReasoning] = useState(false)
  const [answer, setAnswer] = useState('')
  const [streaming, setStreaming] = useState(false)
  const [clickThrough, setClickThrough] = useState(false)
  const [ragReady, setRagReady] = useState(false)
  const [resumeName, setResumeName] = useState<string | null>(null)
  const [jdName, setJdName] = useState<string | null>(null)

  const transcriptEndRef = useRef<HTMLDivElement>(null)
  const answerEndRef = useRef<HTMLDivElement>(null)
  const reasoningEndRef = useRef<HTMLDivElement>(null)
  const sendToPython = useSendToPython()

  // ── Message handler ──────────────────────────────────────────────────────

  const handleMessage = useCallback((msg: PythonMessage) => {
    switch (msg.type) {

      case 'transcript': {
        setTranscript((prev) => {
          const lastIdx = [...prev].reverse().findIndex(
            (l) => l.speaker === msg.speaker && !l.final
          )
          if (lastIdx !== -1) {
            const realIdx = prev.length - 1 - lastIdx
            const updated = [...prev]
            updated[realIdx] = { ...updated[realIdx], text: msg.text, final: msg.final }
            return updated
          }
          return [...prev, { id: ++lineIdCounter, speaker: msg.speaker, text: msg.text, final: msg.final }]
        })
        if (msg.final) {
          setStatus('processing')
          setStatusText('Рассуждаю…')
          // reset previous reasoning/answer for the new question
          setReasoning('')
          setAnswer('')
          setReasoningOpen(true)
        }
        break
      }

      case 'reasoning_token': {
        setStreamingReasoning(true)
        setReasoning((prev) => prev + msg.token)
        break
      }

      case 'llm_token': {
        // first content token means reasoning finished
        setStreamingReasoning(false)
        setStreaming(true)
        setStatusText('Генерирую ответ…')
        setAnswer((prev) => prev + msg.token)
        break
      }

      case 'llm_done': {
        setStreaming(false)
        setStatus('recording')
        setStatusText('Запись…')
        break
      }

      case 'status': {
        setStatusText(msg.text)
        break
      }

      case 'rag_ready': {
        setRagReady(true)
        setStatusText('Контекст загружен')
        break
      }

      case 'error': {
        setStatusText('Ошибка: ' + msg.message)
        break
      }
    }
  }, [])

  usePythonBridge(handleMessage)

  // ── Electron hotkey listeners ────────────────────────────────────────────

  useEffect(() => {
    if (!window.electronAPI) return

    const cleanupCT = window.electronAPI.onClickThroughChanged((enabled) => {
      setClickThrough(enabled)
    })

    const cleanupRec = window.electronAPI.onToggleRecording(() => {
      handleRecordToggle()
    })

    const cleanupClear = window.electronAPI.onClearSession(() => {
      setTranscript([])
      setReasoning('')
      setAnswer('')
      setStatus('idle')
      setStatusText('Очищено')
      sendToPython({ type: 'clear_session' })
    })

    return () => { cleanupCT(); cleanupRec(); cleanupClear() }
  }, [recording])

  // ── Auto-scroll ──────────────────────────────────────────────────────────

  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [transcript])

  useEffect(() => {
    answerEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [answer])

  useEffect(() => {
    if (reasoningOpen) {
      reasoningEndRef.current?.scrollIntoView({ behavior: 'smooth' })
    }
  }, [reasoning, reasoningOpen])

  // ── Actions ──────────────────────────────────────────────────────────────

  function handleRecordToggle() {
    if (!recording) {
      setRecording(true)
      setStatus('recording')
      setStatusText('Запись…')
      sendToPython({ type: 'start_recording' })
    } else {
      setRecording(false)
      setStatus('idle')
      setStatusText('Остановлено')
      sendToPython({ type: 'stop_recording' })
    }
  }

  function handleClickThrough() {
    const next = !clickThrough
    setClickThrough(next)
    window.electronAPI?.setClickThrough(next)
  }

  async function handleUploadResume() {
    const filePath = await window.electronAPI?.pickFile([
      { name: 'Documents', extensions: ['pdf', 'txt', 'md'] },
    ])
    if (!filePath) return
    const content = await window.electronAPI?.readFile(filePath)
    if (!content) return
    const name = filePath.split('/').pop() ?? filePath
    setResumeName(name)
    sendToPython({ type: 'upload_resume', content, name })
    setStatusText('Резюме загружено, индексирую…')
  }

  async function handleUploadJD() {
    const filePath = await window.electronAPI?.pickFile([
      { name: 'Text', extensions: ['txt', 'md', 'pdf'] },
    ])
    if (!filePath) return
    const content = await window.electronAPI?.readFile(filePath)
    if (!content) return
    const name = filePath.split('/').pop() ?? filePath
    setJdName(name)
    sendToPython({ type: 'upload_jd', content, name })
    setStatusText('Вакансия загружена, индексирую…')
  }

  // ── Render ───────────────────────────────────────────────────────────────

  const hasReasoning = reasoning.length > 0

  return (
    <div className="overlay">

      {/* Title bar */}
      <div className="titlebar">
        <div className="titlebar-left">
          <div className={`status-dot ${status}`} title={statusText} />
          <span className="app-name">Copilot</span>
        </div>
        <div className="titlebar-controls">
          <button
            className={`icon-btn ${recording ? 'active' : ''}`}
            onClick={handleRecordToggle}
            title={recording ? 'Стоп (Ctrl+Shift+R)' : 'Запись (Ctrl+Shift+R)'}
          >
            {recording ? '⏹' : '⏺'}
          </button>
          <button
            className={`icon-btn ${clickThrough ? 'active' : ''}`}
            onClick={handleClickThrough}
            title="Режим прозрачности (Ctrl+Shift+P)"
          >
            ⊙
          </button>
          <button
            className="icon-btn"
            onClick={() => {
              setTranscript([])
              setReasoning('')
              setAnswer('')
              sendToPython({ type: 'clear_session' })
            }}
            title="Очистить (Ctrl+Shift+C)"
          >
            ✕
          </button>
        </div>
      </div>

      {clickThrough && (
        <div className="click-through-banner">
          Режим прозрачности — <span className="kbd">Ctrl+Shift+P</span> для выхода
        </div>
      )}

      <div className="sections">

        {/* RAG */}
        <div className="section">
          <div className="section-header">
            Контекст
            {ragReady && <span className="section-badge">готов</span>}
          </div>
          <div className="rag-body">
            <div className="rag-file-row">
              <span className={`rag-file-name ${resumeName ? '' : 'empty'}`}>
                {resumeName ?? 'Резюме не загружено'}
              </span>
              <button className="upload-btn" onClick={handleUploadResume}>Загрузить</button>
            </div>
            <div className="rag-file-row">
              <span className={`rag-file-name ${jdName ? '' : 'empty'}`}>
                {jdName ?? 'Вакансия не загружена'}
              </span>
              <button className="upload-btn" onClick={handleUploadJD}>Загрузить</button>
            </div>
          </div>
        </div>

        {/* Transcript */}
        <div className="section">
          <div className="section-header">Транскрипция</div>
          <div className="transcript-body">
            {transcript.length === 0 ? (
              <span style={{ color: 'var(--text-muted)', fontSize: 12, fontStyle: 'italic' }}>
                Речь появится здесь…
              </span>
            ) : (
              transcript.map((line) => (
                <div key={line.id} className="transcript-line">
                  <span className={`transcript-speaker ${line.speaker}`}>
                    {line.speaker === 'mic' ? 'ВЫ' : 'ОН'}
                  </span>
                  <span className={`transcript-text ${line.final ? '' : 'pending'}`}>
                    {line.text}
                  </span>
                </div>
              ))
            )}
            <div ref={transcriptEndRef} />
          </div>
        </div>

        {/* Reasoning (collapsible) — only shown when the model is thinking */}
        {hasReasoning && (
          <div className="section reasoning-section">
            <div
              className="section-header reasoning-header"
              onClick={() => setReasoningOpen((o) => !o)}
            >
              <span className="reasoning-toggle">{reasoningOpen ? '▾' : '▸'}</span>
              Мышление модели
              {streamingReasoning && <span className="reasoning-pulse" />}
              <span className="section-badge" style={{ marginLeft: 'auto' }}>
                {Math.round(reasoning.length / 4)} ток.
              </span>
            </div>
            {reasoningOpen && (
              <div className="reasoning-body">
                {reasoning}
                {streamingReasoning && <span className="cursor" style={{ background: 'var(--text-muted)' }} />}
                <div ref={reasoningEndRef} />
              </div>
            )}
          </div>
        )}

        {/* Answer */}
        <div className="section" style={{ flex: 1 }}>
          <div className="section-header">Ответ</div>
          <div className="answer-body">
            {answer ? (
              <>
                <span dangerouslySetInnerHTML={{ __html: renderMarkdownLite(answer) }} />
                {streaming && <span className="cursor" />}
              </>
            ) : (
              <span className="answer-placeholder">
                {status === 'processing'
                  ? 'Модель рассуждает…'
                  : 'Ответ появится здесь после распознавания вопроса…'}
              </span>
            )}
            <div ref={answerEndRef} />
          </div>
        </div>

      </div>

      {/* Bottom bar */}
      <div className="bottom-bar">
        <span className="status-text">{statusText}</span>
        <span className="kbd">⌃⇧H</span>
        <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>скрыть</span>
      </div>

    </div>
  )
}

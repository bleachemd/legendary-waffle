"""
OpenRouter LLM connector — streams tokens from google/gemma-4-31b-it:free.
"""

import os
import sys
import json
from typing import Iterator

OPENROUTER_API_KEY = os.getenv("OPENROUTER_API_KEY", "")
API_URL  = "https://openrouter.ai/api/v1/chat/completions"
MODEL    = "google/gemma-3-27b-it:free"

SYSTEM_PROMPT = (
    "Ты — ИИ-копилот на техническом собеседовании. "
    "Твоя задача — выдавать краткие, структурированные, профессиональные ответы "
    "на русском языке на основе контекста кандидата и транскрипции вопроса. "
    "Ответы должны быть в форме тезисов (bullet points) или готового кода "
    "без лишних приветствий и 'вводных фраз'. "
    "Будь лаконичен, время ответа критично."
)


def stream_answer(question: str, context: str = "") -> Iterator[str]:
    """
    Generator that yields LLM tokens one by one.
    Uses server-sent events (stream=true) to get sub-second first-token latency.
    """
    if not OPENROUTER_API_KEY:
        yield "[Ошибка: OPENROUTER_API_KEY не задан]"
        return

    user_message = question
    if context:
        user_message = (
            f"Контекст из резюме/вакансии:\n{context}\n\n"
            f"Вопрос интервьюера: {question}"
        )

    payload = {
        "model": MODEL,
        "stream": True,
        "max_tokens": 512,
        "temperature": 0.3,
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": user_message},
        ],
    }

    headers = {
        "Authorization": f"Bearer {OPENROUTER_API_KEY}",
        "Content-Type": "application/json",
        "HTTP-Referer": "https://interview-copilot.local",
        "X-Title": "Interview Copilot",
    }

    try:
        import urllib.request

        req = urllib.request.Request(
            API_URL,
            data=json.dumps(payload).encode(),
            headers=headers,
            method="POST",
        )

        with urllib.request.urlopen(req, timeout=60) as resp:
            for raw_line in resp:
                line = raw_line.decode("utf-8").strip()

                if not line or line == "data: [DONE]":
                    continue

                if line.startswith("data: "):
                    line = line[6:]

                try:
                    event = json.loads(line)
                except json.JSONDecodeError:
                    continue

                choices = event.get("choices", [])
                if not choices:
                    continue

                delta = choices[0].get("delta", {})
                token = delta.get("content", "")
                if token:
                    yield token

    except Exception as exc:
        print(f"[llm] error: {exc}", file=sys.stderr)
        yield f"\n[Ошибка запроса: {exc}]"

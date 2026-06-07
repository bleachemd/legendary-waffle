"""
OpenRouter LLM connector — google/gemma-4-31b-it:free with reasoning.

Uses the OpenAI-compatible Python SDK pointed at OpenRouter.
Streams two kinds of tokens:
  reasoning_token — the model's internal thinking (shown collapsed in UI)
  llm_token       — the actual answer visible to the candidate

The last yielded event is always `turn_complete`, which carries the full
assistant message (including reasoning_details). The caller must append it
to the conversation history before the next turn so the model can continue
reasoning from where it left off.
"""

import os
import sys
from typing import Iterator

MODEL = "google/gemma-4-31b-it:free"

SYSTEM_PROMPT = (
    "Ты — ИИ-копилот на техническом собеседовании. "
    "Твоя задача — выдавать краткие, структурированные, профессиональные ответы "
    "на русском языке на основе контекста кандидата и транскрипции вопроса. "
    "Ответы должны быть в форме тезисов (bullet points) или готового кода "
    "без лишних приветствий и 'вводных фраз'. "
    "Будь лаконичен, время ответа критично."
)


def _get_client():
    api_key = os.getenv("OPENROUTER_API_KEY", "")
    if not api_key or api_key.startswith("sk-or-v1-replace"):
        raise RuntimeError("OPENROUTER_API_KEY not set")

    from openai import OpenAI  # type: ignore
    return OpenAI(
        base_url="https://openrouter.ai/api/v1",
        api_key=api_key,
        default_headers={
            "HTTP-Referer": "https://interview-copilot.local",
            "X-Title": "Interview Copilot",
        },
    )


def make_system_message() -> dict:
    return {"role": "system", "content": SYSTEM_PROMPT}


def stream_answer(messages: list[dict]) -> Iterator[dict]:
    """
    Generator — yields dicts in this order:

      {"type": "reasoning_token", "token": str}   — zero or more
      {"type": "llm_token",       "token": str}   — one or more
      {"type": "turn_complete",   "assistant_message": dict}  — always last

    The caller must append `assistant_message` to the conversation history
    before the next call so reasoning context is preserved across turns.
    """
    try:
        client = _get_client()
    except RuntimeError as exc:
        yield {"type": "llm_token", "token": f"[Ошибка: {exc}]"}
        yield {"type": "turn_complete", "assistant_message": {"role": "assistant", "content": ""}}
        return

    accumulated_reasoning = ""
    accumulated_content = ""

    try:
        stream = client.chat.completions.create(
            model=MODEL,
            messages=messages,
            stream=True,
            max_tokens=768,
            temperature=0.3,
            extra_body={
                "reasoning": {
                    # "high" gives the most thorough step-by-step thinking;
                    # drop to "low" if first-token latency matters more than depth
                    "effort": "high",
                },
            },
        )

        for chunk in stream:
            if not chunk.choices:
                continue
            delta = chunk.choices[0].delta

            # reasoning tokens (model's internal monologue)
            reasoning = getattr(delta, "reasoning", None)
            if reasoning:
                accumulated_reasoning += reasoning
                yield {"type": "reasoning_token", "token": reasoning}

            # answer tokens
            if delta.content:
                accumulated_content += delta.content
                yield {"type": "llm_token", "token": delta.content}

    except Exception as exc:
        print(f"[llm] stream error: {exc}", file=sys.stderr)
        error_text = f"\n[Ошибка: {exc}]"
        accumulated_content += error_text
        yield {"type": "llm_token", "token": error_text}

    # Build the assistant message to hand back for history preservation.
    # reasoning_details must survive into the next turn so the model can
    # continue reasoning from where it left off (per OpenRouter docs).
    assistant_message: dict = {
        "role": "assistant",
        "content": accumulated_content,
    }
    if accumulated_reasoning:
        assistant_message["reasoning_details"] = [
            {"type": "thinking", "thinking": accumulated_reasoning}
        ]

    yield {"type": "turn_complete", "assistant_message": assistant_message}

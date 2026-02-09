"""
sse_decoder.py — W3C-compliant Server-Sent Events decoder (SDD §4.1, T-1.2)

Decodes SSE events from async byte streams (httpx response.aiter_bytes()).
Handles: multi-line data fields, CRLF normalization, comments, cross-chunk state.

See: https://html.spec.whatwg.org/multipage/server-sent-events.html#parsing-an-event-stream
"""

from dataclasses import dataclass, field
from typing import AsyncGenerator, AsyncIterable, Optional


@dataclass
class SSEEvent:
    """A single Server-Sent Event."""
    event_type: str = "message"
    data: str = ""
    id: str = ""
    retry: Optional[int] = None


async def sse_decode(stream: AsyncIterable[bytes]) -> AsyncGenerator[SSEEvent, None]:
    """Decode SSE events from an async byte stream.

    Yields SSEEvent objects as they are parsed. Handles:
    - Multi-line data fields (accumulated with newlines per W3C spec)
    - CRLF / CR / LF line endings (normalized to LF)
    - Comment lines (starting with ':')
    - id and retry fields
    - Events spanning multiple TCP chunks
    - OpenAI-style [DONE] terminator (yielded as data, caller decides)

    Event dispatch occurs on empty lines (double newline = event boundary).
    """
    buffer = ""
    event_type = "message"
    data_lines: list[str] = []
    event_id = ""
    retry: Optional[int] = None

    async for chunk in stream:
        buffer += chunk.decode("utf-8", errors="replace")

        # Normalize all line endings to LF
        buffer = buffer.replace("\r\n", "\n").replace("\r", "\n")

        while "\n" in buffer:
            line, buffer = buffer.split("\n", 1)

            if not line:
                # Empty line = dispatch event (if we have data)
                if data_lines:
                    yield SSEEvent(
                        event_type=event_type,
                        data="\n".join(data_lines),
                        id=event_id,
                        retry=retry,
                    )
                # Reset per-event fields (id/retry persist per W3C spec)
                event_type = "message"
                data_lines = []
                continue

            if line.startswith(":"):
                # Comment — ignore
                continue

            # Parse field:value
            if ":" in line:
                field_name, _, value = line.partition(":")
                if value.startswith(" "):
                    value = value[1:]  # Strip single leading space
            else:
                field_name = line
                value = ""

            if field_name == "event":
                event_type = value
            elif field_name == "data":
                data_lines.append(value)
            elif field_name == "id":
                if "\0" not in value:  # Per spec: ignore id with NULL
                    event_id = value
            elif field_name == "retry":
                try:
                    retry = int(value)
                except ValueError:
                    pass
            # Unknown fields are ignored per spec

    # Process any remaining content in buffer (stream ended without final newline)
    if buffer:
        line = buffer
        if not line.startswith(":"):
            if ":" in line:
                field_name, _, value = line.partition(":")
                if value.startswith(" "):
                    value = value[1:]
            else:
                field_name = line
                value = ""
            if field_name == "event":
                event_type = value
            elif field_name == "data":
                data_lines.append(value)
            elif field_name == "id" and "\0" not in value:
                event_id = value
            elif field_name == "retry":
                try:
                    retry = int(value)
                except ValueError:
                    pass

    # Emit final event if we have accumulated data
    if data_lines:
        yield SSEEvent(
            event_type=event_type,
            data="\n".join(data_lines),
            id=event_id,
            retry=retry,
        )

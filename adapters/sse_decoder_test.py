#!/usr/bin/env python3
"""
sse_decoder_test.py — SSE decoder tests (SDD §4.1, T-1.2)

Tests W3C-compliant SSE decoding: multi-line data, CRLF normalization,
comments, cross-chunk state, OpenAI-style [DONE] terminator.

Run: python3 adapters/sse_decoder_test.py
"""

import asyncio
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from sse_decoder import sse_decode, SSEEvent

passed = 0
failed = 0


def test(name: str, fn):
    global passed, failed
    try:
        fn()
        print(f"  PASS  {name}")
        passed += 1
    except Exception as e:
        print(f"  FAIL  {name}")
        print(f"         {e}")
        failed += 1


def assert_eq(actual, expected, msg=""):
    if actual != expected:
        raise AssertionError(f"{msg}: expected {expected!r}, got {actual!r}")


async def collect_events(chunks: list[bytes]) -> list[SSEEvent]:
    """Helper: feed chunks to decoder and collect all events."""
    async def stream():
        for chunk in chunks:
            yield chunk
    return [event async for event in sse_decode(stream())]


def run(coro):
    """Run async test in event loop."""
    return asyncio.new_event_loop().run_until_complete(coro)


# --- Basic Tests ---


def test_single_data_event():
    events = run(collect_events([b'data: hello\n\n']))
    assert_eq(len(events), 1, "event count")
    assert_eq(events[0].data, "hello", "data")
    assert_eq(events[0].event_type, "message", "default event type")


def test_named_event():
    events = run(collect_events([b'event: chunk\ndata: token\n\n']))
    assert_eq(len(events), 1, "event count")
    assert_eq(events[0].event_type, "chunk", "event type")
    assert_eq(events[0].data, "token", "data")


def test_multi_line_data():
    events = run(collect_events([b'data: line1\ndata: line2\ndata: line3\n\n']))
    assert_eq(len(events), 1, "event count")
    assert_eq(events[0].data, "line1\nline2\nline3", "multi-line data")


def test_multiple_events():
    events = run(collect_events([b'data: first\n\ndata: second\n\n']))
    assert_eq(len(events), 2, "event count")
    assert_eq(events[0].data, "first", "first event")
    assert_eq(events[1].data, "second", "second event")


# --- CRLF Normalization ---


def test_crlf_line_endings():
    events = run(collect_events([b'data: hello\r\n\r\n']))
    assert_eq(len(events), 1, "event count")
    assert_eq(events[0].data, "hello", "data with CRLF")


def test_cr_only_line_endings():
    events = run(collect_events([b'data: hello\r\r']))
    assert_eq(len(events), 1, "event count")
    assert_eq(events[0].data, "hello", "data with CR")


def test_mixed_line_endings():
    events = run(collect_events([b'data: one\r\n\r\ndata: two\n\n']))
    assert_eq(len(events), 2, "event count")
    assert_eq(events[0].data, "one", "CRLF event")
    assert_eq(events[1].data, "two", "LF event")


# --- Comments ---


def test_comments_ignored():
    events = run(collect_events([b': this is a comment\ndata: hello\n\n']))
    assert_eq(len(events), 1, "event count")
    assert_eq(events[0].data, "hello", "data after comment")


def test_empty_comment():
    events = run(collect_events([b':\ndata: hello\n\n']))
    assert_eq(len(events), 1, "event count")
    assert_eq(events[0].data, "hello", "data after empty comment")


# --- Cross-Chunk State ---


def test_event_split_across_chunks():
    """Event data spanning multiple TCP chunks."""
    events = run(collect_events([b'data: hel', b'lo\n\n']))
    assert_eq(len(events), 1, "event count")
    assert_eq(events[0].data, "hello", "data across chunks")


def test_event_boundary_split_across_chunks():
    """Event boundary (empty line) spanning chunks."""
    events = run(collect_events([b'data: hello\n', b'\n']))
    assert_eq(len(events), 1, "event count")
    assert_eq(events[0].data, "hello", "boundary across chunks")


def test_multiple_events_across_chunks():
    """Multiple events in fragmented chunks."""
    events = run(collect_events([
        b'data: fi',
        b'rst\n\ndat',
        b'a: second\n\n',
    ]))
    assert_eq(len(events), 2, "event count")
    assert_eq(events[0].data, "first", "first event")
    assert_eq(events[1].data, "second", "second event")


# --- ID and Retry ---


def test_id_field():
    events = run(collect_events([b'id: 42\ndata: hello\n\n']))
    assert_eq(len(events), 1, "event count")
    assert_eq(events[0].id, "42", "event id")


def test_id_persists_across_events():
    events = run(collect_events([b'id: 1\ndata: first\n\ndata: second\n\n']))
    assert_eq(len(events), 2, "event count")
    assert_eq(events[0].id, "1", "first event id")
    assert_eq(events[1].id, "1", "id persists to second event")


def test_retry_field():
    events = run(collect_events([b'retry: 3000\ndata: hello\n\n']))
    assert_eq(len(events), 1, "event count")
    assert_eq(events[0].retry, 3000, "retry value")


def test_retry_non_integer_ignored():
    events = run(collect_events([b'retry: abc\ndata: hello\n\n']))
    assert_eq(len(events), 1, "event count")
    assert_eq(events[0].retry, None, "invalid retry ignored")


def test_id_with_null_ignored():
    """Per W3C spec, id containing NULL byte must be ignored."""
    events = run(collect_events([b'id: has\x00null\ndata: hello\n\n']))
    assert_eq(len(events), 1, "event count")
    assert_eq(events[0].id, "", "id with NULL ignored")


# --- OpenAI-Style Events ---


def test_openai_done_marker():
    """OpenAI uses data: [DONE] as stream terminator."""
    events = run(collect_events([
        b'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n',
        b'data: [DONE]\n\n',
    ]))
    assert_eq(len(events), 2, "event count")
    assert_eq(events[1].data, "[DONE]", "DONE marker")


def test_openai_streaming_format():
    """Typical OpenAI streaming response."""
    events = run(collect_events([
        b'data: {"id":"chatcmpl-1","choices":[{"delta":{"role":"assistant"}}]}\n\n',
        b'data: {"id":"chatcmpl-1","choices":[{"delta":{"content":"Hello"}}]}\n\n',
        b'data: {"id":"chatcmpl-1","choices":[{"delta":{"content":" world"}}]}\n\n',
        b'data: [DONE]\n\n',
    ]))
    assert_eq(len(events), 4, "event count")


# --- Edge Cases ---


def test_empty_data_field():
    events = run(collect_events([b'data:\n\n']))
    assert_eq(len(events), 1, "event count")
    assert_eq(events[0].data, "", "empty data")


def test_data_with_leading_space_stripped():
    """Per spec: if value starts with space, remove ONE leading space."""
    events = run(collect_events([b'data:  two spaces\n\n']))
    assert_eq(len(events), 1, "event count")
    assert_eq(events[0].data, " two spaces", "one leading space stripped")


def test_field_without_colon():
    """Field without colon has empty value per spec."""
    events = run(collect_events([b'data\n\n']))
    assert_eq(len(events), 1, "event count")
    assert_eq(events[0].data, "", "field without colon")


def test_empty_lines_without_data_no_event():
    """Empty lines without preceding data should not produce events."""
    events = run(collect_events([b'\n\n\n']))
    assert_eq(len(events), 0, "no events from empty lines")


def test_stream_ends_without_trailing_newline():
    """Handle stream that ends mid-event (no trailing empty line)."""
    events = run(collect_events([b'data: partial']))
    assert_eq(len(events), 1, "final event emitted")
    assert_eq(events[0].data, "partial", "partial data")


def test_unknown_fields_ignored():
    events = run(collect_events([b'unknown: value\ndata: hello\n\n']))
    assert_eq(len(events), 1, "event count")
    assert_eq(events[0].data, "hello", "unknown field ignored")


# --- Main ---


def main():
    print("SSE Decoder Tests (T-1.2)")
    print("=========================")

    print()
    print("Basic:")
    test("single data event", test_single_data_event)
    test("named event", test_named_event)
    test("multi-line data", test_multi_line_data)
    test("multiple events", test_multiple_events)

    print()
    print("CRLF normalization:")
    test("CRLF line endings", test_crlf_line_endings)
    test("CR-only line endings", test_cr_only_line_endings)
    test("mixed line endings", test_mixed_line_endings)

    print()
    print("Comments:")
    test("comments ignored", test_comments_ignored)
    test("empty comment", test_empty_comment)

    print()
    print("Cross-chunk state:")
    test("event split across chunks", test_event_split_across_chunks)
    test("boundary split across chunks", test_event_boundary_split_across_chunks)
    test("multiple events across chunks", test_multiple_events_across_chunks)

    print()
    print("ID and retry:")
    test("id field", test_id_field)
    test("id persists across events", test_id_persists_across_events)
    test("retry field", test_retry_field)
    test("retry non-integer ignored", test_retry_non_integer_ignored)
    test("id with NULL ignored", test_id_with_null_ignored)

    print()
    print("OpenAI-style events:")
    test("OpenAI [DONE] marker", test_openai_done_marker)
    test("OpenAI streaming format", test_openai_streaming_format)

    print()
    print("Edge cases:")
    test("empty data field", test_empty_data_field)
    test("leading space stripped", test_data_with_leading_space_stripped)
    test("field without colon", test_field_without_colon)
    test("empty lines without data", test_empty_lines_without_data_no_event)
    test("stream ends without trailing newline", test_stream_ends_without_trailing_newline)
    test("unknown fields ignored", test_unknown_fields_ignored)

    print()
    print(f"Results: {passed} passed, {failed} failed")

    if failed > 0:
        sys.exit(1)


if __name__ == "__main__":
    main()

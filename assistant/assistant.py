"""Command-line entry point for the assistant package.

Usage:
    python -m assistant.assistant "<ticket text>"
"""
import json
import sys

from .core import handle_ticket


def main() -> None:
    if len(sys.argv) < 2:
        print('Usage: python -m assistant.assistant "<ticket text>"', file=sys.stderr)
        sys.exit(1)

    ticket_text = sys.argv[1]
    result = handle_ticket(ticket_text)

    tool_calls = result.pop("tool_calls")
    total_input_tokens = result.pop("total_input_tokens")
    total_output_tokens = result.pop("total_output_tokens")

    print("\n=== TOOLS CALLED ===")
    if tool_calls:
        for i, call in enumerate(tool_calls, start=1):
            print(f"{i}. {call['name']}({call['arguments']})")
    else:
        print("(none)")

    print("\n=== STRUCTURED RECORD ===")
    print(json.dumps(result, indent=2))

    print("\n=== TOKEN USAGE ===")
    print(f"Total input tokens: {total_input_tokens} | Total output tokens: {total_output_tokens}")


if __name__ == "__main__":
    main()

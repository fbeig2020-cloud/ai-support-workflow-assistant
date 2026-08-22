"""
score_prompt.py

PLAIN-ENGLISH SUMMARY
----------------------
This script tests one prompt against a list of example cases (an eval.jsonl
file). For each example it:
  1. Fills the example's "input" values into the prompt.
  2. Sends the filled-in prompt to Claude.
  3. Compares Claude's answer against the example's "expected" answer.

At the end it prints a score (what fraction of examples matched) and a
line for every example that failed, showing what we expected vs. what
Claude actually said.

USAGE
-----
    python scripts/score_prompt.py <path-to-prompt-file> <path-to-eval.jsonl>

The prompt file is plain text. Anywhere you write {{field_name}}, this
script will replace it with the value of "field_name" from each test
case's "input" object.
"""

import sys
import os
import json
import re

# ---------------------------------------------------------------------------
# SETTINGS YOU MIGHT WANT TO CHANGE
# ---------------------------------------------------------------------------

# Which Claude model to send the prompt to. Change this one line to switch
# models later — nothing else in the file needs to change.
MODEL_NAME = "claude-sonnet-5"

# The most tokens (roughly, chunks of text) Claude is allowed to reply with.
MAX_TOKENS = 1024

# For number fields, how far off Claude's answer is allowed to be from the
# expected number and still count as a match (e.g. 4.99 matching 5).
NUMBER_TOLERANCE = 0.01


# ---------------------------------------------------------------------------
# STEP 1: Read the two files given on the command line
# ---------------------------------------------------------------------------

def read_prompt_file(path):
    """Read the prompt template as plain text."""
    if not os.path.exists(path):
        print(f"I can't find a prompt file at '{path}'.")
        print("Check the path you typed and try again.")
        sys.exit(1)
    with open(path, "r", encoding="utf-8") as f:
        return f.read()


def read_eval_cases(path):
    """Read the eval file: one JSON object per line."""
    if not os.path.exists(path):
        print(f"I can't find an eval file at '{path}'.")
        print("Check the path you typed and try again.")
        sys.exit(1)

    cases = []
    with open(path, "r", encoding="utf-8") as f:
        for line_number, line in enumerate(f, start=1):
            line = line.strip()
            if not line:
                continue
            try:
                cases.append(json.loads(line))
            except json.JSONDecodeError:
                print(f"Skipping line {line_number} of the eval file — it isn't valid JSON.")
    return cases


# ---------------------------------------------------------------------------
# STEP 2: Load the API key from a .env file in the project root
# ---------------------------------------------------------------------------

def load_env_file():
    """
    Read KEY=VALUE lines out of a .env file in the project root and add
    them to the environment, so os.environ.get("ANTHROPIC_API_KEY") works.
    This is a tiny hand-written version of what the "dotenv" package does,
    so we don't need to install anything extra just for this.
    """
    script_dir = os.path.dirname(os.path.abspath(__file__))
    project_root = os.path.dirname(script_dir)
    env_path = os.path.join(project_root, ".env")

    if not os.path.exists(env_path):
        return

    with open(env_path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            key = key.strip()
            value = value.strip().strip('"').strip("'")
            if key and key not in os.environ:
                os.environ[key] = value


# ---------------------------------------------------------------------------
# STEP 3: Fill the prompt template and call Claude
# ---------------------------------------------------------------------------

def fill_prompt(template, input_values):
    """Replace every {{field_name}} in the prompt with its input value."""
    filled = template
    for key, value in input_values.items():
        filled = filled.replace("{{" + key + "}}", str(value))
    return filled


def ask_claude(client, filled_prompt):
    """
    Send the filled-in prompt to Claude and return its reply as plain text.
    Returns (reply_text, error_message). Exactly one of the two is None.
    """
    try:
        response = client.messages.create(
            model=MODEL_NAME,
            max_tokens=MAX_TOKENS,
            messages=[{"role": "user", "content": filled_prompt}],
        )
    except Exception as e:
        # AuthenticationError specifically means the key is missing/wrong —
        # that's worth its own plain-English message and stops the whole
        # run, since every remaining case would fail the same way.
        if e.__class__.__name__ == "AuthenticationError":
            print("Your ANTHROPIC_API_KEY was rejected by Anthropic.")
            print("Fix: open your .env file and check the key is correct, current, and has credit.")
            sys.exit(1)
        return None, str(e)

    text = "".join(block.text for block in response.content if block.type == "text")
    return text, None


# ---------------------------------------------------------------------------
# STEP 4: Parse Claude's reply as JSON, and compare it to what we expected
# ---------------------------------------------------------------------------

def try_parse_json(text):
    """
    Try to read Claude's reply as a JSON object. Claude sometimes wraps
    JSON in a ```json ... ``` code block, so we try that too before
    giving up. Returns None if nothing parses.
    """
    text = text.strip()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass

    fenced = re.search(r"```(?:json)?\s*(\{.*\})\s*```", text, re.DOTALL)
    if fenced:
        try:
            return json.loads(fenced.group(1))
        except json.JSONDecodeError:
            return None

    return None


def field_matches(expected_value, actual_value):
    """Compare one field the way the rules ask for."""
    # Numbers: allow a small tolerance instead of requiring an exact match.
    if isinstance(expected_value, (int, float)) and not isinstance(expected_value, bool) \
       and isinstance(actual_value, (int, float)) and not isinstance(actual_value, bool):
        return abs(expected_value - actual_value) <= NUMBER_TOLERANCE

    # Text: ignore case and surrounding whitespace.
    if isinstance(expected_value, str) and isinstance(actual_value, str):
        return expected_value.strip().lower() == actual_value.strip().lower()

    # Anything else (booleans, lists, etc.): compare as-is.
    return expected_value == actual_value


def case_passes(expected, actual):
    """
    A case passes only if every field named in "expected" is present in
    "actual" and matches. Extra fields in "actual" are ignored on purpose —
    we only grade what "expected" names.
    """
    for key, expected_value in expected.items():
        if key not in actual:
            return False
        if not field_matches(expected_value, actual[key]):
            return False
    return True


# ---------------------------------------------------------------------------
# MAIN
# ---------------------------------------------------------------------------

def main():
    if len(sys.argv) != 3:
        print("Usage: python scripts/score_prompt.py <prompt_file> <eval_jsonl_file>")
        sys.exit(1)

    prompt_path = sys.argv[1]
    eval_path = sys.argv[2]

    prompt_template = read_prompt_file(prompt_path)
    cases = read_eval_cases(eval_path)

    load_env_file()
    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        print("ANTHROPIC_API_KEY is not set.")
        print("Fix: create a .env file in the project root with a line like:")
        print("     ANTHROPIC_API_KEY=sk-ant-...")
        sys.exit(1)

    try:
        from anthropic import Anthropic
    except ImportError:
        print("The 'anthropic' Python package isn't installed.")
        print("Fix: run  python -m pip install anthropic  and try again.")
        sys.exit(1)

    client = Anthropic(api_key=api_key)

    total = 0
    passed = 0
    failures = []

    for case in cases:
        total += 1
        case_input = case.get("input", {})
        expected = case.get("expected", {})
        case_label = case_input.get("request_id", f"case #{total}")

        filled_prompt = fill_prompt(prompt_template, case_input)
        reply_text, error = ask_claude(client, filled_prompt)

        if error:
            failures.append(f"{case_label}: the API call itself failed — {error}")
            continue

        actual = try_parse_json(reply_text)
        if actual is None:
            failures.append(
                f"{case_label}: Claude's reply wasn't valid JSON. Raw reply: {reply_text!r}"
            )
            continue

        if case_passes(expected, actual):
            passed += 1
        else:
            failures.append(f"{case_label}: expected {expected}, got {actual}")

    score = passed / total if total > 0 else 0.0

    print()
    print(f"Score: {score:.2f}  ({passed}/{total} cases matched)")
    print(f"Model used: {MODEL_NAME}")
    print()

    if failures:
        print("Failed cases:")
        for line in failures:
            print(f" - {line}")
    else:
        print("All cases passed.")


if __name__ == "__main__":
    main()

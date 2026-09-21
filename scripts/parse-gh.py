#!/usr/bin/env python3
"""Parse gh-app Python-repr JSON output safely (bare True/False/None, single quotes).

Reads gh-app output from a file (never a pipe), normalizes the Python-repr
tokens, and re-emits clean JSON.
"""
import ast
import json
import re
import sys

def parse_gh_output(raw: str):
    # gh-app emits Python repr: single quotes, bare true/false/null in some
    # paths, bare None in others. Normalize stepwise.
    text = raw.strip()
    # Replace bare Python literals that json can't handle.
    text = re.sub(r'\bNone\b', 'null', text)
    text = re.sub(r'\bTrue\b', 'true', text)
    text = re.sub(r'\bFalse\b', 'false', text)
    # Try direct JSON first (some endpoints return true JSON).
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass
    # Python-repr: single-quoted strings. Convert with ast.literal_eval after
    # token fixes. ast handles single quotes natively; the failed token above
    # was 'None' which we've replaced.
    return ast.literal_eval(text)

if __name__ == '__main__':
    with open(sys.argv[1]) as f:
        raw = f.read()
    data = parse_gh_output(raw)
    json.dump(data, sys.stdout, indent=1, default=str)
    print()
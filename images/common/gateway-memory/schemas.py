"""Tool schemas — what the LLM sees."""

MEMORY_GET = {
    "name": "memory_get",
    "description": (
        "Read one memory entry by key from the gateway's shared memory "
        "store. 'shared' scope (default) is readable by every agent on "
        "the team; 'private' scope is visible only to this agent. "
        "Returns found=false if the key doesn't exist in that scope."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "key": {
                "type": "string",
                "description": "Memory key to fetch.",
            },
            "scope": {
                "type": "string",
                "enum": ["shared", "private"],
                "description": (
                    "shared = visible to the whole team (default). "
                    "private = visible only to this agent."
                ),
            },
        },
        "required": ["key"],
    },
}

MEMORY_SET = {
    "name": "memory_set",
    "description": (
        "Create or update (upsert) a memory entry. Use 'shared' scope "
        "(default) for facts, conventions, or status other fleet agents "
        "should see; use 'private' scope for notes only this agent should "
        "retain. Only the agent that originally wrote a shared entry can "
        "update or delete it later — writing to someone else's shared key "
        "fails with a permission error."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "key": {
                "type": "string",
                "description": "Memory key to write.",
            },
            "value": {
                "type": "string",
                "description": "Text/markdown content to store.",
            },
            "scope": {
                "type": "string",
                "enum": ["shared", "private"],
                "description": (
                    "shared = team-readable (default). private = visible "
                    "only to this agent."
                ),
            },
            "metadata": {
                "type": "object",
                "description": "Optional structured metadata to store alongside the value.",
            },
        },
        "required": ["key", "value"],
    },
}

MEMORY_LIST = {
    "name": "memory_list",
    "description": (
        "List memory entries visible to this agent, optionally filtered "
        "by a key prefix (namespace scan, e.g. 'fleet/conventions/'). Use "
        "this to discover what's already stored before writing duplicates."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "key_prefix": {
                "type": "string",
                "description": "Return only keys starting with this prefix.",
            },
            "scope": {
                "type": "string",
                "enum": ["shared", "private", "all"],
                "description": "Which scope to list. Defaults to 'all' (both).",
            },
        },
        "required": [],
    },
}
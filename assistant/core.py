import json

from . import client as client_module
from . import prompt
from . import tools

OUTPUT_SCHEMA = {
    "type": "object",
    "properties": {
        "category": {"type": "string", "enum": tools.CATEGORIES},
        "priority": {"type": "string", "enum": ["low", "medium", "high", "urgent"]},
        "kb_articles_cited": {"type": "array", "items": {"type": "string"}},
        "draft_reply": {"type": "string"},
        "escalation_recommended": {"type": "boolean"},
        "escalation_reason": {"type": "string"},
        "confidence": {"type": "string", "enum": ["high", "medium", "low", "none"]},
    },
    "required": [
        "category",
        "priority",
        "kb_articles_cited",
        "draft_reply",
        "escalation_recommended",
        "escalation_reason",
        "confidence",
    ],
    "additionalProperties": False,
}

MAX_TOOL_TURNS = 5


def handle_ticket(ticket_text: str) -> dict:
    messages = [{"role": "user", "content": ticket_text}]
    total_input_tokens = 0
    total_output_tokens = 0
    cited_article_ids: set[str] = set()
    tool_calls: list[dict] = []
    tool_turns = 0
    loop_limit_exceeded = False
    searched_category: str | None = None

    output_config = {"format": {"type": "json_schema", "schema": OUTPUT_SCHEMA}}

    response = client_module.client.messages.create(
        model=client_module.MODEL,
        max_tokens=client_module.DEFAULT_MAX_TOKENS,
        system=prompt.SYSTEM_PROMPT,
        tools=tools.TOOLS,
        output_config=output_config,
        messages=messages,
    )
    total_input_tokens += response.usage.input_tokens
    total_output_tokens += response.usage.output_tokens

    while response.stop_reason == "tool_use":
        tool_turns += 1
        if tool_turns > MAX_TOOL_TURNS:
            print(f"Tool-use loop exceeded MAX_TOOL_TURNS ({MAX_TOOL_TURNS}); escalating instead of continuing.")
            loop_limit_exceeded = True
            break

        tool_use_blocks = [b for b in response.content if b.type == "tool_use"]
        messages.append({"role": "assistant", "content": response.content})

        tool_results = []
        for tool_use in tool_use_blocks:
            print(f"Tool requested: {tool_use.name}")
            print(f"Tool arguments: {tool_use.input}")

            tool_calls.append({"name": tool_use.name, "arguments": tool_use.input})

            if tool_use.name == "search_knowledge_base":
                requested_category = tool_use.input.get("category")
                if searched_category is None:
                    searched_category = requested_category
                if requested_category != searched_category:
                    result = {
                        "found": False,
                        "confidence": "none",
                        "results": [],
                        "message": (
                            f"Rejected: a ticket is classified into exactly one category. "
                            f"This ticket was already searched under '{searched_category}'; "
                            f"searching a different category ('{requested_category}') is not "
                            f"permitted. Search '{searched_category}' again with different "
                            f"keywords if you want to refine the match, or conclude no good "
                            f"match exists and recommend escalation."
                        ),
                    }
                else:
                    result = tools.TOOL_FUNCTIONS[tool_use.name](**tool_use.input)
            else:
                result = tools.TOOL_FUNCTIONS[tool_use.name](**tool_use.input)
            print(f"Tool result: {result}")

            if tool_use.name == "search_knowledge_base" and result.get("found"):
                for article in result["results"]:
                    cited_article_ids.add(article["id"])

            tool_results.append(
                {"type": "tool_result", "tool_use_id": tool_use.id, "content": json.dumps(result)}
            )

        messages.append({"role": "user", "content": tool_results})

        response = client_module.client.messages.create(
            model=client_module.MODEL,
            max_tokens=client_module.DEFAULT_MAX_TOKENS,
            system=prompt.SYSTEM_PROMPT,
            tools=tools.TOOLS,
            output_config=output_config,
            messages=messages,
        )
        total_input_tokens += response.usage.input_tokens
        total_output_tokens += response.usage.output_tokens

    if loop_limit_exceeded:
        data = {
            "category": "general_support_request",
            "priority": "medium",
            "kb_articles_cited": [],
            "draft_reply": "",
            "escalation_recommended": True,
            "escalation_reason": (
                f"Tool-use loop exceeded MAX_TOOL_TURNS ({MAX_TOOL_TURNS}) without reaching a final answer."
            ),
            "confidence": "none",
        }
    elif response.stop_reason == "max_tokens":
        data = {
            "category": "general_support_request",
            "priority": "medium",
            "kb_articles_cited": [],
            "draft_reply": "",
            "escalation_recommended": True,
            "escalation_reason": (
                "Model response was truncated by the max_tokens limit before a complete "
                "structured answer could be produced; escalating instead of parsing a partial response."
            ),
            "confidence": "none",
        }
    else:
        text = next(b.text for b in response.content if b.type == "text")
        data = json.loads(text)

        data["kb_articles_cited"] = [
            article_id for article_id in data.get("kb_articles_cited", []) if article_id in cited_article_ids
        ]

    data["requires_human_approval"] = True
    data["status"] = "proposed"
    data["tool_calls"] = tool_calls
    data["total_input_tokens"] = total_input_tokens
    data["total_output_tokens"] = total_output_tokens

    print(f"Final proposal: {json.dumps({k: v for k, v in data.items() if not k.startswith('total_')}, indent=2)}")
    print(f"Total input tokens: {total_input_tokens} | Total output tokens: {total_output_tokens}")

    return data

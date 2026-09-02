import json
import anthropic
from dotenv import load_dotenv

load_dotenv()

client = anthropic.Anthropic()  # reads API key from ANTHROPIC_API_KEY env var

LOOKUP_ORDER_TOOL = {
    "name": "lookup_order",
    "description": "Look up an order by its order ID and return its status, carrier, and ETA.",
    "input_schema": {
        "type": "object",
        "properties": {
            "order_id": {"type": "string", "description": "The order ID, e.g. ORD-4471."}
        },
        "required": ["order_id"],
    },
}


def lookup_order(order_id: str) -> str:
    with open("orders.json") as f:
        orders = json.load(f)
    for order in orders:
        if order["order_id"] == order_id:
            return json.dumps(
                {"status": order["status"], "carrier": order["carrier"], "eta": order["eta"]}
            )
    return f"No order found with ID {order_id}."


class StructuredOutputError(Exception):
    """Raised when the model's final structured response isn't valid, parseable JSON."""


ORDER_STATUS_SCHEMA = {
    "type": "object",
    "properties": {
        "resolution_category": {
            "type": "string",
            "enum": ["on_time", "delayed", "lost", "order_not_found"],
            "description": "The overall outcome of this order-status ticket.",
        },
        "order_facts": {
            "type": "object",
            "description": "The order details exactly as returned by lookup_order — never invented.",
            "properties": {
                "order_id": {"type": "string"},
                "status": {"type": "string", "description": "'not_found' if lookup_order found no match."},
                "carrier": {"type": "string", "description": "Empty string if not applicable."},
                "eta": {"type": "string", "description": "Empty string if not applicable."},
            },
            "required": ["order_id", "status", "carrier", "eta"],
            "additionalProperties": False,
        },
        "urgency": {
            "type": "string",
            "enum": ["low", "medium", "high"],
            "description": "How urgently a support agent should follow up.",
        },
        "customer_reply": {"type": "string", "description": "The human-readable reply to send the customer."},
    },
    "required": ["resolution_category", "order_facts", "urgency", "customer_reply"],
    "additionalProperties": False,
}


def get_structured_result(messages: list, total_input_tokens: int, total_output_tokens: int) -> dict:
    response = client.messages.create(
        model="claude-opus-5",
        max_tokens=1024,
        output_config={"format": {"type": "json_schema", "schema": ORDER_STATUS_SCHEMA}},
        messages=messages,
    )
    total_input_tokens += response.usage.input_tokens
    total_output_tokens += response.usage.output_tokens

    text = next(b.text for b in response.content if b.type == "text")
    try:
        data = json.loads(text)
    except json.JSONDecodeError as e:
        raise StructuredOutputError(f"Model returned invalid JSON for the structured result: {e}") from e

    data["total_input_tokens"] = total_input_tokens
    data["total_output_tokens"] = total_output_tokens
    return data


ticket = (
    "Hi - where is order ORD-4471?? It was supposed to be here last week "
    "and nobody has told me anything."
)
messages = [{"role": "user", "content": ticket}]

response = client.messages.create(
    model="claude-opus-5",
    max_tokens=1024,
    tools=[LOOKUP_ORDER_TOOL],
    messages=messages,
)
total_input_tokens = response.usage.input_tokens
total_output_tokens = response.usage.output_tokens

if response.stop_reason == "tool_use":
    tool_use = next(b for b in response.content if b.type == "tool_use")
    print(f"Tool requested: {tool_use.name}")
    print(f"Tool arguments: {tool_use.input}")

    tool_result = lookup_order(tool_use.input["order_id"])
    print(f"Tool result: {tool_result}")

    messages.append({"role": "assistant", "content": response.content})
    messages.append(
        {
            "role": "user",
            "content": [
                {
                    "type": "tool_result",
                    "tool_use_id": tool_use.id,
                    "content": tool_result,
                }
            ],
        }
    )

    response = client.messages.create(
        model="claude-opus-5",
        max_tokens=1024,
        tools=[LOOKUP_ORDER_TOOL],
        messages=messages,
    )
    total_input_tokens += response.usage.input_tokens
    total_output_tokens += response.usage.output_tokens

final_reply = next(b.text for b in response.content if b.type == "text")
print(f"Final reply: {final_reply}")

# messages already ends on a user turn (the ticket, or the tool_result) — the
# API requires the conversation to end there, so no assistant turn is appended.
structured_result = get_structured_result(messages, total_input_tokens, total_output_tokens)
print(f"Structured result: {json.dumps(structured_result, indent=2)}")
print(
    f"Total input tokens: {structured_result['total_input_tokens']} | "
    f"Total output tokens: {structured_result['total_output_tokens']}"
)

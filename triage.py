import json
import anthropic
from dotenv import load_dotenv

load_dotenv()

client = anthropic.Anthropic()  # reads API key from ANTHROPIC_API_KEY env var

response = client.messages.create(
    model="claude-opus-5",
    max_tokens=1024,
    messages=[
        {"role": "user", "content": "Where is my order ORD-4471? It has been two weeks!"}
    ],
    output_config={
        "format": {
            "type": "json_schema",
            "schema": {
                "type": "object",
                "properties": {
                    "category": {"type": "string", "enum": ["shipping", "billing", "technical", "other"]},
                    "urgency": {"type": "string", "enum": ["low", "normal", "high"]},
                    "order_id": {"type": "string"},
                    "suggested_reply": {"type": "string"},
                },
                "required": ["category", "urgency", "order_id", "suggested_reply"],
                "additionalProperties": False,
            },
        }
    },
)

text = next(block.text for block in response.content if block.type == "text")
data = json.loads(text)

print(f"category: {data['category']}")
print(f"urgency: {data['urgency']}")
print(f"order_id: {data['order_id']}")
print(f"suggested_reply: {data['suggested_reply']}")
print(f"Input tokens: {response.usage.input_tokens} | Output tokens: {response.usage.output_tokens}")

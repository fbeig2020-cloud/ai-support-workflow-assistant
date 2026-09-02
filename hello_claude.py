import anthropic
from dotenv import load_dotenv

load_dotenv()

client = anthropic.Anthropic()  # reads API key from ANTHROPIC_API_KEY env var

response = client.messages.create(
    model="claude-opus-5",
    max_tokens=1024,  # raised from 512: claude-opus-5 extended thinking shares this budget
    system="You are a concise, factual support-operations assistant.",
    messages=[
        {"role": "user", "content": "A customer cannot log in after a password reset. What do you need to help?"}
    ],
)

print(next(block.text for block in response.content if block.type == "text"))
print(f"Input tokens: {response.usage.input_tokens} | Output tokens: {response.usage.output_tokens}")

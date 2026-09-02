import anthropic
from dotenv import load_dotenv

load_dotenv()

MODEL = "claude-opus-5"
DEFAULT_MAX_TOKENS = 3072

client = anthropic.Anthropic()  # reads API key from ANTHROPIC_API_KEY env var

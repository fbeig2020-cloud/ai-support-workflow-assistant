RATES = {
    "claude-opus-5": {"input": 5.00, "output": 25.00},
    "claude-sonnet-5": {"input": 3.00, "output": 15.00},
    "claude-haiku-4-5": {"input": 1.00, "output": 5.00},
}


def price(input_tokens, output_tokens, model):
    rates = RATES[model]
    return (input_tokens / 1_000_000) * rates["input"] + (output_tokens / 1_000_000) * rates["output"]


INPUT_TOKENS = 983
OUTPUT_TOKENS = 462
CALLS_PER_DAY = 1000
DAYS_PER_MONTH = 30  # approximation

print(f"{'Model':<20}{'Cost/call ($)':>15}{'Cost/month, 1k calls/day ($)':>32}")
for model in RATES:
    call_cost = price(INPUT_TOKENS, OUTPUT_TOKENS, model)
    monthly_cost = call_cost * CALLS_PER_DAY * DAYS_PER_MONTH
    print(f"{model:<20}{call_cost:>15.5f}{monthly_cost:>32.2f}")

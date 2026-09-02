import json
from pathlib import Path

CATEGORIES = [
    "login_problem",
    "access_permission_issue",
    "power_bi_report_issue",
    "sql_database_issue",
    "data_issue",
    "technical_question",
    "general_support_request",
]

KNOWLEDGE_BASE_PATH = Path(__file__).resolve().parents[1] / "src" / "data" / "knowledgeBase.json"

SEARCH_KB_TOOL = {
    "name": "search_knowledge_base",
    "description": (
        "Search the support knowledge base for articles matching a ticket's category "
        "and keywords. Returns the best-matching articles with their steps, or an "
        "honest not-found result if nothing matches well."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "category": {"type": "string", "enum": CATEGORIES},
            "keywords": {
                "type": "array",
                "items": {"type": "string"},
                "description": "Optional keywords from the ticket to refine the search.",
            },
        },
        "required": ["category"],
        "additionalProperties": False,
    },
    "strict": True,
}

MIN_RELEVANCE_SCORE = 1
MAX_RESULTS = 3


def search_knowledge_base(category: str, keywords: list[str] | None = None) -> dict:
    # Tool input crosses a trust boundary — never assume the model sent the
    # declared array shape even with strict:True, so normalize defensively.
    if not keywords:
        keywords = []
    elif isinstance(keywords, str):
        keywords = [k.strip() for k in keywords.split(",") if k.strip()]
    elif not isinstance(keywords, list):
        keywords = []

    try:
        with open(KNOWLEDGE_BASE_PATH) as f:
            articles = json.load(f)["articles"]
    except (OSError, json.JSONDecodeError, KeyError) as e:
        return {
            "found": False,
            "confidence": "none",
            "results": [],
            "message": f"Knowledge base unavailable: {e}",
        }

    scored = []
    for article in articles:
        score = 0
        if article["category"] == category:
            score += 3
        for keyword in keywords:
            if any(keyword.lower() in tag.lower() or tag.lower() in keyword.lower() for tag in article["tags"]):
                score += 1
        if score >= MIN_RELEVANCE_SCORE:
            scored.append((score, article))

    scored.sort(key=lambda pair: pair[0], reverse=True)
    top = scored[:MAX_RESULTS]

    if not top:
        return {
            "found": False,
            "confidence": "none",
            "results": [],
            "message": f"No knowledge base article found for category '{category}'.",
        }

    best_score = top[0][0]
    confidence = "high" if best_score >= 4 else "medium" if best_score >= 2 else "low"

    return {
        "found": True,
        "confidence": confidence,
        "results": [
            {
                "id": article["id"],
                "title": article["title"],
                "category": article["category"],
                "steps": article["steps"],
                "score": score,
            }
            for score, article in top
        ],
    }


TOOLS = [SEARCH_KB_TOOL]
TOOL_FUNCTIONS = {"search_knowledge_base": search_knowledge_base}

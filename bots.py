"""Bot detection for the laptop version. A copy of cloudflare/src/bots.js; keep the two in step.

Visitors that announce they're automated are sent to the Bot Arcade. Visitors that act like a
program without announcing it keep playing, and their session is flagged for the instructor.
"""

import re

# Who announces themselves, by user-agent. Order matters: the first match names the visitor.
DECLARED_AGENTS = [
    ("ChatGPT (OpenAI)", re.compile(r"ChatGPT|OAI-SearchBot|GPTBot|OpenAI", re.I)),
    ("Claude (Anthropic)", re.compile(r"Claude-User|ClaudeBot|Claude-SearchBot|Claude-Web|anthropic-ai", re.I)),
    ("the Claude app's built-in browser", re.compile(r"\bClaude/\d")),
    ("Perplexity", re.compile(r"Perplexity(Bot|-User)", re.I)),
    ("Google's crawlers", re.compile(r"Googlebot|GoogleOther|Google-CloudVertexBot|Google-Extended|APIs-Google|Gemini", re.I)),
    ("Microsoft Bing", re.compile(r"bingbot|BingPreview", re.I)),
    ("Meta AI", re.compile(r"meta-externalagent|meta-externalfetcher|FacebookBot|facebookexternalhit", re.I)),
    ("Applebot", re.compile(r"Applebot", re.I)),
    ("Amazonbot", re.compile(r"Amazonbot", re.I)),
    ("ByteDance", re.compile(r"Bytespider", re.I)),
    ("Common Crawl", re.compile(r"CCBot", re.I)),
    ("DuckDuckGo", re.compile(r"DuckAssistBot|DuckDuckBot", re.I)),
    ("Mistral AI", re.compile(r"MistralAI-User", re.I)),
    ("Cohere", re.compile(r"cohere-ai", re.I)),
    ("a headless browser", re.compile(r"HeadlessChrome|PhantomJS|SlimerJS", re.I)),
    ("browser automation", re.compile(r"Selenium|Playwright|Puppeteer|WebDriver", re.I)),
    ("a command-line or code HTTP client", re.compile(
        r"^(curl|Wget|python-requests|Python-urllib|aiohttp|httpx|Go-http-client|node-fetch|axios|okhttp|Java/|libwww-perl|Scrapy|undici)", re.I)),
    ("a self-described bot", re.compile(r"\b(bot|crawler|spider|scraper)\b", re.I)),
]

BROWSER_DECLARES = {
    "webdriver": "reported that it's controlled by automation software (navigator.webdriver)",
}

FLAGS = {
    "scripted_events": "clicked or submitted with scripted, not real, input events",
    "no_typing": "text appeared in the box without typing or pasting",
    "no_activity": "sent a message with no mouse, touch, or keyboard activity on the page",
    "superhuman_typing": "typed faster than a person can",
    "regular_timing": "sent messages at machine-regular intervals",
    "automation_hints": "browser shows signs of being headless or embedded (no window size)",
}


def declared_bot(headers):
    """Why a request counts as a declared bot, or None."""
    signer = headers.get("Signature-Agent")
    if signer:
        return f"signed its requests as an AI agent ({signer.replace(chr(34), '')})"
    if "web-bot-auth" in (headers.get("Signature-Input") or "").lower():
        return "signed its requests as a bot (Web Bot Auth)"
    ua = headers.get("User-Agent") or ""
    if not ua.strip():
        return "sent no browser identification at all"
    for who, pattern in DECLARED_AGENTS:
        if pattern.search(ua):
            return f"identified itself as {who}"
    return None

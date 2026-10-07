// Bot detection, the "playing nice" way:
// - Visitors that announce they're automated (a bot user-agent, a signed AI-agent request, or a
//   browser that reports it's driven by automation) are sent to the Bot Arcade instead of Gandalf.
// - Visitors that don't announce themselves but act like a program are treated like everyone
//   else, and their session is flagged so the instructor can see it.
// The laptop version (../../app.py) uses the same lists.

// Who announces themselves, by user-agent. Order matters: the first match names the visitor.
export const DECLARED_AGENTS = [
  ["ChatGPT (OpenAI)", /ChatGPT|OAI-SearchBot|GPTBot|OpenAI/i],
  ["Claude (Anthropic)", /Claude-User|ClaudeBot|Claude-SearchBot|Claude-Web|anthropic-ai/i],
  ["the Claude app's built-in browser", /\bClaude\/\d/],
  ["Perplexity", /Perplexity(Bot|-User)/i],
  ["Google's crawlers", /Googlebot|GoogleOther|Google-CloudVertexBot|Google-Extended|APIs-Google|Gemini/i],
  ["Microsoft Bing", /bingbot|BingPreview/i],
  ["Meta AI", /meta-externalagent|meta-externalfetcher|FacebookBot|facebookexternalhit/i],
  ["Applebot", /Applebot/i],
  ["Amazonbot", /Amazonbot/i],
  ["ByteDance", /Bytespider/i],
  ["Common Crawl", /CCBot/i],
  ["DuckDuckGo", /DuckAssistBot|DuckDuckBot/i],
  ["Mistral AI", /MistralAI-User/i],
  ["Cohere", /cohere-ai/i],
  ["a headless browser", /HeadlessChrome|PhantomJS|SlimerJS/i],
  ["browser automation", /Selenium|Playwright|Puppeteer|WebDriver/i],
  ["a command-line or code HTTP client", /^(curl|Wget|python-requests|Python-urllib|aiohttp|httpx|Go-http-client|node-fetch|axios|okhttp|Java\/|libwww-perl|Scrapy|undici)/i],
  ["a self-described bot", /\b(bot|crawler|spider|scraper)\b/i],
];

// Returns why a request counts as a declared bot, or null.
export function declaredBot(headers) {
  // ChatGPT agent signs every request (RFC 9421, "Web Bot Auth") with Signature-Agent: "https://chatgpt.com".
  const signer = headers.get("signature-agent");
  if (signer) return `signed its requests as an AI agent (${signer.replace(/"/g, "")})`;
  if (/web-bot-auth/i.test(headers.get("signature-input") || "")) return "signed its requests as a bot (Web Bot Auth)";
  const ua = headers.get("user-agent") || "";
  if (!ua.trim()) return "sent no browser identification at all";
  for (const [who, pattern] of DECLARED_AGENTS) if (pattern.test(ua)) return `identified itself as ${who}`;
  return null;
}

// Signals the page can report. "webdriver" is a declaration (the browser itself says it's
// automated), so it sends the visitor to the arcade; the rest only flag the session.
export const BROWSER_DECLARES = {
  webdriver: "reported that it's controlled by automation software (navigator.webdriver)",
};
export const FLAGS = {
  scripted_events: "clicked or submitted with scripted, not real, input events",
  no_typing: "text appeared in the box without typing or pasting",
  no_activity: "sent a message with no mouse, touch, or keyboard activity on the page",
  superhuman_typing: "typed faster than a person can",
  regular_timing: "sent messages at machine-regular intervals",
  automation_hints: "browser shows signs of being headless or embedded (no window size)",
};

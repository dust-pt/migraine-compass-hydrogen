const GEMINI_MODELS = ["gemini-3.8-flash", "gemini-2.5-flash"];

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    }
  });
}

function buildPrompt(data) {
  return [
    "You are drafting a concise, neutral 1-page clinical brief for a patient to share with their neurologist or doctor.",
    "Rules:",
    "- Report ONLY what is in the logged data below. Do NOT invent triggers, medications, dates, or medical diagnoses.",
    "- Keep each bullet short (max 12 words), plain English, factual, and non-alarmist.",
    "- Return valid JSON with exact keys: overview (string), triggers (array of 3-4 strings), treatments (array of 2-3 strings), patientNote (string).",
    "",
    "Logged patient data (past 7 weeks):",
    JSON.stringify(data)
  ].join("\n");
}

function extractJson(text) {
  const cleaned = text.replace(/^```json\s*/i, "").replace(/```$/i, "").trim();
  return JSON.parse(cleaned);
}

export async function onRequestPost(context) {
  const apiKey = context.env?.GEMINI_API_KEY;
  if (!apiKey) {
    return jsonResponse({ error: "GEMINI_API_KEY is not configured in Cloudflare Pages secrets." }, 503);
  }

  let payload;
  try {
    payload = await context.request.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON request body." }, 400);
  }

  const prompt = buildPrompt({
    totalAttacks: Number(payload.totalAttacks) || 6,
    lastEpisode: String(payload.lastWhen || "15 days ago"),
    counts: payload.counts || {},
    selectedTriggers: Array.isArray(payload.selectedTriggers) ? payload.selectedTriggers : [],
    selectedHelped: Array.isArray(payload.selectedHelped) ? payload.selectedHelped : [],
    sleep: String(payload.sleep || ""),
    weather: String(payload.weather || ""),
    note: String(payload.note || "").slice(0, 600)
  });

  let lastError = "Gemini request failed";

  for (const model of GEMINI_MODELS) {
    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-goog-api-key": apiKey
          },
          body: JSON.stringify({
            contents: [{ role: "user", parts: [{ text: prompt }] }],
            generationConfig: {
              temperature: 0.25,
              maxOutputTokens: 500,
              responseMimeType: "application/json"
            }
          })
        }
      );

      if (!res.ok) {
        const errText = await res.text();
        lastError = `${model} HTTP ${res.status}: ${errText.slice(0, 200)}`;
        continue;
      }

      const data = await res.json();
      const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!rawText) {
        lastError = `${model} returned empty candidate`;
        continue;
      }

      const parsed = extractJson(rawText);
      if (
        typeof parsed.overview === "string" &&
        Array.isArray(parsed.triggers) &&
        Array.isArray(parsed.treatments) &&
        typeof parsed.patientNote === "string"
      ) {
        return jsonResponse({
          source: "gemini",
          model,
          summary: {
            overview: parsed.overview,
            triggers: parsed.triggers.slice(0, 4).map(String),
            treatments: parsed.treatments.slice(0, 4).map(String),
            patientNote: parsed.patientNote
          }
        });
      }
      lastError = `${model} returned unexpected JSON shape`;
    } catch (err) {
      lastError = `${model}: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  return jsonResponse({ error: lastError }, 502);
}

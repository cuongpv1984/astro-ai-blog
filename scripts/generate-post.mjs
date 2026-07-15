import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import matter from "gray-matter";

const root = process.cwd();
const postsDir = path.join(root, "src", "content", "posts");
const provider = process.env.AI_PROVIDER || (process.env.GEMINI_API_KEY ? "gemini" : "openai");
const preferredModel = process.env.OPENAI_MODEL || "gpt-4o-mini";
const geminiModel = process.env.GEMINI_MODEL || "gemini-3.5-flash";
const fallbackModels = [
  preferredModel,
  "gpt-4o-mini",
  "gpt-4o",
  "gpt-4.1-mini",
  "gpt-4.1",
].filter((value, index, list) => value && list.indexOf(value) === index);
const topic = process.env.SITE_TOPIC || "Meo cong nghe va nang suat cho nguoi dung pho thong";
const language = process.env.SITE_LANGUAGE || "vi";
const publishDraft = process.env.PUBLISH_DRAFT === "true";
const categories = [
  "Cong nghe",
  "Nang suat",
  "Doi song so",
  "Huong dan",
];

function slugify(value) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

async function listRecentPosts() {
  const files = await fs.readdir(postsDir).catch(() => []);
  const posts = [];

  for (const file of files.filter((name) => name.endsWith(".md"))) {
    const raw = await fs.readFile(path.join(postsDir, file), "utf8");
    const parsed = matter(raw);
    posts.push({
      title: parsed.data.title,
      category: parsed.data.category,
      file,
    });
  }

  return posts.slice(-20);
}

function extractJson(text) {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```json\s*([\s\S]*?)```/i);
  if (fenced) return JSON.parse(fenced[1]);
  try {
    return JSON.parse(trimmed);
  } catch {
    const firstBrace = trimmed.indexOf("{");
    const lastBrace = trimmed.lastIndexOf("}");
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      return JSON.parse(trimmed.slice(firstBrace, lastBrace + 1));
    }
    throw new Error("AI response did not contain valid JSON.");
  }
}

function extractGeminiText(data) {
  if (typeof data?.output_text === "string") return data.output_text;
  if (typeof data?.outputText === "string") return data.outputText;
  if (Array.isArray(data?.candidates)) {
    const candidateText = data.candidates
      .flatMap((candidate) => candidate.content?.parts || [])
      .map((part) => part.text)
      .filter(Boolean)
      .join("\n");
    if (candidateText) return candidateText;
  }

  const found = [];
  const visit = (value, key = "") => {
    if (!value) return;
    if (typeof value === "string") {
      if (["text", "output_text", "outputText"].includes(key)) {
        found.push(value);
      }
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item) => visit(item));
      return;
    }
    if (typeof value === "object") {
      Object.entries(value).forEach(([childKey, childValue]) => visit(childValue, childKey));
    }
  };

  visit(data);
  return found.join("\n");
}

async function buildPrompt() {
  const recentPosts = await listRecentPosts();
  return `Create one original daily blog article in ${language}.

Site topic: ${topic}
Available categories: ${categories.join(", ")}
Recent posts to avoid repeating: ${JSON.stringify(recentPosts)}

Return only valid JSON with this shape:
{
  "title": "short helpful title",
  "description": "SEO description under 155 characters",
  "category": "one available category",
  "markdown": "article body in Markdown"
}

Rules:
- Write for people first, not search engines.
- Start with a direct 2-3 sentence answer.
- Use clear H2 sections.
- Include practical examples or steps.
- Include a short FAQ section with 3 questions.
- Do not invent statistics, studies, prices, or named sources.
- Do not include the frontmatter block.
- Keep the body between 800 and 1200 words.`;
}

async function requestArticleWithOpenAIModel(modelName) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("Missing OPENAI_API_KEY. Add it to GitHub Secrets or .env.");
  }

  const promptText = await buildPrompt();
  const prompt = {
    role: "user",
    content: [
      {
        type: "input_text",
        text: promptText,
      },
    ],
  };

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: modelName,
      input: [prompt],
      text: {
        format: {
          type: "json_object",
        },
      },
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    const error = new Error(`OpenAI request failed for model ${modelName}: ${response.status} ${body}`);
    error.status = response.status;
    error.body = body;
    throw error;
  }

  const data = await response.json();
  const output = data.output_text || data.output?.flatMap((item) => item.content || [])
    .map((item) => item.text)
    .filter(Boolean)
    .join("\n");

  if (!output) {
    throw new Error("OpenAI returned no article text.");
  }

  return extractJson(output);
}

async function requestArticle() {
  if (provider === "gemini") {
    return requestArticleWithGemini();
  }

  const errors = [];

  for (const modelName of fallbackModels) {
    try {
      console.log(`Trying OpenAI model: ${modelName}`);
      return await requestArticleWithOpenAIModel(modelName);
    } catch (error) {
      const body = String(error.body || error.message || "");
      if (error.status === 403 && body.includes("model_not_found")) {
        errors.push(`${modelName}: no access`);
        continue;
      }
      throw error;
    }
  }

  throw new Error(
    `No configured OpenAI model is available for this API key/project. Tried: ${errors.join(", ")}. Open the OpenAI dashboard, check the project's model access, or set GitHub variable OPENAI_MODEL to a model your project can use.`
  );
}

async function requestArticleWithGemini() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("Missing GEMINI_API_KEY. Add it to GitHub Secrets or .env.");
  }

  const promptText = await buildPrompt();
  console.log(`Trying Gemini model: ${geminiModel}`);

  const response = await fetch("https://generativelanguage.googleapis.com/v1beta/interactions", {
    method: "POST",
    headers: {
      "x-goog-api-key": apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: geminiModel,
      input: promptText,
      generation_config: {
        temperature: 0.8,
      },
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Gemini request failed for model ${geminiModel}: ${response.status} ${body}`);
  }

  const data = await response.json();
  const output = extractGeminiText(data);

  if (!output) {
    throw new Error(`Gemini returned no article text. Response keys: ${Object.keys(data).join(", ")}`);
  }

  return extractJson(output);
}

async function writeArticle(article) {
  const today = new Date().toISOString().slice(0, 10);
  const title = String(article.title || "").trim();
  const description = String(article.description || "").trim();
  const category = categories.includes(article.category) ? article.category : categories[0];
  const markdown = String(article.markdown || "").trim();

  if (title.length < 10) throw new Error("Generated title is too short.");
  if (description.length < 50 || description.length > 170) {
    throw new Error("Generated description must be between 50 and 170 characters.");
  }
  if (markdown.length < 2500) throw new Error("Generated article is too short.");

  let slug = slugify(title);
  let filePath = path.join(postsDir, `${slug}.md`);
  let suffix = 2;

  while (true) {
    try {
      await fs.access(filePath);
      slug = `${slugify(title)}-${suffix}`;
      filePath = path.join(postsDir, `${slug}.md`);
      suffix += 1;
    } catch {
      break;
    }
  }

  const file = matter.stringify(markdown, {
    title,
    description,
    category,
    publishedAt: today,
    updatedAt: today,
    draft: publishDraft,
  });

  await fs.writeFile(filePath, file, "utf8");
  return filePath;
}

const article = await requestArticle();
const filePath = await writeArticle(article);
console.log(`Created ${filePath}`);

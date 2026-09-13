// scrape-news.mjs
// Robot de noticias de BrawlCoach:
// 1) Lee el blog oficial de Brawl Stars (supercell.com) - página pública, sin login.
// 2) Si hay una noticia nueva que aún no hemos publicado, la manda a Hugging Face
//    para que la redacte en español con el tono de BrawlCoach.
// 3) Guarda el resultado en la tabla "noticias" de Supabase.

import * as cheerio from "cheerio";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const HF_TOKEN = process.env.HF_TOKEN;

// Modelo gratuito vía Hugging Face Inference Providers, fijado al proveedor
// Groq (rápido y fiable) para evitar timeouts. Si deja de funcionar, prueba
// otro modelo/proveedor de la lista en https://huggingface.co/docs/inference-providers
const HF_MODEL = "meta-llama/Llama-3.1-8B-Instruct:groq";

const BLOG_URL = "https://supercell.com/en/games/brawlstars/blog/";

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY || !HF_TOKEN) {
  console.error("Faltan variables de entorno (SUPABASE_URL, SUPABASE_SERVICE_KEY o HF_TOKEN).");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

async function fetchLatestArticle() {
  const res = await fetch(BLOG_URL, {
    headers: { "User-Agent": "Mozilla/5.0 (BrawlCoachNewsBot)" },
  });
  if (!res.ok) throw new Error(`No se pudo cargar el blog: ${res.status}`);

  const html = await res.text();
  const $ = cheerio.load(html);

  const candidates = [];
  $('a[href*="/games/brawlstars/blog/"]').each((_, el) => {
    const href = $(el).attr("href");
    const text = $(el).text().trim();
    if (
      href &&
      text &&
      text.length > 5 &&
      !href.endsWith("/blog/") &&
      !href.includes("/blog/page/")
    ) {
      candidates.push({ href, text });
    }
  });

  if (candidates.length === 0) {
    throw new Error(
      "No se encontró ningún artículo. Puede que Supercell haya cambiado el diseño de la página."
    );
  }

  const latest = candidates[0];
  const fullUrl = latest.href.startsWith("http")
    ? latest.href
    : `https://supercell.com${latest.href}`;

  return { title: latest.text, url: fullUrl };
}

async function fetchArticleText(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (BrawlCoachNewsBot)" },
  });
  if (!res.ok) throw new Error(`No se pudo cargar el artículo: ${res.status}`);

  const html = await res.text();
  const $ = cheerio.load(html);
  const text = $("main").text().replace(/\s+/g, " ").trim();
  return text.slice(0, 6000);
}

async function writeNewsWithHuggingFace(originalTitle, articleText) {
  const prompt = `Eres el redactor de noticias de BrawlCoach, una web de coaching de Brawl Stars.
Redacta una noticia breve en español (150-250 palabras), con tono cercano y entusiasta
para jugadores de Brawl Stars, a partir de este contenido oficial de Supercell.

Título original (en inglés): ${originalTitle}
Contenido original: ${articleText}

Responde ÚNICAMENTE con un JSON válido, sin texto adicional, sin backticks ni markdown,
con este formato exacto:
{"titulo": "...", "resumen": "...", "contenido": "..."}

- "titulo": el título traducido/adaptado al español, atractivo.
- "resumen": una frase de gancho (máx 25 palabras).
- "contenido": el cuerpo de la noticia en español (150-250 palabras).`;

  const res = await fetch("https://router.huggingface.co/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${HF_TOKEN}`,
    },
    body: JSON.stringify({
      model: HF_MODEL,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Error de Hugging Face (${res.status}): ${errText}`);
  }

  const data = await res.json();
  const rawText = data.choices?.[0]?.message?.content || "";
  const cleaned = rawText.replace(/```json|```/g, "").trim();

  try {
    return JSON.parse(cleaned);
  } catch (e) {
    throw new Error(`El modelo no devolvió un JSON válido:\n${rawText}`);
  }
}

async function main() {
  console.log("Buscando la última noticia en el blog oficial...");
  const latest = await fetchLatestArticle();
  console.log("Última encontrada:", latest.title, "-", latest.url);

  const { data: existing, error: checkError } = await supabase
    .from("noticias_procesadas")
    .select("url")
    .eq("url", latest.url)
    .maybeSingle();

  if (checkError) throw checkError;

  if (existing) {
    console.log("Ya estaba publicada. No hay nada nuevo que hacer.");
    return;
  }

  console.log("¡Es nueva! Descargando el contenido completo...");
  const articleText = await fetchArticleText(latest.url);

  console.log("Pidiendo a Hugging Face que la redacte en español...");
  const noticia = await writeNewsWithHuggingFace(latest.title, articleText);

  console.log("Guardando en la tabla noticias...");
  const { error: insertError } = await supabase.from("noticias").insert({
    titulo: noticia.titulo,
    resumen: noticia.resumen,
    contenido: noticia.contenido,
    fuente_url: latest.url,
  });
  if (insertError) throw insertError;

  await supabase
    .from("noticias_procesadas")
    .insert({ url: latest.url, titulo: latest.title });

  console.log("Listo. Noticia publicada:", noticia.titulo);
}

main().catch((err) => {
  console.error("Error en el robot de noticias:", err);
  process.exit(1);
});

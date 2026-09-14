// scrape-news.mjs
// Robot de noticias de BrawlCoach:
// 1) Lee el blog oficial de Brawl Stars (supercell.com) - página pública, sin login.
// 2) Si hay una noticia nueva que aún no hemos publicado, la manda a Hugging Face
//    para que la redacte en español con el tono de BrawlCoach.
// 3) Guarda el resultado en la tabla "brawl_news" de Supabase (la que lee la web real).
// 4) Marca la URL como procesada en "noticias_procesadas" para no repetirla.

import * as cheerio from "cheerio";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const HF_TOKEN = process.env.HF_TOKEN;

const HF_MODEL = "meta-llama/Llama-3.1-8B-Instruct";

const BLOG_URL = "https://supercell.com/en/games/brawlstars/blog/";

// Imagen de respaldo por si el artículo no tiene og:image
const FALLBACK_IMAGE =
  "https://supercell.com/en/games/brawlstars/static/images/social-share.jpg";

// Categorías permitidas para clasificar la noticia
const CATEGORIAS_VALIDAS = [
  "Actualización",
  "Evento",
  "Balance",
  "Esports",
  "General"
];

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY || !HF_TOKEN) {
  console.error(
    "Faltan variables de entorno (SUPABASE_URL, SUPABASE_SERVICE_KEY o HF_TOKEN)."
  );
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

async function fetchArticleDetails(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (BrawlCoachNewsBot)" },
  });

  if (!res.ok) throw new Error(`No se pudo cargar el artículo: ${res.status}`);

  const html = await res.text();
  const $ = cheerio.load(html);

  const text = $("main").text().replace(/\s+/g, " ").trim();

  const ogImage =
    $('meta[property="og:image"]').attr("content") ||
    $('meta[name="twitter:image"]').attr("content") ||
    FALLBACK_IMAGE;

  return {
    text: text.slice(0, 6000),
    imageUrl: ogImage,
  };
}

function formatFechaEspanol(date) {
  return date.toLocaleDateString("es-ES", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

async function writeNewsWithHuggingFace(originalTitle, articleText) {
  const prompt = `Eres el redactor de noticias de BrawlCoach, una web de coaching de Brawl Stars.
Redacta una noticia breve en español (40-60 palabras), con tono cercano y entusiasta
para jugadores de Brawl Stars, a partir de este contenido oficial de Supercell.

Título original (en inglés): ${originalTitle}
Contenido original: ${articleText}

También clasifica la noticia en UNA de estas categorías exactas (elige la que mejor encaje):
${CATEGORIAS_VALIDAS.join(", ")}

Responde ÚNICAMENTE con un JSON válido, sin texto adicional, sin backticks ni markdown,
con este formato exacto:
{"titulo": "...", "resumen": "...", "categoria": "..."}

- "titulo": el título traducido/adaptado al español, atractivo (máx 80 caracteres).
- "resumen": el cuerpo de la noticia en español (40-60 palabras).
- "categoria": una de las categorías de la lista de arriba, EXACTAMENTE como está escrita.`;

  const MAX_INTENTOS = 3;

  for (let intento = 1; intento <= MAX_INTENTOS; intento++) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 90000);

      const res = await fetch(
        "https://router.huggingface.co/v1/chat/completions",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${HF_TOKEN}`,
          },
          body: JSON.stringify({
            model: HF_MODEL,
            messages: [{ role: "user", content: prompt }],
          }),
          signal: controller.signal,
        }
      );

      clearTimeout(timeoutId);

      if (!res.ok) {
        const errText = await res.text();
        throw new Error(
          `Error de Hugging Face (${res.status}): ${errText}`
        );
      }

      const data = await res.json();
      const rawText = data.choices?.[0]?.message?.content || "";
      const cleaned = rawText.replace(/```json|```/g, "").trim();

      const parsed = JSON.parse(cleaned);

      // Nos aseguramos de que la categoría sea una de las válidas;
      // si no, "General".
      if (!CATEGORIAS_VALIDAS.includes(parsed.categoria)) {
        parsed.categoria = "General";
      }

      return parsed;
    } catch (e) {
      console.log(
        `Intento ${intento} de ${MAX_INTENTOS} falló: ${e.message}`
      );

      if (intento === MAX_INTENTOS) throw e;

      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}

async function main() {
  console.log("Buscando la última noticia en el blog oficial...");

  const latest = await fetchLatestArticle();

  console.log(
    "Última encontrada:",
    latest.title,
    "-",
    latest.url
  );

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

  const { text: articleText, imageUrl } =
    await fetchArticleDetails(latest.url);

  console.log(
    "Pidiendo a Hugging Face que la redacte en español..."
  );

  const noticia = await writeNewsWithHuggingFace(
    latest.title,
    articleText
  );

  console.log("Guardando en la tabla brawl_news...");

  const { error: insertError } = await supabase
    .from("brawl_news")
    .insert({
      title: noticia.titulo,
      summary: noticia.resumen,
      category: noticia.categoria,
      image_url: imageUrl,
      formatted_time: formatFechaEspanol(new Date()),
      sources_count: 1,
    });

  if (insertError) throw insertError;

  await supabase
    .from("noticias_procesadas")
    .insert({
      url: latest.url,
      titulo: latest.title,
    });

  console.log("Listo. Noticia publicada:", noticia.titulo);
}

main().catch((err) => {
  console.error("Error en el robot de noticias:", err);
  process.exit(1);
});

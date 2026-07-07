import { useEffect } from "react";

/**
 * Client-side per-route metadata. The static `<head>` in index.html carries the
 * home-page defaults (and is what the build-time prerender snapshots into the
 * per-route HTML files); this module updates the same tags live as the SPA
 * navigates, so browser tabs, history entries, and JS-rendering crawlers see
 * the right title/description/canonical for each view.
 *
 * Non-JS social crawlers (Discord/Twitter/etc.) only ever read the served HTML,
 * so their card comes from whichever prerendered file the URL resolves to.
 */

/** Canonical production origin (Firebase custom domain), no trailing slash. */
export const SITE_URL = "https://recap.latam-tools.com.br";

/** Absolute social preview image (generated into dist/og.png at build time). */
export const OG_IMAGE = `${SITE_URL}/og.png`;

const DEFAULT_TITLE = "RagnaRecap — Análise de Replays Ragnarok Online";
const DEFAULT_DESCRIPTION =
  "Carregue, visualize e compartilhe replays .rrf do Ragnarok Online. " +
  "Estatísticas de DPS, abates, equipamentos e timeline — tudo no navegador.";

export type SeoMeta = {
  /** Full document title. */
  title?: string;
  description?: string;
  /** Absolute canonical URL for this view. Defaults to the current location. */
  canonical?: string;
};

function upsertMeta(selector: string, attr: "name" | "property", key: string, content: string) {
  let el = document.head.querySelector<HTMLMetaElement>(selector);
  if (!el) {
    el = document.createElement("meta");
    el.setAttribute(attr, key);
    document.head.appendChild(el);
  }
  el.setAttribute("content", content);
}

function upsertCanonical(href: string) {
  let el = document.head.querySelector<HTMLLinkElement>('link[rel="canonical"]');
  if (!el) {
    el = document.createElement("link");
    el.setAttribute("rel", "canonical");
    document.head.appendChild(el);
  }
  el.setAttribute("href", href);
}

/**
 * Imperatively sync the document `<head>` to `meta`, filling any gap with the
 * home-page defaults so a view that only sets a title still resets the
 * description/canonical the previous view may have left behind.
 */
export function applySeo(meta: SeoMeta) {
  const title = meta.title ?? DEFAULT_TITLE;
  const description = meta.description ?? DEFAULT_DESCRIPTION;
  // Default the origin to the canonical production host (never the live
  // location.origin) so it stays correct on the .web.app mirror and in the
  // headless-browser prerender, which both run under a non-canonical origin.
  const path = typeof location !== "undefined" ? location.pathname : "/";
  const canonical = meta.canonical ?? SITE_URL + path;

  document.title = title;
  upsertMeta('meta[name="description"]', "name", "description", description);
  upsertCanonical(canonical);

  upsertMeta('meta[property="og:title"]', "property", "og:title", title);
  upsertMeta('meta[property="og:description"]', "property", "og:description", description);
  upsertMeta('meta[property="og:url"]', "property", "og:url", canonical);

  upsertMeta('meta[name="twitter:title"]', "name", "twitter:title", title);
  upsertMeta('meta[name="twitter:description"]', "name", "twitter:description", description);
}

/**
 * Apply per-view SEO metadata for as long as the calling component is mounted.
 * The next mounted view overwrites it, so there's no teardown to undo.
 */
export function useSeo(meta: SeoMeta) {
  useEffect(() => {
    applySeo(meta);
    // Re-run whenever the concrete values change.
  }, [meta.title, meta.description, meta.canonical]);
}

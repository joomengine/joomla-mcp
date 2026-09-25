export const articleTextDescription =
  'Complete article HTML, split at the first Joomla Read More marker into introtext and fulltext. ' +
  'Without a marker, fulltext is cleared. Use articletext alone or explicit introtext/fulltext, never both.';

// Match Joomla's Content::bind() delimiter, including case and quote handling.
// Source: libraries/src/Table/Content.php at 071afb7ad305c02983a653ccfc301b5c8360264b.
const readMoreMarker = /<hr[\t\n\v\f\r ]+id=("|')system-readmore("|')[\t\n\v\f\r ]*\/*>/i;

/**
 * Translate the editor's combined text into Joomla's native storage fields.
 * API PATCH fills omitted columns from the current row before binding; sending
 * articletext alone lets those old values overwrite Content::bind()'s split.
 * Normalize before confirmation and use the same fields for API and companion.
 */
export function normalizeArticleText(
  body: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const articletext = body['articletext'];
  if (articletext === undefined) return body;

  if (typeof articletext !== 'string') {
    throw new Error('Article articletext must be a string.');
  }
  if (Object.hasOwn(body, 'introtext') || Object.hasOwn(body, 'fulltext')) {
    throw new Error('Use articletext or introtext/fulltext, not both in the same article mutation.');
  }

  const marker = readMoreMarker.exec(articletext);
  const normalized = { ...body };
  delete normalized['articletext'];
  normalized['introtext'] = marker === null ? articletext : articletext.slice(0, marker.index);
  normalized['fulltext'] = marker === null ? '' : articletext.slice(marker.index + marker[0].length);

  return Object.freeze(normalized);
}

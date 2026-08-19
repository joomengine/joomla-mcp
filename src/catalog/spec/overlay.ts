import type { ResolvedActionCatalog } from './types.js';

/**
 * Process-wide overlay slot. Kept in its own module so action-catalog.ts can
 * read it without importing the spec loader (which would cycle through the
 * in-repo fallback arrays).
 */
let overlay: ResolvedActionCatalog | undefined;
let configured = false;

export function setActionCatalogOverlay(next: ResolvedActionCatalog | undefined): void {
  overlay = next;
  configured = true;
}

export function getActionCatalogOverlay(): ResolvedActionCatalog | undefined {
  return overlay;
}

export function isActionCatalogOverlayConfigured(): boolean {
  return configured;
}

export function resetActionCatalogOverlay(): void {
  overlay = undefined;
  configured = false;
}

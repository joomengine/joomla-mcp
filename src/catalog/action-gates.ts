/**
 * Source-registered actions that are intentionally not executable.
 *
 * Keeping these actions in the catalogue preserves an exact Joomla route
 * inventory while preventing route registration from being mistaken for a
 * functioning, production-safe controller contract.
 */
export const sourceOnlyActionGates: Readonly<Record<string, string>> = Object.freeze({
  'configuration.component.get':
    'Raw component configuration can contain extension secrets and has no reviewed component-specific output allowlist.',
  'configuration.component.update':
    'Component configuration is defined by each runtime config.xml form; execution requires runtime schema discovery and secret classification.',
  'languages.packages.install':
    'Joomla registers languages.install, but the Joomla 6.1 API LanguagesController has no install task or task alias.',
  'languages.overrides.site.update':
    'Joomla 6.1 routes the string override constant through ApiController::edit(), which coerces id to integer and prevents the registered PATCH route from resolving.',
  'languages.overrides.administrator.update':
    'Joomla 6.1 routes the string override constant through ApiController::edit(), which coerces id to integer and prevents the registered PATCH route from resolving.',
});

export function sourceOnlyGateReason(actionId: string): string | undefined {
  return sourceOnlyActionGates[actionId];
}

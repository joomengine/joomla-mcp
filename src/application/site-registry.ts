import type { Configuration, SiteConfig, Toolset } from '../config/schema.js';

export class SiteRegistry {
  public constructor(private readonly configuration: Configuration) {}

  public get(id?: string): SiteConfig {
    const selected = id === undefined || id === '' ? this.configuration.defaultSite : id;
    const site = this.configuration.sites.get(selected);

    if (site === undefined) {
      throw new Error(`Unknown Joomla site: ${selected}`);
    }

    return site;
  }

  public requireToolset(site: SiteConfig, toolset: Toolset): void {
    if (!site.toolsets.has(toolset)) {
      throw new Error(`Toolset ${toolset} is disabled for Joomla site ${site.id}.`);
    }
  }

  public summary(): {
    defaultSite: string;
    sites: Array<{ id: string; api: boolean; cli: boolean; toolsets: Toolset[] }>;
  } {
    return {
      defaultSite: this.configuration.defaultSite,
      sites: [...this.configuration.sites.values()].map((site) => ({
        id: site.id,
        api: site.api !== undefined,
        cli: site.cli !== undefined,
        toolsets: [...site.toolsets],
      })),
    };
  }
}

import { describe, expect, it } from 'vitest';

import {
  LIVE_SCENARIO_SCHEMA,
  expandLiveScenarioValue,
  loadLiveScenarioConfiguration,
  orderedLiveScenarioRecords,
  recordReferences,
  resolveLiveScenarioValue,
  scenarioActionSelected,
  validateScenarioConfiguration,
  type LiveScenarioConfiguration,
} from '../src/live-test/scenario-config.js';

function configuration(
  resources: LiveScenarioConfiguration['resources'],
): LiveScenarioConfiguration {
  return {
    schema: LIVE_SCENARIO_SCHEMA,
    name: 'Unit scenario',
    target: { configurationFile: 'config/sites.json' },
    selection: {
      profile: 'crud',
      joomlaPaths: ['api'],
      mcpTransports: ['stdio'],
      families: [],
    },
    safety: {
      confirmMutations: true,
      disposable: true,
      cleanup: 'never',
    },
    progress: { enabled: true, heartbeatSeconds: 30 },
    resources,
  };
}

describe('live scenario configuration', () => {
  it('loads the packaged default with all CRUD families and the requested visible site graph', async () => {
    const scenario = await loadLiveScenarioConfiguration('config/live-test.default.json');
    expect(Object.keys(scenario.resources)).toHaveLength(36);
    expect(scenario.resources['content.categories']?.records).toHaveLength(3);
    expect(scenario.resources['content.articles']?.records).toHaveLength(5);
    expect(scenario.resources['users.groups']?.records).toHaveLength(4);
    expect(scenario.resources['users.users']?.records).toHaveLength(5);
    expect(scenario.resources['banners.categories']?.records).toHaveLength(3);
    expect(scenario.resources['banners.banners']?.records).toHaveLength(5);
    expect(scenario.resources['menus.site-items']?.records).toHaveLength(5);
    expect(scenario.resources['modules.site']?.records).toHaveLength(5);
    expect(orderedLiveScenarioRecords(scenario)).toHaveLength(117);
  });

  it('orders named dependencies and resolves their runtime Joomla identifiers', () => {
    const scenario = configuration({
      'content.categories': {
        records: [{
          key: 'news',
          generate: false,
          data: { title: 'News', alias: 'live-news', published: 1 },
          updates: [],
          deleteAfterVerify: false,
        }],
      },
      'content.articles': {
        records: [{
          key: 'launch',
          generate: false,
          data: {
            title: 'Launch',
            alias: 'launch',
            catid: { $ref: 'content.categories.news' },
            state: 1,
          },
          updates: [{
            name: 'unpublish',
            data: { state: 0 },
          }, {
            name: 'republish',
            data: { state: 1 },
          }],
          deleteAfterVerify: false,
        }],
      },
    });

    expect(() => validateScenarioConfiguration(scenario)).not.toThrow();
    expect(orderedLiveScenarioRecords(scenario).map((entry) => entry.reference)).toEqual([
      'content.categories.news',
      'content.articles.launch',
    ]);
    const article = scenario.resources['content.articles']!.records[0]!;
    expect(recordReferences(article)).toEqual(['content.categories.news']);
    expect(resolveLiveScenarioValue(article.data, new Map([
      ['content.categories.news', {
        id: 71,
        label: 'News',
        attributes: { title: 'News' },
      }],
    ]))).toMatchObject({ catid: 71 });
  });

  it('resolves multiple groups and template links by human reference', () => {
    const registry = new Map([
      ['users.groups.authors', {
        id: 12,
        label: 'Authors',
        attributes: { title: 'Authors' },
      }],
      ['users.groups.reviewers', {
        id: 13,
        label: 'Reviewers',
        attributes: { title: 'Reviewers' },
      }],
      ['content.articles.launch', {
        id: 99,
        label: 'Launch',
        attributes: { title: 'Launch' },
      }],
    ]);

    expect(resolveLiveScenarioValue({
      groups: { $refs: ['users.groups.authors', 'users.groups.reviewers'] },
      link: {
        $template: 'index.php?option=com_content&view=article&id={{content.articles.launch.id}}',
      },
    }, registry)).toEqual({
      groups: [12, 13],
      link: 'index.php?option=com_content&view=article&id=99',
    });
  });

  it('expands deterministic run and lane tokens without interpreting named references', () => {
    const context = {
      scenario: 'Unit scenario',
      seed: 'build-42',
      lane: 'stdio-api',
    };
    const first = expandLiveScenarioValue({
      alias: 'article-{{token}}',
      note: '{{seed}}/{{lane}}',
      link: {
        $template: 'index.php?id={{content.articles.launch.id}}&run={{token}}',
      },
    }, context);
    const second = expandLiveScenarioValue({
      alias: 'article-{{token}}',
      note: '{{seed}}/{{lane}}',
      link: {
        $template: 'index.php?id={{content.articles.launch.id}}&run={{token}}',
      },
    }, context);

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      alias: expect.stringMatching(/^article-[a-f0-9]{12}$/u),
      note: 'build-42/stdio-api',
      link: {
        $template: expect.stringContaining('{{content.articles.launch.id}}'),
      },
    });
  });

  it('fails closed for missing, duplicate, cyclic, or numeric relationship references', () => {
    const numericCategory = configuration({
      'content.articles': {
        records: [{
          key: 'invalid',
          generate: false,
          data: { title: 'Invalid', catid: 2 },
          updates: [],
          deleteAfterVerify: false,
        }],
      },
    });
    expect(() => validateScenarioConfiguration(numericCategory))
      .toThrow('must express catid with a named $ref');

    const numericModuleAssignment = configuration({
      'modules.site': {
        records: [{
          key: 'invalid',
          generate: false,
          data: { title: 'Invalid module', assigned: [12] },
          updates: [],
          deleteAfterVerify: false,
        }],
      },
    });
    expect(() => validateScenarioConfiguration(numericModuleAssignment))
      .toThrow('must express assigned with a named $refs');

    const missing = configuration({
      'content.categories': {
        records: [{
          key: 'child',
          generate: false,
          data: { title: 'Child', parent_id: { $ref: 'content.categories.missing' } },
          updates: [],
          deleteAfterVerify: false,
        }],
      },
    });
    expect(() => validateScenarioConfiguration(missing)).toThrow('references missing record');

    const cycle = configuration({
      'content.categories': {
        records: [{
          key: 'first',
          generate: false,
          data: { title: 'First', parent_id: { $ref: 'content.categories.second' } },
          updates: [],
          deleteAfterVerify: false,
        }, {
          key: 'second',
          generate: false,
          data: { title: 'Second', parent_id: { $ref: 'content.categories.first' } },
          updates: [],
          deleteAfterVerify: false,
        }],
      },
    });
    expect(() => validateScenarioConfiguration(cycle)).toThrow('dependency cycle');
  });

  it('selects only configured CRUD families and explicitly included special actions', () => {
    const scenario: LiveScenarioConfiguration = {
      ...configuration({
        'content.articles': {
          records: [{
            key: 'article',
            generate: false,
            data: { title: 'Article', catid: { $ref: 'content.categories.news' } },
            updates: [],
            deleteAfterVerify: false,
          }],
        },
        'content.categories': {
          records: [{
            key: 'news',
            generate: false,
            data: { title: 'News' },
            updates: [],
            deleteAfterVerify: false,
          }],
        },
      }),
      specialActions: {
        include: ['cache'],
        exclude: ['cache.clean'],
      },
    };

    expect(scenarioActionSelected('content.articles.create', scenario)).toBe(true);
    expect(scenarioActionSelected('users.users.create', scenario)).toBe(false);
    expect(scenarioActionSelected('cache.status', scenario)).toBe(true);
    expect(scenarioActionSelected('cache.clean', scenario)).toBe(false);
  });
});

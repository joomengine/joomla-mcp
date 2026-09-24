#!/usr/bin/env node

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';

import { loadConfiguration } from '../../dist/config/load.js';
import { createHttpLiveSession, createStdioLiveSession } from '../../dist/live-test/transports.js';

// Run only against the disposable Joomla instance created by run-joomengine.sh.
// Every assertion reads the article through Joomla's real GET API after the write.
const [configurationFile, evidenceFile, disposable] = process.argv.slice(2);
assert.ok(configurationFile && evidenceFile && disposable === '--disposable',
  'Usage: verify-article-bodies.mjs CONFIG EVIDENCE --disposable');
const configuration = await loadConfiguration(configurationFile);
const site = 'fixture';
const api = configuration.sites.get(site)?.api;
assert.ok(api, 'The disposable fixture must configure its API adapter.');
assert.equal(new URL(api.baseUrl).hostname, '127.0.0.1', 'The fixture must use loopback.');
assert.equal(api.allowInsecureLoopback, true, 'The fixture must explicitly enable loopback HTTP.');
const evidence = { issue: 31, checks: [], cleanup: [], status: 'RUNNING' };

try {
  for (const transport of ['stdio', 'http']) {
    const session = transport === 'stdio'
      ? await createStdioLiveSession({ configurationFile })
      : await createHttpLiveSession(configuration);
    try {
      await verifySession(session);
    } finally {
      await session.close();
    }
  }
  evidence.status = 'PASS';
} catch (error) {
  evidence.status = 'FAIL';
  evidence.error = error instanceof Error ? error.message : String(error);
  throw error;
} finally {
  await writeFile(evidenceFile, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
}

async function verifySession(session) {
  const requested = await session.call({
    name: 'joomla_permission_request',
    arguments: {
      site, toolsets: ['content.write', 'structure.write'], duration: '30-minutes',
      reason: 'Verify article body persistence in the disposable Joomla fixture.',
    },
  });
  await session.call({
    name: 'joomla_permission_approve',
    arguments: { requestId: requested.requestId, acknowledgement: requested.acknowledgement },
  });

  const resources = [];
  const errors = [];
  try {
    const suffix = randomUUID();
    const category = resource(await write(session, 'generic', 'content.categories.create', {
      data: {
        parent_id: 1, title: `Article body fixture ${suffix}`, alias: `article-body-${suffix}`,
        published: 1, access: 1, language: '*',
      },
    }));
    const catid = Number(category.id);
    resources.push({ base: 'content.categories', id: catid });

    for (const planner of ['generic', 'typed']) {
      const label = `${session.kind}/${planner}`;
      let title = `Body regression ${planner} ${suffix}`;
      const initial = '<p>Initial plain article body.</p>';
      const intro = '<p>Replacement introduction.</p>';
      const full = '<p>Replacement continuation.</p>';
      const combined = `${intro}<hr id="system-readmore" />${full}`;
      const created = resource(await write(session, planner, 'content.articles.create', {
        data: { title, catid, articletext: initial, state: 1, language: '*', access: 1 },
      }));
      const id = Number(created.id);
      resources.push({ base: 'content.articles', id });
      await check('create plain articletext', initial, '');

      await update({ articletext: combined });
      await check('update readmore articletext', intro, full);

      const replacement = '<p>Plain replacement clears the previous continuation.</p>';
      await update({ articletext: replacement });
      await check('remove previous fulltext', replacement, '');

      await update({ introtext: intro, fulltext: full });
      await check('explicit introtext and fulltext', intro, full);

      const partialIntro = '<p>Only the introduction changes.</p>';
      await update({ introtext: partialIntro });
      await check('introtext-only update preserves fulltext', partialIntro, full);

      const partialFull = '<p>Only the continuation changes.</p>';
      await update({ fulltext: partialFull });
      await check('fulltext-only update preserves introtext', partialIntro, partialFull);

      title = `${title} renamed`;
      await update({ title });
      await check('title-only update preserves both body fields', partialIntro, partialFull);

      for (const field of ['introtext', 'fulltext']) {
        await assert.rejects(
          () => plan(session, planner, 'content.articles.update', {
            id, data: { articletext: combined, [field]: '<p>Conflicting body.</p>' },
          }),
          /articletext/iu,
          `${label}: mixed articletext and ${field} must fail before writing`,
        );
      }
      await check('mixed body fields rejected without changing stored content', partialIntro, partialFull);

      await update({ articletext: '' });
      await check('empty articletext clears both body fields', '', '');

      const splitCreated = resource(await write(session, planner, 'content.articles.create', {
        data: {
          title: `Readmore creation ${planner} ${suffix}`, catid, articletext: combined,
          state: 1, language: '*', access: 1,
        },
      }));
      const splitId = Number(splitCreated.id);
      resources.push({ base: 'content.articles', id: splitId });
      await assertBody(session, splitId, intro, full, `Readmore creation ${planner} ${suffix}`);
      passed(`${label}: create readmore articletext`);

      async function update(data) {
        await write(session, planner, 'content.articles.update', { id, data });
      }

      async function check(name, expectedIntro, expectedFull) {
        await assertBody(session, id, expectedIntro, expectedFull, title);
        passed(`${label}: ${name}`);
      }
    }
  } catch (error) {
    errors.push(error);
  } finally {
    // Joomla's delete lifecycle requires trashing records first. Reverse order
    // removes articles before their category, including on an assertion failure.
    for (const { base, id } of resources.reverse()) {
      try {
        await write(session, 'generic', `${base}.update`, {
          id, data: base === 'content.articles' ? { state: -2 } : { published: -2 },
        });
        await write(session, 'generic', `${base}.delete`, { id });
        evidence.cleanup.push({ transport: session.kind, action: `${base}.delete`, id, status: 'PASS' });
      } catch (error) {
        evidence.cleanup.push({ transport: session.kind, action: `${base}.delete`, id, status: 'FAIL' });
        errors.push(error);
      }
    }
  }
  if (errors.length) throw new AggregateError(errors, errors.map((error) => error.message).join('\n'));
}

async function plan(session, planner, action, input) {
  return session.call(planner === 'typed' ? {
    name: `joomla_content_article_${action.endsWith('.create') ? 'create' : 'update'}_plan`,
    arguments: { site, ...input, idempotencyKey: randomUUID() },
  } : {
    name: 'joomla_action_write_plan',
    arguments: { site, action, input, transport: 'api', idempotencyKey: randomUUID(), dryRun: false },
  });
}

async function write(session, planner, action, input) {
  const planned = await plan(session, planner, action, input);
  assert.equal(typeof planned.confirmationToken, 'string', `${action} must return an executable plan.`);
  return session.call({ name: 'joomla_write_apply', arguments: { confirmationToken: planned.confirmationToken } });
}

function resource(applied) {
  const item = applied.mutation?.data?.data;
  assert.ok(item && Number.isSafeInteger(Number(item.id)) && Number(item.id) > 0,
    'A successful fixture create must return its resource ID.');
  return item;
}

async function assertBody(session, id, expectedIntro, expectedFull, title) {
  const response = await session.call({
    name: 'joomla_action_read',
    arguments: { site, action: 'content.articles.get', input: { id }, transport: 'api' },
  });
  assert.equal(response.status, 200, 'Article readback must come from a successful Joomla API GET.');
  const item = response.data?.data;
  assert.equal(String(item?.id), String(id), 'Readback must identify the created article.');
  assert.equal(item?.attributes?.title, title, 'The persisted title must match its latest value.');
  // Joomla's API view exposes introtext + one literal space + fulltext as `text`.
  assert.equal(item.attributes.text, `${expectedIntro} ${expectedFull}`,
    'Joomla API GET returned an unexpected persisted article body.');

  // The native model also exposes the stored columns separately, proving that
  // the API write preserved the readmore boundary rather than merely its text.
  const native = await session.call({
    name: 'joomla_action_read',
    arguments: { site, action: 'content.articles.get', input: { id }, transport: 'cli' },
  });
  assert.equal(native.data?.ok, true, 'The companion must read the persisted article successfully.');
  assert.equal(String(native.data?.result?.id), String(id));
  assert.equal(native.data.result.introtext, expectedIntro, 'Stored introtext must match exactly.');
  assert.equal(native.data.result.fulltext, expectedFull, 'Stored fulltext must match exactly.');
}

function passed(name) {
  evidence.checks.push({ name, status: 'PASS' });
  process.stdout.write(`JMCP-FIXTURE state=PASS phase=article-bodies check=${JSON.stringify(name)}\n`);
}

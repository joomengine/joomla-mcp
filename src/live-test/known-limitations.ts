import type {
  LiveJoomlaPath,
  LiveKnownUpstreamLimitation,
  LiveTestOptions,
} from './types.js';

const joomla612Fixture =
  'octoleo/joomengine:6@sha256:5fbcccb6275cc8336d22cad563082e09824bd04e0035bc1837787be8f16b2372';

interface KnownLimitationContext {
  readonly options: LiveTestOptions;
  readonly joomlaPath: LiveJoomlaPath;
  readonly scenarioId: string;
  readonly phase: string;
  readonly error: string;
}

interface KnownLimitationRule {
  readonly code: string;
  readonly scenarioIds: readonly string[];
  readonly phases: readonly string[];
  readonly joomlaPaths?: readonly LiveJoomlaPath[];
  readonly error: RegExp;
  readonly explanation: string;
  readonly reference: string;
}

const directFailureRules: readonly KnownLimitationRule[] = Object.freeze([
  Object.freeze({
    code: 'joomla-6.1.2-module-api-create-model-state',
    scenarioIds: Object.freeze(['modules.site.create', 'modules.administrator.create']),
    phases: Object.freeze([
      'create-showcase',
      'create-deletion',
      'create-primary',
      'create-secondary',
      'create-welcome-sidebar',
      'create-release-top',
      'create-guides-bottom',
      'create-multi-page-sidebar',
      'create-community-footer',
    ]),
    error: /Joomla API returned HTTP 400: .*Field 'params' doesn't have a default value/u,
    explanation:
      'Joomla 6.1.2 does not seed the module edit-model state before its generic API create path validates and saves the module form.',
    reference:
      'https://github.com/joomla/joomla-cms/blob/6.1.2/api/components/com_modules/src/Controller/ModulesController.php',
  }),
  Object.freeze({
    code: 'joomla-6.1.2-language-override-item-id-filter',
    scenarioIds: Object.freeze([
      'languages.overrides.site.get',
      'languages.overrides.administrator.get',
    ]),
    phases: Object.freeze(['read', 'read-back-created']),
    error: /did not return language override .* with the submitted value\./u,
    explanation:
      'Joomla 6.1.2 filters the string route identifier as an integer in the generic API item display path, so site and administrator override item responses are empty.',
    reference:
      'https://github.com/joomla/joomla-cms/blob/6.1.2/libraries/src/MVC/Controller/ApiController.php#L148-L152',
  }),
  Object.freeze({
    code: 'joomla-6.1.2-site-language-override-client-coercion',
    scenarioIds: Object.freeze(['languages.overrides.site.create']),
    phases: Object.freeze(['write']),
    error: /did not return language override .* with the submitted value\./u,
    explanation:
      'Joomla 6.1.2 passes the site client name into a model path that coerces any non-empty client value to administrator, so the site override is not written to the requested file.',
    reference:
      'https://github.com/joomla/joomla-cms/blob/6.1.2/administrator/components/com_languages/src/Model/OverrideModel.php#L158-L185',
  }),
  Object.freeze({
    code: 'joomla-6.1.2-language-override-refresh-500',
    scenarioIds: Object.freeze(['languages.overrides.refresh']),
    phases: Object.freeze(['write']),
    error: /Joomla API returned HTTP 500: \{"errors":\[\{"code":500,"title":"Internal server error"\}\]\}/u,
    explanation:
      'The pinned Joomla 6.1.2 language override cache-refresh API route returns an internal-server error after dispatch.',
    reference:
      'https://github.com/joomla/joomla-cms/blob/6.1.2/plugins/webservices/languages/src/Extension/Languages.php',
  }),
  Object.freeze({
    code: 'joomla-6.1.2-language-override-delete-500',
    scenarioIds: Object.freeze([
      'languages.overrides.site.delete',
      'languages.overrides.administrator.delete',
    ]),
    phases: Object.freeze(['write']),
    error: /Joomla API returned HTTP 500: \{"errors":\{"code":500,"title":"Internal server error"\}\}/u,
    explanation:
      'The pinned Joomla 6.1.2 override controller delegates file-backed override deletion to the generic model deletion path and returns HTTP 500.',
    reference:
      'https://github.com/joomla/joomla-cms/blob/6.1.2/api/components/com_languages/src/Controller/OverridesController.php#L154-L163',
  }),
  Object.freeze({
    code: 'joomla-6.1.2-scheduler-state-null-checkout',
    scenarioIds: Object.freeze(['scheduler.tasks.state.set']),
    phases: Object.freeze(['write']),
    joomlaPaths: Object.freeze(['cli'] as const),
    error: /Joomla command "scheduler:state" exited 1\. Output: .*Task ID '\d+' is checked out!/u,
    explanation:
      'Joomla 6.1.2 scheduler:state treats an unlocked task with a null lock owner as checked out because the generic checkout check compares null to the CLI user identifier.',
    reference:
      'https://github.com/joomla/joomla-cms/blob/6.1.2/libraries/src/Console/TasksStateCommand.php#L126-L132',
  }),
]);

const verifiedDeletionRules: readonly KnownLimitationRule[] = Object.freeze([
  Object.freeze({
    code: 'joomla-6.1.2-contact-get-after-delete-500',
    scenarioIds: Object.freeze(['contacts.contacts.get']),
    phases: Object.freeze(['verify-deleted']),
    error: /Joomla API returned HTTP 500: \{"errors":\{"code":500,"title":"Internal server error"\}\}/u,
    explanation:
      'Joomla 6.1.2 returns HTTP 500 when the contact item route reads a contact after deletion; the live test accepted this only after the contact disappeared from the active collection.',
    reference:
      'https://github.com/joomla/joomla-cms/blob/6.1.2/api/components/com_contact/src/Controller/ContactController.php',
  }),
  Object.freeze({
    code: 'joomla-6.1.2-message-get-after-delete-500',
    scenarioIds: Object.freeze(['messages.messages.get']),
    phases: Object.freeze(['verify-deleted']),
    error: /Joomla API returned HTTP 500: \{"errors":\{"code":500,"title":"Internal server error"\}\}/u,
    explanation:
      'Joomla 6.1.2 returns HTTP 500 when the private-message item route reads a deleted message; the live test accepted this only after the message disappeared from the active collection.',
    reference:
      'https://github.com/joomla/joomla-cms/blob/6.1.2/administrator/components/com_messages/src/Model/MessageModel.php',
  }),
  Object.freeze({
    code: 'joomla-6.1.2-newsfeed-get-after-delete-500',
    scenarioIds: Object.freeze(['newsfeeds.feeds.get']),
    phases: Object.freeze(['verify-deleted']),
    error: /Joomla API returned HTTP 500: \{"errors":\{"code":500,"title":"Internal server error"\}\}/u,
    explanation:
      'Joomla 6.1.2 returns HTTP 500 when the newsfeed item route reads a deleted feed; the live test accepted this only after the feed disappeared from the active collection.',
    reference:
      'https://github.com/joomla/joomla-cms/blob/6.1.2/api/components/com_newsfeeds/src/Controller/FeedsController.php',
  }),
]);

const verifiedPartialRules: readonly KnownLimitationRule[] = Object.freeze([
  Object.freeze({
    code: 'joomla-6.1.2-message-create-response-404',
    scenarioIds: Object.freeze(['messages.messages.create']),
    phases: Object.freeze([
      'create-showcase',
      'create-deletion',
      'create-primary',
      'create-secondary',
    ]),
    error: /Joomla API returned HTTP 404: \{"errors":\[\{"title":"Resource not found","code":404\}\]\}/u,
    explanation:
      'Joomla 6.1.2 persists the private message but its generic API add path returns HTTP 404 while rendering the newly created record; the live test accepted this only after listing the exact submitted subject.',
    reference:
      'https://github.com/joomla/joomla-cms/blob/6.1.2/libraries/src/MVC/Controller/ApiController.php#L369-L379',
  }),
  Object.freeze({
    code: 'joomla-6.1.2-content-language-update-response-400',
    scenarioIds: Object.freeze(['languages.content.update']),
    phases: Object.freeze([
      'update-showcase',
      'cleanup-trash-showcase',
      'update-primary-generated-update',
      'update-secondary-generated-update',
      'update-deletion-generated-update',
    ]),
    error: /Joomla API returned HTTP 400: .*Check-in failed with the following error:/u,
    explanation:
      'Joomla 6.1.2 persists the content-language PATCH but its generic API save path reports an empty check-in failure; the live test accepted this only after reading back every submitted field.',
    reference:
      'https://github.com/joomla/joomla-cms/blob/6.1.2/libraries/src/MVC/Controller/ApiController.php#L523-L535',
  }),
  Object.freeze({
    code: 'joomla-6.1.2-message-update-creates-replacement',
    scenarioIds: Object.freeze(['messages.messages.get']),
    phases: Object.freeze(['read-back-updated']),
    error: /Updated messages\.messages did not return the expected changed fields\./u,
    explanation:
      'Joomla 6.1.2 validates message PATCH data with a form that omits message_id, so the request creates a replacement message while returning the unchanged original; the live test accepted this only after finding the exact replacement and deleting it.',
    reference:
      'https://github.com/joomla/joomla-cms/blob/6.1.2/administrator/components/com_messages/forms/message.xml',
  }),
]);

export function knownUpstreamLimitation(
  context: KnownLimitationContext,
): LiveKnownUpstreamLimitation | undefined {
  return matchRule(context, directFailureRules);
}

export function verifiedPartialMutationLimitation(
  context: KnownLimitationContext,
): LiveKnownUpstreamLimitation | undefined {
  return matchRule(context, verifiedPartialRules);
}

export function verifiedDeletionLimitation(
  context: KnownLimitationContext,
): LiveKnownUpstreamLimitation | undefined {
  return matchRule(context, verifiedDeletionRules);
}

function matchRule(
  context: KnownLimitationContext,
  rules: readonly KnownLimitationRule[],
): LiveKnownUpstreamLimitation | undefined {
  const fixture = context.options.fixtureDigests?.['joomla-image'];
  if (fixture !== joomla612Fixture) return undefined;
  const rule = rules.find((candidate) =>
    (candidate.joomlaPaths ?? ['api']).includes(context.joomlaPath) &&
    candidate.scenarioIds.includes(context.scenarioId) &&
    candidate.phases.includes(context.phase) &&
    candidate.error.test(context.error));
  if (rule === undefined) return undefined;
  return Object.freeze({
    code: rule.code,
    fixture,
    explanation: rule.explanation,
    reference: rule.reference,
    observedError: context.error,
  });
}

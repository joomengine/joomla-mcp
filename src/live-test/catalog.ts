import { sourceOnlyActionGates } from '../catalog/action-gates.js';
import { joomlaActions } from '../catalog/action-catalog.js';
import {
  companionActions,
  supportsCompanionReadAction,
  supportsCompanionWriteAction,
} from '../catalog/companion-actions.js';
import type { JoomlaActionDescriptor } from '../contracts/action-catalog.js';
import type { LiveJoomlaPath, LiveScenario } from './types.js';

const gateReasons = new Map(Object.entries(sourceOnlyActionGates));

export function liveScenarioCatalog(): readonly LiveScenario[] {
  const scenarios = new Map<string, LiveScenario>();

  for (const action of joomlaActions) {
    const paths = action.risk === 'read' || action.risk === 'sensitive-read'
      ? supportsCompanionReadAction(action.id)
        ? ['api', 'cli'] as const
        : ['api'] as const
      : supportsCompanionWriteAction(action.id)
        ? ['api', 'cli'] as const
        : ['api'] as const;
    scenarios.set(action.id, fromJoomlaAction(action, paths));
  }

  for (const action of companionActions) {
    const existing = scenarios.get(action.id);
    if (existing !== undefined) {
      if (!existing.joomlaPaths.includes('cli')) {
        scenarios.set(action.id, Object.freeze({
          ...existing,
          joomlaPaths: Object.freeze([...existing.joomlaPaths, 'cli'] as LiveJoomlaPath[]),
        }));
      }
      continue;
    }
    scenarios.set(action.id, Object.freeze({
      id: action.id,
      title: action.title,
      domain: action.domain,
      risk: action.risk,
      toolset: action.toolset,
      operation: action.risk === 'read' ? 'read' : 'write',
      joomlaPaths: Object.freeze(['cli'] as const),
    }));
  }

  return Object.freeze([...scenarios.values()].sort((left, right) => left.id.localeCompare(right.id)));
}

function fromJoomlaAction(
  action: JoomlaActionDescriptor,
  joomlaPaths: readonly ('api' | 'cli')[],
): LiveScenario {
  const sourceOnlyReason = gateReasons.get(action.id);
  return Object.freeze({
    id: action.id,
    title: action.title,
    domain: action.domain,
    risk: action.risk,
    toolset: action.toolset,
    operation: action.operation,
    joomlaPaths: sourceOnlyReason === undefined ? Object.freeze([...joomlaPaths]) : Object.freeze([]),
    ...(sourceOnlyReason === undefined ? {} : { sourceOnlyReason }),
    source: Object.freeze({
      repository: action.source.repository,
      commit: action.source.commit,
      path: action.source.path,
      registration: action.source.registration,
    }),
  });
}

export function sourceOnlyScenarioIds(): ReadonlySet<string> {
  return new Set(Object.keys(sourceOnlyActionGates));
}

import { ChangeState } from "@veil/contracts";

const TERMINAL = new Set<ChangeState>([
  ChangeState.Published,
  ChangeState.Failed,
  ChangeState.Cancelled,
]);

const TRANSITIONS: ReadonlyMap<ChangeState, ReadonlySet<ChangeState>> = new Map([
  [ChangeState.Preflight, new Set<ChangeState>([ChangeState.Importing])],
  [ChangeState.Importing, new Set<ChangeState>([ChangeState.Encrypting])],
  [ChangeState.Encrypting, new Set<ChangeState>([ChangeState.PrivateReady])],
  [ChangeState.PrivateReady, new Set<ChangeState>([ChangeState.Materializing, ChangeState.Capturing])],
  [ChangeState.Materializing, new Set<ChangeState>([ChangeState.AgentsRunning])],
  [ChangeState.AgentsRunning, new Set<ChangeState>([ChangeState.Capturing])],
  [ChangeState.Capturing, new Set<ChangeState>([ChangeState.Destroying])],
  [ChangeState.Destroying, new Set<ChangeState>([ChangeState.Evaluating])],
  [ChangeState.Evaluating, new Set<ChangeState>([ChangeState.ReviewReady])],
  [ChangeState.ReviewReady, new Set<ChangeState>([ChangeState.Materializing, ChangeState.Capturing, ChangeState.Publishing])],
  [ChangeState.Publishing, new Set<ChangeState>([ChangeState.Published, ChangeState.ReviewReady])],
]);

export function canTransition(from: ChangeState, to: ChangeState): boolean {
  if (from === to || TERMINAL.has(from)) return false;
  if (to === ChangeState.Failed || to === ChangeState.Cancelled) return true;
  return TRANSITIONS.get(from)?.has(to) ?? false;
}

export function assertLegalTransition(from: ChangeState, to: ChangeState): void {
  if (!canTransition(from, to)) {
    throw new Error(`Illegal Veil state transition: ${from} -> ${to}`);
  }
}

export function isTerminalState(state: ChangeState): boolean {
  return TERMINAL.has(state);
}

export interface AgentRole {
  id: string;
  name: string;
  instruction: string;
}

export interface AgentSummary {
  summary: string;
  changed_files: string[];
  commands_attempted: string[];
  known_risks: string[];
}

export interface CodexEvent {
  type: string;
  thread_id?: string;
  item?: {
    id?: string;
    type?: string;
    status?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface AgentExecutionResult {
  exitCode: number;
  startedAt: string;
  endedAt: string;
  threadId: string | null;
  summary: AgentSummary | null;
  events: CodexEvent[];
  malformedLineCount: number;
  stderr: string;
  timedOut: boolean;
  cancelled: boolean;
}

export interface AgentRunOptions {
  /** A fully materialized, .git-free execution view. It is the only writable host mount. */
  workspaceDirectory: string;
  privateBriefPath?: string;
  role: AgentRole;
  model?: string;
  codexBinary?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  onEvent?: (event: CodexEvent) => void | Promise<void>;
  /**
   * `required` fails closed unless the Linux mount boundary can be created.
   * `disabled` preserves the explicitly local V1 runner on unsupported hosts.
   */
  isolationMode?: "disabled" | "required";
  /** Dependency injection for tests or an explicitly provisioned bubblewrap binary. */
  isolationBinary?: string;
}

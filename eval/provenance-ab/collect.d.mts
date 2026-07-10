export interface MatrixRow {
  variant: string;
  workspace: string;
  replicate?: number;
  source_commit: string;
  source_dirty: boolean;
  source_patch_sha256: string | null;
  source_untracked: boolean;
  source_build_sha256: string;
  requested_model: string;
  task_outcome: string;
  project_guidance_legitimate: string;
  live_request_distinguishable: string;
  injection_loop: string;
  fallback_occurred: boolean;
  tool_dispositions: unknown[];
}

export function collectRun(dir: string): MatrixRow;
